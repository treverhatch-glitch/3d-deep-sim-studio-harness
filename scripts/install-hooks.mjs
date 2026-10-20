#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, '.git', 'hooks', 'pre-commit');
if (!fs.existsSync(path.join(root, '.git'))) {
  console.log('[hooks] no .git, skip');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'hooks', 'pre-commit'), dest);
fs.chmodSync(dest, 0o755);
console.log('[hooks] installed scripts/hooks/pre-commit');
