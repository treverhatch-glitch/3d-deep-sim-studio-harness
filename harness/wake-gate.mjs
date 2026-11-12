/**
 * harness/wake-gate.mjs — 2.84: a planning wake needs something that changed.
 *
 * In one crew's 26 hours the Director was woken 33 times for its regular development cycle and the Producer 50 times
 * because the queue was below its depth target (0 ready, every area blocked) and 29 more for its cycle: about $60 of
 * $82 of planning spend left no board event behind. 2.83 backed off one case (the same train or chain-gate blocker,
 * harness/line-producer.mjs producerWakeBackoff); this gate covers the two kinds of planning wake:
 *
 *   queue-depth  the Producer's "queue is below its depth target" wake (harness/queue-depth.mjs). Its fingerprint: the
 *                count ready, the target, the blocked areas with the kinds of their reasons (no times, no counters),
 *                the ids of the open tasks. The same fingerprint as the last wake, whose session has ended and changed
 *                nothing on the board (BOARD_EVENT_TYPES, by that session's agent): skipped.
 *   cycle        each role's regular development cycle (harness/dev-cycle.mjs, "its regular cycle" only). Its
 *                fingerprint is a digest of what changed since that role's last cycle session ended (landed, handed
 *                back, held or parked, asks, decisions, a person's message, tester and playtest findings, a red train
 *                or trunk). An empty digest after an ended session: skipped. A non-empty one runs, and goes at the top
 *                of the brief the session is told to read.
 *
 * Never longer than STUDIO_WAKE_SAME_MAX_H (6) hours for a queue-depth wake, STUDIO_CYCLE_QUIET_MAX_H (12) for a cycle,
 * since the last wake that ran; 0 or off turns that kind's skipping off. Every skip emits agent.wake.skipped with the
 * kind and a plain reason. Nothing else is gated here: a person's request, an ask's answer, an alert or an owner order
 * wakes as before. State: .studio/line/wake-gate.json, next to the 2.83 state.json (its own file, so the Line
 * Producer's rewrites of state.json never race it); it survives a supervisor restart.
 *
 * 2.84 (a2): a back-off by outcome, per kind and role. In the replayed log the digest was almost never empty (hand-backs
 * and parks fill it), so only 1 of 32 Director cycles would have been skipped by the digest. Now after a session that
 * changed nothing (a cycle: no board event; a queue-depth session: no task added) the next wake of that kind waits twice
 * as long: the base interval (the cycle's STUDIO_DEV_CYCLE_MIN, the depth ask's STUDIO_QUEUE_DEPTH_ASK_MIN), then x2, x4,
 * x8 ..., never longer than the kind's ceiling. A session that changed the board (a cycle) or added a task (a queue
 * session) resets it; a hand-back or a park does not. Strong news (STRONG_NEWS_TYPES) makes a cycle due at once and keeps
 * the count; a queue wake is cut short when a blocked area frees up or the queue reached its target since. The ceilings'
 * `off` (or 0) turns the back-off off with the rest: 2.83's cadence.
 *
 * The fingerprint, the digest and the verdicts are pure (inputs in, verdict out); gateWake/recordWake read and write
 * the state. Imports only event.mjs and fsafe.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { readJson, writeAtomic } from './fsafe.mjs';

/**
 * The events that change the board. One list: a planning session's outcome (agent.session.end meta.outcome.boardEvents)
 * counts these by its own agent, and the queue-depth skip asks whether the last session emitted any.
 */
export const BOARD_EVENT_TYPES = Object.freeze([
  'task.added', 'task.dropped', 'task.reordered', 'task.reopened', 'task.retyped',
  'task.hold', 'task.held', 'task.unheld', 'task.unblocked', 'task.dev_yes',
  'decision', 'ask.open', 'ask.answered',
]);
const BOARD = new Set(BOARD_EVENT_TYPES);
export const isBoardEvent = (e) => Boolean(e && BOARD.has(e.type));

/** The roles whose sessions get meta.outcome.boardEvents on agent.session.end. */
export const PLANNING_OUTCOME_ROLES = Object.freeze(['producer', 'director']);

export const WAKE_GATE_FILE = () => path.join(STUDIO_STATE_DIR, 'line', 'wake-gate.json');

const hours = (v, d) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return d;
  if (/^(off|false|no)$/.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
/** The longest a queue-depth wake is skipped, in hours; 0: never skipped. */
export const wakeSameMaxH = (env = process.env) => hours(env.STUDIO_WAKE_SAME_MAX_H, 6);
/** The longest a regular cycle is skipped, in hours; 0: never skipped. */
export const cycleQuietMaxH = (env = process.env) => hours(env.STUDIO_CYCLE_QUIET_MAX_H, 12);
export const maxHoursFor = (kind, env = process.env) => (kind === 'cycle' ? cycleQuietMaxH(env) : wakeSameMaxH(env));

const ts = (e) => Date.parse(e?.ts) || 0;
const sha = (x) => crypto.createHash('sha1').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const utc = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** How many board-changing events `agent` emitted in [from, to]. */
export function boardEventsBy(agent, events = [], { from = 0, to = Infinity } = {}) {
  if (!agent) return 0;
  let n = 0;
  for (const e of events) { const t = ts(e); if (e.agent === agent && isBoardEvent(e) && t >= from && t <= to) n += 1; }
  return n;
}

/**
 * What a woken session did, from the log: { ended, endedAt, boardEvents }. Its agent.session.end after `since` (its
 * meta.outcome.boardEvents when it carries one, else its board events counted from the log); ended false when it has none.
 */
export function sessionOutcomeOf(agent, since, events = []) {
  if (!agent) return { ended: false, endedAt: null, boardEvents: null };
  const end = events.find((e) => e.type === 'agent.session.end' && e.agent === agent && ts(e) >= since);
  const added = (to) => events.filter((e) => e.type === 'task.added' && e.agent === agent && ts(e) >= since && ts(e) <= to).length;
  if (!end) return { ended: false, endedAt: null, boardEvents: boardEventsBy(agent, events, { from: since }), tasksAdded: added(Infinity) };
  const n = Number(end.meta?.outcome?.boardEvents);
  return { ended: true, endedAt: ts(end), boardEvents: Number.isFinite(n) ? n : boardEventsBy(agent, events, { from: since, to: ts(end) }), tasksAdded: added(ts(end)) };
}

/**
 * 2.84 (a2): news that makes a backed-off regular cycle due at once (the back-off count is kept). Each type with its
 * predicate where the type alone is not enough. A red train, a hand-back, a park or an agent's own decision is not news
 * of this kind: those were in nearly every digest and bought nothing.
 *   ask.answered          by a person, or recorded by the owner's stand-in (meta.via: owner proxy, beta mode)
 *   decision              made as a person or by the owner's stand-in (meta.as not "agent" or "autonomous", or
 *                         meta.standIn: the overseer's own board decision, 2.84 n)
 *   inbound.message       a person's message (a new owner note), or the overseer's order
 *   2.84 (n): none of these from a launched session's own shell (meta.role).
 *   playtest.verdict      the owner played a build
 *   task.dev_yes          the dev said yes to an agent-proposed mechanic (an order)
 *   bible.signed, bible.phase_override, milestone.closed   a phase change
 */
export const STRONG_NEWS_TYPES = Object.freeze(['ask.answered', 'decision', 'inbound.message', 'playtest.verdict', 'task.dev_yes', 'bible.signed', 'bible.phase_override', 'milestone.closed']);
const SYSTEM_NAMES = /^(harness|supervisor|watch|watchdog|launcher|threads|train|line|line-producer|communicator|janitor|budget|dev-cycle)$|-train$/i;
/** A name that reads as a person's (no agent-style hyphenated name, not the harness's own). */
export const looksLikePerson = (name) => { const n = String(name || '').trim(); return Boolean(n) && !SYSTEM_NAMES.test(n) && !/-/.test(n) && !/^(producer|director|builder|reviewer|tester|planner|rnd|art)\d*$/i.test(n); };
const STRONG = new Set(STRONG_NEWS_TYPES);
export function isStrongNews(e, { isPerson = looksLikePerson } = {}) {
  if (!e || !STRONG.has(e.type)) return false;
  // 2.84 (n): an answer, a decision or a post made from a launched session's shell (meta.role: a Producer or Director
  // standing in under beta mode, say) is that session's own news, not an owner's: it never ends a back-off.
  if (['ask.answered', 'decision', 'inbound.message'].includes(e.type) && String(e.meta?.role || '').trim()) return false;
  if (e.type === 'ask.answered') return Boolean(e.meta?.via || e.meta?.recordedBy) || isPerson(e.meta?.by || e.agent);
  // 2.84 (n): a board decision the owner's stand-in took as itself (meta.standIn: the owner's proxy, a beta-mode agent or
  // an outside signer; decisions-log.mjs) counts as the owner's, like a person's.
  if (e.type === 'decision') { const as = String(e.meta?.as || '').toLowerCase(); if (e.meta?.standIn) return true; return as !== '' ? !/^(agent|autonomous)/.test(as) : isPerson(e.agent); }
  return true;
}

/**
 * 2.84 (a2): the back-off verdict, pure: { skip, wait (ms), due (ms) }. quiet: sessions in a row that changed nothing;
 * lastAt: the last wake that ran; baseMs: the kind's own interval; maxH: its ceiling; cutShort: news that ends the wait.
 */
export function backoffVerdict({ quiet = 0, lastAt = null, now = Date.now(), baseMs = 0, maxH = 6, cutShort = false } = {}) {
  if (!(maxH > 0) || !(quiet > 0) || !Number.isFinite(lastAt) || !(baseMs > 0)) return { skip: false, wait: baseMs, due: Number.isFinite(lastAt) ? lastAt + baseMs : now };
  const wait = Math.min(baseMs * 2 ** Math.min(quiet, 30), maxH * 3600000);
  const due = lastAt + wait;
  return { skip: now < due && !cutShort, wait, due };
}

/** A blocked task's reason as a kind, without its times, counts or ids. */
export function reasonKind(why) {
  const s = String(why || '');
  const rules = [
    [/trunk is red/i, 'red trunk'], [/\btrain\b/i, 'train'], [/^parked\b|\bparked by\b/i, 'parked'], [/held for landing|^held\b/i, 'held'],
    [/^waits for\b/i, 'waits'], [/^blocked until\b/i, 'blocked until'], [/^stopped by\b/i, 'stopped'], [/says yes|agent-proposed/i, 'needs yes'],
    [/same blocker/i, 'same blocker'], [/a rescue for/i, 'rescue'], [/over (its|the) budget|budget/i, 'budget'], [/\block|holds|lane|folder/i, 'lane busy'],
  ];
  for (const [rx, k] of rules) if (rx.test(s)) return k;
  return 'other';
}

/**
 * The queue-depth wake's situation: { key, summary, facts }. ready: the ids ready (or a count), target: the depth target,
 * blocked: readiness()'s [{ area, tasks: [{ id, why }] }], open: the open task ids (backlog and in progress).
 */
export function queueFingerprint({ ready = [], target = null, blocked = [], open = [] } = {}) {
  const facts = {
    ready: Array.isArray(ready) ? ready.length : Number(ready) || 0,
    target: target ?? null,
    blocked: blocked.map((b) => `${b.area}: ${[...new Set((b.tasks || []).map((t) => reasonKind(t.why)))].sort().join(', ')}`).sort(),
    open: [...new Set(open.map(String))].sort(),
  };
  return { key: sha(facts), summary: `${facts.ready} ready, ${facts.blocked.length} area${facts.blocked.length === 1 ? '' : 's'} blocked`, facts, areas: blocked.map((b) => String(b.area)).sort() };
}

const PLANNER = /^(producer|director)(-|$)/;
const RED = /^task\.train\.(?:[a-z0-9-]+\.)?(dropped|known_red|died|stalled)$/;
/** The digest's groups, in the order they print: [label, test(e)]. */
const DIGEST = [
  ['landed or done', (e) => e.type === 'task.done' || e.type === 'milestone.closed'],
  ['handed back', (e) => e.type === 'task.paused'],
  ['held, parked or released', (e) => ['task.hold', 'task.held', 'task.unheld', 'task.unblocked'].includes(e.type)],
  ['asks', (e) => e.type === 'ask.open' || e.type === 'ask.answered'],
  ['a person\'s messages and decisions', (e) => e.type === 'inbound.message' || e.type === 'bible.signed' || e.type === 'bible.phase_override' || e.type === 'task.dev_yes' || (e.type === 'decision' && !PLANNER.test(String(e.agent || '')))],
  ['tester and playtest findings', (e) => e.type === 'tester.report' || e.type === 'playtest.verdict'],
  ['red train or trunk', (e) => RED.test(e.type) || e.type === 'trunk.red'],
];

/**
 * What changed on the board in (since, until]: { lines (10 at most, one per group), count, key, empty }. Pure. The
 * events are the recent-events reader's (bounded); a group names its tasks, else the start of its first message.
 */
export function cycleDigest(events = [], { since = 0, until = Infinity, max = 10 } = {}) {
  const groups = DIGEST.map(([label]) => ({ label, n: 0, items: [] }));
  let count = 0;
  for (const e of events) {
    const t = ts(e);
    if (!(t > since && t <= until)) continue;
    const i = DIGEST.findIndex(([, test]) => test(e));
    if (i < 0) continue;
    count += 1;
    const g = groups[i];
    g.n += 1;
    const item = e.task || String(e.msg || '').replace(/\s+/g, ' ').slice(0, 80);
    if (item && !g.items.includes(item)) g.items.push(item);
  }
  const lines = groups.filter((g) => g.n).map((g) => `- ${g.label} (${g.n}): ${g.items.slice(0, 6).join('; ')}${g.items.length > 6 ? `; +${g.items.length - 6} more` : ''}`).slice(0, max);
  return { lines, count, key: sha(lines), empty: count === 0 };
}

/**
 * The verdict, pure: { skip, why }. kind 'queue-depth' | 'cycle'; fp: this wake's fingerprint ({ key, summary } or a
 * digest); last: the last wake that ran ({ key, summary, at, agent }) or null; outcome: sessionOutcomeOf(last.agent).
 */
export function wakeVerdict({ kind, fp, last = null, outcome = null, now = Date.now(), maxH = 6 } = {}) {
  if (!(maxH > 0)) return { skip: false, why: 'skipping is off' };
  if (!last || !Number.isFinite(last.at)) return { skip: false, why: 'first wake of this kind' };
  if (now - last.at >= maxH * 3600000) return { skip: false, why: `${maxH} h since the last wake (the ceiling)` };
  if (!last.agent) return { skip: false, why: 'the last wake started no known session' };
  if (!outcome?.ended) return { skip: false, why: `${last.agent}'s session has not ended` };
  const when = utc(outcome.endedAt || last.at);
  if (kind === 'cycle') {
    if (!fp?.empty) return { skip: false, why: `${fp?.count ?? 0} change(s) since ${last.agent}'s cycle ended at ${when}` };
    return { skip: true, why: `nothing changed on the board since ${last.agent}'s cycle ended at ${when}` };
  }
  if (fp?.key !== last.key) return { skip: false, why: 'the situation changed' };
  if (outcome.boardEvents > 0) return { skip: false, why: `${last.agent}'s session changed the board (${outcome.boardEvents} event(s))` };
  return { skip: true, why: `nothing changed since ${last.agent}'s session at ${when}, which planned nothing: ${fp.summary || last.summary || 'the same situation'}` };
}

export const readWakeGate = () => { const j = readJson(WAKE_GATE_FILE(), {}); return j && typeof j === 'object' ? j : {}; };
function writeWakeGate(st) { try { fs.mkdirSync(path.dirname(WAKE_GATE_FILE()), { recursive: true }); writeAtomic(WAKE_GATE_FILE(), `${JSON.stringify(st, null, 1)}\n`); } catch { /* the next pass tries again */ } }
const slotOf = (kind, role) => `${kind}:${role}`;

/**
 * Ask the gate before a wake. kind 'queue-depth' | 'cycle'; role 'producer' | 'director'; fp: the fingerprint, or for
 * a cycle a function (since) => digest, called with the end of the last cycle session (else `fallbackSince`).
 * baseMs: the kind's own interval (the back-off's base). Returns { skip, why, fp, since, backoff }. A skip emits
 * agent.wake.skipped. Never throws (an error: the wake goes ahead).
 */
export function gateWake({ kind, role, fp, now = Date.now(), env = process.env, events = null, fallbackSince = 0, emit = emitEvent, agent = 'supervisor', baseMs = 0 } = {}) {
  try {
    const st = readWakeGate();
    const slotKey = slotOf(kind, role);
    let last = st[slotKey] || null;
    const evs = events || readRecentEvents(5000);
    const outcome = last?.agent ? sessionOutcomeOf(last.agent, last.at, evs) : null;
    // 2.84 (a2): fold the last session's outcome into the back-off count, once per session.
    if (last?.agent && outcome?.ended && last.folded !== last.agent) {
      const changed = kind === 'cycle' ? outcome.boardEvents > 0 : outcome.tasksAdded > 0;
      last = { ...last, quiet: changed ? 0 : (Number(last.quiet) || 0) + 1, folded: last.agent };
      st[slotKey] = last;
    }
    const since = outcome?.ended ? outcome.endedAt : Number.isFinite(last?.at) ? last.at : fallbackSince;
    const f = typeof fp === 'function' ? fp(since) : fp;
    const maxH = maxHoursFor(kind, env);
    let v = wakeVerdict({ kind, fp: f, last, outcome, now, maxH });
    let backoff = null;
    // The back-off is asked even when another rule already skips, so the reason names the wait and the next time.
    if (last && maxH > 0 && Number(last.quiet) > 0 && outcome?.ended && !/ceiling/.test(v.why)) {
      const cutShort = kind === 'cycle'
        ? evs.some((e) => ts(e) > since && ts(e) <= now && isStrongNews(e))
        : (Array.isArray(last.areas) && Array.isArray(f?.areas) && last.areas.some((a) => !f.areas.includes(a))) || (Number.isFinite(last.fullAt) && last.fullAt > last.at);
      backoff = backoffVerdict({ quiet: Number(last.quiet), lastAt: last.at, now, baseMs, maxH, cutShort });
      last = { ...last, due: backoff.due };
      st[slotKey] = last;
      if (backoff.skip) {
        const n = Number(last.quiet);
        v = kind === 'cycle'
          ? { skip: true, why: `backing off: ${n} cycle${n === 1 ? '' : 's'} in a row changed nothing; next regular cycle at ${utc(backoff.due)} (or sooner on an answer, an owner order or a phase change)` }
          : { skip: true, why: `backing off: ${n} queue-depth session${n === 1 ? '' : 's'} in a row added no task; next queue-depth wake at ${utc(backoff.due)} (or sooner when a blocked area frees up or the queue reaches its target)` };
      } else if (cutShort && !v.skip) v = { ...v, why: `${v.why}; the back-off was cut short` };
    }
    if (v.skip) {
      st[slotKey] = { ...last, skips: (Number(last.skips) || 0) + 1, lastSkip: now };
      const label = kind === 'cycle' ? 'regular cycle' : 'queue below its depth target';
      try { emit({ type: 'agent.wake.skipped', agent, to: role, msg: `${role === 'director' ? 'Director' : 'Producer'} wake skipped (${label}): ${v.why}`.slice(0, 400), meta: { kind, role, gate: '2.84', last: last.agent, fingerprint: f?.key || null, ...(backoff?.skip ? { backoff: { quiet: Number(last.quiet), due: new Date(backoff.due).toISOString() } } : {}) } }); } catch { /* the skip stands */ }
    }
    if (last) writeWakeGate(st);
    return { ...v, fp: f, since, backoff };
  } catch (e) { return { skip: false, why: `error: ${e.message}`, fp: typeof fp === 'function' ? null : fp, since: fallbackSince }; }
}

/** After a wake that ran: remember its fingerprint, when, and the session it started (null when none is known). The back-off count carries over until that session's outcome is folded in. */
export function recordWake({ kind, role, fp, agent = null, now = Date.now() } = {}) {
  try {
    const st = readWakeGate();
    const prev = st[slotOf(kind, role)] || {};
    st[slotOf(kind, role)] = { key: fp?.key || null, summary: fp?.summary || (Array.isArray(fp?.lines) ? `${fp.count} change(s)` : null), at: now, agent: agent || null, quiet: Number(prev.quiet) || 0, ...(Array.isArray(fp?.areas) ? { areas: fp.areas } : {}) };
    writeWakeGate(st);
  } catch { /* the next wake runs without a gate */ }
}

/** 2.84 (a2): the queue reached its depth target: a queue-depth back-off ends (its next wake is not held back). */
export function markQueueFull(now = Date.now()) {
  try {
    const st = readWakeGate();
    const k = slotOf('queue-depth', 'producer');
    const s0 = st[k];
    if (!s0 || (Number.isFinite(s0.fullAt) && s0.fullAt > s0.at)) return;
    st[k] = { ...s0, fullAt: now };
    writeWakeGate(st);
  } catch { /* the next pass tries again */ }
}

/**
 * 2.84 (a2): one clause for the mode line when a planning wake is backed off, else ''. E.g. "backed off: the Director's
 * next regular cycle at 16:40 UTC (3 quiet in a row)".
 */
export function backoffClause(now = Date.now()) {
  const st = readWakeGate();
  const parts = [];
  for (const [k, label] of [['cycle:director', "the Director's next regular cycle"], ['cycle:producer', "the Producer's next regular cycle"], ['queue-depth:producer', "the Producer's next queue-depth wake"]]) {
    const s0 = st[k];
    if (s0 && Number(s0.quiet) > 0 && Number.isFinite(s0.due) && s0.due > now) parts.push(`${label} at ${utc(s0.due)} (${s0.quiet} quiet in a row)`);
  }
  return parts.length ? `backed off: ${parts.join('; ')}` : '';
}

/** The lines that open a cycle brief: what changed since this role's last cycle (the digest, 10 lines at most). */
export function digestHeader(role, digest, since) {
  const who = role === 'director' ? 'Director' : role === 'producer' ? 'Producer' : role;
  const head = `# What changed since your last cycle (${who}${since ? `, since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''})`;
  return [head, ...(digest?.lines?.length ? digest.lines.slice(0, 10) : ['- nothing on the board (this cycle ran on its ceiling)'])].join('\n');
}
