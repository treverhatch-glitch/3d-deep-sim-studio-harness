#!/usr/bin/env node
/**
 * harness/autonomy.mjs — 2.64.0: the autonomy scorecard. How much the studio needs a person, from the event log.
 *
 *   npm run autonomy                     the last 7 days, with daily buckets and the level badge
 *   npm run autonomy -- --days 14 --json
 *   npm run autonomy -- --now 2026-11-08T00:00:00Z   the window ending then (a replay of an older week)
 *
 * A script over .studio/events.jsonl (no model, no tokens). It measures, over the window:
 *   - hours of supervisor running (minus halted time) per UNPLANNED person intervention: a person resuming a halted
 *     supervisor, forcing a task done, stopping an agent, reopening, dropping or reordering a task, unblocking a parked
 *     one, stopping the studio, retyping a task, or sending an away decision back with "redo". Planned reviews (away
 *     "great"/"comment", fun verdicts, intent confirmations, the dev's yes, Bible signing, approvals) are counted apart.
 *   - the hands-free land rate: landed tasks (task done, a train landing, a lane merge) not forced and with no person
 *     event on the task between its claim and its landing;
 *   - the forced-done rate; the reopen/escape rate (reopened, or a bug added --caused-by it, within 7 days of landing);
 *   - hand-backs by failure label (harness/metrics.mjs's labels); the halt wait (supervisor halted until resumed);
 *   - gate catches (train reds and done-check refusals) per landed task, which separates "the agents got better" from
 *     "the gates caught it";
 *   - the owner's Great/Redo verdicts on away cards; tokens per landed task (counted as the overnight page counts them).
 * Who is a person uses the harness's own rules: verdict.mjs isPerson, reclassify.mjs isAgentName (agent shapes, a
 * "-bot" suffix, launched session names), and the harness's own scripts (watchdog, train, supervisor). A decision an
 * agent recorded on a person's direct permission (2.59.1, meta.permission + meta.recordedBy) is the PERSON's
 * intervention: the person decided, the agent only typed it.
 *
 * The level badge: the level the owner set (studio/autonomy.json "level", default L2) and whether the window meets
 * the L3 bar in that file. Moving up is only ever a suggestion shown to the owner; when the studio is at L3 and a
 * metric falls below the bar, a demotion is suggested. Nothing here changes how the studio runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents } from './event.mjs';

export const AUTONOMY_REL = 'studio/autonomy.json';
export const DEFAULT_AUTONOMY = Object.freeze({
  level: 'L2',
  days: 7,
  l3: Object.freeze({
    hoursBetweenInterventions: 8, // more than this many supervisor hours per unplanned intervention
    handsFreeLandRate: 0.8, // at least
    reopenRate: 0.05, // at most
    redoRate: 0.1, // at most (n/a with no away verdicts)
    tierCUnsigned: 0, // at most (n/a until landings carry a risk tier)
    minLanded: 10, // at least this many landed tasks in the window, so a quiet week can't promote
  }),
});
const DAY = 86400000;
const ESCAPE_DAYS = 7;
const ts = (e) => Date.parse(e?.ts) || 0;
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** The owner's config merged over the defaults. Returns { ...config, file, exists }. */
export function readAutonomyConfig(root = REPO_ROOT) {
  const file = path.join(root, AUTONOMY_REL);
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const c = raw && typeof raw === 'object' ? raw : {};
  return { level: /^L[0-4]$/.test(String(c.level || '')) ? c.level : DEFAULT_AUTONOMY.level, days: Number(c.days) > 0 ? Number(c.days) : DEFAULT_AUTONOMY.days, l3: { ...DEFAULT_AUTONOMY.l3, ...(c.l3 && typeof c.l3 === 'object' ? c.l3 : {}) }, file: AUTONOMY_REL, exists: Boolean(raw) };
}

// The harness's own scripts and accounts: never a person.
const SYSTEM = /^(watchdog|train|supervisor|launcher|harness|hub|system|ci|ci-watch|rescue|router|gamedev|director-flow|scheduler|null|undefined|unknown)$/i;
let classifier = null;
/** A person's name? The harness's existing rules (verdict.mjs isPerson + reclassify.mjs isAgentName), cached per name. */
export async function personClassifier() {
  if (classifier) return classifier;
  const { isPerson } = await import('./verdict.mjs');
  let isAgentName = () => false;
  try { ({ isAgentName } = await import('./reclassify.mjs')); } catch {}
  const cache = new Map();
  classifier = (name) => {
    const n = String(name || '').trim();
    if (!n || SYSTEM.test(n)) return false;
    if (!cache.has(n)) cache.set(n, Boolean(isPerson(n)) && !isAgentName(n));
    return cache.get(n);
  };
  return classifier;
}

/** Who acted, and whether a person decided it. { who, person, onPermission }. */
export function actorOf(e, isPersonName) {
  const m = e?.meta || {};
  // 2.59.1: recorded by an agent on a person's direct permission: the person decided.
  if (String(m.permission || '').trim() && String(m.recordedBy || '').trim()) return { who: String(m.by || e.agent || ''), person: true, onPermission: true, recordedBy: String(m.recordedBy) };
  // A done forced past a check that a person accepted with a reason: the person decided.
  if (e.type === 'task.forced' && m.acceptedBy && isPersonName(String(m.acceptedBy))) return { who: String(m.acceptedBy), person: true, onPermission: false };
  if (e.type === 'supervisor.resumed') {
    // Only a person (or an agent on a person's permission, recorded on resume_asked) resumes a halted supervisor.
    const who = String(m.by || '');
    return { who: who || 'a person (War Room)', person: !who || isPersonName(who), onPermission: false };
  }
  const who = String(e.agent || '');
  return { who, person: isPersonName(who), onPermission: false };
}

const UNPLANNED = new Set(['supervisor.resumed', 'task.forced', 'agent.stopped', 'task.reopened', 'task.dropped', 'task.reordered', 'task.unblocked', 'studio.stopped', 'task.retyped']);
const PLANNED = new Set(['playtest.verdict', 'intent.confirmed', 'task.dev_yes', 'bible.signed', 'golden.approved', 'approval.protected']);
/** 'unplanned' | 'planned' | null for one event, given its actor. */
export function interventionKind(e, actor) {
  if (!actor.person) return null;
  if (e.type === 'away.verdict') return (e.status || e.meta?.verdict) === 'redo' ? 'unplanned' : 'planned';
  if (e.type === 'task.hold' && /unparked/i.test(e.msg || '')) return 'unplanned';
  if (UNPLANNED.has(e.type)) return 'unplanned';
  if (PLANNED.has(e.type)) return 'planned';
  return null;
}

/** Landing events: [{ task, at, event, forced }] (a train landing names its lanes in meta.lanes). */
function landingsOf(e) {
  if (e.type === 'task.done' || e.type === 'lane.merged') return e.task ? [e.task] : [];
  if (e.type === 'task.forced') return e.task ? [e.task] : [];
  if (e.type === 'task.train.landed') return Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : [];
  return [];
}

/** Spans [a, b] the supervisor ran: supervisor.start to supervisor.stop; an open one ends at the log's last event. */
function supervisorSpans(events, end) {
  const spans = [];
  let from = null;
  for (const e of events) {
    if (e.type === 'supervisor.start' && from === null) from = ts(e);
    else if (e.type === 'supervisor.stop' && from !== null) { spans.push([from, ts(e)]); from = null; }
  }
  if (from !== null) spans.push([from, Math.min(end, events.length ? ts(events[events.length - 1]) : end)]);
  return spans;
}
/** Spans the supervisor was halted (supervisor.halted to supervisor.resumed), each with its wait. */
function haltSpans(events, end) {
  const spans = [];
  let from = null;
  for (const e of events) {
    if (e.type === 'supervisor.halted' && from === null) from = ts(e);
    else if (e.type === 'supervisor.resumed' && from !== null) { spans.push({ from, to: ts(e), open: false }); from = null; }
  }
  if (from !== null) spans.push({ from, to: end, open: true });
  return spans;
}
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
/** Supervisor running time (minus halts) inside [a, b], in ms. */
function runningMs(a, b, runs, halts) {
  let ms = 0;
  for (const [r0, r1] of runs) {
    const x0 = Math.max(a, r0); const x1 = Math.min(b, r1);
    if (x1 <= x0) continue;
    ms += x1 - x0;
    for (const h of halts) ms -= overlap(x0, x1, h.from, h.to);
  }
  return Math.max(0, ms);
}

/**
 * The scorecard. events: the log (any order); now: the window's end; days: its length.
 * isPersonName: a name -> bool function (personClassifier()); attempts: rows from metrics.mjs attemptRows (optional).
 */
export function buildAutonomy(events, { now = Date.now(), days = DEFAULT_AUTONOMY.days, isPersonName, attempts = null, weigh = null } = {}) {
  if (typeof isPersonName !== 'function') throw new Error('buildAutonomy needs isPersonName (await personClassifier())');
  const sorted = [...events].map((e, i) => [ts(e), i, e]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  const from = now - days * DAY;
  const inWin = (t) => t >= from && t <= now;
  const win = sorted.filter((e) => inWin(ts(e)));
  const weight = weigh || ((e) => (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0) + (Number(e.meta?.cacheRead ?? e.cacheRead) || 0));

  // Interventions. A reopen an away verdict made (same person and task, within 2 min) is that verdict, not a second one.
  const all = [];
  for (const e of sorted) {
    const actor = actorOf(e, isPersonName);
    const kind = interventionKind(e, actor);
    if (kind) all.push({ at: ts(e), ts: e.ts, type: e.type, kind, who: actor.who, task: e.task || null, onPermission: actor.onPermission, ...(actor.recordedBy ? { recordedBy: actor.recordedBy } : {}), verdict: e.type === 'away.verdict' ? (e.status || e.meta?.verdict) : undefined });
  }
  const folded = all.filter((x) => !(x.type === 'task.reopened' && all.some((v) => v.type === 'away.verdict' && v.task && v.task === x.task && v.who === x.who && Math.abs(v.at - x.at) <= 120000)));
  const interventions = folded.filter((x) => inWin(x.at));
  const unplanned = interventions.filter((x) => x.kind === 'unplanned');
  const planned = interventions.filter((x) => x.kind === 'planned');

  // Supervisor hours (halted time excluded) and the hours between unplanned interventions.
  const runs = supervisorSpans(sorted, now);
  const halts = haltSpans(sorted, now);
  const supMs = runningMs(from, now, runs, halts);
  const cuts = [from, ...unplanned.map((x) => x.at), now];
  let longest = 0;
  for (let i = 1; i < cuts.length; i++) longest = Math.max(longest, runningMs(cuts[i - 1], cuts[i], runs, halts));
  const hoursBetween = supMs / 3600000 / Math.max(1, unplanned.length);

  // Landed tasks in the window: the first landing of each.
  const landedAt = new Map(); // task -> { at, forced, viaTrain }
  const landingsByTask = new Map(); // task -> all landing times (whole log)
  for (const e of sorted) {
    for (const t of landingsOf(e)) {
      if (!landingsByTask.has(t)) landingsByTask.set(t, []);
      landingsByTask.get(t).push(ts(e));
      if (!inWin(ts(e))) continue;
      const cur = landedAt.get(t) || { at: ts(e), forced: false, viaTrain: false, people: new Set() };
      if (e.type === 'task.forced') cur.forced = true;
      if (e.type === 'task.train.landed' || e.type === 'lane.merged') cur.viaTrain = true;
      landedAt.set(t, cur);
    }
  }
  const landed = [...landedAt.entries()].map(([task, x]) => ({ task, ...x }));
  // Per-task index (one pass), so each landed task reads only its own events.
  const byTask = new Map();
  const add = (t, e) => { if (!byTask.has(t)) byTask.set(t, []); byTask.get(t).push(e); };
  const causedBy = new Map();
  for (const e of sorted) {
    if (e.task) add(e.task, e);
    if (e.type === 'task.train.landed') for (const t of (e.meta?.lanes || []).map(String)) if (t !== e.task) add(t, e);
    if (e.type === 'task.added' && e.meta?.causedBy) { const k = String(e.meta.causedBy); if (!causedBy.has(k)) causedBy.set(k, []); causedBy.get(k).push(ts(e)); }
  }
  // Hands-free: no person event on the task from the claim that led to this landing up to the landing. A person
  // running the train counts on each lane it landed.
  for (const l of landed) {
    const mine = byTask.get(l.task) || [];
    const prevLand = (landingsByTask.get(l.task) || []).filter((t) => t < l.at).pop() ?? -Infinity;
    const claim = mine.find((e) => e.type === 'task.start' && ts(e) > prevLand && ts(e) <= l.at);
    const start = claim ? ts(claim) : prevLand;
    for (const e of mine) {
      const t = ts(e);
      if (t < start || t > l.at) continue;
      const a = actorOf(e, isPersonName);
      if (a.person) l.people.add(`${e.type}:${a.who}`);
    }
    l.handsFree = !l.forced && l.people.size === 0;
    // Escapes: reopened, or a bug added --caused-by it, within 7 days of landing.
    const within = (t) => t > l.at && t <= l.at + ESCAPE_DAYS * DAY;
    l.escaped = mine.some((e) => e.type === 'task.reopened' && within(ts(e))) || (causedBy.get(l.task) || []).some(within);
  }
  const n = landed.length;
  const rate = (k) => (n ? round(landed.filter(k).length / n, 4) : null);

  // Hand-backs by failure label (metrics.mjs attempts that started in the window and didn't end done).
  let handBacks = null;
  if (Array.isArray(attempts)) {
    const rows = attempts.filter((r) => inWin(Date.parse(r.start) || 0));
    // An attempt that didn't end done (a done later reopened is the reopen rate's, not a hand-back).
    const failed = rows.filter((r) => r.failure && r.outcome !== 'done');
    const byLabel = {};
    for (const r of failed) byLabel[r.failure] = (byLabel[r.failure] || 0) + 1;
    handBacks = { attempts: rows.length, count: failed.length, rate: rows.length ? round(failed.length / rows.length, 4) : null, byLabel };
  }

  // Halt wait: halts that started in the window.
  const hw = halts.filter((h) => inWin(h.from)).map((h) => ({ ...h, min: round((h.to - h.from) / 60000, 1) }));
  const waits = hw.map((h) => h.min).sort((a, b) => a - b);
  const haltWait = { count: hw.length, open: hw.filter((h) => h.open).length, totalMin: round(waits.reduce((s, x) => s + x, 0), 1), medianMin: waits.length ? waits[Math.floor((waits.length - 1) / 2)] : null, maxMin: waits.length ? waits[waits.length - 1] : null };

  // Gate catches per landed task.
  const trainReds = win.filter((e) => e.type === 'task.train.red' || e.type === 'task.train.red_main').length;
  const notDone = win.filter((e) => e.type === 'task.not_done').length;

  // The owner's verdicts on away cards (persons only).
  const av = win.filter((e) => e.type === 'away.verdict' && actorOf(e, isPersonName).person).map((e) => e.status || e.meta?.verdict);
  const verdicts = { great: av.filter((v) => v === 'great').length, redo: av.filter((v) => v === 'redo').length, comment: av.filter((v) => v === 'comment').length };
  const vTotal = verdicts.great + verdicts.redo + verdicts.comment;
  verdicts.redoRate = vTotal ? round(verdicts.redo / vTotal, 4) : null;

  // Tokens per landed task.
  const tokens = win.filter((e) => e.type === 'agent.session.end').reduce((s, e) => s + weight(e), 0);

  // Risk tiers (2.63): a landing that names tier C without a signature. n/a while no landing carries a tier.
  const tiered = win.filter((e) => landingsOf(e).length && e.meta?.tier);
  const tierC = tiered.length ? tiered.filter((e) => String(e.meta.tier).toUpperCase() === 'C' && !(e.meta.signed || e.meta.signature || e.meta.approval)).length : null;

  // Daily buckets: 24 h slices ending at `now`, oldest first.
  const buckets = [];
  for (let i = days; i >= 1; i--) {
    const b0 = now - i * DAY; const b1 = b0 + DAY;
    const inB = (t) => t > b0 && t <= b1;
    const bl = landed.filter((l) => inB(l.at));
    buckets.push({ day: new Date(b0 + DAY / 2).toISOString().slice(0, 10), from: new Date(b0).toISOString(), supervisorHours: round(runningMs(b0, b1, runs, halts) / 3600000, 2), unplanned: unplanned.filter((x) => inB(x.at)).length, planned: planned.filter((x) => inB(x.at)).length, landed: bl.length, handsFree: bl.filter((l) => l.handsFree).length, forced: bl.filter((l) => l.forced).length, tokens: Math.round(win.filter((e) => e.type === 'agent.session.end' && inB(ts(e))).reduce((s, e) => s + weight(e), 0)) });
  }

  const firstEvent = sorted.length ? ts(sorted[0]) : null;
  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days, historyDays: firstEvent === null ? 0 : round((now - firstEvent) / DAY, 2) },
    supervisorHours: round(supMs / 3600000, 2),
    interventions: { unplanned: unplanned.length, planned: planned.length, onPermission: unplanned.filter((x) => x.onPermission).length, list: interventions.map(({ at, ...x }) => x) },
    hoursBetweenInterventions: round(hoursBetween, 2),
    longestStretchHours: round(longest / 3600000, 2),
    landed: n,
    handsFree: landed.filter((l) => l.handsFree).length,
    handsFreeLandRate: rate((l) => l.handsFree),
    forced: landed.filter((l) => l.forced).length,
    forcedRate: rate((l) => l.forced),
    escaped: landed.filter((l) => l.escaped).length,
    reopenRate: rate((l) => l.escaped),
    handBacks,
    haltWait,
    gateCatches: { trainReds, notDone, total: trainReds + notDone, perLanded: n ? round((trainReds + notDone) / n, 2) : null },
    verdicts,
    tokens: Math.round(tokens),
    tokensPerLanded: n ? Math.round(tokens / n) : null,
    tierCUnsigned: tierC,
    tasks: landed.map((l) => ({ task: l.task, landed: new Date(l.at).toISOString(), handsFree: l.handsFree, forced: l.forced, escaped: l.escaped, viaTrain: l.viaTrain, people: [...l.people] })),
    buckets,
  };
}

/** Each L3 bar against a scorecard: [{ id, ok, value, bar, na }]. */
export function l3Checks(card, l3 = DEFAULT_AUTONOMY.l3, days = DEFAULT_AUTONOMY.days) {
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
  return [
    { id: 'history', ok: card.window.historyDays >= days, value: `${card.window.historyDays} days of log`, bar: `${days} days` },
    { id: 'hoursBetweenInterventions', ok: card.hoursBetweenInterventions > l3.hoursBetweenInterventions, value: `${card.hoursBetweenInterventions} h`, bar: `more than ${l3.hoursBetweenInterventions} h` },
    { id: 'minLanded', ok: card.landed >= l3.minLanded, value: `${card.landed} landed`, bar: `at least ${l3.minLanded}` },
    { id: 'handsFreeLandRate', ok: card.handsFreeLandRate !== null && card.handsFreeLandRate >= l3.handsFreeLandRate, value: pct(card.handsFreeLandRate), bar: `at least ${pct(l3.handsFreeLandRate)}` },
    { id: 'reopenRate', ok: card.reopenRate !== null && card.reopenRate <= l3.reopenRate, value: pct(card.reopenRate), bar: `at most ${pct(l3.reopenRate)}` },
    { id: 'redoRate', ok: card.verdicts.redoRate === null || card.verdicts.redoRate <= l3.redoRate, na: card.verdicts.redoRate === null, value: pct(card.verdicts.redoRate), bar: `at most ${pct(l3.redoRate)}` },
    { id: 'tierCUnsigned', ok: card.tierCUnsigned === null || card.tierCUnsigned <= l3.tierCUnsigned, na: card.tierCUnsigned === null, value: card.tierCUnsigned === null ? 'n/a (no risk tiers yet)' : String(card.tierCUnsigned), bar: `at most ${l3.tierCUnsigned}` },
  ];
}

/**
 * The badge and the suggestion. Never changes the level: the owner does, in studio/autonomy.json (signed).
 * { level, meets, checks, suggestion: { kind: 'promote'|'demote'|null, text } }
 */
export function levelBadge(card, cfg = DEFAULT_AUTONOMY) {
  const checks = l3Checks(card, cfg.l3, cfg.days);
  const failing = checks.filter((c) => !c.ok);
  const meets = failing.length ? 'L2' : 'L3';
  const level = cfg.level || 'L2';
  const rank = (l) => Number(String(l).slice(1)) || 0;
  let suggestion = { kind: null, text: '' };
  if (meets === 'L3' && rank(level) < 3) suggestion = { kind: 'promote', text: `Every L3 bar held for ${cfg.days} days${checks.some((c) => c.na) ? ` (${checks.filter((c) => c.na).map((c) => c.id).join(', ')}: n/a)` : ''}. Suggestion for the owner: move to L3. Your call: set "level": "L3" in ${AUTONOMY_REL} and sign it; nothing changes on its own.` };
  else if (rank(level) >= 3 && failing.length) suggestion = { kind: 'demote', text: `The studio is at ${level} but ${failing.map((c) => `${c.id} ${c.value} (bar: ${c.bar})`).join('; ')}. Suggestion for the owner: back to L2 until the numbers hold again (set "level": "L2" in ${AUTONOMY_REL}).` };
  return { level, meets, checks, suggestion };
}

/** One line for the overnight page and the War Room. */
export function autonomyLine(card, badge) {
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const sug = badge.suggestion.kind ? ` · ${badge.suggestion.kind === 'promote' ? 'suggest L3 (your call)' : 'suggest back to L2'}` : '';
  return `Autonomy (${card.window.days} d): ${badge.level}${badge.meets === 'L3' ? ', meets the L3 bar' : ''} · ${card.hoursBetweenInterventions} h between interventions (${card.interventions.unplanned} unplanned, ${card.interventions.planned} planned) · hands-free ${pct(card.handsFreeLandRate)} of ${card.landed} landed · forced ${pct(card.forcedRate)} · reopened ${pct(card.reopenRate)} · Redo ${pct(card.verdicts.redoRate)} · ${card.tokensPerLanded === null ? 'no task landed' : `${Math.round(card.tokensPerLanded / 1000)}k tokens per landed task`}${sug}`;
}

/** Is studio/autonomy.json in the protected list (so only the owner's signed change moves the bar)? */
export async function configProtected() {
  try {
    const { protectedGlobs } = await import('./approve.mjs');
    const { matchAny } = await import('./merge-lane.mjs');
    return matchAny(AUTONOMY_REL, protectedGlobs());
  } catch { return null; }
}

/** Everything the CLI, the overnight page and the War Room show. */
export async function autonomyReport({ now = Date.now(), days = null, events = null, withAttempts = true } = {}) {
  const cfg = readAutonomyConfig();
  const d = Number(days) > 0 ? Number(days) : cfg.days;
  const evs = events || readRecentEvents(200000);
  const isPersonName = await personClassifier();
  let attempts = null;
  if (withAttempts) { try { attempts = (await import('./metrics.mjs')).attemptRows(evs, { now }); } catch {} }
  let weigh = null;
  try { const { weightedTokens } = await import('./budget.mjs'); weigh = (e) => weightedTokens(e); } catch {}
  const card = buildAutonomy(evs, { now, days: d, isPersonName, attempts, weigh });
  const badge = levelBadge(card, { ...cfg, days: d });
  return { card, badge, line: autonomyLine(card, badge), config: { file: cfg.file, exists: cfg.exists, level: cfg.level, l3: cfg.l3, protected: await configProtected() } };
}

let cached = null;
/** The War Room's card (GET /api/autonomy): the report without the per-task rows, recomputed at most every STUDIO_AUTONOMY_CACHE_S (300) s. */
export async function autonomyCard({ now = Date.now() } = {}) {
  const ttl = Number(process.env.STUDIO_AUTONOMY_CACHE_S ?? 300) * 1000;
  if (cached && now - cached.at < ttl) return cached.card;
  const r = await autonomyReport({ now });
  const { tasks, ...card } = r.card;
  card.interventions = { ...card.interventions, list: card.interventions.list.slice(-8) };
  cached = { at: now, card: { ...card, badge: r.badge, line: r.line, config: r.config } };
  return cached.card;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const at = flag('now') ? Date.parse(flag('now')) : Date.now(); // --now <ISO>: score a past window (a replay)
  if (!Number.isFinite(at)) { console.error('Usage: npm run autonomy [-- --days 7] [--now <ISO time>] [--json]'); process.exit(1); }
  const r = await autonomyReport({ days: flag('days'), now: at });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const c = r.card;
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
  console.log(r.line);
  console.log(`Supervisor ran ${c.supervisorHours} h (halts excluded); longest stretch without an unplanned intervention ${c.longestStretchHours} h.`);
  console.log(`Interventions: ${c.interventions.unplanned} unplanned (${c.interventions.onPermission} recorded by an agent on a person's permission), ${c.interventions.planned} planned reviews.`);
  console.log(`Landed ${c.landed}: ${c.handsFree} hands-free (${pct(c.handsFreeLandRate)}), ${c.forced} forced (${pct(c.forcedRate)}), ${c.escaped} reopened or caused a bug within 7 days (${pct(c.reopenRate)}).`);
  if (c.handBacks) console.log(`Hand-backs: ${c.handBacks.count} of ${c.handBacks.attempts} attempts (${pct(c.handBacks.rate)})${Object.keys(c.handBacks.byLabel).length ? `: ${Object.entries(c.handBacks.byLabel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}.`);
  console.log(`Halts: ${c.haltWait.count}${c.haltWait.open ? ` (${c.haltWait.open} still waiting)` : ''}, waited ${c.haltWait.totalMin ?? 0} min in all (median ${c.haltWait.medianMin ?? '-'}, longest ${c.haltWait.maxMin ?? '-'}).`);
  console.log(`Gate catches: ${c.gateCatches.trainReds} train reds, ${c.gateCatches.notDone} done-check refusals (${c.gateCatches.perLanded ?? '-'} per landed task).`);
  console.log(`Away verdicts: ${c.verdicts.great} great, ${c.verdicts.redo} redo, ${c.verdicts.comment} comment (Redo ${pct(c.verdicts.redoRate)}). Tokens: ${c.tokens.toLocaleString()} (${c.tokensPerLanded === null ? '-' : c.tokensPerLanded.toLocaleString()} per landed task).`);
  console.log('Days:');
  for (const b of c.buckets) console.log(`  ${b.day}: supervisor ${b.supervisorHours} h, ${b.unplanned} unplanned / ${b.planned} planned, ${b.landed} landed (${b.handsFree} hands-free, ${b.forced} forced)`);
  console.log(`L3 bar (${r.config.file}${r.config.exists ? '' : ', defaults: no file'}${r.config.protected ? '; protected: owner-signed changes only' : '; set by a person, a Producer or Director session or an outside agent, never a worker'}):`);
  for (const k of r.badge.checks) console.log(`  ${k.ok ? 'ok  ' : 'MISS'} ${k.id}: ${k.value} (bar: ${k.bar})${k.na ? ' n/a' : ''}`);
  if (r.badge.suggestion.kind) console.log(r.badge.suggestion.text);
}
