#!/usr/bin/env node
import { replayToTick } from '../cartridges/example-sim/index.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const seeds = arg('--seeds', 5);
const ticks = arg('--ticks', 100);

function hasBadNumber(value) {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasBadNumber);
  if (value && typeof value === 'object') return Object.values(value).some(hasBadNumber);
  return false;
}

for (let i = 0; i < seeds; i++) {
  const seed = 1000 + i;
  const a = replayToTick({ seed, tick: ticks, actions: [] });
  const b = replayToTick({ seed, tick: ticks, actions: [] });
  if (a.hash !== b.hash) {
    console.error(`[soak] FAIL seed ${seed}: ${a.hash} != ${b.hash}`);
    process.exit(1);
  }
  if (hasBadNumber(a.state)) {
    console.error(`[soak] FAIL seed ${seed}: non-finite state`);
    process.exit(1);
  }
  console.log(`[soak] PASS seed ${seed} hash ${a.hash}`);
}
console.log(`[soak] ${seeds} seeds x ${ticks} ticks ok`);
