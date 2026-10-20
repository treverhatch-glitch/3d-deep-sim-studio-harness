#!/usr/bin/env node
/**
 * harness/replay.mjs — replay any cartridge to an exact seed + tick, twice, and prove it matches.
 *
 *   node harness/replay.mjs --seed 1337 --tick 200 [--cartridge example-sim]
 *   node harness/replay.mjs --trace .studio/last-seed-failure.json
 *   node harness/replay.mjs --golden qa/golden/example-sim-start-to-win.json [--state-out state.json]
 *   node harness/replay.mjs --scenario start-to-win
 *
 * Exit 1 when the two runs disagree or the run hits a failing tick.
 */

import fs from 'node:fs';
import path from 'node:path';
import { emitEvent, REPO_ROOT } from './event.mjs';
import { cartridgeFromArgv, loadCartridge, replay, runScenario } from './cartridge.mjs';

function parseArgs(argv) {
  const out = { seed: 1337, tick: 200, actions: [], desc: 'Deterministic replay' };
  for (let i = 0; i < argv.length; i++) {
    const next = () => String(argv[++i] ?? '');
    if (argv[i] === '--seed') out.seed = Number(next());
    else if (argv[i] === '--tick') out.tick = Number(next());
    else if (argv[i] === '--desc') out.desc = next();
    else if (argv[i] === '--trace') out.trace = next();
    else if (argv[i] === '--golden') out.golden = next();
    else if (argv[i] === '--scenario') out.scenario = next();
    else if (argv[i] === '--state-out') out.stateOut = next();
    else if (argv[i] === '--quiet') out.quiet = true;
  }
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(REPO_ROOT, file), 'utf8'));

const args = parseArgs(process.argv.slice(2));
let cartName = cartridgeFromArgv();
for (const file of [args.trace, args.golden].filter(Boolean)) {
  const spec = readJson(file);
  if (spec.cartridge && !process.argv.includes('--cartridge')) cartName = spec.cartridge;
  if (spec.seed != null) args.seed = Number(spec.seed);
  if (spec.tick != null) args.tick = Number(spec.tick);
  if (spec.scenario) args.scenario = spec.scenario;
  if (spec.description) args.desc = spec.description;
  if (Array.isArray(spec.actions)) args.actions = spec.actions;
  if (spec.tuning) args.tuning = spec.tuning;
}

const cart = await loadCartridge(cartName);
const run = () =>
  args.scenario
    ? runScenario(cart, args.scenario, { seed: args.seed, tuning: args.tuning })
    : replay(cart, { seed: args.seed, tick: args.tick, actions: args.actions, tuning: args.tuning });
const a = run();
const b = run();
const deterministic = a.hash === b.hash;

if (args.stateOut) fs.writeFileSync(args.stateOut, JSON.stringify(a.state));

emitEvent({
  type: 'sim.replay',
  agent: 'playtester',
  status: deterministic && !a.findings.length ? 'IDLE' : 'ERROR',
  task: `SEED-${args.seed}@T${a.failingTick ?? args.tick}`,
  target: `cartridges/${cart.name}`,
  msg: `Replayed ${cart.name} seed ${args.seed} -> ${a.hash}${a.failingTick ? ` (fails at tick ${a.failingTick})` : ''}`,
});

if (!args.quiet) {
  console.log(
    JSON.stringify(
      {
        cartridge: cart.name,
        scenario: args.scenario || null,
        seed: args.seed,
        tick: args.scenario ? a.ticksRun : args.tick,
        description: args.desc,
        actions: args.scenario ? a.actions.length : args.actions.length,
        deterministic,
        hash: a.hash,
        hashVerify: b.hash,
        outcome: a.outcome,
        failingTick: a.failingTick,
        findings: a.findings,
      },
      null,
      2
    )
  );
}

if (!deterministic || a.findings.length) process.exit(1);
