/**
 * cartridges/_template/qa.mjs — scenarios the harness plays (playtest, vertical slice, goldens, balance, fun).
 * A policy is a pure function of (state, tick) that returns an action, an array of actions, or null.
 */

// Hire whenever affordable during the first half of the time limit.
const growPolicy = (state) => (state.credits >= state.tuning.workerCost && state.tick < state.tuning.timeLimit / 2 ? { type: 'hire' } : null);

export const scenarios = {
  // Required: new game to win with no human input. Golden: qa/golden/<name>-start-to-win.json
  'start-to-win': { seed: 1, maxTicks: 400, policy: growPolicy, expect: 'won' },
  // Doing nothing should not win; the fun check uses this to prove choices matter.
  idle: { seed: 1, maxTicks: 400, expect: 'lost' },
};
