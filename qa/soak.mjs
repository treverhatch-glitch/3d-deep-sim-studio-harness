#!/usr/bin/env node
/**
 * Soak: N seeds x M ticks, fail on NaN or non-determinism.
 * Usage: node qa/soak.mjs --seeds 5 --ticks 100
 */
import { replayToTick, hashSimState } from '../cartridges/example-sim/index.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const seeds = arg('--seeds', 5);
const ticks = arg('--ticks', 100);

for (let i = 0; i < seeds; i++) {
  const seed = 1000 + i;
  const a = replayToTick({ seed, tick: ticks, actions: [] });
  const b = replayToTick({ seed, tick: ticks, actions: [] });
  if (a.hash !== b.hash) {
    console.error(`[soak] FAIL seed ${seed}: ${a.hash} != ${b.hash}`);
    process.exit(1);
  }
  const blob = JSON.stringify(a.state);
  if (blob.includes('NaN') || blob.includes('Infinity')) {
    console.error(`[soak] FAIL seed ${seed}: non-finite state`);
    process.exit(1);
  }
  console.log(`[soak] PASS seed ${seed} hash ${a.hash}`);
}
console.log(`[soak] ${seeds} seeds x ${ticks} ticks ok`);
