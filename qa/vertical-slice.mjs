#!/usr/bin/env node
/**
 * qa/vertical-slice.mjs — every game cartridge must be playable start to win, with no input from a person.
 *
 * Plays scenarios['start-to-win'] from cartridges/<name>/qa.mjs twice, then checks:
 *   it ends in its expected outcome (default "won"), never breaks an invariant, is deterministic,
 *   and its final SHA-256 (and the SHA-256 of the actions it took) match qa/golden/<name>-start-to-win.json.
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
  if (a.sha256 !== b.sha256 || a.actionsSha256 !== b.actionsSha256) {
    fail(`${name}: two runs disagree (sha256 ${a.sha256.slice(0, 16)}… vs ${b.sha256.slice(0, 16)}…)`);
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
  if (golden.sha256 !== a.sha256) {
    fail(`${name}: slice sha256 ${a.sha256} != golden ${golden.sha256}`);
    continue;
  }
  if (golden.actionsSha256 && golden.actionsSha256 !== a.actionsSha256) {
    fail(`${name}: the slice reached the same end by different actions (actionsSha256 ${a.actionsSha256.slice(0, 16)}… != golden ${golden.actionsSha256.slice(0, 16)}…)`);
    continue;
  }
  console.log(`[slice] PASS ${name}: ${a.outcome} at tick ${a.ticksRun}, ${a.actions.length} action(s), hash ${a.hash}`);
}
if (failed) process.exit(1);
