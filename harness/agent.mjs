#!/usr/bin/env node
/**
 * harness/agent.mjs — start agents, watch them, and clean up when one dies.
 *
 *   npm run agent -- start --role builder --agent builder-1 --tool claude|codex|agy|cursor|grok|aider|nim|custom --model <model> [--force-model]
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
 *   npm run agent -- allow agy [--dry-run] | --by <owner> [--scope user] [--all] [--prune]   the owner writes agy's
 *                                  headless allow-rules (the approved set) into .studio/agy-settings.json, which the launcher passes to agy
 *                                  with --settings (--scope user: agy's own settings.json instead; harness/agy-allow.mjs)
 *
 * What a start does:
 *   1. Refuses if the studio is stopped, the mode's caps are full, or the daily token cap is spent.
 *   2. Writes the agent's kickoff with its real model, and starts the tool with it: no shell (harness/launch.mjs),
 *      the prompt goes in on stdin (or as one argument), so the same line works on Windows, macOS
 *      and Linux. STUDIO_<ROLE>_CMD (or STUDIO_AGENT_CMD) overrides it with your own command;
 *      {kickoff}, {agent}, {model} and {role} are filled in, quoted for the shell.
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
import os from 'node:os';
import crypto from 'node:crypto';
import { allowedToolsList } from './allowlist.mjs';
import { fillCommand, localizeCommand, launchPlan, spawnPlan, spawnAgentSync, describePlan, resolveCommand, envValue } from './launch.mjs';
import { pinKickoff } from './task-pin.mjs';
import { agyAllowHint, noteAgyHint, allowCli, agyStudioSettings, AGY_SHELL_RULES, writeAgyLaneRules } from './agy-allow.mjs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { emitSampled } from './telemetry.mjs';
import { escalationFor } from './model-tiers.mjs';
import { launchRoute } from './routing.mjs';
import { sessionReasoningOnly, rerouteFor } from './reasoning-only.mjs';
import { kickoffParts } from './kickoff.mjs';
import { sweepThreads } from './threads.mjs';
import { layoutPrompt, recordPrefix, cacheStats, LONG_CACHE_ROLES, volatileLeaks } from './prompt-layout.mjs';
import { parseNextQueue, pauseTask, readStop, nextFor } from './task.mjs';
import { recordDenials } from './denials.mjs';
import { taskType } from './done-check.mjs';
import { listLocks, release, claim, renewOwner, tooBroad } from './lock.mjs';
import { AGY_STREAM_FLAGS, agyStreamOn, agyStreamWanted, userLine, driveAgyStream, taskStillOpen, streamFailure, readStreamRecord, writeStreamRecord, streamRecordHolds, STREAM_RECORD } from './agy-stream.mjs';
import { savePatch } from './wip.mjs';
import { laneList, laneEntries, readHolds } from './task-hold.mjs';
import { regionOnlyFiles } from './lane-regions.mjs';
import { engineLaunch } from './engine-tracks.mjs';
import { laneWantsCopy, lanelessWantsCopy, laneShareDirs, createLaneCopy, removeLaneCopy, unmerged, rememberTaskBranch, worktreeSupport, isLaneWorktree, LANES_DIR, laneLive } from './worktree.mjs';
import { effectiveMode, AUTOSTART_OFF } from './mode.mjs';
import { ownerOnlyStep } from './owner-only.mjs';
import { markExhausted, quotaKeyFor, toolNamed, weightedTokens, dailyCap, QUOTA_ERROR, LIMIT_STOP, customKey } from './budget.mjs';
import { sessionLimits, heartbeatCheck, newRedCheck, readFlag, clearFlag, HANDOFF_TEMPLATE } from './session-cap.mjs';
import { stopIfOverBudget } from './task-budget.mjs';
import { agentEnv, nimKeyMissing, nimModel, NIM_DEFAULT_MODEL, agentLikeName } from './agent-env.mjs';
import { aiderProgram, writeAiderIgnore, excludeAiderFiles } from './aider-launch.mjs';
import { pickNimModel, stubFetchFrom } from './nim-check.mjs';
import { AIDER_SESSION } from './models.config.mjs';
import { rescueOf, rescueModelFor } from './rescue.mjs';
import { cooldown } from './task-hold.mjs';
import { mapStale, writeMap } from './map.mjs';
import { pitfallsForPrompt } from './pitfalls.mjs';
import { recordFollow } from './scorecard.mjs';
import { untrustedBlock, oneLine } from './untrusted.mjs';
import { latestFacts } from './handback-facts.mjs';
import { jobDone } from './jobs.mjs';
import { isNim, providerConcurrency } from './families.mjs';
import { observe, logTokens, logStall, idleVerdict, readStall, stallEndOf, readLogFrom, resetStall, newestSessionPart, stallLimits } from './stall.mjs';
import { readPrices, readPriceMultipliers, priceFor, dollarsOf } from './autonomy.mjs';
import { reloadEnvIfChanged } from './env-reload.mjs';
import { profileGuard, profileOf } from './profile-guard.mjs';
import { toolCmd } from './spend-guard.mjs';
import { pickTool, readBudget, budgetStopFor } from './budget.mjs';
import { STOP_NOTE, loopHandBacks, parkOnce } from './busy.mjs';
import { sessionOutcome, parkIfNoWork } from './session-outcome.mjs';
import { writeAtomic } from './fsafe.mjs';
import { selfIdentity, spawnedIdentity, pidAlive, recordAlive, pidExists, readStarts, sameProcess } from './proc-identity.mjs';
import { gateEnv } from './gate-env.mjs';

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
    // PU-19: Claude Code's "5-hour limit reached ∙ resets 3pm" says neither "error" nor "usage limit".
    if (!/\berror\b|\bfailed\b|too many requests|\b429\b|\b401\b|usage limit reached|hit your (?:usage )?limit|\blimit (?:reached|exceeded|hit)\b|\breached your\b|invalid api key|not logged in/i.test(l)) continue;
    const q = l.match(QUOTA_ERROR);
    if (q) return { kind: 'quota', text: q[0], line: l, named: toolNamed(l) };
    const au = l.match(AUTH_ERROR);
    if (au) return { kind: 'auth', text: au[0], line: l, named: toolNamed(l) };
  }
  return null;
}
const IS = { win: process.platform === 'win32', mac: process.platform === 'darwin' };

/** M4 (2.58.3): NVIDIA NIM's OpenAI-compatible endpoint (the same base harness/models.config.mjs uses for route.mjs). */
export const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
/** H-1 (2.58.5): the NIM default model and the rule that a `nim` session never runs a role's or Claude's model live in
 * harness/agent-env.mjs (the kickoff's launch line uses them too); re-exported here as before. */
export { NIM_DEFAULT_MODEL, nimModel };
/**
 * H-1 (2.58.5): a NIM answer that the model is gone (410, "reached its end of life") or unknown (404) as one clear line,
 * else null. aider retries such an answer for a minute or two, then exits, and the log holds only litellm's retries.
 */
export function nimModelTrouble(log, model = null) {
  const lines = String(log || '').split(/\r?\n/).slice(-400).join(' ');
  const m = lines.match(/Error code: (410|404)\b[^\n]{0,600}/);
  if (!m) return null;
  const named = (m[0].match(/model '([^']+)'/) || m[0].match(/model[: ]+"?([\w.-]+\/[\w.:+-]+)/) || [])[1] || model || 'the model';
  const what = m[1] === '410' ? 'is gone (410: past its end of life)' : 'was not found (404)';
  return `NIM says ${named} ${what}: start with --model <a model NIM lists now> or set STUDIO_NIM_MODEL (npm run models:check lists what your key can use; the default is ${NIM_DEFAULT_MODEL}).`;
}
/** Whether a program is on this PATH (env: the agent's). Windows: the launcher's own PATH x PATHEXT lookup. */
export function onPath(name, env = process.env, platform = process.platform) {
  if (platform === 'win32') return resolveCommand(name, { env, platform }).mode !== 'missing';
  return String(envValue(env, 'PATH', platform) || '').split(path.delimiter).filter(Boolean).some((d) => {
    try { const f = path.join(d, name); return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; }
  });
}
/**
 * Why a built-in tool can't start before anything is spawned (null: it can). M4: nim needs aider and a NIM key.
 * B-18 (2.60.1): aider (nim and aider) is STUDIO_AIDER_CMD, else the studio's .studio/aider-venv, else PATH
 * (harness/aider-launch.mjs aiderProgram, which the launched argv uses too).
 */
export function toolPreflight(tool, env = process.env, platform = process.platform) {
  if (tool !== 'nim' && tool !== 'aider') return null;
  const prog = aiderProgram({ env, platform, onPath });
  if (!prog.cmd) return prog.why;
  if (tool === 'nim' && nimKeyMissing(env)) return 'NVIDIA_API_KEY is not set: add your NVIDIA NIM key to .env (the agent gets it as OPENAI_API_KEY; it is never printed)';
  return null;
}

/**
 * B-20, B-21, B-37 (2.60.1): the arguments every aider session (nim, aider) gets after its model and message file.
 * --no-pretty --no-fancy-input: stdout is a log file, not a terminal (prompt-toolkit warned on Git Bash's
 * xterm-256color). --no-gitignore: aider would add `.aider*` to the tracked .gitignore. --aiderignore <file>: the
 * harness's folders and the protected paths are never added to its chat or edited. --read <brief>: the task's brief,
 * read-only. --map-tokens / --map-refresh (models.config.mjs AIDER_SESSION; STUDIO_AIDER_MAP_TOKENS,
 * STUDIO_AIDER_MAP_REFRESH): a bounded repo map. --subtree-only is not used: a session's folder is the repo root.
 */
export function aiderTail({ ignoreFile = null, reads = [], env = process.env } = {}) {
  const mt = String(env.STUDIO_AIDER_MAP_TOKENS ?? '').trim();
  const tokens = /^\d+$/.test(mt) ? mt : String(AIDER_SESSION.mapTokens);
  const refresh = String(env.STUDIO_AIDER_MAP_REFRESH || '').trim() || AIDER_SESSION.mapRefresh;
  return ['--no-pretty', '--no-fancy-input', '--no-gitignore', '--map-tokens', tokens, ...(refresh && /^(auto|always|files|manual)$/.test(refresh) ? ['--map-refresh', refresh] : []),
    ...(ignoreFile ? ['--aiderignore', ignoreFile] : []), ...(reads || []).filter(Boolean).flatMap((r) => ['--read', r])];
}

/** H-2: the settings file as agy's argument. A path with a space (C:\\Users\\Jo Ann\\…) would split as the prompt did, so
 * it is given relative to the agent's folder then (.studio/ is the main checkout's, linked in a lane copy). */
function agySettingsArg(file) {
  if (!file || !/\s/.test(file)) return file;
  const rel = path.relative(REPO_ROOT, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !/\s/.test(rel) ? rel : file;
}

/**
 * 2.76.0 (B-80; the crew's local patches W-0072, W-0073): agy's options before --settings.
 *   --print-timeout STUDIO_AGY_PRINT_TIMEOUT (5400s): 900 s ended a builder mid test run ("print timeout after 15m0s
 *       while the agent was waiting on 1 background task"); a builder session runs up to 90 min (STUDIO_SESSION_MAX_MIN).
 *   --mode STUDIO_AGY_MODE (accept-edits; off drops it): agy's analogue of Claude's acceptEdits. A headless agy session
 *       ends at its first refused tool, and file writes were refused even with a write_file allow rule. Commands stay
 *       on the --settings allow-list.
 *   --model <model> when one is given (STUDIO_AGY_MODEL_FLAG names the flag; off drops it): with no model passed agy ran
 *       its own default (a Claude model), not Gemini. UNTESTED on real agy: the flag's name (agy models lists the names).
 * A value that isn't one plain word is ignored (the default is used).
 */
export const AGY_DEFAULT_MODEL = 'gemini-4-argon-high';
/**
 * 2.77.0 (n, the owner's Priority 8): agy serves Gemini here. agy also lists Claude and other models, and with a
 * non-Gemini model (or none) it ran Claude Sonnet inside agy: the session spent Claude's pool while the record said agy.
 * isGeminiModel: a Gemini model id (gemini-…, models/gemini-…). modelFamilyTool: the tool a model's family runs on
 * here (gemini -> agy, claude/opus/sonnet/haiku -> claude), or null.
 */
export const isGeminiModel = (m) => /^(models\/)?gemini[-_.]/i.test(String(m || '').trim());
export function modelFamilyTool(m) {
  const s = String(m || '').trim().toLowerCase();
  if (isGeminiModel(s)) return 'agy';
  if (/^(claude|opus|sonnet|haiku)\b|^claude-/.test(s)) return 'claude';
  return null;
}
/** STUDIO_AGY_ANY_MODEL=on (or --force-model): agy may run a model that isn't Gemini (a person's explicit choice). */
export const agyAnyModel = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env.STUDIO_AGY_ANY_MODEL || '').trim());
export function agyOptions(model = null, env = process.env) {
  const word = (v, d) => (/^[\w.:-]{1,60}$/.test(String(v ?? '').trim()) ? String(v).trim() : d);
  const timeout = word(env.STUDIO_AGY_PRINT_TIMEOUT, '5400s');
  const mode = /^(off|0|false|no|none)$/i.test(String(env.STUDIO_AGY_MODE || '')) ? null : word(env.STUDIO_AGY_MODE, 'accept-edits');
  const flag = /^(off|0|false|no|none)$/i.test(String(env.STUDIO_AGY_MODEL_FLAG || '')) ? null : (/^--?[\w-]{1,30}$/.test(String(env.STUDIO_AGY_MODEL_FLAG || '').trim()) ? String(env.STUDIO_AGY_MODEL_FLAG).trim() : '--model');
  const m = model && model !== 'unknown' ? word(model, null) : null;
  return ['--print-timeout', /^\d+$/.test(timeout) ? `${timeout}s` : timeout, ...(mode ? ['--mode', mode] : []), ...(flag && m ? [flag, m] : [])];
}

/**
 * How each tool is started: an argv, the prompt on stdin (stdin) or as one argument (promptAt, its index in argv).
 * P-066 (crew P-036): harness/launch.mjs starts the argv with no shell on every OS, so each element arrives as one
 * argument. The prompt goes on stdin where the tool reads it there (claude -p with no prompt argument, codex's -, and
 * since 2.58.5 agy); cursor and grok take it as one argument, and a prompt too long for the command line becomes an
 * instruction to read the kickoff file.
 */
export function toolCommand(tool, { model, file, prompt, effort, addDirs = [], aider = {}, stream = false }) {
  const m = model && model !== 'unknown' ? model : null;
  // M1 (2.58.3): a session in a lane copy (.lanes/<agent>) reads studio/ and .studio/ through links to the main
  // checkout; Claude Code resolves the link and refuses a target outside its working directory ("outside the allowed
  // working directories"), so the launcher names the main checkout's real folders (harness/worktree.mjs laneShareDirs).
  // Each flag and each path is its own argument. Codex takes the same flag (extra writable roots) but an older Codex
  // refuses it and its sandbox already reads outside the copy, so Codex gets it only with STUDIO_CODEX_ADD_DIR=on.
  // The others: no known flag.
  const dirs = (addDirs || []).filter(Boolean).flatMap((d) => ['--add-dir', d]);
  switch (tool) {
    case 'claude': {
      // Builders need Playwright, vite, ffmpeg and asset tools too (run #1: a narrow list failed silently).
      // In a frozen test clone, STUDIO_CLAUDE_BYPASS=1 skips permission prompts entirely; the clone is the boundary.
      // stream-json (2.26): the log keeps every message and tool call, not only the final result, so a
      // session can be read back (test #2: --output-format json left nothing but the last answer).
      const bypass = process.env.STUDIO_CLAUDE_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      // harness/allowlist.mjs: the same list the kickoff prints (2.30c). P-066: each pattern is its own argument after
      // the flag (Claude Code takes a space-separated list), so "Bash(git log *)" never depends on quoting.
      const allowed = allowedToolsList();
      // 2.29.2: a turn ceiling, so no session runs 126 turns again (the refresh point, 40 turns, is in the kickoff).
      const ceiling = sessionLimits().ceilingTurns;
      return { argv: ['claude', '-p', ...(bypass ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'acceptEdits', '--allowedTools', ...allowed]), ...dirs, '--output-format', 'stream-json', '--verbose', ...(ceiling > 0 ? ['--max-turns', String(ceiling)] : []), ...(m ? ['--model', m] : []), ...(effort ? ['--effort', effort] : [])], stdin: prompt };
    }
    case 'codex': {
      // In a frozen test clone, Codex's sandbox can't write .git or bind 127.0.0.1 on macOS; the clone itself is the boundary.
      const bypass = process.env.STUDIO_CODEX_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      return { argv: ['codex', 'exec', '--json', ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']), ...(/^(on|1|true|yes)$/i.test(process.env.STUDIO_CODEX_ADD_DIR || '') ? dirs : []), ...(m ? ['-m', m] : []), '-'], stdin: prompt };
    }
    case 'agy': {
      // From run #1: agy exits with "I'll report back" before it finishes unless it has a print timeout
      // and stdin is closed; no script(1) wrapper needed. In a frozen test clone it may skip its own
      // permission prompts (STUDIO_AGY_BYPASS=1), since nobody is there to answer them.
      const bypass = process.env.STUDIO_AGY_BYPASS === '1' && fs.existsSync(path.join(STUDIO_STATE_DIR, 'harness-frozen'));
      // M3 (2.58.3, crew P-037 addendum): agy takes a session settings file (--settings <file>); the studio's own
      // (.studio/agy-settings.json, written by `npm run agent -- allow agy`) is passed when it exists.
      const settings = agySettingsArg(agyStudioSettings());
      const tail = [...agyOptions(m), ...(settings ? ['--settings', settings] : []), ...(bypass ? ['--dangerously-skip-permissions'] : [])];
      // H-2 (2.58.5): on Windows agy.exe got `-p <prompt>` as one argument (started directly, no shell, quoted by the
      // rules every Windows program reads) and still said `unexpected argument "are"`: the prompt ("You are …") was split
      // at its spaces after it reached agy.exe. agy reads a prompt from stdin too ("Prompts are read only from -p/--print,
      // -i/--prompt-interactive, or stdin"), so the kickoff goes there and no argument has a space to split.
      // STUDIO_AGY_PROMPT=arg brings back `-p <prompt>` (UNTESTED on real agy: which of the two works for your agy).
      if (/^(arg|argument|p)$/i.test(process.env.STUDIO_AGY_PROMPT || '')) return { argv: ['agy', '-p', prompt, ...tail], promptAt: 2 };
      // 2.77.3 (C1 / B-99): stream (the default since 2.78.1, STUDIO_AGY_STREAM=0 turns it off; the launcher asks for it
      // for a builder-like session, harness/agy-stream.mjs): the kickoff is the first stream-json user message (keyed on
      // "event", B-118) and stdin stays open, so the launcher can send a follow-up when a turn ends with the task still in
      // progress. --print-timeout and the other options stay as they are.
      if (stream && agyStreamOn()) return { argv: ['agy', ...AGY_STREAM_FLAGS, ...tail], stdin: userLine(prompt), stream: 'agy' };
      return { argv: ['agy', ...tail], stdin: prompt };
    }
    case 'cursor':
      return { argv: ['agent', '-p', '--force', '--output-format', 'text', prompt], promptAt: 5 };
    case 'grok':
      return { argv: ['grok', '-p', prompt, ...(m ? ['-m', m] : []), '--output-format', 'json', '--always-approve'], promptAt: 2 };
    case 'aider':
      // B-18: aider.program is the launcher's resolved aider (STUDIO_AIDER_CMD, the venv, or 'aider' on PATH).
      return { argv: [aider.program || 'aider', '--model', `ollama_chat/${m || process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b'}`, '--message-file', file, '--yes', ...aiderTail(aider)] };
    case 'nim':
      // M4 (2.58.3, crew P-040): aider on NVIDIA NIM's OpenAI-compatible endpoint, so a NIM model can edit files and run
      // commands (route.mjs only chats). Same shape as the Ollama case, without aider's own commits. The key
      // never goes in argv: the child gets OPENAI_API_KEY from NVIDIA_API_KEY (harness/agent-env.mjs).
      // H-1 (2.58.5): nimModel() never takes a role's or Claude's model. H-8: --no-auto-commits, the owner's condition
      // for NIM (aider's own commits skipped the studio's hooks and task flow; the crew set AIDER_AUTO_COMMITS=false).
      // 2.60.1: B-18 the resolved aider; B-20/B-21 aiderTail (no pretty output, ignore file, the brief as --read).
      return { argv: [aider.program || 'aider', '--model', `openai/${nimModel(m)}`, '--openai-api-base', NIM_API_BASE, '--message-file', file, '--yes-always', '--no-auto-commits', ...aiderTail(aider)] };
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
// A heartbeat older than this many minutes is a stalled session (agent list and the watcher say so).
const STALL_BEAT_MIN = Math.max(5, (HEARTBEAT_MS / 60000) * 3);

/**
 * Every agent session the launcher knows, with whether it is still running. PU-17 (P-045): a cheap check with no
 * child process (harness/proc-identity.mjs pidAlive): a number in use is alive, as before; on Linux a /proc start
 * that differs from the one recorded at launch means the number is another program's now.
 */
export function sessions() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(AGENTS_DIR, f))).filter(Boolean).map((s) => {
    const running = s.status === 'running' && recordAlive(s);
    const beatAge = s.lastBeat ? Math.round((Date.now() - Date.parse(s.lastBeat)) / 60000) : null;
    const ending = running ? wrappingUp(s) : null;
    // 2.73.2 (B-72): an ending session's heartbeat stops while its launcher hands its work back: not a stall.
    return { ...s, running, beatAgeMin: beatAge, stalled: running && !ending && beatAge !== null && beatAge > STALL_BEAT_MIN, ...(ending ? { ending } : {}) };
  });
}

/**
 * 2.73.2 (B-72): the agent's process has ended and its (live) launcher is wrapping up: it saves the work, may close the
 * task itself (autoFinish runs the gates, minutes with no heartbeat) and records the end. The watchdog ended
 * builder-s122, its process was gone, but the record still said running with a heartbeat going stale, so the listing
 * said STALLED, the watchdog logged "Ended" on every pass and the watch pass raised a stall task. { since, why } or null.
 * The launcher marks it at once (agentExited); a launcher that hasn't yet (or can't) is seen by its agent's pid being
 * gone. Bounded: past STUDIO_DONE_RUNNING_MAX_MIN (90) minutes it is a stall again (a hung launcher).
 */
export function wrappingUp(s, now = Date.now(), env = process.env) {
  if (!s || s.status !== 'running' || s.starting || !s.pid || !s.supervisor || s.supervisor === s.pid) return null;
  const mark = s.agentExited && (!s.agentExited.startedAt || !s.startedAt || s.agentExited.startedAt === s.startedAt) ? s.agentExited : null;
  if (!mark && pidAlive(s.pid, s.identity?.pid)) return null;
  const since = mark?.at || s.lastBeat || s.startedAt || null;
  const max = Number(env.STUDIO_DONE_RUNNING_MAX_MIN ?? 90);
  if (Number.isFinite(max) && max > 0 && since && now - Date.parse(since) > max * 60000) return null;
  return { since, why: mark ? `its agent exited${mark.kind && mark.kind !== 'exit' ? ` (${mark.kind})` : ''}; the launcher is handing its work back` : `its agent's process (pid ${s.pid}) is gone; the launcher is handing its work back` };
}

/** 2.73.2 (B-72): the launcher notes at once that its agent exited (before its clean-up, which can take minutes). */
function markAgentExited(agent, startedAt, info) {
  try {
    const cur = readJson(sessionFile(agent));
    if (!cur || cur.status !== 'running' || (cur.startedAt && cur.startedAt !== startedAt)) return;
    writeAtomic(sessionFile(agent), JSON.stringify({ ...cur, agentExited: { startedAt, ...info }, lastBeat: new Date().toISOString() }, null, 2), { fsync: false });
  } catch { /* the listing still sees the agent's pid gone */ }
}

/**
 * 2.73.2 (B-72): one agent.session.end per session, whoever records it (the launcher's clean-up, the watch pass's
 * markGone, a stop's endAsDead). An atomic create of .studio/session-ends/<agent>.<hash of startedAt>: true for the
 * first caller only. Markers older than a week are pruned.
 */
export function claimSessionEnd(agent, startedAt, by = 'launcher') {
  if (!agent || !startedAt) return true;
  const dir = path.join(STUDIO_STATE_DIR, 'session-ends');
  const name = `${String(agent).replace(/[^\w.-]/g, '_')}.${crypto.createHash('sha1').update(String(startedAt)).digest('hex').slice(0, 12)}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), `${JSON.stringify({ agent, startedAt, by, at: new Date().toISOString(), pid: process.pid })}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    return true; // can't tell: record it, as before
  }
  try { const old = Date.now() - 7 * 86400000; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).mtimeMs < old) fs.rmSync(p, { force: true }); } } catch {}
  return true;
}

/**
 * 2.30h: locks held by agents whose process is gone are freed at once (not left to run out): an owner with a
 * launcher session record and no running session. People and CLI owners have no record and are left alone.
 */
export async function releaseDeadLocks(list = sessions()) {
  const known = new Map();
  for (const s of list) known.set(s.agent, (known.get(s.agent) || false) || s.running);
  const endedAt = new Map(list.filter((s) => !s.running && s.endedAt).map((s) => [s.agent, Date.parse(s.endedAt) || 0]));
  const { releaseDeadOwners } = await import('./lock.mjs');
  // 2.55.0 (P-028): only claims made before that session ended are its own. A chat bot claiming tasks itself under
  // the same name after the session ended keeps its claim.
  const freed = releaseDeadOwners((owner, l) => known.has(owner) && !known.get(owner) && !(endedAt.get(owner) && Date.parse(l?.claimedAt || '') > endedAt.get(owner)));
  if (freed.length) emitEvent({ type: 'lock.dead_released', agent: 'watch', msg: `Freed ${freed.length} lock(s) held by agents whose process is gone: ${freed.join(', ')}`.slice(0, 300), meta: { freed } });
  return freed;
}

/**
 * Sessions whose record says "running" but whose process is gone (killed with the shell that started it,
 * a crash, a reboot) are marked ended, so the War Room and agent list stop showing them and the watcher
 * hands their task back and frees their claims (test #3). Returns the agents marked.
 */
/**
 * 2.71.1 (B): the task a session worked on, for its agent.session.end event (tokens per landed change, per task): the
 * launcher's own record (the task it was started on), else the one task lock the agent holds. null: neither says.
 */
export function sessionTask(s, locks = null) {
  if (s?.task) return String(s.task);
  try {
    const held = (locks || listLocks()).filter((l) => l.owner === s?.agent && l.key.startsWith('task:')).map((l) => l.key.slice(5));
    return held.length === 1 ? held[0] : null;
  } catch { return null; }
}

/** The last task this agent claimed (task.start) since its session started, from the event log; null if none. */
export function claimedSince(agent, startedAt, events = null) {
  try {
    const from = Date.parse(startedAt || '') || 0;
    const mine = (events || readRecentEvents(5000)).filter((e) => e.type === 'task.start' && e.agent === agent && e.task && Date.parse(e.ts) >= from - 1000);
    return mine.length ? String(mine[mine.length - 1].task) : null;
  } catch { return null; }
}

export function markGone() {
  const gone = [];
  for (const s of sessions()) {
    if (s.status !== 'running' || s.running) continue;
    const at = new Date().toISOString();
    fs.writeFileSync(sessionFile(s.agent), JSON.stringify({ ...s, running: undefined, stalled: undefined, beatAgeMin: undefined, ending: undefined, status: 'ended', endedAt: at, reason: 'its process is gone (killed, crashed or the machine restarted)' }, null, 2));
    // 2.73.2 (B-72): one agent.session.end per session (claimSessionEnd), whichever pass or launcher records it.
    if (claimSessionEnd(s.agent, s.startedAt, 'watch')) emitEvent({ type: 'agent.session.end', agent: s.agent, model: s.model, task: sessionTask(s) || claimedSince(s.agent, s.startedAt) || undefined, status: 'error', msg: `${s.agent} ended: its process is gone (last heartbeat ${s.lastBeat || 'never'})`, meta: { role: s.role, tool: s.tool, reason: 'process gone', startedAt: s.startedAt || undefined, bootAt: new Date(Date.now() - os.uptime() * 1000).toISOString() } }); // 2.71.0 (z): times for harness/workaround.mjs
    // 2.65.0: the uniform job.done (harness/jobs.mjs) beside agent.session.end.
    jobDone({ kind: 'session', id: s.agent, agent: s.agent, task: s.task || null, result: 'gone', ms: Date.parse(s.startedAt) ? Date.now() - Date.parse(s.startedAt) : null, tail: `its process is gone (last heartbeat ${s.lastBeat || 'never'})`, log: s.log || null, extra: { role: s.role || null } });
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
      claude = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, turns: Number(o.num_turns) || null, ...writeSplit(u) };
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
      // 2.65.2: in the OpenAI shapes the cached tokens are part of prompt_tokens / input_tokens
      // (prompt_tokens_details.cached_tokens, input_tokens_details.cached_tokens, cached_input_tokens), so they come
      // off the input, as the Codex path does; before, they were counted as fresh input (and cached_input_tokens twice).
      // In Anthropic's shape input_tokens excludes cache reads, and cache writes are added as the Claude path adds them.
      const u = o.usage;
      if (u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null) {
        plain = { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, ...writeSplit(u) };
      } else {
        const cached = Number(u.cached_input_tokens ?? u.input_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_tokens) || 0;
        plain = { in: Math.max(0, ((u.input_tokens ?? u.prompt_tokens) || 0) - cached), cacheRead: cached, out: (u.output_tokens ?? u.completion_tokens) || 0 };
      }
    }
  }
  const r = claude || (codex.seen ? { in: codex.in, cacheRead: codex.cached, out: codex.out, turns: codex.turns } : plain);
  // Turns too (2.28): each turn re-reads the whole context, so cost follows turns more than file size
  // (Jed's sandbox A/B: a map-first workflow added turns and cost 27% more cache reads).
  return r ? { tokensIn: r.in, tokensOut: r.out, cacheRead: r.cacheRead, costUsd: cost, turns: r.turns || null, cacheWrite: r.cacheWrite || 0, cacheWrite5m: r.cacheWrite5m ?? null, cacheWrite1h: r.cacheWrite1h ?? null } : { tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsd: null, turns: null, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null };
}
/** 2.65.2: cache writes (already in tokensIn) and, when the usage gives it (cache_creation), their 5-minute / 1-hour split. */
function writeSplit(u) {
  const c = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const n = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Number(x));
  return { cacheWrite: Number(u.cache_creation_input_tokens) || 0, cacheWrite5m: c ? n(c.ephemeral_5m_input_tokens) : null, cacheWrite1h: c ? n(c.ephemeral_1h_input_tokens) : null };
}

/** 2.65.2: the prompt-cache TTL the launcher asks Claude Code for in this role's sessions (recorded at session end, so cache writes are priced by it when the stream gives no split). */
export const cacheTtlAsked = (role) => (LONG_CACHE_ROLES.has(role) && process.env.STUDIO_LONG_CACHE !== 'off' ? '1h' : '5m');

/** 2.30i: a session that ended without task done gets the launcher's foreground verify: a clean exit, or a crash after it committed. */
/** 2.77.2 (B-107): did the session commit work for its task? In a lane copy: its branch is ahead of main. In the shared
 * checkout: a commit naming the task since it started (logHit, called only then). */
export const workCommitted = ({ ahead = 0, inCopy = false, logHit = () => false } = {}) => Number(ahead) > 0 || (!inCopy && Boolean(logHit()));

export function crashFinishable({ code, trouble, reasoningOnly, capped, hasCommit }) {
  if (trouble || reasoningOnly || capped) return false;
  return Boolean(hasCommit) && Number.isInteger(code);
}

/**
 * 2.78.2 (a): is task `id`'s lane queued for the merge train by this session (its agent, or its lane branch)? The queue
 * entry stays until the train lands it or hands it back (harness/train.mjs). Never throws.
 */
export function trainQueued(id, { agent = null, branch = null, stateDir = STUDIO_STATE_DIR } = {}) {
  try {
    const q = JSON.parse(fs.readFileSync(path.join(stateDir, 'train', 'queue.json'), 'utf8'));
    return Array.isArray(q) && q.some((e) => e?.task === id && ((agent && e.agent === agent) || (branch && e.branch === branch)));
  } catch { return false; }
}

/** After an agent exits: record it, and if it died holding work, hand the work back cleanly. */
/**
 * 2.73.1 (B-66): how a session's process ended, as far as Node can tell: { kind, code, signal, at, by?, why? }.
 *   stopped      a person or the Producer stopped or paused it (stopAgent's mark: a kill from its parent's side)
 *   stall|idle|budget  this launcher ended it (the stall watchdog, the idle exit, the task's budget)
 *   spawn-error  its program never started
 *   signal       it was killed by a signal from outside (SIGKILL from the OOM killer, a SIGTERM to its tree, …)
 *   exit         it exited by itself with this code. On Windows a kill from outside (taskkill /F) reads as exit 1:
 *                Windows has no signals, so "exit 1" there may still be an outside kill.
 * ranSec: how long its process ran (the halt rule merges only sessions that had got going, harness/supervisor.mjs).
 * A session whose launcher died too is ended later by markGone/endAsDead with reason 'process gone' (no exit cause).
 */
export function exitCause({ code, exit = {}, stop = null } = {}) {
  const base = { code: code ?? null, signal: exit.signal || null, at: exit.at || new Date().toISOString(), ...(Number.isFinite(exit.ranMs) ? { ranSec: Math.round(exit.ranMs / 1000) } : {}) };
  if (stop) return { ...base, kind: 'stopped', by: stop.by, why: stop.kind || 'stop' };
  if (exit.killedBy?.kind) return { ...base, kind: exit.killedBy.kind, by: exit.killedBy.by || 'launcher', why: String(exit.killedBy.why || '').slice(0, 200) };
  if (exit.spawnError) return { ...base, kind: 'spawn-error', why: String(exit.spawnError).slice(0, 200) };
  if (exit.signal) return { ...base, kind: 'signal', why: `killed by ${exit.signal} from outside the launcher` };
  return { ...base, kind: 'exit' };
}

/**
 * 2.76.0 (B-82): a session's usage from its stream (each assistant message's usage, once per message id, newest Claude
 * session only), for a session that ended with no result line of its own: the launcher ended it (stall, idle, budget),
 * or it crashed. Same shape as tokensFrom; null when the stream carries no usage.
 */
export function streamUsage(log) {
  const seen = new Set();
  let n = 0; const r = { in: 0, cacheRead: 0, out: 0, cacheWrite: 0, cacheWrite5m: null, cacheWrite1h: null };
  for (const l of newestSessionPart(log).split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{') || !t.includes('usage')) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    if (o.type === 'result') continue;
    const u = o.message?.usage;
    if (!u || typeof u !== 'object') continue;
    const id = o.message?.id;
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    n += 1;
    const w = writeSplit(u);
    r.in += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    r.cacheRead += Number(u.cache_read_input_tokens) || 0;
    r.out += Number(u.output_tokens) || 0;
    r.cacheWrite += w.cacheWrite;
    if (w.cacheWrite5m !== null) r.cacheWrite5m = (r.cacheWrite5m || 0) + w.cacheWrite5m;
    if (w.cacheWrite1h !== null) r.cacheWrite1h = (r.cacheWrite1h || 0) + w.cacheWrite1h;
  }
  return n ? { tokensIn: r.in, tokensOut: r.out, cacheRead: r.cacheRead, costUsd: null, turns: n, cacheWrite: r.cacheWrite, cacheWrite5m: r.cacheWrite5m, cacheWrite1h: r.cacheWrite1h, fromStream: true } : null;
}

/** 2.76.0 (B-82): dollars for a session's usage at studio/prices.json (harness/autonomy.mjs), or null with no price row. */
export function estimateCost(tok, { model, tool, role } = {}) {
  try {
    const prices = readPrices();
    if (!prices || !priceFor(prices, model, tool)) return null;
    const meta = { tool, cacheRead: tok.cacheRead, cacheWrite: tok.cacheWrite, cacheWrite5m: tok.cacheWrite5m, cacheWrite1h: tok.cacheWrite1h, cacheTtl: tok.cacheWrite ? cacheTtlAsked(role) : undefined };
    const d = dollarsOf([{ model, tokensIn: tok.tokensIn, tokensOut: tok.tokensOut, meta }], prices, readPriceMultipliers());
    return d.priced ? Math.round(d.usd * 10000) / 10000 : null;
  } catch { return null; }
}

/**
 * 2.76.0 (B-80, the crew's adapter checklist item 3): why a headless agy session stopped, from its own log: the
 * "jetski: …" line or a "… permission that headless mode cannot prompt for" refusal (one denial ends the session).
 * null when there is none.
 */
export function agyStopLine(log) {
  const lines = String(log || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = [...lines].reverse().find((l) => /^jetski:|headless mode cannot prompt|auto-denied|print timeout after/i.test(l));
  return hit ? hit.replace(/\s+/g, ' ').slice(0, 300) : null;
}

/**
 * 2.77.0 (n, the owner's Priority 8 telemetry): what an agy session used, from its own output. agy -p printed only its
 * final text in the crew's logs (no usage line, no model), so every agy session recorded 0 tokens and the session's
 * model was whatever the launcher passed. Read here, newest session part only:
 *   - Gemini usage objects: usageMetadata { promptTokenCount, candidatesTokenCount, cachedContentTokenCount } (one per
 *     response id, the last one counts), or a stats.models.<model>.tokens { prompt, candidates, cached } summary (the
 *     Gemini CLI's --output-format json shape); a plain `usage` line is tokensFrom's already;
 *   - the model it names: modelVersion, model, or the stats.models key.
 * { reported: true, tokensIn, tokensOut, cacheRead, model } or, with nothing reported, an estimate from text length
 * (the kickoff in, the session's output out, ~4 characters a token): { reported: false, estimated: true, tokensIn,
 * tokensOut, cacheRead: 0, model } — recorded as usage "not reported", never as 0.
 */
export function agyUsage(log, { kickoffChars = 0 } = {}) {
  const part = newestSessionPart(String(log || ''));
  let model = null;
  const byResp = new Map();
  let stats = null;
  let n = 0;
  for (const l of part.split(/\r?\n/)) {
    const t = l.trim();
    if (!t.startsWith('{')) continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const m = o.modelVersion || o.model || o.response?.modelVersion || null;
    if (typeof m === 'string' && /^[\w.:/-]{2,80}$/.test(m)) model = m.replace(/^models\//, '');
    const um = o.usageMetadata || o.response?.usageMetadata;
    if (um && typeof um === 'object') { byResp.set(o.responseId || o.response?.responseId || `n${n++}`, um); }
    const sm = o.stats?.models;
    if (sm && typeof sm === 'object' && Object.keys(sm).length) stats = sm;
  }
  if (stats) {
    let i = 0, out = 0, cached = 0;
    for (const [k, v] of Object.entries(stats)) { const tk = v?.tokens || {}; i += Number(tk.prompt ?? tk.input) || 0; out += Number(tk.candidates ?? tk.output) || 0; cached += Number(tk.cached) || 0; if (!model) model = k; }
    if (i || out) return { reported: true, tokensIn: Math.max(0, i - cached), tokensOut: out, cacheRead: cached, model };
  }
  if (byResp.size) {
    let i = 0, out = 0, cached = 0;
    for (const um of byResp.values()) { const c = Number(um.cachedContentTokenCount) || 0; i += Math.max(0, (Number(um.promptTokenCount) || 0) - c); out += (Number(um.candidatesTokenCount) || 0) + (Number(um.thoughtsTokenCount) || 0); cached += c; }
    if (i || out || cached) return { reported: true, tokensIn: i, tokensOut: out, cacheRead: cached, model };
  }
  const text = part.split(/\r?\n/).filter((l) => !/^\[launcher\]/.test(l)).join('\n');
  return { reported: false, estimated: true, tokensIn: Math.ceil((Number(kickoffChars) || 0) / 4), tokensOut: Math.ceil(text.length / 4), cacheRead: 0, model };
}

/**
 * 2.77.1 (B-99): did agy end this session mid-task with exit 0? 'denied' (a command refused in headless mode: its
 * jetski line), 'idle' (its agent went idle while a background tool task still ran), or null.
 */
export function agyCutShort({ tool, code, log }) {
  if (tool !== 'agy' || code !== 0) return null;
  const line = agyStopLine(log);
  if (/^jetski:|auto-denied|headless mode cannot prompt/i.test(line || '')) return 'denied';
  if (/root agent idle; waiting up to [^\n]*background task/i.test(String(log || '').slice(-4000))) return 'idle';
  return null;
}

export function cleanUp(agent, { code, log = '', usageLog = null, role, tool, model, cmd = null, exit = {} }) {
  // 2.76.0 (B-80): an agy session's real reason (its jetski / permission line) goes into its hand-back and its end.
  const agyLine = tool === 'agy' ? agyStopLine(usageLog ?? log) : null;
  const agySaid = agyLine ? ` agy said: "${agyLine}".` : '';
  // 2.77.1 (B-99): agy -p exits 0 mid-task when one command is refused in headless mode (its jetski line) or when its
  // root agent goes idle while a background tool task (a test run) is still pending. Neither is a finish: the session
  // counts as a failed run, so --fallback starts the next model and the hand-back says why (it never halts the
  // supervisor: that counts non-zero exit codes).
  const agyCut = agyCutShort({ tool, code, log: usageLog ?? log });
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
  // 2.58.3 (N1): a person (or the Producer) stopped or paused it: the kill ends it with exit 1 (taskkill /F on
  // Windows) or a signal, but that's a stop, not a crash: no failover, no "error", and the supervisor's halt, the
  // loop park, the breaker and the tier-up don't count it. stopAgent wrote who before it killed (stopMark).
  const stop = !capped ? stopMark(agent) : null;
  const bad = !capped && !stop && (code !== 0 || Boolean(trouble) || reasoningOnly || agyCut);
  // PU-19 (P-042): the session stopped at a usage limit: its own, or for a custom command (no tool name of its
  // own) the one its line names. That's waiting for the reset, not a failure: the tool is marked out until
  // then (below), and the hand-back says "usage limit", so the breaker, the loop park, the model escalation
  // and the supervisor's halt don't count it.
  // (Repeated 5xx refusals are a run-out too, but not a usage limit: they keep their old handling.)
  const limit = !capped && !stop && found?.kind === 'quota' && !/^provider refused/.test(found.text) && (!other || (tool === 'custom' && code !== 0)) ? found : null;
  // Out of quota: remember until when, so the supervisor moves this tool's lanes to the next tool.
  // STUDIO_QUOTA_SKIP=off: usage is watched outside the harness, so never skip a tool for quota.
  // (PU-19: marked before the hand-back, so the note can say until when.)
  let limitMark = null;
  const quota = (other ? found : t)?.kind === 'quota' ? (other ? found : t) : null;
  if (quota && !/^(off|0|false|no)$/i.test(process.env.STUDIO_QUOTA_SKIP || '')) {
    // 2.30o: generic: the order entry this session ran as (tool:model when the order lists it, else the tool).
    const order = (() => { try { return readBudget().order || []; } catch { return []; } })();
    // 2.58.0 (PU-40, P-051): a custom command's limit is saved per program (custom:<program>), the key the launch
    // check (budgetStopFor) matches; as plain "custom" nothing matched it and the next launch hit the limit again.
    const ck = tool === 'custom' ? customKey(cmd ?? (process.env[`STUDIO_${roleKey(role)}_CMD`] || process.env.STUDIO_AGENT_CMD || '')) || 'custom' : null;
    const who = other || ck || (order.includes(`${tool}:${model}`) ? `${tool}:${model}` : quotaKeyFor(tool, model));
    const line = log.split('\n').slice(-30).reverse().find((l) => /reset|try again/i.test(l) && QUOTA_ERROR.test(l) && (toolNamed(l) || who) === who) || quota.line;
    limitMark = { on: who, ...markExhausted(who, line) };
    // The command stopped at a limit its line names another tool for (a wrapper around that tool): hold the command too.
    if (limit && other && ck) markExhausted(ck, line);
  }
  const mine = listLocks().filter((l) => l.owner === agent);
  const tasks = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
  const handed = [];
  const s0 = readJson(sessionFile(agent)) || {};
  // An agent in its own copy (2.29): its uncommitted work is in that copy, its commits on its branch.
  const copyDir = s0.copy?.dir ? path.join(REPO_ROOT, s0.copy.dir) : null;
  const ahead = s0.copy?.branch ? unmerged(s0.copy.branch) : 0;
  const finished = [];
  const queuedForTrain = [];
  for (const id of tasks) {
    // 2.78.2 (a, W-0090): its task done queued the lane for the merge train and the session ended, as it should: the
    // train lands it (task.done) or hands it back (task.paused). No launcher verify, no second done, no hand-back here.
    if (trainQueued(id, { agent, branch: s0.copy?.branch || null })) { queuedForTrain.push(id); continue; }
    // 2.77.2 (B-107): in its own lane copy, a session's work is exactly the commits its branch has that main doesn't
    // (ahead). The log search below is for a session in the shared checkout only: in a copy it also found main's own
    // commits naming the task (made before the copy was cut), so an empty lane got a 20-minute launcher verify.
    const hasCommit = workCommitted({ ahead, inCopy: Boolean(s0.copy?.branch), logHit: () => {
      const cwd = copyDir && fs.existsSync(copyDir) ? copyDir : REPO_ROOT;
      const git = spawnSync('git', ['log', `--since=${s0.startedAt || new Date(Date.now()-86400000).toISOString()}`, '--grep', id, '--oneline'], { windowsHide: true, cwd, encoding: 'utf8' });
      return git.status === 0 && git.stdout.trim().length > 0;
    } });
    let af = null;
    // A stopped session's task isn't closed for it: the person asked it to stop (its work is saved below).
    if (!stop && crashFinishable({ code, trouble, reasoningOnly, capped, hasCommit })) {
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
    const note = stop
      ? `${agent} (${tool}, ${model}) was ${stop.kind === 'pause' ? 'paused' : 'stopped'} by ${stop.by} (${STOP_NOTE}).${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch}${s0.now ? ` It last said: "${s0.now}".` : ''} Check its commits (git log --grep ${id}) before redoing anything.`
      : capped
      ? `${agent} (${tool}, ${model}) refreshed: ${refresh?.endedBy || `it reached the ${sessionLimits().ceilingTurns}-turn ceiling`}.${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch} A fresh session continues from this hand-back${s0.now ? `; it last said: "${s0.now}"` : ''}.`
      : limit
      ? `${agent} (${tool}, ${model}) stopped at its usage limit: the provider said "${String(limit.line || limit.text).replace(/^"|"$/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)}".${limitMark ? ` ${limitMark.on} is out until ${limitMark.until}${limitMark.resetKnown ? '' : ' (no reset time given: 1 h assumed)'}.` : ''} Not a failure: the task goes back to the queue for the next tool in the order, or for after the reset.${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch} Picked up by the launcher.`
      : bad
      ? `${agent} (${tool}, ${model}) stopped: ${trouble ? `provider said "${trouble}"` : reasoningOnly ? 'it replied with reasoning only (no answer, no work): a failed hand-off; the Director routes this task to another model family' : agyCut ? (agyCut === 'denied' ? 'agy ended the session mid-task: one shell command was refused in headless mode (one plain command per call; see GEMINI.md)' : 'agy ended the session mid-task: its agent went idle while a background command (a test run) was still running (run commands in the foreground)') : `exit code ${code}`}.${agySaid}${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'}${onBranch} Picked up by the launcher.`
      : `${agent} (${tool}, ${model}) ended without task done or a hand-back.${agySaid}${s0.now ? ` It last said: "${s0.now}".` : ''}${s0.wip ? ` Work in progress: ${s0.wip}.` : ''}${patch ? ` Uncommitted work ${copyDir ? 'was in its copy and is' : 'is in the tree and'} saved to ${patch}.` : ' No uncommitted work.'}${onBranch} Check its commits (git log --grep ${id}) before redoing anything. Picked up by the launcher.`;
    // 2.78.2 (d): the harness's own refusal of an owner-only step at the end of the session's output goes into the hand-back,
    // where pauseTask parks the task for the owner (harness/owner-only.mjs) instead of relaunching a builder on it.
    const ownerSaid = !stop && !limit ? ownerOnlyStep(String(log).slice(-6000)) : null;
    const noteOut = ownerSaid ? `${note} Its last output said: "${ownerSaid.phrase}".` : note;
    pauseTask(id, agent, af && !af.ok && af.output ? `${noteOut} Launcher verify: ${af.output.replace(/\n/g, ' ')}` : noteOut, { force: true });
    if (reasoningOnly) emitEvent({ type: 'agent.reasoning_only', agent, model, task: id, status: 'warn', msg: `${agent} (${model}) replied with reasoning only on ${id}: failed hand-off, the next session goes to another model family`, meta: { role, tool } });
    handed.push({ task: id, patch });
    if (!capped && !limit && !stop) parkIfLooping(id);
  }
  for (const l of listLocks().filter((x) => x.owner === agent)) release(l.key, agent);
  // 2.67.2: what this session did for its task (claimed, commits, done) and, with no work, why: recorded on
  // agent.session.end (meta.outcome); after STUDIO_NO_WORK_EXITS such exits in a row the task is parked, not relaunched.
  const oTask = s0.task || tasks[0] || null;
  let outcome = null;
  try {
    if (oTask) {
      const t0 = s0.startedAt || new Date(Date.now() - 86400000).toISOString();
      const cwd = copyDir && fs.existsSync(copyDir) ? copyDir : REPO_ROOT;
      const gl = spawnSync('git', ['log', `--since=${t0}`, '--grep', oTask, '--format=%h'], { windowsHide: true, cwd, encoding: 'utf8' });
      const commits = gl.status === 0 ? gl.stdout.split('\n').filter(Boolean).length : 0;
      outcome = sessionOutcome({ agent, task: oTask, startedAt: t0, events: readRecentEvents(20000), commits: Math.max(commits, finished.includes(oTask) ? 1 : 0), counts: !stop && !capped && !limit && !trouble && !reasoningOnly });
      if (outcome && (finished.includes(oTask) || queuedForTrain.includes(oTask))) outcome = { ...outcome, done: true, noWork: false, stuck: false, why: '', ...(queuedForTrain.includes(oTask) ? { queuedForTrain: true } : {}) };
    }
  } catch { outcome = null; }
  let tok = tokensFrom(log);
  // 2.76.0 (B-82): no result line of its own (the launcher ended it, it crashed): its usage from the stream, and its
  // cost estimated at studio/prices.json (meta.costEstimated), so API spend isn't undercounted.
  let costEstimated = false;
  if (!(tok.tokensIn || tok.tokensOut || tok.cacheRead)) {
    const st = streamUsage(usageLog ?? log);
    if (st) tok = st;
  }
  // 2.77.0 (n): agy reported no usage line Claude's readers know: its own (Gemini) usage, else "not reported" with an
  // estimate from text length (meta.usage, meta.tokensEstimated), never a silent 0; and the model agy names, if any.
  let agyUse = null;
  if (tool === 'agy' && !(tok.tokensIn || tok.tokensOut || tok.cacheRead)) {
    let kickoffChars = 0;
    try { kickoffChars = fs.statSync(path.join(STUDIO_STATE_DIR, 'kickoff', `${agent}.md`)).size; } catch {}
    agyUse = agyUsage(usageLog ?? log, { kickoffChars });
    tok = { ...tok, tokensIn: agyUse.tokensIn, tokensOut: agyUse.tokensOut, cacheRead: agyUse.cacheRead || 0, ...(agyUse.estimated ? { usage: 'not reported', tokensEstimated: true } : { usage: 'reported' }) };
  } else if (tool === 'agy') {
    const named = agyUsage(usageLog ?? log).model;
    agyUse = { reported: true, model: named };
    tok = { ...tok, usage: 'reported' };
  }
  const modelReported = agyUse?.model && agyUse.model !== model ? agyUse.model : null;
  if (modelReported) model = modelReported;
  if (tok.costUsd === null && (tok.tokensIn || tok.tokensOut || tok.cacheRead)) {
    const est = estimateCost(tok, { model, tool, role });
    if (est !== null) { tok = { ...tok, costUsd: est }; costEstimated = true; }
  }
  // 2.30g: cache hit vs write from Claude's own usage lines, and which prompt prefix the session started from.
  const cache = cacheStats(log);
  const prefixHash = (readJson(sessionFile(agent)) || {}).prefixHash || null;
  const cause = exitCause({ code, exit, stop });
  // 2.73.2 (B-72): recorded once: a stop's endAsDead (or the watch pass) may have recorded this session's end already.
  const firstEnd = claimSessionEnd(agent, s0.startedAt, 'launcher');
  const reason = stop ? `${stop.kind === 'pause' ? 'paused' : 'stopped'} by ${stop.by}` : capped ? 'refreshed (session cap): a fresh session continues' : limit ? `usage limit: ${limit.text}${limitMark ? `, ${limitMark.on} out until ${limitMark.until}` : ''}` : trouble ? `provider: ${trouble}` : code === 0 ? (handed.length ? 'finished without task done' : finished.length ? 'finished (the launcher closed its task)' : 'finished') : `exit ${code}${cause.kind === 'signal' ? `, ${cause.why}` : ['stall', 'idle', 'budget'].includes(cause.kind) ? `, ended by the launcher (${cause.kind}: ${cause.why})` : cause.kind === 'spawn-error' ? `, it never started: ${cause.why}` : ''}`;
  if (firstEnd) emitEvent({ type: 'agent.session.end', agent, model, task: oTask || claimedSince(agent, s0.startedAt) || undefined, status: bad ? (limit ? 'warn' : 'error') : 'ok', tokensIn: tok.tokensIn, tokensOut: tok.tokensOut, msg: `${agent} ended (${reason})${agyLine ? `; agy said: ${agyLine}` : ''}${handed.length ? `; handed back ${handed.map((h) => h.task).join(', ')}` : ''}${other ? `; ${other} reported its own limit inside this session (marked on ${other})` : ''}${outcome?.why ? `; no work on ${outcome.task}: ${outcome.why}` : ''}`.slice(0, 900), meta: { role, tool, code, reason, handed, ...(outcome ? { outcome } : {}), finishedByLauncher: finished, costUsd: tok.costUsd, ...(costEstimated ? { costEstimated: true } : {}), ...(tok.fromStream ? { usageFrom: 'stream' } : {}), ...(agyLine ? { agyStop: agyLine } : {}), ...(agyUse ? { usage: agyUse.estimated ? 'not reported' : 'reported', ...(agyUse.estimated ? { tokensEstimated: true, estimate: 'text length / 4 (kickoff in, output out)' } : {}), ...(modelReported ? { modelReported, modelAsked: s0.model || null } : {}) } : {}), cacheRead: tok.cacheRead, cacheWrite: cache.cacheWrite || tok.cacheWrite || 0, cacheWrite5m: tok.cacheWrite5m ?? undefined, cacheWrite1h: tok.cacheWrite1h ?? undefined, cacheTtl: (cache.cacheWrite || tok.cacheWrite) ? cacheTtlAsked(role) : undefined, cacheHitRate: cache.cacheRead + cache.cacheWrite + cache.input ? Number(cache.hitRate.toFixed(3)) : undefined, prefixHash: prefixHash || undefined, turns: tok.turns, otherToolLimit: other, refreshed: capped || undefined, usageLimit: limit ? { on: limitMark?.on || null, until: limitMark?.until || null } : undefined, stoppedBy: stop?.by || undefined, stopKind: stop?.kind || undefined, exitCause: cause } });
  if (outcome?.counts && (outcome.noWork || outcome.stuck)) {
    try { parkIfNoWork(outcome.task, readRecentEvents(20000), { park: parkOnce, ask: (m) => emitEvent({ type: 'agent.ask', agent: 'launcher', to: 'producer', task: outcome.task, msg: m }) }); } catch { /* the park is a help, never a crash */ }
  }
  jobDone({ kind: 'session', id: agent, agent, task: s0.task || tasks[0] || null, code: code ?? null, result: stop ? (stop.kind === 'pause' ? 'paused' : 'stopped') : bad ? 'fail' : 'pass', ms: Date.parse(s0.startedAt) ? Date.now() - Date.parse(s0.startedAt) : null, tail: reason, log: s0.log || null, extra: { role: role || null, handed: handed.map((h) => h.task) } });
  // 2.61.0: which skills and pitfall lines this session was given, and whether its log shows it used them (telemetry only).
  try { recordFollow({ agent, model, role, task: s0.task || tasks[0] || null, log }); } catch { /* telemetry, never a blocker */ }
  // 2.66.0 (c): Claude Code's permission_denials, harvested into .studio/denials.jsonl (redacted; candidates only, never allowed).
  try { recordDenials({ log, logFile: s0.log ? path.join(REPO_ROOT, s0.log) : null, from: s0.logFrom || 0, task: s0.task || tasks[0] || null, agent, role }); } catch { /* evidence, never a blocker */ }
  const s = readJson(sessionFile(agent)) || {};
  fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...s, status: 'ended', endedAt: s.status === 'ended' && s.endedAt ? s.endedAt : new Date().toISOString(), code, reason, exitCause: cause, handed, ...(outcome ? { outcome } : {}), ...(stop ? { stoppedBy: stop.by } : {}), ...tok }, null, 2));
  fs.rmSync(stopFile(agent), { force: true });
  return { bad, trouble, troubleKind: t?.kind || (agyCut ? 'agy-cut' : undefined), agyCut, handed, finished, reason, capped, usageLimit: Boolean(limit), stoppedBy: stop?.by || null };
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
    const dirty = spawnSync('git', ['status', '--porcelain', '--', ...paths], { windowsHide: true, cwd, encoding: 'utf8' }).stdout || '';
    if (dirty.trim()) return { ok: false, output: 'working tree dirty' };
  }
  const env = { ...process.env, STUDIO_LOCK_OWNER: agent, STUDIO_TASK_PIN: id, ...(cwd !== REPO_ROOT ? { STUDIO_MAIN_ROOT: REPO_ROOT } : {}) };
  const g = spawnSync(process.execPath, [path.join(cwd, 'scripts', 'run-gates.mjs')], { windowsHide: true, cwd, env: gateEnv(env), encoding: 'utf8', timeout: 20 * 60000 }); // 2.71.1 (B): harness/gate-env.mjs
  if (g.status !== 0) {
    const out = `${g.stderr || ''}${g.stdout || ''}`.trim().split('\n').slice(-15).join('\n');
    return { ok: false, output: out || 'verify failed' };
  }
  const gitLog = spawnSync('git', ['log', '-1', '--format=%h', '--grep', id], { windowsHide: true, cwd, encoding: 'utf8' });
  const sha = gitLog.status === 0 && gitLog.stdout.trim() ? gitLog.stdout.trim() : 'none';
  const ext = code === 0 ? 'clean exit' : `exit code ${code}`;
  const note = `closed by the launcher: session ended without task done (${ext}), verify passed in the foreground, commit ${sha}`;
  const done = spawnSync(process.execPath, [path.join(cwd, 'harness', 'task.mjs'), 'done', id, '--agent', agent, '--note', note], { windowsHide: true, cwd, env, encoding: 'utf8', timeout: 20 * 60000 });
  if (done.status !== 0) {
    const out = `${done.stderr || ''}${done.stdout || ''}`.trim().split('\n').slice(-15).join('\n');
    return { ok: false, output: out || 'task done failed' };
  }
  if (!/^(off|0|false|no)$/i.test(process.env.STUDIO_POST_BROWSER_PLAY || '')) {
    const bp = spawnSync(process.execPath, [path.join(cwd, 'qa', 'browser-play.mjs')], { windowsHide: true, cwd, env, encoding: 'utf8', timeout: 5 * 60000 });
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
  // 2.30q (#6): harness-caused hand-backs (claim ran out during gates, merge refused, land lock) don't count.
  // PU-19: nor a session that stopped at its usage limit (it waits for the reset; it isn't stuck).
  // 2.58.3 (N1, N3): nor a person's stop; counted since the last done, unblock or unpark (busy.mjs loopHandBacks,
  // the watchdog's rule too), and parked once however many passes get here at the same moment (parkOnce).
  const since = loopHandBacks(id, readRecentEvents(20000), { since: now - 2 * 3600000 });
  if (since.length < limit) return null;
  const last = String(since[since.length - 1].msg || '').replace(/^Handed back [^:]+:\s*/, '').slice(0, 200);
  const why = `handed back ${since.length} times in 2 h without being done; the last note: "${last}". Fix the blocker, then npm run task -- unpark ${id} --by <name>`;
  if (!parkOnce(id, { by: 'launcher', why, at: new Date(now).toISOString() }, { by: 'launcher', msg: `Parked ${id}: ${why}` })) return null;
  emitEvent({ type: 'agent.ask', agent: 'launcher', to: 'producer', task: id, msg: `${id} keeps coming back (${since.length} hand-backs in 2 h), so it's parked. Last note: "${last}"` });
  return why;
}

/** The last part of a log (stream-json logs grow large; the refresh check needs only the latest usage). */
function tailOf(file, bytes = 2 * 1024 * 1024, from = 0) {
  // 2.76.0 (B-83): from = where this session's output starts in the (appended) log: earlier sessions never count.
  if (from > 0) return readLogFrom(file, from, bytes);
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
export function refreshRule({ oneTask = false, task = null, role = null, model = null } = {}) {
  // 2.78.1 (e): the role's own refresh point (reviewers and engine-porters earlier; harness/session-cap.mjs contextPoint).
  const l = sessionLimits(process.env, { role, model });
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

/**
 * 2.59.0 (#8): a launch in the main checkout with a too-broad lane: null when a person kept that exact lane wide (task add
 * --lane/--paths … --wide "<why>" or task lane … --wide, by a name that isn't an agent's and not from inside a launched
 * session), else the refusal, which says how to narrow it (one launch.skipped event per task per STUDIO_SKIP_LOG_MIN).
 */
function broadLaneRefusal({ agent, role, task, lane, broad }) {
  const want = laneList(lane).join(',');
  const added = task ? readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === task).pop() : null;
  const hold = task ? readHolds()[task] : null;
  const ok = (w) => w && typeof w.why === 'string' && w.why.trim() && laneList(w.lane || '').join(',') === want && !w.inSession && !agentLikeName(w.by);
  if (ok(hold?.laneWide) || (!(hold && 'lane' in hold) && ok(added?.meta?.laneWide))) return null;
  const list = broad.map((x) => `${x.p} (${x.why})`).join(', ');
  const fix = task ? `npm run task -- lane ${task} <the folders or files it changes, a.js,b.js> --by <you>` : 'start it with a narrower --lane';
  const message = `Not started: lane ${list} is too broad to hold for a whole session in the main checkout: it would block every other agent's commits there. Narrow the task's lane: ${fix}. A person who means it: npm run task -- lane ${task || '<ID>'} ${want} --wide "<why>" --by <you>.`;
  const f = path.join(STUDIO_STATE_DIR, 'launch-skips.json');
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  const k = `broad|${task || agent}|${want}`;
  if (!(Date.now() - (seen[k] || 0) < Number(process.env.STUDIO_SKIP_LOG_MIN ?? 10) * 60000)) {
    seen[k] = Date.now();
    try { fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(seen, null, 2)}\n`); } catch {}
    emitEvent({ type: 'launch.skipped', agent, to: 'human', task: task || undefined, status: 'warn', msg: `${agent} (${role}): ${message}`.slice(0, 600), meta: { role, lane: want, broad: broad.map((x) => x.p) } });
  }
  return { ok: false, skipped: true, message };
}

/**
 * 2.78.1 (e): a refresh relaunch starts from the hand-off, not from scratch: read it first, and the newest entry's
 * hand-back facts (lane, commits, last verify, the next command: written by the harness, harness/handback-facts.mjs)
 * are in the prompt itself. Quoted in the marked block: commit subjects and failing lines are other sessions' text.
 */
export function refreshKickoff(task) {
  let facts = null;
  try { facts = latestFacts(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'handoffs', `${task}.md`), 'utf8')); } catch { facts = null; }
  const head = `\nThis is a fresh session after a refresh: read studio/handoffs/${task}.md first; don't redo what it says is done.${facts ? ' Its newest hand-back facts are below: start from them (the lane, the commits already made, the last verify and the next command).' : ''}\n`;
  return facts ? `${head}\n${untrustedBlock([{ label: `Hand-back facts for ${task}${facts.heading ? ` (${facts.heading})` : ''}, written by the harness from git and the gate logs (commit subjects and failing lines are quoted)`, text: facts.block }])}` : head;
}

/**
 * 2.78.1 (e): the launch prompt's two parts, built in one place (runAgent, and the selftest that builds it twice).
 * `stable` (above the marker) is the same bytes for every session of a role in this studio: it never names the agent,
 * its model, its task, its lane or the time. Everything per session goes in `volatile`, below the marker.
 */
export function sessionPromptParts({ role, agent, model, task = null, lane = null, oneTask = false, refreshes = 0, note = '', by = null, tool = null, custom = null, copy = null, engineLane = null }) {
  // 2.30g: cache-friendly order. The fixed part (role kickoff, rules, the map tip, pitfalls) comes first
  // and never names this agent, its model or the time, so every session of a role starts with the same
  // bytes and Claude reads it from the prompt cache. Everything that changes per session goes last.
  const { stable: kick, volatile: kickTail } = kickoffParts({ role, agent, model, launched: true, task });
  const stable = (kick
    // Cheaper to read (2.26): the map instead of searching, never the long changelog, a short hand-back,
    // and the rules this game has learned the hard way.
    // 2.29: a lookup, not a read-first step (Jed's A/B: reading a map, then line ranges, added turns and cost 27% more).
    + `\nTo find a function, constant or TUNING key, run \`npm run map -- find <name>\`: one call gives the file, the line range and the arguments, so you read only those lines. .studio/MAP.md lists every code file in one line if you need the lay of the land. Every turn re-reads your whole conversation, so fewer, bigger steps cost less than many small ones. Never read CHANGELOG.md; studio/llms.txt lists every command. If you hand work back, keep the note under 20 lines: done, not done, files touched, next step, proof.\n`
    + `\nEvery few minutes, say what you are doing in one line: npm run agent -- now "<what you are doing>". The War Room shows it with your work in progress.\n`
    + `\nHarness output is compact in launched sessions: verify prints failures only (each gate's full log is in .studio/gates/out/<gate>.log; open it only when you need it), and \`node harness/task.mjs list\` shows your role's next tasks, not the whole board (--all for everything). Don't cat studio/NEXT.md.\n`
    + `\nSkills load on demand: .claude/skills/ holds the know-how for Godot, the web build, assets and tests. Claude Code shows you only their names until a task needs one; other tools: open the skill's SKILL.md when your task matches its description.\n`
    // PU-36 (P-049): studio/PITFALLS.md is written by agents and people: last, in the marked block, never among the rules.
    // It stays in the stable part (it changes only when a pitfall is added), so the prompt cache still holds.
    // 2.61: only the lines for all and for this role (a role's prefix is shared by that role only).
    + pitfallsForPrompt(role));
  const volatile = `You are ${agent} (role \`${role}\`), running on ${model}. $STUDIO_LOCK_OWNER is ${agent} and $STUDIO_AGENT_MODEL is ${model} in your shell.\n`
    + kickTail
    + (task ? `\nStart with ${task}: node harness/task.mjs start ${task} --agent ${agent} --model ${model}\n` : '')
    + (lane ? `\nYour lane is \`${lane}\` (claimed for you): edit files only under it. Work outside it goes to the Producer as a task.\n` : '')
    + (engineLane?.note ? `\n${engineLane.note}\n` : '')
    + (copy?.reused ? `\nThis copy is the one the last session under your name used (it ended and you take over): its commits and any uncommitted changes are still here. A patch the hand-back names is a copy of those changes: don't apply it again.\n` : '')
    + (copy ? `\nYou work in your own copy of the repo (\`.lanes/${agent}\`, branch \`${copy.branch}\`): other agents' unfinished work can't reach your tests, and yours can't reach theirs. \`studio/\` and \`.studio/\` are shared with everyone. Commit your work as you go; \`task done\` adds your commits to the studio's branch once your checks pass (it rebases first and tells you if anything conflicts). Uncommitted work never leaves your copy.${copy.mixed ? ` MIXED LANE NOT MERGED: ${copy.mixed.line}` : ''}${copy.laneless ? ' Your task has no lane: claim the folders you edit (node harness/lock.mjs claim path:<dir> --owner $STUDIO_LOCK_OWNER) as usual.' : ''}\n` : '')
    + refreshRule({ oneTask, task, role, model })
    // 2.77.0 (n, B-92): a session started on a task works only that task (harness/task-pin.mjs; task start/done refuse others).
    + (task ? pinKickoff(task) : '')
    // 2.76.0 (B-80 part 2): one refused command ends a headless agy session; these rules steer it (and GEMINI.md below).
    + (tool === 'agy' && !custom ? `\n${AGY_SHELL_RULES.split('\n').slice(2).join('\n')}` : '')
    // 2.58.0 (PU-36): a refresh relaunch is the launcher's own instruction, so it is said here, not as a note.
    + (refreshes > 0 && task ? refreshKickoff(task) : '')
    // PU-36 (P-049): the --note is written by whoever started the session (a person, the Producer, a chat bot), so it
    // goes in the marked block with its real sender (--by, or "unknown"), never "the Producer" by default.
    + (note ? `\n${untrustedBlock([{ label: `Note from ${oneLine(by) || 'unknown'} (sent with --note when this session was started)`, text: note }])}` : '');
  return { stable, volatile };
}

/** Run one agent to the end, with heartbeats. Resolves with the cleanup result. */
/**
 * 2.79 (b): the queue entry (game train, or any engine train's queue) that still needs this agent's lane copy, or null.
 * Read through the trains' own readers (readQueue in train.mjs; readUnityQueue in unity-train.mjs for every
 * <engine>-queue.json): an entry names the copy by dir, or by the agent that queued it.
 */
export async function queuedCopy(agent, dirs = [], root = REPO_ROOT) {
  const same = (a, b) => path.resolve(root, String(a)) === path.resolve(root, String(b));
  const mine = (e) => e && ((e.agent && e.agent === agent) || (e.dir && dirs.some((d) => d && same(e.dir, d))));
  try {
    const { readQueue } = await import('./train.mjs');
    const g = readQueue(root).find(mine);
    if (g) return { task: g.task, train: 'merge' };
  } catch { /* a queue that can't be read keeps nothing alive */ }
  try {
    const { readUnityQueue } = await import('./unity-train.mjs');
    for (const f of fs.readdirSync(path.join(root, '.studio', 'train'))) {
      const m = f.match(/^(.+)-queue\.json$/);
      const u = m && readUnityQueue(root, m[1]).find(mine);
      if (u) return { task: u.task, train: m[1] };
    }
  } catch { /* none */ }
  return null;
}

export async function runAgent({ role, agent, tool, model, fallback = [], task = null, lane = null, oneTask = false, division = null, note = '', by = null, refreshes = 0, reuseCopy = null, agyOneTurn = false }) {
  const opts2 = { refreshes };
  // H-1 (2.58.5): a nim session runs a NIM model (--model, STUDIO_NIM_MODEL or the default), never the role's.
  if (tool === 'nim') model = nimModel(model);
  // 2.30q (#7): every start path (first start, refresh relaunch, failover) checks the budget stop first.
  { const st = launchStop({ role, tool, model, agent, task }); if (st) return { ok: false, skipped: true, message: `Not started: budget stop (${st.why}).` }; }
  // 2.31.0: a task that used its own budget (harness/task-budget.mjs) gets no new session, refresh or failover.
  { const over = task ? stopIfOverBudget(task, { by: 'launcher' }) : null; if (over) { emitEvent({ type: 'launch.skipped', agent, task, msg: `${agent} not started on ${task}: ${over.split('. ')[0]}` }); return { ok: false, skipped: true, message: `Not started: ${over}` }; } }
  // Lines for the agent's log, written once it is open.
  const launchNotes = [];
  // B-19 (2.60.1): a nim session's model is checked once before it starts (one 1-token request, cached per model and
  // key for 24 h in .studio/nim-models.json; harness/nim-check.mjs). NIM says not found / not for this account: the
  // next model in STUDIO_NIM_MODELS (or models.config.mjs NIM_SESSION) is tried; none works: not started. A 429 or a
  // network error never changes the model (the quota fallback handles a 429). STUDIO_NIM_CHECK_STUB: a test's answers.
  if (tool === 'nim' && process.env.STUDIO_REHEARSAL !== '1') {
    const key = agentEnv({ tool: 'nim', role, model, agent }).OPENAI_API_KEY || null;
    const stub = String(process.env.STUDIO_NIM_CHECK_STUB || '').trim();
    const pick = await pickNimModel(model, { key, base: NIM_API_BASE, fetchImpl: stub ? stubFetchFrom(stub) : globalThis.fetch });
    const meta = { role, configured: pick.configured, chosen: pick.model, tried: pick.tried.map((t) => ({ model: t.model, verdict: t.verdict, status: t.status, cached: t.cached })) };
    if (!pick.model) {
      emitEvent({ type: 'launch.skipped', agent, to: 'human', task: task || undefined, status: 'error', msg: `${agent} not started (${role} on nim): ${pick.refused}`.slice(0, 600), meta });
      return { ok: false, skipped: true, message: `${agent} not started: ${pick.refused}` };
    }
    launchNotes.push(pick.line);
    if (pick.tried.length) emitEvent({ type: 'agent.nim_model', agent, to: pick.changed ? 'producer' : undefined, task: task || undefined, status: pick.changed || pick.skipped ? 'warn' : 'ok', msg: `${agent}: ${pick.line}`.slice(0, 600), meta });
    if (pick.changed) {
      model = pick.model;
      const st = launchStop({ role, tool, model, agent, task });
      if (st) return { ok: false, skipped: true, message: `Not started: budget stop (${st.why}).` };
    }
  }
  // A lane is a folder this agent owns for the session, so two agents never edit the same files.
  // 2.30k: a lane can be several files (a,b,c); each is claimed, and all are let go if one is taken.
  const lanePaths = laneList(lane);
  // 2.59.0 (#8): a too-broad lane path (a game's folder or source root, or more than STUDIO_LOCK_MAX_FILES tracked files:
  // lock.mjs tooBroad, the by-hand rule of 2.58.5 P-090) isn't held as a 6-hour session lock. In the agent's own copy
  // overlapping edits are caught when the lane lands; in the main checkout the launch is refused unless a person kept
  // the lane wide (task add --lane … --wide "<why>", or task lane <ID> <folder> --wide "<why>" --by <you>).
  const broad = lanePaths.map((p) => ({ p, why: tooBroad(p) })).filter((x) => x.why);
  const copyLikely = broad.length > 0 && laneWantsCopy(lane) && !process.env.STUDIO_MAIN_ROOT && worktreeSupport().ok;
  if (broad.length && !copyLikely) {
    const refused = broadLaneRefusal({ agent, role, task, lane, broad });
    if (refused) return refused;
  }
  const unheld = new Set(copyLikely ? broad.map((x) => x.p) : []);
  // 2.78.2 (item 9): a file the lane names only by regions, and that allows region lanes (harness/lane-regions.mjs), isn't
  // held as a file lock when the agent works in its own copy: two lanes on regions that don't overlap run side by side
  // (the supervisor's lanesClash decided that), and the train catches a real conflict. No copy: held as before.
  let regionFree = new Set();
  try { if (laneWantsCopy(lane) && !process.env.STUDIO_MAIN_ROOT && worktreeSupport().ok) regionFree = regionOnlyFiles(laneEntries(lane)); } catch { regionFree = new Set(); }
  const held = [];
  for (const p of lanePaths) {
    if (unheld.has(p) || regionFree.has(p)) continue;
    const c = claim(`path:${p}`, agent, 6 * 3600);
    if (c && c.ok === false) {
      for (const q of held) release(`path:${q}`, agent);
      return { ok: false, message: `Lane ${p} is taken: ${c.message || `claimed by ${c.lock?.owner || 'another agent'}`}` };
    }
    held.push(p);
  }
  // A code lane gets its own working copy (2.29), so half-done work never leaks into another agent's
  // tests or commits. Not possible here (old git, STUDIO_WORKTREES=off): the shared checkout, as before.
  // 2.30e (R6): In rehearsal mode, use the rehearsal agent unless a custom command is set.
  // 2.30o: a tool in the budget order may carry its own launch command (hermes, gemini, grokbot ...):
  // STUDIO_TOOL_<TOOL>_CMD. It wins over the role's command, so a takeover changes the program too.
  const viaTool = toolCmd(tool);
  let custom = viaTool || process.env[`STUDIO_${roleKey(role)}_CMD`] || (tool === 'custom' ? process.env.STUDIO_AGENT_CMD : null);
  let rehearsal = false;
  if (process.env.STUDIO_REHEARSAL === '1' && !custom) {
    custom = `node harness/rehearsal-agent.mjs {agent} {task} ok`;
    rehearsal = true;
  }
  // M2 (2.58.3, crew P-039): a code-writing role on a task with no lane gets its own copy too (no path claims), so its
  // staged or half-done files never sit in the main checkout where they block every other task's `task done`.
  // Producer, Director, planner and liaison stay in the main checkout; STUDIO_LANELESS=shared turns it off.
  // H-9 (2.58.5): a custom command too (STUDIO_<ROLE>_CMD, STUDIO_TOOL_<TOOL>_CMD, STUDIO_AGENT_CMD): 2.58.3 left it in
  // the main checkout, and a wrapper session staged game code there that the pre-commit hook refused. It runs in the
  // copy (cwd), with STUDIO_MAIN_ROOT set, and its line may use {mainRoot} and {addDirs} (the --add-dir pair the
  // built-in claude gets) to pass the main checkout's folders on. The rehearsal agent stays in the main checkout.
  // 2.58.5: from here until the real record (below) this session counts as running. The detached launcher clears the
  // placeholder its parent wrote (so its own checks don't count it), and making the lane copy can take seconds (on
  // Windows, or a big repo); in that gap a supervisor pass saw the role under its cap and started a second session,
  // before the first could hit a usage limit (PU-19 failed on Windows CI once custom commands got copies, H-9).
  holdStarting({ agent, role, tool, model, task, lane });
  let copy = null;
  const laneless = !laneWantsCopy(lane) && !rehearsal && lanelessWantsCopy({ role, lane, task });
  // 2.78.1 (B-118): a failover (or the one-turn relaunch after a stream failure) under the same name works on in the copy
  // the ended session used. Making a new one first removed it, and on Windows a copy the dead agy's processes still
  // held stayed behind, fresh, so it was refused: "no lane copy could be made for builder-agyf9 (… still in use)".
  const reused = reuseCopy && !rehearsal && !process.env.STUDIO_MAIN_ROOT ? reusableCopy(agent, reuseCopy) : null;
  if (reused) {
    copy = reused;
    emitEvent({ type: 'lane.reused', agent, task: task || undefined, msg: `${agent} works on in its own copy (${LANES_DIR}/${agent}, branch ${reused.branch}): the session before it under this name ended and this one takes over`.slice(0, 400), meta: { dir: `${LANES_DIR}/${agent}`, branch: reused.branch } });
  } else if ((laneWantsCopy(lane) || laneless) && !process.env.STUDIO_MAIN_ROOT) {
    const c = createLaneCopy(agent, { task, lane });
    // 2.77.1 (H5): a copy that was wanted and could be made here but wasn't (a leftover .lanes/<agent> still in use, a failed
    // worktree add) refuses the start at once. It used to fall through to the shared checkout and the tool started anyway:
    // the session sat idle for an hour (crew, Windows). Git too old / STUDIO_WORKTREES=off / an unknown task id keep the
    // shared-checkout fallback. Nothing has been claimed for the task yet (the session claims it with `task start`).
    if (c.error && worktreeSupport().ok && !/is not on the board/.test(c.error)) {
      for (const q of held) release(`path:${q}`, agent);
      dropStarting(agent);
      const rel = `.lanes/${agent}`;
      let fresh = null;
      try { fresh = freshAgentName(role, agent); } catch { fresh = null; }
      const message = `Not started: no lane copy could be made for ${agent} (${c.error}). Use another agent name${fresh ? ` (${fresh} is free: --agent ${fresh}, or --auto-name)` : ''}, or remove the leftover copy ${rel} first: git worktree remove --force ${rel} (npm run janitor -- --lanes --yes --by <you> removes stale ones).`;
      emitEvent({ type: 'agent.start_refused', agent, to: 'human', task: task || undefined, status: 'warn', msg: message.slice(0, 600), meta: { role, dir: rel, error: c.error } });
      return { ok: false, skipped: true, message };
    }
    if (c.error) emitEvent({ type: 'lane.shared', agent, task, msg: `${agent} works in the shared checkout: ${c.error}` });
    else copy = { ...c, laneless };
  }
  // 2.77.0 (u, P5.1): an engine pass whose work lives in the engine's own repo gets a worktree of that repo on its branch
  // (harness/engine-tracks.mjs engineLaunch), named in its prompt and passed to the tool as an extra folder.
  const engineLane = launchEngineLane({ task, agent, role });
  if (engineLane?.refuse && !/^(off|0|false|no)$/i.test(process.env.STUDIO_ENGINE_LANE_REQUIRED || '')) {
    for (const q of held) release(`path:${q}`, agent);
    if (copy) removeLaneCopy(agent, { keepBranch: unmerged(copy.branch) > 0 });
    dropStarting(agent);
    const message = `Not started: ${agent} would have no code access for ${task}: ${engineLane.refuse}.`;
    emitEvent({ type: 'agent.start_refused', agent, to: 'human', task: task || undefined, status: 'warn', msg: message.slice(0, 600), meta: { role, engine: true } });
    return { ok: false, skipped: true, message };
  }
  // 2.76.0 (B-80 part 2): an agy session reads GEMINI.md in its folder: the shell rules, kept out of the lane's change.
  if (copy && tool === 'agy' && !custom) writeAgyLaneRules(copy.dir, { excludeFile: path.join(REPO_ROOT, '.studio', 'lanes', `${agent}.exclude`) });
  // 2.78.2 (item 9): region files left unheld for a copy: held after all when no copy was made.
  if (regionFree.size && !copy) {
    for (const p of regionFree) {
      const c = claim(`path:${p}`, agent, 6 * 3600);
      if (c && c.ok === false) {
        for (const q of held) release(`path:${q}`, agent);
        dropStarting(agent);
        return { ok: false, message: `Lane ${p} is taken: ${c.message || `claimed by ${c.lock?.owner || 'another agent'}`}` };
      }
      held.push(p);
    }
  } else if (regionFree.size) {
    emitEvent({ type: 'lane.unlocked', agent, task: task || undefined, msg: `${agent}: ${[...regionFree].join(', ')} not held as a file lock: its lane names regions of it (${laneEntries(lane).filter((e) => e.includes('#')).slice(0, 4).join(', ')}) and it allows region lanes; ${agent} works in its own copy, and the train catches a real conflict`.slice(0, 500), meta: { paths: [...regionFree], regions: true } });
  }
  // 2.59.0 (#8): the broad paths left unheld for a copy: held after all (a person kept them wide) or refused when the
  // copy couldn't be made; otherwise say once that they aren't locked.
  if (unheld.size && !copy) {
    const refused = broadLaneRefusal({ agent, role, task, lane, broad });
    if (refused) {
      for (const q of held) release(`path:${q}`, agent);
      dropStarting(agent);
      return refused;
    }
    for (const p of unheld) claim(`path:${p}`, agent, 6 * 3600);
  } else if (unheld.size) {
    emitEvent({ type: 'lane.unlocked', agent, task: task || undefined, msg: `${agent}: lane ${[...unheld].join(', ')} not held as a session lock (${broad.map((x) => x.why).join('; ')}): ${agent} works in its own copy, and overlaps with other lanes are caught when the lane lands`, meta: { paths: [...unheld] } });
  }
  const { stable, volatile } = sessionPromptParts({ role, agent, model, task, lane, oneTask, refreshes, note, by, tool, custom, copy, engineLane });
  // 2.30q (#8): warn when something session-specific slipped into the stable prefix (it would break the cache).
  { const leaks = volatileLeaks(stable, { agent, model, task }); if (leaks.length) emitSampled({ type: 'prompt.prefix.volatile', agent, to: 'producer', status: 'warn', msg: `${role} prompt prefix carries ${leaks.join(', ')}: every ${role} session misses the prompt cache; move it below the stable marker`, meta: { role, leaks } }, `${role}: ${leaks.join(',')}`); }
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
  const effort = { 'every-build': 'high', systems: 'medium' }[effectiveMode().review] || null;
  // 2.60.1, aider sessions (nim, aider): B-18 the aider to start (STUDIO_AIDER_CMD, .studio/aider-venv, PATH; the
  // preflight below says why when there is none); B-20 the agent's .aiderignore and the task's brief as --read; in a
  // lane copy aider's own .aider* files are kept out of the lane's change.
  const aiderRun = !custom && (tool === 'nim' || tool === 'aider');
  let aider = {};
  if (aiderRun) {
    const prog = aiderProgram({ env: process.env, onPath });
    let ignoreFile = null;
    try { ignoreFile = writeAiderIgnore(agent); } catch {}
    if (copy) excludeAiderFiles(agent);
    const brief = task ? path.join(STUDIO_STATE_DIR, 'briefs', `${task}.md`) : null;
    aider = { program: prog.cmd || 'aider', ignoreFile, reads: brief && fs.existsSync(brief) ? [brief] : [] };
    if (prog.cmd && prog.via !== 'PATH') launchNotes.push(`aider: ${prog.cmd} (${prog.via === 'venv' ? "the studio's .studio/aider-venv" : 'STUDIO_AIDER_CMD'})`);
    if (ignoreFile) launchNotes.push(`aider ignores the harness's folders and the protected paths (${path.relative(REPO_ROOT, ignoreFile).split(path.sep).join('/')})${aider.reads.length ? `; the brief is passed with --read` : ''}`);
  }
  // 2.78.1 (B-118): stream mode is the default for a builder-like agy session, unless this is the one-turn relaunch after
  // a stream failure, or the failure record (.studio/agy-stream.json) still holds for the agy on PATH.
  let agyStream = !custom && tool === 'agy' && agyStreamWanted({ role }) && !agyOneTurn;
  if (agyStream) {
    const held = agyStreamRecordCheck();
    if (held.holds) { agyStream = false; launchNotes.push(`agy stream mode skipped: .studio/${STREAM_RECORD} records that this agy refused it (${held.rec?.why || 'no reason recorded'}); ${held.why}. Delete .studio/${STREAM_RECORD} to try stream mode again; it is tried again by itself when agy changes.`); }
  }
  if (agyOneTurn && tool === 'agy') launchNotes.push('agy one-turn launch: the stream session before this one failed on its input format (see the line above); this session runs as one turn');
  const cmd = custom ? null : toolCommand(tool, { model, file, prompt, effort, addDirs: [...(copy ? laneShareDirs() : []), ...(engineLane?.dir ? [engineLane.dir] : [])], aider, stream: agyStream });
  if (!custom && !cmd) dropStarting(agent);
  if (!custom && !cmd) return { ok: false, message: `No launch command for tool "${tool}". Use --tool claude|codex|agy|cursor|grok|aider|nim, or set STUDIO_${roleKey(role)}_CMD (with {kickoff}, {agent}, {model}).` };
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const logFile = path.join(AGENTS_DIR, `${agent}.log`);
  const out = fs.openSync(logFile, 'a');
  // 2.76.0 (B-83, B-82): the log is appended to across sessions under one name (a relaunch, a refresh, a failover):
  // this session's part starts here. The stall check, the refresh check and the session's usage read only that part.
  let logFrom = 0;
  try { logFrom = fs.fstatSync(out).size; } catch {}
  // A task on another version of the game (--track engine:godot) tags everything its agent records.
  const track = task ? readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === task).pop()?.meta?.track : null;
  // 2.30q (#8): launched sessions get compact harness output (gate logs to files, a trimmed task list).
  // 2.33.0: the agent sees only its own tool's credentials and the studio's settings (harness/agent-env.mjs).
  // 2.59.0 (#14): the owner's key mapping (STUDIO_KEYMAP_<ROLE>, STUDIO_KEYMAP_AGENT_<NAME>): names in the log, never values.
  const keyNotes = [];
  // B-18 (2.60.1): a custom command for --tool nim (STUDIO_TOOL_NIM_CMD, the old venv workaround, or a role's command)
  // keeps nim's environment: the NIM key as OPENAI_API_KEY and AIDER_OPENAI_API_KEY (as a 'custom' tool it had no key).
  const nimCustom = Boolean(custom) && tool === 'nim' && !rehearsal;
  const env = agentEnv({ tool: custom && !nimCustom ? 'custom' : tool, role, model, agent, notes: keyNotes, extra: { STUDIO_LOCK_OWNER: agent, STUDIO_AGENT_MODEL: model, STUDIO_ROLE: role, STUDIO_COMPACT_OUTPUT: process.env.STUDIO_COMPACT_OUTPUT ?? 'on', ...(track ? { STUDIO_TRACK: track } : {}), STUDIO_TASK_PIN: task || '' } });
  for (const n of launchNotes) fs.writeSync(out, `[launcher] ${n}\n`);
  if (nimCustom) fs.writeSync(out, `[launcher] the custom command for --tool nim gets nim's environment: the NIM key as OPENAI_API_KEY and AIDER_OPENAI_API_KEY (value not shown)\n`);
  // B-37 (2.60.1): Python holds its output in a buffer when stdout is a file, so an aider that died left nothing in the
  // log; unbuffered, and UTF-8 (a Windows code page can't print every character aider prints).
  if (aiderRun || nimCustom) {
    env.PYTHONUNBUFFERED ||= '1';
    env.PYTHONIOENCODING ||= 'utf-8';
  }
  if (keyNotes.length) {
    for (const n of keyNotes) fs.writeSync(out, `[launcher] ${n}\n`);
    const refusedKeys = keyNotes.filter((n) => /refused|not set/.test(n));
    emitEvent({ type: 'agent.keymap', agent, task: task || undefined, to: refusedKeys.length ? 'human' : undefined, status: refusedKeys.length ? 'warn' : 'ok', msg: `${agent}: ${keyNotes.join('; ')}`.slice(0, 600) });
  }
  // Claude Code stops a shell command after 2 minutes by default, so agents sent a long verify to the
  // background and their session ended with it (test #3). Give commands 10 minutes unless set.
  env.BASH_DEFAULT_TIMEOUT_MS ||= '600000';
  env.BASH_MAX_TIMEOUT_MS ||= '1200000';
  // 2.30g: the Director and Producer start from the same prefix every time, often more than 5 minutes
  // apart, so they ask Claude Code for the 1-hour cache (Claude Code 2.1.108+; older versions ignore it).
  if (cacheTtlAsked(role) === '1h') {
    env.ENABLE_PROMPT_CACHING_1H ||= '1';
    env.CLAUDE_CODE_PROMPT_CACHE_TTL ||= '1h';
  }
  if (copy) env.STUDIO_MAIN_ROOT = REPO_ROOT;
  const cwd = copy ? copy.dir : REPO_ROOT;
  // P-066 (crew P-036): a built-in tool starts with no shell on every OS and its arguments intact (harness/launch.mjs:
  // on Windows an npm .cmd shim runs as node on its .js entry, any other .cmd through cmd.exe with each argument quoted
  // for it). A custom command is the user's own line for the shell; the values filled into it are quoted for that shell.
  let line = null;
  let plan = null;
  try {
    if (custom) {
      if (nimCustom && nimKeyMissing(env)) throw new Error('NVIDIA_API_KEY is not set: add your NVIDIA NIM key to .env (the agent gets it as OPENAI_API_KEY; it is never printed)');
      // H-9: in a copy, a script the line names that isn't committed is run from the main checkout (absolute path).
      const loc = copy ? localizeCommand(custom, { from: REPO_ROOT, to: copy.dir }) : { template: custom, values: {}, moved: [] };
      if (loc.moved.length) fs.writeSync(out, `[launcher] not in this agent's copy, run from the main checkout: ${loc.moved.join(', ')}\n`);
      line = fillCommand(loc.template, { kickoff: file, agent, model, role, task: task || '', mainRoot: REPO_ROOT, addDirs: copy ? laneShareDirs().flatMap((d) => ['--add-dir', d]) : [], ...loc.values });
    }
    else if (toolPreflight(tool, env)) throw new Error(toolPreflight(tool, env));
    else plan = launchPlan(cmd.argv, { env, cwd, promptAt: cmd.promptAt, promptFile: file });
  } catch (err) {
    // Nothing started (a value cmd.exe can't carry, a command line too long): say why, give back the lane and the copy.
    fs.writeSync(out, `\n[launcher] could not start: ${err.message}\n`);
    fs.closeSync(out);
    if (copy) removeLaneCopy(agent, { keepBranch: unmerged(copy.branch) > 0 });
    for (const p of lanePaths) release(`path:${p}`, agent);
    dropStarting(agent);
    emitEvent({ type: 'launch.skipped', agent, to: 'human', task: task || undefined, status: 'error', msg: `${agent} not started (${role} on ${custom ? 'a custom command' : tool}): ${err.message}`.slice(0, 400), meta: { role, tool } });
    return { ok: false, message: `${agent} not started: ${err.message}` };
  }
  const said = describePlan(plan);
  if (said) fs.writeSync(out, `[launcher] ${said}\n`);
  // B-37: where this session's own output starts in the log (the log is appended to across sessions).
  let logStart = 0;
  try { logStart = fs.fstatSync(out).size; } catch {}
  const t0 = Date.now();
  if (custom && copy) fs.writeSync(out, `[launcher] the custom command runs in this agent's own copy (${path.relative(REPO_ROOT, copy.dir).split(path.sep).join('/')}); the main checkout is $STUDIO_MAIN_ROOT, {mainRoot} in the command; {addDirs} gives the --add-dir pair for its studio/ and .studio/\n`);
  const child = custom
    ? spawn(line, { windowsHide: true, cwd, shell: true, env, stdio: ['ignore', out, out] })
    : spawnPlan(plan, { cwd, env, stdio: [cmd.stdin ? 'pipe' : 'ignore', out, out] });
  // PU-17 (P-039, P-045): when the agent's process started, for a later stop to check the number is still the agent.
  // In-process only (no child process, nothing slow): the spawn time and the program's name; /proc ticks on Linux.
  const identity = { pid: spawnedIdentity(child.pid, custom ? line.split(/\s+/)[0] : plan.file), supervisor: launcherIdentity() };
  const startedAt = new Date().toISOString();
  // 2.77.3 (C1 / B-99): an agy stream session keeps its stdin open; harness/agy-stream.mjs reads its turns from the log
  // and sends a follow-up while its task is still in progress (STUDIO_AGY_CONTINUE_MAX, STUDIO_AGY_CONTINUE_WAIT_SEC).
  let agyDriver = null;
  if (cmd?.stream === 'agy' && child.stdin) {
    fs.writeSync(out, `[launcher] agy stream session: ${AGY_STREAM_FLAGS.join(' ')}; stdin stays open for follow-ups while the task is in progress (the default; STUDIO_AGY_STREAM=0 starts the one-turn launch)\n`);
    try {
      agyDriver = driveAgyStream({
        agent, child, logFile, from: logStart, firstMessage: cmd.stdin,
        decide: () => taskStillOpen({ agent, role, task, startedAt, locks: listLocks(), events: readRecentEvents(5000), doneIds: parseNextQueue().done.map((t) => t.id), studioStop: readStop(), agentStop: stopMark(agent), refresh: readFlag(agent) }),
        note: (l) => { try { fs.appendFileSync(logFile, `[launcher] ${l}\n`); } catch {} },
        onContinue: ({ n, task: t, why, nudge }) => emitEvent({ type: 'agent.agy_continue', agent, task: t || task || undefined, msg: `${agent}: ${nudge ? `no tool call or file write for STUDIO_AGY_NUDGE_MIN while ${t || 'its task'} is in progress` : `agy's turn ended with ${t || 'its task'} in progress`} (${why}); follow-up ${n} sent${nudge ? ' as a nudge' : ''}`.slice(0, 400), meta: { n, ...(nudge ? { nudge: true } : {}) } }),
        // 2.78.1: the progress nudge reads the stall check's progress and stays below its no-progress limit.
        progressAt: () => Date.parse(readStall(agent)?.lastProgressAt || '') || 0,
        stallMin: () => stallLimits(role).stallMin,
      });
    } catch (err) {
      fs.writeSync(out, `[launcher] agy stream: couldn't follow the session (${String(err?.message || err).slice(0, 200)}); its input is closed after the kickoff\n`);
      try { child.stdin.end(); } catch {}
    }
  } else if (cmd?.stdin && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.stdin);
  }
  clearFlag(agent);
  const session = { agent, role, tool: custom && !viaTool ? 'custom' : tool, model, profile: profileOf(role, custom || ''), pid: child.pid, supervisor: process.pid, identity, status: 'running', startedAt, lastBeat: startedAt, log: path.relative(REPO_ROOT, logFile), task, ...(task ? { pinned: task } : {}), lane, oneTask, division, hiredBy: by, prefixHash: prefix?.hash || null, logFrom, ...(copy ? { copy: { dir: path.relative(REPO_ROOT, copy.dir).split(path.sep).join('/'), branch: copy.branch } } : {}) };
  fs.writeFileSync(sessionFile(agent), JSON.stringify(session, null, 2));
  resetStall(agent); // 2.76.0 (B-83): the last session's stall record never judges this one
  emitEvent({ type: 'agent.session.start', agent, model, status: 'running', task, msg: `${agent} started (${role}, ${session.tool}, ${model})${by ? `, hired by ${by}` : ''}${division ? ` into ${division}` : ''}`, meta: { role, tool: session.tool, pid: child.pid, division, hiredBy: by, lane } });
  // 2.73.1 (B-66): when this launcher ends the agent itself (stall, idle, budget), so the end records why.
  let killedBy = null;
  const beat = setInterval(() => {
    // 2.73.2 (B-74): limits changed in .env since this launcher started (STUDIO_STALL_MIN, ...) apply from this beat.
    reloadEnvIfChanged({ by: `launcher ${agent}` });
    const now = new Date().toISOString();
    const s = readJson(sessionFile(agent)) || session;
    const wip = wipSummary(agent);
    let progress = null;
    try {
      progress = heartbeatCheck(agent, { log: tailOf(logFile, undefined, logFrom), model, task, role });
    } catch {
      // the refresh check is a help, never a blocker
    }
    // 2.30o: the stall check (harness/stall.mjs): no progress, a read-only burn, or past the wall-clock cap ends it.
    let stall = null;
    try {
      // 2.76.0 (B-84): a copy made when the session claimed its task (harness/lane-at-claim.mjs) is where its work is.
      const cwdNow = !copy && s.copy?.dir ? path.join(REPO_ROOT, s.copy.dir) : cwd;
      stall = observe({ ...session, ...s }, { tokens: logTokens(tailOf(logFile, undefined, logFrom)), cwd: fs.existsSync(cwdNow) ? cwdNow : cwd });
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
      killedBy ||= { kind: 'idle', why: idle.why, at: new Date().toISOString() };
      stopChild(child);
    }
    // 2.73.2 (B-72): logged once per session (logStall: not again when the watchdog logged it first); this launcher
    // ends its own agent once.
    // 2.78.1 (e): a builder's verify red on a different cause than its previous red, past half its refresh point: end
    // this session as a refresh (the flag's endedBy), so a fresh one starts from the hand-back with the failure only.
    try {
      const nr = !killedBy ? newRedCheck(agent, { since: Date.parse(startedAt) || 0, context: progress?.context || 0, role, model }) : null;
      if (nr?.handoff) {
        killedBy = { kind: 'refresh', why: nr.why, at: new Date().toISOString() };
        stopChild(child);
      }
    } catch {
      // the new-red check is a help, never a crash
    }
    if (stall?.stalled && !killedBy) {
      logStall({ ...session, ...s }, stall, { by: 'launcher' });
      killedBy = { kind: 'stall', why: stall.why, stallKind: stall.kind, at: new Date().toISOString() };
      stopChild(child);
    }
    // 2.31.0: the task this session holds used its budget across sessions: end the session, the task stays parked.
    try {
      const heldTask = listLocks().find((l) => l.owner === agent && l.key.startsWith('task:'))?.key.slice(5) || task;
      if (heldTask && !s.budgetStop) {
        const over = stopIfOverBudget(heldTask, { by: 'launcher' });
        if (over) {
          fs.writeFileSync(sessionFile(agent), JSON.stringify({ ...readJson(sessionFile(agent)), budgetStop: over }, null, 2));
          emitEvent({ type: 'agent.budget_stop', agent, task: heldTask, to: 'producer', msg: `${agent} ended: ${over.split('. ')[0]}` });
          killedBy ||= { kind: 'budget', why: over.split('. ')[0], at: new Date().toISOString() };
          stopChild(child);
        }
      }
    } catch {
      // the budget check is a guard, never a crash
    }
    // 2.64.0: route what happened since the last beat to the tasks' inboxes (harness/threads.mjs; shadow mode logs only).
    try { sweepThreads({ lockMs: 1000 }); } catch { /* routing is a help, never a crash */ }
    emitEvent({ type: 'agent.heartbeat', agent, model, status: 'running', msg: `${agent} alive${wip ? `: ${wip}` : ''}${s.now ? ` (now: ${s.now})` : ''}` });
  }, HEARTBEAT_MS);
  let exitSignal = null;
  let spawnError = null;
  let exitedAt = null;
  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `\n[launcher] could not start: ${err.message}\n`);
      spawnError = err.message;
      exitedAt = new Date().toISOString();
      resolve(127);
    });
    child.on('exit', (c, sig) => { exitSignal = sig || null; exitedAt = new Date().toISOString(); resolve(c ?? 1); });
  });
  clearInterval(beat);
  if (agyDriver) { try { agyDriver.stop(); } catch {} }
  // 2.73.2 (B-72/B-76): the watchdog's stall end (another process: logStall recorded it) is a stall end here too, so
  // the halt rule doesn't count it as the tool failing; and the record says at once that the agent has exited, so the
  // listing, the HUD and the watch pass see it ending while the clean-up below runs (it can take minutes).
  if (!killedBy) { const st = stallEndOf(agent, startedAt); if (st && st.by !== 'launcher') killedBy = { kind: 'stall', why: st.why, stallKind: st.kind, at: st.at, by: st.by }; }
  markAgentExited(agent, startedAt, { at: exitedAt || new Date().toISOString(), code, signal: exitSignal, kind: killedBy?.kind || (spawnError ? 'spawn-error' : exitSignal ? 'signal' : 'exit') });
  fs.closeSync(out);
  // 2.76.0 (B-82): this session's own part of the log (an earlier session's result line in the tail was reported as
  // this one's usage and cost: two session ends with the same costUsd), and all of it for the usage of a session the
  // launcher ended (no result line of its own).
  const log = readLogFrom(logFile, logFrom, 256 * 1024).slice(-20000);
  const usageLog = readLogFrom(logFile, logFrom, 64 * 1024 * 1024);
  // B-37 (2.60.1): a failed aider session (nim, aider) leaves evidence: the last lines of its output in a file beside
  // the log, and its lane copy kept for a look (STUDIO_KEEP_FAILED_LANE=off removes it as before). Before H-1's line,
  // which stays the log's last.
  let keptCopy = false;
  if ((session.tool === 'nim' || session.tool === 'aider') && code !== 0) {
    const ev = failedSessionEvidence({ agent, logFile, from: logStart, code, tool: session.tool, model, secs: Math.round((Date.now() - t0) / 1000), cwd, secrets: [env.OPENAI_API_KEY, env.AIDER_OPENAI_API_KEY] });
    keptCopy = Boolean(copy) && !/^(off|0|false|no)$/i.test(process.env.STUDIO_KEEP_FAILED_LANE || '');
    const rel = copy ? path.relative(REPO_ROOT, copy.dir).split(path.sep).join('/') : null;
    const kept = keptCopy ? ` Its lane copy is kept for a look: ${rel} (branch ${copy.branch}); a session named ${agent} replaces it, or remove it: git worktree remove --force ${rel}.` : '';
    try { fs.appendFileSync(logFile, `\n[launcher] ${ev.line}${kept}\n`); } catch {}
    emitEvent({ type: 'agent.failed_evidence', agent, to: 'human', task: task || undefined, status: 'error', msg: `${agent}: ${ev.line}${kept}`.slice(0, 600), meta: { tool: session.tool, model, code, tail: ev.file, keptCopy: keptCopy ? rel : null } });
  }
  // H-1 (2.58.5): a NIM model that is gone (410) or unknown (404) gets one clear line in the log and for a person.
  if (session.tool === 'nim') {
    const gone = nimModelTrouble(log, model);
    if (gone) {
      try { fs.appendFileSync(logFile, `\n[launcher] ${gone}\n`); } catch {}
      emitEvent({ type: 'agent.model_gone', agent, to: 'human', task: task || undefined, status: 'error', msg: `${agent}: ${gone}`.slice(0, 400), meta: { tool: 'nim', model } });
    }
  }
  const atClaim = !copy ? (readJson(sessionFile(agent)) || {}).copy || null : null; // 2.76.0 (B-84): made at task start
  // 2.78.1 (B-118): an agy stream session that exited before its first turn ended, on an input-format error or with no
  // stream-json at all: recorded once (.studio/agy-stream.json) and relaunched below in the one-turn mode.
  let streamFail = null;
  if (agyDriver) {
    try {
      streamFail = streamFailure({ state: agyDriver.state, log, ended: killedBy || stopMark(agent) || (spawnError ? { kind: 'spawn-error' } : null) });
      if (streamFail.failed) recordStreamFailure({ agent, task, why: streamFail.why, line: streamFail.line, logFile });
      else streamFail = null;
    } catch { streamFail = null; }
  }
  const result = cleanUp(agent, { code, log, usageLog, role, tool: session.tool, model, cmd: session.tool === 'custom' ? custom : null, exit: { signal: exitSignal, killedBy, spawnError, at: exitedAt, ranMs: Date.now() - t0 } });
  // 2.78.1 (B-118): the copies are removed below, unless the next session under this name (a failover, the one-turn
  // relaunch) works on in them: ownCopy.
  const atClaimDir = atClaim?.branch && atClaim.dir ? path.join(REPO_ROOT, atClaim.dir) : null;
  const ownCopy = copy && fs.existsSync(copy.dir) ? { dir: copy.dir, branch: copy.branch, laneless: Boolean(copy.laneless) } : atClaimDir && fs.existsSync(atClaimDir) ? { dir: atClaimDir, branch: atClaim.branch, laneless: true } : null;
  // 2.79 (b): a copy whose task waits in a train's queue is left for the train (it checks and lands it from that copy) and
  // the janitor (it removes it once the task has landed). task done queues and the session ends seconds later: removing
  // the copy then made the train find a lane folder with no .git (the 2.78.2 hand-backs "its copy is on main now").
  const dropCopies = async () => {
    const queued = await queuedCopy(agent, [copy?.dir, atClaimDir]);
    if (queued) { emitEvent({ type: 'lane.kept', agent, task: queued.task, msg: `Kept ${agent}'s lane copy: ${queued.task} waits in the ${queued.train} train queue` }); return; }
    if (copy && !keptCopy) removeLaneCopy(agent, { keepBranch: unmerged(copy.branch) > 0 });
    if (atClaimDir && fs.existsSync(atClaimDir)) removeLaneCopy(agent, { keepBranch: unmerged(atClaim.branch) > 0 });
  };
  for (const p of lanePaths) release(`path:${p}`, agent);
  // Refreshed (2.29.2): the launcher reopens the same task at once in a fresh session that reads the hand-back.
  // The task it handed back, or the task it was started on when it hadn't claimed it yet (and it isn't done).
  const again = result.capped ? result.handed[0]?.task || (task && !parseNextQueue().done.some((t) => t.id === task) ? task : null) : null;
  const maxRefresh = Number(process.env.STUDIO_REFRESH_RELAUNCH ?? 5);
  if (again && !readStop() && (opts2.refreshes || 0) < maxRefresh) {
    await dropCopies();
    emitEvent({ type: 'agent.refresh', agent, task: again, msg: `${agent} refreshed on ${again}; a fresh session continues from studio/handoffs/${again}.md` });
    return runAgent({ role, agent, tool, model, fallback, task: again, lane, oneTask, division, note, by, refreshes: (opts2.refreshes || 0) + 1 });
  }
  // 2.78.1 (B-118): the stream session failed on its input format: once, the same agent and model again in the one-turn
  // mode (before any failover), in its own copy. Its task, if it had one and it isn't done; or, started with none, a
  // session that finished nothing.
  if (streamFail && !agyOneTurn && !readStop() && !stopMark(agent)) {
    const resume = result.handed[0]?.task || (task && !parseNextQueue().done.some((t) => t.id === task) ? task : null);
    if (resume || (!task && !result.finished?.length)) {
      emitEvent({ type: 'agent.agy_one_turn', agent, task: resume || undefined, to: 'producer', status: 'warn', msg: `${agent}: ${streamFail.why.slice(0, 240)}; relaunched in the one-turn mode${resume ? ` on ${resume}` : ''}`.slice(0, 500) });
      return runAgent({ role, agent, tool, model, fallback, task: resume, lane, oneTask, division, note, by, refreshes: opts2.refreshes || 0, reuseCopy: ownCopy, agyOneTurn: true });
    }
  }
  if (result.bad && !fallback.length && result.troubleKind === 'quota') {
    if (isNim(model, tool) && process.env.STUDIO_NIM_FALLBACK) fallback = [process.env.STUDIO_NIM_FALLBACK];
  }
  // 2.30o: any run-out (quota, 429 loop, spend or token cap, credit refused, 5xx refusals) on any launcher:
  // with no fallback given, the next tool in the budget order that isn't marked out takes the task over.
  // PU-19: not for a custom command: the next tool would run that same command, so it waits for the reset.
  if (result.bad && !fallback.length && result.troubleKind === 'quota' && process.env.STUDIO_TAKEOVER !== 'off' && session.tool !== 'custom') {
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
    // 2.77.0 (n): a failover keeps the model only within its family: agy gets a Gemini model, claude never a Gemini one.
    if (!fmodel && ftool === 'agy' && !isGeminiModel(model)) model = isGeminiModel(process.env.STUDIO_TOOL_AGY_MODEL) ? String(process.env.STUDIO_TOOL_AGY_MODEL).trim() : AGY_DEFAULT_MODEL;
    else if (!fmodel && ftool !== 'agy' && isGeminiModel(model)) model = String(process.env[`STUDIO_TOOL_${roleKey(ftool)}_MODEL`] || process.env[`STUDIO_${roleKey(role)}_MODEL`] || process.env.STUDIO_AGENT_MODEL || 'unknown').trim();
    emitEvent({ type: 'agent.failover', agent, to: 'producer', msg: `${agent} failed over to ${ftool}${fmodel ? ` (${fmodel})` : ''}${resume ? ` on ${resume}` : ''}${ownCopy ? `, in its own copy (${LANES_DIR}/${agent})` : ''}` });
    // 2.78.1 (B-118): the failover works on in the ended session's copy (reuseCopy), never a new one under the same name.
    return runAgent({ role, agent, tool: ftool, model: fmodel || model, fallback: rest, task: resume, lane, oneTask, division, note, by, reuseCopy: ownCopy });
  }
  await dropCopies();
  return { ok: true, code, ...result };
}

/**
 * 2.78.1 (B-118): the copy the ended session under this name used, to work on in: { dir, branch, laneless, reused }, or
 * null when it is gone or isn't this agent's lane worktree (then a new copy is made as usual).
 */
function reusableCopy(agent, prev) {
  try {
    const dir = path.resolve(REPO_ROOT, String(prev?.dir || ''));
    const own = path.join(REPO_ROOT, LANES_DIR, agent);
    const same = process.platform === 'win32' ? dir.toLowerCase() === own.toLowerCase() : dir === own;
    if (!prev?.dir || !same || !fs.existsSync(dir) || !isLaneWorktree(dir, REPO_ROOT)) return null;
    const head = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { windowsHide: true, cwd: dir, encoding: 'utf8' });
    const branch = head.status === 0 ? head.stdout.trim() : prev.branch;
    if (!branch) return null;
    return { dir, branch, carried: null, mixed: null, sparse: null, laneless: Boolean(prev.laneless), reused: true };
  } catch { return null; }
}

/** 2.78.1: agy's program file on PATH ({ program, size, mtimeMs }), and its --version line (a spawn: asked only when needed). */
function agyIdent(env = process.env) {
  try {
    let program = null;
    if (process.platform === 'win32') {
      // An npm shim runs its .js entry (the file an upgrade rewrites); a .exe or .cmd is the file itself.
      const r = resolveCommand('agy', { env });
      program = r.mode === 'missing' ? null : r.mode === 'node' ? r.prefix[r.prefix.length - 1] : r.script || r.file;
    } else {
      program = String(envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'agy')).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;
      if (program) { try { program = fs.realpathSync(program); } catch {} }
    }
    if (!program || !fs.existsSync(program)) return null;
    const st = fs.statSync(program);
    return { program, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch { return null; }
}
function agyVersion(env = process.env) {
  try {
    const r = spawnAgentSync(['agy', '--version'], { env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    const line = `${r.stdout || ''}`.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return r.status === 0 && line ? line.slice(0, 120) : null;
  } catch { return null; }
}
/** 2.78.1: does the stream failure record hold for this agy? { holds, why, rec }. No record: no spawn, no stat. */
function agyStreamRecordCheck(env = process.env) {
  const rec = readStreamRecord(STUDIO_STATE_DIR);
  if (!rec) return { holds: false, why: 'no record', rec: null };
  const h = streamRecordHolds(rec, { ident: () => agyIdent(env), version: () => agyVersion(env) });
  try {
    if (h.refreshed) writeStreamRecord(STUDIO_STATE_DIR, h.refreshed);
    if (h.changed) {
      fs.rmSync(path.join(STUDIO_STATE_DIR, STREAM_RECORD), { force: true });
      emitEvent({ type: 'agent.agy_stream_retry', agent: 'launcher', to: 'producer', msg: `${h.why}: .studio/${STREAM_RECORD} cleared; agy builders try the stream mode again`.slice(0, 400) });
    }
  } catch { /* the record is a help */ }
  return { ...h, rec };
}
/** 2.78.1: write the stream failure record once (not again while one holds for this agy). */
function recordStreamFailure({ agent, task, why, line, logFile }) {
  const prev = readStreamRecord(STUDIO_STATE_DIR);
  const note = (l) => { try { fs.appendFileSync(logFile, `[launcher] ${l}\n`); } catch {} };
  if (prev && streamRecordHolds(prev, { ident: () => agyIdent(), version: () => agyVersion() }).holds) { note(`agy stream: ${why}; already recorded in .studio/${STREAM_RECORD}`); return false; }
  const ident = agyIdent();
  const rec = { at: new Date().toISOString(), agent, task: task || null, why: String(why).slice(0, 400), line: line || null, flags: [...AGY_STREAM_FLAGS], agy: { ...(ident || {}), version: agyVersion() }, clear: `delete .studio/${STREAM_RECORD} to try the stream mode again (it is tried again by itself when agy changes)` };
  writeStreamRecord(STUDIO_STATE_DIR, rec);
  note(`agy stream: ${why}; recorded in .studio/${STREAM_RECORD}: agy builders start in the one-turn mode until it is deleted or agy changes`);
  emitEvent({ type: 'agent.agy_stream_off', agent, to: 'human', task: task || undefined, status: 'warn', msg: `${agent}: ${why}. Recorded in .studio/${STREAM_RECORD}: agy builders start in the one-turn mode until it is deleted or agy changes${rec.agy.version ? ` (now ${rec.agy.version})` : ''}`.slice(0, 600), meta: { agy: rec.agy, line: rec.line } });
  return true;
}

/**
 * B-37 (2.60.1): the last lines (STUDIO_FAILED_TAIL_LINES, 200) of a failed session's own output, from `from` (its
 * start in the log), written to .studio/agents/<agent>.failed-<time>.log with what exited and how; { file, line }.
 */
export function failedSessionEvidence({ agent, logFile, from = 0, code, tool, model, secs = null, cwd = null, secrets = [] }) {
  let text = '';
  try {
    const fd = fs.openSync(logFile, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(from, size - 2 * 1024 * 1024);
    const buf = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {}
  // The session's key never goes into the copy (aider doesn't print it; this makes sure).
  for (const k of secrets) if (k && String(k).length >= 8) text = text.split(String(k)).join('<key>');
  const n = Math.max(1, Number(process.env.STUDIO_FAILED_TAIL_LINES || 200) || 200);
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-n);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
  const file = path.join(AGENTS_DIR, `${agent}.failed-${stamp}.log`);
  const head = [`# ${agent}: ${tool} (${model}) exited with code ${code}${secs !== null ? ` after ${secs} s` : ''}`, `# cwd: ${cwd ? path.relative(REPO_ROOT, cwd).split(path.sep).join('/') || '.' : '?'}`, `# the last ${tail.length} of ${lines.length} lines it printed:`, ''];
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.writeFileSync(file, `${head.join('\n')}${tail.join('\n')}\n`);
  } catch {}
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const line = tail.length
    ? `${tool} exited with code ${code}${secs !== null ? ` after ${secs} s` : ''}; its last ${tail.length} lines are in ${rel}.`
    : `${tool} exited with code ${code}${secs !== null ? ` after ${secs} s` : ''} and printed nothing (output unbuffered); ${rel} records the exit.`;
  return { file: rel, line, lines: tail.length };
}

/**
 * End a process and anything it started (on Windows a custom command or a plain .cmd tool runs under cmd.exe, and any
 * agent starts its own tools, so kill the tree). group: the
 * process leads its own process group (a launcher started with --detach), so on macOS and Linux the group goes too.
 */
function killTree(pid, { group = false } = {}) {
  try {
    if (IS.win) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else if (group) {
      try {
        process.kill(-pid);
      } catch {
        process.kill(pid);
      }
    } else process.kill(pid);
    return true;
  } catch {
    return false;
  }
}

/**
 * The launcher's own child: until Node has seen it exit, the OS can't give its number to anyone else (the launcher
 * still holds it), so the ChildProcess itself is the identity check and no OS query is needed.
 */
function stopChild(child) {
  return child && child.exitCode === null && child.signalCode === null && child.pid ? killTree(child.pid) : false;
}

// This launcher's start: the spawn time its parent wrote in the placeholder (startAgent --detach), else its own
// clock (Date.now() - process.uptime()). Never an OS query.
let LAUNCHER_ID = null;
const launcherIdentity = () => LAUNCHER_ID || (LAUNCHER_ID = selfIdentity());
/** 2.58.5: a "starting" record for this launcher (its pid and spawn time), unless another live session holds the name. */
function holdStarting({ agent, role, tool, model, task, lane }) {
  try {
    if (sessions().some((x) => x.agent === agent && x.running && !(x.starting && x.supervisor === process.pid))) return;
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.writeFileSync(sessionFile(agent), JSON.stringify({ agent, role, tool, model, task: task || null, lane: lane || null, status: 'running', starting: true, supervisor: process.pid, identity: { supervisor: launcherIdentity() }, startedAt: new Date().toISOString() }, null, 2));
  } catch {}
}
/** Takes back this launcher's own "starting" record when the session never starts. */
function dropStarting(agent) {
  try { const p = readJson(sessionFile(agent)); if (p?.starting && p.supervisor === process.pid) fs.rmSync(sessionFile(agent), { force: true }); } catch {}
}

/**
 * PU-17 (P-039, P-045): what a stop does with a session's process, decided at kill time. `cur` is what the OS says
 * about the target now (harness/proc-identity.mjs readStarts, read once by the caller): { start, proc?, cmd? },
 * { error } when it couldn't be read, or null when the number is free. The target is the agent's process, or, while
 * the session is still starting (a launcher, no agent yet), the launcher.
 *   kill: kill the target and its tree. end: mark the session ended and hand its work back here, because no live
 *   launcher is left to do it.
 *   same start (within the tolerance): kill. Clearly different: the number is another program's; nothing is killed.
 *   Nothing to compare (unreadable, or a record from before PU-17): the old rule. A heartbeat within the stall
 *   threshold means the launcher wrote it minutes ago, so the number is still the agent's: kill. An older one means
 *   it may be anyone's by now: nothing is killed and the session is treated as dead. Wrongly sparing a dead record
 *   costs nothing; wrongly killing costs a stranger's program.
 */
export function killVerdict(s, cur, now = Date.now()) {
  const beat = Date.parse(s.lastBeat || s.startedAt || '');
  const beatMin = Number.isFinite(beat) ? Math.max(0, Math.round((now - beat) / 60000)) : null;
  const fresh = beatMin !== null && beatMin <= STALL_BEAT_MIN;
  const starting = !s.pid;
  const pid = s.pid || s.supervisor || null;
  const recorded = starting ? s.identity?.supervisor : s.identity?.pid;
  const who = starting ? 'its launcher (the agent was still starting)' : 'the agent';
  // While the agent runs, its launcher hands the work back when the agent ends (listing check: no OS query).
  // 2.73.2 (B-72): a launcher wrapping up after its agent exited (no heartbeat while it hands the work back) is live too:
  // a stop then must not hand the same work back a second time beside it.
  const launcherLive = !starting && Boolean(s.supervisor) && s.supervisor !== s.pid && (fresh || Boolean(wrappingUp(s, now))) && pidAlive(s.supervisor, s.identity?.supervisor);
  const base = { pid, target: starting ? 'launcher' : 'agent', beatMin, cmd: cur?.cmd || null, end: starting || !launcherLive };
  if (!pid) return { ...base, kill: false, end: true, kind: 'gone', why: 'it has no process on record' };
  if (!cur) return { ...base, kill: false, kind: 'gone', why: `${starting ? 'its launcher' : 'its process'} (pid ${pid}) is gone` };
  const same = sameProcess(recorded, cur);
  if (same === true) return { ...base, kill: true, kind: 'same', why: `pid ${pid} is still ${who} (same start time)` };
  if (same === false) {
    const secs = Number.isFinite(cur.start) && Number.isFinite(recorded?.start) ? Math.round(Math.abs(cur.start - recorded.start) / 1000) : null;
    return { ...base, kill: false, kind: 'reused', why: `pid ${pid} now belongs to another program${cur.cmd ? ` (${cur.cmd})` : ''}${secs !== null ? `, started ${secs} s ${cur.start > recorded.start ? 'after' : 'before'} ${who}` : ''}: nothing was killed` };
  }
  const what = cur.error ? `its start time couldn't be read (${cur.error})` : 'the record has no start time';
  if (fresh) return { ...base, kill: true, kind: 'unverified', why: `${what}, but its heartbeat is ${beatMin} min old, so pid ${pid} is still ${who}` };
  return { ...base, kill: false, kind: 'stale', why: `pid ${pid} is in use but ${what} and the last heartbeat was ${beatMin ?? '?'} min ago (over ${STALL_BEAT_MIN}), so the number may belong to another program now: nothing was killed` };
}

/**
 * 2.58.3 (N1): who stopped a session, written by stopAgent (agent stop, pause, stop all) before it kills, and read by
 * the launcher when the agent exits. Kept beside the record (.studio/agents/<agent>.stop, written whole) as well as in
 * it (stopRequested), because the launcher's heartbeat rewrites the record and could drop a field written meanwhile.
 * Only a mark made during this session counts (the same startedAt).
 */
const stopFile = (agent) => path.join(AGENTS_DIR, `${agent}.stop`);
export function recordStop(s, by, kind = 'stop') {
  const mark = { by: String(by || 'unknown').slice(0, 60), kind, at: new Date().toISOString(), startedAt: s.startedAt || null };
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    writeAtomic(stopFile(s.agent), `${JSON.stringify(mark)}\n`, { fsync: false });
    const cur = readJson(sessionFile(s.agent));
    if (cur && cur.startedAt === s.startedAt) writeAtomic(sessionFile(s.agent), JSON.stringify({ ...cur, stopRequested: mark }, null, 2), { fsync: false });
  } catch {
    // the stop goes ahead; at worst it reads as a crash, as before
  }
  return mark;
}
export function stopMark(agent, s = readJson(sessionFile(agent))) {
  if (!s) return null;
  const ok = (m) => m && m.by && (!s.startedAt || !m.startedAt || m.startedAt === s.startedAt) && (!s.startedAt || Date.parse(m.at) >= Date.parse(s.startedAt) - 1000);
  const side = readJson(stopFile(agent));
  if (ok(side)) return side;
  return ok(s.stopRequested) ? s.stopRequested : null;
}

/**
 * A session whose process is gone, isn't the agent any more, or whose launcher was just killed ends here, the way
 * the watcher ends a dead one (markGone, then the hand-back and releaseDeadLocks): the record is marked ended,
 * uncommitted work is saved, its tasks go back to the queue with a note, and its claims are freed.
 */
function endAsDead(s, v, by) {
  const cur = readJson(sessionFile(s.agent));
  if (!cur || cur.status !== 'running') return false; // already ended (its launcher got there first)
  // A new session has taken the name since; unless it is the launcher just killed, which wrote its real record.
  if (cur.startedAt && s.startedAt && cur.startedAt !== s.startedAt && !(v.kill && v.target === 'launcher' && cur.supervisor === s.supervisor)) return false;
  const what = v.kill ? (v.target === 'launcher' ? `stopped by ${by} while it was starting; its launcher was stopped, so the stop handed its work back` : `stopped by ${by}; its launcher was gone, so the stop handed its work back`) : v.why;
  const reason = v.kill ? what : `ended by ${by}: ${v.why}`;
  // 2.58.3 (N1): a stop someone asked for (agent stop, pause, stop all) is a stop, not a crash.
  const stop = stopMark(s.agent, cur);
  fs.writeFileSync(sessionFile(s.agent), JSON.stringify({ ...cur, running: undefined, stalled: undefined, beatAgeMin: undefined, ending: undefined, status: 'ended', endedAt: new Date().toISOString(), reason, ...(stop ? { stoppedBy: stop.by } : {}) }, null, 2));
  fs.rmSync(stopFile(s.agent), { force: true });
  const mine = listLocks().filter((l) => l.owner === s.agent);
  const held = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
  for (const t of held) {
    const patch = saveWorkOf(s.agent, t, mine, cur);
    pauseTask(t, s.agent, `${s.agent}'s session ended without a hand-back (${what}${stop ? `; ${STOP_NOTE}` : ''}).${patch ? ` Uncommitted work saved to ${patch} (git apply it to continue).` : ' No uncommitted work.'} Check its commits (git log --grep ${t}) before redoing anything.`, { force: true });
  }
  for (const l of listLocks().filter((x) => x.owner === s.agent)) release(l.key, s.agent);
  if (cur.copy) removeLaneCopy(s.agent, { keepBranch: unmerged(cur.copy.branch) > 0, ifIdle: true });
  if (claimSessionEnd(s.agent, cur.startedAt || s.startedAt, by)) emitEvent({ type: 'agent.session.end', agent: s.agent, model: s.model, task: s.task || cur.task || held[0] || claimedSince(s.agent, s.startedAt) || undefined, status: stop ? 'ok' : 'error', msg: `${s.agent} ended: ${what}${held.length ? `; handed back ${held.join(', ')}` : ''}`, meta: { role: s.role, tool: s.tool, reason: v.kind, by, handed: held, stoppedBy: stop?.by || undefined, stopKind: stop?.kind || undefined } });
  jobDone({ kind: 'session', id: s.agent, agent: s.agent, task: s.task || null, result: stop ? 'stopped' : 'gone', ms: Date.parse(s.startedAt) ? Date.now() - Date.parse(s.startedAt) : null, tail: String(what || '').slice(0, 300), log: s.log || null, extra: { role: s.role || null, handed: held } });
  if (v.kind === 'reused' || v.kind === 'stale') {
    emitEvent({ type: 'agent.pid_reused', agent: by, status: 'warn', msg: `${s.agent}: ${v.why}; its session is marked ended${held.length ? ` and ${held.join(', ')} handed back` : ''}`, meta: { session: s.agent, pid: v.pid, target: v.target, verified: v.kind === 'reused', now: v.cmd || undefined } });
  }
  return true;
}

/**
 * Stop a launcher session (agent stop, pause, stop all, the stall and refresh checks). PU-17 (P-039, P-045): it takes
 * the session record, reads the target's start time from the OS once (`starts`: already read by the caller, as stop
 * all does for every session in one query) and kills only after killVerdict says the number is still the agent's,
 * or still its launcher's while it starts; otherwise the session is ended as dead and the other program is left
 * alone. A bare pid is looked up among the sessions; a number no session owns is never killed.
 */
export function stopAgent(target, { by = 'launcher', starts = null, record = null } = {}) {
  const s = target && typeof target === 'object' ? target : sessions().find((x) => x.status === 'running' && x.pid === Number(target));
  if (!s) return { killed: false, ended: false, why: `pid ${target} is not a launcher session: not killed` };
  const pid = Number(s.pid || s.supervisor) || null;
  const cur = pid && pidExists(pid) ? (starts || readStarts([pid])).get(pid) || null : null;
  const v = killVerdict(s, cur);
  // 2.58.3 (N1): agent stop, pause and stop all (record: 'stop' | 'pause' | 'stop-all') say who stopped it first, so
  // the launcher's clean-up (or endAsDead below) records a stop, not a crash. The stall and refresh checks don't.
  if (record) recordStop(s, by, record);
  // A launcher stopped while it starts leads its own process group (--detach), so its agent goes with it.
  const killed = v.kill ? killTree(v.pid, { group: v.target === 'launcher' && Boolean(s.starting) }) : false;
  const ended = v.end ? endAsDead(s, v, by) : false;
  return { killed, ended, kind: v.kind, target: v.target, why: v.why };
}

/**
 * Work in progress, for the heartbeat: uncommitted changes under the agent's path claims (or, with
 * no path claims, the files its task's commits touched), and when the last verify ran. Cheap: git only.
 */
export function wipSummary(agent) {
  const paths = listLocks().filter((l) => l.owner === agent && l.key.startsWith('path:')).map((l) => l.key.slice(5));
  const copy = readJson(sessionFile(agent))?.copy;
  const cwd = copy?.dir && fs.existsSync(path.join(REPO_ROOT, copy.dir)) ? path.join(REPO_ROOT, copy.dir) : REPO_ROOT;
  const r = spawnSync('git', ['diff', '--numstat', 'HEAD', '--', ...(paths.length && cwd === REPO_ROOT ? paths : ['.'])], { windowsHide: true, cwd, encoding: 'utf8' });
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
export function nextAgentName(role, prefix = '', { after = 0 } = {}) {
  const f = path.join(STUDIO_STATE_DIR, 'agent-names.json');
  const counters = readJson(f) || {};
  const key = `${role}-${prefix}`;
  const re = new RegExp(`^${role.replace(/[^a-z0-9-]/gi, '')}-${prefix}(\\d+)$`);
  const seen = sessions().map((x) => Number((String(x.agent).match(re) || [])[1]) || 0);
  let n = Math.max(Number(counters[key]) || 0, ...seen, Number(after) || 0, 0) + 1;
  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  // 2.78.0 (PU-63): never a name a leftover lane folder (.lanes/<name>) still holds, and never one another launch has just
  // taken: each name is reserved with an exclusive create (.studio/agent-names/<name>), so two launches in the same second
  // (two processes reading the same counter) get different names.
  const dirs = path.join(STUDIO_STATE_DIR, 'agent-names');
  fs.mkdirSync(dirs, { recursive: true });
  for (let tries = 0; tries < 1000; tries++, n++) {
    const name = `${role}-${prefix}${n}`;
    if (fs.existsSync(path.join(REPO_ROOT, '.lanes', name))) continue;
    try { fs.writeFileSync(path.join(dirs, name), `${new Date().toISOString()}\n`, { flag: 'wx' }); } catch (err) { if (err.code === 'EEXIST') continue; }
    break;
  }
  const cur = readJson(f) || {};
  fs.writeFileSync(f, `${JSON.stringify({ ...cur, [key]: Math.max(n, Number(cur[key]) || 0) }, null, 2)}\n`);
  return `${role}-${prefix}${n}`;
}

/**
 * 2.78.1 (e): why this name can't get a lane copy now ('' when it can): a leftover .lanes/<name> that is still in use
 * (harness/worktree.mjs laneLive: a process in it, a fresh claim, changed in the last STUDIO_LANE_LIVE_MIN minutes).
 */
export function laneNameClash(agent) {
  const dir = path.join(REPO_ROOT, '.lanes', String(agent || ''));
  if (!agent || !fs.existsSync(dir)) return '';
  let l = { live: false };
  try { l = laneLive(agent); } catch { l = { live: false }; }
  return l.live ? `the lane copy .lanes/${agent} of an earlier session named ${agent} is still in use (${l.why}).` : '';
}

/**
 * 2.78.1 (e): a fresh, unused name like `agent` for this role (nextAgentName's reservation, PU-63): builder-agyf9 →
 * builder-agyf10 (the same prefix), any other name → <role>-<n>.
 */
export function freshAgentName(role, agent) {
  const r = String(role || '').replace(/[^a-z0-9-]/gi, '');
  const m = String(agent || '').match(new RegExp(`^${r}-([a-z-]*?)(\\d+)$`, 'i'));
  return nextAgentName(r, m ? m[1] : '', { after: m ? Number(m[2]) : 0 });
}

/**
 * Save an agent's work on a task before its task is handed back: in its own copy (2.29) the uncommitted
 * files there, and its unmerged commits stay on its branch for the next agent; otherwise the files under
 * its claims in the shared checkout.
 */
export function saveWorkOf(agent, task, mine, s = readJson(sessionFile(agent))) {
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
    pauseTask(t, agent, `${note || `Paused from the War Room; ${agent}'s work so far is ${s.copy ? 'in its copy' : 'in the working tree'}.`}${patch ? ` Saved to ${patch}.` : ''} Paused by ${by} (${STOP_NOTE}).`, { force: true });
  }
  // A paused task doesn't restart straight away under a new name (STUDIO_STOP_COOLDOWN_MIN, default 15).
  for (const t of tasksOf(agent, s)) cooldown(t, by, undefined, s.role || null);
  stopAgent(s, { by, record: 'pause' });
  emitEvent({ type: 'agent.paused', agent, to: 'producer', msg: `${agent} paused${held.length ? `; ${held.join(', ')} back in the queue` : ''}${note ? `: ${note}` : ''}` });
  return { ok: true, handed: held };
}

/**
 * Stop one agent by name: its task can't restart for the cooldown; the launcher hands the work back. PU-17: a record
 * still marked running whose process is gone, or whose number another program has now, is ended here (work handed
 * back, claims freed) without killing anything, instead of "isn't running".
 */
export function stopAgentNamed(agent, by = 'war-room-human') {
  const s = sessions().find((x) => x.agent === agent && x.status === 'running');
  if (!s) return { ok: false, message: `${agent || '(no name)'} isn't running.` };
  const tasks = tasksOf(agent, s);
  const until = tasks.map((t) => cooldown(t, by, undefined, s.role || null)).filter(Boolean)[0] || null;
  const r = stopAgent(s, { by, record: 'stop' });
  emitEvent({ type: 'agent.stopped', agent: by, to: 'producer', msg: `${by} stopped ${agent}${r.killed ? '' : ` (nothing killed: ${r.why})`}${tasks.length ? `; ${tasks.join(', ')} can restart after ${until ? `${until.slice(11, 16)} UTC` : 'now'}` : ''}`, meta: { killed: r.killed, kind: r.kind, target: r.target } });
  return { ok: true, agent, tasks, until, killed: r.killed, ended: r.ended, kind: r.kind, target: r.target, why: r.why };
}

/** "Stop all": every running launcher session hands its task back with a note and ends. */
export function stopAllAgents(by = 'war-room-human', reason = '') {
  const stopped = [];
  const list = sessions().filter((x) => x.running);
  // PU-17: one OS query for every session's start time, not one per session.
  const live = list.map((s) => Number(s.pid || s.supervisor)).filter((p) => p && pidExists(p));
  const starts = live.length ? readStarts(live) : new Map();
  for (const s of list) {
    const mine = listLocks().filter((l) => l.owner === s.agent);
    const held = mine.filter((l) => l.key.startsWith('task:')).map((l) => l.key.slice(5));
    for (const t of held) {
      const patch = saveWorkOf(s.agent, t, mine, s);
      pauseTask(t, s.agent, `The studio was stopped by ${by}${reason ? ` (${reason})` : ''}; ${s.agent}'s work so far is ${s.copy ? 'in its copy' : 'in the working tree'}${patch ? ` and saved to ${patch}` : ''} (${STOP_NOTE}).`, { force: true });
    }
    stopAgent(s, { by, starts, record: 'stop-all' });
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
  const ps = spawnSync('ps', ['-eo', 'pid=,args='], { windowsHide: true, encoding: 'utf8' });
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
      const l = spawnSync('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn'], { windowsHide: true, encoding: 'utf8' });
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
/**
 * 2.77.0 (u, P5.1): the engine worktree of a launched engine pass ({ dir, branch, note }), or null. An error becomes the
 * prompt's note and an engine.lane event: the session still starts (its brief says what to fix), never a crash.
 */
function launchEngineLane({ task, agent, role = null }) {
  if (!task || /^(off|0|false|no)$/i.test(String(process.env.STUDIO_ENGINE_LANES || ''))) return null;
  try {
    const r = engineLaunch({ task, agent, role });
    if (!r) return null;
    // 2.78.1 (e, B-119): no worktree means no code access: the launch is refused (runAgent), it never runs blind.
    if (r.error) { emitEvent({ type: 'engine.lane', agent, task, status: 'warn', msg: `${agent}: no engine worktree for ${task}: ${r.error}`.slice(0, 400) }); return { note: `Your task is an engine pass, but its worktree couldn't be made: ${r.error}. Fix that first, or hand it back with a note.`, refuse: r.error }; }
    emitEvent({ type: 'engine.lane', agent, task, msg: `${agent}: ${task} works in ${r.dir.split(path.sep).join('/')} on ${r.branch}${r.created ? ' (new)' : ''}`.slice(0, 400), meta: { dir: r.dir, branch: r.branch, repo: r.repo } });
    return r;
  } catch (e) { return { note: `Your task is an engine pass, but its worktree couldn't be made (${e.message}).` }; }
}

export function startAgent(opts, { detach = false } = {}) {
  const { role } = opts;
  const agent = opts.agent || (role ? nextAgentName(role) : null);
  opts = { ...opts, agent };
  if (!role || !agent) return { ok: false, message: 'Usage: npm run agent -- start --role <role> --agent <unique-name> --tool <tool> --model <model>' };
  // 2.54.0: the detached supervisor clears the placeholder its launcher wrote for it, so its own record
  // doesn't count against its caps; it writes the real record when the agent starts.
  // PU-17: the placeholder holds this launcher's spawn time (written by its parent); its real record keeps it.
  try { const p = readJson(sessionFile(agent)); if (p?.starting && p.supervisor === process.pid) { if (p.identity?.supervisor?.start) LAUNCHER_ID = p.identity.supervisor; fs.rmSync(sessionFile(agent), { force: true }); } } catch {}
  if (readStop()) return { ok: false, message: 'The studio is stopped; resume it first (npm run task -- resume --by <name>).' };
  // 2.54.0: the placeholder a detached launch writes (below) is this very supervisor, not a second session.
  const already = sessions().find((s) => s.agent === agent && s.running && !(s.starting && s.supervisor === process.pid));
  if (already) return { ok: false, message: `${agent} is already running (pid ${already.pid}).` };
  // Never two sessions on one task (test #2: T-160 and T-171 each started twice within seconds).
  if (opts.task) {
    const busy = sessions().find((s) => s.running && s.task === opts.task);
    const held = listLocks().find((l) => l.key === `task:${opts.task}` && l.owner !== agent);
    if (busy) return { ok: false, message: `Not started: ${busy.agent} is already on ${opts.task}.` };
    if (held) return { ok: false, message: `Not started: ${held.owner} holds ${opts.task}.` };
  }
  // 2.78.1 (e): `agent stop` then a start with the same name: the stopped session's lane copy is still in use (its clean-up
  // runs on, or it changed minutes ago), and the launch would be refused once the copy is wanted. Say which fresh name to
  // use, or with --auto-name (STUDIO_AUTO_NAME=on) start under it.
  {
    // Only when this session gets a lane copy (a code lane, or a worker with none: worktree.mjs lanelessWantsCopy).
    const wantsCopy = (opts.lane ? laneWantsCopy(opts.lane) : lanelessWantsCopy({ role, lane: null, task: opts.task })) && !process.env.STUDIO_MAIN_ROOT && process.env.STUDIO_REHEARSAL !== '1';
    const clash = wantsCopy ? laneNameClash(agent) : '';
    if (clash) {
      const auto = Boolean(opts.autoName) || /^(on|1|true|yes)$/i.test(process.env.STUDIO_AUTO_NAME || '');
      const fresh = freshAgentName(role, agent);
      if (!auto) return { ok: false, message: `Not started: ${clash} Start it under a fresh name: --agent ${fresh} (or add --auto-name to use one automatically).`, suggest: fresh };
      emitEvent({ type: 'agent.renamed', agent: fresh, task: opts.task || undefined, msg: `${agent} → ${fresh}: ${clash}`.slice(0, 400), meta: { was: agent } });
      opts = { ...opts, agent: fresh };
      return startAgent(opts, { detach });
    }
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
      if (mm.join(':')) opts = { ...opts, orderModel: true };
    }
  }
  // 2.76.0 (B-80): agy with no --model ran agy's own default (a Claude model), not Gemini. A role's model setting is for
  // its Claude sessions, so agy takes STUDIO_TOOL_AGY_MODEL, else the Gemini default (AGY_DEFAULT_MODEL).
  if (tool === 'agy' && !opts.model && !opts.orderModel) model = String(process.env.STUDIO_TOOL_AGY_MODEL || '').trim() || AGY_DEFAULT_MODEL;
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
  // 2.73.0 (e): cheap-first routing (harness/routing.mjs, studio/policy.json "routing"): a listed task type/track starts
  // on the cheapest tier the policy lists and goes one tier up per red round; only models the policy lists, picked at
  // session start (never mid-task). A routed task skips the tier-up and reroute below (they could pick unlisted models).
  let routed = null;
  if (opts.task && !opts.model) {
    try {
      const q = parseNextQueue();
      const t = [...q.inProgress, ...q.backlog].find((x) => x.id === opts.task);
      if (t) {
        const evs = readRecentEvents(20000);
        const track = evs.filter((e) => e.type === 'task.added' && e.task === t.id).pop()?.meta?.track || '';
        const r = launchRoute({ id: t.id, type: taskType(t), track, role: t.role || role }, { events: evs });
        if (r && r.arm !== 'none') {
          routed = r;
          if (r.model) model = r.model;
          emitEvent({ type: 'model.routed', agent: opts.by || 'launcher', task: t.id, msg: `${t.id} (${r.matched}): ${r.arm === 'holdout' ? `holdout: starts on the default model ${model}` : `starts on ${r.model} (${r.tier} tier)`}: ${r.why}`.slice(0, 400), meta: { ...r, model: r.model || model } });
        }
      }
    } catch { /* routing is a preference, never a blocker */ }
  }
  // 2.30d (plan #3): a task that came back without being done starts one model tier up.
  if (opts.task && !opts.model && !routed) {
    const esc = escalationFor(opts.task);
    if (esc && esc.tier !== esc.from) {
      if (esc.applied) model = esc.model;
      emitEvent({ type: esc.applied ? 'model.escalated' : 'model.escalation_suggested', agent: opts.by || 'producer', task: opts.task, msg: `${opts.task} was handed back ${esc.failed} time${esc.failed === 1 ? '' : 's'} without being done: ${esc.applied ? `starting on ${esc.model}` : `suggest a ${esc.tier}-tier model (set STUDIO_TIER_${esc.tier.toUpperCase()}_MODEL)`} instead of ${esc.fromModel || 'the last model'} (${esc.from})`, meta: esc });
    }
  }
  // 2.30h (3): the last hand-off was reasoning only: the Director's reroute moves the task to another family.
  if (opts.task && !opts.model && !routed) {
    const rr = rerouteFor(opts.task, readRecentEvents(5000));
    if (rr) {
      if (rr.applied) {
        model = rr.model;
        if (rr.tool && !opts.tool) tool = rr.tool;
      }
      emitEvent({ type: rr.applied ? 'model.rerouted' : 'model.reroute_suggested', agent: 'director', to: 'producer', task: opts.task, msg: `${opts.task}: ${rr.fromModel} (${rr.fromFamily}) replied with reasoning only; ${rr.applied ? `rerouted to ${rr.model}${rr.tool ? ` on ${rr.tool}` : ''}` : 'route it to another model family (set STUDIO_REROUTE_MODELS, e.g. codex:gpt-5)'}`, meta: rr });
    }
  }
  // 2.77.0 (n, Priority 8): an agy session runs a Gemini model. An explicit non-Gemini --model is refused unless forced
  // (--force-model, STUDIO_AGY_ANY_MODEL=on, or an agy:<model> entry the owner put in the budget order); a model the
  // rescue, routing, tier-up or reroute picked for an agy session that isn't Gemini gives way to the Gemini default.
  if (tool === 'agy' && !isGeminiModel(model)) {
    const forced = Boolean(opts.forceModel) || agyAnyModel() || Boolean(opts.orderModel);
    if (!forced && opts.model) return { ok: false, refused: 'agy-model', message: `Not started: agy runs Gemini models in this studio, and "${model}" isn't one (agy with a non-Gemini model, or none, ran Claude Sonnet inside agy). Use --model gemini-… (agy models lists them; the default is ${String(process.env.STUDIO_TOOL_AGY_MODEL || '').trim() || AGY_DEFAULT_MODEL}), --tool claude for a Claude model, or --force-model to run it on agy anyway.` };
    if (!forced) {
      const g = isGeminiModel(process.env.STUDIO_TOOL_AGY_MODEL) ? String(process.env.STUDIO_TOOL_AGY_MODEL).trim() : AGY_DEFAULT_MODEL;
      emitEvent({ type: 'model.kept_gemini', agent: opts.by || 'launcher', task: opts.task || undefined, msg: `${agent} (agy): ${model} isn't a Gemini model, so it starts on ${g}`, meta: { tool, from: model, model: g } });
      model = g;
    }
  }
  // H-1 (2.58.5): a nim session never inherits the role's (or a rescue's, escalation's, reroute's) non-NIM model.
  if (tool === 'nim') model = nimModel(model);
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
    const args = [fileURLToPath(import.meta.url), 'start', '--attach', '--role', role, '--agent', agent, '--tool', tool, '--model', model, ...(opts.fallback?.length ? ['--fallback', opts.fallback.join(',')] : []), ...(opts.task ? ['--task', opts.task] : []), ...(opts.lane ? ['--lane', opts.lane] : []), ...(opts.oneTask ? ['--one-task'] : []), ...(opts.extra ? ['--extra', String(opts.extra)] : []), ...(opts.division ? ['--division', opts.division] : []), ...(opts.note ? ['--note', String(opts.note)] : []), ...(opts.by ? ['--by', opts.by] : []), ...(opts.loop ? ['--loop', String(opts.loop)] : []), ...(opts.approved ? ['--approved'] : []), ...(opts.forceModel || (tool === 'agy' && !isGeminiModel(model)) ? ['--force-model'] : [])];
    // 2.77.0 (n, B-92): the launcher is not the pinned session that may have started it (its agent gets its own pin).
    const sup = spawn(process.execPath, args, { windowsHide: true, cwd: REPO_ROOT, detached: true, stdio: 'ignore', env: { ...process.env, STUDIO_TASK_PIN: '' } });
    sup.unref();
    // PU-17: the launcher's spawn time (in-process, no OS query), for a stop that comes while it is still starting.
    const supId = spawnedIdentity(sup.pid, process.execPath);
    // 2.54.0 (P-024): register the session at once. The supervisor writes the real record a moment later, and
    // until then another wake-up in the same pass (a Director ping, the dev cycle, the queue refill) would not
    // see it and start a second Director or Producer, even under the same name.
    try {
      if (!fs.existsSync(sessionFile(agent)) || !sessions().some((x) => x.agent === agent && x.running)) {
        fs.mkdirSync(AGENTS_DIR, { recursive: true });
        fs.writeFileSync(sessionFile(agent), JSON.stringify({ agent, role, tool, model, task: opts.task || null, lane: opts.lane || null, status: 'running', starting: true, supervisor: sup.pid, ...(supId ? { identity: { supervisor: supId } } : {}), startedAt: new Date().toISOString() }, null, 2));
      }
    } catch {}
    return { ok: true, detached: true, agent, role, tool, model, supervisor: sup.pid };
  }
  return { ok: true, agent, tool, model, run: runAgent({ ...opts, tool, model }) };
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
    // 2.55.0 (P-032): with no pace chosen nothing starts on its own, the Director included (2.30j let it start
    // builders here; in the first Hatchfield crew run that kept starting Opus sessions nobody asked for). A note
    // goes to the dev once an hour instead.
    if (!mode.chosen) {
      const msg = 'No pace is chosen, so the studio starts no agents on its own: npm run mode -- set <pace> --by <name> (precise, budget, fast, prototype or extreme), or start agents by hand';
      const last = readRecentEvents(2000).filter((e) => e.type === 'pace.unchosen').pop();
      if (!last || Date.now() - Date.parse(last.ts) > 3600000) emitEvent({ type: 'pace.unchosen', agent: 'watch', to: 'human', status: 'warn', msg });
      return { started: [], why: 'no pace chosen yet: nothing starts on its own' };
    }
    return { started: [], why: `${mode.label} doesn't start agents on its own` };
  }
  // 2.58.0 (crew report): starting agents from the watcher, the HUB's loops and the Director's flow is opt-in, one
  // switch off by default (npm run mode -- autostart on --by <name>); away mode and MAX SPEED don't override it.
  if (!mode.autostart) return { started: [], autostartOff: true, why: AUTOSTART_OFF };
  if (readStop()) return { started: [], why: 'the studio is stopped' };
  const { readStatus, supervise } = await import('./supervisor.mjs');
  const sup = readStatus();
  if (sup?.status === 'running' && pidAlive(sup.pid, sup.identity)) return { started: [], why: `the supervisor (pid ${sup.pid}) starts agents` };
  const r = await supervise({ watcher: true, prefix: 'auto-', deps: { sessions, startAgent, launchableRoles, nextAgentName } }, { startedAt: Date.now(), names: [] });
  if (r.started.length) {
    const msg = byDirector && !mode.chosen ? `Started ${r.started.join(', ')} (away mode or auto-launch, no pace chosen)` : `Started ${r.started.join(', ')} (${mode.label}${mode.boost ? ' + MAX SPEED' : ''})`;
    emitEvent({ type: 'agent.auto_start', agent: 'watch', to: 'producer', msg });
  }
  return { started: r.started, why: r.why.join('; ') };
}

/**
 * A person did something in the War Room that an agent should act on now (a pitch, a message, a
 * confirmed brief, a design to change). Start that role's agent if none is running and the caps
 * allow it, even in paces that don't start agents on their own: a person asked. Returns `next`,
 * one plain sentence saying what happens now.
 * 2.58.0: `auto: true` is a wake-up nobody asked for (the HUB's game-dev loop, the queue refill, the development
 * cycle): it starts nothing while auto-start is off (npm run mode -- autostart on --by <name>).
 */
export function wake(role, { task = null, why = '', auto = false } = {}) {
  const label = { rnd: 'R&D', producer: 'the Producer', director: 'the Director', art: 'the art department', builder: 'a builder', liaison: 'the Liaison' }[role] || role;
  const busy = sessions().find((s) => s.role === role && s.running);
  if (busy) return { started: false, next: `${label} (${busy.agent}) is running and picks ${task || 'it'} up from the queue${busy.task ? ` after ${busy.task}` : ''}.` };
  if (auto && !effectiveMode().autostart) return { started: false, autostartOff: true, next: `${task ? `Queued as ${task} for ${label}. ` : ''}${label} wasn't started: ${AUTOSTART_OFF}.` };
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
    // 2.79 (f): `--pool api` starts one builder of STUDIO_API_POOL (billed to its mapped API key) by hand (harness/api-pool.mjs).
    let poolAgent = null;
    if (flag('pool')) {
      if (String(flag('pool')).toLowerCase() !== 'api') { console.error('--pool takes "api" (the builders named in STUDIO_API_POOL)'); process.exit(1); }
      const pm = (await import('./api-pool.mjs')).pickManual({ live: sessions() });
      if (!pm.name) { console.error(`No API-pool builder to start: ${pm.why}`); process.exit(1); }
      poolAgent = pm.name;
    }
    const base = { autoName: argv.includes('--auto-name'), role: poolAgent ? 'builder' : flag('role'), agent: poolAgent || flag('agent'), tool: flag('tool'), model: flag('model'), fallback: (flag('fallback') || '').split(',').filter(Boolean), task: flag('task'), next: argv.includes('--next'), lane: flag('lane'), oneTask: argv.includes('--one-task') || Boolean(flag('loop')), extra: Number(flag('extra')) || 0, division, note: flag('note') || '', by: flag('by') || (cmd === 'hire' ? process.env.STUDIO_LOCK_OWNER || null : null), loop: flag('loop'), approved: argv.includes('--approved'), forceModel: argv.includes('--force-model') };
    // A hire runs in the background unless --foreground: tied to the hiring shell, it died with it and its
    // record stayed "running" with its claims held (test #3, engine-porter-1).
    // 2.79 (d): `start` runs in the background too: tied to the starter's shell, a builder died when the command that
    // started it returned (builder-api2 after 12 min, builder-api3 after 1). --attach (or --foreground, for
    // a script or a test that wants the session in this process) keeps it here.
    const attach = argv.includes('--attach') || argv.includes('--foreground');
    const r = startAgent(base, { detach: argv.includes('--detach') || !attach });
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
    // P-067 (crew P-037): agy takes its allowed commands from its own settings file, not the command line; say so
    // (one line, and an event at most hourly for launches nobody watches) when the harness list isn't there. Never blocks.
    if (r.tool === 'agy') { const h = agyAllowHint(); if (h) { console.log(h); noteAgyHint(h, { agent: r.agent }); } }
    if (r.detached) {
      console.log(`${r.agent} started in the background (${r.tool}, ${r.model}), pid ${r.supervisor}. Output: .studio/agents/${r.agent}.log. npm run agent -- list (--attach keeps it in this shell)`);
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
    const after = r.tasks.length ? ` ${r.tasks.join(', ')} won't restart before ${r.until ? r.until.slice(11, 16) : 'now'} (STUDIO_STOP_COOLDOWN_MIN).` : '';
    if (r.killed && r.target === 'launcher') console.log(`Stopping ${r.agent}: it was still starting, so its launcher was stopped${r.ended ? ' and its work handed back' : ''}.${after}`);
    else if (r.killed) console.log(`Stopping ${r.agent}; ${r.ended ? 'its launcher was gone, so its work was handed back here' : 'the launcher hands its work back'}.${after}`);
    else if (r.ended) console.log(`${r.agent} wasn't running any more: ${r.why}. Its session is marked ended, its work handed back and its claims freed.${after}`);
    else console.log(`${r.agent}: ${r.why}; its launcher is still running and hands its work back.${after}`);
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
  if (cmd === 'allow') process.exit(allowCli(argv.slice(1))); // P-067: the owner enrols agy's allow-rules (harness/agy-allow.mjs)
  const list = sessions();
  if (!list.length) console.log('No agents started by the launcher yet. npm run agent -- start --role builder --agent builder-1 --tool claude --model claude-sonnet-5-5');
  for (const s of list) console.log(`${s.running ? (s.ending ? 'ending ' : s.stalled ? 'STALLED' : 'running') : 'ended  '}  ${s.agent.padEnd(18)} ${String(s.role).padEnd(14)} ${s.tool}/${s.model}${s.task ? `  ${s.task}` : ''}${s.running ? `  heartbeat ${s.beatAgeMin} min ago${s.ending ? ` (${s.ending.why})` : ''}` : `  ${s.reason || ''}`}${s.running && s.copy ? `  own copy ${s.copy.dir} (${s.copy.branch})` : ''}`);
  const others = otherAgents();
  for (const o of others.list) console.log(`outside  pid ${String(o.pid).padEnd(12)} not started by the launcher: ${o.command}`);
  if (others.list.length) console.log('  Agents outside the launcher keep no heartbeat and don\'t see Stop all until they next run a harness command. Prefer npm run agent -- hire.');
  const mode = effectiveMode();
  console.log(`\nMode: ${mode.label}${mode.boost ? ' + MAX SPEED' : ''}, up to ${mode.maxAgents} agents. Roles that can start on their own: ${launchableRoles().join(', ') || 'none (set STUDIO_AGENT_TOOL or STUDIO_<ROLE>_TOOL in .env)'}.`);
  console.log(mode.autostart ? 'Auto-start is on: the watcher and the HUB may start agents on their own (npm run mode -- autostart off --by <name>).' : `Auto-start is off: ${AUTOSTART_OFF.replace(/^auto-start is off, so /, '')}.`);
}
