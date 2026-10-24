#!/usr/bin/env node
/**
 * harness/watchdog.mjs — the overnight watchdog (2.30, G1). Opt-in: off until the dev turns it on,
 * for runs nobody is watching. A script, not a model: it costs no tokens and never slows a build.
 *
 *   npm run watchdog -- on --by <dev> | off --by <dev> | status
 *   (or the switch in the War Room's Ops view)
 *
 * While it is on, every watch pass also:
 *   1. answers a refresh check nobody answered in STUDIO_WATCHDOG_CHECK_MIN (15) minutes: hand off, so a
 *      flagged session can't run on unchecked;
 *   2. parks a task handed back STUDIO_WATCHDOG_HANDBACKS (3) times in 2 hours, with the reason;
 *   3. stops the studio when no task finished in STUDIO_WATCHDOG_IDLE_HOURS (2) while sessions ran.
 * Every action is an event with "watchdog" as the agent, so the morning report shows what it did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';

export const WATCHDOG_FILE = path.join(STUDIO_STATE_DIR, 'watchdog.json');
export function readWatchdog() {
  try {
    return { on: false, ...JSON.parse(fs.readFileSync(WATCHDOG_FILE, 'utf8')) };
  } catch {
    return { on: false };
  }
}
export function watchdogLimits(env = process.env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  return { checkMin: n(env.STUDIO_WATCHDOG_CHECK_MIN, 15), handBacks: n(env.STUDIO_WATCHDOG_HANDBACKS, 3), idleHours: n(env.STUDIO_WATCHDOG_IDLE_HOURS, 2) };
}
export function setWatchdog(on, by) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const w = { ...readWatchdog(), on: Boolean(on), by, at: new Date().toISOString() };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(WATCHDOG_FILE, `${JSON.stringify(w, null, 2)}\n`);
  emitEvent({ type: 'watchdog.switch', agent: by, to: 'producer', msg: `Watchdog ${on ? 'on' : 'off'} (${by})${on ? ': unanswered refresh checks hand off, looping tasks park, an idle studio stops' : ''}` });
  return { ok: true, watchdog: w };
}

/** One pass. Returns what it did. Does nothing while off. */
export async function watchdogPass(now = Date.now(), { events = readRecentEvents(5000), lim = watchdogLimits() } = {}) {
  const w = readWatchdog();
  // 2.30o: always on while a studio has an active game (STUDIO_WATCHDOG=off is the only way out), so
  // production never depends on someone attending. Away mode is no longer needed to turn it on.
  const { gameActive, gamedevPass } = await import('./gamedev-loop.mjs');
  const auto = !w.on && !/^off$/i.test(process.env.STUDIO_WATCHDOG || '') && (await gameActive());
  if (!w.on && !auto) return { on: false, actions: [] };
  const actions = [];
  try {
    for (const a of await gamedevPass(now, { events })) actions.push(a);
  } catch (e) {
    actions.push({ kind: 'error', msg: `game-dev loop: ${e.message}` });
  }
  // 1. Unanswered checks.
  const { refreshBoard, endForRefresh, readFlag } = await import('./session-cap.mjs');
  for (const r of refreshBoard()) {
    if (!r.running || !r.checkDue) continue;
    const at = Date.parse(readFlag(r.agent)?.cardAt || '');
    if (!(now - at >= lim.checkMin * 60000)) continue;
    const res = await endForRefresh(r.agent, 'watchdog');
    if (res.ok) actions.push({ kind: 'handoff', agent: r.agent, msg: `${r.agent}'s refresh check went unanswered for ${lim.checkMin} min (${r.turns} turns, ${r.model}): handed off` });
  }
  // 2. Looping tasks.
  const { setHold, readHolds } = await import('./task-hold.mjs');
  const since = now - 2 * 3600000;
  const counts = new Map();
  // 2.30q (#6): hand-backs the harness caused (claim ran out during gates, merge refused by the main checkout,
  // land lock) are not the task looping, so they never count toward parking.
  const { harnessCaused, taskBusy } = await import('./busy.mjs');
  for (const e of events) if (e.type === 'task.paused' && e.task && Date.parse(e.ts) >= since && !harnessCaused(e)) counts.set(e.task, (counts.get(e.task) || 0) + 1);
  const holds = readHolds();
  for (const [task, n] of counts) {
    if (n < lim.handBacks || holds[task]?.parked) continue;
    if ((await taskBusy(task, { now })).busy) continue;
    setHold(task, { parked: { by: 'watchdog', why: `handed back ${n} times in 2 h; a person or the Producer looks before it runs again`, at: new Date(now).toISOString() } }, { by: 'watchdog', msg: `watchdog parked ${task}: handed back ${n} times in 2 h` });
    actions.push({ kind: 'park', task, msg: `parked ${task} (handed back ${n} times in 2 h)` });
  }
  // 3. An idle studio: sessions ran for the whole window, nothing finished.
  const win = now - lim.idleHours * 3600000;
  const turnedOnAt = auto ? 0 : Date.parse(w.at || '') || 0;
  if (lim.idleHours > 0 && turnedOnAt <= win) {
    const ran = events.filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= win).length;
    const done = events.filter((e) => e.type === 'task.done' && Date.parse(e.ts) >= win).length;
    const { readStop, setStop } = await import('./task.mjs');
    if (ran >= 2 && !done && !readStop()) {
      setStop('watchdog', `no task finished in ${lim.idleHours} h while ${ran} sessions ran`);
      actions.push({ kind: 'stop', msg: `stopped the studio: ${ran} sessions, no task finished in ${lim.idleHours} h` });
    }
  }
  for (const a of actions) emitEvent({ type: 'watchdog.action', agent: 'watchdog', to: 'producer', task: a.task, msg: `Watchdog ${a.msg}`, meta: { kind: a.kind } });
  return { on: true, auto, actions };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--by');
  const by = i >= 0 ? argv[i + 1] : null;
  const cmd = argv[0] || 'status';
  if (cmd === 'on' || cmd === 'off') {
    const r = setWatchdog(cmd === 'on', by);
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
  } else if (cmd === 'loop') {
    // 2.30o: the game-dev loop without the hub (the hub runs it itself every STUDIO_GAMEDEV_INTERVAL s).
    const every = Number(argv[1] || 180);
    const once = async () => {
      const r = await watchdogPass();
      console.log(`[gamedev] ${r.on ? (r.actions.length ? r.actions.map((a) => a.msg).join(' | ') : 'nothing to do') : 'off (no active game, or STUDIO_WATCHDOG=off)'}`);
      return r;
    };
    const r = await once();
    if (every > 0 && r.on && !argv.includes('--once')) setInterval(() => once().catch((e) => console.error(`[gamedev] ${e.message}`)), every * 1000);
    else process.exit(0);
  } else if (cmd === 'pass') {
    const r = await watchdogPass();
    console.log(r.on ? (r.actions.length ? r.actions.map((a) => a.msg).join('\n') : 'Watchdog: nothing to do.') : 'Watchdog is off.');
    process.exit(0);
  } else if (cmd !== 'status') {
    console.log('Usage: npm run watchdog -- on|off --by <name> | status | pass | loop [seconds] [--once]');
    process.exit(1);
  }
  const w = readWatchdog();
  const l = watchdogLimits();
  console.log(w.on ? `Watchdog is on (${w.by}, ${w.at}): unanswered checks hand off after ${l.checkMin} min, a task handed back ${l.handBacks} times in 2 h parks, no task done in ${l.idleHours} h stops the studio.` : 'Watchdog is off: no studio game is active (it turns on by itself while one is; STUDIO_WATCHDOG=off opts out). Force it on: npm run watchdog -- on --by <you>');
}
