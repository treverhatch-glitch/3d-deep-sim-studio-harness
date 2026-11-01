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
 * Status: .studio/supervisor.json, the War Room's Ops view, and the run report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { selfIdentity, pidAlive, pidExists, readStarts, sameProcess } from './proc-identity.mjs';

export const STATUS_FILE = path.join(STUDIO_STATE_DIR, 'supervisor.json');
const STOP_FILE = path.join(STUDIO_STATE_DIR, 'supervisor-stop');
const LOOP_MS = Number(process.env.STUDIO_SUPERVISOR_SEC || 60) * 1000;
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
  if (!s || s.status !== 'running' || !alive(s)) return { code: 0, text: `Not halted: no supervisor is running${s?.status === 'running' ? ' (its process is gone)' : ''}, so there is nothing to clear. npm run studio:start starts a fresh one.` };
  if (!s.halted) return { code: 0, text: 'Not halted: the supervisor is starting agents; nothing to clear.' };
  const note = String(why || '').trim().slice(0, 300);
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  const permRec = onPerm && onPerm.via !== 'person' ? { permission: perm.slice(0, 300), recordedBy: onPerm.recordedBy } : {};
  fs.writeFileSync(RESUME, `${JSON.stringify({ by: who.slice(0, 60), why: note, via: 'cli', at: new Date().toISOString(), ...permRec })}\n`);
  emitEvent({ type: 'supervisor.resume_asked', agent: who.slice(0, 60), to: 'supervisor', msg: `${who} asked the supervisor to try again${permRec.recordedBy ? ` (recorded by ${permRec.recordedBy} on ${who}'s permission: "${permRec.permission.slice(0, 120)}")` : ''}${note ? `: ${note}` : ''} (it stopped: ${s.halted.why || 'see npm run studio:status'})`.slice(0, 600), meta: { ...permRec, by: who.slice(0, 60), why: note || null, via: 'cli', cleared: s.halted.why || null } });
  return { code: 0, text: `Cleared the halt (${s.halted.why || 'no reason recorded'}). The supervisor starts agents again on its next pass (within ${Math.round(LOOP_MS / 1000)} s); its supervisor.resumed event names ${who}.` };
}
// PU-17 (P-039, P-045): a status record's supervisor is alive while its pid is in use (no OS query); on Linux the
// /proc start written at its start must match too, so a status file left "running" by a crash or a reboot that
// names a reused number reads as not running.
const alive = (st) => Boolean(st?.pid) && pidAlive(st.pid, st.identity, { eperm: false });

/** "23:00" (today, or tomorrow if past), "8h", "90m", or an ISO time. */
export function parseUntil(s, now = Date.now()) {
  if (!s) return null;
  const rel = String(s).match(/^(\d+(?:\.\d+)?)\s*(h|m|s)$/i);
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

/** One pass: what to start now, and why nothing else. Pure decision + the starts; the loop calls it. */
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
  if (opts.until && now >= opts.until) return { stop: true, started: [], why: [`the time is up (${new Date(opts.until).toTimeString().slice(0, 5)})`] };
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
  // PU-19: a session that stopped at its usage limit waits for the reset (its tool is marked out); it isn't a bad end.
  // 2.58.3 (N1): nor is a session a person (or the Producer) stopped or paused: killing it ends it with exit 1 on
  // Windows (taskkill /F) and by a signal elsewhere; the launcher records who stopped it (meta.stoppedBy).
  const mine = readRecentEvents(5000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= (state.haltCheckFrom || state.startedAt) && (state.names || []).includes(e.agent) && !e.meta?.usageLimit && !e.meta?.stoppedBy);
  const last2 = mine.slice(-2);
  if (last2.length === 2 && last2.every((e) => e.meta?.code && e.meta.code === last2[0].meta.code && (e.meta?.tool || '') === (last2[0].meta?.tool || ''))) {
    const code = last2[0].meta.code;
    // Name the program, not "custom" (test #2): the first word of STUDIO_<ROLE>_CMD or STUDIO_AGENT_CMD.
    const metaTool = last2[0].meta?.tool || 'the agent tool';
    const roleOf = String(last2[0].meta?.role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    const tool = metaTool === 'custom' ? String(process.env[`STUDIO_${roleOf}_CMD`] || process.env.STUDIO_AGENT_CMD || 'the custom command').trim().split(/\s+/)[0].replace(/^["']|["']$/g, '') : metaTool;
    // A program that isn't on the PATH: exit 127 (9009, or 1 under cmd.exe on Windows), or one `which` can't find.
    const missing = code === 127 || code === 9009 || (/^[\w.-]+$/.test(tool) && spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { encoding: 'utf8' }).status !== 0);
    const hint = missing ? `${tool} wasn't found: the supervisor's PATH doesn't include it (reinstall with npm run studio:start -- --install from a terminal where \`${tool}\` works)` : code === 126 ? `${tool} isn't executable` : `check npm run agent -- logs ${last2[1].agent}`;
    state.halted = { at: new Date(now).toISOString(), code, tool, why: `two sessions in a row ended with exit ${code} (${last2.map((e) => e.agent).join(', ')}): ${hint}`, ...(metaTool === 'custom' ? { custom: true } : {}), ...(missing ? { missing: true } : {}) };
    emitEvent({ type: 'supervisor.halted', agent: 'supervisor', to: 'human', status: 'blocked', msg: `Supervisor stopped starting agents: ${state.halted.why}` });
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
    return { started: [], why: [`halted: ${state.halted.why}`] };
  }
  // Budget: tokens since the supervisor started, or a share of the plan's week (studio/budget.json).
  const st = budgetStatus(now);
  const { weightedTokens } = await import('./budget.mjs');
  const spentHere = Math.round(readRecentEvents(50000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= state.startedAt).reduce((n, e) => n + weightedTokens(e), 0));
  state.tokens = spentHere;
  if (opts.budget?.tokens && spentHere >= opts.budget.tokens) return { stop: true, started: [], why: [`the budget is spent (${spentHere.toLocaleString()} of ${opts.budget.tokens.toLocaleString()} tokens)`] };
  const known = st.filter((t) => t.weekly);
  if (opts.budget?.share && known.length && known.every((t) => t.pct >= opts.budget.share)) return { stop: true, started: [], why: [`the plan reached ${Math.round(opts.budget.share * 100)}% of the week`] };
  const over = known.length && known.every((t) => t.verdict === 'over');
  const under = known.some((t) => t.verdict === 'under');
  if (over) return { started: [], why: ['every tool is over its target for this point in the week: slowing down'] };
  const mode = effectiveMode();
  const extra = opts.budget && under ? 2 : 0;
  const live = sessions().filter((s) => s.running);
  let room = Math.min(12, mode.maxAgents + extra) - live.length;
  if (room <= 0) return { started: [], why: [`${live.length} agents running, the cap (${mode.label}${extra ? ' + 2 for the budget' : ''})`] };
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
    let h = holdReason(t.id, q, now);
    if (!h) {
      const a = claimActive(t.id, { root: mainRoot(), now, events: (claimEvents ||= readRecentEvents(20000)), orphaned: true });
      if (a.busy) h = `waits for ${a.owner}: ${a.why}`;
    }
    if (h) held.push(`${t.id} ${h}`);
    return !h;
  });
  if (held.length) why.push(`held: ${held.slice(0, 4).join('; ')}${held.length > 4 ? ` (+${held.length - 4})` : ''}`);
  const evs = readRecentEvents(20000);
  const groups = new Map();
  const floorsConfig = readJson(path.join(REPO_ROOT, 'studio', 'floors.json'));
  const gameCartridge = readJson(path.join(REPO_ROOT, 'studio', 'game.json'))?.cartridge ?? readJson(path.join(REPO_ROOT, 'studio', 'gates.json'))?.cartridge;
  const { taskType } = await import('./done-check.mjs');

  for (const t of waiting) {
    // Lanes always count now: a task's own lane, `task lane`, or its --part (harness/task-hold.mjs).
    let lane = laneOf(t.id, evs) || null;
    if (!lane && floorsConfig && gameCartridge && ['change', 'system'].includes(taskType(t))) {
      const meta = evs.find((e) => e.task === t.id && e.type === 'task.added')?.meta;
      if (meta?.phase) {
        lane = `cartridges/${gameCartridge}/floors/phase-${meta.phase}`;
      }
    }
    const key = `${t.role}|${lane || ''}`;
    if (!groups.has(key)) groups.set(key, { role: t.role, lane, tasks: [] });
    groups.get(key).tasks.push(t);
  }
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
  const started = [];
  let ram = null;
  // Most urgent first; the dev hacker only gets a slot nobody else needs (it never holds anything up).
  const ordered = [...groups.values()].sort((a, b) => (a.role === 'dev-hacker') - (b.role === 'dev-hacker') || String(a.tasks[0].priority).localeCompare(String(b.tasks[0].priority)));
  for (const g of ordered) {
    if (room <= 0) break;
    if (!canStart.has(g.role)) {
      why.push(`${g.role}: no tool set to start it (STUDIO_AGENT_TOOL or STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL)`);
      continue;
    }
    // Builders (and any role whose work has a lane) never share files: a builder with no lane holds
    // the whole game, so nothing else in that role runs beside it, and two lanes must not overlap.
    const sameRole = live.filter((s) => s.role === g.role);
    const codeRole = g.role === 'builder' || Boolean(g.lane) || sameRole.some((s) => s.lane);
    if (codeRole) {
      const clash = sameRole.find((s) => lanesClash(s.lane || null, g.lane || null));
      if (clash) {
        if (sameRole.length) why.push(`${g.role}${g.lane ? ` in ${g.lane}` : ''}: ${clash.agent} is working ${clash.lane ? `in ${clash.lane}` : 'on the whole game (no lane)'}`);
        continue;
      }
    }
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
    const agent = nextAgentName(g.role, opts.prefix || 's');
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
    const r = startAgent({ role: g.role, agent, tool, task: g.tasks[0].id, lane: g.lane, oneTask: true, extra }, { detach: true });
    if (r.ok) {
      started.push(`${agent} on ${g.tasks[0].id}${g.lane ? ` in ${g.lane}` : ''}${tool && tool !== preferred ? ` (${tool}: ${preferred} is out of quota)` : ''}`);
      // Count it at once, so the next group in this pass sees it (a lane taken, or the whole game).
      live.push({ agent, role: g.role, lane: g.lane || null, task: taskId, running: true });
      if (g.role === 'producer') (await import('./producer-wake.mjs')).producerLaunched(now);
      room -= 1;
    } else why.push(`${g.role}: ${r.message}`);
  }
  if (!groups.size) why.push('no waiting tasks for agents');
  return { started, why };
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

function hubUp(port) {
  return fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
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
  let downSince = null;
  const save = (extra = {}) => fs.writeFileSync(STATUS_FILE, `${JSON.stringify({ ...state, ...extra, startedAt: new Date(state.startedAt).toISOString(), lastLoop: new Date().toISOString(), tasksDone: parseNextQueue().done.length - state.doneAtStart }, null, 2)}\n`);
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
  const tick = async () => {
    if (stopping) return;
    // 1. The hub: up, or restart it and remember how long it was down.
    if (opts.hub && !(await hubUp(port))) {
      if (!downSince) downSince = Date.now();
      if (!hub || hub.exitCode !== null) {
        const log = fs.openSync(path.join(STUDIO_STATE_DIR, 'hub.log'), 'a');
        hub = spawn(process.execPath, [path.join(REPO_ROOT, 'hub', 'server.mjs')], { cwd: REPO_ROOT, stdio: ['ignore', log, log], env: process.env });
      }
    } else if (downSince) {
      if (Date.now() - downSince > LOOP_MS) {
        state.hubDown.push({ from: new Date(downSince).toISOString(), to: new Date().toISOString() });
        emitEvent({ type: 'supervisor.hub_restarted', agent: 'supervisor', to: 'producer', msg: `The War Room hub was down from ${new Date(downSince).toTimeString().slice(0, 5)} to ${new Date().toTimeString().slice(0, 5)}; restarted` });
      }
      downSince = null;
    }
    // 2-4. Work.
    const r = await supervise(opts, state).catch((err) => ({ started: [], why: [`error: ${err.message}`] }));
    state.sessions += r.started.length;
    state.last = { at: new Date().toISOString(), started: r.started, why: r.why.slice(0, 6) };
    if (r.started.length) emitEvent({ type: 'supervisor.started', agent: 'supervisor', to: 'producer', msg: `Started ${r.started.join(', ')}` });
    // 2.30h (2): the Director's flow pass sees what the supervisor couldn't start, and why (no model, no tokens).
    await import('./director-flow.mjs').then(({ flowPass }) => flowPass({ fill: false, launcherWhy: r.why, throttleMs: 55000 })).catch(() => {});
    save();
    if (r.stop) finish(r.why[0]);
  };
  await tick();
  setInterval(tick, LOOP_MS);
}

/** Start at login: launchd on macOS, systemd --user on Linux, Task Scheduler on Windows. */
/**
 * The node to run at login: the one on this terminal's PATH (run #1: process.execPath was a node bundled
 * inside another app), unless STUDIO_NODE says otherwise.
 */
export function loginNode() {
  if (process.env.STUDIO_NODE) return process.env.STUDIO_NODE;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' });
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
  const has = spawnSync(process.platform === 'win32' ? 'where' : 'which', [tool], { encoding: 'utf8' });
  const warn = has.status === 0 ? '' : `\nWarning: \`${tool}\` isn't on this terminal's PATH, so the supervisor won't find it either. Run this from a terminal where \`${tool} --version\` works.`;
  if (process.platform === 'darwin') {
    const label = `com.studio.${slug}`;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (remove) {
      spawnSync('launchctl', ['unload', '-w', plist]);
      fs.rmSync(plist, { force: true });
      return `Removed ${plist}`;
    }
    const xml = launchdPlist({ label, node, args });
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    spawnSync('launchctl', ['unload', '-w', plist]);
    fs.writeFileSync(plist, xml);
    spawnSync('launchctl', ['load', '-w', plist]);
    return `Installed ${plist} (node ${node}, this terminal's PATH and HOME): the supervisor starts at login and after a restart. Remove: npm run studio:start -- --uninstall${warn}`;
  }
  if (process.platform === 'win32') {
    const name = `Studio ${slug}`;
    if (remove) {
      spawnSync('schtasks', ['/Delete', '/F', '/TN', name]);
      return `Removed the scheduled task "${name}"`;
    }
    const cmd = [node, ...args].map((a) => `"${a}"`).join(' ');
    const r = spawnSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', name, '/TR', cmd], { encoding: 'utf8' });
    return r.status === 0 ? `Installed the scheduled task "${name}": the supervisor starts when you log in. Remove: npm run studio:start -- --uninstall${warn}` : `Task Scheduler said: ${r.stderr || r.stdout}`;
  }
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', `studio-${slug}.service`);
  if (remove) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `studio-${slug}.service`]);
    fs.rmSync(unit, { force: true });
    return `Removed ${unit}`;
  }
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, `[Unit]\nDescription=Game studio supervisor (${slug})\n\n[Service]\nWorkingDirectory=${REPO_ROOT}\nEnvironment="PATH=${process.env.PATH || ''}" "HOME=${process.env.HOME || os.homedir()}"\nExecStart=${[node, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\nRestart=on-failure\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n`);
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  spawnSync('systemctl', ['--user', 'enable', '--now', `studio-${slug}.service`]);
  return `Installed ${unit} (systemd --user, this terminal's PATH): the supervisor starts at login. Keep it running while logged out: loginctl enable-linger $USER. Remove: npm run studio:start -- --uninstall${warn}`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'stop') {
    fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    const s = readStatus();
    // PU-17 (P-039): signal the pid only while it is still the supervisor: its start time, read from the OS once
    // now, against the one in supervisor.json. Unreadable, or a status file from before PU-17: signalled only if
    // its last loop is recent; otherwise the number may be another program's by now. Either way the stop file
    // above stops a real supervisor at its next loop.
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
  if (argv[0] === 'status') {
    const s = readStatus();
    console.log(s ? `${s.status === 'running' && alive(s) ? 'Running' : 'Not running'} since ${s.startedAt}${s.stopReason ? `; stopped: ${s.stopReason}` : ''}. Sessions started: ${s.sessions}; tasks done: ${s.tasksDone}; tokens: ${(s.tokens || 0).toLocaleString()}. Last pass: ${s.last ? `${s.last.started.join(', ') || 'nothing started'}${s.last.why?.length ? ` (${s.last.why.join('; ')})` : ''}` : 'none'}${s.hubDown?.length ? `. Hub down: ${s.hubDown.map((d) => `${d.from.slice(11, 16)}-${d.to.slice(11, 16)}`).join(', ')}` : ''}` : 'The supervisor has not run here yet: npm run studio:start');
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
}
