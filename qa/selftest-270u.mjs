/**
 * qa/selftest-270u.mjs — 2.70.0 (u): Unity speed, with a stand-in editor and a stand-in dotnet (node scripts).
 *   (1) the Unity Accelerator: STUDIO_UNITY_ACCELERATOR adds the cache-server arguments to every editor start (tests,
 *       build) when the endpoint answers; unreachable: the run goes on without them and says so; the summary says on/off;
 *   (2) no duplicate Edit Mode: the editor skips Edit Mode when the code-only dotnet step ran the same tests in this gate,
 *       or when Edit Mode passed earlier on the same clean tree with the same Unity; a changed tree runs it again;
 *   (3) one editor start (STUDIO_UNITY_ONE_EDITOR=on): one -executeMethod start with a harness script that is removed
 *       after; a run that doesn't write both results falls back to two starts;
 *   (4) the Graphics split: Graphics-tagged tests run in their own start with a device, the rest -nographics "!Graphics";
 *   (5) landing build options: -studioBuildSpeed fast / -studioCodeOptimization release for the build method, never a
 *       guessed editor flag, none for --release;
 *   (6) the Library cache copies in parallel (bounded, copied not linked), and says so with the file count.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest270U({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_TEST_LOADAVG: '0', STUDIO_MACHINE_SCAN: 'off', STUDIO_UNITY: '', STUDIO_UNITY_PIN: '', STUDIO_UNITY_LIBRARY_CACHE: 'off', STUDIO_UNITY_LIBRARY_BASE: '', STUDIO_UNITY_PLAYMODE_RETRY: '', STUDIO_UNITY_CODE_ONLY: '', STUDIO_DOTNET: '', STUDIO_UNITY_ACCELERATOR: '', STUDIO_UNITY_ACCELERATOR_TIMEOUT_MS: '', STUDIO_UNITY_EDITMODE_REUSE: '', STUDIO_UNITY_ONE_EDITOR: '', STUDIO_UNITY_GRAPHICS_SPLIT: '', STUDIO_UNITY_LANDING_BUILD: '', STUDIO_UNITY_CODE_OPT: '', STUDIO_UNITY_CACHE_COPY: '', STUDIO_UNITY_CACHE_COPY_JOBS: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-270u.jsonl') };
  const T = path.join(tmpRoot, `u270-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const w = (p, rel, text) => { fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true }); fs.writeFileSync(path.join(p, rel), text); };
  // A made-up Unity project: a pure sim, an Edit Mode test assembly (Editor only), a Play Mode one.
  const project = (name, { simTests = false, graphics = null, version = '6000.3.1f1' } = {}) => {
    const p = path.join(T, name, 'tinygame');
    w(p, 'ProjectSettings/ProjectVersion.txt', `m_EditorVersion: ${version}\n`);
    w(p, 'Packages/manifest.json', '{ "dependencies": {} }\n');
    w(p, 'Assets/Sim/Sim.asmdef', JSON.stringify({ name: 'Sim', noEngineReferences: true }));
    w(p, 'Assets/Sim/Rules.cs', 'namespace Sim { public static class Rules { public static int Add(int a, int b) => a + b; } }\n');
    w(p, 'Assets/Editor/StudioBuild.cs', '// stand-in\n');
    w(p, 'Assets/Tests/EditMode/EditTests.asmdef', JSON.stringify({ name: 'EditTests', references: ['Sim'], includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'] }));
    w(p, 'Assets/Tests/EditMode/RulesTests.cs', 'using NUnit.Framework;\npublic class RulesTests { [Test] public void Adds() { Assert.AreEqual(3, Sim.Rules.Add(1, 2)); } }\n');
    w(p, 'Assets/Tests/PlayMode/PlayTests.asmdef', JSON.stringify({ name: 'PlayTests', references: ['Sim', 'UnityEngine.TestRunner'], includePlatforms: [], defineConstraints: ['UNITY_INCLUDE_TESTS'] }));
    w(p, 'Assets/Tests/PlayMode/BootTests.cs', 'using NUnit.Framework;\npublic class BootTests { [Test] public void Boots() { } }\n');
    if (graphics === 'tagged') w(p, 'Assets/Tests/PlayMode/LookTests.cs', 'using NUnit.Framework;\npublic class LookTests { [Test, Category("Graphics")] public void Lit() { } }\n');
    if (graphics === 'commented') w(p, 'Assets/Tests/PlayMode/LookTests.cs', 'using NUnit.Framework;\npublic class LookTests {\n  // [Category("Graphics")] someday\n  [Test] public void Lit() { }\n}\n');
    if (simTests) w(p, 'tools/SimTests/SimTests.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <Compile Include="../../Assets/Sim/**/*.cs" />\n    <Compile Include="../../Assets/Tests/EditMode/**/*.cs" />\n  </ItemGroup>\n</Project>\n');
    return p;
  };
  const kidsDone = [];
  try {
    // ---------- (6) the parallel Library copy (direct; every platform) ----------
    {
      const a = project('copy-a');
      const b = project('copy-b');
      const c = project('copy-c');
      for (let i = 0; i < 40; i += 1) w(a, `Library/Artifacts/${String(i % 7)}/f${i}`, `artifact ${i}`);
      w(a, 'Library/ArtifactDB', 'db');
      w(a, 'Library/ArtifactDB-lock', 'lock');
      const old = new Date('2021-03-04T05:06:07Z');
      fs.utimesSync(path.join(a, 'Library', 'ArtifactDB'), old, old);
      const cacheDir = path.join(T, 'cache-copy');
      const f = path.join(T, 'probe-copy.mjs');
      fs.writeFileSync(f, `import fs from 'node:fs';
import path from 'node:path';
import { seedLibrary, saveLibrary } from ${u('harness/unity-cache.mjs')};
const env = { ...process.env, STUDIO_UNITY_LIBRARY_CACHE: ${JSON.stringify(cacheDir)}, STUDIO_UNITY_CACHE_COPY_JOBS: '3' };
const [a, b, c] = ${JSON.stringify([a, b, c])};
const saved = saveLibrary(a, { env });
const seeded = seedLibrary(b, { env });
const ino = (p) => fs.statSync(p).ino;
const n = fs.readdirSync(path.join(b, 'Library', 'Artifacts'), { recursive: true }).filter((x) => /f\\d+$/.test(x)).length;
const copied = n === 40 && ino(path.join(b, 'Library', 'ArtifactDB')) !== ino(path.join(a, 'Library', 'ArtifactDB')) && !fs.existsSync(path.join(b, 'Library', 'ArtifactDB-lock'));
const mtime = Math.round(fs.statSync(path.join(b, 'Library', 'ArtifactDB')).mtimeMs / 1000);
const serial = seedLibrary(c, { env: { ...env, STUDIO_UNITY_CACHE_COPY: 'serial' } });
console.log(JSON.stringify({ saved: saved.status, savedCopy: saved.copy, savedWhy: saved.why, seeded: seeded.status, copy: seeded.copy, files: seeded.files, why: seeded.why, copied, mtime, serial: serial.copy, serialWhy: serial.why, serialOk: fs.existsSync(path.join(c, 'Library', 'ArtifactDB')) }));`);
      const r = run(dir, `node "${f}"`, base);
      const j = (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } })();
      guard('2.70.0 (u)(6): the warm Library is copied in parallel by default (STUDIO_UNITY_CACHE_COPY_JOBS at a time, real copies with their own inodes, timestamps kept, lock files skipped) and the cache line says how (parallel, N at a time, M files); STUDIO_UNITY_CACHE_COPY=serial copies as before (2.69.0: one serial fs.cpSync, no measure in the line)', () => [
        j.saved === 'saved' && j.savedCopy === 'parallel' && j.seeded === 'seeded' && j.copy === 'parallel' && j.files === 41 && /parallel copy, 3 at a time, 41 file\(s\)/.test(j.why || '') && j.copied && j.mtime === Math.round(old.getTime() / 1000) && j.serial === 'serial' && /serial copy/.test(j.serialWhy || '') && j.serialOk,
        JSON.stringify({ j, o: out(r).slice(-800) })]);
    }

    if (process.platform === 'win32') {
      report('2.70.0 (u): the stand-in editor checks (skipped on Windows: the stand-in editor and dotnet are POSIX scripts)', true, '');
      return;
    }

    // ---------- the stand-in editor: records each start's arguments; writes NUnit results ----------
    const seenF = path.join(T, 'seen.jsonl');
    const fake = path.join(T, 'fake-unity.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const at = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
const proj = at('-projectPath');
const planF = path.join(${JSON.stringify(T)}, 'plan.json');
let plan = [];
try { plan = JSON.parse(fs.readFileSync(planF, 'utf8')); } catch {}
const sdir = path.join(proj, 'Assets', 'StudioHarnessTemp');
const script = (() => { try { return fs.readFileSync(path.join(sdir, 'StudioHarnessRunAll.cs'), 'utf8'); } catch { return ''; } })();
fs.appendFileSync(${JSON.stringify(seenF)}, JSON.stringify({ args: a, project: path.basename(path.dirname(proj)), script: /TestRunnerApi/.test(script), gitignore: fs.existsSync(path.join(sdir, '.gitignore')) }) + '\\n');
const pass = (f, n = 2) => fs.writeFileSync(f, '<test-run total="' + n + '" passed="' + n + '" failed="0" skipped="0" result="Passed"></test-run>');
if (at('-executeMethod') === 'StudioHarnessRunAll.Run') {
  fs.writeFileSync(path.join(proj, 'Assets', 'StudioHarnessTemp.meta'), 'guid: made-by-the-editor');
  pass(at('-studioEditModeResults'));
  if (!plan.includes('one-editor-short')) pass(at('-studioPlayModeResults'));
  process.exit(0);
}
if (at('-executeMethod')) { console.log('[build] PASS ' + at('-executeMethod') + ' -> ' + at('-out')); process.exit(0); }
pass(at('-testResults'));
`);
    fs.chmodSync(fake, 0o755);
    // The stand-in dotnet: writes the trx the sim's tests would.
    const dotnetF = path.join(T, 'fake-dotnet.mjs');
    fs.writeFileSync(dotnetF, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const res = a[a.indexOf('--results-directory') + 1];
fs.mkdirSync(res, { recursive: true });
fs.writeFileSync(path.join(res, 'sim.trx'), '<TestRun><ResultSummary outcome="Completed"><Counters total="3" executed="3" passed="3" failed="0" error="0" timeout="0" aborted="0" /></ResultSummary></TestRun>');
console.log('Passed!  - Failed: 0, Passed: 3');
`);
    fs.chmodSync(dotnetF, 0o755);
    const uenv = { ...base, STUDIO_UNITY: fake, STUDIO_DOTNET: dotnetF };
    const seen = () => { try { return fs.readFileSync(seenF, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const reset = (plan = []) => { fs.rmSync(seenF, { force: true }); fs.writeFileSync(path.join(T, 'plan.json'), JSON.stringify(plan)); };
    const gate = (p, env = {}, extra = '') => run(dir, `node harness/unity.mjs gate "${p}"${extra}`, { ...uenv, ...env });
    const starts = (s, platform) => s.filter((x) => x.args.includes('-runTests') && x.args[x.args.indexOf('-testPlatform') + 1] === platform);
    const argOf = (x, k) => (x.args.includes(k) ? x.args[x.args.indexOf(k) + 1] : null);

    // ---------- (1) the Accelerator ----------
    {
      const server = net.createServer((s) => s.end());
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      kidsDone.push(() => server.close());
      const port = server.address().port;
      const p = project('accel');
      reset();
      const on = gate(p, { STUDIO_UNITY_ACCELERATOR: `127.0.0.1:${port}` });
      const sOn = seen();
      reset();
      const b = run(dir, `node harness/unity.mjs build "${p}"`, { ...uenv, STUDIO_UNITY_ACCELERATOR: `127.0.0.1:${port}` });
      const sB = seen();
      // A port nothing listens on: close a server and reuse its port.
      const dead = net.createServer();
      await new Promise((res) => dead.listen(0, '127.0.0.1', res));
      const deadPort = dead.address().port;
      await new Promise((res) => dead.close(res));
      reset();
      const offRun = gate(p, { STUDIO_UNITY_ACCELERATOR: `127.0.0.1:${deadPort}` });
      const sOff = seen();
      const accelArgs = (x) => x.args.includes('-EnableCacheServer') && argOf(x, '-cacheServerEndpoint') === `127.0.0.1:${port}` && argOf(x, '-cacheServerEnableDownload') === 'true' && argOf(x, '-cacheServerEnableUpload') === 'true' && argOf(x, '-cacheServerNamespacePrefix') === '6000.3.1f1';
      guard('2.70.0 (u)(1): STUDIO_UNITY_ACCELERATOR=<host:port> that answers adds -EnableCacheServer -cacheServerEndpoint -cacheServerEnableDownload/Upload true -cacheServerNamespacePrefix <project version> to every editor start (Edit Mode, Play Mode, the build) and the gate\'s summary says "cache server on"; one that doesn\'t answer: no cache arguments, said once, the gate still passes with "cache server off" (2.69.0: no Accelerator support)', () => [
        on.status === 0 && sOn.length === 2 && sOn.every(accelArgs) && /PASS the editor's tests \(Edit Mode and Play Mode\); cache server on/.test(out(on))
          && b.status === 0 && sB.length === 1 && accelArgs(sB[0])
          && offRun.status === 0 && sOff.length === 2 && sOff.every((x) => !x.args.includes('-EnableCacheServer')) && (out(offRun).match(/did not answer/g) || []).length === 1 && /cache server off/.test(out(offRun).split('\n').filter((l) => /PASS the editor's tests/.test(l)).join('')),
        JSON.stringify({ on: out(on).slice(-900), sOn: sOn.map((x) => x.args.join(' ')), b: out(b).slice(-400), off: out(offRun).slice(-900), sOff: sOff.map((x) => x.args.join(' ')) })]);
    }

    // ---------- (2) no duplicate Edit Mode ----------
    {
      // (a) the code-only dotnet step compiles and runs every Edit Mode test file: the editor runs Play Mode only.
      const p = project('dup-dotnet', { simTests: true });
      reset();
      const g = gate(p);
      const s = seen();
      // Not covered: an Edit Mode test file the .NET project doesn't compile.
      const q = project('dup-uncovered', { simTests: true });
      w(q, 'Assets/Tests/EditorOnly/MenuTests.cs', 'using NUnit.Framework;\npublic class MenuTests { [Test] public void Opens() { } }\n');
      w(q, 'Assets/Tests/EditorOnly/MenuTests.asmdef', JSON.stringify({ name: 'MenuTests', includePlatforms: ['Editor'], defineConstraints: ['UNITY_INCLUDE_TESTS'] }));
      reset();
      const g2 = gate(q);
      const s2 = seen();
      // Edit Mode alone (no Play Mode start to compile the project in the editor): the editor still runs it.
      reset();
      const g3 = gate(p, {}, ' --platform EditMode');
      const s3 = seen();
      reset();
      const g4 = gate(p, { STUDIO_UNITY_EDITMODE_REUSE: 'off' });
      const s4 = seen();
      guard('2.70.0 (u)(2): the duplicate Edit Mode run is gone: when the code-only `dotnet test tools/SimTests` compiled and passed every Edit Mode test file in this gate, the editor starts once (Play Mode) and the gate says Edit Mode was reused; an Edit Mode file the .NET project misses, an Edit Mode-only gate and STUDIO_UNITY_EDITMODE_REUSE=off still run it in the editor (2.69.0: the same tests ran twice, with .NET and in the editor)', () => [
        g.status === 0 && starts(s, 'EditMode').length === 0 && starts(s, 'PlayMode').length === 1 && /PASS EditMode: reused, not run again: the same Edit Mode tests passed with \.NET/.test(out(g)) && /Edit Mode reused \(passed with \.NET in this gate\)/.test(out(g))
          && g2.status === 0 && starts(s2, 'EditMode').length === 1 && /doesn't compile 1 Edit Mode test file/.test(out(g2))
          && g3.status === 0 && starts(s3, 'EditMode').length === 1
          && g4.status === 0 && starts(s4, 'EditMode').length === 1,
        JSON.stringify({ g: out(g).slice(-900), s: s.map((x) => x.args.join(' ')), g2: out(g2).slice(-600), s2: s2.length, g3: s3.length, g4: s4.length })]);

      // (b) a previous gate's Edit Mode pass on the same clean tree and the same Unity: reused; a changed tree runs it.
      const r = project('dup-tree');
      const repo = path.dirname(r);
      const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { windowsHide: true, cwd: repo, encoding: 'utf8' });
      git('init', '-q');
      fs.writeFileSync(path.join(repo, '.gitignore'), 'Library/\n');
      git('add', '-A');
      git('commit', '-qm', 'one');
      reset();
      const t1 = gate(r);
      const s1 = seen();
      reset();
      const t2 = gate(r);
      const st2 = seen();
      fs.appendFileSync(path.join(r, 'Assets/Sim/Rules.cs'), '// a change\n');
      reset();
      const t3 = gate(r);
      const st3 = seen();
      git('commit', '-qam', 'two');
      reset();
      const t4 = gate(r);
      const st4 = seen();
      reset();
      const t5 = gate(r);
      const st5 = seen();
      guard('2.70.0 (u)(2): a gate on the same clean tree with the same Unity as an earlier Edit Mode pass skips the editor\'s Edit Mode run (recorded by tree and version in .studio/gates/unity-editmode.json) and still runs Play Mode; an uncommitted change and a new commit run it again, and a pass on the new tree is reused next time (2.69.0: every gate re-ran Edit Mode)', () => [
        t1.status === 0 && starts(s1, 'EditMode').length === 1
          && t2.status === 0 && starts(st2, 'EditMode').length === 0 && starts(st2, 'PlayMode').length === 1 && /reused, not run again: Edit Mode passed \(2\/2\) .* on this same tree/.test(out(t2))
          && t3.status === 0 && starts(st3, 'EditMode').length === 1 && /uncommitted change/.test(out(t3))
          && t4.status === 0 && starts(st4, 'EditMode').length === 1
          && t5.status === 0 && starts(st5, 'EditMode').length === 0,
        JSON.stringify({ t1: out(t1).slice(-500), t2: out(t2).slice(-700), t3: out(t3).slice(-500), n: [s1, st2, st3, st4, st5].map((x) => starts(x, 'EditMode').length), rec: fs.existsSync(path.join(dir, '.studio/gates/unity-editmode.json')) })]);
    }

    // ---------- (3) one editor start ----------
    {
      const p = project('one');
      reset();
      const g = gate(p, { STUDIO_UNITY_ONE_EDITOR: 'on' });
      const s = seen();
      const gone = !fs.existsSync(path.join(p, 'Assets', 'StudioHarnessTemp')) && !fs.existsSync(path.join(p, 'Assets', 'StudioHarnessTemp.meta'));
      reset(['one-editor-short']);
      const f = gate(p, { STUDIO_UNITY_ONE_EDITOR: 'on' });
      const sf = seen();
      const gone2 = !fs.existsSync(path.join(p, 'Assets', 'StudioHarnessTemp')) && !fs.existsSync(path.join(p, 'Assets', 'StudioHarnessTemp.meta'));
      reset();
      const d = gate(p);
      const sd = seen();
      guard('2.70.0 (u)(3): STUDIO_UNITY_ONE_EDITOR=on runs Edit Mode and Play Mode in ONE editor start (-executeMethod StudioHarnessRunAll.Run with a harness script using TestRunnerApi, written with a .gitignore and removed after, its .meta too); a start that writes only one results file falls back to two starts in the same gate and says so; default off (2.69.0: always two starts)', () => [
        g.status === 0 && s.length === 1 && argOf(s[0], '-executeMethod') === 'StudioHarnessRunAll.Run' && s[0].script && s[0].gitignore && gone && /one editor start: Edit Mode and Play Mode ran in one editor/.test(out(g)) && /; one editor start$/m.test(out(g))
          && f.status === 0 && sf.length === 3 && starts(sf, 'EditMode').length === 1 && starts(sf, 'PlayMode').length === 1 && /didn't write both results \(PlayMode results not written/.test(out(f)) && gone2
          && d.status === 0 && sd.length === 2 && sd.every((x) => !x.args.includes('-executeMethod')),
        JSON.stringify({ g: out(g).slice(-700), s, f: out(f).slice(-700), sf: sf.map((x) => x.args.slice(0, 8).join(' ')), sd: sd.length, gone, gone2 })]);
    }

    // ---------- (4) the Graphics split ----------
    {
      const p = project('gfx', { graphics: 'tagged' });
      reset();
      const g = gate(p);
      const s = seen();
      const pm = starts(s, 'PlayMode');
      const em = starts(s, 'EditMode');
      reset();
      const o = gate(p, { STUDIO_UNITY_GRAPHICS_SPLIT: 'off' });
      const so = seen();
      const c = project('gfx-commented', { graphics: 'commented' });
      reset();
      const n = gate(c);
      const sn = seen();
      guard('2.70.0 (u)(4): with a test tagged [Category("Graphics")] its platform runs twice: -nographics -testCategory "!Graphics", then -testCategory Graphics WITH a graphics device (no -nographics), results added up; a platform without Graphics tests runs as before; STUDIO_UNITY_GRAPHICS_SPLIT=off and a commented-out tag: one -nographics run each (2.69.0: every test ran -nographics)', () => [
        g.status === 0 && em.length === 1 && em[0].args.includes('-nographics') && !em[0].args.includes('-testCategory')
          && pm.length === 2 && pm[0].args.includes('-nographics') && argOf(pm[0], '-testCategory') === '!Graphics' && !pm[1].args.includes('-nographics') && argOf(pm[1], '-testCategory') === 'Graphics' && /PASS PlayMode: 4\/4 passed/.test(out(g)) && /Graphics split: 1 test file\(s\) tagged Graphics \(PlayMode\)/.test(out(g))
          && o.status === 0 && so.length === 2 && so.every((x) => x.args.includes('-nographics') && !x.args.includes('-testCategory'))
          && n.status === 0 && sn.length === 2 && sn.every((x) => x.args.includes('-nographics') && !x.args.includes('-testCategory')),
        JSON.stringify({ g: out(g).slice(-900), s: s.map((x) => x.args.join(' ')), so: so.length, sn: sn.map((x) => x.args.join(' ')) })]);
    }

    // ---------- (5) landing build options ----------
    {
      const p = project('build');
      const b = (env, extra = '') => { reset(); const r = run(dir, `node harness/unity.mjs build "${p}"${extra}`, { ...uenv, ...env }); return { r, s: seen() }; };
      const fast = b({ STUDIO_UNITY_LANDING_BUILD: 'fast', STUDIO_UNITY_CODE_OPT: 'release' });
      const rel = b({ STUDIO_UNITY_LANDING_BUILD: 'fast' }, ' --release');
      const def = b({});
      const known = new Set(['-batchmode', '-nographics', '-projectPath', '-executeMethod', '-out', '-logFile', '-studioBuildSpeed', '-studioCodeOptimization']);
      const flags = (x) => x.args.filter((a) => /^-[A-Za-z]/.test(a));
      guard('2.70.0 (u)(5): STUDIO_UNITY_LANDING_BUILD=fast passes -studioBuildSpeed fast to the build method (the game\'s StudioBuild.cs contract) and STUDIO_UNITY_CODE_OPT=release passes -studioCodeOptimization release, with no guessed editor flag and a note pointing at the docs TODO; --release gets no speed argument; by default neither (2.69.0: no landing build options)', () => [
        fast.r.status === 0 && fast.s.length === 1 && argOf(fast.s[0], '-studioBuildSpeed') === 'fast' && argOf(fast.s[0], '-studioCodeOptimization') === 'release' && flags(fast.s[0]).every((f) => known.has(f)) && /no editor flag is added: its name is unverified/.test(out(fast.r))
          && rel.r.status === 0 && !rel.s[0].args.includes('-studioBuildSpeed') && /off for a --release build/.test(out(rel.r))
          && def.r.status === 0 && !def.s[0].args.includes('-studioBuildSpeed') && !def.s[0].args.includes('-studioCodeOptimization'),
        JSON.stringify({ fast: fast.s.map((x) => x.args.join(' ')), fo: out(fast.r).slice(-600), rel: rel.s.map((x) => x.args.join(' ')), def: def.s.map((x) => x.args.join(' ')) })]);
    }
  } finally {
    for (const k of kidsDone) { try { k(); } catch {} }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }
}
