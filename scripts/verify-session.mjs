#!/usr/bin/env node
/**
 * Agent-agnostic session check. Cursor, Codex, Claude, and others can all run this.
 * Usage: node scripts/verify-session.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'AGENTS.md',
  'studio/CURRENT_TASK.md',
  'studio/NEXT.md',
  'studio/memory/failures.md',
  'docs/READ-FIRST.md',
];
let failed = 0;
for (const rel of required) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    console.error(`[session] MISSING ${rel}`);
    failed += 1;
  } else {
    console.log(`[session] ok ${rel}`);
  }
}
const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
if (!agents.includes('lock.mjs')) {
  console.error('[session] AGENTS.md missing lock.mjs rule');
  failed += 1;
}
try {
  const hooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' }).trim();
  if (hooks !== 'scripts/hooks') console.warn('[session] note: pre-commit hook not installed. Run: npm run hooks:install');
} catch {
  console.warn('[session] note: pre-commit hook not installed. Run: npm run hooks:install');
}
if (failed) process.exit(1);
console.log('[session] PASS — read-order files present. Any agent can run this; not Claude-only.');
