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
 *   3. stops the studio when no task finished in STUDIO_WATCHDOG_IDLE_HOURS (2) while sessions that held a task
 *      ran (planning sessions don't count; the window never starts before the studio, a switch-on or a resume).
 *      0 turns the idle stop off.
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

/**
 * 2.54.0: the idle stop. Stops the studio when sessions that held a task ran for the whole window and none
 * finished. The window starts no earlier than the studio's first event, the watchdog being switched on, or
 * the last resume, so a young or just-resumed studio is never stopped for hours it didn't run (P-022).
 * Planning sessions (Producer, Director, any session that never held a task) don't count: they don't
 * finish tasks by design (P-023).
 */
export function idleStopReason(now, { events = [], lim = watchdogLimits(), w = {}, auto = false } = {}) {
  if (!(lim.idleHours > 0)) return null;
  const win = now - lim.idleHours * 3600000;
  const ts = (e) => Date.parse(e.ts) || 0;
  // The studio's start: its first event, when the log still holds it (a full buffer means an older studio).
  const studioStart = events.length && events.length < 5000 ? Math.min(...events.map(ts).filter(Boolean)) : 0;
  const switchedOn = !auto ? Date.parse(w.at || '') || 0 : 0;
  const resumed = Math.max(0, ...events.filter((e) => e.type === 'studio.resumed').map(ts));
  const since = Math.max(studioStart, switchedOn, resumed);
  if (since > win) return null;
  const inWin = events.filter((e) => ts(e) >= win);
  if (inWin.some((e) => e.type === 'task.done')) return null;
  const heldTask = new Set(inWin.filter((e) => /^task\.(start|paused|done|claimed)$/.test(e.type) && e.agent).map((e) => e.agent));
  const ran = inWin.filter((e) => e.type === 'agent.session.end' && (e.task || e.meta?.handed?.length || heldTask.has(e.agent))).length;
  return ran >= 2 ? { ran, hours: lim.idleHours } : null;
}

async function idleStop(now, { events, lim, w, auto }) {
  const { readStop, setStop } = await import('./task.mjs');
  if (readStop()) return null;
  const r = idleStopReason(now, { events, lim, w, auto });
  if (!r) return null;
  setStop('watchdog', `no task finished in ${r.hours} h while ${r.ran} task sessions ran`);
  return { kind: 'stop', msg: `stopped the studio: ${r.ran} task sessions, no task finished in ${r.hours} h` };
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
  // 3. An idle studio (2.54.0: checked first, so a pass that stops the studio launches nothing after it).
  const idle = await idleStop(now, { events, lim, w, auto });
  if (idle) {
    actions.push(idle);
    return { on: true, auto, actions, quieted: actions.length - logActions(actions, { now }).length };
  }
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
  // 2b. 2.31.0: tasks over their own budget (sessions, claimed minutes, tokens). This also covers builders
  // the harness never launched: their claims count, so a long outside claim is parked and flagged here.
  try {
    const { stopIfOverBudget } = await import('./task-budget.mjs');
    const { parseNextQueue } = await import('./task.mjs');
    const before = readHolds();
    for (const t of parseNextQueue().inProgress) {
      if (before[t.id]?.parked) continue;
      const why = stopIfOverBudget(t.id, { by: 'watchdog', now });
      if (why) actions.push({ kind: 'budget', task: t.id, msg: `stopped ${t.id}: ${why.split('. ')[0]}` });
    }
  } catch (e) {
    actions.push({ kind: 'error', msg: `task budgets: ${e.message}` });
  }
  // 2c. 2.35.0: the rescue ladder (harness/rescue.mjs). A task stopped by its budget gets a rescue on a
  // different model family; a stuck rescue (own budget, or unclaimed for an hour) moves it to a split
  // rescue on the next model; after that it is shelved for the morning report. Nothing waits on it.
  try {
    const { rescuePass } = await import('./rescue.mjs');
    actions.push(...(await rescuePass({ now })));
  } catch (e) {
    actions.push({ kind: 'error', msg: `rescues: ${e.message}` });
  }
  // 2d. 2.37.0: the whole-game check (STUDIO_WHOLE_GAME=on): a new commit on the studio's branch starts a
  // background run of every check on the whole game (harness/whole-game.mjs).
  try {
    const { wholeKick } = await import('./whole-game.mjs');
    const a = wholeKick();
    if (a) actions.push(a);
  } catch (e) {
    actions.push({ kind: 'error', msg: `whole-game check: ${e.message}` });
  }
  const logged = logActions(actions, { now });
  return { on: true, auto, actions, quieted: actions.length - logged.length };
}

/**
 * 2.40.0: log the watchdog's actions as watchdog.action events. With STUDIO_WATCHDOG_QUIET_MIN (opt-in) the
 * same action (kind, task and message, numbers ignored) is logged once per window; when it shows again after
 * the window, its line says how many times it repeated meanwhile. The actions themselves still happen every
 * pass; only the log is quieter (the research pack counted 11-23 watchdog events per finished task).
 * Returns the actions that were logged.
 */
export function logActions(actions, { now = Date.now(), env = process.env, file = path.join(STUDIO_STATE_DIR, 'watchdog-quiet.json') } = {}) {
  const quietMs = Number(env.STUDIO_WATCHDOG_QUIET_MIN || 0) * 60000;
  let seen = {};
  if (quietMs > 0) { try { seen = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {} }
  const logged = [];
  for (const a of actions) {
    const key = `${a.kind}|${a.task || ''}|${String(a.msg || '').replace(/\d+(\.\d+)?/g, '#')}`;
    const s = seen[key];
    if (quietMs > 0 && s && now - s.at < quietMs) { s.count = (s.count || 0) + 1; continue; }
    const again = s?.count ? ` (repeated ${s.count} more time${s.count === 1 ? '' : 's'} since ${new Date(s.at).toISOString().slice(11, 16)} UTC)` : '';
    emitEvent({ type: 'watchdog.action', agent: 'watchdog', to: 'producer', task: a.task, msg: `Watchdog ${a.msg}${again}`, meta: { kind: a.kind, ...(s?.count ? { repeated: s.count } : {}) } });
    logged.push(a);
    if (quietMs > 0) seen[key] = { at: now, count: 0 };
  }
  if (quietMs > 0) {
    for (const [k, v] of Object.entries(seen)) if (now - v.at > Math.max(quietMs * 4, 86400000)) delete seen[k];
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(seen)}\n`); } catch {}
  }
  return logged;

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
