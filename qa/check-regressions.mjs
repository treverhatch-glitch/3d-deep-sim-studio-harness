#!/usr/bin/env node
/**
 * qa/check-regressions.mjs — every fixed bug keeps a replay in qa/regressions/ that must still match.
 * A regression with no hash fails: an unpinned regression proves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCartridgeName, loadCartridge, replay } from '../harness/cartridge.mjs';
import { isSha256 } from '../harness/hash.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regressions');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
if (!files.length) {
  console.log('[regressions] none yet');
  process.exit(0);
}
const update = process.argv.includes('--update');
const carts = new Map();
let failed = 0;
for (const file of files) {
  const full = path.join(dir, file);
  const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
  const name = spec.cartridge || defaultCartridgeName();
  if (!carts.has(name)) carts.set(name, await loadCartridge(name));
  const result = replay(carts.get(name), { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning });
  if (update) {
    spec.cartridge = name;
    spec.hash = result.hash;
    spec.sha256 = result.sha256;
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[regressions] updated ${file} -> sha256 ${result.sha256.slice(0, 16)}…`);
    continue;
  }
  if (result.findings.length) {
    console.error(`[regressions] FAIL ${file}: tick ${result.failingTick} ${result.findings[0].id} — ${result.findings[0].summary}`);
    failed += 1;
  } else if (!isSha256(spec.sha256)) {
    console.error(`[regressions] FAIL ${file}: no sha256 pinned. Run: node qa/check-regressions.mjs --update`);
    failed += 1;
  } else if (result.sha256 !== spec.sha256) {
    console.error(`[regressions] FAIL ${file}: sha256 expected ${spec.sha256} got ${result.sha256}`);
    failed += 1;
  } else {
    console.log(`[regressions] PASS ${file} (${name}, sha256 ${result.sha256.slice(0, 16)}…)`);
  }
}
if (failed) process.exit(1);
