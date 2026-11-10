#!/usr/bin/env node
/**
 * harness/model-pools.mjs — 2.77.0 (n): model pools and quota-aware routing that prefers Gemini (the owner's Priority 8).
 *
 * The owner's words: "i'd love to lean on gemini for more tasks and use its usage more than claudes... argon is a solid
 * model, gemini flash has a bigger usage pool available but less capable". So the Line Producer (harness/line-producer.mjs)
 * routes each builder task to a model POOL:
 *   - small or mechanical tasks (size 1-2, or a chore/docs/test task) -> Gemini Flash (the big pool),
 *   - normal features (size 3, or no size) -> Gemini Argon,
 *   - hard work (size 4-5) and chain-breakers -> Claude (Opus, then Sonnet),
 *   - escalation after a Gemini failure -> Claude (Sonnet, Opus for hard work or a second red round),
 * each falling back to the next pool in its list when a pool is near its limit, marked out (a usage-limit line), or
 * dropped for that size class because it doesn't land there. A task that keeps handing back a protected step is never
 * routed to a pool that just handed one back. A task that started keeps its model until it lands or fails.
 *
 * The data: studio/models.json (optional; `npm run models -- init` writes these defaults), merged over DEFAULT_MODELS:
 *   pools.<name>: { tool, model, match (regex for the session models it counts), sessions5h, sessionsDay, tokens5h?,
 *                   tokensDay?, off? }      the limits are GUESSES (no provider publishes agy's pools): set your own;
 *   routes.small|normal|hard: [pool, …]    first that is fine wins;
 *   escalate.small|normal|hard|twice: [pool, …]   after a red round (twice: after two, or after a Claude failure);
 *   nearPct (85): a pool at this % of either window (or of agy's own quota, when read) is near its limit;
 *   success: { last: 6, floor: 0.34, minSamples: 3 }: a pool is dropped for a size class when, over its last `last`
 *            decided sessions there (landed or handed back; protected hand-backs and usage limits don't count), at
 *            least minSamples, it landed less than `floor`;
 *   protectedHours (24): how long a protected hand-back keeps a pool off protected-heavy tasks.
 * Observed use comes from the session events (agent.session.start per session, agent.session.end tokens; agy's are
 * often estimated, harness/agent.mjs agyUsage). agy's own quota: no `agy usage`/`agy quota` command appears in the crew's
 * evidence (only `agy models`), so it is read only when STUDIO_AGY_QUOTA_CMD names one (e.g. "agy usage --json"; JSON
 * with per-model used/limit/remaining/percent, or text lines "<model> … 37%" / "… 120/500"), cached for
 * STUDIO_AGY_QUOTA_SEC (600) in .studio/routing/agy-quota.json. UNTESTED on real agy.
 * Outcomes: .studio/routing/outcomes.json (rebuilt from the events each Line Producer pass, older rows kept): per
 * session { task, agent, model, pool, size, result landed|handed|open|other, protected }.
 *
 * On when STUDIO_MODEL_ROUTING=on, or (auto, the default) when studio/models.json exists or agy is enrolled
 * (.studio/agy-settings.json, `npm run agent -- allow agy`); off: the 2.76 tier routing as before.
 *
 *   npm run models -- status [--json]     pools, use, success rates, and what routing would pick now and why
 *   npm run models -- init [--force]      write studio/models.json with the defaults (the guesses, to edit)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { OWNER_STEP_PROTECTED } from './owner-only.mjs';
import { readJson } from './fsafe.mjs';

export const MODELS_REL = 'studio/models.json';
export const ROUTING_DIR = () => path.join(STUDIO_STATE_DIR, 'routing');
export const OUTCOMES_FILE = () => path.join(ROUTING_DIR(), 'outcomes.json');
export const AGY_QUOTA_FILE = () => path.join(ROUTING_DIR(), 'agy-quota.json');
export const SIZE_CLASSES = ['small', 'normal', 'hard'];
const H = 3600000;
const num = (v, d) => { const n = Number(v); return v !== null && v !== undefined && String(v).trim() !== '' && Number.isFinite(n) ? n : d; };
const ts = (e) => Date.parse(e?.ts) || 0;

/** The defaults. Every limit is a GUESS: no provider publishes these pools for agy or a Claude plan. */
export const DEFAULT_MODELS = {
  note: 'Model pools for the Line Producer (harness/model-pools.mjs). The limits are GUESSES, not published figures: set your own from what your plans allow. Sessions are counted per pool from the studio\'s own events.',
  pools: {
    'gemini-flash': { tool: 'agy', model: 'gemini-3.8-flash-high', match: '^gemini-[0-9.]+-flash', sessions5h: 60, sessionsDay: 300, note: 'the big pool, less capable: small and mechanical tasks' },
    'gemini-argon': { tool: 'agy', model: 'gemini-4-argon-high', match: '^gemini-[0-9.]+-argon', sessions5h: 20, sessionsDay: 100, note: 'a solid model: normal features' },
    'claude-sonnet': { tool: 'claude', model: 'claude-sonnet-5-5', match: 'sonnet', sessions5h: 15, sessionsDay: 60, note: 'escalation after a Gemini failure' },
    'claude-opus': { tool: 'claude', model: 'claude-opus-5-5', match: 'opus', sessions5h: 8, sessionsDay: 30, note: 'hard work and chain-breakers' },
  },
  routes: {
    small: ['gemini-flash', 'gemini-argon', 'claude-sonnet', 'claude-opus'],
    normal: ['gemini-argon', 'claude-sonnet', 'claude-opus'],
    hard: ['claude-opus', 'claude-sonnet', 'gemini-argon'],
  },
  escalate: {
    small: ['claude-sonnet', 'claude-opus'],
    normal: ['claude-sonnet', 'claude-opus'],
    hard: ['claude-opus', 'claude-sonnet'],
    twice: ['claude-opus', 'claude-sonnet'],
  },
  nearPct: 85,
  success: { last: 6, floor: 0.34, minSamples: 3 },
  protectedHours: 24,
};

/** The config in force: DEFAULT_MODELS with studio/models.json over it (pools merged per name, lists replaced). */
export function readModels({ root = REPO_ROOT } = {}) {
  const file = path.join(root, MODELS_REL);
  const own = fs.existsSync(file) ? readJson(file, null) : null;
  const d = JSON.parse(JSON.stringify(DEFAULT_MODELS));
  const errors = [];
  if (fs.existsSync(file) && !own) errors.push(`${MODELS_REL} isn't valid JSON: the defaults apply`);
  if (own && typeof own === 'object') {
    for (const [k, v] of Object.entries(own.pools || {})) d.pools[k] = v === null ? undefined : { ...(d.pools[k] || {}), ...v };
    for (const k of Object.keys(d.pools)) if (!d.pools[k]) delete d.pools[k];
    for (const c of [...SIZE_CLASSES, 'twice']) {
      if (Array.isArray(own.routes?.[c])) d.routes[c] = own.routes[c].map(String);
      if (Array.isArray(own.escalate?.[c])) d.escalate[c] = own.escalate[c].map(String);
    }
    if (own.nearPct !== undefined) d.nearPct = num(own.nearPct, d.nearPct);
    if (own.success && typeof own.success === 'object') d.success = { ...d.success, ...own.success };
    if (own.protectedHours !== undefined) d.protectedHours = num(own.protectedHours, d.protectedHours);
  }
  for (const list of [...Object.values(d.routes), ...Object.values(d.escalate)]) for (const p of list) if (!d.pools[p]) errors.push(`a route names pool "${p}", which isn't in pools`);
  return { ...d, file: own ? MODELS_REL : null, errors: [...new Set(errors)] };
}

/** { on, why }: STUDIO_MODEL_ROUTING on|off|auto (auto: on with studio/models.json or agy enrolled). */
export function modelRoutingOn({ env = process.env, root = REPO_ROOT } = {}) {
  const v = String(env.STUDIO_MODEL_ROUTING ?? '').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return { on: false, why: 'STUDIO_MODEL_ROUTING=off: the 2.76 tier routing' };
  if (/^(on|1|true|yes)$/.test(v)) return { on: true, why: 'STUDIO_MODEL_ROUTING=on' };
  if (fs.existsSync(path.join(root, MODELS_REL))) return { on: true, why: `${MODELS_REL} is there` };
  if (fs.existsSync(path.join(root, '.studio', 'agy-settings.json'))) return { on: true, why: 'agy is enrolled (.studio/agy-settings.json): Gemini first' };
  return { on: false, why: `no ${MODELS_REL} and agy isn't enrolled (npm run agent -- allow agy): the 2.76 tier routing (STUDIO_MODEL_ROUTING=on turns pools on)` };
}

/** The pool a session's model counts against (exact model first, then each pool's match), or null. */
export function poolOf(model, cfg) {
  const m = String(model || '').trim().replace(/^models\//, '');
  if (!m || m === 'unknown') return null;
  for (const [k, p] of Object.entries(cfg.pools || {})) if (String(p.model || '').toLowerCase() === m.toLowerCase()) return k;
  for (const [k, p] of Object.entries(cfg.pools || {})) { try { if (p.match && new RegExp(p.match, 'i').test(m)) return k; } catch {} }
  return null;
}
export const isGeminiPool = (name, cfg) => cfg.pools?.[name]?.tool === 'agy' || /^gemini/i.test(String(cfg.pools?.[name]?.model || ''));

/** small | normal | hard from a task's size (1-2, 3, 4-5) or, with none, its type (chore/docs/test small). */
export function sizeClass(meta = {}, type = '', { chainBreaker = false } = {}) {
  if (chainBreaker) return 'hard';
  const s = Number(meta?.size);
  if (Number.isFinite(s) && s > 0) return s <= 2 ? 'small' : s >= 4 ? 'hard' : 'normal';
  return ['chore', 'docs', 'test'].includes(String(type || '').toLowerCase()) ? 'small' : 'normal';
}

/** Observed use per pool: { sessions5h, sessionsDay, tokens5h, tokensDay, estimated } from the events. */
export function poolUse(cfg, events, now = Date.now()) {
  const out = {};
  for (const k of Object.keys(cfg.pools || {})) out[k] = { sessions5h: 0, sessionsDay: 0, tokens5h: 0, tokensDay: 0, estimated: false };
  for (const e of events) {
    const t = ts(e);
    if (t > now || t < now - 24 * H) continue;
    if (e.type !== 'agent.session.start' && e.type !== 'agent.session.end') continue;
    const k = poolOf(e.model, cfg);
    if (!k) continue;
    const u = out[k];
    const in5 = t >= now - 5 * H;
    if (e.type === 'agent.session.start') { u.sessionsDay += 1; if (in5) u.sessions5h += 1; continue; }
    const tok = (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
    u.tokensDay += tok; if (in5) u.tokens5h += tok;
    if (e.meta?.tokensEstimated) u.estimated = true;
  }
  return out;
}

/** Per-model used % from a quota command's output (JSON or text). { '<model>': pct }. */
export function parseQuotaOutput(text) {
  const out = {};
  const s = String(text || '').trim();
  const put = (m, used, limit, remaining, pct) => {
    const name = String(m || '').trim().replace(/^models\//, '');
    if (!name) return;
    let p = Number.isFinite(Number(pct)) && pct !== null && pct !== undefined && pct !== '' ? Number(pct) : null;
    if (p === null && Number(limit) > 0 && Number.isFinite(Number(used))) p = (Number(used) / Number(limit)) * 100;
    if (p === null && Number(limit) > 0 && Number.isFinite(Number(remaining))) p = 100 - (Number(remaining) / Number(limit)) * 100;
    if (p !== null && Number.isFinite(p)) out[name] = Math.max(0, Math.min(100, Math.round(p * 10) / 10));
  };
  if (/^[[{]/.test(s)) {
    try {
      const j = JSON.parse(s);
      const rows = Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : Object.entries(j.models || j).map(([k, v]) => (v && typeof v === 'object' ? { model: k, ...v } : null)).filter(Boolean);
      for (const r of rows) put(r.model || r.name || r.id, r.used ?? r.usage, r.limit ?? r.quota ?? r.total, r.remaining, r.usedPct ?? r.percent ?? r.percentUsed ?? (r.remainingPct !== undefined ? 100 - Number(r.remainingPct) : undefined));
      return out;
    } catch { /* text below */ }
  }
  for (const line of s.split(/\r?\n/)) {
    const m = line.match(/\b((?:gemini|claude|gpt)[\w.-]*)\b/i);
    if (!m) continue;
    const pct = line.match(/(\d+(?:\.\d+)?)\s*%\s*(used|left|remaining)?/i);
    const frac = line.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
    if (pct) put(m[1], null, null, null, /left|remaining/i.test(pct[2] || '') ? 100 - Number(pct[1]) : Number(pct[1]));
    else if (frac) put(m[1], Number(frac[1].replace(/,/g, '')), Number(frac[2].replace(/,/g, '')));
  }
  return out;
}

/**
 * agy's own quota, if a command for it is set (STUDIO_AGY_QUOTA_CMD; cached STUDIO_AGY_QUOTA_SEC, 600 s).
 * { source: 'command'|'cache'|'none', models: { model: usedPct }, at, why }. Never throws. deps.run(argv) for tests.
 */
export function readAgyQuota({ env = process.env, now = Date.now(), deps = {} } = {}) {
  const cmd = String(env.STUDIO_AGY_QUOTA_CMD || '').trim();
  if (!cmd || /^(off|none|0)$/i.test(cmd)) return { source: 'none', models: {}, at: null, why: 'agy shows no quota command the harness knows of (the crew\'s evidence has only `agy models`): configured limits and observed use only (STUDIO_AGY_QUOTA_CMD names one)' };
  const maxAge = Math.max(0, num(env.STUDIO_AGY_QUOTA_SEC, 600)) * 1000;
  const cached = readJson(AGY_QUOTA_FILE(), null);
  if (cached && cached.cmd === cmd && now - Date.parse(cached.at) < maxAge) return { ...cached, source: 'cache' };
  const argv = cmd.split(/\s+/).filter(Boolean);
  let r;
  try {
    r = deps.run ? deps.run(argv) : null;
    if (!r) { const { spawnAgentSync } = deps.launch || {}; r = (spawnAgentSync || ((a, o) => spawnSync(a[0], a.slice(1), { ...o, windowsHide: true })))(argv, { encoding: 'utf8', timeout: 20000, windowsHide: true, cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); }
  } catch (e) { r = { status: null, error: e }; }
  const models = r && r.status === 0 ? parseQuotaOutput(r.stdout) : {};
  const res = { source: 'command', cmd, at: new Date(now).toISOString(), models, why: r?.status === 0 ? (Object.keys(models).length ? `\`${cmd}\`: ${Object.entries(models).map(([m, p]) => `${m} ${p}%`).join(', ')}` : `\`${cmd}\` printed nothing the harness could read`) : `\`${cmd}\` failed (${r?.error?.message || `exit ${r?.status ?? 'timeout'}`})` };
  try { fs.mkdirSync(ROUTING_DIR(), { recursive: true }); fs.writeFileSync(AGY_QUOTA_FILE(), `${JSON.stringify(res, null, 2)}\n`); } catch {}
  return res;
}

/**
 * Each pool's state now: { tool, model, limits, use, quotaPct, near, out, why }. marks(key) -> until|null for a
 * usage-limit mark (harness/budget.mjs exhaustedUntil; keys tool and tool:model).
 */
export function poolState(cfg, { use = {}, quota = { models: {} }, marks = () => null, now = Date.now() } = {}) {
  const near = num(cfg.nearPct, 85);
  const out = {};
  for (const [k, p] of Object.entries(cfg.pools || {})) {
    const u = use[k] || { sessions5h: 0, sessionsDay: 0, tokens5h: 0, tokensDay: 0 };
    const reasons = [];
    const pct = (used, lim) => (Number(lim) > 0 ? (used / Number(lim)) * 100 : 0);
    const w = [['sessions5h', 'sessions in 5 h'], ['sessionsDay', 'sessions today'], ['tokens5h', 'tokens in 5 h'], ['tokensDay', 'tokens today']].map(([f, label]) => ({ f, label, used: u[f] || 0, lim: p[f], pct: pct(u[f] || 0, p[f]) })).filter((x) => Number(x.lim) > 0);
    const worst = w.sort((a, b) => b.pct - a.pct)[0] || null;
    if (worst && worst.pct >= near) reasons.push(`${worst.used} of ${worst.lim} ${worst.label} (${Math.round(worst.pct)}% >= ${near}%)`);
    const qk = Object.keys(quota.models || {}).find((m) => m.toLowerCase() === String(p.model).toLowerCase() || poolOf(m, { pools: { [k]: p } }) === k);
    const qp = qk ? quota.models[qk] : null;
    if (qp !== null && qp >= near) reasons.push(`agy's quota says ${qp}% used`);
    const until = p.tool ? marks(`${p.tool}:${p.model}`) || marks(p.tool) : null;
    const isOut = Boolean(until) || p.off === true;
    out[k] = { tool: p.tool, model: p.model, limits: { sessions5h: p.sessions5h ?? null, sessionsDay: p.sessionsDay ?? null, tokens5h: p.tokens5h ?? null, tokensDay: p.tokensDay ?? null }, use: u, usedPct: worst ? Math.round(worst.pct) : 0, quotaPct: qp, near: !isOut && reasons.length > 0, out: isOut, why: p.off === true ? 'off in studio/models.json' : until ? `marked out of quota until ${String(until).slice(0, 16)}` : reasons.join('; ') || `${worst ? `${worst.used}/${worst.lim} ${worst.label}` : 'no limits set'}` };
  }
  void now;
  return out;
}

/**
 * Outcomes per session, rebuilt from the events and merged with the earlier file's rows (kept 500):
 * [{ key, agent, task, model, tool, pool, size, start, end, result: landed|handed|open|other, protected, why }].
 * sizeOf(taskId) -> small|normal|hard.
 */
export function buildOutcomes(events, { cfg, prev = [], sizeOf = () => 'normal', now = Date.now() } = {}) {
  const sorted = [...events].sort((a, b) => ts(a) - ts(b));
  const open = new Map();
  const sessions = [];
  const landings = new Map();
  const pauses = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const e of sorted) {
    if (e.type === 'agent.session.start' && e.agent) open.set(e.agent, { start: ts(e), model: e.model || null, tool: e.meta?.tool || null, task: e.task || null });
    else if (e.type === 'agent.session.end' && e.agent) {
      const s = open.get(e.agent) || { start: Date.parse(e.meta?.startedAt) || ts(e), model: null, tool: null, task: null };
      open.delete(e.agent);
      const task = e.task || s.task;
      if (!task) continue;
      sessions.push({ agent: e.agent, start: s.start, end: Math.max(s.start, Date.parse(e.meta?.endedAt || '') || ts(e)), model: e.model || s.model, tool: e.meta?.tool || s.tool, task: String(task), reason: String(e.meta?.reason || ''), handed: (e.meta?.handed || []).map((h) => h?.task).filter(Boolean) });
    } else if (e.type === 'task.done' || e.type === 'lane.merged') { if (e.task) add(landings, String(e.task), ts(e)); }
    else if (e.type === 'task.train.landed') { for (const t of e.meta?.lanes || [e.task]) if (t) add(landings, String(typeof t === 'object' ? t.task : t), ts(e)); }
    else if (e.type === 'task.paused' && e.task) add(pauses, String(e.task), { at: ts(e), agent: e.agent, msg: String(e.msg || ''), ownerStep: e.meta?.ownerStep || null });
  }
  const byTask = new Map();
  for (const s of sessions) add(byTask, s.task, s);
  const rows = [];
  for (const [task, list] of byTask) {
    list.sort((a, b) => a.start - b.start);
    list.forEach((s, i) => {
      const next = list[i + 1]?.start ?? Infinity;
      const landed = (landings.get(task) || []).some((L) => L >= s.start && L < next);
      const p = (pauses.get(task) || []).filter((x) => x.at >= s.start && x.at < next && (x.agent === s.agent || x.at <= s.end + 120000)).pop();
      const notCounted = /usage limit|stopped by|paused by|refreshed|budget stop/i.test(s.reason);
      const handed = Boolean(p) || s.handed.includes(task) || next !== Infinity;
      const result = landed ? 'landed' : notCounted ? 'other' : handed ? 'handed' : 'open';
      const prot = !landed && Boolean(p && p.ownerStep === OWNER_STEP_PROTECTED);
      const pool = poolOf(s.model, cfg);
      rows.push({ key: `${s.agent}|${new Date(s.start).toISOString()}`, agent: s.agent, task, model: s.model, tool: s.tool, pool, size: sizeOf(task), start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), result, protected: prot, why: landed ? 'its task landed after this session (and before the next on it)' : notCounted ? `not counted (${s.reason.slice(0, 80)})` : p ? `handed back: ${p.msg.replace(/^Handed back \S+: /, '').slice(0, 160)}` : handed ? 'another session took the task over' : 'ended; nothing landed or handed back yet' });
    });
  }
  const fresh = new Map(rows.map((r) => [r.key, r]));
  const kept = (Array.isArray(prev) ? prev : []).filter((r) => r?.key && !fresh.has(r.key));
  void now;
  return [...kept, ...rows].sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(-500);
}
export const readOutcomes = () => { const j = readJson(OUTCOMES_FILE(), null); return Array.isArray(j?.outcomes) ? j.outcomes : []; };
export function writeOutcomes(outcomes, { now = Date.now() } = {}) {
  try { fs.mkdirSync(ROUTING_DIR(), { recursive: true }); const f = OUTCOMES_FILE(); const tmp = `${f}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify({ at: new Date(now).toISOString(), note: 'per session: landed vs handed back, by model pool and task size (harness/model-pools.mjs); rebuilt from the events each Line Producer pass', outcomes }, null, 2)}\n`); fs.renameSync(tmp, f); return f; } catch { return null; }
}

/** Success per pool and size class over each one's last `success.last` decided sessions. { pool: { size: {…} } } */
export function successRates(outcomes, cfg) {
  const last = Math.max(1, num(cfg.success?.last, 6));
  const floor = num(cfg.success?.floor, 0.34);
  const minN = Math.max(1, num(cfg.success?.minSamples, 3));
  const out = {};
  const decided = outcomes.filter((o) => o.pool && (o.result === 'landed' || (o.result === 'handed' && !o.protected))).sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  for (const p of Object.keys(cfg.pools || {})) {
    out[p] = {};
    for (const s of SIZE_CLASSES) {
      const mine = decided.filter((o) => o.pool === p && o.size === s).slice(0, last);
      const landed = mine.filter((o) => o.result === 'landed').length;
      const rate = mine.length ? landed / mine.length : null;
      out[p][s] = { n: mine.length, landed, handed: mine.length - landed, rate: rate === null ? null : Math.round(rate * 100) / 100, dropped: mine.length >= minN && rate < floor };
    }
  }
  return out;
}
/** Pools with a protected hand-back in the last protectedHours: { pool: { task, at } }. */
export function recentProtected(outcomes, cfg, now = Date.now()) {
  const from = now - num(cfg.protectedHours, 24) * H;
  const out = {};
  for (const o of outcomes) if (o.protected && o.pool && Date.parse(o.end) >= from) out[o.pool] = { task: o.task, at: o.end };
  return out;
}

/**
 * The route for one task. ctx: { size, chainBreaker, failed, lastFailedPool, protectedHeavy, startedOn: { model, tool }
 * | null }. model: { cfg, state, rates, recentProt }. Returns { pool, tool, model, size, why, skipped } or a route with
 * model null (the launcher's default) when no pool fits.
 */
export function pickPool(ctx, { cfg, state = {}, rates = {}, recentProt = {} }) {
  const size = ctx.chainBreaker ? 'hard' : SIZE_CLASSES.includes(ctx.size) ? ctx.size : 'normal';
  const failed = Math.max(0, Number(ctx.failed) || 0);
  const stickyPool = ctx.startedOn?.model ? poolOf(ctx.startedOn.model, cfg) : null;
  // 2.79.2: a task that started on Vertex isn't kept there by this rule: the supervisor picks Vertex per start (share, budget).
  if (ctx.startedOn?.model && ctx.startedOn.tool !== 'vertex' && !failed && !(ctx.protectedHeavy && stickyPool && recentProt[stickyPool]) && !(stickyPool && state[stickyPool]?.out)) return { pool: poolOf(ctx.startedOn.model, cfg), tool: ctx.startedOn.tool || null, model: ctx.startedOn.model, size, why: `it already started on ${ctx.startedOn.model}: it keeps that model until it lands or fails`, skipped: [] };
  const geminiFailed = failed > 0 && ctx.lastFailedPool && isGeminiPool(ctx.lastFailedPool, cfg);
  const listName = failed >= 2 || (failed > 0 && !geminiFailed) ? 'twice' : failed > 0 ? size : null;
  const chain = (listName ? cfg.escalate?.[listName] : cfg.routes?.[size]) || [];
  const head = listName ? (failed >= 2 ? `${failed} red rounds: Claude, strongest first` : geminiFailed ? `a Gemini failure (${ctx.lastFailedPool}): escalated to Claude` : `a red round on ${ctx.lastFailedPool || 'its last model'}: the strongest model`) : `${ctx.chainBreaker ? 'a chain-breaker' : `${size} task`}`;
  const skipped = [];
  const near = [];
  const dropped = [];
  for (const p of chain) {
    const st = state[p];
    if (!cfg.pools?.[p] || !st) { skipped.push({ pool: p, why: 'not in pools' }); continue; }
    if (st.out) { skipped.push({ pool: p, why: st.why }); continue; }
    if (ctx.protectedHeavy && recentProt[p]) { skipped.push({ pool: p, why: `it handed back a protected step (${recentProt[p].task}) in the last ${cfg.protectedHours} h` }); continue; }
    if (rates[p]?.[size]?.dropped) { const r = rates[p][size]; skipped.push({ pool: p, why: `it landed ${r.landed} of its last ${r.n} ${size} tasks (under ${Math.round(num(cfg.success?.floor, 0.34) * 100)}%)` }); dropped.push(p); continue; }
    if (st.near) { skipped.push({ pool: p, why: `near its limit: ${st.why}` }); near.push(p); continue; }
    const fell = skipped.length ? `; skipped ${skipped.map((s) => `${s.pool} (${s.why})`).join(', ')}` : '';
    return { pool: p, tool: st.tool, model: st.model, size, why: `${head} -> ${p} (${st.model} on ${st.tool})${fell}`, skipped };
  }
  // Nothing fit: the least-used pool that is only near its limit, else one dropped for this size, else the default.
  const pick = near.sort((a, b) => (state[a].usedPct || 0) - (state[b].usedPct || 0))[0] || dropped[0] || null;
  if (pick) return { pool: pick, tool: state[pick].tool, model: state[pick].model, size, why: `${head}: every pool on its list is near its limit or doesn't land here, so the least-used: ${pick} (${state[pick].model}); skipped ${skipped.map((s) => `${s.pool} (${s.why})`).join(', ')}`, skipped };
  return { pool: null, tool: null, model: null, size, why: `${head}: no pool on its list can take it (${skipped.map((s) => `${s.pool}: ${s.why}`).join('; ') || 'the list is empty'}): the launcher's default`, skipped };
}

/**
 * Everything routing needs, gathered once: { on, why, cfg, state, rates, recentProt, outcomes, quota, use }. Writes
 * .studio/routing/outcomes.json unless write is false. deps: { events, marks, quota } for tests.
 */
export async function modelContext({ env = process.env, now = Date.now(), root = REPO_ROOT, events = null, sizeOf = null, write = true, deps = {} } = {}) {
  const on = modelRoutingOn({ env, root });
  const cfg = readModels({ root });
  const evs = events || deps.events || readRecentEvents(20000);
  let marks = deps.marks;
  if (!marks) { try { const b = await import('./budget.mjs'); marks = (k) => b.exhaustedUntil(k, now); } catch { marks = () => null; } }
  let quota = deps.quota;
  if (!quota) { let launch = {}; try { launch = await import('./launch.mjs'); } catch {} quota = readAgyQuota({ env, now, deps: { launch } }); }
  const added = new Map();
  for (const e of evs) if (e.type === 'task.added' && e.task) added.set(String(e.task), e.meta || {});
  const sz = sizeOf || ((id) => sizeClass(added.get(String(id)) || {}, ''));
  const outcomes = buildOutcomes(evs, { cfg, prev: readOutcomes(), sizeOf: sz, now });
  if (write) writeOutcomes(outcomes, { now });
  const use = poolUse(cfg, evs, now);
  const state = poolState(cfg, { use, quota, marks, now });
  return { on: on.on, why: on.why, cfg, state, rates: successRates(outcomes, cfg), recentProt: recentProtected(outcomes, cfg, now), outcomes, quota, use };
}

/** What routing would pick now for each size class (and after a Gemini failure). */
export function routingPreview(mc) {
  const firstGemini = Object.keys(mc.cfg.pools).find((p) => isGeminiPool(p, mc.cfg)) || null;
  return {
    small: pickPool({ size: 'small' }, mc),
    normal: pickPool({ size: 'normal' }, mc),
    hard: pickPool({ size: 'hard' }, mc),
    afterGeminiFailure: pickPool({ size: 'normal', failed: 1, lastFailedPool: firstGemini }, mc),
  };
}

export function statusText(mc) {
  const L = [`Model routing: ${mc.on ? 'on' : 'off'} (${mc.why}).${mc.cfg.file ? ` Config: ${mc.cfg.file}.` : ' Config: the built-in defaults (npm run models -- init writes studio/models.json to edit).'}${mc.cfg.errors.length ? ` Problems: ${mc.cfg.errors.join('; ')}.` : ''}`];
  L.push('Pools (limits are guesses unless you set them; use from the studio\'s events):');
  for (const [k, s] of Object.entries(mc.state)) {
    const l = s.limits;
    L.push(`  ${k}: ${s.model} on ${s.tool}; ${s.use.sessions5h}/${l.sessions5h ?? '-'} sessions in 5 h, ${s.use.sessionsDay}/${l.sessionsDay ?? '-'} today; ${s.use.tokensDay.toLocaleString()} tokens today${s.use.estimated ? ' (agy\'s estimated: usage not reported)' : ''}${s.quotaPct !== null ? `; agy quota ${s.quotaPct}%` : ''}; ${s.out ? `OUT: ${s.why}` : s.near ? `NEAR: ${s.why}` : 'ok'}.`);
  }
  L.push(`agy's own quota: ${mc.quota.why}.`);
  L.push(`Success (last ${mc.cfg.success.last} decided sessions per size; dropped under ${Math.round(mc.cfg.success.floor * 100)}% with ${mc.cfg.success.minSamples}+):`);
  for (const [p, bySize] of Object.entries(mc.rates)) L.push(`  ${p}: ${SIZE_CLASSES.map((s) => { const r = bySize[s]; return `${s} ${r.n ? `${r.landed}/${r.n}${r.dropped ? ' DROPPED' : ''}` : '-'}`; }).join(', ')}`);
  const prot = Object.entries(mc.recentProt);
  if (prot.length) L.push(`Protected hand-backs (kept off protected-heavy tasks for ${mc.cfg.protectedHours} h): ${prot.map(([p, x]) => `${p} on ${x.task}`).join(', ')}.`);
  const pv = routingPreview(mc);
  L.push('What routing would pick now:');
  for (const [k, r] of Object.entries(pv)) L.push(`  ${k}: ${r.model ? `${r.model} (${r.tool})` : 'the launcher\'s default'} — ${r.why}`);
  if (!mc.on) L.push('(Routing is off, so the Line Producer uses the 2.76 tiers; this is what it would pick with pools on.)');
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  if (cmd === 'init') {
    const f = path.join(REPO_ROOT, MODELS_REL);
    if (fs.existsSync(f) && !argv.includes('--force')) { console.error(`${MODELS_REL} is there already (--force overwrites it).`); process.exit(1); }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(DEFAULT_MODELS, null, 2)}\n`);
    console.log(`Wrote ${MODELS_REL} with the default pools (the limits are guesses: set your own). Model routing is on while it is there.`);
    process.exit(0);
  }
  if (cmd !== 'status' || argv.includes('--help') || argv.includes('-h')) { console.log('Usage: npm run models -- status [--json] | init [--force]'); process.exit(cmd === 'status' || cmd === 'help' ? 0 : 1); }
  const mc = await modelContext({ write: false });
  if (argv.includes('--json')) { const { outcomes, ...rest } = mc; console.log(JSON.stringify({ ...rest, outcomes: outcomes.length, preview: routingPreview(mc) }, null, 2)); }
  else console.log(statusText(mc));
  process.exit(0);
}
