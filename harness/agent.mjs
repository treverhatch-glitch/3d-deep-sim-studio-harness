#!/usr/bin/env node
/**
 * harness/agent.mjs — start agents, watch them, and clean up when one dies.
 *
 *   npm run agent -- start --role builder --agent builder-1 --tool claude|codex|agy|cursor|grok|aider|custom --model <model>
 *                       [--fallback codex:gpt-6-sol,claude:claude-sonnet-5-5] [--detach]
 *   npm run agent -- list          who is running, last heartbeat, task, tool, model
 *   npm run agent -- stop <agent>  end one agent (it is cleaned up like any other exit)
 *   npm run agent -- fill          start agents for waiting tasks, within the mode's caps (the watcher runs this)
 *
 * What a start does:
 *   1. Refuses if the studio is stopped, the mode's caps are full, or the daily token cap is spent.
 *   2. Writes the agent's kickoff with its real model, and starts the tool with it: no shell quoting,
 *      the prompt goes in on stdin (or as one argument), so the same line works on Windows, macOS
 *      and Linux. STUDIO_<ROLE>_CMD (or STUDIO_AGENT_CMD) overrides it with your own command;
 *      {kickoff}, {agent}, {model} and {role} are filled in.
 *   3. Emits agent.session.start, then agent.heartbeat every 2 minutes while it runs, then
 *      agent.session.end with the exit code, a reason and the tokens it reported.
 *   4. When it ends badly (non-zero exit, usage limit, 429, auth error) while holding a task, it hands
 *      the task back with a note, saves the uncommitted changes under its claims to
 *      .studio/wip/<task>-<agent>.patch, and frees its claims. With --fallback it starts the next
 *      tool and model in the list on the same task.
 *
 * Tools and models per role come from --tool/--model, or STUDIO_<ROLE>_TOOL / STUDIO_<ROLE>_MODEL,
 * or STUDIO_AGENT_TOOL / STUDIO_AGENT_MODEL (.env). Output goes to .studio/agents/<agent>.log.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { kickoff } from './kickoff.mjs';
import { parseNextQueue, pauseTask, readStop, nextFor } from './task.mjs';
import { listLocks, release } from './lock.mjs';
import { effectiveMode } from './mode.mjs';

export const AGENTS_DIR = path.join(STUDIO_STATE_DIR, 'agents');
const WIP_DIR = path.join(STUDIO_STATE_DIR, 'wip');
const HEARTBEAT_MS = Number(process.env.STUDIO_HEARTBEAT_SEC || 120) * 1000;
const PROVIDER_TROUBLE = /usage limit|rate.?limit|\b429\b|quota|insufficient[_ ]credit|credit balance|unauthori[sz]ed|\b401\b|invalid api key|authentication|not supported when using|try again at/i;
const IS = { win: process.platform === 'win32', mac: process.platform === 'darwin' };

/** How each tool is started: an argv and whether the prompt goes on stdin. */
export function toolCommand(tool, { model, file, prompt, effort }) {
  const m = model && model !== 'unknown' ? model : null;
  switch (tool) {
    case 'claude':
      return { argv: ['claude', '-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash(node harness/*),Bash(node qa/*),Bash(node scripts/*),Bash(npm run *),Bash(npm test*),Bash(npx playwright *),Bash(git status*),Bash(git diff *),Bash(git add *),Bash(git commit *),Bash(git log *)', '--output-format', 'json', ...(m ? ['--model', m] : []), ...(effort ? ['--effort', effort] : [])], stdin: prompt };
    case 'codex': {
      // In a frozen test clone, Codex's sandbox can't write .git or bind 127.0.0.1 on macOS; the clone itself is the boundary.
      const bypass = process.env.STUDIO_CODEX_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      return { argv: ['codex', 'exec', '--json', ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']), ...(m ? ['-m', m] : []), '-'], stdin: prompt };
    }
    case 'agy':
      // agy prints nothing without a terminal: macOS script(1) is BSD (-q file cmd…), Linux is util-linux (-qc 'cmd').
      if (IS.win) return { argv: ['agy', '-p', prompt] };
      if (IS.mac) return { argv: ['script', '-q', '/dev/null', 'agy', '-p', prompt] };
      return { argv: ['script', '-qc', `agy -p "$(cat '${file}')"`, '/dev/null'] };
    case 'cursor':
      return { argv: ['agent', '-p', '--force', '--output-format', 'text', prompt] };
    case 'grok':
      return { argv: ['grok', '-p', prompt, ...(m ? ['-m', m] : []), '--output-format', 'json', '--always-approve'] };
    case 'aider':
      return { argv: ['aider', '--model', `ollama_chat/${m || process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b'}`, '--message-file', file, '--yes'] };
    default:
      return null;
  }
}

const roleKey = (role) => String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const sessionFile = (agent) => path.join(AGENTS_DIR, `${agent}.json`);
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Every agent session the launcher knows, with whether it is still running. */
export function sessions() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(AGENTS_DIR, f))).filter(Boolean).map((s) => {
    const running = s.status === 'running' && alive(s.supervisor || s.pid);
    const beatAge = s.lastBeat ? Math.round((Date.now() - Date.parse(s.lastBeat)) / 60000) : null;
    return { ...s, running, beatAgeMin: beatAge, stalled: running && beatAge !== null && beatAge > Math.max(5, (HEARTBEAT_MS / 60000) * 3) };
  });
}

function caps(role) {
  const mode = effectiveMode();
  const live = sessions().filter((s) => s.running);
  const ofRole = live.filter((s) => s.role === role).length;
  const perRole = mode.perRole[role] ?? Math.max(1, Math.floor(mode.maxAgents / 2));
  if (live.length >= mode.maxAgents) return { ok: false, why: `${live.length} agents already running; the ${mode.label}${mode.boost ? ' + MAX SPEED' : ''} mode allows ${mode.maxAgents}` };
  if (['producer', 'director'].includes(role) ? ofRole >= 1 : ofRole >= perRole) return { ok: false, why: `${ofRole} ${role} agent(s) already running; the mode allows ${['producer', 'director'].includes(role) ? 1 : perRole}` };
  return { ok: true, mode };
}

function spentToday() {
  const cap = Number(process.env.STUDIO_DAILY_TOKEN_CAP || 0);
  if (!cap) return { over: false };
  const today = new Date().toISOString().slice(0, 10);
  const used = readRecentEvents(50000).filter((e) => String(e.ts).startsWith(today)).reduce((n, e) => n + (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0), 0);
  return { over: used >= cap, used, cap };
}

/** The uncommitted changes under an agent's claims (or every change when it claimed nothing), as a patch. */
function savePatch(agent, taskId, claims) {
  const paths = claims.filter((k) => k.startsWith('path:')).map((k) => k.slice(5)).filter(Boolean);
  const scope = paths.length ? ['--', ...paths] : [];
  const tracked = spawnSync('git', ['diff', 'HEAD', ...scope], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '';
  const untracked = (spawnSync('git', ['ls-files', '--others', '--exclude-standard', ...scope], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout || '').split('\n').filter(Boolean);
  const extra = untracked.map((f) => spawnSync('git', ['diff', '--no-index', '--', '/dev/null', f], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout || '').join('');
  const patch = tracked + extra;
  if (!patch.trim()) return null;
  fs.mkdirSync(WIP_DIR, { recursive: true });
  const file = path.join(WIP_DIR, `${taskId || 'no-task'}-${agent}.patch`);
  fs.writeFileSync(file, patch);
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function tokensFrom(log) {
  const sum = (re) => [...log.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
  const tin = sum(/"input_tokens"\s*:\s*(\d+)/g) + sum(/"prompt_tokens"\s*:\s*(\d+)/g);
  const tout = sum(/"output_tokens"\s*:\s*(\d+)/g) + sum(/"completion_tokens"\s*:\s*(\d+)/g);
  const cost = [...log.matchAll(/"total_cost_usd"\s*:\s*([\d.]+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  return { tokensIn: tin, tokensOut: tout, costUsd: cost || null };
}

/** After an agent exits: record it, and if it died holding work, hand the work back cleanly. */
export function cleanUp(agent, { code, log = '', role, tool, model }) {
  const trouble = (log.match(PROVIDER_TROUBLE) || [])[0] || null;
  const bad = code !== 0 || Boolean(trouble);
  const mine = listLocks().filter((l) => l.owner === agent);
  const tasks = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
  const handed = [];
  if (bad && tasks.length) {
    for (const t of tasks) {
      const patch = savePatch(agent, t, mine.map((l) => l.key));
      const note = `${agent} (${tool}, ${model}) stopped: ${trouble ? `provider said "${trouble}"` : `exit code ${code}`}.${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'} Picked up by the launcher.`;
      pauseTask(t, agent, note, { force: true });
      handed.push({ task: t, patch });
    }
  }
  if (bad) for (const l of listLocks().filter((x) => x.owner === agent)) release(l.key, agent);
  const tok = tokensFrom(log);
  const reason = trouble ? `provider: ${trouble}` : code === 0 ? 'finished' : `exit ${code}`;
  emitEvent({ type: 'agent.session.end', agent, model, status: bad ? 'error' : 'ok', tokensIn: tok.tokensIn, tokensOut: tok.tokensOut, msg: `${agent} ended (${reason})${handed.length ? `; handed back ${handed.map((h) => h.task).join(', ')}` : ''}`, meta: { role, tool, code, reason, handed, costUsd: tok.costUsd } });
  const s = readJson(sessionFile(agent)) || {};
  fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, status: 'ended', endedAt: new Date().toISOString(), code, reason, handed, ...tok }, null, 2));
  return { bad, trouble, handed, reason };
}

/** Run one agent to the end, with heartbeats. Resolves with the cleanup result. */
export async function runAgent({ role, agent, tool, model, fallback = [], task = null }) {
  const prompt = kickoff({ role, agent, model }) + (task ? `\n\nStart with ${task}: node harness/task.mjs start ${task} --agent ${agent} --model ${model}\n` : '');
  const file = path.join(STUDIO_STATE_DIR, 'kickoff', `${agent}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prompt);
  const custom = process.env[`STUDIO_${roleKey(role)}_CMD`] || (tool === 'custom' ? process.env.STUDIO_AGENT_CMD : null);
  const effort = { 'every-build': 'high', systems: 'medium' }[effectiveMode().review] || null;
  const cmd = custom ? null : toolCommand(tool, { model, file, prompt, effort });
  if (!custom && !cmd) return { ok: false, message: `No launch command for tool "${tool}". Use --tool claude|codex|agy|cursor|grok|aider, or set STUDIO_${roleKey(role)}_CMD (with {kickoff}, {agent}, {model}).` };
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const logFile = path.join(AGENTS_DIR, `${agent}.log`);
  const out = fs.openSync(logFile, 'a');
  const env = { ...process.env, STUDIO_LOCK_OWNER: agent, STUDIO_AGENT_MODEL: model, STUDIO_ROLE: role };
  const fill = (s) => s.replaceAll('{kickoff}', file).replaceAll('{agent}', agent).replaceAll('{model}', model).replaceAll('{role}', role);
  const child = custom
    ? spawn(fill(custom), { cwd: REPO_ROOT, shell: true, env, stdio: ['ignore', out, out] })
    : spawn(cmd.argv[0], cmd.argv.slice(1), { cwd: REPO_ROOT, env, shell: IS.win, stdio: [cmd.stdin ? 'pipe' : 'ignore', out, out] });
  if (cmd?.stdin && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin);
  }
  const startedAt = new Date().toISOString();
  const session = { agent, role, tool: custom ? 'custom' : tool, model, pid: child.pid, supervisor: process.pid, status: 'running', startedAt, lastBeat: startedAt, log: path.relative(REPO_ROOT, logFile), task };
  fs.writeFileSync(sessionFile(agent), JSON.stringify(session, null, 2));
  emitEvent({ type: 'agent.session.start', agent, model, status: 'running', task, msg: `${agent} started (${role}, ${session.tool}, ${model})`, meta: { role, tool: session.tool, pid: child.pid } });
  const beat = setInterval(() => {
    const now = new Date().toISOString();
    const s = readJson(sessionFile(agent)) || session;
    fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, lastBeat: now }, null, 2));
    emitEvent({ type: 'agent.heartbeat', agent, model, status: 'running', msg: `${agent} alive` });
  }, HEARTBEAT_MS);
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `\n[launcher] could not start: ${err.message}\n`);
      resolve(127);
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
  clearInterval(beat);
  fs.closeSync(out);
  const log = fs.readFileSync(logFile, 'utf8').slice(-20000);
  const result = cleanUp(agent, { code, log, role, tool: session.tool, model });
  if (result.bad && fallback.length) {
    const [next, ...rest] = fallback;
    const [ftool, fmodel] = next.split(':');
    const resume = result.handed[0]?.task || task;
    emitEvent({ type: 'agent.failover', agent, to: 'producer', msg: `${agent} failed over to ${ftool}${fmodel ? ` (${fmodel})` : ''}${resume ? ` on ${resume}` : ''}` });
    return runAgent({ role, agent, tool: ftool, model: fmodel || model, fallback: rest, task: resume });
  }
  return { ok: true, code, ...result };
}

/** End an agent and anything it started (on Windows the agent runs under cmd.exe, so kill the tree). */
export function stopAgent(pid) {
  try {
    if (IS.win) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/** Start one agent, after the stop switch, caps and spend checks. */
export function startAgent(opts, { detach = false } = {}) {
  const { role, agent } = opts;
  if (!role || !agent) return { ok: false, message: 'Usage: npm run agent -- start --role <role> --agent <unique-name> --tool <tool> --model <model>' };
  if (readStop()) return { ok: false, message: 'The studio is stopped; resume it first (npm run task -- resume --by <name>).' };
  const already = sessions().find((s) => s.agent === agent && s.running);
  if (already) return { ok: false, message: `${agent} is already running (pid ${already.pid}).` };
  const c = caps(role);
  if (!c.ok) return { ok: false, message: `Not started: ${c.why}.` };
  const spend = spentToday();
  if (spend.over) return { ok: false, message: `Not started: the daily token cap is spent (${spend.used} of ${spend.cap}).` };
  const tool = opts.tool || process.env[`STUDIO_${roleKey(role)}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
  const model = opts.model || process.env[`STUDIO_${roleKey(role)}_MODEL`] || process.env.STUDIO_AGENT_MODEL || 'unknown';
  if (detach) {
    // A supervisor process of its own, so the agent outlives this command (the HUB and the watcher use this).
    const args = [fileURLToPath(import.meta.url), 'start', '--role', role, '--agent', agent, '--tool', tool, '--model', model, ...(opts.fallback?.length ? ['--fallback', opts.fallback.join(',')] : []), ...(opts.task ? ['--task', opts.task] : [])];
    const sup = spawn(process.execPath, args, { cwd: REPO_ROOT, detached: true, stdio: 'ignore', env: process.env });
    sup.unref();
    return { ok: true, detached: true, agent, role, tool, model, supervisor: sup.pid };
  }
  return { ok: true, run: runAgent({ ...opts, tool, model }) };
}

/** The watcher's job: start agents for waiting tasks while the mode allows it. */
export function fillAgents() {
  const mode = effectiveMode();
  if (!mode.autoLaunch) return { started: [], why: `${mode.label} doesn't start agents on its own` };
  if (readStop()) return { started: [], why: 'the studio is stopped' };
  const q = parseNextQueue();
  const started = [];
  const roles = [...new Set(q.backlog.map((t) => t.role).filter((r) => r && r !== 'human'))];
  for (const role of roles) {
    const launchable = process.env[`STUDIO_${roleKey(role)}_CMD`] || process.env[`STUDIO_${roleKey(role)}_TOOL`] || process.env.STUDIO_AGENT_TOOL;
    if (!launchable) continue;
    const { task } = nextFor({ role }, q);
    if (!task) continue;
    const n = sessions().filter((s) => s.role === role).length + 1;
    const r = startAgent({ role, agent: `${role}-auto-${n}`, task: task.id }, { detach: true });
    if (r.ok) started.push(`${r.agent} on ${task.id}`);
    else if (/caps|already running|allows/.test(r.message)) break;
  }
  if (started.length) emitEvent({ type: 'agent.auto_start', agent: 'watch', to: 'producer', msg: `Started ${started.join(', ')} (${mode.label}${mode.boost ? ' + MAX SPEED' : ''})` });
  return { started };
}

/**
 * A person did something in the War Room that an agent should act on now (a pitch, a message, a
 * confirmed brief, a design to change). Start that role's agent if none is running and the caps
 * allow it, even in paces that don't start agents on their own: a person asked. Returns `next`,
 * one plain sentence saying what happens now.
 */
export function wake(role, { task = null, why = '' } = {}) {
  const label = { rnd: 'R&D', producer: 'the Producer', director: 'the Director', art: 'the art department', builder: 'a builder', liaison: 'the Liaison' }[role] || role;
  const busy = sessions().find((s) => s.role === role && s.running);
  if (busy) return { started: false, next: `${label} (${busy.agent}) is running and picks ${task || 'it'} up from the queue${busy.task ? ` after ${busy.task}` : ''}.` };
  if (!launchableRoles([role]).length) return { started: false, next: `${task ? `Queued as ${task} for ${label}. ` : `Saved for ${label}. `}No tool is set to start ${label} on its own (STUDIO_AGENT_TOOL or STUDIO_${roleKey(role)}_TOOL in .env), so it waits until someone starts that agent (Start agent in Ops, or npm run agent).` };
  const n = sessions().filter((s) => s.role === role).length + 1;
  const r = startAgent({ role, agent: `${role}-${n}`, task }, { detach: true });
  if (!r.ok) return { started: false, next: `${task ? `Queued as ${task}. ` : ''}${label} didn't start: ${r.message.replace(/^Not started: /, '')} It starts when a slot frees.` };
  emitEvent({ type: 'agent.wake', agent: 'war-room', to: role, task, msg: `Started ${r.agent} (${label})${why ? ` for ${why}` : ''}` });
  return { started: true, agent: r.agent, next: `${label} is starting now as ${r.agent} (${r.tool}${r.model !== 'unknown' ? `, ${r.model}` : ''})${task ? ` on ${task}` : ''}. Watch it in Ops.` };
}

/** Which roles can start without a person (for preflight and the War Room). */
export function launchableRoles(roles = ['producer', 'director', 'builder', 'qa-playtester', 'rnd', 'planner', 'art', 'reviewer', 'liaison']) {
  return roles.filter((r) => process.env[`STUDIO_${roleKey(r)}_CMD`] || process.env[`STUDIO_${roleKey(r)}_TOOL`] || process.env.STUDIO_AGENT_TOOL || (r === 'director' && process.env.STUDIO_DIRECTOR_CMD));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const cmd = argv[0];
  if (cmd === 'start') {
    const r = startAgent({ role: flag('role'), agent: flag('agent'), tool: flag('tool'), model: flag('model'), fallback: (flag('fallback') || '').split(',').filter(Boolean), task: flag('task') }, { detach: argv.includes('--detach') });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    if (r.detached) {
      console.log(`${r.agent} started in the background (${r.tool}, ${r.model}). Output: .studio/agents/${r.agent}.log. npm run agent -- list`);
      process.exit(0);
    }
    const res = await r.run;
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`${flag('agent')} ended: ${res.reason}${res.handed?.length ? `; handed back ${res.handed.map((h) => `${h.task}${h.patch ? ` (work in ${h.patch})` : ''}`).join(', ')}` : ''}`);
    process.exit(res.bad ? 1 : 0);
  }
  if (cmd === 'stop') {
    const s = sessions().find((x) => x.agent === argv[1]);
    if (!s?.running) {
      console.error(`${argv[1] || '(no name)'} isn't running.`);
      process.exit(1);
    }
    stopAgent(s.pid);
    console.log(`Stopping ${s.agent}; the launcher hands its work back.`);
    process.exit(0);
  }
  if (cmd === 'fill') {
    const r = fillAgents();
    console.log(r.started.length ? `Started: ${r.started.join(', ')}` : `Nothing started${r.why ? `: ${r.why}` : ''}.`);
    process.exit(0);
  }
  const list = sessions();
  if (!list.length) console.log('No agents started by the launcher yet. npm run agent -- start --role builder --agent builder-1 --tool claude --model claude-sonnet-5-5');
  for (const s of list) console.log(`${s.running ? (s.stalled ? 'STALLED' : 'running') : 'ended  '}  ${s.agent.padEnd(18)} ${String(s.role).padEnd(14)} ${s.tool}/${s.model}${s.task ? `  ${s.task}` : ''}${s.running ? `  heartbeat ${s.beatAgeMin} min ago` : `  ${s.reason || ''}`}`);
  const mode = effectiveMode();
  console.log(`\nMode: ${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, up to ${mode.maxAgents} agents. Roles that can start on their own: ${launchableRoles().join(', ') || 'none (set STUDIO_AGENT_TOOL or STUDIO_<ROLE>_TOOL in .env)'}.`);
}
