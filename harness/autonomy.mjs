#!/usr/bin/env node
/**
 * harness/autonomy.mjs — 2.64.0: the autonomy scorecard. How much the studio needs a person, from the event log.
 *
 *   npm run autonomy                     the last 7 days, with daily buckets and the level badge
 *   npm run autonomy -- --days 14 --json
 *   npm run autonomy -- --now 2026-11-08T00:00:00Z   the window ending then (a replay of an older week)
 *   npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "…"]   2.65.0: set the level (setLevel)
 * 2.65.0: the card also shows the cost per landed task (tokens; dollars only with a studio/prices.json table), the
 * person's round-trips per landed task and orchestrator interventions (conductor.note events).
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
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';
import { weightedTokens } from './token-weight.mjs';

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
/**
 * 2.65.0: an optional price table, studio/prices.json (none ships): { "models": { "<model or tool>": { "in": usd,
 * "out": usd, "cacheRead": usd } } } per million tokens. Without it the scorecard's cost is in tokens only.
 * 2.65.2: cache writes are priced as Anthropic bills them, not as plain input: a 5-minute write at 1.25x the model's
 * input price, a 1-hour write at 2x (a model may set "cacheWrite5m" / "cacheWrite1h" in USD itself). A model with no
 * "cacheRead" price reads at 0.1x its input price, not $0. The multipliers can be set in the file's top-level
 * "multipliers": { "cacheWrite5m": 1.25, "cacheWrite1h": 2, "cacheRead": 0.1 }.
 */
export const PRICES_REL = 'studio/prices.json';
export const DEFAULT_PRICE_MULTIPLIERS = Object.freeze({ cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 });
const readPriceFile = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, PRICES_REL), 'utf8')); } catch { return null; } };
export function readPrices(root = REPO_ROOT) {
  const j = readPriceFile(root);
  return j?.models && typeof j.models === 'object' ? j.models : null;
}
/** 2.65.2: the price file's "multipliers" over DEFAULT_PRICE_MULTIPLIERS (a value that isn't a number >= 0 is ignored). */
export function readPriceMultipliers(root = REPO_ROOT) {
  const m = readPriceFile(root)?.multipliers;
  const out = { ...DEFAULT_PRICE_MULTIPLIERS };
  if (m && typeof m === 'object') for (const k of Object.keys(out)) if (m[k] !== null && m[k] !== '' && Number.isFinite(Number(m[k])) && Number(m[k]) >= 0) out[k] = Number(m[k]);
  return out;
}
const num = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
/**
 * Dollars for session-end events at a price table (by the event's model, else its tool): { usd, unpriced, reported }.
 * 2.65.2: a session whose tool reported its own cost (meta.costUsd, Claude Code's total_cost_usd) counts at that cost
 * (reported); the others are priced from the table, with tokensIn split into plain input and cache writes
 * (meta.cacheWrite, which agent.mjs folds into tokensIn): writes at the 1-hour price for meta.cacheWrite1h, else at
 * the TTL the launcher asked for (meta.cacheTtl), else at the 5-minute price.
 */
export function dollarsOf(ends, prices, multipliers = DEFAULT_PRICE_MULTIPLIERS) {
  const mult = { ...DEFAULT_PRICE_MULTIPLIERS, ...(multipliers || {}) };
  let usd = 0; let unpriced = 0; let reported = 0;
  for (const e of ends) {
    const tin = Number(e.tokensIn) || 0; const tout = Number(e.tokensOut) || 0; const cr = Number(e.meta?.cacheRead ?? e.cacheRead) || 0;
    const cost = num(e.meta?.costUsd);
    if (cost !== null && cost >= 0 && (cost > 0 || !(tin + tout + cr))) { usd += cost; reported += 1; continue; }
    const p = (prices && (prices[e.model] || prices[e.meta?.tool])) || null;
    if (!p) { if (tin + tout + cr) unpriced += 1; continue; }
    const w1hSplit = num(e.meta?.cacheWrite1h); const w5mSplit = num(e.meta?.cacheWrite5m);
    const cw = Math.min(tin, num(e.meta?.cacheWrite) ?? ((w1hSplit || 0) + (w5mSplit || 0)));
    let w1h;
    if (w1hSplit !== null || w5mSplit !== null) w1h = Math.min(cw, w1hSplit ?? Math.max(0, cw - (w5mSplit || 0)));
    else w1h = e.meta?.cacheTtl === '1h' ? cw : 0;
    const w5m = cw - w1h;
    const pin = Number(p.in) || 0;
    const price = (k) => num(p[k]) ?? pin * mult[k];
    usd += ((tin - cw) * pin + w5m * price('cacheWrite5m') + w1h * price('cacheWrite1h') + tout * (Number(p.out) || 0) + cr * price('cacheRead')) / 1e6;
  }
  return { usd, unpriced, reported };
}
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
const SYSTEM = /^(watchdog|train|supervisor|launcher|harness|hub|system|ci|ci-watch|rescue|router|gamedev|director-flow|scheduler|self-triage|done-check|digest|null|undefined|unknown)$/i;
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
export function buildAutonomy(events, { now = Date.now(), days = DEFAULT_AUTONOMY.days, isPersonName, attempts = null, weigh = null, prices = null, priceMultipliers = null } = {}) {
  if (typeof isPersonName !== 'function') throw new Error('buildAutonomy needs isPersonName (await personClassifier())');
  const sorted = [...events].map((e, i) => [ts(e), i, e]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  const from = now - days * DAY;
  const inWin = (t) => t >= from && t <= now;
  const win = sorted.filter((e) => inWin(ts(e)));
  // 2.65.2: without `weigh`, the budget meter's weighting (cache reads at cacheReadWeight), as the CLI and the hub use.
  const weight = weigh || ((e) => weightedTokens(e));

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
  // 2.65.0: cost per merged change, this window and the one before (the trend). Tokens as the tools reported them;
  // dollars only from a price table in config (none ships: tokens only, and the card says so).
  const prevFrom = from - days * DAY;
  const inPrev = (t) => t >= prevFrom && t < from;
  const prevTokens = sorted.filter((e) => e.type === 'agent.session.end' && inPrev(ts(e))).reduce((s, e) => s + weight(e), 0);
  const prevLanded = new Set();
  for (const e of sorted) if (inPrev(ts(e))) for (const t of landingsOf(e)) prevLanded.add(t);
  const cost = { tokensPerLanded: n ? Math.round(tokens / n) : null, previousTokensPerLanded: prevLanded.size ? Math.round(prevTokens / prevLanded.size) : null, dollarsPerLanded: null, priced: false, note: `tokens only: no price table in config (${PRICES_REL})` };
  if (prices && typeof prices === 'object') {
    const d = dollarsOf(win.filter((e) => e.type === 'agent.session.end'), prices, priceMultipliers || DEFAULT_PRICE_MULTIPLIERS);
    Object.assign(cost, { priced: true, dollars: round(d.usd, 2), dollarsPerLanded: n ? round(d.usd / n, 2) : null, unpricedSessions: d.unpriced, reportedSessions: d.reported, note: `at the prices in ${PRICES_REL}${d.reported ? ` (${d.reported} session(s) at the cost their tool reported)` : ''}${d.unpriced ? `; ${d.unpriced} session(s) of a model or tool not in the table are not counted in dollars` : ''}` });
  }
  // 2.65.0: orchestrator interventions: conductor notes (event conductor.note, an outside orchestrator's rulings in a
  // task's record), counted by type so they show once the conductor tools write them; and a person's round-trips
  // (planned and unplanned interventions) per landed task.
  const notes = win.filter((e) => e.type === 'conductor.note');
  const byWho = {};
  for (const e of notes) { const w = String(e.meta?.by || e.agent || 'unknown'); byWho[w] = (byWho[w] || 0) + 1; }
  const orchestrator = { conductorNotes: notes.length, by: byWho, perLanded: n ? round(notes.length / n, 2) : null };
  const roundTripsPerLanded = n ? round((unplanned.length + planned.length) / n, 2) : null;

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
    cost,
    orchestrator,
    roundTripsPerLanded,
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
  if (meets === 'L3' && rank(level) < 3) suggestion = { kind: 'promote', text: `Every L3 bar held for ${cfg.days} days${checks.some((c) => c.na) ? ` (${checks.filter((c) => c.na).map((c) => c.id).join(', ')}: n/a)` : ''}. Suggestion for the owner: move to L3. Your call: npm run autonomy -- level L3 --by <you> (a person, a Producer/Director session or an outside agent on your word); nothing changes on its own.` };
  else if (rank(level) >= 3 && failing.length) suggestion = { kind: 'demote', text: `The studio is at ${level} but ${failing.map((c) => `${c.id} ${c.value} (bar: ${c.bar})`).join('; ')}. Suggestion for the owner: back to L2 until the numbers hold again (npm run autonomy -- level L2 --by <you>).` };
  return { level, meets, checks, suggestion };
}

/** One line for the overnight page and the War Room. */
export function autonomyLine(card, badge) {
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const sug = badge.suggestion.kind ? ` · ${badge.suggestion.kind === 'promote' ? 'suggest L3 (your call)' : 'suggest back to L2'}` : '';
  return `Autonomy (${card.window.days} d): ${badge.level}${badge.meets === 'L3' ? ', meets the L3 bar' : ''} · ${card.hoursBetweenInterventions} h between interventions (${card.interventions.unplanned} unplanned, ${card.interventions.planned} planned) · hands-free ${pct(card.handsFreeLandRate)} of ${card.landed} landed · forced ${pct(card.forcedRate)} · reopened ${pct(card.reopenRate)} · Redo ${pct(card.verdicts.redoRate)} · ${card.tokensPerLanded === null ? 'no task landed' : `${Math.round(card.tokensPerLanded / 1000)}k tokens per landed task${card.cost?.previousTokensPerLanded ? ` (was ${Math.round(card.cost.previousTokensPerLanded / 1000)}k)` : ''}${card.cost?.priced ? (card.cost.dollarsPerLanded !== null ? `, $${card.cost.dollarsPerLanded}` : '') : card.cost ? ', tokens only' : ''}`}${card.roundTripsPerLanded !== null && card.roundTripsPerLanded !== undefined ? ` · ${card.roundTripsPerLanded} person round-trips per landed task` : ''}${card.orchestrator?.conductorNotes ? ` · ${card.orchestrator.conductorNotes} conductor notes` : ''}${sug}`;
}

/**
 * 2.65.0: `npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "…"]`. Sets "level" in
 * studio/autonomy.json, set once; agents then make every decision that level allows, and the scorecard only suggests.
 * Who (the owner's rule, harness/permission.mjs): a person in their own terminal; a launched Producer or Director
 * session; an agent outside the harness on a person's direct permission (--permission, 10+ characters). A worker
 * (a launched builder, qa, ... session, or a worker's name in STUDIO_LOCK_OWNER or --by) never. One autonomy.level
 * event names who and why. Returns { ok, message, from, to }.
 */
export async function setLevel(level, { by, why = '', permission = '', env = process.env, root = REPO_ROOT } = {}) {
  const to = String(level || '').toUpperCase();
  if (!/^L[1-4]$/.test(to)) return { ok: false, message: 'Usage: npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "<the person\'s words or a link>"]' };
  const who = String(by || '').trim();
  if (!who) return { ok: false, message: 'Say who sets it: --by <name>.' };
  const { agentOnPermission, WORKER_NAME, DECIDER_ROLES, AGENT_SHELL } = await import('./permission.mjs');
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const tail = 'The level is set by a person, a Producer or Director session, or an agent outside the harness on a person\'s permission; never by a worker.';
  if (role && !DECIDER_ROLES.test(role)) return { ok: false, message: `Refused: a launched ${role} session can't set the autonomy level. ${tail}` };
  const worker = [owner, who].find((x) => x && WORKER_NAME.test(x));
  if (worker) return { ok: false, message: `Refused: ${worker} is a worker agent. ${tail}` };
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  let rec = { via: 'person' };
  if (role) rec = { via: role.toLowerCase(), recordedBy: owner || `a ${role.toLowerCase()} session` };
  else if (marker || owner) {
    const p = agentOnPermission({ permission, env });
    if (!p.ok) return { ok: false, message: `Refused: an agent outside the harness sets the level only on a person's direct permission: ${p.why}. ${tail}` };
    rec = { via: 'outside agent', recordedBy: p.recordedBy, permission: String(permission).trim().slice(0, 500) };
  } else {
    let agentish = false;
    try { agentish = (await import('./reclassify.mjs')).isAgentName(who); } catch {}
    if (agentish) return { ok: false, message: `Refused: "${who}" is an agent's name; --by is the person setting the level (or run it from that agent's own Producer/Director session).` };
  }
  const file = path.join(root, AUTONOMY_REL);
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { raw = {}; }
  const from = /^L[0-4]$/.test(String(raw.level || '')) ? raw.level : DEFAULT_AUTONOMY.level;
  const note = String(why || '').trim().slice(0, 300);
  const set = { by: who.slice(0, 60), at: new Date().toISOString(), from, ...(note ? { why: note } : {}), via: rec.via, ...(rec.recordedBy ? { recordedBy: rec.recordedBy } : {}), ...(rec.permission ? { permission: rec.permission } : {}) };
  const next = { ...(Object.keys(raw).length ? raw : { note: 'The autonomy level and the bar for L3 (npm run autonomy; docs/AUTONOMY.md).', days: DEFAULT_AUTONOMY.days, l3: { ...DEFAULT_AUTONOMY.l3 } }), level: to, levelSet: set };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const how = rec.recordedBy ? (rec.permission ? ` (recorded by ${rec.recordedBy} on ${who}'s permission: "${rec.permission.slice(0, 120)}")` : ` (a ${rec.via} session: ${rec.recordedBy})`) : '';
  emitEvent({ type: 'autonomy.level', agent: (rec.recordedBy || who).slice(0, 60), to: 'producer', msg: `Autonomy level ${from} -> ${to} by ${who}${how}${note ? `: ${note}` : ''}`.slice(0, 600), meta: { by: who.slice(0, 60), from, to, why: note || null, via: rec.via, ...(rec.recordedBy ? { recordedBy: rec.recordedBy } : {}), ...(rec.permission ? { permission: rec.permission } : {}) } });
  return { ok: true, from, to, message: `Autonomy level ${from} -> ${to} in ${AUTONOMY_REL}, set by ${who}${how}${note ? ` (${note})` : ''}. Commit ${AUTONOMY_REL} so the change is on record.` };
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
  const card = buildAutonomy(evs, { now, days: d, isPersonName, attempts, weigh, prices: readPrices(), priceMultipliers: readPriceMultipliers() });
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
  if (argv[0] === 'level') {
    const r = await setLevel(argv[1], { by: flag('by'), why: flag('why') || '', permission: flag('permission') || '' });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
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
  if (c.cost) console.log(`Cost per landed task: ${c.cost.tokensPerLanded === null ? '-' : `${c.cost.tokensPerLanded.toLocaleString()} tokens`}${c.cost.previousTokensPerLanded ? ` (the ${r.card.window.days} days before: ${c.cost.previousTokensPerLanded.toLocaleString()})` : ''}${c.cost.priced ? `, $${c.cost.dollarsPerLanded ?? '-'} (${c.cost.note})` : ` (${c.cost.note})`}.`);
  console.log(`Person round-trips per landed task: ${c.roundTripsPerLanded ?? '-'}. Orchestrator interventions: ${c.orchestrator.conductorNotes} conductor note(s)${c.orchestrator.conductorNotes ? ` (${Object.entries(c.orchestrator.by).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.`);
  console.log('Days:');
  for (const b of c.buckets) console.log(`  ${b.day}: supervisor ${b.supervisorHours} h, ${b.unplanned} unplanned / ${b.planned} planned, ${b.landed} landed (${b.handsFree} hands-free, ${b.forced} forced)`);
  console.log(`L3 bar (${r.config.file}${r.config.exists ? '' : ', defaults: no file'}${r.config.protected ? '; protected: owner-signed changes only' : '; set by a person, a Producer or Director session or an outside agent, never a worker'}):`);
  for (const k of r.badge.checks) console.log(`  ${k.ok ? 'ok  ' : 'MISS'} ${k.id}: ${k.value} (bar: ${k.bar})${k.na ? ' n/a' : ''}`);
  if (r.badge.suggestion.kind) console.log(r.badge.suggestion.text);
}
