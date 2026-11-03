/**
 * harness/routing.mjs — 2.73.0 (e): cheap-first routing (holdout off) and what each tier costs per landed change.
 *
 * Where the harness picks a writer's model (harness/agent.mjs startAgent: --model, else STUDIO_<ROLE>_MODEL, else
 * STUDIO_AGENT_MODEL, then the rescue model, the 2.30d tier-up after a failed hand-back and the reasoning-only reroute),
 * a counted studio/policy.json may say:
 *   "routing": { "cheapFirst": ["chore", "docs", "test"], "tiers": { "cheap": "<model>", "mid": "<model>", "top": "<model>" },
 *                "models": ["<model>", …], "holdout": 0 }
 * A task whose type (done-check's typeOf), track (task add --track) or role is listed starts on the cheapest tier the
 * policy names a model for, and goes one tier up per red round (a failed hand-back as 2.30d's escalationFor counts
 * them: not a usage limit, a person's stop or a hand-back the harness caused), capped at the top tier listed.
 *   - Only a model the policy lists (a "tiers" value or "models") is ever picked; a tier with no listed model is skipped
 *     (STUDIO_TIER_<TIER>_MODEL counts only when the policy lists that model too).
 *   - The model never changes mid-task: the route is picked when a session starts, a task already started on another
 *     model (before the policy, or by hand) keeps it, and the tier only moves after a red round.
 *   - --model on the launch always wins (a person's or the Producer's explicit choice).
 *   - The holdout (a seeded share of matching tasks sent to the default tier, to measure the difference) is built but
 *     OFF: "holdout": 0 is the default; the owner deferred it until API credit is available. The output says so.
 * Each routed start is one `model.routed` event (meta: task, type, arm 'cheap-first' | 'holdout', tier, model, failed).
 *
 * routingStats(): per task type and tier, from agent.session.end events (they name their task since 2.71.1): sessions,
 * tasks, landed (each landing is credited to its task's last session that started before it), the
 * success rate (landed / sessions) and the tokens per landed change (all the tier's tokens on that type / its landings).
 *
 *   npm run autonomy -- routing [--days 14] [--json]
 */
import crypto from 'node:crypto';
import { readRecentEvents } from './event.mjs';
import { tierOf, escalationFor } from './model-tiers.mjs';
import { readPolicy } from './policy-rules.mjs';

export const TIER_ORDER = ['cheap', 'mid', 'top'];
export const HOLDOUT_NOTE = 'off (0): the owner deferred it until API credit is available, so cheap-first is not compared with the default tier on the same kind of task';
const DAY = 86400000;
const ts = (e) => Date.parse(e?.ts) || 0;

/** The routing block in force: { on, cheapFirst, tiers, models, holdout, why } from a readPolicy() result. */
export function routingPolicy(policy) {
  const r = policy?.counts ? policy.effective?.routing : null;
  if (!policy?.counts) return { on: false, cheapFirst: [], tiers: {}, models: [], holdout: 0, why: policy?.why || 'no studio policy counts' };
  if (!r || !r.cheapFirst.length) return { on: false, cheapFirst: [], tiers: r?.tiers || {}, models: r?.models || [], holdout: 0, why: 'the policy lists no "routing.cheapFirst"' };
  return { on: true, ...r, why: '' };
}

/** The model for each tier: the policy's tiers, else STUDIO_TIER_<TIER>_MODEL when the policy lists that model. */
export function tierModels(rp, env = process.env) {
  const listed = new Set((rp.models || []).map((m) => m.toLowerCase()));
  const out = {};
  for (const t of TIER_ORDER) {
    const m = rp.tiers?.[t] || String(env[`STUDIO_TIER_${t.toUpperCase()}_MODEL`] || '').trim();
    if (m && listed.has(m.toLowerCase())) out[t] = m;
  }
  return out;
}

/** The seeded holdout draw for a task: [0, 1). */
export const holdoutDraw = (task) => parseInt(crypto.createHash('sha256').update(`studio-holdout|${task}`).digest('hex').slice(0, 13), 16) / 2 ** 52;

/** Does the policy's cheapFirst list name this task (its type, track or role)? Returns the matching word or ''. */
export function cheapFirstMatch(rp, { type = '', track = '', role = '' } = {}) {
  const want = new Set(rp.cheapFirst || []);
  for (const w of [type, track, role].map((x) => String(x || '').toLowerCase()).filter(Boolean)) if (want.has(w)) return w;
  return '';
}

/**
 * The route for a session about to start on `task` ({ id, type, track, role }), or null (no routing applies).
 * { task, type, matched, arm, tier, model, failed, why } — model null means the launcher keeps its default.
 */
export function routeFor(task, { policy, events = readRecentEvents(20000), env = process.env } = {}) {
  if (!task?.id) return null;
  const rp = routingPolicy(policy);
  if (!rp.on) return null;
  const matched = cheapFirstMatch(rp, task);
  if (!matched) return null;
  const models = tierModels(rp, env);
  const avail = TIER_ORDER.filter((t) => models[t]);
  const base = { task: task.id, type: task.type || null, matched };
  if (!avail.length) return { ...base, arm: 'none', tier: null, model: null, failed: 0, why: 'the policy lists no model for any tier: the default model starts it' };
  const mine = events.filter((e) => e.task === task.id);
  const lastDone = mine.filter((e) => e.type === 'task.done').pop();
  const since = lastDone ? mine.slice(mine.indexOf(lastDone) + 1) : mine;
  // Never mid-task: a task that already ran a session since its last landing without a route keeps its model.
  const routed = since.filter((e) => e.type === 'model.routed');
  const started = since.some((e) => e.type === 'agent.session.start' || e.type === 'task.start');
  if (started && !routed.length) return { ...base, arm: 'none', tier: null, model: null, failed: 0, why: 'it started before cheap-first applied: it keeps its model until it lands' };
  if (rp.holdout > 0 && holdoutDraw(task.id) < rp.holdout) return { ...base, arm: 'holdout', tier: 'default', model: null, failed: 0, why: `the seeded holdout (${Math.round(rp.holdout * 100)}%) sends it to the default tier` };
  const failed = escalationFor(task.id, { events, env: {} })?.failed || 0;
  const prev = routed.pop();
  if (prev && Number(prev.meta?.failed || 0) === failed && prev.meta?.model && avail.some((t) => models[t] === prev.meta.model)) return { ...base, arm: 'cheap-first', tier: prev.meta.tier, model: prev.meta.model, failed, sticky: true, why: `it started on ${prev.meta.model}; no red round since` };
  const idx = Math.min(avail.length - 1, failed);
  const tier = avail[idx];
  return { ...base, arm: 'cheap-first', tier, model: models[tier], failed, why: failed ? `${failed} red round(s): one tier up each, from ${avail[0]} to ${tier}` : `cheap-first (${matched}): the cheapest listed tier` };
}

/**
 * The launcher's call (harness/agent.mjs startAgent, only when no --model was given): the route, or null. Never throws.
 * task: { id, type, track, role }.
 */
export function launchRoute(task, { events = null, env = process.env, root = undefined } = {}) {
  try {
    const policy = readPolicy(root ? { root } : {});
    if (!policy.counts || !policy.effective?.routing?.cheapFirst?.length) return null;
    return routeFor(task, { policy, events: events || readRecentEvents(20000), env });
  } catch { return null; }
}

/**
 * Per task type and tier, from session ends: { days, holdout, note, rows: [{ type, tier, sessions, tasks, landed,
 * successRate, tokens, tokensPerLanded }] }. typeOfTask(id) -> type (defaults to 'change').
 */
export function routingStats(events, { now = Date.now(), days = 14, typeOfTask = null, weight = null, holdout = 0 } = {}) {
  const from = now - days * DAY;
  const w = typeof weight === 'function' ? weight : (e) => (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0);
  const sorted = [...events].sort((a, b) => ts(a) - ts(b));
  const ends = sorted.filter((e) => e.type === 'agent.session.end' && (e.task || e.meta?.task) && ts(e) >= from && ts(e) <= now);
  const landings = new Map();
  for (const e of sorted) {
    const ids = e.type === 'task.done' || e.type === 'lane.merged' ? [e.task] : e.type === 'task.train.landed' ? (e.meta?.lanes || [e.task]) : [];
    for (const t of ids.filter(Boolean).map(String)) { if (!landings.has(t)) landings.set(t, []); landings.get(t).push(ts(e)); }
  }
  const arms = new Map();
  for (const e of sorted) if (e.type === 'model.routed' && e.task) arms.set(e.task, e.meta?.arm || 'cheap-first');
  const byTask = new Map();
  for (const e of ends) { const t = String(e.task || e.meta.task); if (!byTask.has(t)) byTask.set(t, []); byTask.get(t).push(e); }
  const rows = new Map();
  for (const [task, list] of byTask) {
    const type = String((typeof typeOfTask === 'function' && (() => { try { return typeOfTask(task); } catch { return null; } })()) || 'change');
    const lands = (landings.get(task) || []).filter((t) => t >= from && t <= now + DAY);
    const starts = list.map((e, i) => Date.parse(e.meta?.startedAt) || (i ? ts(list[i - 1]) : -Infinity));
    // Each landing is credited to the last session that started before it (a session is "landed" once at most).
    const credited = new Set();
    for (const L of lands) { let j = -1; for (let i = 0; i < list.length; i++) if (starts[i] <= L) j = i; if (j >= 0) credited.add(j); }
    list.forEach((e, i) => {
      const tier = tierOf(e.model);
      const key = `${type}\t${tier}`;
      if (!rows.has(key)) rows.set(key, { type, tier, sessions: 0, tasks: new Set(), landed: 0, tokens: 0, arms: {} });
      const r = rows.get(key);
      r.sessions += 1; r.tasks.add(task); r.tokens += w(e);
      const arm = arms.get(task) || 'default';
      r.arms[arm] = (r.arms[arm] || 0) + 1;
      if (credited.has(i)) r.landed += 1;
    });
  }
  const out = [...rows.values()].map((r) => ({ type: r.type, tier: r.tier, sessions: r.sessions, tasks: r.tasks.size, landed: r.landed, successRate: r.sessions ? Math.round((r.landed / r.sessions) * 1000) / 1000 : null, tokens: Math.round(r.tokens), tokensPerLanded: r.landed ? Math.round(r.tokens / r.landed) : null, arms: r.arms }));
  out.sort((a, b) => a.type.localeCompare(b.type) || TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  return { days, holdout, note: holdout > 0 ? `${Math.round(holdout * 100)}% of matching tasks go to the default tier (seeded by the task id)` : HOLDOUT_NOTE, rows: out };
}

/** The CLI text for `npm run autonomy -- routing`. */
export function routingText(stats, rp) {
  const L = [rp.on ? `Cheap-first routing: on for ${rp.cheapFirst.join(', ')} (studio/policy.json "routing"); tiers ${TIER_ORDER.filter((t) => rp.tiers?.[t]).map((t) => `${t} ${rp.tiers[t]}`).join(', ') || 'none listed'}; only models the policy lists.` : `Cheap-first routing: off (${rp.why}).`];
  L.push(`Holdout: ${stats.note}.`);
  L.push(`Per task type and tier, ${stats.days} days of session ends that name their task:`);
  if (!stats.rows.length) L.push('  no session end names a task yet.');
  for (const r of stats.rows) L.push(`  ${r.type} · ${r.tier}: ${r.sessions} session(s) on ${r.tasks} task(s), ${r.landed} landed (success ${r.successRate === null ? '-' : `${Math.round(r.successRate * 100)}%`}), ${r.tokensPerLanded === null ? 'no landing yet' : `${r.tokensPerLanded.toLocaleString()} tokens per landed change`}.`);
  return L.join('\n');
}
