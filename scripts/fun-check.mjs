#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, step } from '../cartridges/example-sim/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seeds = [1, 7, 42, 1337];
let dead = 0;
let starved = 0;
let wins = 0;

for (const seed of seeds) {
  let state = createInitialState(seed);
  let last = JSON.stringify(state.entities);
  let still = 0;
  for (let t = 1; t <= 30; t++) {
    state = step(state, t === 1 ? { type: 'spawn', kind: 'sensor', x: 1, z: 1 } : null);
    const now = JSON.stringify(state.entities);
    if (now === last) still += 1;
    last = now;
  }
  if (still > 20) dead += 1;
  if (state.resources.credits < 0) starved += 1;
  if (state.won) wins += 1;
}

const report = [
  '# Fun proxy report',
  '',
  `- seeds: ${seeds.length}`,
  `- wins: ${wins}`,
  `- starved: ${starved}`,
  `- dead-time seeds: ${dead}`,
  '- human-review: required',
  '',
  'Proxies only. A human decides if the slice is fun.',
].join('\n');
const out = path.join(root, 'studio', 'fun', 'latest.md');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, report);
console.log(report);
if (starved === seeds.length || dead === seeds.length) process.exit(1);
