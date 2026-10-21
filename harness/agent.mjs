#!/usr/bin/env node
/**
 * harness/agent.mjs — start agents, watch them, and clean up when one dies.
 *
 *   npm run agent -- start --role builder --agent builder-1 --tool claude|codex|agy|cursor|grok|aider|custom --model <model>
 *                       [--fallback codex:gpt-6-sol,claude:claude-sonnet-5-5] [--task T-012] [--lane <folder>] [--one-task] [--detach]
 *   npm run agent -- now "<what I'm doing>"   an agent's one-line status, shown with its heartbeat in the War Room
 *   npm run agent -- hire --role <role> [--division sound] [--task T-012 | --next] [--lane <folder>] [--note "…"]
 *                        [--loop until-empty|N] [--by <producer or person>] [--open]   the same as start, as a hire:
 *                        the Producer hires on its own up to studio/budget.json producerMayHireUpTo (default 4), past
 *                        that the game dev is asked; --open switches the division on
 *   npm run agent -- pause <agent> [--note "…"]   its task goes back to the queue, then it stops
 *   npm run agent -- logs <agent> [--tail 60]
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
import { listLocks, release, claim } from './lock.mjs';
import { effectiveMode } from './mode.mjs';
import { markExhausted } from './budget.mjs';
import { cooldown } from './task-hold.mjs';

export const AGENTS_DIR = path.join(STUDIO_STATE_DIR, 'agents');
const WIP_DIR = path.join(STUDIO_STATE_DIR, 'wip');
const HEARTBEAT_MS = Number(process.env.STUDIO_HEARTBEAT_SEC || 120) * 1000;
// Only a real limit or auth error counts (run #1: a normal end_turn and selftest output that mentioned
// "quota" marked tools out and idled the studio for an hour). Read the end of a failed session, or a
// final result object that says it is an error; never the agent's whole transcript.
const QUOTA_ERROR = /usage limit (?:reached|exceeded|hit)|(?:hit|reached) (?:your|the) (?:usage |rate )?limit|\b429\b|too many requests|rate[ _-]?limit(?:ed| exceeded| reached| error)|quota (?:exceeded|exhausted)|insufficient[_ ]quota|credit balance is too low|insufficient[_ ]credits?|out of (?:credits|quota)/i;
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid (?:api|x-api) key|authentication (?:failed|error|required)|not logged in|please (?:run )?\/?login/i;
export function providerTrouble(log, code) {
  const lines = String(log || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // A final result object (claude stream-json, codex --json) decides when there is one.
  for (const l of lines.slice(-40).reverse()) {
    if (!l.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type === 'result' || o.type === 'turn.failed' || o.type === 'error') {
      const err = o.is_error === true || o.type !== 'result' || /error/i.test(String(o.subtype || ''));
      if (!err) return null;
      const text = JSON.stringify(o.result ?? o.error ?? o.message ?? o).slice(0, 400);
      const q = text.match(QUOTA_ERROR);
      if (q) return { kind: 'quota', text: q[0], line: text };
      const au = text.match(AUTH_ERROR);
      return au ? { kind: 'auth', text: au[0], line: text } : null;
    }
  }
  if (code === 0) return null;
  // A failed session without a result object: only its last lines, and never a line reporting an allowed status.
  for (const l of lines.slice(-30).reverse()) {
    if (/"status"\s*:\s*"allowed"|rate_limit_event/.test(l)) continue;
    // The line has to read as an error from the tool, not text the agent wrote or read.
    if (!/\berror\b|\bfailed\b|too many requests|\b429\b|\b401\b|usage limit reached|hit your (?:usage )?limit|invalid api key|not logged in/i.test(l)) continue;
    const q = l.match(QUOTA_ERROR);
    if (q) return { kind: 'quota', text: q[0], line: l };
    const au = l.match(AUTH_ERROR);
    if (au) return { kind: 'auth', text: au[0], line: l };
  }
  return null;
}
const IS = { win: process.platform === 'win32', mac: process.platform === 'darwin' };

/** How each tool is started: an argv and whether the prompt goes on stdin. */
export function toolCommand(tool, { model, file, prompt, effort }) {
  const m = model && model !== 'unknown' ? model : null;
  switch (tool) {
    case 'claude': {
      // Builders need Playwright, vite, ffmpeg and asset tools too (run #1: a narrow list failed silently).
      // In a frozen test clone, STUDIO_CLAUDE_BYPASS=1 skips permission prompts entirely; the clone is the boundary.
      const bypass = process.env.STUDIO_CLAUDE_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      const allowed = 'Bash(node *),Bash(npm *),Bash(npx *),Bash(ffmpeg *),Bash(blender *),Bash(git status*),Bash(git diff *),Bash(git add *),Bash(git commit *),Bash(git log *),Bash(git show *),Bash(ls *),Bash(mkdir *),Bash(cp *),Bash(mv *)';
      return { argv: ['claude', '-p', ...(bypass ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', allowed]), '--output-format', 'json', ...(m ? ['--model', m] : []), ...(effort ? ['--effort', effort] : [])], stdin: prompt };
    }
    case 'codex': {
      // In a frozen test clone, Codex's sandbox can't write .git or bind 127.0.0.1 on macOS; the clone itself is the boundary.
      const bypass = process.env.STUDIO_CODEX_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      return { argv: ['codex', 'exec', '--json', ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']), ...(m ? ['-m', m] : []), '-'], stdin: prompt };
    }
    case 'agy': {
      // From run #1: agy exits with "I'll report back" before it finishes unless it has a print timeout
      // and stdin is closed; no script(1) wrapper needed. In a frozen test clone it may skip its own
      // permission prompts (STUDIO_AGY_BYPASS=1), since nobody is there to answer them.
      const bypass = process.env.STUDIO_AGY_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      return { argv: ['agy', '-p', prompt, '--print-timeout', '900s', ...(bypass ? ['--dangerously-skip-permissions'] : [])] };
    }
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

// extra: the supervisor's budget allowance (up to two more agents while the plan is under its target).
function caps(role, extra = 0) {
  const mode = { ...effectiveMode() };
  mode.maxAgents = Math.min(12, mode.maxAgents + extra);
  const live = sessions().filter((s) => s.running);
  const ofRole = live.filter((s) => s.role === role).length;
  const perRole = (mode.perRole[role] ?? Math.max(1, Math.floor(mode.maxAgents / 2))) + (extra ? 1 : 0);
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
  const t = providerTrouble(log, code);
  const trouble = t?.text || null;
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
  // Out of quota: remember until when, so the supervisor moves this tool's lanes to the next tool.
  // STUDIO_QUOTA_SKIP=off: usage is watched outside the harness, so never skip a tool for quota.
  if (t?.kind === 'quota' && !/^(off|0|false|no)$/i.test(process.env.STUDIO_QUOTA_SKIP || '')) {
    const line = log.split('\n').slice(-30).reverse().find((l) => /reset|try again/i.test(l) && QUOTA_ERROR.test(l)) || t.line;
    markExhausted(tool, line);
  }
  const tok = tokensFrom(log);
  const reason = trouble ? `provider: ${trouble}` : code === 0 ? 'finished' : `exit ${code}`;
  emitEvent({ type: 'agent.session.end', agent, model, status: bad ? 'error' : 'ok', tokensIn: tok.tokensIn, tokensOut: tok.tokensOut, msg: `${agent} ended (${reason})${handed.length ? `; handed back ${handed.map((h) => h.task).join(', ')}` : ''}`, meta: { role, tool, code, reason, handed, costUsd: tok.costUsd } });
  const s = readJson(sessionFile(agent)) || {};
  fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, status: 'ended', endedAt: new Date().toISOString(), code, reason, handed, ...tok }, null, 2));
  return { bad, trouble, handed, reason };
}

/** Run one agent to the end, with heartbeats. Resolves with the cleanup result. */
export async function runAgent({ role, agent, tool, model, fallback = [], task = null, lane = null, oneTask = false, division = null, note = '', by = null }) {
  // A lane is a folder this agent owns for the session, so two agents never edit the same files.
  if (lane) {
    const c = claim(`path:${lane}`, agent, 6 * 3600);
    if (c && c.ok === false) return { ok: false, message: `Lane ${lane} is taken: ${c.message || 'claimed by another agent'}` };
  }
  const prompt = kickoff({ role, agent, model })
    + (task ? `\n\nStart with ${task}: node harness/task.mjs start ${task} --agent ${agent} --model ${model}\n` : '')
    + (lane ? `\nYour lane is \`${lane}\` (claimed for you): edit files only under it. Work outside it goes to the Producer as a task.\n` : '')
    + `\nEvery few minutes, say what you are doing in one line: npm run agent -- now "<what you are doing>". The War Room shows it with your work in progress.\n`
    + (oneTask ? `\nDo this one task, finish it (task done) or hand it back with a note, then stop. A fresh session starts for the next task, so you never carry a long history.\n` : '')
    + (note ? `\nNote from ${by || 'the Producer'}: ${note}\n` : '');
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
  const fill = (s) => s.replaceAll('{kickoff}', file).replaceAll('{agent}', agent).replaceAll('{model}', model).replaceAll('{role}', role).replaceAll('{task}', task || '');
  const child = custom
    ? spawn(fill(custom), { cwd: REPO_ROOT, shell: true, env, stdio: ['ignore', out, out] })
    : spawn(cmd.argv[0], cmd.argv.slice(1), { cwd: REPO_ROOT, env, shell: IS.win, stdio: [cmd.stdin ? 'pipe' : 'ignore', out, out] });
  if (cmd?.stdin && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin);
  }
  const startedAt = new Date().toISOString();
  const session = { agent, role, tool: custom ? 'custom' : tool, model, pid: child.pid, supervisor: process.pid, status: 'running', startedAt, lastBeat: startedAt, log: path.relative(REPO_ROOT, logFile), task, lane, oneTask, division, hiredBy: by };
  fs.writeFileSync(sessionFile(agent), JSON.stringify(session, null, 2));
  emitEvent({ type: 'agent.session.start', agent, model, status: 'running', task, msg: `${agent} started (${role}, ${session.tool}, ${model})${by ? `, hired by ${by}` : ''}${division ? ` into ${division}` : ''}`, meta: { role, tool: session.tool, pid: child.pid, division, hiredBy: by, lane } });
  const beat = setInterval(() => {
    const now = new Date().toISOString();
    const s = readJson(sessionFile(agent)) || session;
    const wip = wipSummary(agent);
    fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, lastBeat: now, wip }, null, 2));
    emitEvent({ type: 'agent.heartbeat', agent, model, status: 'running', msg: `${agent} alive${wip ? `: ${wip}` : ''}${s.now ? ` (now: ${s.now})` : ''}` });
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
  if (lane) release(`path:${lane}`, agent);
  if (result.bad && fallback.length) {
    const [next, ...rest] = fallback;
    const [ftool, fmodel] = next.split(':');
    const resume = result.handed[0]?.task || task;
    emitEvent({ type: 'agent.failover', agent, to: 'producer', msg: `${agent} failed over to ${ftool}${fmodel ? ` (${fmodel})` : ''}${resume ? ` on ${resume}` : ''}` });
    return runAgent({ role, agent, tool: ftool, model: fmodel || model, fallback: rest, task: resume, lane, oneTask, division, note, by });
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

/**
 * Work in progress, for the heartbeat: uncommitted changes under the agent's path claims (or, with
 * no path claims, the files its task's commits touched), and when the last verify ran. Cheap: git only.
 */
export function wipSummary(agent) {
  const paths = listLocks().filter((l) => l.owner === agent && l.key.startsWith('path:')).map((l) => l.key.slice(5));
  const r = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', ...(paths.length ? paths : ['.'])], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const rows = r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([, , f]) => f && !/^(studio\/(NEXT|CURRENT_TASK)\.md|\.studio\/)/.test(f));
  const add = rows.reduce((n, [a]) => n + (Number(a) || 0), 0);
  const del = rows.reduce((n, [, d]) => n + (Number(d) || 0), 0);
  const top = rows.sort((x, y) => Number(y[0]) + Number(y[1]) - Number(x[0]) - Number(x[1])).slice(0, 2).map(([a, d, f]) => `${f.split('/').pop()} +${a}/−${d}`);
  let verify = '';
  try {
    const g = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'gates-last.json'), 'utf8'));
    const min = Math.round((Date.now() - Date.parse(g.at)) / 60000);
    if (min < 240) verify = `, last verify ${min} min ago${g.rows?.some((x) => x.required && !x.ok) ? ' (red)' : ''}`;
  } catch {
    // none yet
  }
  return rows.length ? `${rows.length} file${rows.length === 1 ? '' : 's'} changed +${add}/−${del}${paths.length ? '' : ' (whole tree)'} (${top.join(', ')})${verify}` : `no uncommitted changes${verify}`;
}

/** An agent says what it is doing now; the War Room shows it next to its heartbeat. */
export function sayNow(agent, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!agent || !t) return { ok: false, message: 'npm run agent -- now "<what you are doing>" (with STUDIO_LOCK_OWNER set)' };
  const s = readJson(sessionFile(agent));
  if (s) fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, now: t, nowAt: new Date().toISOString() }, null, 2));
  emitEvent({ type: 'agent.now', agent, msg: t });
  return { ok: true };
}

const isAgentName = (by) => /^(prod|producer|director|builder|rnd|qa|reviewer|planner|art|liaison|agent|watch|supervisor|dev-hacker|codex|claude|gemini|agy|grok|cursor|aider|hermes)\b/i.test(String(by || '')) || by === process.env.STUDIO_LOCK_OWNER;
function readBudgetLimits() {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'budget.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * A name no session has used before, kept across restarts in .studio/agent-names.json, so two
 * different sessions never share a name (run #1: builder-s3 named a dead session and a live one).
 */
export function nextAgentName(role, prefix = '') {
  const f = path.join(STUDIO_STATE_DIR, 'agent-names.json');
  const counters = readJson(f) || {};
  const key = `${role}-${prefix}`;
  const re = new RegExp(`^${role.replace(/[^a-z0-9-]/gi, '')}-${prefix}(\\d+)$`);
  const seen = sessions().map((x) => Number((String(x.agent).match(re) || [])[1]) || 0);
  const n = Math.max(Number(counters[key]) || 0, ...seen, 0) + 1;
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify({ ...counters, [key]: n }, null, 2)}\n`);
  return `${role}-${prefix}${n}`;
}

/** The tasks an agent holds (its task locks), plus the task its session was started on. */
const tasksOf = (agent, s) => [...new Set([...listLocks().filter((l) => l.owner === agent && l.key.startsWith('task:')).map((l) => l.key.slice(5)), ...(s?.task ? [s.task] : [])])];

/** Pause an agent: its task goes back to the queue with a note (and its claims), then the process ends. */
export function pauseAgent(agent, note = '', by = 'war-room-human') {
  const s = sessions().find((x) => x.agent === agent && x.running);
  if (!s) return { ok: false, message: `${agent} isn't running.` };
  const held = listLocks().filter((l) => l.owner === agent && l.key.startsWith('task:')).map((l) => l.key.slice(5));
  for (const t of held) pauseTask(t, agent, note || `Paused from the War Room; ${agent}'s work so far is in the working tree.`, { force: true });
  // A paused task doesn't restart straight away under a new name (STUDIO_STOP_COOLDOWN_MIN, default 15).
  for (const t of tasksOf(agent, s)) cooldown(t, by);
  stopAgent(s.pid);
  emitEvent({ type: 'agent.paused', agent, to: 'producer', msg: `${agent} paused${held.length ? `; ${held.join(', ')} back in the queue` : ''}${note ? `: ${note}` : ''}` });
  return { ok: true, handed: held };
}

/** Stop one agent by name: its task can't restart for the cooldown; the launcher hands the work back. */
export function stopAgentNamed(agent, by = 'war-room-human') {
  const s = sessions().find((x) => x.agent === agent && x.running);
  if (!s) return { ok: false, message: `${agent || '(no name)'} isn't running.` };
  const tasks = tasksOf(agent, s);
  const until = tasks.map((t) => cooldown(t, by)).filter(Boolean)[0] || null;
  stopAgent(s.pid);
  emitEvent({ type: 'agent.stopped', agent: by, to: 'producer', msg: `${by} stopped ${agent}${tasks.length ? `; ${tasks.join(', ')} can restart after ${until ? until.slice(11, 16) : 'now'}` : ''}` });
  return { ok: true, agent, tasks, until };
}

/** "Stop all": every running launcher session hands its task back with a note and ends. */
export function stopAllAgents(by = 'war-room-human', reason = '') {
  const stopped = [];
  for (const s of sessions().filter((x) => x.running)) {
    const held = listLocks().filter((l) => l.owner === s.agent && l.key.startsWith('task:')).map((l) => l.key.slice(5));
    for (const t of held) pauseTask(t, s.agent, `The studio was stopped by ${by}${reason ? ` (${reason})` : ''}; ${s.agent}'s work so far is in the working tree.`, { force: true });
    stopAgent(s.pid);
    stopped.push(s.agent);
  }
  if (stopped.length) emitEvent({ type: 'agent.stopped', agent: by, to: 'producer', msg: `Stop all: ${stopped.join(', ')} handed back their work` });
  return stopped;
}

/**
 * Agents the launcher didn't start (a claude -p, codex exec or agy run by hand or a script) working in
 * this repo, so `agent list` shows them too. Best effort: Linux reads /proc, macOS asks lsof; Windows isn't checked.
 */
export function otherAgents() {
  if (IS.win) return { checked: false, list: [] };
  const known = new Set(sessions().filter((x) => x.running).flatMap((x) => [x.pid, x.supervisor]).filter(Boolean));
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (ps.status !== 0) return { checked: false, list: [] };
  const list = [];
  for (const line of ps.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m || known.has(Number(m[1])) || Number(m[1]) === process.pid) continue;
    // The program itself must be claude, codex or agy (run directly or by node), not a path that mentions one.
    const words = m[2].split(/\s+/);
    const base = (w) => String(w || '').split('/').pop().replace(/\.(exe|js|mjs|cjs)$/i, '');
    const prog = /^(node|bun|deno)$/.test(base(words[0])) ? base(words[1]) : base(words[0]);
    const rest = words.slice(1);
    if (!((prog === 'claude' && rest.some((w) => w === '-p' || w === '--print')) || (prog === 'codex' && rest.includes('exec')) || (prog === 'agy' && rest.includes('-p')))) continue;
    let cwd = '';
    try {
      cwd = fs.readlinkSync(`/proc/${m[1]}/cwd`);
    } catch {
      const l = spawnSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      cwd = (l.stdout || '').split('\n').find((x) => x.startsWith('n'))?.slice(1) || '';
    }
    if (cwd && (cwd === REPO_ROOT || cwd.startsWith(`${REPO_ROOT}${path.sep}`))) list.push({ pid: Number(m[1]), command: m[2].slice(0, 120) });
  }
  return { checked: true, list };
}

/** The last lines of an agent's output. */
export function agentLog(agent, tail = 60) {
  const f = path.join(AGENTS_DIR, `${agent}.log`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, 'utf8').split('\n').slice(-tail).join('\n');
}

/** Start one agent, after the stop switch, caps and spend checks. */
export function startAgent(opts, { detach = false } = {}) {
  const { role } = opts;
  const agent = opts.agent || (role ? nextAgentName(role) : null);
  opts = { ...opts, agent };
  if (!role || !agent) return { ok: false, message: 'Usage: npm run agent -- start --role <role> --agent <unique-name> --tool <tool> --model <model>' };
  if (readStop()) return { ok: false, message: 'The studio is stopped; resume it first (npm run task -- resume --by <name>).' };
  const already = sessions().find((s) => s.agent === agent && s.running);
  if (already) return { ok: false, message: `${agent} is already running (pid ${already.pid}).` };
  const c = caps(role, Number(opts.extra) || 0);
  if (!c.ok) return { ok: false, message: `Not started: ${c.why}.` };
  const spend = spentToday();
  if (spend.over) return { ok: false, message: `Not started: the daily token cap is spent (${spend.used} of ${spend.cap}).` };
  const tool = opts.tool || process.env[`STUDIO_${roleKey(role)}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
  const model = opts.model || process.env[`STUDIO_${roleKey(role)}_MODEL`] || process.env.STUDIO_AGENT_MODEL || 'unknown';
  if (tool === 'codex' && model === 'unknown' && !process.env[`STUDIO_${roleKey(role)}_CMD`]) return { ok: false, message: 'Codex needs a model (--model, or STUDIO_AGENT_MODEL / STUDIO_<ROLE>_MODEL): its default is refused on ChatGPT logins.' };
  // The Director watches for drift and files corrections; the Producer decides staffing.
  if (opts.by && /^director\b/i.test(String(opts.by))) return { ok: false, message: 'The Director does not hire: file a correction task for the Producer instead.' };
  // A frozen clone (a test run) keeps agents out of the harness itself.
  if (opts.lane && fs.existsSync(path.join(REPO_ROOT, '.studio', 'harness-frozen')) && /^(\.\/)?(harness|hub|qa|scripts)(\/|$)/.test(String(opts.lane).replace(/\\/g, '/'))) return { ok: false, message: `Not started: ${opts.lane} is harness code, and this clone's harness is frozen.` };
  // The Producer hires on its own up to a limit (studio/budget.json producerMayHireUpTo, default 4);
  // past it, the hire becomes a question for the game dev (Needs you), started when they say yes.
  if (opts.by && isAgentName(opts.by) && !opts.approved) {
    const limit = Number(readBudgetLimits().producerMayHireUpTo ?? 4);
    const byAgents = sessions().filter((s) => s.running && s.hiredBy && isAgentName(s.hiredBy)).length;
    if (byAgents >= limit) return { ok: false, needsApproval: true, message: `${opts.by} already has ${byAgents} agents it hired running (its limit is ${limit}): asking the game dev.`, approval: { role, agent, tool, model, task: opts.task || null, lane: opts.lane || null, division: opts.division || null, by: opts.by } };
  }
  if (opts.next && !opts.task) opts = { ...opts, task: nextFor({ role }, parseNextQueue()).task?.id || null };
  if (detach) {
    // A supervisor process of its own, so the agent outlives this command (the HUB and the watcher use this).
    const args = [fileURLToPath(import.meta.url), 'start', '--role', role, '--agent', agent, '--tool', tool, '--model', model, ...(opts.fallback?.length ? ['--fallback', opts.fallback.join(',')] : []), ...(opts.task ? ['--task', opts.task] : []), ...(opts.lane ? ['--lane', opts.lane] : []), ...(opts.oneTask ? ['--one-task'] : []), ...(opts.extra ? ['--extra', String(opts.extra)] : []), ...(opts.division ? ['--division', opts.division] : []), ...(opts.note ? ['--note', String(opts.note)] : []), ...(opts.by ? ['--by', opts.by] : []), ...(opts.loop ? ['--loop', String(opts.loop)] : []), ...(opts.approved ? ['--approved'] : [])];
    const sup = spawn(process.execPath, args, { cwd: REPO_ROOT, detached: true, stdio: 'ignore', env: process.env });
    sup.unref();
    return { ok: true, detached: true, agent, role, tool, model, supervisor: sup.pid };
  }
  return { ok: true, agent, run: runAgent({ ...opts, tool, model }) };
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
  if (cmd === 'start' || cmd === 'hire') {
    // hire = start, from the Producer or the game dev, into a division, with a note; --loop keeps the
    // same desk working through the division's tasks one session at a time.
    const division = flag('division');
    if (division && (argv.includes('--open') || (flag('by') && !isAgentName(flag('by'))))) {
      const { setDivision, listDivisions } = await import('./divisions.mjs');
      const d = listDivisions().find((x) => x.id === division);
      if (d && !d.active) setDivision(division, true, flag('by') || 'producer');
    }
    const base = { role: flag('role'), agent: flag('agent'), tool: flag('tool'), model: flag('model'), fallback: (flag('fallback') || '').split(',').filter(Boolean), task: flag('task'), next: argv.includes('--next'), lane: flag('lane'), oneTask: argv.includes('--one-task') || Boolean(flag('loop')), extra: Number(flag('extra')) || 0, division, note: flag('note') || '', by: flag('by') || (cmd === 'hire' ? process.env.STUDIO_LOCK_OWNER || null : null), loop: flag('loop'), approved: argv.includes('--approved') };
    const r = startAgent(base, { detach: argv.includes('--detach') });
    if (!r.ok) {
      if (r.needsApproval) {
        const { ask } = await import('./ask.mjs');
        const a = r.approval;
        const q = ask({ question: `Hire ${a.agent} (${a.role}${a.division ? ` in ${a.division}` : ''}, ${a.tool}/${a.model})${a.task ? ` for ${a.task}` : ''}?`, options: ['yes', 'no'], why: r.message, by: a.by, action: { type: 'hire', opts: a } });
        console.error(`${r.message} ${q.ok ? `Asked as ${q.ask.id}; it starts when the game dev says yes.` : ''}`);
        process.exit(2);
      }
      console.error(r.message);
      process.exit(1);
    }
    if (r.detached) {
      console.log(`${r.agent} started in the background (${r.tool}, ${r.model}). Output: .studio/agents/${r.agent}.log. npm run agent -- list`);
      process.exit(0);
    }
    let res = await r.run;
    // --loop until-empty | N: the next session starts on the next task for this role, same name, same desk.
    let left = flag('loop') === 'until-empty' ? Infinity : Number(flag('loop')) || 0;
    while (res.ok && !res.bad && --left > 0) {
      const next = nextFor({ role: base.role }, parseNextQueue()).task;
      if (!next || readStop()) break;
      const again = startAgent({ ...base, agent: r.agent || base.agent, task: next.id, next: false });
      if (!again.ok) break;
      res = await again.run;
    }
    if (!res.ok) {
      console.error(res.message);
      process.exit(1);
    }
    console.log(`${flag('agent') || r.agent || ''} ended: ${res.reason}${res.handed?.length ? `; handed back ${res.handed.map((h) => `${h.task}${h.patch ? ` (work in ${h.patch})` : ''}`).join(', ')}` : ''}`);
    process.exit(res.bad ? 1 : 0);
  }
  if (cmd === 'pause') {
    const r = pauseAgent(argv[1], flag('note') || '', flag('by') || 'human');
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`${argv[1]} paused${r.handed.length ? `; ${r.handed.join(', ')} back in the queue with a note` : ''}.`);
    process.exit(0);
  }
  if (cmd === 'logs') {
    const t = agentLog(argv[1], Number(flag('tail')) || 60);
    console.log(t ?? `No log for ${argv[1]}.`);
    process.exit(t ? 0 : 1);
  }
  if (cmd === 'now') {
    const r = sayNow(process.env.STUDIO_LOCK_OWNER || flag('agent'), argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--'))).join(' '));
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    process.exit(0);
  }
  if (cmd === 'stop') {
    const r = stopAgentNamed(argv[1], flag('by') || 'human');
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Stopping ${r.agent}; the launcher hands its work back.${r.tasks.length ? ` ${r.tasks.join(', ')} won't restart before ${r.until ? r.until.slice(11, 16) : 'now'} (STUDIO_STOP_COOLDOWN_MIN).` : ''}`);
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
  const others = otherAgents();
  for (const o of others.list) console.log(`outside  pid ${String(o.pid).padEnd(12)} not started by the launcher: ${o.command}`);
  if (others.list.length) console.log('  Agents outside the launcher keep no heartbeat and don\'t see Stop all until they next run a harness command. Prefer npm run agent -- hire.');
  const mode = effectiveMode();
  console.log(`\nMode: ${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, up to ${mode.maxAgents} agents. Roles that can start on their own: ${launchableRoles().join(', ') || 'none (set STUDIO_AGENT_TOOL or STUDIO_<ROLE>_TOOL in .env)'}.`);
}
