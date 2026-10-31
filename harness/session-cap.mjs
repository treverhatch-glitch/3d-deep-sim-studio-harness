#!/usr/bin/env node
/**
 * harness/session-cap.mjs — refresh context by default (2.29.2).
 *
 *   npm run session                                     every running session: turns, context, refresh state
 *   npm run session -- exception "<live repro>"          mid-debug: keep going past the refresh point (flagged)
 *   npm run session -- check <agent> continue|handoff --by <director or producer> [--note "…"]
 *
 * The studio's files are the memory, not the chat. A launched session refreshes at the task boundary
 * (one task per session) or when it passes the refresh point, ~120k tokens of context or 40 turns,
 * whichever comes first: it writes its hand-back (done / failed / next / standing rules, under 3k
 * characters), commits, and ends; a fresh session continues the same task from the hand-back.
 *
 * Exception: mid-debug with a live repro, an agent may go on to the ceiling. Using it flags the agent,
 * and the Director or Producer checks on it at every 20 turns / 40k tokens past the refresh point
 * (continue, or hand off now), so it never runs unchecked. A session past the refresh point without the
 * exception gets the same check. Nothing here waits: checks are cards, the agent keeps working.
 *
 * Limits (environment, 0 turns one off): STUDIO_SESSION_TURNS (40), STUDIO_SESSION_CONTEXT (120000),
 * STUDIO_SESSION_CEILING_TURNS (80, passed to Claude Code as --max-turns), STUDIO_CHECK_TURNS (20),
 * STUDIO_CHECK_TOKENS (40000). Counts are the tool's own (Claude Code stream-json usage), named with
 * the model, since every model family counts tokens differently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

export const REFRESH_DIR = path.join(STUDIO_STATE_DIR, 'refresh');
const AGENTS_DIR = path.join(STUDIO_STATE_DIR, 'agents');
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number.isFinite(Number(v)) ? Number(v) : d);

/** The limits in force. */
export function sessionLimits(env = process.env) {
  return {
    turns: num(env.STUDIO_SESSION_TURNS, 40),
    context: num(env.STUDIO_SESSION_CONTEXT, 120000),
    ceilingTurns: num(env.STUDIO_SESSION_CEILING_TURNS, 80),
    checkTurns: num(env.STUDIO_CHECK_TURNS, 20),
    checkTokens: num(env.STUDIO_CHECK_TOKENS, 40000),
  };
}

/**
 * Turns and current context from a Claude Code stream-json log (or any log with per-message usage):
 * a turn is an assistant message (by id), the context is the last one's input + cache reads + cache writes.
 */
export function sessionProgress(log) {
  const ids = new Set();
  let turns = 0;
  let context = 0;
  let resultTurns = null;
  for (const l of String(log || '').split(/\r?\n/)) {
    const s = l.trim();
    if (!s.startsWith('{')) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === 'assistant' && o.message) {
      const id = o.message.id || `${turns}`;
      if (!ids.has(id)) {
        ids.add(id);
        turns += 1;
      }
      const u = o.message.usage;
      if (u) context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } else if (o.type === 'result' && o.num_turns != null) resultTurns = Number(o.num_turns);
  }
  return { turns: resultTurns ?? turns, context };
}

const flagFile = (agent) => path.join(REFRESH_DIR, `${agent}.json`);
export function readFlag(agent) {
  try {
    return JSON.parse(fs.readFileSync(flagFile(agent), 'utf8'));
  } catch {
    return null;
  }
}
function writeFlag(agent, f) {
  fs.mkdirSync(REFRESH_DIR, { recursive: true });
  fs.writeFileSync(flagFile(agent), `${JSON.stringify(f, null, 2)}\n`);
  return f;
}
/** A new session starts with no refresh record (its name may be reused). */
export function clearFlag(agent) {
  try {
    fs.rmSync(flagFile(agent), { force: true });
  } catch {}
}

/**
 * Where a session stands: ok (under the refresh point), due (past it: hand off at the next breakpoint),
 * exception (flagged mid-debug), and whether a Director/Producer check is owed (one per 20 turns / 40k
 * tokens past the refresh point).
 */
export function refreshState({ turns = 0, context = 0 }, flag = null, lim = sessionLimits()) {
  const overTurns = lim.turns > 0 && turns >= lim.turns;
  const overContext = lim.context > 0 && context >= lim.context;
  const past = overTurns || overContext;
  const exception = Boolean(flag?.exception);
  const state = !past ? 'ok' : exception ? 'exception' : 'due';
  // Checks owed: steps of checkTurns past the turn limit or checkTokens past the context limit.
  const stepT = lim.checkTurns > 0 && overTurns ? Math.floor((turns - lim.turns) / lim.checkTurns) + 1 : 0;
  const stepK = lim.checkTokens > 0 && overContext ? Math.floor((context - lim.context) / lim.checkTokens) + 1 : 0;
  const owed = Math.max(stepT, stepK);
  // The first check for a flagged agent is at the refresh point itself; for an unflagged one, one step past it.
  const checksOwed = exception ? owed : Math.max(0, owed - 1);
  // A check covers every check point passed up to then; the next is owed at the next point.
  const covered = Math.max(0, ...(flag?.checks || []).map((c) => Number(c.covers) || 1));
  return { state, past, overTurns, overContext, checksOwed, checkDue: checksOwed > covered, nextCheck: { turns: lim.turns + covered * lim.checkTurns, context: lim.context + covered * lim.checkTokens } };
}

/** An agent says it is mid-debug with a live repro: it may continue past the refresh point, flagged. */
export function flagException(agent, why, at = new Date().toISOString()) {
  const w = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!agent) return { ok: false, message: 'Run it as the agent (STUDIO_LOCK_OWNER set by the launcher).' };
  if (!w) return { ok: false, message: 'Say what the live repro is: npm run session -- exception "<repro: seed, tick, command>"' };
  const f = writeFlag(agent, { ...(readFlag(agent) || {}), agent, exception: { why: w, at }, checks: readFlag(agent)?.checks || [] });
  emitEvent({ type: 'agent.refresh.exception', agent, to: 'producer', msg: `${agent} is mid-debug past the refresh point (flagged; the Director or Producer checks at every 20 turns / 40k tokens): ${w}` });
  return { ok: true, flag: f };
}

/** The Director or Producer's check: let it continue, or have it hand off now. */
export function recordCheck(agent, decision, { by, note = '' } = {}) {
  if (!['continue', 'handoff'].includes(decision)) return { ok: false, message: 'check <agent> continue|handoff --by <name>' };
  if (!by) return { ok: false, message: 'Say who checked: --by <director or producer name>.' };
  const f = readFlag(agent) || { agent, checks: [] };
  const owed = refreshState(f.last || {}, f).checksOwed;
  f.checks = [...(f.checks || []), { by, decision, covers: Math.max(1, owed), note: String(note).slice(0, 300), at: new Date().toISOString(), turns: f.last?.turns ?? null, context: f.last?.context ?? null, model: f.last?.model ?? null }];
  if (decision === 'handoff') f.handoffAsked = f.checks[f.checks.length - 1].at;
  writeFlag(agent, f);
  emitEvent({ type: 'agent.refresh.check', agent: by, to: agent, msg: `${by} checked ${agent}: ${decision === 'continue' ? 'continue' : 'hand off now'}${note ? ` (${note})` : ''}` });
  return { ok: true, flag: f };
}

/**
 * Called from the launcher's heartbeat: read the session's log, record where it stands, and raise one
 * card per owed check (to the Producer, copied to the Director). Never stops anything by itself.
 */
export function heartbeatCheck(agent, { log, model = 'unknown', task = null, lim = sessionLimits() } = {}) {
  const p = sessionProgress(log);
  const f = readFlag(agent) || { agent, checks: [] };
  const st = refreshState(p, f, lim);
  const prev = f.last?.state;
  f.last = { ...p, model, state: st.state, at: new Date().toISOString(), task };
  if (st.state === 'due' && prev !== 'due') emitEvent({ type: 'agent.refresh.due', agent, task, msg: `${agent} passed the refresh point (${p.turns} turns, ${p.context.toLocaleString()} tokens of context, ${model}): hand off at the next breakpoint` });
  if (st.checkDue && f.cardFor !== st.checksOwed) {
    f.cardFor = st.checksOwed;
    f.cardAt = new Date().toISOString();
    emitEvent({ type: 'agent.ask', agent: 'launcher', to: 'producer', task, msg: `Check ${agent}${st.state === 'exception' ? ' (mid-debug exception)' : ''}: ${p.turns} turns, ${p.context.toLocaleString()} tokens of context (${model}). Continue or hand off: npm run session -- check ${agent} continue|handoff --by <you>`, meta: { refreshCheck: true, director: true } });
  }
  writeFlag(agent, f);
  return { ...p, ...st };
}

/**
 * "Hand off now": mark why, then end the session. The launcher treats it as a refresh (no failover,
 * no cooldown): it hands the task back with the work saved and starts a fresh session on it at once.
 */
export async function endForRefresh(agent, by) {
  const { sessions, stopAgent } = await import('./agent.mjs');
  const s = sessions().find((x) => x.agent === agent && x.running);
  if (!s) return { ok: false, message: `${agent} isn't running.` };
  const f = readFlag(agent) || { agent, checks: [] };
  writeFlag(agent, { ...f, endedBy: `handed off at a refresh check by ${by || 'the Producer'}` });
  stopAgent(s, { by: by || 'producer' }); // 2.57.0 (PU-17): the record, so the kill checks the process is still the agent
  return { ok: true };
}

/** Every launched session's refresh record, for the War Room. */
export function refreshBoard() {
  if (!fs.existsSync(REFRESH_DIR)) return [];
  const lim = sessionLimits();
  return fs.readdirSync(REFRESH_DIR).filter((f) => f.endsWith('.json')).map((f) => {
    const r = readFlag(f.slice(0, -5));
    if (!r) return null;
    let running = false;
    try {
      running = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')).status === 'running';
    } catch {}
    const st = refreshState(r.last || {}, r, lim);
    return { agent: r.agent || f.slice(0, -5), running, turns: r.last?.turns ?? 0, context: r.last?.context ?? 0, model: r.last?.model || 'unknown', task: r.last?.task || null, state: st.state, checkDue: st.checkDue, exception: r.exception || null, checks: r.checks || [], handoffAsked: r.handoffAsked || null, endedBy: r.endedBy || null };
  }).filter(Boolean);
}

/** The template a refreshing agent writes into its hand-back (task pause --note), kept under 3k characters. */
export const HANDOFF_TEMPLATE = 'Done: … | Failed/tried: … | Next step: … | Standing rules: … | Files: …';
export const HANDOFF_MAX = 3000;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const words = argv.slice(1).filter((x, i, a) => !x.startsWith('--') && !(i > 0 && a[i - 1].startsWith('--')));
  if (argv[0] === 'exception') {
    const r = flagException(process.env.STUDIO_LOCK_OWNER || flag('agent'), words.join(' '));
    console[r.ok ? 'log' : 'error'](r.ok ? 'Flagged: continue debugging. The Director or Producer checks on you at every 20 turns / 40k tokens past the refresh point.' : r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[0] === 'check') {
    const r = recordCheck(argv[1], argv[2], { by: flag('by') || process.env.STUDIO_LOCK_OWNER, note: flag('note') || '' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    if (argv[2] === 'handoff') {
      const p = await endForRefresh(argv[1], flag('by'));
      console.log(p.ok ? `${argv[1]} hands off now; a fresh session continues the task.` : `Recorded. ${p.message}`);
    } else console.log(`Recorded: ${argv[1]} continues. Next check in 20 turns / 40k tokens.`);
    process.exit(0);
  }
  const lim = sessionLimits();
  const rows = refreshBoard();
  console.log(`Refresh point: ${lim.turns} turns or ${lim.context.toLocaleString()} tokens of context; ceiling ${lim.ceilingTurns} turns; checks every ${lim.checkTurns} turns / ${lim.checkTokens.toLocaleString()} tokens past it.`);
  if (!rows.length) console.log('No launched session has reported yet.');
  for (const r of rows) console.log(`${r.running ? 'running' : 'ended  '}  ${r.agent.padEnd(18)} ${String(r.turns).padStart(3)} turns  ${r.context.toLocaleString().padStart(9)} tokens (${r.model})  ${r.state}${r.exception ? ' [mid-debug]' : ''}${r.checkDue ? '  CHECK DUE' : ''}`);
}
