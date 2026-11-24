/**
 * harness/engine-ram.mjs — what an engine land needs in free RAM, and how the Line Producer makes room for it.
 * No permanent reservation: the land counts only while one is queued or near, and is released at once when it starts.
 *   1. The need: the owner/tuned floor, else the passed sampled runs of the land kind (run-cost.mjs landNeed), else the table.
 *   2. The hold (engineHoldPlan, pure; engineHoldPass reads the machine): while a land is queued or near (an engine
 *      porter ran `task done --check`), new heavy starts wait (a quiet hold tagged "engine-land"; the land ignores it).
 *      If free RAM is short and running verifies aren't about to finish, the builder target steps down (never a kill).
 *   3. Bounded by STUDIO_ENGINE_HOLD_MAX_MIN (30; 0: no hold): past it the hold is released (line.engine_hold_expired).
 * Settings: STUDIO_ENGINE_RAM_MARGIN_GB (1.5), STUDIO_ENGINE_RAM_MIN_GB (4), STUDIO_ENGINE_RAM_RUNS (3; 0: always the
 * table), STUDIO_ENGINE_VERIFY_TYPICAL_MIN (10), STUDIO_ENGINE_WAIT_SOON_MIN (5), STUDIO_ENGINE_SCALE_STEP_MIN (3),
 * STUDIO_ENGINE_NEAR_MIN (30), STUDIO_ENGINE_LAND_WAIT_MIN (20: how long a land waits for RAM with no Line Producer).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from './fsafe.mjs';
import { numSplit as num } from './helpers.mjs';

export const ramFile = (root) => path.join(root, '.studio', 'engine-ram.json');
export const holdStateFile = (root) => path.join(root, '.studio', 'line', 'engine-hold.json');
export const ENGINE_HOLD_TAG = 'engine-land';
/**
 * 2.81: engine first by default. Engine work is the longest and costliest queue (the crew's week: 16% of 67 land runs
 * passed, a queued port waited up to 9.4 h), so a studio with exactly one engine in studio/game.json gives it the push
 * unless someone said otherwise: `npm run mode -- engine-push off` keeps it off, a timed push that ended falls back here.
 */
export function defaultPushEngine(root) {
  const names = Object.keys(readJson(path.join(root, 'studio', 'game.json'), null)?.engines || {}).filter((n) => /^[a-z][a-z0-9-]{1,30}$/.test(n));
  return names.length === 1 ? names[0] : null;
}
/** The push record's verdict: an engine name (pushed), null (explicitly off), or undefined (nobody decided: the default applies). */
export function pushRecordEngine(p, now = Date.now()) {
  if (p?.on && p.engine && (!p.until || Date.parse(p.until) > now)) return String(p.engine);
  return p && p.on === false ? null : undefined;
}
/** studio/mode.json "enginePush" (harness/mode.mjs): the engine being pushed now, or null. Read here so heavy.mjs needs no mode.mjs. */
export function pushEngine(root, now = Date.now()) {
  const e = pushRecordEngine(readJson(path.join(root, 'studio', 'mode.json'), null)?.enginePush, now);
  return e === undefined ? defaultPushEngine(root) : e;
}
/**
 * 2.79.1 (4): an engine push gives the engine line at least 2 slots (a land and a porter's quick check) when the machine
 * has the RAM for both (STUDIO_ENGINE_PUSH_MIN_TOTAL_GB, 24), else it stays as it was. base 0 (no engine line) stays 0.
 */
export function pushSlots(base, root, env = process.env, totalGb = os.totalmem() / 1024 ** 3) {
  if (!(base > 0) || base >= 2 || !pushEngine(root)) return base;
  return totalGb >= num(env.STUDIO_ENGINE_PUSH_MIN_TOTAL_GB, 24) ? 2 : base;
}
export const holdMaxMin = (env = process.env) => Math.max(0, num(env.STUDIO_ENGINE_HOLD_MAX_MIN, 30));

// ---- the hold --------------------------------------------------------------------------------------------------

const isVerify = (h) => !h?.claim?.engine && /verify|gate/i.test(`${h?.claim?.kind || ''} ${h?.label || ''}`);

/**
 * One decision, pure. facts: { now, land: { engine, label, queued, near, holdsSlot, needGb } | null (the first engine
 * with a land waiting), freeGb, holders: [{ label, at, claim: { kind, engine } }], builders (running now), prev (the last
 * state) }. Returns { hold, expired?, cap (builder target cap or null), why, holders: [...labels], state (to save, or null) }.
 */
export function engineHoldPlan(f, env = process.env) {
  const now = f.now ?? Date.now();
  const max = holdMaxMin(env);
  const pushed = Boolean(f.land?.push);
  const none = (why, extra = {}) => ({ hold: false, cap: null, why, state: null, ...extra });
  if (!(max > 0)) return none('STUDIO_ENGINE_HOLD_MAX_MIN=0: the Line Producer makes no room for engine lands');
  const land = f.land;
  if (!land || land.holdsSlot || !(land.queued || land.near)) return none(land?.holdsSlot ? `the ${land.label || land.engine} land holds its slot: hold released, builders refill` : 'no engine land queued or near: no RAM is held back', { released: Boolean(f.prev?.active) });
  const need = land.needGb;
  const free = Number.isFinite(f.freeGb) ? f.freeGb : null;
  const enough = free !== null && need > 0 && free >= need;
  const L = land.label || land.engine;
  const verifies = (f.holders || []).filter(isVerify);
  const labels = (f.holders || []).map((h) => h.label || h.claim?.kind || 'a heavy job').slice(0, 6);
  const prev = f.prev && f.prev.engine === land.engine ? f.prev : null;
  // A land that is only near (no branch queued yet) holds nothing back while the RAM is there already.
  if (!land.queued && enough) return none(`the ${L} land is near; ${free} GB free already covers its ${need} GB: nothing held back`);
  // After an expiry: back at the next natural gap (no verify running, or the RAM is there).
  if (prev?.expiredAt && !prev.active && !pushed) {
    if (verifies.length && !enough) return none(`the ${L} hold ran out at ${new Date(prev.expiredAt).toISOString().slice(11, 16)} UTC; it comes back at the next natural gap (no verify running, or ${need} GB free)`, { state: prev });
  }
  let st = prev?.active ? prev : { engine: land.engine, active: true, since: now, scaled: 0, scaleBase: f.builders ?? 0, lastScaleAt: now };
  // An engine push has no time limit (the game's verifies wait); the hold is re-marked every pass, so it lasts a few passes at a time.
  const until = pushed ? now + 10 * 60000 : st.since + max * 60000;
  if (!pushed && now >= until) {
    const state = { engine: land.engine, active: false, expiredAt: now };
    return { hold: false, expired: true, cap: null, why: `the ${L} land waited ${max} min (STUDIO_ENGINE_HOLD_MAX_MIN) for ${need} GB free RAM and ${free === null ? 'free RAM is unknown' : `${free} GB is free`}: the hold is released, the land stays queued`, freeGb: free, needGb: need, holders: labels, state };
  }
  if (enough) return { hold: true, cap: st.scaled ? Math.max(0, st.scaleBase - st.scaled) : null, until, why: `${free} GB free covers the ${L} land's ${need} GB: new verifies wait until it holds its slot`, holders: labels, state: st };
  // Not enough yet: the natural gap if the running verifies are about to finish; else scale down one at a time.
  const typical = Math.max(1, num(env.STUDIO_ENGINE_VERIFY_TYPICAL_MIN, 10));
  const soonMin = Math.max(0, num(env.STUDIO_ENGINE_WAIT_SOON_MIN, 5));
  const remaining = Math.max(0, ...verifies.map((h) => typical - (now - Number(h.at || now)) / 60000));
  const soon = verifies.length > 0 && remaining <= soonMin;
  const step = Math.max(0.1, num(env.STUDIO_ENGINE_SCALE_STEP_MIN, 3)) * 60000;
  let step1 = '';
  if (!soon && now - st.lastScaleAt >= step && st.scaleBase - st.scaled > 0) {
    st = { ...st, scaled: st.scaled + 1, lastScaleAt: now };
    step1 = `; builder target stepped down to ${Math.max(0, st.scaleBase - st.scaled)} (one at a time, none stopped)`;
  }
  const why = `${free === null ? 'free RAM unknown' : `${free} GB free`}, the ${L} land needs ${need} GB: new verifies wait${soon ? ` (the running ones are expected to finish within ~${Math.ceil(remaining)} min: waiting for that gap)` : verifies.length ? ` (${verifies.length} running verify(s) still have ~${Math.ceil(remaining)} min)` : ' (no verify is running: other heavy work holds the RAM)'}${step1}`;
  return { hold: true, cap: st.scaled ? Math.max(0, st.scaleBase - st.scaled) : null, until, why, holders: labels, state: st };
}

// ---- the pass --------------------------------------------------------------------------------------------------------

/** "Is a Line Producer making room right now?" for the land's own wait: the hold state is fresh (the pass rewrites it). */
export function lineHoldActive(root, now = Date.now()) {
  const s = readJson(holdStateFile(root), null);
  return Boolean(s?.active) && now - Number(s.seenAt || 0) < 5 * 60000;
}
/** How long a land waits for RAM in acquireHeavy (minutes): the Line's hold plus a margin, else its own shorter wait. */
export function landWaitMin(root, env = process.env, now = Date.now()) {
  const own = Math.max(1, num(env.STUDIO_ENGINE_LAND_WAIT_MIN, 20));
  return lineHoldActive(root, now) ? Math.max(own, holdMaxMin(env) + 5) : own;
}

/**
 * Look, decide, hold or release. deps: { root, heavy (heavy.mjs), readQueue(engine), freeGb, holders, near(engine)
 * -> bool, targets [{ name, label }], needGb(engine) -> number, builders, emit, log, claimedSlot(engine) }.
 * act false: decide only. Returns the plan plus { land, state }.
 */
export async function engineHoldPass({ now = Date.now(), env = process.env, act = true, builders = 0, owner = 'line-producer', deps = {} } = {}) {
  const root = deps.root;
  const prev = readJson(holdStateFile(root), null);
  const targets = deps.targets || [];
  const hv = deps.heavy || (await import('./heavy.mjs'));
  const holders = deps.holders || (() => { try { return hv.heavyHolders(root, { env }); } catch { return []; } })();
  let land = null;
  for (const t of targets) {
    const queued = (deps.readQueue ? deps.readQueue(t.name) : []).length > 0;
    const near = deps.near ? Boolean(await deps.near(t.name)) : false;
    const holdsSlot = holders.some((h) => h?.claim?.engine === t.name);
    if (!(queued || near || holdsSlot)) continue;
    land = { engine: t.name, label: t.label, queued, near, holdsSlot, needGb: deps.needGb(t.name), push: deps.push === t.name };
    if (!holdsSlot) break;
  }
  const plan = engineHoldPlan({ now, land, freeGb: deps.freeGb, holders, builders, prev }, env);
  if (act) {
    const clear = () => { try { hv.clearQuietHold(root, ENGINE_HOLD_TAG); } catch {} };
    if (plan.hold) {
      try { hv.markQuietHold(root, { ms: plan.until - now, tag: ENGINE_HOLD_TAG, owner, why: `the ${land.label || land.engine} land is queued: ${plan.why}`.slice(0, 240), now }); } catch {}
    } else clear();
    const emit = deps.emit || (() => {});
    if (plan.hold && !(prev?.active && prev.engine === land.engine)) emit({ type: 'line.engine_hold', agent: owner, to: 'producer', msg: `Line Producer: the ${land.label || land.engine} land is ${land.queued ? 'queued' : 'near'}: ${plan.why}`.slice(0, 600), meta: { engine: land.engine, freeGb: deps.freeGb ?? null, needGb: land.needGb } });
    if (plan.expired) emit({ type: 'line.engine_hold_expired', agent: owner, to: 'producer', status: 'warn', msg: `Line Producer: ${plan.why}; holders: ${plan.holders.join('; ') || 'none'}`.slice(0, 600), meta: { engine: land?.engine, freeGb: plan.freeGb, floorGb: plan.needGb, holders: plan.holders } });
    if (!plan.hold && prev?.active && !plan.expired) emit({ type: 'line.engine_hold_released', agent: owner, to: 'producer', msg: `Line Producer: engine hold released (${plan.why})`.slice(0, 400), meta: { engine: prev.engine } });
    try {
      fs.mkdirSync(path.dirname(holdStateFile(root)), { recursive: true });
      if (plan.state) fs.writeFileSync(holdStateFile(root), `${JSON.stringify({ ...plan.state, seenAt: now })}\n`);
      else fs.rmSync(holdStateFile(root), { force: true });
    } catch { /* best effort */ }
  }
  return { ...plan, land };
}
