#!/usr/bin/env node
/**
 * qa/vertical-slice.mjs — every game cartridge must be playable start to win, with no input from a person.
 *
 * Plays scenarios['start-to-win'] from cartridges/<name>/qa.mjs twice, then checks:
 *   it ends in its expected outcome (default "won"), never breaks an invariant, is deterministic,
 *   and its final hash matches qa/golden/<name>-start-to-win.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cartridgeFromArgv, listCartridges, loadCartridge, runScenario } from '../harness/cartridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = process.argv.includes('--cartridge') ? [cartridgeFromArgv()] : listCartridges();
if (!names.length) {
  console.error('[slice] FAIL no game cartridges. Create one: npm run new-game <name>');
  process.exit(1);
}

let failed = 0;
const fail = (msg) => {
  console.error(`[slice] FAIL ${msg}`);
  failed += 1;
};

for (const name of names) {
  const cart = await loadCartridge(name);
  const scenario = cart.scenarios['start-to-win'];
  if (!scenario) {
    fail(`${name}: qa.mjs has no scenarios['start-to-win']`);
    continue;
  }
  const a = runScenario(cart, 'start-to-win');
  const b = runScenario(cart, 'start-to-win');
  const expected = scenario.expect || 'won';
  if (a.findings.length) {
    fail(`${name}: tick ${a.failingTick} ${a.findings[0].id} — ${a.findings[0].summary}`);
    continue;
  }
  if (a.hash !== b.hash) {
    fail(`${name}: two runs disagree (${a.hash} vs ${b.hash})`);
    continue;
  }
  if (a.outcome !== expected) {
    fail(`${name}: expected "${expected}" within ${scenario.maxTicks ?? 1000} ticks, got "${a.outcome}" after ${a.ticksRun}`);
    continue;
  }
  const goldenFile = path.join(root, 'qa', 'golden', `${name}-start-to-win.json`);
  if (!fs.existsSync(goldenFile)) {
    fail(`${name}: missing qa/golden/${name}-start-to-win.json`);
    continue;
  }
  const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8'));
  if (golden.hash !== a.hash) {
    fail(`${name}: slice hash ${a.hash} != golden ${golden.hash}`);
    continue;
  }
  console.log(`[slice] PASS ${name}: ${a.outcome} at tick ${a.ticksRun}, ${a.actions.length} action(s), hash ${a.hash}`);
}
if (failed) process.exit(1);
