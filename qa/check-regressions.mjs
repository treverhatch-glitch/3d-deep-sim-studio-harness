#!/usr/bin/env node
/**
 * qa/check-regressions.mjs — every fixed bug keeps a replay in qa/regressions/ that must still match.
 * A regression with no hash fails: an unpinned regression proves nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCartridgeName, loadCartridge, replay } from '../harness/cartridge.mjs';
import { isHash64 } from '../harness/hash.mjs';

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
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[regressions] updated ${file} -> ${result.hash}`);
    continue;
  }
  if (result.findings.length) {
    console.error(`[regressions] FAIL ${file}: tick ${result.failingTick} ${result.findings[0].id} — ${result.findings[0].summary}`);
    failed += 1;
  } else if (!isHash64(spec.hash)) {
    console.error(`[regressions] FAIL ${file}: no 64-bit hash pinned. Run: node qa/check-regressions.mjs --update`);
    failed += 1;
  } else if (result.hash !== spec.hash) {
    console.error(`[regressions] FAIL ${file}: expected ${spec.hash} got ${result.hash}`);
    failed += 1;
  } else {
    console.log(`[regressions] PASS ${file} (${name}, ${result.hash})`);
  }
}
if (failed) process.exit(1);
