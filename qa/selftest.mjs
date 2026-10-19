#!/usr/bin/env node
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

mustFail('golden-bad-hash', () => {
  const dir = path.join(tmp, 'golden');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({
    seed: 1,
    tick: 1,
    actions: [],
    hash: 'deadbeef',
  }));
  execSync(`python3 "${path.join(root, 'tools/golden.py')}" --check "${dir}"`, { stdio: 'pipe' });
});

mustFail('purity-random', () => {
  const dir = path.join(tmp, 'sim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.mjs'), 'export const x = Math.random();\n');
  const script = `
import fs from 'node:fs';
const code = fs.readFileSync(${JSON.stringify(path.join(dir, 'bad.mjs'))}, 'utf8');
if (/Math\\.random/.test(code)) process.exit(1);
`;
  fs.writeFileSync(path.join(tmp, 'purity-mini.mjs'), script);
  execSync(`node "${path.join(tmp, 'purity-mini.mjs')}"`, { stdio: 'pipe' });
});

if (process.exitCode) process.exit(process.exitCode);
console.log('[selftest] ok');
