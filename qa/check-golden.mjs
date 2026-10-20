#!/usr/bin/env node
/**
 * qa/check-golden.mjs — replay every qa/golden/*.json against its cartridge and compare 64-bit hashes.
 *
 *   node qa/check-golden.mjs            check (fails on mismatch, stub hash, or a game with no golden)
 *   node qa/check-golden.mjs --update   rewrite hashes after an intended sim change (commit them together)
 *
 * Golden shapes:
 *   replay:   { "cartridge", "seed", "tick", "actions": [{ "tick", "action" }], "hash" }
 *   scenario: { "cartridge", "scenario": "start-to-win", "seed"?, "expect": { "outcome", "tick" }, "hash" }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCartridgeName, listCartridges, loadCartridge, replay, runScenario } from '../harness/cartridge.mjs';
import { isHash64 } from '../harness/hash.mjs';

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'golden');
const update = process.argv.includes('--update');

const files = fs.existsSync(GOLDEN_DIR) ? fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json')).sort() : [];
if (!files.length) {
  console.error('[golden] FAIL no golden files in qa/golden');
  process.exit(1);
}

const carts = new Map();
const covered = new Set();
let failed = 0;
const fail = (msg) => {
  console.error(`[golden] FAIL ${msg}`);
  failed += 1;
};

for (const file of files) {
  const full = path.join(GOLDEN_DIR, file);
  const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
  const name = spec.cartridge || defaultCartridgeName();
  if (!carts.has(name)) carts.set(name, await loadCartridge(name));
  const cart = carts.get(name);
  covered.add(name);

  const result = spec.scenario
    ? runScenario(cart, spec.scenario, { seed: spec.seed, tuning: spec.tuning })
    : replay(cart, { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning });

  if (result.findings.length) {
    fail(`${file}: tick ${result.failingTick} ${result.findings[0].id} — ${result.findings[0].summary}`);
    continue;
  }

  if (update) {
    spec.cartridge = name;
    spec.hash = result.hash;
    if (spec.scenario) spec.expect = { ...(spec.expect || {}), outcome: result.outcome, tick: result.ticksRun };
    delete spec.note;
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[golden] updated ${file} -> ${result.hash}`);
    continue;
  }

  if (!isHash64(spec.hash)) {
    fail(`${file}: hash "${spec.hash}" is a stub or not 64-bit. Run: npm run golden -- --update`);
    continue;
  }
  if (result.hash !== spec.hash) {
    fail(`${file}: expected ${spec.hash} got ${result.hash}`);
    continue;
  }
  if (spec.expect?.outcome !== undefined && result.outcome !== spec.expect.outcome) {
    fail(`${file}: expected outcome ${spec.expect.outcome} got ${result.outcome}`);
    continue;
  }
  if (spec.expect?.tick !== undefined && result.ticksRun !== spec.expect.tick) {
    fail(`${file}: expected to finish at tick ${spec.expect.tick} got ${result.ticksRun}`);
    continue;
  }
  const what = spec.scenario ? `${spec.scenario} ${result.outcome} @ tick ${result.ticksRun}` : `seed ${spec.seed} tick ${spec.tick}`;
  console.log(`[golden] PASS ${file} (${name}: ${what}, ${result.hash})`);
}

for (const name of listCartridges()) {
  if (!covered.has(name)) fail(`cartridge ${name} has no golden file. Add one under qa/golden/ (npm run new-game makes them).`);
}

if (failed) process.exit(1);
console.log(`[golden] ${files.length} file(s) ok across ${covered.size} cartridge(s)`);
