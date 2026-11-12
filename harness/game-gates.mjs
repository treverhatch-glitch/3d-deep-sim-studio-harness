#!/usr/bin/env node
/**
 * harness/game-gates.mjs: the gates follow the studio's game, not the bundled cartridge.
 *
 * When a game is set (`task game <name>`, studio/game.json "game", STUDIO_GAME) and it is not a cartridge, its own
 * checks run:
 *
 *   <game>/studio.gates.json   { "gates": [{ "id": "playtest", "command": "node tools/x.mjs", "required": true }] }
 *                              commands run from the repo root
 *   else, by convention:       <sim>/qa.mjs (scenarios; exit 1 fails), <sim>/playtest.mjs, <sim>/golden.mjs
 *
 * Engine gate: a task whose files are in a Godot project (a folder with project.godot) also runs Godot headless:
 * --import, then tools/gate.gd when the project has one. A non-zero exit or a SCRIPT ERROR / Parse Error / ERROR:
 * line fails it. Godot binary: STUDIO_GODOT, else godot on PATH.
 *
 *   node harness/game-gates.mjs [--paths a,b] [--changed a,b] [--json]   exit 1 when a required check fails
 *
 * No game set (or the game is a cartridge): nothing extra runs, the cartridge gates cover it.
 *
 * Manifest keys and settings:
 * - "paths" (globs) and "track" per gate, "shared" globs for the manifest. With --changed (or STUDIO_GATE_CHANGED) only
 *   gates whose paths the change touches run; skipped gates are logged with the reason. A gate without paths always
 *   runs; no --changed means every gate runs. The checks run with CI=true (test runners never write snapshots).
 * - Timeouts: "slowTests" and the load factor give STUDIO_TEST_TIMEOUT_SCALE (slowTestsOf, testTimeoutScale); a vitest,
 *   jest or node --test check also gets a per-test timeout scaled for its workers (harness/test-timeouts.mjs, row
 *   field "testTimeout"; STUDIO_TEST_TIMEOUT_SCALE=off: nothing passed). A check's timeout is scaled by load
 *   (harness/heavy.mjs scaledTimeout, loadReading); one that times out under load runs once more at the cap
 *   (STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR x the base, harness/self-triage.mjs timeoutRerun). Details at runGameGates.
 * - STUDIO_GATE_FOCUS ({ "<check>": [test files] }, a merge train's re-check; honoured only in a run-gates --only run):
 *   a failing check runs on those files only (its manifest "focus" command with {files}, else the files appended to a
 *   command that clearly runs vitest, jest or node --test, else an inferred focus (harness/train-focus.mjs inferFocus;
 *   "focus inferred: ..." once), else the whole check, saying why). Checks not in the map are skipped, and a failing
 *   check's test files are printed ("failing test files in <check>: [...]").
 * - "ratchet": true (with a section in <game>/purity-baseline.json it fails only on new hits, harness/ratchet.mjs) and
 *   "canary": "<command or fixture path>" (input that must make it fail; npm run gates -- --canaries,
 *   harness/canaries.mjs).
 * - The game:perf step. Wall-clock tests flake on a busy machine. A studio lists their globs in studio/game.json
 *   "perfTests" (["src/**\/*.perf.test.ts", ...]; the file is protected: the owner adds the key) or STUDIO_PERF_TESTS
 *   (comma list; off: none). The test checks (a "related" or "focus" command, "slowTests": true, or a command that
 *   clearly runs vitest, jest or node --test) leave them out (STUDIO_TEST_EXCLUDE) and, after the other checks, a
 *   game:perf step runs only them (STUDIO_TEST_ONLY, one test worker) once the machine is quiet (harness/flake-quiet.mjs).
 *   A landing run (a merge train's) waits up to STUDIO_PERF_WAIT_MIN (10) and holds new builder and lane verifies back
 *   (harness/heavy.mjs markQuietHold); any other verify runs it only if the machine is quiet already. Never quiet:
 *   "not run (busy)", a WARN, never red; in a train's focused re-check of game:perf it is a busy refusal. Quiet: its
 *   result counts like any required check. docs/ONBOARDING-A-GAME.md "Perf tests".
 * - The quarantine line says "skipped" only once verified (harness/test-config-check.mjs verifySkip, once per test
 *   config, cached in .studio/test-config-check.json); a config that still lists them is "WARN game:quarantine:
 *   quarantine NOT honoured by the game's test config (<file>): N quarantined tests still run". Test files outside the
 *   perf globs that assert on wall-clock time print "WARN game:test-timing" (harness/test-timing.mjs; advisory,
 *   STUDIO_TEST_TIMING=off).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgePass } from './silent-green.mjs';
import { pinMode, checkGodotVersions } from './godot-version.mjs';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { emitSampled } from './telemetry.mjs';
import { selectGates, scopeOf, withGateSlot, matchAny, ALWAYS_SHARED } from './merge-lane.mjs';
import { normMode } from './det-math.mjs';
import { testRngMode } from './test-rng.mjs';
import { scaledTimeout, recordGateTime, recordGatePass, heldClaim, heavyHolders, laneChecksRunning } from './heavy.mjs';
import { machineProfile, testWorkers, oomSignature, logicalCores } from './heavy-budget.mjs';
import { scaleTestTimeouts, timeoutLine as testTimeoutLine } from './test-timeouts.mjs';
import { timeoutRerun } from './self-triage.mjs';
import { readFocus, focusCommand, failingTestFiles, inferFocus } from './train-focus.mjs';
import { quarantineEnvValue } from './flakes.mjs';
import { gateEnv, applyGateEnv } from './gate-env.mjs';
import { clearRunner } from './train-focus.mjs';
import { verifySkip, listPlan, skipFix } from './test-config-check.mjs';
import { readJson } from './fsafe.mjs';

const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));

/** Files Godot writes on import or in the editor; they never block a task or a merge. */
export const isEngineChurn = (f) => /(^|\/)\.godot\//.test(f) || /\.import$/.test(f) || /\.(uid|tmp)$/.test(f) || /(^|\/)\.import\//.test(f);

/** The studio's game when it is not a cartridge: { name, root, sim } or null. */
export async function studioGame() {
  const { activeGame } = await import('./cartridge.mjs');
  const g = activeGame();
  if (!g.name || !['STUDIO_GAME', 'studio/game.json game'].includes(g.from)) return null;
  if (exists(`cartridges/${g.name}/index.mjs`)) return null; // a cartridge: the cartridge gates already check it
  const root = [`game/${g.name}`, `web/${g.name}`].find(exists);
  if (!root) return { name: g.name, root: null, sim: null };
  return { name: g.name, root, sim: exists(`${root}/sim`) ? `${root}/sim` : null };
}

/** The checks the game declares (manifest first, then conventional files). */
export function declaredGates(game) {
  if (!game?.root) return [];
  const man = path.join(REPO_ROOT, game.root, 'studio.gates.json');
  if (fs.existsSync(man)) {
    const j = JSON.parse(fs.readFileSync(man, 'utf8'));
    const list = (j.gates || []).filter((x) => x && x.id && x.command).map((x) => ({ id: `game:${x.id}`, command: x.command, required: x.required !== false, ...(Array.isArray(x.paths) && x.paths.length ? { paths: x.paths.map(String) } : {}), ...(x.track ? { track: String(x.track) } : {}), ...(typeof x.related === 'string' && x.related.includes('{files}') ? { related: x.related } : {}), ...(typeof x.focus === 'string' && x.focus.includes('{files}') ? { focus: x.focus } : {}), ...(x.tier === 'slow' ? { tier: 'slow' } : {}), ...(x.slowTests === true ? { slowTests: true } : {}), ...(x.ratchet === true ? { ratchet: true } : {}), ...(typeof x.canary === 'string' && x.canary.trim() ? { canary: x.canary.trim() } : {}) }));
    // A manifest with "detMath" (warn or required) gets the deterministic-math check on its sim paths; the cartridge
    // purity gate is skipped for such a game, so this is where it runs. Required fails.
    if (j.detMath !== undefined && !list.some((x) => /check-sim-purity/.test(x.command))) {
      const { mode } = normMode(j.detMath && typeof j.detMath === 'object' ? j.detMath.mode : j.detMath);
      if (mode !== 'off') list.push({ id: 'game:det-math', command: 'node scripts/check-sim-purity.mjs --det-math-only', required: mode === 'required' });
    }
    // "testRandomness" adds the test-randomness check (harness/test-rng.mjs): a seeded game on the shared Math.random,
    // or an unseeded game, in a test file. Advisory (WARN) unless "mode": "required" or STUDIO_TEST_RNG=required.
    if (j.testRandomness && typeof j.testRandomness === 'object' && !list.some((x) => x.id === 'game:test-rng')) {
      const mode = testRngMode(j.testRandomness);
      if (mode !== 'off') list.push({ id: 'game:test-rng', command: 'node harness/test-rng.mjs', required: mode === 'required' });
    }
    // "stateProbe" adds the state probe (harness/state-probe.mjs): the sim's digests at the declared ticks, compared
    // with main's; a change with no Golden-Reason is red with the first differing tick.
    if (j.stateProbe && typeof j.stateProbe === 'object' && !list.some((x) => x.id === 'game:state-probe')) {
      list.push({ id: 'game:state-probe', command: 'node harness/state-probe.mjs', required: true });
    }
    return list;
  }
  const out = [];
  if (game.sim) {
    for (const [id, f] of [['qa', 'qa.mjs'], ['playtest', 'playtest.mjs'], ['golden', 'golden.mjs']]) {
      if (exists(`${game.sim}/${f}`)) out.push({ id: `game:${id}`, command: `node ${game.sim}/${f}`, required: true });
    }
  }
  return out;
}

/**
 * The manifest's slow seeded tests, { pattern, minScale } or null: "slowTests": { "pattern": "<file glob or test-name
 * pattern>", "timeoutScale": true, "minScale": <n, optional> }. "timeoutScale": false turns it off.
 */
export function slowTestsOf(game) {
  if (!game?.root) return null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')).slowTests;
    if (!st || typeof st !== 'object' || Array.isArray(st) || st.timeoutScale === false) return null; // an array is the slow tier
    const min = Number(st.minScale);
    return { pattern: String(st.pattern || ''), minScale: Number.isFinite(min) && min > 1 ? min : 1 };
  } catch {
    return null;
  }
}

/**
 * The game's slow tier, or null. The manifest marks test globs slow ("slowTests": ["<glob>", ...], e.g. a soak-test
 * file glob; the object form, { "pattern", "timeoutScale" }, only scales timeouts unless it also says "tier": "slow")
 * and/or whole checks ("tier": "slow" on a gate). Verifies and trains skip them (STUDIO_TEST_EXCLUDE for the game's
 * test config); the nightly slow tier (npm run gates -- --tier slow, harness/slow-tier.mjs) runs only them, on main.
 * The manifest is protected, so only the owner moves a test out of landing. STUDIO_SLOW_TIER=off runs everything in
 * every verify.
 */
export function slowTierOf(game) {
  if (!game?.root) return null;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')); } catch { return null; }
  const st = j?.slowTests;
  const globs = Array.isArray(st) ? st.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : st && typeof st === 'object' && st.tier === 'slow' && String(st.pattern || '').trim() ? [String(st.pattern).trim()] : [];
  const gates = (Array.isArray(j?.gates) ? j.gates : []).filter((x) => x && x.id && x.command && x.tier === 'slow').map((x) => `game:${x.id}`);
  return globs.length || gates.length ? { globs, gates } : null;
}
/** This run is the slow tier (STUDIO_GATE_TIER=slow, set by harness/slow-tier.mjs). */
export const slowTierRun = (env = process.env) => /^slow$/i.test(String(env.STUDIO_GATE_TIER || ''));
/** STUDIO_SLOW_TIER=off: no slow tier, every check and test runs in every verify. */
export const slowTierOff = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_SLOW_TIER || ''));

/**
 * The perf test globs: STUDIO_PERF_TESTS (comma list; off: none), else studio/game.json "perfTests" (a list of globs,
 * or one comma-separated string). [] when neither.
 */
export function perfTestsOf(env = process.env, root = REPO_ROOT) {
  const split = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
  if (env.STUDIO_PERF_TESTS !== undefined && String(env.STUDIO_PERF_TESTS).trim() !== '') return /^(off|0|false|no)$/i.test(String(env.STUDIO_PERF_TESTS).trim()) ? [] : split(env.STUDIO_PERF_TESTS);
  try {
    const v = readJson(path.join(root, 'studio', 'game.json'), {}).perfTests;
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').flatMap(split);
    if (typeof v === 'string') return split(v);
  } catch {}
  return [];
}
/** Minutes a landing run's game:perf step waits for a quiet machine (STUDIO_PERF_WAIT_MIN, default 10). */
export function perfWaitMin(env = process.env) {
  const v = String(env.STUDIO_PERF_WAIT_MIN ?? '').trim();
  return v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 10;
}
/** A check that runs the game's tests (it gets STUDIO_TEST_EXCLUDE / STUDIO_TEST_ONLY): also an npm script whose last step runs vitest or jest (inferFocus). */
export const isTestCheck = (g) => Boolean(g && (g.related || g.focus || g.slowTests || clearRunner(g.command) || inferFocus(g.command, { root: REPO_ROOT }).focus));

/** "focus inferred: …", printed once per check per run (a focused re-check, a timeout-only re-run). */
const inferredSaid = new Set();
export function focusFor(g, files, log = (m) => console.error(m)) {
  const fc = focusCommand(g, files, { root: REPO_ROOT });
  if (fc.inferred && !inferredSaid.has(g.id)) { inferredSaid.add(g.id); log(`[game-gates] ${g.id}: focus inferred: ${fc.inferred} (its command runs an npm script that runs vitest or jest; the manifest has no "focus"; STUDIO_FOCUS_INFER=off: none)`); }
  return fc;
}

/**
 * The per-test timeout factor a game's test command gets: the gate's load factor, at least the manifest's minScale
 * and any STUDIO_TEST_TIMEOUT_SCALE already set, never below 1 (a timeout is never lowered).
 */
export function testTimeoutScale(gateFactor, slow, env = process.env) {
  const given = Number(env.STUDIO_TEST_TIMEOUT_SCALE);
  return Math.round(Math.max(1, Number(gateFactor) || 1, slow?.minScale || 1, Number.isFinite(given) ? given : 1) * 10) / 10;
}

/** The manifest's shared globs (a change there runs every gate), plus the manifest itself. */
export function sharedPaths(game) {
  if (!game?.root) return [];
  const out = [`${game.root}/studio.gates.json`];
  const man = path.join(REPO_ROOT, game.root, 'studio.gates.json');
  try { const j = JSON.parse(fs.readFileSync(man, 'utf8')); if (Array.isArray(j.shared)) out.push(...j.shared.map(String)); } catch {}
  return out;
}

/** Godot projects that hold any of these paths (nearest folder with project.godot). */
export function godotProjects(paths = []) {
  const found = new Set();
  for (const p of paths) {
    let d = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
    while (d && d !== '.') {
      if (fs.existsSync(path.join(REPO_ROOT, d, 'project.godot'))) { found.add(d); break; }
      const up = path.posix.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return [...found].sort();
}

const ERR = /SCRIPT ERROR|Parse Error|^\s*ERROR:|Failed to load script|Failed loading resource/m;
export const godotBin = () => process.env.STUDIO_GODOT || 'godot';

export function engineGates(paths) {
  return godotProjects(paths).map((p) => ({ id: `engine:${p}`, project: p, required: true }));
}

function runGodot(project) {
  const bin = godotBin();
  // The binary, the project, the export templates and gdUnit4 must agree on the version (harness/godot-version.mjs).
  // Notes by default; STUDIO_GODOT_PIN=fail makes a mismatch fail the gate.
  let notes = [];
  if (pinMode() !== 'off') {
    const v = checkGodotVersions(project, { bin });
    notes = v.problems.map((p) => `Godot version: ${p}`);
    if (pinMode() === 'fail' && v.problems.length) return { ok: false, why: notes.join('; '), notes: [] };
  }
  // tools/gate.gd presses every control in tools/controls.gd and writes one result per id here, for the controls
  // check (qa/controls-check.mjs).
  const reports = path.join(REPO_ROOT, 'qa', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  const env = { ...gateEnv(), STUDIO_CONTROLS_OUT: path.join(reports, `controls-godot-${project.replace(/[^\w.-]+/g, '_')}.json`) };
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', env, timeout: Number(process.env.STUDIO_GODOT_TIMEOUT_MS || 300000), maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) };
  const steps = [['--headless', '--path', project, '--import']];
  if (fs.existsSync(path.join(REPO_ROOT, project, 'tools', 'gate.gd'))) steps.push(['--headless', '--path', project, '--script', 'res://tools/gate.gd']);
  for (const args of steps) {
    const r = spawnSync(opts.shell ? `"${bin}"` : bin, args, { windowsHide: true, ...opts });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (r.error) return { ok: false, why: `could not run Godot (${bin}): ${r.error.code || r.error.message}`, notes };
    const bad = text.split('\n').find((l) => ERR.test(l));
    if (r.status !== 0 || bad) return { ok: false, why: `${args.includes('--import') ? 'import' : 'gate.gd'} ${r.status !== 0 ? `exited ${r.status}` : 'printed an error'}${bad ? `: ${bad.trim().slice(0, 200)}` : ''}`, notes };
  }
  return { ok: true, why: '', notes };
}

/**
 * Which of the game's checks a change runs, and the scope a pass covers, without running anything:
 * { game, all, shared, gates, skipped, scope, layout, layoutPaths, engine, why }. runGameGates runs this plan; task
 * done uses it to record the right scope when a verify stands in for the checks.
 *
 * incoming (the landing re-check after a rebase onto a moved main, STUDIO_GATE_INCOMING_FILE): the files main brought
 * in. The lane's own pass on its pre-rebase commit stands for a check whose declared inputs ("paths", layoutPaths, a
 * Godot project's folder) none of them touch; such a check is skipped with that reason. A check with no declared
 * paths, or any incoming file that is shared (harness/, scripts/, the manifest, its "shared" globs), runs again.
 */
export async function planGameGates({ paths = [], changed = null, incoming = null } = {}) {
  const game = await studioGame();
  const all = game ? declaredGates(game) : [];
  const shared = game ? sharedPaths(game) : [];
  const sel = game ? selectGates(all, changed, { shared }) : { run: [], skipped: [], why: '' };
  let gates = sel.run;
  const skipped = [...sel.skipped];
  let scope = game && all.length ? scopeOf(gates, shared) : null;
  // The game's layout rules (studio.layout.json), when it declares them; unscoped unless the manifest names its
  // inputs ("layoutPaths").
  const layout = Boolean(game?.root && fs.existsSync(path.join(REPO_ROOT, game.root, 'studio.layout.json')) && process.env.STUDIO_LAYOUT_GATE !== 'off');
  let layoutPaths = null;
  if (layout) {
    try { const lp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')).layoutPaths; layoutPaths = Array.isArray(lp) && lp.length ? lp.map(String) : null; } catch {}
    scope = scope && layoutPaths ? [...scope, ...layoutPaths] : null;
  }
  let engine = engineGates(paths);
  if (scope) scope = [...new Set([...scope, ...engine.map((e) => `${e.project}/**`)])];
  let runLayout = layout;
  if (Array.isArray(incoming)) {
    const files = incoming.map((f) => String(f).replace(/\\/g, '/')).filter(Boolean);
    const hitShared = files.find((f) => matchAny(f, [...ALWAYS_SHARED, ...shared]));
    const untouched = (globs) => !hitShared && !files.some((f) => matchAny(f, globs));
    const why = `none of the ${files.length} file(s) the rebase brought in are among its inputs; it passed on this lane's commit before the rebase`;
    const keep = [];
    for (const g of gates) {
      if (g.paths?.length && untouched(g.paths)) skipped.push({ id: g.id, why });
      else keep.push(g);
    }
    gates = keep;
    if (layout && layoutPaths && untouched(layoutPaths)) { runLayout = false; skipped.push({ id: 'game:layout', why }); }
    const keepEngine = [];
    for (const e of engine) {
      if (untouched([`${e.project}/**`])) skipped.push({ id: e.id, why });
      else keepEngine.push(e);
    }
    engine = keepEngine;
  }
  // Run by the verify for the tracks it covers (STUDIO_GATE_TRACKS, harness/gate-tracks.mjs): a game check on
  // another track (a manifest check is web unless its "track" says otherwise), the layout rules (web) and a Godot
  // project's gate (engine:godot) are skipped with that reason. Unset (task done, the train's re-checks): all of them.
  {
    const gt = await import('./gate-tracks.mjs');
    const cov = gt.coveredFromEnv();
    if (cov !== '*') {
      const why = (t) => `${t.join('+')} track; this change covers ${[...cov].join(', ')} only`;
      const keep = [];
      for (const g of gates) { const t = gt.gateTrack(g).tracks; if (gt.runsFor(t, cov)) keep.push(g); else skipped.push({ id: g.id, why: why(t) }); }
      gates = keep;
      if (runLayout && !gt.runsFor(['web'], cov)) { runLayout = false; skipped.push({ id: 'game:layout', why: why(['web']) }); }
      const keepEngine = [];
      for (const e of engine) { if (gt.runsFor(['engine:godot'], cov)) keepEngine.push(e); else skipped.push({ id: e.id, why: why(['engine:godot']) }); }
      engine = keepEngine;
    }
  }
  // The slow tier. A verify (and a train) skips the slow checks; the slow tier runs only them, plus the test
  // checks (a "related" or "focus" command, or "slowTests": true) with only the slow test globs (STUDIO_TEST_ONLY).
  const tierInfo = game && !slowTierOff() ? slowTierOf(game) : null;
  let slowTier = null;
  if (tierInfo) {
    const slowRun = slowTierRun();
    const testGate = (g) => Boolean(g.related || g.focus || g.slowTests);
    const keep = [];
    for (const g of gates) {
      if (slowRun ? g.tier === 'slow' || (tierInfo.globs.length && testGate(g)) : g.tier !== 'slow') keep.push(g);
      else skipped.push({ id: g.id, why: slowRun ? 'not in the slow tier (it runs in every verify)' : 'slow tier: it runs nightly on main (npm run gates -- --tier slow); landing never waits for it' });
    }
    gates = keep;
    slowTier = { run: slowRun, globs: tierInfo.globs };
    if (slowRun) { runLayout = false; engine = []; }
  }
  let perf = null;
  if (game && !slowTierRun()) {
    const globs = perfTestsOf();
    if (globs.length) {
      perf = { globs, gates: gates.filter((g) => g.tier !== 'slow' && isTestCheck(g)) };
      if (!perf.gates.length && all.some((g) => g.tier !== 'slow' && isTestCheck(g))) { skipped.push({ id: 'game:perf', why: 'none of the checks that run the perf tests is selected for this change' }); perf = null; }
    }
  }
  return { game, all, shared, gates, skipped, scope, layout: runLayout, layoutPaths, engine, why: sel.why || '', slowTier, perf };
}

/** The slow-tier env one game check runs with: STUDIO_TEST_EXCLUDE in a verify, STUDIO_TEST_ONLY in the slow tier. */
export function slowTierEnv(slowTier, gate, env = process.env) {
  if (!slowTier?.globs?.length || gate?.tier === 'slow') return {};
  if (slowTier.run) return { STUDIO_TEST_ONLY: slowTier.globs.join(',') };
  const mine = String(env.STUDIO_TEST_EXCLUDE || '').split(',').map((x) => x.trim()).filter(Boolean);
  return { STUDIO_TEST_EXCLUDE: [...new Set([...mine, ...slowTier.globs])].join(',') };
}

/** Related tests only (STUDIO_GATE_RELATED=on, or STUDIO_WHOLE_GAME=on). */
export const relatedTestsOn = (env = process.env) => /^(on|1|true|yes)$/i.test(env.STUDIO_GATE_RELATED || '') || /^(on|1|true|yes)$/i.test(env.STUDIO_WHOLE_GAME || '');

/** The files a landing re-check was told main brought in (STUDIO_GATE_INCOMING_FILE), or null (unknown: no filter). */
export function readIncoming(env = process.env) {
  const f = env.STUDIO_GATE_INCOMING_FILE;
  if (!f) return null;
  try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(j.incoming) ? j.incoming.map(String) : null; } catch { return null; }
}

/**
 * One line with the load probe's reading for a check, printed every time: "[game-gates] <check>: load factor F
 * (<reasons> | nothing scaling it); <CPU reading>; quiet-run floor: <...>[; timeout N s, not scaled]". It never reads
 * "timeout <n> s (": that is the scaled-timeout line, printed after it when the timeout isn't the base.
 */
export function loadReading(label, t, base) {
  const sec = (ms) => Math.round(Number(ms) / 1000);
  const parts = [];
  if (t.scaleOff) parts.push('load factor not measured (STUDIO_GAME_GATE_TIMEOUT_SCALE=off)');
  else {
    parts.push(`load factor ${t.factor} (${t.why || 'nothing scaling it'})`);
    if (Number.isFinite(t.busy)) parts.push(`CPU ${Math.round(t.busy * 100)}% busy (STUDIO_CPU_BUSY_THRESHOLD ${Math.round((t.busyThreshold ?? 0.6) * 100)}%)`);
    else if (Number.isFinite(t.load)) parts.push(`no CPU sample (the load average ${t.load.toFixed(1)} on ${t.cores} core${t.cores === 1 ? '' : 's'} is used)`);
    else parts.push('no CPU sample (STUDIO_CPU_PROBE=off, or it could not be read)');
  }
  if (t.scaleOff) parts.push('quiet-run floor: not used');
  else if (t.label === null || t.label === undefined) parts.push('quiet-run floor: not used for a related-tests run');
  else if (!(t.floorMult > 0)) parts.push('quiet-run floor: off (STUDIO_GAME_GATE_TIMEOUT_FLOOR)');
  else if (t.quiet) parts.push(`quiet-run floor: recorded (last quiet run ${sec(t.quiet.ms)} s${t.quiet.at ? `, ${String(t.quiet.at).slice(0, 16).replace('T', ' ')} UTC` : ''}; floor ${sec(t.floorMs)} s)`);
  else if (t.lastPass) parts.push(`quiet-run floor: none recorded yet; the last passing run, ${sec(t.lastPass.ms)} s at load factor ${t.lastPass.factor}, stands in (floor ${sec(t.floorMs)} s)`);
  else parts.push('quiet-run floor: none recorded yet');
  if (Number(t.ms) === Number(base)) parts.push(`timeout ${sec(base)} s, not scaled`);
  return `[game-gates] ${label}: ${parts.join('; ')}`;
}

/**
 * The timeout-only re-run of one failed check (harness/timeout-rerun.mjs). Returns null (not timeout-only,
 * switched off, too many files, no way to run one file) or { green: [files], red: [files], allGreen }. Each file runs
 * once, alone, through the check's focus command, with one test worker; a pass that ran no test isn't green.
 */
export async function timeoutOnlyRerun({ g, r, runOnce, log = () => {}, root = REPO_ROOT, setRelated = () => {}, env = process.env }) {
  const tr = await import('./timeout-rerun.mjs');
  if (!tr.timeoutRerunOn(env)) return null;
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const t0 = tr.timeoutOnly(text);
  if (!t0.ok) { if (t0.blocks.some((b) => b.timeout)) log(`[game-gates] ${g.id}: not re-run for timeouts: ${t0.why}`); return null; }
  const { repoRel } = await import('./gate-subids.mjs');
  const t = { ...t0, files: [...new Set(t0.files.map((f) => repoRel(f, [REPO_ROOT])))] };
  const { flakeRules, recordTimeoutFlakes } = await import('./flakes.mjs');
  const max = flakeRules(env).maxFiles;
  if (t.files.length > max) { log(`[game-gates] ${g.id}: timeout-only red in ${t.files.length} files, more than STUDIO_FLAKE_MAX_FILES (${max}): not re-run, it stays red`); return null; }
  const plans = t.files.map((f) => ({ f, fc: focusFor(g, [f], log) }));
  const cant = plans.find((p) => !p.fc.cmd);
  if (cant) { log(`[game-gates] ${g.id}: timeout-only red, but ${cant.f} can't be run alone (${cant.fc.why}): it stays red`); return null; }
  log(`[game-gates] ${g.id}: timeout-only red (${t.why}): re-running ${t.files.length} file(s), each alone at low load (one test worker; STUDIO_TIMEOUT_RERUN=off: no re-run)`);
  const green = [];
  const red = [];
  setRelated(true); // a single-file run is never the check's quiet-run time
  for (const { f, fc } of plans) {
    const x = await runOnce(fc.cmd, null, { STUDIO_TEST_WORKERS: '1', VITEST_MAX_WORKERS: '1', STUDIO_TIMEOUT_RERUN: 'off' });
    const out = `${x.stdout || ''}${x.stderr || ''}`;
    const ok = x.status === 0 && !judgePass(g.id, { output: out, env: { ...env, STUDIO_SILENT_GREEN: 'warn' } }).note;
    (ok ? green : red).push(f);
    log(`[game-gates] ${g.id}: ${f} alone at low load: ${ok ? 'green (timeout-flake)' : `red (${x.status === 0 ? 'passed having run no test' : `exit ${x.status ?? x.signal ?? '?'}`})`}`);
  }
  if (green.length) recordTimeoutFlakes(root, { check: g.id, files: green, text, env, log }); // text: a port collision there is named
  if (red.length) log(`[game-gates] ${g.id}: ${red.length} timed-out file(s) red alone too: a real red (${red.join(', ')})`);
  else log(`[game-gates] ${g.id}: every timed-out file passed alone: counted green for those files only (the rest of the check had passed)`);
  return { green, red, allGreen: !red.length };
}

/** The manifest's "divergence" ({ command, gate?, state?, goldens? }) or null. */
export function divergenceConfOf(game) {
  if (!game?.root) return null;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, game.root, 'studio.gates.json'), 'utf8')).divergence;
    return d && typeof d === 'object' && !Array.isArray(d) && typeof d.command === 'string' && d.command.trim() ? d : null;
  } catch { return null; }
}

/** Run the game's divergence contract for a failed check it applies to, printing its two lines. Never throws. */
async function divergenceForCheck(game, g, log) {
  try {
    const conf = divergenceConfOf(game);
    if (!conf) return null;
    const applies = conf.gate ? [String(conf.gate), `game:${conf.gate}`].includes(g.id) : /golden/i.test(g.id);
    const dv = await import('./divergence.mjs');
    if (!applies || !dv.divergenceOn()) return null;
    const res = await dv.gameDivergence({ root: REPO_ROOT, game, conf, gate: g.id });
    for (const l of dv.divergenceLines('[game-gates]', { ...res, gate: g.id })) log(l);
    // The signed report a re-record of the declared goldens carries (harness/golden-report.mjs).
    if (Array.isArray(conf.goldens) && conf.goldens.length) (await import('./golden-report.mjs')).writeGoldenReport(REPO_ROOT, conf.goldens.map(String), res, { by: 'harness/game-gates.mjs', gate: g.id });
    return res;
  } catch (e) { log(`[game-gates] first divergence: not found (${String(e.message || e).slice(0, 160)})`); return null; }
}

/** Run the game's checks and the engine gate for these paths. */
export async function runGameGates({ paths = [], changed = null, incoming = null, quiet = false } = {}) {
  const plan = await planGameGates({ paths, changed, incoming });
  const { game, all, gates, scope } = plan;
  const rows = [];
  const skipped = [...plan.skipped];
  const log = (s) => !quiet && console.log(s);
  // Heavy checks take a box-wide gate slot (shared by every lane copy through the main checkout).
  let slotRoot = REPO_ROOT;
  try { slotRoot = (await import('./worktree.mjs')).mainRoot(); } catch {}
  const slot = (label, fn) => withGateSlot(slotRoot, label, fn, { log: (m) => console.error(m) });
  // In a sparse lane, put back every left-out file the checks about to run read (harness/lane-sparse.mjs).
  if (game?.root) {
    try {
      const ls = await import('./lane-sparse.mjs');
      ls.widenForChecks({ dir: REPO_ROOT, label: '[game-gates]', log: (m) => console.error(m), needs: ls.gameCheckNeeds({ root: REPO_ROOT, gameRoot: game.root, ids: gates.map((g) => g.id), engineProjects: (plan.engine || []).map((e) => e.project).filter(Boolean), layout: plan.layout, layoutPaths: plan.layoutPaths }) });
    } catch (err) { console.error(`[game-gates] WARN sparse lane check: ${err.message}`); }
  }
  if (game) {
    if (plan.why) log(`[game-gates] ${plan.why}`);
    if (!all.length) rows.push({ id: 'game:none', ok: false, required: true, why: `the game ${game.name} declares no checks: add ${game.root || `web/${game.name}`}/studio.gates.json or ${game.sim || '<game>/sim'}/qa.mjs` });
    // Related tests only. A gate may declare `related` (a command with {files}, such as "cd game/x && npx vitest
    // related --run --passWithNoTests {files}"): when the change is known and is only code files under the game, that
    // runs instead of the whole suite; only when the whole suite still runs after landing (STUDIO_WHOLE_GAME=on) or
    // STUDIO_GATE_RELATED=on says so.
    const relatedOn = relatedTestsOn();
    const prefix = `${game.root}/`;
    const changedHere = (changed || []).map((f) => String(f).replace(/\\/g, '/')).filter((f) => f.startsWith(prefix));
    const codeOnly = changedHere.length && changedHere.every((f) => /\.(m?[jt]sx?|cjs|vue|svelte)$/i.test(f)) && !/ is shared/.test(plan.why || '');
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    let cmdLabel = '';
    // The game's checks run with CI=true, so test runners never write or rewrite snapshots during a verify (updating
    // is a deliberate run with -u). STUDIO_GAME_GATE_CI=off leaves CI as it is. Code-loading NODE_OPTIONS, git
    // redirects and replace refs are dropped (harness/gate-env.mjs).
    const env = gateEnv(/^(off|0|false|no)$/i.test(process.env.STUDIO_GAME_GATE_CI || '') ? process.env : { ...process.env, CI: 'true' });
    // The timeout is scaled for load, judged once the check has its slot (harness/heavy.mjs scaledTimeout): other heavy
    // work, other game checks, a high load average. Never below STUDIO_GAME_GATE_TIMEOUT_MS (600 s), at most
    // STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR (3) times it; the value used is printed and kept in the check's row, so a
    // real hang still fails, just later. The slow tier's base is STUDIO_SLOW_TIMEOUT_MS (60 min).
    const baseTimeout = plan.slowTier?.run ? Number(process.env.STUDIO_SLOW_TIMEOUT_MS || 3600000) : Number(process.env.STUDIO_GAME_GATE_TIMEOUT_MS || 600000);
    let timing = { ms: baseTimeout, base: baseTimeout, factor: 1, why: '' };
    // Slow seeded tests ("slowTests"): the game's checks get the gate's load factor in STUDIO_TEST_TIMEOUT_SCALE (and
    // the pattern in STUDIO_SLOW_TESTS) for its test config to multiply its timeouts by (docs/ONBOARDING-A-GAME.md,
    // "Slow tests"). Never below 1; printed for every check.
    const slow = slowTestsOf(game);
    let testScale = 1;
    // The timeout is also never below 1.5 x the check's last quiet run (heavy.mjs lastQuietTime), kept per game and
    // check in the main checkout's .studio/gates/game-gate-times.json from passing whole-suite runs at load factor 1;
    // the line names why whenever the timeout differs from the base.
    let curRelated = false;
    let curGate = null;
    let curPerf = null;
    const timeKey = () => `${game.name}:${cmdLabel}`;
    const timingWhy = (t) => [t.factor > 1 ? `${Math.round(baseTimeout / 1000)} s x ${t.factor}: ${t.why}` : '', t.floor ? t.floor.why : '', t.rerun && !(t.factor > 1) && !t.floor ? 'self-triage\'s one re-run at the cap' : ''].filter(Boolean).join('; ');
    const workersNow = () => {
      let profile = null;
      try { profile = machineProfile(slotRoot); } catch {}
      try {
        return { ...testWorkers({ profile, env: process.env, holdClaim: heldClaim(slotRoot), holders: heavyHolders(slotRoot), laneChecks: laneChecksRunning(slotRoot), root: REPO_ROOT, trainRoot: slotRoot, self: plan.slowTier?.run ? 'soak' : 'check' }), cores: logicalCores(profile) };
      } catch (err) { return { workers: 2, why: `couldn't size them (${String(err.message || err).slice(0, 80)}): 2`, cores: logicalCores(profile) }; }
    };
    let testTO = null;
    let twRow = null;
    const qVerdict = new Map();
    const quarantineState = (g, files) => {
      if (!g) return { state: 'unknown', why: 'not a check of the game', still: [] };
      if (!qVerdict.has(g.id)) {
        let v = { state: 'unknown', why: 'not a test check', still: [] };
        if (isTestCheck(g)) { try { v = verifySkip({ root: REPO_ROOT, cacheRoot: slotRoot, gate: g, varName: 'STUDIO_TEST_QUARANTINE', files }); v.runner = listPlan(g, REPO_ROOT).runner || null; } catch (err) { v = { state: 'unknown', why: String(err.message || err).slice(0, 160), still: [] }; } }
        qVerdict.set(g.id, { ...v, files: files.length });
      }
      return qVerdict.get(g.id);
    };
    const runOnce = (cmd, forceMs = null, extraEnv = null) => slot(cmdLabel, () => {
      timing = scaledTimeout(baseTimeout, slotRoot, { label: curRelated || plan.slowTier?.run ? null : timeKey() });
      if (forceMs) timing = { ...timing, ms: Math.max(timing.ms, forceMs), rerun: true };
      const changedT = timing.ms !== baseTimeout;
      console.error(loadReading(cmdLabel, timing, baseTimeout));
      if (changedT) console.error(`[game-gates] ${cmdLabel}: timeout ${Math.round(timing.ms / 1000)} s (${timingWhy(timing)}; STUDIO_GAME_GATE_TIMEOUT_SCALE=off keeps ${Math.round(baseTimeout / 1000)} s)`);
      if (changedT) emitSampled({ type: 'gate.timeout_scaled', agent: process.env.STUDIO_LOCK_OWNER || 'gates', msg: `${cmdLabel}: timeout ${Math.round(timing.ms / 1000)} s (${timingWhy(timing)})`.slice(0, 400), meta: { gate: cmdLabel, timeoutMs: timing.ms, baseMs: baseTimeout, factor: timing.factor, ...(timing.floor ? { floorFromMs: timing.floor.lastMs } : {}) } }, cmdLabel);
      let runEnv = env;
      if (slow) {
        testScale = testTimeoutScale(timing.factor, slow, env);
        runEnv = { ...env, STUDIO_TEST_TIMEOUT_SCALE: String(testScale), STUDIO_SLOW_TESTS: slow.pattern };
        console.error(`[game-gates] ${cmdLabel}: slow tests${slow.pattern ? ` (${slow.pattern})` : ''}: per-test timeouts x${testScale} (STUDIO_TEST_TIMEOUT_SCALE=${testScale}; the gate's load factor ${timing.factor}${slow.minScale > 1 ? `, minScale ${slow.minScale}` : ''})`);
      }
      // Test workers sized to the machine (harness/heavy-budget.mjs testWorkers), always passed (CI=true
      // stays for snapshots): STUDIO_TEST_WORKERS and VITEST_MAX_WORKERS for the game's test config to read.
      const tw = workersNow();
      twRow = { workers: tw.workers, why: String(tw.why || '').slice(0, 400), ...(tw.share ? { share: tw.share } : {}), ...(Number(tw.machineWorkers) > 0 ? { machineWorkers: tw.machineWorkers } : {}) };
      runEnv = { ...runEnv, STUDIO_TEST_WORKERS: String(tw.workers), VITEST_MAX_WORKERS: String(tw.workers) };
      if (extraEnv) runEnv = { ...runEnv, ...extraEnv };
      const ste = slowTierEnv(plan.slowTier, curGate);
      if (Object.keys(ste).length) { runEnv = { ...runEnv, ...ste }; console.error(`[game-gates] ${cmdLabel}: slow tier: ${ste.STUDIO_TEST_ONLY ? `only ${ste.STUDIO_TEST_ONLY} (STUDIO_TEST_ONLY)` : `skips ${plan.slowTier.globs.join(', ')} (STUDIO_TEST_EXCLUDE; they run nightly on main)`}`); }
      if (plan.perf) {
        if (curPerf) { runEnv = { ...runEnv, STUDIO_TEST_ONLY: curPerf.join(',') }; console.error(`[game-gates] ${cmdLabel}: game:perf: only ${curPerf.join(', ')} (STUDIO_TEST_ONLY)`); }
        else {
          const mine = String(runEnv.STUDIO_TEST_EXCLUDE || '').split(',').map((x) => x.trim()).filter(Boolean);
          runEnv = { ...runEnv, STUDIO_TEST_EXCLUDE: [...new Set([...mine, ...plan.perf.globs])].join(',') };
          console.error(`[game-gates] ${cmdLabel}: skips the perf tests ${plan.perf.globs.join(', ')} (STUDIO_TEST_EXCLUDE; they run alone in game:perf)`);
        }
      }
      // The quarantine list (studio/quarantine.json, harness/flakes.mjs) as STUDIO_TEST_QUARANTINE, a JSON
      // list of test files for the game's runner to skip; unset when nothing is quarantined.
      // "skipped" only once verified: the runner's list mode drops them with the variable set
      // (harness/test-config-check.mjs verifySkip, once per test config); a config that ignores it is a WARN, and those
      // tests are not counted as skipped (the row's "quarantine").
      // A quarantined file this lane changed is not skipped in its run (the fix is proven in its own lane).
      const qAll = quarantineEnvValue(REPO_ROOT) ? JSON.parse(quarantineEnvValue(REPO_ROOT)) : [];
      const qFiles = qAll.filter((t) => {
        const hit = changedHere.some((c) => c === t || c.endsWith(`/${t}`));
        if (hit) console.error(`[game-gates] ${cmdLabel}: running ${t}: this lane changes it (quarantined)`);
        return !hit;
      });
      const quarantined = qFiles.length ? JSON.stringify(qFiles) : '';
      if (quarantined) {
        runEnv = { ...runEnv, STUDIO_TEST_QUARANTINE: quarantined };
        const qs = quarantineState(curGate, qFiles);
        const n = qFiles.length;
        if (qs.state === 'honoured') console.error(`[game-gates] ${cmdLabel}: ${n} quarantined test file(s) skipped by the game's runner (STUDIO_TEST_QUARANTINE; verified: ${qs.why}${qs.cached ? ', cached for this test config' : ''}; npm run flakes)`);
        else if (qs.state === 'not-honoured') { if (!qs.said) { qs.said = true; log(`[game-gates] WARN game:quarantine: quarantine NOT honoured by the game's test config (${qs.config || 'its config'}): ${qs.still.length || n} quarantined tests still run (${(qs.still.length ? qs.still : qFiles).slice(0, 4).join(', ')}); fix: ${skipFix(qs.config, qs.runner)}`); } }
        else console.error(`[game-gates] ${cmdLabel}: ${n} quarantined test file(s) passed to the game's runner in STUDIO_TEST_QUARANTINE (not verified that its test config skips them: ${qs.why || 'not a test check'})`);
      } else { const { STUDIO_TEST_QUARANTINE: _q, ...rest } = runEnv; runEnv = rest; }
      console.error(`[game-gates] ${cmdLabel}: ${extraEnv?.STUDIO_TEST_WORKERS || tw.workers} test workers (STUDIO_TEST_WORKERS, VITEST_MAX_WORKERS: ${extraEnv?.STUDIO_TEST_WORKERS ? 'low load for the timeout-only re-run' : tw.why})`);
      const scaled = scaleTestTimeouts({ command: cmd, root: REPO_ROOT, workers: Number(runEnv.STUDIO_TEST_WORKERS) || tw.workers, machineWorkers: extraEnv?.STUDIO_TEST_WORKERS ? null : tw.machineWorkers, cores: tw.cores, gateFactor: timing.factor, minScale: slow?.minScale || 1, env: process.env });
      testTO = scaled.info;
      if (testTO) console.error(testTimeoutLine(cmdLabel, testTO));
      const t0 = Date.now();
      const res = spawnSync(scaled.command, { windowsHide: true, cwd: REPO_ROOT, shell: true, encoding: 'utf8', env: runEnv, maxBuffer: 32 * 1024 * 1024, timeout: timing.ms });
      // A pass at load factor 1 is the check's quiet run (its floor); a pass of self-triage's re-run at the cap is also
      // its lastPass at any factor, standing in for the floor only while no quiet run is recorded.
      if (res.status === 0 && !curRelated && !plan.slowTier?.run) {
        const took = Date.now() - t0;
        if (timing.factor === 1) recordGateTime(slotRoot, timeKey(), took);
        if (timing.rerun) recordGatePass(slotRoot, timeKey(), took, timing.factor);
      }
      return res;
    });
    // A merge train's re-check (STUDIO_GATE_FOCUS, passed on by run-gates only in an --only run) runs a
    // failing check on its failing test files only (harness/train-focus.mjs); the checks that passed in the verify are
    // skipped. Never in a verify: run-gates drops the variable from any other run.
    const focusMap = readFocus();
    // A merge train's related-first check (STUDIO_GATE_RELATED_ONLY=on with STUDIO_GATE_RELATED=on) runs
    // only the checks that have related tests for these files; nothing else (no whole suite, no layout, no engine gate).
    const relatedOnly = relatedOn && /^(on|1|true|yes)$/i.test(process.env.STUDIO_GATE_RELATED_ONLY || '');
    if (relatedOnly) { plan.layout = false; plan.engine = []; }
    for (const g of gates) {
      cmdLabel = g.id;
      curGate = g;
      testTO = null;
      twRow = null;
      if (focusMap && !(g.id in focusMap)) { skipped.push({ id: g.id, why: 'it passed in the train\'s verify; this focused re-check runs only the checks that failed there' }); continue; }
      const existing = changedHere.filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => f.slice(prefix.length));
      const related = Boolean(g.related && relatedOn && codeOnly && existing.length);
      if (relatedOnly && !related) { skipped.push({ id: g.id, why: 'related-first: it has no related-tests command for these files (the full verify runs it)' }); continue; }
      let focused = null;
      if (focusMap && !related) {
        const fc = focusFor(g, focusMap[g.id], log);
        if (fc.cmd) { focused = { cmd: fc.cmd, files: focusMap[g.id], how: fc.how }; log(`[game-gates] ${g.id}: focused re-check of ${focusMap[g.id].length} failing test file(s) (${fc.how}): ${focusMap[g.id].slice(0, 6).join(', ')}${focusMap[g.id].length > 6 ? ' ...' : ''}`); }
        else log(`[game-gates] ${g.id}: the whole check runs, not a focused re-check: ${fc.why}`);
      }
      const cmd = related ? g.related.replace('{files}', existing.map(q).join(' ')) : focused ? focused.cmd : g.command;
      curRelated = related || Boolean(focused);
      if (related) log(`[game-gates] ${g.id}: only the tests related to the ${existing.length} changed file(s) (the whole suite runs in the whole-game check after landing)`);
      let r = runOnce(cmd);
      // A focused run that fails without naming a failing test (it couldn't start, a bad path), or passes having run
      // nothing, says nothing about the question: the whole check runs instead.
      if (focused) {
        const text = `${r.stdout || ''}${r.stderr || ''}`;
        const named = r.status !== 0 && (failingTestFiles(text).length || (await import('./baseline.mjs')).failingTests(text).length);
        const why = r.status !== 0 && !named ? `exited ${r.status ?? r.signal ?? '?'} without naming a failing test` : r.status === 0 && judgePass(g.id, { output: text, env: { ...process.env, STUDIO_SILENT_GREEN: 'warn' } }).note ? 'passed having run no test' : '';
        if (why) {
          log(`[game-gates] ${g.id}: the focused run ${why}; running the whole check instead`);
          focused = { ...focused, fellBack: why };
          curRelated = false;
          r = runOnce(g.command);
        }
      }
      // A check killed for memory (heavy-budget.mjs oomSignature) runs once more (it queues for its gate
      // slot again), with a note, instead of counting red. STUDIO_HEAVY_OOM_RETRY=off: it counts as it is.
      let oomRetry = null;
      const oom = /^(off|0|false|no)$/i.test(process.env.STUDIO_HEAVY_OOM_RETRY || '') ? '' : oomSignature(r);
      if (oom) {
        console.error(`[game-gates] ${g.id}: died out of memory (${oom}): queued once more`);
        emitEvent({ type: 'heavy.oom_retry', agent: process.env.STUDIO_LOCK_OWNER || 'gates', status: 'warn', msg: `${g.id} died out of memory (${oom}); re-queued once`.slice(0, 400), meta: { gate: g.id, signature: oom } });
        r = runOnce(cmd);
        oomRetry = oomSignature(r) ? `${oom}, and again on its one retry` : oom;
      }
      const timedOut = (x) => x.error?.code === 'ETIMEDOUT' || (x.status === null && x.signal);
      const timeoutLine = () => `\nError: timed out after ${Math.round(timing.ms / 1000)} s (STUDIO_GAME_GATE_TIMEOUT_MS${timing.factor > 1 ? ` ${Math.round(baseTimeout / 1000)} s x ${timing.factor} for load` : ''}${timing.floor ? `${timing.factor > 1 ? ',' : ` ${Math.round(baseTimeout / 1000)} s`} raised to ${timing.floor.mult} x the last ${timing.floor.from === 'last pass' ? 'passing' : 'quiet'} run of ${Math.round(timing.floor.lastMs / 1000)} s` : ''}${timing.rerun ? '; self-triage\'s one re-run at the cap' : ''})`;
      if (timedOut(r)) r.stderr = `${r.stderr || ''}${timeoutLine()}`;
      // A check that timed out under load (factor > 1), or has no quiet run recorded yet, runs once more at the cap,
      // once per check per window (harness/self-triage.json); a timeout with no load, or at the cap, stands.
      if (timedOut(r) && !curRelated) {
        const tr = timeoutRerun({ gate: timeKey(), timing, base: baseTimeout, root: slotRoot });
        if (tr.rerun) {
          console.error(`[game-gates] ${g.id}: ${tr.why}`);
          const first = String(r.stderr || '').trim().split('\n').pop();
          r = runOnce(cmd, tr.ms);
          if (timedOut(r)) r.stderr = `${first}\n${r.stderr || ''}${timeoutLine()}`;
        } else if (timing.factor > 1 || tr.reason) console.error(`[game-gates] ${g.id}: no re-run (${tr.why})`);
      }
      // A red whose only failures are per-test timeouts re-runs just those files, each alone at low load
      // (harness/timeout-rerun.mjs). All green alone: the check counts green, each file a "timeout-flake"; any red alone:
      // red, naming only the red files. Mixed reds, unreadable output, STUDIO_TIMEOUT_RERUN=off: red as before.
      let timeoutFlake = null;
      let redAlone = null;
      if (r.status !== 0 && !timedOut(r)) {
        const save = curRelated;
        const t = await timeoutOnlyRerun({ g, r, runOnce, log, root: slotRoot, setRelated: (v) => { curRelated = v; } });
        curRelated = save;
        if (t?.green) { timeoutFlake = t.green; if (t.allGreen) r = { ...r, status: 0, signal: null, error: undefined }; }
        if (t?.red) redAlone = t.red;
      }
      // STUDIO_GAME_GATE_RETRY=on (opt-in): a failed check runs once more before it counts; passing the second time is
      // logged as flaky (gate.flaky).
      let flaky = null;
      if (r.status !== 0 && /^(on|1|true|yes)$/i.test(process.env.STUDIO_GAME_GATE_RETRY || '')) {
        const first = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 2).join(' | ');
        const again = runOnce(cmd);
        if (again.status === 0) {
          flaky = first.slice(0, 200) || `exit ${r.status}`;
          emitEvent({ type: 'gate.flaky', agent: 'gates', to: 'producer', status: 'warn', msg: `${g.id} failed, then passed when run again: ${flaky}`, meta: { gate: g.id } });
          log(`[game-gates] WARN ${g.id} failed, then passed when run again (flaky: ${flaky})`);
          r = again;
        } else r = again;
      }
      // A "ratchet": true check whose game has a baseline for it fails only on hits the baseline doesn't list
      // (harness/ratchet.mjs judgeCheck); only those are printed. No baseline section: its own exit code, as before.
      let ratchet = null;
      if (g.ratchet && !related && !focused) {
        try {
          const rat = await import('./ratchet.mjs');
          ratchet = rat.judgeCheck(g, r, { root: REPO_ROOT, gameRoot: game.root, base: await rat.laneBase() });
        } catch (err) { log(`[game-gates] WARN ${g.id}: the ratchet couldn't judge it (${err.message}); its exit code stands`); }
        if (ratchet) { for (const l of ratchet.lines) log(l); r = { ...r, status: ratchet.status }; }
      }
      // A red golden-type check of a game whose manifest declares "divergence": where it first went wrong
      // (harness/divergence.mjs gameDivergence: the game's per-tick digests on this tree and the reference commit).
      if (r.status !== 0) await divergenceForCheck(game, g, log);
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 3).join(' | ');
      // Exit 0 with "nothing was run" is a silent green (harness/silent-green.mjs; warn by default).
      // A related run with no related tests is fine: the whole suite runs after landing.
      const sg = r.status === 0 ? (related ? { ok: true, why: '', note: '' } : judgePass(g.id, { output: `${r.stdout || ''}${r.stderr || ''}` })) : null;
      if (sg?.note) log(`[game-gates] WARN ${sg.note}`);
      // The failing test names, so a task is judged only on failures that are new since it was claimed.
      const failures = r.status === 0 ? null : (await import('./baseline.mjs')).failingTests(`${r.stdout || ''}${r.stderr || ''}`);
      let failFiles = r.status === 0 ? [] : failingTestFiles(`${r.stdout || ''}${r.stderr || ''}`);
      if (r.status !== 0 && redAlone) failFiles = [...redAlone];
      rows.push({ id: g.id, ok: r.status === 0 && sg.ok, required: g.required, ...(failFiles.length ? { failingFiles: failFiles } : {}), ...(focused ? { focus: focused.fellBack ? { files: focused.files, fellBack: focused.fellBack } : { files: focused.files, how: focused.how } } : {}), ...(timing.ms !== baseTimeout ? { timeoutMs: timing.ms, timeoutBaseMs: baseTimeout, timeoutWhy: [timing.why, timing.floor?.why].filter(Boolean).join('; ') } : {}), ...(slow ? { testTimeoutScale: testScale } : {}), ...(testTO ? { testTimeout: testTO } : {}), ...(twRow ? { testWorkers: twRow } : {}), ...(failures?.length ? { failures } : {}), why: r.status === 0 ? sg.why : `exit ${r.status}${tail ? `: ${tail.slice(0, 300)}` : ''}`, ...(related ? { related: existing.length } : {}), ...(flaky ? { flaky } : {}), ...(oomRetry ? { oomRetry } : {}), ...(timeoutFlake ? { timeoutFlake } : {}) });
      { const qs = qVerdict.get(g.id); if (qs) rows[rows.length - 1].quarantine = { files: qs.files, state: qs.state, skipped: qs.state === 'honoured' ? qs.files : 0, ...(qs.state === 'not-honoured' ? { stillRun: qs.still.length || qs.files } : {}) }; }
      if (ratchet) { const row = rows[rows.length - 1]; delete row.failures; delete row.failingFiles; if (ratchet.why) row.why = ratchet.why; row.ratchet = { fresh: ratchet.judged?.fresh.length ?? null, standing: ratchet.judged?.standing ?? null }; }
    }
    const perfFocus = focusMap ? focusMap['game:perf'] || null : null;
    if (plan.perf && relatedOnly) skipped.push({ id: 'game:perf', why: 'related-first: the perf tests run in the full verify' });
    else if (plan.perf && focusMap && !perfFocus) skipped.push({ id: 'game:perf', why: 'it passed in the train\'s verify; this focused re-check runs only the checks that failed there' });
    else if (plan.perf && !plan.perf.gates.length) rows.push({ id: 'game:perf', ok: false, required: false, why: `not run: perf tests are listed (${plan.perf.globs.join(', ')}) but no check of the game runs its tests (a "related" or "focus" command, "slowTests": true, or vitest, jest or node --test as its command's last step)` });
    else if (plan.perf) {
      const landing = /^landing$/i.test(String(process.env.STUDIO_GATE_PRIORITY || ''));
      const waitMin = landing ? perfWaitMin() : 0;
      const only = perfFocus?.length ? perfFocus : plan.perf.globs;
      const { waitQuiet } = await import('./flake-quiet.mjs');
      const hv = await import('./heavy.mjs');
      const holdMs = waitMin > 0 ? (waitMin + baseTimeout / 60000 * plan.perf.gates.length) * 60000 : 0;
      const held = holdMs ? hv.markQuietHold(slotRoot, { ms: holdMs, owner: process.env.STUDIO_LOCK_OWNER || null, why: 'the game:perf step (wall-clock tests, alone on a quiet machine)', tag: 'perf' }) : null;
      if (held) console.error(`[game-gates] game:perf: holding new builder and lane verifies back while it waits for a quiet machine and runs (at most ${Math.round(holdMs / 6000) / 10} min; running ones are not stopped)`);
      try {
        const t0 = Date.now();
        const q = waitQuiet(slotRoot, { waitMin, log: (m) => console.error(`[game-gates] game:perf: ${m}`), what: 'the game:perf step', pollMs: 5000 });
        if (!q.quiet) {
          const busyWhat = q.busy.slice(0, 3).join('; ');
          const why = `not run (busy): ${landing ? `no quiet machine within ${waitMin} min (STUDIO_PERF_WAIT_MIN)` : 'the machine is not quiet (a lane verify runs it only on a quiet machine; the merge train waits for one)'}: ${busyWhat}`.slice(0, 400);
          // In a train's focused re-check of game:perf the step judged nothing: a busy refusal, never "green".
          if (perfFocus) { console.error(`[heavy] game:perf did not run: ${why}`); rows.push({ id: 'game:perf', ok: false, required: true, why, perf: { notRun: 'busy' } }); }
          else rows.push({ id: 'game:perf', ok: false, required: false, why, perf: { notRun: 'busy', busy: q.busy.slice(0, 5) } });
        } else {
          log(`[game-gates] game:perf: the machine is quiet${q.waitedMs > 1000 ? ` after ${Math.round(q.waitedMs / 1000)} s` : ''}: ${only.join(', ')} alone, one test worker, in ${plan.perf.gates.map((g) => g.id).join(', ')}`);
          let okAll = true;
          let required = false;
          const fails = [];
          const files = [];
          const tails = [];
          let ran = '';
          for (const g of plan.perf.gates) {
            cmdLabel = `${g.id} (game:perf)`;
            curGate = g;
            curPerf = only;
            curRelated = true;
            let r;
            try { r = runOnce(g.command, null, { STUDIO_TEST_WORKERS: '1', VITEST_MAX_WORKERS: '1', STUDIO_TIMEOUT_RERUN: 'off' }); } finally { curPerf = null; curRelated = false; }
            const text = `${r.stdout || ''}${r.stderr || ''}`;
            ran += text;
            if (r.status !== 0) {
              okAll = false;
              required ||= g.required !== false;
              for (const f of failingTestFiles(text)) if (!files.includes(f)) files.push(f);
              const ft = (await import('./baseline.mjs')).failingTests(text);
              for (const t of ft || []) fails.push(t);
              tails.push(`${g.id}: exit ${r.status ?? r.signal ?? '?'}${(r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) ? ` (timed out after ${Math.round(timing.ms / 1000)} s)` : ''}`);
            }
          }
          const sg = okAll ? judgePass('game:perf', { output: ran }) : null;
          if (sg?.note) log(`[game-gates] WARN ${sg.note}`);
          const tail = ran.trim().split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 3).join(' | ');
          rows.push({ id: 'game:perf', ok: okAll && sg.ok, required: okAll ? true : required, ...(files.length ? { failingFiles: files } : {}), ...(fails.length ? { failures: fails } : {}), perf: { globs: only, waitedMs: Date.now() - t0 }, why: okAll ? sg.why : `${tails.join('; ')}${tail ? `: ${tail.slice(0, 300)}` : ''}` });
        }
      } finally { if (held) hv.clearQuietHold(slotRoot, 'perf'); }
    }
  }
  if (plan.layout) {
    const { runLayoutGate } = await import('./layout-gate.mjs');
    const lay = runLayoutGate({ gameDir: game.root });
    rows.push({ id: 'game:layout', ok: lay.ok, required: true, why: lay.ok ? '' : lay.why.slice(0, 400) });
  }
  for (const e of plan.engine) {
    const r = slot(e.id, () => runGodot(e.project));
    for (const n of r.notes || []) log(`[game-gates] WARN ${e.id}: ${n} (STUDIO_GODOT_PIN=fail makes this fail the gate)`);
    rows.push({ id: e.id, ok: r.ok, required: true, why: r.why });
  }
  // A failing check's test names, one JSON line, so the merge train can tell a red that is only the game's
  // declared pins (harness/train.mjs pinsOnlyRed) from any other.
  for (const r of rows) {
    // An optional check that fails is a WARN (never the gate's FAIL), so the Fix line and the train's focus
    // read the required check that failed, not an advisory one listed before it.
    log(`[game-gates] ${r.ok ? 'PASS' : r.required === false ? 'WARN' : 'FAIL'} ${r.id}${r.why ? `: ${r.why}` : ''}`);
    if (!r.ok && r.failures?.length) log(`[game-gates] failing tests in ${r.id}: ${JSON.stringify(r.failures)}`);
    if (!r.ok && r.failingFiles?.length) log(`[game-gates] failing test files in ${r.id}: ${JSON.stringify(r.failingFiles)}`);
    if (r.timeoutFlake?.length) log(`[game-gates] timeout-flake in ${r.id}: ${JSON.stringify(r.timeoutFlake)}`);
  }
  for (const s of skipped) log(`[game-gates] SKIP ${s.id}: ${s.why}`);
  // E2E/browser tests that start a server on a fixed port with strictPort collide when two verifies run them at once.
  // Advisory only (never a FAIL, no row): run-gates shows these WARN lines even on a passing check.
  if (game?.root && rows.length && !process.env.STUDIO_GATE_FOCUS) { try { const { fixedPortWarnings } = await import('./test-ports.mjs'); for (const l of fixedPortWarnings(REPO_ROOT, [game.root])) log(l); } catch {} }
  // Test files outside the perf tests that assert on wall-clock time (harness/test-timing.mjs). Advisory only.
  if (game?.root && rows.length && !process.env.STUDIO_GATE_FOCUS) { try { const { timingWarnings } = await import('./test-timing.mjs'); for (const l of timingWarnings(REPO_ROOT, [game.root], { perfGlobs: perfTestsOf(), gameRoot: game.root })) log(l); } catch {} }
  if (!rows.length && !skipped.length) log(`[game-gates] no studio game set${game ? '' : ' (or it is a cartridge)'}; the cartridge gates cover it`);
  const failed = rows.filter((r) => !r.ok && r.required);
  return { ok: failed.length === 0, game: game?.name || null, rows, failed, skipped, scope };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  applyGateEnv();
  const a = process.argv.slice(2);
  const paths = String(a.includes('--paths') ? a[a.indexOf('--paths') + 1] || '' : process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
  const ch = String(a.includes('--changed') ? a[a.indexOf('--changed') + 1] || '' : process.env.STUDIO_GATE_CHANGED || '').split(',').filter(Boolean);
  // --plan prints which checks would run and the scope a pass covers, running nothing.
  if (a.includes('--plan')) {
    const p = await planGameGates({ paths, changed: ch.length ? ch : null });
    console.log(JSON.stringify({ game: p.game?.name || null, gates: [...p.gates.map((g) => g.id), ...(p.layout ? ['game:layout'] : []), ...p.engine.map((e) => e.id)], skipped: p.skipped, scope: p.scope }));
    process.exit(0);
  }
  const t0 = Date.now();
  const res = await runGameGates({ paths, changed: ch.length ? ch : null, incoming: readIncoming(), quiet: a.includes('--json') });
  // The uniform job.done (harness/jobs.mjs) for a run of the game's checks.
  try { (await import('./jobs.mjs')).jobDone({ kind: 'game-gates', id: res.game || null, code: res.ok ? 0 : 1, ms: Date.now() - t0, tail: res.failed.map((f) => `${f.id}: ${String(f.why || '').slice(0, 160)}`).join(' | '), task: process.env.STUDIO_JOB_TASK || null, extra: { ran: res.rows.map((r) => r.id), skipped: res.skipped.map((x) => x.id) } }); } catch {}
  if (a.includes('--json')) console.log(JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
