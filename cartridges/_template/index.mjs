/**
 * cartridges/_template/index.mjs — the smallest cartridge that passes every gate.
 * `npm run new-game <name>` copies this folder. Replace the economy with your game; keep the contract:
 *
 *   createInitialState(seed, tuning?)  plain JSON state, seeded RNG state inside it
 *   step(state, actions|null)          one fixed tick; returns a NEW state; actions is an array or null
 *   invariants(state)                  [{ id, severity: 'P0'|'P1'|'P2', summary }]
 *   outcome(state)                     'won' | 'lost' | null
 *   actions(state, rand)               one random player action (or [actions] or null) for npm run fuzz
 *   TUNING                             every balance number in one table (the balancer sweeps it)
 *
 * Pure: no DOM, no Three.js, no Math.random, no Date, no timers. The purity gate traps them at runtime.
 */

export const TUNING = Object.freeze({
  startCredits: 100,
  baseIncome: 1, // credits per tick with no workers
  workerCost: 50,
  workerIncome: 2, // credits per worker per tick
  noise: 2, // seeded +/- credits per tick
  winCredits: 1000,
  timeLimit: 400, // ticks; reaching it without winning is a loss
});

// Mulberry32: the RNG state lives in the sim state, so replays are exact.
function nextRng(rngState) {
  let t = (rngState + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, rngState: (rngState + 0x6d2b79f5) >>> 0 };
}

export function createInitialState(seed = 1, tuning = TUNING) {
  const t = { ...TUNING, ...tuning };
  return {
    seed: Number(seed) >>> 0,
    rngState: Number(seed) >>> 0,
    tick: 0,
    tuning: t,
    credits: t.startCredits,
    workers: 0,
    won: false,
    lost: false,
  };
}

export function step(prev, actions = null) {
  const state = structuredClone(prev);
  const t = state.tuning;
  state.tick += 1;
  for (const action of actions || []) {
    if (action?.type === 'hire' && state.credits >= t.workerCost) {
      state.credits -= t.workerCost;
      state.workers += 1;
    }
  }
  const rng = nextRng(state.rngState);
  state.rngState = rng.rngState;
  state.credits += t.baseIncome + state.workers * t.workerIncome + Math.round((rng.value - 0.5) * 2 * t.noise);
  if (!state.won && !state.lost) {
    if (state.credits >= t.winCredits) state.won = true;
    else if (state.tick >= t.timeLimit || state.credits < 0) state.lost = true;
  }
  return state;
}

export function invariants(state) {
  const findings = [];
  if (!Number.isInteger(state.workers) || state.workers < 0) findings.push({ id: 'WORKERS_RANGE', severity: 'P0', summary: `workers is ${state.workers}` });
  if (state.won && state.lost) findings.push({ id: 'WON_AND_LOST', severity: 'P0', summary: 'state is both won and lost' });
  return findings;
}

/**
 * Fuzz actions (npm run fuzz, qa/fuzz.mjs): return one action a player could send now, an array, or null. Use only the
 * seeded `rand` passed in (rand() in [0, 1), rand.int(n), rand.pick(list)), never Math.random. Cover every action type
 * step() accepts, including ones that should be refused (unaffordable, unknown ids): the fuzzer checks invariants(),
 * a JSON save/load round trip and determinism after each, and shrinks any failure to a short repro.
 */
export function actions(state, rand) {
  // Mostly hires (refused when unaffordable), sometimes an action step() doesn't know (it must be ignored).
  return rand() < 0.8 ? { type: 'hire' } : { type: rand.pick(['fire', 'unknown']) };
}

export function outcome(state) {
  return state.won ? 'won' : state.lost ? 'lost' : null;
}
