#!/usr/bin/env node
/**
 * qa/check-golden.mjs — replay every qa/golden/*.json against its cartridge and compare hashes:
 * SHA-256 (the verification hash) and the 16-hex display hash. See docs/HASH.md.
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
import { isHash64, isSha256 } from '../harness/hash.mjs';

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
    spec.sha256 = result.sha256;
    if (spec.scenario) spec.expect = { ...(spec.expect || {}), outcome: result.outcome, tick: result.ticksRun };
    delete spec.note;
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[golden] updated ${file} -> sha256 ${result.sha256.slice(0, 16)}…, display ${result.hash}`);
    continue;
  }

  if (!isSha256(spec.sha256)) {
    fail(`${file}: sha256 "${spec.sha256 ?? ''}" is missing, a stub or not 256-bit. Run: npm run golden -- --update`);
    continue;
  }
  if (result.sha256 !== spec.sha256) {
    fail(`${file}: sha256 expected ${spec.sha256} got ${result.sha256}`);
    continue;
  }
  if (!isHash64(spec.hash) || result.hash !== spec.hash) {
    fail(`${file}: display hash expected ${spec.hash} got ${result.hash} (sha256 matches: the cartridge's display hash changed; regenerate)`);
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
  console.log(`[golden] PASS ${file} (${name}: ${what}, sha256 ${result.sha256.slice(0, 16)}…)`);
}

for (const name of listCartridges()) {
  if (!covered.has(name)) fail(`cartridge ${name} has no golden file. Add one under qa/golden/ (npm run new-game makes them).`);
}

if (failed) process.exit(1);
console.log(`[golden] ${files.length} file(s) ok across ${covered.size} cartridge(s)`);
