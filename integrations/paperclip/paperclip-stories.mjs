#!/usr/bin/env node
/**
 * Build a session story for each finished Paperclip heartbeat run, whatever
 * agent ran it (Claude Code, Codex, Cursor, OpenCode), into one library.
 *
 * Paperclip's run logs hold what the agent printed but not what it was
 * asked or for which issue, so this reads that from Paperclip's database
 * (read-only) and passes it in: the issue and wake reason become the title,
 * summary and, where the agent printed no prompt, turn 1's prompt.
 *
 *   node paperclip-stories.mjs [--hours 24] [--run <run-id>]... [--out <dir>]
 *
 * Needs `psql` and read access to the Paperclip instance (run as the user
 * Paperclip runs as). The connection string comes from PAPERCLIP_DB_URL or
 * the instance's config.json; it is never printed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STORY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'session-story', 'bin', 'story.mjs');

function parseArgs(argv) {
  const opts = { hours: 24, runs: [], out: '/var/lib/session-stories', instance: '/root/.paperclip/instances/default' };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--hours') opts.hours = Number(value);
    else if (flag === '--run') opts.runs.push(value);
    else if (flag === '--out') opts.out = value;
    else if (flag === '--instance') opts.instance = value;
    else throw new Error(`unknown option ${flag}`);
    i++;
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) throw new Error('--hours must be a positive number');
  return opts;
}

function dbUrl(instance) {
  if (process.env.PAPERCLIP_DB_URL) return process.env.PAPERCLIP_DB_URL;
  const config = JSON.parse(readFileSync(path.join(instance, 'config.json'), 'utf8'));
  const url = config.database && config.database.connectionString;
  if (!url) throw new Error(`no database.connectionString in ${instance}/config.json; set PAPERCLIP_DB_URL`);
  return url;
}

const UUID = /^[0-9a-f-]{36}$/i;

// Paperclip adapter types -> story.mjs --agent, so a run that died before
// printing anything still gets a page.
const AGENT_FOR_ADAPTER = {
  claude_local: 'claude-code',
  codex_local: 'codex',
  opencode_local: 'opencode',
  cursor: 'cursor',
};

function finishedRuns({ instance, hours, runs }) {
  for (const id of runs) if (!UUID.test(id)) throw new Error(`not a run id: ${id}`);
  const where = runs.length
    ? `r.id in (${runs.map((id) => `'${id}'`).join(',')})`
    : `r.finished_at > now() - interval '${hours} hours'`;
  const sql = `
    set default_transaction_read_only = on;
    select json_build_object(
      'id', r.id, 'status', r.status, 'error', r.error, 'log_store', r.log_store, 'log_ref', r.log_ref,
      'log_compressed', r.log_compressed, 'agent', a.name, 'adapter', a.adapter_type,
      'model', a.adapter_config->>'model',
      'issue', r.context_snapshot->'paperclipIssue'->>'identifier',
      'issue_title', r.context_snapshot->'paperclipIssue'->>'title',
      'wake', coalesce(r.context_snapshot->'paperclipWake'->>'reason', r.context_snapshot->>'wakeReason'),
      'task', r.context_snapshot->>'paperclipTaskMarkdown',
      'cwd', r.context_snapshot->'paperclipWorkspace'->>'cwd')
    from heartbeat_runs r join agents a on a.id = r.agent_id
    where ${where} and r.finished_at is not null and r.log_ref is not null
    order by r.finished_at`;
  const out = execFileSync('psql', [dbUrl(instance), '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function storyFor(run, { instance, out, scratch }) {
  if (run.log_store !== 'local_file' || run.log_compressed) {
    return `skipped ${run.id}: log is ${run.log_compressed ? 'compressed' : run.log_store}`;
  }
  const log = path.join(instance, 'data', 'run-logs', run.log_ref);
  if (!existsSync(log)) return `skipped ${run.id}: ${log} is gone`;

  const issue = run.issue ? `${run.issue}: ${run.issue_title || ''}`.trim() : 'No issue';
  const prompt = [issue, run.wake ? `Woken by: ${run.wake}` : null, run.task || null].filter(Boolean).join('\n\n');
  const json = path.join(scratch, `${run.id}.json`);
  const args = [STORY, 'extract', '--log', log, '--prompt', prompt, '-o', json];
  if (run.model) args.push('--model', run.model);
  if (AGENT_FOR_ADAPTER[run.adapter]) args.push('--agent', AGENT_FOR_ADAPTER[run.adapter]);
  if (run.cwd && existsSync(run.cwd)) args.push('--cwd', run.cwd);
  else args.push('--cwd', scratch, '--no-git');
  execFileSync(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

  // No model writes these here, so they are facts from Paperclip, not judgements.
  const story = JSON.parse(readFileSync(json, 'utf8'));
  story.session.title = clip(`${run.issue || 'Run'} · ${run.agent}`, 60);
  story.session.summary = clip(
    `${run.agent} (${story.environment.agent.name}${run.model ? `, ${run.model}` : ''}) on ${issue}. ` +
    `Paperclip marked the run ${run.status}${run.error ? `: ${run.error}` : ''}.`,
    240,
  );
  story.session.source = { ...story.session.source, paperclip: { ...(story.session.source.paperclip || {}), issue: run.issue, status: run.status } };
  writeFileSync(json, JSON.stringify(story, null, 2));
  execFileSync(process.execPath, [STORY, 'render', json, '--library', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return `${run.status.padEnd(9)} ${story.environment.agent.name.padEnd(12)} ${story.session.title}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runs = finishedRuns(opts);
  // Stories hold prompts, command output and diffs word for word: owner-only.
  mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(tmpdir(), 'paperclip-stories-'));
  let failed = 0;
  try {
    for (const run of runs) {
      try {
        console.log(storyFor(run, { ...opts, scratch }));
      } catch (err) {
        failed++;
        console.error(`failed  ${run.id}: ${(err.stderr || err.message || '').toString().trim().split('\n').pop()}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`${runs.length - failed}/${runs.length} runs -> ${path.join(opts.out, 'index.html')}`);
  if (failed) process.exitCode = 1;
}

main();
