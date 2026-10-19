#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInitialState, step } from '../cartridges/example-sim/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'studio', 'balance');
fs.mkdirSync(outDir, { recursive: true });

const costs = [5, 10, 25, 50];
const seeds = [1, 7, 42, 1337];
const ticks = 40;
const rows = [];

for (const cost of costs) {
  let wins = 0;
  let starved = 0;
  for (const seed of seeds) {
    let state = createInitialState(seed);
    for (let t = 1; t <= ticks; t++) {
      const action = t % 5 === 0 ? { type: 'spawn', kind: 'sensor', x: t, z: 1 } : null;
      state = step(state, action);
      if (action) state.resources.credits -= Math.max(0, cost - 25);
    }
    if (state.won) wins += 1;
    if (state.resources.credits < 0) starved += 1;
  }
  rows.push({ cost, wins, seeds: seeds.length, starved });
}

const best = rows.slice().sort((a, b) => Math.abs(a.wins - 2) - Math.abs(b.wins - 2))[0];
const md = [
  '# Balance sweep',
  '',
  '| cost | wins | starved |',
  '|------|------|---------|',
  ...rows.map((r) => `| ${r.cost} | ${r.wins}/${r.seeds} | ${r.starved} |`),
  '',
  `Closest to 50% wins: cost ${best.cost} (${best.wins}/${best.seeds}).`,
  'This is a proxy. A human still picks the final number.',
].join('\n');
fs.writeFileSync(path.join(outDir, 'latest.md'), md);
console.log(md);
