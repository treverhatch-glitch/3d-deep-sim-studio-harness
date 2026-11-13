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
 * Limits (environment, 0 turns one off): STUDIO_SESSION_TURNS (40), STUDIO_SESSION_CONTEXT (120000; 2.78.1: per role
 * STUDIO_SESSION_CONTEXT_<ROLE>, STUDIO_SESSION_CONTEXT_EARLY 70000 for STUDIO_SESSION_EARLY_ROLES reviewer,engine-porter,
 * and a model factor STUDIO_SESSION_CONTEXT_FACTOR_<WORD>: contextPoint),
 * STUDIO_SESSION_CEILING_TURNS (80, passed to Claude Code as --max-turns), STUDIO_CHECK_TURNS (20),
 * STUDIO_CHECK_TOKENS (40000). Counts are the tool's own (Claude Code stream-json usage), named with
 * the model, since every model family counts tokens differently.
 *
 * 2.85: the check decides by rule (STUDIO_REFRESH_DECIDE=rule, the default): hand off when the context is at or over
 * STUDIO_REFRESH_HANDOFF_PCT (60) percent of the model's context window (harness/model-limits.mjs; unknown: twice the
 * refresh point), or when the session has made no commit and no verify for STUDIO_REFRESH_IDLE_TURNS (40) turns; else
 * continue. Recorded as a check by "rule" (agent.refresh.decided), no ask. A session flagged mid-debug asked for a person's
 * check, so it still gets the card. STUDIO_REFRESH_DECIDE=ask: every check is a card, as before. A person's
 * `session -- check` still decides at any time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { verifyCause } from './handback-facts.mjs';
import { limitsFor } from './model-limits.mjs';

export const REFRESH_DIR = path.join(STUDIO_STATE_DIR, 'refresh');
const AGENTS_DIR = path.join(STUDIO_STATE_DIR, 'agents');
const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number.isFinite(Number(v)) ? Number(v) : d);

/** 2.78.1 (e): roles that re-read big diffs or engine logs and drift: they refresh earlier by default. */
export const EARLY_REFRESH_ROLES = 'reviewer,engine-porter';
const envKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * The context refresh point for a role and model (2.78.1, e). In order: STUDIO_SESSION_CONTEXT_<ROLE> (e.g.
 * STUDIO_SESSION_CONTEXT_REVIEWER=60000); else, for a role in STUDIO_SESSION_EARLY_ROLES (reviewer,engine-porter),
 * STUDIO_SESSION_CONTEXT_EARLY (70000); else STUDIO_SESSION_CONTEXT (120000). Then a model factor: the first
 * STUDIO_SESSION_CONTEXT_FACTOR_<WORD> whose word is in the model's name (STUDIO_SESSION_CONTEXT_FACTOR_SONNET=0.8 moves
 * a Sonnet session's point to 80 %); none set: 1. 0 anywhere turns the context refresh off for that role.
 * Returns { context, from }.
 */
export function contextPoint(env = process.env, { role = null, model = null } = {}) {
  const base = num(env.STUDIO_SESSION_CONTEXT, 120000);
  const rk = envKey(role);
  const early = String(env.STUDIO_SESSION_EARLY_ROLES || EARLY_REFRESH_ROLES).toLowerCase().split(/[,\s]+/).filter(Boolean);
  let context = base;
  let from = 'STUDIO_SESSION_CONTEXT';
  if (rk && env[`STUDIO_SESSION_CONTEXT_${rk}`] !== undefined && env[`STUDIO_SESSION_CONTEXT_${rk}`] !== '' && Number.isFinite(Number(env[`STUDIO_SESSION_CONTEXT_${rk}`]))) {
    context = Number(env[`STUDIO_SESSION_CONTEXT_${rk}`]);
    from = `STUDIO_SESSION_CONTEXT_${rk}`;
  } else if (role && early.includes(String(role).toLowerCase())) {
    context = num(env.STUDIO_SESSION_CONTEXT_EARLY, 70000);
    from = 'STUDIO_SESSION_CONTEXT_EARLY';
  }
  const m = String(model || '').toLowerCase();
  if (m && context > 0) {
    const f = Object.keys(env).filter((k) => k.startsWith('STUDIO_SESSION_CONTEXT_FACTOR_')).sort()
      .find((k) => { const w = k.slice('STUDIO_SESSION_CONTEXT_FACTOR_'.length).toLowerCase().replace(/_/g, '-'); return w && m.includes(w); });
    const v = f ? Number(env[f]) : NaN;
    if (f && Number.isFinite(v) && v > 0) { context = Math.round(context * v); from += ` × ${f}`; }
  }
  return { context, from };
}

/** The limits in force; with a role (and model), its own context refresh point (contextPoint). */
export function sessionLimits(env = process.env, { role = null, model = null } = {}) {
  const cp = contextPoint(env, { role, model });
  return {
    turns: num(env.STUDIO_SESSION_TURNS, 40),
    context: cp.context,
    contextFrom: cp.from,
    ceilingTurns: num(env.STUDIO_SESSION_CEILING_TURNS, 80),
    checkTurns: num(env.STUDIO_CHECK_TURNS, 20),
    checkTokens: num(env.STUDIO_CHECK_TOKENS, 40000),
  };
}

/**
 * Turns and current context from a Claude Code stream-json log (or any log with per-message usage):
 * a turn is an assistant message (by id), the context is the last one's input + cache reads + cache writes.
 */
// 2.85: a tool call that is work landing: a commit or a verify (the idle-turns rule counts turns since the last one).
const WORK_CMD = /\bgit\b(?:\s+-c\s+\S+)*\s+commit\b|\bnpm run verify\b|run-gates\.mjs|\btask(?:\.mjs| --) done\b/;
export function sessionProgress(log) {
  const ids = new Set();
  let turns = 0;
  let context = 0;
  let resultTurns = null;
  let workTurn = 0;
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
      if (Array.isArray(o.message.content) && o.message.content.some((c) => c?.type === 'tool_use' && WORK_CMD.test(String(c.input?.command || '')))) workTurn = turns;
    } else if (o.type === 'result' && o.num_turns != null) resultTurns = Number(o.num_turns);
  }
  // 2.85: idleTurns: turns since the last commit or verify in this log (all of them when there was none).
  return { turns: resultTurns ?? turns, context, idleTurns: Math.max(0, turns - workTurn) };
}

/** 2.85: STUDIO_REFRESH_DECIDE: 'rule' (default) or 'ask'. */
export const refreshDecideMode = (env = process.env) => (/^ask$/i.test(String(env.STUDIO_REFRESH_DECIDE || '').trim()) ? 'ask' : 'rule');

/**
 * 2.85: the rule a check point decides by: { decision: 'continue'|'handoff', why, pct, window }. The window is the
 * model's context size (harness/model-limits.mjs limitsFor); unknown: twice the refresh point.
 */
export function refreshRuleDecision({ turns = 0, context = 0, idleTurns = 0, model = null, point = 0, env = process.env } = {}) {
  let window = 0;
  try { window = Number(limitsFor(model)?.context) || 0; } catch { window = 0; }
  const from = window ? `its ${Math.round(window / 1000)}k window` : `twice its ${Math.round(point / 1000)}k refresh point (window unknown)`;
  if (!window) window = point > 0 ? point * 2 : 0;
  const pctAt = num(env.STUDIO_REFRESH_HANDOFF_PCT, 60);
  const idleAt = num(env.STUDIO_REFRESH_IDLE_TURNS, 40);
  const pct = window > 0 ? Math.round((context / window) * 1000) / 10 : 0;
  if (window > 0 && pctAt > 0 && pct >= pctAt) return { decision: 'handoff', why: `context ${context.toLocaleString()} tokens is ${pct} % of ${from}, at or over STUDIO_REFRESH_HANDOFF_PCT (${pctAt} %)`, pct, window };
  if (idleAt > 0 && idleTurns >= idleAt) return { decision: 'handoff', why: `no commit and no verify in its last ${idleTurns} turns (STUDIO_REFRESH_IDLE_TURNS ${idleAt})`, pct, window };
  return { decision: 'continue', why: `context at ${pct} % of ${from} (under ${pctAt} %), last commit or verify ${idleTurns} turns ago (under ${idleAt})`, pct, window };
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
export function heartbeatCheck(agent, { log, model = 'unknown', task = null, role = null, env = process.env, lim = sessionLimits(env, { role, model }) } = {}) {
  const p = sessionProgress(log);
  let decided = null;
  const f = readFlag(agent) || { agent, checks: [] };
  const st = refreshState(p, f, lim);
  const prev = f.last?.state;
  f.last = { ...p, model, role, point: lim.context, state: st.state, at: new Date().toISOString(), task };
  if (st.state === 'due' && prev !== 'due') emitEvent({ type: 'agent.refresh.due', agent, task, msg: `${agent} passed the refresh point (${p.turns} turns, ${p.context.toLocaleString()} tokens of context, ${model}; its point: ${lim.turns || '∞'} turns or ${lim.context ? `${Math.round(lim.context / 1000)}k` : '∞'} tokens${role ? ` for a ${role}` : ''}): hand off at the next breakpoint` });
  if (st.checkDue && f.cardFor !== st.checksOwed) {
    f.cardFor = st.checksOwed;
    f.cardAt = new Date().toISOString();
    if (refreshDecideMode(env) === 'rule' && st.state !== 'exception') {
      // 2.85: decided by rule, recorded as a check like a person's (by: 'rule'); a hand-off ends the session as a
      // refresh (endedBy), which the launcher acts on (agent.mjs). No ask.
      const d = refreshRuleDecision({ ...p, model, point: lim.context, env });
      const at = f.cardAt;
      f.checks = [...(f.checks || []), { by: 'rule', decision: d.decision, covers: Math.max(1, st.checksOwed), note: d.why.slice(0, 300), at, turns: p.turns, context: p.context, model }];
      if (d.decision === 'handoff') { f.handoffAsked = at; f.endedBy = `handed off at a refresh check by the rule: ${d.why}`; }
      decided = d;
      emitEvent({ type: 'agent.refresh.decided', agent, to: 'producer', task, msg: `${agent}: ${d.decision === 'handoff' ? 'hand off now' : 'continue'} by rule at ${p.turns} turns, ${p.context.toLocaleString()} tokens (${model}): ${d.why}`.slice(0, 600), meta: { decision: d.decision, why: d.why, turns: p.turns, tokens: p.context, pct: d.pct, idleTurns: p.idleTurns, window: d.window, by: 'rule' } });
    } else emitEvent({ type: 'agent.ask', agent: 'launcher', to: 'producer', task, msg: `Check ${agent}${st.state === 'exception' ? ' (mid-debug exception)' : ''}: ${p.turns} turns, ${p.context.toLocaleString()} tokens of context (${model}). Continue or hand off: npm run session -- check ${agent} continue|handoff --by <you>`, meta: { refreshCheck: true, director: true } });
  }
  writeFlag(agent, f);
  return { ...p, ...st, ...(decided ? { decided } : {}) };
}

/**
 * 2.78.1 (e): fresh session for a red on a different cause. A builder whose verify goes red on another cause (failing gate
 * and first failing line, harness/handback-facts.mjs verifyCause) than its previous red in this session, once its context
 * is past STUDIO_REFRESH_NEW_RED_SHARE (0.5) of its refresh point, hands off: a fresh session starts from the hand-back
 * (its facts carry the failure), not from a context full of the first red. STUDIO_REFRESH_ON_NEW_RED=off turns it off;
 * STUDIO_REFRESH_NEW_RED_ROLES (builder) names the roles. A session flagged mid-debug (npm run session -- exception)
 * keeps going: a long investigation still waits for its commit or breakpoint. Returns { handoff, why }.
 */
export function newRedDecision({ reds = [], red = null, context = 0, point = 0, exception = false, env = process.env } = {}) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_REFRESH_ON_NEW_RED || ''))) return { handoff: false, why: 'STUDIO_REFRESH_ON_NEW_RED=off' };
  if (!red || red.ok) return { handoff: false, why: 'not red' };
  const prev = reds.filter((r) => r.key && (Number(r.at) || 0) < (Number(red.at) || 0)).pop();
  if (!prev) return { handoff: false, why: 'its first red in this session' };
  if (prev.key === red.key) return { handoff: false, why: 'the same cause as its previous red' };
  const share = num(env.STUDIO_REFRESH_NEW_RED_SHARE, 0.5);
  if (!(point > 0) || context < point * share) return { handoff: false, why: `context ${context} under ${Math.round(share * 100)} % of its refresh point` };
  if (exception) return { handoff: false, why: 'flagged mid-debug (session exception)' };
  const k = (n) => `${Math.round(n / 1000)}k`;
  return { handoff: true, why: `verify red on a different cause (${red.failGate || 'a gate'}${red.line ? `: ${String(red.line).slice(0, 120)}` : ''}) than its previous red (${prev.gate || 'a gate'}), at ${k(context)} of its ${k(point)} refresh point: a fresh session starts from the hand-back with the failure only` };
}

/** The launcher's beat: record a new verify of this session and decide (newRedDecision); writes the refresh flag. */
export function newRedCheck(agent, { since = 0, context = 0, role = null, model = null, env = process.env } = {}) {
  const roles = String(env.STUDIO_REFRESH_NEW_RED_ROLES || 'builder').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!role || !roles.includes(String(role).toLowerCase())) return null;
  const red = verifyCause(agent, since);
  if (!red) return null;
  const f = readFlag(agent) || { agent, checks: [] };
  const reds = f.reds || [];
  if (reds.some((r) => r.at === red.at) || f.endedBy) return { handoff: false, why: 'seen' };
  const lim = sessionLimits(env, { role, model });
  const d = newRedDecision({ reds, red, context, point: lim.context, exception: Boolean(f.exception), env });
  f.reds = [...reds, { at: red.at, key: red.key, gate: red.failGate, ok: red.ok }].slice(-10);
  if (d.handoff) {
    f.endedBy = d.why;
    f.newRed = { at: red.at, gate: red.failGate, line: red.line, key: red.key, log: red.log };
    emitEvent({ type: 'agent.refresh.new_red', agent, to: 'producer', msg: `${agent} hands off: ${d.why}`.slice(0, 500), meta: { gate: red.failGate, key: red.key, previous: reds.filter((r) => r.key).pop()?.key || null, context, point: lim.context } });
  }
  writeFlag(agent, f);
  return d;
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
  stopAgent(s, { by: by || 'producer' }); // PU-17: the record, so the kill checks the process is still the agent
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
    const st = refreshState(r.last || {}, r, r.last?.role ? sessionLimits(process.env, { role: r.last.role, model: r.last.model }) : lim);
    return { agent: r.agent || f.slice(0, -5), running, turns: r.last?.turns ?? 0, context: r.last?.context ?? 0, model: r.last?.model || 'unknown', task: r.last?.task || null, state: st.state, checkDue: st.checkDue, exception: r.exception || null, checks: r.checks || [], handoffAsked: r.handoffAsked || null, endedBy: r.endedBy || null };
  }).filter(Boolean);
}

/** The template a refreshing agent writes into its hand-back (task pause --note), kept under 3k characters. */
export const HANDOFF_TEMPLATE = 'Done: … | Failed/tried: … | Next step: … | Standing rules: … | Files: …';
export const HANDOFF_MAX = 3000;

// 2.84: the command-line part is an async function, not a top-level await: an import cycle through a top-level await ends the process with exit 13.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))(async () => {
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
})().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
