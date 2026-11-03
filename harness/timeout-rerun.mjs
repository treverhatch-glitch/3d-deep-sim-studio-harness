/**
 * harness/timeout-rerun.mjs — 2.72.0 (a): a red whose ONLY failures are per-test timeouts re-runs just those files.
 *
 * On a clean game copy the red runs were timeouts in long sim suites (4 of 6). Before 2.72.0 such a red blamed the
 * lane (the train's flake triager labelled it afterwards, labels only). Now, in a game check (harness/game-gates.mjs):
 *   - timeoutOnly(output) reads the runner's failures (vitest "Test timed out in N ms", jest "Exceeded timeout of N ms",
 *     node --test failureType 'testTimeoutFailure' / "test timed out after N ms", in TAP or the spec reporter) and says
 *     whether EVERY failure is a timeout, each in a named file, and the runner's own failure count agrees (a count it
 *     can't read, a failure it can't place, a file-level error, or any non-timeout failure: not timeout-only);
 *   - then each timed-out file runs once more ALONE at low load (one test worker: STUDIO_TEST_WORKERS=1,
 *     VITEST_MAX_WORKERS=1, as the 2.69 flake triager's second run), through the check's focus command (2.65.3);
 *   - every file green alone: the check counts green, each file labelled "timeout-flake" in .studio/flakes.jsonl (and
 *     in the digest); any file red alone: the check stays red, and only the red files are its failing files. A mixed
 *     red (a timeout and a real failure) is a real red, as before. A file that was not re-run green never counts green.
 * STUDIO_TIMEOUT_RERUN=off keeps 2.71.1's behaviour (no re-run). The flake triager's own runs set it off: it wants the
 * raw answer.
 */
import { normTestPath, failingTestFiles } from './train-focus.mjs';

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const timeoutRerunOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TIMEOUT_RERUN || '').trim());

/** A line (or block) that says a test ran out of time, in any of the runners we read. */
export const TIMEOUT_SIG = /Test timed out in \d+\s*ms|Exceeded timeout of \d+\s*ms|failureType:\s*'testTimeoutFailure'|test timed out after \d+\s*ms|Error: Timeout of \d+\s*ms exceeded/i;

/**
 * The failures a runner's output describes: [{ file, test, timeout }]. vitest (the "FAIL file > test" blocks of its
 * failure summary), jest ("FAIL file" then "● test" blocks; "● Test suite failed to run" is a file error), node --test
 * (TAP "not ok" blocks with location and failureType; the spec reporter's "test at file:l:c" blocks). Aggregates
 * (node's 'subtestsFailed' parents, jest's summary repeat) are left out; duplicates merge.
 */
export function failureBlocks(output) {
  const lines = String(output || '').replace(ANSI, '').split(/\r?\n/);
  const out = [];
  const seen = new Map();
  const add = (b) => {
    const k = `${b.file || ''}|${b.test || ''}`;
    if (seen.has(k)) { const o = seen.get(k); o.timeout = o.timeout || b.timeout; return; }
    seen.set(k, b); out.push(b);
  };
  let jestFile = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // vitest: " FAIL  file > suite > test" (a test) or " FAIL  file [ file ]" / " FAIL  file" (the file itself)
    let m = l.match(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+?)\s+>\s+(.+?)\s*$/);
    if (m) {
      const body = [];
      for (let j = i + 1; j < lines.length && !/^\s*FAIL\s/.test(lines[j]) && !/^\s*⎯{3,}/.test(lines[j]) && !/^\s*(Test Files|Tests)\s/.test(lines[j]); j++) body.push(lines[j]);
      add({ file: normTestPath(m[1]), test: m[2].trim(), timeout: TIMEOUT_SIG.test(body.join('\n')), runner: 'vitest' });
      continue;
    }
    // jest: " FAIL  file (5 s)" opens a file; "  ● name" a test in it.
    m = l.match(/^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+?)(?:\s+\(.*\)|\s+(\[.*\]))?\s*$/);
    if (m && !/:$/.test(m[1])) { jestFile = normTestPath(m[1]); if (m[2]) add({ file: jestFile, test: '(file)', timeout: false, runner: 'vitest' }); continue; }
    m = l.match(/^\s*●\s+(.+?)\s*$/);
    if (m && jestFile) {
      if (/^Test suite failed to run/.test(m[1])) { add({ file: jestFile, test: '(file)', timeout: false, runner: 'jest' }); continue; }
      const body = [];
      for (let j = i + 1; j < lines.length && !/^\s*●\s/.test(lines[j]) && !/^\s*(FAIL|PASS)\s/.test(lines[j]) && !/^\s*(Tests|Test Suites):/.test(lines[j]); j++) body.push(lines[j]);
      add({ file: jestFile, test: m[1].replace(/\s+›\s+/g, ' > '), timeout: TIMEOUT_SIG.test(body.join('\n')), runner: 'jest' });
      continue;
    }
    // node --test, TAP: "not ok N - name" then an indented YAML block up to "...".
    m = l.match(/^\s*not ok \d+ - (.+?)\s*$/);
    if (m) {
      const body = [];
      for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]) && !/^\s*(not )?ok \d+/.test(lines[j]); j++) body.push(lines[j]);
      const text = body.join('\n');
      if (/failureType:\s*'subtestsFailed'/.test(text)) continue;
      const loc = text.match(/^\s*location:\s*['"](.+?)['"]\s*$/m);
      add({ file: loc ? normTestPath(loc[1]) : null, test: m[1], timeout: TIMEOUT_SIG.test(text), runner: 'node --test' });
      continue;
    }
    // node --test, spec reporter's failing list: "test at file:l:c", "✖ name (ms)", then the error.
    m = l.match(/^\s*test at (.+?:\d+:\d+)\s*$/);
    if (m) {
      const name = (lines[i + 1] || '').match(/^\s*✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/);
      const body = [];
      for (let j = i + 2; j < lines.length && !/^\s*test at /.test(lines[j]); j++) body.push(lines[j]);
      add({ file: normTestPath(m[1]), test: name ? name[1] : '?', timeout: TIMEOUT_SIG.test(body.join('\n')), runner: 'node --test' });
    }
  }
  return out;
}

/** The runner's own count of failed tests (timeouts included), or null when it printed none we read. */
export function failureCount(output) {
  const t = String(output || '').replace(ANSI, '');
  let m = t.match(/^\s*Tests\s+(\d+) failed/m); // vitest
  if (m) return Number(m[1]);
  m = t.match(/^\s*Tests:\s+(?:.*?\b)?(\d+) failed/m); // jest
  if (m) return Number(m[1]);
  const f = t.match(/^\s*(?:#|ℹ)\s*fail (\d+)\s*$/m); // node --test (a timeout counts as cancelled there)
  const c = t.match(/^\s*(?:#|ℹ)\s*cancelled (\d+)\s*$/m);
  if (f) return Number(f[1]) + (c ? Number(c[1]) : 0);
  return null;
}

/**
 * Is this red only timeouts? { ok, files, why, blocks }. ok only when every failure parsed is a timeout in a named file,
 * the runner's count says no more failed than that, and no failing file is named outside them.
 */
export function timeoutOnly(output) {
  const blocks = failureBlocks(output);
  const no = (why) => ({ ok: false, files: [], why, blocks });
  if (!blocks.length) return no('no failure the harness can read');
  if (!blocks.some((b) => b.timeout)) return no('no failure is a timeout');
  const real = blocks.filter((b) => !b.timeout);
  if (real.length) return no(`a mixed red: ${real.length} failure(s) that are not timeouts (${real.slice(0, 2).map((b) => `${b.file || '?'} > ${b.test}`).join('; ')})`);
  if (blocks.some((b) => !b.file)) return no('a timed-out test whose file the output does not name');
  const n = failureCount(output);
  if (n === null) return no('the runner printed no failure count to check against');
  if (n > blocks.length) return no(`the runner counts ${n} failure(s), the harness read ${blocks.length}`);
  const files = [...new Set(blocks.map((b) => b.file))];
  const named = failingTestFiles(output).filter((f) => !files.some((x) => x === f || x.endsWith(`/${f}`) || f.endsWith(`/${x}`)));
  if (named.length) return no(`a failing file with no timeout read in it (${named.slice(0, 2).join(', ')})`);
  return { ok: true, files, why: `${blocks.length} test(s) timed out in ${files.length} file(s), nothing else failed`, blocks };
}

/** The timeout-flake lines a log names ("[game-gates] timeout-flake in <check>: [files]"): { <check>: [files] }. */
export function timeoutFlakesFromLog(text) {
  const out = {};
  for (const l of String(text || '').replace(ANSI, '').split(/\r?\n/)) {
    const m = l.match(/^\s*(?:\|\s*)?\[game-gates\] timeout-flake in (\S+?): (\[.*\])\s*$/);
    if (m) { try { out[m[1]] = [...new Set([...(out[m[1]] || []), ...JSON.parse(m[2]).map(String)])]; } catch {} }
  }
  return out;
}
