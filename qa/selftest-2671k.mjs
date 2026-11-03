/**
 * qa/selftest-2671k.mjs — 2.67.1 (k): Unity streamlining, with a stand-in editor (a node script).
 *   (a) a warm Library cache: a fresh copy gets the cached Library (no re-import), keyed by Unity version and packages,
 *       copied (never linked), and never shared by two runs at once (a held key lock: cold run, no save);
 *   (b) a Play Mode test failure gets one retry: a pass on retry is green with a flake record (and a digest line);
 *       fail-fail is red; a compile error and Edit Mode are never retried; STUDIO_UNITY_PLAYMODE_RETRY=off;
 *   (c) code-only steps (studio/game.json engines.unity.codeOnly) run without machine:heavy while another holder has
 *       it, the editor step waits for it, and a code-only failure stops before waiting for the editor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2671K({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-2671k.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_GATE_PRIORITY: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_TEST_LOADAVG: '0', STUDIO_UNITY: '', STUDIO_UNITY_PIN: '', STUDIO_UNITY_LIBRARY_CACHE: '', STUDIO_UNITY_LIBRARY_BASE: '', STUDIO_UNITY_LIBRARY_CACHE_KEEP: '', STUDIO_UNITY_PLAYMODE_RETRY: '', STUDIO_UNITY_CODE_ONLY: '', STUDIO_DOTNET: '', STUDIO_WORKTREES: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events };
  const T = path.join(tmpRoot, `k2671-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const kids = [];
  const sleepF = path.join(T, 'sleep.mjs');
  fs.writeFileSync(sleepF, 'setTimeout(() => {}, Number(process.argv[2] || 1000));\n');
  const lockF = path.join(dir, '.studio', 'locks', 'machine-heavy-1.lock');
  const holder = (ms, label = 'holder-2671k') => {
    const c = spawn(process.execPath, ['harness/heavy.mjs', 'run', '--label', label, '--', 'node', `"${sleepF}"`, String(ms)], { windowsHide: true, cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
    kids.push(c);
    const up = until(() => readJson(lockF)?.label === label, 15000 * SLOW);
    return { c, up, gone: () => until(() => readJson(lockF)?.pid !== c.pid, 30000 * SLOW) };
  };
  // A made-up Unity project at <lane>/mygame (same name in every lane: the same project, as lane copies are).
  const project = (lane, { version = '6000.3.1f1', manifest = '{ "dependencies": { "com.example.ui": "1.0.0" } }' } = {}) => {
    const p = path.join(T, lane, 'mygame');
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(p, rel)), { recursive: true }); fs.writeFileSync(path.join(p, rel), text); };
    w('ProjectSettings/ProjectVersion.txt', `m_EditorVersion: ${version}\n`);
    w('Packages/manifest.json', manifest);
    w('Assets/Sim/Sim.asmdef', JSON.stringify({ name: 'Sim', noEngineReferences: true }));
    w('Assets/Sim/Rules.cs', 'namespace Sim { public static class Rules { public static int Add(int a, int b) => a + b; } }\n');
    w('Assets/Editor/StudioBuild.cs', '// stand-in\n');
    return p;
  };
  try {
    // ---------- (a) direct: seed, save, key, lock (runs on every platform) ----------
    {
      const a = project('direct-a');
      const b = project('direct-b');
      const c = project('direct-c', { manifest: '{ "dependencies": { "com.example.ui": "2.0.0" } }' });
      fs.mkdirSync(path.join(a, 'Library'), { recursive: true });
      fs.writeFileSync(path.join(a, 'Library', 'ArtifactDB'), 'imported');
      fs.writeFileSync(path.join(a, 'Library', 'ArtifactDB-lock'), 'lock');
      const cacheDir = path.join(T, 'cache-direct');
      const f = path.join(T, 'probe-direct.mjs');
      fs.writeFileSync(f, `import fs from 'node:fs';
import path from 'node:path';
import { seedLibrary, saveLibrary, cacheKey } from ${u('harness/unity-cache.mjs')};
const env = { ...process.env, STUDIO_UNITY_LIBRARY_CACHE: ${JSON.stringify(cacheDir)} };
const [a, b, c] = ${JSON.stringify([a, b, c])};
const coldB = seedLibrary(b, { env }).status;
const saved = saveLibrary(a, { env });
const seeded = seedLibrary(b, { env });
const ino = (p) => fs.statSync(p).ino;
const copied = fs.existsSync(path.join(b, 'Library', 'ArtifactDB')) && !fs.lstatSync(path.join(b, 'Library')).isSymbolicLink() && ino(path.join(b, 'Library', 'ArtifactDB')) !== ino(path.join(${JSON.stringify(cacheDir)}, saved.key, 'Library', 'ArtifactDB'));
const noLock = !fs.existsSync(path.join(b, 'Library', 'ArtifactDB-lock'));
const again = seedLibrary(b, { env }).status;
const keyC = cacheKey(c).key, keyA = cacheKey(a).key;
const coldC = seedLibrary(c, { env }).status;
const off = seedLibrary(c, { env: { ...env, STUDIO_UNITY_LIBRARY_CACHE: 'off' } }).status;
console.log(JSON.stringify({ coldB, saved: saved.status, seeded: seeded.status, copied, noLock, again, keyA, keyC, coldC, off }));`);
      const r = run(dir, `node "${f}"`, base);
      const j = (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return {}; } })();
      guard('2.67.1 (k)(a): the Library cache module: a copy with no Library is cold until a green copy saves one, then gets it seeded as a real copy (no link, same files, its own inodes, no *-lock files), keeps its own Library after that, a packages change is another key (cold), and STUDIO_UNITY_LIBRARY_CACHE=off is off (2.67.0: no cache at all)', () => [
        j.coldB === 'cold' && j.saved === 'saved' && j.seeded === 'seeded' && j.copied && j.noLock && j.again === 'warm-here' && j.keyA && j.keyC && j.keyA !== j.keyC && j.coldC === 'cold' && j.off === 'off',
        JSON.stringify({ j, o: out(r).slice(-800) })]);
    }

    if (process.platform === 'win32') {
      report('2.67.1 (k): the stand-in editor checks (skipped on Windows: the stand-in editor is a POSIX script)', true, '');
      return;
    }

    // ---------- the stand-in editor ----------
    const seenF = path.join(T, 'seen.txt');
    const fake = path.join(T, 'fake-unity.mjs');
    fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const at = (k) => a[a.indexOf(k) + 1];
const proj = at('-projectPath');
const lane = path.basename(path.dirname(proj));
const seen = (s) => fs.appendFileSync(${JSON.stringify(seenF)}, s + ' ' + lane + ' ' + (process.env.STUDIO_HEAVY_HELD ? 'held' : 'none') + ' ' + Date.now() + '\\n');
// The import a fresh copy needs (about 10 min in real life): only when Library/ is missing.
if (!fs.existsSync(path.join(proj, 'Library', 'ArtifactDB'))) {
  seen('import');
  fs.mkdirSync(path.join(proj, 'Library'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'Library', 'ArtifactDB'), 'imported ' + Date.now());
  fs.writeFileSync(path.join(proj, 'Library', 'ArtifactDB-lock'), 'lock');
}
const platform = at('-testPlatform');
seen('tests-' + platform);
const planF = path.join(${JSON.stringify(T)}, 'plan-' + platform + '.json');
let plan = [];
try { plan = JSON.parse(fs.readFileSync(planF, 'utf8')); } catch {}
const step = plan.shift() || 'pass';
fs.writeFileSync(planF, JSON.stringify(plan));
if (step === 'compile') { console.log('Assets/Scripts/Dock.cs(3,5): error CS0103: The name \\'dock\\' does not exist in the current context'); process.exit(1); }
if (step === 'fail') fs.writeFileSync(at('-testResults'), '<test-run total="2" passed="1" failed="1" skipped="0" result="Failed"><test-case fullname="Game.PlayTests.CartDocks" result="Failed"><failure><message><![CDATA[expected docked]]></message></failure></test-case></test-run>');
else fs.writeFileSync(at('-testResults'), '<test-run total="2" passed="2" failed="0" skipped="0" result="Passed"></test-run>');
`);
    fs.chmodSync(fake, 0o755);
    const uenv = { ...base, STUDIO_UNITY: fake };
    const seen = () => { try { return fs.readFileSync(seenF, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const [what, lane, held, at] = l.split(' '); return { what, lane, held, at: Number(at) }; }); } catch { return []; } };
    const reset = () => { fs.rmSync(seenF, { force: true }); for (const p of ['EditMode', 'PlayMode']) fs.rmSync(path.join(T, `plan-${p}.json`), { force: true }); };
    const plan = (platform, steps) => fs.writeFileSync(path.join(T, `plan-${platform}.json`), JSON.stringify(steps));
    const gate = (p, env = {}) => run(dir, `node harness/unity.mjs gate "${p}"`, { ...uenv, ...env });
    const cacheRootDir = path.join(dir, '.studio', 'unity-cache');
    const keyOf = (p) => { const r = run(dir, `node harness/unity-cache.mjs status "${p}" --json`, uenv); try { return JSON.parse(String(r.stdout).trim().split('\n').pop()).key; } catch { return null; } };

    // ---------- (a) through the gate: seeded then reused; keyed; concurrent safety ----------
    {
      reset();
      const a = project('lane-a');
      const g1 = gate(a);
      const b = project('lane-b');
      const g2 = gate(b);
      const s = seen();
      const key = keyOf(a);
      guard('2.67.1 (k)(a): the warm Library: the first green gate in a fresh copy imports and saves the Library; a second fresh copy of the same project gets it seeded and its editor does no import (2.67.0: every fresh copy re-imported, ~10 min)', () => [
        g1.status === 0 && g2.status === 0 && s.filter((x) => x.what === 'import' && x.lane === 'lane-a').length === 1 && !s.some((x) => x.what === 'import' && x.lane === 'lane-b')
          && Boolean(key) && fs.existsSync(path.join(cacheRootDir, key, 'Library', 'ArtifactDB')) && /Library cache \(before the editor\): seeded/.test(out(g2)) && /Library cache \(after the green run\): saved/.test(out(g1)),
        JSON.stringify({ s, key, g1: out(g1).slice(-700), g2: out(g2).slice(-700) })]);

      reset();
      const c = project('lane-c', { version: '6000.3.2f1' });
      const gc = gate(c);
      const d = project('lane-d', { manifest: '{ "dependencies": { "com.example.ui": "1.1.0" } }' });
      const gd = gate(d);
      const e = project('lane-e');
      const ge = gate(e, { STUDIO_UNITY_LIBRARY_CACHE: 'off' });
      const s2 = seen();
      const keys = fs.existsSync(cacheRootDir) ? fs.readdirSync(cacheRootDir).filter((n) => !n.endsWith('.lock')) : [];
      guard('2.67.1 (k)(a): the cache is keyed: another Unity version or a Packages/manifest.json change starts fresh (an import, then its own key), only the newest 2 keys of a project are kept, and STUDIO_UNITY_LIBRARY_CACHE=off imports as before (2.67.0: no keys at all)', () => [
        gc.status === 0 && gd.status === 0 && ge.status === 0 && ['lane-c', 'lane-d', 'lane-e'].every((l) => s2.some((x) => x.what === 'import' && x.lane === l))
          && keyOf(c) !== key && keyOf(d) !== key && keys.includes(keyOf(d)) && keys.length === 2 && !/Library cache/.test(out(ge)),
        JSON.stringify({ s2, keys, gc: out(gc).slice(-400), gd: out(gd).slice(-400) })]);

      // Another run is copying this key's Library (a live holder of <cache>/<key>.lock): no sharing, no overwrite.
      reset();
      const sl = spawn(process.execPath, [sleepF, String(20000 * SLOW)], { windowsHide: true, stdio: 'ignore' });
      kids.push(sl);
      const keyNow = keyOf(project('lane-f', { manifest: '{ "dependencies": { "com.example.ui": "1.1.0" } }' }));
      const readMeta = () => { try { return fs.readFileSync(path.join(cacheRootDir, String(keyNow), 'meta.json'), 'utf8'); } catch { return null; } };
      const metaBefore = readMeta();
      fs.mkdirSync(cacheRootDir, { recursive: true });
      fs.writeFileSync(path.join(cacheRootDir, `${keyNow}.lock`), JSON.stringify({ pid: sl.pid, at: Date.now(), what: 'seed lane-x' }));
      const gf = gate(path.join(T, 'lane-f', 'mygame'));
      const s3 = seen();
      const metaAfter = readMeta();
      sl.kill();
      fs.rmSync(path.join(cacheRootDir, `${keyNow}.lock`), { force: true });
      guard('2.67.1 (k)(a): never shared at once: while another run holds the key\'s cache lock, a gate neither seeds from it nor saves over it (it imports from scratch, says so, and still passes) (2.67.0: no lock)', () => [
        gf.status === 0 && s3.some((x) => x.what === 'import' && x.lane === 'lane-f') && /before the editor\): busy: seed lane-x/.test(out(gf)) && /after the green run\): busy/.test(out(gf)) && Boolean(metaBefore) && metaBefore === metaAfter,
        JSON.stringify({ s3, gf: out(gf).slice(-800) })]);
    }

    // ---------- (b) Play Mode flake retry ----------
    {
      const flakesF = path.join(dir, '.studio', 'unity-flakes.jsonl');
      reset();
      fs.rmSync(flakesF, { force: true });
      const p = project('lane-g');
      plan('PlayMode', ['fail', 'pass']);
      const g = gate(p);
      const s = seen();
      const rec = (() => { try { return JSON.parse(fs.readFileSync(flakesF, 'utf8').trim().split('\n').pop()); } catch { return null; } })();
      const df = path.join(T, 'probe-digest.mjs');
      fs.writeFileSync(df, `import { buildDigest } from ${u('harness/digest.mjs')};\nconst d = await buildDigest({});\nconsole.log(JSON.stringify({ text: d.text }));`);
      const dg = run(dir, `node "${df}"`, base);
      const dtext = (() => { try { return JSON.parse(String(dg.stdout).trim().split('\n').pop()).text; } catch { return out(dg); } })();
      guard('2.67.1 (k)(b): a Play Mode failure gets one retry: fail then pass is green, with a WARN naming the test, a record in .studio/unity-flakes.jsonl (test names, both results, both logs, which exist) and a line in the daily digest (2.67.0: one failure was red)', () => [
        g.status === 0 && s.filter((x) => x.what === 'tests-PlayMode').length === 2 && /WARN PlayMode flaked: Game\.PlayTests\.CartDocks/.test(out(g)) && /WARN flaky PlayMode/.test(out(g))
          && rec?.tests?.[0] === 'Game.PlayTests.CartDocks' && rec.first?.result === 'failed' && rec.second?.result === 'passed' && rec.logs?.length === 2 && rec.logs.every((l) => fs.existsSync(path.join(dir, l)))
          && /Unity Play Mode flaked 1 time in 24 h.*CartDocks/.test(dtext),
        JSON.stringify({ s, rec, g: out(g).slice(-900), dtext: String(dtext).slice(-600) })]);

      const flakeLines = () => { try { return fs.readFileSync(flakesF, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
      const before = flakeLines();
      reset(); plan('PlayMode', ['fail', 'fail']);
      const ff = gate(p);
      const ffRuns = seen().filter((x) => x.what === 'tests-PlayMode').length;
      reset(); plan('PlayMode', ['compile', 'pass']);
      const ce = gate(p);
      const ceRuns = seen().filter((x) => x.what === 'tests-PlayMode').length;
      reset(); plan('EditMode', ['fail', 'pass']);
      const em = gate(p);
      const emRuns = seen().filter((x) => x.what === 'tests-EditMode').length;
      reset(); plan('PlayMode', ['fail', 'pass']);
      const off = gate(p, { STUDIO_UNITY_PLAYMODE_RETRY: 'off' });
      const offRuns = seen().filter((x) => x.what === 'tests-PlayMode').length;
      guard('2.67.1 (k)(b): the retry is only for a Play Mode test failure: fail-fail is red after exactly two runs (no flake record), a compile error runs once and is red, an Edit Mode failure runs once and is red, and STUDIO_UNITY_PLAYMODE_RETRY=off runs once (2.67.0: never a second run)', () => [
        ff.status === 1 && ffRuns === 2 && /again on retry: red/.test(out(ff)) && ce.status === 1 && ceRuns === 1 && /compile errors/.test(out(ce)) && em.status === 1 && emRuns === 1 && off.status === 1 && offRuns === 1 && flakeLines() === before,
        JSON.stringify({ ffRuns, ceRuns, emRuns, offRuns, ff: out(ff).slice(-500), ce: out(ce).slice(-300) })]);
    }

    // ---------- (c) code-only steps while the editor is busy ----------
    {
      const gameJson = path.join(dir, 'studio', 'game.json');
      const gameBefore = fs.existsSync(gameJson) ? fs.readFileSync(gameJson, 'utf8') : null;
      const codeF = path.join(T, 'code-only.mjs');
      fs.writeFileSync(codeF, `import fs from 'node:fs';\nimport path from 'node:path';\nfs.appendFileSync(${JSON.stringify(seenF)}, 'code ' + path.basename(path.dirname(process.argv[2])) + ' ' + (process.env.STUDIO_HEAVY_HELD ? 'held' : 'none') + ' ' + Date.now() + '\\n');\nif (fs.existsSync(${JSON.stringify(path.join(T, 'code-fails'))})) { console.log('1 of 3 code tests failed: Rules.AddWraps'); process.exit(1); }\n`);
      fs.mkdirSync(path.dirname(gameJson), { recursive: true });
      fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: { unity: { codeOnly: [`node "${codeF}" {folder}`] } } }, null, 2));
      try {
        reset();
        const p = project('lane-h');
        const h = holder(5000 * SLOW);
        const t0 = Date.now();
        const g = gate(p, { STUDIO_HEAVY_WAIT_MIN: '1' });
        const s = seen();
        h.gone();
        const code = s.find((x) => x.what === 'code');
        const firstEditor = s.find((x) => x.what !== 'code');
        guard('2.67.1 (k)(c): code-only steps (studio/game.json engines.unity.codeOnly) run first and without machine:heavy while another holder has it; the editor step waits for the lock and runs after it is free (2.67.0: codeOnly was never run, everything waited)', () => [
          h.up && g.status === 0 && code?.held === 'none' && code.at - t0 < 4000 * SLOW && firstEditor?.held === 'held' && firstEditor.at - code.at >= 2000 && /PASS code-only: node/.test(out(g)) && /waits for the machine:heavy lock/.test(out(g)),
          JSON.stringify({ up: h.up, s, t0, g: out(g).slice(-900) })]);

        reset();
        fs.writeFileSync(path.join(T, 'code-fails'), '1');
        const h2 = holder(30000 * SLOW);
        const t1 = Date.now();
        const g2 = gate(p, { STUDIO_HEAVY_WAIT_MIN: '0.1' });
        const ms = Date.now() - t1;
        const s2 = seen();
        h2.c.kill();
        h2.gone();
        fs.rmSync(path.join(T, 'code-fails'), { force: true });
        guard('2.67.1 (k)(c): a code-only failure stops before waiting for the editor: red (exit 1, not busy 3) at once beside a holder, naming the step and its last lines, and the editor never runs (2.67.0: it waited for the lock and gave up busy)', () => [
          h2.up && g2.status === 1 && ms < 5000 * SLOW && /code-only step .* failed \(exit 1\): 1 of 3 code tests failed/.test(out(g2)) && /did not run/.test(out(g2)) && s2.length === 1 && s2[0].what === 'code',
          JSON.stringify({ up: h2.up, ms, s2, g2: out(g2).slice(-700) })]);
      } finally {
        if (gameBefore === null) fs.rmSync(gameJson, { force: true }); else fs.writeFileSync(gameJson, gameBefore);
      }
    }
  } finally {
    for (const c of kids) { try { c.kill(); } catch {} }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
  }
}
