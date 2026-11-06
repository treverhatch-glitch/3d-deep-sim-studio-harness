#!/usr/bin/env node
/**
 * harness/train-pipeline.mjs — 2.77.0 (p, P9.6): pipelined merge trains, and a batch cap per train.
 *
 * A full verify takes about 23-25 minutes on the crew's PC, so lanes waited in line: one train, then the next. Two
 * trains verifying side by side would each verify against a main that is about to move (the second would have to
 * verify again after the first lands), so the trains are pipelined instead:
 *
 *   - batch: a train takes at most STUDIO_TRAIN_BATCH ready lanes (default 4; 0/off: no cap, the 2.76 way), beside
 *     STUDIO_TRAIN_MAX and --max (the smallest cap wins). Fix-first (B-75) still picks its lane before the cap; tiers,
 *     holds and run-alone lanes are judged as before;
 *   - pipeline: while train A verifies, at most ONE speculative train B verifies "main + A's merged result + B's lanes"
 *     in its own scratch copy, under its own lock (.studio/locks/train-next.lock; never two B's). B lands right after A,
 *     without verifying again, when main is then exactly A's verified tree (A landed it), or that tree plus record files
 *     only (the record rule: nextBaseVerdict in harness/train.mjs, its core speculativeBaseVerdict here). If A goes red,
 *     is rebuilt, held, bisected, or ends without landing, or main moves any other way, B is discarded: its lanes keep
 *     their place in the queue (no hand-back, nothing counted toward STUDIO_TRAIN_MAX_HANDBACKS), a
 *     task.train.next_discarded event says why, and the lanes go in the next normal train (B's process runs it when the
 *     train daemon is on). B lands under the train lock (.studio/locks/train.lock), as any train does: never two
 *     trains landing at once, and main moves by compare-and-swap from the tip B assumed;
 *   - STUDIO_TRAIN_PIPELINE: unset (auto) starts B only when the machine budget has room for a second train verify
 *     beside A's (harness/heavy-budget.mjs, the same admission machine:heavy uses; no machine scan: no room, so trains
 *     wait as before); on: start B whenever there are lanes (its verify still waits for its own machine:heavy claim);
 *     off: never.
 *
 * B is conservative: it never hands a lane back, never holds one for the owner and never bisects. A lane it would have
 * to (a precheck refusal, tier C not released, a missing Golden-Reason, run alone behind others, a conflict on A's
 * tree, a dependency) is left for the next normal train, which applies the rules as before; B's own red verify only
 * discards B. A started B, or the train daemon's pass while A verifies (pipelineKick / nextPass), spawns it as a
 * detached child: `node harness/train-daemon.mjs run-next <A's id>` (runNextNow).
 *
 * Imports nothing from train.mjs at load time (train.mjs imports this file); the child's CLI imports it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { machineProfile, slotsFor, budgetState, jobClaim, admit, maxConcurrent, rigKind } from './heavy-budget.mjs';
import { spawnDetached } from './train-detach.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const NEXT_BY = 'train-next';
export const nextLockFile = (root) => path.join(root, '.studio', 'locks', 'train-next.lock');
const trainLockFile = (root) => path.join(root, '.studio', 'locks', 'train.lock');
const statusFile = (root, id) => path.join(root, '.studio', 'train', String(id), 'status.json');
const lifeFile = (root, id) => path.join(root, '.studio', 'train', String(id), 'life.json');
export const staleMs = (env) => (Number(env.STUDIO_TRAIN_STALE_MIN) > 0 ? Number(env.STUDIO_TRAIN_STALE_MIN) : 360) * 60000;

// ---- the batch cap ------------------------------------------------------------------------------------

/** STUDIO_TRAIN_BATCH: the most lanes one train takes (default 4; 0/off: no cap). */
export function batchSize(env = process.env) {
  const raw = String(env.STUDIO_TRAIN_BATCH ?? '').trim();
  if (raw === '') return 4;
  if (off(raw)) return 0;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : 4;
}

/** The lane cap of one train: the smallest of --max, STUDIO_TRAIN_MAX and STUDIO_TRAIN_BATCH that is set (0: none). */
export function batchCap({ max = 0, rulesMax = 0, env = process.env } = {}) {
  const caps = [Number(max) > 0 ? Number(max) : 0, Number(rulesMax) > 0 ? Number(rulesMax) : 0, batchSize(env)].filter((n) => n > 0);
  return caps.length ? Math.min(...caps) : 0;
}

// ---- the switch and the room ------------------------------------------------------------------------------

/** STUDIO_TRAIN_PIPELINE: 'auto' (unset: on when the machine budget has room), 'on' or 'off'. */
export function pipelineMode(env = process.env) {
  const raw = String(env.STUDIO_TRAIN_PIPELINE ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'auto') return 'auto';
  if (off(raw)) return 'off';
  return /^(on|1|true|yes)$/.test(raw) ? 'on' : 'auto';
}

/**
 * Room for a second train verify beside A's: { ok, why }. A's own verify claim is counted even before its run-gates
 * takes it (the kick comes right before A's verify starts). opts.machine / opts.holders are test hooks.
 */
export async function pipelineRoom({ root, env = process.env, machine, holders } = {}) {
  const profile = machineProfile(root, { env, ...(machine !== undefined ? { machine } : {}) });
  if (!profile) return { ok: false, why: 'no machine scan (npm run machine writes one), so no second verify is started' };
  let live = holders;
  if (!Array.isArray(live)) { try { live = (await import('./heavy.mjs')).heavyHolders(root, { env }); } catch { live = []; } }
  const sim = [...live];
  if (!sim.some((h) => rigKind(h) === 'train')) {
    const st0 = budgetState(profile, sim, { env });
    sim.push({ pid: 0, at: Date.now(), landing: true, claim: jobClaim('verify', { root, env, state: st0, profile, as: 'train', label: "train A's verify" }) });
  }
  const state = budgetState(profile, sim, { env });
  const claim = jobClaim('verify', { root, env, state, profile, as: 'train', label: 'speculative train verify' });
  const a = admit(claim, state, { slots: slotsFor(profile, env), holders: sim, kindMax: maxConcurrent('verify', { root, env }) });
  if (!a.ok) return { ok: false, why: a.line || 'the budget says no' };
  if (a.alone) return { ok: false, why: `it would run alone (${a.line})` };
  return { ok: true, why: `a second train verify fits the machine budget beside train A's (${claim.workers || '?'} test workers: ${String(claim.workersWhy || '').slice(0, 160)})` };
}

// ---- the locks ---------------------------------------------------------------------------------------------

/** The live speculative train's lock record ({ pid, at, id, after, base, lanes, by }), or null. */
export function readNextLock(root, { env = process.env, now = Date.now() } = {}) {
  const h = readJson(nextLockFile(root));
  if (!h || !h.pid || !alive(h.pid) || now - Number(h.at || 0) > staleMs(env)) return null;
  return h;
}

/** The live train lock's record, or null. */
export function readTrainLock(root, { env = process.env, now = Date.now() } = {}) {
  const h = readJson(trainLockFile(root));
  if (!h || (h.pid && !alive(h.pid)) || now - Number(h.at || 0) > staleMs(env)) return null;
  return h;
}

/**
 * Take the speculative train's lock (one at a time). Returns { ok, release() } or { ok: false, holder }. A lock left
 * by a dead process (or older than STUDIO_TRAIN_STALE_MIN) is taken over.
 */
export function takeNextLock(root, info, { env = process.env } = {}) {
  const f = nextLockFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), ...info }), { flag: 'wx' });
      const update = (patch) => { try { const h = readJson(f); if (h && h.pid === process.pid && h.id === info.id) fs.writeFileSync(f, JSON.stringify({ ...h, ...patch })); } catch {} };
      const release = () => { try { const h = readJson(f); if (!h || (h.pid === process.pid && h.id === info.id)) fs.rmSync(f, { force: true }); } catch {} };
      return { ok: true, update, release };
    } catch (err) {
      if (!['EEXIST', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      const h = readJson(f);
      if (h && h.pid && alive(h.pid) && Date.now() - Number(h.at || 0) <= staleMs(env)) return { ok: false, holder: h };
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
  return { ok: false, holder: readJson(f) || { why: 'unreadable lock' } };
}

/**
 * A speculative train that the other trains wait for: its lock is live, its train A no longer holds the train lock
 * (A ended: B lands now) and main (tip, when given) is the tree it built on. While A holds the train lock, that lock
 * already makes the others wait; a B whose base main is not will be discarded, so nobody waits for it. self: the
 * caller's own train id (its own B is behind it, never ahead). Returns the lock record or null.
 */
export function nextBusy(root, { env = process.env, now = Date.now(), tip = null, self = null } = {}) {
  const n = readNextLock(root, { env, now });
  if (!n) return null;
  if (self && n.after === self) return null; // it is behind the caller (the caller is its train A)
  const t = readTrainLock(root, { env, now });
  if (t && t.id === n.after) return null;
  if (tip && n.base && n.base !== tip) return null; // main isn't the tree it built on: it can't land, it is discarded
  return n;
}

// ---- train A, as B sees it ---------------------------------------------------------------------------------

/**
 * Train A's state for its speculative train: { id, live, ended, step, text, head, tree, base, tasks }. live: A holds
 * the train lock and its process runs; ended: its life record's end ({ how, summary|cause }), null while it runs.
 */
export function trainState(root, id, { env = process.env, now = Date.now() } = {}) {
  const st = readJson(statusFile(root, id)) || {};
  const life = readJson(lifeFile(root, id));
  const lock = readTrainLock(root, { env, now });
  const pid = life?.pid || null;
  const live = Boolean(lock && lock.id === id) && (!pid || alive(pid));
  return { id, live, ended: life?.ended || (!live && pid && !alive(pid) ? { how: 'died', cause: `its process ${pid} is gone` } : null), step: st.step || null, text: String(st.text || '').slice(0, 200), head: st.head || null, tree: st.tree || null, base: st.base || null, tasks: Array.isArray(st.tasks) ? st.tasks : [] };
}

/**
 * Is main exactly the tree B assumed (A's verified tree), or that plus record files only? Pure apart from the hook:
 * { land: true, how: 'same' } | { land: true, how: 'record', files } | { land: false, why }. recordMove(root, from, to,
 * lanes) -> { ok, files } | { ok: false, why } is the record-file rule (train.mjs nextBaseVerdict passes the B-29 board
 * rule; P9.1's record-only rule plugs in there).
 */
export function speculativeBaseVerdict(root, { assumed, now, lanes = [] }, { recordMove = null } = {}) {
  if (!assumed || !now) return { land: false, why: 'no tree to compare' };
  if (now === assumed) return { land: true, how: 'same' };
  if (typeof recordMove !== 'function') return { land: false, why: `main is at ${String(now).slice(0, 8)}, not ${String(assumed).slice(0, 8)}` };
  let r;
  try { r = recordMove(root, assumed, now, lanes); } catch (e) { r = { ok: false, why: e.message }; }
  if (r?.ok) return { land: true, how: 'record', files: r.files || [] };
  return { land: false, why: `main moved ${String(assumed).slice(0, 8)} -> ${String(now).slice(0, 8)}${r?.why ? `: ${r.why}` : ''}` };
}

/**
 * What B does now, from A's state (pure): { wait: true } | { land: true, how, files? } | { discard: why }.
 * f: { a: trainState, base (A's tree B built on: A's head), tip0 (main when B started), mainNow, verdict(now) }.
 */
export function judgeTrainA({ a, base, tip0, mainNow, verdict }) {
  const name = `train ${a?.id || '?'}`;
  if (a && a.live && !a.ended) {
    if (a.head && a.head !== base) return { discard: `${name} changed its tree (${String(base).slice(0, 8)} -> ${String(a.head).slice(0, 8)}: ${a.step || '?'}, ${a.text || 'rebuilt'})` };
    if (['verify', 'done'].includes(a.step)) return { wait: true };
    return { discard: `${name} went red or is bisecting (${a.step || '?'}: ${a.text || ''})`.trim() };
  }
  if (mainNow === tip0) return { discard: `${name} ended without landing (${a?.ended?.how || 'ended'}${a?.ended?.summary || a?.ended?.cause ? `: ${String(a.ended.summary || a.ended.cause).slice(0, 200)}` : ''})` };
  const v = verdict(mainNow);
  if (v.land) return { land: true, how: v.how, ...(v.files ? { files: v.files } : {}) };
  return { discard: `${main(mainNow, base)}: ${v.why}` };
}
const main = (now, base) => `main is not train A's verified tree (${String(base).slice(0, 8)}) but ${String(now).slice(0, 8)}`;

// ---- which lanes B takes ------------------------------------------------------------------------------------

/**
 * B's lanes, from the queue's candidates in order (pure). Each: { task, tier, released, runAlone: { yes, why }, held,
 * out, wait, fixFirst, needs, capped, inA }. Returns { lanes, skipped: [{ task, why }], wait: why|null }. A lane the
 * rules would hold, hand back or run alone behind others is left for the next normal train (skipped, never touched).
 */
export function pickNextLanes(cands = [], { batch = 4 } = {}) {
  const skipped = [];
  const ok = [];
  const fix = cands.find((c) => c.fixFirst && !c.inA);
  if (fix) return { lanes: [], skipped: [], wait: `${fix.task} is a fix lane that trains first and alone (B-75): no speculative train` };
  for (const c of cands) {
    if (c.inA) continue;
    if (c.held) { skipped.push({ task: c.task, why: `held for the owner (tier ${c.held.tier || '?'})` }); continue; }
    if (c.out) { skipped.push({ task: c.task, why: 'held out of trains' }); continue; }
    if (c.wait) { skipped.push({ task: c.task, why: c.wait }); continue; }
    if (c.tier === 'C' && !c.released) { skipped.push({ task: c.task, why: 'tier C, not released: the next normal train holds it for the owner' }); continue; }
    if (c.needs) { skipped.push({ task: c.task, why: `the next normal train decides (${c.needs})` }); continue; }
    if (c.capped) { skipped.push({ task: c.task, why: 'handed back more than STUDIO_TRAIN_MAX_HANDBACKS: the next normal train holds it' }); continue; }
    ok.push(c);
  }
  let group = ok;
  if (ok.length && ok[0].runAlone?.yes) group = [ok[0]];
  else group = ok.filter((c) => !c.runAlone?.yes);
  for (const c of ok.filter((x) => !group.includes(x))) skipped.push({ task: c.task, why: c.runAlone?.yes ? `it runs alone (${c.runAlone.why}): a train of its own` : `${ok[0].task} runs alone: this lane goes in the next train` });
  const cap = Number(batch) > 0 ? Number(batch) : group.length;
  for (const c of group.slice(cap)) skipped.push({ task: c.task, why: `past the batch of ${cap} (STUDIO_TRAIN_BATCH)` });
  return { lanes: group.slice(0, cap), skipped, wait: null };
}

// ---- starting B ------------------------------------------------------------------------------------------

/**
 * Should a speculative train start now? Pure: f = { mode, room, next (live lock), a (trainState of the running train),
 * ready (queued lanes not in A, not held) }. { start, why }.
 */
export function nextDecision(f) {
  const no = (why) => ({ start: false, why });
  if (f.mode === 'off') return no('STUDIO_TRAIN_PIPELINE=off');
  if (f.drain) return no(`drain is on (${f.drain})`);
  if (f.next) return no(`a speculative train is already running (${f.next.id || '?'}, after ${f.next.after || '?'})`);
  if (!f.a || !f.a.live) return no('no train is running');
  if (f.a.step !== 'verify' || !f.a.head) return no(`train ${f.a.id} is not verifying a known tree (${f.a.step || 'starting'})`);
  if (!(f.ready || []).length) return no('no other lane is queued');
  if (f.mode === 'auto' && !f.room?.ok) return no(`no room for a second verify: ${f.room?.why || 'the budget says no'} (STUDIO_TRAIN_PIPELINE=on starts one anyway)`);
  return { start: true, why: `${f.ready.length} lane(s) queued behind train ${f.a.id}${f.mode === 'auto' ? `; ${f.room.why}` : ' (STUDIO_TRAIN_PIPELINE=on)'}` };
}

/** The queued lanes a B could take, cheaply (no git): not in A, not held for the owner, not held out of trains. */
function readyBehind(root, a) {
  const q = readJson(path.join(root, '.studio', 'train', 'queue.json'));
  let holds = {};
  try { holds = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch {}
  return (Array.isArray(q) ? q : []).filter((e) => e && e.task && !(a.tasks || []).includes(e.task) && !(e.held && !(e.released && e.released.head === e.head)) && !holds[e.task]?.held);
}

/**
 * Start B behind train `after` if the decision says so (A calls it right before its verify; the train daemon on each
 * pass while a train runs). spawn(root, { after, env }) -> { pid } (default spawnNextTrain). { started, why, pid? }.
 * Never throws.
 */
export async function pipelineKick(root, { after, env = process.env, spawn: spawnIt = spawnNextTrain, log = () => {}, machine, holders, emit = null } = {}) {
  try {
    const mode = pipelineMode(env);
    if (mode === 'off') return { started: false, why: 'STUDIO_TRAIN_PIPELINE=off' };
    // 2.79 (b): a speculative train is a train start: `train auto off` stops it too (the one reader, train-daemon.mjs trainAuto).
    const auto = (await import('./train-daemon.mjs')).trainAuto(root, env);
    if (!auto.on) return { started: false, why: auto.why };
    const next = readNextLock(root, { env });
    const lock = readTrainLock(root, { env });
    const id = after || lock?.id;
    const a = id ? trainState(root, id, { env }) : null;
    const ready = a ? readyBehind(root, a) : [];
    let drain = null;
    try { const dr = await (await import('./busy.mjs')).readDrain(); drain = dr?.on ? `by ${dr.by || '?'}` : null; } catch {}
    const f = { mode, next, a, ready, drain, room: { ok: false } };
    let d = nextDecision({ ...f, room: { ok: true } });
    if (d.start && mode === 'auto') { f.room = await pipelineRoom({ root, env, ...(machine !== undefined ? { machine } : {}), ...(holders !== undefined ? { holders } : {}) }); d = nextDecision(f); }
    if (!d.start) return { started: false, why: d.why };
    const child = spawnIt(root, { after: id, env });
    log(`[train] ${id}: speculative train started behind it (pid ${child?.pid || '?'}): ${d.why}`);
    try { (emit || (await import('./event.mjs')).emitEvent)({ type: 'task.train.next_started', agent: 'train', status: 'ok', msg: `train ${id}: a speculative train starts behind it: ${d.why}`.slice(0, 600), meta: { train: id, pid: child?.pid || null, ready: ready.map((e) => e.task), mode } }); } catch {}
    return { started: true, why: d.why, pid: child?.pid || null };
  } catch (e) { return { started: false, why: `error: ${e.message}` }; }
}

/**
 * The detached child: node harness/train-daemon.mjs run-next <after> (output in .studio/train/next.log). Its entry is in
 * train-daemon.mjs: this file is imported by train.mjs, so a CLI here would import train.mjs while it loads.
 */
export function spawnNextTrain(root, { after, env = process.env } = {}) {
  const log = path.join(root, '.studio', 'train', 'next.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  // 2.78.2 (a, W-0090): through a launcher that exits at once, so it outlives its starter (harness/train-detach.mjs).
  const d = spawnDetached({ args: [path.join(HERE, 'train-daemon.mjs'), 'run-next', String(after)], out: log, env: { ...env, STUDIO_LOCK_OWNER: NEXT_BY, STUDIO_MAIN_ROOT: root }, cwd: root });
  if (d.ok) return { pid: d.pid };
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'train-daemon.mjs'), 'run-next', String(after)], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...env, STUDIO_LOCK_OWNER: NEXT_BY, STUDIO_MAIN_ROOT: root } });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return { pid: child.pid };
}

/** Wait (polling) while a speculative train others wait for is live: { waited, gone }. maxMs 0: don't wait. */
export async function waitForNext(root, { env = process.env, maxMs = 0, poll = 1000, log = () => {}, tipOf = () => null, self = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const t0 = Date.now();
  let told = false;
  for (;;) {
    const n = nextBusy(root, { env, tip: tipOf(), self });
    if (!n) return { waited: Date.now() - t0, gone: true };
    if (Date.now() - t0 >= maxMs) return { waited: Date.now() - t0, gone: false, holder: n };
    if (!told) { log(`[train] the speculative train ${n.id || '?'} (after ${n.after || '?'}) lands or is discarded first; waiting for it`); told = true; }
    await sleep(Math.min(poll, Math.max(50, maxMs - (Date.now() - t0))));
  }
}
