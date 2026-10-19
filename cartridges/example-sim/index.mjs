/**
 * cartridges/example-sim/index.mjs — Reference Deterministic 3D Sim Cartridge
 */

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

export function hashSimState(state) {
  const json = JSON.stringify(canonical(state));
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
    resources: { credits: 10000, energy: 500 },
    entities: [
      { id: 'unit-1', kind: 'vehicle', x: 0, y: 0, z: 0, speed: 1 },
      { id: 'prop-1', kind: 'crate', x: 4, y: 0, z: -2, speed: 0 },
    ],
    actionLog: [],
  };
}

function normalizeActions(action) {
  if (!action) return [];
  return Array.isArray(action) ? action.filter(Boolean) : [action];
}

export function step(prevState, action = null) {
  if (prevState.paused && (!action || (action.type && action.type !== 'RESUME'))) {
    return prevState;
  }
  const state = structuredClone(prevState);
  state.tick += 1;

  for (const act of normalizeActions(action)) {
    if (!act || !act.type) continue;
    state.actionLog.push({ tick: state.tick, action: act });
    if (act.type === 'SPAWN_ENTITY' || act.type === 'spawn') {
      state.entities.push({
        id: act.id || `entity-${state.tick}-${state.entities.length}`,
        kind: act.kind || 'crate',
        x: Number(act.x || 0),
        y: 0,
        z: Number(act.z || 0),
        speed: Number(act.speed ?? 1),
      });
      state.resources.credits -= Number(act.cost ?? 250);
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
    getState() { return current; },
    getHash() { return hashSimState(current); },
    serialize() { return JSON.stringify(current); },
    deserialize(raw) { current = JSON.parse(raw); return current; },
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
