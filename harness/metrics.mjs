#!/usr/bin/env node
/**
 * harness/metrics.mjs — 2.54.0 (PU-02, PU-03): one data row per task attempt, with a failure label.
 *
 *   npm run metrics                     write .studio/metrics/attempts.jsonl and .csv, print medians and p90
 *   npm run metrics -- --since 2026-10-31T10:00:00Z [--json]
 *
 * An attempt is one claim of a task: from `task.start` to the first of task done, hand-back (task.paused),
 * forced done, dropped/shelved, the claiming agent's session ending, or the next claim of the same task.
 * Its wall time is split into:
 *   - checks:  `npm run verify` runs by that agent inside the attempt (gates.run meta.ms);
 *   - person:  questions to the game dev from that agent until answered, and time the studio was stopped;
 *   - stalled: heartbeat gaps over 5 minutes (heartbeats come every 2) and idle stalls the watchdog ended;
 *   - agent:   the rest.
 * Plus tokens (in, out, cache reads), reported cost (an estimate from the CLI), sessions, earlier attempts on
 * the same task (retries), hand-backs, rescues, refusals, and whether it was reopened after done.
 *
 * Failure labels (PU-03) for every attempt that didn't end in a done, from a fixed list based on the MAST
 * taxonomy of multi-agent failures (arXiv 2503.13657) plus three of our own. Assigned by rules, never by a model:
 *   repetition      (MAST step repetition) a burn/loop stall, or parked after repeated hand-backs
 *   premature-stop  (MAST premature termination) the session ended without done or a hand-back
 *   no-stop         (MAST unaware of termination) over its task budget, or a refresh check left unanswered
 *   verify-missing  (MAST no or incomplete verification) forced done, or "not done" for a missing verify
 *   verify-wrong    (MAST incorrect verification) reopened after it was done
 *   spec-ignored    (MAST disobey task specification) refused for scope, or a review said it missed the task
 *   env-harness     the harness or the machine: harness-caused hand-back, flaky check, studio stopped, merge refused
 *   quota           a usage limit, rate limit or budget stop on the tool
 *   lane-conflict   lost the task lock or the lane to another agent
 *   unknown         none of the above matched
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';

export const FAILURE_LABELS = ['repetition', 'premature-stop', 'no-stop', 'verify-missing', 'verify-wrong', 'spec-ignored', 'env-harness', 'quota', 'lane-conflict', 'unknown'];
const ts = (e) => Date.parse(e?.ts) || 0;
const min = (ms) => Math.round((ms / 60000) * 10) / 10;
const family = (model) => {
  const m = String(model || '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) return 'anthropic';
  if (/gpt|o\d|codex|openai/.test(m)) return 'openai';
  if (/grok|xai/.test(m)) return 'xai';
  if (/gemini|vertex/.test(m)) return 'google';
  if (/llama|qwen|deepseek|glm|mistral|nemotron|ollama/.test(m)) return 'open-weights';
  return m ? 'other' : null;
};

/** Overlap in ms between [a0, a1] and [b0, b1]. */
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Spans when the studio was stopped (studio.stopped → studio.resumed). */
function stoppedSpans(events, end) {
  const spans = [];
  let from = null;
  for (const e of events) {
    if (e.type === 'studio.stopped' && from === null) from = ts(e);
    if (e.type === 'studio.resumed' && from !== null) { spans.push([from, ts(e)]); from = null; }
  }
  if (from !== null) spans.push([from, end]);
  return spans;
}

/**
 * Spans each agent waited on a person: its ask.open until the matching ask.answered (an answer closes that ID for
 * every agent that has it open). One pass for all agents: agent -> spans.
 */
function askSpansByAgent(events, end) {
  const spans = new Map();
  const open = new Map(); // agent -> Map(ask id or #n -> opened at)
  const holders = new Map(); // ask id -> agents that have it open
  for (const e of events) {
    if (e.type !== 'ask.open' && e.type !== 'ask.answered') continue;
    const id = (String(e.msg || '').match(/^(A-\d+|ask-[\w-]+|Q-\d+)/) || [])[1] || null;
    if (e.type === 'ask.open') {
      if (!open.has(e.agent)) open.set(e.agent, new Map());
      const mine = open.get(e.agent);
      mine.set(id || `#${mine.size}`, ts(e));
      if (id) { if (!holders.has(id)) holders.set(id, new Set()); holders.get(id).add(e.agent); }
    } else if (id && holders.has(id)) {
      for (const agent of holders.get(id)) {
        const mine = open.get(agent);
        if (!mine.has(id)) continue;
        if (!spans.has(agent)) spans.set(agent, []);
        spans.get(agent).push([mine.get(id), ts(e)]);
        mine.delete(id);
      }
      holders.delete(id);
    }
  }
  for (const [agent, mine] of open) {
    if (!spans.has(agent)) spans.set(agent, []);
    for (const t of mine.values()) spans.get(agent).push([t, end]);
  }
  return spans;
}

/** Events sorted by time once (stable: equal times keep log order), with each event's time read once. */
function byTime(events) {
  const keyed = events.map((e) => [ts(e), e]).sort((x, y) => x[0] - y[0]);
  return { sorted: keyed.map((k) => k[1]), times: keyed.map((k) => k[0]) };
}

/** First position in `times` (ascending) holding a value >= x, or > x with `after`. */
function bound(times, x, after = false) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < x || (after && times[mid] === x)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sorted events of one type grouped by a key (agent or task), each group with its times, for binary search. */
function groupBy(sorted, times, type, key) {
  const m = new Map();
  sorted.forEach((e, i) => {
    if (e.type !== type) return;
    if (!m.has(e[key])) m.set(e[key], { ev: [], t: [] });
    m.get(e[key]).ev.push(e);
    m.get(e[key]).t.push(times[i]);
  });
  return m;
}
const lastAtOrBefore = (g, x) => { const p = g ? bound(g.t, x, true) : 0; return p > 0 ? g.ev[p - 1] : undefined; };
const firstAtOrAfter = (g, x) => { const p = g ? bound(g.t, x) : 0; return g && p < g.ev.length ? g.ev[p] : undefined; };

/** Every attempt in the log, oldest first. */
export function buildAttempts(events, { now = Date.now() } = {}) {
  events = byTime(events).sorted;
  const attempts = [];
  const open = new Map(); // task -> attempt
  const close = (a, end, outcome, endEvent = null) => {
    a.end = end; a.outcome = outcome; a.endEvent = endEvent; open.delete(a.task); attempts.push(a);
  };
  const tries = new Map();
  for (const e of events) {
    const task = e.task || null;
    if (e.type === 'task.start' && task) {
      if (open.has(task)) close(open.get(task), ts(e), 'reclaimed', e);
      const n = (tries.get(task) || 0) + 1;
      tries.set(task, n);
      open.set(task, { task, attempt: n, agent: e.agent || null, model: e.model || null, start: ts(e), startEvent: e });
      continue;
    }
    if (!task || !open.has(task)) {
      // The claiming agent's session ending closes its open attempt.
      if (e.type === 'agent.session.end') for (const a of [...open.values()]) if (a.agent === e.agent) close(a, ts(e), 'session-ended', e);
      continue;
    }
    const a = open.get(task);
    if (e.type === 'task.done') close(a, ts(e), 'done', e);
    else if (e.type === 'task.forced') close(a, ts(e), 'forced', e);
    else if (e.type === 'task.paused') close(a, ts(e), 'handed-back', e);
    else if (['task.dropped', 'task.shelved'].includes(e.type)) close(a, ts(e), e.type.slice(5), e);
  }
  for (const a of open.values()) { a.end = now; a.outcome = 'open'; attempts.push(a); }
  return attempts.sort((x, y) => x.start - y.start);
}

/**
 * PU-03: one failure label for an attempt that didn't end done. `inWin`: the events inside the attempt; `all`: the
 * whole log sorted by time; `index` (optional, from attemptRows): the same log's session ends by agent.
 */
export function labelFailure(a, inWin, all, index = null) {
  if (a.outcome === 'done' || a.outcome === 'open') return null;
  const txt = (e) => `${e?.msg || ''} ${JSON.stringify(e?.meta || {})}`;
  const mine = inWin.filter((e) => e.task === a.task || e.agent === a.agent || e.meta?.target === a.agent);
  const has = (re, types = null) => mine.some((e) => (!types || types.includes(e.type)) && re.test(txt(e)));
  if (has(/usage limit|rate limit|\b429\b|quota|marked out|budget stop/i, ['agent.session.end', 'tool.takeover', 'task.budget', 'agent.stopped', 'task.paused'])) return 'quota';
  if (mine.some((e) => e.type === 'session.stall' && /burn|loop|repeat/i.test(txt(e))) || has(/handed back \d+ times/i, ['task.hold'])) return 'repetition';
  if (mine.some((e) => e.type === 'task.lock_denied') || has(/lane .* is held|holds T-\d+|already claimed/i)) return 'lane-conflict';
  if (a.outcome === 'forced' || has(/no full `?npm run verify|didn't run|no changes found/i, ['task.not_done'])) return 'verify-missing';
  if (has(/over (its|the) (task )?budget|refresh check went unanswered|session cap/i, ['task.budget', 'watchdog.action', 'agent.stopped', 'task.paused'])) return 'no-stop';
  if (mine.some((e) => e.type === 'task.refused' || e.type === 'task.scope_override') || has(/missed the task|off the spec|not what the task asked/i, ['review.verdict', 'task.reopened'])) return 'spec-ignored';
  if (mine.some((e) => ['studio.stopped', 'gate.flaky', 'whole.environment'].includes(e.type)) || has(/harness|merge refused|land lock|claim ran out|main checkout/i, ['task.paused'])) return 'env-harness';
  if (a.outcome === 'session-ended' || /ended without task done|without task done or a hand-back|finished without task done|session ended .* while it held/i.test(txt(a.endEvent))) {
    // A hand-back for a session that had already ended before this claim began is the harness's mistake (an old
    // record under the same agent name), not the agent stopping early.
    const lastEnd = index ? lastAtOrBefore(index.sessionEnds.get(a.agent), a.end) : all.filter((e) => e.type === 'agent.session.end' && e.agent === a.agent && ts(e) <= a.end).pop();
    if (lastEnd && ts(lastEnd) < a.start && a.endEvent?.agent !== a.agent) return 'env-harness';
    return 'premature-stop';
  }
  return 'unknown';
}

/**
 * One metrics row per attempt.
 * 2.58.0 (PU-41, P-059): this filtered the whole log once per attempt (20k events 14 s, 40k 53 s). Now the log is
 * sorted once, an attempt's events are found by binary search on time, and session starts/ends, reopenings and
 * questions are indexed by agent or task. The rows are the same as before.
 */
export function attemptRows(events = readRecentEvents(200000), { now = Date.now(), since = 0 } = {}) {
  const { sorted, times } = byTime(events);
  events = sorted;
  const end = now;
  const stops = stoppedSpans(events, end);
  const asks = askSpansByAgent(events, end);
  const index = {
    sessionEnds: groupBy(events, times, 'agent.session.end', 'agent'),
    sessionStarts: groupBy(events, times, 'agent.session.start', 'agent'),
    reopens: groupBy(events, times, 'task.reopened', 'task'),
  };
  const rows = [];
  for (const a of buildAttempts(events, { now })) {
    if (a.start < since) continue;
    const inWin = events.slice(bound(times, a.start), bound(times, a.end, true)); // start <= time <= end, in log order
    const wall = Math.max(0, a.end - a.start);
    const checks = inWin.filter((e) => e.type === 'gates.run' && e.agent === a.agent).reduce((s, e) => s + (Number(e.meta?.ms) || 0), 0);
    const person = [...(asks.get(a.agent) || []), ...stops].reduce((s, [x, y]) => s + overlap(a.start, a.end, x, y), 0);
    // Stalls: gaps over 5 min between heartbeats (every 2 min while a launched agent runs). An agent working
    // outside the launcher (a chat bot claiming tasks itself) sends none, so its quiet time isn't called a stall;
    // only stalls the watchdog ended count for it.
    const own = inWin.filter((e) => e.agent === a.agent || e.meta?.target === a.agent);
    const heartbeats = own.some((e) => e.type === 'agent.heartbeat');
    let stalled = 0;
    if (heartbeats) {
      const beats = own.map(ts).concat([a.start, a.end]).sort((x, y) => x - y);
      for (let i = 1; i < beats.length; i++) if (beats[i] - beats[i - 1] > 5 * 60000) stalled += beats[i] - beats[i - 1];
    }
    for (const e of inWin.filter((x) => x.type === 'session.stall' && (x.meta?.target === a.agent))) {
      const m = String(e.msg || '').match(/for (\d+) min/);
      if (m) stalled += Number(m[1]) * 60000;
    }
    stalled = Math.min(Math.max(0, stalled - person - checks), Math.max(0, wall - checks - person));
    const agentMs = Math.max(0, wall - checks - person - stalled);
    // The session that held this attempt reports its tokens when it ends, often after the task is done: the
    // first session end of this agent at or after the attempt began (shared by time with its other attempts below).
    const firstEnd = firstAtOrAfter(index.sessionEnds.get(a.agent), a.start);
    const sessions = firstEnd ? [firstEnd] : [];
    const reopens = index.reopens.get(a.task);
    const reopened = !!reopens && reopens.t[reopens.t.length - 1] > a.start;
    // The model from the agent's own session record first (an event's model can be the studio default).
    const sess = lastAtOrBefore(index.sessionStarts.get(a.agent), a.end);
    const model = sessions.find((e) => e.model)?.model || (sess && ts(sess) >= a.start - 6 * 3600000 ? sess.model : null) || a.model || null;
    const row = {
      task: a.task, attempt: a.attempt, retries: a.attempt - 1, agent: a.agent, model, family: family(model),
      start: new Date(a.start).toISOString(), end: new Date(a.end).toISOString(), outcome: a.outcome,
      minutes: min(wall), agentMin: min(agentMs), checksMin: min(checks), personMin: min(person), stalledMin: min(stalled),
      tokensIn: 0, tokensOut: 0, cacheRead: 0, costUsdReported: 0,
      sessions: sessions.length, heartbeats,
      handBacks: inWin.filter((e) => e.type === 'task.paused' && e.task === a.task).length,
      notDone: inWin.filter((e) => e.type === 'task.not_done' && e.task === a.task).length,
      rescues: inWin.filter((e) => /^task\.rescue/.test(e.type) && e.task === a.task).length,
      reopened,
    };
    row.failure = labelFailure(a, inWin, events, index);
    if (reopened && row.outcome === 'done') row.failure = 'verify-wrong';
    row._session = sessions[0] || null;
    row._wall = wall;
    rows.push(row);
  }
  // Share each session's tokens and reported cost among the attempts it held, by their wall time.
  const bySession = new Map();
  for (const r of rows) if (r._session) { if (!bySession.has(r._session)) bySession.set(r._session, []); bySession.get(r._session).push(r); }
  for (const [e, rs] of bySession) {
    const total = rs.reduce((x, r) => x + r._wall, 0) || rs.length;
    for (const r of rs) {
      const w = total === rs.length ? 1 / rs.length : r._wall / total;
      r.tokensIn = Math.round((Number(e.tokensIn) || 0) * w);
      r.tokensOut = Math.round((Number(e.tokensOut) || 0) * w);
      r.cacheRead = Math.round((Number(e.meta?.cacheRead) || 0) * w);
      r.costUsdReported = Math.round((Number(e.meta?.costUsd) || 0) * w * 100) / 100;
    }
  }
  for (const r of rows) { delete r._session; delete r._wall; }
  return rows;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null; };

export function summarize(rows) {
  const by = (key) => {
    const m = new Map();
    for (const r of rows) { const k = r[key] ?? '(none)'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m].map(([k, rs]) => ({ [key]: k, attempts: rs.length, done: rs.filter((r) => r.outcome === 'done').length, medianMin: median(rs.map((r) => r.minutes)), p90Min: p90(rs.map((r) => r.minutes)), medianTokens: median(rs.map((r) => r.tokensIn + r.tokensOut)) }));
  };
  const failures = {};
  for (const r of rows) if (r.failure) failures[r.failure] = (failures[r.failure] || 0) + 1;
  const tot = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 10) / 10;
  return { attempts: rows.length, done: rows.filter((r) => r.outcome === 'done').length, minutes: { agent: tot('agentMin'), checks: tot('checksMin'), person: tot('personMin'), stalled: tot('stalledMin') }, byModel: by('model'), byOutcome: by('outcome'), failures };
}

const CSV_COLS = ['task', 'attempt', 'retries', 'agent', 'model', 'family', 'start', 'end', 'outcome', 'failure', 'minutes', 'agentMin', 'checksMin', 'personMin', 'stalledMin', 'tokensIn', 'tokensOut', 'cacheRead', 'costUsdReported', 'sessions', 'heartbeats', 'handBacks', 'notDone', 'rescues', 'reopened'];
export function writeMetrics(rows, dir = path.join(STUDIO_STATE_DIR, 'metrics')) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'attempts.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  const q = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  fs.writeFileSync(path.join(dir, 'attempts.csv'), [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => q(r[c])).join(','))].join('\n') + '\n');
  return { jsonl: path.join(dir, 'attempts.jsonl'), csv: path.join(dir, 'attempts.csv') };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const since = Date.parse(flag('since') || '') || 0;
  const rows = attemptRows(readRecentEvents(200000), { since });
  const files = writeMetrics(rows);
  const s = summarize(rows);
  if (argv.includes('--json')) { console.log(JSON.stringify({ rows, summary: s }, null, 2)); process.exit(0); }
  console.log(`${s.attempts} attempt(s), ${s.done} done. Minutes: agent ${s.minutes.agent}, checks ${s.minutes.checks}, waiting on a person ${s.minutes.person}, stalled ${s.minutes.stalled}.`);
  for (const m of s.byModel) console.log(`- ${m.model}: ${m.attempts} attempt(s), ${m.done} done, median ${m.medianMin ?? '-'} min (p90 ${m.p90Min ?? '-'}), median ${m.medianTokens ?? '-'} tokens`);
  const f = Object.entries(s.failures).sort((a, b) => b[1] - a[1]);
  console.log(f.length ? `Failures: ${f.map(([k, n]) => `${k} ${n}`).join(', ')}` : 'Failures: none');
  console.log(`Rows: ${path.relative(process.cwd(), files.csv)} (and .jsonl)`);
}
