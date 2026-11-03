#!/usr/bin/env node
/**
 * harness/autonomy.mjs — 2.64.0: the autonomy scorecard. How much the studio needs a person, from the event log.
 *
 *   npm run autonomy                     the last 7 days, with daily buckets and the level badge
 *   npm run autonomy -- --days 14 --json
 *   npm run autonomy -- --now 2026-11-08T00:00:00Z   the window ending then (a replay of an older week)
 *   npm run autonomy -- --since 2026-11-01T00:00:00Z  2.66.0: the window from then to now (or to --now)
 * 2.66.0: a "Tokens" block (tokenWork): the effective-token ratio (tokens of sessions whose task landed and stayed
 * landed for keepDays, over all judged tokens), the cost per kept change (also per task type) and the waste split
 * (reopened / reverted or redone / handed back / dropped / no task), with pending landings apart; --json: card.tokenWork.
 *   npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "…"]   2.65.0: set the level (setLevel)
 *   npm run autonomy -- mode autonomous on|off --by <game dev> [--agent <name>]   2.71.0: propose autonomous mode (the
 *     owner confirms: npm run policy -- confirm) or pause it at once (harness/policy.mjs)
 *   npm run autonomy -- impact [--release <version>] [--days 3] [--json]   2.68.0: a harness upgrade's before vs after
 *     (harness/impact.mjs)
 *   npm run autonomy -- routing [--days 14] [--json]   2.73.0 (e): cheap-first routing's success rate and tokens per
 *     landed change by task type and tier (harness/routing.mjs); the holdout is off
 * 2.73.0 (e): the L3 bar's rates are judged at a one-sided Wilson bound ("confidence", default 0.9) for a promotion and
 * as point estimates for a demotion; a failed audit (harness/audit.mjs) counts as a Redo.
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
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents, emitEvent } from './event.mjs';
import { weightedTokens, cacheReadWeight } from './token-weight.mjs';
import { buildAttempts } from './metrics.mjs';

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
/**
 * 2.67.0: where the prices come from, for the card: { file, checked, placeholder } or null with no table. The file
 * ships with defaults for the Claude families ("opus", "sonnet", "haiku") and a "checked" date the owner sets after
 * comparing them with the provider's price page ("UNVERIFIED" until then).
 */
export function readPriceInfo(root = REPO_ROOT) {
  const j = readPriceFile(root);
  if (!(j?.models && typeof j.models === 'object')) return null;
  const checked = String(j.checked ?? '').trim().slice(0, 40) || null;
  return { file: PRICES_REL, checked, placeholder: !checked || /unverified|placeholder/i.test(checked) };
}
/**
 * 2.67.0: the price row for a session: its model's own row, else its tool's, else the longest family key the model
 * names as a word ("claude-opus-4-5" -> "opus"), so the shipped family rows price full model ids.
 */
export function priceFor(prices, model, tool) {
  if (!prices || typeof prices !== 'object') return null;
  if (model && prices[model]) return prices[model];
  if (tool && prices[tool]) return prices[tool];
  const m = String(model || '').toLowerCase();
  if (!m || m === 'unknown') return null;
  let best = null;
  for (const k of Object.keys(prices)) {
    const kk = k.toLowerCase();
    if (kk.length < 3 || !prices[k] || typeof prices[k] !== 'object') continue;
    if (new RegExp(`(?<![a-z0-9])${kk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(m) && (!best || kk.length > best.length)) best = k;
  }
  return best ? prices[best] : null;
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
  let usd = 0; let unpriced = 0; let reported = 0; let priced = 0;
  for (const e of ends) {
    const tin = Number(e.tokensIn) || 0; const tout = Number(e.tokensOut) || 0; const cr = Number(e.meta?.cacheRead ?? e.cacheRead) || 0;
    const cost = num(e.meta?.costUsd);
    if (cost !== null && cost >= 0 && (cost > 0 || !(tin + tout + cr))) { usd += cost; reported += 1; continue; }
    const p = priceFor(prices, e.model, e.meta?.tool);
    if (!p) { if (tin + tout + cr) unpriced += 1; continue; }
    if (tin + tout + cr) priced += 1;
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
  return { usd, unpriced, reported, priced };
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
  return { level: /^L[0-4]$/.test(String(c.level || '')) ? c.level : DEFAULT_AUTONOMY.level, days: Number(c.days) > 0 ? Number(c.days) : DEFAULT_AUTONOMY.days, l3: { ...DEFAULT_AUTONOMY.l3, ...(c.l3 && typeof c.l3 === 'object' ? c.l3 : {}) }, keepDays: keepDaysOf(c), minSample: Number(c.minSample) >= 1 ? Math.round(Number(c.minSample)) : DEFAULT_MIN_SAMPLE, ...(c.confidence !== undefined ? { confidence: c.confidence } : {}), file: AUTONOMY_REL, exists: Boolean(raw) };
}

/**
 * 2.66.0: tokens that do work. A landed change is KEPT when, within keepDays of its landing, it was not reopened,
 * reverted (a later commit `Revert "…<task>…"`, or a merge-train hand-back of the same task after it landed) or redone
 * (a task added naming it: --caused-by, meta.redoOf / meta.fixes, or "redo of <task>" / "fixes <task>" in its title).
 * A landing younger than keepDays with none of those yet is PENDING, reported apart (not counted either way).
 * keepDays: STUDIO_KEEP_DAYS, else studio/autonomy.json "keepDays", else 7. Any rate on fewer than minSample items
 * (studio/autonomy.json "minSample", default 30) reads "not enough data (n=…)" with its Wilson 95% interval.
 */
export const DEFAULT_KEEP_DAYS = 7;
export const DEFAULT_MIN_SAMPLE = 30;
export function keepDaysOf(c = {}, env = process.env) {
  for (const v of [env.STUDIO_KEEP_DAYS, c?.keepDays]) if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
  return DEFAULT_KEEP_DAYS;
}
/** Wilson score interval (95% two-sided by default) for k successes in n: [low, high], or null with n = 0. */
export function wilson(k, n, z = 1.96) {
  if (!(n > 0)) return null;
  const p = Math.min(1, Math.max(0, k / n)); const z2 = z * z;
  const den = 1 + z2 / n; const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}
/**
 * 2.73.0 (e): the L3 bar's confidence. Point estimates let 10 lucky landings suggest L3; promotion now needs the one-
 * sided bound at this confidence to clear each rate bar (the hands-free rate's LOWER bound at or above its bar, the
 * reopen and redo rates' UPPER bounds at or below theirs). studio/autonomy.json "confidence" (the owner's), else
 * STUDIO_L3_CONFIDENCE, else 0.9. 0 means point estimates (the old behaviour). Demotion always reads point estimates.
 */
export const DEFAULT_L3_CONFIDENCE = 0.9;
export function l3Confidence(fileValue = undefined, env = process.env) {
  for (const v of [fileValue, env.STUDIO_L3_CONFIDENCE]) {
    if (v === undefined || v === null || v === '') continue;
    const x = Number(v);
    if (Number.isFinite(x) && x >= 0 && x < 1) return x;
  }
  return DEFAULT_L3_CONFIDENCE;
}
/** The standard normal quantile (Acklam's approximation, |error| < 1.2e-9): z with P(Z <= z) = p, 0 < p < 1. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) return p >= 1 ? Infinity : -Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5; const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
/** One-sided Wilson bound at `confidence`: side 'lower' | 'upper'; null with n = 0; the point estimate with confidence 0. */
export function wilsonBound(k, n, confidence, side) {
  if (!(n > 0)) return null;
  if (!(confidence > 0)) return Math.min(1, Math.max(0, k / n));
  const w = wilson(k, n, normalQuantile(confidence));
  return side === 'lower' ? w[0] : w[1];
}
/**
 * How many more landings (or reviews) at the current rate would make the bound clear the bar: a count, 0 when it
 * already clears, null when it never would at this rate (the rate itself is on the wrong side of the bar) or n = 0.
 */
export function moreToClear(k, n, bar, confidence, side, cap = 5000) {
  if (!(n > 0)) return null;
  const p = k / n;
  const clears = (kk, nn) => { const b = wilsonBound(kk, nn, confidence, side); return side === 'lower' ? b >= bar - 1e-12 : b <= bar + 1e-12; };
  if (clears(k, n)) return 0;
  if (side === 'lower' ? p <= bar : p >= bar) return null;
  for (let m = 1; m <= cap; m++) if (clears(p * (n + m), n + m)) return m;
  return null;
}
/** A rate with its sample: { k, n, rate, low, high, enough, text }. Under minSample the text never shows a bare percentage. */
export function sampledRate(k, n, minSample = DEFAULT_MIN_SAMPLE) {
  const w = wilson(k, n);
  const p1 = (x) => `${Math.round(x * 1000) / 10}%`;
  const enough = n >= minSample;
  const text = !(n > 0) ? 'no data (n=0)' : enough ? `${p1(k / n)} (95% interval ${p1(w[0])}-${p1(w[1])}, n=${round(n, 1)})` : `not enough data (n=${round(n, 1)}; 95% interval ${p1(w[0])}-${p1(w[1])})`;
  return { k: round(k, 2), n: round(n, 2), rate: n > 0 ? round(k / n, 4) : null, low: w ? round(w[0], 4) : null, high: w ? round(w[1], 4) : null, enough, text };
}
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * 2.71.1 (B): tokens per landed change from the sessions that name their task (agent.session.end's task, or meta.task):
 * { sessions, named, tasks: landed tasks with at least one named session, tokensPerLandedNamed (their mean), top: the
 * five costliest [{ task, tokens, sessions }] }. Sessions that name no task are left to the window average.
 */
export function tokensByLandedTask(ends, landedTasks, weightOf) {
  const landed = new Set((landedTasks || []).map(String));
  const per = new Map();
  let named = 0;
  for (const e of ends || []) {
    const t = String(e.task || e.meta?.task || '');
    if (!t) continue;
    named += 1;
    if (!landed.has(t)) continue;
    const r = per.get(t) || { task: t, tokens: 0, sessions: 0 };
    r.tokens += Number(weightOf(e)) || 0;
    r.sessions += 1;
    per.set(t, r);
  }
  const rows = [...per.values()].map((r) => ({ ...r, tokens: Math.round(r.tokens) })).sort((a, b) => b.tokens - a.tokens);
  return { sessions: (ends || []).length, named, tasks: rows.length, tokensPerLandedNamed: rows.length ? Math.round(rows.reduce((n, r) => n + r.tokens, 0) / rows.length) : null, top: rows.slice(0, 5) };
}

/** Does this text name the task id as a whole word (T-1 is not T-12)? */
export const namesTask = (text, id) => Boolean(id) && new RegExp(`(?<![\\w-])${reEsc(id)}(?![\\w])`).test(String(text || ''));
/** A revert commit subject naming the task: `Revert "…<task>…"` (what git revert writes). */
export const revertNames = (subject, id) => /^\s*Revert\s+"/i.test(String(subject || '')) && namesTask(subject, id);
/**
 * Revert commits on the checked-out branch since `sinceMs`: [{ at, subject }]. One `git log` (no shell, so the same on
 * Windows); [] when git or the repo isn't there.
 */
export function revertCommits(root = REPO_ROOT, sinceMs = 0) {
  try {
    const args = ['log', '--format=%ct%x1f%s', '--grep=^Revert "'];
    if (sinceMs > 0) args.push(`--since=${new Date(sinceMs).toISOString()}`);
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (r.status !== 0) return [];
    return String(r.stdout || '').split('\n').filter(Boolean).map((l) => { const [t, ...s] = l.split('\x1f'); return { at: Number(t) * 1000, subject: s.join('\x1f') }; }).filter((x) => Number.isFinite(x.at));
  } catch { return []; }
}
/** The tasks a task.added event names as the work it redoes or fixes: --caused-by, meta.redoOf / meta.fixes, or "redo of T-…" / "fixes T-…" in its title. */
export function redoTargets(e) {
  if (e?.type !== 'task.added') return [];
  const out = new Set([e.meta?.causedBy, e.meta?.redoOf, e.meta?.fixes].filter(Boolean).map(String));
  for (const m of String(e.msg || '').matchAll(/\b(?:redo(?:es)? of|redoes|fix(?:es)? for|fixes)\s+([A-Z][A-Z0-9]*-\d+)(?![\w])/gi)) out.add(m[1]);
  if (e.task) out.delete(String(e.task));
  return [...out];
}
/** A merge-train hand-back (task.paused "Handed back <task>: Not landed by merge train …", train.mjs handBack). */
const trainHandBack = (e) => e.type === 'task.paused' && /Not landed by merge train/i.test(String(e.msg || ''));
/** The type a task.added event's title gives when no typing function is passed: meta.type, else its "Bug: …" prefix. */
const KNOWN_PREFIX = /^(bug|fix|chore|study|balance|fun|playtest|review|docs|idea|rescue|system|direction)\b/i;
function defaultTypeOf(t) {
  if (t.retyped) return t.retyped;
  if (t.metaType) return String(t.metaType);
  const m = String(t.title || '').match(KNOWN_PREFIX);
  if (m) return m[1].toLowerCase() === 'fix' ? 'bug' : m[1].toLowerCase();
  return 'change';
}

/**
 * 2.66.0: the Tokens block. sorted: the whole log by time; the window is [from, now]. Each agent.session.end in the
 * window is shared among the task attempts it held (metrics.mjs buildAttempts; an attempt belongs to its agent's first
 * session end at or after its start, shared by wall time as attemptRows shares tokens). Each attempt falls in one bucket:
 *   kept / reopened / revertedOrRedone (the landing it led to, judged over keepDays) · pending (that landing is younger
 *   than keepDays, or the attempt is still open) · handedBack (no landing before the next claim) · dropped (the task
 *   was dropped or shelved after it) · noTask (a session that held no attempt: Producer, Director, reviews, …).
 * Effective-token ratio = kept tokens / judged tokens (all minus pending). Cost per kept change = judged tokens and $ /
 * kept landings in the window (also per task type, without noTask).
 */
export function tokenWork(sorted, { from, now, judgedAt = null, keepDays = DEFAULT_KEEP_DAYS, minSample = DEFAULT_MIN_SAMPLE, weight = null, prices = null, priceMultipliers = null, reverts = [], typeOfTask = null } = {}) {
  const K = keepDays * DAY;
  if (typeof weight !== 'function') { const crw = cacheReadWeight(); weight = (e) => weightedTokens(e, crw); }
  const lastTs = sorted.length ? ts(sorted[sorted.length - 1]) : 0;
  const judged = Number.isFinite(judgedAt) && judgedAt ? judgedAt : Math.max(now, lastTs);
  const inWin = (t) => t >= from && t <= now;
  const byTask = new Map(); const redoneAt = new Map(); const tasks = new Map();
  const push = (t, e) => { if (!byTask.has(t)) byTask.set(t, []); byTask.get(t).push(e); };
  for (const e of sorted) {
    if (e.task) push(e.task, e);
    for (const t of landingsOf(e)) if (t !== e.task) push(t, e);
    if (e.type === 'task.added') {
      for (const t of redoTargets(e)) { if (!redoneAt.has(t)) redoneAt.set(t, []); redoneAt.get(t).push(e); }
      if (e.task) { const m = String(e.msg || '').match(/^Queued \S+ \[[^\]]*\] \(([^)]*)\): ([\s\S]*)$/); tasks.set(e.task, { id: e.task, title: m ? m[2] : String(e.meta?.title || ''), role: m ? m[1] : null, metaType: e.meta?.type || null, retyped: null }); }
    }
    if (e.type === 'task.retyped' && e.task && e.meta?.to) { const t = tasks.get(e.task) || { id: e.task, title: '', role: null, metaType: null }; t.retyped = String(e.meta.to); tasks.set(e.task, t); }
  }
  const typeCache = new Map();
  const typeOf = (id) => {
    if (!typeCache.has(id)) {
      const t = tasks.get(id) || { id, title: '', role: null, metaType: null, retyped: null };
      let ty = null;
      if (typeof typeOfTask === 'function') { try { ty = typeOfTask(t); } catch { ty = null; } }
      typeCache.set(id, String(ty || defaultTypeOf(t)));
    }
    return typeCache.get(id);
  };
  // Landing times per task (first landing of each cluster: a train landing and its task.done count once).
  const landTimes = new Map();
  for (const [t, evs] of byTask) {
    const xs = evs.filter((e) => landingsOf(e).includes(t)).map(ts);
    if (xs.length) landTimes.set(t, xs);
  }
  /** A landing's fate: 'kept' | 'reopened' | 'revertedOrRedone' | 'pending', with the evidence. */
  const fateCache = new Map();
  const fateOf = (task, L) => {
    const key = `${task}@${L}`;
    if (fateCache.has(key)) return fateCache.get(key);
    const within = (t) => t > L && t <= L + K;
    const mine = byTask.get(task) || [];
    let f = null;
    const reo = mine.find((e) => e.type === 'task.reopened' && within(ts(e)));
    if (reo) f = { fate: 'reopened', why: `reopened ${reo.ts}` };
    if (!f) { const r = (reverts || []).find((x) => within(Number(x.at)) && revertNames(x.subject, task)); if (r) f = { fate: 'revertedOrRedone', why: `reverted: ${String(r.subject).slice(0, 120)}` }; }
    if (!f) { const h = mine.find((e) => trainHandBack(e) && within(ts(e))); if (h) f = { fate: 'revertedOrRedone', why: `handed back by the merge train after landing (${h.ts})` }; }
    if (!f) { const a = (redoneAt.get(task) || []).find((e) => within(ts(e))); if (a) f = { fate: 'revertedOrRedone', why: `redone by ${a.task}` }; }
    if (!f) f = L + K > judged ? { fate: 'pending', why: `landed less than ${keepDays} day(s) before ${new Date(judged).toISOString()}` } : { fate: 'kept', why: '' };
    fateCache.set(key, f);
    return f;
  };
  // Attempts: which landing each led to (a landing after its start and before the task's next claim).
  const attempts = buildAttempts(sorted, { now: judged });
  const byTaskAttempts = new Map();
  for (const a of attempts) { if (!byTaskAttempts.has(a.task)) byTaskAttempts.set(a.task, []); byTaskAttempts.get(a.task).push(a); }
  for (const [task, as] of byTaskAttempts) {
    as.sort((x, y) => x.start - y.start);
    const lands = landTimes.get(task) || [];
    const ends = (byTask.get(task) || []).filter((e) => e.type === 'task.dropped' || e.type === 'task.shelved').map(ts);
    as.forEach((a, i) => {
      const next = i + 1 < as.length ? as[i + 1].start : Infinity;
      const L = lands.find((t) => t >= a.start && t < next);
      if (L !== undefined) { const f = fateOf(task, L); a.bucket = f.fate; a.landedAt = L; return; }
      if (a.outcome === 'open') { a.bucket = 'pending'; return; }
      if (ends.some((t) => t >= a.start && t < next) || ['dropped', 'shelved'].includes(a.outcome)) { a.bucket = 'dropped'; return; }
      // A hand-back is judged with its task (so a young window doesn't count failures at once and successes keepDays
      // later): pending while the landing that followed is pending, or, with no landing yet, for keepDays after it.
      const later = lands.find((t) => t >= a.start);
      a.bucket = later !== undefined ? (fateOf(task, later).fate === 'pending' ? 'pending' : 'handedBack') : (a.end ?? judged) + K > judged ? 'pending' : 'handedBack';
    });
  }
  // Each window session's share per attempt.
  const endsByAgent = new Map();
  for (const e of sorted) if (e.type === 'agent.session.end') { const k = String(e.agent || ''); if (!endsByAgent.has(k)) endsByAgent.set(k, []); endsByAgent.get(k).push(e); }
  const held = new Map(); // session end event -> attempts
  const hold = (s, a) => { if (!held.has(s)) held.set(s, []); held.get(s).push(a); };
  // A session end that names its task (e.task or meta.task) holds that task's latest attempt claimed before it ended.
  const named = (e) => String(e.task || e.meta?.task || '');
  const claimed = new Set();
  for (const ends of endsByAgent.values()) for (const s of ends) {
    if (!named(s) || !inWin(ts(s))) continue;
    const a = (byTaskAttempts.get(named(s)) || []).filter((x) => x.start <= ts(s)).pop();
    if (a && !claimed.has(a)) { claimed.add(a); hold(s, a); }
  }
  for (const a of attempts) {
    if (claimed.has(a)) continue;
    const s = (endsByAgent.get(String(a.agent || '')) || []).find((e) => ts(e) >= a.start && !named(e));
    if (s && inWin(ts(s))) hold(s, a);
  }
  const mult = priceMultipliers || DEFAULT_PRICE_MULTIPLIERS;
  const BUCKETS = ['kept', 'reopened', 'revertedOrRedone', 'handedBack', 'dropped', 'noTask', 'pending'];
  const sum = Object.fromEntries(BUCKETS.map((b) => [b, { tokens: 0, usd: 0, sessions: 0 }]));
  const byType = {};
  let total = 0; let usdTotal = 0; let unpriced = 0; let reported = 0; let sessions = 0;
  for (const e of sorted) {
    if (e.type !== 'agent.session.end' || !inWin(ts(e))) continue;
    sessions += 1;
    const w = weight(e);
    const d = dollarsOf([e], prices, mult);
    unpriced += d.unpriced; reported += d.reported;
    total += w; usdTotal += d.usd;
    const as = held.get(e) || [];
    const parts = as.length ? as.map((a) => ({ a, wall: Math.max(0, (a.end ?? judged) - a.start) })) : [{ a: null, wall: 1 }];
    const wallSum = parts.reduce((s, p) => s + p.wall, 0);
    for (const p of parts) {
      const share = wallSum > 0 ? p.wall / wallSum : 1 / parts.length;
      const b = p.a ? p.a.bucket : 'noTask';
      sum[b].tokens += w * share; sum[b].usd += d.usd * share; sum[b].sessions += share;
      if (p.a && b !== 'pending') {
        const ty = typeOf(p.a.task);
        const row = byType[ty] || (byType[ty] = { kept: 0, tokens: 0, usd: 0 });
        row.tokens += w * share; row.usd += d.usd * share;
      }
    }
  }
  // Landings in the window and their fates (each task's landings in the window, once each).
  const landings = [];
  for (const [task, xs] of landTimes) {
    let prev = -Infinity;
    for (const L of xs) {
      // A task.done and the train landing that closed it (or a landing repeated without a claim between) are one landing.
      const claimBetween = (byTask.get(task) || []).some((e) => (e.type === 'task.start' || e.type === 'task.reopened') && ts(e) > prev && ts(e) < L);
      if (prev !== -Infinity && !claimBetween) continue;
      prev = L;
      if (inWin(L)) landings.push({ task, at: new Date(L).toISOString(), type: typeOf(task), ...fateOf(task, L) });
    }
  }
  const kept = landings.filter((l) => l.fate === 'kept');
  for (const l of kept) { const row = byType[l.type] || (byType[l.type] = { kept: 0, tokens: 0, usd: 0 }); row.kept += 1; }
  const decidedLandings = landings.filter((l) => l.fate !== 'pending');
  const judgedTokens = total - sum.pending.tokens; const judgedUsd = usdTotal - sum.pending.usd;
  const judgedSessions = sessions - sum.pending.sessions;
  const dollarsKnown = sessions > 0 && (Boolean(prices && typeof prices === 'object') || unpriced === 0) && (Boolean(prices) || reported > 0);
  const $ = (x) => (dollarsKnown ? round(x, 2) : null);
  const buckets = {};
  for (const b of BUCKETS) buckets[b] = { tokens: Math.round(sum[b].tokens), usd: $(sum[b].usd), sessions: round(sum[b].sessions, 2), ...(b === 'pending' ? {} : { share: sampledRate(judgedTokens > 0 ? (sum[b].tokens / judgedTokens) * judgedSessions : 0, judgedSessions, minSample) }) };
  const etr = sampledRate(judgedTokens > 0 ? (sum.kept.tokens / judgedTokens) * judgedSessions : 0, judgedSessions, minSample);
  etr.tokenRatio = judgedTokens > 0 ? round(sum.kept.tokens / judgedTokens, 4) : null;
  if (dollarsKnown && judgedUsd > 0) etr.dollarRatio = round(sum.kept.usd / judgedUsd, 4);
  const perType = {};
  for (const [ty, r] of Object.entries(byType).sort((a, b) => b[1].tokens - a[1].tokens)) perType[ty] = { kept: r.kept, tokens: Math.round(r.tokens), usd: $(r.usd), tokensPerKept: r.kept ? Math.round(r.tokens / r.kept) : null, dollarsPerKept: r.kept && dollarsKnown ? round(r.usd / r.kept, 2) : null };
  return {
    keepDays, minSample, judgedAt: new Date(judged).toISOString(),
    sessions, tokens: Math.round(total), dollars: $(usdTotal), dollarsKnown, unpricedSessions: unpriced, reportedSessions: reported,
    judgedTokens: Math.round(judgedTokens), judgedDollars: $(judgedUsd), judgedSessions: round(judgedSessions, 2),
    effectiveTokenRatio: etr,
    landed: landings.length, kept: kept.length, pendingLandings: landings.length - decidedLandings.length,
    keepRate: sampledRate(kept.length, decidedLandings.length, minSample),
    costPerKept: { tokens: kept.length ? Math.round(judgedTokens / kept.length) : null, dollars: kept.length && dollarsKnown ? round(judgedUsd / kept.length, 2) : null },
    buckets, perType,
    landings,
  };
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
const PLANNED = new Set(['playtest.verdict', 'intent.confirmed', 'task.dev_yes', 'bible.signed', 'golden.approved', 'approval.protected', 'supervisor.halt_cleared']);
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
/**
 * Spans the supervisor was halted, each with its wait: supervisor.halted to supervisor.resumed, or (2.67.0) to
 * supervisor.halt_cleared (studio:resume clearing a stale halt whose supervisor isn't running), supervisor.stop or a
 * new supervisor.start (a halt lives in the supervisor's own state: a stopped one waits on nothing, a new one starts
 * unhalted). An open span carries its halted event.
 */
const HALT_ENDS = new Set(['supervisor.resumed', 'supervisor.halt_cleared', 'supervisor.stop', 'supervisor.start']);
function haltSpans(events, end) {
  const spans = [];
  let from = null; let ev = null;
  for (const e of events) {
    if (e.type === 'supervisor.halted' && from === null) { from = ts(e); ev = e; }
    else if (HALT_ENDS.has(e.type) && from !== null) { spans.push({ from, to: Math.max(from, ts(e)), open: false, endedBy: e.type }); from = null; ev = null; }
  }
  if (from !== null) spans.push({ from, to: Math.max(from, end), open: true, event: ev });
  return spans;
}
/** 2.67.0: hours after which an open halt whose supervisor isn't running is stale (STUDIO_HALT_STALE_H, default 24). */
export function haltStaleHours(env = process.env) {
  const v = env.STUDIO_HALT_STALE_H;
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 24;
}
/**
 * 2.67.0: the open halt in an event log, or null: { at, who, cause, ageH, stale, supervisorRunning, clear }.
 * supervisorRunning: from the log (a supervisor.start with no stop after it), or the caller's `running` (the status file).
 */
export function openHaltOf(events, { now = Date.now(), running = null, staleH = haltStaleHours(), zone = null } = {}) {
  const sorted = [...events].filter((e) => e && e.ts).sort((a, b) => ts(a) - ts(b));
  const h = haltSpans(sorted, now).find((x) => x.open);
  if (!h) return null;
  let up = null;
  for (const e of sorted) { if (e.type === 'supervisor.start') up = true; else if (e.type === 'supervisor.stop') up = false; }
  const supervisorRunning = typeof running === 'boolean' ? running : Boolean(up);
  const ageH = round((now - h.from) / 3600000, 1);
  const stale = ageH >= staleH && !supervisorRunning;
  const cause = String(h.event?.msg || '').replace(/^Supervisor stopped starting agents:\s*/i, '').slice(0, 300) || 'no cause recorded';
  const zn = typeof zone === 'string' && zone ? zone : (zone || studioZone()).zone;
  const clear = supervisorRunning
    ? 'fix the cause, then npm run studio:resume -- --by <your name> [--why "what you fixed"] (or "Fixed it: try again" in the War Room)'
    : stale
      ? `its supervisor isn't running and it is older than STUDIO_HALT_STALE_H (${staleH} h): npm run studio:resume -- --by <your name> --why "stale halt" clears it (an outside agent adds --permission "<the person's words>")`
      : `its supervisor isn't running, so nothing waits on it; a new npm run studio:start starts unhalted, and npm run studio:resume clears it once it is ${staleH} h old`;
  return { at: new Date(h.from).toISOString(), atLocal: localStamp(h.from, zn), who: String(h.event?.agent || 'supervisor'), cause, ageH, stale, supervisorRunning, staleH, clear };
}

/**
 * 2.67.0: the studio's time zone for daily rows and landing times: STUDIO_TZ (an IANA name this Node knows), else UTC
 * (as before). { zone, source, machine } (machine: this computer's zone, from TZ or the system, for the card's hint
 * "set STUDIO_TZ=<zone>"). TZ alone doesn't switch the card: TZ is often set machine-wide, and the days (and the
 * replays scored on them) would then change with whichever computer printed them.
 */
const zoneOk = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
export function studioZone(env = process.env) {
  for (const k of ['STUDIO_TZ']) {
    const z = String(env[k] || '').trim().replace(/^:/, '');
    if (z && zoneOk(z)) return { zone: z, source: k };
  }
  let machine = null;
  try { machine = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch {}
  const tz = String(env.TZ || '').trim().replace(/^:/, '');
  if (tz && zoneOk(tz)) machine = tz;
  return { zone: 'UTC', source: 'default', machine };
}
const ZFMT = new Map();
function zoneParts(ms, zone) {
  const k = zone || 'UTC';
  if (!ZFMT.has(k)) ZFMT.set(k, new Intl.DateTimeFormat('en-US', { timeZone: k, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const p = Object.fromEntries(ZFMT.get(k).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month) - 1, d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}
/** Minutes the zone is ahead of UTC at `ms`. */
export function zoneOffsetMin(ms, zone) {
  const w = zoneParts(ms, zone);
  return Math.round((Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
/** The instant of local midnight starting the local day y-mo-d (day overflow rolls on, as Date.UTC does). */
function localMidnight(y, mo, d, zone) {
  const guess = Date.UTC(y, mo, d);
  const first = guess - zoneOffsetMin(guess, zone) * 60000;
  return guess - zoneOffsetMin(first, zone) * 60000;
}
const pad = (x) => String(x).padStart(2, '0');
/** "YYYY-MM-DD" of `ms` in the zone. */
export const localDate = (ms, zone) => { const w = zoneParts(ms, zone); return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}`; };
/** "YYYY-MM-DD HH:MM +07:00" (UTC: "… UTC"). */
export function localStamp(ms, zone) {
  const w = zoneParts(ms, zone); const off = zoneOffsetMin(ms, zone);
  const o = off === 0 ? 'UTC' : `${off > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)} ${o}`;
}
/** Local calendar days covering [from, now]: [{ day, b0, b1 }] (the first and last may be partial). */
export function localDays(from, now, zone) {
  const out = [];
  let w = zoneParts(from, zone);
  let start = localMidnight(w.y, w.mo, w.d, zone);
  for (let guard = 0; start < now && guard < 400; guard++) {
    w = zoneParts(start + 12 * 3600000, zone);
    const next = localMidnight(w.y, w.mo, w.d + 1, zone);
    const b0 = Math.max(from, start); const b1 = Math.min(now, next);
    if (b1 > b0) out.push({ day: `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}`, b0, b1 });
    start = next;
  }
  return out;
}

/**
 * 2.67.0: orchestrator interventions. An outside orchestrator's own steps, besides its conductor notes: train releases
 * it recorded, lanes refreshes, holds, a stale halt cleared, and the person-only steps (reopen, drop, reorder, force,
 * resume, …) it took. Planned: notes, releases (recorded approvals), refreshes, halt clears, the card's planned types.
 * Unplanned: holds and the card's unplanned types. Its actor: who recorded it (meta.recordedBy), else the event's agent;
 * an outside agent is neither the harness, a worker, a launched Producer/Director session, nor a person acting alone.
 */
const LAUNCHED_DECIDER = /^(producer|director)(-|_|\d|$)/i;
const WORKER_RE = /^(builder|rnd|qa|qa-playtester|playtester|reviewer|art|artist|art-director|designer|designer-calibrator|balancer|fun-tester|scout|reference-scout|engine-porter|dev-hacker|planner|liaison)(-|_|\d|$)/i;
export function orchestratorKind(e) {
  const t = String(e?.type || '');
  if (t === 'conductor.note' || t === 'task.train.released' || t === 'supervisor.halt_cleared' || t.startsWith('lanes.refresh.')) return t === 'lanes.refresh.refused' ? null : 'planned';
  if (t === 'task.hold' || t === 'supervisor.resume_asked' || UNPLANNED.has(t)) return 'unplanned';
  if (PLANNED.has(t)) return 'planned';
  return null;
}
export function orchestratorOf(e, isPersonName) {
  const kind = orchestratorKind(e);
  if (!kind) return null;
  const rec = String(e.meta?.recordedBy || '').trim();
  const who = rec || String(e.agent || '').trim();
  if (!who || SYSTEM.test(who) || WORKER_RE.test(who) || LAUNCHED_DECIDER.test(who) || /^a (producer|director) session$/i.test(who)) return null;
  // A conductor note counts whoever wrote it (2.65.0); the other steps only an agent's (a person's own are interventions).
  if (e.type !== 'conductor.note' && !rec && who !== 'conductor' && isPersonName(who)) return null;
  return { who, kind, type: e.type };
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
export function buildAutonomy(events, { now = Date.now(), days = DEFAULT_AUTONOMY.days, isPersonName, attempts = null, weigh = null, prices = null, priceMultipliers = null, keepDays = null, minSample = DEFAULT_MIN_SAMPLE, reverts = [], typeOfTask = null, judgedAt = null, priceInfo = null, zone = null, supervisorRunning = null } = {}) {
  if (typeof isPersonName !== 'function') throw new Error('buildAutonomy needs isPersonName (await personClassifier())');
  const sorted = [...events].map((e, i) => [ts(e), i, e]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
  const from = now - days * DAY;
  const inWin = (t) => t >= from && t <= now;
  const win = sorted.filter((e) => inWin(ts(e)));
  // 2.65.2: without `weigh`, the budget meter's weighting (cache reads at cacheReadWeight), as the CLI and the hub use.
  // 2.66.0: the cache-read weight read once per scorecard (weightedTokens' default re-read studio/budget.json per event).
  const crw = weigh ? null : cacheReadWeight();
  const weight = weigh || ((e) => weightedTokens(e, crw));

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
      if (e.meta?.tier && !cur.tier) { cur.tier = String(e.meta.tier).toUpperCase(); cur.signed = Boolean(e.meta.signed || e.meta.signature || e.meta.approval || e.meta.released); }
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
  const z = zone && typeof zone === 'object' ? zone : typeof zone === 'string' && zone ? { zone, source: 'given' } : studioZone();
  const oh = hw.some((h) => h.open) ? openHaltOf(sorted, { now, zone: z.zone, running: supervisorRunning }) : null;
  const haltWait = { ...(oh ? { openHalt: oh } : {}), count: hw.length, open: hw.filter((h) => h.open).length, totalMin: round(waits.reduce((s, x) => s + x, 0), 1), medianMin: waits.length ? waits[Math.floor((waits.length - 1) / 2)] : null, maxMin: waits.length ? waits[waits.length - 1] : null };

  // Gate catches per landed task.
  const trainReds = win.filter((e) => e.type === 'task.train.red' || e.type === 'task.train.red_main').length;
  const notDone = win.filter((e) => e.type === 'task.not_done').length;

  // The owner's verdicts on away cards (persons only).
  const av = win.filter((e) => e.type === 'away.verdict' && actorOf(e, isPersonName).person).map((e) => e.status || e.meta?.verdict);
  const verdicts = { great: av.filter((v) => v === 'great').length, redo: av.filter((v) => v === 'redo').length, comment: av.filter((v) => v === 'comment').length };
  const vTotal = verdicts.great + verdicts.redo + verdicts.comment;
  // 2.73.0 (e): audits (harness/audit.mjs): a failed audit of a hands-free landing or an autonomous decision counts as
  // a Redo, a passed one as a review. The last verdict per audit item counts.
  const auditLast = new Map();
  for (const e of win) if (e.type === 'audit.verdict' && e.meta?.of && ['pass', 'fail'].includes(e.meta?.verdict)) auditLast.set(String(e.meta.of), e.meta.verdict);
  verdicts.audited = auditLast.size;
  verdicts.auditFailed = [...auditLast.values()].filter((x) => x === 'fail').length;
  const rTotal = vTotal + verdicts.audited;
  verdicts.redoRate = rTotal ? round((verdicts.redo + verdicts.auditFailed) / rTotal, 4) : null;

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
  // 2.71.1 (B): sessions that name their task (agent.session.end carries it since 2.71.1) are counted per landed task.
  cost.byTask = tokensByLandedTask(win.filter((e) => e.type === 'agent.session.end'), landed.map((l) => l.task), weight);
  if (prices && typeof prices === 'object') {
    // 2.67.0: "prices from <file>, checked <date>"; with a table but no session it can price (or that reported its
    // cost) in the window, the card stays in tokens and says why instead of showing $0.
    const src = `prices from ${priceInfo?.file || PRICES_REL}${priceInfo?.checked ? `, checked ${priceInfo.checked}` : priceInfo ? ', never checked' : ''}${priceInfo?.placeholder ? ' (placeholders: confirm them against the provider\'s price page and set "checked" to that date)' : ''}`;
    const d = dollarsOf(win.filter((e) => e.type === 'agent.session.end'), prices, priceMultipliers || DEFAULT_PRICE_MULTIPLIERS);
    cost.priceSource = { file: priceInfo?.file || PRICES_REL, checked: priceInfo?.checked || null, placeholder: Boolean(priceInfo?.placeholder) };
    if (d.priced + d.reported > 0) Object.assign(cost, { priced: true, dollars: round(d.usd, 2), dollarsPerLanded: n ? round(d.usd / n, 2) : null, unpricedSessions: d.unpriced, reportedSessions: d.reported, note: `${src}${d.reported ? ` (${d.reported} session(s) at the cost their tool reported)` : ''}${d.unpriced ? `; ${d.unpriced} session(s) of a model or tool not in the table are not counted in dollars` : ''}` });
    else Object.assign(cost, { unpricedSessions: d.unpriced, note: `tokens only: no session in the window has a model or tool in the table (${src})` });
  }
  // 2.65.0: orchestrator interventions: conductor notes (event conductor.note, an outside orchestrator's rulings in a
  // task's record), counted by type so they show once the conductor tools write them; and a person's round-trips
  // (planned and unplanned interventions) per landed task.
  const notes = win.filter((e) => e.type === 'conductor.note');
  const byWho = {};
  for (const e of notes) { const w = String(e.meta?.by || e.agent || 'unknown'); byWho[w] = (byWho[w] || 0) + 1; }
  // 2.67.0: and the orchestrator's other steps (orchestratorOf): releases, lanes refreshes, holds, halt clears and
  // person-only steps it recorded, split planned / unplanned; plus the work it reported (npm run usage: outside sessions).
  const steps = win.map((e) => orchestratorOf(e, isPersonName)).filter(Boolean);
  const byType = {}; const stepWho = {};
  for (const s of steps) { byType[s.type] = (byType[s.type] || 0) + 1; stepWho[s.who] = (stepWho[s.who] || 0) + 1; }
  const outsideEnds = win.filter((e) => e.type === 'agent.session.end' && e.meta?.outside);
  const outsideBy = {};
  for (const e of outsideEnds) { const w = String(e.agent || 'unknown'); outsideBy[w] = (outsideBy[w] || 0) + Math.round(weight(e)); }
  const outsideTokens = outsideEnds.reduce((s, e) => s + weight(e), 0);
  const orchestrator = { conductorNotes: notes.length, by: byWho, perLanded: n ? round(notes.length / n, 2) : null,
    interventions: steps.length, planned: steps.filter((s) => s.kind === 'planned').length, unplanned: steps.filter((s) => s.kind === 'unplanned').length, byType, who: stepWho,
    usage: { sessions: outsideEnds.length, tokens: Math.round(outsideTokens), share: tokens > 0 ? round(outsideTokens / tokens, 4) : null, by: outsideBy } };
  const roundTripsPerLanded = n ? round((unplanned.length + planned.length) / n, 2) : null;

  // Risk tiers (2.63): a landing that names tier C without a signature. n/a while no landing carries a tier.
  // 2.67.0: the train records a lane's tier on its own task.train.tier event (meta.tier, meta.released) before the
  // landing, not on task.train.landed, so the old check read n/a forever. A landed task's tier: its landing event's
  // meta.tier, else its latest tier event since its previous landing; a tier-C landing is signed when that tier event
  // names a release or a task.train.released (the owner's release, or one recorded on their permission) came between.
  const tierRows = [];
  for (const l of landed) {
    const mine = byTask.get(l.task) || [];
    const prevLand = (landingsByTask.get(l.task) || []).filter((t) => t < l.at).pop() ?? -Infinity;
    const since = (e) => ts(e) > prevLand && ts(e) <= l.at;
    let tier = l.tier || null; let signed = Boolean(l.signed); let by = null;
    if (!tier) { const te = mine.filter((e) => e.type === 'task.train.tier' && e.meta?.tier && since(e)).pop(); if (te) { tier = String(te.meta.tier).toUpperCase(); if (te.meta.released) { signed = true; by = String(te.meta.released); } } }
    if (tier && !signed) { const re = mine.filter((e) => e.type === 'task.train.released' && since(e)).pop(); if (re) { signed = true; by = String(re.meta?.by || re.agent || ''); } }
    if (tier) tierRows.push({ task: l.task, tier, signed, ...(by ? { releasedBy: by } : {}) });
  }
  const tierC = tierRows.length ? tierRows.filter((r) => r.tier === 'C' && !r.signed).length : null;
  const tiers = { A: tierRows.filter((r) => r.tier === 'A').length, B: tierRows.filter((r) => r.tier === 'B').length, C: tierRows.filter((r) => r.tier === 'C').length, untiered: n - tierRows.length, cUnsigned: tierC, rows: tierRows.filter((r) => r.tier === 'C') };

  // Daily buckets: 24 h slices ending at `now`, oldest first.
  // 2.67.0: calendar days in the studio's zone (studioZone: STUDIO_TZ, else TZ, else UTC), each with its UTC span
  // when the zone isn't UTC; an event at a day's first instant is that day's, and the window's end is the last day's.
  const buckets = [];
  for (const { day, b0, b1 } of localDays(from, now, z.zone)) {
    const inB = (t) => t >= b0 && (t < b1 || (b1 === now && t === now));
    const bl = landed.filter((l) => inB(l.at));
    const off0 = zoneOffsetMin(b0, z.zone); const off1 = zoneOffsetMin(Math.max(b0, b1 - 1), z.zone);
    buckets.push({ day, zone: z.zone, ...(off0 || off1 ? { utc: `${new Date(b0).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(b1).toISOString().slice(0, 16).replace('T', ' ')} UTC` } : {}), from: new Date(b0).toISOString(), supervisorHours: round(runningMs(b0, b1, runs, halts) / 3600000, 2), unplanned: unplanned.filter((x) => inB(x.at)).length, planned: planned.filter((x) => inB(x.at)).length, landed: bl.length, handsFree: bl.filter((l) => l.handsFree).length, forced: bl.filter((l) => l.forced).length, tokens: Math.round(win.filter((e) => e.type === 'agent.session.end' && inB(ts(e))).reduce((s, e) => s + weight(e), 0)) });
  }

  // 2.66.0: tokens that do work (effective-token ratio, cost per kept change, the waste split).
  const work = tokenWork(sorted, { from, now, judgedAt, keepDays: Number(keepDays) > 0 ? Number(keepDays) : keepDaysOf({}), minSample, weight, prices, priceMultipliers, reverts, typeOfTask });

  const firstEvent = sorted.length ? ts(sorted[0]) : null;
  return {
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), days: round(days, 2), historyDays: firstEvent === null ? 0 : round((now - firstEvent) / DAY, 2) },
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
    tiers,
    zone: z,
    tokenWork: work,
    tasks: landed.map((l) => ({ task: l.task, landed: new Date(l.at).toISOString(), landedLocal: localStamp(l.at, z.zone), ...(localDate(l.at, z.zone) !== new Date(l.at).toISOString().slice(0, 10) ? { landedUtcDate: new Date(l.at).toISOString().slice(0, 10) } : {}), handsFree: l.handsFree, forced: l.forced, escaped: l.escaped, viaTrain: l.viaTrain, people: [...l.people] })),
    buckets,
  };
}

/**
 * Each L3 bar against a scorecard: [{ id, ok, value, bar, na }].
 * 2.73.0 (e): with confidence > 0 (l3Confidence) the three rate bars read a one-sided Wilson bound: ok is the bound's
 * verdict (promotion), pointOk the point estimate's (demotion); each also carries { point, bound, k, n, side,
 * confidence, more } (more: landings or reviews at the current rate that would clear it, null: never at this rate).
 * The redo rate counts the owner's Redo verdicts and failed audits (harness/audit.mjs) over verdicts plus audits.
 */
export function l3Checks(card, l3 = DEFAULT_AUTONOMY.l3, days = DEFAULT_AUTONOMY.days, confidence = 0) {
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
  const conf = Number(confidence) > 0 && Number(confidence) < 1 ? Number(confidence) : 0;
  const f2 = (x) => (x === null || x === undefined ? 'n/a' : (Math.round(x * 100) / 100).toFixed(2));
  const v = card.verdicts || {};
  const redoK = (v.redo || 0) + (v.auditFailed || 0);
  const redoN = (v.great || 0) + (v.redo || 0) + (v.comment || 0) + (v.audited || 0);
  const redoPoint = v.redoRate ?? null;
  const unit = (id) => (id === 'redoRate' ? 'review' : 'landing');
  const rated = (id, label, k, n, point, bar, side, naWhenEmpty) => {
    const na = naWhenEmpty && !(n > 0);
    const pointOk = na ? true : point !== null && (side === 'lower' ? point >= bar : point <= bar);
    const pointBar = `${side === 'lower' ? 'at least' : 'at most'} ${pct(bar)}`;
    if (!conf) return { id, ok: pointOk, pointOk, na, value: pct(point), bar: pointBar, pointBar, point, bound: point, k, n, side, confidence: 0 };
    const bound = n > 0 ? round(wilsonBound(k, n, conf, side), 4) : null;
    const ok = na ? true : bound !== null && (side === 'lower' ? bound >= bar - 1e-12 : bound <= bar + 1e-12);
    const more = na || ok ? 0 : moreToClear(k, n, bar, conf, side);
    const cp = `${Math.round(conf * 100)}%`;
    const tail = na ? '' : ok ? ': clears' : more === null ? (n > 0 ? `: not yet; at this rate it never clears (the rate itself is ${side === 'lower' ? 'under' : 'over'} the bar)` : `: not yet (no ${unit(id)} yet)`) : `: not yet; about ${more} more ${unit(id)}${more === 1 ? '' : 's'} at this rate would clear it`;
    const value = na ? `${label} n/a (n=0)` : `${label} ${f2(point)} (${side} bound ${f2(bound)} at ${cp}, n=${n})${tail}`;
    return { id, ok, pointOk, na, value, pointBar, bar: `${side} bound ${side === 'lower' ? 'at least' : 'at most'} ${f2(bar)} at ${cp} (point ${side === 'lower' ? 'at least' : 'at most'} ${pct(bar)})`, point, bound, k, n, side, confidence: conf, more };
  };
  return [
    { id: 'history', ok: card.window.historyDays >= days, value: `${card.window.historyDays} days of log`, bar: `${days} days` },
    { id: 'hoursBetweenInterventions', ok: card.hoursBetweenInterventions > l3.hoursBetweenInterventions, value: `${card.hoursBetweenInterventions} h`, bar: `more than ${l3.hoursBetweenInterventions} h` },
    { id: 'minLanded', ok: card.landed >= l3.minLanded, value: `${card.landed} landed`, bar: `at least ${l3.minLanded}` },
    rated('handsFreeLandRate', 'hands-free', card.handsFree ?? 0, card.landed ?? 0, card.handsFreeLandRate, l3.handsFreeLandRate, 'lower', false),
    rated('reopenRate', 'reopened', card.escaped ?? 0, card.landed ?? 0, card.reopenRate, l3.reopenRate, 'upper', false),
    rated('redoRate', 'redo', redoK, redoN, redoPoint, l3.redoRate, 'upper', true),
    { id: 'tierCUnsigned', ok: card.tierCUnsigned === null || card.tierCUnsigned <= l3.tierCUnsigned, na: card.tierCUnsigned === null, value: card.tierCUnsigned === null ? 'n/a (no landing in the window carries a risk tier)' : `${card.tierCUnsigned}${card.tiers ? ` (tiers of ${card.tiers.A + card.tiers.B + card.tiers.C} landing(s): A ${card.tiers.A}, B ${card.tiers.B}, C ${card.tiers.C}${card.tiers.C ? `, released: ${card.tiers.C - card.tiers.cUnsigned}` : ''})` : ''}`, bar: `at most ${l3.tierCUnsigned}` },
  ];
}

/**
 * The badge and the suggestion. Never changes the level: the owner does, in studio/autonomy.json (signed).
 * { level, meets, checks, confidence, suggestion: { kind: 'promote'|'demote'|null, text } }
 * 2.73.0 (e): promotion needs every bar at its confidence bound (fast to step down, slow to step up); demotion reads
 * the point estimates (pointOk), so a studio at L3 isn't told to step down only because its sample is small.
 */
export function levelBadge(card, cfg = DEFAULT_AUTONOMY, env = process.env) {
  const confidence = l3Confidence(cfg.confidence, env);
  const checks = l3Checks(card, cfg.l3, cfg.days, confidence);
  const failing = checks.filter((c) => !c.ok);
  const pointFailing = checks.filter((c) => !(c.pointOk ?? c.ok));
  const meets = failing.length ? 'L2' : 'L3';
  const level = cfg.level || 'L2';
  const rank = (l) => Number(String(l).slice(1)) || 0;
  const cw = confidence ? ` (rates at their one-sided ${Math.round(confidence * 100)}% bound)` : '';
  let suggestion = { kind: null, text: '' };
  if (meets === 'L3' && rank(level) < 3) suggestion = { kind: 'promote', text: `Every L3 bar held for ${cfg.days} days${cw}${checks.some((c) => c.na) ? ` (${checks.filter((c) => c.na).map((c) => c.id).join(', ')}: n/a)` : ''}. Suggestion for the owner: move to L3. Your call: npm run autonomy -- level L3 --by <you> (a person, a Producer/Director session or an outside agent on your word); nothing changes on its own.` };
  else if (rank(level) >= 3 && pointFailing.length) suggestion = { kind: 'demote', text: `The studio is at ${level} but ${pointFailing.map((c) => `${c.id} ${c.confidence ? pct1(c.point) : c.value} (bar: ${c.pointBar || c.bar})`).join('; ')}. Suggestion for the owner: back to L2 until the numbers hold again (npm run autonomy -- level L2 --by <you>).` };
  return { level, meets, checks, confidence, suggestion };
}
const pct1 = (x) => (x === null || x === undefined ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
/** One line for the overnight page and the War Room. */
export function autonomyLine(card, badge) {
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
  const sug = badge.suggestion.kind ? ` · ${badge.suggestion.kind === 'promote' ? 'suggest L3 (your call)' : 'suggest back to L2'}` : '';
  return `Autonomy (${card.window.days} d): ${badge.level}${badge.meets === 'L3' ? ', meets the L3 bar' : ''} · ${card.hoursBetweenInterventions} h between interventions (${card.interventions.unplanned} unplanned, ${card.interventions.planned} planned) · hands-free ${pct(card.handsFreeLandRate)}${(() => { const h = (badge.checks || []).find((c) => c.id === 'handsFreeLandRate'); return h?.confidence && h.bound !== null && h.bound !== undefined ? ` (lower bound ${pct(h.bound)} at ${Math.round(h.confidence * 100)}%)` : ''; })()} of ${card.landed} landed · forced ${pct(card.forcedRate)} · reopened ${pct(card.reopenRate)} · Redo ${pct(card.verdicts.redoRate)} · ${card.tokensPerLanded === null ? 'no task landed' : `${Math.round(card.tokensPerLanded / 1000)}k tokens per landed task${card.cost?.previousTokensPerLanded ? ` (was ${Math.round(card.cost.previousTokensPerLanded / 1000)}k)` : ''}${card.cost?.priced ? (card.cost.dollarsPerLanded !== null ? `, $${card.cost.dollarsPerLanded}` : '') : card.cost ? ', tokens only' : ''}`}${card.roundTripsPerLanded !== null && card.roundTripsPerLanded !== undefined ? ` · ${card.roundTripsPerLanded} person round-trips per landed task` : ''}${card.orchestrator?.interventions ? ` · ${card.orchestrator.interventions} orchestrator interventions (${card.orchestrator.conductorNotes} conductor notes)` : card.orchestrator?.conductorNotes ? ` · ${card.orchestrator.conductorNotes} conductor notes` : ''}${card.orchestrator?.usage?.sessions ? ` · outside work ${Math.round(card.orchestrator.usage.tokens / 1000)}k tokens` : ''}${sug}`;
}

/** 2.66.0: the CLI's short "Tokens" block (lines). */
export function tokenBlock(w) {
  if (!w) return [];
  const tk = (x) => (x === null || x === undefined ? '-' : x >= 1e6 ? `${Math.round(x / 1e5) / 10}M` : x >= 1e3 ? `${Math.round(x / 100) / 10}k` : String(Math.round(x)));
  const usd = (x) => (x === null || x === undefined ? '' : ` ($${x.toFixed(2)})`);
  const b = w.buckets;
  const share = (k) => (b[k].share?.enough ? ` ${Math.round(b[k].share.rate * 1000) / 10}%` : '');
  const out = [`Tokens (kept = landed and not reopened, reverted, redone or handed back by the train within ${w.keepDays} day(s); ${w.sessions} session(s), ${tk(w.tokens)} weighted tokens${usd(w.dollars)}):`];
  out.push(`  Effective-token ratio (kept / judged tokens): ${w.effectiveTokenRatio.text}${w.effectiveTokenRatio.enough && w.effectiveTokenRatio.dollarRatio !== undefined ? `; by dollars ${Math.round(w.effectiveTokenRatio.dollarRatio * 1000) / 10}%` : ''}.`);
  out.push(`  Cost per kept change: ${w.kept ? `${tk(w.costPerKept.tokens)} tokens${w.costPerKept.dollars !== null ? `, $${w.costPerKept.dollars.toFixed(2)}` : ''}` : 'no kept change yet'} (${w.kept} kept of ${w.landed - w.pendingLandings} judged landing(s); keep rate ${w.keepRate.text}).`);
  out.push(`  Waste: reopened ${tk(b.reopened.tokens)}${usd(b.reopened.usd)}${share('reopened')} · reverted or redone ${tk(b.revertedOrRedone.tokens)}${usd(b.revertedOrRedone.usd)}${share('revertedOrRedone')} · handed back ${tk(b.handedBack.tokens)}${usd(b.handedBack.usd)}${share('handedBack')} · dropped ${tk(b.dropped.tokens)}${usd(b.dropped.usd)}${share('dropped')} · no task ${tk(b.noTask.tokens)}${usd(b.noTask.usd)}${share('noTask')}.`);
  out.push(`  Pending (younger than ${w.keepDays} day(s) or still open; not judged): ${tk(b.pending.tokens)} tokens${usd(b.pending.usd)}, ${w.pendingLandings} landing(s).`);
  const types = Object.entries(w.perType).filter(([, r]) => r.tokens > 0 || r.kept);
  if (types.length) out.push(`  Per kept change by type: ${types.map(([ty, r]) => `${ty} ${r.kept ? `${tk(r.tokensPerKept)}${r.dollarsPerKept !== null ? ` $${r.dollarsPerKept.toFixed(2)}` : ''} (${r.kept} kept)` : `${tk(r.tokens)}, none kept`}`).join(' · ')}.`);
  if (w.unpricedSessions && w.dollars !== null) out.push(`  ${w.unpricedSessions} session(s) of a model or tool not in ${PRICES_REL} are not in the dollars.`);
  return out;
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
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'autonomy-level', subject: AUTONOMY_REL, by: who, as: dm.asOf({ via: rec.via, permission: rec.permission }), why: note || `${from} -> ${to}`, evidence: `${from} -> ${to}`, undo: { kind: 'text', text: `npm run autonomy -- level ${from} --by <name>` } }); } catch {}
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
export async function autonomyReport({ now = Date.now(), days = null, since = null, events = null, withAttempts = true, root = REPO_ROOT } = {}) {
  const cfg = readAutonomyConfig(root);
  // 2.66.0: --since <ISO>: the window from then to `now` (overrides --days).
  const sinceMs = since === null || since === undefined || since === '' ? NaN : (typeof since === 'number' ? since : Date.parse(since));
  const d = Number.isFinite(sinceMs) && sinceMs < now ? (now - sinceMs) / DAY : Number(days) > 0 ? Number(days) : cfg.days;
  const evs = events || readRecentEvents(200000);
  const isPersonName = await personClassifier();
  let attempts = null;
  if (withAttempts) { try { attempts = (await import('./metrics.mjs')).attemptRows(evs, { now }); } catch {} }
  let weigh = null;
  try { const { weightedTokens } = await import('./budget.mjs'); weigh = (e) => weightedTokens(e); } catch {}
  // 2.66.0: the task types done-check uses (title, role, an owner's reclassification), and the revert commits.
  let typeOfTask = null;
  try { const dc = await import('./done-check.mjs'); typeOfTask = (t) => dc.typeOf({ id: t.id, title: t.title, role: t.role }).type; } catch {}
  const reverts = revertCommits(root, now - d * DAY);
  // 2.67.0: is a supervisor running now (its status file and a live pid)? An open halt whose supervisor is gone is stale.
  let supervisorRunning = false;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'supervisor.json'), 'utf8'));
    if (st?.status === 'running' && st.pid) { const { pidAlive } = await import('./proc-identity.mjs'); supervisorRunning = Boolean(pidAlive(st.pid, st.identity, { eperm: false })); }
  } catch {}
  const card = buildAutonomy(evs, { now, days: d, isPersonName, attempts, weigh, prices: readPrices(root), priceMultipliers: readPriceMultipliers(root), priceInfo: readPriceInfo(root), keepDays: cfg.keepDays, minSample: cfg.minSample, reverts, typeOfTask, zone: studioZone(), supervisorRunning });
  const badge = levelBadge(card, { ...cfg, days: round(d, 2) });
  return { card, badge, line: autonomyLine(card, badge), config: { file: cfg.file, exists: cfg.exists, level: cfg.level, l3: cfg.l3, confidence: badge.confidence, keepDays: cfg.keepDays, minSample: cfg.minSample, protected: await configProtected() } };
}

let cached = null;
/** The War Room's card (GET /api/autonomy): the report without the per-task rows, recomputed at most every STUDIO_AUTONOMY_CACHE_S (300) s. */
export async function autonomyCard({ now = Date.now() } = {}) {
  const ttl = Number(process.env.STUDIO_AUTONOMY_CACHE_S ?? 300) * 1000;
  if (cached && now - cached.at < ttl) return cached.card;
  const r = await autonomyReport({ now });
  const { tasks, ...card } = r.card;
  if (card.tokenWork) card.tokenWork = { ...card.tokenWork, landings: card.tokenWork.landings.filter((l) => l.fate !== 'kept').slice(-8) };
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
  // 2.71.0 (x): `mode autonomous on|off --by <game dev>`: on writes a proposal the owner confirms (npm run policy --
  // confirm); off pauses autonomous mode at once (harness/policy.mjs). Never turns anything on by itself.
  if (argv[0] === 'mode') {
    if (argv[1] !== 'autonomous' || !['on', 'off'].includes(argv[2])) { console.error('Usage: npm run autonomy -- mode autonomous on --agent <name> --by <game dev> [--actions …] [--review-h 72] [--why "…"] [--permission "…"]\n       npm run autonomy -- mode autonomous off --by <name> [--why "…"]'); process.exit(2); }
    const r = await (await import('./policy-rules.mjs')).proposeMode({ on: argv[2] === 'on', agent: flag('agent') || '', actions: flag('actions'), reviewH: flag('review-h'), by: flag('by'), why: flag('why') || '', permission: flag('permission') || '' });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  // 2.73.0 (e): cheap-first routing's measures (harness/routing.mjs): success rate and tokens per landed change by task
  // type and tier, from session ends; the holdout is off until the owner turns it on.
  if (argv[0] === 'routing') {
    const rt = await import('./routing.mjs');
    const { readPolicy } = await import('./policy-rules.mjs');
    const rp = rt.routingPolicy(readPolicy());
    const evs = readRecentEvents(200000);
    let typeOfTask = null;
    try {
      const dc = await import('./done-check.mjs');
      const info = new Map();
      for (const e of evs) if (e.type === 'task.added' && e.task) { const m = String(e.msg || '').match(/^Queued \S+ \[[^\]]*\] \(([^)]*)\): ([\s\S]*)$/); info.set(e.task, { id: e.task, title: m ? m[2] : String(e.meta?.title || ''), role: m ? m[1] : null }); }
      typeOfTask = (id) => dc.typeOf(info.get(id) || { id, title: '', role: null }).type;
    } catch {}
    let weight = null;
    try { const { weightedTokens: wt } = await import('./budget.mjs'); weight = (e) => wt(e); } catch {}
    const st = rt.routingStats(evs, { now: flag('now') ? Date.parse(flag('now')) : Date.now(), days: Number(flag('days')) > 0 ? Number(flag('days')) : 14, typeOfTask, weight, holdout: rp.holdout || 0 });
    if (argv.includes('--json')) { console.log(JSON.stringify({ routing: rp, ...st }, null, 2)); process.exit(0); }
    console.log(rt.routingText(st, rp));
    process.exit(0);
  }
  // 2.68.0: the release impact report (harness/impact.mjs): the same measures before vs after a harness upgrade.
  if (argv[0] === 'impact') {
    const r = await (await import('./impact.mjs')).impactCli(argv.slice(1), { root: REPO_ROOT, autonomy: { buildAutonomy, personClassifier } });
    (r.code ? console.error : console.log)(r.text);
    process.exit(r.code);
  }
  const at = flag('now') ? Date.parse(flag('now')) : Date.now(); // --now <ISO>: score a past window (a replay)
  if (!Number.isFinite(at)) { console.error('Usage: npm run autonomy [-- --days 7] [--now <ISO time>] [--json]'); process.exit(1); }
  const since = flag('since');
  if (since !== null && !Number.isFinite(Date.parse(since))) { console.error('Usage: npm run autonomy [-- --days 7 | --since <ISO time>] [--now <ISO time>] [--json]'); process.exit(1); }
  const r = await autonomyReport({ days: flag('days'), since, now: at });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
  const c = r.card;
  const pct = (x) => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);
  console.log(r.line);
  console.log(`Supervisor ran ${c.supervisorHours} h (halts excluded); longest stretch without an unplanned intervention ${c.longestStretchHours} h.`);
  console.log(`Interventions: ${c.interventions.unplanned} unplanned (${c.interventions.onPermission} recorded by an agent on a person's permission), ${c.interventions.planned} planned reviews.`);
  console.log(`Landed ${c.landed}: ${c.handsFree} hands-free (${pct(c.handsFreeLandRate)}), ${c.forced} forced (${pct(c.forcedRate)}), ${c.escaped} reopened or caused a bug within 7 days (${pct(c.reopenRate)}).`);
  if (c.handBacks) console.log(`Hand-backs: ${c.handBacks.count} of ${c.handBacks.attempts} attempts (${pct(c.handBacks.rate)})${Object.keys(c.handBacks.byLabel).length ? `: ${Object.entries(c.handBacks.byLabel).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}.`);
  console.log(`Halts: ${c.haltWait.count}${c.haltWait.open ? ` (${c.haltWait.open} still waiting)` : ''}, waited ${c.haltWait.totalMin ?? 0} min in all (median ${c.haltWait.medianMin ?? '-'}, longest ${c.haltWait.maxMin ?? '-'}).`);
  const oh = c.haltWait.openHalt;
  if (oh) console.log(`  Open halt: since ${oh.atLocal} (${oh.ageH} h), by ${oh.who}: ${oh.cause}. ${oh.stale ? 'Stale: ' : ''}${oh.clear}.`);
  console.log(`Gate catches: ${c.gateCatches.trainReds} train reds, ${c.gateCatches.notDone} done-check refusals (${c.gateCatches.perLanded ?? '-'} per landed task).`);
  console.log(`Away verdicts: ${c.verdicts.great} great, ${c.verdicts.redo} redo, ${c.verdicts.comment} comment (Redo ${pct(c.verdicts.redoRate)}). Tokens: ${c.tokens.toLocaleString()} (${c.tokensPerLanded === null ? '-' : c.tokensPerLanded.toLocaleString()} per landed task).`);
  if (c.cost?.byTask?.tasks) console.log(`Tokens per landed task, from the sessions that name it: ${c.cost.byTask.tokensPerLandedNamed.toLocaleString()} (${c.cost.byTask.tasks} task(s); ${c.cost.byTask.named} of ${c.cost.byTask.sessions} session(s) name their task).`);
  if (c.cost) console.log(`Cost per landed task: ${c.cost.tokensPerLanded === null ? '-' : `${c.cost.tokensPerLanded.toLocaleString()} tokens`}${c.cost.previousTokensPerLanded ? ` (the ${r.card.window.days} days before: ${c.cost.previousTokensPerLanded.toLocaleString()})` : ''}${c.cost.priced ? `, $${c.cost.dollarsPerLanded ?? '-'} (${c.cost.note})` : ` (${c.cost.note})`}.`);
  const o = c.orchestrator;
  console.log(`Person round-trips per landed task: ${c.roundTripsPerLanded ?? '-'}. Orchestrator interventions: ${o.conductorNotes} conductor note(s)${o.conductorNotes ? ` (${Object.entries(o.by).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}${o.interventions ? `; ${o.interventions} step(s) in all by an outside agent or in a conductor note, ${o.planned} planned, ${o.unplanned} unplanned (${Object.entries(o.byType).map(([k, v]) => `${k} ${v}`).join(', ')}; ${Object.entries(o.who).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}.`);
  console.log(o.usage.sessions ? `Outside work (npm run usage): ${o.usage.sessions} session(s), ${o.usage.tokens.toLocaleString()} weighted tokens (${pct(o.usage.share)} of the window's), counted in the tokens and cost above (${Object.entries(o.usage.by).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ')}).` : 'Outside work: none recorded (an orchestrator outside the harness records its sessions with npm run usage -- import <its .jsonl> or usage -- add).');
  if (c.tiers && c.tierCUnsigned !== null) console.log(`Risk tiers of landings: A ${c.tiers.A}, B ${c.tiers.B}, C ${c.tiers.C} (${c.tiers.rows.map((x) => `${x.task} ${x.signed ? `released${x.releasedBy ? ` by ${x.releasedBy}` : ''}` : 'NOT released'}`).join(', ') || 'none'}), ${c.tiers.untiered} without a tier.`);
  for (const l of tokenBlock(c.tokenWork)) console.log(l);
  console.log(c.zone.source === 'default' ? `Days (UTC${c.zone.machine && c.zone.machine !== 'UTC' && !/^Etc\/(UTC|GMT)$/.test(c.zone.machine) ? `; this computer is on ${c.zone.machine}: set STUDIO_TZ=${c.zone.machine} for local days` : ''}):` : `Days (local, ${c.zone.zone}, from ${c.zone.source}):`);
  for (const b of c.buckets) console.log(`  ${b.day}${b.utc ? ` (${b.utc})` : ''}: supervisor ${b.supervisorHours} h, ${b.unplanned} unplanned / ${b.planned} planned, ${b.landed} landed (${b.handsFree} hands-free, ${b.forced} forced)`);
  console.log(`L3 bar (${r.config.file}${r.config.exists ? '' : ', defaults: no file'}${r.config.protected ? '; protected: owner-signed changes only' : '; set by a person, a Producer or Director session or an outside agent, never a worker'}):`);
  console.log(r.badge.confidence ? `  Rates are judged at their one-sided ${Math.round(r.badge.confidence * 100)}% Wilson bound for a promotion (${r.config.file} "confidence", else STUDIO_L3_CONFIDENCE; 0 = point estimates); a demotion reads the point estimates.` : '  Rates are judged as point estimates ("confidence": 0).');
  for (const k of r.badge.checks) console.log(`  ${k.ok ? 'ok  ' : 'MISS'} ${k.id}: ${k.value} (bar: ${k.bar})${k.na ? ' n/a' : ''}`);
  if (c.verdicts.audited) console.log(`  Audits counted in the redo rate: ${c.verdicts.audited} (${c.verdicts.auditFailed} failed).`);
  if (r.badge.suggestion.kind) console.log(r.badge.suggestion.text);
}
