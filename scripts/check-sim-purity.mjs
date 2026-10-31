#!/usr/bin/env node
/**
 * scripts/check-sim-purity.mjs — the sim must be pure: same seed + actions, same result, anywhere.
 *
 * 1. Static scan of src/sim/ and cartridges/ for presentation imports, DOM, randomness, wall clock,
 *    timers and global escapes (eval, Function, globalThis).
 * 2. Runtime probe (scripts/sim-runtime-probe.mjs): plays every cartridge with those globals trapped,
 *    which catches aliases a regex cannot see.
 * Fails on 0 files and on 0 cartridges, so an empty or moved sim cannot pass by accident.
 *
 * 2.58.2 (PU-22): deterministic math (harness/det-math.mjs). Math.sin, cos, atan2, hypot, pow, exp, log and
 * the other inexact functions (and **) give different last bits in different engines, so a sim that must
 * replay the same in a port can't call them. Each game has a mode: "warn" (the default: printed, never
 * fails), "required" (fails here; npm run new-game writes it) or "off". Cartridges set it in
 * cartridges/<name>/cartridge.json "detMath", a studio game that isn't a cartridge in its studio.gates.json
 * "detMath" (with "paths" for where its sim lives; default <game>/sim). The detMath module itself is exempt.
 *
 *   node scripts/check-sim-purity.mjs [--det-math-only] [--all]
 *     --det-math-only  only the deterministic-math rule, every scope (the game:det-math check runs this)
 *     --all            print every warning, not the first 25
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const detOnly = argv.includes('--det-math-only');
const WARN_LINES = argv.includes('--all') ? Infinity : 25;

const RULES = [
  { id: 'NO_PRESENTATION_IMPORT', re: /(from\s+|import\s*\(\s*|require\s*\(\s*)['"`](three|react|react-dom|@react-three\/[^'"`]*|pixi\.js|phaser|babylonjs|@babylonjs\/[^'"`]*)(\/[^'"`]*)?['"`]/, reason: 'rendering/UI library inside the sim' },
  { id: 'NO_DOM', re: /\b(window|document|localStorage|sessionStorage|navigator|requestAnimationFrame|HTMLElement|WebGL\w*)\b/, reason: 'browser global inside the sim' },
  { id: 'NO_MATH_RANDOM', re: /\bMath\s*\.\s*random\b|\bMath\s*\[\s*['"`]random|\{[^}]*\brandom\b[^}]*\}\s*=\s*Math\b/, reason: 'unseeded randomness (use the seeded RNG in state)' },
  { id: 'NO_WALL_CLOCK', re: /\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bDate\s*\(|\bDate\s*\[|\bperformance\s*(\.|\[)|\bprocess\s*\.\s*hrtime\b/, reason: 'wall-clock time (use state.tick)' },
  { id: 'NO_CRYPTO_RANDOM', re: /\bcrypto\s*\.\s*(getRandomValues|randomUUID|randomBytes|randomInt)\b|['"`](node:)?crypto['"`]/, reason: 'unseeded crypto randomness' },
  { id: 'NO_TIMERS', re: /\b(setTimeout|setInterval|setImmediate)\s*\(/, reason: 'timers make the sim depend on real time' },
  { id: 'NO_GLOBAL_ESCAPE', re: /\bglobalThis\b|\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`]/, reason: 'dynamic global access can hide any of the above' },
  { id: 'NO_CONSTRUCTOR_ESCAPE', re: /\.\s*constructor\s*\.\s*constructor\b|\[\s*['"`]constructor['"`]\s*\]/, reason: 'reaching the Function constructor through a prototype can run any code' },
];

function collect(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') collect(full, out);
    } else if (/\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/.test(entry.name) && !/\.(test|spec)\.[a-z]+$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Drop comments but keep line numbers.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '');

// Deterministic math, per scope: required findings fail with the static scan, warn findings are printed.
async function detMath() {
  const { detMathScopes, scanScope, formatFinding } = await import('../harness/det-math.mjs');
  const scopes = await detMathScopes(REPO_ROOT);
  const cache = new Map();
  const failing = [];
  let scanned = 0;
  for (const scope of scopes) {
    if (scope.bad) console.log(`[sim-purity] WARN ${scope.source}: detMath mode "${scope.bad}" is not off, warn or required; using warn`);
    if (scope.mode === 'off') continue;
    const res = scanScope(scope, { root: REPO_ROOT, cache });
    scanned += res.files;
    if (!res.files && scope.label.startsWith('game ')) {
      const msg = `${scope.label} has no sim files to check for deterministic math: set "detMath": { "paths": [...] } in ${scope.source}`;
      if (scope.mode === 'required') failing.push(msg);
      else console.log(`[sim-purity] WARN ${msg}`);
      continue;
    }
    if (!res.findings.length) continue;
    if (scope.mode === 'required') {
      failing.push(...res.findings.map(formatFinding));
      continue;
    }
    console.log(`[sim-purity] WARN deterministic math: ${res.findings.length} engine-dependent Math use(s) in ${scope.label} (mode warn, from ${scope.source === 'default' ? 'the default' : scope.source}; "required" makes them fail):`);
    for (const f of res.findings.slice(0, WARN_LINES)) console.log(`  ! ${formatFinding(f)}`);
    if (res.findings.length > WARN_LINES) console.log(`  … and ${res.findings.length - WARN_LINES} more (node scripts/check-sim-purity.mjs --all)`);
  }
  return { failing, scanned, scopes };
}

if (detOnly) {
  const det = await detMath();
  if (det.failing.length) {
    console.error('[sim-purity] FAIL deterministic math (mode required):');
    for (const v of det.failing) console.error(`  x ${v}`);
    process.exit(1);
  }
  console.log(`[sim-purity] deterministic math PASS — ${det.scanned} file(s) in ${det.scopes.filter((s) => s.mode !== 'off').length} scope(s)`);
  process.exit(0);
}

const files = [path.join(REPO_ROOT, 'src', 'sim'), path.join(REPO_ROOT, 'cartridges')].flatMap((d) => collect(d));
if (!files.length) {
  console.error('[sim-purity] FAIL 0 simulation files found under src/sim/ or cartridges/.');
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) violations.push(`${path.relative(REPO_ROOT, file)}:${i + 1} [${rule.id}] ${rule.reason}`);
    }
  });
}
const det = await detMath();
violations.push(...det.failing);
if (violations.length) {
  console.error('[sim-purity] FAIL static scan:');
  for (const v of violations) console.error(`  x ${v}`);
  process.exit(1);
}
console.log(`[sim-purity] static PASS — ${files.length} file(s)`);

const cartDir = path.join(REPO_ROOT, 'cartridges');
const carts = fs
  .readdirSync(cartDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(cartDir, d.name, 'index.mjs')))
  .map((d) => d.name);
if (!carts.length) {
  console.error('[sim-purity] FAIL 0 cartridges with index.mjs to probe.');
  process.exit(1);
}
let failed = 0;
for (const name of carts) {
  try {
    const out = execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'sim-runtime-probe.mjs'), name], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(out);
  } catch (err) {
    process.stderr.write(String(err.stderr || err.stdout || err.message));
    failed += 1;
  }
}
if (failed) process.exit(1);
console.log(`[sim-purity] PASS — ${files.length} file(s) scanned, ${carts.length} cartridge(s) probed at runtime`);
