#!/usr/bin/env node
/**
 * harness/ci-watch.mjs — watch CI after a push, re-run a failed job once, then alert (2.30h, item 5).
 *
 *   npm run ci:watch [-- --sha <commit>] [--timeout-min 60] [--poll-sec 30] [--detach]
 *
 * Today a red Windows check sat for two hours unseen. After a push (scripts/release-ship.mjs runs this
 * itself; `npm run ci:watch -- --detach` runs it in the background after a hand push) it waits for the
 * GitHub Actions runs on that commit, re-runs the failed jobs once (a flaky timing check gets a second
 * chance), and when a job is still red:
 *   - emits ci.failed (a War Room card, and a phone alert when alerts are on: npm run alerts),
 *   - runs STUDIO_CI_NOTIFY_CMD if set (a notification hook; it gets CI_SHA, CI_STATE and CI_SUMMARY in
 *     its environment, e.g. a curl to a webhook), and
 *   - records .studio/ci-watch.json, which the War Room shows.
 * Green: ci.green and the same file. Needs the gh CLI (logged in); without it, says "CI not checked",
 * never "green". STUDIO_GH points at another gh (the self-test uses a fake one). Never blocks an agent:
 * it runs after the push, in its own process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { routeNow } from './threads.mjs';

export const CI_FILE = () => path.join(STUDIO_STATE_DIR, 'ci-watch.json');
// STUDIO_GH may be a command line ("node fake-gh.mjs"); the arguments here never hold spaces or quotes.
const gh = (args) => (process.env.STUDIO_GH ? spawnSync(`${process.env.STUDIO_GH} ${args.map((a) => `"${a}"`).join(' ')}`, { cwd: REPO_ROOT, encoding: 'utf8', shell: true }) : spawnSync('gh', args, { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32' }));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function readCiWatch() {
  try {
    return JSON.parse(fs.readFileSync(CI_FILE(), 'utf8'));
  } catch {
    return null;
  }
}

/** What to do with the runs seen so far: wait, rerun (once), green, red. Pure. */
export function ciDecision(runs, { rerunDone = false } = {}) {
  if (!runs.length || runs.some((r) => r.status !== 'completed')) return 'wait';
  if (runs.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion))) return 'green';
  return rerunDone ? 'red' : 'rerun';
}

function listRuns(sha) {
  const r = gh(['run', 'list', '--commit', sha, '--json', 'databaseId,name,status,conclusion,workflowName', '--limit', '20']);
  try {
    return JSON.parse(r.stdout);
  } catch {
    return [];
  }
}
function jobsOf(id) {
  const j = gh(['run', 'view', String(id), '--json', 'jobs']);
  try {
    return JSON.parse(j.stdout).jobs.map((x) => ({ name: x.name, conclusion: x.conclusion || x.status }));
  } catch {
    return [];
  }
}

export function watchCi({ sha, timeoutMin = 60, pollSec = 30 } = {}) {
  sha = sha || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
  const rec = { sha, startedAt: new Date().toISOString(), state: 'watching', first: null, rerun: null };
  const save = () => {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(CI_FILE(), `${JSON.stringify({ ...rec, at: new Date().toISOString() }, null, 2)}\n`);
  };
  if (gh(['--version']).status !== 0) {
    rec.state = 'not checked';
    rec.why = 'gh CLI not found';
    save();
    return rec;
  }
  save();
  const until = Date.now() + timeoutMin * 60000;
  let rerunDone = false;
  for (;;) {
    const runs = listRuns(sha);
    const d = ciDecision(runs, { rerunDone });
    if (d === 'wait') {
      if (Date.now() > until) {
        rec.state = 'timed out';
        break;
      }
      sleep(pollSec * 1000);
      continue;
    }
    const snap = runs.map((r) => ({ id: r.databaseId, workflow: r.workflowName || r.name, conclusion: r.conclusion, jobs: jobsOf(r.databaseId) }));
    if (!rerunDone) rec.first = snap;
    else rec.rerun = snap;
    if (d === 'green') {
      rec.state = rerunDone ? 'green after one re-run' : 'green';
      break;
    }
    if (d === 'red') {
      rec.state = 'red';
      break;
    }
    // d === 'rerun': the failed jobs, once.
    for (const r of runs.filter((x) => !['success', 'skipped', 'neutral'].includes(x.conclusion))) gh(['run', 'rerun', String(r.databaseId), '--failed']);
    rerunDone = true;
    rec.state = 're-running failed jobs';
    save();
    sleep(Math.min(60, pollSec * 2) * 1000);
  }
  const failing = (rec.rerun || rec.first || []).flatMap((r) => r.jobs.filter((j) => !['success', 'skipped', 'neutral'].includes(j.conclusion)).map((j) => `${r.workflow}/${j.name}`));
  const jobsN = (rec.rerun || rec.first || []).reduce((n, r) => n + r.jobs.length, 0);
  rec.failing = failing;
  rec.summary = rec.state.startsWith('green') ? `CI ${rec.state} on ${sha.slice(0, 7)}: ${jobsN} job(s)` : rec.state === 'red' ? `CI red on ${sha.slice(0, 7)} after one re-run: ${failing.join(', ') || 'a job'} failed` : `CI ${rec.state} on ${sha.slice(0, 7)}`;
  save();
  const red = rec.state === 'red' || rec.state === 'timed out';
  const ev = emitEvent({ type: red ? 'ci.failed' : 'ci.green', agent: 'ci-watch', to: 'producer', status: red ? 'error' : 'ok', msg: rec.summary, meta: { sha, failing } });
  // 2.64.0: pass-through (harness/threads.mjs). The result goes to the task whose lane or landing made this commit, or
  // to the Producer; in shadow mode (the default) it is only logged as thread.would_route. Never blocks the watch.
  try { rec.routed = routeNow(ev); save(); } catch {}
  if (red && process.env.STUDIO_CI_NOTIFY_CMD) {
    const n = spawnSync(process.env.STUDIO_CI_NOTIFY_CMD, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 30000, env: { ...process.env, CI_SHA: sha, CI_STATE: rec.state, CI_SUMMARY: rec.summary } });
    rec.notified = n.status === 0;
    save();
  }
  return rec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv.includes('--detach')) {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], { cwd: REPO_ROOT, detached: true, stdio: 'ignore' });
    c.unref();
    console.log(`[ci-watch] watching in the background (pid ${c.pid}); result in .studio/ci-watch.json`);
    process.exit(0);
  }
  const r = watchCi({ sha: flag('sha'), timeoutMin: Number(flag('timeout-min') || 60), pollSec: Number(flag('poll-sec') || 30) });
  console.log(`[ci-watch] ${r.summary || r.state}${r.why ? ` (${r.why})` : ''}`);
  process.exit(r.state === 'red' || r.state === 'timed out' ? 1 : 0);
}
