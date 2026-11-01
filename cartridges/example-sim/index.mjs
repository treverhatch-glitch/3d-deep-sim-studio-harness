/**
 * cartridges/example-sim/index.mjs — reference deterministic sim cartridge.
 *
 * A tiny economy: units earn credits, each new unit costs more, power runs down every tick.
 * Win by reaching TUNING.winCredits before power runs out. Lose on negative credits or no power.
 * Pure: no DOM, no Three.js, no Math.random, no wall clock. Seeded Mulberry32 only.
 */

export const TUNING = Object.freeze({
  startCredits: 1500,
  startEnergy: 600, // ticks of power; 0 power = lost
  energyPerTick: 1,
  baseIncome: 20, // credits per tick
  unitIncome: 12, // credits per working unit per tick
  unitUpkeep: 4, // credits per working unit per tick
  spawnCost: 400, // first extra unit
  spawnCostGrowth: 60, // each further unit costs this much more
  driftRange: 40, // seeded income noise per tick
  winCredits: 25000,
});

const UNIT_KINDS = new Set(['vehicle', 'sensor']);

export function nextMulberry32(rngState) {
  let t = (rngState + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const nextState = (rngState + 0x6d2b79f5) >>> 0;
  const floatVal = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value: floatVal, rngState: nextState };
}

// Canonical JSON, the same text as harness/hash.mjs canonicalJson(): keys in code-point order,
// built directly because JSON.stringify moves integer-like keys ("0", "10") to the front.
function byCodePoint(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort(byCodePoint);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return 'null';
}

/**
 * The fast display hash: FNV-1a 64-bit over canonical JSON as UTF-8, the same function as
 * harness/hash.mjs hash64(), kept here so the cartridge ports on its own. For the HUD and quick
 * checks only; goldens and regressions are verified with SHA-256 by the harness.
 */
export function hashSimState(state) {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonicalJson(state))) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function createInitialState(seed = 42069, tuning = TUNING) {
  const cleanSeed = Number(seed) >>> 0;
  const t = { ...TUNING, ...tuning };
  return {
    seed: cleanSeed,
    rngState: cleanSeed,
    tick: 0,
    paused: false,
    won: false,
    lost: false,
    tuning: t,
    resources: { credits: t.startCredits, energy: t.startEnergy },
    entities: [
      { id: 'unit-1', kind: 'vehicle', x: 0, y: 0, z: 0, speed: 1 },
      { id: 'prop-1', kind: 'crate', x: 4, y: 0, z: -2, speed: 0 },
    ],
    actionLog: [],
  };
}

export const unitCount = (state) => state.entities.filter((e) => UNIT_KINDS.has(e.kind)).length;
export const nextUnitCost = (state) => state.tuning.spawnCost + state.tuning.spawnCostGrowth * (unitCount(state) - 1);

function normalizeActions(action) {
  if (!action) return [];
  return Array.isArray(action) ? action.filter(Boolean) : [action];
}

export function step(prevState, action = null) {
  const actions = normalizeActions(action);
  if (prevState.paused && !actions.some((a) => a.type === 'RESUME')) return prevState;
  const state = structuredClone(prevState);
  const t = state.tuning;
  state.tick += 1;

  for (const act of actions) {
    if (!act.type) continue;
    if (act.type === 'PAUSE') state.paused = true;
    if (act.type === 'RESUME') state.paused = false;
    if (act.type === 'SPAWN_ENTITY' || act.type === 'spawn') {
      const kind = act.kind || 'crate';
      const cost = UNIT_KINDS.has(kind) ? nextUnitCost(state) : 0;
      // A caller-given id already in use is refused like an unaffordable spawn (logged, ok: false, nothing charged):
      // two entities with one id broke the DUPLICATE_ID invariant (found by a fuzz run, 2.65.2).
      const taken = act.id != null && state.entities.some((e) => e.id === act.id);
      const ok = !taken && state.resources.credits >= cost;
      state.actionLog.push({ tick: state.tick, action: act, ok });
      if (!ok) continue;
      state.entities.push({
        id: act.id || `entity-${state.tick}-${state.entities.length}`,
        kind,
        x: Number(act.x || 0),
        y: 0,
        z: Number(act.z || 0),
        speed: UNIT_KINDS.has(kind) ? 1 : 0,
      });
      state.resources.credits -= cost;
      continue;
    }
    state.actionLog.push({ tick: state.tick, action: act, ok: true });
  }

  const rng = nextMulberry32(state.rngState);
  state.rngState = rng.rngState;
  const drift = Math.round((rng.value - 0.45) * t.driftRange);
  const units = unitCount(state);
  state.resources.credits += t.baseIncome + units * (t.unitIncome - t.unitUpkeep) + drift;
  state.resources.energy = Math.max(0, state.resources.energy - t.energyPerTick);

  for (const ent of state.entities) {
    if (ent.speed > 0) ent.x = Number((ent.x + ent.speed * 0.5).toFixed(3));
  }

  if (!state.won && !state.lost) {
    if (state.resources.credits >= t.winCredits) state.won = true;
    else if (state.resources.credits < 0 || state.resources.energy <= 0) state.lost = true;
  }
  return state;
}

export function invariants(state) {
  const findings = [];
  const { credits, energy } = state.resources;
  if (!Number.isFinite(credits)) findings.push({ id: 'CREDITS_NONFINITE', severity: 'P0', summary: `credits is ${credits}` });
  if (energy < 0 || energy > state.tuning.startEnergy) {
    findings.push({ id: 'ENERGY_RANGE', severity: 'P0', summary: `energy ${energy} outside 0..${state.tuning.startEnergy}` });
  }
  const ids = new Set();
  for (const e of state.entities) {
    if (ids.has(e.id)) findings.push({ id: 'DUPLICATE_ID', severity: 'P1', summary: `entity id ${e.id} used twice` });
    ids.add(e.id);
  }
  if (state.won && state.lost) findings.push({ id: 'WON_AND_LOST', severity: 'P0', summary: 'state is both won and lost' });
  return findings;
}

export function outcome(state) {
  return state.won ? 'won' : state.lost ? 'lost' : null;
}

export function replayToTick({ seed = 42069, tick = 120, actions = [] } = {}) {
  let state = createInitialState(seed);
  const actionsByTick = new Map();
  for (const entry of actions) {
    if (!entry || typeof entry.tick !== 'number') continue;
    const list = actionsByTick.get(entry.tick) || [];
    list.push(entry.action || entry);
    actionsByTick.set(entry.tick, list);
  }
  for (let t = 1; t <= tick; t++) {
    state = step(state, actionsByTick.get(t) || null);
  }
  return { seed, tick: state.tick, hash: hashSimState(state), state };
}

/** Browser bridge for ?playtest=1. The host page passes its window in; the sim never touches globals. */
export function mountPlaytestApi(targetWindow) {
  if (!targetWindow) return null;
  let current = createInitialState(42069);
  const api = {
    reset(seed = 42069) {
      current = createInitialState(seed);
      return current;
    },
    step(ticks = 1, action = null) {
      for (let i = 0; i < ticks; i++) current = step(current, i === 0 ? action : null);
      return current;
    },
    dispatch(action) {
      current = step(current, action);
      return current;
    },
    getState() {
      return current;
    },
    getHash() {
      return hashSimState(current);
    },
    serialize() {
      return JSON.stringify(current);
    },
    deserialize(raw) {
      current = JSON.parse(raw);
      return current;
    },
    replay(payload) {
      const res = replayToTick(payload);
      current = res.state;
      return res;
    },
  };
  targetWindow.__sim = api;
  return api;
}
