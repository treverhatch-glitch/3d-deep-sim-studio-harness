/**
 * harness/train-focus.mjs — a red merge train re-checks only the failing test FILES, not the whole failing gate.
 *   - harness/game-gates.mjs names the failing files of a failing check (failingTestFiles: vitest, jest, `node --test`,
 *     plain "FAIL <file>" lines) in "[game-gates] failing test files in <check>: [...]";
 *   - the train reads them from its verify log (focusFromLog) and gives each re-check STUDIO_GATE_FOCUS, a JSON map
 *     { "<check>": [files] } that scripts/run-gates.mjs passes on only in an --only run;
 *   - game-gates runs the failing check on those files only (focusCommand): the gate's "focus" command ({files}), else
 *     the files appended to a vitest, jest or `node --test` command, else inferFocus, else the whole check.
 * A focused re-check is partial (--only): it stands for no verify; landing still needs a full verify. Code only.
 * inferFocus: for an npm-script command whose last step runs vitest or jest, the earlier steps then
 * `npx vitest run {files}` / `npx jest {files}`. STUDIO_FOCUS_INFER=off: no inference.
 */
import { resolveRunner, configFlag } from './test-timeouts.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
 * The failing test files a runner's output names, in order, at most `max`: vitest ("FAIL  file > test"), jest
 * ("FAIL file"), `node --test` (TAP "location: 'file:line:col'" under a "not ok"), and any plain "FAIL <path>" line.
 * Paths keep the form the runner printed, with forward slashes.
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
export function focusCommand(gate, files = [], opts = {}) {
  const list = (files || []).map((f) => normTestPath(f)).filter(Boolean);
  if (!list.length) return { why: 'the verify named no failing test file for it' };
  const bad = list.find((f) => UNSAFE.test(f));
  if (bad) return { why: `a failing test path has a character that isn't safe on a command line (${bad.slice(0, 80)})` };
  if (typeof gate?.focus === 'string' && gate.focus.includes('{files}')) return { cmd: gate.focus.split('{files}').join(list.map(quote).join(' ')), how: 'the manifest\'s "focus" command' };
  const runner = clearRunner(gate?.command);
  if (runner) return { cmd: `${String(gate.command).trimEnd()} ${list.map(quote).join(' ')}`, how: `${runner}, the files appended` };
  // 2.78.2 (f): an npm script whose last step runs vitest or jest: the focus command is inferred.
  const inf = inferFocus(gate?.command, opts);
  if (inf.focus) return { cmd: inf.focus.split('{files}').join(list.map(quote).join(' ')), how: `focus inferred: ${inf.focus} (${inf.why}; STUDIO_FOCUS_INFER=off: none)`, inferred: inf.focus };
  return { why: `its command (${String(gate?.command || '').slice(0, 80)}) doesn't clearly run vitest, jest or node --test as its last step${inf.why ? ` (${inf.why})` : ''} and its manifest entry has no "focus" command with {files}` };
}

/** 2.78.2 (f): STUDIO_FOCUS_INFER=off turns the inferred focus command off. */
export const focusInferOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_FOCUS_INFER ?? '').trim());

/**
 * The focus command a check's command implies, { focus: '<command with {files}>', runner, why } or { focus: null, why
 * }. Only for a command whose last step runs an npm script (read from the package.json its `cd` steps lead to) whose
 * own last step runs vitest or jest. The earlier steps are kept, then `npx vitest run` / `npx jest`, with the
 * script's --config.
 */
export function inferFocus(command, { root = HARNESS_ROOT, env = process.env } = {}) {
  if (!focusInferOn(env)) return { focus: null, why: 'STUDIO_FOCUS_INFER=off' };
  const cmd = String(command || '').trim();
  if (!cmd || clearRunner(cmd)) return { focus: null, why: '' };
  let r;
  try { r = resolveRunner(cmd, root); } catch (e) { return { focus: null, why: String(e.message || e).slice(0, 120) }; }
  if (!r?.runner) return { focus: null, why: r?.why || 'no runner found' };
  if (!r.npm || !['vitest', 'jest'].includes(r.runner)) return { focus: null, why: `its npm script runs ${r.runner}, not vitest or jest` };
  const parts = cmd.split(/&&|\|\||;/);
  const last = parts[parts.length - 1].trim();
  const at = cmd.lastIndexOf(last);
  const before = at > 0 ? cmd.slice(0, at) : '';
  const cfg = configFlag(r.text);
  const cfgArg = cfg ? ` --config ${/^[\w./\\:-]+$/.test(cfg) ? cfg : quote(cfg)}` : '';
  const tail = r.runner === 'vitest' ? `npx vitest run${cfgArg} {files}` : `npx jest${cfgArg} {files}`;
  return { focus: `${before}${tail}`, runner: r.runner, why: `${r.via} runs ${r.runner}` };
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
