/**
 * harness/engine-ram.mjs: what an engine land needs in free RAM, and how the Line Producer makes room for it (2.79.1, 3.2).
 *
 * 2.79.0 held 12 GB free for a Unity land by making the land wait 60 min for it, then refuse, while six builders kept
 * starting verifies. The owner's direction: no permanent reservation (idle reserved RAM is wasted); account for the land
 * only while one is queued or near, and release at once when it starts. So:
 *
 *   1. The need. The engine table's floor (engine-tracks.mjs engineFloor), or better the peak RAM measured in the last
 *      green land runs of that engine plus a margin, never under a small minimum. A run keeps its peak in
 *      .studio/engine-ram.json (recordLandPeak: the machine monitor's history samples taken while it ran). The owner's
 *      environment floor and the lane's tuned ram-floor still win (engineFloor).
 *   2. The hold (engineHoldPlan, pure; engineHoldPass reads the machine). While a land is queued, or near (an engine
 *      porter ran `task done --check`), and its slot isn't taken yet: new heavy starts wait (a quiet hold tagged
 *      "engine-land": builders keep coding; running verifies finish; the land itself ignores this hold). If the running
 *      verifies are about to finish (their elapsed against the typical verify time), that is the natural gap: wait. If
 *      not, and free RAM still isn't enough, the builder target steps down one at a time (never a kill). The moment the land
 *      holds its slot the hold is released and builders refill.
 *   3. Bounded: STUDIO_ENGINE_HOLD_MAX_MIN (30; 0: no hold). Past it the hold is released, the land stays queued, one
 *      line.engine_hold_expired event says why (free RAM, the need, the holders), and the hold comes back at the next
 *      natural gap (no verify running, or free RAM at the need).
 *
 * Settings: STUDIO_ENGINE_HOLD_MAX_MIN (30), STUDIO_ENGINE_RAM_MARGIN_GB (1.5), STUDIO_ENGINE_RAM_MIN_GB (4),
 * STUDIO_ENGINE_RAM_RUNS (3: green runs before the measured need replaces the table's; 0: always the table),
 * STUDIO_ENGINE_VERIFY_TYPICAL_MIN (10), STUDIO_ENGINE_WAIT_SOON_MIN (5), STUDIO_ENGINE_SCALE_STEP_MIN (3),
 * STUDIO_ENGINE_NEAR_MIN (30: how long a porter's `task done --check` counts as "a land is near"),
 * STUDIO_ENGINE_LAND_WAIT_MIN (20: how long a land waits for RAM when no Line Producer runs).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const num = (v, d) => { const s = String(v ?? '').trim(); const n = Number(s); return s !== '' && Number.isFinite(n) ? n : d; };
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const r1 = (x) => Math.round(x * 10) / 10;
const tsOf = (v) => (typeof v === 'number' ? v : Date.parse(v));

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

// ---- 1. the measured need ---------------------------------------------------------------------------------------

/** The machine monitor's samples (.studio/machine-history.jsonl: { at, ram: [usedGb, totalGb] }) as [{ at, used }]. */
export function readUsedHistory(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.studio', 'machine-history.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!l.trim()) continue;
    try { const s = JSON.parse(l); const at = tsOf(s.at); if (Number.isFinite(at) && Number.isFinite(Number(s.ram?.[0]))) out.push({ at, used: Number(s.ram[0]) }); } catch { /* skip */ }
  }
  return out;
}

/**
 * The extra RAM a land run took: the highest used-RAM sample while it ran, less the sample just before it started
 * (taken at most 10 min earlier). null when the monitor has no sample on either side (nothing is guessed).
 */
export function peakFromHistory(samples, startMs, endMs) {
  const before = samples.filter((s) => s.at <= startMs && startMs - s.at <= 600000).sort((a, b) => b.at - a.at)[0];
  const during = samples.filter((s) => s.at > startMs && s.at <= endMs + 60000);
  if (!before || !during.length) return null;
  return r1(Math.max(0, Math.max(...during.map((s) => s.used)) - before.used));
}

/** Keep one land run's measured peak (green runs teach the need; others are kept for the record). Never throws. */
export function recordLandPeak(engine, { root, startMs, endMs, status, samples = null } = {}) {
  try {
    const gb = peakFromHistory(samples || readUsedHistory(root), startMs, endMs);
    if (gb === null || !(gb > 0)) return null;
    const all = readJson(ramFile(root), {}) || {};
    const list = Array.isArray(all[engine]?.peaks) ? all[engine].peaks : [];
    list.push({ gb, status: status || null, at: new Date(endMs).toISOString() });
    all[engine] = { peaks: list.slice(-20) };
    fs.mkdirSync(path.dirname(ramFile(root)), { recursive: true });
    fs.writeFileSync(ramFile(root), `${JSON.stringify(all, null, 2)}\n`);
    return gb;
  } catch { return null; }
}

/** The measured need of an engine's land: { gb, n, peak, from } from the last green runs, or null (too few runs / off). */
export function learnedNeed(engine, { root, env = process.env } = {}) {
  const runs = num(env.STUDIO_ENGINE_RAM_RUNS, 3);
  if (!(runs > 0)) return null;
  const green = ((readJson(ramFile(root), {}) || {})[engine]?.peaks || []).filter((p) => p.status === 'pass' && Number(p.gb) > 0).slice(-5);
  if (green.length < runs) return null;
  const peak = Math.max(...green.map((p) => Number(p.gb)));
  const margin = Math.max(0, num(env.STUDIO_ENGINE_RAM_MARGIN_GB, 1.5));
  const min = Math.max(0, num(env.STUDIO_ENGINE_RAM_MIN_GB, 4));
  const gb = Math.max(min, Math.ceil((peak + margin) * 10) / 10);
  return { gb, n: green.length, peak, from: `measured: the peak of the last ${green.length} green land run(s) was ${peak} GB, plus ${margin} GB margin${gb === min && peak + margin < min ? `, raised to the ${min} GB minimum` : ''} (.studio/engine-ram.json)` };
}

// ---- 2. the hold --------------------------------------------------------------------------------------------------

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
