/**
 * qa/selftest-272c.mjs — 2.72.0 (c): engine gates that prove they ran, the state probe, the completeness rubric and the
 * error-signature memory. A made-up studio, a made-up game, a stand-in Unity editor and a stand-in gdUnit4 runner;
 * every check fails on 2.71.1.
 *   1. Engine gates (harness/engine-proof.mjs, unity.mjs judgeRun, godot-unit.mjs judgeGodotRun): a stale results file,
 *      compile errors or a batch-mode abort next to green results, an exit code that disagrees with the results, and
 *      a reused gdUnit4 report folder are red, each with its own plain-words and Fix line; allowEmpty allows 0 tests.
 *   2. The state probe (harness/state-probe.mjs, game:state-probe): digests at the declared ticks against main's
 *      baseline; a change with no Golden-Reason is red with the first differing tick.
 *   3. The completeness rubric (harness/contracts.mjs): test-name criteria are checked, manual ones are listed as
 *      "unverified, for the reviewer"; in a lane they hold the lane at tier C until a reviewer signs them.
 *   4. Error-signature memory (harness/error-memory.mjs): a red fixed on one task shows as "seen before" on the next.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest272C({ dir, run, report, tmpRoot }) {
  const TRAIN_QUEUE = path.join('.studio', 'train', 'queue.json');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const T = path.join(tmpRoot, `s272c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const w = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_TEST_LOADAVG: '0', STUDIO_MACHINE_SCAN: 'off', STUDIO_UNITY: '', STUDIO_UNITY_PIN: '', STUDIO_UNITY_LIBRARY_CACHE: 'off', STUDIO_UNITY_CODE_ONLY: '', STUDIO_DOTNET: '', STUDIO_UNITY_ACCELERATOR: '', STUDIO_UNITY_EDITMODE_REUSE: '', STUDIO_UNITY_ONE_EDITOR: '', STUDIO_UNITY_GRAPHICS_SPLIT: '', STUDIO_SILENT_GREEN: '', STUDIO_GAME: '', STUDIO_TRAIN: '', STUDIO_ERROR_MEMORY: '', STUDIO_ERROR_MEMORY_MAX: '', STUDIO_STATE_PROBE_BASE: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_WEAKENED_TESTS: '', STUDIO_PROTECT_BASE: '', STUDIO_OWNER_KEY: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-272c.jsonl'), GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-272c-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...base, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || e.message); } };

  // ---------- 1. engine gates prove they ran ----------
  const jr = probe('judge', `import fs from 'node:fs';
import path from 'node:path';
import { judgeRun } from ${u('harness/unity.mjs')};
const d = ${JSON.stringify(T)};
const f = path.join(d, 'TestResults-EditMode-x.xml');
const pass = '<test-run total="3" passed="3" failed="0" skipped="0" result="Passed"></test-run>';
fs.writeFileSync(f, pass);
const old = new Date(Date.now() - 3600000); fs.utimesSync(f, old, old);
const start = Date.now();
const stale = judgeRun('EditMode', f, '', 0, { startedAt: start });
fs.writeFileSync(f, pass);
const compile = judgeRun('EditMode', f, 'Assets/Scripts/Belt.cs(4,9): error CS0103: The name x does not exist', 0, { startedAt: start });
const aborted = judgeRun('PlayMode', f, 'Aborting batchmode due to failure:\\nExecuting method failed', 0, { startedAt: start });
const mismatch = judgeRun('EditMode', f, '', 1, { startedAt: start });
const killed = judgeRun('EditMode', f, '', null, { startedAt: start, signal: 'SIGTERM' });
const clean = judgeRun('EditMode', f, '', 0, { startedAt: start });
fs.writeFileSync(f, '<test-run total="0" passed="0" failed="0" skipped="0" result="Passed"></test-run>');
const empty = judgeRun('PlayMode', f, '', 0, { startedAt: start });
const allowed = judgeRun('PlayMode', f, '', 0, { startedAt: start, allowEmpty: true });
const k = (r) => (r.proof || []).map((p) => p.kind);
console.log(JSON.stringify({ stale: [stale.ok, k(stale)], compile: [compile.ok, k(compile)], aborted: [aborted.ok, k(aborted)], mismatch: [mismatch.ok, k(mismatch), mismatch.problems.join(' | ')], killed: [killed.ok, k(killed)], clean: clean.ok, empty: [empty.ok, k(empty)], allowed: [allowed.ok, allowed.note || ''] }));`);
  guard('2.72.0 (c)(1): the Unity results judge needs proof the run ran: a results file older than the run is stale-results, compile errors or "Aborting batchmode" next to green results fail, a non-zero exit or a kill behind green results is exit-mismatch, 0 tests fail unless allowEmpty; a clean fresh run passes', () => [
    jr.stale?.[0] === false && jr.stale[1].includes('stale-results') && jr.compile?.[0] === false && jr.compile[1].includes('compile-error')
      && jr.aborted?.[0] === false && jr.aborted[1].includes('aborted') && jr.mismatch?.[0] === false && jr.mismatch[1].includes('exit-mismatch') && /exited 1 but its results say every test passed/.test(jr.mismatch[2])
      && jr.killed?.[0] === false && jr.killed[1].includes('exit-mismatch') && jr.clean === true && jr.empty?.[0] === false && jr.empty[1].includes('empty-run') && jr.allowed?.[0] === true && /allowEmpty/.test(jr.allowed[1]),
    JSON.stringify(jr).slice(0, 2500)]);

  const fx = probe('fix', `import { gateFix, fixCoverage, ENGINE_FIXES } from ${u('harness/gate-fix.mjs')};
import { PROOF_KINDS } from ${u('harness/engine-proof.mjs')};
const f = gateFix({ id: 'game' }, { output: '[game-gates] running engine\\n[engine-gate] FAIL exit-mismatch (unity): EditMode: the run exited 1\\n' });
const g = gateFix({ id: 'godot-unit' }, { output: '[engine-gate] FAIL stale-results (godot): this run wrote no new report folder' });
console.log(JSON.stringify({ f, g, all: PROOF_KINDS.every((k) => ENGINE_FIXES[k]), cov: fixCoverage().ok }));`);
  guard('2.72.0 (c)(1): every engine-gate failure kind has its own Fix line (harness/gate-fix.mjs ENGINE_FIXES), and a gate whose output carries "[engine-gate] FAIL <kind>" gets that kind\'s Fix (Unity or Godot rerun), not the generic one', () => [
    fx.f?.source === 'engine-check' && /exit code and the results disagree/.test(fx.f.text) && /unity\.mjs gate/.test(fx.f.text) && fx.g?.source === 'engine-check' && /written before this run started/.test(fx.g.text) && /godot-unit/.test(fx.g.text) && fx.all === true && fx.cov === true,
    JSON.stringify(fx).slice(0, 1500)]);

  if (process.platform === 'win32') {
    report('2.72.0 (c)(1): the stand-in Unity editor and gdUnit4 runner checks (skipped on Windows: POSIX scripts)', true, '');
  } else {
    // A made-up Unity project and a stand-in editor that writes green results, then aborts batch mode and exits 1.
    const p = path.join(T, 'unity', 'tinygame');
    w(p, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.1f1\n');
    w(p, 'Assets/Sim/Sim.asmdef', JSON.stringify({ name: 'Sim', noEngineReferences: true }));
    w(p, 'Assets/Sim/Rules.cs', 'namespace Sim { public static class Rules { public static int Add(int a, int b) => a + b; } }\n');
    const seenF = path.join(T, 'unity-seen.jsonl');
    const planF = path.join(T, 'unity-plan.txt');
    const fake = path.join(T, 'fake-unity.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const at = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
fs.appendFileSync(${JSON.stringify(seenF)}, JSON.stringify({ results: at('-testResults') }) + '\\n');
const plan = fs.existsSync(${JSON.stringify(planF)}) ? fs.readFileSync(${JSON.stringify(planF)}, 'utf8').trim() : 'pass';
fs.writeFileSync(at('-testResults'), '<test-run total="2" passed="2" failed="0" skipped="0" result="Passed"></test-run>');
if (plan === 'abort') { console.log('Aborting batchmode due to failure:'); console.log('Exception in StudioSetup.Init'); process.exit(1); }
`);
    fs.chmodSync(fake, 0o755);
    const uenv = { ...base, STUDIO_UNITY: fake };
    fs.writeFileSync(planF, 'abort');
    const ab = run(dir, `node harness/unity.mjs gate "${p}" --platform EditMode`, uenv);
    const seen1 = fs.existsSync(seenF) ? fs.readFileSync(seenF, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    fs.writeFileSync(planF, 'pass');
    const ok = run(dir, `node harness/unity.mjs gate "${p}" --platform EditMode`, uenv);
    const left = fs.readdirSync(p).filter((n) => /^TestResults-/.test(n));
    report('2.72.0 (c)(1): the Unity gate with a stand-in editor that writes green results, then prints "Aborting batchmode" and exits 1, is red with "[engine-gate] FAIL aborted" and "exit-mismatch" lines and their Fix lines; the results file it was told to write carries this run\'s nonce; a clean run passes and leaves only its own results file',
      ab.status === 1 && /\[engine-gate\] FAIL aborted \(unity\): EditMode: the editor aborted batch mode/.test(out(ab)) && /\[engine-gate\] FAIL exit-mismatch \(unity\)/.test(out(ab)) && /\[engine-gate\] Fix: the editor aborted batch mode/.test(out(ab))
        && /TestResults-EditMode-[0-9a-z]+-[0-9a-f]{8}\.xml$/.test(seen1[0]?.results || '') && ok.status === 0 && /PASS the editor's tests \(Edit Mode\)/.test(out(ok)) && left.length === 1,
      `${out(ab).slice(-1500)}\n---\n${JSON.stringify(seen1)}\n---\n${out(ok).slice(-600)}\n${left.join(',')}`);

    // gdUnit4: a report folder that existed before the run (only touched by it), and a fresh report that fails while the runner exits 0.
    const g = path.join(dir, 'gtest272c');
    w(g, 'project.godot', '[application]\nconfig/name="gtest272c"\n');
    fs.mkdirSync(path.join(g, 'addons', 'gdUnit4'), { recursive: true });
    w(g, 'reports/report_1/results.xml', '<testsuites><testsuite name="Old"><testcase name="test_old" classname="Old"/></testsuite></testsuites>');
    const sh = path.join(g, 'addons', 'gdUnit4', 'runtest.sh');
    fs.writeFileSync(sh, '#!/bin/sh\ntouch reports/report_1/results.xml reports/report_1\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'fake-godot-272c'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const cfgF = path.join(dir, 'studio', 'godot-unit.json');
    const hadCfg = fs.existsSync(cfgF) ? fs.readFileSync(cfgF, 'utf8') : null;
    const cfg = (extra = {}) => fs.writeFileSync(cfgF, JSON.stringify({ enabled: true, project: 'gtest272c', tests: 'res://test', gdunit: 'v6.2.2', godot: '4.7.2', watch: ['sim'], ...extra }));
    cfg();
    const genv = { ...base, GODOT_BIN: path.join(dir, 'fake-godot-272c'), STUDIO_GODOT_UNIT_ALL: '1' };
    const reused = run(dir, 'node harness/godot-unit.mjs', genv);
    const failing = '<testsuites><testsuite name="Belt"><testcase name="test_count" classname="Belt"><failure message="expected 3 bags"/></testcase></testsuite></testsuites>';
    fs.writeFileSync(sh, `#!/bin/sh\nmkdir -p reports/report_2\ncat > reports/report_2/results.xml <<'X'\n${failing}\nX\nexit 0\n`, { mode: 0o755 });
    const lying = run(dir, 'node harness/godot-unit.mjs', genv);
    fs.writeFileSync(sh, `#!/bin/sh\nmkdir -p reports/report_3\necho '<testsuites></testsuites>' > reports/report_3/results.xml\nexit 0\n`, { mode: 0o755 });
    const emptyRed = run(dir, 'node harness/godot-unit.mjs', genv);
    cfg({ allowEmpty: true });
    fs.writeFileSync(sh, `#!/bin/sh\nmkdir -p reports/report_4\necho '<testsuites></testsuites>' > reports/report_4/results.xml\nexit 0\n`, { mode: 0o755 });
    const emptyOk = run(dir, 'node harness/godot-unit.mjs', genv);
    if (hadCfg === null) fs.rmSync(cfgF, { force: true }); else fs.writeFileSync(cfgF, hadCfg);
    fs.rmSync(g, { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'fake-godot-272c'), { force: true });
    report('2.72.0 (c)(1): the Godot unit gate counts only a report folder this run made (an older one it merely touched is stale-results), fails a fresh report with a failing test even when gdUnit4 exits 0 (test-failed, exit-mismatch), fails 0 tests by default (empty-run) and passes them with "allowEmpty": true; each red has its Fix line',
      reused.status !== 0 && /\[engine-gate\] FAIL stale-results \(godot\)/.test(out(reused)) && /\[engine-gate\] Fix: /.test(out(reused))
        && lying.status !== 0 && /FAIL test-failed \(godot\): 1 test\(s\) failed: Belt::test_count/.test(out(lying)) && /FAIL exit-mismatch \(godot\)/.test(out(lying))
        && emptyRed.status !== 0 && /FAIL empty-run \(godot\)/.test(out(emptyRed)) && emptyOk.status === 0 && /allowEmpty/.test(out(emptyOk)) && /PASS \(exit code 0, 0 test\(s\)\)/.test(out(emptyOk)),
      [reused, lying, emptyRed, emptyOk].map((r) => out(r).slice(-700)).join('\n---\n'));
  }

  // ---------- the studio as a git checkout (for the probe, the contracts and the memory) ----------
  const git = (cmd, e = {}) => run(dir, `git -c user.name=hatch -c user.email=owner@example.com ${cmd}`, { ...base, ...e });
  const gameF = path.join(dir, 'studio', 'game.json');
  const hadGame = fs.existsSync(gameF) ? fs.readFileSync(gameF, 'utf8') : null;
  git('init -q -b main');
  git('config core.autocrlf false');
  // ---------- 2. the state probe ----------
  fs.writeFileSync(gameF, JSON.stringify({ ...(hadGame ? JSON.parse(hadGame) : {}), game: 'zz-belt' }, null, 2));
  w(dir, 'game/zz-belt/studio.gates.json', JSON.stringify({ gates: [{ id: 'qa', command: 'node -e "process.exit(0)"' }], stateProbe: { command: 'node game/zz-belt/tools/probe.mjs --ticks {ticks}', ticks: [0, 100, 1000] } }, null, 2));
  w(dir, 'game/zz-belt/sim/rule.json', JSON.stringify({ speed: 2 }));
  w(dir, 'game/zz-belt/tools/probe.mjs', `import fs from 'node:fs';
import crypto from 'node:crypto';
const ticks = process.argv[process.argv.indexOf('--ticks') + 1].split(',').map(Number);
const { speed } = JSON.parse(fs.readFileSync('game/zz-belt/sim/rule.json', 'utf8'));
for (const t of ticks) console.log('tick ' + t + ' ' + crypto.createHash('sha1').update(String(Math.min(t, 50) * speed)).digest('hex').slice(0, 12));
`);
  // In this one checkout the lane is a branch, so main is named (a lane copy compares with the main checkout's branch).
  const pbase = { ...base, STUDIO_STATE_PROBE_BASE: 'main' };
  const rec = run(dir, 'node harness/state-probe.mjs record', base);
  git('add -A');
  git('commit -q -m base --no-verify');
  git('checkout -q -b lane-272c');
  const same = run(dir, 'node harness/state-probe.mjs', pbase);
  w(dir, 'game/zz-belt/sim/rule.json', JSON.stringify({ speed: 3 }));
  git('commit -q -am "faster belt" --no-verify');
  const red = run(dir, 'node harness/state-probe.mjs', pbase);
  git('commit -q --allow-empty --no-verify -m "belt speed" -m "Golden-Reason: the belt moves faster on purpose"');
  const unrecorded = run(dir, 'node harness/state-probe.mjs', pbase);
  run(dir, 'node harness/state-probe.mjs record', base);
  git('commit -q -am "record the probe" --no-verify');
  const onPurpose = run(dir, 'node harness/state-probe.mjs', pbase);
  const decl = probe('decl', `import { declaredGates } from ${u('harness/game-gates.mjs')};
console.log(JSON.stringify({ ids: declaredGates({ name: 'zz-belt', root: 'game/zz-belt', sim: 'game/zz-belt/sim' }).map((g) => g.id) }));`);
  git('checkout -q main');
  report('2.72.0 (c)(2): the state probe: record writes main\'s baseline; the same build matches it; a sim change with no Golden-Reason is red naming the first differing tick (100, not 0); with a Golden-Reason but no new recording still red; recorded and committed it passes as changed on purpose; the game\'s checks list game:state-probe',
    rec.status === 0 && same.status === 0 && /matches main's at tick\(s\) 0, 100, 1000/.test(out(same))
      && red.status === 1 && /changed with no Golden-Reason: first differing tick 100 \(main /.test(out(red)) && /2 of 3 tick\(s\) differ: 100, 1000/.test(out(red))
      && unrecorded.status === 1 && /doesn't hold the new digests/.test(out(unrecorded)) && onPurpose.status === 0 && /changed on purpose/.test(out(onPurpose))
      && (decl.ids || []).includes('game:state-probe'),
    [rec, same, red, unrecorded, onPurpose].map((r) => out(r).slice(-500)).join('\n---\n') + JSON.stringify(decl).slice(0, 400));
  if (hadGame === null) fs.rmSync(gameF, { force: true }); else fs.writeFileSync(gameF, hadGame);
  fs.rmSync(path.join(dir, 'game', 'zz-belt'), { recursive: true, force: true });

  // ---------- 3. the completeness rubric ----------
  const PROD = { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s3' };
  const REVIEWER = { STUDIO_ROLE: 'reviewer', STUDIO_LOCK_OWNER: 'reviewer-s4' };
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...base, ...e });
  const id = (() => { try { return JSON.parse(task('add "Add the belt bag counter" --role builder').stdout).id; } catch { return null; } })();
  w(dir, 'tests/belt-272c.test.mjs', "import test from 'node:test';\ntest('the belt counts bags', () => {});\ntest.skip('the belt jams', () => {});\n");
  task(`contract ${id} add "A test proves the belt counts bags" --test "the belt counts bags"`, PROD);
  task(`contract ${id} add "The counter reads well at a glance" --manual`, PROD);
  task(`contract ${id} add "The counter has a tooltip" --manual --should`, PROD);
  task(`contract ${id} add "A test covers a jam" --test "the belt jams" --should`, PROD);
  task(`contract ${id} agree`, PROD);
  const dc = out(run(dir, `node harness/done-check.mjs ${id}`, base));
  const rub = probe('rubric', `import { contractChecks, unverifiedMust, contractForReview } from ${u('harness/contracts.mjs')};
import { laneTier, holdLane, readQueue, clearContractHolds, enqueue } from ${u('harness/train.mjs')};
import { spawnSync } from 'node:child_process';
const id = ${JSON.stringify(id)};
const t = { id, title: 'Add the belt bag counter', role: 'builder' };
const lane = contractChecks(t, 'change', { defer: true });
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const tier = await laneTier(process.cwd(), { head, task: id });
const e = enqueue(process.cwd(), { task: id, agent: 'builder-s9', dir: process.cwd(), branch: 'main', head, note: '' });
holdLane(process.cwd(), { ...e, head }, { tier: 'C', why: tier.why.join('; ') });
console.log(JSON.stringify({ laneFailing: lane.checks.filter((c) => !c.ok).map((c) => c.label), unverified: lane.unverified.map((x) => x.id + ':' + x.must), must: unverifiedMust(id).map((x) => x.id), tier: tier.tier, why: tier.why, review: contractForReview(id) }));`);
  task(`contract ${id} sign C2 pass --by reviewer-s4`, REVIEWER);
  const after = probe('rubric2', `import { unverifiedMust } from ${u('harness/contracts.mjs')};
import { laneTier, readQueue, clearContractHolds } from ${u('harness/train.mjs')};
import { spawnSync } from 'node:child_process';
const id = ${JSON.stringify(id)};
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const tier = await laneTier(process.cwd(), { head, task: id });
const heldBefore = Boolean(readQueue(process.cwd()).find((x) => x.task === id)?.held);
clearContractHolds(process.cwd(), readQueue(process.cwd()).map((l) => ({ ...l, fromQueue: true })));
const heldAfter = Boolean(readQueue(process.cwd()).find((x) => x.task === id)?.held);
console.log(JSON.stringify({ must: unverifiedMust(id).map((x) => x.id), tier: tier.tier, heldBefore, heldAfter }));`);
  try { fs.rmSync(path.join(dir, TRAIN_QUEUE), { force: true }); } catch {}
  report('2.72.0 (c)(3): the completeness rubric: a criterion tied to a test name passes when that test is defined (a skipped one is not), a manual must-item still blocks done in the main checkout and is listed "unverified, for the reviewer" with the should-items, which never block; in a lane (defer) it doesn\'t block done but makes the lane tier C ("unverified must-items") until a reviewer signs it, which clears the hold; the reviewer\'s brief marks it UNVERIFIED',
    Boolean(id) && /\[x\] Contract C1: A test proves the belt counts bags \(test\)/.test(dc) && /\[ \] Contract C2: The counter reads well/.test(dc) && !/Contract C3/.test(dc) && !/\[.\] Contract C4/.test(dc)
      && /unverified, for the reviewer: C2 \(must\) .*C3 \(should\)/.test(dc) && /should-items not met .*C4 \(the test "the belt jams" is skipped/.test(dc)
      && Array.isArray(rub.laneFailing) && rub.laneFailing.length === 0 && (rub.unverified || []).join(',') === 'C2:true,C3:false' && (rub.must || []).join(',') === 'C2'
      && rub.tier === 'C' && /acceptance contract has unverified must-items \(C2: a reviewer signs them/.test((rub.why || []).join('; ')) && /C2: The counter reads well .*UNVERIFIED/.test(rub.review || '')
      && (after.must || []).length === 0 && after.tier !== 'C' && after.heldBefore === true && after.heldAfter === false,
    `${dc.slice(-1400)}\n---\n${JSON.stringify(rub).slice(0, 1500)}\n---\n${JSON.stringify(after).slice(0, 600)}`);

  // ---------- 4. error-signature memory ----------
  const mem = probe('memory', `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { observeVerify, readMemory, rememberFix, seenBefore } from ${u('harness/error-memory.mjs')};
import { recordGateRefusal, buildFacts, renderFacts } from ${u('harness/handback-facts.mjs')};
import { kickoffParts } from ${u('harness/kickoff.mjs')};
const git = (...a) => spawnSync('git', ['-c', 'user.name=hatch', '-c', 'user.email=owner@example.com', ...a], { encoding: 'utf8' });
const headNow = () => git('rev-parse', 'HEAD').stdout.trim();
const redText = (n) => '[game-gates] FAIL game:qa\\n  AssertionError: expected ' + n + ' bags on the belt, got ' + (n - 1) + '\\n';
fs.mkdirSync('game/zz-mem/sim', { recursive: true });
fs.writeFileSync('game/zz-mem/sim/belt.mjs', 'export const bags = (n) => n - 1;\\n');
git('add', '-A'); git('commit', '-q', '--no-verify', '-m', 'belt');
const redHead = headNow();
const r1 = await observeVerify({ task: 'T-9701', rows: [{ id: 'game', ok: false, required: true }, { id: 'docs', ok: true, required: true }], outputOf: () => redText(3), cwd: process.cwd(), head: redHead });
fs.writeFileSync('game/zz-mem/sim/belt.mjs', 'export const bags = (n) => n;\\n');
git('commit', '-q', '--no-verify', '-am', 'count every bag on the belt');
const fixHead = headNow().slice(0, 8);
const g1 = await observeVerify({ task: 'T-9701', rows: [{ id: 'game', ok: true, required: true }], outputOf: () => '', cwd: process.cwd(), head: headNow() });
// Another task meets the same red (other numbers): its hand-back facts and its kickoff say how it was fixed.
recordGateRefusal('T-9702', { gates: [{ id: 'game', ok: false }], text: redText(7) });
const facts = renderFacts(buildFacts('T-9702', {}));
await observeVerify({ task: 'T-9702', rows: [{ id: 'game', ok: false, required: true }], outputOf: () => redText(9), cwd: process.cwd(), head: headNow() });
const kick = kickoffParts({ role: 'builder', agent: 'builder-m2', model: 'x', task: 'T-9702' }).volatile;
// A different red is not "seen before".
const other = await observeVerify({ task: 'T-9703', rows: [{ id: 'game', ok: false, required: true }], outputOf: () => '[game-gates] FAIL game:qa\\n  TypeError: belt is undefined\\n', cwd: process.cwd(), head: headNow() });
const otherSeen = seenBefore(other.pending[0]?.key);
// The cap: the newest STUDIO_ERROR_MEMORY_MAX keys are kept.
for (let i = 0; i < 5; i++) rememberFix({ key: 'k' + i, gate: 'x', commit: 'c' + i, files: [], summary: 's' }, { max: 3 });
const keys = readMemory().map((e) => e.key);
console.log(JSON.stringify({ pending: r1.pending.length, fixed: g1.fixed.map((f) => ({ commit: f.commit, files: f.files, summary: f.summary, sub: f.sub })), fixHead, facts, kick, otherSeen, keys }));`);
  report('2.72.0 (c)(4): error-signature memory: a red on a task, then a green of that gate on the same task, records the fix (its commit, subject and changed files; the game check\'s sub-id); a later red with the same signature on another task shows "Seen before: fixed in <commit> by changing <files> (<summary>)" in its hand-back facts and its kickoff; a different red doesn\'t; the memory keeps the newest N',
    mem.pending === 1 && mem.fixed?.length === 1 && mem.fixed[0].commit === mem.fixHead && mem.fixed[0].files.join(',') === 'game/zz-mem/sim/belt.mjs' && mem.fixed[0].summary === 'count every bag on the belt' && mem.fixed[0].sub === 'game:qa'
      && new RegExp(`- Seen before: fixed in ${mem.fixHead} by changing game/zz-mem/sim/belt\\.mjs \\(count every bag on the belt\\)`).test(mem.facts || '')
      && new RegExp(`T-9702's failure was seen before \\(game:qa\\): fixed in ${mem.fixHead}`).test(mem.kick || '') && mem.otherSeen === null && (mem.keys || []).join(',') === 'k2,k3,k4',
    JSON.stringify(mem).slice(0, 2500));

  // The verify itself (scripts/run-gates.mjs) feeds the memory for the owner's claimed task.
  const gatesF = path.join(dir, 'studio', 'gates.json');
  const hadGates = fs.readFileSync(gatesF, 'utf8');
  fs.writeFileSync(path.join(dir, 'zz-gate-272c.mjs'), "import fs from 'node:fs';\nif (!fs.existsSync('zz-fixed-272c.txt')) { console.log('AssertionError: the belt lost 2 bags'); process.exit(1); }\nconsole.log('ok');\n");
  fs.writeFileSync(gatesF, JSON.stringify({ cartridge: JSON.parse(hadGates).cartridge, gates: [{ id: 'zz-belt', command: 'node zz-gate-272c.mjs', required: true, fix: 'fix the belt' }] }, null, 2));
  const owner = { STUDIO_LOCK_OWNER: 'builder-m3' };
  run(dir, 'node harness/lock.mjs claim task:T-9711 --owner builder-m3', { ...base, ...owner });
  const v1 = run(dir, 'node scripts/run-gates.mjs --only zz-belt', { ...base, ...owner });
  fs.writeFileSync(path.join(dir, 'zz-fixed-272c.txt'), 'fixed\n');
  git('add zz-fixed-272c.txt zz-gate-272c.mjs');
  git('commit -q --no-verify -m "put the lost bags back"');
  const v2 = run(dir, 'node scripts/run-gates.mjs --only zz-belt', { ...base, ...owner });
  fs.writeFileSync(gatesF, hadGates);
  run(dir, 'node harness/lock.mjs release task:T-9711 --owner builder-m3', { ...base, ...owner });
  const memAfter = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'error-memory.jsonl'), 'utf8'); } catch { return ''; } })();
  report('2.72.0 (c)(4): a verify (scripts/run-gates.mjs) on the owner\'s claimed task keeps its red as pending and the next green of that gate records the fix in .studio/error-memory.jsonl with the fixing commit\'s subject',
    v1.status !== 0 && v2.status === 0 && /remembered the fix of zz-belt's red for T-9711/.test(out(v2)) && /"task":"T-9711"/.test(memAfter) && /put the lost bags back/.test(memAfter),
    `${out(v1).slice(-600)}\n---\n${out(v2).slice(-800)}\n---\n${memAfter.slice(-600)}`);
  for (const f of ['zz-gate-272c.mjs', 'zz-fixed-272c.txt']) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
}
