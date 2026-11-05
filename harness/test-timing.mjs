#!/usr/bin/env node
/**
 * harness/test-timing.mjs — 2.78.2 (f): millisecond budgets hiding in the normal test suites.
 *
 * Tests that assert on wall-clock time ("each kind averages under 2 ms", a 40 ms layout budget, a frame budget) go red
 * on a busy machine with nothing wrong in the code. 2.78.2 (b) gave them a place (the perf tests: studio/game.json
 * "perfTests" / STUDIO_PERF_TESTS, run alone on a quiet machine in game:perf), but nothing found the ones outside it.
 *
 *   timingFindings(root, dirs, { perfGlobs, gameRoot })   test files (not matching the perf globs) where a wall-clock
 *                       value is ASSERTED against a bound: [{ file, line, text }]. A wall-clock value is an elapsed time
 *                       taken from performance.now(), Date.now() or process.hrtime (a difference with a start time, or
 *                       a variable assigned one, or anything computed from it: an average, a total); an assertion is
 *                       expect(<it>).toBeLessThan / toBeLessThanOrEqual / toBeWithin / .below / .lessThan / .most,
 *                       expect(<it> < n) / assert(<it> < n) / assert.ok(<it> <= n) (or n > <it>). Taking a time without
 *                       asserting on it (logging, a seed) is never flagged. Comment lines are skipped.
 *   timingWarnings(root, dirs, { perfGlobs, gameRoot })   the advisory lines game-gates prints
 *                       ("[game-gates] WARN game:test-timing: <file>:<line> …"); never a FAIL, no row.
 *                       STUDIO_TEST_TIMING=off turns the scan off.
 *
 *   node harness/test-timing.mjs [--json] [<dir> ...]   the findings (default: the studio game's folder); exit 0 always
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestPath } from './test-weakening.mjs';
import { matchAny } from './merge-lane.mjs';

const toPosix = (p) => String(p).replace(/\\/g, '/');
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
export const testTimingOn = (env = process.env) => !off(env.STUDIO_TEST_TIMING);

const CODE = /\.(m?[jt]sx?|c[jt]s)$/i;
const CLOCK = /\b(?:performance\.now|Date\.now|process\.hrtime(?:\.bigint)?|hrtime(?:\.bigint)?)\s*\(/;
const CLOCK_G = /\b(?:performance\.now|Date\.now|process\.hrtime(?:\.bigint)?|hrtime(?:\.bigint)?)\s*\([^()]*\)/g;
// An upper bound on the value (a budget). Lower bounds ("waited at least N ms") don't flake under load.
const UPPER_MATCHER = /\.\s*(?:toBeLessThan|toBeLessThanOrEqual|toBeWithin|below|lessThan|most|lt|lte|isBelow|isAtMost)\s*\(/;
const ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]\s|]+)?=\s*([^;]+)|^\s*([A-Za-z_$][\w$.]*)\s*(?:\+|-)?=\s*(?!=)([^;]+)/;

function walk(root, rel, out, depth = 0) {
  if (depth > 12) return out;
  let st;
  try { st = fs.statSync(path.join(root, rel)); } catch { return out; }
  if (st.isFile()) { if (CODE.test(rel)) out.push(toPosix(rel)); return out; }
  let list = [];
  try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (['node_modules', '.git', 'dist', 'build', '.lanes', '.studio', 'coverage'].includes(e.name)) continue;
    walk(root, path.join(rel, e.name), out, depth + 1);
  }
  return out;
}

const word = (name) => new RegExp(`(^|[^\\w$.])${name.replace(/[$.]/g, '\\$&')}(?![\\w$])`);

/**
 * The lines of one file's text that assert on a wall-clock value: [{ line, text }]. Exported for tests.
 * Start times are variables assigned a clock call alone (`const t0 = performance.now()`); elapsed values are variables
 * assigned from an expression with a clock call and a minus, an hrtime(start) call, or any expression using an elapsed
 * value (an average, a running total).
 */
export function timingLines(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const starts = new Set();
  const elapsed = new Set();
  const other = new Set(); // names also given a value that is not a time: ambiguous, never treated as elapsed
  const usesAny = (expr, set) => [...set].some((v) => word(v).test(expr));
  const isElapsedExpr = (expr) => {
    if (usesAny(expr, elapsed)) return true;
    if (!CLOCK.test(expr) && !usesAny(expr, starts)) return false;
    const bare = expr.replace(CLOCK_G, 'NOW');
    if (/\bhrtime(?:\.bigint)?\s*\(\s*[A-Za-z_$]/.test(expr)) return true; // process.hrtime(start)
    return /NOW\s*-|-\s*NOW|-\s*[A-Za-z_$]/.test(bare) && (/NOW/.test(bare) || usesAny(expr, starts));
  };
  // Two passes: names first (a helper may be declared after its use), then the assertions.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const raw of lines.flatMap((x) => (/^\s*(\/\/|\*|\/\*)/.test(x) ? [] : x.split(/[;{}]/)))) {
      const l = raw.trim();
      const m = l.match(ASSIGN);
      if (!m) continue;
      const name = (m[1] || m[3] || '').split('.').pop();
      const expr = m[2] || m[4] || '';
      if (!name) continue;
      if (/=>|^\s*(?:async\s+)?function\b/.test(expr)) { other.add(name); continue; } // a helper, not a value
      if (isElapsedExpr(expr)) elapsed.add(name);
      else if (!CLOCK.test(expr)) other.add(name);
      else if (CLOCK.test(expr) && expr.replace(CLOCK_G, '').replace(/[\s();Nn]|BigInt|Number/g, '') === '') starts.add(name);
    }
  }
  for (const v of other) elapsed.delete(v);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i].trim();
    if (!l || /^(\/\/|\*|\/\*)/.test(l)) continue;
    // A multi-line expect(...): read up to two more lines.
    const open = (x) => (x.match(/\(/g) || []).length - (x.match(/\)/g) || []).length;
    const stmt = /\bexpect\s*\(|\bassert\b/.test(l) && open(l) > 0 && !/=>|\{\s*$/.test(l) ? [l, (lines[i + 1] || '').trim(), (lines[i + 2] || '').trim()].join(' ') : l;
    const timed = (s) => usesAny(s, elapsed) || (CLOCK.test(s) && /-/.test(s.replace(CLOCK_G, 'NOW')) && /NOW\s*-|-\s*NOW/.test(s.replace(CLOCK_G, 'NOW')));
    let hit = false;
    const ex = stmt.match(/\bexpect\s*\(([\s\S]*?)\)\s*\.\s*(?:not\s*\.\s*)?([A-Za-z]+)\s*\(/);
    if (ex && !/=>|\{/.test(ex[1])) {
      const subject = ex[1];
      if (timed(subject) && (UPPER_MATCHER.test(stmt) || /<=?\s*[\w.$]/.test(subject) && /\.toBe(?:Truthy|\s*\(\s*true)/.test(stmt))) hit = true;
      else if (timed(subject) && /[<>]=?/.test(subject)) hit = true;
    }
    if (!hit && /\bassert(?:\.ok|\.strictEqual|\.equal)?\s*\(/.test(stmt)) {
      const a = stmt.slice(stmt.search(/\bassert/));
      const cmp = a.match(/\(\s*([^,]*?)\s*(<=?|>=?)\s*([^,)]*)/);
      if (cmp && ((/</.test(cmp[2]) && timed(cmp[1])) || (/>/.test(cmp[2]) && timed(cmp[3])))) hit = true;
    }
    if (hit) out.push({ line: i + 1, text: l.slice(0, 160) });
  }
  return out;
}

/** Test files under `dirs` (relative to root), outside the perf globs, that assert on wall-clock time. Never throws. */
export function timingFindings(root, dirs = ['.'], { perfGlobs = [], gameRoot = null, maxFiles = 4000 } = {}) {
  const out = [];
  try {
    const files = [...new Set(dirs.flatMap((d) => walk(root, toPosix(d).replace(/\/+$/, '') || '.', [])))].map((f) => f.replace(/^\.\//, '')).slice(0, maxFiles);
    const g = gameRoot ? `${toPosix(gameRoot).replace(/\/+$/, '')}/` : null;
    for (const f of files) {
      if (!isTestPath(f)) continue;
      // The perf globs are the runner's (from the game's folder) or the repo's: either form excludes the file.
      if (perfGlobs.length && (matchAny(f, perfGlobs) || (g && f.startsWith(g) && matchAny(f.slice(g.length), perfGlobs)))) continue;
      let text;
      try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      if (!CLOCK.test(text)) continue;
      for (const h of timingLines(text)) out.push({ file: f, ...h });
    }
  } catch {}
  return out;
}

/** The advisory lines for a game folder (game-gates prints them), or []. */
export function timingWarnings(root, dirs, { perfGlobs = [], gameRoot = null, env = process.env } = {}) {
  if (!testTimingOn(env)) return [];
  const f = timingFindings(root, dirs, { perfGlobs, gameRoot });
  if (!f.length) return [];
  const files = [...new Set(f.map((x) => x.file))];
  return [
    ...f.slice(0, 8).map((x) => `[game-gates] WARN game:test-timing: ${x.file}:${x.line} asserts on wall-clock time (${x.text}); a busy machine turns it red with nothing wrong: move it to the perf tests`),
    `[game-gates] WARN game:test-timing: ${f.length} wall-clock assertion(s) in ${files.length} test file(s) outside the perf tests${perfGlobs.length ? ` (${perfGlobs.join(', ')})` : ''}: list their files in studio/game.json "perfTests" (the owner's file) or STUDIO_PERF_TESTS, so they run alone on a quiet machine in game:perf (docs/ONBOARDING-A-GAME.md "Perf tests"); advisory only, STUDIO_TEST_TIMING=off hides it`,
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let dirs = argv.filter((a) => !a.startsWith('--'));
  let gameRoot = null;
  if (!dirs.length) {
    const { gameFolder } = await import('./test-rng.mjs');
    gameRoot = gameFolder(root);
    dirs = [gameRoot || '.'];
  }
  const { perfTestsOf } = await import('./game-gates.mjs');
  const perfGlobs = perfTestsOf(process.env, root);
  const f = timingFindings(root, dirs, { perfGlobs, gameRoot });
  if (json) console.log(JSON.stringify({ dirs, perfGlobs, findings: f }));
  else {
    for (const x of f) console.log(`${x.file}:${x.line} [TEST_TIMING] ${x.text}`);
    console.log(f.length ? `[test-timing] ${f.length} wall-clock assertion(s) outside the perf tests (advisory): move them to the perf tests (studio/game.json "perfTests")` : `[test-timing] ok: no wall-clock assertion outside the perf tests in ${dirs.join(', ')}`);
  }
  process.exit(0);
}
