/**
 * Copy this folder to cartridges/<your-game>/ and rename exports as needed.
 * Keep the sim pure: no DOM, no Three.js, no Math.random, no Date.now.
 */

export function createInitialState(seed = 1337) {
  return {
    seed: Number(seed) >>> 0,
    rngState: Number(seed) >>> 0,
    tick: 0,
    resources: { credits: 1000 },
    entities: [],
    won: false,
    lost: false,
  };
}

function nextRng(state) {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, rngState: (state + 0x6d2b79f5) >>> 0 };
}

export function step(prev, action = null) {
  const state = structuredClone(prev);
  state.tick += 1;
  if (action?.type === 'spawn') {
    state.entities.push({ id: `e-${state.tick}`, x: Number(action.x || 0), z: Number(action.z || 0) });
    state.resources.credits -= 10;
  }
  const rng = nextRng(state.rngState);
  state.rngState = rng.rngState;
  state.resources.credits += 1;
  if (state.entities.length >= 3) state.won = true;
  if (state.resources.credits < 0) state.lost = true;
  return state;
}

export function invariants(state) {
  const findings = [];
  if (!Number.isFinite(state.resources.credits)) {
    findings.push({ id: 'CREDITS', severity: 'P0', tick: state.tick, summary: 'credits not finite' });
  }
  return findings;
}
