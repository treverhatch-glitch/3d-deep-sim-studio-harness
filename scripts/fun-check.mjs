#!/usr/bin/env node
/**
 * scripts/fun-check.mjs — cheap fun proxies from real scenario runs. A person still decides if it is fun.
 *
 *   node scripts/fun-check.mjs [--cartridge name] [--write]
 *
 * Fails when the slice cannot be won, or when doing nothing wins as fast as playing (choices do not matter).
 * --write saves the report to studio/fun/latest.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cartridgeFromArgv, loadCartridge, runScenario } from '../harness/cartridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cart = await loadCartridge(cartridgeFromArgv());
const slice = cart.scenarios['start-to-win'];
if (!slice) {
  console.error(`[fun] FAIL ${cart.name} has no scenarios['start-to-win'] in qa.mjs`);
  process.exit(1);
}
const seeds = [1, 7, 42, 1337, 2024, 9001];
const played = seeds.map((seed) => runScenario(cart, 'start-to-win', { seed }));
const idleSpec = cart.scenarios.idle || { seed: slice.seed, maxTicks: slice.maxTicks };
const idle = seeds.map((seed) => runScenario(cart, idleSpec, { seed }));

const wins = played.filter((r) => r.outcome === 'won');
const idleWins = idle.filter((r) => r.outcome === 'won');
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const playTicks = avg(wins.map((r) => r.ticksRun));
const idleTicks = avg(idleWins.map((r) => r.ticksRun));
const longestGap = Math.max(
  ...played.map((r) => {
    const ticks = [0, ...new Set(r.actions.map((a) => a.tick)), r.ticksRun];
    return Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]));
  })
);
const choicesMatter = idleWins.length < wins.length || (idleTicks !== null && playTicks !== null && idleTicks >= playTicks * 1.25);

const report = [
  `# Fun proxy report: ${cart.name}`,
  '',
  `- slice wins: ${wins.length}/${seeds.length} seeds, average ${playTicks ?? '–'} ticks`,
  `- doing nothing wins: ${idleWins.length}/${seeds.length} seeds${idleTicks ? `, average ${idleTicks} ticks` : ''}`,
  `- choices matter: ${choicesMatter ? 'yes' : 'NO — idling does as well as playing'}`,
  `- longest stretch with no player action: ${longestGap} ticks`,
  `- actions per 100 ticks: ${avg(played.map((r) => (100 * r.actions.length) / Math.max(1, r.ticksRun)))}`,
  '- human-review: required',
  '',
  'Proxies only. A person signs the slice in studio/fun/review-YYYY-MM-DD.md.',
  '',
].join('\n');
console.log(report);
if (process.argv.includes('--write')) fs.writeFileSync(path.join(root, 'studio', 'fun', 'latest.md'), report);
if (wins.length === 0) {
  console.error('[fun] FAIL the slice is never won');
  process.exit(1);
}
if (!choicesMatter) {
  console.error('[fun] FAIL doing nothing wins as fast as playing');
  process.exit(1);
}
console.log('[fun] PASS');
