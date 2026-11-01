#!/usr/bin/env node
/**
 * qa/fails-before.mjs — does a regression fail on the code before the fix? If it doesn't, it doesn't
 * guard anything.
 *
 *   node qa/fails-before.mjs <regression.json> <commit>    replay it at <commit> (usually the fix's parent)
 *
 * Checks out <commit> into a temporary git worktree (your checkout is untouched), replays the
 * regression with that commit's cartridge, and hashes the end state with today's SHA-256. The
 * regression "fails before" when the old code breaks an invariant, throws, or ends in a different
 * state than the pinned sha256. Results are cached by regression and commit (.studio/cache/).
 *
 * 2.58.4: a run that never got to play the old code proves nothing, so it is an error (known: false), never a pass,
 * and never cached: the cartridge couldn't be loaded at that commit (not there yet, its build failed, a dependency
 * such as node_modules is missing in the worktree), or the run timed out, was killed or printed no result. Before,
 * every one of those counted as "the old code throws" and a regression that guards nothing passed the check.
 * STUDIO_FAILS_BEFORE_TIMEOUT_MS sets the time limit (default 120000).
 *
 * 2.59.0: a regression can also be a seeded game unit test ("kind": "test"; qa/regressions/README.md), for a bug in
 * a part of the game no cartridge replays. The command comes from the studio's own config, never from the regression
 * file: "regressionTest" in studio/game.json, else in the game's studio.gates.json (both protected files), with
 * {file} {name} {seed} {junit} filled in. The test must PASS on the current checkout (the control: the runner, the
 * file and the name work) and FAIL at <commit>, judged from the runner's JUnit result: the named test ran and failed.
 * A run with no JUnit file, no such test in it (the file didn't load: an import the old code doesn't have, a missing
 * dependency), a skipped test, a timeout or a kill is an error (known: false), as for a replay, never a pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.studio', 'cache', 'fails-before.json');
const git = (args, cwd = ROOT) => spawnSync('git', args, { cwd, encoding: 'utf8' });

// ---- 2.59.0: "kind": "test" regressions (a seeded game unit test, run by the game's own test runner) ----

/** A regression file's kind: "test" (a seeded game unit test) or "replay" (a cartridge replay, the default). */
export const regressionKind = (spec) => (spec && spec.kind === 'test' ? 'test' : 'replay');

const readJsonAt = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/**
 * The studio's test runner for "kind": "test" regressions: { command, cwd, timeoutMs, from } or { error }. Read from
 * the current checkout (root), never from the old commit: studio/game.json "regressionTest", else the game's
 * studio.gates.json "regressionTest" (game/<game>/ or web/<game>/). A string is the command alone.
 */
export function regressionTestRunner(root = ROOT) {
  const gameJson = readJsonAt(path.join(root, 'studio', 'game.json')) || {};
  const game = process.env.STUDIO_GAME || gameJson.game || null;
  const tries = [['studio/game.json', gameJson]];
  if (game && /^[\w.-]+$/.test(game)) for (const d of ['game', 'web']) tries.push([`${d}/${game}/studio.gates.json`, readJsonAt(path.join(root, d, game, 'studio.gates.json'))]);
  for (const [from, j] of tries) {
    const r = j && j.regressionTest;
    if (!r) continue;
    const cfg = typeof r === 'string' ? { command: r } : r;
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) return { error: `${from} "regressionTest" has no command` };
    if (!cfg.command.includes('{junit}')) return { error: `${from} "regressionTest" command has no {junit}: the runner must write a JUnit XML result there (vitest: --reporter=junit --outputFile={junit}; node --test: --test-reporter=junit --test-reporter-destination={junit}), so a test that never ran can't count as failing` };
    const cwd = typeof cfg.cwd === 'string' ? cfg.cwd.replace(/\\/g, '/').replace(/^\.\/?|\/+$/g, '') : '';
    if (cwd.split('/').includes('..') || path.isAbsolute(cwd)) return { error: `${from} "regressionTest" cwd must be a folder inside the repo` };
    return { command: cfg.command, cwd, timeoutMs: Number(cfg.timeoutMs) || null, from };
  }
  return { error: `no test runner for "kind": "test" regressions: add "regressionTest": { "command": "…{file}…{name}…{junit}…" } to studio/game.json or ${game ? `the game's studio.gates.json (game/${game}/ or web/${game}/)` : 'the game\'s studio.gates.json'} (a protected file: the owner approves it)` };
}

/** Split a command line into words: spaces separate, "…" and '…' group, no shell, no globbing. */
export function splitCommand(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (const ch of String(text)) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

const xmlText = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`)); return m ? xmlText(m[2] ?? m[3]) : null; };
/** The test cases in a JUnit XML report: [{ name, classname, failed, skipped, message }]. */
export function junitCases(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const body = m[3] || '';
    const fail = body.match(/<(failure|error)\b([^>]*)>?/);
    out.push({ name: attr(m[1], 'name') || '', classname: attr(m[1], 'classname') || '', failed: Boolean(fail), skipped: /<skipped\b/.test(body), message: fail ? (attr(fail[0], 'message') || xmlText(body.replace(/<[^>]+>/g, ' ')).trim()).replace(/\s+/g, ' ').slice(0, 200) : '' });
  }
  return out;
}
/** The case for this test name: exact, or the name after a suite path ("suite > name", "Suite.name", "suite::name"). */
const findCase = (cases, want) => {
  const w = String(want).trim();
  return cases.find((c) => c.name === w) || cases.find((c) => [' > ', ' › ', '::', '.', ' '].some((sep) => c.name.endsWith(`${sep}${w}`) || `${c.classname}${sep}${c.name}` === w));
};

const linkModules = (from, to, dirs) => {
  for (const d of dirs) {
    const src = path.join(from, d, 'node_modules');
    const dst = path.join(to, d, 'node_modules');
    if (!fs.existsSync(src) || fs.existsSync(dst) || !fs.existsSync(path.join(to, d))) continue;
    // A junction on Windows needs no admin rights; elsewhere a plain directory link.
    try { fs.symlinkSync(fs.realpathSync(src), dst, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the run then says what it couldn't load */ }
  }
};
/** Every folder from the repo root down to rel's folder: ['', 'game', 'game/x', …]. */
const ancestors = (rel) => {
  const parts = path.posix.dirname(String(rel).replace(/\\/g, '/')).split('/').filter((p) => p && p !== '.');
  return ['', ...parts.map((_, i) => parts.slice(0, i + 1).join('/'))];
};

/**
 * Run one "kind": "test" regression in a checkout (root): { ran, passed, why }. ran false: it proves nothing (no
 * JUnit result, the named test not in it, skipped, timed out, killed). The seed goes in as {seed} and STUDIO_TEST_SEED.
 */
export function runRegressionTest(spec, root = ROOT, runner = regressionTestRunner(ROOT)) {
  if (runner.error) return { ran: false, passed: null, why: runner.error };
  const file = String(spec.test?.file || '').replace(/\\/g, '/');
  const name = String(spec.test?.name || '');
  if (!file || !name || !Number.isInteger(spec.seed)) return { ran: false, passed: null, why: 'a "kind": "test" regression needs "test": { "file", "name" } and an integer "seed"' };
  if (path.isAbsolute(file) || file.split('/').includes('..')) return { ran: false, passed: null, why: `test.file must be a path inside the repo, not ${file}` };
  const junitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fails-before-junit-'));
  const junit = path.join(junitDir, 'result.xml');
  try {
    const cwd = path.join(root, runner.cwd || '');
    const fromCwd = path.relative(cwd, path.join(root, file)).split(path.sep).join('/');
    const vals = { file: fromCwd, name, seed: String(spec.seed), junit };
    const fill = (w) => w.replace(/\{(file|name|seed|junit)\}/g, (_, k) => vals[k]);
    const words = splitCommand(runner.command).map(fill);
    if (!words.length) return { ran: false, passed: null, why: `${runner.from} "regressionTest" command is empty` };
    const isNode = /^node(\.exe)?$/i.test(words[0]);
    const bin = isNode ? process.execPath : words[0];
    // Windows: npx/npm/vitest are .cmd files, which only run through a shell (each word quoted). UNTESTED on Windows.
    const shell = !isNode && process.platform === 'win32';
    const q = (w) => `"${String(w).replace(/"/g, '""')}"`;
    const limit = runner.timeoutMs || Number(process.env.STUDIO_FAILS_BEFORE_TIMEOUT_MS || 120000);
    const env = { ...process.env, CI: 'true', STUDIO_TEST_SEED: String(spec.seed), STUDIO_TEST_NAME: name, STUDIO_TEST_FILE: file, AGENT_EVENTS_FILE: path.join(junitDir, '.events.jsonl') };
    const r = shell
      ? spawnSync([bin, ...words.slice(1)].map(q).join(' '), { cwd, shell: true, encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024, env })
      : spawnSync(bin, words.slice(1), { cwd, encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024, env });
    const tail = String(`${r.stderr || ''}\n${r.stdout || ''}`).replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(-300);
    if (r.error?.code === 'ETIMEDOUT' || r.signal) return { ran: false, passed: null, why: `the test run timed out or was killed after ${Math.round(limit / 1000)} s (STUDIO_FAILS_BEFORE_TIMEOUT_MS)` };
    if (r.error) return { ran: false, passed: null, why: `couldn't run ${words[0]} (${r.error.code || r.error.message})` };
    if (!fs.existsSync(junit)) return { ran: false, passed: null, why: `the runner wrote no JUnit result (exit ${r.status}), so the test never ran there: ${tail || 'no output'}` };
    const cases = junitCases(fs.readFileSync(junit, 'utf8'));
    const c = findCase(cases, name);
    if (!c) {
      const fileLevel = cases.find((x) => x.failed);
      return { ran: false, passed: null, why: `the test "${name}" didn't run (not in the JUnit result${fileLevel ? `; the run failed before it: ${fileLevel.message || fileLevel.name}` : cases.length ? `; it holds ${cases.length} other test(s)` : ''}): the file didn't load or the name doesn't match` };
    }
    if (c.skipped) return { ran: false, passed: null, why: `the test "${name}" was skipped` };
    return c.failed ? { ran: true, passed: false, why: c.message || 'the test failed' } : { ran: true, passed: true, why: 'the test passed' };
  } finally {
    fs.rmSync(junitDir, { recursive: true, force: true });
  }
}

/** failsBefore for a "kind": "test" regression: it passes on the current checkout, and fails at the commit. */
function testFailsBefore(regressionFile, spec, resolved) {
  const runner = regressionTestRunner(ROOT);
  if (runner.error) return { ok: false, known: false, why: runner.error };
  const file = String(spec.test?.file || '').replace(/\\/g, '/');
  const src = path.join(ROOT, file);
  if (!file || !fs.existsSync(src)) return { ok: false, known: false, why: `the test file ${file || '(none named)'} isn't in this checkout` };
  const head = git(['rev-parse', 'HEAD']).stdout.trim();
  const status = git(['status', '--porcelain']).stdout;
  const key = crypto.createHash('sha256').update(`test|${resolved}|${head}|${status}|${JSON.stringify(spec)}|${JSON.stringify(runner)}|`).update(fs.readFileSync(src)).digest('hex');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = {}; }
  if (cache[key]) return cache[key];
  const short = resolved.slice(0, 7);
  // The control first: on the current checkout (with the fix) the test must run and pass.
  const now = runRegressionTest(spec, ROOT, runner);
  if (!now.ran) return { ok: false, known: false, commit: short, why: `the test couldn't be run on the current checkout (${now.why}); fix the regression or the runner first` };
  if (!now.passed) return { ok: false, known: true, commit: short, why: `the test fails on the current checkout too (${now.why}): it must pass with the fix` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fails-before-'));
  let result;
  try {
    const add = git(['worktree', 'add', '--detach', '--force', tmp, resolved]);
    if (add.status !== 0) return { ok: false, known: false, why: `couldn't check out ${short}: ${add.stderr.trim()}` };
    // Today's test against the old code: the test file as it is now, at the same path.
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
    fs.copyFileSync(src, path.join(tmp, file));
    // The worktree has no dependencies of its own (P-081): use this checkout's.
    linkModules(ROOT, tmp, [...new Set([...ancestors(file), ...ancestors(`${runner.cwd || '.'}/x`)])]);
    const before = runRegressionTest(spec, tmp, runner);
    if (!before.ran) return { ok: false, known: false, commit: short, why: `at ${short}: ${before.why}; that proves nothing about the bug, so it doesn't count as failing before the fix` };
    result = before.passed
      ? { ok: false, known: true, commit: short, why: `the test passes on ${short} too, so it doesn't catch the bug` }
      : { ok: true, known: true, commit: short, why: `the test "${spec.test.name}" (seed ${spec.seed}) fails on the old code (${before.why}) and passes on the current checkout` };
  } finally {
    git(['worktree', 'remove', '--force', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
    git(['worktree', 'prune']);
  }
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  cache[key] = result;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return result;
}

export function failsBefore(regressionFile, commit) {
  const spec = JSON.parse(fs.readFileSync(regressionFile, 'utf8'));
  const resolved = git(['rev-parse', '--verify', `${commit}^{commit}`]).stdout.trim();
  if (!resolved) return { ok: false, known: false, why: `no commit ${commit}` };
  if (regressionKind(spec) === 'test') return testFailsBefore(regressionFile, spec, resolved);
  const key = crypto.createHash('sha256').update(`${resolved}|${JSON.stringify(spec)}`).digest('hex');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    cache = {};
  }
  if (cache[key]) return cache[key];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fails-before-'));
  let result;
  try {
    const add = git(['worktree', 'add', '--detach', '--force', tmp, resolved]);
    if (add.status !== 0) return { ok: false, known: false, why: `couldn't check out ${resolved.slice(0, 7)}: ${add.stderr.trim()}` };
    const probe = path.join(tmp, '.fails-before-probe.mjs');
    fs.writeFileSync(probe, `
import fs from 'node:fs';
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { loadCartridge, replay } = await import(${JSON.stringify(pathToFileURL(path.join(tmp, 'harness', 'cartridge.mjs')).href)});
const { sha256 } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'harness', 'hash.mjs')).href)});
let out;
let cart = null;
try {
  cart = await loadCartridge(spec.cartridge || undefined);
} catch (err) {
  out = { loadFailed: String(err && err.message || err) };
}
if (cart) {
  try {
    const r = replay(cart, { seed: spec.seed, tick: spec.tick, actions: spec.actions || [], tuning: spec.tuning });
    out = { findings: r.findings.map((f) => f.id), failingTick: r.failingTick, sha256: sha256(r.state) };
  } catch (err) {
    out = { threw: String(err && err.message || err) };
  }
}
console.log('FAILS_BEFORE_RESULT ' + JSON.stringify(out));
`);
    const specFile = path.join(tmp, '.fails-before-spec.json');
    fs.writeFileSync(specFile, JSON.stringify(spec));
    const limit = Number(process.env.STUDIO_FAILS_BEFORE_TIMEOUT_MS || 120000);
    const run = spawnSync(process.execPath, [probe, specFile], { cwd: tmp, encoding: 'utf8', timeout: limit, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AGENT_EVENTS_FILE: path.join(tmp, '.events.jsonl') } });
    const line = String(run.stdout || '').split('\n').reverse().find((l) => l.startsWith('FAILS_BEFORE_RESULT '));
    let before = null;
    try { before = line ? JSON.parse(line.slice('FAILS_BEFORE_RESULT '.length)) : null; } catch { before = null; }
    const short = (t) => String(t || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
    // Never played the old code: an error, not a pass (and not cached, so a fixed setup is checked again).
    const unplayed = run.error?.code === 'ETIMEDOUT' || run.signal
      ? `the run at ${resolved.slice(0, 7)} timed out or was killed after ${Math.round(limit / 1000)} s (STUDIO_FAILS_BEFORE_TIMEOUT_MS)`
      : !before
        ? `the run at ${resolved.slice(0, 7)} printed no result (exit ${run.status}): ${short(run.stderr) || 'no output'}`
        : before.loadFailed
          ? `the cartridge couldn't be loaded at ${resolved.slice(0, 7)} (${short(before.loadFailed)})`
          : null;
    if (unplayed) return { ok: false, known: false, commit: resolved.slice(0, 7), why: `${unplayed}; that proves nothing about the bug, so it doesn't count as failing before the fix. Land the cartridge (and anything its build needs) before the fix that relies on it` };
    const failed = Boolean(before.threw) || (before.findings || []).length > 0 || before.sha256 !== spec.sha256;
    result = {
      ok: failed,
      known: true,
      commit: resolved.slice(0, 7),
      why: failed
        ? before.threw
          ? `the old code throws (${before.threw})`
          : before.findings?.length
            ? `the old code breaks ${before.findings.join(', ')} at tick ${before.failingTick}`
            : 'the old code ends in a different state'
        : `the regression passes on ${resolved.slice(0, 7)} too, so it doesn't catch the bug`,
    };
  } finally {
    git(['worktree', 'remove', '--force', tmp]);
    fs.rmSync(tmp, { recursive: true, force: true });
    git(['worktree', 'prune']);
  }
  if (!result) return { ok: false, known: false, why: 'no result' };
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  cache[key] = result;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [file, commit] = process.argv.slice(2);
  if (!file || !commit) {
    console.error('Usage: node qa/fails-before.mjs <regression.json> <commit>');
    process.exit(1);
  }
  const r = failsBefore(path.resolve(file), commit);
  console.log(r.ok ? `[fails-before] PASS ${path.basename(file)} fails at ${r.commit}: ${r.why}` : `[fails-before] ${r.known === false ? 'ERROR' : 'FAIL'} ${path.basename(file)}: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
