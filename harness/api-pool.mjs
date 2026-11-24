/**
 * harness/api-pool.mjs — builders that bill an API key, started when the plan's budget is high.
 * STUDIO_API_POOL=builder-api2,builder-api3 names builders whose key mapping (STUDIO_KEYMAP_AGENT_<NAME>=
 * ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE, harness/agent-env.mjs keymapFor) makes them bill the API key, not the plan.
 * When the supervisor would start nothing new because every tool with a known weekly budget is over its target
 * (budget.mjs budgetStatus), or the usage wind-down is on (STUDIO_USAGE_WINDDOWN_PCT, harness/winddown.mjs), it starts
 * builders under these names, up to the pool's size and the pace/RAM/rig caps. With plan headroom the pool is not used.
 * A name with no key mapping would bill the plan, so it is never started from the pool. The key's spend is limited as
 * for any session (STUDIO_SPEND_GUARD_AT, .studio/credit.json, the daily token cap). `npm run agent -- start --pool api
 * [--role R] [--task T-12]` starts one pool session by hand (poolRole). Key values are never read or printed.
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
/**
 * 2.96: the roles whose slot STUDIO_BUILDER_ORDER fills. Builders always; an engine porter only when the owner adds it
 * (STUDIO_BUILDER_ORDER_ROLES=builder,engine-porter), so an upgrade never moves porters onto API credit by itself.
 */
export const orderedRole = (role, env = process.env) => role === 'builder' || (role === 'engine-porter' && String(env.STUDIO_BUILDER_ORDER_ROLES || '').toLowerCase().split(/[\s,]+/).includes('engine-porter'));
/** The tool an API-pool session runs: the role's tool, but agy never (an API key does not pay for agy): claude. */
export const apiTool = (tool) => (tool === 'agy' ? 'claude' : tool);
/** The first kind in `order` that can start now (can: { api, vertex, plan } booleans), or null. */
export const builderKind = (order, can) => order.find((k) => can[k]) || null;

/**
 * The pool name `agent start --pool api` takes by hand: the first one with no live session and whose lane copy is not in
 * use (busy(name) gives why, or ''), or null with a reason. The key map is per name, so any role takes a pool name.
 */
export function pickManual({ live = [], env = process.env, busy = () => '' } = {}) {
  const p = poolPlan({ usage: { over: true }, live, env });
  if (!p.on) return { name: null, why: p.why || 'STUDIO_API_POOL is not set' };
  const name = p.free.find((n) => !busy(n));
  if (!name) return { name: null, why: `every API-pool name is busy (${p.all.map((n) => `${n}: ${p.free.includes(n) ? 'its lane copy is in use' : 'running'}`).join(', ')})` };
  return { name, why: '' };
}

/**
 * 2.98: the role `start --pool api` takes. --role wins; else an engine task (its board role is an engine role, or it
 * has an engine track) starts an engine porter; else a builder. { role, why, engine }.
 */
export function poolRole({ role = null, task = null, boardRole = null, engine = null, engineRole = () => false } = {}) {
  if (role) return { role, why: '--role given', engine: false };
  if (task && boardRole && engineRole(boardRole)) return { role: boardRole, why: `${task} is an ${boardRole} task on the board`, engine: true };
  if (task && engine) return { role: 'engine-porter', why: `${task} is on engine:${engine}`, engine: true };
  return { role: 'builder', why: task ? `${task} is not an engine task` : 'no --task', engine: false };
}
