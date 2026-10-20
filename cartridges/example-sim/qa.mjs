/**
 * cartridges/example-sim/qa.mjs — scripted scenarios the harness can play.
 * Policies must be pure functions of (state, tick): they run inside replays and goldens.
 */
import { nextUnitCost, unitCount } from './index.mjs';

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

// The browser build (web/example-sim/). The browser play gate (qa/browser-play.mjs) opens it, plays
// start-to-win with real key presses chosen by the same policy, and compares what the screen shows
// (window.__view) with the sim (window.__sim) as it goes.
export const browser = {
  page: 'web/example-sim/index.html',
  query: 'playtest=1&speed=2',
  scenario: 'start-to-win',
  maxMs: 40000,
  // Which real input performs a sim action.
  input: (action) => (action.type === 'spawn' ? { key: 'b' } : null),
  // What the screen must agree with; each string is a mismatch.
  wiring: (state, view) => {
    const out = [];
    if (view.hud.credits !== Math.floor(state.resources.credits)) out.push(`HUD credits ${view.hud.credits}, sim ${Math.floor(state.resources.credits)}`);
    if (view.hud.energy !== state.resources.energy) out.push(`HUD power ${view.hud.energy}, sim ${state.resources.energy}`);
    if (view.hud.units !== unitCount(state)) out.push(`HUD units ${view.hud.units}, sim ${unitCount(state)}`);
    if (view.drawn !== state.entities.length) out.push(`${view.drawn} things drawn, sim has ${state.entities.length}`);
    return out;
  },
};
