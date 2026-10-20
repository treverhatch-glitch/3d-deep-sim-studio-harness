#!/usr/bin/env node
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const steps = [
  ['syntax', 'node --check harness/cartridge.mjs && node --check scripts/release.mjs'],
  ['gates', 'node scripts/run-gates.mjs'],
  ['closed-loop', 'node harness/closed-loop.mjs --simulate-fail; test $? -eq 1'],
];
for (const [label, cmd] of steps) {
  try {
    execSync(cmd, { stdio: 'inherit', shell: true });
    console.log(`[release] PASS ${label}`);
  } catch {
    console.error(`[release] FAIL ${label}`);
    process.exit(1);
  }
}
const changelog = fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '';
if (!changelog.includes('2.2.0')) {
  console.error('[release] FAIL changelog missing 2.2.0');
  process.exit(1);
}
console.log('[release] READY 2.2.0');
