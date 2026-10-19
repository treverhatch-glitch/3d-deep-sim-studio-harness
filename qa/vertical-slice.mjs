#!/usr/bin/env node
import { createInitialState, step, hashSimState } from '../cartridges/example-sim/index.mjs';

function hasBad(value) {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasBad);
  if (value && typeof value === 'object') return Object.values(value).some(hasBad);
  return false;
}

const seed = 1337;
let state = createInitialState(seed);
const start = Date.now();
for (let t = 1; t <= 30; t++) {
  const action = t === 1 ? { type: 'spawn', kind: 'sensor', x: 1, z: 1 } : null;
  state = step(state, action);
  if (hasBad(state)) {
    console.error(`[slice] FAIL non-finite at tick ${t}`);
    process.exit(1);
  }
}
const ms = Date.now() - start;
if (state.entities.length < 3) {
  console.error('[slice] FAIL expected spawned entity');
  process.exit(1);
}
if (state.resources.credits <= 0) {
  console.error('[slice] FAIL credits depleted unexpectedly');
  process.exit(1);
}
const again = (() => {
  let s = createInitialState(seed);
  for (let t = 1; t <= 30; t++) s = step(s, t === 1 ? { type: 'spawn', kind: 'sensor', x: 1, z: 1 } : null);
  return hashSimState(s);
})();
if (again !== hashSimState(state)) {
  console.error('[slice] FAIL non-deterministic');
  process.exit(1);
}
console.log(`[slice] PASS tick=${state.tick} entities=${state.entities.length} ms=${ms} hash=${hashSimState(state)}`);
