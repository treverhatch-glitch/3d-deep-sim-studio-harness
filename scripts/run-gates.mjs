#!/usr/bin/env node
/**
 * scripts/run-gates.mjs — run every gate in studio/gates.json and report.
 *   node scripts/run-gates.mjs [--required-only] [--only id,id] [--except id,id] [--deep] [--full] [--tier fast|merge|slow] [--no-cache] [--all]
 * In a lane copy the game checks are scoped to the lane's changes (2.31.0); --all runs every one.
 * Exit 1 when a required gate fails. Optional gates are reported as WARN and never fail the run.
 *
 * --tier fast (in-session): runs only the `lite` gates; a gate whose command and input files are unchanged
 *   since its last pass is skipped (cache keyed by content hash). A fast run never counts as a full verify.
 * --tier merge: runs a full, deep verify and never reads from cache (same as --full --deep).
 * --tier slow (2.69.0): the game's slow tier only (harness/slow-tier.mjs; `npm run gates -- --tier slow`, nightly).
 * --deep (or STUDIO_VERIFY_DEEP=1) runs harness self-checks; npm run release and CI do.
 * --full runs every gate a Full studio would.
 * Everyday verify (no tier) skips the deep gates, as before, and never reads the cache.
 *
 * 2.58.0: `npm run verify` runs the gates in a process of its own and shows its log here, so killing this one (or its
 *   whole process tree) leaves the run going; `--wait` re-attaches to it, `--no-detach` runs in this process.
 *   Every verify names the tracked files it changed (changedByVerify in the record).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get, set, del, getKey } from '../harness/gate-cache.mjs';
import { writeAtomic, withFileLock, pidAlive } from '../harness/fsafe.mjs';
import { selfIdentity, pidAlive as idAlive } from '../harness/proc-identity.mjs';
import { applyGateEnv, nodeModulesDrift, porcelainZ } from '../harness/gate-env.mjs';
import { createFence, fenceLine } from '../harness/gate-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
const argv = process.argv.slice(2);
// 2.71.1 (B, S03/T06/G10/G16): the gates and everything they start run without code-loading NODE_OPTIONS (or npm's
// node-options), with git pointed only at this checkout and replace refs ignored (harness/gate-env.mjs). Done in place
// before anything is spawned, so every git call (whichever helper makes it) and every child inherits it. A preload
// into this very process (NODE_OPTIONS=... npm run verify by hand) has already run: it is named, and recorded.
const gateEnvApplied = applyGateEnv();
if (gateEnvApplied.dropped.length && !process.env.STUDIO_VERIFY_RUN) console.log(`[gates] note: the gates run without ${gateEnvApplied.dropped.join(', ')} (harness/gate-env.mjs)`);
if (gateEnvApplied.preload.length) process.env.STUDIO_VERIFY_PRELOADED = [...new Set([...String(process.env.STUDIO_VERIFY_PRELOADED || '').split(' ').filter(Boolean), ...gateEnvApplied.preload])].join(' ');
if (gateEnvApplied.preload.length) console.log(`[gates] WARN this run was started with NODE_OPTIONS that load code into it (${gateEnvApplied.preload.join(' ')}): its checks run without them, but this process's own exit code can't be trusted; the verify record says nodeOptionsPreload`);

// 2.58.0 (F1): verify survives being reaped. Claude Code's low-memory guard killed an agent's background
// `npm run verify` four times while the session sat idle (foreground runs survived). `npm run verify` now starts
// the run in a process nothing it came from holds (startRun), writes .studio/verify-running/<owner>.json, shows
// the run's log here and exits with its code. If this process is killed the run finishes anyway and writes the
// normal verify record; `npm run verify -- --wait` re-attaches (or shows the finished run). One run per owner:
// a second call with the same options attaches to the running one, other options wait for it to end.
// Only `npm run verify` detaches by default (npm sets npm_lifecycle_event): harness callers of this script, CI
// and the release keep the in-process run. --detach or STUDIO_VERIFY_DETACH=on asks for it; =off never.
const SCRIPT = fileURLToPath(import.meta.url);
const VERIFY_DIR = path.join(root, '.studio', 'verify-running');
const verifyOwner = /^[\w.-]+$/.test(process.env.STUDIO_LOCK_OWNER || '') ? process.env.STUDIO_LOCK_OWNER : '_default';
// 2.59.0 (#11b): the checkout's running full verify. 2.67.2 (B-50): keyed by checkout. A lane copy's (and a train's
// scratch copy's) .studio/ is a link to the main checkout's, so one shared full.json made a builder's lane verify look
// like "a full verify of this checkout" to the train and to every other lane: each was refused. The main checkout
// keeps full.json; any other checkout uses full.<hash of its real path>.json, and a record names its checkout (root).
const CHECKOUT = checkoutKey(root);
const FULL_FILE = path.join(VERIFY_DIR, CHECKOUT.file);
{
  const stage = argv.indexOf('--verify-stage');
  if (stage >= 0) process.exit(await verifyStage(argv[stage + 1], argv[stage + 2]));
  // 2.69.0 (p): `npm run gates -- --tier slow` is the nightly slow tier (harness/slow-tier.mjs): the game's slow checks and
  // slow tests only, on this checkout, one bug task per new failure. It is never a verify and writes no verify record.
  if (argv.includes('--tier') && argv[argv.indexOf('--tier') + 1] === 'slow') process.exit(await (await import('../harness/slow-tier.mjs')).slowTierCli(argv, { root }));
  const detachEnv = String(process.env.STUDIO_VERIFY_DETACH || '');
  const detach = !argv.includes('--no-detach') && !process.env.STUDIO_VERIFY_RUN && !/^(off|0|false|no)$/i.test(detachEnv)
    && (argv.includes('--detach') || /^(on|1|true|yes)$/i.test(detachEnv) || process.env.npm_lifecycle_event === 'verify');
  const wait = argv.includes('--wait') && !process.env.STUDIO_VERIFY_RUN;
  // 2.59.0 (#6): a lane copy runs its own committed harness/ and scripts/. When the studio's branch changed them since
  // the lane branched, its gates would judge with the old code (T-061 failed the hooks gate again after the fix had
  // landed on main): refuse and name the files and the fix (rebase). The studio's branch holds the reviewed harness; a
  // lane's own harness edits (a harness task) don't count. STUDIO_LANE_HARNESS=own runs the lane's copy anyway.
  if (!wait) {
    let d = null;
    try { d = (await import('../harness/hook-stamp.mjs')).laneHarnessDrift(root); } catch {}
    if (d?.files.length) {
      const { laneDriftText, laneHarnessOwn } = await import('../harness/hook-stamp.mjs');
      if (laneHarnessOwn()) console.log(`[gates] note: STUDIO_LANE_HARNESS=own: running this lane copy's own harness, ${d.files.length} file(s) behind ${d.branch}`);
      else {
        console.error(`[gates] FAIL not run: ${laneDriftText(d)}`);
        process.exit(1);
      }
    }
  }
  if (wait || detach) process.stdout.on('error', () => {}); // a reader that went away (| head) never stops the run
  if (wait) process.exit(await flushed(await waitForVerify()));
  if (detach) process.exit(await flushed(await detachVerify(argv.filter((a) => !['--wait', '--detach', '--no-detach'].includes(a)))));
}
let only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
// 2.72.0 (d): --except id,id leaves those gates out (CI runs the self-test in parallel shards of its own jobs:
// `node scripts/run-gates.mjs --required-only --deep --except selftest` beside `node qa/selftest.mjs --shard i/N`).
// It is a partial run, like --only: never a verify record, never the full verify.
const except = exceptGates(argv, cfg.gates || []);
// 2.65.3 (B-43): a merge train's focused re-check (STUDIO_GATE_FOCUS, harness/train-focus.mjs) is read only by an
// --only run, which stands for no verify; any other run drops it, so a verify always runs the whole game check.
const focusRun = Boolean(only && String(process.env.STUDIO_GATE_FOCUS || '').trim());
if (!only) delete process.env.STUDIO_GATE_FOCUS;
const tier = argv.includes('--tier') ? argv[argv.indexOf('--tier') + 1] : null;
const isMergeTier = tier === 'merge';
const isFastTier = tier === 'fast';
const deep = argv.includes('--deep') || process.env.STUDIO_VERIFY_DEEP === '1' || isMergeTier;
const useCache = !(argv.includes('--no-cache') || process.env.STUDIO_GATE_CACHE === '0');

const all = cfg.gates || [];
const runStarted = Date.now();
const DEEP = all.some((g) => 'deep' in g) ? new Set(all.filter((g) => g.deep).map((g) => g.id)) : new Set(['selftest', 'hub-smoke', 'hud']);
const LITE = all.some((g) => 'lite' in g) ? new Set(all.filter((g) => g.lite).map((g) => g.id)) : new Set(['purity', 'isolation', 'golden', 'regressions', 'playtest', 'secrets']);
const { readMode, scopeOf } = await import('../harness/mode.mjs');
const scope = argv.includes('--full') || deep ? 'full' : scopeOf(readMode());
const skipped = [];
// 2.30n: with a studio game that isn't a cartridge, the cartridge gates (example-sim's goldens, playtest,
// regressions...) say nothing about it; the "game" gate runs the game's own checks instead.
const { studioGame, declaredGates, isEngineChurn } = await import('../harness/game-gates.mjs');
const sg = await studioGame();
const gameOwnsGates = Boolean(sg && declaredGates(sg).length);
// 2.58.4: a studio game with its own checks can also have real cartridges (a replay cartridge that drives the game's
// sim for goldens, regressions and soak). The cartridge gates that check every cartridge keep running for those; the
// ones that test only the default cartridge (playtest, browser-play: the template's, here) stay skipped.
const EVERY_CARTRIDGE_GATES = new Set(['purity', 'isolation', 'golden', 'golden-py', 'regressions', 'vertical-slice', 'soak', 'tick-budget']);
const { listCartridges, isTemplateCartridge } = await import('../harness/cartridge.mjs');
const realCartridges = listCartridges().filter((n) => !isTemplateCartridge(n));
const keepForCartridges = (g) => realCartridges.length > 0 && EVERY_CARTRIDGE_GATES.has(g.id);
const gates = all.filter((g) => {
  if (only) return only.has(g.id);
  if (gameOwnsGates && g.cartridge && !keepForCartridges(g)) return skipped.push(`${g.id} (cartridge; ${sg.name} runs its own)`), false;
  if (argv.includes('--required-only') && g.required === false) return false;
  if (isFastTier && !LITE.has(g.id)) return false;
  if (!deep && DEEP.has(g.id)) return skipped.push(`${g.id} (deep)`), false;
  if (scope === 'lite' && !LITE.has(g.id) && !isFastTier) return skipped.push(g.id), false;
  return true;
}).filter((g) => !except?.has(g.id) || (skipped.push(`${g.id} (--except)`), false));
// An --except run stands for no verify: from here on it is treated as the --only run of the gates it kept.
if (except) only = new Set(gates.map((g) => g.id));

// 2.60.0 (#5): a run that takes machine:heavy runs as the leader of a process group of its own (POSIX; a re-run of
// this script that this one waits for), so `node harness/heavy.mjs stop` and a later take kill every gate it started
// (npm, node, vitest workers), even after this process is gone. Windows: taskkill /T from the holder covers it.
const isHeavyGate = (g) => g.heavy === true || (g.heavy !== false && ((g.id === 'game' && sg) || g.id === 'browser-play'));
if ((!only && !isFastTier) || gates.some(isHeavyGate)) {
  const code = await (await import('../harness/heavy.mjs')).heavyOwnGroup();
  if (code !== null) process.exit(code);
}
const { activeCartridge } = await import('../harness/cartridge.mjs');
const active = activeCartridge();
console.log(gameOwnsGates ? `[gates] testing the studio's game "${sg.name}" with its own checks (${declaredGates(sg).map((x) => x.id).join(', ')}); ${realCartridges.length ? `its cartridge${realCartridges.length === 1 ? '' : 's'} (${realCartridges.join(', ')}) get${realCartridges.length === 1 ? 's' : ''} the cartridge gates that check every cartridge, the rest are skipped` : 'the cartridge gates are skipped'}` : `[gates] testing the game "${active.name || 'none'}"${active.from ? ` (from ${active.from})` : ''}; goldens and regressions cover every cartridge`);
// 2.71.1 (B, S03/S04): node_modules that don't match package-lock.json (a stale install, or a test runner swapped for a
// shim) are named once; cheap (two JSON reads per folder), never a failure.
try {
  for (const d of [...new Set([root, sg?.root ? path.resolve(root, sg.root) : null].filter(Boolean))]) {
    const why = nodeModulesDrift(d);
    if (why) console.log(`[gates] WARN node_modules in ${path.relative(root, d).split(path.sep).join('/') || '.'} doesn't match its package-lock.json (a stale install, or changed by hand): ${why}. The checks may not run what the lockfile names: run npm ci there`);
  }
} catch { /* a help, never a failure */ }
// 2.31.0: in a lane copy, verify tests what this lane changed against the studio's branch (committed and
// not), the same scope `task done` uses. Before, verify had no diff, so a Godot-only lane ran every web
// game check (~11 min in the Marina run) and never ran the Godot gate, which only runs for changed paths.
// --all (or STUDIO_GATE_CHANGED set by the caller) overrides. Changes to shared files still run everything.
let changedFiles = null;
let changedBase = null;
if (process.env.STUDIO_GATE_CHANGED) changedFiles = process.env.STUDIO_GATE_CHANGED.split(',').filter(Boolean);
else if (!argv.includes('--all')) {
  try {
    const { inLaneCopy, laneDiff } = await import('../harness/worktree.mjs');
    if (inLaneCopy()) {
      const ld = laneDiff();
      // 2.71.1 (B, G14): -z names: a non-ASCII path is no longer a quoted "web/\340..." that no glob matches.
      const dirty = porcelainZ(spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '').map((e) => e.file);
      const files = [...new Set([...(ld?.changed || []), ...dirty])];
      if (files.length) {
        changedFiles = files;
        changedBase = ld?.base || null;
      }
    }
  } catch {
    // no lane diff: every gate runs, as before
  }
}
if (changedFiles?.length) {
  process.env.STUDIO_GATE_CHANGED = changedFiles.join(',');
  if (!process.env.STUDIO_GATE_PATHS) process.env.STUDIO_GATE_PATHS = changedFiles.join(',');
  console.log(`[gates] scoped to the ${changedFiles.length} file(s) this lane changed${changedBase ? ` since ${changedBase.slice(0, 8)}` : ''}; game checks outside them are skipped (--all runs everything)`);
}
// 2.59.0: the owner's task reclassifications in force (harness/reclassify.mjs), shown like approvals, and any on file
// that doesn't count (unsigned with an owner key, set by an agent's commit, not committed).
if (fs.existsSync(path.join(root, 'studio', 'task-types.json')) || fs.existsSync(path.join(root, 'studio', 'approvals'))) {
  try {
    const { typeRecordLines } = await import('../harness/reclassify.mjs');
    for (const l of typeRecordLines()) console.log(`[gates] ${l.ok ? 'owner type:' : 'WARN owner type:'} ${l.line}`);
  } catch { /* the list is a help, never a failure */ }
}
// 2.70.0 (w): in a sparse lane (harness/lane-sparse.mjs) the checks never see a partial tree: every left-out file a
// check about to run reads is put back first (the game's own checks do the same in harness/game-gates.mjs), and a
// run that still leaves files out doesn't write the shared gate cache.
let sparseRun = null;
try {
  const ls = await import('../harness/lane-sparse.mjs');
  sparseRun = ls.widenForChecks({ dir: root, needs: gates.filter((g) => g.id !== 'game').map((g) => ({ id: g.id, globs: ls.harnessCheckNeeds(g) })), log: (m) => console.log(m) });
} catch (err) { console.log(`[gates] WARN sparse lane check: ${err.message}`); }
if (skipped.length) console.log(`[gates] ${scope === 'lite' ? 'Lite scope: ' : ''}skipped ${skipped.join(', ')}${skipped.some((x) => x.endsWith('(deep)')) ? '; --deep runs the harness self-checks' : ''}${scope === 'lite' ? '; --full runs every gate' : ''}`);
// 2.59.0 (#11b): one full verify per checkout. A stopped background verify loop's shell child survived and ran a
// second full verify of the same checkout beside the first (the per-owner record above only keeps one owner's
// detached runs apart). The process that runs the gates records itself in .studio/verify-running/full.json (pid and
// start identity, harness/proc-identity.mjs); a second full run here while that process lives is refused, naming
// it. A record whose process is gone (its shell was killed) is stale and ignored. Partial runs (--only, --tier fast)
// don't take or check it.
const fullRun = !only && !isFastTier;
if (fullRun) claimFullVerify();
// 2.59.0 (#11a): heavy work takes the machine:heavy lock (harness/heavy.mjs) for the whole run: the full set, or a
// run with a heavy gate in it (the studio game's checks, browser-play, or a gate marked "heavy": true). It waits,
// naming the holder, and fails clearly past STUDIO_HEAVY_WAIT_MIN; its gates (children) don't wait for it again.
// 2.65.0: the slot's handle, so each gate's shell is recorded in its tree on Windows (harness/gate-spawn.mjs).
let heavyLock = null;
{
  if (fullRun || gates.some(isHeavyGate)) {
    const { acquireHeavy, heavyRoot } = await import('../harness/heavy.mjs');
    try {
      const lk = acquireHeavy(await heavyRoot(), `${fullRun ? 'full verify' : 'verify'} of ${path.basename(root)}`, { log: (m) => console.log(m), owner: process.env.STUDIO_LOCK_OWNER || null, kind: 'verify' });
      heavyLock = lk;
      process.on('exit', () => lk.release());
    } catch (err) {
      if (err.code !== 'HEAVY_BUSY') throw err;
      console.error(err.message);
      process.exit(1);
    }
  }
}
// 2.58.0 (PU-34): the commit and tree the gates start on are the ones they test, so the record names HEAD from
// before the first gate, and the tree counts as dirty if it was dirty then or is at the end (an edit made while the
// gates ran). Engine cache files a gate rewrites (.godot/, *.import, *.uid) don't count. task done trusts a verify
// only for this commit on a clean tree (harness/done-check.mjs gatesAfter).
const gitOut = (args) => { try { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; } catch { return null; } };
// 2.58.3 (O3, crew P-035): nor does a tracked file that differs only in line endings (harness/eol-only.mjs).
const { splitEolOnly } = await import('../harness/eol-only.mjs');
// 2.71.1 (B, G14): names read with -z (never quoted), so a non-ASCII engine cache file is recognised as one.
const treeDirty = () => { const s = gitOut(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.', ':(exclude)studio']); return s === null ? null : splitEolOnly(root, porcelainZ(s).filter((e) => !isEngineChurn(e.file)).map((e) => `${e.xy} ${e.file}`)).real.length > 0; };
const headAtStart = gitOut(['rev-parse', 'HEAD'])?.trim() || null;
// 2.58.5 (H-3): the tree it tests too (with dirty=false, the files the gates saw), so task done can let this verify
// stand in for its game checks on the same tree; with what scoped the game gate (its paths, related tests only).
const treeAtStart = headAtStart ? gitOut(['rev-parse', 'HEAD^{tree}'])?.trim() || null : null;
const gatePathsAtStart = String(process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
const relatedAtStart = (await import('../harness/game-gates.mjs')).relatedTestsOn();
// 2.71.1 (G15/T02): untracked files, and ignored files outside build and dependency output, under the game and the paths
// the checks read count as dirty too: a config or setup file no commit holds changes what the checks run, and a record
// of a "clean" run beside one must never be reused (harness/gate-trust.mjs hiddenInputs).
const trust = await import('../harness/gate-trust.mjs');
const hiddenAtStart = trust.hiddenInputs(root, [...(sg?.root ? [sg.root] : []), 'cartridges', 'qa', 'harness', 'scripts', 'engine', 'hub'], { skip: isEngineChurn });
if (hiddenAtStart?.length) console.log(`[gates] note: ${hiddenAtStart.length} untracked or ignored file(s) the checks may read (${hiddenAtStart.slice(0, 5).join(', ')}${hiddenAtStart.length > 5 ? ', …' : ''}): this verify counts as dirty, so it can't stand in for task done's checks or a train's verify. Commit them, or delete them (or add build output to .gitignore under a dist/, build/ or coverage/ folder).`);
const dirtyAtStart = hiddenAtStart?.length ? true : treeDirty();
const { runGateCommand } = await import('../harness/gate-spawn.mjs');
const rows = [];
let cachedCount = 0;
const compact = /^(on|1|true|yes)$/i.test(process.env.STUDIO_COMPACT_OUTPUT || '');
// 2.58.0 (F2): the tracked files as they are before any gate runs, to name the ones this verify changes.
const trackedBefore = trackedSnapshot();
for (const gate of gates) {
  const cacheable = gate.cache !== false && (gate.lite || gate.cache === true);
  let key;
  // Only the in-session fast tier reads the cache; everyday verify, --deep and the merge tier always run.
  // 2.30h (#6): a gate with cacheDeep (the HUD check) also reuses its last pass in a --deep run; the merge tier still always runs it.
  if (useCache && cacheable && !focusRun && (isFastTier || (gate.cacheDeep && !isMergeTier))) {
    key = getKey(gate);
    const cached = get(gate, key);
    if (cached) {
      rows.push({ id: gate.id, ok: true, required: gate.required !== false, ms: cached.ms || 0, cached: true, cartridge: active.name });
      console.log(`[gates] PASS ${gate.id} (cached ${key.slice(0, 8)}: command and files unchanged since its last pass)`);
      cachedCount++;
      continue;
    }
  }

  const start = Date.now();
  // 2.30q (#8): compact output (STUDIO_COMPACT_OUTPUT=on, set for launched sessions): a gate's own output goes to
  // .studio/gates/out/<gate>.log and only a failure's last lines are printed, so an agent's context doesn't
  // carry every passing gate's log into every later turn (verify was ~3k chars a call in the Marina run).
  // 2.65.0: on Windows, while this run holds machine:heavy, the gate's shell is recorded in the holder's tree so its
  // children that outlive it are found by `heavy stop` and the next take; POSIX runs exactly as before (spawnSync).
  // 2.71.1 (B, L01/I01): every gate's output goes through a fence (harness/gate-output.mjs): kept whole in
  // .studio/gates/out/<gate>.log, at most its first and last STUDIO_GATE_OUTPUT_LINES (200) lines shown, and a line that
  // looks like run-gates' own ([gates] ..., [verify] ...) shown as `| [gates] ...`, so no check prints our verdict or Fix.
  const outName = `.studio/gates/out/${String(gate.id).replace(/[^\w.-]/g, '_')}.log`;
  const fence = createFence({ show: compact ? null : (t) => process.stdout.write(t), logName: outName, pick: /^\[game-gates\] WARN game:/ });
  const outTmp = path.join(root, `${outName}.${process.pid}.tmp`);
  const res = await runGateCommand(gate.command, { cwd: root, compact, lk: heavyLock, outFile: outTmp, onData: (d) => fence.push(d) });
  try { fs.renameSync(outTmp, path.join(root, outName)); } catch { try { fs.rmSync(outTmp, { force: true }); } catch {} }
  const fenced = fence.end();
  if (compact) {
    // 2.67.0 (B-48): a passing game gate's advisory checks (game:test-rng, game:det-math in warn mode) still show.
    if (res.status === 0) for (const l of fenced.picked) console.log(`${l} (advisory; full: ${outName})`);
    if (res.status !== 0) {
      const lines = [...fenced.head, ...fenced.tail];
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      const n = Number(process.env.STUDIO_COMPACT_FAIL_LINES || 40);
      console.log(`[gates] ${gate.id} output (last ${Math.min(n, lines.length)} of ${fenced.lines} lines; full: ${outName})`);
      console.log(lines.slice(-n).map(fenceLine).join('\n'));
    }
  }
  const ms = Date.now() - start;
  const ok = res.status === 0;
  const required = gate.required !== false;
  rows.push({ id: gate.id, ok, required, ms, cached: false, cartridge: active.name });
  console.log(`[gates] ${ok ? 'PASS' : required ? 'FAIL' : 'WARN'} ${gate.id}`);
  if (!ok) console.log(`[gates] ${(await import('../harness/gate-fix.mjs')).gateFixLine(gate, { output: fenced.text, compact })}`); // 2.66.0 (d): one next step per failure

  if (cacheable && !isMergeTier && !focusRun && !sparseRun?.partial) {
    if (ok) set(gate, ms);
    else del(gate);
  }
}

// 2.30c (G3): failing first, in plain words; "not run" apart from "pass".
{
  const { gateWords } = await import('../harness/gate-words.mjs');
  console.log('\n[gates] in plain words');
  for (const l of gateWords({ rows, skipped, partial: Boolean(only) }, all).lines) console.log(`  ${l}`);
}
if (!compact) console.log('\n[gates] summary');
if (!compact) for (const r of rows) console.log(`  ${r.ok ? 'PASS' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.cached ? ' (cached)' : ''}${r.required ? '' : '  (optional)'}`);
// 2.58.0 (F2): a verify must not dirty the repo (on Windows each verify rewrote a game test snapshot's line endings
// on main). Tracked files outside studio/ (the board, which other agents write meanwhile) whose state or content
// differs from before the gates ran are named here and in the record; the exit code doesn't change.
const changedByVerify = changedTracked(trackedBefore, trackedSnapshot());
if (changedByVerify?.length) {
  const shown = changedByVerify.slice(0, 10).join(', ') + (changedByVerify.length > 10 ? ` (+${changedByVerify.length - 10} more)` : '');
  console.log(`\n[gates] WARN this verify changed ${changedByVerify.length} tracked file(s): ${shown}`);
  console.log('[gates]   a check rewrote them (a test snapshot, its line endings, a generated file) or they were edited while it ran; `git diff` shows how. Game checks run with CI=true so test runners never write snapshots: update them on purpose with `-u`, and give generated files `eol=lf` in .gitattributes. Recorded as changedByVerify in the verify record.');
}
// The War Room's gate board reads this file; it is runtime state (gitignored under .studio/).
try {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  // 2.43.0: the commit this verify ran on, and whether the tree was clean, so task done can trust it on that commit.
  const headNow = headAtStart;
  const dirtyEnd = treeDirty();
  const dirtyNow = dirtyAtStart === null || dirtyEnd === null ? null : dirtyAtStart || dirtyEnd;
  // 2.71.1 (D01/T04): every record carries a run id, and a full run also writes its run log (.studio/gates/runs/<id>.json,
  // the record's digest): reuse needs the two to match (harness/gate-trust.mjs recordTrust).
  const runId = /^[\w.-]{6,80}$/.test(process.env.STUDIO_VERIFY_RUN || '') ? process.env.STUDIO_VERIFY_RUN : trust.newRunId();
  const rec = JSON.stringify({ runId, at: new Date().toISOString(), head: headNow, tree: treeAtStart, dirty: dirtyNow, gatePaths: gatePathsAtStart, ...(relatedAtStart ? { related: true } : {}), ...(process.env.STUDIO_GATE_INCOMING_FILE ? { incomingOnly: true } : {}), partial: Boolean(only) || isFastTier, ...(focusRun ? { focus: true } : {}), scope, deep, tier, cachedCount, skipped, cartridge: active.name, rows, ...(changedFiles?.length ? { scoped: true, changed: changedFiles, base: changedBase } : {}), ...(changedByVerify ? { changedByVerify } : {}), ...(process.env.STUDIO_VERIFY_RUN ? { verifyRun: process.env.STUDIO_VERIFY_RUN } : {}), ...(hiddenAtStart?.length ? { hidden: hiddenAtStart } : {}), ...(process.env.STUDIO_VERIFY_PRELOADED ? { nodeOptionsPreload: process.env.STUDIO_VERIFY_PRELOADED.split(' ') } : {}) }, null, 2);
  if (!only && !isFastTier) trust.writeRunLog(path.join(root, '.studio'), JSON.parse(rec), { root: CHECKOUT.real, owner: process.env.STUDIO_LOCK_OWNER || null });
  // Each agent's own runs are kept apart too (2.29): in its own copy it tests its own work, and its
  // done-check reads its own record. The studio-wide record is the main checkout's.
  const owner = process.env.STUDIO_LOCK_OWNER;
  // 2.71.1 (G12): a checkout whose .studio/ is a link (a lane or train copy) is a copy whatever STUDIO_MAIN_ROOT says, so a
  // lane naming itself can't write the studio-wide records.
  const inCopy = (Boolean(process.env.STUDIO_MAIN_ROOT) && path.resolve(process.env.STUDIO_MAIN_ROOT) !== root) || CHECKOUT.file !== 'full.json';
  if (!inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last.json'), rec);
  // A full run is kept apart, so one agent's --only run never wipes the full verify another agent's
  // done-check needs (test #2).
  if (!only && !isFastTier && !inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last-full.json'), rec);
  if (owner && /^[\w.-]+$/.test(owner)) {
    fs.mkdirSync(path.join(root, '.studio', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), rec);
    if (!only && !isFastTier) fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}-full.json`), rec);
  }
  // 2.69.0 (p): a clean full verify is also kept by the tree it tested (.studio/gates/trees/<tree>.json, the newest 64),
  // so the merge train can reuse a lane's green verify after its agent's next verify replaced <owner>-full.json.
  if (!only && !isFastTier && !focusRun && treeAtStart && dirtyNow === false && !relatedAtStart && !process.env.STUDIO_GATE_INCOMING_FILE) {
    const tdir = path.join(root, '.studio', 'gates', 'trees');
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, `${treeAtStart}.json`), JSON.stringify({ ...JSON.parse(rec), owner: owner || null, checkout: root }, null, 2));
    try { const old = fs.readdirSync(tdir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(tdir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(64); for (const o of old) fs.rmSync(path.join(tdir, o.n), { force: true }); } catch {}
  }
} catch {
  // read-only checkout: the board just shows "not run"
}
// 2.34.0: every verify is an event (how long, scoped or not, what failed), for the harness health report.
try {
  const { emitEvent } = await import('../harness/event.mjs');
  emitEvent({ type: 'gates.run', agent: process.env.STUDIO_LOCK_OWNER || null, msg: `verify: ${rows.filter((r) => r.ok).length}/${rows.length} passed in ${Math.round((Date.now() - runStarted) / 1000)} s${changedFiles?.length ? ` (scoped to ${changedFiles.length} file(s))` : ''}`, meta: { ms: Date.now() - runStarted, scoped: Boolean(changedFiles?.length), partial: Boolean(only) || isFastTier, ran: rows.length, failed: rows.filter((r) => !r.ok && r.required).map((r) => r.id), gameMs: rows.find((r) => r.id === 'game')?.ms ?? null, ...(changedByVerify?.length ? { changedByVerify } : {}) } });
  // 2.65.0: a full verify also ends with the uniform job.done (harness/jobs.mjs), which `npm run events -- wait` matches.
  if (!only && !isFastTier) {
    const failedIds = rows.filter((r) => !r.ok && r.required).map((r) => r.id);
    const owner = process.env.STUDIO_LOCK_OWNER;
    (await import('../harness/jobs.mjs')).jobDone({ kind: 'verify', id: process.env.STUDIO_VERIFY_RUN || owner || (headAtStart ? String(headAtStart).slice(0, 8) : null), code: !rows.length || failedIds.length ? 1 : 0, ms: Date.now() - runStarted, tail: failedIds.length ? `failed: ${failedIds.join(', ')}` : !rows.length ? 'no gate ran' : '', log: owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : '.studio/gates-last-full.json', extra: { scoped: Boolean(changedFiles?.length), head: headAtStart || null } });
  }
} catch {
  // the event log is a help, never a blocker
}
// 2.31.0: fail closed. A verify where no gate ran checked nothing; it used to print "0/0 passed, all
// required gates green" and count as a full verify.
if (!rows.length) {
  console.error('[gates] no gate ran, so nothing was checked: this is not a pass. Check studio/gates.json, --only, and the scope (npm run mode).');
  process.exit(1);
}
const failed = rows.filter((r) => !r.ok && r.required);
if (failed.length) {
  console.error(`[gates] ${failed.length} required gate(s) failed: ${failed.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
console.log(`[gates] ${rows.filter((r) => r.ok).length}/${rows.length} passed, all required gates green`);

// ---- 2.58.0 (F2): tracked files a verify changed ----

/** Tracked files that differ from HEAD outside studio/: path -> "<status> <content hash>". null without git. */
function trackedSnapshot() {
  try {
    const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.', ':(exclude)studio'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const parts = r.stdout.split('\0');
    const snap = new Map();
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      if (e[0] === 'R' || e[0] === 'C') i++; // with -z a rename's old path follows as its own entry
      const file = e.slice(3);
      let hash = 'gone';
      // The content too: a file already changed before the run that a check rewrites keeps the same status line.
      if (snap.size < 5000) try { hash = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, file))).digest('hex'); } catch {}
      snap.set(file, `${e.slice(0, 2)} ${hash}`);
    }
    return snap;
  } catch {
    return null;
  }
}

function changedTracked(before, after) {
  if (!before || !after) return null;
  const out = new Set();
  for (const [f, v] of after) if (before.get(f) !== v) out.add(f);
  for (const f of before.keys()) if (!after.has(f)) out.add(f);
  return [...out].sort();
}

// ---- 2.59.0 (#11b): one full verify per checkout ----

/**
 * 2.67.2 (B-50): this checkout's key for the full-verify record: { real, file }. The checkout whose .studio/ is its
 * own folder (the main checkout) uses full.json; a checkout whose .studio/ is a link (a lane or train copy) uses
 * full.<12 hex of sha1(its real path)>.json. Windows paths compare case-insensitively.
 */
function checkoutKey(dir) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const here = norm(real(dir));
  const own = norm(path.dirname(real(path.join(dir, '.studio')))) === here;
  return { real: here, file: own ? 'full.json' : `full.${crypto.createHash('sha1').update(here).digest('hex').slice(0, 12)}.json` };
}

/** The live full verify of this checkout other than this process: its record, or null (none, or stale). */
function liveFullVerify() {
  const rec = readJsonFile(FULL_FILE);
  if (!rec?.pid || rec.pid === process.pid) return null;
  if (rec.root && rec.root !== CHECKOUT.real) return null; // another checkout's run (2.67.2, B-50)
  return idAlive(rec.pid, rec.identity) && Date.now() - Date.parse(rec.startedAt || 0) < Number(process.env.STUDIO_VERIFY_MAX_MIN || 360) * 60000 ? rec : null;
}

/** Record this process as the checkout's full verify, or refuse (exit 1) while another one lives. */
function claimFullVerify() {
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  const holder = statusLock('full', () => {
    const live = liveFullVerify();
    if (live) return live;
    const st = process.env.STUDIO_VERIFY_RUN ? readJsonFile(verifyFiles().status) : null;
    writeAtomic(FULL_FILE, JSON.stringify({ pid: process.pid, identity: selfIdentity(), root: CHECKOUT.real, owner: verifyOwner, args: argv, startedAt: new Date().toISOString(), ...(process.env.STUDIO_VERIFY_RUN ? { verifyRun: process.env.STUDIO_VERIFY_RUN, log: st?.runId === process.env.STUDIO_VERIFY_RUN ? relPath(st.log) : null } : {}) }, null, 2));
    return null;
  });
  if (holder) {
    console.error(`[verify] refused: a full verify of this checkout is already running: ${holder.owner || '_default'}'s (pid ${holder.pid}, ${holder.args?.length ? holder.args.join(' ') : 'no options'}, started ${ago(holder.startedAt)} ago${holder.log ? `, log ${holder.log}` : ''}). Two full runs on one checkout share its files and slow each other into timeouts. Wait for it instead: npm run verify -- --wait (shows it and its result). Nothing was run and no verify record was written.`);
    process.exit(1);
  }
  process.on('exit', () => {
    try { if (readJsonFile(FULL_FILE)?.pid === process.pid) fs.rmSync(FULL_FILE, { force: true }); } catch {}
  });
}

// ---- 2.58.0 (F1): the detached run ----
// .studio/verify-running/<owner>.json          { runId, owner, args, startedAt, state, hostPid, runnerPid, log, result }
// .studio/verify-running/<owner>.<runId>.log   the run's output (stdout and stderr); this run's and the one before
// .studio/verify-running/<owner>.result.json   { runId, code, endedAt }, written when the run ends (never deleted
//                                              first: one attached to the last run may still be reading it)

function verifyFiles(owner = verifyOwner) {
  return { status: path.join(VERIFY_DIR, `${owner}.json`), result: path.join(VERIFY_DIR, `${owner}.result.json`) };
}

/** A new run's own log; older ones but the last (one attached to it may still be reading) are removed. */
function newRunLog(owner, runId) {
  const esc = owner.replace(/[.\\-]/g, '\\$&');
  const mine = new RegExp(`^${esc}\\.[0-9a-z]+-\\d+\\.log$`);
  const old = fs.readdirSync(VERIFY_DIR).filter((f) => mine.test(f)).map((f) => ({ f, t: fs.statSync(path.join(VERIFY_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of old.slice(1)) try { fs.rmSync(path.join(VERIFY_DIR, f), { force: true }); } catch {}
  const log = path.join(VERIFY_DIR, `${owner}.${runId}.log`);
  fs.writeFileSync(log, '');
  return log;
}

function readJsonFile(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function relPath(f) { return path.relative(root, f).split(path.sep).join('/'); }
function nap(ms) { return new Promise((r) => setTimeout(r, ms)); }
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso || 0)) / 1000));
  return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

/** 'none' | 'running' | 'done' | 'stale' (its host is gone without a result, or it never started). */
function runState(st, files) {
  if (!st?.runId) return 'none';
  if (readJsonFile(files.result)?.runId === st.runId) return 'done';
  const age = Date.now() - Date.parse(st.startedAt || 0);
  if (st.hostPid) return pidAlive(st.hostPid) && age < Number(process.env.STUDIO_VERIFY_MAX_MIN || 360) * 60000 ? 'running' : 'stale';
  return age < 60000 ? 'running' : 'stale'; // starting: two Node start-ups, slow on a busy Windows box
}

function statusLock(owner, fn) { return withFileLock(`verify-${owner}`, fn, { dir: VERIFY_DIR, what: `the verify record for ${owner}` }); }

/** Wait until everything written to stdout is out, then hand back the exit code. */
async function flushed(code) {
  await new Promise((r) => process.stdout.write('', () => r()));
  return code;
}

async function writeOut(chunk) {
  await new Promise((r) => { try { process.stdout.write(chunk, () => r()); } catch { r(); } });
}

/** Copy the log from `off` to stdout; returns the new offset. */
async function pump(file, off) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return off; }
  try {
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) break;
      off += n;
      await writeOut(Buffer.from(buf.subarray(0, n)));
    }
  } catch {
    // the log went away (a new run truncated it): stop here
  } finally {
    fs.closeSync(fd);
  }
  return off;
}

/** Print the log's last lines (STUDIO_VERIFY_TAIL_LINES, 120); returns the offset they end at. */
async function printTail(file) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return 0; }
  const n = Math.max(1, Number(process.env.STUDIO_VERIFY_TAIL_LINES || 120));
  const from = Math.max(0, size - 512 * 1024);
  const buf = Buffer.alloc(size - from);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, buf.length, from); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n');
  if (lines.length > n + 1 || from > 0) {
    console.log(`[verify] ... (earlier lines in ${relPath(file)})`);
    await writeOut(lines.slice(-(n + 1)).join('\n'));
  } else await writeOut(buf);
  return size;
}

/** Stop a run and everything it started (Ctrl+C at a terminal). */
function stopRun(hostPid) {
  if (!hostPid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(hostPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-hostPid, 'SIGTERM'); } catch { try { process.kill(hostPid, 'SIGTERM'); } catch {} }
}

/** Show the run's output from `off` until it ends; its exit code. */
async function follow(st, off) {
  const files = verifyFiles(st.owner);
  const t0 = Date.now();
  let checked = Date.now();
  // A person at a terminal who presses Ctrl+C means "stop": the run stops too. An agent's shell has no terminal,
  // and a killed or closed shell leaves the run going (the point of running it apart).
  if (process.stdin.isTTY && process.stdout.isTTY) {
    process.once('SIGINT', () => {
      stopRun(readJsonFile(files.status)?.hostPid);
      try { writeAtomic(files.result, JSON.stringify({ runId: st.runId, code: 130, stopped: true, endedAt: new Date().toISOString() })); } catch {}
      console.log('\n[verify] stopped: Ctrl+C stops the run too (it keeps going only when this shell is killed or closed)');
      process.exit(130);
    });
  }
  for (;;) {
    off = await pump(st.log, off);
    const res = readJsonFile(files.result);
    if (res?.runId === st.runId) {
      await pump(st.log, off);
      return Number.isInteger(res.code) ? res.code : 1;
    }
    if (Date.now() - checked > 1000) {
      checked = Date.now();
      const cur = readJsonFile(files.status);
      if (cur?.runId !== st.runId || runState(cur, files) === 'stale') {
        if (readJsonFile(files.result)?.runId === st.runId) continue;
        await pump(st.log, off);
        console.log(`\n[verify] the run stopped before it finished (${cur?.runId !== st.runId ? 'another run replaced it' : cur.hostPid ? `its process ${cur.hostPid} is gone` : 'it never started'}) and wrote no result: run npm run verify again`);
        return 1;
      }
    }
    await nap(Date.now() - t0 < 5000 ? 40 : 150);
  }
}

/** `npm run verify`: start the run apart (or attach to this owner's running one) and show it. */
async function detachVerify(runArgs) {
  const files = verifyFiles();
  fs.mkdirSync(VERIFY_DIR, { recursive: true });
  let told = false;
  for (;;) {
    const pick = statusLock(verifyOwner, () => {
      const st = readJsonFile(files.status);
      if (runState(st, files) === 'running') return { st, same: JSON.stringify(st.args || []) === JSON.stringify(runArgs) };
      const runId = `${Date.now().toString(36)}-${process.pid}`;
      const next = { runId, owner: verifyOwner, args: runArgs, startedAt: new Date().toISOString(), state: 'starting', by: process.pid, log: newRunLog(verifyOwner, runId), result: files.result };
      writeAtomic(files.status, JSON.stringify(next, null, 2));
      return { start: next };
    });
    if (pick.start) {
      console.log(`[verify] the gates run in a process of their own (log ${relPath(pick.start.log)}): if this shell is killed they still finish and write the record; npm run verify -- --wait shows them`);
      startRun(files.status);
      return follow(pick.start, 0);
    }
    if (pick.same) {
      console.log(`[verify] a verify for ${verifyOwner} with the same options is already running (started ${ago(pick.st.startedAt)} ago); showing it instead of starting a second one`);
      return follow(pick.st, await printTail(pick.st.log));
    }
    if (!told) console.log(`[verify] a verify for ${verifyOwner} is already running (${pick.st.args?.join(' ') || 'no options'}, started ${ago(pick.st.startedAt)} ago); this one starts when it ends`);
    told = true;
    while (runState(readJsonFile(files.status), files) === 'running') await nap(500);
  }
}

/**
 * Start the run so that no process in this one's tree is its parent: a quick hop starts the run's host and exits at
 * once. A reaper that kills this process and everything under it (a parent-pid walk on POSIX, taskkill /T on
 * Windows) or its process group doesn't reach the host: on POSIX it is in a session of its own; on Windows it is
 * detached, so outside the hop's kill-on-close job, and runs the gates in a hidden console (no window opens).
 */
function startRun(statusFile) {
  const c = spawn(process.execPath, [SCRIPT, '--verify-stage', 'hop', statusFile], { cwd: root, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
  c.on('error', (e) => { try { fs.appendFileSync(readJsonFile(statusFile)?.log, `[verify] could not start the run: ${e.message}\n`); } catch {} });
  c.unref();
}

/** The hop and the host (internal: --verify-stage hop|host <status file>). */
async function verifyStage(stage, statusFile) {
  const st = readJsonFile(statusFile);
  if (!st?.runId) return 1;
  if (stage === 'hop') {
    const h = spawn(process.execPath, [SCRIPT, '--verify-stage', 'host', statusFile], { cwd: root, stdio: 'ignore', detached: true, windowsHide: true });
    h.on('error', () => {});
    h.unref();
    return 0;
  }
  if (stage !== 'host') return 1;
  // The host runs the gates (this script, --no-detach, in a child it waits for) and writes the result at the end.
  const mine = (fn) => statusLock(st.owner, () => { const cur = readJsonFile(statusFile); return cur?.runId === st.runId ? fn(cur) : false; });
  mine((cur) => writeAtomic(statusFile, JSON.stringify({ ...cur, state: 'running', hostPid: process.pid }, null, 2)));
  const fd = fs.openSync(st.log, 'a');
  return new Promise((resolve) => {
    let ended = false;
    const finish = (code, why) => {
      if (ended) return;
      ended = true;
      if (why) try { fs.appendFileSync(st.log, `\n[verify] ${why}\n`); } catch {}
      const endedAt = new Date().toISOString();
      try {
        mine((cur) => {
          writeAtomic(st.result, JSON.stringify({ runId: st.runId, code, endedAt }));
          writeAtomic(statusFile, JSON.stringify({ ...cur, state: 'done', code, endedAt }, null, 2));
        });
      } catch {
        writeAtomic(st.result, JSON.stringify({ runId: st.runId, code, endedAt }));
      }
      resolve(0);
    };
    // On Windows the output comes through pipes: with no handle inherited, windowsHide gives the gates a console that
    // has no window at all (CREATE_NO_WINDOW), not a hidden one a default-terminal setting could still show.
    const piped = process.platform === 'win32';
    const r = spawn(process.execPath, [SCRIPT, '--no-detach', ...(st.args || [])], { cwd: root, env: { ...process.env, STUDIO_VERIFY_RUN: st.runId }, stdio: piped ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd], windowsHide: true });
    if (piped) for (const s of [r.stdout, r.stderr]) s.on('data', (d) => { try { fs.writeSync(fd, d); } catch {} });
    r.on('error', (e) => finish(1, `could not start the gates: ${e.message}`));
    let exited = null;
    // The pipes close after the last output; a process a gate left running can hold them open, so 2 s at most.
    r.on('exit', (code, signal) => { exited = [code ?? 1, signal ? `the gates were stopped (${signal})` : '']; if (piped) setTimeout(() => finish(...exited), 2000); else finish(...exited); });
    r.on('close', () => { if (exited) finish(...exited); });
    if (r.pid) mine((cur) => writeAtomic(statusFile, JSON.stringify({ ...cur, runnerPid: r.pid }, null, 2)));
  });
}

/** `npm run verify -- --wait`: show this owner's running or last run; exit with its code. */
async function waitForVerify() {
  const files = verifyFiles();
  const st = readJsonFile(files.status);
  const state = runState(st, files);
  // 2.59.0 (#11b): a full verify someone else runs in this checkout (the one a refused verify named) is shown too.
  const other = state === 'running' ? null : liveFullVerify();
  if (other) {
    const ofiles = verifyFiles(other.owner || '_default');
    const ost = readJsonFile(ofiles.status);
    console.log(`[verify] the full verify running in this checkout is ${other.owner || '_default'}'s (pid ${other.pid}, started ${ago(other.startedAt)} ago); showing it until it ends`);
    if (other.verifyRun && ost?.runId === other.verifyRun && ost.log) return follow(ost, await printTail(ost.log));
    // Run in its shell's own process (not apart): no log to show here; wait for it to end, then read its record.
    while (liveFullVerify()?.pid === other.pid) await nap(1000);
    const rec = readJsonFile(path.join(root, '.studio', 'gates-last-full.json'));
    const failedIds = (rec?.rows || []).filter((r) => !r.ok && r.required).map((r) => r.id);
    console.log(`[verify] it ended${rec ? `: ${failedIds.length ? `FAIL ${failedIds.join(', ')}` : 'all required gates green'} (recorded ${ago(rec.at)} ago)` : ' (no record found)'}`);
    return rec && !failedIds.length ? 0 : 1;
  }
  if (state === 'none') {
    console.log(`[verify] no verify has run apart for ${verifyOwner} in this checkout yet (${relPath(files.status)}); npm run verify starts one`);
    return 1;
  }
  const what = `the verify for ${verifyOwner}${st.args?.length ? ` (${st.args.join(' ')})` : ''} started ${ago(st.startedAt)} ago`;
  if (state === 'running') {
    console.log(`[verify] ${what} is still running; showing it until it ends`);
    return follow(st, await printTail(st.log));
  }
  if (state === 'done') {
    const res = readJsonFile(files.result);
    const rec = readJsonFile(path.join(root, '.studio', ...(verifyOwner === '_default' ? ['gates-last.json'] : ['gates', `${verifyOwner}.json`])));
    const head = rec?.verifyRun === st.runId && rec.head ? ` on ${rec.head.slice(0, 8)}` : '';
    console.log(`[verify] ${what} finished ${ago(res.endedAt)} ago${head} with exit code ${res.code}${res.stopped ? ' (stopped with Ctrl+C)' : ''}; its output:`);
    await printTail(st.log);
    return Number.isInteger(res.code) ? res.code : 1;
  }
  console.log(`[verify] ${what} stopped before it finished (${st.hostPid ? `its process ${st.hostPid} is gone` : 'it never started'}) and wrote no result: run npm run verify again. Its output so far:`);
  await printTail(st.log);
  return 1;
}

/** 2.72.0 (d): the gate ids after --except (a Set), or null. An id that isn't a gate stops the run (a typo would run it). */
function exceptGates(args, gateList) {
  if (!args.includes('--except')) return null;
  const ids = String(args[args.indexOf('--except') + 1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const known = new Set(gateList.map((g) => g.id));
  const bad = ids.filter((x) => !known.has(x));
  if (!ids.length || bad.length) {
    console.error(`[gates] --except needs gate ids from studio/gates.json${bad.length ? `; not a gate: ${bad.join(', ')}` : ''}`);
    process.exit(2);
  }
  return new Set(ids);
}
