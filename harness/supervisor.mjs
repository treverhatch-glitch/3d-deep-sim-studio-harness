#!/usr/bin/env node
/**
 * harness/supervisor.mjs — keep the studio running without anyone at the keyboard.
 *
 *   npm run studio:start [-- --until 23:00 | --until 8h] [--window 09:00-23:00] [--budget 50% | --budget 3000000]
 *                        [--lanes auto] [--no-hub] [--foreground]   (runs on its own unless --foreground)
 *   npm run studio:start -- --install [same options]    start it at login (launchd, systemd --user, Task Scheduler)
 *   npm run studio:start -- --uninstall
 *   npm run studio:stop                                  stop the supervisor (agents finish their task)
 *   npm run studio:status
 *   npm run studio:resume -- --by <your name> [--why "…"]   clear a halt ("Fixed it: try again" without the War Room)
 *     [--permission "<the person's words or a link>"]        2.59.1: a Producer/Director or an outside agent, for a person
 *   npm run studio:extend -- --until <time|+8h|none> --by <your name> [--why "…"] [--permission "…"]
 *                                                        2.73.1: move a running supervisor's end time, no restart
 *
 * Every minute it:
 *   1. keeps the War Room hub up (restarts it, and logs how long it was down);
 *   2. stops starting work outside the time window, past --until, past the budget, or while "Stop all" is on;
 *   3. starts agents for waiting work, one task per session: for each role (and lane) with waiting
 *      tasks and no agent on it, within the pace's caps, it starts a fresh agent on the next task. When
 *      a session ends, the next minute starts the next one. With --budget and the plan under its target
 *      (studio/budget.json), it allows up to two extra agents; over the target, none;
 *   4. skips a tool that ran out of quota until its reset and uses the next tool in the budget's order.
 * 2.65.0: a halt (two sessions in a row ending the same bad way) whose cause is on the self-triage list
 * (harness/self-triage.mjs: the tool isn't on PATH and another tool is) is fixed and cleared by "self-triage";
 * any other halt still waits for a person (studio:resume or the War Room).
 * With --lanes auto, tasks that name a lane (task add --lane game/x/src/floors) get one agent per lane,
 * each holding that folder, so builders never edit the same files.
 * 2.68.0: each pass also runs the crew watchdog (harness/crew-watch.mjs: a role launching sessions that land nothing is
 * paused), the futility cap (harness/futility.mjs, shadow mode by default) and the usage wind-down
 * (harness/winddown.mjs, STUDIO_USAGE_WINDDOWN_PCT). Code only: no model, no tokens.
 * 2.69.0 (r): and the train daemon (harness/train-daemon.mjs, STUDIO_TRAIN_AUTO, default on): a merge train starts on
 * its own when lanes are ready and the machine budget has room for a verify (npm run task -- train auto off|on --by).
 * Status: .studio/supervisor.json, the War Room's Ops view, and the run report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { poolPlan } from './api-pool.mjs';
const poolPlanNow = (usage, live) => poolPlan({ usage, live });
import { writeAtomic } from './fsafe.mjs';
import { selfIdentity, pidAlive, pidExists, readStarts, sameProcess } from './proc-identity.mjs';

export const STATUS_FILE = path.join(STUDIO_STATE_DIR, 'supervisor.json');
const STOP_FILE = path.join(STUDIO_STATE_DIR, 'supervisor-stop');
const LOOP_MS = Number(process.env.STUDIO_SUPERVISOR_SEC || 60) * 1000;
const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
/**
 * 2.77.1 (B-102): one step of a pass, bounded. A step still pending after `ms` is reported (supervisor.step_timeout)
 * and the pass goes on with `fallback`, so one hung step can't keep the Communicator, the machine scan, the train
 * daemon and the status save from running. The step itself is not killed; it may still finish later.
 */
export async function boundedStep(label, fn, { ms = num(process.env.STUDIO_SUPERVISOR_STEP_SEC, 300) * 1000, fallback, state = null, emit = emitEvent } = {}) {
  if (state) state.step = label;
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((resolve) => { timer = setTimeout(() => { try { emit({ type: 'supervisor.step_timeout', agent: 'supervisor', to: 'producer', status: 'warn', msg: `supervisor step "${label}" still running after ${Math.round(ms / 1000)} s; the pass went on without it`, meta: { step: label, ms } }); } catch {} resolve(typeof fallback === 'function' ? fallback() : fallback); }, ms); }),
    ]);
  } finally { clearTimeout(timer); }
}
/**
 * 2.78.0 (PU-63): start backoff. A start of task T refused for the same reason as last time (task.start_refused,
 * task.lock_denied, a start the launcher refused) is skipped in later passes for 2, 4, 8 ... minutes (doubling per repeat,
 * capped at STUDIO_START_BACKOFF_MAX_MIN, 30). It resets when the reason changes or the task's state changes (a hold, an
 * unhold, a hand-back, a start, a lock taken or freed). The state is in state.startBackoff (mirrored to
 * .studio/start-backoff.json so a restart or the watcher's fresh state keeps it).
 */
export const START_BACKOFF_FILE = path.join(STUDIO_STATE_DIR, 'start-backoff.json');
export const startBackoffMaxMin = (env = process.env) => { const v = num(env.STUDIO_START_BACKOFF_MAX_MIN, 30); return v > 0 ? v : 30; };
/** The wait after `repeats` same-reason refusals in a row (1 -> 2 min, 2 -> 4, 3 -> 8 ...), in ms; 0 for the first refusal. */
export const startBackoffMs = (repeats, env = process.env) => (repeats >= 1 ? Math.min(startBackoffMaxMin(env), 2 ** Math.min(repeats, 20)) * 60000 : 0);
export const refusalKey = (reason) => String(reason || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 160);
const TASK_STATE_EVENTS = new Set(['task.added', 'task.start', 'task.done', 'task.paused', 'task.reopened', 'task.dropped', 'task.held', 'task.unheld', 'task.hold', 'task.lane', 'task.dev_yes', 'task.retyped', 'task.reordered']);
/** What "the task's state" is for the backoff: its latest state-changing event and whether its task lock is held. */
export function taskStateSig(events, task, locked = false) {
  let last = null;
  for (const e of events) if (e.task === task && TASK_STATE_EVENTS.has(e.type)) last = e;
  return `${last ? `${last.type}@${last.ts}` : 'none'}|${locked ? 'locked' : 'free'}`;
}
/** Record a refusal of `task` for `reason` in state.startBackoff; returns the entry ({ count, until, … }). */
export function noteStartRefusal(state, task, reason, sig, now = Date.now(), env = process.env) {
  const bo = (state.startBackoff ||= {});
  const key = refusalKey(reason);
  const prev = bo[task];
  const count = prev && prev.reason === key && prev.sig === sig ? prev.count + 1 : 1;
  bo[task] = { reason: key, sig, count, until: now + startBackoffMs(count - 1, env), said: false };
  return bo[task];
}
/** The live backoff entry for `task`, or null (none, expired, or the task's state changed, which resets it). */
export function startBackedOff(state, task, sig, now = Date.now()) {
  const e = state.startBackoff?.[task];
  if (!e) return null;
  if (e.sig !== sig) { delete state.startBackoff[task]; return null; }
  return now < e.until ? e : null;
}
const START_REFUSALS = new Set(['task.start_refused', 'task.lock_denied']);
/** Fold the log's refusals since the last look into state.startBackoff. Returns how many it noted. */
export function ingestRefusals(state, events, sigOf, now = Date.now(), env = process.env) {
  const from = state.startBackoffSeen ?? state.startedAt ?? now;
  let seen = from; let k = 0;
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const t = Date.parse(e.ts);
    if (!START_REFUSALS.has(e.type) || !e.task || !(t > from)) continue;
    noteStartRefusal(state, e.task, `${e.type} ${e.msg || ''}`.replace(new RegExp(String(e.task).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'T'), sigOf(e.task), now, env);
    seen = Math.max(seen, t); k += 1;
  }
  state.startBackoffSeen = seen;
  return k;
}
/**
 * 2.78.0 (PU-63): the loop's delay with +-STUDIO_SUPERVISOR_JITTER (0.1; 0 = off) so several supervisors or watchers on one PC
 * don't fire in lockstep. rnd() is in [0, 1).
 */
export const supervisorJitter = (env = process.env) => Math.min(0.5, Math.max(0, num(env.STUDIO_SUPERVISOR_JITTER, 0.1)));
export const jitteredDelay = (baseMs, frac = supervisorJitter(), rnd = Math.random) => Math.max(1, Math.round(baseMs * (1 + (rnd() * 2 - 1) * frac)));
const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
export const readStatus = () => readJson(STATUS_FILE);
/** "Try again" on a halted supervisor: the War Room (hub) or `npm run studio:resume` writes it; the next pass reads it. */
const RESUME = path.join(STUDIO_STATE_DIR, 'supervisor-resume');
function readResume() {
  let text = '';
  try { text = fs.readFileSync(RESUME, 'utf8').trim(); } catch { return {}; }
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return { by: String(j.by || '').slice(0, 60), why: String(j.why || '').slice(0, 300), via: String(j.via || '').slice(0, 20) }; } catch {}
  return { by: text.slice(0, 60), via: 'war-room' };
}

/**
 * 2.59.0 (#15): `npm run studio:resume -- --by <name> [--why "…"]`: what the War Room's "Fixed it: try again" does, from a
 * terminal, without the hub token. A person decides to retry after two sessions failed the same way, so it refuses
 * inside a launched agent session and for agents' names. Not halted (or no supervisor running): says so, does nothing.
 * STUDIO_RESUME_BY (off by default): a comma-separated list of the names allowed to resume; when set, any other is refused.
 */
export async function resumeCli({ by = null, why = null, permission = null, env = process.env } = {}) {
  const { agentLikeName, launchedSession } = await import('./agent-env.mjs');
  const { agentOnPermission, permissionText } = await import('./permission.mjs');
  const who = String(by || '').trim();
  // 2.59.1 (the owner's rule): with a person's direct permission (--by <them> --permission "<their words or a link>"),
  // a Producer or Director session, or an agent outside the harness, may resume for them; a worker session never.
  const perm = permissionText(permission);
  const onPerm = perm ? agentOnPermission({ permission: perm, env }) : null;
  if (onPerm && !onPerm.ok) return { code: 1, text: `Not resumed: ${onPerm.why}.` };
  const inSession = onPerm ? null : launchedSession(env);
  if (inSession) return { code: 1, text: `Not resumed: ${inSession}. After two sessions failed the same way, a person decides to try again: npm run studio:resume -- --by <your name> in your own terminal, or "Fixed it: try again" in the War Room. With a person's direct permission a Producer or Director session, or an agent outside the harness, may do it for them: --by <the person> --permission "<their words or a link>".` };
  if (!who) return { code: 1, text: 'Who is asking? npm run studio:resume -- --by <your name> [--why "what you fixed"]' };
  if (agentLikeName(who, { stateDir: STUDIO_STATE_DIR })) return { code: 1, text: `Not resumed: "${who}" is an agent's name. A person decides to try again after repeated failures: --by <your name>.` };
  const allow = String(env.STUDIO_RESUME_BY || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(who.toLowerCase())) return { code: 1, text: `Not resumed: "${who}" isn't in STUDIO_RESUME_BY (the names the owner allows to resume the supervisor).` };
  const s = readStatus();
  if (!s || s.status !== 'running' || !alive(s)) {
    const stale = await clearStaleHalt({ who, why, permRec: onPerm && onPerm.via !== 'person' ? { permission: perm.slice(0, 300), recordedBy: onPerm.recordedBy } : {}, env });
    if (stale) return stale;
    return { code: 0, text: `Not halted: no supervisor is running${s?.status === 'running' ? ' (its process is gone)' : ''}, so there is nothing to clear. npm run studio:start starts a fresh one.` };
  }
  if (!s.halted) return { code: 0, text: 'Not halted: the supervisor is starting agents; nothing to clear.' };
  const note = String(why || '').trim().slice(0, 300);
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const permRec = onPerm && onPerm.via !== 'person' ? { permission: perm.slice(0, 300), recordedBy: onPerm.recordedBy } : {};
  fs.writeFileSync(RESUME, `${JSON.stringify({ by: who.slice(0, 60), why: note, via: 'cli', at: new Date().toISOString(), ...permRec })}\n`);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'studio-resume', subject: 'supervisor', by: who.slice(0, 60), as: dm.asOf({ via: permRec.recordedBy ? 'outside agent' : 'person', permission: permRec.permission }), why: note || 'try again', evidence: `halted: ${String(s.halted.why || '').slice(0, 120)}`, undo: null }); } catch {}
  emitEvent({ type: 'supervisor.resume_asked', agent: who.slice(0, 60), to: 'supervisor', msg: `${who} asked the supervisor to try again${permRec.recordedBy ? ` (recorded by ${permRec.recordedBy} on ${who}'s permission: "${permRec.permission.slice(0, 120)}")` : ''}${note ? `: ${note}` : ''} (it stopped: ${s.halted.why || 'see npm run studio:status'})`.slice(0, 600), meta: { ...permRec, by: who.slice(0, 60), why: note || null, via: 'cli', cleared: s.halted.why || null } });
  return { code: 0, text: `Cleared the halt (${s.halted.why || 'no reason recorded'}). The supervisor starts agents again on its next pass (within ${Math.round(LOOP_MS / 1000)} s); its supervisor.resumed event names ${who}.` };
}
/**
 * 2.73.1: `npm run studio:extend -- --until <time|+8h|none> --by <name> [--why "…"] [--permission "…"]` moves a running
 * supervisor's end time (its --until) without a restart: it writes .studio/supervisor-extend.json, which the next pass
 * reads (applyExtend: a supervisor.extended event). "none" removes the end time. Who may: the decider rules
 * (harness/decider.mjs, action 'supervisor-extend'): a person; an agent the owner's delegation covers for
 * 'supervisor-extend' (harness/delegation.mjs delegationFor); a Producer or Director session or an outside agent on a
 * person's direct permission (--permission); never a worker session or a worker's name.
 */
export const EXTEND_FILE = path.join(STUDIO_STATE_DIR, 'supervisor-extend.json');
export async function extendCli({ until = null, by = null, why = null, permission = null, env = process.env, now = Date.now() } = {}) {
  const raw = String(until || '').trim();
  if (!raw) return { code: 1, text: 'Until when? npm run studio:extend -- --until <23:00 | +8h | 2026-11-05T11:52:00Z | none> --by <your name> [--why "…"]' };
  const none = /^(none|off|never)$/i.test(raw);
  const t = none ? null : parseUntil(raw, now);
  if (!none && !Number.isFinite(t)) return { code: 1, text: `Not changed: "${raw}" isn't a time. Use 23:00, +8h, 90m, an ISO time (2026-11-05T11:52:00Z) or none.` };
  if (!none && t <= now) return { code: 1, text: `Not changed: ${new Date(t).toISOString()} has passed. To stop now: npm run studio:stop.` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, action: 'supervisor-extend', env, what: "change the supervisor's end time" });
  if (!d.ok) return { code: 1, text: `Not changed: ${d.why.replace(/^Refused: /, '')}` };
  const s = readStatus();
  if (!s || s.status !== 'running' || !alive(s)) return { code: 1, text: `Not changed: no supervisor is running${s?.status === 'running' ? ' (its process is gone)' : ''}. Start one with the end time you want: npm run studio:start -- --until ${raw}` };
  const from = s.opts?.until || null;
  const rec = { until: none ? null : new Date(t).toISOString(), from, by: String(d.by).slice(0, 60), why: String(why || '').trim().slice(0, 300), via: d.via, at: new Date(now).toISOString(), ...(d.via !== 'person' ? { recordedBy: d.recordedBy, permission: String(d.permission || '').slice(0, 300) } : {}) };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(EXTEND_FILE, `${JSON.stringify(rec, null, 2)}\n`);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'supervisor-extend', subject: 'supervisor', by: rec.by, as: dm.asOf(d), why: rec.why || 'new end time', evidence: `until ${from || 'none'} -> ${rec.until || 'none'}`, undo: from ? { kind: 'supervisor-extend', text: `npm run studio:extend -- --until ${from} --by <name>` } : null }); } catch {}
  emitEvent({ type: 'supervisor.extend_asked', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'supervisor', msg: `${rec.by} asked the supervisor to run ${rec.until ? `until ${rec.until}` : 'with no end time'} (was ${from || 'no end time'})${d.via !== 'person' ? ` (recorded by ${d.recordedBy}, ${d.via})` : ''}${rec.why ? `: ${rec.why}` : ''}`.slice(0, 600), meta: rec });
  return { code: 0, text: `The supervisor runs ${rec.until ? `until ${rec.until} (${new Date(t).toString().slice(0, 21)} here)` : 'with no end time'} from its next pass (within ${Math.round(LOOP_MS / 1000)} s); it was ${from || 'no end time'}. Its supervisor.extended event names ${rec.by}.` };
}
/** The loop's half: a waiting studio:extend request moves opts.until (and the status record's). Returns it or null. */
export function applyExtend(opts, state, now = Date.now()) {
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(EXTEND_FILE, 'utf8')); } catch { return null; }
  fs.rmSync(EXTEND_FILE, { force: true });
  const t = rec?.until === null ? null : Date.parse(rec?.until || '');
  if (!rec || (rec.until !== null && !Number.isFinite(t))) return null;
  const from = opts.until ? new Date(opts.until).toISOString() : null;
  opts.until = t;
  state.opts = { ...(state.opts || {}), until: t ? new Date(t).toISOString() : null };
  state.extended = { at: new Date(now).toISOString(), by: rec.by || null, from, to: state.opts.until };
  emitEvent({ type: 'supervisor.extended', agent: 'supervisor', to: 'producer', msg: `Supervisor end time ${from || 'none'} -> ${state.opts.until || 'none'} (${rec.by || 'someone'} asked${rec.why ? `: ${rec.why}` : ''})`.slice(0, 600), meta: { by: rec.by || null, why: rec.why || null, via: rec.via || null, recordedBy: rec.recordedBy || null, from, to: state.opts.until } });
  return state.extended;
}

/**
 * 2.67.0: a halt left open in the event log by a supervisor that is no longer running (it crashed, or the PC
 * restarted) kept the scorecard's "still waiting" counting for days, and studio:resume said "nothing to clear". Once
 * the halt is older than STUDIO_HALT_STALE_H (24) hours, studio:resume (the same people as above: a person, or a
 * Producer/Director session or an outside agent on a person's recorded permission) records supervisor.halt_cleared,
 * which ends it on the card. A younger one is left alone (nothing waits on it; a new supervisor starts unhalted).
 * Returns { code, text } or null (no open halt in the log).
 */
async function clearStaleHalt({ who, why, permRec = {}, env = process.env, now = Date.now() }) {
  const { openHaltOf, haltStaleHours } = await import('./autonomy.mjs');
  const staleH = haltStaleHours(env);
  const h = openHaltOf(readRecentEvents(50000), { now, running: false, staleH });
  if (!h) return null;
  if (!h.stale) return { code: 0, text: `Not cleared: the open halt (since ${h.atLocal}, by ${h.who}: ${h.cause}) is ${h.ageH} h old, under STUDIO_HALT_STALE_H (${staleH} h). No supervisor is running, so nothing waits on it: npm run studio:start starts a fresh one, unhalted.` };
  const note = String(why || '').trim().slice(0, 300);
  emitEvent({ type: 'supervisor.halt_cleared', agent: (permRec.recordedBy || who).slice(0, 60), to: 'producer', msg: `${who} cleared a stale halt (since ${h.at}, ${h.ageH} h; its supervisor isn't running)${permRec.recordedBy ? ` (recorded by ${permRec.recordedBy} on ${who}'s permission: "${permRec.permission.slice(0, 120)}")` : ''}${note ? `: ${note}` : ''} (it stopped: ${h.cause})`.slice(0, 600), meta: { ...permRec, by: who.slice(0, 60), why: note || null, via: 'cli', stale: true, haltAt: h.at, ageH: h.ageH, staleH, cleared: h.cause } });
  return { code: 0, text: `Cleared a stale halt (since ${h.atLocal}, ${h.ageH} h old; its supervisor isn't running): ${h.cause}. The scorecard no longer counts it as waiting; npm run studio:start starts a fresh supervisor.` };
}
// PU-17 (P-039, P-045): a status record's supervisor is alive while its pid is in use (no OS query); on Linux the
// /proc start written at its start must match too, so a status file left "running" by a crash or a reboot that
// names a reused number reads as not running.
const alive = (st) => Boolean(st?.pid) && pidAlive(st.pid, st.identity, { eperm: false });

/** "23:00" (today, or tomorrow if past), "8h", "90m" (2.73.1: or "+8h"; from now), or an ISO time. */
export function parseUntil(s, now = Date.now()) {
  if (!s) return null;
  const rel = String(s).trim().match(/^\+?\s*(\d+(?:\.\d+)?)\s*(h|m|s)$/i);
  if (rel) return now + Number(rel[1]) * { h: 3600000, m: 60000, s: 1000 }[rel[2].toLowerCase()];
  const hm = String(s).match(/^(?:tonight\s+|today\s+)?(\d{1,2}):(\d{2})$/i);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}
/** Inside a daily window "09:00-23:00" (it may cross midnight)? */
export function inWindow(win, now = Date.now()) {
  const m = String(win || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return true;
  const d = new Date(now);
  const mins = d.getHours() * 60 + d.getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a <= b ? mins >= a && mins < b : mins >= a || mins < b;
}

/**
 * Two sessions in a row ending the same bad way (exit 127 and the like): record the halt (supervisor.halted, Needs you).
 * Returns true when it halted. 2.68.0: also run when the time is up, so a halt caught by the last pass before --until
 * is still recorded (on a slow machine the second bad end used to land after the stop and the halt was lost).
 */
async function checkBadEnds(opts, state, now) {
  // PU-19: a session that stopped at its usage limit waits for the reset (its tool is marked out); it isn't a bad end.
  // 2.58.3 (N1): nor is a session a person (or the Producer) stopped or paused: killing it ends it with exit 1 on
  // Windows (taskkill /F) and by a signal elsewhere; the launcher records who stopped it (meta.stoppedBy).
  // 2.73.1 (B-66): nor one its own launcher ended (meta.exitCause: the stall watchdog, the idle exit, the task's budget):
  // like the watchdog's stop (stoppedBy) it ends with exit 1 or a signal, and those have their own handling (the breaker,
  // the crew watchdog). And sessions that die within STUDIO_HALT_SAME_DEATH_SEC (5) of each other count as ONE end: one
  // outside cause (a killed process tree, a crash of the machine's shell) took them together.
  const mine = readRecentEvents(5000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= (state.haltCheckFrom || state.startedAt) && (state.names || []).includes(e.agent) && !e.meta?.usageLimit && !e.meta?.stoppedBy && !LAUNCHER_KILLS.has(e.meta?.exitCause?.kind));
  const ends = groupSameDeaths(mine);
  const last2 = ends.slice(-2).map((g) => g[g.length - 1]);
  if (last2.length === 2 && last2.every((e) => e.meta?.code && e.meta.code === last2[0].meta.code && (e.meta?.tool || '') === (last2[0].meta?.tool || ''))) {
    const code = last2[0].meta.code;
    const groups = ends.slice(-2);
    // Name the program, not "custom" (test #2): the first word of STUDIO_<ROLE>_CMD or STUDIO_AGENT_CMD.
    const metaTool = last2[0].meta?.tool || 'the agent tool';
    const roleOf = String(last2[0].meta?.role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const tool = metaTool === 'custom' ? String(process.env[`STUDIO_${roleOf}_CMD`] || process.env.STUDIO_AGENT_CMD || 'the custom command').trim().split(/\s+/)[0].replace(/^["']|["']$/g, '') : metaTool;
    // A program that isn't on the PATH: exit 127 (9009, or 1 under cmd.exe on Windows), or one `which` can't find.
    const missing = code === 127 || code === 9009 || (/^[\w.-]+$/.test(tool) && spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { windowsHide: true, encoding: 'utf8' }).status !== 0);
    const hint = missing ? `${tool} wasn't found: the supervisor's PATH doesn't include it (reinstall with npm run studio:start -- --install from a terminal where \`${tool}\` works)` : code === 126 ? `${tool} isn't executable` : `check npm run agent -- logs ${last2[1].agent}`;
    const names = groups.map((g) => (g.length > 1 ? `${g.map((e) => e.agent).join(' + ')} together` : g[0].agent));
    const causes = groups.flat().map((e) => ({ agent: e.agent, ...(e.meta?.exitCause ? { kind: e.meta.exitCause.kind, signal: e.meta.exitCause.signal || null } : { kind: 'unknown' }), code: e.meta?.code ?? null }));
    state.halted = { at: new Date(now).toISOString(), code, tool, scope: 'builders', why: `two sessions in a row ended with exit ${code} (${names.join(', ')}): ${hint}`, causes, ...(metaTool === 'custom' ? { custom: true } : {}), ...(missing ? { missing: true } : {}) };
    emitEvent({ type: 'supervisor.halted', agent: 'supervisor', to: 'human', status: 'blocked', msg: `Supervisor stopped starting agents: ${state.halted.why}. A halt stops new sessions only: the train daemon still lands lanes already queued.`, meta: { code, tool, scope: 'builders', causes, sameDeathSec: sameDeathSec() } });
    // 2.65.0: a halt whose cause is on the self-triage list (harness/self-triage.json: the tool isn't on PATH and another
    // tool is) is fixed and cleared as studio:resume would, by "self-triage"; the next pass resumes. Unknown causes,
    // and a cause already fixed once in the window, wait for a person as before.
    if (!opts.dryRun) {
      try {
        const { triageHalt } = await import('./self-triage.mjs');
        const t = await triageHalt(state.halted, { now });
        if (t.fixed) state.halted.selfTriage = t.why;
      } catch { /* the halt stands */ }
    }
    return true;
  }
  return false;
}

/** 2.73.1 (B-66): ends the launcher caused itself (exitCause kinds), never a sign the tool is broken. */
const LAUNCHER_KILLS = new Set(['stall', 'idle', 'budget', 'stopped']);
export const sameDeathSec = (env = process.env) => { const v = String(env.STUDIO_HALT_SAME_DEATH_SEC ?? '').trim(); const n = Number(v); return v !== '' && Number.isFinite(n) && n >= 0 ? n : 5; };
/**
 * 2.73.1 (B-66): session ends (in order) grouped so that ends within STUDIO_HALT_SAME_DEATH_SEC of the group's first are
 * one group: [[end, …], …]. The time is when the process exited (meta.exitCause.at), else the event's. 0 = no grouping.
 * Only ends that record how long the process ran (meta.exitCause.ranSec) and had run at least SAME_DEATH_MIN_RUN_SEC
 * (60) are merged: sessions that crash at launch, together or one after another, are each evidence the tool is broken.
 * Nor is an exit that says the tool itself can't run (127 or 9009: not found; 126: not executable).
 */
const TOOL_MISSING = new Set([126, 127, 9009]);
const SAME_DEATH_MIN_RUN_SEC = 60;
const mergeable = (e) => !TOOL_MISSING.has(Number(e.meta?.code)) && Number(e.meta?.exitCause?.ranSec) >= SAME_DEATH_MIN_RUN_SEC;
export function groupSameDeaths(ends, env = process.env) {
  const win = sameDeathSec(env) * 1000;
  const at = (e) => { const t = Date.parse(e.meta?.exitCause?.at || ''); return Number.isFinite(t) ? t : Date.parse(e.ts); };
  const out = [];
  for (const e of ends) {
    const g = out[out.length - 1];
    if (g && win > 0 && mergeable(e) && mergeable(g[0]) && Math.abs(at(e) - at(g[0])) <= win) g.push(e);
    else out.push([e]);
  }
  return out;
}

/** One pass: what to start now, and why nothing else. Pure decision + the starts; the loop calls it. */
/** 2.77.2 (B-107): the running session of the same role whose lane clashes with group g's, or undefined. A session whose
 * agent has exited (its launcher is handing the work back) works on nothing and clashes with nothing. */
export function laneClashWith(sameRole, g, clashes) {
  return (sameRole || []).find((s) => !s.ending && !s.agentExited && clashes(s.lane || null, g.lane || null, s, g));
}

/**
 * 2.78.1 (B-123): the lane a running session works in now. A session's lane was fixed when it was launched, so a
 * `task lane <ID> …` on its task (a person, the orchestrator or the Producer scoping it later) never reached the
 * supervisor: a builder launched with no lane kept "working on the whole game" until it ended. The board's `task lane`
 * record (studio/task-holds.json "lane") wins; else the lane it was launched with.
 */
export function currentLane(s, holds = {}) {
  const h = s?.task ? holds[s.task] : null;
  if (h && 'lane' in h) return h.lane || null;
  return s?.lane || null;
}

export async function supervise(opts, state, now = Date.now()) {
  const { parseNextQueue, readStop } = await import('./task.mjs');
  if (!opts.watcher) {
    const floorsConfig = readJson(path.join(REPO_ROOT, 'studio', 'floors.json'));
    if (floorsConfig?.autoOpen) {
      const { tick: tickFloors } = await import('./floors.mjs');
      await tickFloors({ by: 'supervisor', silent: true });
    }
  }
  // The watcher passes the launcher's functions in: agent.mjs run as a command can't import itself again.
  const { sessions, startAgent, launchableRoles, nextAgentName } = opts.deps || (await import('./agent.mjs'));
  const { holdReason, laneOf, lanesClash, laneList } = await import('./task-hold.mjs');
  const { effectiveMode } = await import('./mode.mjs');
  const { budgetStatus, pickTool, quotaMark, probeTool, exhaustedUntil, customKey } = await import('./budget.mjs');
  const { status: lockStatus } = await import('./lock.mjs');
  const why = [];
  // opts.watcher: the watcher's auto-launch uses this same picker when no supervisor runs (one launcher).
  if (!opts.watcher && fs.existsSync(STOP_FILE)) return { stop: true, started: [], why: ['studio:stop was asked'] };
  // 2.73.1: `npm run studio:extend` moved the end time (before the time-is-up check, so a late extend still counts).
  if (!opts.watcher) { try { applyExtend(opts, state, now); } catch { /* the old end time stands */ } }
  // 2.71.0 (y): the owner's reports to a webhook (harness/report-post.mjs): the digest once a day at STUDIO_REPORT_HOUR,
  // the what's-next board when the queue changed a lot; before the halt and window checks, so a halted studio still reports.
  if (!opts.watcher) {
    try {
      const rp = await (await import('./report-post.mjs')).reportPass({ now, inline: Boolean(opts.deps?.reportInline), deps: opts.deps?.reportDeps || {} });
      if (rp?.line) console.log(`[supervisor] ${rp.line}`);
    } catch { /* a report, never a crash */ }
  }
  if (opts.until && now >= opts.until) {
    if (!state.halted) { try { await checkBadEnds(opts, state, now); } catch { /* the stop stands */ } }
    return { stop: true, started: [], why: [`the time is up (${new Date(opts.until).toTimeString().slice(0, 5)})`] };
  }
  if (readStop()) return { started: [], why: ['"Stop all agents" is on in the War Room'] };
  if (opts.window && !inWindow(opts.window, now)) return { started: [], why: [`outside the window ${opts.window}`] };
  // Two sessions in a row ending the same bad way (exit 127: the tool isn't on PATH) means starting
  // more won't help: stop starting, and ask a person once (Needs you). "Try again" clears it.
  if (fs.existsSync(RESUME)) {
    // Who asked: the War Room writes the person's name; `npm run studio:resume` (2.59.0, #15) writes { by, why }.
    const asked = readResume();
    fs.rmSync(RESUME, { force: true });
    if (state.halted) emitEvent({ type: 'supervisor.resumed', agent: 'supervisor', to: 'producer', msg: `Supervisor starting agents again${asked.by ? ` (${asked.by} asked${asked.why ? `: ${asked.why}` : ''})` : ''}`, meta: { by: asked.by || null, why: asked.why || null, via: asked.via || null, cleared: state.halted.why || null } });
    state.halted = null;
    state.haltCheckFrom = now;
  }
  if (state.halted) return { started: [], why: [`halted: ${state.halted.why}`] };
  if (await checkBadEnds(opts, state, now)) return { started: [], why: [`halted: ${state.halted.why}`] };
  // 2.68.0: the futility cap (harness/futility.mjs): a running session past the p90 of its type's good runs raises a
  // Check (shadow mode by default; STUDIO_FUTILITY=on hands it back, its diff kept).
  if (!opts.watcher) {
    try {
      const { futilityPass } = await import('./futility.mjs');
      futilityPass({ sessions: sessions(), events: readRecentEvents(20000), now, dryRun: opts.dryRun, pause: opts.deps?.pauseAgent || (await import('./agent.mjs')).pauseAgent });
    } catch { /* a check, never a crash */ }
    // 2.69.0 (p): the nightly slow tier (harness/slow-tier.mjs): once a day from STUDIO_SLOW_HOUR (3), detached, on main.
    try {
      const { mainRoot: slowRoot } = await import('./worktree.mjs');
      const sl = await (opts.deps?.slowTierPass || (await import('./slow-tier.mjs')).slowTierPass)({ root: slowRoot(), now, dryRun: opts.dryRun });
      if (sl?.started) console.log(`[supervisor] started the nightly slow tier (${sl.why}); output .studio/slow-tier.log`);
    } catch { /* the slow tier never blocks the supervisor */ }
  }
  // Budget: tokens since the supervisor started, or a share of the plan's week (studio/budget.json).
  const st = budgetStatus(now);
  let poolUsage = null; // set when the plan's budget is high (2.79 f)
  // 2.79 (f): STUDIO_API_POOL builders (harness/api-pool.mjs) start while the plan's budget is high: the two places this pass
  // would start nothing (the wind-down above, every tool over its target below) let the pool's builders through instead.
  const apiPoolOn = (usage) => { try { return Boolean(process.env.STUDIO_API_POOL) && poolPlanNow(usage, sessions().filter((s) => s.running)).free.length > 0; } catch { return false; } };
  // 2.68.0: usage wind-down (harness/winddown.mjs): at STUDIO_USAGE_WINDDOWN_PCT start nothing new, let the running
  // sessions finish, write .studio/restart-log.md; resume (and link the log) when the usage resets.
  try {
    const { winddownPass } = await import('./winddown.mjs');
    const { readHolds } = await import('./task-hold.mjs');
    const wd = winddownPass({ now, rows: st, dryRun: opts.dryRun, lists: () => ({ live: sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, role: s.role, task: s.task })), queued: (parseNextQueue().backlog || []).map((t) => ({ id: t.id, role: t.role, title: t.title })), held: Object.entries(readHolds()).filter(([, h]) => h?.held).map(([id, h]) => ({ id, why: h.held.why || 'held' })) }) });
    if (wd.active) { poolUsage = { winddown: true, why: wd.why }; if (!apiPoolOn(poolUsage)) return { started: [], why: [wd.why], winddown: true }; }
  } catch { /* the wind-down is a guard, never a crash */ }
  const { weightedTokens } = await import('./budget.mjs');
  const spentHere = Math.round(readRecentEvents(50000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= state.startedAt).reduce((n, e) => n + weightedTokens(e), 0));
  state.tokens = spentHere;
  if (opts.budget?.tokens && spentHere >= opts.budget.tokens) return { stop: true, started: [], why: [`the budget is spent (${spentHere.toLocaleString()} of ${opts.budget.tokens.toLocaleString()} tokens)`] };
  const known = st.filter((t) => t.weekly);
  if (opts.budget?.share && known.length && known.every((t) => t.pct >= opts.budget.share)) return { stop: true, started: [], why: [`the plan reached ${Math.round(opts.budget.share * 100)}% of the week`] };
  const over = known.length && known.every((t) => t.verdict === 'over');
  const under = known.some((t) => t.verdict === 'under');
  if (over) { poolUsage ||= { over: true, why: 'every tool is over its target for this point in the week' }; if (!apiPoolOn(poolUsage)) return { started: [], why: ['every tool is over its target for this point in the week: slowing down'] }; }
  const mode = effectiveMode();
  const extra = opts.budget && under ? 2 : 0;
  const live = sessions().filter((s) => s.running);
  const configured = Math.min(12, mode.maxAgents + extra);
  // 2.68.0 (n): the session cap by RAM (harness/heavy-budget.mjs sessionCap): the RAM budget less the heavy jobs' claims,
  // STUDIO_SESSION_RAM_GB (0.6) a session; no machine scan: the pace's cap as before.
  const ramCap = await sessionCapNow(configured);
  // 2.69.0 (s): the queue-depth target (harness/queue-depth.mjs): fewer startable builder tasks than STUDIO_QUEUE_DEPTH
  // (default this cap) asks the Producer, naming the areas chains and holds block. It never adds a task.
  if (!opts.watcher) {
    try {
      const { queueDepthPass } = await import('./queue-depth.mjs');
      const { listLocks } = await import('./lock.mjs');
      const { unmerged } = await import('./worktree.mjs');
      const qd = await queueDepthPass({ q: parseNextQueue(), cap: ramCap.cap, now, dryRun: opts.dryRun, deps: { locks: listLocks(), unmerged, locked: (id) => lockStatus(`task:${id}`).locked, ...(opts.deps?.wake ? { wake: opts.deps.wake } : {}) } });
      if (qd.asked) why.push(`queue below its depth target (${qd.ready.length} ready, target ${qd.target}): the Producer was asked`);
    } catch { /* a nudge, never a crash */ }
  }
  // 2.69.0 (s): the upgrade watch (harness/upgrade-watch.mjs), every STUDIO_UPGRADE_WATCH_MIN (60) minutes.
  if (!opts.watcher) {
    try {
      const uw = await import('./upgrade-watch.mjs');
      const w = await uw.supervisorWatch({ now, dryRun: opts.dryRun });
      if (w?.line) why.push(w.line);
    } catch { /* a watch, never a crash */ }
  }
  // 2.73.0 (f): the weekly harness scout (harness/harness-scout.mjs): one research task on STUDIO_SCOUT_DAY, off by
  // default (STUDIO_HARNESS_SCOUT=on, the owner's).
  if (!opts.watcher) {
    try {
      const sc = await (await import('./harness-scout.mjs')).scoutPass({ now, dryRun: opts.dryRun, deps: opts.deps?.scoutDeps || {} });
      if (sc?.line) why.push(sc.line);
    } catch { /* paperwork, never a crash */ }
  }
  // 2.70.0 (w): the janitor's stale-lane proposals (a dry run, never deletes) and the lane disk report, at most every
  // STUDIO_JANITOR_LANES_MIN (360) minutes, in a detached child (harness/lane-disk.mjs).
  if (!opts.watcher) {
    try { await (await import('./lane-disk.mjs')).lanesPass({ now, inline: Boolean(opts.deps?.lanesInline) }); } catch { /* a report, never a crash */ }
  }
  let room = ramCap.cap - live.length;
  // 2.79 (f): the plan's budget is high: only the API pool's builders start (their names, up to the pool's size).
  const poolMode = poolUsage ? poolPlanNow(poolUsage, live) : null;
  if (poolMode) { room = Math.min(room, poolMode.free.length); why.push(`${poolUsage.why}: ${poolMode.why}`); }
  if (room <= 0) return { started: [], why: [ramCap.cap < configured ? `${live.length} agent${live.length === 1 ? '' : 's'} running; no more start: ${ramCap.why}` : `${live.length} agents running, the cap (${mode.label}${extra ? ' + 2 for the budget' : ''})`] };
  if (ramCap.cap < configured) why.push(`at most ${ramCap.cap} session${ramCap.cap === 1 ? '' : 's'} now: ${ramCap.why}`);
  // Waiting work, grouped by role and lane.
  const q = parseNextQueue();
  const held = [];
  // 2.58.3 (N2): a task handed back because its claim ran out while its owner (an agent working outside the
  // launcher) is still active is that owner's, not a new agent's (harness/busy.mjs claimActive).
  const { claimActive } = await import('./busy.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  let claimEvents = null;
  const waiting = q.backlog.filter((t) => {
    if (!t.role || t.role === 'human' || lockStatus(`task:${t.id}`).locked) return false;
    let h = holdReason(t.id, q, now, undefined, t.role);
    if (!h) {
      const a = claimActive(t.id, { root: mainRoot(), now, events: (claimEvents ||= readRecentEvents(20000)), orphaned: true });
      if (a.busy) h = `waits for ${a.owner}: ${a.why}`;
    }
    if (h) held.push(`${t.id} ${h}`);
    return !h;
  });
  if (held.length) why.push(`held: ${held.slice(0, 4).join('; ')}${held.length > 4 ? ` (+${held.length - 4})` : ''}`);
  const evs = readRecentEvents(20000);
  // 2.78.1 (B-123): running sessions work in their task's lane as the board says it now (task lane after launch).
  try { const hl = (await import('./task-hold.mjs')).readHolds(); for (const s of live) s.lane = currentLane(s, hl); } catch { /* the launch lanes stand */ }
  // 2.78.1 (B-123, 3): builders with no lane side by side when both have a prediction and they don't overlap
  // (harness/lane-plan.mjs; STUDIO_UNSCOPED_PARALLEL=off: the old rule, no lane = the whole game).
  let lanePlan = null;
  let predict = null;
  try { lanePlan = await import('./lane-plan.mjs'); if (lanePlan.unscopedParallelOn()) predict = lanePlan.predictor(evs); } catch { lanePlan = null; }
  const groups = new Map();
  const floorsConfig = readJson(path.join(REPO_ROOT, 'studio', 'floors.json'));
  const gameCartridge = readJson(path.join(REPO_ROOT, 'studio', 'game.json'))?.cartridge ?? readJson(path.join(REPO_ROOT, 'studio', 'gates.json'))?.cartridge;
  const { taskType } = await import('./done-check.mjs');

  // 2.78.0 (PU-63): a task whose start was refused for the same reason as last time waits out a doubling backoff.
  const sigOf = (id) => taskStateSig(evs, id, lockStatus(`task:${id}`).locked);
  if (!state.startBackoff) { const f = readJson(START_BACKOFF_FILE, {}) || {}; state.startBackoff = f.tasks || {}; state.startBackoffSeen ??= f.seen; }
  try { ingestRefusals(state, evs, sigOf, now); } catch { /* a backoff is a courtesy, never a crash */ }
  const backedOff = [];
  const saveBackoff = () => { if (opts.dryRun) return; try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(START_BACKOFF_FILE, `${JSON.stringify({ seen: state.startBackoffSeen, tasks: state.startBackoff }, null, 2)}\n`); } catch { /* best effort */ } };

  for (const t of waiting) {
    const bo = startBackedOff(state, t.id, sigOf(t.id), now);
    if (bo) {
      if (!bo.said) { bo.said = true; backedOff.push(`${t.id} (refused ${bo.count}x for the same reason; skipped for ${Math.max(1, Math.round((bo.until - now) / 60000))} min)`); }
      continue;
    }
    // Lanes always count now: a task's own lane, `task lane`, or its --part (harness/task-hold.mjs).
    let lane = laneOf(t.id, evs) || null;
    if (!lane && floorsConfig && gameCartridge && ['change', 'system'].includes(taskType(t))) {
      const meta = evs.find((e) => e.task === t.id && e.type === 'task.added')?.meta;
      if (meta?.phase) {
        lane = `cartridges/${gameCartridge}/floors/phase-${meta.phase}`;
      }
    }
    // 2.78.1 (B-123, 3): a laneless task with a prediction is its own group, so two of them can start in one pass.
    const own = !lane && predict && predict(t.id).length ? `|pred:${t.id}` : '';
    const key = `${t.role}|${lane || ''}${own}`;
    if (!groups.has(key)) groups.set(key, { role: t.role, lane, tasks: [] });
    groups.get(key).tasks.push(t);
  }
  if (backedOff.length) why.push(`start backoff: ${backedOff.slice(0, 4).join('; ')}${backedOff.length > 4 ? ` (+${backedOff.length - 4})` : ''}`);
  saveBackoff();
  // 2.30c (#12): skip a task whose prerequisite isn't merged yet or whose folder another agent holds,
  // and try the next one in its group; mark it "waiting on X" for the War Room.
  const { handoutBlock, writeWaiting } = await import('./handout.mjs');
  const { listLocks } = await import('./lock.mjs');
  const { unmerged } = await import('./worktree.mjs');
  const locksNow = listLocks();
  const waitingOn = {};
  for (const g of groups.values()) {
    g.tasks = g.tasks.filter((t) => {
      const b = handoutBlock(t.id, q, { locks: locksNow, unmerged, lane: g.lane });
      if (b) waitingOn[t.id] = b;
      return !b;
    });
  }
  for (const [k, g] of [...groups.entries()]) if (!g.tasks.length) groups.delete(k);
  if (Object.keys(waitingOn).length) why.push(`waiting: ${Object.entries(waitingOn).slice(0, 4).map(([id, b]) => `${id} ${b.why}`).join('; ')}`);
  if (!opts.dryRun) writeWaiting(waitingOn);
  const canStart = new Set(launchableRoles([...new Set(waiting.map((t) => t.role))]));
  // 2.68.0: the crew watchdog (harness/crew-watch.mjs): a role with more than STUDIO_CREW_MAX_SESSIONS sessions in the
  // last hour and nothing landed isn't launched until the cause clears or someone resumes it (npm run crew -- resume).
  let crewPaused = {};
  if (!opts.watcher) {
    try {
      const byRole = {};
      for (const t of waiting) (byRole[t.role] ||= []).push(t.id);
      crewPaused = (await import('./crew-watch.mjs')).crewPass({ events: evs, now, waitingByRole: byRole, dryRun: opts.dryRun }).paused || {};
    } catch { crewPaused = {}; }
  }
  const started = [];
  let ram = null;
  // Most urgent first; the dev hacker only gets a slot nobody else needs (it never holds anything up).
  let ordered = [...groups.values()].sort((a, b) => (a.role === 'dev-hacker') - (b.role === 'dev-hacker') || String(a.tasks[0].priority).localeCompare(String(b.tasks[0].priority)));
  // 2.76.0 (k): the Line Producer's plan (harness/line-producer.mjs, STUDIO_LINE_PRODUCER): its order, model routes and
  // the rig's builder cap. Within the pace's caps only: it reorders and can hold builders back, never adds one.
  const line = await linePlanNow(now);
  if (line) ordered = line.orderGroups(ordered);
  for (const g of ordered) {
    if (room <= 0) break;
    if (poolMode && g.role !== 'builder') continue; // the pool is builders only; other roles wait for headroom
    if (crewPaused[g.role]) {
      why.push(`${g.role}: paused by the crew watchdog (${String(crewPaused[g.role].why || '').slice(0, 120)}; npm run crew -- resume ${g.role} --by <name>)`);
      continue;
    }
    if (!canStart.has(g.role)) {
      why.push(`${g.role}: no tool set to start it (STUDIO_AGENT_TOOL or STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL)`);
      continue;
    }
    // Builders (and any role whose work has a lane) never share files: a builder with no lane holds
    // the whole game, so nothing else in that role runs beside it, and two lanes must not overlap.
    const sameRole = live.filter((s) => s.role === g.role);
    const codeRole = g.role === 'builder' || Boolean(g.lane) || sameRole.some((s) => s.lane);
    if (codeRole) {
      // 2.77.2 (B-107): a session whose agent has already exited (its launcher is handing its work back) is working on
      // nothing: it no longer holds the whole game, so it doesn't stop every other builder from starting.
      const clash = laneClashWith(sameRole, g, predict && lanePlan ? (a, b, s, gg) => lanePlan.clashWithPredictions({ sLane: a, gLane: b, sTask: s?.task || null, gTask: gg?.tasks?.[0]?.id || null, clashes: lanesClash, predict }) : lanesClash);
      if (clash) {
        if (sameRole.length) why.push(`${g.role}${g.lane ? ` in ${g.lane}` : ''}: ${clash.agent} is working ${clash.lane ? `in ${clash.lane}` : 'on the whole game (no lane)'}`);
        continue;
      }
    }
    const lineHold = line ? line.holdFor(g, live) || (line.holdTask ? line.holdTask(g) : '') : '';
    if (lineHold) { why.push(lineHold); continue; }
    const perRole = (mode.perRole || {})[g.role] ?? 1;
    // One agent per lane (the clash check above); without a lane, the pace's per-role cap.
    if (!g.lane && sameRole.length >= perRole + (extra ? 1 : 0)) continue;
    const heldPath = g.lane ? laneList(g.lane).find((p) => lockStatus(`path:${p}`).locked) : null;
    if (heldPath) {
      why.push(`lane ${heldPath} is held by ${lockStatus(`path:${heldPath}`).lock.owner}`);
      continue;
    }
    // 2.30c (#11): the Producer starts on events only, at most every 15 min unless urgent, backing off when quiet.
    if (g.role === 'producer') {
      const { producerWake } = await import('./producer-wake.mjs');
      const w = producerWake({ now, queue: q, commit: true });
      if (!w.wake) {
        why.push(`producer: ${w.why}`);
        continue;
      }
    }
    const preferred = process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
    // 2.30o: when the tools in the budget order carry their own launch commands (STUDIO_TOOL_<TOOL>_CMD), the
    // order decides (a quota error or spend guard hands over); a role command only applies otherwise.
    const { toolCmd } = await import('./spend-guard.mjs');
    const orderCmds = [preferred, ...((await import('./budget.mjs')).readBudget().order || [])].some((t) => toolCmd(t));
    const custom = orderCmds ? undefined : process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CMD`];
    // Before believing a mark older than 10 minutes, ask the tool once (one tiny call, at most every
    // 10 minutes per tool). Test #2: a wrong mark idled the studio; the provider never said "limit".
    const mark = !custom && !opts.watcher ? quotaMark(preferred) : null;
    if (mark && Date.parse(mark.until) > now && now - Date.parse(mark.at) > 10 * 60000 && !/^(off|0|false|no)$/i.test(process.env.STUDIO_QUOTA_PROBE || '') && now - ((state.probed || {})[preferred] || 0) > 10 * 60000) {
      state.probed = { ...(state.probed || {}), [preferred]: now };
      why.push(`asked ${preferred} whether it is really out: ${probeTool(preferred).why}`);
    }
    const tool = custom ? undefined : pickTool(preferred, now);
    // PU-19: a role run by its own command (STUDIO_<ROLE>_CMD) whose limit line named no tool is marked for that command: wait
    // for that reset too. 2.58.0 (PU-40): the mark is per program (custom:<program>), so another command isn't held by it.
    const customOut = custom ? exhaustedUntil(customKey(custom) || 'custom', now) : null;
    if (customOut) {
      why.push(`${g.role}: its command is out of quota until ${customOut} (npm run budget)`);
      continue;
    }
    if (!custom && !tool) {
      why.push(`${g.role}: every tool is out of quota (npm run budget)`);
      continue;
    }
    // 2.59.0 (#11c): no new agent while free memory is under the floor (a Unity editor and browser playtests beside a
    // full verify took a PC to 2.6 GB free). Running agents are never stopped; the next pass looks again.
    ram ||= ramCheck(opts);
    if (ram.low) {
      why.push(ram.why);
      ramNote(ram, now);
      break;
    }
    const agent = poolMode ? poolMode.free.shift() : nextAgentName(g.role, opts.prefix || 's');
    if (!agent) break;
    state.names = [...(state.names || []), agent].slice(-200);
    // 2.30l: one builder per task. Two passes at once (the watcher and the Director flow) both started
    // T-025 at 17:13:02. A launch lock (one atomic file per task) and the live sessions decide who starts it.
    const taskId = g.tasks[0].id;
    if (live.some((s) => s.running !== false && s.task === taskId) || lockStatus(`task:${taskId}`).locked) {
      why.push(`${taskId} already has an agent`);
      continue;
    }
    const { claim: claimLaunch } = await import('./lock.mjs');
    const launch = claimLaunch(`launch:${taskId}`, agent, Number(process.env.STUDIO_LAUNCH_LOCK_SEC || 120));
    if (launch && launch.ok === false) {
      why.push(`${taskId} is being started by ${launch.lock?.owner || 'another pass'}`);
      continue;
    }
    const lr = line ? line.routeFor(g, { tool, preferred, custom, live, outUntil: (await import('./budget.mjs')).exhaustedUntil }) : {};
    const r = startAgent({ role: g.role, agent, tool: lr.tool || tool, task: g.tasks[0].id, lane: g.lane, oneTask: true, extra, ...(lr.model ? { model: lr.model } : {}) }, { detach: true });
    if (r.ok && lr.model) emitEvent({ type: 'model.routed', agent: 'line-producer', task: taskId, msg: `${taskId}: starts on ${lr.model}${lr.tool ? ` (${lr.tool})` : ''} (${lr.tier} ${lr.tool ? 'task' : 'tier'}, the Line Producer): ${lr.why}`.slice(0, 400), meta: { task: taskId, arm: 'line-producer', tier: lr.tier, model: lr.model, ...(lr.tool ? { tool: lr.tool } : {}), failed: lr.failed || 0 } });
    if (r.ok) {
      if (poolMode) emitEvent({ type: 'supervisor.api_pool', agent: 'supervisor', task: taskId, msg: `${agent} starts on ${taskId} billed to its API key: ${poolUsage.why}`, meta: { agent, reason: poolUsage.over ? 'over-target' : 'winddown' } });
      started.push(`${agent} on ${g.tasks[0].id}${g.lane ? ` in ${g.lane}` : ''}${tool && tool !== preferred ? ` (${tool}: ${preferred} is out of quota)` : ''}`);
      // Count it at once, so the next group in this pass sees it (a lane taken, or the whole game).
      live.push({ agent, role: g.role, lane: g.lane || null, task: taskId, running: true });
      if (g.role === 'producer') (await import('./producer-wake.mjs')).producerLaunched(now);
      room -= 1;
    } else {
      why.push(`${g.role}: ${r.message}`);
      try { noteStartRefusal(state, taskId, `start_agent ${r.message}`, sigOf(taskId), now); saveBackoff(); } catch { /* best effort */ }
    }
  }
  if (!groups.size) why.push('no waiting tasks for agents');
  return { started, why };
}

/**
 * 2.69.0 (r): one train-daemon pass for the supervisor loop: what it decided goes in state.train (studio:status).
 * A wind-down (supervise's result), "Stop all" and drain keep it from starting a train. 2.73.1 (B-66): the supervisor's
 * own halt (scope 'builders') stops new sessions only; a train for lanes already queued still starts. Never throws.
 */
export async function trainDaemonTick(state, r = {}, opts = {}) {
  try {
    const { trainDaemonPass } = await import('./train-daemon.mjs');
    const d = await trainDaemonPass({ halted: state.halted || null, ...(r.winddown ? { winddown: r.why?.[0] || 'winding down' } : {}), ...opts });
    state.train = { at: new Date().toISOString(), started: Boolean(d.started), why: d.why, ...(d.pid ? { pid: d.pid } : {}) };
    return d;
  } catch (err) { state.train = { at: new Date().toISOString(), started: false, why: `error: ${err.message}` }; return { started: false, why: err.message }; }
}

/**
 * 2.76.0 (k): the Line Producer's plan for this pass, or null (off, report, stale, unreadable). orderGroups(groups) sorts
 * by its order; routeFor(group, …) gives { model, tier, why } for the group's first task (only on the preferred tool,
 * never for a custom command) holdFor(group, live) says why a builder waits when the rig's builder cap is reached. Never throws.
 */
async function linePlanNow(now) {
  try {
    const lp = await import('./line-producer.mjs');
    const plan = lp.supervisorPlan({ now });
    if (!plan) return null;
    return {
      orderGroups: (groups) => lp.orderGroups(groups, plan),
      // 2.77.0 (u, P5.1): an engine pass's session (engine-porter) counts against the rig's cap with the builders.
      holdFor: (g, live) => (g.role === 'builder' && plan.rigCap !== null && live.filter((s) => s.role === 'builder' && s.running !== false).length >= plan.rigCap ? `builder: the Line Producer holds new builders (the rig can carry ${plan.rigCap} now: ${String(plan.rigWhy).slice(0, 160)})` : g.role === 'engine-porter' && plan.rigCap !== null && live.filter((s) => (s.role === 'builder' || s.role === 'engine-porter') && s.running !== false).length >= plan.rigCap ? `engine-porter: the Line Producer holds new engine passes (the rig can carry ${plan.rigCap} sessions now: ${String(plan.rigWhy).slice(0, 160)})` : ''),
      routeFor: (g, { tool, preferred, custom, outUntil }) => {
        const id = g.tasks[0]?.id;
        const r = plan.routes[id];
        if (!r?.model || custom) return {};
        // 2.77.0 (n): a model-pool route names its tool too (agy for Gemini, claude for Claude): it is taken unless that
        // tool is marked out of quota now (the pool's own limits were weighed when the route was made).
        if (r.tool) return outUntil && (outUntil(r.tool) || outUntil(`${r.tool}:${r.model}`)) ? {} : { tool: r.tool, model: r.model, tier: r.tier, why: r.why };
        if (tool && tool !== preferred) return {};
        return { model: r.model, tier: r.tier, why: r.why };
      },
      // 2.77.0 (n): a task whose protected step the Line Producer routed to an approver waits for that approval.
      holdTask: (g) => (plan.hold && plan.hold.has(g.tasks[0]?.id) ? `${g.tasks[0].id}: ${String(plan.hold.get(g.tasks[0].id)).slice(0, 200)} (the Line Producer holds it until then)` : ''),
    };
  } catch { return null; }
}

/** 2.68.0 (n): the session cap by RAM, { cap, why }; the configured cap when anything fails. */
async function sessionCapNow(configured) {
  try {
    const hb = await import('./heavy-budget.mjs');
    const h = await import('./heavy.mjs');
    const root = await h.heavyRoot();
    return hb.sessionCap({ configured, profile: hb.machineProfile(root), holders: h.heavyHolders(root), root: REPO_ROOT, heavyRoot: root });
  } catch { return { cap: configured, why: '' }; }
}

// 2.59.0 (#11c) ramCheck lives in harness/ram.mjs (2.64.0: heavy.mjs uses it too, and importing this module from
// heavy.mjs made a cycle with this file's top-level await). Re-exported for existing callers.
export { ramCheck } from './ram.mjs';
import { ramCheck } from './ram.mjs';

/** Says so once per pass, as an event at most every STUDIO_RAM_NOTE_MIN (15) minutes while it stays low. */
function ramNote(ram, now) {
  const every = Number(process.env.STUDIO_RAM_NOTE_MIN || 15) * 60000;
  const last = readRecentEvents(2000).filter((e) => e.type === 'supervisor.ram_low').pop();
  if (last && now - Date.parse(last.ts) < every) return;
  emitEvent({ type: 'supervisor.ram_low', agent: 'supervisor', to: 'producer', status: 'warn', msg: `Not starting agents: ${ram.why}`, meta: { freeGb: ram.freeGb, floorGb: ram.floorGb } });
}

/** 2.74.0 (B-70): one keeper pass for the hub (harness/hub-keeper.mjs); returns the hub child to keep. Never throws. */
async function keepHubUp(state, port, child) {
  try {
    const { keepHub } = await import('./hub-keeper.mjs');
    // 2.77.1 (B-102): bounded like every step of a pass; still pending, the pass goes on with the hub child it had.
    return await boundedStep('hub', async () => (await keepHub({ state, port, child, loopMs: LOOP_MS })).child, { state, fallback: child });
  } catch { return child; }
}

async function main(argv) {
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const budgetArg = flag('budget');
  const opts = {
    until: parseUntil(flag('until')),
    window: flag('window'),
    budget: budgetArg ? (/%$/.test(budgetArg) ? { share: Number(budgetArg.slice(0, -1)) / 100 } : { tokens: Number(budgetArg) }) : null,
    lanes: flag('lanes'),
    hub: !argv.includes('--no-hub'),
  };
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const prev = readStatus();
  if (prev?.pid && prev.pid !== process.pid && alive(prev) && prev.status === 'running') {
    console.error(`A supervisor is already running (pid ${prev.pid}). npm run studio:stop first.`);
    process.exit(1);
  }
  fs.rmSync(STOP_FILE, { force: true });
  const { parseNextQueue } = await import('./task.mjs');
  const state = { pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: Date.now(), opts: { ...opts, until: opts.until ? new Date(opts.until).toISOString() : null }, sessions: 0, doneAtStart: parseNextQueue().done.length, hubDown: [] };
  const port = Number(process.env.HUB_PORT || 3847);
  let hub = null;
  const save = (extra = {}) => writeAtomic(STATUS_FILE, `${JSON.stringify({ ...state, ...extra, startedAt: new Date(state.startedAt).toISOString(), lastLoop: new Date().toISOString(), tasksDone: parseNextQueue().done.length - state.doneAtStart }, null, 2)}\n`);
  // 2.79.1: this supervisor's own pid, identity and status go to supervisor.json now, before the first full pass (which can
  // take minutes): studio:status and studio:reload-env right after studio:stop && studio:start read the OLD record
  // otherwise and said "Not running".
  try { save(); } catch { /* the first pass writes it */ }
  emitEvent({ type: 'supervisor.start', agent: 'supervisor', to: 'producer', msg: `Supervisor running${opts.until ? ` until ${new Date(opts.until).toTimeString().slice(0, 5)}` : ''}${opts.window ? `, window ${opts.window}` : ''}${opts.budget ? `, budget ${budgetArg}` : ''}${opts.lanes ? `, lanes ${opts.lanes}` : ''}` });
  console.log(`[supervisor] running (pid ${process.pid}). npm run studio:stop to stop; agents finish their current task.`);
  // 2.29.2: --budget 50% paces against the week's tokens; without --weekly it can never trip.
  if (opts.budget?.share) {
    const { readBudget } = await import('./budget.mjs');
    if (!Object.values(readBudget().tools || {}).some((t) => Number(t.weeklyTokens) > 0)) console.warn(`[supervisor] --budget ${budgetArg} needs a week's tokens to pace against, and none is set: npm run budget -- set claude --weekly <tokens> --reset <day>. Until then only the daily cap applies.`);
  }
  let stopping = false;
  const finish = (why) => {
    if (stopping) return;
    stopping = true;
    state.status = 'stopped';
    state.stopReason = why;
    save();
    const mins = Math.round((Date.now() - state.startedAt) / 60000);
    emitEvent({ type: 'supervisor.stop', agent: 'supervisor', to: 'producer', msg: `Supervisor stopped (${why}) after ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}: ${state.sessions} sessions started, ${parseNextQueue().done.length - state.doneAtStart} tasks done, ${(state.tokens || 0).toLocaleString()} tokens reported` });
    // 2.30c (G6): at --until, a one-page overnight summary (studio/daily/overnight-<date>.md).
    const summary = opts.until ? import('./overnight.mjs').then(({ writeOvernight }) => writeOvernight({ from: state.startedAt })).catch(() => {}) : Promise.resolve();
    summary.finally(() => {
      hub?.kill();
      setTimeout(() => process.exit(0), 300);
    });
  };
  process.on('SIGINT', () => finish('stopped by hand'));
  process.on('SIGTERM', () => finish('stopped by the system'));
  // 2.73.2 (B-74): `npm run studio:reload-env` is answered within seconds; every pass also re-reads .env when it changed.
  const { reloadEnvIfChanged, watchReloadRequests } = await import('./env-reload.mjs');
  watchReloadRequests({ by: 'supervisor' });
  const tick = async () => {
    if (stopping) return;
    reloadEnvIfChanged({ by: 'supervisor', ack: true });
    // 1. The hub: up, or restart it (with backoff) and remember how long it was down and why (2.74.0, harness/hub-keeper.mjs).
    if (opts.hub) hub = await keepHubUp(state, port, hub);
    // 2.76.0 (k): the Line Producer's pass (harness/line-producer.mjs): mechanical unblocks, the order, the routes, the
    // rig's builder cap, .studio/line/status.json; supervise() below follows the plan. Code only, never a crash.
    await boundedStep('line-producer', () => import('./line-producer.mjs').then(({ lineProducerPass }) => lineProducerPass({})), { state }).then((lp) => { if (lp && !lp.off) state.line = { at: lp.at, mode: lp.mode, builders: lp.builders ? { running: lp.builders.running, target: lp.builders.target } : null, blocked: lp.blocked?.length || 0, error: lp.error || undefined }; }).catch(() => {});
    // 2-4. Work.
    const r = await boundedStep('supervise', () => supervise(opts, state), { state, ms: num(process.env.STUDIO_SUPERVISOR_STEP_SEC, 300) * 2000, fallback: () => ({ started: [], why: ['the launch step was still running; see supervisor.step_timeout'] }) }).catch((err) => ({ started: [], why: [`error: ${err.message}`] }));
    state.sessions += r.started.length;
    state.last = { at: new Date().toISOString(), started: r.started, why: r.why.slice(0, 6) };
    if (r.started.length) emitEvent({ type: 'supervisor.started', agent: 'supervisor', to: 'producer', msg: `Started ${r.started.join(', ')}` });
    // 2.30h (2): the Director's flow pass sees what the supervisor couldn't start, and why (no model, no tokens).
    await boundedStep('director-flow', () => import('./director-flow.mjs').then(({ flowPass }) => flowPass({ fill: false, launcherWhy: r.why, throttleMs: 55000 })), { state }).catch(() => {});
    // 2.68.0 (m): the resource monitor: a machine scan every STUDIO_MACHINE_SAMPLE_S into machine.sample (harness/machine.mjs).
    await boundedStep('machine', () => import('./machine.mjs').then(({ sampleMachine }) => sampleMachine({ emit: emitEvent })), { state }).catch(() => {});
    // 2.79 (f): the hourly summaries of the diagnostics counted instead of logged one by one (harness/telemetry.mjs).
    await boundedStep('telemetry', () => import('./telemetry.mjs').then(({ flushTelemetry }) => flushTelemetry({ emit: emitEvent })), { state }).catch(() => {});
    // 2.76.0 (l): the Communicator (harness/communicator.mjs): the 30-minute status post and the alerts that tag who must
    // act. After the machine scan (it reads that scan) and before a stop ends the loop (so a stop file is reported).
    await boundedStep('communicator', () => import('./communicator.mjs').then(({ communicatorPass }) => communicatorPass({ passWhy: r.why })), { state }).catch(() => {});
    // 2.71.0 (z): the self-repair loop's pass (harness/workaround.mjs): hand-edited records, supervisor restarts, killed
    // launchers, harness tasks and their "maybe fixed" marks. Itself throttled to STUDIO_WORKAROUND_SCAN_MIN (10).
    await boundedStep('workaround', () => import('./workaround.mjs').then(({ workaroundPass }) => workaroundPass({})), { state }).catch(() => {});
    // 2.69.0 (r): the train daemon (harness/train-daemon.mjs, STUDIO_TRAIN_AUTO): a train starts, detached, when lanes
    // are ready and the machine has room for a verify; never two at once, never while halted or winding down.
    if (!r.stop) await boundedStep('train-daemon', () => trainDaemonTick(state, r), { state }).catch(() => {});
    // 2.78.1: gate runs whose parent is gone, past STUDIO_ORPHAN_GATE_MIN, are ended with their tree (harness/gate-reaper.mjs;
    // itself throttled to STUDIO_ORPHAN_GATE_SCAN_MIN).
    await boundedStep('gate-reaper', () => import('./gate-reaper.mjs').then(({ reapOrphanGates }) => reapOrphanGates({ log: (m) => console.error(m) })), { state }).then((g) => { if (g && !g.skipped) state.gateReaper = { at: new Date().toISOString(), ended: (g.ended || []).map((e) => e.pid) }; }).catch(() => {});
    state.passes = (state.passes || 0) + 1; // 2.77.1 (B-102): passes finished since the start, in supervisor.json
    save();
    if (r.stop) finish(r.why[0]);
  };
  // 2.77.1 (B-102): the loop is set before the first pass, passes never overlap, and a pass still running after
  // STUDIO_SUPERVISOR_STUCK_MIN (15) is reported once (supervisor.pass_stuck) instead of silently stopping the studio.
  let busySince = 0;
  let stuckSaid = false;
  const loop = async () => {
    if (busySince) {
      const min = (Date.now() - busySince) / 60000;
      if (!stuckSaid && min >= num(process.env.STUDIO_SUPERVISOR_STUCK_MIN, 15)) {
        stuckSaid = true;
        emitEvent({ type: 'supervisor.pass_stuck', agent: 'supervisor', to: 'producer', status: 'warn', msg: `A supervisor pass has run ${Math.round(min)} min (last step: ${state.step || '?'}); the next pass waits for it` });
      }
      return;
    }
    busySince = Date.now();
    try { await tick(); } catch (err) { console.error(`[supervisor] pass failed: ${err?.message || err}`); } finally { busySince = 0; stuckSaid = false; state.step = undefined; }
  };
  // 2.78.0 (PU-63): a self-rescheduling timeout with +-STUDIO_SUPERVISOR_JITTER (0.1) instead of a fixed interval, so
  // several studios or watchers on one PC don't fire in lockstep. The next timer is set when this one fires (before its
  // pass), so a pass that runs long is still seen by the next call (the stuck report) and passes still never overlap.
  const schedule = () => { if (stopping) return; setTimeout(() => { schedule(); loop(); }, jitteredDelay(LOOP_MS)); };
  schedule();
  await loop();
}

/** Start at login: launchd on macOS, systemd --user on Linux, Task Scheduler on Windows. */
/**
 * The node to run at login: the one on this terminal's PATH (run #1: process.execPath was a node bundled
 * inside another app), unless STUDIO_NODE says otherwise.
 */
export function loginNode() {
  if (process.env.STUDIO_NODE) return process.env.STUDIO_NODE;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { windowsHide: true, encoding: 'utf8' });
  const found = (r.stdout || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  return found || process.execPath;
}
const xmlEsc = (a) => String(a).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A launchd plist with this terminal's PATH and HOME, so agents' tools (claude in ~/.local/bin) are found. */
export function launchdPlist({ label, node, args, env = process.env }) {
  const vars = { PATH: env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: env.HOME || os.homedir() };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xmlEsc(label)}</string>\n<key>ProgramArguments</key><array>${[node, ...args].map((a) => `<string>${xmlEsc(a)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict>${Object.entries(vars).map(([k, v]) => `<key>${k}</key><string>${xmlEsc(v)}</string>`).join('')}</dict>\n<key>WorkingDirectory</key><string>${xmlEsc(REPO_ROOT)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>60</integer>\n<key>StandardOutPath</key><string>${xmlEsc(path.join(STUDIO_STATE_DIR, 'supervisor.log'))}</string>\n<key>StandardErrorPath</key><string>${xmlEsc(path.join(STUDIO_STATE_DIR, 'supervisor.log'))}</string>\n</dict></plist>\n`;
}

function install(argv, remove = false) {
  const slug = path.basename(REPO_ROOT).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const args = [path.join(REPO_ROOT, 'harness', 'supervisor.mjs'), ...argv.filter((a) => !['--install', '--uninstall', '--foreground'].includes(a)), '--foreground'];
  const node = loginNode();
  // The agent tool must be findable from the PATH the login job gets; say so now rather than loop on exit 127.
  const tool = process.env.STUDIO_AGENT_TOOL || 'claude';
  const has = spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { windowsHide: true, encoding: 'utf8' });
  const warn = has.status === 0 ? '' : `\nWarning: \`${tool}\` isn't on this terminal's PATH, so the supervisor won't find it either. Run this from a terminal where \`${tool} --version\` works.`;
  if (process.platform === 'darwin') {
    const label = `com.studio.${slug}`;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (remove) {
      spawnSync('launchctl', ['unload', '-w', plist], { windowsHide: true });
      fs.rmSync(plist, { force: true });
      return `Removed ${plist}`;
    }
    const xml = launchdPlist({ label, node, args });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    spawnSync('launchctl', ['unload', '-w', plist], { windowsHide: true });
    fs.writeFileSync(plist, xml);
    spawnSync('launchctl', ['load', '-w', plist], { windowsHide: true });
    return `Installed ${plist} (node ${node}, this terminal's PATH and HOME): the supervisor starts at login and after a restart. Remove: npm run studio:start -- --uninstall${warn}`;
  }
  if (process.platform === 'win32') {
    const name = `Studio ${slug}`;
    if (remove) {
      spawnSync('schtasks', ['/Delete', '/F', '/TN', name], { windowsHide: true });
      return `Removed the scheduled task "${name}"`;
    }
    const cmd = [node, ...args].map((a) => `"${a}"`).join(' ');
    const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', name, '/TR', cmd], { windowsHide: true, encoding: 'utf8' });
    return r.status === 0 ? `Installed the scheduled task "${name}": the supervisor starts when you log in. Remove: npm run studio:start -- --uninstall${warn}` : `Task Scheduler said: ${r.stderr || r.stdout}`;
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `studio-${slug}.service`);
  if (remove) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `studio-${slug}.service`], { windowsHide: true });
    fs.rmSync(unit, { force: true });
    return `Removed ${unit}`;
  }
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, `[Unit]\nDescription=Game studio supervisor (${slug})\n\n[Service]\nWorkingDirectory=${REPO_ROOT}\nEnvironment="PATH=${process.env.PATH || ''}" "HOME=${process.env.HOME || os.homedir()}"\nExecStart=${[node, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n`);
  spawnSync('systemctl', ['--user', 'daemon-reload'], { windowsHide: true });
  spawnSync('systemctl', ['--user', 'enable', '--now', `studio-${slug}.service`], { windowsHide: true });
  return `Installed ${unit} (systemd --user, this terminal's PATH): the supervisor starts at login. Keep it running while logged out: loginctl enable-linger $USER. Remove: npm run studio:start -- --uninstall${warn}`;
}

// 2.77.1 (B-102): the CLI runs in an async function, never as a top-level await. With main() awaited at the top level,
// any pass that imports this file back (the Communicator's needs-a-person list, self-triage, the digest read
// readStatus from here) waited for this module to finish loading, which waited for the pass: Node exited with code 13
// ("unsettled top-level await") after the first pass on the crew's PC.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) (async () => {
  const argv = process.argv.slice(2);
  // 2.67.0 (B-47): --help / -h prints usage and never starts, stops or resumes anything.
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(['Usage:',
      '  npm run studio:start [-- --until 23:00 | --until 8h] [--window 09:00-23:00] [--budget 50% | --budget 3000000]',
      '  npm run studio:start -- --install | --uninstall      start it at login, or stop doing so',
      '  npm run studio:stop                                  stop the supervisor (agents finish their task)',
      '  npm run studio:status',
      '  npm run studio:resume -- --by <your name> [--why "…"]   clear a halt',
      '  npm run studio:extend -- --until <23:00 | +8h | ISO time | none> --by <your name> [--why "…"]   move a running supervisor\'s end time'].join('\n'));
    process.exit(0);
  }
  if (argv[0] === 'stop') {
    const markStopped = (rec, why) => { try { writeAtomic(STATUS_FILE, `${JSON.stringify({ ...rec, status: 'stopped', stopReason: why }, null, 2)}\n`); } catch { /* the stop file still stops it */ } };
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    const s = readStatus();
    // PU-17 (P-039): signal the pid only while it is still the supervisor: its start time, read from the OS once
    // now, against the one in supervisor.json. Unreadable, or a status file from before PU-17: signalled only if
    // its last loop is recent; otherwise the number may be another program's by now. Either way the stop file
    // above stops a real supervisor at its next loop.
    if (s?.pid && s.status === 'running' && !pidExists(s.pid)) markStopped(s, 'studio:stop: its process was already gone');
    if (s?.pid && pidExists(s.pid)) {
      const cur = readStarts([s.pid]).get(Number(s.pid)) || null;
      const same = cur ? sameProcess(s.identity, cur) : null;
      const loopAge = Date.now() - Date.parse(s.lastLoop || s.startedAt || '');
      const fresh = Number.isFinite(loopAge) && loopAge <= Math.max(5 * 60000, 3 * LOOP_MS);
      if (same === true || (same === null && cur && fresh)) {
        try {
          process.kill(s.pid, 'SIGTERM');
        } catch {
          // it will see the stop file
        }
        // 2.79.1: on Windows SIGTERM ends the process outright, so its own "stopped" write never happens: mark it here.
        if (s.status === 'running') markStopped(s, 'studio:stop');
      } else if (cur && s.status === 'running') {
        const why = same === false ? `pid ${s.pid} now belongs to another program${cur.cmd ? ` (${cur.cmd})` : ''}` : `pid ${s.pid} is in use but ${cur.error ? `its start time couldn't be read (${cur.error})` : 'supervisor.json has no start time'} and its last loop was ${Number.isFinite(loopAge) ? Math.round(loopAge / 60000) : '?'} min ago, so the number may be another program's`;
        console.log(`Not signalled: ${why}. ${same === false ? 'The supervisor that wrote supervisor.json is gone.' : 'A supervisor that is still running stops at its next loop.'}`);
        emitEvent({ type: 'agent.pid_reused', agent: 'supervisor', status: 'warn', msg: `studio:stop: ${why}: nothing was killed`, meta: { pid: s.pid, verified: same === false } });
        if (same === false) {
          try {
            fs.writeFileSync(STATUS_FILE, `${JSON.stringify({ ...s, status: 'stopped', stopReason: `its process is gone (${why})` }, null, 2)}\n`);
          } catch {}
        }
      }
    }
    console.log('Supervisor stopping. Agents that are running finish their task; nothing new starts.');
    process.exit(0);
  }
  if (argv[0] === 'resume') {
    const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
    const r = await resumeCli({ by: flag('by'), why: flag('why'), permission: flag('permission') });
    (r.code ? console.error : console.log)(r.text);
    process.exit(r.code);
  }
  if (argv[0] === 'extend') {
    const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
    const r = await extendCli({ until: flag('until'), by: flag('by'), why: flag('why'), permission: flag('permission') });
    (r.code ? console.error : console.log)(r.text);
    process.exit(r.code);
  }
  if (argv[0] === 'status') {
    // 2.76.0 (j, B-87): agent-proposed tasks waiting on the dev's yes, named after the last pass (harness/yes-wait.mjs).
    const yesWaitText = async () => { try { const w = await (await import('./yes-wait.mjs')).readYesWaiting(); return w.count ? `; ${w.line}: npm run task -- yes <id> --by <dev>${w.beta.on ? ` (${w.beta.words})` : ''}` : ''; } catch { return ''; } };
    const s = readStatus();
    // 2.77.0 (p, P9.6): the merge train(s) now: the running one and the speculative one behind it.
    const trainsNow = async () => { try { const ts = await import('./train-status.mjs'); const t = ts.readTrainStatus((await import('./worktree.mjs')).mainRoot()); return t ? `\n${ts.trainsText(t)}` : ''; } catch { return ''; } };
    console.log(s ? `${s.status === 'running' && alive(s) ? 'Running' : 'Not running'} since ${s.startedAt}${s.opts?.until ? ` until ${s.opts.until}` : ''}${s.stopReason ? `; stopped: ${s.stopReason}` : ''}. Sessions started: ${s.sessions}; tasks done: ${s.tasksDone}; tokens: ${(s.tokens || 0).toLocaleString()}. Last pass: ${s.last ? `${s.last.started.join(', ') || 'nothing started'}${s.last.why?.length ? ` (${s.last.why.join('; ')})` : ''}` : 'none'}${await yesWaitText()}${s.hubDown?.length ? `. Hub down: ${s.hubDown.map((d) => `${d.from.slice(11, 16)}-${d.to.slice(11, 16)}`).join(', ')}` : ''}${await import('./hub-keeper.mjs').then((m) => m.hubKeepLine(s), () => '')}${await trainsNow()}` : `The supervisor has not run here yet: npm run studio:start${await trainsNow()}`);
    process.exit(0);
  }
  if (argv.includes('--install') || argv.includes('--uninstall')) {
    console.log(install(argv, argv.includes('--uninstall')));
    process.exit(0);
  }
  // By default it runs on its own, so it outlives the terminal or agent shell that started it
  // (run #1: every agent died when the host shell restarted). --foreground keeps it attached.
  if (!argv.includes('--foreground')) {
    const prev = readStatus();
    if (prev?.pid && alive(prev) && prev.status === 'running') {
      console.error(`A supervisor is already running (pid ${prev.pid}). npm run studio:stop first.`);
      process.exit(1);
    }
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    const log = fs.openSync(path.join(STUDIO_STATE_DIR, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv, '--foreground'], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', log, log], env: process.env, windowsHide: true });
    child.unref();
    console.log(`[supervisor] running on its own (pid ${child.pid}); output in .studio/supervisor.log. npm run studio:status to check, npm run studio:stop to stop.`);
    process.exit(0);
  }
  await main(argv.filter((a) => a !== '--foreground'));
})().catch((err) => { console.error(`[supervisor] ${err?.stack || err}`); process.exit(1); });
