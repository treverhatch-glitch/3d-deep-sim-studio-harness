#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'studio', 'reviews');
fs.mkdirSync(dir, { recursive: true });
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
if (!files.length) {
  console.log('[reviewer] no review files yet');
  process.exit(0);
}
let failed = 0;
for (const file of files) {
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  const reviewer = (text.match(/model-family\s*:\s*(\S+)/i) || [])[1];
  const implementer = (text.match(/implementer-family\s*:\s*(\S+)/i) || [])[1];
  if (!reviewer || !implementer) {
    console.error(`[reviewer] FAIL ${file} needs model-family and implementer-family`);
    failed += 1;
    continue;
  }
  if (reviewer.toLowerCase() === implementer.toLowerCase()) {
    console.error(`[reviewer] FAIL ${file} reviewer family matches implementer (${reviewer})`);
    failed += 1;
    continue;
  }
  console.log(`[reviewer] ok ${file} (${implementer} -> ${reviewer})`);
}
if (failed) process.exit(1);
