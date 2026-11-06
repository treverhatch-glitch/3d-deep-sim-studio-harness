/**
 * harness/train-cancel.mjs — 2.78.2 (a): `npm run task -- train cancel [<train id>] --by <you> [--why "…"]`.
 *
 * A red chain could hold the PC for two hours (train 125652) and the only ways out were waiting or killing processes
 * by hand, which left a dead train for the reaper. Cancel stops the running train cleanly, by the paths that already
 * exist for a stall (harness/train-watch.mjs, 2.77.3):
 *   1. the train's cancel marker (.studio/train/<id>.cancel.json, { cancel: true, by, why }; the marker `train leave`
 *      writes for one lane, 2.77.1) — the train stops at its next step (harness/train.mjs checkCancel): nothing more
 *      lands from that attempt, nobody is handed back, every lane still riding keeps (or gets) its place in the queue;
 *   2. its running checks are stopped (the stall watch's kill path: its whole tree below the train process), so a
 *      verify or a flake re-run it is blocked in returns at once;
 *   3. it waits up to STUDIO_TRAIN_CANCEL_WAIT_S (default 120) for the train to end by itself (its lock released, its
 *      life record's normal end). One that doesn't (a hang outside a child), and a speculative train (it never lands
 *      before its train A ended), is ended with its tree; its end is recorded here as cancelled (not "died"), its
 *      lock freed when it still names it, and its lanes kept as above;
 *   4. one task.train.cancelled event (to the Producer) with who, why and how it ended.
 * Who: as for `train leave` (a person, the orchestrator or another agent outside the harness, a Producer or Director
 * session; never a worker: harness/task-hold.mjs holdRefusal). The train daemon starts the next train at its next
 * pass as usual: `npm run task -- train auto off --by <name>` keeps trains from starting.
 */
import fs from 'node:fs';
import path from 'node:path';
import { emitEvent } from './event.mjs';
import { writeAtomic } from './fsafe.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(j, null, 2)}\n`); } catch {} };
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) && n >= 0 ? n : d; };
/** STUDIO_TRAIN_CANCEL_WAIT_S in ms (default 120 s): how long cancel waits for the train to end by itself. */
export const cancelWaitMs = (env = process.env) => num(env.STUDIO_TRAIN_CANCEL_WAIT_S, 120) * 1000;

/** The train to cancel: { id, pid, speculative, lockName } or { error }. */
export async function cancelTarget(root, id = null) {
  const life = await import('./train-life.mjs');
  const lockOf = (name) => { const l = readJson(path.join(root, '.studio', 'locks', name)); return l?.id ? { ...l, name } : null; };
  const locks = [lockOf('train.lock'), lockOf('train-next.lock')].filter(Boolean);
  let lk = null;
  if (id) lk = locks.find((l) => String(l.id) === String(id)) || null;
  else lk = locks.find((l) => l.pid && life.pidAlive(l.pid)) || null;
  const tid = id || lk?.id;
  if (!tid) return { error: 'No train is running (npm run task -- train status).' };
  const rec = readJson(life.lifeFile(root, tid));
  if (!rec && !lk && !fs.existsSync(path.join(root, '.studio', 'train', String(tid)))) return { error: `There is no train ${tid} (npm run task -- train status names the running one).` };
  if (rec?.ended) return { error: `Train ${tid} has already ended (${rec.ended.how || 'done'} at ${String(rec.ended.at || '').slice(0, 19)}).` };
  const pid = Number(rec?.pid || lk?.pid || life.pidOfId(tid)) || null;
  const { NEXT_BY } = await import('./train-pipeline.mjs');
  return { id: String(tid), pid, speculative: lk?.name === 'train-next.lock' || rec?.by === NEXT_BY || Boolean(lk?.speculative), lanes: (rec?.lanes || []).map((l) => l.task).filter(Boolean), life: rec };
}

/**
 * Cancel train `id` (default: the running one). opts: { by, why, env, waitMs, emit, kill: { children(pid), tree(pid) } }.
 * Returns { ok, message, id?, how? } (how: clean | ended | already-dead).
 */
export async function cancelTrain(root, { id = null, by = '', why = '', env = process.env, waitMs = cancelWaitMs(env), emit = emitEvent, kill = null } = {}) {
  const { holdRefusal } = await import('./task-hold.mjs');
  const refused = holdRefusal(by, env);
  if (refused) return { ok: false, message: refused.replace('hold a lane', 'cancel a train').replace('holds lanes', 'cancels trains').replace('Say who holds it', 'Say who cancels it') };
  const t = await cancelTarget(root, id);
  if (t.error) return { ok: false, message: t.error };
  const life = await import('./train-life.mjs');
  const tr = await import('./train.mjs');
  const { cancelPath } = await import('./train-watch.mjs');
  const who = String(by).trim().slice(0, 60);
  const reason = String(why || '').trim().slice(0, 300);
  const at = new Date().toISOString();
  const done = () => { const r = readJson(life.lifeFile(root, t.id)); return Boolean(r?.ended) || !life.pidAlive(t.pid); };
  const finishEvent = (how, extra = {}) => {
    const lanes = extra.lanes || t.lanes;
    const msg = `train ${t.id} cancelled by ${who}${reason ? `: ${reason}` : ''}; ${how === 'clean' ? 'it stopped its checks and ended' : how === 'ended' ? 'its process was ended' : 'it had already died'}; nobody handed back${lanes.length ? `, ${lanes.join(', ')} keep their place in the queue` : ''}`;
    emit({ type: 'task.train.cancelled', agent: who, to: 'producer', status: 'warn', msg: msg.slice(0, 600), meta: { train: t.id, by: who, why: reason || null, how, speculative: t.speculative, lanes, ...(extra.killed ? { killed: extra.killed } : {}) } });
  };
  // The process is gone already: the reaper records it (lanes kept, lock freed) as for any dead train.
  if (!life.pidAlive(t.pid)) {
    tr.reapTrains(root, { env });
    finishEvent('already-dead');
    return { ok: true, id: t.id, how: 'already-dead', message: `Train ${t.id} had already died (process ${t.pid || '?'} gone): recorded, its lock freed and its lanes kept in the queue.` };
  }
  writeJson(cancelPath(root, t.id), { tasks: [], cancel: true, by: who, why: reason, at });
  const children = kill?.children || (async (pid) => (await import('./train-watch.mjs')).stopTrainChildren(pid));
  let killed = [];
  if (!t.speculative) {
    const k = await children(t.pid);
    killed = k.killed || [];
    for (const until = Date.now() + waitMs; !done() && Date.now() < until;) sleep(250);
  }
  if (!t.speculative && done()) {
    finishEvent('clean', { killed });
    return { ok: true, id: t.id, how: 'clean', message: `Train ${t.id} is cancelled (by ${who}${reason ? `: ${reason}` : ''}): its running checks were stopped and it ended; nothing more lands from it, nobody was handed back and its lanes keep their place in the queue. The train daemon starts the next train at its next pass (npm run task -- train auto off --by <name> keeps trains from starting).` };
  }
  // It didn't end by itself (or it is a speculative train): end it with its tree and record the end here.
  const tree = kill?.tree || (async (pid) => { const h = await import('./heavy.mjs'); const r = h.killHolderTree({ pid, tree: { root: pid, groups: [] } }, { self: process.pid }); return { killed: r.killed || [], survivors: r.survivors || [] }; });
  const k2 = await tree(t.pid);
  killed = [...new Set([...killed, ...(k2.killed || [])])];
  for (const until = Date.now() + 10000; life.pidAlive(t.pid) && Date.now() < until;) sleep(200);
  const rec = readJson(life.lifeFile(root, t.id)) || { id: t.id, pid: t.pid, lanes: [] };
  if (!rec.ended) {
    rec.ended = { at: new Date().toISOString(), how: 'cancelled', by: who, why: reason, found: 'train cancel' };
    writeJson(life.lifeFile(root, t.id), rec);
    writeJson(path.join(root, '.studio', 'train', t.id, 'status.json'), { train: t.id, at: rec.ended.at, step: 'ended', text: `cancelled by ${who}${reason ? `: ${reason}` : ''}`.slice(0, 400), eta: null });
  }
  for (const name of ['train.lock', 'train-next.lock']) {
    const f = path.join(root, '.studio', 'locks', name);
    const l = readJson(f);
    if (l && String(l.id) === t.id) { try { fs.rmSync(f, { force: true }); } catch {} }
  }
  // Its lanes keep (or get) their place: a queued lane is still queued; a task done's own lane is queued.
  const kept = [];
  for (const l of rec.lanes || []) {
    if (!l?.task) continue;
    try { if (!tr.readQueue(root).some((e) => e.task === l.task) && !t.speculative) tr.enqueue(root, { task: l.task, agent: l.agent, dir: l.dir, branch: l.branch, head: l.head, all: Boolean(l.all), note: `queued again: train ${t.id} was cancelled` }); } catch {}
    kept.push(l.task);
  }
  try { (await import('./jobs.mjs')).jobDone({ kind: 'train', id: t.id, code: 1, result: 'cancelled', tail: `cancelled by ${who}${reason ? `: ${reason}` : ''}`.slice(0, 600), log: path.join('.studio', 'train', t.id).split(path.sep).join('/'), extra: { cancelled: true, by: who } }); } catch {}
  finishEvent('ended', { killed, lanes: kept });
  return { ok: true, id: t.id, how: 'ended', message: `Train ${t.id} is cancelled (by ${who}${reason ? `: ${reason}` : ''}): ${t.speculative ? 'a speculative train is ended with its checks' : `it didn't end within STUDIO_TRAIN_CANCEL_WAIT_S (${Math.round(waitMs / 1000)} s) after its checks were stopped, so its process was ended`}; its lock is freed, nobody was handed back${kept.length ? ` and ${kept.join(', ')} keep their place in the queue` : ''}.` };
}
