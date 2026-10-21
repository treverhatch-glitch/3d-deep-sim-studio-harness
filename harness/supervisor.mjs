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
 *
 * Every minute it:
 *   1. keeps the War Room hub up (restarts it, and logs how long it was down);
 *   2. stops starting work outside the time window, past --until, past the budget, or while "Stop all" is on;
 *   3. starts agents for waiting work, one task per session: for each role (and lane) with waiting
 *      tasks and no agent on it, within the pace's caps, it starts a fresh agent on the next task. When
 *      a session ends, the next minute starts the next one. With --budget and the plan under its target
 *      (studio/budget.json), it allows up to two extra agents; over the target, none;
 *   4. skips a tool that ran out of quota until its reset and uses the next tool in the budget's order.
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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
  const { sessions, startAgent, launchableRoles, nextAgentName } = await import('./agent.mjs');
  const { holdReason, laneOf, lanesClash } = await import('./task-hold.mjs');
  const { effectiveMode } = await import('./mode.mjs');
  const { budgetStatus, pickTool } = await import('./budget.mjs');
  const { status: lockStatus } = await import('./lock.mjs');
  const why = [];
  if (fs.existsSync(STOP_FILE)) return { stop: true, started: [], why: ['studio:stop was asked'] };
  if (opts.until && now >= opts.until) return { stop: true, started: [], why: [`the time is up (${new Date(opts.until).toTimeString().slice(0, 5)})`] };
  if (readStop()) return { started: [], why: ['"Stop all agents" is on in the War Room'] };
  if (opts.window && !inWindow(opts.window, now)) return { started: [], why: [`outside the window ${opts.window}`] };
  // Two sessions in a row ending the same bad way (exit 127: the tool isn't on PATH) means starting
  // more won't help: stop starting, and ask a person once (Needs you). "Try again" clears it.
  const RESUME = path.join(STUDIO_STATE_DIR, 'supervisor-resume');
  if (fs.existsSync(RESUME)) {
    fs.rmSync(RESUME, { force: true });
    if (state.halted) emitEvent({ type: 'supervisor.resumed', agent: 'supervisor', to: 'producer', msg: 'Supervisor starting agents again' });
    state.halted = null;
    state.haltCheckFrom = now;
  }
  if (state.halted) return { started: [], why: [`halted: ${state.halted.why}`] };
  const mine = readRecentEvents(5000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= (state.haltCheckFrom || state.startedAt) && (state.names || []).includes(e.agent));
  const last2 = mine.slice(-2);
  if (last2.length === 2 && last2.every((e) => e.meta?.code && e.meta.code === last2[0].meta.code && (e.meta?.tool || '') === (last2[0].meta?.tool || ''))) {
    const code = last2[0].meta.code;
    const tool = last2[0].meta?.tool || 'the agent tool';
    const hint = code === 127 || code === 9009 ? `${tool} wasn't found: the supervisor's PATH doesn't include it (reinstall with npm run studio:start -- --install from a terminal where \`${tool}\` works)` : code === 126 ? `${tool} isn't executable` : `check npm run agent -- logs ${last2[1].agent}`;
    state.halted = { at: new Date(now).toISOString(), code, tool, why: `two sessions in a row ended with exit ${code} (${last2.map((e) => e.agent).join(', ')}): ${hint}` };
    emitEvent({ type: 'supervisor.halted', agent: 'supervisor', to: 'human', status: 'blocked', msg: `Supervisor stopped starting agents: ${state.halted.why}` });
    return { started: [], why: [`halted: ${state.halted.why}`] };
  }
  // Budget: tokens since the supervisor started, or a share of the plan's week (studio/budget.json).
  const st = budgetStatus(now);
  const spentHere = readRecentEvents(50000).filter((e) => e.type === 'agent.session.end' && Date.parse(e.ts) >= state.startedAt).reduce((n, e) => n + (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0), 0);
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
  const waiting = q.backlog.filter((t) => {
    if (!t.role || t.role === 'human' || lockStatus(`task:${t.id}`).locked) return false;
    const h = holdReason(t.id, q, now);
    if (h) held.push(`${t.id} ${h}`);
    return !h;
  });
  if (held.length) why.push(`held: ${held.slice(0, 4).join('; ')}${held.length > 4 ? ` (+${held.length - 4})` : ''}`);
  const evs = readRecentEvents(20000);
  const groups = new Map();
  for (const t of waiting) {
    // Lanes always count now: a task's own lane, `task lane`, or its --part (harness/task-hold.mjs).
    const lane = laneOf(t.id, evs) || null;
    const key = `${t.role}|${lane || ''}`;
    if (!groups.has(key)) groups.set(key, { role: t.role, lane, tasks: [] });
    groups.get(key).tasks.push(t);
  }
  const canStart = new Set(launchableRoles([...new Set(waiting.map((t) => t.role))]));
  const started = [];
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
    if (g.lane && lockStatus(`path:${g.lane}`).locked) {
      why.push(`lane ${g.lane} is held by ${lockStatus(`path:${g.lane}`).lock.owner}`);
      continue;
    }
    const preferred = process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
    const custom = process.env[`STUDIO_${g.role.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_CMD`];
    const tool = custom ? undefined : pickTool(preferred, now);
    if (!custom && !tool) {
      why.push(`${g.role}: every tool is out of quota (npm run budget)`);
      continue;
    }
    const agent = nextAgentName(g.role, 's');
    state.names = [...(state.names || []), agent].slice(-200);
    const r = startAgent({ role: g.role, agent, tool, task: g.tasks[0].id, lane: g.lane, oneTask: true, extra }, { detach: true });
    if (r.ok) {
      started.push(`${agent} on ${g.tasks[0].id}${g.lane ? ` in ${g.lane}` : ''}${tool && tool !== preferred ? ` (${tool}: ${preferred} is out of quota)` : ''}`);
      // Count it at once, so the next group in this pass sees it (a lane taken, or the whole game).
      live.push({ agent, role: g.role, lane: g.lane || null, running: true });
      room -= 1;
    } else why.push(`${g.role}: ${r.message}`);
  }
  if (!groups.size) why.push('no waiting tasks for agents');
  return { started, why };
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
  if (prev?.pid && prev.pid !== process.pid && alive(prev.pid) && prev.status === 'running') {
    console.error(`A supervisor is already running (pid ${prev.pid}). npm run studio:stop first.`);
    process.exit(1);
  }
  fs.rmSync(STOP_FILE, { force: true });
  const { parseNextQueue } = await import('./task.mjs');
  const state = { pid: process.pid, status: 'running', startedAt: Date.now(), opts: { ...opts, until: opts.until ? new Date(opts.until).toISOString() : null }, sessions: 0, doneAtStart: parseNextQueue().done.length, hubDown: [] };
  const port = Number(process.env.HUB_PORT || 3847);
  let hub = null;
  let downSince = null;
  const save = (extra = {}) => fs.writeFileSync(STATUS_FILE, `${JSON.stringify({ ...state, ...extra, startedAt: new Date(state.startedAt).toISOString(), lastLoop: new Date().toISOString(), tasksDone: parseNextQueue().done.length - state.doneAtStart }, null, 2)}\n`);
  emitEvent({ type: 'supervisor.start', agent: 'supervisor', to: 'producer', msg: `Supervisor running${opts.until ? ` until ${new Date(opts.until).toTimeString().slice(0, 5)}` : ''}${opts.window ? `, window ${opts.window}` : ''}${opts.budget ? `, budget ${budgetArg}` : ''}${opts.lanes ? `, lanes ${opts.lanes}` : ''}` });
  console.log(`[supervisor] running (pid ${process.pid}). npm run studio:stop to stop; agents finish their current task.`);
  let stopping = false;
  const finish = (why) => {
    if (stopping) return;
    stopping = true;
    state.status = 'stopped';
    state.stopReason = why;
    save();
    const mins = Math.round((Date.now() - state.startedAt) / 60000);
    emitEvent({ type: 'supervisor.stop', agent: 'supervisor', to: 'producer', msg: `Supervisor stopped (${why}) after ${mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`}: ${state.sessions} sessions started, ${parseNextQueue().done.length - state.doneAtStart} tasks done, ${(state.tokens || 0).toLocaleString()} tokens reported` });
    hub?.kill();
    setTimeout(() => process.exit(0), 300);
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
    if (s?.pid && alive(s.pid)) {
      try {
        process.kill(s.pid, 'SIGTERM');
      } catch {
        // it will see the stop file
      }
    }
    console.log('Supervisor stopping. Agents that are running finish their task; nothing new starts.');
    process.exit(0);
  }
  if (argv[0] === 'status') {
    const s = readStatus();
    console.log(s ? `${s.status === 'running' && alive(s.pid) ? 'Running' : 'Not running'} since ${s.startedAt}${s.stopReason ? `; stopped: ${s.stopReason}` : ''}. Sessions started: ${s.sessions}; tasks done: ${s.tasksDone}; tokens: ${(s.tokens || 0).toLocaleString()}. Last pass: ${s.last ? `${s.last.started.join(', ') || 'nothing started'}${s.last.why?.length ? ` (${s.last.why.join('; ')})` : ''}` : 'none'}${s.hubDown?.length ? `. Hub down: ${s.hubDown.map((d) => `${d.from.slice(11, 16)}-${d.to.slice(11, 16)}`).join(', ')}` : ''}` : 'The supervisor has not run here yet: npm run studio:start');
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
    if (prev?.pid && alive(prev.pid) && prev.status === 'running') {
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
