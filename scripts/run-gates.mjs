#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || [];
let failed = 0;
for (const gate of gates) {
  if (gate.required === false && process.argv.includes('--required-only')) continue;
  try {
    execSync(gate.command, { cwd: root, stdio: 'inherit' });
    console.log(`[gates] PASS ${gate.id}`);
  } catch {
    console.error(`[gates] FAIL ${gate.id}`);
    failed += 1;
    if (gate.required !== false) {
      // keep going so the report shows every failure
    }
  }
}
if (failed) process.exit(1);
console.log(`[gates] ${gates.length} gate(s) ok`);
