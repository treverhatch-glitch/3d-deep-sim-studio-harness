/**
 * harness/api-pool.mjs — 2.79 (f): builders that bill an API key, started when the plan's budget is high.
 *
 * STUDIO_API_POOL=builder-api2,builder-api3 names builders whose key mapping (STUDIO_KEYMAP_AGENT_<NAME>=
 * ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE, harness/agent-env.mjs keymapFor) makes them bill the API key, not the plan.
 * The supervisor (harness/supervisor.mjs) reads the usage signal it already has: when it would start nothing new because
 * every tool with a known weekly budget is over its target for this point in the week (budget.mjs budgetStatus), or the
 * usage wind-down is on (STUDIO_USAGE_WINDDOWN_PCT, harness/winddown.mjs), it starts builders under these names instead
 * of waiting for headroom, up to the pool's size and the pace/RAM/rig caps, the Line Producer's holds included. When the
 * plan has headroom the pool is not used: plan builders (builder-s1 ...) start as before.
 *
 * A name with no key mapping in the environment would bill the plan, not the key, so it is never started from the pool
 * (and `agent start --pool api` says so). The key's own spend is limited as for any session: the spend guard
 * (STUDIO_SPEND_GUARD_AT, .studio/credit.json) and the daily token cap apply when the session starts.
 *
 * `npm run agent -- start --pool api [--task T-12]` starts one pool builder by hand, whatever the plan's budget.
 * Names only; values of keys are never read or printed here.
 */
import { keymapFor } from './agent-env.mjs';

const NAME = /^builder-[a-z0-9][a-z0-9-]*$/;

/** { names: valid builder names, ignored: [{ name, why }] } from STUDIO_API_POOL (comma or space separated). */
export function poolNames(env = process.env) {
  const raw = String(env.STUDIO_API_POOL || '').split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const names = [];
  const ignored = [];
  for (const n of [...new Set(raw)]) {
    if (!NAME.test(n)) { ignored.push({ name: n.slice(0, 40), why: 'not a builder name (builder-<something>)' }); continue; }
    const keyed = keymapFor({ agent: n, env }).pairs.some((p) => /API_KEY/.test(p.target));
    if (!keyed) { ignored.push({ name: n, why: `no STUDIO_KEYMAP_AGENT_${n.toUpperCase().replace(/-/g, '_')} mapping an API key: it would bill the plan` }); continue; }
    names.push(n);
  }
  return { names, ignored };
}

/**
 * The pool for this pass. usage: { over (every known tool over its target), winddown (wind-down active) }; live: the
 * running sessions. { on (a pool is set), high (the plan's budget is high), free: names that may start now, why }.
 */
export function poolPlan({ usage = {}, live = [], env = process.env } = {}) {
  const { names, ignored } = poolNames(env);
  if (!names.length) return { on: false, high: false, free: [], ignored, why: ignored.length ? `STUDIO_API_POOL has no usable name (${ignored.map((i) => `${i.name}: ${i.why}`).join('; ')})` : '' };
  const running = new Set(live.filter((s) => s && s.running !== false).map((s) => s.agent));
  const free = names.filter((n) => !running.has(n));
  const high = Boolean(usage.over || usage.winddown);
  const why = high
    ? `the plan's budget is high (${usage.winddown ? 'wind-down' : 'every tool over its target'}): ${free.length} of ${names.length} API-key builder${names.length === 1 ? '' : 's'} free`
    : 'the plan has headroom: plan builders start';
  return { on: true, high, free: high ? free : [], all: names, ignored, why };
}

/**
 * 2.80 (c), Patch #18: STUDIO_BUILDER_ORDER (e.g. api,vertex,plan): the order the supervisor fills a builder slot in, among
 * api (STUDIO_API_POOL), vertex (vertex.mjs vertexPick) and plan (the plan's tool). null when unset (today's choice).
 */
export function builderOrder(env = process.env) {
  const o = [...new Set(String(env.STUDIO_BUILDER_ORDER || '').toLowerCase().split(/[\s,]+/).filter((k) => ['api', 'vertex', 'plan'].includes(k)))];
  return o.length ? o : null;
}
/** The first kind in `order` that can start now (can: { api, vertex, plan } booleans), or null. */
export const builderKind = (order, can) => order.find((k) => can[k]) || null;

/** The pool name `agent start --pool api` takes by hand: the first one not running, or null with a reason. */
export function pickManual({ live = [], env = process.env } = {}) {
  const p = poolPlan({ usage: { over: true }, live, env });
  if (!p.on) return { name: null, why: p.why || 'STUDIO_API_POOL is not set' };
  if (!p.free.length) return { name: null, why: `every API-pool builder is running (${p.all.join(', ')})` };
  return { name: p.free[0], why: '' };
}
