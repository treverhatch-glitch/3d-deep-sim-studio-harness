/**
 * cartridges/example-sim/index.mjs — Reference Deterministic 3D Sim Cartridge
 *
 * Demonstrates the #1 mandatory rule for every new game in this harness:
 *   Implement a deterministic SEED + FIXED-TICK system FIRST so automated QA
 *   and bug replay (`{ seed, tick, description }`) can scroll back to any
 *   exact failing moment.
 *
 * Pure JS/TS: ZERO DOM, Three.js, unseeded RNG, or wall-clock calls inside
 * simulation state transitions.
 */

export function nextMulberry32(rngState) {
  let t = (rngState + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const nextState = (rngState + 0x6d2b79f5) >>> 0;
  const floatVal = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value: floatVal, rngState: nextState };
}

export function hashSimState(state) {
  const json = JSON.stringify(state);
  let hash = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function createInitialState(seed = 42069) {
  const cleanSeed = Number(seed) >>> 0;
  return {
    seed: cleanSeed,
    rngState: cleanSeed,
    tick: 0,
    paused: false,
    resources: {
      credits: 10000,
      energy: 500,
    },
    entities: [
      { id: 'unit-1', kind: 'vehicle', x: 0, y: 0, z: 0, speed: 1 },
      { id: 'prop-1', kind: 'crate', x: 4, y: 0, z: -2, speed: 0 },
    ],
    actionLog: [],
  };
}

export function step(prevState, action = null) {
  if (prevState.paused && (!action || action.type !== 'RESUME')) {
    return prevState;
  }
  const state = structuredClone(prevState);
  state.tick += 1;

  if (action && action.type) {
    state.actionLog.push({ tick: state.tick, action });
    if (action.type === 'SPAWN_ENTITY') {
      state.entities.push({
        id: action.id || `entity-${state.tick}`,
        kind: action.kind || 'crate',
        x: Number(action.x || 0),
        y: 0,
        z: Number(action.z || 0),
        speed: Number(action.speed ?? 1),
      });
      state.resources.credits -= Number(action.cost ?? 250);
    }
  }

  const rng = nextMulberry32(state.rngState);
  state.rngState = rng.rngState;

  const drift = Math.round((rng.value - 0.45) * 40);
  state.resources.credits += 25 + drift;
  state.resources.energy = Math.max(0, state.resources.energy - 1);

  for (const ent of state.entities) {
    if (ent.speed > 0) {
      ent.x = Number((ent.x + ent.speed * 0.5).toFixed(3));
    }
  }

  return state;
}

/**
 * Deterministically replay from `{ seed, tick, actions }` to reproduce any bug state.
 */
export function replayToTick({ seed = 42069, tick = 120, actions = [] } = {}) {
  let state = createInitialState(seed);
  const actionsByTick = new Map();
  for (const entry of actions) {
    if (entry && typeof entry.tick === 'number') {
      actionsByTick.set(entry.tick, entry.action || entry);
    }
  }
  for (let t = 1; t <= tick; t++) {
    state = step(state, actionsByTick.get(t) || null);
  }
  return {
    seed,
    tick: state.tick,
    hash: hashSimState(state),
    state,
  };
}

/**
 * Expose both `window.__hatch` and `window.__sim` when running in a browser with `?playtest=1`.
 */
export function mountPlaytestApi(targetWindow) {
  if (!targetWindow) return null;
  let current = createInitialState(42069);
  const api = {
    reset(seed = 42069) {
      current = createInitialState(seed);
      return current;
    },
    step(ticks = 1, action = null) {
      for (let i = 0; i < ticks; i++) {
        current = step(current, i === 0 ? action : null);
      }
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
