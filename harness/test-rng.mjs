#!/usr/bin/env node
/**
 * harness/test-rng.mjs — 2.67.0 (B-48, B-45): a test that starts a seeded game but rolls the shared dice.
 *
 * A crew's main went red twice from tests that looked seeded: `beginNew(seed)` in a test file, while the test setup
 * file routed the sim's dice to the worker's shared Math.random, so the result depended on which tests ran before it.
 * Another test started a game with no seed at all. Both pass alone and fail in a full run, now and then.
 *
 * The game says what its calls look like, in its manifest (game/<name>/studio.gates.json; the harness only reads it,
 * and the manifest is a protected file):
 *
 *   "testRandomness": {
 *     "mode": "warn",                                       warn (default) | required | off
 *     "seededCalls": ["\\bbeginNew\\s*\\("],                regexes: a call that starts a seeded game (its argument
 *                                                           list follows the match)
 *     "sharedRandomSetup": ["\\bforceSimRandom\\s*\\(\\s*Math\\.random"],
 *                                                           regexes: a line that routes the sim's dice to Math.random
 *     "isolateCall": "forceSimRandom(null)",                text (or a list): what gives a test file its own dice
 *     "setupFiles": ["src/test/setup.ts"],                  optional; default: files named *setup* under "paths"
 *     "paths": ["src"]                                      optional; where tests live (default: the game's folder)
 *   }
 *
 * Findings, one per test file (harness/test-weakening.mjs isTestPath names test files):
 *   shared-random   a seeded call while a setup file (or the test file itself) routes the dice to the shared
 *                   Math.random, and the test file never isolates (no isolateCall in it)
 *   unseeded-game   a seeded call with no argument, or one built from Math.random / Date.now / performance.now
 *
 * Advisory first: the game gate lists it as `game:test-rng`, a WARN in verify that never fails it, and a hand-back
 * carries the findings as a fact (harness/handback-facts.mjs). "mode": "required" in the manifest, or
 * STUDIO_TEST_RNG=required, makes it a failing check. The setting can only raise the manifest's mode (never turn a
 * required check off). Comments are ignored; it reads text, not types: a seeded call through a helper with another
 * name, or a setup that reaches Math.random another way, isn't seen.
 *
 *   node harness/test-rng.mjs [--json]     exit 1 when there are findings (the gate's "required" decides FAIL or WARN)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, normMode } from './det-math.mjs';
import { isTestPath } from './test-weakening.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s)$/i;
const SETUP_NAME = /(^|[._-])setup([._-]|$)|^setupTests?\./i;
const UNSEEDED_ARG = /\bMath\s*\.\s*random\b|\bDate\s*\.\s*now\b|\bperformance\s*\.\s*now\b|\bcrypto\s*\.\s*(getRandomValues|randomUUID|randomInt)\b/;
export const KINDS = Object.freeze(['shared-random', 'unseeded-game']);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const toPosix = (p) => String(p).replace(/\\/g, '/');
const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String).filter(Boolean);

/** The studio game's folder under `root` (game/<name> or web/<name>), or null. Sync: hand-backs call it. */
export function gameFolder(root = DEFAULT_ROOT, env = process.env) {
  let name = String(env.STUDIO_GAME || '').trim();
  if (!name) name = String(readJson(path.join(root, 'studio', 'game.json'))?.game || '').trim();
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  return [`game/${name}`, `web/${name}`].find((d) => fs.existsSync(path.join(root, d, 'studio.gates.json'))) || null;
}

/** The mode: the manifest's, raised (never lowered) by STUDIO_TEST_RNG. */
export function testRngMode(raw, env = process.env) {
  const m = normMode(raw?.mode).mode;
  const e = String(env.STUDIO_TEST_RNG || '').trim();
  if (m === 'off' || !e) return m;
  return normMode(e).mode === 'required' ? 'required' : m;
}

/** The game's "testRandomness" settings, ready to scan, or null when it declares none. */
export function testRngConfig(root = DEFAULT_ROOT, { folder = gameFolder(root), env = process.env } = {}) {
  if (!folder) return null;
  const raw = readJson(path.join(root, folder, 'studio.gates.json'))?.testRandomness;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rx = (s) => { try { return new RegExp(s, 'g'); } catch { return null; } };
  const bad = [];
  const compile = (key) => list(raw[key]).map((s) => { const r = rx(s); if (!r) bad.push(`${key}: ${s}`); return r; }).filter(Boolean);
  const resolve = (p) => { const s = toPosix(p).replace(/\/+$/, ''); return fs.existsSync(path.join(root, s)) ? s : `${folder}/${s.replace(/^\.\//, '')}`; };
  return {
    folder,
    source: `${folder}/studio.gates.json`,
    mode: testRngMode(raw, env),
    seededCalls: compile('seededCalls'),
    sharedRandomSetup: compile('sharedRandomSetup'),
    isolateCalls: list(raw.isolateCall).map((s) => s.replace(/\s+/g, '')),
    setupFiles: list(raw.setupFiles).map(resolve),
    paths: (list(raw.paths).length ? list(raw.paths) : [folder]).map(resolve),
    bad,
  };
}

function walk(root, rel, out) {
  let st;
  try { st = fs.statSync(path.join(root, rel)); } catch { return out; }
  if (st.isFile()) { if (CODE_EXT.test(rel)) out.push(toPosix(rel)); return out; }
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
    walk(root, path.join(rel, e.name), out);
  }
  return out;
}

const lineOf = (text, idx) => { let n = 1; for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') n += 1; return n; };

/** The argument text of the call whose name ends at `from` (the next "(" after it), or null when there is none. */
function argsAt(code, from) {
  let i = from;
  while (i < code.length && /\s/.test(code[i])) i += 1;
  if (code[i - 1] === '(') i -= 1;
  else if (code[i] !== '(') return null;
  let depth = 0;
  for (let j = i; j < code.length; j++) {
    const c = code[j];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) return code.slice(i + 1, j); }
  }
  return null;
}

/** Where a text routes the dice to the shared Math.random: [{ line }] (comments ignored). */
function sharedLines(code, cfg) {
  const hits = [];
  for (const re of cfg.sharedRandomSetup) for (const m of code.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) hits.push({ line: lineOf(code, m.index) });
  return hits;
}

/**
 * Scan the game's tests: { files, setups: [{ file, line }], findings: [{ file, line, kind, message }] }.
 * `root` is the checkout to read (a lane copy for a hand-back).
 */
export function scanTestRng(root = DEFAULT_ROOT, cfg = testRngConfig(root)) {
  if (!cfg || !cfg.seededCalls.length) return { files: 0, setups: [], findings: [] };
  const all = [...new Set(cfg.paths.flatMap((p) => walk(root, p, [])))].sort();
  const tests = all.filter((f) => isTestPath(f));
  const setupCands = cfg.setupFiles.length ? cfg.setupFiles : all.filter((f) => SETUP_NAME.test(path.basename(f)));
  const code = (f) => { try { return scrub(fs.readFileSync(path.join(root, f), 'utf8')).code; } catch { return null; } };
  const setups = [];
  for (const f of setupCands) {
    const c = code(f);
    if (c === null) continue;
    for (const h of sharedLines(c, cfg)) setups.push({ file: f, line: h.line });
  }
  const findings = [];
  for (const f of tests) {
    if (setupCands.includes(f)) continue;
    const c = code(f);
    if (c === null) continue;
    let firstSeeded = null;
    for (const re of cfg.seededCalls) {
      for (const m of c.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
        const args = argsAt(c, m.index + m[0].length);
        const line = lineOf(c, m.index);
        const call = m[0].replace(/\s*\($/, '').trim();
        if (args !== null && (!args.trim() || UNSEEDED_ARG.test(args))) {
          findings.push({ file: f, line, kind: 'unseeded-game', message: `${call}(${args.trim().slice(0, 40)}) starts a game without a fixed seed: pass a literal or test-local seed so every run rolls the same dice` });
        } else if (!firstSeeded || line < firstSeeded.line) firstSeeded = { line, call };
      }
    }
    if (!firstSeeded) continue;
    const own = sharedLines(c, cfg);
    const routed = own.length ? { file: f, line: own[0].line } : setups[0] || null;
    if (!routed) continue;
    const flat = c.replace(/\s+/g, '');
    if (cfg.isolateCalls.some((s) => flat.includes(s))) continue;
    findings.push({ file: f, line: firstSeeded.line, kind: 'shared-random', message: `${firstSeeded.call}(seed) runs on the shared Math.random (${routed.file}:${routed.line} routes the sim's dice there), so the result depends on test order: ${cfg.isolateCalls.length ? `call ${cfg.isolateCalls.join(' or ')} in this file (beforeEach)` : 'give the test its own seeded dice'}` });
  }
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));
  return { files: tests.length, setups, findings };
}

export const formatFinding = (f) => `${f.file}:${f.line} [TEST_RNG ${f.kind}] ${f.message}`;

/** For a hand-back: { mode, count, items: ['file:line kind', …] } or null (no settings, or no findings). Never throws. */
export function testRngFacts(root = DEFAULT_ROOT, env = process.env) {
  try {
    const cfg = testRngConfig(root, { env });
    if (!cfg || cfg.mode === 'off') return null;
    const r = scanTestRng(root, cfg);
    if (!r.findings.length) return null;
    return { mode: cfg.mode, count: r.findings.length, items: r.findings.map((f) => `${f.file}:${f.line} ${f.kind}`) };
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const json = process.argv.includes('--json');
  const root = DEFAULT_ROOT;
  const cfg = testRngConfig(root);
  if (!cfg || cfg.mode === 'off') {
    const why = cfg ? `"testRandomness" is off in ${cfg.source}` : 'the game declares no "testRandomness" in its studio.gates.json';
    console.log(json ? JSON.stringify({ ok: true, mode: cfg?.mode || null, findings: [], why }) : `[test-rng] nothing to check: ${why}`);
    process.exit(0);
  }
  const r = scanTestRng(root, cfg);
  if (json) console.log(JSON.stringify({ ok: !r.findings.length, mode: cfg.mode, files: r.files, setups: r.setups, findings: r.findings, bad: cfg.bad }));
  else {
    for (const b of cfg.bad) console.log(`[test-rng] note: ${cfg.source} has a pattern that isn't a valid regex (${b}); it is skipped`);
    for (const f of r.findings) console.log(formatFinding(f));
    console.log(r.findings.length
      ? `[test-rng] ${r.findings.length} test file finding(s) in ${r.files} test file(s) (${cfg.mode === 'required' ? 'required' : 'advisory: a warning, set "mode": "required" or STUDIO_TEST_RNG=required to fail on it'})`
      : `[test-rng] ok: ${r.files} test file(s), no seeded game on shared randomness, no unseeded game`);
  }
  process.exit(r.findings.length ? 1 : 0);
}
