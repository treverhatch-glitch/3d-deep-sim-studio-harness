import { createInitialState, step, invariants } from './index.mjs';

export function createAdapter() {
  let state = createInitialState(1337);
  return {
    name: 'example-sim',
    init(seed = 1337) {
      state = createInitialState(seed);
      return state;
    },
    step(ticks = 1, action = null) {
      for (let i = 0; i < ticks; i++) state = step(state, i === 0 ? action : null);
      return state;
    },
    getState() { return state; },
    invariants(s) { return typeof invariants === 'function' ? invariants(s) : []; },
  };
}

export const scenarios = {
  startToWin: { seed: 1337, maxTicks: 300, expect: 'won' },
  idle: { seed: 1337, maxTicks: 600, expect: 'lost' },
};
