#!/usr/bin/env node
/**
 * harness/agent.mjs — start agents, watch them, and clean up when one dies.
 *
 *   npm run agent -- start --role builder --agent builder-1 --tool claude|codex|agy|cursor|grok|aider|custom --model <model>
 *                       [--fallback codex:gpt-6-sol,claude:claude-sonnet-5-5] [--task T-012] [--lane <folder>] [--one-task] [--detach]
 *   npm run agent -- now "<what I'm doing>"   an agent's one-line status, shown with its heartbeat in the War Room
 *   npm run agent -- hire --role <role> [--division sound] [--task T-012 | --next] [--lane <folder>] [--note "…"]
 *                        [--loop until-empty|N] [--by <producer or person>] [--open] [--foreground]   the same as start, as a hire
 *                        (in the background unless --foreground):
 *                        the Producer hires on its own up to studio/budget.json producerMayHireUpTo (default 4), past
 *                        that the game dev is asked; --open switches the division on
 *   npm run agent -- pause <agent> [--note "…"]   its task goes back to the queue, then it stops
 *   npm run agent -- logs <agent> [--tail 60] [--raw]   a Claude session reads as a conversation
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
import { allowedTools } from './allowlist.mjs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { escalationFor } from './model-tiers.mjs';
import { sessionReasoningOnly, rerouteFor } from './reasoning-only.mjs';
import { kickoffParts } from './kickoff.mjs';
import { layoutPrompt, recordPrefix, cacheStats, LONG_CACHE_ROLES, volatileLeaks } from './prompt-layout.mjs';
import { parseNextQueue, pauseTask, readStop, nextFor } from './task.mjs';
import { taskType } from './done-check.mjs';
import { listLocks, release, claim, renewOwner } from './lock.mjs';
import { savePatch } from './wip.mjs';
import { laneList } from './task-hold.mjs';
import { laneWantsCopy, createLaneCopy, removeLaneCopy, unmerged, rememberTaskBranch } from './worktree.mjs';
import { effectiveMode } from './mode.mjs';
import { markExhausted, toolNamed, weightedTokens, dailyCap, QUOTA_ERROR } from './budget.mjs';
import { sessionLimits, heartbeatCheck, readFlag, clearFlag, HANDOFF_TEMPLATE } from './session-cap.mjs';
import { setHold } from './task-hold.mjs';
import { stopIfOverBudget } from './task-budget.mjs';
import { agentEnv } from './agent-env.mjs';
import { rescueOf, rescueModelFor } from './rescue.mjs';
import { cooldown } from './task-hold.mjs';
import { mapStale, writeMap } from './map.mjs';
import { pitfallsForPrompt } from './pitfalls.mjs';
import { isNim, providerConcurrency } from './families.mjs';
import { observe, logTokens, logStall, idleVerdict, readStall } from './stall.mjs';
import { profileGuard, profileOf } from './profile-guard.mjs';
import { toolCmd } from './spend-guard.mjs';
import { pickTool, readBudget, budgetStopFor } from './budget.mjs';
import { harnessCaused } from './busy.mjs';

export const AGENTS_DIR = path.join(STUDIO_STATE_DIR, 'agents');
const WIP_DIR = path.join(STUDIO_STATE_DIR, 'wip');
const HEARTBEAT_MS = Number(process.env.STUDIO_HEARTBEAT_SEC || 120) * 1000;
// Only a real limit or auth error counts (run #1: a normal end_turn and selftest output that mentioned
// "quota" marked tools out and idled the studio for an hour). Read the end of a failed session, or a
// final result object that says it is an error; never the agent's whole transcript.
const AUTH_ERROR = /\b401\b|unauthori[sz]ed|invalid (?:api|x-api) key|authentication (?:failed|error|required)|not logged in|please (?:run )?\/?login/i;
export function providerTrouble(log, code) {
  const lines = String(log || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // 2.30i: an HTTP 429 the provider put in the stream json (Marina's NIM sessions), not only on stderr.
  for (const l of lines.slice(-40).reverse()) {
    if (!l.startsWith('{')) continue;
    try {
      const o = JSON.parse(l);
      if (o?.error?.code === 429 || o?.status === 429 || o?.error?.status === 429 || o?.api_error_status === 429) {
        return { kind: 'quota', text: '429', line: l, named: toolNamed(l) };
      }
    } catch {}
  }
  // 2.30o: repeated provider refusals (5xx / overloaded / unavailable) are a run-out like a quota error, for
  // any launcher: three or more in the session's last lines.
  const refusals = lines.slice(-60).filter((l) => /\b(?:HTTP|status|code)?\W{0,3}5(?:00|02|03|04|29)\b.*(?:error|overloaded|unavailable|bad gateway|timeout)|\boverloaded(?:_error)?\b|service unavailable/i.test(l) && !/"type"\s*:\s*"(?:user|assistant|tool_result)"/.test(l));
  if (refusals.length >= Number(process.env.STUDIO_5XX_RUNOUT ?? 3)) return { kind: 'quota', text: `provider refused ${refusals.length} times (5xx)`, line: refusals[refusals.length - 1].slice(0, 240), named: toolNamed(refusals[refusals.length - 1]) };
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
      if (q) return { kind: 'quota', text: q[0], line: text, named: toolNamed(text) };
      const au = text.match(AUTH_ERROR);
      return au ? { kind: 'auth', text: au[0], line: text, named: toolNamed(text) } : null;
    }
  }
  if (code === 0) return null;
  // A failed session without a result object: only its last lines, and never a line reporting an allowed status.
  for (const l of lines.slice(-30).reverse()) {
    if (/"status"\s*:\s*"allowed"|rate_limit_event/.test(l)) continue;
    // 2.30 (J12): a stream event (what the agent said, or a tool result it read) is the agent's transcript,
    // never the provider talking: a killed session's last lines were a selftest's output quoting "429"
    // and "usage limit reached", and the tool was marked out while the plan had room.
    if (l.startsWith('{') && /"type"\s*:\s*"(?:user|assistant|system|stream_event|tool_use|tool_result|item\.\w+|message)"/.test(l)) continue;
    // The line has to read as an error from the tool, not text the agent wrote or read.
    if (!/\berror\b|\bfailed\b|too many requests|\b429\b|\b401\b|usage limit reached|hit your (?:usage )?limit|invalid api key|not logged in/i.test(l)) continue;
    const q = l.match(QUOTA_ERROR);
    if (q) return { kind: 'quota', text: q[0], line: l, named: toolNamed(l) };
    const au = l.match(AUTH_ERROR);
    if (au) return { kind: 'auth', text: au[0], line: l, named: toolNamed(l) };
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
      // stream-json (2.26): the log keeps every message and tool call, not only the final result, so a
      // session can be read back (test #2: --output-format json left nothing but the last answer).
      const bypass = process.env.STUDIO_CLAUDE_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      const allowed = allowedTools(); // harness/allowlist.mjs: the same list the kickoff prints (2.30c)
      // 2.29.2: a turn ceiling, so no session runs 126 turns again (the refresh point, 40 turns, is in the kickoff).
      const ceiling = sessionLimits().ceilingTurns;
      return { argv: ['claude', '-p', ...(bypass ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', allowed]), '--output-format', 'stream-json', '--verbose', ...(ceiling > 0 ? ['--max-turns', String(ceiling)] : []), ...(m ? ['--model', m] : []), ...(effort ? ['--effort', effort] : [])], stdin: prompt };
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

/**
 * 2.30h: locks held by agents whose process is gone are freed at once (not left to run out): an owner with a
 * launcher session record and no running session. People and CLI owners have no record and are left alone.
 */
export async function releaseDeadLocks(list = sessions()) {
  const known = new Map();
  for (const s of list) known.set(s.agent, (known.get(s.agent) || false) || s.running);
  const { releaseDeadOwners } = await import('./lock.mjs');
  const freed = releaseDeadOwners((owner) => known.has(owner) && !known.get(owner));
  if (freed.length) emitEvent({ type: 'lock.dead_released', agent: 'watch', msg: `Freed ${freed.length} lock(s) held by agents whose process is gone: ${freed.join(', ')}`.slice(0, 300), meta: { freed } });
  return freed;
}

/**
 * Sessions whose record says "running" but whose process is gone (killed with the shell that started it,
 * a crash, a reboot) are marked ended, so the War Room and agent list stop showing them and the watcher
 * hands their task back and frees their claims (test #3). Returns the agents marked.
 */
export function markGone() {
  const gone = [];
  for (const s of sessions()) {
    if (s.status !== 'running' || s.running) continue;
    const at = new Date().toISOString();
    fs.writeFileSync(sessionFile(s.agent), JSON.stringify({ ...s, running: undefined, stalled: undefined, beatAgeMin: undefined, status: 'ended', endedAt: at, reason: 'its process is gone (killed, crashed or the machine restarted)' }, null, 2));
    emitEvent({ type: 'agent.session.end', agent: s.agent, model: s.model, status: 'error', msg: `${s.agent} ended: its process is gone (last heartbeat ${s.lastBeat || 'never'})`, meta: { role: s.role, tool: s.tool, reason: 'process gone' } });
    // Its own copy: save what's uncommitted, keep unmerged commits on their branch, remove the copy.
    if (s.copy) {
      const mine = listLocks().filter((l) => l.owner === s.agent);
      for (const t of tasksOf(s.agent, s)) saveWorkOf(s.agent, t, mine, s);
      removeLaneCopy(s.agent, { keepBranch: unmerged(s.copy.branch) > 0, ifIdle: true });
    }
    gone.push(s.agent);
  }
  return gone;
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

// 2.29.2: cache reads count (weighted, see budget.mjs), and the cap has a default instead of 0 = none.
export function spentToday(now = Date.now(), events = readRecentEvents(50000)) {
  const cap = dailyCap();
  if (!cap) return { over: false, used: null, cap: 0 };
  const today = new Date(now).toISOString().slice(0, 10);
  const used = Math.round(events.filter((e) => String(e.ts).startsWith(today)).reduce((n, e) => n + weightedTokens(e), 0));
  return { over: used >= cap, used, cap };
}

/**
 * What a session used, from the tool's own final report (run #1: summing every "input_tokens" in a
 * Claude log ignored cache reads, which were 37.6M of the real work, and double-counted streamed
 * messages). Claude Code: the last {"type":"result"} object's usage. Codex: each turn.completed.
 * Cache reads are kept apart: cheap, but they are where the cost of re-reading context shows.
 */
export function tokensFrom(log) {
  const lines = String(log || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
  let claude = null;
  let cost = null;
  const codex = { seen: false, in: 0, cached: 0, out: 0 };
  let plain = null;
  for (const l of lines) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type === 'result' && o.usage) {
      const u = o.usage;
      claude = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, turns: Number(o.num_turns) || null };
      if (o.total_cost_usd != null) cost = Number(o.total_cost_usd);
    } else if (o.type === 'turn.completed' && o.usage) {
      const u = o.usage;
      codex.seen = true;
      codex.turns = (codex.turns || 0) + 1;
      codex.in += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
      codex.cached += u.cached_input_tokens || 0;
      codex.out += u.output_tokens || 0;
    } else if (o.usage && (o.usage.input_tokens != null || o.usage.prompt_tokens != null)) {
      // Another tool's (or a script's) single usage report: the last one counts.
      plain = { in: (o.usage.input_tokens ?? o.usage.prompt_tokens) || 0, cacheRead: o.usage.cache_read_input_tokens || o.usage.cached_input_tokens || 0, out: (o.usage.output_tokens ?? o.usage.completion_tokens) || 0 };
    }
  }
  const r = claude || (codex.seen ? { in: codex.in, cacheRead: codex.cached, out: codex.out, turns: codex.turns } : plain);
  // Turns too (2.28): each turn re-reads the whole context, so cost follows turns more than file size
  // (Jed's sandbox A/B: a map-first workflow added turns and cost 27% more cache reads).
  return r ? { tokensIn: r.in, tokensOut: r.out, cacheRead: r.cacheRead, costUsd: cost, turns: r.turns || null } : { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null, turns: null };
}

/** 2.30i: a session that ended without task done gets the launcher's foreground verify: a clean exit, or a crash after it committed. */
export function crashFinishable({ code, trouble, reasoningOnly, capped, hasCommit }) {
  if (trouble || reasoningOnly || capped) return false;
  return Boolean(hasCommit) && Number.isInteger(code);
}

/** After an agent exits: record it, and if it died holding work, hand the work back cleanly. */
export function cleanUp(agent, { code, log = '', role, tool, model }) {
  const found = providerTrouble(log, code);
  // An error that names another tool (agy's 429 printed by a command this session ran) is that tool's,
  // never this session's (test #2: claude was marked out of quota for agy's limit).
  const other = found?.named && found.named !== tool ? found.named : null;
  const t = other ? null : found;
  const trouble = t?.text || null;
  // 2.29.2: a session that reached the turn ceiling, or was asked to hand off at a refresh check, refreshed:
  // that's the plan working, not a failure, so no failover, and a fresh session continues the task.
  const refresh = readFlag(agent);
  const capped = !trouble && (/"subtype"\s*:\s*"error_max_turns"/.test(String(log).slice(-20000)) || Boolean(refresh?.endedBy));
  // 2.30h (3): an empty final answer after spending output tokens is a failed hand-off, not a finish.
  const reasoningOnly = !capped && !trouble && code === 0 && sessionReasoningOnly(log);
  const bad = !capped && (code !== 0 || Boolean(trouble) || reasoningOnly);
  const mine = listLocks().filter((l) => l.owner === agent);
  const tasks = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
  const handed = [];
  const s0 = readJson(sessionFile(agent)) || {};
  // An agent in its own copy (2.29): its uncommitted work is in that copy, its commits on its branch.
  const copyDir = s0.copy?.dir ? path.join(REPO_ROOT, s0.copy.dir) : null;
  const ahead = s0.copy?.branch ? unmerged(s0.copy.branch) : 0;
  const finished = [];
  for (const id of tasks) {
    const hasCommit = ahead > 0 || (() => {
      const cwd = copyDir && fs.existsSync(copyDir) ? copyDir : REPO_ROOT;
      const git = spawnSync('git', ['log', `--since=${s0.startedAt || new Date(Date.now()-86400000).toISOString()}`, '--grep', id, '--oneline'], { cwd, encoding: 'utf8' });
      return git.status === 0 && git.stdout.trim().length > 0;
    })();
    let af = null;
    if (crashFinishable({ code, trouble, reasoningOnly, capped, hasCommit })) {
      af = autoFinish(agent, id, copyDir, mine, code);
      if (af.ok) {
        finished.push(id);
        continue;
      }
    }
    const patch = savePatch(agent, id, copyDir ? [] : mine.map((l) => l.key), copyDir && fs.existsSync(copyDir) ? { cwd: copyDir } : {});
    if (ahead) rememberTaskBranch(id, s0.copy.branch);
    const onBranch = ahead ? ` ${ahead} commit(s) not yet in the studio's branch are on ${s0.copy.branch}; the next agent's copy gets them merged in.` : '';
    // A session that ended without task done or a hand-back still holds its task (test #2: claims sat
    // for up to an hour). Hand it back now, with what it last said and what it left.
    const note = capped
      ? `${agent} (${tool}, ${model}) refreshed: ${refresh?.endedBy || `it reached the ${sessionLimits().ceilingTurns}-turn ceiling`}.${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch} A fresh session continues from this hand-back${s0.now ? `; it last said: "${s0.now}"` : ''}.`
      : bad
      ? `${agent} (${tool}, ${model}) stopped: ${trouble ? `provider said "${trouble}"` : reasoningOnly ? 'it replied with reasoning only (no answer, no work): a failed hand-off; the Director routes this task to another model family' : `exit code ${code}`}.${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch} Picked up by the launcher.`
      : `${agent} (${tool}, ${model}) ended without task done or a hand-back.${s0.now ? ` It last said: "${s0.now}".` : ''}${s0.wip ? ` Work in progress: ${s0.wip}.` : ''}${patch ? ` Uncommitted work ${copyDir ? 'was in its copy and is' : 'is in the tree and'} saved to ${patch}.` : ' No uncommitted work.'}${onBranch} Check its commits (git log --grep ${id}) before redoing anything. Picked up by the launcher.`;
    pauseTask(id, agent, af && !af.ok && af.output ? `${note} Launcher verify: ${af.output.replace(/\n/g, ' ')}` : note, { force: true });
    if (reasoningOnly) emitEvent({ type: 'agent.reasoning_only', agent, model, task: id, status: 'warn', msg: `${agent} (${model}) replied with reasoning only on ${id}: failed hand-off, the next session goes to another model family`, meta: { role, tool } });
    handed.push({ task: id, patch });
    if (!capped) parkIfLooping(id);
  }
  for (const l of listLocks().filter((x) => x.owner === agent)) release(l.key, agent);
  // Out of quota: remember until when, so the supervisor moves this tool's lanes to the next tool.
  // STUDIO_QUOTA_SKIP=off: usage is watched outside the harness, so never skip a tool for quota.
  const quota = (other ? found : t)?.kind === 'quota' ? (other ? found : t) : null;
  if (quota && !/^(off|0|false|no)$/i.test(process.env.STUDIO_QUOTA_SKIP || '')) {
    // 2.30o: generic: the order entry this session ran as (tool:model when the order lists it, else the tool).
    const order = (() => { try { return readBudget().order || []; } catch { return []; } })();
    const who = other || (order.includes(`${tool}:${model}`) ? `${tool}:${model}` : tool);
    const line = log.split('\n').slice(-30).reverse().find((l) => /reset|try again/i.test(l) && QUOTA_ERROR.test(l) && (toolNamed(l) || who) === who) || quota.line;
    markExhausted(who, line);
  }
  const tok = tokensFrom(log);
  // 2.30g: cache hit vs write from Claude's own usage lines, and which prompt prefix the session started from.
  const cache = cacheStats(log);
  const prefixHash = (readJson(sessionFile(agent)) || {}).prefixHash || null;
  const reason = capped ? 'refreshed (session cap): a fresh session continues' : trouble ? `provider: ${trouble}` : code === 0 ? (handed.length ? 'finished without task done' : finished.length ? 'finished (the launcher closed its task)' : 'finished') : `exit ${code}`;
  emitEvent({ type: 'agent.session.end', agent, model, status: bad ? 'error' : 'ok', tokensIn: tok.tokensIn, tokensOut: tok.tokensOut, msg: `${agent} ended (${reason})${handed.length ? `; handed back ${handed.map((h) => h.task).join(', ')}` : ''}${other ? `; ${other} reported its own limit inside this session (marked on ${other})` : ''}`, meta: { role, tool, code, reason, handed, finishedByLauncher: finished, costUsd: tok.costUsd, cacheRead: tok.cacheRead, cacheWrite: cache.cacheWrite, cacheHitRate: cache.cacheRead + cache.cacheWrite + cache.input ? Number(cache.hitRate.toFixed(3)) : undefined, prefixHash: prefixHash || undefined, turns: tok.turns, otherToolLimit: other, refreshed: capped || undefined } });
  const s = readJson(sessionFile(agent)) || {};
  fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, status: 'ended', endedAt: new Date().toISOString(), code, reason, handed, ...tok }, null, 2));
  return { bad, trouble, troubleKind: t?.kind, handed, finished, reason, capped };
}

/**
 * Finish a task an agent left without calling task done, if its done-check passes: run task done as that
 * agent (in its copy, so the work is delivered); if only the verify is missing or stale, run the everyday
 * verify first. In the shared checkout, only when the agent left nothing uncommitted under its claims.
 * STUDIO_AUTO_FINISH=off turns it off.
 */
export function autoFinish(agent, id, copyDir, mine, code) {
  if (/^(off|0|false|no)$/i.test(process.env.STUDIO_AUTO_FINISH || '')) return { ok: false, output: 'disabled' };
  const t = parseNextQueue().inProgress.find((x) => x.id === id);
  if (!t || taskType(t) === 'none') return { ok: false, output: 'not checkable' };
  const cwd = copyDir && fs.existsSync(copyDir) ? copyDir : REPO_ROOT;
  if (cwd === REPO_ROOT) {
    const paths = mine.filter((l) => l.key.startsWith('path:')).map((l) => l.key.slice(5)).filter(Boolean);
    if (!paths.length) return { ok: false, output: 'no claims' };
    const dirty = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd, encoding: 'utf8' }).stdout || '';
    if (dirty.trim()) return { ok: false, output: 'working tree dirty' };
  }
  const env = { ...process.env, STUDIO_LOCK_OWNER: agent, ...(cwd !== REPO_ROOT ? { STUDIO_MAIN_ROOT: REPO_ROOT } : {}) };
  const g = spawnSync(process.execPath, [path.join(cwd, 'scripts', 'run-gates.mjs')], { cwd, env, encoding: 'utf8', timeout: 20 * 60000 });
  if (g.status !== 0) {
    const out = `${g.stderr || ''}${g.stdout || ''}`.trim().split('\n').slice(-15).join('\n');
    return { ok: false, output: out || 'verify failed' };
  }
  const gitLog = spawnSync('git', ['log', '-1', '--format=%h', '--grep', id], { cwd, encoding: 'utf8' });
  const sha = gitLog.status === 0 && gitLog.stdout.trim() ? gitLog.stdout.trim() : 'none';
  const ext = code === 0 ? 'clean exit' : `exit code ${code}`;
  const note = `closed by the launcher: session ended without task done (${ext}), verify passed in the foreground, commit ${sha}`;
  const done = spawnSync(process.execPath, [path.join(cwd, 'harness', 'task.mjs'), 'done', id, '--agent', agent, '--note', note], { cwd, env, encoding: 'utf8', timeout: 20 * 60000 });
  if (done.status !== 0) {
    const out = `${done.stderr || ''}${done.stdout || ''}`.trim().split('\n').slice(-15).join('\n');
    return { ok: false, output: out || 'task done failed' };
  }
  if (!/^(off|0|false|no)$/i.test(process.env.STUDIO_POST_BROWSER_PLAY || '')) {
    const bp = spawnSync(process.execPath, [path.join(cwd, 'qa', 'browser-play.mjs')], { cwd, env, encoding: 'utf8', timeout: 5 * 60000 });
    emitEvent({ type: 'qa.browser_play', agent: 'launcher', task: id, status: bp.status === 0 ? 'ok' : 'warn', msg: `browser check after ${id}: ${bp.status === 0 ? 'passed' : 'failed or skipped'}` });
  }
  emitEvent({ type: 'agent.finished_for', agent: 'launcher', task: id, to: 'producer', msg: `${agent} ended without task done; its check passed, so the launcher closed ${id}` });
  return { ok: true, output: '' };
}

/**
 * A task handed back three times in two hours without being done is stuck on something a fresh session
 * won't fix (test #2: T-110 went to 12 sessions in a row, each refused the same command). Park it with
 * the last note, and tell the Producer. STUDIO_LOOP_HANDBACKS sets the count (0 turns it off).
 */
export function parkIfLooping(id, now = Date.now()) {
  const limit = Number(process.env.STUDIO_LOOP_HANDBACKS ?? 3);
  if (!(limit > 0)) return null;
  const evs = readRecentEvents(20000).filter((e) => e.task === id && Date.parse(e.ts) >= now - 2 * 3600000);
  const lastDone = evs.filter((e) => e.type === 'task.done').pop();
  // 2.30q (#6): harness-caused hand-backs (claim ran out during gates, merge refused, land lock) don't count.
  const pauses = evs.filter((e) => e.type === 'task.paused' && (!lastDone || e.ts > lastDone.ts) && !harnessCaused(e));
  const unparked = evs.filter((e) => e.type === 'task.hold' && /unparked/.test(e.msg || '')).pop();
  const since = unparked ? pauses.filter((e) => e.ts > unparked.ts) : pauses;
  if (since.length < limit) return null;
  const last = String(since[since.length - 1].msg || '').replace(/^Handed back [^:]+:\s*/, '').slice(0, 200);
  const why = `handed back ${since.length} times in 2 h without being done; the last note: "${last}". Fix the blocker, then npm run task -- unpark ${id} --by <name>`;
  setHold(id, { parked: { by: 'launcher', why, at: new Date(now).toISOString() } }, { by: 'launcher', msg: `Parked ${id}: ${why}` });
  emitEvent({ type: 'agent.ask', agent: 'launcher', to: 'producer', task: id, msg: `${id} keeps coming back (${since.length} hand-backs in 2 h), so it's parked. Last note: "${last}"` });
  return why;
}

/** The last part of a log (stream-json logs grow large; the refresh check needs only the latest usage). */
function tailOf(file, bytes = 2 * 1024 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** Refresh context by default (2.29.2): the rule every launched session gets, in a few lines. */
export function refreshRule({ oneTask = false, task = null } = {}) {
  const l = sessionLimits();
  const id = task || '<ID>';
  return `\nRefresh context by default: the studio's files are the memory, not this chat.${oneTask ? ' Do this one task, finish it (task done) or hand it back, then stop; a fresh session starts for the next task.' : ''}${l.turns || l.context ? ` At ${l.turns || '∞'} turns or ${l.context ? `${Math.round(l.context / 1000)}k` : '∞'} tokens of context, whichever comes first, refresh: commit, then \`node harness/task.mjs pause ${id} --note "${HANDOFF_TEMPLATE}"\` (under 3k characters) and stop; a fresh session continues from that note.` : ''} Refresh at a natural breakpoint, not every few turns.${l.turns || l.context ? ` Mid-debug with a live repro? \`npm run session -- exception "<repro>"\` lets you go on${l.ceilingTurns ? ` to ${l.ceilingTurns} turns` : ''}; you are flagged and the Director or Producer checks on you every ${l.checkTurns} turns / ${Math.round(l.checkTokens / 1000)}k tokens.` : ''}\n`;
}

/**
 * 2.30q (#7): check the budget stop before any session starts (startAgent, refresh relaunch, failover).
 * A stopped launch logs one launch.skipped event (once per role/tool/model per STUDIO_SKIP_LOG_MIN, 10, min)
 * instead of starting a session that exits at once.
 */
export function launchStop({ role, tool, model, agent = null, task = null }, now = Date.now()) {
  const cmd = toolCmd(tool) || process.env[`STUDIO_${roleKey(role)}_CMD`] || (tool === 'custom' ? process.env.STUDIO_AGENT_CMD || '' : '');
  const st = budgetStopFor({ tool, model, cmd }, now);
  if (!st.stopped) return null;
  const f = path.join(STUDIO_STATE_DIR, 'launch-skips.json');
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const k = `${role}|${tool}|${model}`;
  if (!(now - (seen[k] || 0) < Number(process.env.STUDIO_SKIP_LOG_MIN ?? 10) * 60000)) {
    seen[k] = now;
    try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(seen, null, 2)}\n`); } catch {}
    emitEvent({ type: 'launch.skipped', agent: 'launcher', to: 'producer', task: task || undefined, status: 'warn', msg: `Not started (${role}${agent ? ` ${agent}` : ''} on ${tool}${model && model !== 'unknown' ? `, ${model}` : ''}): budget stop: ${st.why}`, meta: { role, tool, model, by: st.by, until: st.until } });
  }
  return st;
}

/** Run one agent to the end, with heartbeats. Resolves with the cleanup result. */
export async function runAgent({ role, agent, tool, model, fallback = [], task = null, lane = null, oneTask = false, division = null, note = '', by = null, refreshes = 0 }) {
  const opts2 = { refreshes };
  // 2.30q (#7): every start path (first start, refresh relaunch, failover) checks the budget stop first.
  { const st = launchStop({ role, tool, model, agent, task }); if (st) return { ok: false, skipped: true, message: `Not started: budget stop (${st.why}).` }; }
  // 2.31.0: a task that used its own budget (harness/task-budget.mjs) gets no new session, refresh or failover.
  { const over = task ? stopIfOverBudget(task, { by: 'launcher' }) : null; if (over) { emitEvent({ type: 'launch.skipped', agent, task, msg: `${agent} not started on ${task}: ${over.split('. ')[0]}` }); return { ok: false, skipped: true, message: `Not started: ${over}` }; } }
  // A lane is a folder this agent owns for the session, so two agents never edit the same files.
  // 2.30k: a lane can be several files (a,b,c); each is claimed, and all are let go if one is taken.
  const lanePaths = laneList(lane);
  for (const [i, p] of lanePaths.entries()) {
    const c = claim(`path:${p}`, agent, 6 * 3600);
    if (c && c.ok === false) {
      for (const q of lanePaths.slice(0, i)) release(`path:${q}`, agent);
      return { ok: false, message: `Lane ${p} is taken: ${c.message || `claimed by ${c.lock?.owner || 'another agent'}`}` };
    }
  }
  // A code lane gets its own working copy (2.29), so half-done work never leaks into another agent's
  // tests or commits. Not possible here (old git, STUDIO_WORKTREES=off): the shared checkout, as before.
  let copy = null;
  if (laneWantsCopy(lane) && !process.env.STUDIO_MAIN_ROOT) {
    const c = createLaneCopy(agent, { task });
    if (c.error) emitEvent({ type: 'lane.shared', agent, task, msg: `${agent} works in the shared checkout: ${c.error}` });
    else copy = c;
  }
  // 2.30g: cache-friendly order. The fixed part (role kickoff, rules, the map tip, pitfalls) comes first
  // and never names this agent, its model or the time, so every session of a role starts with the same
  // bytes and Claude reads it from the prompt cache. Everything that changes per session goes last.
  const { stable: kick, volatile: kickTail } = kickoffParts({ role, agent, model, launched: true });
  const stable = (kick
    // Cheaper to read (2.26): the map instead of searching, never the long changelog, a short hand-back,
    // and the rules this game has learned the hard way.
    // 2.29: a lookup, not a read-first step (Jed's A/B: reading a map, then line ranges, added turns and cost 27% more).
    + `\nTo find a function, constant or TUNING key, run \`npm run map -- find <name>\`: one call gives the file, the line range and the arguments, so you read only those lines. .studio/MAP.md lists every code file in one line if you need the lay of the land. Every turn re-reads your whole conversation, so fewer, bigger steps cost less than many small ones. Never read CHANGELOG.md; studio/llms.txt lists every command. If you hand work back, keep the note under 20 lines: done, not done, files touched, next step, proof.\n`
    + `\nEvery few minutes, say what you are doing in one line: npm run agent -- now "<what you are doing>". The War Room shows it with your work in progress.\n`
    + `\nHarness output is compact in launched sessions: verify prints failures only (each gate's full log is in .studio/gates/out/<gate>.log; open it only when you need it), and \`node harness/task.mjs list\` shows your role's next tasks, not the whole board (--all for everything). Don't cat studio/NEXT.md.\n`
    + `\nSkills load on demand: .claude/skills/ holds the know-how for Godot, the web build, assets and tests. Claude Code shows you only their names until a task needs one; other tools: open the skill's SKILL.md when your task matches its description.\n`
    + pitfallsForPrompt());
  const volatile = `You are ${agent} (role \`${role}\`), running on ${model}. $STUDIO_LOCK_OWNER is ${agent} and $STUDIO_AGENT_MODEL is ${model} in your shell.\n`
    + kickTail
    + (task ? `\nStart with ${task}: node harness/task.mjs start ${task} --agent ${agent} --model ${model}\n` : '')
    + (lane ? `\nYour lane is \`${lane}\` (claimed for you): edit files only under it. Work outside it goes to the Producer as a task.\n` : '')
    + (copy ? `\nYou work in your own copy of the repo (\`.lanes/${agent}\`, branch \`${copy.branch}\`): other agents' unfinished work can't reach your tests, and yours can't reach theirs. \`studio/\` and \`.studio/\` are shared with everyone. Commit your work as you go; \`task done\` adds your commits to the studio's branch once your checks pass (it rebases first and tells you if anything conflicts). Uncommitted work never leaves your copy.\n` : '')
    + refreshRule({ oneTask, task })
    + (note ? `\nNote from ${by || 'the Producer'}: ${note}\n` : '');
  // 2.30q (#8): warn when something session-specific slipped into the stable prefix (it would break the cache).
  { const leaks = volatileLeaks(stable, { agent, model, task }); if (leaks.length) emitEvent({ type: 'prompt.prefix.volatile', agent, to: 'producer', status: 'warn', msg: `${role} prompt prefix carries ${leaks.join(', ')}: every ${role} session misses the prompt cache; move it below the stable marker`, meta: { role, leaks } }); }
  const prompt = layoutPrompt({ stable, volatile });
  let prefix = null;
  try {
    prefix = recordPrefix({ role, agent, prompt });
  } catch {
    // the ledger is a measurement, never a blocker
  }
  // The map the prompt points at, refreshed when code changed since it was made.
  try {
    if (mapStale()) writeMap();
  } catch {
    // the map is a help, never a blocker
  }
  const file = path.join(STUDIO_STATE_DIR, 'kickoff', `${agent}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, prompt);
  // 2.30e (R6): In rehearsal mode, use the rehearsal agent unless a custom command is set.
  // 2.30o: a tool in the budget order may carry its own launch command (hermes, gemini, grokbot ...):
  // STUDIO_TOOL_<TOOL>_CMD. It wins over the role's command, so a takeover changes the program too.
  const viaTool = toolCmd(tool);
  let custom = viaTool || process.env[`STUDIO_${roleKey(role)}_CMD`] || (tool === 'custom' ? process.env.STUDIO_AGENT_CMD : null);
  if (process.env.STUDIO_REHEARSAL === '1' && !custom) {
    custom = `node harness/rehearsal-agent.mjs {agent} {task} ok`;
  }
  const effort = { 'every-build': 'high', systems: 'medium' }[effectiveMode().review] || null;
  const cmd = custom ? null : toolCommand(tool, { model, file, prompt, effort });
  if (!custom && !cmd) return { ok: false, message: `No launch command for tool "${tool}". Use --tool claude|codex|agy|cursor|grok|aider, or set STUDIO_${roleKey(role)}_CMD (with {kickoff}, {agent}, {model}).` };
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const logFile = path.join(AGENTS_DIR, `${agent}.log`);
  const out = fs.openSync(logFile, 'a');
  // A task on another version of the game (--track engine:godot) tags everything its agent records.
  const track = task ? readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === task).pop()?.meta?.track : null;
  // 2.30q (#8): launched sessions get compact harness output (gate logs to files, a trimmed task list).
  // 2.33.0: the agent sees only its own tool's credentials and the studio's settings (harness/agent-env.mjs).
  const env = agentEnv({ tool: custom ? 'custom' : tool, role, model, extra: { STUDIO_LOCK_OWNER: agent, STUDIO_AGENT_MODEL: model, STUDIO_ROLE: role, STUDIO_COMPACT_OUTPUT: process.env.STUDIO_COMPACT_OUTPUT ?? 'on', ...(track ? { STUDIO_TRACK: track } : {}) } });
  // Claude Code stops a shell command after 2 minutes by default, so agents sent a long verify to the
  // background and their session ended with it (test #3). Give commands 10 minutes unless set.
  env.BASH_DEFAULT_TIMEOUT_MS ||= '600000';
  env.BASH_MAX_TIMEOUT_MS ||= '1200000';
  // 2.30g: the Director and Producer start from the same prefix every time, often more than 5 minutes
  // apart, so they ask Claude Code for the 1-hour cache (Claude Code 2.1.108+; older versions ignore it).
  if (LONG_CACHE_ROLES.has(role) && process.env.STUDIO_LONG_CACHE !== 'off') {
    env.ENABLE_PROMPT_CACHING_1H ||= '1';
    env.CLAUDE_CODE_PROMPT_CACHE_TTL ||= '1h';
  }
  const fill = (s) => s.replaceAll('{kickoff}', file).replaceAll('{agent}', agent).replaceAll('{model}', model).replaceAll('{role}', role).replaceAll('{task}', task || '');
  if (copy) env.STUDIO_MAIN_ROOT = REPO_ROOT;
  const cwd = copy ? copy.dir : REPO_ROOT;
  const child = custom
    ? spawn(fill(custom), { cwd, shell: true, env, stdio: ['ignore', out, out] })
    : spawn(cmd.argv[0], cmd.argv.slice(1), { cwd, env, shell: IS.win, stdio: [cmd.stdin ? 'pipe' : 'ignore', out, out] });
  if (cmd?.stdin && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin);
  }
  const startedAt = new Date().toISOString();
  clearFlag(agent);
  const session = { agent, role, tool: custom && !viaTool ? 'custom' : tool, model, profile: profileOf(role, custom || ''), pid: child.pid, supervisor: process.pid, status: 'running', startedAt, lastBeat: startedAt, log: path.relative(REPO_ROOT, logFile), task, lane, oneTask, division, hiredBy: by, prefixHash: prefix?.hash || null, ...(copy ? { copy: { dir: path.relative(REPO_ROOT, copy.dir).split(path.sep).join('/'), branch: copy.branch } } : {}) };
  fs.writeFileSync(sessionFile(agent), JSON.stringify(session, null, 2));
  emitEvent({ type: 'agent.session.start', agent, model, status: 'running', task, msg: `${agent} started (${role}, ${session.tool}, ${model})${by ? `, hired by ${by}` : ''}${division ? ` into ${division}` : ''}`, meta: { role, tool: session.tool, pid: child.pid, division, hiredBy: by, lane } });
  const beat = setInterval(() => {
    const now = new Date().toISOString();
    const s = readJson(sessionFile(agent)) || session;
    const wip = wipSummary(agent);
    let progress = null;
    try {
      progress = heartbeatCheck(agent, { log: tailOf(logFile), model, task });
    } catch {
      // the refresh check is a help, never a blocker
    }
    // 2.30o: the stall check (harness/stall.mjs): no progress, a read-only burn, or past the wall-clock cap ends it.
    let stall = null;
    try {
      stall = observe({ ...session, ...s }, { tokens: logTokens(tailOf(logFile)), cwd });
    } catch {
      // the stall check is a guard, never a crash
    }
    fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, lastBeat: now, wip, ...(stall?.stalled ? { stalled: stall } : {}), ...(progress ? { progress: { turns: progress.turns, context: progress.context, state: progress.state } } : {}) }, null, 2));
    renewOwner(agent);
    // 2.30o: an idle session exits and frees its slot: no task claimed for STUDIO_IDLE_EXIT_MIN (5) minutes.
    let idle = null;
    try {
      const holds = listLocks().some((l) => l.owner === agent && l.key.startsWith('task:'));
      const lastProg = readStall(agent)?.lastProgressAt;
      const since = holds ? null : [s.idleSince || now, lastProg].filter(Boolean).sort().pop();
      idle = idleVerdict({ role, startedAt, idleSince: since });
      fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...readJson(sessionFile(agent)), idleSince: holds ? null : s.idleSince || now }, null, 2));
    } catch {
      // never a crash
    }
    if (idle?.exit && !s.idleExit) {
      fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...readJson(sessionFile(agent)), idleExit: idle.why }, null, 2));
      emitEvent({ type: 'agent.idle_exit', agent, to: 'producer', msg: `${agent} ended: ${idle.why}; its slot is free (a new session starts only when a task is ready)` });
      stopAgent(child.pid);
    }
    if (stall?.stalled && !s.stalled) {
      logStall({ ...session, ...s }, stall);
      stopAgent(child.pid);
    }
    // 2.31.0: the task this session holds used its budget across sessions: end the session, the task stays parked.
    try {
      const heldTask = listLocks().find((l) => l.owner === agent && l.key.startsWith('task:'))?.key.slice(5) || task;
      if (heldTask && !s.budgetStop) {
        const over = stopIfOverBudget(heldTask, { by: 'launcher' });
        if (over) {
          fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...readJson(sessionFile(agent)), budgetStop: over }, null, 2));
          emitEvent({ type: 'agent.budget_stop', agent, task: heldTask, to: 'producer', msg: `${agent} ended: ${over.split('. ')[0]}` });
          stopAgent(child.pid);
        }
      }
    } catch {
      // the budget check is a guard, never a crash
    }
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
  if (copy) removeLaneCopy(agent, { keepBranch: unmerged(copy.branch) > 0 });
  for (const p of lanePaths) release(`path:${p}`, agent);
  // Refreshed (2.29.2): the launcher reopens the same task at once in a fresh session that reads the hand-back.
  // The task it handed back, or the task it was started on when it hadn't claimed it yet (and it isn't done).
  const again = result.capped ? result.handed[0]?.task || (task && !parseNextQueue().done.some((t) => t.id === task) ? task : null) : null;
  const maxRefresh = Number(process.env.STUDIO_REFRESH_RELAUNCH ?? 5);
  if (again && !readStop() && (opts2.refreshes || 0) < maxRefresh) {
    emitEvent({ type: 'agent.refresh', agent, task: again, msg: `${agent} refreshed on ${again}; a fresh session continues from studio/handoffs/${again}.md` });
    return runAgent({ role, agent, tool, model, fallback, task: again, lane, oneTask, division, note: `Fresh session after a refresh: read studio/handoffs/${again}.md first; don't redo what it says is done.`, by, refreshes: (opts2.refreshes || 0) + 1 });
  }
  if (result.bad && !fallback.length && result.troubleKind === 'quota') {
    if (isNim(model, tool) && process.env.STUDIO_NIM_FALLBACK) fallback = [process.env.STUDIO_NIM_FALLBACK];
  }
  // 2.30o: any run-out (quota, 429 loop, spend or token cap, credit refused, 5xx refusals) on any launcher:
  // with no fallback given, the next tool in the budget order that isn't marked out takes the task over.
  if (result.bad && !fallback.length && result.troubleKind === 'quota' && process.env.STUDIO_TAKEOVER !== 'off') {
    const nxt = pickTool(tool);
    if (nxt && nxt !== tool && nxt !== `${tool}:${model}`) {
      fallback = [nxt];
      emitEvent({ type: 'tool.takeover', agent, to: 'human', status: 'warn', msg: `${agent} ran out on ${tool}${model ? ` (${model})` : ''}: ${nxt} takes over${task ? ` ${task}` : ''}` });
    }
  }
  // 2.30i: the launcher closed the task after a crash, so nothing is left to fail over.
  if (result.bad && fallback.length && !(result.finished?.length && !result.handed.length)) {
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
  const copy = readJson(sessionFile(agent))?.copy;
  const cwd = copy?.dir && fs.existsSync(path.join(REPO_ROOT, copy.dir)) ? path.join(REPO_ROOT, copy.dir) : REPO_ROOT;
  const r = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', ...(paths.length && cwd === REPO_ROOT ? paths : ['.'])], { cwd, encoding: 'utf8' });
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

/**
 * Save an agent's work on a task before its task is handed back: in its own copy (2.29) the uncommitted
 * files there, and its unmerged commits stay on its branch for the next agent; otherwise the files under
 * its claims in the shared checkout.
 */
function saveWorkOf(agent, task, mine, s = readJson(sessionFile(agent))) {
  const copyDir = s?.copy?.dir ? path.join(REPO_ROOT, s.copy.dir) : null;
  if (copyDir && fs.existsSync(copyDir)) {
    if (unmerged(s.copy.branch) > 0) rememberTaskBranch(task, s.copy.branch);
    return savePatch(agent, task, [], { cwd: copyDir });
  }
  return savePatch(agent, task, mine.map((l) => l.key));
}

/** The tasks an agent holds (its task locks), plus the task its session was started on. */
const tasksOf = (agent, s) => [...new Set([...listLocks().filter((l) => l.owner === agent && l.key.startsWith('task:')).map((l) => l.key.slice(5)), ...(s?.task ? [s.task] : [])])];

/** Pause an agent: its task goes back to the queue with a note (and its claims), then the process ends. */
export function pauseAgent(agent, note = '', by = 'war-room-human') {
  const s = sessions().find((x) => x.agent === agent && x.running);
  if (!s) return { ok: false, message: `${agent} isn't running.` };
  const mine = listLocks().filter((l) => l.owner === agent);
  const held = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
  // The patch is saved before the hand-back frees the claims, so the launcher's clean-up still has it.
  for (const t of held) {
    const patch = saveWorkOf(agent, t, mine);
    pauseTask(t, agent, `${note || `Paused from the War Room; ${agent}'s work so far is ${s.copy ? 'in its copy' : 'in the working tree'}.`}${patch ? ` Saved to ${patch}.` : ''}`, { force: true });
  }
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
    const mine = listLocks().filter((l) => l.owner === s.agent);
    const held = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
    for (const t of held) {
      const patch = saveWorkOf(s.agent, t, mine, s);
      pauseTask(t, s.agent, `The studio was stopped by ${by}${reason ? ` (${reason})` : ''}; ${s.agent}'s work so far is ${s.copy ? 'in its copy' : 'in the working tree'}${patch ? ` and saved to ${patch}` : ''}.`, { force: true });
    }
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

/**
 * The last lines of an agent's output. Claude's stream-json log is shown as a conversation (what it
 * said, each tool it ran, the result); --raw gives the lines as written.
 */
export function agentLog(agent, tail = 60, { raw = false } = {}) {
  const f = path.join(AGENTS_DIR, `${agent}.log`);
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  if (raw) return lines.slice(-tail).join('\n');
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t.startsWith('{')) {
      if (t) out.push(t);
      continue;
    }
    let o;
    try {
      o = JSON.parse(t);
    } catch {
      out.push(t);
      continue;
    }
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'text' && c.text?.trim()) out.push(`${agent}: ${c.text.trim().replace(/\s+/g, ' ').slice(0, 400)}`);
        else if (c.type === 'tool_use') out.push(`  → ${c.name} ${JSON.stringify(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? c.input ?? '').slice(0, 160)}`);
      }
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) if (c.type === 'tool_result' && c.is_error) out.push(`  ✗ ${String(Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content).replace(/\s+/g, ' ').slice(0, 200)}`);
    } else if (o.type === 'result') {
      const u = o.usage || {};
      out.push(`result (${o.subtype || 'done'}${o.is_error ? ', error' : ''}): ${String(o.result || '').replace(/\s+/g, ' ').slice(0, 300)} [in ${(u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)}, cache read ${u.cache_read_input_tokens || 0}, out ${u.output_tokens || 0}${o.total_cost_usd != null ? `, $${Number(o.total_cost_usd).toFixed(2)}` : ''}]`);
    } else if (o.type === 'system' && o.subtype === 'init') out.push(`(session ${o.session_id || ''} started: ${o.model || ''})`);
    else if (!['user', 'assistant', 'system', 'stream_event', 'rate_limit_event'].includes(o.type)) out.push(t.slice(0, 400));
  }
  return out.slice(-tail).join('\n');
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
  // Never two sessions on one task (test #2: T-160 and T-171 each started twice within seconds).
  if (opts.task) {
    const busy = sessions().find((s) => s.running && s.task === opts.task);
    const held = listLocks().find((l) => l.key === `task:${opts.task}` && l.owner !== agent);
    if (busy) return { ok: false, message: `Not started: ${busy.agent} is already on ${opts.task}.` };
    if (held) return { ok: false, message: `Not started: ${held.owner} holds ${opts.task}.` };
  }
  const c = caps(role, Number(opts.extra) || 0);
  if (!c.ok) return { ok: false, message: `Not started: ${c.why}.` };
  const spend = spentToday();
  if (spend.over) return { ok: false, message: `Not started: the daily token cap is spent (${spend.used} of ${spend.cap}).` };
  let tool = opts.tool || process.env[`STUDIO_${roleKey(role)}_TOOL`] || process.env.STUDIO_AGENT_TOOL || 'claude';
  let model = opts.model || process.env[`STUDIO_${roleKey(role)}_MODEL`] || process.env.STUDIO_AGENT_MODEL || 'unknown';
  // 2.30o: with no tool given, the first tool in the budget order that isn't marked out (a quota error or a
  // spend guard, harness/spend-guard.mjs) takes the session.
  if (!opts.tool) {
    const t = pickTool(tool);
    if (t && t !== tool) {
      emitEvent({ type: 'tool.takeover', agent: 'launcher', to: 'producer', msg: `${tool} is marked out; ${agent} starts on ${t}` });
      const [tt, ...mm] = t.split(':');
      tool = tt;
      if (!opts.model) model = mm.join(':') || process.env[`STUDIO_TOOL_${roleKey(tt)}_MODEL`] || model;
    }
  }
  // 2.30q (#7): the budget stop is checked after the takeover picked a tool; with every tool out, nothing starts.
  { const st = launchStop({ role, tool, model, agent, task: opts.task || null }); if (st) return { ok: false, skipped: true, message: `Not started: budget stop (${st.why}).` }; }
  // 2.30o: profile check before launch: a planning role never shares a builder's profile; per-profile limits.
  {
    const profile = profileOf(role, toolCmd(tool) || process.env[`STUDIO_${roleKey(role)}_CMD`] || (tool === 'custom' ? process.env.STUDIO_AGENT_CMD : ''));
    const running = sessions().filter((x) => x.running).map((x) => ({ agent: x.agent, role: x.role, profile: x.profile || 'default' }));
    const g = profileGuard({ role, profile, running });
    if (!g.ok) {
      emitEvent({ type: 'profile.refused', agent: 'launcher', to: 'producer', status: 'blocked', msg: `Not started (${role} on ${profile}): ${g.why}` });
      return { ok: false, message: `Not started: ${g.why}.` };
    }
  }
  // 2.35.0: a rescue runs on the rescue model: a different family from the models that got stuck (harness/rescue.mjs).
  if (opts.task && !opts.model) {
    try {
      const t = [...parseNextQueue().inProgress, ...parseNextQueue().backlog].find((x) => x.id === opts.task);
      const stuck = t ? rescueOf(t.title) : null;
      if (stuck) {
        // A later step skips the models earlier steps used, so the same blind spot isn't asked twice.
        const earlier = readRecentEvents(20000).filter((e) => e.type === 'task.rescue' && e.task === stuck && e.meta?.rescue !== opts.task).map((e) => e.meta?.model).filter(Boolean);
        const m = rescueModelFor(stuck, { exclude: earlier });
        if (m.model) {
          model = m.model;
          opts.model = m.model;
          emitEvent({ type: 'model.rescue', agent: opts.by || 'launcher', task: opts.task, msg: `${opts.task} (rescue of ${stuck}) runs on ${m.model}${m.differentFamily ? `, not ${m.usedFamilies.join('/') || 'the stuck task'}'s family` : ''}` });
        }
      }
    } catch {
      // the rescue model is a preference, never a blocker
    }
  }
  // 2.30d (plan #3): a task that came back without being done starts one model tier up.
  if (opts.task && !opts.model) {
    const esc = escalationFor(opts.task);
    if (esc && esc.tier !== esc.from) {
      if (esc.applied) model = esc.model;
      emitEvent({ type: esc.applied ? 'model.escalated' : 'model.escalation_suggested', agent: opts.by || 'producer', task: opts.task, msg: `${opts.task} was handed back ${esc.failed} time${esc.failed === 1 ? '' : 's'} without being done: ${esc.applied ? `starting on ${esc.model}` : `suggest a ${esc.tier}-tier model (set STUDIO_TIER_${esc.tier.toUpperCase()}_MODEL)`} instead of ${esc.fromModel || 'the last model'} (${esc.from})`, meta: esc });
    }
  }
  // 2.30h (3): the last hand-off was reasoning only: the Director's reroute moves the task to another family.
  if (opts.task && !opts.model) {
    const rr = rerouteFor(opts.task, readRecentEvents(5000));
    if (rr) {
      if (rr.applied) {
        model = rr.model;
        if (rr.tool && !opts.tool) tool = rr.tool;
      }
      emitEvent({ type: rr.applied ? 'model.rerouted' : 'model.reroute_suggested', agent: 'director', to: 'producer', task: opts.task, msg: `${opts.task}: ${rr.fromModel} (${rr.fromFamily}) replied with reasoning only; ${rr.applied ? `rerouted to ${rr.model}${rr.tool ? ` on ${rr.tool}` : ''}` : 'route it to another model family (set STUDIO_REROUTE_MODELS, e.g. codex:gpt-5)'}`, meta: rr });
    }
  }
  if (tool === 'codex' && model === 'unknown' && !process.env[`STUDIO_${roleKey(role)}_CMD`]) return { ok: false, message: 'Codex needs a model (--model, or STUDIO_AGENT_MODEL / STUDIO_<ROLE>_MODEL): its default is refused on ChatGPT logins.' };
  // 2.30i: NIM's free tier serves one session at a time (Marina: parallel NIM sessions all got 429).
  if (isNim(model, tool)) {
    const limit = providerConcurrency(model, tool, process.env);
    const nimRunning = sessions().filter((s) => s.running && isNim(s.model, s.tool));
    if (nimRunning.length >= limit) return { ok: false, message: `Not started: NIM allows ${limit} session(s) at a time; ${nimRunning[0]?.agent || 'an agent'} is on it.` };
  }
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

/**
 * The watcher's job: start agents for waiting tasks while the mode allows it. One launcher (test #2,
 * FIX 02): while the supervisor runs, it starts the agents and this does nothing; otherwise this uses
 * the supervisor's own picker (lanes, holds, task claims, caps, quota) with -auto- names.
 */
export async function fillAgents({ byDirector = false, autonomous = false } = {}) {
  const mode = effectiveMode();
  // 2.30o: away mode (or the game-dev loop asking for it) means the studio starts agents on its own.
  if (!mode.autoLaunch && !autonomous) {
    if (!(byDirector && !mode.chosen)) return { started: [], why: `${mode.label} doesn't start agents on its own` };
  }
  if (readStop()) return { started: [], why: 'the studio is stopped' };
  const { readStatus, supervise } = await import('./supervisor.mjs');
  const sup = readStatus();
  if (sup?.status === 'running' && alive(sup.pid)) return { started: [], why: `the supervisor (pid ${sup.pid}) starts agents` };
  const r = await supervise({ watcher: true, prefix: 'auto-', deps: { sessions, startAgent, launchableRoles, nextAgentName } }, { startedAt: Date.now(), names: [] });
  if (r.started.length) {
    const msg = byDirector && !mode.chosen ? `Started ${r.started.join(', ')} (pace not chosen yet: the Director started it)` : `Started ${r.started.join(', ')} (${mode.label}${mode.boost ? ' + MAX SPEED' : ''})`;
    emitEvent({ type: 'agent.auto_start', agent: 'watch', to: 'producer', msg });
  }
  return { started: r.started, why: r.why.join('; ') };
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
  if (!launchableRoles([role]).length) {
    const msg = `No tool is set to start ${label}: set STUDIO_AGENT_TOOL (or STUDIO_${roleKey(role)}_TOOL) in .env, or start it in Ops`;
    const lastAlert = readRecentEvents(2000).filter((e) => e.type === 'agent.no_tool' && e.msg === msg).pop();
    if (!lastAlert || Date.now() - Date.parse(lastAlert.ts) > 3600000) emitEvent({ type: 'agent.no_tool', agent: 'war-room', to: 'human', status: 'warn', msg });
    return { started: false, next: `${task ? `Queued as ${task} for ${label}. ` : `Saved for ${label}. `}No tool is set to start ${label} on its own (STUDIO_AGENT_TOOL or STUDIO_${roleKey(role)}_TOOL in .env), so it waits until someone starts that agent (Start agent in Ops, or npm run agent).` };
  }
  const r = startAgent({ role, agent: nextAgentName(role), task }, { detach: true });
  if (!r.ok) return { started: false, next: `${task ? `Queued as ${task}. ` : ''}${label} didn't start: ${r.message.replace(/^Not started: /, '')} It starts when a slot frees.` };
  emitEvent({ type: 'agent.wake', agent: 'war-room', to: role, task, msg: `Started ${r.agent} (${label})${why ? ` for ${why}` : ''}` });
  return { started: true, agent: r.agent, next: `${label} is starting now as ${r.agent} (${r.tool}${r.model !== 'unknown' ? `, ${r.model}` : ''})${task ? ` on ${task}` : ''}. Watch it in Ops.` };
}

/** Which roles can start without a person (for preflight and the War Room). */
export function launchableRoles(roles = ['producer', 'director', 'builder', 'qa-playtester', 'rnd', 'planner', 'art', 'reviewer', 'liaison']) {
  return roles.filter((r) => process.env[`STUDIO_${roleKey(r)}_CMD`] || process.env[`STUDIO_${roleKey(r)}_TOOL`] || process.env.STUDIO_AGENT_TOOL || (r === 'director' && process.env.STUDIO_DIRECTOR_CMD));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // 2.30i: keys in .env reach the agents (Jed's test needed a wrapper); never overrides the shell, never printed.
  const { loadDotEnv } = await import('./dotenv.mjs');
  loadDotEnv(path.join(REPO_ROOT, '.env'));
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
    // A hire runs in the background unless --foreground: tied to the hiring shell, it died with it and its
    // record stayed "running" with its claims held (test #3, engine-porter-1).
    const r = startAgent(base, { detach: argv.includes('--detach') || (cmd === 'hire' && !argv.includes('--foreground')) });
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
    const t = agentLog(argv[1], Number(flag('tail')) || 60, { raw: argv.includes('--raw') });
    console.log(t ?? `No log for ${argv[1]}.`);
    process.exit(t === null ? 1 : 0);
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
  if (cmd === 'stop-all') {
    // Used by npm run task -- stop: prints the agents it stopped, one per line.
    for (const a of stopAllAgents(flag('by') || 'human', flag('reason') || '')) console.log(a);
    process.exit(0);
  }
  if (cmd === 'fill') {
    const r = await fillAgents();
    console.log(r.started.length ? `Started: ${r.started.join(', ')}` : `Nothing started${r.why ? `: ${r.why}` : ''}.`);
    process.exit(0);
  }
  const list = sessions();
  if (!list.length) console.log('No agents started by the launcher yet. npm run agent -- start --role builder --agent builder-1 --tool claude --model claude-sonnet-5-5');
  for (const s of list) console.log(`${s.running ? (s.stalled ? 'STALLED' : 'running') : 'ended  '}  ${s.agent.padEnd(18)} ${String(s.role).padEnd(14)} ${s.tool}/${s.model}${s.task ? `  ${s.task}` : ''}${s.running ? `  heartbeat ${s.beatAgeMin} min ago` : `  ${s.reason || ''}`}${s.running && s.copy ? `  own copy ${s.copy.dir} (${s.copy.branch})` : ''}`);
  const others = otherAgents();
  for (const o of others.list) console.log(`outside  pid ${String(o.pid).padEnd(12)} not started by the launcher: ${o.command}`);
  if (others.list.length) console.log('  Agents outside the launcher keep no heartbeat and don\'t see Stop all until they next run a harness command. Prefer npm run agent -- hire.');
  const mode = effectiveMode();
  console.log(`\nMode: ${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, up to ${mode.maxAgents} agents. Roles that can start on their own: ${launchableRoles().join(', ') || 'none (set STUDIO_AGENT_TOOL or STUDIO_<ROLE>_TOOL in .env)'}.`);
}
