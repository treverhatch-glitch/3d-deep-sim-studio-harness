#!/usr/bin/env node
/**
 * harness/busy.mjs — 2.30q (#6): "no session on it" is not "stalled".
 *
 * In the Marina run (2.30.0-o) the Director's flow pass handed back tasks whose builder was inside
 * `task done` (gates take 10-23 min) or whose lane was waiting to land, because the builder runs outside
 * the harness (no session record) and its task claim ran out during the gates. 13 of 83 hand-backs were
 * "The claim ran out with no running session on it"; three of those tasks were then parked by the watchdog
 * for "handed back 3 times in 2 h". Here a task counts as busy when:
 *   - a `task done` for it is running (.studio/done-running/<T>.json, written by task done, live pid), or
 *   - its lane branch has commits the studio's branch lacks and the lane copy is live (worktree laneLive).
 * And a hand-back the harness caused (claim ran out, the main checkout refused the merge, the land lock,
 * the branch kept moving) never counts toward parking.
 *
 * 2.58.3 (N2): a task also counts as busy when the owner of its last claim (an agent working outside the launcher,
 * such as a chat bot that claims with `task start` and works in its own copy) was heard from within
 * STUDIO_CLAIM_ACTIVE_MIN (30) minutes, or its lane copy changed in that time (claimActive). Its claim running out
 * is not the owner leaving: the Director's flow pass, the watcher's requeue and the supervisor's pick all keep away.
 * (N1, N3): a person's stop is never a loop either (PERSON_CAUSE), and one rule counts hand-backs for every parker
 * (loopHandBacks: since the last done, unblock or unpark), and a park is written once (parkOnce).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRecentEvents, emitEvent } from './event.mjs';
import { updateHolds } from './task-hold.mjs';
import { LIMIT_STOP } from './budget.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

async function stateDir() {
  const { mainRoot } = await import('./worktree.mjs');
  return path.join(mainRoot(), '.studio');
}
const doneDir = (dir) => path.join(dir, 'done-running');
const safe = (id) => String(id).replace(/[^\w.-]/g, '_');

/** task done is running for this task (called by the CLI before the checks start). */
export async function markDoneRunning(task, agent, { dir } = {}) {
  const d = doneDir(dir || (await stateDir()));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${safe(task)}.json`), JSON.stringify({ task, agent: agent || null, pid: process.pid, at: new Date().toISOString() }));
}
export async function clearDoneRunning(task, { dir } = {}) {
  const f = path.join(doneDir(dir || (await stateDir())), `${safe(task)}.json`);
  try { const r = read(f, null); if (!r || r.pid === process.pid || !alive(r.pid)) fs.rmSync(f, { force: true }); } catch {}
}
/** The running done for a task, or null (a dead pid or a record older than STUDIO_DONE_RUNNING_MAX_MIN, 90, is stale). */
export function doneRunning(task, { dir, now = Date.now(), env = process.env } = {}) {
  const r = read(path.join(doneDir(dir), `${safe(task)}.json`), null);
  if (!r) return null;
  const max = Number(env.STUDIO_DONE_RUNNING_MAX_MIN ?? 90) * 60000;
  if (!alive(r.pid) || now - Date.parse(r.at) > max) return null;
  return r;
}

// Events about an agent that say it has gone, not that it is working.
const GONE_TYPES = new Set(['agent.session.end', 'lock.dead_released', 'agent.pid_reused']);
// What ends a claim on a task.
const ENDS = new Set(['task.paused', 'task.done', 'task.forced', 'task.reopened']);
const claimWindowMs = (env) => {
  const v = Number(env.STUDIO_CLAIM_ACTIVE_MIN ?? 30);
  return (Number.isFinite(v) ? Math.max(0, v) : 30) * 60000;
};

/**
 * 2.58.3 (N2): who last claimed a task (its last task.start), from the events. { owner, at, orphaned } or null.
 * A hand-back by the owner (or a done) ends the claim: null. A hand-back by someone else that the harness caused
 * (the Director's flow pass or the watcher after the claim ran out) leaves the owner on record, orphaned: true,
 * so the supervisor doesn't give a live owner's task to a new agent.
 */
export function claimOwner(task, events = readRecentEvents(20000)) {
  let cur = null;
  for (const e of events) {
    if (e.task !== task) continue;
    if (e.type === 'task.start' && e.agent) cur = { owner: e.agent, at: e.ts, orphaned: false };
    else if (cur && ENDS.has(e.type)) {
      if (e.type === 'task.paused' && e.agent !== cur.owner && harnessCaused(e)) cur = { ...cur, orphaned: true };
      else cur = null;
    }
  }
  return cur;
}

/** A lane copy's last change: the newest of its index, its last commit and its uncommitted files (ms, or 0). */
function laneChangedAt(dir) {
  let t = 0;
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  try { t = Math.max(t, fs.statSync(dir).mtimeMs); } catch { return 0; }
  try {
    const idx = git('rev-parse', '--git-path', 'index').stdout?.trim();
    if (idx) t = Math.max(t, fs.statSync(path.resolve(dir, idx)).mtimeMs);
  } catch {}
  try { t = Math.max(t, (Number(git('log', '-1', '--format=%ct').stdout?.trim()) || 0) * 1000); } catch {}
  try {
    const files = String(git('status', '--porcelain', '--untracked-files=all').stdout || '').split('\n').filter(Boolean).slice(0, 200);
    for (const l of files) {
      const f = l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop();
      try { t = Math.max(t, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
    }
  } catch {}
  return t;
}

/**
 * 2.58.3 (N2): is the owner of this task's last claim still working on it, though its claim ran out? Busy when the
 * owner has any event (other than ones saying it has gone, and the claim's own start) in the last STUDIO_CLAIM_ACTIVE_MIN (30) minutes, or its
 * lane copy (.lanes/<owner>, .lanes/<owner>-*, or the copy on the task's remembered lane branch) has a commit or a
 * file change in that time. Synchronous (the watcher's pass is). `root` is the main checkout (worktree.mainRoot()).
 * Returns { busy, why, owner }.
 */
export function claimActive(task, { root = null, now = Date.now(), env = process.env, events = null, orphaned = false } = {}) {
  const win = claimWindowMs(env);
  if (!(win > 0)) return { busy: false };
  const evs = events || readRecentEvents(20000);
  const c = claimOwner(task, evs);
  if (!c || (c.orphaned && !orphaned)) return { busy: false };
  // The claim's own task.start isn't proof of work since: a claim runs out an hour after it, so on its own it is never
  // inside the window when the claim ran out by itself (only when it was released by hand straight away).
  const mine = evs.filter((e) => e.agent === c.owner && !(e.type === 'task.start' && e.task === task && e.ts === c.at));
  const last = mine[mine.length - 1];
  const min = (t) => Math.max(0, Math.round((now - t) / 60000));
  if (last && !GONE_TYPES.has(last.type)) {
    const at = Date.parse(last.ts) || 0;
    if (now - at <= win) return { busy: true, owner: c.owner, short: `${task}'s owner ${c.owner} is still working on it`, why: `${task}'s claim ran out, but its owner ${c.owner} was active ${min(at)} min ago (${last.type}); it is still working on it (STUDIO_CLAIM_ACTIVE_MIN ${Math.round(win / 60000)})` };
  }
  if (root) {
    try {
      const lanes = path.join(root, '.lanes');
      const dirs = new Set();
      if (fs.existsSync(lanes)) {
        for (const d of fs.readdirSync(lanes, { withFileTypes: true })) if (d.isDirectory() && (d.name === c.owner || d.name.startsWith(`${c.owner}-`))) dirs.add(path.join(lanes, d.name));
        const b = read(path.join(root, '.studio', 'lane-branches.json'), {})[task];
        if (b) {
          for (const d of fs.readdirSync(lanes, { withFileTypes: true })) {
            if (!d.isDirectory() || dirs.has(path.join(lanes, d.name))) continue;
            const head = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: path.join(lanes, d.name), encoding: 'utf8', windowsHide: true }).stdout?.trim();
            if (head === b) dirs.add(path.join(lanes, d.name));
          }
        }
      }
      for (const d of dirs) {
        const t = laneChangedAt(d);
        if (t && now - t <= win) return { busy: true, owner: c.owner, short: `${task}'s owner ${c.owner} is still working on it`, why: `${task}'s claim ran out, but ${c.owner}'s lane copy ${path.relative(root, d).split(path.sep).join('/')} changed ${min(t)} min ago; it is still working on it` };
      }
    } catch {}
  }
  return { busy: false, owner: c.owner };
}

/** Is this task busy even though no harness session holds it? { busy, why }. */
export async function taskBusy(task, { now = Date.now(), env = process.env, events = null } = {}) {
  const dir = await stateDir();
  const d = doneRunning(task, { dir, now, env });
  if (d) return { busy: true, why: `task done is running for ${task} (${d.agent || 'pid ' + d.pid}, since ${d.at})` };
  try {
    const { mainRoot } = await import('./worktree.mjs');
    const a = claimActive(task, { root: mainRoot(), now, env, events });
    if (a.busy) return { busy: true, why: a.why, short: a.short, owner: a.owner };
  } catch {}
  try {
    const { mainRoot, laneCopies, laneLive } = await import('./worktree.mjs');
    const b = read(path.join(dir, 'lane-branches.json'), {})[task];
    if (b) {
      const lane = laneCopies(mainRoot()).find((l) => l.branch === b);
      if (lane && lane.unmerged > 0) {
        const l = laneLive(lane.agent);
        if (l.live) return { busy: true, why: `${task}'s lane ${lane.agent} has ${lane.unmerged} commit(s) queued to land (${l.why})` };
      }
    }
  } catch {}
  return { busy: false };
}

/** A hand-back the harness caused, not the work: never counts toward parking. */
export const HARNESS_CAUSE = /claim ran out|couldn't be added to \S+ in the main checkout|land lock|kept moving while|index\.lock|merge worktree|done is running|queued to land/i;
export const harnessCaused = (e) => e?.meta?.cause === 'harness' || HARNESS_CAUSE.test(String(e?.msg || ''));
/**
 * 2.58.3 (N1): a hand-back because a person (or the Producer) stopped or paused the session: the note says
 * "a stop, not a failure" (STOP_NOTE). Not the task looping, and not the harness's fault (the health share stays clean).
 */
export const STOP_NOTE = 'a stop, not a failure';
export const PERSON_CAUSE = /\ba stop, not a failure\b/i;
export const personCaused = (e) => e?.meta?.cause === 'person' || PERSON_CAUSE.test(String(e?.msg || ''));

/**
 * 2.58.3 (N3): the one rule for counting a task's loop. The hand-backs (task.paused) that count, since the task was
 * last done, unblocked or unparked, and not harness-caused, person-caused or a usage-limit stop. `events` are
 * that task's or anyone's (filtered here); `since` is a time floor (ms).
 */
export function loopHandBacks(task, events, { since = 0 } = {}) {
  const mine = events.filter((e) => e.task === task && (Date.parse(e.ts) || 0) >= since);
  const reset = mine.filter((e) => e.type === 'task.done' || e.type === 'task.unblocked' || (e.type === 'task.hold' && /unparked/.test(e.msg || ''))).pop();
  return mine.filter((e) => e.type === 'task.paused' && (!reset || e.ts > reset.ts) && !harnessCaused(e) && !personCaused(e) && !LIMIT_STOP.test(e.msg || ''));
}

/**
 * 2.58.3 (N3): park a task once. The holds are read again and written under their lock (task-hold.mjs updateHolds),
 * so two passes at the same moment (the supervisor's, the watcher's, the hub's) park it once, and only the pass that
 * parked it emits the task.hold event. Returns true when this call parked it.
 */
export function parkOnce(task, parked, { by = 'watchdog', msg = '' } = {}) {
  const did = updateHolds((all) => {
    if (all[task]?.parked) return false;
    all[task] = { ...(all[task] || {}), parked };
    return true;
  });
  if (did && msg) emitEvent({ type: 'task.hold', agent: by, task, msg });
  return did;
}


/**
 * 2.30q: drain. `task drain on --by <name>` makes new `task done` landings wait (they poll until drain is off,
 * up to STUDIO_DRAIN_WAIT_MIN, 120, then refuse with nothing closed); dones already running finish.
 * `task drain wait` blocks until no done is running (for upgrades); `task drain status` exits 3 while on,
 * so builder wait scripts can check it before calling done.
 */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export async function readDrain() { return read(path.join(await stateDir(), 'drain.json'), { on: false }); }
export async function setDrain(on, by, why = '') {
  const d = await stateDir();
  fs.mkdirSync(d, { recursive: true });
  const rec = { on: Boolean(on), by: by || 'unknown', why, at: new Date().toISOString() };
  fs.writeFileSync(path.join(d, 'drain.json'), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}
export async function runningDones({ now = Date.now() } = {}) {
  const dir = await stateDir();
  const dd = doneDir(dir);
  if (!fs.existsSync(dd)) return [];
  return fs.readdirSync(dd).filter((f) => f.endsWith('.json')).map((f) => doneRunning(f.slice(0, -5), { dir, now })).filter(Boolean);
}
/** Called by task done before anything closes. Returns { ok } or { ok: false, message }. */
export async function waitForDrain({ log = console.error, env = process.env } = {}) {
  const max = Number(env.STUDIO_DRAIN_WAIT_MIN ?? 120) * 60000;
  const poll = Number(env.STUDIO_DRAIN_POLL_MS ?? 15000);
  const start = Date.now();
  let told = false;
  for (;;) {
    const d = await readDrain();
    if (!d.on) return { ok: true, waitedMs: Date.now() - start };
    if (!told) { log(`[drain] landings are paused (drain on by ${d.by}${d.why ? `: ${d.why}` : ''}); waiting until npm run task -- drain off`); told = true; }
    if (Date.now() - start >= max) return { ok: false, message: `Drain is still on after ${Math.round(max / 60000)} min (by ${d.by}). Nothing was closed; run task done again after drain off.` };
    sleep(poll);
  }
}
