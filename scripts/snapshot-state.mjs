#!/usr/bin/env node
// Copies the key state files into .studio/snapshots/<UTC stamp>/ before a risky change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = path.join(ROOT, '.studio', 'snapshots', stamp);
fs.mkdirSync(dest, { recursive: true });
for (const f of ['studio/CURRENT_TASK.md', 'studio/memory/failures.md', 'studio/templates/seed-failure.json']) {
  try { fs.copyFileSync(path.join(ROOT, f), path.join(dest, path.basename(f))); } catch {}
}
console.log(`Snapshot saved to ${path.relative(ROOT, dest)}`);
