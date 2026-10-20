#!/usr/bin/env node
/**
 * scripts/new-game.mjs <name> — start a new game cartridge that passes every gate on day one.
 *
 *   npm run new-game my-airport
 *
 * Copies cartridges/_template to cartridges/<name>, plays it, and writes two real golden files:
 *   qa/golden/<name>-start-to-win.json   (the vertical slice: scenario, outcome, tick, SHA-256 and display hash)
 *   qa/golden/<name>-seed-1.json         (a plain 100-tick replay with no actions)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCartridge, replay, runScenario } from '../harness/cartridge.mjs';
import { emitEvent } from '../harness/event.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]{1,40}$/.test(name)) {
  console.error('Usage: npm run new-game <name>   (lowercase letters, digits and dashes, e.g. my-airport)');
  process.exit(1);
}
const src = path.join(root, 'cartridges', '_template');
const dest = path.join(root, 'cartridges', name);
const goldenDir = path.join(root, 'qa', 'golden');
const goldenFiles = [`${name}-start-to-win.json`, `${name}-seed-1.json`].map((f) => path.join(goldenDir, f));
if (fs.existsSync(dest)) {
  console.error(`cartridges/${name} already exists`);
  process.exit(1);
}
if (goldenFiles.some((f) => fs.existsSync(f))) {
  console.error(`golden files for ${name} already exist in qa/golden/`);
  process.exit(1);
}

fs.cpSync(src, dest, { recursive: true });
const readme = path.join(dest, 'README.md');
fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replaceAll('__GAME_NAME__', name));

const cart = await loadCartridge(name);
const slice = runScenario(cart, 'start-to-win');
if (slice.outcome !== 'won' || slice.findings.length) {
  console.error(`[new-game] the template did not win (${slice.outcome}); fix cartridges/_template first`);
  fs.rmSync(dest, { recursive: true, force: true });
  process.exit(1);
}
const plain = replay(cart, { seed: 1, tick: 100 });
fs.mkdirSync(goldenDir, { recursive: true });
const write = (file, spec) => fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
write(goldenFiles[0], {
  name: `${name} vertical slice: new game to win`,
  cartridge: name,
  scenario: 'start-to-win',
  seed: slice.seed,
  expect: { outcome: slice.outcome, tick: slice.ticksRun },
  hash: slice.hash,
  sha256: slice.sha256,
});
write(goldenFiles[1], { name: `${name} seed 1, 100 ticks, no actions`, cartridge: name, seed: 1, tick: 100, actions: [], hash: plain.hash, sha256: plain.sha256 });

emitEvent({ type: 'game.new', agent: 'producer', target: `cartridges/${name}`, msg: `New cartridge ${name}: slice won at tick ${slice.ticksRun}` });
console.log(`[new-game] cartridges/${name}/ created
[new-game] qa/golden/${name}-start-to-win.json  won at tick ${slice.ticksRun}, sha256 ${slice.sha256.slice(0, 16)}…
[new-game] qa/golden/${name}-seed-1.json        sha256 ${plain.sha256.slice(0, 16)}…

Next:
  npm run verify                                  every gate, now including ${name}
  npm run playtest -- --cartridge ${name}         play it tick by tick
  set "cartridge": "${name}" in studio/gates.json to make it the default`);
