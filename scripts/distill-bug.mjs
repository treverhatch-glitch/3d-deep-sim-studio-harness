#!/usr/bin/env node
// Appends a distilled bug lesson to studio/memory/failures.md.
//   node scripts/distill-bug.mjs "What broke" "Root cause" "The fix" "How to avoid it"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [broke = '', cause = '', fix = '', avoid = ''] = process.argv.slice(2);
if (!broke) {
  console.error('Usage: node scripts/distill-bug.mjs "What broke" "Root cause" "The fix" "How to avoid it"');
  process.exit(2);
}
const file = path.join(ROOT, 'studio', 'memory', 'failures.md');
fs.mkdirSync(path.dirname(file), { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, '# Failure Lessons\n\n');
fs.appendFileSync(file, `## ${new Date().toISOString().slice(0, 10)}\n- What broke: ${broke}\n- Root cause: ${cause}\n- The fix that worked: ${fix}\n- How to avoid it next time: ${avoid}\n\n`);
console.log('Added a lesson to studio/memory/failures.md');
