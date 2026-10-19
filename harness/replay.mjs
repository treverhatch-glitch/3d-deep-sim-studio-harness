#!/usr/bin/env node
/**
 * harness/replay.mjs — Deterministic Seed + Tick Bug Replay Runner
 *
 * Usage:
 *   node harness/replay.mjs --seed 1337 --tick 200
 *   node harness/replay.mjs --trace .studio/last-seed-failure.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { runDeterministicTrajectory } from '../qa/hatchfield.adapter.mjs';
import { emitEvent, REPO_ROOT } from './event.mjs';

function parseArgs(argv) {
  const out = { seed: 1337, tick: 200, desc: 'Deterministic bug replay', actions: [], trace: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seed') out.seed = Number(argv[++i] || out.seed);
    else if (argv[i] === '--tick') out.tick = Number(argv[++i] || out.tick);
    else if (argv[i] === '--desc') out.desc = String(argv[++i] || out.desc);
    else if (argv[i] === '--trace') out.trace = String(argv[++i] || '');
  }
  return out;
}

function loadTrace(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath);
  if (!fs.existsSync(abs)) {
    throw new Error(`Trace file not found: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

const args = parseArgs(process.argv.slice(2));
if (args.trace) {
  const trace = loadTrace(args.trace);
  if (trace.seed != null) args.seed = Number(trace.seed);
  if (trace.tick != null) args.tick = Number(trace.tick);
  if (trace.description) args.desc = trace.description;
  if (Array.isArray(trace.actions)) args.actions = trace.actions;
}

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
  msg: `Replayed { seed: ${args.seed}, tick: ${args.tick}, actions: ${args.actions.length} } -> hash=${result.hash}`,
});

console.log(JSON.stringify({
  replayPayload: {
    seed: args.seed,
    tick: args.tick,
    description: args.desc,
    actions: args.actions,
  },
  deterministic: result.deterministic,
  hash: result.hash,
  hashVerify: result.hashVerify,
  entitiesCount: result.state?.entities?.length ?? 0,
  resources: result.state?.resources ?? {},
}, null, 2));

if (!result.deterministic) process.exit(1);
