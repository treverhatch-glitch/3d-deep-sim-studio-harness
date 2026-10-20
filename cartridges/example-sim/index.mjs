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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonical(value[key]);
      return acc;
    }, {});
  }
  return value;
}

/** Same function as harness/hash.mjs, kept here so the cartridge ports on its own. */
export function hashSimState(state) {
  const json = JSON.stringify(canonical(state));
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h2 = (h2 + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
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
      const ok = state.resources.credits >= cost;
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
  targetWindow.__hatch = api;
  targetWindow.__sim = api;
  return api;
}
