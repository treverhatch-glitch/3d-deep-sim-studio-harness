#!/usr/bin/env node
/**
 * harness/crew-watch.mjs — 2.68.0: the crew watchdog. The supervisor's loop asks it, every pass, whether a role is
 * burning sessions without landing anything, and stops launching that role until the cause clears or someone decides.
 *
 *   npm run crew                                              each role's last hour, and which roles are paused
 *   npm run crew -- resume <role> --by <name> [--why "…"] [--permission "<the person's words or a link>"]
 *
 * Per role, over the last hour (STUDIO_CREW_WINDOW_MIN, 60) of agent.session.start / agent.session.end events:
 * sessions, sessions with no commit (the session's outcome, harness/session-outcome.mjs), tokens spent per landed task
 * (weighted as the autonomy scorecard's tokenWork weighs them: harness/token-weight.mjs), repeated short exits (under
 * STUDIO_CREW_SHORT_SEC, 180 s) and tasks landed (task.done, train landings, lane merges of the role's tasks).
 * Unhealthy: more than STUDIO_CREW_MAX_SESSIONS (6) sessions in the window and 0 landed. Then the supervisor pauses
 * launching that role (running sessions go on), emits one crew.unhealthy (to the Producer, with the evidence) and the
 * digest and `status --brief` show it. It resumes:
 *   - when the cause clears: a task the role worked lands, or new work for the role appears (a task added, unparked or
 *     unheld since the pause); the window then starts again from the resume;
 *   - on `npm run crew -- resume <role> --by <name>`: a person, an agent under the owner's delegation for hold, or a
 *     Producer/Director session or an outside agent on a person's direct permission (harness/decider.mjs); never a
 *     worker. The supervisor's next pass picks it up and emits crew.resumed naming who.
 *   - 2.78.2 (c): by itself, STUDIO_CREW_BREAKER_RESUME_MIN (30; 0 or off: never) minutes after the pause, when the
 *     evidence that tripped it no longer trips it (the role's window, looked at as of now, is healthy: a pause the
 *     supervisor slept through, or one whose sessions have aged out), or else ONCE for that cause (the same tasks):
 *     the window starts again, and if the role trips again on the same cause it stays paused for a decider or real
 *     progress. Logged as crew.resumed (meta.auto). A landing or new work clears the cause and forgets "once".
 * STUDIO_CREW_WATCH=off turns it off. State: .studio/crew-paused.json (pauses), .studio/crew-resume.json (asks).
 * No model, no tokens. Only event.mjs and token-weight.mjs are imported at load (the supervisor imports this file).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { weightedTokens } from './token-weight.mjs';
import { readJson } from './fsafe.mjs';

export const PAUSED_FILE = () => path.join(STUDIO_STATE_DIR, 'crew-paused.json');
export const RESUME_FILE = () => path.join(STUDIO_STATE_DIR, 'crew-resume.json');
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`); fs.renameSync(tmp, f); };
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const ts = (e) => Date.parse(e?.ts) || 0;

/** The watchdog's settings. */
export function crewLimits(env = process.env) {
  return {
    off: /^(off|0|false|no)$/i.test(String(env.STUDIO_CREW_WATCH || '').trim()),
    maxSessions: Math.max(1, num(env.STUDIO_CREW_MAX_SESSIONS, 6)),
    windowMs: Math.max(1, num(env.STUDIO_CREW_WINDOW_MIN, 60)) * 60000,
    shortMs: Math.max(1, num(env.STUDIO_CREW_SHORT_SEC, 180)) * 1000,
    // 2.78.2 (c): minutes a pause lasts before the supervisor resumes the role by itself (0 or off: never).
    resumeMs: /^(off|false|no)$/i.test(String(env.STUDIO_CREW_BREAKER_RESUME_MIN || '').trim()) ? 0 : Math.max(0, num(env.STUDIO_CREW_BREAKER_RESUME_MIN, 30)) * 60000,
  };
}

const landingsOf = (e) => (e.type === 'task.done' || e.type === 'lane.merged' ? (e.task ? [e.task] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [e.task] : []) : []);

/**
 * Each role's last window: { [role]: { sessions, ended, noCommit, shortExits, tokens, landed, tokensPerLanded, tasks,
 * whys, unhealthy, why } }. sinceByRole: a later start per role (a resume restarts its window).
 */
export function crewHealth(events, { now = Date.now(), env = process.env, sinceByRole = {}, weight = (e) => weightedTokens(e) } = {}) {
  const lim = crewLimits(env);
  const roleOf = new Map(); // agent -> role (from its starts)
  const startOf = new Map(); // agent -> latest start time
  const out = {};
  const row = (role) => (out[role] ||= { sessions: 0, ended: 0, noCommit: 0, shortExits: 0, tokens: 0, landed: 0, tokensPerLanded: null, tasks: [], landedTasks: [], whys: [], agents: [], unhealthy: false, why: '' });
  const sorted = [...events].sort((a, b) => ts(a) - ts(b));
  const from = (role) => Math.max(now - lim.windowMs, Number(sinceByRole[role]) || 0);
  for (const e of sorted) {
    const t = ts(e);
    if (t > now) break;
    if (e.type === 'agent.session.start') {
      const role = String(e.meta?.role || '').trim() || 'unknown';
      roleOf.set(e.agent, role); startOf.set(e.agent, t);
      if (e.meta?.outside || t < from(role)) continue;
      const r = row(role);
      r.sessions += 1;
      if (!r.agents.includes(e.agent)) r.agents.push(e.agent);
      if (e.task && !r.tasks.includes(e.task)) r.tasks.push(e.task);
    } else if (e.type === 'agent.session.end' && !e.meta?.outside) {
      const role = String(e.meta?.role || roleOf.get(e.agent) || '').trim() || 'unknown';
      if (t < from(role)) continue;
      const r = row(role);
      r.ended += 1;
      r.tokens += weight(e);
      const o = e.meta?.outcome;
      if (o && !o.done && !o.commits && o.counts !== false) { r.noCommit += 1; if (o.why && r.whys.length < 3) r.whys.push(`${e.agent}: ${o.why}`); }
      if (o?.task && !r.tasks.includes(o.task)) r.tasks.push(o.task);
      const st = startOf.get(e.agent);
      if (st && t - st < lim.shortMs && !e.meta?.stoppedBy && !e.meta?.usageLimit) r.shortExits += 1;
    }
  }
  // Landings in each role's window of the tasks its sessions held.
  for (const e of sorted) {
    const t = ts(e);
    if (t > now) break;
    for (const task of landingsOf(e)) {
      for (const [role, r] of Object.entries(out)) {
        if (t < from(role) || !r.tasks.includes(task) || r.landedTasks.includes(task)) continue;
        r.landedTasks.push(task); r.landed += 1;
      }
    }
  }
  for (const r of Object.values(out)) {
    r.tokens = Math.round(r.tokens);
    r.tokensPerLanded = r.landed ? Math.round(r.tokens / r.landed) : null;
    r.unhealthy = r.sessions > lim.maxSessions && r.landed === 0;
    if (r.unhealthy) r.why = `${r.sessions} sessions in ${Math.round(lim.windowMs / 60000)} min and 0 landed (STUDIO_CREW_MAX_SESSIONS=${lim.maxSessions}): ${r.noCommit} with no commit, ${r.shortExits} short exit${r.shortExits === 1 ? '' : 's'} (under ${Math.round(lim.shortMs / 1000)} s), ${r.tokens.toLocaleString('en-US')} tokens for nothing landed`;
  }
  return out;
}

export const readPaused = () => readJson(PAUSED_FILE(), { roles: {}, since: {} }) || { roles: {}, since: {} };

/**
 * The supervisor's pass. waitingByRole: { role: [task ids waiting for it] } (new work clears a pause). Returns
 * { paused: { role: entry }, health, emitted: [types] }. dryRun: decides, writes nothing, emits nothing.
 */
export function crewPass({ events = null, now = Date.now(), env = process.env, waitingByRole = {}, dryRun = false, emit = emitEvent } = {}) {
  const lim = crewLimits(env);
  if (lim.off) return { paused: {}, health: {}, emitted: [] };
  const ev = events || readRecentEvents(20000);
  const st = readPaused();
  st.roles ||= {}; st.since ||= {};
  const emitted = [];
  const say = (e) => { if (!dryRun) emit(e); emitted.push(e.type); };
  let changed = false;
  // A decider's resume.
  const asks = readJson(RESUME_FILE(), {}) || {};
  for (const [role, ask] of Object.entries(asks)) {
    if (!st.roles[role]) continue;
    const was = st.roles[role];
    delete st.roles[role]; delete (st.auto ||= {})[role]; st.since[role] = now; changed = true;
    say({ type: 'crew.resumed', agent: String(ask.recordedBy || ask.by || 'unknown').slice(0, 60), to: 'producer', msg: `Launching ${role} again: ${ask.by} asked${ask.recordedBy && ask.recordedBy !== ask.by ? ` (recorded by ${ask.recordedBy}${ask.permission ? ` on their permission: "${String(ask.permission).slice(0, 120)}"` : ''})` : ''}${ask.why ? `: ${ask.why}` : ''} (paused since ${was.at}: ${was.why})`.slice(0, 600), meta: { role, by: ask.by, via: ask.via || null, recordedBy: ask.recordedBy || null, permission: ask.permission || null, why: ask.why || null, pausedAt: was.at } });
  }
  if (Object.keys(asks).length && !dryRun) fs.rmSync(RESUME_FILE(), { force: true });
  // The cause clears: a landing of the role's tasks since the pause, or new work for it.
  const sorted = [...ev].sort((a, b) => ts(a) - ts(b));
  for (const [role, p] of Object.entries(st.roles)) {
    const at = Date.parse(p.at) || 0;
    const landed = sorted.find((e) => ts(e) > at && ts(e) <= now && landingsOf(e).some((t) => (p.tasks || []).includes(t)));
    const fresh = (waitingByRole[role] || []).filter((t) => !(p.waiting || []).includes(t));
    const why = landed ? `${landingsOf(landed).find((t) => (p.tasks || []).includes(t))} landed` : fresh.length ? `new work for it: ${fresh.slice(0, 3).join(', ')}` : '';
    if (!why) continue;
    delete st.roles[role]; delete (st.auto ||= {})[role]; st.since[role] = now; changed = true;
    say({ type: 'crew.resumed', agent: 'supervisor', to: 'producer', msg: `Launching ${role} again: the cause cleared (${why}); paused since ${p.at}: ${p.why}`.slice(0, 600), meta: { role, by: 'supervisor', cleared: why, pausedAt: p.at } });
  }
  // 2.78.2 (c): a pause that has lasted STUDIO_CREW_BREAKER_RESUME_MIN resumes by itself when its evidence no longer
  // trips (as of now, with no restart of the window), or once per cause (the same tasks); a second trip stays.
  st.auto ||= {};
  if (lim.resumeMs > 0) {
    const raw = crewHealth(ev, { now, env, sinceByRole: {} });
    for (const [role, p] of Object.entries(st.roles)) {
      const at = Date.parse(p.at) || 0;
      if (now - at < lim.resumeMs) continue;
      const sig = [...(p.tasks || [])].sort().slice(0, 10).join(',');
      const cleared = !raw[role]?.unhealthy;
      if (!cleared && st.auto[role] === sig) continue;
      const how = cleared ? `its evidence no longer trips the breaker (${raw[role]?.sessions ?? 0} sessions, ${raw[role]?.landed ?? 0} landed in the last ${Math.round(lim.windowMs / 60000)} min)` : 'one retry for this cause (if it trips again on the same tasks it stays paused)';
      if (cleared) delete st.auto[role]; else st.auto[role] = sig;
      delete st.roles[role]; st.since[role] = now; changed = true;
      say({ type: 'crew.resumed', agent: 'supervisor', to: 'producer', msg: `Launching ${role} again: paused ${Math.round((now - at) / 60000)} min (STUDIO_CREW_BREAKER_RESUME_MIN=${Math.round(lim.resumeMs / 60000)}), ${how}; was: ${p.why}`.slice(0, 600), meta: { role, by: 'supervisor', auto: true, cleared, pausedAt: p.at } });
    }
  }
  const health = crewHealth(ev, { now, env, sinceByRole: st.since });
  for (const [role, r] of Object.entries(health)) {
    if (!r.unhealthy || st.roles[role] || role === 'unknown') continue;
    const entry = { at: new Date(now).toISOString(), why: r.why, evidence: { sessions: r.sessions, noCommit: r.noCommit, shortExits: r.shortExits, tokens: r.tokens, landed: r.landed, agents: r.agents.slice(-8), whys: r.whys }, tasks: r.tasks.slice(0, 40), waiting: (waitingByRole[role] || []).slice(0, 80) };
    st.roles[role] = entry; changed = true;
    say({ type: 'crew.unhealthy', agent: 'supervisor', to: 'producer', status: 'blocked', msg: `Not launching ${role}: ${r.why}${r.whys.length ? `. Last: ${r.whys[0]}` : ''}. Fix the cause (new or unblocked work clears it), or: npm run crew -- resume ${role} --by <name>`.slice(0, 700), meta: { role, ...entry.evidence, tasks: entry.tasks.slice(0, 10) } });
  }
  if (changed && !dryRun) writeJson(PAUSED_FILE(), st);
  return { paused: st.roles, health, emitted };
}

/** One line per paused role (digest, status --brief): [{ role, line }]. */
export function pausedLines(st = readPaused()) {
  return Object.entries(st?.roles || {}).map(([role, p]) => ({ role, line: `${role} paused since ${String(p.at).slice(11, 16)} UTC: ${p.evidence?.sessions ?? '?'} sessions/h, 0 landed (npm run crew -- resume ${role} --by <you>)` }));
}

/** `npm run crew -- resume <role> --by <name>`: record the ask; the supervisor's next pass resumes and says so. */
export async function resumeRole(role, { by, why = '', permission = '', env = process.env } = {}) {
  const r = String(role || '').trim();
  if (!r) return { code: 1, text: 'Usage: npm run crew -- resume <role> --by <name> [--why "…"] [--permission "…"]' };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, what: 'resume a role the crew watchdog paused' });
  if (!d.ok) return { code: 1, text: d.why };
  if (!readPaused().roles?.[r]) return { code: 0, text: `${r} isn't paused; nothing to resume.` };
  const asks = readJson(RESUME_FILE(), {}) || {};
  asks[r] = { by: d.by, via: d.via, recordedBy: d.recordedBy, permission: d.permission || null, why: String(why || '').slice(0, 300), at: new Date().toISOString() };
  writeJson(RESUME_FILE(), asks);
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'crew-resume', subject: r, by: d.by, as: dm.asOf(d), why: asks[r].why || `resume ${r}`, evidence: 'paused by the crew watchdog', undo: null }); } catch {}
  return { code: 0, text: `Asked the supervisor to launch ${r} again (${d.via}${d.via !== 'person' ? `, recorded by ${d.recordedBy}` : ''}); its next pass emits crew.resumed.` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'resume') {
    const r = await resumeRole(argv[1] && !argv[1].startsWith('--') ? argv[1] : '', { by: flag('by'), why: flag('why') || '', permission: flag('permission') || '' });
    (r.code ? console.error : console.log)(r.text);
    process.exit(r.code);
  }
  if (argv.length && !['--json'].includes(argv[0])) { console.error('Usage: npm run crew [-- --json] | npm run crew -- resume <role> --by <name> [--why "…"] [--permission "…"]'); process.exit(2); }
  const health = crewHealth(readRecentEvents(20000), { sinceByRole: readPaused().since || {} });
  const paused = readPaused().roles || {};
  if (argv.includes('--json')) { console.log(JSON.stringify({ health, paused }, null, 2)); process.exit(0); }
  const rows = Object.entries(health);
  console.log(rows.length ? rows.map(([role, r]) => `${role}: ${r.sessions} session(s), ${r.landed} landed, ${r.noCommit} no commit, ${r.shortExits} short exit(s), ${r.tokens.toLocaleString('en-US')} tokens${r.tokensPerLanded ? ` (${r.tokensPerLanded.toLocaleString('en-US')} per landed)` : ''}${r.unhealthy ? ' UNHEALTHY' : ''}`).join('\n') : 'No sessions in the window.');
  for (const l of pausedLines()) console.log(`Paused: ${l.line}`);
  process.exit(0);
}
