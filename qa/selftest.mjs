#!/usr/bin/env node
/**
 * Proves key checks can fail. Uses temp copies; does not edit the repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-selftest-'));

function mustFail(label, fn) {
  try {
    fn();
    console.error(`[selftest] FAIL ${label} did not fail`);
    process.exitCode = 1;
  } catch {
    console.log(`[selftest] PASS ${label} failed as expected`);
  }
}

mustFail('secret-scan', () => {
  const dir = path.join(tmp, 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'leak.txt'), 'sk-' + 'a'.repeat(24));
  execSync(`bash "${path.join(root, 'scripts/secret-scan.sh')}" "${dir}"`, { stdio: 'pipe' });
});

mustFail('lock-shared-owner', () => {
  execSync(`node "${path.join(root, 'harness/lock.mjs')}" claim task:selftest --owner cursor`, {
    cwd: root,
    stdio: 'pipe',
  });
});

if (process.exitCode) process.exit(process.exitCode);
console.log('[selftest] ok');
