#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFamily } from '../harness/families.mjs';

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
    // A Director's design or drift review isn't a code review; it belongs in studio/bible/reviews/ (run #1).
    if (/director|drift/i.test(file) || /^#\s*(director|drift)/im.test(text)) {
      console.log(`[reviewer] note: ${file} looks like a Director design review, not a code review. Move it to studio/bible/reviews/ (npm run director -- review writes there).`);
      continue;
    }
    console.error(`[reviewer] FAIL ${file} needs model-family and implementer-family (a code review: npm run review -- <TASK_ID>)`);
    failed += 1;
    continue;
  }
  if (modelFamily(reviewer) === modelFamily(implementer)) {
    console.error(`[reviewer] FAIL ${file} reviewer family matches implementer (${reviewer})${/not (?:a |an )?(?:cross-family )?approval|same[- ]family/i.test(text) ? '. It says it is not an approval: npm run preflight -- --fix moves it to studio/reviews/same-family/ and records the review as owed' : ''}`);
    failed += 1;
    continue;
  }
  console.log(`[reviewer] ok ${file} (${implementer} -> ${reviewer})`);
}
if (failed) process.exit(1);
