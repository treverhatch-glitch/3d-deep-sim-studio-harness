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
 *   - never two trains: no train lock held by a live process (.studio/locks/train.lock), no daemon train still running,
 *     no speculative train about to land (2.77.0, P9.6: harness/train-pipeline.mjs; while a train verifies the pass
 *     may start ONE speculative train behind it, pipelineKick);
 *   - the queue has ready lanes by the batch rules that already exist (STUDIO_TRAIN_MIN lanes not held for the owner or
 *     out of trains, or the oldest has waited STUDIO_TRAIN_WAIT_MIN);
 *   - the machine budget has room for a verify claim (harness/heavy-budget.mjs jobClaim('verify') + admit, the same
 *     admission machine:heavy uses; no machine scan: the slot count decides, as there). 2.77.3 (M6): when it hasn't,
 *     the pass leaves the train-wait marker (harness/heavy.mjs markTrainWait), so the next freed slot is kept for the
 *     train instead of going to a builder's verify (STUDIO_TRAIN_SLOT_PRIORITY_MIN, 15).
 * The train runs in a detached child (`node harness/train-daemon.mjs run`), so the supervisor's pass never waits on it.
 * After the train the child, for each handed-back lane whose task has no running session, makes sure the task is back
 * on the board for a builder with the hand-back facts block: the train's own hand-back (task.mjs pauseTask) normally
 * did it; a task still in progress is handed back, and a waiting task whose hand-back note has no facts block gets
 * one. Then ONE job.done (kind train, meta.auto) sums the train and what was re-queued.
 *
 * 2.85 (e): a crew's web lanes sat 2 h each for 16 hours, every train started by hand, because an agent had turned the
 * daemon off five days before (`train auto off`, no reason, to let an engine land through) and nobody turned it on again:
 * while off, the daemon said nothing (its waiting event needed it on) and `train status` never mentioned it. Now:
 *   - an off switch an agent records (anyone but a person in their own terminal) lapses after STUDIO_TRAIN_AUTO_OFF_HOURS
 *     (4; 0: never), or after `--hours N` when given; a person's off lasts until they turn it on. The deciders are the same.
 *   - why the daemon doesn't start a train is said once per distinct reason (train.daemon.waiting, and the older
 *     task.train.auto_waiting), off included, and `train status` prints "the automatic start is waiting: <reason>".
 *   - lanes that wait only for the owner (tier C) are named with the one command; the daemon never releases one.
 *   - an engine land does not stop a web train: the verify claim is admitted by the heavy budget beside it (an engine land
 *     takes no machine:heavy slot; its RAM counts), so the train starts when free RAM covers the web verify's need.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { spawnDetached } from './train-detach.mjs';
import { writeAtomic, pidAlive as alive, readJson } from './fsafe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
export const AUTO_FILE = (root) => path.join(root, '.studio', 'train', 'auto.json');
export const DAEMON_FILE = (root) => path.join(root, '.studio', 'train', 'daemon.json');
export const DAEMON_LAST = (root) => path.join(root, '.studio', 'train', 'daemon-last.json');
export const DAEMON_BY = 'train-daemon';

/** 2.85 (e): how long an agent's `train auto off` lasts without --hours (STUDIO_TRAIN_AUTO_OFF_HOURS, 4; 0: until turned on). */
export function autoOffHours(env = process.env) {
  const s = String(env.STUDIO_TRAIN_AUTO_OFF_HOURS ?? '').trim();
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? n : 4;
}
/** When a recorded off switch ends (ms), or null (it lasts until turned on). 2.85 (e): an agent's off lapses. */
export function autoOffUntil(s, env = process.env) {
  if (!s?.off) return null;
  const until = Date.parse(s.until || '');
  if (Number.isFinite(until)) return until;
  const at = Date.parse(s.at || '');
  const h = autoOffHours(env);
  if (s.via && s.via !== 'person' && h > 0 && Number.isFinite(at)) return at + h * 3600000;
  return null;
}

/** Is the daemon on? { on, why, key, lapsed? }: STUDIO_TRAIN_AUTO (default on), then the recorded switch (2.85: it may have lapsed). */
export function trainAuto(root, env = process.env, now = Date.now()) {
  if (off(env.STUDIO_TRAIN_AUTO)) return { on: false, why: 'STUDIO_TRAIN_AUTO is off', key: 'env-off' };
  const s = readJson(AUTO_FILE(root));
  if (s && s.off) {
    const until = autoOffUntil(s, env);
    if (until !== null && now >= until) return { on: true, why: '', lapsed: { by: s.by || '?', at: s.at || null, until: new Date(until).toISOString() } };
    return { on: false, key: `off:${s.at || ''}`, why: `train auto is off (by ${s.by || '?'} at ${String(s.at || '').slice(0, 16)}${until !== null ? `, until ${new Date(until).toISOString().slice(0, 16)}` : ''}${s.why ? `: ${s.why}` : ''}; npm run task -- train auto on --by <name>)` };
  }
  return { on: true, why: '' };
}
export function autoStatusText(root, env = process.env) {
  const a = trainAuto(root, env);
  const run = readJson(DAEMON_FILE(root));
  const last = readJson(DAEMON_LAST(root));
  return [`Train daemon: ${a.on ? 'on (a supervisor pass starts trains when lanes are ready and the machine has room)' : `off: ${a.why}`}.`, run && alive(run.pid) ? `A daemon train is running (pid ${run.pid}, since ${String(run.at).slice(0, 16)}).` : '', last ? `Last daemon train: ${last.id || '?'} at ${String(last.at).slice(0, 16)}: ${last.tail || last.message || ''}`.slice(0, 300) : '', daemonWaitingLine(root, { env })].filter(Boolean).join('\n');
}

export const DAEMON_WHY = (root) => path.join(root, '.studio', 'train', 'daemon-why.json');
/**
 * 2.85 (e): the line `train status` prints while lanes wait and no daemon train runs: "The automatic start is waiting:
 * <reason>" (the switch first; else the last pass's reason), or '' (nothing waits, or a train runs).
 */
export function daemonWaitingLine(root, { env = process.env, queue = null, now = Date.now() } = {}) {
  let q = queue;
  if (!q) { try { q = readJson(path.join(root, '.studio', 'train', 'queue.json')) || []; } catch { q = []; } }
  if (!Array.isArray(q) || !q.length) return '';
  const run = readJson(DAEMON_FILE(root));
  if (run && alive(run.pid)) return '';
  const a = trainAuto(root, env, now);
  if (!a.on) return `The automatic start is waiting: ${a.why}.`;
  const w = readJson(DAEMON_WHY(root));
  return w?.why ? `The automatic start is waiting: ${w.why} (since ${String(w.at || '').slice(11, 16)} UTC).` : '';
}

/** `train auto off|on --by <name>`: decider rules; records who and why, one event. */
export async function setTrainAuto(root, { on, by, why = '', permission = '', hours = null, env = process.env, emit = emitEvent } = {}) {
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, action: 'train-auto', what: `turn the train daemon ${on ? 'on' : 'off'}` });
  if (!d.ok) return { ok: false, message: d.why };
  const f = AUTO_FILE(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const at = new Date();
  // 2.85 (e): an off switch says when it ends: --hours N, else an agent's lapses after STUDIO_TRAIN_AUTO_OFF_HOURS.
  const h = Number(hours);
  const lastH = !on ? (hours !== null && hours !== undefined && hours !== '' && Number.isFinite(h) && h > 0 ? h : d.via !== 'person' && autoOffHours(env) > 0 ? autoOffHours(env) : null) : null;
  const rec = { off: !on, by: d.by, why: String(why || '').slice(0, 300), at: at.toISOString(), via: d.via, ...(lastH ? { until: new Date(at.getTime() + lastH * 3600000).toISOString() } : {}), ...(d.via !== 'person' ? { recordedBy: d.recordedBy, permission: d.permission || null } : {}) };
  writeAtomic(f, `${JSON.stringify(rec, null, 2)}\n`);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'train-auto', subject: 'train daemon', by: d.by, as: dm.asOf(d), why: rec.why || (on ? 'train daemon on' : 'train daemon off'), evidence: on ? 'on' : 'off', undo: { kind: 'train-auto', on: !on, text: `npm run task -- train auto ${on ? 'off' : 'on'} --by <name>` }, root }); } catch {}
  emit({ type: on ? 'task.train.auto_on' : 'task.train.auto_off', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} turned the train daemon ${on ? 'on' : 'off'}${d.via !== 'person' ? ` (recorded by ${d.recordedBy})` : ''}${rec.why ? `: ${rec.why}` : ''}`.slice(0, 600), meta: rec });
  return { ok: true, message: on ? `The train daemon is on: the supervisor starts a train when lanes are ready and the machine has room${off(env.STUDIO_TRAIN_AUTO) ? ' (but STUDIO_TRAIN_AUTO is off in this environment)' : ''}.` : `The train daemon is off: trains run only by hand (npm run task -- train) until ${rec.until ? `${rec.until.slice(0, 16)} UTC (it turns itself on again then; --hours N sets how long, STUDIO_TRAIN_AUTO_OFF_HOURS for an agent's)` : 'train auto on'}.` };
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
export async function verifyRoom(root, env = process.env, given = {}) {
  try {
    const hb = await import('./heavy-budget.mjs');
    const h = await import('./heavy.mjs');
    // 2.85 (e): the machine facts may be given (tests); an engine land among the holders takes no game slot, its RAM counts.
    const hroot = 'profile' in given && 'holders' in given && 'slots' in given ? null : await h.heavyRoot();
    const profile = 'profile' in given ? given.profile : hb.machineProfile(hroot, { env });
    const holders = 'holders' in given ? given.holders : h.heavyHolders(hroot, { env });
    const state = hb.budgetState(profile, holders, { env });
    const claim = hb.jobClaim('verify', { root, env, profile, state, as: 'train' }); // 2.76.0 (j, B-89): sized as the train's verify
    const a = hb.admit(claim, state, { slots: 'slots' in given ? given.slots : h.heavySlotsAt(hroot, env, profile), holders, kindMax: hb.maxConcurrent('verify', { root, env }) });
    return { ok: a.ok, line: a.ok ? '' : a.line };
  } catch (e) { return { ok: false, line: `the machine budget couldn't be read (${e.message})` }; }
}

/**
 * The decision, from facts (pure): { start, why, lanes }. facts: { auto, trainOn, halted, winddown, stopped, lock,
 * running, redMain (why main being red waits, Patch #25), queue: [entry], heldOut(task) -> bool, heldNow(entry) -> bool,
 * rules: { min, waitMin }, room: { ok, line },
 * now }.
 */
export function daemonDecision(f) {
  // 2.85 (e): each reason has a key that names it without its changing numbers: the waiting event is said once per key.
  const no = (why, key = why) => ({ start: false, why, key, lanes: [] });
  if (!f.auto?.on) return no(f.auto?.why || 'train auto is off', f.auto?.key || 'off');
  if (!f.trainOn) return no('STUDIO_TRAIN is off', 'train-off');
  if (f.halted && f.haltScope !== 'builders') return no(`halted: ${f.halted}`, 'halted');
  if (f.drain) return no(`drain is on (${f.drain}; npm run task -- drain off)`, 'drain');
  if (f.winddown) return no(`winding down: ${f.winddown}`, 'winddown');
  if (f.stopped) return no(`"Stop all" is on (${f.stopped})`, 'stopped');
  if (f.lock) return no(`another train is running (${f.lock.id || '?'}, by ${f.lock.by || '?'})`, `lock:${f.lock.id || ''}`);
  // 2.77.0 (p, P9.6): a speculative train that lands on main now (its train A ended) goes first.
  if (f.next) return no(`the speculative train ${f.next.id || '?'} (after ${f.next.after || '?'}) lands first`, `next:${f.next.id || ''}`);
  if (f.running) return no(`the daemon's train is still running (pid ${f.running.pid})`, `running:${f.running.pid}`);
  if (f.redMain) return no(f.redMain);
  const isHeld = (e) => (f.heldNow || (() => false))(e);
  const isOut = (e) => (f.heldOut || (() => false))(e.task);
  const ready = (f.queue || []).filter((e) => !isHeld(e) && !isOut(e));
  if (!ready.length) {
    if (!(f.queue || []).length) return no('no lane is queued', 'empty');
    // 2.85 (e): name the lanes and the one command. The daemon never releases a lane (a decision: a person's, or in
    // beta mode a stand-in's, harness/beta-mode.mjs standInMay('release')).
    const held = (f.queue || []).filter(isHeld).map((e) => e.task);
    const out = (f.queue || []).filter((e) => !isHeld(e) && isOut(e)).map((e) => e.task);
    const parts = [held.length ? `${held.join(', ')} need${held.length === 1 ? 's' : ''} the owner (tier C): ${f.betaRelease ? 'beta mode is on, so a stand-in may release it' : 'a person releases it'} (the daemon never does): npm run task -- train release <ID> --by <name>` : '', out.length ? `${out.join(', ')} ${out.length === 1 ? 'is' : 'are'} held out of trains (npm run task -- train status says why)` : ''].filter(Boolean);
    return no(`every queued lane waits: ${parts.join('; ')}`, `held:${held.join(',')}|${out.join(',')}`);
  }
  const rules = f.rules || { min: 1, waitMin: 10 };
  const now = f.now ?? Date.now();
  const oldest = Math.min(...ready.map((e) => Date.parse(e.at) || now));
  const waitedMin = (now - oldest) / 60000;
  if (ready.length < rules.min && waitedMin < rules.waitMin) return no(`${ready.length} of ${rules.min} lane(s) ready (STUDIO_TRAIN_MIN); waiting up to ${Math.ceil(rules.waitMin - waitedMin)} min more (STUDIO_TRAIN_WAIT_MIN)`, `min:${ready.length}`);
  if (!f.room?.ok) return no(`no room on the machine for a verify: ${f.room?.line || 'the budget says no'}`, `room:${String(f.room?.line || '').split(':')[0].slice(0, 40)}`);
  return { start: true, why: `${ready.length} lane(s) ready${ready.length < rules.min ? ` (waited ${Math.round(waitedMin)} min, STUDIO_TRAIN_WAIT_MIN)` : ''}${f.halted ? ` (the supervisor's builder halt stops new sessions, not trains: ${String(f.halted).slice(0, 120)})` : ''}`, lanes: ready.map((e) => e.task) };
}

/** Gather the facts for one pass. opts override any of them (tests). */
export async function daemonFacts(root, { env = process.env, now = Date.now(), halted = null, ...given } = {}) {
  const tr = await import('./train.mjs');
  const facts = { now, auto: trainAuto(root, env, now), trainOn: tr.trainOn(env), halted: halted ? String(halted.why || halted) : null, haltScope: halted && typeof halted === 'object' ? halted.scope || null : null, ...given };
  if (!('drain' in given)) { try { const d = await (await import('./busy.mjs')).readDrain(); facts.drain = d?.on ? `by ${d.by || '?'}${d.why ? `: ${d.why}` : ''}` : null; } catch { facts.drain = null; } }
  if (!('winddown' in given)) { try { const wm = await import('./winddown.mjs'); const w = wm.readWinddown(); facts.winddown = w && !wm.winddownOver(w, { env, now }) ? w.why || `since ${w.at}` : null; } catch { facts.winddown = null; } }
  if (!('stopped' in given)) { try { const s = (await import('./task.mjs')).readStop(); facts.stopped = s ? `by ${s.by}` : null; } catch { facts.stopped = null; } }
  if (!('lock' in given)) facts.lock = trainLockHeld(root, env, now);
  if (!('next' in given)) { try { const pl = await import('./train-pipeline.mjs'); const wt = await import('./worktree.mjs'); const tip = String(spawnSync('git', ['rev-parse', `refs/heads/${wt.mainBranch(root)}`], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout || '').trim() || null; facts.next = pl.nextBusy(root, { env, now, tip }); } catch { facts.next = null; } }
  if (!('running' in given)) { const r = readJson(DAEMON_FILE(root)); facts.running = r && alive(r.pid) ? r : null; }
  if (!('queue' in given)) facts.queue = tr.readQueue(root);
  if (!('heldNow' in given)) facts.heldNow = tr.heldNow;
  if (!('heldOut' in given)) facts.heldOut = (task) => Boolean(tr.taskHoldOf(root, task));
  if (!('rules' in given)) facts.rules = tr.batchRules(env);
  if (!('redMain' in given)) { try { facts.redMain = await redMainWait(root, facts.queue, { env, now }); } catch { facts.redMain = null; } }
  // 2.85 (e): may a stand-in release a tier C lane (beta mode on, and 'release' one of its kinds)? Only for the wording.
  if (!('betaRelease' in given)) { try { const bm = await import('./beta-mode.mjs'); facts.betaRelease = bm.STAND_IN_KINDS.includes('release') && bm.readBeta({ root }).on; } catch { facts.betaRelease = false; } }
  return facts;
}

/**
 * 2.80 (c), Patch #25: after a train found main itself red, the daemon started the same lanes again at once, ~30 min each
 * to find main red again (6 times in a day). While the last train's verdict (.studio/train/red-streak.json) is "main is
 * red" and main's head and the queued lanes (each task and its head) are the ones the daemon first saw after it, it waits
 * (the reason, or null to go on): a new or changed lane may be the fix, so it never waits on one. `npm run task -- train` runs.
 */
export async function redMainWait(root, queue = [], { env = process.env, now = Date.now(), git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }) } = {}) {
  const last = (readJson(path.join(root, '.studio', 'train', 'red-streak.json'))?.trains || []).at(-1);
  if (!last?.redMain) return null;
  const tip = String(git(['rev-parse', `refs/heads/${(await import('./worktree.mjs')).mainBranch(root)}`]).stdout || '').trim();
  const f = path.join(root, '.studio', 'train', 'red-main-head.json');
  const tr = await import('./train.mjs');
  const headOf = (l) => tr.laneNow(l).head || null;
  // The queue as it stood when the daemon first saw the verdict: a lane queued since, or one with new commits, may be the
  // fix (whatever check it is for), so the wait is only for the SAME lanes on the same main.
  const lanes = (queue || []).map((l) => `${l.task}@${headOf(l) || ''}`).sort().join(',');
  let seen = readJson(f);
  if (seen?.train !== last.id) { seen = { train: last.id, head: tip, lanes, at: new Date(now).toISOString() }; writeAtomic(f, `${JSON.stringify(seen)}\n`); }
  if (!tip || seen.head !== tip || seen.lanes !== lanes) return null;
  const fix = (await import('./train-fix-first.mjs')).fixFirstOrder(root, queue || [], { tip, env, headOf }).fix;
  return fix ? null : `main is red at ${tip.slice(0, 8)} (train ${last.id} found ${last.gates.join(', ') || 'its checks'} red on main itself) and the queue is the same lanes: no train until main changes or a lane is queued or changed (npm run task -- train runs one anyway)`;
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
  if (off(env.STUDIO_TRAIN_AUTO)) {
    // 2.85 (e): said once, while lanes wait (it was silent).
    if (!dryRun) { let q = given.queue; if (!q) { try { q = (await import('./train.mjs')).readQueue(root); } catch { q = []; } } sayWaiting(root, { why: 'STUDIO_TRAIN_AUTO is off', key: 'env-off' }, q, { now, emit }); }
    return { started: false, why: 'STUDIO_TRAIN_AUTO is off' };
  }
  // 2.85 (e): an agent's off switch that lapsed is turned back on, once, with one event.
  if (!dryRun && !('auto' in given)) {
    const a = trainAuto(root, env, now);
    if (a.lapsed) {
      try { const s = readJson(AUTO_FILE(root)) || {}; writeAtomic(AUTO_FILE(root), `${JSON.stringify({ ...s, off: false, lapsedAt: new Date(now).toISOString() }, null, 2)}\n`); } catch {}
      emit({ type: 'task.train.auto_on', agent: DAEMON_BY, to: 'producer', msg: `train daemon: on again: the off switch ${a.lapsed.by} set at ${String(a.lapsed.at || '').slice(0, 16)} ended at ${a.lapsed.until.slice(0, 16)} (an agent's off lasts STUDIO_TRAIN_AUTO_OFF_HOURS, or its --hours)`.slice(0, 600), meta: { lapsed: a.lapsed } });
    }
  }
  // 2.76.0 (B-88): a train that died without recording its end (process gone) is recorded, its lock freed, its lanes kept.
  if (!dryRun && !('lock' in given)) { try { (await import('./train.mjs')).reapTrains(root, { env }); } catch {} }
  const f = await daemonFacts(root, { env, now, halted, ...given });
  // 2.77.0 (p, P9.6): while a train verifies, the pass may start ONE speculative train behind it (harness/train-pipeline.mjs).
  if (f.lock && !dryRun && !('lock' in given) && !f.drain && !f.winddown && !f.stopped && !(f.halted && f.haltScope !== 'builders')) { try { f.pipeline = await (await import('./train-pipeline.mjs')).pipelineKick(root, { after: f.lock.id, env, emit }); } catch {} }
  // The machine budget is read only when everything else says go (it reads the scan and the heavy holders).
  if (!('room' in given)) f.room = { ok: true };
  let d = daemonDecision(f);
  // 2.85 (e): given.machine ({ profile, holders, slots }) stands in for the machine (tests); else it is read.
  if (d.start && !('room' in given)) { f.room = await verifyRoom(root, env, given.machine || {}); d = daemonDecision(f); }
  // 2.77.3 (M6): no room only for want of a slot or budget: the train goes first on the next free one (harness/heavy.mjs
  // markTrainWait; builders' verifies don't take a newly freed slot while it is fresh, STUDIO_TRAIN_SLOT_PRIORITY_MIN).
  if (!d.start && f.room && !f.room.ok && !dryRun && !('room' in given) && !given.machine) {
    try { const h = await import('./heavy.mjs'); const w = h.markTrainWait(await h.heavyRoot(), { why: `train daemon: ${f.room.line || 'no room'}`, lanes: (f.queue || []).map((e) => e.task), env }); if (w) d.why = `${d.why}; the train takes the next free slot (builders' verifies wait for it, STUDIO_TRAIN_SLOT_PRIORITY_MIN)`; } catch {}
  }
  if (!d.start) {
    if (!dryRun) sayWaiting(root, d, f.queue || [], { now, emit });
    return { started: false, why: d.why, ...(f.pipeline?.started ? { next: f.pipeline } : {}) };
  }
  if (dryRun) return { started: false, why: `would start: ${d.why}`, lanes: d.lanes };
  // 2.85 (e): the switch may have been read before it lapsed this pass; d.start means it is on now.
  const child = spawnTrain(root, env);
  const pid = child?.pid || null;
  try { fs.rmSync(DAEMON_WHY(root), { force: true }); } catch {}
  fs.mkdirSync(path.dirname(DAEMON_FILE(root)), { recursive: true });
  writeAtomic(DAEMON_FILE(root), `${JSON.stringify({ pid, at: new Date(now).toISOString(), lanes: d.lanes })}\n`);
  emit({ type: 'task.train.auto_start', agent: DAEMON_BY, status: 'ok', msg: `train daemon: started a train for ${d.lanes.join(', ')}: ${d.why}`.slice(0, 600), meta: { pid, lanes: d.lanes, why: d.why } });
  return { started: true, why: d.why, pid, lanes: d.lanes };
}

/**
 * 2.85 (e): say why no train starts, once per distinct reason (d.key: the reason without its changing numbers), while
 * lanes wait: .studio/train/daemon-why.json (what `train status` prints) and one train.daemon.waiting event (and the older
 * task.train.auto_waiting, which the board and older tools read). Before, the event needed the daemon on (so an off
 * switch was silent) and compared the whole text (so a changing RAM figure said it again on most passes).
 */
export function sayWaiting(root, d, queue, { now = Date.now(), emit = emitEvent } = {}) {
  if (!(queue || []).length) { try { fs.rmSync(DAEMON_WHY(root), { force: true }); } catch {} return false; }
  const last = readJson(DAEMON_WHY(root));
  const key = d.key || d.why;
  if (last && (last.key || last.why) === key) {
    // Same reason: keep its first time, refresh the words (the numbers in them may have moved).
    try { fs.writeFileSync(DAEMON_WHY(root), JSON.stringify({ ...last, key, why: d.why })); } catch {}
    return false;
  }
  try { fs.mkdirSync(path.dirname(DAEMON_WHY(root)), { recursive: true }); fs.writeFileSync(DAEMON_WHY(root), JSON.stringify({ why: d.why, key, at: new Date(now).toISOString() })); } catch {}
  const msg = `train daemon: not starting a train: ${d.why}`.slice(0, 600);
  const meta = { why: d.why, key, queued: (queue || []).map((e) => e.task) };
  emit({ type: 'train.daemon.waiting', agent: DAEMON_BY, status: 'warn', msg, meta });
  emit({ type: 'task.train.auto_waiting', agent: DAEMON_BY, status: 'warn', msg, meta });
  return true;
}

/**
 * The detached child: node harness/train-daemon.mjs run (its output in .studio/train/daemon.log). Windows: windowsHide.
 * 2.78.2 (a, W-0090): started through a launcher that exits at once (harness/train-detach.mjs spawnDetached), so the
 * train outlives the supervisor that started it (a tree kill of the supervisor doesn't reach it).
 */
export function spawnDaemonTrain(root, env = process.env) {
  const log = path.join(root, '.studio', 'train', 'daemon.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const d = spawnDetached({ args: [path.join(HERE, 'train-daemon.mjs'), 'run'], out: log, env: { ...env, STUDIO_LOCK_OWNER: DAEMON_BY, STUDIO_MAIN_ROOT: root }, cwd: root });
  if (d.ok) return { pid: d.pid };
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
export async function runDaemonTrain({ root, env = process.env, runTrain = null, deps = null, board = null, finish = null, waitMs = 0 } = {}) {
  const t0 = Date.now();
  const tr = await import('./train.mjs');
  let res;
  try {
    if (!runTrain || !deps) { const busyMod = await import('./busy.mjs'); deps ||= (await import('./task.mjs')).trainDeps(busyMod); }
    // 2.78.2 (a): a train a queued task done started (harness/train-detach.mjs kickTrain) waits for a running train first.
    res = await (runTrain || tr.runTrain)({ root, by: DAEMON_BY, now: true, quietJob: true, deps, log: (m) => console.error(m), ...(waitMs > 0 ? { waitMs } : {}) });
  } catch (e) { res = { ok: false, id: `daemon-${t0}`, message: `the train failed to run: ${e.message}`, landed: [], dropped: [], deferred: [], held: [] }; }
  let routed = { requeued: [], noted: [], ok: [], skipped: [] };
  if (!res.busy && (res.dropped || []).length) { try { routed = afterTrain(res, board || (await boardDeps())); } catch {} }
  const tail = [routed.requeued.length ? `re-queued ${routed.requeued.join(', ')}` : '', routed.noted.length ? `facts added for ${routed.noted.join(', ')}` : '', res.busy ? 'another train was running' : ''].filter(Boolean).join('; ');
  if (!res.busy) (finish || tr.trainJobDone)(res, t0, { tail, extra: { auto: true, requeued: routed.requeued, noted: routed.noted, routedSkipped: routed.skipped } });
  try { fs.writeFileSync(DAEMON_LAST(root), `${JSON.stringify({ id: res.id, at: new Date().toISOString(), ok: res.ok, landed: res.landed || [], dropped: (res.dropped || []).map((d) => d.task), ...routed, message: String(res.message || '').slice(0, 300), tail })}\n`); } catch {}
  try { const r = readJson(DAEMON_FILE(root)); if (!r || r.pid === process.pid || !alive(r.pid)) fs.rmSync(DAEMON_FILE(root), { force: true }); } catch {}
  return { res, routed };
}

/**
 * 2.77.0 (p, P9.6): the speculative train's detached child (harness/train-pipeline.mjs spawnNextTrain): runNextTrain
 * behind train `after`; discarded, its lanes go in the next normal train, which this process runs when the train daemon
 * is on (as the daemon would). Returns { res, rerun }.
 */
export async function runNextNow({ root, after, env = process.env, log = (m) => console.error(m) } = {}) {
  const tr = await import('./train.mjs');
  const pl = await import('./train-pipeline.mjs');
  const busyMod = await import('./busy.mjs');
  const deps = (await import('./task.mjs')).trainDeps(busyMod);
  const res = await tr.runNextTrain({ root, after, deps, log });
  let rerun = null;
  if (res.discarded && !res.busy) {
    const auto = trainAuto(root, env);
    // 2.78.1 (B-122): not from a process whose harness changed since it started: the train daemon starts it fresh.
    const cg = (await import('./harness-version.mjs')).chainGuard({ env });
    if (!cg.ok) log(`[train] the discarded lanes wait for the train daemon's next train: ${cg.why}`);
    else if (auto.on && tr.trainOn(env)) rerun = await tr.runTrain({ root, by: pl.NEXT_BY, now: true, waitMs: pl.staleMs(env), deps, log });
    else log(`[train] the discarded lanes wait for the next train (the train daemon is off: ${auto.why || 'STUDIO_TRAIN is off'})`);
  }
  return { res, rerun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const { mainRoot } = await import('./worktree.mjs');
  const root = mainRoot();
  // 2.78.1 (B-122): the harness this process runs, as it starts (harness-version.mjs).
  (await import('./harness-version.mjs')).processHarness();
  if (argv[0] === 'run-next' && argv[1]) {
    const { res, rerun } = await runNextNow({ root, after: argv[1] });
    console.log(res.message || '');
    if (rerun) console.log(rerun.message || '');
    process.exit(res.ok ? 0 : 1);
  }
  if (argv[0] === 'run') {
    try { fs.mkdirSync(path.dirname(DAEMON_FILE(root)), { recursive: true }); const r = readJson(DAEMON_FILE(root)) || {}; fs.writeFileSync(DAEMON_FILE(root), `${JSON.stringify({ ...r, pid: process.pid, at: r.at || new Date().toISOString() })}\n`); } catch {}
    // 2.78.2 (a): `run --wait <min>` (a train a queued task done started): wait that long for a running train.
    const wi = argv.indexOf('--wait');
    const waitMin = wi >= 0 ? Number(argv[wi + 1]) : 0;
    const { res } = await runDaemonTrain({ root, waitMs: Number.isFinite(waitMin) && waitMin > 0 ? waitMin * 60000 : 0 });
    console.log(res.message || '');
    process.exit(res.ok ? 0 : 1);
  }
  console.log(autoStatusText(root));
  process.exit(0);
}
