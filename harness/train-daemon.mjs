/**
 * harness/train-daemon.mjs — 2.69.0 (r): the train daemon (the crew orchestrator's duty 3, now code).
 *
 * The orchestrator chose when to run merge trains, waited for a quiet PC, retried refusals, read the results and routed
 * hand-backs to fixers by hand. Now each supervisor pass (harness/supervisor.mjs; no model, no tokens) asks
 * trainDaemonPass() whether to start a train, and starts one when ALL hold:
 *   - the daemon is on: STUDIO_TRAIN_AUTO (default on while a supervisor runs) and no `train auto off` switch
 *     (.studio/train/auto.json, set by `npm run task -- train auto off|on --by <name>`: decider rules, harness/decider.mjs:
 *     a person, an agent under the owner's delegation, or a Producer/Director session or an outside agent on a
 *     person's permission; never a worker), and the train itself is on (STUDIO_TRAIN);
 *   - nothing stops it: no usage wind-down (2.68.0, harness/winddown.mjs), no "Stop all", no drain (2.73.1: `npm run
 *     task -- drain on`), and no halt other than the supervisor's builder halt. 2.73.1 (B-66): the supervisor's halt
 *     ("two sessions in a row ended with exit N", scope 'builders') stops new sessions, not the train: a lane already
 *     queued and verified still lands. A halt that names no scope still stops trains; studio:stop ends the supervisor
 *     and with it the daemon;
 *   - never two trains: no train lock held by a live process (.studio/locks/train.lock), no daemon train still running;
 *   - the queue has ready lanes by the batch rules that already exist (STUDIO_TRAIN_MIN lanes not held for the owner or
 *     out of trains, or the oldest has waited STUDIO_TRAIN_WAIT_MIN);
 *   - the machine budget has room for a verify claim (harness/heavy-budget.mjs jobClaim('verify') + admit, the same
 *     admission machine:heavy uses; no machine scan: the slot count decides, as there).
 * The train runs in a detached child (`node harness/train-daemon.mjs run`), so the supervisor's pass never waits on it.
 * After the train the child, for each handed-back lane whose task has no running session, makes sure the task is back
 * on the board for a builder with the hand-back facts block: the train's own hand-back (task.mjs pauseTask) normally
 * did it; a task still in progress is handed back, and a waiting task whose hand-back note has no facts block gets
 * one. Then ONE job.done (kind train, meta.auto) sums the train and what was re-queued.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export const AUTO_FILE = (root) => path.join(root, '.studio', 'train', 'auto.json');
export const DAEMON_FILE = (root) => path.join(root, '.studio', 'train', 'daemon.json');
export const DAEMON_LAST = (root) => path.join(root, '.studio', 'train', 'daemon-last.json');
export const DAEMON_BY = 'train-daemon';

/** Is the daemon on? { on, why }: STUDIO_TRAIN_AUTO (default on), then the recorded switch. */
export function trainAuto(root, env = process.env) {
  if (off(env.STUDIO_TRAIN_AUTO)) return { on: false, why: 'STUDIO_TRAIN_AUTO is off' };
  const s = readJson(AUTO_FILE(root));
  if (s && s.off) return { on: false, why: `train auto is off (by ${s.by || '?'} at ${String(s.at || '').slice(0, 16)}${s.why ? `: ${s.why}` : ''}; npm run task -- train auto on --by <name>)` };
  return { on: true, why: '' };
}
export function autoStatusText(root, env = process.env) {
  const a = trainAuto(root, env);
  const run = readJson(DAEMON_FILE(root));
  const last = readJson(DAEMON_LAST(root));
  return [`Train daemon: ${a.on ? 'on (a supervisor pass starts trains when lanes are ready and the machine has room)' : `off: ${a.why}`}.`, run && alive(run.pid) ? `A daemon train is running (pid ${run.pid}, since ${String(run.at).slice(0, 16)}).` : '', last ? `Last daemon train: ${last.id || '?'} at ${String(last.at).slice(0, 16)}: ${last.tail || last.message || ''}`.slice(0, 300) : ''].filter(Boolean).join('\n');
}

/** `train auto off|on --by <name>`: decider rules; records who and why, one event. */
export async function setTrainAuto(root, { on, by, why = '', permission = '', env = process.env, emit = emitEvent } = {}) {
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, action: 'train-auto', what: `turn the train daemon ${on ? 'on' : 'off'}` });
  if (!d.ok) return { ok: false, message: d.why };
  const f = AUTO_FILE(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const rec = { off: !on, by: d.by, why: String(why || '').slice(0, 300), at: new Date().toISOString(), via: d.via, ...(d.via !== 'person' ? { recordedBy: d.recordedBy, permission: d.permission || null } : {}) };
  fs.writeFileSync(f, `${JSON.stringify(rec, null, 2)}\n`);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'train-auto', subject: 'train daemon', by: d.by, as: dm.asOf(d), why: rec.why || (on ? 'train daemon on' : 'train daemon off'), evidence: on ? 'on' : 'off', undo: { kind: 'train-auto', on: !on, text: `npm run task -- train auto ${on ? 'off' : 'on'} --by <name>` }, root }); } catch {}
  emit({ type: on ? 'task.train.auto_on' : 'task.train.auto_off', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} turned the train daemon ${on ? 'on' : 'off'}${d.via !== 'person' ? ` (recorded by ${d.recordedBy})` : ''}${rec.why ? `: ${rec.why}` : ''}`.slice(0, 600), meta: rec });
  return { ok: true, message: on ? `The train daemon is on: the supervisor starts a train when lanes are ready and the machine has room${off(env.STUDIO_TRAIN_AUTO) ? ' (but STUDIO_TRAIN_AUTO is off in this environment)' : ''}.` : 'The train daemon is off: trains run only by hand (npm run task -- train) until train auto on.' };
}

/** A train lock held by a live process (and not stale): its record, else null. */
export function trainLockHeld(root, env = process.env, now = Date.now()) {
  const h = readJson(path.join(root, '.studio', 'locks', 'train.lock'));
  if (!h) return null;
  const stale = Number(env.STUDIO_TRAIN_STALE_MIN || 360) * 60000;
  if ((h.pid && !alive(h.pid)) || now - Number(h.at || 0) > stale) return null;
  return h;
}

/** Room for a verify claim on the machine budget (the machine:heavy admission): { ok, line }. */
export async function verifyRoom(root, env = process.env) {
  try {
    const hb = await import('./heavy-budget.mjs');
    const h = await import('./heavy.mjs');
    const hroot = await h.heavyRoot();
    const profile = hb.machineProfile(hroot, { env });
    const holders = h.heavyHolders(hroot, { env });
    const state = hb.budgetState(profile, holders, { env });
    const claim = hb.jobClaim('verify', { root, env, profile, state });
    const a = hb.admit(claim, state, { slots: h.heavySlots(env, profile), holders, kindMax: hb.maxConcurrent('verify', { root, env }) });
    return { ok: a.ok, line: a.ok ? '' : a.line };
  } catch (e) { return { ok: false, line: `the machine budget couldn't be read (${e.message})` }; }
}

/**
 * The decision, from facts (pure): { start, why, lanes }. facts: { auto, trainOn, halted, winddown, stopped, lock,
 * running, queue: [entry], heldOut(task) -> bool, heldNow(entry) -> bool, rules: { min, waitMin }, room: { ok, line },
 * now }.
 */
export function daemonDecision(f) {
  const no = (why) => ({ start: false, why, lanes: [] });
  if (!f.auto?.on) return no(f.auto?.why || 'train auto is off');
  if (!f.trainOn) return no('STUDIO_TRAIN is off');
  if (f.halted && f.haltScope !== 'builders') return no(`halted: ${f.halted}`);
  if (f.drain) return no(`drain is on (${f.drain}; npm run task -- drain off)`);
  if (f.winddown) return no(`winding down: ${f.winddown}`);
  if (f.stopped) return no(`"Stop all" is on (${f.stopped})`);
  if (f.lock) return no(`another train is running (${f.lock.id || '?'}, by ${f.lock.by || '?'})`);
  if (f.running) return no(`the daemon's train is still running (pid ${f.running.pid})`);
  const ready = (f.queue || []).filter((e) => !(f.heldNow || (() => false))(e) && !(f.heldOut || (() => false))(e.task));
  if (!ready.length) return no((f.queue || []).length ? 'every queued lane waits for the owner or is held out of trains' : 'no lane is queued');
  const rules = f.rules || { min: 1, waitMin: 10 };
  const now = f.now ?? Date.now();
  const oldest = Math.min(...ready.map((e) => Date.parse(e.at) || now));
  const waitedMin = (now - oldest) / 60000;
  if (ready.length < rules.min && waitedMin < rules.waitMin) return no(`${ready.length} of ${rules.min} lane(s) ready (STUDIO_TRAIN_MIN); waiting up to ${Math.ceil(rules.waitMin - waitedMin)} min more (STUDIO_TRAIN_WAIT_MIN)`);
  if (!f.room?.ok) return no(`no room on the machine for a verify: ${f.room?.line || 'the budget says no'}`);
  return { start: true, why: `${ready.length} lane(s) ready${ready.length < rules.min ? ` (waited ${Math.round(waitedMin)} min, STUDIO_TRAIN_WAIT_MIN)` : ''}${f.halted ? ` (the supervisor's builder halt stops new sessions, not trains: ${String(f.halted).slice(0, 120)})` : ''}`, lanes: ready.map((e) => e.task) };
}

/** Gather the facts for one pass. opts override any of them (tests). */
export async function daemonFacts(root, { env = process.env, now = Date.now(), halted = null, ...given } = {}) {
  const tr = await import('./train.mjs');
  const facts = { now, auto: trainAuto(root, env), trainOn: tr.trainOn(env), halted: halted ? String(halted.why || halted) : null, haltScope: halted && typeof halted === 'object' ? halted.scope || null : null, ...given };
  if (!('drain' in given)) { try { const d = await (await import('./busy.mjs')).readDrain(); facts.drain = d?.on ? `by ${d.by || '?'}${d.why ? `: ${d.why}` : ''}` : null; } catch { facts.drain = null; } }
  if (!('winddown' in given)) { try { const w = (await import('./winddown.mjs')).readWinddown(); facts.winddown = w ? w.why || `since ${w.at}` : null; } catch { facts.winddown = null; } }
  if (!('stopped' in given)) { try { const s = (await import('./task.mjs')).readStop(); facts.stopped = s ? `by ${s.by}` : null; } catch { facts.stopped = null; } }
  if (!('lock' in given)) facts.lock = trainLockHeld(root, env, now);
  if (!('running' in given)) { const r = readJson(DAEMON_FILE(root)); facts.running = r && alive(r.pid) ? r : null; }
  if (!('queue' in given)) facts.queue = tr.readQueue(root);
  if (!('heldNow' in given)) facts.heldNow = tr.heldNow;
  if (!('heldOut' in given)) facts.heldOut = (task) => Boolean(tr.taskHoldOf(root, task));
  if (!('rules' in given)) facts.rules = tr.batchRules(env);
  return facts;
}

/**
 * One supervisor pass: decide, and start the train in a detached child when it should run. Returns
 * { started, why, pid? }. opts: { root, env, now, halted, spawnTrain(root) -> { pid }, emit, dryRun, ...fact overrides }.
 * Says why it didn't start at most once per reason change (a task.train.auto_waiting event).
 */
export async function trainDaemonPass({ root = null, env = process.env, now = Date.now(), halted = null, spawnTrain = spawnDaemonTrain, emit = emitEvent, dryRun = false, ...given } = {}) {
  // 2.73.2 (B-74): STUDIO_TRAIN_* changed in .env since the last pass apply from this pass (harness/env-reload.mjs).
  if (env === process.env) { try { (await import('./env-reload.mjs')).reloadEnvIfChanged({ by: DAEMON_BY }); } catch {} }
  root ||= (await import('./worktree.mjs')).mainRoot();
  if (off(env.STUDIO_TRAIN_AUTO)) return { started: false, why: 'STUDIO_TRAIN_AUTO is off' };
  const f = await daemonFacts(root, { env, now, halted, ...given });
  // The machine budget is read only when everything else says go (it reads the scan and the heavy holders).
  if (!('room' in given)) f.room = { ok: true };
  let d = daemonDecision(f);
  if (d.start && !('room' in given)) { f.room = await verifyRoom(root, env); d = daemonDecision(f); }
  const last = readJson(path.join(root, '.studio', 'train', 'daemon-why.json'));
  if (!d.start) {
    if (!dryRun && f.auto?.on && (f.queue || []).length && last?.why !== d.why) {
      try { fs.mkdirSync(path.join(root, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(root, '.studio', 'train', 'daemon-why.json'), JSON.stringify({ why: d.why, at: new Date(now).toISOString() })); } catch {}
      emit({ type: 'task.train.auto_waiting', agent: DAEMON_BY, status: 'warn', msg: `train daemon: not starting a train: ${d.why}`.slice(0, 600), meta: { why: d.why, queued: (f.queue || []).map((e) => e.task) } });
    }
    return { started: false, why: d.why };
  }
  if (dryRun) return { started: false, why: `would start: ${d.why}`, lanes: d.lanes };
  const child = spawnTrain(root, env);
  const pid = child?.pid || null;
  try { fs.rmSync(path.join(root, '.studio', 'train', 'daemon-why.json'), { force: true }); } catch {}
  fs.mkdirSync(path.dirname(DAEMON_FILE(root)), { recursive: true });
  fs.writeFileSync(DAEMON_FILE(root), `${JSON.stringify({ pid, at: new Date(now).toISOString(), lanes: d.lanes })}\n`);
  emit({ type: 'task.train.auto_start', agent: DAEMON_BY, status: 'ok', msg: `train daemon: started a train for ${d.lanes.join(', ')}: ${d.why}`.slice(0, 600), meta: { pid, lanes: d.lanes, why: d.why } });
  return { started: true, why: d.why, pid, lanes: d.lanes };
}

/** The detached child: node harness/train-daemon.mjs run (its output in .studio/train/daemon.log). Windows: windowsHide. */
export function spawnDaemonTrain(root, env = process.env) {
  const log = path.join(root, '.studio', 'train', 'daemon.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(HERE, 'train-daemon.mjs'), 'run'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...env, STUDIO_LOCK_OWNER: DAEMON_BY, STUDIO_MAIN_ROOT: root } });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  return { pid: child.pid };
}

/**
 * After a train: each handed-back lane whose task has no running session is back on the board for a builder with
 * the facts block. deps: { running(task) -> bool, boardOf(task) -> 'in-progress'|'backlog'|'done'|null,
 * handBack(lane, note), handoffText(task) -> string, addNote(task, note) }. Returns { requeued, noted, ok, skipped }.
 */
export function afterTrain(res, deps) {
  const out = { requeued: [], noted: [], ok: [], skipped: [] };
  for (const d of res?.dropped || []) {
    const task = d.task;
    if (deps.running(task)) { out.skipped.push({ task, why: 'its session is still running' }); continue; }
    const where = deps.boardOf(task);
    const note = `Not landed by merge train ${res.id}: ${d.why || 'handed back'}`;
    if (where === 'in-progress') {
      try { deps.handBack({ task, agent: d.agent || null }, note); out.requeued.push(task); } catch (e) { out.skipped.push({ task, why: `couldn't hand it back: ${e.message}` }); }
    } else if (where === 'backlog') {
      const text = String(deps.handoffText(task) || '');
      if (text.includes('Hand-back facts') && text.includes('merge train')) out.ok.push(task);
      else { try { deps.addNote(task, note); out.noted.push(task); } catch (e) { out.skipped.push({ task, why: `couldn't add the facts: ${e.message}` }); } }
    } else out.skipped.push({ task, why: where === 'done' ? 'already done' : 'not on the board' });
  }
  return out;
}

/** The default deps for afterTrain: the board (task.mjs), the sessions (agent.mjs), the facts (handback-facts.mjs). */
export async function boardDeps() {
  const task = await import('./task.mjs');
  const { withFacts } = await import('./handback-facts.mjs');
  let live = [];
  try { live = (await import('./agent.mjs')).sessions().filter((s) => s.running); } catch { live = []; }
  const file = (id) => path.join(task.HANDOFF_DIR, `${id}.md`);
  return {
    running: (id) => live.some((s) => s.task === id),
    boardOf: (id) => { const q = task.parseNextQueue(); return q.inProgress.some((t) => t.id === id) ? 'in-progress' : q.backlog.some((t) => t.id === id) ? 'backlog' : q.done.some((t) => t.id === id) ? 'done' : null; },
    handBack: (lane, note) => task.pauseTask(lane.task, lane.agent, withFacts(lane.task, note, { agent: lane.agent }), { force: true }),
    handoffText: (id) => { try { return fs.readFileSync(file(id), 'utf8'); } catch { return ''; } },
    addNote: (id, note) => { fs.mkdirSync(task.HANDOFF_DIR, { recursive: true }); fs.appendFileSync(file(id), `\n## ${new Date().toISOString()} · ${DAEMON_BY}\n${withFacts(id, note)}\n`); },
  };
}

/**
 * The child's work: one train (runTrain, its own job.done left out), the after-train routing, ONE job.done (kind train,
 * meta.auto). opts: { root, runTrain, deps (for runTrain), board (afterTrain deps), jobDone }.
 */
export async function runDaemonTrain({ root, env = process.env, runTrain = null, deps = null, board = null, finish = null } = {}) {
  const t0 = Date.now();
  const tr = await import('./train.mjs');
  let res;
  try {
    if (!runTrain || !deps) { const busyMod = await import('./busy.mjs'); deps ||= (await import('./task.mjs')).trainDeps(busyMod); }
    res = await (runTrain || tr.runTrain)({ root, by: DAEMON_BY, now: true, quietJob: true, deps, log: (m) => console.error(m) });
  } catch (e) { res = { ok: false, id: `daemon-${t0}`, message: `the train failed to run: ${e.message}`, landed: [], dropped: [], deferred: [], held: [] }; }
  let routed = { requeued: [], noted: [], ok: [], skipped: [] };
  if (!res.busy && (res.dropped || []).length) { try { routed = afterTrain(res, board || (await boardDeps())); } catch {} }
  const tail = [routed.requeued.length ? `re-queued ${routed.requeued.join(', ')}` : '', routed.noted.length ? `facts added for ${routed.noted.join(', ')}` : '', res.busy ? 'another train was running' : ''].filter(Boolean).join('; ');
  if (!res.busy) (finish || tr.trainJobDone)(res, t0, { tail, extra: { auto: true, requeued: routed.requeued, noted: routed.noted, routedSkipped: routed.skipped } });
  try { fs.writeFileSync(DAEMON_LAST(root), `${JSON.stringify({ id: res.id, at: new Date().toISOString(), ok: res.ok, landed: res.landed || [], dropped: (res.dropped || []).map((d) => d.task), ...routed, message: String(res.message || '').slice(0, 300), tail })}\n`); } catch {}
  try { const r = readJson(DAEMON_FILE(root)); if (!r || r.pid === process.pid || !alive(r.pid)) fs.rmSync(DAEMON_FILE(root), { force: true }); } catch {}
  return { res, routed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const { mainRoot } = await import('./worktree.mjs');
  const root = mainRoot();
  if (argv[0] === 'run') {
    try { fs.mkdirSync(path.dirname(DAEMON_FILE(root)), { recursive: true }); const r = readJson(DAEMON_FILE(root)) || {}; fs.writeFileSync(DAEMON_FILE(root), `${JSON.stringify({ ...r, pid: process.pid, at: r.at || new Date().toISOString() })}\n`); } catch {}
    const { res } = await runDaemonTrain({ root });
    console.log(res.message || '');
    process.exit(res.ok ? 0 : 1);
  }
  console.log(autoStatusText(root));
  process.exit(0);
}
