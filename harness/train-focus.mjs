/**
 * harness/train-focus.mjs — 2.65.3 (B-43): a red merge train re-checks only the failing test FILES.
 *
 * Before 2.65.3 each re-check of a red train (prefix bisection, harness/train.mjs redPlan) ran the whole failing
 * studio gate again: for a game whose tests are one gate that was the whole suite, about 10 min a re-check. Now:
 *   - harness/game-gates.mjs names the failing test files of a failing check (failingTestFiles: vitest, jest,
 *     `node --test`, and plain "FAIL <file>" lines; Windows backslashes become forward slashes) in one line,
 *     "[game-gates] failing test files in <check>: [...]";
 *   - the train reads them from its verify log (focusFromLog) and gives each re-check STUDIO_GATE_FOCUS, a JSON map
 *     { "<check>": [files] } that scripts/run-gates.mjs passes on only in an --only run;
 *   - game-gates then runs a failing check on those files only (focusCommand): the manifest gate's "focus" command
 *     (a template with {files}), else, for a command that clearly runs vitest, jest or `node --test` as its last step,
 *     the files appended; else the whole check, saying why. Checks that passed in the verify are skipped. A focused
 *     run that fails without naming a failing test, or passes having run nothing, runs the whole check instead.
 * A focused re-check is a partial run (--only): it stands for no verify, and landing still needs a full verify of the
 * exact tree. Code only; the game's manifest is protected, the harness only reads "focus".
 */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const FILE_EXT = /\.[A-Za-z0-9]{1,6}$/;

/** A path as the runner printed it, normalised: forward slashes, no file:// prefix, no :line:col, no leading ./ */
export function normTestPath(p) {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (/^file:\/\//i.test(s)) { s = s.replace(/^file:\/\//i, ''); try { s = decodeURIComponent(s); } catch {} if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1); }
  // A YAML-escaped Windows path (TAP: 'C:\\\\a\\\\b.mjs') doubles its backslashes: collapse repeated slashes (a UNC path's
  // leading // is kept).
  s = s.replace(/\\/g, '/').replace(/(?!^)\/{2,}/g, '/').replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '');
  return s;
}

const looksLikeFile = (s) => Boolean(s) && FILE_EXT.test(s) && !/\s/.test(s) && !/^[a-z]+:[^/]/i.test(s.replace(/^[A-Za-z]:\//, ''));

/**
 * The failing test files a runner's output names, in order, at most `max`: vitest ("FAIL  file > test",
 * "FAIL  |project| file", "❯ file (3 tests | 1 failed)"), jest ("FAIL file" / "FAIL file (5 s)"), `node --test`
 * (TAP "location: 'file:line:col'" under a "not ok", the spec reporter's "test at file:line:col"), and any plain
 * "FAIL <path>" line. Paths keep the form the runner printed (relative to where it ran, or absolute), with forward
 * slashes.
 */
export function failingTestFiles(output, { max = 50 } = {}) {
  const found = [];
  const add = (p) => { const s = normTestPath(p); if (looksLikeFile(s) && !found.includes(s)) found.push(s); };
  let notOk = false;
  for (const raw of String(output || '').replace(ANSI, '').split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, '');
    let m = l.match(/^\s*(?:FAIL|×|✗|✖)\s+(?:\|[^|]+\|\s+)?(\S+?)(?:\s+>\s.*|\s+\(.*\)|\s+\[.*\])?$/);
    if (m && !/:$/.test(m[1])) { add(m[1]); continue; }
    m = l.match(/^\s*❯\s+(\S+)\s+\(\d+\s+tests?\b.*\bfailed\)/);
    if (m) { add(m[1]); continue; }
    m = l.match(/^\s*test at (.+?:\d+:\d+)\s*$/);
    if (m) { add(m[1]); continue; }
    if (/^\s*not ok \d+/.test(l)) { notOk = true; continue; }
    if (/^\s*ok \d+/.test(l)) { notOk = false; continue; }
    m = l.match(/^\s*location:\s*'(.+?)'\s*$/) || l.match(/^\s*location:\s*"(.+?)"\s*$/);
    if (m && notOk) add(m[1]);
  }
  return found.slice(0, max);
}

/** STUDIO_GATE_FOCUS as { "<check>": [files] }, or null (unset, or not a JSON object of string lists). */
export function readFocus(env = process.env) {
  const t = String(env.STUDIO_GATE_FOCUS || '').trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const out = {};
    for (const [k, v] of Object.entries(j)) out[k] = Array.isArray(v) ? v.map((f) => normTestPath(f)).filter(Boolean) : [];
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

const UNSAFE = /["'`$%!&|<>^;*?\r\n]/;
const quote = (f) => `"${f}"`;

/** The runner the last step of a command clearly runs: 'vitest' | 'jest' | 'node --test' | null. */
export function clearRunner(command) {
  const segs = String(command || '').split(/&&|\|\||;/);
  const last = segs[segs.length - 1].trim();
  if (!last || /[|<>]/.test(last)) return null;
  const toks = last.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  const base = (t) => t.replace(/\\/g, '/').split('/').pop().replace(/\.(c?m?js|cmd|exe|ps1)$/i, '').toLowerCase();
  if (toks.some((t) => base(t) === 'vitest')) return 'vitest';
  if (toks.some((t) => base(t) === 'jest')) return 'jest';
  if (base(toks[0]) === 'node' && toks.includes('--test')) return 'node --test';
  return null;
}

/**
 * The command that runs a game check (a manifest gate: { id, command, focus? }) on these files only:
 * { cmd, how } or { why } (then the whole check runs, and the log says why).
 */
export function focusCommand(gate, files = []) {
  const list = (files || []).map((f) => normTestPath(f)).filter(Boolean);
  if (!list.length) return { why: 'the verify named no failing test file for it' };
  const bad = list.find((f) => UNSAFE.test(f));
  if (bad) return { why: `a failing test path has a character that isn't safe on a command line (${bad.slice(0, 80)})` };
  if (typeof gate?.focus === 'string' && gate.focus.includes('{files}')) return { cmd: gate.focus.split('{files}').join(list.map(quote).join(' ')), how: 'the manifest\'s "focus" command' };
  const runner = clearRunner(gate?.command);
  if (runner) return { cmd: `${String(gate.command).trimEnd()} ${list.map(quote).join(' ')}`, how: `${runner}, the files appended` };
  return { why: `its command (${String(gate?.command || '').slice(0, 80)}) doesn't clearly run vitest, jest or node --test as its last step and its manifest entry has no "focus" command with {files}` };
}

/**
 * What a verify log says about the game's failing checks: { failed: [check ids], files: { id: [files] },
 * tests: { id: [names] } }, read from game-gates' own lines ("[game-gates] FAIL <id>", "failing tests in <id>: [...]",
 * "failing test files in <id>: [...]").
 */
export function focusFromLog(text) {
  const failed = [];
  const files = {};
  const tests = {};
  for (const l of String(text || '').replace(ANSI, '').split(/\r?\n/)) {
    let m = l.match(/^\[game-gates\] FAIL (\S+?)(?:: |$)/);
    if (m && !failed.includes(m[1])) failed.push(m[1]);
    m = l.match(/^\[game-gates\] failing test files in (\S+?): (\[.*\])\s*$/);
    if (m) { try { files[m[1]] = JSON.parse(m[2]).map((f) => normTestPath(f)).filter(Boolean); } catch {} }
    m = l.match(/^\[game-gates\] failing tests in (\S+?): (\[.*\])\s*$/);
    if (m) { try { tests[m[1]] = JSON.parse(m[2]).map(String); } catch {} }
  }
  return { failed, files, tests };
}

/**
 * The STUDIO_GATE_FOCUS map for a red train's re-checks, or { focus: null, why } when they run the whole gate as
 * before 2.65.3 (no failing game check named, or no failing test file named for any of them).
 */
export function trainFocus(text) {
  const f = focusFromLog(text);
  if (!f.failed.length) return { focus: null, why: 'the verify log names no failing game check', ...f };
  if (!f.failed.some((id) => f.files[id]?.length)) return { focus: null, why: `the verify log names no failing test file for ${f.failed.join(', ')}`, ...f };
  return { focus: Object.fromEntries(f.failed.map((id) => [id, f.files[id] || []])), why: '', ...f };
}

/** The failing tests a verify log names, flattened and capped: { list, more }. */
export function failingTestsLine(text, cap = 8) {
  const f = focusFromLog(text);
  const all = [];
  for (const id of f.failed) for (const t of f.tests[id] || []) all.push(`${id}: ${t}`);
  if (!all.length) for (const id of f.failed) for (const x of f.files[id] || []) all.push(`${id}: ${x}`);
  return { list: all.slice(0, cap).map((s) => s.slice(0, 160)), more: Math.max(0, all.length - cap), checks: f.failed };
}
