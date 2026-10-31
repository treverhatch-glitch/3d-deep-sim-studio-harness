#!/usr/bin/env node
/**
 * scripts/secret-scan.mjs [root] [--staged] — fail if a key-shaped string would be committed.
 *
 * In a git checkout it scans exactly what git would publish: tracked files plus untracked files
 * that are not ignored. Your own .env (ignored) never trips it, so private clones stay green.
 * --staged scans only staged files (used by the pre-commit hook). Outside git it scans the folder.
 * Pure Node, so it runs the same on Windows, macOS and Linux. Values are never printed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const STAGED = args.includes('--staged');
const ROOT = path.resolve(args.find((a) => !a.startsWith('--')) || '.');

import { SECRET_PATTERNS as PATTERNS } from '../harness/secrets.mjs';

const SKIP = /(^|\/)(secret-scan\.(mjs|sh)|secrets\.mjs|package-lock\.json|[^/]*\.lock)$/;

function listFiles() {
  const git = (a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() === 'true') {
    const r = STAGED ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']) : git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    return r.stdout.split('\0').filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.lanes') continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

// 2.43.0: a key-shaped match glued inside a longer run of base64 characters is a piece of encoded data (an
// image pack, a font), not a key: "AKIA" plus 16 capitals turns up by chance in a few hundred KB of base64.
// A real key stands on its own (quotes, =, space or a line edge around it).
const B64 = /[A-Za-z0-9+/]/;
function keyIn(line, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (const m of line.matchAll(g)) {
    const before = line[m.index - 1] || '';
    const after = line[m.index + m[0].length] || '';
    if (B64.test(before) && (B64.test(after) || after === '=')) continue;
    return true;
  }
  return false;
}

let count = 0;
const hits = new Set();
for (const rel of listFiles()) {
  const full = path.join(ROOT, rel);
  if (SKIP.test(rel) || !fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const buf = fs.readFileSync(full);
  count += 1;
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  buf.toString('utf8').split(/\r?\n/).forEach((line, i) => {
    if (PATTERNS.some((re) => keyIn(line, re))) hits.add(`  ${rel}:${i + 1}`);
  });
}
if (hits.size) {
  console.log('[secrets] FAIL key-shaped string(s) found (values hidden):');
  console.log([...hits].sort().join('\n'));
  console.log('[secrets] Move real keys to .env (gitignored). If one was ever committed, rotate it.');
  process.exit(1);
}
console.log(`[secrets] PASS — ${count} file(s) scanned`);
