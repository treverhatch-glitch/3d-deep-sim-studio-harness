#!/usr/bin/env node
/**
 * qa/check-golden.mjs — compare replay hashes to qa/golden/*.json
 * Usage: node qa/check-golden.mjs [--update]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayToTick } from '../cartridges/example-sim/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.join(__dirname, 'golden');
const update = process.argv.includes('--update');

if (!fs.existsSync(GOLDEN_DIR)) {
  console.error('No qa/golden directory');
  process.exit(1);
}

const files = fs.readdirSync(GOLDEN_DIR).filter((f) => f.endsWith('.json'));
if (files.length === 0) {
  console.error('No golden files');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  const full = path.join(GOLDEN_DIR, file);
  const spec = JSON.parse(fs.readFileSync(full, 'utf8'));
  const result = replayToTick({
    seed: spec.seed,
    tick: spec.tick,
    actions: spec.actions || [],
  });

  if (update || !spec.hash || spec.hash === 'REPLACE_AFTER_FIRST_RUN') {
    spec.hash = result.hash;
    delete spec.note;
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`[golden] updated ${file} -> ${result.hash}`);
    continue;
  }

  if (result.hash !== spec.hash) {
    console.error(`[golden] FAIL ${file}: expected ${spec.hash} got ${result.hash}`);
    failed += 1;
  } else {
    console.log(`[golden] PASS ${file} (${result.hash})`);
  }
}

if (failed > 0) process.exit(1);
console.log(`[golden] ${files.length} file(s) ok`);
