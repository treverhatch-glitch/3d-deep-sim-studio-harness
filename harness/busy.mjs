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
 */
import fs from 'node:fs';
import path from 'node:path';

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

/** Is this task busy even though no harness session holds it? { busy, why }. */
export async function taskBusy(task, { now = Date.now(), env = process.env } = {}) {
  const dir = await stateDir();
  const d = doneRunning(task, { dir, now, env });
  if (d) return { busy: true, why: `task done is running for ${task} (${d.agent || 'pid ' + d.pid}, since ${d.at})` };
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
