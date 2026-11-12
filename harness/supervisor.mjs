#!/usr/bin/env node
/**
 * harness/supervisor.mjs — keep the studio running without anyone at the keyboard.
 *
 *   npm run studio:start [-- --until 23:00 | --until 8h] [--window 09:00-23:00] [--budget 50% | --budget 3000000]
 *                        [--lanes auto] [--foreground]   (runs on its own unless --foreground; --hub/--no-hub are ignored)
 *   npm run studio:start -- --install [same options]    start it at login (launchd, systemd --user, Task Scheduler)
 *   npm run studio:start -- --uninstall
 *   npm run studio:stop                                  stop the supervisor (agents finish their task)
 *   npm run studio:status
 *   npm run studio:resume -- --by <your name> [--why "…"] [--permission "<the person's words or a link>"]   clear a halt
 *   npm run studio:extend -- --until <time|+8h|none> --by <your name> [--why "…"] [--permission "…"]   move the end time
 *
 * Every minute it stops starting work outside the time window, past --until, past the budget, or while "Stop all" is on;
 * starts one agent per task for each role (and lane) with waiting tasks and no agent, within the pace's caps (with --budget
 * and the plan under its target, studio/budget.json, up to two extra; over it, none); skips a tool that ran out of quota until
 * its reset and uses the next in the budget's order; and halts when two sessions in a row end the same bad way (a cause on the
 * self-triage list, harness/self-triage.mjs: the tool isn't on PATH and another is, is fixed by "self-triage"; any other halt
 * waits for a person: studio:resume or the War Room). Each pass also runs the crew watchdog (harness/crew-watch.mjs), the
 * futility cap (harness/futility.mjs, shadow mode by default), the usage wind-down (harness/winddown.mjs,
 * STUDIO_USAGE_WINDDOWN_PCT) and the train daemon (harness/train-daemon.mjs, STUDIO_TRAIN_AUTO, default on; npm run task --
 * train auto off|on --by). Code only: no model, no tokens.
 * With --lanes auto, tasks that name a lane (task add --lane game/x/src/floors) get one agent per lane, each holding that folder.
 * Status: .studio/supervisor.json, the War Room's Ops view, and the run report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { poolPlan, builderOrder, builderKind } from './api-pool.mjs';
const poolPlanNow = (usage, live) => poolPlan({ usage, live });
import { writeAtomic, readJson } from './fsafe.mjs';
import { selfIdentity, pidAlive, pidExists, readStarts, sameProcess } from './proc-identity.mjs';

export const STATUS_FILE = path.join(STUDIO_STATE_DIR, 'supervisor.json');
const STOP_FILE = path.join(STUDIO_STATE_DIR, 'supervisor-stop');
const LOOP_MS = Number(process.env.STUDIO_SUPERVISOR_SEC || 60) * 1000;
const num = (v, d) => (Number.isFinite(Number(v)) && String(v ?? '').trim() !== '' ? Number(v) : d);
/** One step of a pass, bounded: after `ms` it is reported (supervisor.step_timeout) and the pass goes on with `fallback`; the step itself is not killed. */
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
 * Start backoff. A start of task T refused for the same reason as last time (task.start_refused, task.lock_denied, a
 * launcher refusal) is skipped for 2, 4, 8 ... minutes (capped at STUDIO_START_BACKOFF_MAX_MIN, 30). It resets when the
 * reason or the task's state changes. Kept in state.startBackoff, mirrored to .studio/start-backoff.json across restarts.
 */
export const START_BACKOFF_FILE = path.join(STUDIO_STATE_DIR, 'start-backoff.json');
export const startBackoffMaxMin = (env = process.env) => { const v = num(env.STUDIO_START_BACKOFF_MAX_MIN, 30); return v > 0 ? v : 30; };
/** The wait in ms after `repeats` same-reason refusals (1 -> 2 min, 2 -> 4, ...); 0 for the first. */
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
export function noteStartRefusal(state, task, reason, sig, now = Date.now(), env = process.env, shown = reason) {
  const bo = (state.startBackoff ||= {});
  const key = refusalKey(reason);
  const prev = bo[task];
  const count = prev && prev.reason === key && prev.sig === sig ? prev.count + 1 : 1;
  // `text` is the refusal in its own words (160 chars), for the "skipped" line; the key is lower-cased and number-free, for comparing.
  bo[task] = { reason: key, text: String(shown ?? '').replace(/\s+/g, ' ').trim().slice(0, 160), sig, count, until: now + startBackoffMs(count - 1, env), said: false };
  return bo[task];
}
/** The words for one skipped task. */
export const backoffWords = (task, bo, now = Date.now()) => `${task} (refused ${bo.count}x for the same reason${bo.text ? `: "${bo.text}"` : ''}; skipped for ${Math.max(1, Math.round((bo.until - now) / 60000))} min)`;
/** The live backoff entry for `task`, or null (none, expired, or its state changed). */
export function startBackedOff(state, task, sig, now = Date.now()) {
  const e = state.startBackoff?.[task];
  if (!e) return null;
  if (e.sig !== sig) { delete state.startBackoff[task]; return null; }
  return now < e.until ? e : null;
}
/** A refusal about the crew, not the task (every seat taken, or a budget stop): it clears by itself, so the task is not backed off. */
export const crewWideRefusal = (msg) => /\bagents? ?(\(s\))? already running\b|\bagent\(s\) already running\b|\bbudget stop\b/i.test(String(msg || ''));
const START_REFUSALS = new Set(['task.start_refused', 'task.lock_denied']);
/** Fold the log's refusals since the last look into state.startBackoff. Returns how many it noted. */
export function ingestRefusals(state, events, sigOf, now = Date.now(), env = process.env) {
  const from = state.startBackoffSeen ?? state.startedAt ?? now;
  let seen = from; let k = 0;
  for (const e of [...events].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const t = Date.parse(e.ts);
    if (!START_REFUSALS.has(e.type) || !e.task || !(t > from)) continue;
    noteStartRefusal(state, e.task, `${e.type} ${e.msg || ''}`.replace(new RegExp(String(e.task).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'T'), sigOf(e.task), now, env, String(e.msg || e.type));
    seen = Math.max(seen, t); k += 1;
  }
  state.startBackoffSeen = seen;
  return k;
}
/** The loop's delay with +-STUDIO_SUPERVISOR_JITTER (0.1; 0 = off) so supervisors on one PC don't fire in lockstep. rnd() is in [0, 1). */
export const supervisorJitter = (env = process.env) => Math.min(0.5, Math.max(0, num(env.STUDIO_SUPERVISOR_JITTER, 0.1)));
export const jitteredDelay = (baseMs, frac = supervisorJitter(), rnd = Math.random) => Math.max(1, Math.round(baseMs * (1 + (rnd() * 2 - 1) * frac)));
export const readStatus = () => readJson(STATUS_FILE);
/** "Try again" on a halted supervisor: `npm run studio:resume` writes it; the next pass reads it. */
const RESUME = path.join(STUDIO_STATE_DIR, 'supervisor-resume');
function readResume() {
  let text = '';
  try { text = fs.readFileSync(RESUME, 'utf8').trim(); } catch { return {}; }
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return { by: String(j.by || '').slice(0, 60), why: String(j.why || '').slice(0, 300), via: String(j.via || '').slice(0, 20) }; } catch {}
  return { by: text.slice(0, 60), via: 'war-room' };
}

/**
 * `npm run studio:resume -- --by <name> [--why "…"]`: the War Room's "Fixed it: try again" from a terminal. A person decides to
 * retry, so it refuses inside a launched agent session and for agents' names. Not halted: says so. STUDIO_RESUME_BY (off by
 * default): comma-separated names allowed to resume; any other is refused.
 */
export async function resumeCli({ by = null, why = null, permission = null, env = process.env } = {}) {
  const { agentLikeName, launchedSession } = await import('./agent-env.mjs');
  const { agentOnPermission, permissionText } = await import('./permission.mjs');
  const who = String(by || '').trim();
  // With a person's direct permission (--by <them> --permission "<their words or a link>"), a Producer or Director session or an outside agent may resume for them; a worker session never.
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
 * `npm run studio:extend -- --until <time|+8h|none> --by <name> [--why "…"] [--permission "…"]` moves a running
 * supervisor's end time (--until) without a restart: it writes .studio/supervisor-extend.json, which the next pass applies
 * (applyExtend: a supervisor.extended event); "none" removes the end time. Who may: the decider rules (harness/decider.mjs,
 * action 'supervisor-extend'): a person; an agent the owner's delegation covers (harness/delegation.mjs delegationFor); a
 * Producer or Director session or an outside agent on a person's direct permission (--permission); never a worker session
 * or a worker's name.
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
 * A halt left open in the log by a supervisor that is gone (crash, restart) would count as "still waiting" on the scorecard.
 * Once older than STUDIO_HALT_STALE_H (24) hours, studio:resume (same people as above) records supervisor.halt_cleared; a
 * younger one is left alone. Returns { code, text } or null (no open halt).
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
// A status record's supervisor is alive while its pid is in use and, on Linux, the /proc start recorded at its start matches (a stale "running" file naming a reused pid reads as not running).
const alive = (st) => Boolean(st?.pid) && pidAlive(st.pid, st.identity, { eperm: false });

/** "23:00" (today, or tomorrow if past), "8h", "90m" or "+8h" (from now), or an ISO time. */
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
 * Returns true when it halted. Also run when the time is up, so a halt caught by the last pass before --until is recorded.
 */
async function checkBadEnds(opts, state, now) {
  // Not bad ends: a session stopped at its usage limit; one a person or the Producer stopped (meta.stoppedBy); one its own launcher
  // ended (meta.exitCause: stall, idle, task budget). Sessions dying within STUDIO_HALT_SAME_DEATH_SEC (5) of each other count as ONE end.
  const mine0 = readRecentEvents(5000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= (state.haltCheckFrom || state.startedAt) && (state.names || []).includes(e.agent) && !e.meta?.usageLimit && !e.meta?.stoppedBy && !LAUNCHER_KILLS.has(e.meta?.exitCause?.kind));
  // Reviewer launch crashes back off per role (roleBackoff) and never halt the supervisor (see roleLaunchFailure).
  noteRoleLaunchFailures(state, mine0, now);
  const mine = mine0.filter((e) => !roleLaunchFailure(e));
  const ends = groupSameDeaths(mine);
  const last2 = ends.slice(-2).map((g) => g[g.length - 1]);
  if (last2.length === 2 && last2.every((e) => e.meta?.code && e.meta.code === last2[0].meta.code && (e.meta?.tool || '') === (last2[0].meta?.tool || ''))) {
    const code = last2[0].meta.code;
    const groups = ends.slice(-2);
    // Name the program, not "custom": the first word of STUDIO_<ROLE>_CMD or STUDIO_AGENT_CMD.
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
    // A halt whose cause is on the self-triage list (harness/self-triage.json: the tool isn't on PATH and another is) is fixed and cleared as studio:resume would, by "self-triage". Unknown causes, and a cause already fixed once in the window, wait for a person.
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

/**
 * A reviewer session that crashed at launch: ran under SAME_DEATH_MIN_RUN_SEC with a non-zero exit, tool not missing.
 * Only the reviewer: its model comes from the review plan (another family, often another tool), so its crash says that
 * route is wrong, not that the studio's tools are broken. A code-writing role that crashes at launch still counts toward the halt.
 */
export const LAUNCH_BACKOFF_ROLES = ['reviewer'];
export function roleLaunchFailure(e) {
  const role = String(e?.meta?.role || 'builder');
  if (!LAUNCH_BACKOFF_ROLES.includes(role)) return false;
  const code = Number(e?.meta?.code);
  if (!code || TOOL_MISSING.has(code)) return false;
  const ran = Number(e?.meta?.exitCause?.ranSec);
  return Number.isFinite(ran) && ran < SAME_DEATH_MIN_RUN_SEC;
}
/**
 * Fold launch crashes of non-builder roles into state.roleBackoff[role] = { count, until, last, said }: the role's next
 * start waits 2, 4, 8 ... minutes (startBackoffMs, capped at STUDIO_START_BACKOFF_MAX_MIN); a session of that role that
 * ran past a minute (or ended cleanly) clears it. One supervisor.role_backoff event per new failure.
 */
export function noteRoleLaunchFailures(state, ends, now = Date.now(), env = process.env) {
  const bo = (state.roleBackoff ||= {});
  if (!Array.isArray(state.roleBackoffSeen)) state.roleBackoffSeen = [];
  const seen = state.roleBackoffSeen;
  for (const e of [...ends].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const role = String(e.meta?.role || 'builder');
    const t = Date.parse(e.ts) || now;
    const key = e.id || `${e.agent}@${e.ts}`;
    if (seen.includes(key)) continue;
    seen.push(key);
    if (seen.length > 200) seen.splice(0, seen.length - 200);
    const cur = bo[role];
    if (roleLaunchFailure(e)) {
      const count = (cur?.count || 0) + 1;
      bo[role] = { count, lastAt: t, until: t + Math.max(60000, startBackoffMs(count, env)), agent: e.agent, code: e.meta?.code ?? null, said: false };
      emitEvent({ type: 'supervisor.role_backoff', agent: 'supervisor', to: 'producer', status: 'warn', msg: `${e.agent} (${role}) ended at launch with exit ${e.meta?.code} (${count} in a row): ${role} sessions wait ${Math.round((bo[role].until - now) / 60000)} min; the supervisor goes on with the other roles (npm run agent -- logs ${e.agent})`, meta: { role, agent: e.agent, code: e.meta?.code ?? null, count, until: new Date(bo[role].until).toISOString() } });
    } else if (cur && String(e.meta?.role || 'builder') === role) delete bo[role];
  }
  return bo;
}
/** The live back-off of a role, or null. */
export const roleBackedOff = (state, role, now = Date.now()) => { const b = state.roleBackoff?.[role]; return b && now < b.until ? b : null; };

/** Ends the launcher caused itself (exitCause kinds), never a sign the tool is broken. */
const LAUNCHER_KILLS = new Set(['stall', 'idle', 'budget', 'stopped']);
export const sameDeathSec = (env = process.env) => { const v = String(env.STUDIO_HALT_SAME_DEATH_SEC ?? '').trim(); const n = Number(v); return v !== '' && Number.isFinite(n) && n >= 0 ? n : 5; };
/**
 * Session ends (in order) grouped: ends within STUDIO_HALT_SAME_DEATH_SEC of the group's first are one group, [[end, …], …]; 0 = no
 * grouping. Time is when the process exited (meta.exitCause.at), else the event's. Only ends that ran at least
 * SAME_DEATH_MIN_RUN_SEC (60, per meta.exitCause.ranSec) merge: launch crashes and an exit 126/127/9009 each count on their own.
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
/** The running session of the same role whose lane clashes with group g's, or undefined. A session whose agent has exited works on nothing and clashes with nothing. */
export function laneClashWith(sameRole, g, clashes) {
  return (sameRole || []).find((s) => !s.ending && !s.agentExited && clashes(s.lane || null, g.lane || null, s, g));
}

/**
 * The lane a running session works in now. A session's lane is fixed at launch, so a later `task lane <ID> …` on its task
 * never reached the supervisor: the board's record (studio/task-holds.json "lane") wins; else the lane it was launched with.
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
  const { laneOf, lanesClash, laneList } = await import('./task-hold.mjs');
  const { eligibility, sameBlocker } = await import('./attempts.mjs');
  const { effectiveMode } = await import('./mode.mjs');
  const { budgetStatus, pickTool, quotaMark, probeTool, exhaustedUntil, customKey } = await import('./budget.mjs');
  const { status: lockStatus } = await import('./lock.mjs');
  const why = [];
  // opts.watcher: the watcher's auto-launch uses this same picker when no supervisor runs (one launcher).
  if (!opts.watcher && fs.existsSync(STOP_FILE)) return { stop: true, started: [], why: ['studio:stop was asked'] };
    // `npm run studio:extend` may have moved the end time (applied before the time-is-up check, so a late extend counts).
  if (!opts.watcher) { try { applyExtend(opts, state, now); } catch { /* the old end time stands */ } }
    // The owner's reports to a webhook (harness/report-post.mjs): the digest once a day at STUDIO_REPORT_HOUR, the what's-next board
    // when the queue changed a lot; before the halt and window checks, so a halted studio still reports.
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
  if (readStop()) return { started: [], why: ['"Stop all agents" is on (npm run task -- resume)'] };
  if (opts.window && !inWindow(opts.window, now)) return { started: [], why: [`outside the window ${opts.window}`] };
    // Two sessions in a row ending the same bad way mean starting more won't help: stop starting and ask a person once (Needs you).
    // "Try again" clears it.
  if (fs.existsSync(RESUME)) {
    // Who asked: the War Room writes the person's name; `npm run studio:resume` writes { by, why }.
    const asked = readResume();
    fs.rmSync(RESUME, { force: true });
    if (state.halted) emitEvent({ type: 'supervisor.resumed', agent: 'supervisor', to: 'producer', msg: `Supervisor starting agents again${asked.by ? ` (${asked.by} asked${asked.why ? `: ${asked.why}` : ''})` : ''}`, meta: { by: asked.by || null, why: asked.why || null, via: asked.via || null, cleared: state.halted.why || null } });
    state.halted = null;
    state.haltCheckFrom = now;
  }
  if (state.halted) return { started: [], why: [`halted: ${state.halted.why}`] };
  if (await checkBadEnds(opts, state, now)) return { started: [], why: [`halted: ${state.halted.why}`] };
    // End sessions whose process is gone (the watcher does this itself), at most once per STUDIO_GONE_CHECK_S.
  if (!opts.watcher && !opts.dryRun) { try { await (await import('./gone-check.mjs')).goneCheck(); } catch { /* a check, never a crash */ } }
    // The futility cap (harness/futility.mjs): a session past the p90 of its type's good runs raises a Check (shadow mode by default;
    // STUDIO_FUTILITY=on hands it back, its diff kept).
  if (!opts.watcher) {
    try {
      const { futilityPass } = await import('./futility.mjs');
      futilityPass({ sessions: sessions(), events: readRecentEvents(20000), now, dryRun: opts.dryRun, pause: opts.deps?.pauseAgent || (await import('./agent.mjs')).pauseAgent });
    } catch { /* a check, never a crash */ }
    // The nightly slow tier (harness/slow-tier.mjs): once a day from STUDIO_SLOW_HOUR (3), detached, on main.
    try {
      const { mainRoot: slowRoot } = await import('./worktree.mjs');
      const sl = await (opts.deps?.slowTierPass || (await import('./slow-tier.mjs')).slowTierPass)({ root: slowRoot(), now, dryRun: opts.dryRun });
      if (sl?.started) console.log(`[supervisor] started the nightly slow tier (${sl.why}); output .studio/slow-tier.log`);
    } catch { /* the slow tier never blocks the supervisor */ }
  }
  // Budget: tokens since the supervisor started, or a share of the plan's week (studio/budget.json).
  const st = budgetStatus(now);
    // Spend budgets (harness/spend-budget.mjs): 75% pages the orchestrator, 100% cuts new sessions on that tool or key.
  if (!opts.watcher && !opts.dryRun) { try { (await import('./spend-budget.mjs')).spendPass({ now }); } catch { /* measuring, never a crash */ } }
    // Vertex (harness/vertex.mjs) can take builders: configured in .env, aider found, not cut by a spend budget. It goes before the
    // paid API pool when the plan's budget is high, and takes STUDIO_VERTEX_SHARE otherwise.
  let vertexReady = { ok: false, why: '' };
  try {
    // Not agent.mjs's preflight: the launcher runs this pass itself (the watcher's deps), and can't import itself again.
    const r0 = (await import('./vertex.mjs')).vertexReady();
    const pre = r0.ok ? '' : r0.why;
    const cut = pre ? '' : (await import('./spend-budget.mjs')).cutFor(['vertex', 'VERTEX_API_KEY']);
    vertexReady = pre ? { ok: false, why: pre } : cut ? { ok: false, why: cut, cut } : { ok: true, why: '' };
  } catch { vertexReady = { ok: false, why: '' }; }
  let poolUsage = null; // set when the plan's budget is high
    // STUDIO_API_POOL builders (harness/api-pool.mjs) start while the plan's budget is high: where this pass would start nothing
    // (the wind-down above, every tool over its target below) the pool's builders go through.
  const apiPoolOn = (usage) => { try { return Boolean(process.env.STUDIO_API_POOL) && poolPlanNow(usage, sessions().filter((s) => s.running)).free.length > 0; } catch { return false; } };
    // Usage wind-down (harness/winddown.mjs): at STUDIO_USAGE_WINDDOWN_PCT start nothing new, let running sessions finish, write
    // .studio/restart-log.md; resume when the usage resets.
  try {
    const { winddownPass } = await import('./winddown.mjs');
    const { readHolds } = await import('./task-hold.mjs');
    const wd = winddownPass({ now, rows: st, dryRun: opts.dryRun, lists: () => ({ live: sessions().filter((s) => s.running).map((s) => ({ agent: s.agent, role: s.role, task: s.task })), queued: (parseNextQueue().backlog || []).map((t) => ({ id: t.id, role: t.role, title: t.title })), held: Object.entries(readHolds()).filter(([, h]) => h?.held).map(([id, h]) => ({ id, why: h.held.why || 'held' })) }) });
    if (wd.active) { poolUsage = { winddown: true, why: wd.why }; if (wd.state?.manual || (!apiPoolOn(poolUsage) && !vertexReady.ok)) return { started: [], why: [wd.why], winddown: true }; } // a manual one starts nothing, paid builders included
  } catch { /* the wind-down is a guard, never a crash */ }
  const { weightedTokens } = await import('./budget.mjs');
  const spentHere = Math.round(readRecentEvents(50000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= state.startedAt).reduce((n, e) => n + weightedTokens(e), 0));
  state.tokens = spentHere;
  if (opts.budget?.tokens && spentHere >= opts.budget.tokens) return { stop: true, started: [], why: [`the budget is spent (${spentHere.toLocaleString()} of ${opts.budget.tokens.toLocaleString()} tokens)`] };
  const known = st.filter((t) => t.weekly);
  if (opts.budget?.share && known.length && known.every((t) => t.pct >= opts.budget.share)) return { stop: true, started: [], why: [`the plan reached ${Math.round(opts.budget.share * 100)}% of the week`] };
  const over = known.length && known.every((t) => t.verdict === 'over');
  const under = known.some((t) => t.verdict === 'under');
  if (over) { poolUsage ||= { over: true, why: 'every tool is over its target for this point in the week' }; if (!apiPoolOn(poolUsage) && !vertexReady.ok) return { started: [], why: ['every tool is over its target for this point in the week: slowing down'] }; }
  const mode = effectiveMode();
  const extra = opts.budget && under ? 2 : 0;
  const live = sessions().filter((s) => s.running);
  const configured = Math.min(12, mode.maxAgents + extra);
    // The session cap by RAM (harness/heavy-budget.mjs sessionCap): the RAM budget less the heavy jobs' claims, STUDIO_SESSION_RAM_GB
    // (0.6) a session; no machine scan: the pace's cap.
  const ramCap = await sessionCapNow(configured);
    // The queue-depth target (harness/queue-depth.mjs): fewer startable builder tasks than STUDIO_QUEUE_DEPTH (default this cap)
    // asks the Producer, naming what blocks. It never adds a task.
  if (!opts.watcher) {
    try {
      const { queueDepthPass } = await import('./queue-depth.mjs');
      const { listLocks } = await import('./lock.mjs');
      const { unmerged } = await import('./worktree.mjs');
      const qd = await queueDepthPass({ q: parseNextQueue(), cap: ramCap.cap, now, dryRun: opts.dryRun, deps: { locks: listLocks(), unmerged, locked: (id) => lockStatus(`task:${id}`).locked, ...(opts.deps?.wake ? { wake: opts.deps.wake } : {}) } });
      if (qd.asked) why.push(`queue below its depth target (${qd.ready.length} ready, target ${qd.target}): the Producer was asked`);
    } catch { /* a nudge, never a crash */ }
  }
    // The upgrade watch (harness/upgrade-watch.mjs), every STUDIO_UPGRADE_WATCH_MIN (60) minutes.
  if (!opts.watcher) {
    try {
      const uw = await import('./upgrade-watch.mjs');
      const w = await uw.supervisorWatch({ now, dryRun: opts.dryRun });
      if (w?.line) why.push(w.line);
    } catch { /* a watch, never a crash */ }
  }
    // The janitor's stale-lane proposals (a dry run, never deletes) and the lane disk report, at most every STUDIO_JANITOR_LANES_MIN
    // (360) minutes, in a detached child (harness/lane-disk.mjs).
  if (!opts.watcher) {
    try { await (await import('./lane-disk.mjs')).lanesPass({ now, inline: Boolean(opts.deps?.lanesInline) }); } catch { /* a report, never a crash */ }
  }
  // A short planning session (producer, director, line-producer) doesn't take a builder slot: it is left out of the count the pace's
  // cap is held against. It still obeys its own per-role cap and the RAM limit, which counts every session.
  let room = builderRoom(ramCap.cap, live);
  const ramAll = (await sessionCapNow(configured + 16)).cap;
  let ramRoom = ramAll - live.length;
  room = Math.min(room, ramRoom);
  // The plan's budget is high: only the API pool's builders start (their names, up to the pool's size).
  const poolMode = poolUsage ? poolPlanNow(poolUsage, live) : null;
  // An owner-set builder order (STUDIO_BUILDER_ORDER; unset: the choice below).
  const bOrder = builderOrder();
  const poolFree = bOrder?.includes('api') ? poolMode?.free || poolPlan({ usage: { over: true }, live }).free : [];
  const vxFirst = Boolean(bOrder?.includes('vertex') && !(bOrder.indexOf('plan') >= 0 && bOrder.indexOf('plan') < bOrder.indexOf('vertex')));
  // Vertex goes before the pool, so with Vertex ready the pool's size doesn't cap the builders that may start.
  if (poolMode) { if (!vertexReady.ok) room = Math.min(room, poolMode.free.length); why.push(`${poolUsage.why}: ${vertexReady.ok ? 'Vertex first, then ' : ''}${poolMode.why}`); }
  if (ramRoom <= 0 || (room <= 0 && !parseNextQueue().backlog.some((t) => isPlanningRole(t.role)))) return { started: [], why: [ramCap.cap < configured ? `${live.length} agent${live.length === 1 ? '' : 's'} running; no more start: ${ramCap.why}` : `${live.length} agents running, the cap (${mode.label}${extra ? ' + 2 for the budget' : ''})`] };
  if (ramCap.cap < configured) why.push(`at most ${ramCap.cap} session${ramCap.cap === 1 ? '' : 's'} now: ${ramCap.why}`);
  const q = parseNextQueue();
  const held = [];
  // A task handed back because its claim ran out while its owner (an agent working outside the launcher) is still active is
  // that owner's, not a new agent's (harness/busy.mjs claimActive).
  const { claimActive } = await import('./busy.mjs');
  const { mainRoot } = await import('./worktree.mjs');
  let claimEvents = null;
  const waiting = q.backlog.filter((t) => {
    if (!t.role || t.role === 'human' || lockStatus(`task:${t.id}`).locked) return false;
    // One verdict (harness/attempts.mjs): the holds, the same-blocker clause, the budget and the round cap.
    let h = eligibility(t.id, { q, now, role: t.role, events: (claimEvents ||= readRecentEvents(20000)) })?.why;
    if (!h) {
      const a = claimActive(t.id, { root: mainRoot(), now, events: (claimEvents ||= readRecentEvents(20000)), orphaned: true });
      if (a.busy) h = `waits for ${a.owner}: ${a.why}`;
    }
    if (h) held.push(`${t.id} ${h}`);
    return !h;
  });
  if (held.length) why.push(`held: ${held.slice(0, 4).join('; ')}${held.length > 4 ? ` (+${held.length - 4})` : ''}`);
  const evs = readRecentEvents(20000);
  // Running sessions work in their task's lane as the board says it now.
  try { const hl = (await import('./task-hold.mjs')).readHolds(); for (const s of live) s.lane = currentLane(s, hl); } catch { /* the launch lanes stand */ }
  // Builders with no lane run side by side when both have a prediction and they don't overlap (harness/lane-plan.mjs;
  // STUDIO_UNSCOPED_PARALLEL=off: no lane = the whole game).
  let lanePlan = null;
  let predict = null;
  try { lanePlan = await import('./lane-plan.mjs'); if (lanePlan.unscopedParallelOn()) predict = lanePlan.predictor(evs); } catch { lanePlan = null; }
  const groups = new Map();
  const floorsConfig = readJson(path.join(REPO_ROOT, 'studio', 'floors.json'));
  const gameCartridge = readJson(path.join(REPO_ROOT, 'studio', 'game.json'))?.cartridge ?? readJson(path.join(REPO_ROOT, 'studio', 'gates.json'))?.cartridge;
  const { taskType } = await import('./done-check.mjs');

  // A task whose start was refused for the same reason as last time waits out a doubling backoff.
  const sigOf = (id) => taskStateSig(evs, id, lockStatus(`task:${id}`).locked);
  if (!state.startBackoff) { const f = readJson(START_BACKOFF_FILE, {}) || {}; state.startBackoff = f.tasks || {}; state.startBackoffSeen ??= f.seen; }
  try { ingestRefusals(state, evs, sigOf, now); } catch { /* a backoff is a courtesy, never a crash */ }
  const backedOff = [];
  const saveBackoff = () => { if (opts.dryRun) return; try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(START_BACKOFF_FILE, `${JSON.stringify({ seen: state.startBackoffSeen, tasks: state.startBackoff }, null, 2)}\n`); } catch { /* best effort */ } };

  for (const t of waiting) {
    const bo = startBackedOff(state, t.id, sigOf(t.id), now);
    if (bo) {
      if (!bo.said) {
        bo.said = true; backedOff.push(backoffWords(t.id, bo, now));
        // Once per backoff, with the reason, so the log says why a task is skipped.
        if (!opts.dryRun) { try { emitEvent({ type: 'supervisor.backoff', agent: 'supervisor', to: 'producer', task: t.id, status: 'warn', msg: backoffWords(t.id, bo, now).slice(0, 400), meta: { task: t.id, count: bo.count, reason: bo.text || bo.reason, minutes: Math.max(1, Math.round((bo.until - now) / 60000)) } }); } catch { /* a note, never a crash */ } }
      }
      continue;
    }
    // A task's own lane, `task lane`, or its --part (harness/task-hold.mjs).
    let lane = laneOf(t.id, evs) || null;
    if (!lane && floorsConfig && gameCartridge && ['change', 'system'].includes(taskType(t))) {
      const meta = evs.find((e) => e.task === t.id && e.type === 'task.added')?.meta;
      if (meta?.phase) {
        lane = `cartridges/${gameCartridge}/floors/phase-${meta.phase}`;
      }
    }
    // A laneless task with a prediction is its own group, so two of them can start in one pass.
    const own = !lane && predict && predict(t.id).length ? `|pred:${t.id}` : '';
    const key = `${t.role}|${lane || ''}${own}`;
    if (!groups.has(key)) groups.set(key, { role: t.role, lane, tasks: [] });
    groups.get(key).tasks.push(t);
  }
  if (backedOff.length) why.push(`start backoff: ${backedOff.slice(0, 4).join('; ')}${backedOff.length > 4 ? ` (+${backedOff.length - 4})` : ''}`);
  saveBackoff();
  // Skip a task whose prerequisite isn't merged yet or whose folder another agent holds, and try the next one in its group;
  // mark it "waiting on X" for the War Room.
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
  // The crew watchdog (harness/crew-watch.mjs): a role with more than STUDIO_CREW_MAX_SESSIONS sessions in the last hour and nothing
  // landed isn't launched until the cause clears or someone resumes it (npm run crew -- resume).
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
  // Most urgent first. With STUDIO_ATTEMPTS=record, a task whose last failed hand-back met a blocker that has not changed (same reason,
  // main's tip, what it waits for) goes after every other eligible one: last in its group, its group last when it is all such.
  const doneIds = new Set((q.done || []).map((x) => x.id));
  const same = (t) => { try { return sameBlocker(t.id, { done: doneIds }).same; } catch { return false; } };
  const allSame = new Map();
  for (const g of groups.values()) {
    g.tasks = [...g.tasks.filter((t) => !same(t)), ...g.tasks.filter((t) => same(t))];
    allSame.set(g, same(g.tasks[0]));
  }
  let ordered = [...groups.values()].sort((a, b) => allSame.get(a) - allSame.get(b) || String(a.tasks[0].priority).localeCompare(String(b.tasks[0].priority)));
  // The Line Producer's plan (harness/line-producer.mjs, STUDIO_LINE_PRODUCER): its order, model routes and the rig's builder cap.
  // Within the pace's caps only: it reorders and can hold builders back, never adds one.
  const line = await linePlanNow(now);
  if (line) ordered = line.orderGroups(ordered);
  for (const g of ordered) {
    const planning = isPlanningRole(g.role);
    if (ramRoom <= 0 || (room <= 0 && !planning)) continue;
    if (poolMode && g.role !== 'builder') continue; // the pool is builders only; other roles wait for headroom
    if (crewPaused[g.role]) {
      why.push(`${g.role}: paused by the crew watchdog (${String(crewPaused[g.role].why || '').slice(0, 120)}; npm run crew -- resume ${g.role} --by <name>)`);
      continue;
    }
    // A role whose sessions crashed at launch waits out its back-off; the other roles go on.
    { const rb = roleBackedOff(state, g.role, now); if (rb) { why.push(`${g.role}: backed off after ${rb.count} launch crash${rb.count === 1 ? '' : 'es'} (last ${rb.agent}, exit ${rb.code}) until ${new Date(rb.until).toISOString().slice(11, 16)} UTC`); continue; } }
    if (!canStart.has(g.role)) {
      why.push(`${g.role}: no tool set to start it (STUDIO_AGENT_TOOL or STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL)`);
      continue;
    }
    // Builders (and any role whose work has a lane) never share files: a builder with no lane holds
    // the whole game, so nothing else in that role runs beside it, and two lanes must not overlap.
    const sameRole = live.filter((s) => s.role === g.role);
    const codeRole = g.role === 'builder' || Boolean(g.lane) || sameRole.some((s) => s.lane);
    if (codeRole) {
      // A session whose agent has already exited (its launcher is handing its work back) holds nothing, so it does not stop other builders.
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
    // The Producer starts on events only, at most every 15 min unless urgent, backing off when quiet.
    if (g.role === 'producer') {
      const { producerWake } = await import('./producer-wake.mjs');
      const w = producerWake({ now, queue: q, commit: true });
      if (!w.wake) {
        why.push(`producer: ${w.why}`);
        continue;
      }
    }
    const preferred = process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
    // When the tools in the budget order carry their own launch commands (STUDIO_TOOL_<TOOL>_CMD), the order decides (a quota error
    // or spend guard hands over); a role command only applies otherwise.
    const { toolCmd } = await import('./spend-guard.mjs');
    const orderCmds = [preferred, ...((await import('./budget.mjs')).readBudget().order || [])].some((t) => toolCmd(t));
    const custom = orderCmds ? undefined : process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CMD`];
    // Before believing a quota mark older than 10 minutes, ask the tool once (one tiny call, at most every 10 minutes per tool): a wrong
    // mark once idled the studio.
    const mark = !custom && !opts.watcher ? quotaMark(preferred) : null;
    if (mark && Date.parse(mark.until) > now && now - Date.parse(mark.at) > 10 * 60000 && !/^(off|0|false|no)$/i.test(process.env.STUDIO_QUOTA_PROBE || '') && now - ((state.probed || {})[preferred] || 0) > 10 * 60000) {
      state.probed = { ...(state.probed || {}), [preferred]: now };
      why.push(`asked ${preferred} whether it is really out: ${probeTool(preferred).why}`);
    }
    const tool = custom ? undefined : pickTool(preferred, now);
    // A role run by its own command (STUDIO_<ROLE>_CMD) whose limit line named no tool is marked per program (custom:<program>): wait
    // for that reset too, without holding other commands.
    const customOut = custom ? exhaustedUntil(customKey(custom) || 'custom', now) : null;
    if (customOut) {
      why.push(`${g.role}: its command is out of quota until ${customOut} (npm run budget)`);
      continue;
    }
    // The route and whether this builder starts on Vertex (harness/vertex.mjs vertexPick): instead of a Claude session, before the paid
    // API pool when the plan's budget is high (or every tool is out), else within its share.
    const lr = line ? line.routeFor(g, { tool, preferred, custom, live, outUntil: (await import('./budget.mjs')).exhaustedUntil }) : {};
    let vx = null;
    // A route that keeps a task on Vertex goes through the same check as a new pick (share, budget cut, earlier failures); if Vertex
    // may not take it now, it starts on the plan's tool.
    if (lr.tool === 'vertex') {
      const keep = vertexReady.ok && g.role === 'builder' && !custom ? (await import('./vertex.mjs')).vertexPick({ role: g.role, taskId: g.tasks[0]?.id, tier: lr.tier || null, live, cap: ramCap.cap, high: Boolean(poolMode) || !tool || vxFirst, events: evs, ready: vertexReady }) : { skip: vertexReady.why || 'vertex is not ready' };
      if (keep.skip) { why.push(`${g.tasks[0]?.id}: not kept on Vertex (${keep.skip})`); lr.tool = null; lr.model = null; }
    }
    if (vertexReady.ok && g.role === 'builder' && !custom && ['claude', null, undefined].includes(lr.tool || tool)) {
      const pick = (await import('./vertex.mjs')).vertexPick({ role: g.role, taskId: g.tasks[0]?.id, tier: lr.tier || null, live, cap: ramCap.cap, high: Boolean(poolMode) || !tool || vxFirst, events: evs, ready: vertexReady });
      if (pick.tool) vx = pick; else if (pick.skip && (poolMode || !tool)) why.push(`${g.tasks[0]?.id}: ${pick.skip}`);
    }
    const kind = bOrder && g.role === 'builder' && !custom ? builderKind(bOrder, { api: Boolean(tool) && poolFree.length > 0, vertex: Boolean(vx) || lr.tool === 'vertex', plan: Boolean(tool) && !poolMode }) : null;
    if (kind !== null && kind !== 'vertex') { vx = null; if (lr.tool === 'vertex') { lr.tool = null; lr.model = null; } }
    if (bOrder && g.role === 'builder' && !custom && !kind) { why.push(`${g.tasks[0]?.id}: no builder in STUDIO_BUILDER_ORDER (${bOrder.join(',')}) can start now`); continue; }
    if (!custom && !tool && !vx) {
      why.push(`${g.role}: every tool is out of quota (npm run budget)`);
      continue;
    }
    // No new agent while free memory is under the floor. Running agents are never stopped; the next pass looks again.
    ram ||= ramCheck(opts);
    if (ram.low) {
      why.push(ram.why);
      ramNote(ram, now);
      break;
    }
    const agent = kind ? (kind === 'api' ? poolFree.shift() : nextAgentName(g.role, opts.prefix || 's')) : !vx && poolMode ? poolMode.free.shift() : nextAgentName(g.role, opts.prefix || 's');
    if (!agent) break;
    state.names = [...(state.names || []), agent].slice(-200);
    // One builder per task: a launch lock (one atomic file per task) and the live sessions decide who starts it, so two passes at once
    // (the watcher and the Director flow) can't both start it.
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
    // toolDefault: this tool is the supervisor's default, not a decision; a reviewer plan's model picks its own tool.
    const r = startAgent({ role: g.role, agent, tool: vx ? 'vertex' : lr.tool || tool, toolDefault: !vx && !lr.tool, task: g.tasks[0].id, lane: g.lane, oneTask: true, extra, ...(vx ? { model: vx.model } : lr.model ? { model: lr.model } : {}) }, { detach: true });
    if (r.ok && vx) emitEvent({ type: 'model.routed', agent: 'supervisor', task: taskId, msg: `${taskId}: starts on ${vx.model} (vertex): ${vx.why}`.slice(0, 400), meta: { task: taskId, arm: 'vertex', tier: vx.size, model: vx.model, tool: 'vertex' } });
    else if (r.ok && lr.model) emitEvent({ type: 'model.routed', agent: 'line-producer', task: taskId, msg: `${taskId}: starts on ${lr.model}${lr.tool ? ` (${lr.tool})` : ''} (${lr.tier} ${lr.tool ? 'task' : 'tier'}, the Line Producer): ${lr.why}`.slice(0, 400), meta: { task: taskId, arm: 'line-producer', tier: lr.tier, model: lr.model, ...(lr.tool ? { tool: lr.tool } : {}), failed: lr.failed || 0 } });
    if (r.ok) {
      if (kind ? kind === 'api' : poolMode && !vx) emitEvent({ type: 'supervisor.api_pool', agent: 'supervisor', task: taskId, msg: `${agent} starts on ${taskId} billed to its API key: ${poolUsage?.why || `STUDIO_BUILDER_ORDER=${bOrder}`}`, meta: { agent, reason: !poolUsage ? 'builder-order' : poolUsage.over ? 'over-target' : 'winddown' } });
      started.push(`${agent} on ${g.tasks[0].id}${g.lane ? ` in ${g.lane}` : ''}${vx ? ` (vertex, ${vx.model})` : tool && tool !== preferred ? ` (${tool}: ${preferred} is out of quota)` : ''}`);
      // Count it at once, so the next group in this pass sees it (a lane taken, or the whole game).
      live.push({ agent, role: g.role, lane: g.lane || null, task: taskId, running: true, tool: vx ? 'vertex' : lr.tool || tool });
      if (g.role === 'producer') (await import('./producer-wake.mjs')).producerLaunched(now);
      ramRoom -= 1;
      if (!planning) room -= 1;
    } else {
      why.push(`${g.role}: ${r.message}`);
      if (!crewWideRefusal(r.message)) try { noteStartRefusal(state, taskId, `start_agent ${r.message}`, sigOf(taskId), now, process.env, r.message); saveBackoff(); } catch { /* best effort */ }
    }
  }
  if (!groups.size) why.push('no waiting tasks for agents');
  return { started, why };
}

/** One train-daemon pass for the supervisor loop: the result goes in state.train. A wind-down, "Stop all" and drain keep it from starting a train; the supervisor's own halt (scope 'builders') does not (lanes already queued still land). Never throws. */
export async function trainDaemonTick(state, r = {}, opts = {}) {
  try {
    const { trainDaemonPass } = await import('./train-daemon.mjs');
    const d = await trainDaemonPass({ halted: state.halted || null, ...(r.winddown ? { winddown: r.why?.[0] || 'winding down' } : {}), ...opts });
    state.train = { at: new Date().toISOString(), started: Boolean(d.started), why: d.why, ...(d.pid ? { pid: d.pid } : {}) };
    return d;
  } catch (err) { state.train = { at: new Date().toISOString(), started: false, why: `error: ${err.message}` }; return { started: false, why: err.message }; }
}

/** Roles whose short sessions don't take a builder slot under the cap. */
export const PLANNING_ROLES = ['producer', 'director', 'line-producer'];
export const isPlanningRole = (role) => PLANNING_ROLES.includes(String(role || ''));
/** Free session slots under the cap for a builder: running sessions of the planning roles are not counted. */
export const builderRoom = (cap, live = []) => cap - live.filter((s) => s && s.running !== false && !isPlanningRole(s.role)).length;

/**
 * May a model-pool route (plan.routes[id]) apply to this role? Only the roles studio/models.json names in "routeRoles" (default
 * builder and engine-porter): the Director, Producer and reviewers keep their own role model.
 */
export const DEFAULT_ROUTE_ROLES = ['builder', 'engine-porter'];
export function routeAppliesToRole(role, models = null) {
  const list = Array.isArray(models?.routeRoles) ? models.routeRoles.map(String) : DEFAULT_ROUTE_ROLES;
  return list.includes(String(role || ''));
}

/**
 * The Line Producer's plan for this pass, or null (off, report, stale, unreadable). orderGroups(groups) sorts by its order;
 * routeFor(group, …) gives { model, tier, why } for the group's first task (only on the preferred tool, never for a custom
 * command); holdFor(group, live) says why a builder waits when the rig's builder cap is reached. Never throws.
 */
export async function linePlanNow(now, { plan: planIn = null, models = null } = {}) {
  try {
    const lp = await import('./line-producer.mjs');
    const plan = planIn || lp.supervisorPlan({ now });
    if (!plan) return null;
    let routeCfg = null;
    try { routeCfg = models || (await import('./model-pools.mjs')).readModels(); } catch { routeCfg = null; }
    return {
      orderGroups: (groups) => lp.orderGroups(groups, plan),
      // An engine pass's session (engine-porter) counts against the rig's cap with the builders.
      holdFor: (g, live) => (g.role === 'builder' && plan.rigCap !== null && live.filter((s) => s.role === 'builder' && s.running !== false).length >= plan.rigCap ? `builder: the Line Producer holds new builders (the rig can carry ${plan.rigCap} now: ${String(plan.rigWhy).slice(0, 160)})` : g.role === 'engine-porter' && plan.rigCap !== null && live.filter((s) => (s.role === 'builder' || s.role === 'engine-porter') && s.running !== false).length >= plan.rigCap ? `engine-porter: the Line Producer holds new engine passes (the rig can carry ${plan.rigCap} sessions now: ${String(plan.rigWhy).slice(0, 160)})` : ''),
      routeFor: (g, { tool, preferred, custom, outUntil }) => {
        const id = g.tasks[0]?.id;
        const r = plan.routes[id];
        if (!r?.model || custom) return {};
        if (!routeAppliesToRole(g.role, routeCfg)) return {};
        // A model-pool route names its tool too (agy for Gemini, claude for Claude): taken unless that tool is marked out of quota now
        // (the pool's own limits were weighed when the route was made).
        if (r.tool) return outUntil && (outUntil(r.tool) || outUntil(`${r.tool}:${r.model}`)) ? {} : { tool: r.tool, model: r.model, tier: r.tier, why: r.why };
        if (tool && tool !== preferred) return {};
        return { model: r.model, tier: r.tier, why: r.why };
      },
      // A task whose protected step the Line Producer routed to an approver waits for that approval.
      holdTask: (g) => (plan.hold && plan.hold.has(g.tasks[0]?.id) ? `${g.tasks[0].id}: ${String(plan.hold.get(g.tasks[0].id)).slice(0, 200)} (the Line Producer holds it until then)` : ''),
    };
  } catch { return null; }
}

/** The session cap by RAM, { cap, why }; the configured cap when anything fails. */
async function sessionCapNow(configured) {
  try {
    const hb = await import('./heavy-budget.mjs');
    const h = await import('./heavy.mjs');
    const root = await h.heavyRoot();
    return hb.sessionCap({ configured, profile: hb.machineProfile(root), holders: h.heavyHolders(root), root: REPO_ROOT, heavyRoot: root });
  } catch { return { cap: configured, why: '' }; }
}

// ramCheck lives in harness/ram.mjs (heavy.mjs uses it too; importing this module from heavy.mjs would make a cycle with this file's
// top-level await). Re-exported for existing callers.
export { ramCheck } from './ram.mjs';
import { ramCheck } from './ram.mjs';

/** Says so once per pass, as an event at most every STUDIO_RAM_NOTE_MIN (15) minutes while it stays low. */
function ramNote(ram, now) {
  const every = Number(process.env.STUDIO_RAM_NOTE_MIN || 15) * 60000;
  const last = readRecentEvents(2000).filter((e) => e.type === 'supervisor.ram_low').pop();
  if (last && now - Date.parse(last.ts) < every) return;
  emitEvent({ type: 'supervisor.ram_low', agent: 'supervisor', to: 'producer', status: 'warn', msg: `Not starting agents: ${ram.why}`, meta: { freeGb: ram.freeGb, floorGb: ram.floorGb } });
}

async function main(argv) {
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const budgetArg = flag('budget');
  const opts = {
    until: parseUntil(flag('until')),
    window: flag('window'),
    budget: budgetArg ? (/%$/.test(budgetArg) ? { share: Number(budgetArg.slice(0, -1)) / 100 } : { tokens: Number(budgetArg) }) : null,
    lanes: flag('lanes'),
  };
  // The hub is gone; a start script that still passes --hub/--no-hub keeps working.
  if (argv.includes('--hub') || argv.includes('--no-hub')) console.log('[supervisor] --hub/--no-hub ignored: there is no hub since 2.80 (npm run studio:status shows the studio).');
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const prev = readStatus();
  if (prev?.pid && prev.pid !== process.pid && alive(prev) && prev.status === 'running') {
    console.error(`A supervisor is already running (pid ${prev.pid}). npm run studio:stop first.`);
    process.exit(1);
  }
  fs.rmSync(STOP_FILE, { force: true });
  const { parseNextQueue } = await import('./task.mjs');
  const state = { pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: Date.now(), opts: { ...opts, until: opts.until ? new Date(opts.until).toISOString() : null }, sessions: 0, doneAtStart: parseNextQueue().done.length };
  const save = (extra = {}) => writeAtomic(STATUS_FILE, `${JSON.stringify({ ...state, ...extra, startedAt: new Date(state.startedAt).toISOString(), lastLoop: new Date().toISOString(), tasksDone: parseNextQueue().done.length - state.doneAtStart }, null, 2)}\n`);
  // Write this supervisor's own pid, identity and status now, before the first full pass (which can take minutes): studio:status and
  // studio:reload-env right after a restart would otherwise read the OLD record and say "Not running".
  try { save(); } catch { /* the first pass writes it */ }
  emitEvent({ type: 'supervisor.start', agent: 'supervisor', to: 'producer', msg: `Supervisor running${opts.until ? ` until ${new Date(opts.until).toTimeString().slice(0, 5)}` : ''}${opts.window ? `, window ${opts.window}` : ''}${opts.budget ? `, budget ${budgetArg}` : ''}${opts.lanes ? `, lanes ${opts.lanes}` : ''}` });
  console.log(`[supervisor] running (pid ${process.pid}). npm run studio:stop to stop; agents finish their current task.`);
  // --budget 50% paces against the week's tokens; without --weekly it can never trip.
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
    // At --until, a one-page overnight summary (studio/daily/overnight-<date>.md).
    const summary = opts.until ? import('./overnight.mjs').then(({ writeOvernight }) => writeOvernight({ from: state.startedAt })).catch(() => {}) : Promise.resolve();
    summary.finally(() => {
      setTimeout(() => process.exit(0), 300);
    });
  };
  process.on('SIGINT', () => finish('stopped by hand'));
  process.on('SIGTERM', () => finish('stopped by the system'));
  // `npm run studio:reload-env` is answered within seconds; every pass also re-reads .env when it changed.
  const { reloadEnvIfChanged, watchReloadRequests } = await import('./env-reload.mjs');
  watchReloadRequests({ by: 'supervisor' });
  const tick = async () => {
    if (stopping) return;
    reloadEnvIfChanged({ by: 'supervisor', ack: true });
    // The Line Producer's pass (harness/line-producer.mjs): mechanical unblocks, the order, the routes, the rig's builder cap,
    // .studio/line/status.json; supervise() below follows the plan. Code only, never a crash.
    await boundedStep('line-producer', () => import('./line-producer.mjs').then(({ lineProducerPass }) => lineProducerPass({})), { state }).then((lp) => { if (lp && !lp.off) state.line = { at: lp.at, mode: lp.mode, builders: lp.builders ? { running: lp.builders.running, target: lp.builders.target } : null, blocked: lp.blocked?.length || 0, error: lp.error || undefined }; }).catch(() => {});
    // A MAX SPEED boost that ran out says so once (event + Studio Status line).
    try { const mm = await import('./mode.mjs'); mm.boostExpiryPass({}); mm.enginePushExpiryPass({}); } catch {}
    const r = await boundedStep('supervise', () => supervise(opts, state), { state, ms: num(process.env.STUDIO_SUPERVISOR_STEP_SEC, 300) * 2000, fallback: () => ({ started: [], why: ['the launch step was still running; see supervisor.step_timeout'] }) }).catch((err) => ({ started: [], why: [`error: ${err.message}`] }));
    state.sessions += r.started.length;
    state.last = { at: new Date().toISOString(), started: r.started, why: r.why.slice(0, 6) };
    if (r.started.length) emitEvent({ type: 'supervisor.started', agent: 'supervisor', to: 'producer', msg: `Started ${r.started.join(', ')}` });
    // The Director's flow pass sees what the supervisor couldn't start, and why (no model, no tokens).
    await boundedStep('director-flow', () => import('./director-flow.mjs').then(({ flowPass }) => flowPass({ fill: false, launcherWhy: r.why, throttleMs: 55000 })), { state }).catch(() => {});
    // The resource monitor: a machine scan every STUDIO_MACHINE_SAMPLE_S into machine.sample (harness/machine.mjs).
    await boundedStep('machine', () => import('./machine.mjs').then(({ sampleMachine }) => sampleMachine({ emit: emitEvent })), { state }).catch(() => {});
    // Hourly summaries of the diagnostics counted instead of logged one by one (harness/telemetry.mjs).
    await boundedStep('telemetry', () => import('./telemetry.mjs').then(({ flushTelemetry }) => flushTelemetry({ emit: emitEvent })), { state }).catch(() => {});
    // The Communicator (harness/communicator.mjs): the 30-minute status post and the alerts that tag who must act. After the machine
    // scan (it reads it) and before a stop ends the loop (so a stop file is reported).
    await boundedStep('communicator', () => import('./communicator.mjs').then(({ communicatorPass }) => communicatorPass({ passWhy: r.why })), { state }).catch(() => {});
    // The timed passes the hub used to run (watch, retro, learn, run report, daily ping; the watchdog): harness/studio-passes.mjs, one
    // bounded step per group, first one interval after the start. state.timed: each group's last run.
    await import('./studio-passes.mjs').then(({ timedPasses }) => timedPasses({ since: state.startedAt, last: (state.timed ||= {}), dryRun: opts.dryRun, deps: { step: (label, fn) => boundedStep(label, fn, { state }) } })).catch((err) => console.error(`[supervisor] timed passes: ${err?.message || err}`));
    // The self-repair loop's pass (harness/workaround.mjs): hand-edited records, supervisor restarts, killed launchers, harness tasks and
    // their "maybe fixed" marks; throttled to STUDIO_WORKAROUND_SCAN_MIN (10).
    // The editor service's queue (harness/editor-service.mjs): off unless engines.<x>.service.check; started, never awaited (a compile
    // can take minutes), and skipped while that engine's train runs.
    if (!opts.dryRun) { try { (await import('./editor-service.mjs')).editorServicePass({ background: true }); } catch { /* off or broken: never a crash */ } }
    await boundedStep('workaround', () => import('./workaround.mjs').then(({ workaroundPass }) => workaroundPass({})), { state }).catch(() => {});
    // The train daemon (harness/train-daemon.mjs, STUDIO_TRAIN_AUTO): a train starts, detached, when lanes are ready and the machine has
    // room for a verify; never two at once, never while halted or winding down.
    if (!r.stop) await boundedStep('train-daemon', () => trainDaemonTick(state, r), { state }).catch(() => {});
    // Gate runs whose parent is gone, past STUDIO_ORPHAN_GATE_MIN, are ended with their tree (harness/gate-reaper.mjs; throttled to
    // STUDIO_ORPHAN_GATE_SCAN_MIN).
    await boundedStep('gate-reaper', () => import('./gate-reaper.mjs').then(({ reapOrphanGates }) => reapOrphanGates({ log: (m) => console.error(m) })), { state }).then((g) => { if (g && !g.skipped) state.gateReaper = { at: new Date().toISOString(), ended: (g.ended || []).map((e) => e.pid) }; }).catch(() => {});
    state.passes = (state.passes || 0) + 1; // passes finished since the start, in supervisor.json
    save();
    if (r.stop) finish(r.why[0]);
  };
  // The loop is set before the first pass, passes never overlap, and a pass still running after STUDIO_SUPERVISOR_STUCK_MIN (15) is
  // reported once (supervisor.pass_stuck) instead of silently stopping the studio.
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
  // A self-rescheduling timeout with +-STUDIO_SUPERVISOR_JITTER (0.1) so several studios or watchers on one PC don't fire in lockstep.
  // The next timer is set when this one fires (before its pass), so a long pass is still seen by the next call (the stuck report) and passes never overlap.
  const schedule = () => { if (stopping) return; setTimeout(() => { schedule(); loop(); }, jitteredDelay(LOOP_MS)); };
  schedule();
  await loop();
}

/** Start at login: launchd on macOS, systemd --user on Linux, Task Scheduler on Windows. */
/** The node to run at login: the one on this terminal's PATH (process.execPath may be a node bundled inside another app), unless STUDIO_NODE says otherwise. */
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

// The CLI runs in an async function, never as a top-level await: a pass that imports this file back (the Communicator, self-triage,
// the digest read readStatus from here) would wait for this module to load, which waits for the pass, and Node exits with code 13
// ("unsettled top-level await").
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) (async () => {
  const argv = process.argv.slice(2);
  // --help / -h prints usage and never starts, stops or resumes anything.
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
    // Signal the pid only while it is still the supervisor: its start time, read from the OS now, against the one in supervisor.json.
    // Unreadable or missing: signalled only if its last loop is recent (the number may be another program's by now). Either way the stop
    // file stops a real supervisor at its next loop.
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
        // On Windows SIGTERM ends the process outright, so its own "stopped" write never happens: mark it here.
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
    // The studio's Vertex proxy (harness/vertex.mjs) stops with the studio; a vertex session started later starts it again.
    try { const px = await (await import('./vertex.mjs')).stopProxy(); if (px.stopped) console.log(`Stopped the studio's Vertex proxy (pid ${px.pid}).`); } catch { /* nothing to stop */ }
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
    // Agent-proposed tasks waiting on the dev's yes, named after the last pass (harness/yes-wait.mjs).
    const yesWaitText = async () => { try { const w = await (await import('./yes-wait.mjs')).readYesWaiting(); return w.count ? `; ${w.line}: npm run task -- yes <id> --by <dev>${w.beta.on ? ` (${w.beta.words})` : ''}` : ''; } catch { return ''; } };
    const s = readStatus();
    // The merge train(s) now: the running one and the speculative one behind it.
    // " ENGINE PUSH: unity until 18:00 UTC." for studio:status, or ''.
    const pushNow = async () => { try { const p = (await import('./mode.mjs')).enginePushOf(); return p ? ` ENGINE PUSH: ${p.engine}${p.until ? ` until ${p.until.slice(11, 16)} UTC` : ' until turned off'} (${p.by}); its porters and lands go first.` : ''; } catch { return ''; } };
    const trainsNow = async () => { try { const ts = await import('./train-status.mjs'); const t = ts.readTrainStatus((await import('./worktree.mjs')).mainRoot()); return t ? `\n${ts.trainsText(t)}` : ''; } catch { return ''; } };
    console.log(s ? `${s.status === 'running' && alive(s) ? 'Running' : 'Not running'} since ${s.startedAt}${s.opts?.until ? ` until ${s.opts.until}` : ''}${s.stopReason ? `; stopped: ${s.stopReason}` : ''}. Sessions started: ${s.sessions}; tasks done: ${s.tasksDone}; tokens: ${(s.tokens || 0).toLocaleString()}. Last pass: ${s.last ? `${s.last.started.join(', ') || 'nothing started'}${s.last.why?.length ? ` (${s.last.why.join('; ')})` : ''}` : 'none'}${await yesWaitText()}${await trainsNow()}${await pushNow()}` : `The supervisor has not run here yet: npm run studio:start${await trainsNow()}${await pushNow()}`);
    process.exit(0);
  }
  if (argv.includes('--install') || argv.includes('--uninstall')) {
    console.log(install(argv, argv.includes('--uninstall')));
    process.exit(0);
  }
  // By default it runs on its own, so it outlives the terminal or agent shell that started it (a host shell restart killed every agent).
  // --foreground keeps it attached.
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
