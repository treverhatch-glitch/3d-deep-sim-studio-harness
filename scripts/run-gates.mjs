#!/usr/bin/env node
/**
 * scripts/run-gates.mjs — run every gate in studio/gates.json and report.
 *   node scripts/run-gates.mjs [--required-only] [--only id,id] [--except id,id] [--deep] [--full] [--tier fast|merge|slow] [--no-cache] [--all]
 * In a lane copy the game checks are scoped to the lane's changes; --all runs every one.
 * Exit 1 when a required gate fails. Optional gates are reported as WARN and never fail the run.
 *
 * --tier fast (in-session): only the `lite` gates; a gate whose command and input files are unchanged since its last pass is
 *   skipped (cache keyed by content hash). A fast run never counts as a full verify.
 * --tier merge: a full, deep verify that never reads the cache (same as --full --deep).
 * --tier slow: the game's slow tier only (harness/slow-tier.mjs; nightly). --canaries: each game check on its must-fail
 *   canary (harness/canaries.mjs); report only.
 * --deep (or STUDIO_VERIFY_DEEP=1) runs harness self-checks (npm run release and CI do); --full runs every gate a Full studio
 *   would. An everyday verify (no tier) skips the deep gates and never reads the cache.
 *
 * `npm run verify` runs the gates in a process of its own and shows its log, so killing this one leaves the run going; `--wait`
 *   re-attaches, `--no-detach` runs in this process. Every verify names the tracked files it changed (changedByVerify).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { get, set, del, getKey } from '../harness/gate-cache.mjs';
import { writeAtomic, withFileLock, pidAlive } from '../harness/fsafe.mjs';
import { selfIdentity, liveAs as idAlive } from '../harness/proc-identity.mjs';
import { applyGateEnv, nodeModulesDrift, porcelainZ } from '../harness/gate-env.mjs';
import { createFence, fenceLine } from '../harness/gate-output.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8'));
const argv = process.argv.slice(2);
// `npm run gates -- stats [--days 7] [--json]`: per gate, runs / times red / last red (harness/gate-stats.mjs). Reads events only.
if (argv[0] === 'stats') process.exit(await (await import('../harness/gate-stats.mjs')).gateStatsCli(argv.slice(1), { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }));
// The gates and their children run without code-loading NODE_OPTIONS, with git pointed only at this checkout and replace refs
// ignored (harness/gate-env.mjs). A preload into this process (NODE_OPTIONS=... by hand) already ran: it is named, and recorded.
const gateEnvApplied = applyGateEnv();
if (gateEnvApplied.dropped.length && !process.env.STUDIO_VERIFY_RUN) console.log(`[gates] note: the gates run without ${gateEnvApplied.dropped.join(', ')} (harness/gate-env.mjs)`);
if (gateEnvApplied.preload.length) process.env.STUDIO_VERIFY_PRELOADED = [...new Set([...String(process.env.STUDIO_VERIFY_PRELOADED || '').split(' ').filter(Boolean), ...gateEnvApplied.preload])].join(' ');
if (gateEnvApplied.preload.length) console.log(`[gates] WARN this run was started with NODE_OPTIONS that load code into it (${gateEnvApplied.preload.join(' ')}): its checks run without them, but this process's own exit code can't be trusted; the verify record says nodeOptionsPreload`);

// `npm run verify` starts the run in a process nothing it came from holds (startRun), writes .studio/verify-running/<owner>.json,
// shows the log and exits with its code; if this process is killed the run still writes the verify record (`--wait` re-attaches).
// One run per owner: a second call with the same options attaches, other options wait. Only `npm run verify` detaches by default
// (npm_lifecycle_event); harness callers, CI and the release run in process. --detach or STUDIO_VERIFY_DETACH=on asks for it; =off never.
const SCRIPT = fileURLToPath(import.meta.url);
const VERIFY_DIR = path.join(root, '.studio', 'verify-running');
const verifyOwner = /^[\w.-]+$/.test(process.env.STUDIO_LOCK_OWNER || '') ? process.env.STUDIO_LOCK_OWNER : '_default';
// The full-verify record is keyed by checkout (a lane copy's .studio/ links to main's): main keeps full.json, others full.<hash of real path>.json.
const CHECKOUT = checkoutKey(root);
const FULL_FILE = path.join(VERIFY_DIR, CHECKOUT.file);
{
  const stage = argv.indexOf('--verify-stage');
  if (stage >= 0) process.exit(await verifyStage(argv[stage + 1], argv[stage + 2]));
  // A reviewer never runs the gates (harness/reviewer-scope.mjs).
  if (!process.env.STUDIO_VERIFY_RUN) {
    const rv = (await import('../harness/reviewer-scope.mjs')).verifyRefusal();
    if (rv) { console.error(`[gates] refused: ${rv}. Nothing was run.`); process.exit(1); }
  }
  // `--tier slow` (harness/slow-tier.mjs): never a verify, no verify record.
  if (argv.includes('--tier') && argv[argv.indexOf('--tier') + 1] === 'slow') process.exit(await (await import('../harness/slow-tier.mjs')).slowTierCli(argv, { root }));
  // `--canaries` (harness/canaries.mjs): report only, never a verify, no verify record.
  if (argv.includes('--canaries')) process.exit(await (await import('../harness/canaries.mjs')).canariesCli(argv, { root }));
  const detachEnv = String(process.env.STUDIO_VERIFY_DETACH || '');
  const detach = !argv.includes('--no-detach') && !process.env.STUDIO_VERIFY_RUN && !/^(off|0|false|no)$/i.test(detachEnv)
    && (argv.includes('--detach') || /^(on|1|true|yes)$/i.test(detachEnv) || process.env.npm_lifecycle_event === 'verify');
  const wait = argv.includes('--wait') && !process.env.STUDIO_VERIFY_RUN;
  // Round cap (harness/round-cap.mjs): a task handed back for being red twice on one failure gets no third verify in the session.
  if (!wait && !process.env.STUDIO_VERIFY_RUN) {
    const capWhy = await (await import('../harness/round-cap.mjs')).verifyRefusal();
    if (capWhy) { console.error(`[gates] refused (STUDIO_ROUND_CAP): ${capWhy}. Nothing was run.`); process.exit(1); }
  }
  // A lane copy runs its own committed harness/ and scripts/; if the studio's branch changed them since the lane branched, refuse and
  // name the files and the fix (rebase). A lane's own harness edits don't count. STUDIO_LANE_HARNESS=own runs the lane's copy anyway.
  if (!wait) {
    let d = null;
    try { d = (await import('../harness/hook-stamp.mjs')).laneHarnessDrift(root); } catch {}
    if (d?.files.length) {
      const { laneDriftText, laneHarnessOwn, workerSession } = await import('../harness/hook-stamp.mjs');
      const builder = await workerSession();
      if (laneHarnessOwn()) console.log(`[gates] note: STUDIO_LANE_HARNESS=own: running this lane copy's own harness, ${d.files.length} file(s) behind ${d.branch}`);
      else {
        // A launched worker's lane is refreshed by the harness (main merged in, hooks re-stamped) and the verify runs again; a person or Producer gets the refusal and fix.
        let rf = null;
        if (builder && !process.env.STUDIO_LANE_REFRESHED) {
          try {
            const { refreshStaleLane } = await import('../harness/train-refresh.mjs');
            rf = await refreshStaleLane(d.lane.main, { task: process.env.STUDIO_JOB_TASK || null, agent: path.basename(root), dir: root, branch: null }, { by: 'harness', log: (m) => console.error(m) });
          } catch (e) { rf = { refreshed: false, why: e.message }; }
        }
        if (rf?.refreshed) {
          console.error(`[gates] this lane copy ran an older harness than ${d.branch}; refreshed it (${rf.why}). Running the verify again on the new code.`);
          const again = spawnSync(process.execPath, [process.argv[1], ...argv], { cwd: root, stdio: 'inherit', windowsHide: true, env: { ...process.env, STUDIO_LANE_REFRESHED: '1' } });
          process.exit(again.status ?? 1);
        }
        console.error(`[gates] FAIL not run: ${laneDriftText(d, { builder })}${rf?.why ? ` (the harness tried to refresh it: ${rf.why})` : ''}`);
        process.exit(1);
      }
    }
  }
  if (wait || detach) process.stdout.on('error', () => {}); // a reader that went away (| head) never stops the run
  if (wait) process.exit(await flushed(await waitForVerify()));
  if (detach) process.exit(await flushed(await detachVerify(argv.filter((a) => !['--wait', '--detach', '--no-detach'].includes(a)))));
}
const onlyGiven = argv.includes('--only');
let only = argv.includes('--only') ? new Set(argv[argv.indexOf('--only') + 1].split(',')) : null;
// --except id,id leaves those gates out (CI: `--required-only --deep --except selftest` beside `node qa/selftest.mjs --shard i/N`).
// A partial run, like --only: never a verify record, never the full verify.
const except = exceptGates(argv, cfg.gates || []);
// STUDIO_GATE_FOCUS (a merge train's focused re-check, harness/train-focus.mjs) is read only by an --only run.
const focusRun = Boolean(only && String(process.env.STUDIO_GATE_FOCUS || '').trim());
if (!only) delete process.env.STUDIO_GATE_FOCUS;
const tier = argv.includes('--tier') ? argv[argv.indexOf('--tier') + 1] : null;
const isMergeTier = tier === 'merge';
const isFastTier = tier === 'fast';
const deep = argv.includes('--deep') || process.env.STUDIO_VERIFY_DEEP === '1' || isMergeTier;
const useCache = !(argv.includes('--no-cache') || process.env.STUDIO_GATE_CACHE === '0');

const all = cfg.gates || [];
const runStarted = Date.now();
const DEEP = all.some((g) => 'deep' in g) ? new Set(all.filter((g) => g.deep).map((g) => g.id)) : new Set(['selftest']);
const LITE = all.some((g) => 'lite' in g) ? new Set(all.filter((g) => g.lite).map((g) => g.id)) : new Set(['purity', 'isolation', 'golden', 'regressions', 'playtest', 'secrets']);
const { readMode, scopeOf } = await import('../harness/mode.mjs');
const scope = argv.includes('--full') || deep ? 'full' : scopeOf(readMode());
const skipped = [];
// A studio game that isn't a cartridge: the "game" gate runs its own checks instead of the cartridge gates.
const { studioGame, declaredGates, isEngineChurn } = await import('../harness/game-gates.mjs');
const sg = await studioGame();
const gameOwnsGates = Boolean(sg && declaredGates(sg).length);
// With real cartridges too, the gates that check every cartridge keep running; those that test only the default cartridge stay skipped.
const EVERY_CARTRIDGE_GATES = new Set(['purity', 'isolation', 'golden', 'golden-py', 'regressions', 'vertical-slice', 'soak', 'tick-budget']);
const { listCartridges, isTemplateCartridge } = await import('../harness/cartridge.mjs');
const realCartridges = listCartridges().filter((n) => !isTemplateCartridge(n));
const keepForCartridges = (g) => realCartridges.length > 0 && EVERY_CARTRIDGE_GATES.has(g.id);
// A game with its own build or checks has the game tester (npm run tester) play it; the template's playtest is skipped.
const { stage1Replaced } = await import('../harness/tester-config.mjs');
const stage1 = stage1Replaced();
const gates = all.filter((g) => {
  if (only) return only.has(g.id);
  if (g.id === 'playtest' && g.cartridge && stage1.replaced) return skipped.push(`playtest (${stage1.words})`), false;
  if (gameOwnsGates && g.cartridge && !keepForCartridges(g)) return skipped.push(`${g.id} (cartridge; ${sg.name} runs its own)`), false;
  if (argv.includes('--required-only') && g.required === false) return false;
  if (isFastTier && !LITE.has(g.id)) return false;
  if (!deep && DEEP.has(g.id)) return skipped.push(`${g.id} (deep)`), false;
  if (scope === 'lite' && !LITE.has(g.id) && !isFastTier) return skipped.push(g.id), false;
  return true;
}).filter((g) => !except?.has(g.id) || (skipped.push(`${g.id} (--except)`), false));
if (except) only = new Set(gates.map((g) => g.id));

// A run that takes machine:heavy leads its own process group (POSIX) so `node harness/heavy.mjs stop` kills every gate (Windows: taskkill /T).
const isHeavyGate = (g) => g.heavy === true || (g.heavy !== false && ((g.id === 'game' && sg) || g.id === 'browser-play'));
if ((!only && !isFastTier) || gates.some(isHeavyGate)) {
  const code = await (await import('../harness/heavy.mjs')).heavyOwnGroup();
  if (code !== null) process.exit(code);
}
const { activeCartridge } = await import('../harness/cartridge.mjs');
const active = activeCartridge();
console.log(gameOwnsGates ? `[gates] testing the studio's game "${sg.name}" with its own checks (${declaredGates(sg).map((x) => x.id).join(', ')}); ${realCartridges.length ? `its cartridge${realCartridges.length === 1 ? '' : 's'} (${realCartridges.join(', ')}) get${realCartridges.length === 1 ? 's' : ''} the cartridge gates that check every cartridge, the rest are skipped` : 'the cartridge gates are skipped'}` : `[gates] testing the game "${active.name || 'none'}"${active.from ? ` (from ${active.from})` : ''}; goldens and regressions cover every cartridge`);
// node_modules that don't match package-lock.json are named once; never a failure.
try {
  for (const d of [...new Set([root, sg?.root ? path.resolve(root, sg.root) : null].filter(Boolean))]) {
    const why = nodeModulesDrift(d);
    if (why) console.log(`[gates] WARN node_modules in ${path.relative(root, d).split(path.sep).join('/') || '.'} doesn't match its package-lock.json (a stale install, or changed by hand): ${why}. The checks may not run what the lockfile names: run npm ci there`);
  }
} catch { /* a help, never a failure */ }
// In a lane copy, verify tests what this lane changed against the studio's branch (the scope `task done` uses). --all (or
// STUDIO_GATE_CHANGED set by the caller) overrides. Changes to shared files still run everything.
let changedFiles = null;
let changedBase = null;
if (process.env.STUDIO_GATE_CHANGED) changedFiles = process.env.STUDIO_GATE_CHANGED.split(',').filter(Boolean);
else if (!argv.includes('--all')) {
  try {
    const { inLaneCopy, laneDiff } = await import('../harness/worktree.mjs');
    if (inLaneCopy()) {
      const ld = laneDiff();
      const dirty = porcelainZ(spawnSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { windowsHide: true, cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout || '').map((e) => e.file);
      const files = [...new Set([...(ld?.changed || []), ...dirty])];
      if (files.length) {
        changedFiles = files;
        changedBase = ld?.base || null;
      }
    }
  } catch {
  }
}
if (changedFiles?.length) {
  process.env.STUDIO_GATE_CHANGED = changedFiles.join(',');
  if (!process.env.STUDIO_GATE_PATHS) process.env.STUDIO_GATE_PATHS = changedFiles.join(',');
  console.log(`[gates] scoped to the ${changedFiles.length} file(s) this lane changed${changedBase ? ` since ${changedBase.slice(0, 8)}` : ''}; game checks outside them are skipped (--all runs everything)`);
}
// Gates run for the engine a task is on (harness/gate-tracks.mjs): the tracks of the lane's changed paths plus each task's track
// (STUDIO_VERIFY_TASKS, set by the merge train; else STUDIO_JOB_TASK; else the owner's task); other tracks' gates are named, not
// run. No task track and no diff, a path outside every track, --all, an --only run or STUDIO_GATES_BY_TRACK=off: every gate runs.
let trackRun = null;
{
  const gt = await import('../harness/gate-tracks.mjs');
  let taskIds = String(process.env.STUDIO_VERIFY_TASKS || process.env.STUDIO_JOB_TASK || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!taskIds.length && !onlyGiven) { try { const t = await (await import('../harness/error-memory.mjs')).taskOfOwner(process.env.STUDIO_LOCK_OWNER); if (t) taskIds = [t]; } catch {} }
  let tasks = [];
  try { tasks = await gt.taskTracks(taskIds); } catch { tasks = []; }
  let engines = null;
  try { engines = (await import('../harness/engine-tracks.mjs')).configuredEngines({ root }); } catch {}
  const d = gt.decideTracks({ paths: changedFiles, tasks, all: argv.includes('--all') || onlyGiven, root, engines });
  if (onlyGiven && d.mode === 'all') d.why = '--only names its gates: every gate';
  let split = gt.splitByTrack(gates, d, { root });
  // A change none of whose tracks has a gate here (a docs-only lane, no docs gate) would check nothing: every gate runs instead.
  if (gates.length && !split.run.length) { Object.assign(d, { mode: 'all', covered: '*', why: `no gate here is on ${d.covered.join(', ')}: every gate` }); split = gt.splitByTrack(gates, d, { root }); }
  if (split.notRun.length) {
    const drop = new Set(split.notRun.map((n) => n.id));
    for (let i = gates.length - 1; i >= 0; i--) if (drop.has(gates[i].id)) gates.splice(i, 1);
    for (const n of split.notRun) skipped.push(`${n.id} (${n.tracks.join('+')} track; not for this change)`);
  }
  trackRun = { mode: d.mode, covered: d.covered === '*' ? ['*'] : d.covered, why: d.why, tasks: d.tasks, notRun: split.notRun };
  if (!onlyGiven) console.log(`[gates] ${gt.modeLine(d)}`);
  const nl = gt.notRunLine(split.notRun, d);
  if (nl) console.log(`[gates] ${nl}`);
}
// The owner's task reclassifications in force (harness/reclassify.mjs), shown like approvals, and any on file that doesn't count.
if (fs.existsSync(path.join(root, 'studio', 'task-types.json')) || fs.existsSync(path.join(root, 'studio', 'approvals'))) {
  try {
    const { typeRecordLines } = await import('../harness/reclassify.mjs');
    for (const l of typeRecordLines()) console.log(`[gates] ${l.ok ? 'owner type:' : 'WARN owner type:'} ${l.line}`);
  } catch { /* the list is a help, never a failure */ }
}
// In a sparse lane (harness/lane-sparse.mjs) the files a check reads are put back first; a run still leaving files out doesn't write the gate cache.
let sparseRun = null;
try {
  const ls = await import('../harness/lane-sparse.mjs');
  sparseRun = ls.widenForChecks({ dir: root, needs: gates.filter((g) => g.id !== 'game').map((g) => ({ id: g.id, globs: ls.harnessCheckNeeds(g) })), log: (m) => console.log(m) });
} catch (err) { console.log(`[gates] WARN sparse lane check: ${err.message}`); }
if (skipped.length) console.log(`[gates] ${scope === 'lite' ? 'Lite scope: ' : ''}skipped ${skipped.join(', ')}${skipped.some((x) => x.endsWith('(deep)')) ? '; --deep runs the harness self-checks' : ''}${scope === 'lite' ? '; --full runs every gate' : ''}`);
// One full verify per checkout: the process records itself in .studio/verify-running/full.json (harness/proc-identity.mjs); a second
// full run while it lives is refused; a dead one's record is stale. Partial runs (--only, --tier fast) skip this.
const fullRun = !only && !isFastTier;
if (fullRun) claimFullVerify();
// The full set, or a run with a heavy gate (the game's checks, browser-play, "heavy": true), takes the machine:heavy lock
// (harness/heavy.mjs) for the whole run; it waits, naming the holder, and fails past STUDIO_HEAVY_WAIT_MIN. The slot's handle
// records each gate's shell in its tree on Windows (harness/gate-spawn.mjs).
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
// The record names HEAD from before the first gate; the tree is dirty if it was then or is at the end (.godot/, *.import, *.uid
// don't count). task done trusts a verify only for this commit on a clean tree (harness/done-check.mjs gatesAfter).
const gitOut = (args) => { try { const r = spawnSync('git', args, { windowsHide: true, cwd: root, encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; } catch { return null; } };
// Nor does a file that differs only in line endings (harness/eol-only.mjs).
const { splitEolOnly } = await import('../harness/eol-only.mjs');
const treeDirty = () => { const s = gitOut(['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=no', '--', '.', ':(exclude)studio']); return s === null ? null : splitEolOnly(root, porcelainZ(s).filter((e) => !isEngineChurn(e.file)).map((e) => `${e.xy} ${e.file}`)).real.length > 0; };
const headAtStart = gitOut(['rev-parse', 'HEAD'])?.trim() || null;
// The tree it tests, and what scoped the game gate (paths, related tests only), so task done can accept it for the game checks.
const treeAtStart = headAtStart ? gitOut(['rev-parse', 'HEAD^{tree}'])?.trim() || null : null;
const gatePathsAtStart = String(process.env.STUDIO_GATE_PATHS || '').split(',').filter(Boolean);
const relatedAtStart = (await import('../harness/game-gates.mjs')).relatedTestsOn();
// Untracked files, and ignored files outside build output, under the paths the checks read count as dirty (harness/gate-trust.mjs hiddenInputs).
const trust = await import('../harness/gate-trust.mjs');
// Ignored files the checks wrote in an earlier verify, those a "generated" glob names (studio/gates.json, studio.gates.json) and
// ignored folders of harmless files are output, not hidden inputs. Untracked, root runner and config-like files still count.
const readPaths = [...(sg?.root ? [sg.root] : []), 'cartridges', 'qa', 'harness', 'scripts', 'engine'];
const studioDirOf = path.join(root, '.studio');
const genBefore = trust.readGenerated(studioDirOf, root);
const ignoredBefore = trust.ignoredSnapshot(root, readPaths);
const sameFp = (a, b) => Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1];
const hiddenRep = trust.hiddenReport(root, readPaths, { skip: isEngineChurn, generated: (rel) => Boolean(ignoredBefore) && sameFp(genBefore[rel], ignoredBefore[rel]), globs: trust.generatedGlobs(root, sg?.root || null) });
const hiddenAtStart = hiddenRep ? hiddenRep.hidden : null;
if (hiddenRep?.generated) console.log(`[gates] note: ${hiddenRep.generated} ignored file(s) the checks' own commands generate (written by an earlier verify here, or named by a "generated" glob) count as output, not inputs`);
if (hiddenAtStart?.length) console.log(`[gates] note: ${hiddenRep.count} untracked or ignored file(s) the checks may read (${hiddenAtStart.slice(0, 5).join(', ')}${hiddenRep.count > 5 ? ', …' : ''}): this verify counts as dirty, so it can't stand in for task done's checks or a train's verify. Commit them, or delete them (or add build output to .gitignore under a dist/, build/ or coverage/ folder; files the game's own scripts generate: list them under "generated" in its studio.gates.json).`);
const trackedDirtyAtStart = treeDirty();
const dirtyAtStart = hiddenAtStart?.length ? true : trackedDirtyAtStart;
const { runGateCommand } = await import('../harness/gate-spawn.mjs');
const rows = [];
let cachedCount = 0;
const compact = /^(on|1|true|yes)$/i.test(process.env.STUDIO_COMPACT_OUTPUT || '');
const trackedBefore = trackedSnapshot();
let firstRed = null;
for (const gate of gates) {
  const cacheable = gate.cache !== false && (gate.lite || gate.cache === true);
  let key;
  // Only the fast tier reads the cache (cacheDeep gates also in --deep); everyday verify and the merge tier always run.
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
  // Compact output (STUDIO_COMPACT_OUTPUT=on, set for launched sessions): only a failure's last lines are printed. On Windows the gate's
  // shell is recorded in the heavy holder's tree for `heavy stop`. Every gate's output goes through a fence
  // (harness/gate-output.mjs): kept whole in .studio/gates/out/<gate>.log, at most its first and last STUDIO_GATE_OUTPUT_LINES (200)
  // lines shown, and a line that looks like run-gates' own ([gates] ..., [verify] ...) is shown as `| [gates] ...`.
  const outName = `.studio/gates/out/${String(gate.id).replace(/[^\w.-]/g, '_')}.log`;
  const fence = createFence({ show: compact ? null : (t) => process.stdout.write(t), logName: outName, pick: /^\[game-gates\] WARN game:/ });
  const outTmp = path.join(root, `${outName}.${process.pid}.tmp`);
  const gateEnvFor = gate.id === 'game' && trackRun?.mode === 'by-track' ? { ...process.env, STUDIO_GATE_TRACKS: trackRun.covered.join(',') } : (() => { const e = { ...process.env }; delete e.STUDIO_GATE_TRACKS; return e; })();
  const res = await runGateCommand(gate.command, { cwd: root, compact, lk: heavyLock, outFile: outTmp, onData: (d) => fence.push(d), env: gateEnvFor });
  try { fs.renameSync(outTmp, path.join(root, outName)); } catch { try { fs.rmSync(outTmp, { force: true }); } catch {} }
  const fenced = fence.end();
  if (compact) {
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
  // Sub-ids (game:test:<file>, golden:<file>), files a timeout-only red re-ran green alone, and a red golden's first divergence,
  // read from the gate's output (harness/gate-subids.mjs).
  const facts = await gateRowFacts(gate.id, ok, fenced.text);
  // Exit 3 with a "NOT RUN" line (infrastructure abort, or RAM under the Unity floor) tested nothing: the row says "not run: <why>", still no pass.
  const notRunLine = !ok && res.status === 3 ? (fenced.text.match(/^\[(?:engine|unity|engine-gate|heavy)\] NOT RUN\b[^\n]*/m) || [])[0] : null;
  const notRun = notRunLine ? notRunLine.replace(/^\[[\w-]+\] NOT RUN\s*/, '').replace(/^[^:]*:\s*not run:\s*/, '').slice(0, 300) : null;
  rows.push({ id: gate.id, ok, required, ms, cached: false, cartridge: active.name, ...facts, ...(notRun ? { notRun } : {}) });
  if (!ok && required && !firstRed && !notRun) firstRed = { id: gate.id, text: fenced.text }; // the round cap's signature
  console.log(notRun ? `[gates] NOT RUN ${gate.id}: not run: ${notRun}` : `[gates] ${ok ? 'PASS' : required ? 'FAIL' : 'WARN'} ${gate.id}`);
  if (facts.sub?.length && !(facts.sub.length === 1 && facts.sub[0] === gate.id)) console.log(`[gates] ${gate.id} failed in: ${facts.sub.slice(0, 8).join(', ')}${facts.sub.length > 8 ? ` (+${facts.sub.length - 8} more)` : ''}`);
  if (!ok) console.log(`[gates] ${(await import('../harness/gate-fix.mjs')).gateFixLine(gate, { output: fenced.text, compact })}`); // one next step per failure

  if (cacheable && !isMergeTier && !focusRun && !sparseRun?.partial) {
    if (ok) set(gate, ms);
    else del(gate);
  }
}

{
  const { gateWords } = await import('../harness/gate-words.mjs');
  console.log('\n[gates] in plain words');
  for (const l of gateWords({ rows, skipped, partial: Boolean(only) }, all).lines) console.log(`  ${l}`);
}
if (!compact) console.log('\n[gates] summary');
if (!compact) for (const r of rows) console.log(`  ${r.ok ? 'PASS' : r.notRun ? 'NOT RUN' : r.required ? 'FAIL' : 'WARN'}  ${r.id.padEnd(16)} ${String(r.ms).padStart(6)} ms${r.cached ? ' (cached)' : ''}${r.required ? '' : '  (optional)'}`);
// A verify must not dirty the repo: tracked files outside studio/ that changed during the run are named here and in the record; the exit code is unchanged.
const changedByVerify = changedTracked(trackedBefore, trackedSnapshot());
if (changedByVerify?.length) {
  const shown = changedByVerify.slice(0, 10).join(', ') + (changedByVerify.length > 10 ? ` (+${changedByVerify.length - 10} more)` : '');
  console.log(`\n[gates] WARN this verify changed ${changedByVerify.length} tracked file(s): ${shown}`);
  console.log('[gates]   a check rewrote them (a test snapshot, its line endings, a generated file) or they were edited while it ran; `git diff` shows how. Game checks run with CI=true so test runners never write snapshots: update them on purpose with `-u`, and give generated files `eol=lf` in .gitattributes. Recorded as changedByVerify in the verify record.');
}
// The War Room's gate board reads this file (runtime state).
try {
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  const headNow = headAtStart;
  const dirtyEnd = treeDirty();
  const dirtyNow = dirtyAtStart === null || dirtyEnd === null ? null : dirtyAtStart || dirtyEnd;
  // What made it dirty (the train tells "only ignored, non-config files" from a hidden input or edited tree), and the ignored files the checks wrote.
  const dirtyFrom = dirtyNow ? { tracked: trackedDirtyAtStart === null || dirtyEnd === null ? null : Boolean(trackedDirtyAtStart || dirtyEnd), untracked: hiddenRep?.untracked?.length || 0, config: hiddenRep?.config?.length || 0, ignored: hiddenRep?.ignored?.length || 0 } : null;
  try { if (!only && !isFastTier) trust.writeGenerated(studioDirOf, root, ignoredBefore, trust.ignoredSnapshot(root, readPaths)); } catch {}
  // Every record carries a run id; a full run also writes .studio/gates/runs/<id>.json; reuse needs both to match (harness/gate-trust.mjs recordTrust).
  const runId = /^[\w.-]{6,80}$/.test(process.env.STUDIO_VERIFY_RUN || '') ? process.env.STUDIO_VERIFY_RUN : trust.newRunId();
  const rec = JSON.stringify({ runId, at: new Date().toISOString(), head: headNow, tree: treeAtStart, dirty: dirtyNow, gatePaths: gatePathsAtStart, ...(relatedAtStart ? { related: true } : {}), ...(process.env.STUDIO_GATE_INCOMING_FILE ? { incomingOnly: true } : {}), partial: Boolean(only) || isFastTier, ...(focusRun ? { focus: true } : {}), scope, deep, tier, cachedCount, skipped, cartridge: active.name, rows, ...(changedFiles?.length ? { scoped: true, changed: changedFiles, base: changedBase } : {}), ...(trackRun ? { tracks: trackRun } : {}), ...(changedByVerify ? { changedByVerify } : {}), ...(process.env.STUDIO_VERIFY_RUN ? { verifyRun: process.env.STUDIO_VERIFY_RUN } : {}), ...(hiddenAtStart?.length ? { hidden: hiddenAtStart } : {}), ...(dirtyFrom ? { dirtyFrom } : {}), ...(process.env.STUDIO_VERIFY_PRELOADED ? { nodeOptionsPreload: process.env.STUDIO_VERIFY_PRELOADED.split(' ') } : {}) }, null, 2);
  // The run log is signed with the studio's verify key; unsigned, it is never reused.
  const runLog = !only && !isFastTier ? trust.writeRunLog(path.join(root, '.studio'), JSON.parse(rec), { root: CHECKOUT.real, owner: process.env.STUDIO_LOCK_OWNER || null }) : null;
  if (runLog && !runLog.signed) console.log(`[gates] note: this verify's record is not signed (${runLog.why}), so task done and the train won't reuse it`);
  const owner = process.env.STUDIO_LOCK_OWNER;
  // A checkout whose .studio/ is a link (lane or train copy) is a copy whatever STUDIO_MAIN_ROOT says.
  const inCopy = (Boolean(process.env.STUDIO_MAIN_ROOT) && path.resolve(process.env.STUDIO_MAIN_ROOT) !== root) || CHECKOUT.file !== 'full.json';
  if (!inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last.json'), rec);
  // A full run is kept apart, so an --only run never wipes the full verify a done-check needs.
  if (!only && !isFastTier && !inCopy) fs.writeFileSync(path.join(root, '.studio', 'gates-last-full.json'), rec);
  if (owner && /^[\w.-]+$/.test(owner)) {
    fs.mkdirSync(path.join(root, '.studio', 'gates'), { recursive: true });
    fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}.json`), rec);
    if (!only && !isFastTier) fs.writeFileSync(path.join(root, '.studio', 'gates', `${owner}-full.json`), rec);
  }
  // A clean full verify is also kept by tree (.studio/gates/trees/<tree>.json, newest 64), so the merge train can reuse a lane's green verify.
  if (!only && !isFastTier && !focusRun && treeAtStart && dirtyNow === false && !relatedAtStart && !process.env.STUDIO_GATE_INCOMING_FILE) {
    const tdir = path.join(root, '.studio', 'gates', 'trees');
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, `${treeAtStart}.json`), JSON.stringify({ ...JSON.parse(rec), owner: owner || null, checkout: root }, null, 2));
    try { const old = fs.readdirSync(tdir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(tdir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(64); for (const o of old) fs.rmSync(path.join(tdir, o.n), { force: true }); } catch {}
  }
} catch {
}
try {
  const { emitEvent } = await import('../harness/event.mjs');
  emitEvent({ type: 'gates.run', agent: process.env.STUDIO_LOCK_OWNER || null, msg: `verify: ${rows.filter((r) => r.ok).length}/${rows.length} passed in ${Math.round((Date.now() - runStarted) / 1000)} s${changedFiles?.length ? ` (scoped to ${changedFiles.length} file(s))` : ''}`, meta: { ms: Date.now() - runStarted, scoped: Boolean(changedFiles?.length), partial: Boolean(only) || isFastTier, ran: rows.length, failed: rows.filter((r) => !r.ok && r.required).map((r) => r.id), ...gatesRunFacts(rows), gameMs: rows.find((r) => r.id === 'game')?.ms ?? null, gateMs: Object.fromEntries(rows.filter((r) => !r.cached && Number.isFinite(r.ms)).map((r) => [r.id, r.ms])), ...(changedByVerify?.length ? { changedByVerify } : {}) } });
  // A full verify ends with job.done (harness/jobs.mjs), which `npm run events -- wait` matches.
  if (!only && !isFastTier) {
    const failedIds = rows.filter((r) => !r.ok && r.required).map((r) => r.id);
    const owner = process.env.STUDIO_LOCK_OWNER;
    (await import('../harness/jobs.mjs')).jobDone({ kind: 'verify', id: process.env.STUDIO_VERIFY_RUN || owner || (headAtStart ? String(headAtStart).slice(0, 8) : null), code: !rows.length || failedIds.length ? 1 : 0, ms: Date.now() - runStarted, tail: failedIds.length ? `failed: ${failedIds.join(', ')}` : !rows.length ? 'no gate ran' : '', log: owner && /^[\w.-]+$/.test(owner) ? `.studio/gates/${owner}-full.json` : '.studio/gates-last-full.json', extra: { scoped: Boolean(changedFiles?.length), head: headAtStart || null } });
  }
} catch {
}
if (!only && !isFastTier && rows.length) await (await import('../harness/round-cap.mjs')).verifyRound({ ok: !rows.some((r) => !r.ok && r.required), failGate: firstRed?.id || null, failText: firstRed?.text || '' });
// Error-signature memory (harness/error-memory.mjs): a red is kept as pending; a later green of that gate on the same task records the fix.
try {
  const em = await import('../harness/error-memory.mjs');
  const task = await em.taskOfOwner(process.env.STUDIO_LOCK_OWNER);
  if (task) {
    const outOf = (id) => { try { return fs.readFileSync(path.join(root, '.studio', 'gates', 'out', `${String(id).replace(/[^\w.-]/g, '_')}.log`), 'utf8'); } catch { return ''; } };
    const seen = await em.observeVerify({ task, rows, outputOf: outOf, cwd: root, head: headAtStart });
    for (const f of seen.fixed) console.log(`[gates] note: remembered the fix of ${f.sub || f.gate}'s red for ${task} (${f.commit}; .studio/error-memory.jsonl)`);
    for (const l of em.seenLinesFor(seen.pending.map((x) => x.key))) console.log(`[gates] ${l}`);
  }
} catch {
}
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

// ---- sub-ids, timeout-flakes and first divergences ----

/** { sub, timeoutFlakes, divergence } for one gate's row (only the keys that have something). Never throws. */
async function gateRowFacts(id, ok, text) {
  try {
    const out = {};
    if (!ok) out.sub = (await import('../harness/gate-subids.mjs')).subIdsFor(id, text, { roots: [root] });
    const tf = (await import('../harness/timeout-rerun.mjs')).timeoutFlakesFromLog(text);
    if (Object.keys(tf).length) out.timeoutFlakes = tf;
    if (!ok) { const d = (await import('../harness/divergence.mjs')).divergenceFromLog(text); if (d.length) out.divergence = d.slice(0, 5); }
    // A game:perf step that said "not run (busy)": the merge train re-runs it before reusing the record (harness/train.mjs verifyTree).
    const pn = String(text || '').match(/^\[game-gates\] WARN game:perf: (not run \(busy\)[^\n]*)/m);
    if (pn) out.perfNotRun = pn[1].slice(0, 300);
    return out;
  } catch { return {}; }
}

/** The gates.run event's meta additions: subIds (the required failures' parts), timeoutFlakes, divergence. */
function gatesRunFacts(list) {
  const red = list.filter((r) => !r.ok && r.required);
  const subIds = [...new Set(red.flatMap((r) => (r.sub?.length ? r.sub : [r.id])))].slice(0, 40);
  const tf = Object.assign({}, ...list.map((r) => r.timeoutFlakes || {}));
  const div = red.flatMap((r) => r.divergence || []).slice(0, 5);
  return { ...(subIds.length ? { subIds } : {}), ...(Object.keys(tf).length ? { timeoutFlakes: tf } : {}), ...(div.length ? { divergence: div } : {}) };
}

// ---- tracked files a verify changed ----

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
      // The content too: a file changed before the run and rewritten by a check keeps the same status line.
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

// ---- one full verify per checkout ----

/** This checkout's key for the full-verify record: { real, file }. The main checkout (own .studio/ folder) uses full.json; a lane or train copy (.studio/ is a link) uses full.<12 hex of sha1(real path)>.json. Windows paths compare case-insensitively. */
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
  if (rec.root && rec.root !== CHECKOUT.real) return null; // another checkout's run
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

// ---- the detached run ----
// .studio/verify-running/<owner>.json          { runId, owner, args, startedAt, state, hostPid, runnerPid, log, result }
// .studio/verify-running/<owner>.<runId>.log   the run's output; this run's and the one before
// .studio/verify-running/<owner>.result.json   { runId, code, endedAt }, written when the run ends (never deleted first)

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

async function flushed(code) {
  await new Promise((r) => process.stdout.write('', () => r()));
  return code;
}

async function writeOut(chunk) {
  await new Promise((r) => { try { process.stdout.write(chunk, () => r()); } catch { r(); } });
}

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

function stopRun(hostPid) {
  if (!hostPid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(hostPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { process.kill(-hostPid, 'SIGTERM'); } catch { try { process.kill(hostPid, 'SIGTERM'); } catch {} }
}

async function follow(st, off) {
  const files = verifyFiles(st.owner);
  const t0 = Date.now();
  let checked = Date.now();
  // Ctrl+C at a terminal stops the run too; a killed or closed shell (an agent's) leaves it going, which is the point.
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
 * Start the run so that no process in this one's tree is its parent: a quick hop starts the run's host and exits. A
 * reaper killing this process tree or group doesn't reach the host: on POSIX it has a session of its own; on Windows it
 * is detached, outside the hop's kill-on-close job, and runs the gates in a hidden console (no window opens).
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
  // The host runs the gates (this script, --no-detach, in a child) and writes the result.
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
    // On Windows the output comes through pipes: with no handle inherited, windowsHide gives the gates a console with no window at all (CREATE_NO_WINDOW).
    const piped = process.platform === 'win32';
    const r = spawn(process.execPath, [SCRIPT, '--no-detach', ...(st.args || [])], { cwd: root, env: { ...process.env, STUDIO_VERIFY_RUN: st.runId }, stdio: piped ? ['ignore', 'pipe', 'pipe'] : ['ignore', fd, fd], windowsHide: true });
    if (piped) for (const s of [r.stdout, r.stderr]) s.on('data', (d) => { try { fs.writeSync(fd, d); } catch {} });
    r.on('error', (e) => finish(1, `could not start the gates: ${e.message}`));
    let exited = null;
    // A process a gate left running can hold the pipes open, so wait 2 s at most.
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
  // A full verify someone else runs in this checkout (the one a refused verify named) is shown too.
  const other = state === 'running' ? null : liveFullVerify();
  if (other) {
    const ofiles = verifyFiles(other.owner || '_default');
    const ost = readJsonFile(ofiles.status);
    console.log(`[verify] the full verify running in this checkout is ${other.owner || '_default'}'s (pid ${other.pid}, started ${ago(other.startedAt)} ago); showing it until it ends`);
    if (other.verifyRun && ost?.runId === other.verifyRun && ost.log) return follow(ost, await printTail(ost.log));
    // Run in its shell's own process (not apart): no log here; wait for it to end, then read its record.
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

/** The gate ids after --except (a Set), or null. An id that isn't a gate stops the run (a typo would run it). */
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
