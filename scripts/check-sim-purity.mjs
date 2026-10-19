#!/usr/bin/env node
/**
 * scripts/check-sim-purity.mjs — fail if no sim files are found
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_PATTERNS = [
  { id: 'NO_THREE_IMPORT', re: /from\s+['"]three(\/.*)?['"]/g, reason: 'Three.js import inside pure sim layer' },
  { id: 'NO_DOM_WINDOW', re: /\b(window|document|localStorage|sessionStorage|requestAnimationFrame)\b/g, reason: 'Browser DOM global inside pure sim layer' },
  { id: 'NO_MATH_RANDOM', re: /\bMath\.random\s*\(|Math\s*\[\s*['"]random['"]\s*\]/g, reason: 'Unseeded Math.random() breaks determinism' },
  { id: 'NO_WALL_CLOCK', re: /\b(Date\.now|performance\.now)\s*\(|Date\s*\[\s*['"]now['"]\s*\]|\bnew\s+Date\s*\(|process\.hrtime/g, reason: 'Wall-clock time breaks fixed-timestep determinism' },
  { id: 'NO_CRYPTO_RANDOM', re: /crypto\.getRandomValues|Math\s*\[\s*['"]random['"]\s*\]\s*\(/g, reason: 'Unseeded crypto/random breaks determinism' },
];

function collectSimFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collectSimFiles(full, out);
    } else if (entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const candidateDirs = [
  path.join(REPO_ROOT, 'src', 'sim'),
  path.join(REPO_ROOT, 'cartridges'),
];

const files = [];
for (const d of candidateDirs) collectSimFiles(d, files);

if (files.length === 0) {
  console.error('[sim-purity] FAIL — 0 simulation files found. Expected files under src/sim or cartridges/.');
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  for (const rule of FORBIDDEN_PATTERNS) {
    rule.re.lastIndex = 0;
    if (rule.re.test(code)) {
      violations.push({
        file: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
        rule: rule.id,
        reason: rule.reason,
      });
    }
  }
}

if (violations.length > 0) {
  console.error('SIM PURITY CHECK FAILED:');
  for (const v of violations) console.error(`  x [${v.rule}] ${v.file}: ${v.reason}`);
  process.exit(1);
}

console.log(`[sim-purity] PASS — ${files.length} simulation file(s) verified.`);
for (const f of files) console.log(`  - ${path.relative(REPO_ROOT, f)}`);
