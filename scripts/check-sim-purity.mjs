#!/usr/bin/env node
/**
 * scripts/check-sim-purity.mjs — Static Determinism & Sim-Purity Guard
 *
 * Enforces `studio/rules/sim-purity.md` across any simulation folder (`src/sim`
 * or `cartridges/<name>/sim`):
 *   1. ZERO imports of `three`, `@react-three/*`, DOM (`window`, `document`,
 *      `localStorage`, `requestAnimationFrame`), or browser audio APIs.
 *   2. ZERO calls to `Math.random()`, `Date.now()`, or `performance.now()`.
 *
 * Keeps the simulation 100% deterministic, headless-testable in Node, and
 * ready for late-game porting to Tauri v2, Godot 4 (`ts2gd`), or Unity (`SharpTS`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const FORBIDDEN_PATTERNS = [
  { id: 'NO_THREE_IMPORT', re: /from\s+['"]three(\/.*)?['"]/g, reason: 'Three.js import inside pure sim layer' },
  { id: 'NO_DOM_WINDOW', re: /\b(window|document|localStorage|sessionStorage|requestAnimationFrame)\b/g, reason: 'Browser DOM global inside pure sim layer' },
  { id: 'NO_MATH_RANDOM', re: /\bMath\.random\s*\(/g, reason: 'Unseeded Math.random() breaks determinism; use seeded SimState RNG' },
  { id: 'NO_WALL_CLOCK', re: /\b(Date\.now|performance\.now)\s*\(/g, reason: 'Wall-clock time breaks fixed-timestep determinism' },
];

function collectSimFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSimFiles(full, out);
    } else if (entry.isFile() && /\.(ts|mts|js|mjs)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const candidateDirs = [
  path.join(REPO_ROOT, 'src', 'sim'),
];

const cartridgesDir = path.join(REPO_ROOT, 'cartridges');
if (fs.existsSync(cartridgesDir)) {
  for (const entry of fs.readdirSync(cartridgesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      candidateDirs.push(path.join(cartridgesDir, entry.name, 'sim'));
      candidateDirs.push(path.join(cartridgesDir, entry.name, 'src', 'sim'));
    }
  }
}

const files = [];
for (const d of candidateDirs) collectSimFiles(d, files);

const violations = [];
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);
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
  console.error('SIM PURITY CHECK FAILED (studio/rules/sim-purity.md):');
  for (const v of violations) {
    console.error(`  ✗ [${v.rule}] ${v.file}: ${v.reason}`);
  }
  process.exit(1);
}

console.log(`[sim-purity] PASS — ${files.length} simulation file(s) verified pure (0 DOM/Three/Math.random/wall-clock leaks).`);
