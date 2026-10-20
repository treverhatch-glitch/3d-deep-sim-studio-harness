/**
 * cartridges/example-sim/qa.mjs — scripted scenarios the harness can play.
 * Policies must be pure functions of (state, tick): they run inside replays and goldens.
 */
import { nextUnitCost } from './index.mjs';

// Buy a unit when it is affordable and pays for itself within half the power that is left.
const expandPolicy = (state, tick) => {
  const cost = nextUnitCost(state);
  const net = state.tuning.unitIncome - state.tuning.unitUpkeep;
  const paysBack = net > 0 && cost / net < state.resources.energy / 2;
  if (paysBack && state.resources.credits >= cost + 200) {
    return { type: 'spawn', kind: 'vehicle', id: `bought-${tick}`, x: 0, z: tick % 7 };
  }
  return null;
};

export const scenarios = {
  // The vertical slice: new game to win, no human input. Golden: qa/golden/example-sim-start-to-win.json
  'start-to-win': { seed: 1337, maxTicks: 600, policy: expandPolicy, expect: 'won' },
  // Never buy anything: should run out of power before it wins.
  idle: { seed: 1337, maxTicks: 600, expect: 'lost' },
};
