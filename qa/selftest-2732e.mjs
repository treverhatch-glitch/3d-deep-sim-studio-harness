/**
 * qa/selftest-2732e.mjs — 2.73.2 (helper e, B-73): a Unity run waits for a free-RAM floor, and an infrastructure abort is
 * "not run", never a FAIL of the game's tests.
 *   floor     STUDIO_UNITY_MIN_FREE_GB (12) never above 60% of the RAM; `heavy run --kind unity` waits for it and exits 3
 *             ("NOT RUN") when the wait runs out, without starting the command
 *   cli       `npm run heavy -- wait` (floor + slot, exit 0 / 3), `wait --hold <label>` keeps the slot in the background
 *             until `release --label <label>`, so other heavy work waits meanwhile
 *   gate      harness/unity.mjs gate with a stand-in editor: out of memory, "Aborting batchmode" before any results and an
 *             editor ended from outside are NOT RUN (exit 3, "[engine-gate] NOT RUN <kind>" with a Fix line); a failing
 *             test or a compile error next to the same signs stays FAIL; free RAM under the floor never starts the editor
 *   land      harness/unity-gate.mjs: a red land run whose output shows an infrastructure abort is status not-run (exit 3)
 *             in unity-last.json, the engine.land event and studio/engine/LOG.md; a failing test keeps it red; under
 *             the floor the land command never starts
 *   train     the Unity train retries a not-run land run and then defers the branch: nobody is handed back
 *   rows      a verify gate that exits 3 with a NOT RUN line is "NOT RUN <id>: not run: <why>" in its row and the plain
 *             words, not FAILING; the Fix for "[engine-gate] NOT RUN out-of-memory" is that kind's own
 * Every check fails on 2.73.1 (no floor, no wait/hold/release, infrastructure aborts recorded as FAIL / red), except the
 * two "stays FAIL" guards, which pass on both (they keep the fix from hiding a real failure).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2732E({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const T = path.join(tmpRoot, `s2732e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const w = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evFile = path.join(dir, '.studio', 'events-2732e.jsonl');
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100',
    STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_HEAVY_OWN_GROUP: '', STUDIO_HEAVY_REEXEC: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '',
    STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_TEST_FREEMEM_MB: '', STUDIO_TEST_MACHINE: '', STUDIO_UNITY_MIN_FREE_GB: '', STUDIO_TEST_LOADAVG: '0', STUDIO_MACHINE_SCAN: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_HEAVY_OOM_RETRY: '',
    STUDIO_UNITY: '', STUDIO_UNITY_PIN: '', STUDIO_UNITY_LIBRARY_CACHE: 'off', STUDIO_UNITY_PLAYMODE_RETRY: '', STUDIO_UNITY_CODE_ONLY: 'off', STUDIO_DOTNET: '', STUDIO_UNITY_ACCELERATOR: '', STUDIO_UNITY_EDITMODE_REUSE: 'off', STUDIO_UNITY_ONE_EDITOR: '', STUDIO_UNITY_GRAPHICS_SPLIT: 'off',
    STUDIO_UNITY_TRAIN_RETRIES: '', STUDIO_UNITY_TRAIN_RETRY_MIN: '', STUDIO_UNITY_GATE_TIMEOUT_MIN: '', STUDIO_GAME: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2732e-${process.pid}.pem`),
    npm_lifecycle_event: '', NODE_OPTIONS: '', AGENT_EVENTS_FILE: evFile, ...ident,
  };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-2732e-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...base, ...env });
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const locksDir = path.join(dir, '.studio', 'locks');
  const clearLocks = () => { try { for (const n of fs.readdirSync(locksDir)) if (/^machine-heavy/.test(n)) fs.rmSync(path.join(locksDir, n), { force: true }); } catch {} };
  clearLocks();
  const gameJson = path.join(dir, 'studio', 'game.json');
  const gatesJson = path.join(dir, 'studio', 'gates.json');
  const gameBefore = fs.existsSync(gameJson) ? fs.readFileSync(gameJson, 'utf8') : null;
  const gatesBefore = fs.readFileSync(gatesJson, 'utf8');
  const logMd = path.join(dir, 'studio', 'engine', 'LOG.md');
  const logBefore = fs.existsSync(logMd) ? fs.readFileSync(logMd, 'utf8') : null;
  const lastGates = path.join(dir, '.studio', 'gates-last.json');
  const lastBefore = fs.existsSync(lastGates) ? fs.readFileSync(lastGates, 'utf8') : null;
  const setUnity = (unity) => fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: { unity } }, null, 2));
  const ran = path.join(T, 'ran.txt');
  const markerJs = path.join(T, 'marker.mjs');
  fs.writeFileSync(markerJs, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(ran)}, 'x');\n`);
  const marker = `node ${markerJs}`;
  const ranCount = () => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').length : 0);

  try {
    // ---------- floor ----------
    const fl = probe('floor', `import { unityMinFreeGb } from ${u('harness/heavy-budget.mjs')};
console.log(JSON.stringify({ d32: unityMinFreeGb({ env: {}, totalGb: 32 }), d16: unityMinFreeGb({ env: {}, totalGb: 16 }), set: unityMinFreeGb({ env: { STUDIO_UNITY_MIN_FREE_GB: '20' }, totalGb: 64 }), off: unityMinFreeGb({ env: { STUDIO_UNITY_MIN_FREE_GB: '0' }, totalGb: 32 }), cap: unityMinFreeGb({ env: { STUDIO_UNITY_MIN_FREE_GB: '20' }, totalGb: 24 }) }));`);
    await guard('2.73.2 (e, B-73): the Unity free-RAM floor is STUDIO_UNITY_MIN_FREE_GB (default 12), never above 60% of the RAM (16 GB: 9.6), 0 turns it off (fails on 2.73.1: no floor)', () => [
      fl.d32?.gb === 12 && fl.d16?.gb === 9.6 && /60%/.test(fl.d16.why) && fl.set?.gb === 20 && fl.off?.gb === 0 && fl.cap?.gb === 14.4,
      JSON.stringify(fl).slice(0, 1500)]);

    fs.rmSync(ran, { force: true });
    const low = run(dir, `node harness/heavy.mjs run --kind unity --label unity-land --timeout-min 0.03 -- ${marker}`, { ...base, STUDIO_TEST_FREEMEM_MB: '2048', STUDIO_UNITY_MIN_FREE_GB: '3' });
    const lowRan = ranCount();
    const ok = run(dir, `node harness/heavy.mjs run --kind unity --label unity-land --timeout-min 0.03 -- ${marker}`, { ...base, STUDIO_TEST_FREEMEM_MB: '4096', STUDIO_UNITY_MIN_FREE_GB: '3' });
    await guard('2.73.2 (e, B-73): `heavy run --kind unity` waits for the free-RAM floor ("waits for memory: free RAM is 2 GB, under the 3 GB floor"), and when the wait runs out it exits 3 with "NOT RUN" without starting the command; with enough free it runs (fails on 2.73.1: it started Unity at once)', () => [
      low.status === 3 && /waits for memory: free RAM is 2 GB, under the 3 GB floor/.test(out(low)) && /\[heavy\] NOT RUN unity-land/.test(out(low)) && lowRan === 0 && ok.status === 0 && ranCount() === 1 && /over the 3 GB floor/.test(out(ok)),
      `${out(low).slice(-800)}\n---\n${out(ok).slice(-500)}\nran ${lowRan}/${ranCount()}`]);

    // ---------- cli: wait, wait --hold, release ----------
    clearLocks();
    const wLow = run(dir, 'node harness/heavy.mjs wait --min-free-gb 3 --timeout-min 0.03', { ...base, STUDIO_TEST_FREEMEM_MB: '2048' });
    const wOk = run(dir, 'node harness/heavy.mjs wait --min-free-gb 3 --timeout-min 0.03', { ...base, STUDIO_TEST_FREEMEM_MB: '4096' });
    const hold = run(dir, 'node harness/heavy.mjs wait --hold land-script --min-free-gb 3 --timeout-min 0.2 --hold-max-min 5', { ...base, STUDIO_TEST_FREEMEM_MB: '4096' });
    const st = run(dir, 'node harness/heavy.mjs status --json', base);
    let stj = null; try { stj = JSON.parse(String(st.stdout).trim().split('\n').pop()); } catch {}
    fs.rmSync(ran, { force: true });
    const blocked = run(dir, `node harness/heavy.mjs run --label web-verify --timeout-min 0.03 -- ${marker}`, base);
    const blockedRan = ranCount();
    const rel = run(dir, 'node harness/heavy.mjs release --label land-script', base);
    const after = run(dir, `node harness/heavy.mjs run --label web-verify --timeout-min 0.05 -- ${marker}`, base);
    await guard('2.73.2 (e, B-73): `npm run heavy -- wait` exits 3 ("NOT RUN") under the floor and 0 over it; `wait --hold <label>` keeps machine:heavy in a background holder (status shows it) so other heavy work waits and does not run; `release --label <label>` frees it (fails on 2.73.1: no wait, hold or release)', () => [
      wLow.status === 3 && /NOT RUN/.test(out(wLow)) && wOk.status === 0 && /nothing is held now/.test(out(wOk)) && hold.status === 0 && /held: machine:heavy for "land-script"/.test(out(hold)) && /release --label "land-script"/.test(out(hold))
        && (stj?.holders || []).some((h) => h.label === 'land-script' && h.hold === true) && blocked.status === 3 && blockedRan === 0 && rel.status === 0 && /released "land-script".*is free/.test(out(rel)) && after.status === 0 && ranCount() === 1,
      [out(wLow).slice(-300), out(wOk).slice(-300), out(hold).slice(-500), JSON.stringify(stj?.holders || []).slice(0, 400), out(blocked).slice(-300), out(rel), out(after).slice(-300)].join('\n---\n')]);
    clearLocks();

    // ---------- gate: harness/unity.mjs gate with a stand-in editor ----------
    if (process.platform === 'win32') {
      report('2.73.2 (e, B-73): the stand-in Unity editor checks (skipped on Windows: a POSIX script stands in for the editor)', true, '');
    } else {
      const p = path.join(T, 'unity', 'tinygame');
      w(p, 'ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.3.1f1\n');
      w(p, 'Assets/Sim/Sim.asmdef', JSON.stringify({ name: 'Sim', noEngineReferences: true }));
      w(p, 'Assets/Sim/Rules.cs', 'namespace Sim { public static class Rules { public static int Add(int a, int b) => a + b; } }\n');
      const planF = path.join(T, 'unity-plan.txt');
      const seenF = path.join(T, 'unity-seen.txt');
      const fake = path.join(T, 'fake-unity.mjs');
      fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const at = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
fs.appendFileSync(${JSON.stringify(seenF)}, 'x');
const plan = fs.readFileSync(${JSON.stringify(planF)}, 'utf8').trim();
const res = (failed) => fs.writeFileSync(at('-testResults'), \`<test-run total="2" passed="\${2 - failed}" failed="\${failed}" skipped="0" result="\${failed ? 'Failed' : 'Passed'}">\${failed ? '<test-case fullname="Game.Tests.Belt" result="Failed"><failure><message><![CDATA[expected 3 but was 4]]></message></failure></test-case>' : ''}</test-run>\`);
if (plan === 'oom') { console.log('Could not allocate memory: System out of memory!'); console.log('Crash!!!'); process.exit(1); }
if (plan === 'abort') { console.log('Aborting batchmode due to failure:'); console.log('Executing method failed'); process.exit(1); }
if (plan === 'killed') { process.kill(process.pid, 'SIGKILL'); }
if (plan === 'fail-oom') { res(1); console.log('Could not allocate memory'); process.exit(2); }
if (plan === 'compile-abort') { console.log('Assets/Scripts/Belt.cs(4,9): error CS0103: The name x does not exist'); console.log('Aborting batchmode due to failure:'); process.exit(1); }
res(0);
`);
      fs.chmodSync(fake, 0o755);
      const uenv = { ...base, STUDIO_UNITY: fake, STUDIO_UNITY_MIN_FREE_GB: '0' };
      const gate = (plan, env = {}) => { fs.writeFileSync(planF, plan); return run(dir, `node harness/unity.mjs gate "${p}" --platform EditMode`, { ...uenv, ...env }); };
      const oom = gate('oom');
      const ab = gate('abort');
      const kl = gate('killed');
      await guard('2.73.2 (e, B-73): the Unity gate calls an editor that ran out of memory, aborted batch mode before writing results, or was ended from outside NOT RUN (exit 3, "[engine-gate] NOT RUN out-of-memory|aborted|editor-killed (unity)" with its Fix line, "not a failure of the work"), never "[engine-gate] FAIL" (fails on 2.73.1: FAIL no-results, exit 1)', () => [
        oom.status === 3 && /\[engine-gate\] NOT RUN out-of-memory \(unity\): EditMode: the editor ran out of memory/.test(out(oom)) && /\[engine-gate\] Fix: NOT RUN: the editor ran out of memory/.test(out(oom)) && !/\[engine-gate\] FAIL/.test(out(oom)) && /not a failure of the work/.test(out(oom))
          && ab.status === 3 && /\[engine-gate\] NOT RUN aborted \(unity\)/.test(out(ab)) && !/\[engine-gate\] FAIL/.test(out(ab))
          && kl.status === 3 && /\[engine-gate\] NOT RUN editor-killed \(unity\)/.test(out(kl)),
        [out(oom).slice(-900), out(ab).slice(-500), out(kl).slice(-500)].join('\n---\n')]);
      const fo = gate('fail-oom');
      const ca = gate('compile-abort');
      await guard('2.73.2 (e, B-73) guard: a failing test stays FAIL (exit 1, "[engine-gate] FAIL test-failed") even with an out-of-memory line in the log, and a compile error next to "Aborting batchmode" stays FAIL compile-error (passes on 2.73.1 too: the fix must not hide a real failure)', () => [
        fo.status === 1 && /\[engine-gate\] FAIL test-failed \(unity\)/.test(out(fo)) && !/\[(?:engine-gate|unity)\] NOT RUN/.test(out(fo)) && ca.status === 1 && /\[engine-gate\] FAIL compile-error \(unity\)/.test(out(ca)) && !/\[(?:engine-gate|unity)\] NOT RUN/.test(out(ca)),
        [out(fo).slice(-700), out(ca).slice(-700)].join('\n---\n')]);
      fs.rmSync(seenF, { force: true });
      const fl2 = gate('pass', { STUDIO_TEST_FREEMEM_MB: '2048', STUDIO_UNITY_MIN_FREE_GB: '3', STUDIO_HEAVY_WAIT_MIN: '0.03' });
      const seenLow = fs.existsSync(seenF);
      const good = gate('pass', { STUDIO_TEST_FREEMEM_MB: '4096', STUDIO_UNITY_MIN_FREE_GB: '3' });
      await guard('2.73.2 (e, B-73): the Unity gate takes machine:heavy only once free RAM is over the floor: under it the editor never starts and the gate is NOT RUN ram-floor (exit 3); over it the gate runs and passes (fails on 2.73.1: the editor started at once)', () => [
        fl2.status === 3 && !seenLow && /\[engine-gate\] NOT RUN ram-floor \(unity\)/.test(out(fl2)) && /under the 3 GB floor/.test(out(fl2)) && good.status === 0 && /PASS the editor's tests/.test(out(good)),
        `${out(fl2).slice(-900)}\nseen: ${seenLow}\n---\n${out(good).slice(-400)}`]);
    }

    // ---------- land: harness/unity-gate.mjs ----------
    const stub = path.join(T, 'land-stub.mjs');
    fs.writeFileSync(stub, `import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(ran)}, 'x');
const plan = process.env.LAND_PLAN || 'pass';
if (plan === 'oom') { console.log('[land] running Unity tests'); console.log('Could not allocate memory: System out of memory!'); console.log('[land] FAIL record written'); process.exit(1); }
if (plan === 'abort') { console.log('Aborting batchmode due to failure:'); process.exit(1); }
if (plan === 'red') { console.log('Aborting batchmode due to failure:'); console.log('2 tests failed'); process.exit(1); }
console.log('[land] landed'); process.exit(0);
`);
    setUnity({ land: `node "${stub}" {branch}` });
    const ugate = (env = {}) => {
      const r = run(dir, 'node harness/unity-gate.mjs --branch feat/dock --json', { ...base, STUDIO_UNITY_MIN_FREE_GB: '0', ...env });
      let j = null;
      try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
      return { code: r.status, j, text: out(r), rec: readJson(path.join(dir, '.studio', 'gates', 'unity-last.json')) };
    };
    const lOom = ugate({ LAND_PLAN: 'oom' });
    const evOom = events().filter((e) => e.type === 'engine.land').pop();
    const lAb = ugate({ LAND_PLAN: 'abort' });
    const log1 = fs.existsSync(logMd) ? fs.readFileSync(logMd, 'utf8') : '';
    await guard('2.73.2 (e, B-73): a Unity land run that the output shows ran out of memory (or aborted batch mode with no failing test) is status not-run, exit 3, recorded as "not run (out-of-memory)" in unity-last.json, a warn engine.land event and "not run (out-of-memory)" in studio/engine/LOG.md, never red (fails on 2.73.1: red, exit 1, a blocked event)', () => [
      lOom.code === 3 && lOom.j?.status === 'not-run' && /^not run \(out-of-memory\)/.test(lOom.j.why || '') && lOom.rec?.status === 'not-run' && evOom?.status === 'warn' && evOom.meta?.status === 'not-run' && evOom.meta?.infra === 'out-of-memory'
        && /unity land: not run \(out-of-memory\)/.test(log1) && lAb.code === 3 && lAb.j?.status === 'not-run' && lAb.j?.infra?.kind === 'aborted',
      JSON.stringify({ oom: lOom.j, ev: evOom, ab: lAb.j }).slice(0, 2500)]);
    const lRed = ugate({ LAND_PLAN: 'red' });
    await guard('2.73.2 (e, B-73) guard: a land run whose output shows failing tests stays red (exit 1) even next to "Aborting batchmode" (passes on 2.73.1 too)', () => [
      lRed.code === 1 && lRed.j?.status === 'red', JSON.stringify(lRed.j).slice(0, 1200)]);
    fs.rmSync(ran, { force: true });
    const lFloor = ugate({ LAND_PLAN: 'pass', STUDIO_TEST_FREEMEM_MB: '2048', STUDIO_UNITY_MIN_FREE_GB: '3', STUDIO_HEAVY_WAIT_MIN: '0.03' });
    await guard('2.73.2 (e, B-73): under the free-RAM floor the Unity land command never starts: status not-run (ram-floor), exit 3 (fails on 2.73.1: it ran)', () => [
      lFloor.code === 3 && lFloor.j?.status === 'not-run' && lFloor.j?.infra?.kind === 'ram-floor' && ranCount() === 0 && /^not run: /.test(lFloor.j.why || ''),
      JSON.stringify(lFloor.j).slice(0, 1500)]);

    // ---------- train: a not-run land run is retried, then deferred; nobody is handed back ----------
    const repo = path.join(T, 'unity-repo');
    fs.mkdirSync(repo, { recursive: true });
    const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...ident, GIT_CONFIG_NOSYSTEM: '1' } });
    g('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base');
    g('checkout', '-qb', 'feat/dock'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n'); g('add', '-A'); g('commit', '-qm', 'dock'); g('checkout', '-q', 'main');
    const head = g('rev-parse', 'feat/dock').stdout.trim();
    setUnity({ land: `node "${stub}" {branch}`, target: 'main', cwd: repo });
    fs.mkdirSync(path.join(dir, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task: 'T-901', agent: 'porter-x', branch: 'feat/dock', head, at: new Date().toISOString() }]));
    fs.rmSync(ran, { force: true });
    const tr = probe('train', `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { handBack: (lane, note) => handed.push({ task: lane.task, note }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, dropped: r.dropped, deferred: r.deferred, notRun: r.notRun || null, landed: r.landed, handed, queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`, { LAND_PLAN: 'oom', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_UNITY_TRAIN_RETRIES: '1', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_MAIN_ROOT: dir });
    await guard('2.73.2 (e, B-73): the Unity train tries a not-run land run (out of memory) once more, then defers the branch ("not run (out-of-memory)") and keeps it queued: nobody is handed back as red (fails on 2.73.1: red, handed back)', () => [
      tr.runs === 2 && ranCount() === 2 && !tr.dropped?.length && !tr.handed?.length && tr.deferred?.some((d) => d.task === 'T-901' && /not run \(out-of-memory\)/.test(d.why)) && tr.notRun && tr.queue?.includes('T-901') && !tr.landed?.length,
      JSON.stringify(tr).slice(0, 2500)]);

    // ---------- rows: a verify gate that did not run ----------
    const gates = JSON.parse(gatesBefore);
    const nr = path.join(T, 'notrun-gate.mjs');
    fs.writeFileSync(nr, "console.log('[engine] NOT RUN Unity: not run: out-of-memory: the editor ran out of memory'); process.exit(3);\n");
    gates.gates = [...(gates.gates || []), { id: 'unity-notrun-2732e', command: `node "${nr}"`, required: true }];
    fs.writeFileSync(gatesJson, JSON.stringify(gates, null, 2));
    const vr = run(dir, 'node scripts/run-gates.mjs --only unity-notrun-2732e', base);
    const rec = readJson(path.join(dir, '.studio', 'gates-last.json'));
    const row = (rec?.rows || []).find((r) => r.id === 'unity-notrun-2732e');
    const words = probe('words', `import { gateWords } from ${u('harness/gate-words.mjs')};
import { gateFix } from ${u('harness/gate-fix.mjs')};
const w = gateWords({ rows: [{ id: 'engine', ok: false, required: true, notRun: 'out-of-memory: the editor ran out of memory' }, { id: 'golden', ok: true, required: true }] }, []);
const f = gateFix({ id: 'game' }, { output: '[engine-gate] NOT RUN out-of-memory (unity): EditMode: the editor ran out of memory\\n' });
console.log(JSON.stringify({ failing: w.failing.length, notRun: w.notRun, lines: w.lines, f }));`);
    await guard('2.73.2 (e, B-73): a verify gate that exits 3 with a NOT RUN line is "[gates] NOT RUN <id>: not run: <why>" and its row keeps notRun (the verify is still no pass); the plain words list it under NOT RUN, not FAILING; "[engine-gate] NOT RUN out-of-memory" gets that kind\'s own Fix (fails on 2.73.1: FAIL, no notRun, the generic Fix)', () => [
      vr.status !== 0 && /\[gates\] NOT RUN unity-notrun-2732e: not run: out-of-memory/.test(out(vr)) && !/\[gates\] FAIL unity-notrun-2732e/.test(out(vr)) && row?.ok === false && /out-of-memory/.test(row?.notRun || '')
        && words.failing === 0 && words.notRun?.some((x) => x.id === 'engine' && /^not run: out-of-memory/.test(x.why)) && words.f?.source === 'engine-check' && /NOT RUN: the editor ran out of memory/.test(words.f.text || ''),
      `${out(vr).slice(-900)}\n---\n${JSON.stringify(row)}\n---\n${JSON.stringify(words).slice(0, 1200)}`]);
  } finally {
    clearLocks();
    fs.writeFileSync(gatesJson, gatesBefore);
    if (gameBefore === null) fs.rmSync(gameJson, { force: true }); else fs.writeFileSync(gameJson, gameBefore);
    if (logBefore === null) fs.rmSync(logMd, { force: true }); else fs.writeFileSync(logMd, logBefore);
    if (lastBefore === null) fs.rmSync(lastGates, { force: true }); else fs.writeFileSync(lastGates, lastBefore);
    for (const f of ['unity-last.json']) fs.rmSync(path.join(dir, '.studio', 'gates', f), { force: true });
    fs.rmSync(path.join(dir, '.studio', 'train', 'unity-queue.json'), { force: true });
    fs.rmSync(path.join(dir, '.studio', 'train', 'unity-last.json'), { force: true });
    fs.rmSync(T, { recursive: true, force: true });
  }
}
