/**
 * harness/train-watch.mjs — 2.77.3 (H2, B-112): a train whose status stops moving ends its attempt.
 *
 * Train 20261104-203215-38488 printed a flake verdict, then sat for 35+ min holding train.lock with its status still at
 * "verify 1 … ETA ~4 min": its process was blocked in a child (a focused run waiting for a machine:heavy slot), and
 * nothing in it could look up. A train runs its checks with spawnSync, so its own code can't watch the clock; a worker
 * thread can (harness/train-life.mjs starts this one beside the heartbeat, for every train that records its life).
 *
 * Every few seconds the worker reads .studio/train/<id>/status.json. When it hasn't changed for STUDIO_TRAIN_STALL_MIN
 * (default 90 minutes, well above a normal verify; 0 or off: no watch) while the train works (any step but a
 * speculative train's wait for train A: "ready", "waiting"; a check of the train waiting in the machine:heavy queue,
 * a wait bounded by STUDIO_HEAVY_WAIT_MIN, counts as moving), the worker:
 *   1. writes the train's cancel marker (.studio/train/<id>.cancel.json, { stall: true }) and life.json's "stalled";
 *   2. stops the train's running children (its whole process tree below the train: harness/heavy.mjs killHolderTree:
 *      taskkill /T /F on Windows, SIGTERM then SIGKILL elsewhere), so the blocked spawnSync returns;
 *   3. sets the status to "stalled: …" and records a task.train.stalled event (to the Producer) saying why.
 * The train then stops at its next step (harness/train.mjs checkCancel): nothing lands from that attempt, nobody is
 * handed back, its lanes keep their place in the queue; a lane that stalls a second train at the same head is held
 * for the Producer (never counted toward STUDIO_TRAIN_MAX_HANDBACKS). The lock is released as at any train end.
 * If the train still hasn't moved STUDIO_TRAIN_STALL_GRACE_S (default 300) later (a hang that isn't a child), the
 * worker ends the train's process; harness/train-life.mjs reapDeadTrains then records it, frees the lock and keeps
 * its lanes moving, as for any train that died.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMainThread, workerData } from 'node:worker_threads';

const num = (v, d) => { const s = String(v ?? '').trim(); if (/^(off|no|false)$/i.test(s)) return 0; const n = Number(s); return s !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
/** STUDIO_TRAIN_STALL_MIN in ms (default 90 min; 0/off: no watch). */
export const stallMs = (env = process.env) => num(env.STUDIO_TRAIN_STALL_MIN, 90) * 60000;
/** STUDIO_TRAIN_STALL_GRACE_S in ms (default 300 s): after stopping the children, how long the train has to end itself. */
export const stallGraceMs = (env = process.env) => num(env.STUDIO_TRAIN_STALL_GRACE_S, 300) * 1000;
/** Steps a train may sit in on purpose (a speculative train waiting for train A; ended). */
export const RESTING = new Set(['ready', 'waiting', 'done', 'died', 'ended', 'stalled']);
export const cancelPath = (root, id) => path.join(root, '.studio', 'train', `${id}.cancel.json`);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.w.tmp`; fs.writeFileSync(t, `${JSON.stringify(j, null, 2)}\n`); fs.renameSync(t, f); } catch {} };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// Loaded once the watch starts (a worker only), so a stall's event is written before its children are stopped.
let events = null;

/**
 * One look (pure but for the files it reads): { fire, why, step, text, since } for train `id`. last: the status's
 * time the watcher saw change last (ms), start: the train's start (ms).
 */
export function stallLook({ root, id, now = Date.now(), limitMs, start = now, alive = 0 }) {
  const sf = path.join(root, '.studio', 'train', String(id), 'status.json');
  const st = readJson(sf) || {};
  const changed = Math.max(mtime(sf) || start, alive || 0);
  const step = st.step || 'starting';
  const text = String(st.text || step).slice(0, 200);
  if (!(limitMs > 0) || RESTING.has(step)) return { fire: false, step, text, changed };
  const idle = now - changed;
  if (idle < limitMs) return { fire: false, step, text, changed };
  const span = idle < 120000 ? `${Math.round(idle / 1000)} s` : `${Math.round(idle / 60000)} min`;
  return { fire: true, step, text, changed, why: `its status stayed at "${text}" for ${span} (STUDIO_TRAIN_STALL_MIN ${Math.round(limitMs / 60000 * 100) / 100})` };
}

/**
 * Is one of the train's checks waiting in the machine:heavy queue (.studio/locks/machine-heavy-queue-<pid>.wait whose
 * owner is train-<id>…)? That wait is bounded by STUDIO_HEAVY_WAIT_MIN, so it counts as the train being alive.
 */
export function waitingForSlot(root, id) {
  try {
    const dir = path.join(root, '.studio', 'locks');
    return fs.readdirSync(dir).some((nm) => /^machine-heavy-queue-\d+\.wait$/.test(nm) && String(readJson(path.join(dir, nm))?.owner || '').startsWith(`train-${id}`));
  } catch { return false; }
}

/** Stop train process `pid`'s children (its whole tree below it), not the train: { killed, survivors }. 2.78.2 (a): also `train cancel`'s. */
export async function stopTrainChildren(pid) {
  try {
    const h = await import('./heavy.mjs');
    const r = h.killHolderTree({ pid, tree: { root: pid, groups: [] } }, { self: pid });
    return { killed: r.killed || [], survivors: r.survivors || [] };
  } catch (e) { return { killed: [], survivors: [], error: String(e?.message || e).slice(0, 200) }; }
}

async function fire({ root, id, pid, look, by }) {
  const lifeF = path.join(root, '.studio', 'train', String(id), 'life.json');
  const life = readJson(lifeF) || {};
  const tasks = (life.lanes || []).map((l) => l.task).filter(Boolean);
  const at = new Date().toISOString();
  writeJson(cancelPath(root, id), { tasks, by: 'train-stall', why: look.why, at, stall: true, step: look.step, text: look.text });
  writeJson(lifeF, { ...life, stalled: { at, step: look.step, text: look.text, why: look.why } });
  // Recorded first (the train may end as soon as its child is stopped, and this thread with it), then the children.
  const text = `stalled: ${look.why}; its running checks are stopped; this attempt ends at its next step (nothing lands from it, nobody is handed back, its lanes keep their place)`;
  writeJson(path.join(root, '.studio', 'train', String(id), 'status.json'), { train: id, at, step: 'stalled', text: text.slice(0, 400), eta: null, stalledFrom: look.step });
  try { process.stderr.write(`[train] ${id}: ${text}\n`); } catch {}
  try {
    const { emitEvent } = await events;
    emitEvent({ type: 'task.train.stalled', agent: String(by || `train-${id}`).slice(0, 60), to: 'producer', status: 'blocked', msg: `train ${id}: ${text}${tasks.length ? `; lanes ${tasks.join(', ')}` : ''}`.slice(0, 600), meta: { train: id, step: look.step, stepText: look.text, why: look.why, lanes: tasks } });
  } catch {}
  const k = await stopTrainChildren(pid);
  writeJson(lifeF, { ...(readJson(lifeF) || life), stalled: { at, step: look.step, text: look.text, why: look.why, killed: k.killed, survivors: k.survivors, ...(k.error ? { error: k.error } : {}) } });
  return { at: Date.now() };
}

async function endProcess({ root, id, pid, by, graceMs }) {
  const lifeF = path.join(root, '.studio', 'train', String(id), 'life.json');
  const life = readJson(lifeF) || {};
  if (life.ended) return false;
  const why = `it didn't end within STUDIO_TRAIN_STALL_GRACE_S (${Math.round(graceMs / 1000)} s) after its checks were stopped: the process is ended; the reaper records it and keeps its lanes`;
  writeJson(lifeF, { ...life, stalled: { ...(life.stalled || {}), ended: new Date().toISOString(), why2: why } });
  try { process.stderr.write(`[train] ${id}: stalled: ${why}\n`); } catch {}
  try { const { emitEvent } = await events; emitEvent({ type: 'task.train.stalled', agent: String(by || `train-${id}`).slice(0, 60), to: 'producer', status: 'blocked', msg: `train ${id}: still stalled: ${why}`.slice(0, 600), meta: { train: id, ended: true } }); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return true;
}

if (!isMainThread && workerData?.trainWatch) {
  const { root, id, pid, by, limitMs, graceMs, tickMs } = workerData;
  events = import('./event.mjs').catch(() => ({ emitEvent: () => {} }));
  const start = Date.now();
  let fired = null; // { at, statusAt }
  let busy = false;
  let alive = 0; // the last time one of its checks was seen waiting for a machine:heavy slot
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      if (fired) {
        const sf = path.join(root, '.studio', 'train', String(id), 'status.json');
        if (mtime(sf) > fired.statusAt + 1) { fired = null; return; } // it moved: watch again
        if (now - fired.at >= graceMs) { await endProcess({ root, id, pid, by, graceMs }); fired = { ...fired, at: Infinity }; }
        return;
      }
      if (waitingForSlot(root, id)) alive = now;
      const look = stallLook({ root, id, now, limitMs, start, alive });
      if (!look.fire) return;
      await fire({ root, id, pid, look, by });
      fired = { at: Date.now(), statusAt: mtime(path.join(root, '.studio', 'train', String(id), 'status.json')) };
    } catch {} finally { busy = false; }
  };
  setInterval(tick, tickMs);
}
