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
 * The fingerprint, the digest and the verdict are pure (inputs in, verdict out); gateWake/recordWake read and write
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
  if (!end) return { ended: false, endedAt: null, boardEvents: boardEventsBy(agent, events, { from: since }) };
  const n = Number(end.meta?.outcome?.boardEvents);
  return { ended: true, endedAt: ts(end), boardEvents: Number.isFinite(n) ? n : boardEventsBy(agent, events, { from: since, to: ts(end) }) };
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
  return { key: sha(facts), summary: `${facts.ready} ready, ${facts.blocked.length} area${facts.blocked.length === 1 ? '' : 's'} blocked`, facts };
}

const PLANNER = /^(producer|director)(-|$)/;
const RED = /^task\.train\.(?:[a-z0-9-]+\.)?(dropped|known_red|died|stalled)$/;
/** The digest's groups, in the order they print: [label, test(e)]. */
const DIGEST = [
  ['landed or done', (e) => e.type === 'task.done' || e.type === 'milestone.closed'],
  ['handed back', (e) => e.type === 'task.paused'],
  ['held, parked or released', (e) => ['task.hold', 'task.held', 'task.unheld', 'task.unblocked'].includes(e.type)],
  ['asks', (e) => e.type === 'ask.open' || e.type === 'ask.answered'],
  ['a person\'s messages and decisions', (e) => e.type === 'inbound.message' || e.type === 'bible.signed' || e.type === 'task.dev_yes' || (e.type === 'decision' && !PLANNER.test(String(e.agent || '')))],
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
 * Returns { skip, why, fp, since }. A skip emits agent.wake.skipped. Never throws (an error: the wake goes ahead).
 */
export function gateWake({ kind, role, fp, now = Date.now(), env = process.env, events = null, fallbackSince = 0, emit = emitEvent, agent = 'supervisor' } = {}) {
  try {
    const st = readWakeGate();
    const last = st[slotOf(kind, role)] || null;
    const evs = events || readRecentEvents(5000);
    const outcome = last?.agent ? sessionOutcomeOf(last.agent, last.at, evs) : null;
    const since = outcome?.ended ? outcome.endedAt : Number.isFinite(last?.at) ? last.at : fallbackSince;
    const f = typeof fp === 'function' ? fp(since) : fp;
    const v = wakeVerdict({ kind, fp: f, last, outcome, now, maxH: maxHoursFor(kind, env) });
    if (v.skip) {
      st[slotOf(kind, role)] = { ...last, skips: (Number(last.skips) || 0) + 1, lastSkip: now };
      writeWakeGate(st);
      const label = kind === 'cycle' ? 'regular cycle' : 'queue below its depth target';
      try { emit({ type: 'agent.wake.skipped', agent, to: role, msg: `${role === 'director' ? 'Director' : 'Producer'} wake skipped (${label}): ${v.why}`.slice(0, 400), meta: { kind, role, gate: '2.84', last: last.agent, fingerprint: f?.key || null } }); } catch { /* the skip stands */ }
    }
    return { ...v, fp: f, since };
  } catch (e) { return { skip: false, why: `error: ${e.message}`, fp: typeof fp === 'function' ? null : fp, since: fallbackSince }; }
}

/** After a wake that ran: remember its fingerprint, when, and the session it started (null when none is known). */
export function recordWake({ kind, role, fp, agent = null, now = Date.now() } = {}) {
  try {
    const st = readWakeGate();
    st[slotOf(kind, role)] = { key: fp?.key || null, summary: fp?.summary || (Array.isArray(fp?.lines) ? `${fp.count} change(s)` : null), at: now, agent: agent || null };
    writeWakeGate(st);
  } catch { /* the next wake runs without a gate */ }
}

/** The lines that open a cycle brief: what changed since this role's last cycle (the digest, 10 lines at most). */
export function digestHeader(role, digest, since) {
  const who = role === 'director' ? 'Director' : role === 'producer' ? 'Producer' : role;
  const head = `# What changed since your last cycle (${who}${since ? `, since ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''})`;
  return [head, ...(digest?.lines?.length ? digest.lines.slice(0, 10) : ['- nothing on the board (this cycle ran on its ceiling)'])].join('\n');
}
