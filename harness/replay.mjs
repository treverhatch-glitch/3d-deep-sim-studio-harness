#!/usr/bin/env node
/**
 * harness/replay.mjs — Deterministic Seed + Tick Bug Replay Runner
 *
 * Every game built with this harness implements a deterministic seed + tick
 * system FIRST so any bug recorded as `{ seed, tick, description, actions }`
 * can be replayed to the exact failing moment.
 *
 * Usage:
 *   node harness/replay.mjs --seed 42069 --tick 120 --desc "Verify tick 120 state"
 */

import { runDeterministicTrajectory } from '../qa/hatchfield.adapter.mjs';
import { emitEvent } from './event.mjs';

function parseArgs(argv) {
  const out = { seed: 42069, tick: 120, desc: 'Deterministic bug replay', actions: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') out.seed = Number(argv[++i] || 42069);
    else if (argv[i] === '--tick') out.tick = Number(argv[++i] || 120);
    else if (argv[i] === '--desc') out.desc = String(argv[++i] || out.desc);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const result = await runDeterministicTrajectory({
  seed: args.seed,
  tick: args.tick,
  description: args.desc,
  actions: args.actions,
});

emitEvent({
  type: 'sim.replay',
  agent: 'playtester',
  status: result.deterministic ? 'IDLE' : 'ERROR',
  task: `SEED-${args.seed}@T${args.tick}`,
  target: 'cartridges/example-sim/index.mjs',
  tokensSaved: 3600,
  msg: `Replayed { seed: ${args.seed}, tick: ${args.tick} } -> hash=${result.hash} (deterministic=${result.deterministic})`,
});

console.log(
  JSON.stringify(
    {
      replayPayload: {
        seed: args.seed,
        tick: args.tick,
        description: args.desc,
      },
      deterministic: result.deterministic,
      hash: result.hash,
      hashVerify: result.hashVerify,
      entitiesCount: result.state?.entities?.length ?? 0,
      resources: result.state?.resources ?? {},
    },
    null,
    2
  )
);

if (!result.deterministic) {
  process.exit(1);
}
