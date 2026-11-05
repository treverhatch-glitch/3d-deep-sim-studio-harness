/**
 * harness/train-life.mjs — 2.76.0 (B-88): a merge train records how it ended, and a dead one is found.
 *
 * Train 20261104-044849-34540 left .studio/train/<id>/status.json at "step": "verify" with no verify log and no end event;
 * its lanes went back to builders with no reason. A train runs in the process that asked for it (a `task done --train`
 * inside a builder's session, `task train`, the daemon's child): when that process ends mid-step (a crash in a step, an
 * unhandled rejection, Ctrl+C or a console closed, or the session's process tree killed by the launcher; on Windows that
 * is TerminateProcess and nothing in the process runs) nothing recorded the end.
 *
 * Now each train writes .studio/train/<id>/life.json { id, pid, by, at, lanes, ended } and a heartbeat file (beat, the
 * time, rewritten every 30 s by a worker thread, so a train blocked in a 30-minute verify still beats):
 *   - every exit path the process can see records the end with its cause: an exception in a step (runTrain's wrapper),
 *     an uncaught exception or unhandled rejection, SIGINT/SIGHUP/SIGBREAK (Ctrl+C, a closed console), process.exit
 *     mid-train; a SIGTERM or a kill ends it at once, as before, and the reaper records it;
 *   - reapDeadTrains (called before every train and by the train daemon's pass) finds a train that never recorded its
 *     end and whose process is gone (or whose heartbeat stopped for STUDIO_TRAIN_DEAD_MIN, 30, minutes on two looks
 *     in a row: Windows reuses process ids). It records task.train.died "died: <last step>" and a job.done (result
 *     died), marks its status "died", frees the train lock (2.77.0: or the speculative train's train-next.lock) if it
 *     still names that train, and keeps its lanes moving:
 *     a queued lane is still queued; a task done's own lane (not queued) is put in the queue once per head (a second
 *     death with the same head goes to the Producer instead). None of this is a hand-back, so it never counts toward
 *     STUDIO_TRAIN_MAX_HANDBACKS.
 * 2.77.3 (H2, B-112): a second worker watches the status (harness/train-watch.mjs, STUDIO_TRAIN_STALL_MIN, 90): a train
 * whose status hasn't changed that long while it works has its children stopped and ends its attempt (lanes kept).
 * Trains from before 2.76.0 have no life.json: a status.json that never reached "done" is judged by the process id in
 * the train id (<stamp>-<pid>).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { emitEvent } from './event.mjs';
import { jobDone } from './jobs.mjs';
import { stallMs, stallGraceMs } from './train-watch.mjs';

const TRAIN_DIR = path.join('.studio', 'train');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify(j, null, 2)}\n`); fs.renameSync(t, f); } catch {} };
export const pidAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const lifeFile = (root, id) => path.join(root, TRAIN_DIR, String(id), 'life.json');
const beatFile = (root, id) => path.join(root, TRAIN_DIR, String(id), 'beat');
const statusFile = (root, id) => path.join(root, TRAIN_DIR, String(id), 'status.json');
const ENDED = new Set(['done', 'died', 'ended']);
export const deadMin = (env = process.env) => { const v = Number(String(env.STUDIO_TRAIN_DEAD_MIN ?? '').trim()); return Number.isFinite(v) && v > 0 ? v : 30; };
/** The process id a train id carries (<yyyymmdd>-<hhmmss>-<pid>[-k]), or null. */
export const pidOfId = (id) => { const m = String(id || '').match(/^\d{8}-\d{6}-(\d+)(?:-\d+)?$/); return m ? Number(m[1]) : null; };
const laneRow = (l) => ({ task: l.task, agent: l.agent || null, dir: l.dir || null, branch: l.branch || null, head: l.head || null, all: Boolean(l.all), fromQueue: Boolean(l.fromQueue), own: Boolean(l.own) });
const stepOf = (root, id) => { const s = readJson(statusFile(root, id)); return s ? { step: s.step || 'starting', text: String(s.text || s.step || '').slice(0, 200) } : { step: 'starting', text: 'starting' }; };

const live = new Map(); // id -> handle, for this process's handlers
let handlersOn = false;
function onSignal(sig) {
  for (const h of [...live.values()]) h.died(`stopped by ${sig}`, { signal: sig });
  removeHandlers();
  process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGHUP' ? 129 : 149);
}
function onUncaught(err, origin) {
  for (const h of [...live.values()]) h.died(`${origin === 'unhandledRejection' ? 'an unhandled rejection' : 'an uncaught exception'}: ${String(err?.message || err).slice(0, 200)}`);
  // Only ours listens: do what Node does without one (print it, exit 1).
  if (process.listenerCount('uncaughtException') <= 1) { try { console.error(err?.stack || String(err)); } catch {} removeHandlers(); process.exit(1); }
}
function onExit(code) { for (const h of [...live.values()]) h.died(`the process exited (code ${code}) mid-train`); }
// Only the signals a terminal sends to the whole process group (Ctrl+C, Ctrl+Break, a console closed): the verify's
// child gets them too, so the handler runs as soon as it stops. SIGTERM keeps Node's default (end at once, even in a
// 30-minute spawnSync): the reaper records that death.
const SIGNALS = process.platform === 'win32' ? ['SIGINT', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGHUP'];
function addHandlers() {
  if (handlersOn) return;
  handlersOn = true;
  for (const s of SIGNALS) { try { process.on(s, onSignal); } catch {} }
  process.on('uncaughtException', onUncaught);
  process.on('exit', onExit);
}
function removeHandlers() {
  if (!handlersOn || live.size) return;
  handlersOn = false;
  for (const s of SIGNALS) { try { process.off(s, onSignal); } catch {} }
  process.off('uncaughtException', onUncaught);
  process.off('exit', onExit);
}

const BEAT_SRC = `const { workerData } = require('node:worker_threads'); const fs = require('node:fs');
const beat = () => { try { fs.writeFileSync(workerData.file, String(Date.now())); } catch {} };
beat(); setInterval(beat, workerData.ms);`;

/**
 * Start recording train `id`'s life. Returns a handle: lanes(list) records its lanes, end(summary) records a normal end,
 * died(cause) records a death (idempotent; the first record wins). Never throws.
 */
export function beginTrainLife(root, { id, by = 'train', beatMs = 30000, harness = null } = {}) {
  const f = lifeFile(root, id);
  // 2.78.1 (B-122): the harness this train's process runs (harness-version.mjs processHarness: version, committed tree,
  // last harness commit), so a train from before an update is known as one (upgrade --preflight lists those still running).
  const doc = { id, pid: process.pid, by, at: new Date().toISOString(), lanes: [], ended: null, ...(harness ? { harness } : {}) };
  writeJson(f, doc);
  let worker = null;
  try {
    worker = new Worker(BEAT_SRC, { eval: true, workerData: { file: beatFile(root, id), ms: beatMs } });
    worker.unref();
    worker.on('error', () => {});
  } catch { try { fs.writeFileSync(beatFile(root, id), String(Date.now())); } catch {} }
  // 2.77.3 (H2, B-112): the stall watch (harness/train-watch.mjs): a status unchanged for STUDIO_TRAIN_STALL_MIN ends
  // the attempt (cancel marker, the train's children stopped), so a hang can't hold the train lock indefinitely.
  let watch = null;
  const limitMs = stallMs();
  if (limitMs > 0) {
    try {
      watch = new Worker(new URL('./train-watch.mjs', import.meta.url), { workerData: { trainWatch: true, root, id, pid: process.pid, by, limitMs, graceMs: stallGraceMs(), tickMs: Math.max(250, Math.min(30000, Math.round(limitMs / 12))) } });
      watch.unref();
      watch.on('error', () => {});
    } catch { watch = null; }
  }
  let done = false;
  const stop = () => { live.delete(id); try { worker?.terminate(); } catch {} try { watch?.terminate(); } catch {} removeHandlers(); };
  const h = {
    id,
    lanes(list) { if (done) return; doc.lanes = (list || []).map(laneRow); writeJson(f, doc); },
    end(summary = '') { if (done) return; done = true; doc.ended = { at: new Date().toISOString(), how: 'done', summary: String(summary || '').slice(0, 300) }; writeJson(f, doc); stop(); },
    died(cause, extra = {}) {
      if (done) return;
      done = true;
      const st = stepOf(root, id);
      doc.ended = { at: new Date().toISOString(), how: 'died', cause: String(cause).slice(0, 300), step: st.step, ...extra };
      writeJson(f, doc);
      recordDeath(root, id, { cause: String(cause), step: st, lanes: doc.lanes, by, self: true });
      stop();
    },
  };
  live.set(id, h);
  addHandlers();
  return h;
}

function recordDeath(root, id, { cause, step, lanes, by, self = false }) {
  const text = `died: ${step.step}${step.text && step.text !== step.step ? ` (${step.text})` : ''}`;
  writeJson(statusFile(root, id), { train: id, at: new Date().toISOString(), step: 'died', text: `${text}; ${cause}`.slice(0, 400), eta: null });
  try { emitEvent({ type: 'task.train.died', agent: String(by || 'train').slice(0, 60), to: 'producer', status: 'blocked', msg: `train ${id}: ${text}: ${cause}${lanes?.length ? `; lanes ${lanes.map((l) => l.task).join(', ')} keep their place (no hand-back)` : ''}`.slice(0, 600), meta: { train: id, step: step.step, stepText: step.text, cause, found: self ? 'itself' : 'reaper', lanes: (lanes || []).map((l) => l.task) } }); } catch {}
  try { jobDone({ kind: 'train', id, code: 1, result: 'died', tail: `${text}: ${cause}`.slice(0, 600), log: path.join(TRAIN_DIR, String(id)).split(path.sep).join('/'), extra: { died: true, step: step.step } }); } catch {}
}

/**
 * Is train `id` (its life.json, or a status.json alone) dead? { dead, why } — never for one that recorded its end.
 * A live process with a heartbeat older than STUDIO_TRAIN_DEAD_MIN is "suspect" on the first look and dead on a later
 * one (a reused pid on Windows, or a frozen process), so one late beat after a sleep never kills a train's record.
 */
export function judgeTrain(root, id, { now = Date.now(), env = process.env } = {}) {
  const life = readJson(lifeFile(root, id));
  const st = readJson(statusFile(root, id));
  if (life?.ended || (!life && (!st || ENDED.has(st.step)))) return { dead: false, why: 'ended' };
  if (life && st && ENDED.has(st.step)) return { dead: false, why: 'ended' };
  // A train from before 2.76.0 (no life.json): only one whose status changed in the last 24 h (an older stuck status, or one
  // left at "verify" by an early return, isn't news).
  if (!life) { try { if (now - fs.statSync(statusFile(root, id)).mtimeMs > 24 * 3600000) return { dead: false, why: 'old' }; } catch { return { dead: false, why: 'no status' }; } }
  const pid = life?.pid || pidOfId(id);
  if (!pid) return { dead: false, why: 'no process id' };
  if (!pidAlive(pid)) return { dead: true, why: `its process ${pid} is gone${life?.stalled ? ` (it had stalled: ${String(life.stalled.why || '').slice(0, 160)})` : ''}` };
  if (!life) return { dead: false, why: 'its process is alive' };
  let beat = 0;
  try { beat = Number(fs.readFileSync(beatFile(root, id), 'utf8')) || 0; } catch {}
  const staleMs = deadMin(env) * 60000;
  if (beat && now - beat <= staleMs) { if (life.suspect) { delete life.suspect; writeJson(lifeFile(root, id), life); } return { dead: false, why: 'beating' }; }
  if (!life.suspect || Number(life.suspect.beat) !== beat) { life.suspect = { at: new Date(now).toISOString(), beat }; writeJson(lifeFile(root, id), life); return { dead: false, why: 'suspect' }; }
  if (now - Date.parse(life.suspect.at) < 60000) return { dead: false, why: 'suspect' };
  return { dead: true, why: `process ${pid} is alive but its heartbeat stopped ${Math.round((now - (beat || Date.parse(life.at))) / 60000)} min ago (STUDIO_TRAIN_DEAD_MIN ${deadMin(env)}): a reused process id, or a frozen process` };
}

/**
 * Find every train that died without recording its end, record it, free its lock and keep its lanes moving.
 * opts: { now, env, log, entryOf(task) -> queue entry|null, mark(task, patch), enqueue(lane), onMain(head) -> bool,
 * toProducer(lane, note) }. A lane still queued keeps its place (marked diedIn); a lane that wasn't queued (a task done's
 * own) is queued; a lane a train already died with at the same head goes to the Producer (toProducer) instead.
 * Returns [{ id, step, why, requeued: [task], producer: [task] }]. Never throws.
 */
export function reapDeadTrains(root, { now = Date.now(), env = process.env, log = () => {}, entryOf = () => null, mark = () => {}, enqueue = () => {}, onMain = () => false, toProducer = () => {} } = {}) {
  const outp = [];
  let ids = [];
  try { ids = fs.readdirSync(path.join(root, TRAIN_DIR), { withFileTypes: true }).filter((e) => e.isDirectory() && /^\d{8}-\d{6}-\d+/.test(e.name)).map((e) => e.name); } catch { return outp; }
  for (const id of ids) {
    try {
      const j = judgeTrain(root, id, { now, env });
      if (!j.dead) continue;
      const life = readJson(lifeFile(root, id)) || { id, pid: pidOfId(id), by: 'train', lanes: [] };
      const step = stepOf(root, id);
      life.ended = { at: new Date(now).toISOString(), how: 'died', cause: j.why, step: step.step, found: 'reaper' };
      writeJson(lifeFile(root, id), life);
      // 2.77.0 (p, P9.6): the speculative train's own lock (train-next.lock) too, when it names the dead train.
      for (const name of ['train.lock', 'train-next.lock']) {
        const lockF = path.join(root, '.studio', 'locks', name);
        const lk = readJson(lockF);
        if (lk && String(lk.id) === String(id)) { try { fs.rmSync(lockF, { force: true }); } catch {} }
      }
      const requeued = [];
      const producer = [];
      const diedIn = { train: id, step: step.step, at: new Date(now).toISOString() };
      for (const l of life.lanes || []) {
        if (!l?.task || (l.head && onMain(l.head))) continue;
        let e = null;
        try { e = entryOf(l.task); } catch {}
        if (e?.diedIn?.head && e.diedIn.head === (e.head || l.head) && e.diedIn.train !== id) {
          try { toProducer({ ...l, ...e }, `two trains died with ${l.task} at ${String(e.head || l.head).slice(0, 8)} (${e.diedIn.train} during ${e.diedIn.step}, then ${id} during ${step.step}): the Producer looks before it trains again`); } catch {}
          producer.push(l.task);
          continue;
        }
        try {
          if (e) mark(l.task, { diedIn: { ...diedIn, head: e.head || l.head } });
          else { enqueue({ ...l, diedIn: { ...diedIn, head: l.head } }); requeued.push(l.task); }
        } catch {}
      }
      recordDeath(root, id, { cause: j.why, step, lanes: life.lanes || [], by: life.by });
      log(`[train] train ${id} died: ${step.step} (${j.why})${requeued.length ? `; queued again: ${requeued.join(', ')}` : ''}${producer.length ? `; to the Producer: ${producer.join(', ')}` : ''}`);
      outp.push({ id, step: step.step, why: j.why, requeued, producer });
    } catch {}
  }
  return outp;
}
