#!/usr/bin/env node
/**
 * harness/test-config-check.mjs — 2.78.2 (f): does the game's test config honour what the harness tells it?
 *
 * The crew's quarantine was a silent no-op: game-gates printed "3 quarantined test file(s) skipped by the game's runner
 * (STUDIO_TEST_QUARANTINE)" while the game's test config never read the variable, so the "skipped" tests ran and kept
 * failing trains. And a test check with no "focus" command made every train re-check re-run the whole suite (~20 min).
 *
 *   verifySkip({ root, gate, varName, files })   runs the runner's list mode (vitest: `npx --no vitest list --filesOnly`,
 *                      jest: `npx --no jest --listTests`; the check's `cd` steps and the script's --config kept) once
 *                      without the variable and once with it naming the probe files (the quarantined files, or the
 *                      first listed file): { state: 'honoured' | 'not-honoured' | 'unknown' | 'off', config, why, still }.
 *                      The verdict is cached per test config (a hash of the runner command, the config file and the
 *                      package.json) in <main checkout>/.studio/test-config-check.json, so it runs once per config.
 *                      STUDIO_QUARANTINE_VERIFY=off: not verified (game-gates then says "passed", never "skipped").
 *                      STUDIO_TEST_LIST_TIMEOUT_MS (120000): the bound on one list run.
 *   testCheckItems({ root })   the preflight's and onboarding's items for the studio game's checks (PASS / WARN / FAIL /
 *                      INFO, with a fix): a test check with neither a "focus" command nor a runner the harness can run
 *                      single files with (harness/train-focus.mjs focusCommand, inferFocus) FAILs; a test config that
 *                      doesn't drop a file named in STUDIO_TEST_QUARANTINE (and, when perf or slow-tier tests are
 *                      declared, STUDIO_TEST_EXCLUDE) FAILs.
 *
 *   node harness/test-config-check.mjs [--json]   the items (npm run onboard -- --check); exit 1 on a FAIL
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRunner, configFlag, findUp, CONFIG_EXT } from './test-timeouts.mjs';
import { normTestPath, focusCommand, clearRunner } from './train-focus.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const rel = (root, f) => path.relative(root, f).split(path.sep).join('/') || '.';
const q = (s) => (/^[\w./\\:-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);

export const quarantineVerifyOn = (env = process.env) => !off(env.STUDIO_QUARANTINE_VERIFY);
export const listTimeoutMs = (env = process.env) => { const n = Number(env.STUDIO_TEST_LIST_TIMEOUT_MS); return Number.isFinite(n) && n > 0 ? n : 120000; };
const CACHE = 'test-config-check.json';

/**
 * How to list a check's test files: { runner, cwd, cmd, config (repo-relative or null), files (absolute config inputs) }
 * or { why }. Only vitest and jest (directly, or as the last step of the npm script the command runs).
 */
export function listPlan(gate, root = ROOT) {
  let r;
  try { r = resolveRunner(String(gate?.command || ''), root); } catch (e) { return { why: String(e.message || e).slice(0, 160) }; }
  if (!r?.runner) return { why: r?.why || 'no test runner found in its command' };
  if (!['vitest', 'jest'].includes(r.runner)) return { why: `it runs ${r.runner}, which has no list mode the harness reads` };
  const named = configFlag(r.text);
  let file = null;
  if (named) file = path.resolve(r.cwd, named);
  else if (r.runner === 'vitest') file = findUp(CONFIG_EXT.map((e) => `vitest.config.${e}`), r.cwd, root) || findUp(CONFIG_EXT.map((e) => `vite.config.${e}`), r.cwd, root);
  else file = findUp([...CONFIG_EXT.map((e) => `jest.config.${e}`), 'jest.config.json'], r.cwd, root);
  const cfgArg = named ? ` --config ${q(named)}` : '';
  const cmd = r.runner === 'vitest' ? `npx --no vitest list --filesOnly${cfgArg}` : `npx --no jest --listTests${cfgArg}`;
  const pkg = path.join(r.cwd, 'package.json');
  const files = [file, pkg].filter((f) => f && fs.existsSync(f));
  return { runner: r.runner, cwd: r.cwd, cmd, config: file && fs.existsSync(file) ? rel(root, file) : null, files, via: r.via };
}

/** The cache key of a test config: the runner command and folder, and the bytes of its config file and package.json. */
export function configKey(plan, root = ROOT) {
  const h = crypto.createHash('sha1');
  h.update(`v1\0${plan.runner}\0${rel(root, plan.cwd)}\0${plan.cmd}\0`);
  for (const f of plan.files) { h.update(`${rel(root, f)}\0`); try { h.update(fs.readFileSync(f)); } catch {} h.update('\0'); }
  return h.digest('hex').slice(0, 20);
}

/** The test files a list run printed (vitest `list --filesOnly` / `list`, jest `--listTests`), normalised. */
export function listedFiles(text) {
  const out = [];
  for (const raw of String(text || '').replace(ANSI, '').split(/\r?\n/)) {
    let l = raw.trim();
    if (!l || /^(npm|npx)\b/i.test(l)) continue;
    l = l.replace(/^\[[^\]]+\]\s+/, '').replace(/\s+>\s.*$/, '');
    if (!/\.[A-Za-z0-9]{1,6}$/.test(l) || /\s/.test(l)) continue;
    const p = normTestPath(l);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
const samePath = (a, b) => { const x = normTestPath(a); const y = normTestPath(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`); };
const isListed = (list, f) => list.some((x) => samePath(x, f));

function readCache(cacheRoot) { try { return JSON.parse(fs.readFileSync(path.join(cacheRoot, '.studio', CACHE), 'utf8')) || {}; } catch { return {}; } }
function writeCache(cacheRoot, key, val) {
  try {
    const c = readCache(cacheRoot);
    c[key] = val;
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete c[k]; // the last 50 configs
    fs.mkdirSync(path.join(cacheRoot, '.studio'), { recursive: true });
    const f = path.join(cacheRoot, '.studio', CACHE);
    fs.writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(c, null, 2));
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
  } catch {}
}

function listRun(plan, env, extra, timeoutMs) {
  const e = { ...env, CI: 'true' };
  for (const k of ['STUDIO_TEST_QUARANTINE', 'STUDIO_TEST_EXCLUDE', 'STUDIO_TEST_ONLY', 'STUDIO_GATE_FOCUS']) delete e[k];
  Object.assign(e, extra);
  const r = spawnSync(plan.cmd, { cwd: plan.cwd, shell: true, encoding: 'utf8', env: e, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.error || r.status !== 0) return { ok: false, why: `\`${plan.cmd}\` ${r.error?.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeoutMs / 1000)} s` : `exited ${r.status ?? r.signal ?? r.error?.code ?? '?'}`}${text.trim() ? `: ${text.trim().split('\n').pop().slice(0, 160)}` : ''}` };
  return { ok: true, files: listedFiles(r.stdout || '') };
}

/** The value a variable carries for these probe files: STUDIO_TEST_QUARANTINE a JSON list, STUDIO_TEST_EXCLUDE globs. */
const valueFor = (varName, files) => (varName === 'STUDIO_TEST_QUARANTINE' ? JSON.stringify(files) : files.join(','));

/**
 * Does the check's test config drop the files named in `varName`? { state, config, why, still, probe, cached }.
 * files: the files to probe (the quarantined ones), or null (the first file the runner lists). With `write` false the
 * cache is read, never written (the preflight changes no file).
 */
export function verifySkip({ root = ROOT, cacheRoot = root, gate, varName = 'STUDIO_TEST_QUARANTINE', files = null, env = process.env, write = true } = {}) {
  if (!quarantineVerifyOn(env)) return { state: 'off', config: null, why: 'STUDIO_QUARANTINE_VERIFY=off', still: [] };
  const plan = listPlan(gate, root);
  if (plan.why) return { state: 'unknown', config: null, why: plan.why, still: [] };
  const key = `${varName}:${configKey(plan, root)}`;
  const hit = readCache(cacheRoot)[key];
  const given = (files || []).map((f) => normTestPath(f)).filter(Boolean);
  if (hit && ['honoured', 'not-honoured', 'unknown'].includes(hit.state)) {
    return { state: hit.state, config: plan.config, why: hit.why || '', still: hit.state === 'not-honoured' ? (given.length ? given : hit.still || []) : [], probe: hit.probe || [], cached: true };
  }
  const t = listTimeoutMs(env);
  const save = (v) => { if (write) writeCache(cacheRoot, key, { ...v, config: plan.config, at: new Date().toISOString() }); return { ...v, config: plan.config, cached: false }; };
  const base = listRun(plan, env, {}, t);
  if (!base.ok) return save({ state: 'unknown', why: `its list mode failed (${base.why})`, still: [], probe: [] });
  if (!base.files.length) return save({ state: 'unknown', why: `\`${plan.cmd}\` listed no test file`, still: [], probe: [] });
  const probe = given.length ? given.filter((f) => isListed(base.files, f)) : [base.files[0]];
  if (!probe.length) return { state: 'unknown', config: plan.config, why: `none of the ${given.length} file(s) is in what \`${plan.cmd}\` lists (renamed or deleted?)`, still: [], probe: [], cached: false };
  const withVar = listRun(plan, env, { [varName]: valueFor(varName, probe) }, t);
  if (!withVar.ok) return save({ state: 'unknown', why: `its list mode failed with ${varName} set (${withVar.why})`, still: [], probe });
  const still = probe.filter((f) => isListed(withVar.files, f));
  if (still.length) return save({ state: 'not-honoured', why: `\`${plan.cmd}\` still lists ${still.slice(0, 3).join(', ')}${still.length > 3 ? ` +${still.length - 3} more` : ''} with ${varName} naming ${still.length === 1 ? 'it' : 'them'}`, still, probe });
  return save({ state: 'honoured', why: `\`${plan.cmd}\` drops ${probe.length === 1 ? probe[0] : `${probe.length} file(s)`} when ${varName} names ${probe.length === 1 ? 'it' : 'them'}`, still: [], probe });
}

/** The fix for a test config that ignores the variables (one sentence, for a FAIL item and the WARN line). */
export function skipFix(config, runner = 'vitest') {
  const where = config || (runner === 'jest' ? 'jest.config.*' : 'vitest.config.* / vite.config.*');
  return runner === 'jest'
    ? `in ${where}, add the files to testPathIgnorePatterns: ...JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]'), ...(process.env.STUDIO_TEST_EXCLUDE || '').split(',').filter(Boolean) (docs/ONBOARDING-A-GAME.md "Quarantined flaky tests")`
    : `in ${where}, make test.exclude read them: exclude: [...configDefaults.exclude, ...JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]'), ...(process.env.STUDIO_TEST_EXCLUDE || '').split(',').filter(Boolean)] (docs/ONBOARDING-A-GAME.md "Quarantined flaky tests")`;
}

const looksLikeTests = (g) => /(^|[^a-z])(tests?|unit|spec|vitest|jest)([^a-z]|$)/i.test(`${g.id} ${g.command}`);
const item = (id, status, detail, fix = '') => ({ id, status, detail, ...(fix ? { fix } : {}) });

/**
 * The preflight's / onboarding's items for the studio game's test checks. deps: { game, gates, perfGlobs, slowGlobs }
 * (a test's; default: read from the studio through harness/game-gates.mjs).
 */
export async function testCheckItems({ root = ROOT, env = process.env, write = false, deps = {} } = {}) {
  let game = deps.game;
  let gates = deps.gates;
  let isTest = deps.isTestCheck;
  let perfGlobs = deps.perfGlobs;
  let slowGlobs = deps.slowGlobs;
  if (!gates) {
    const gg = await import(pathToFileURL(path.join(root, 'harness', 'game-gates.mjs')).href);
    game = await gg.studioGame();
    if (!game?.root) return [];
    gates = gg.declaredGates(game);
    isTest = gg.isTestCheck;
    perfGlobs = gg.perfTestsOf(env, root);
    slowGlobs = gg.slowTierOf(game)?.globs || [];
  }
  const manifest = game?.root ? `${game.root}/studio.gates.json` : 'the game\'s studio.gates.json';
  const out = [];
  for (const g of gates || []) {
    const id = String(g.id).replace(/^game:/, '');
    const testy = (isTest ? isTest(g) : Boolean(g.focus || g.related || clearRunner(g.command))) || looksLikeTests(g);
    if (!testy) continue;
    // Item 14: a train re-check runs single test files only through a "focus" command (declared, or inferred).
    const fc = focusCommand(g, ['probe.test.ts'], { root, env });
    if (fc.cmd) out.push(item(`game-tests/focus:${id}`, 'PASS', `a train re-check runs single test files (${fc.how.replace(/ \(.*$/, '')})`));
    else out.push(item(`game-tests/focus:${id}`, 'FAIL', `the test check ${id} has no "focus" command and its command (${String(g.command).slice(0, 80)}) doesn't run vitest, jest or node --test where the harness can see it: every train re-check re-runs the whole check, and a timeout-only red "can't be run alone" stays red`, `add "focus": "<the steps before it> && npx vitest run {files}" (or npx jest {files}) to the ${id} check in ${manifest} (the owner's change: it is protected), or make its command (or its npm script's last step) run vitest or jest`));
    // Item 13: the test config drops what STUDIO_TEST_QUARANTINE (and STUDIO_TEST_EXCLUDE, when used) names.
    const vars = [['quarantine', 'STUDIO_TEST_QUARANTINE'], ...((perfGlobs?.length || slowGlobs?.length) ? [['exclude', 'STUDIO_TEST_EXCLUDE']] : [])];
    for (const [k, v] of vars) {
      const r = verifySkip({ root, gate: g, varName: v, env, write });
      const plan = r.state === 'not-honoured' ? listPlan(g, root) : null;
      if (r.state === 'honoured') out.push(item(`game-tests/${k}:${id}`, 'PASS', `its test config honours ${v} (${r.why}${r.cached ? '; cached for this config' : ''})`));
      else if (r.state === 'not-honoured') out.push(item(`game-tests/${k}:${id}`, 'FAIL', `${k === 'quarantine' ? 'quarantine' : v} NOT honoured by the game's test config (${r.config || 'its config'}): ${r.why}; ${k === 'quarantine' ? 'quarantined tests would still run and fail trains' : 'perf / slow-tier tests would still run in every verify'}`, skipFix(r.config, plan?.runner)));
      else if (r.state === 'off') out.push(item(`game-tests/${k}:${id}`, 'INFO', `not checked (${r.why})`));
      else out.push(item(`game-tests/${k}:${id}`, 'WARN', `can't tell whether its test config honours ${v}: ${r.why}`, `check by hand that ${r.config || 'its test config'} skips the files ${v} names (${skipFix(r.config).replace(/^in [^,]+, /, '')})`));
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const json = process.argv.includes('--json');
  const items = await testCheckItems({ root: ROOT, write: true });
  if (json) console.log(JSON.stringify({ items }));
  else if (!items.length) console.log('[onboard check] no studio game with test checks (or it is a cartridge): nothing to check');
  else {
    const { itemLines } = await import('./upgrade-preflight.mjs');
    for (const l of itemLines('check', items)) console.log(l.replace(/^\[upgrade check\]/, '[onboard check]'));
  }
  process.exit(items.some((i) => i.status === 'FAIL') ? 1 : 0);
}
