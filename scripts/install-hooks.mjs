#!/usr/bin/env node
/**
 * scripts/install-hooks.mjs — point git at scripts/hooks so the pre-commit check runs for everyone.
 *   npm run hooks:install      (also run by npm run setup)
 *   npm run hooks:install -- --check   exit 1 when the hooks are not installed
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

let inside = false;
try {
  inside = git('rev-parse', '--is-inside-work-tree') === 'true';
} catch {
  inside = false;
}
if (!inside) {
  console.log('[hooks] not a git checkout; nothing to install');
  process.exit(process.argv.includes('--check') ? 1 : 0);
}

let current = '';
try {
  current = git('config', '--get', 'core.hooksPath');
} catch {
  current = '';
}
if (process.argv.includes('--check')) {
  const ok = current === 'scripts/hooks';
  console.log(ok ? '[hooks] installed (core.hooksPath=scripts/hooks)' : '[hooks] NOT installed. Run: npm run hooks:install');
  process.exit(ok ? 0 : 1);
}
for (const f of fs.readdirSync(path.join(root, 'scripts', 'hooks'))) fs.chmodSync(path.join(root, 'scripts', 'hooks', f), 0o755);
git('config', 'core.hooksPath', 'scripts/hooks');
console.log('[hooks] installed: git now runs scripts/hooks/pre-commit. Set STUDIO_LOCK_OWNER to your agent name.');
