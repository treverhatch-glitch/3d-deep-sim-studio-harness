#!/usr/bin/env node
/**
 * Looks for a review marker before a task can be considered reviewed.
 * Marker file: studio/reviews/<task-id>.md containing "model-family:"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'studio', 'reviews');
fs.mkdirSync(dir, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
if (!files.length) {
  console.log('[reviewer] no review files yet (ok for empty harness)');
  process.exit(0);
}
let failed = 0;
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  if (!/model-family\s*:/i.test(text)) {
    console.error(`[reviewer] FAIL ${file} missing model-family`);
    failed += 1;
  } else {
    console.log(`[reviewer] ok ${file}`);
  }
}
if (failed) process.exit(1);
