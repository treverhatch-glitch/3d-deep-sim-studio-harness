#!/usr/bin/env node
/**
 * scripts/check-docs.mjs — docs only name commands that exist.
 *
 * Scans the Markdown that agents read for `npm run <script>`, `node <file>` and `bash <file>`, and
 * fails when the script isn't in package.json or the file isn't in the repo. Plans for future
 * commands (docs/ROADMAP.md), the changelog and dated notes are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.studio', 'dist', 'harness-notes', 'retros', 'daily', 'reviews', 'research', 'meetings', 'handoffs']);
const SKIP_FILES = new Set(['CHANGELOG.md', 'docs/ROADMAP.md']);
const scripts = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {}));
const hubScripts = fs.existsSync(path.join(root, 'hub', 'package.json')) ? new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'hub', 'package.json'), 'utf8')).scripts || {})) : new Set();

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.md')) files.push(path.relative(root, full).split(path.sep).join('/'));
  }
})(root);

const problems = [];
for (const rel of files.filter((f) => !SKIP_FILES.has(f))) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m0 of line.matchAll(/\bnpm run ([a-z][\w:.-]*)/g)) {
      // "npm run asset." at the end of a sentence names the asset script (run #1: a Producer log line broke preflight).
      const m = [m0[0], m0[1].replace(/[.:-]+$/, '')];
      if (!scripts.has(m[1]) && !hubScripts.has(m[1])) problems.push(`${rel}:${i + 1} npm run ${m[1]} (no such script in package.json)`);
    }
    for (const m of line.matchAll(/\b(?:node|bash)\s+((?:\.\/)?(?:harness|scripts|qa|hub|tools|cartridges)\/[\w./-]+\.(?:mjs|js|sh|py))/g)) {
      if (!fs.existsSync(path.join(root, m[1]))) problems.push(`${rel}:${i + 1} ${m[0]} (no such file)`);
    }
  });
}
if (problems.length) {
  console.log(`[docs] FAIL ${problems.length} command(s) in the docs don't exist:`);
  console.log(problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`[docs] PASS — ${files.length - SKIP_FILES.size} Markdown file(s), every command exists`);
