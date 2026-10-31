/**
 * qa/selftest-246.mjs — the 2.46.0 checks that need neither .NET nor Unity: the Unity track's sim purity
 * check, its reading of Unity's NUnit results, the version pin, a Unity engine track started from
 * engine/_unity, and adopting an existing Unity project. The .NET proof (tests, parity, planted faults) is
 * scripts/check-unity-template.mjs in CI's engine-unity-sim job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest246({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };
  const u = await imp('harness/unity.mjs');

  // 1. Purity: the shipped template is clean; each planted fault is named; comments and strings don't count.
  const tpl = path.join(dir, 'engine/_unity');
  const clean = u.simPurity(tpl);
  const plant = (name, code, asmdef = null) => {
    const d = path.join(tmpRoot, `unity-246-${name}-${process.pid}`);
    fs.mkdirSync(path.join(d, 'Assets/Sim'), { recursive: true });
    fs.writeFileSync(path.join(d, 'Assets/Sim/Sim.asmdef'), asmdef ?? JSON.stringify({ name: 'Sim', references: [], noEngineReferences: true }));
    fs.writeFileSync(path.join(d, 'Assets/Sim/Rules.cs'), code);
    return u.simPurity(d);
  };
  const faults = {
    engine: plant('engine', 'using UnityEngine;\nclass A {}\n'),
    time: plant('time', 'class A { float f() => Time.deltaTime; }\n'),
    random: plant('random', 'class A { int f() => new System.Random().Next(); }\n'),
    clock: plant('clock', 'class A { long f() => System.DateTime.Now.Ticks; }\n'),
    guid: plant('guid', 'class A { string f() => System.Guid.NewGuid().ToString(); }\n'),
    asmdef: plant('asmdef', 'class A {}\n', JSON.stringify({ name: 'Sim', references: ['UnityEngine.UI'], noEngineReferences: false })),
  };
  const seeded = plant('seeded', '// UnityEngine.Random is banned here; Time.deltaTime too.\nclass A { string s = "UnityEngine.Random.value"; int f(int seed) => new System.Random(seed).Next(); }\n');
  const named = (r, k) => !r.ok && r.problems.some((p) => p.includes(k));
  report('2.46.0: the Unity sim purity check passes the template\'s pure sim and names each planted fault (UnityEngine, Unity time, an unseeded Random, the wall clock, a random Guid, an asmdef with engine references); comments, strings and a seeded Random are fine', clean.ok && clean.files >= 1 && named(faults.engine, 'UnityEngine') && named(faults.time, 'Unity time') && named(faults.random, 'unseeded System.Random') && named(faults.clock, 'wall clock') && named(faults.guid, 'random Guid') && named(faults.asmdef, 'noEngineReferences') && named(faults.asmdef, 'UnityEngine.UI') && seeded.ok, JSON.stringify({ clean, faults, seeded }, null, 1).slice(0, 3000));

  // 2. Unity's NUnit results: counts and failures; a run with no test is an empty run.
  const xml = `<?xml version="1.0"?><test-run id="2" testcasecount="3" result="Failed(Child)" total="3" passed="2" failed="1" inconclusive="0" skipped="0">
<test-suite type="Assembly" name="ControlsTests.dll"><test-case id="1" name="BuyUnit" fullname="Studio.Game.Tests.ControlsTests.BuyUnit" result="Passed"></test-case>
<test-case id="2" name="BuyButton" fullname="Studio.Game.Tests.ControlsTests.BuyButton" result="Failed"><failure><message><![CDATA[buy-button: units 2 -> 2 after clicking Buy
  Expected: True]]></message></failure></test-case></test-suite></test-run>`;
  const res = u.parseNUnit(xml);
  const empty = u.parseNUnit('<test-run id="2" testcasecount="0" result="Passed" total="0" passed="0" failed="0"></test-run>');
  report('2.46.0: Unity\'s NUnit results are read: totals, and each failed test with its first message line; a run with no test reads as total 0 (the gate fails it)', res?.total === 3 && res.passed === 2 && res.failed === 1 && res.failures.length === 1 && /BuyButton/.test(res.failures[0].name) && /units 2 -> 2/.test(res.failures[0].message) && empty?.total === 0 && u.parseNUnit('not xml') === null, JSON.stringify({ res, empty }));

  // 3. The version pin.
  const pinOk = u.checkPin(tpl, '6000.3');
  const pinBad = u.checkPin(tpl, '6000.0');
  const pinNone = u.checkPin(tpl, '');
  report('2.46.0: STUDIO_UNITY_PIN accepts the project\'s version or its prefix (6000.3), refuses another (6000.0) with why an upgrade is a decision, and notes when no pin is set', pinOk.ok && !pinBad.ok && /STUDIO_UNITY_PIN is 6000\.0/.test(pinBad.why) && pinNone.ok && /no STUDIO_UNITY_PIN/.test(pinNone.note), JSON.stringify({ pinOk, pinBad, pinNone }));

  // 4. A Unity engine track starts from engine/_unity: the pure sim, the .NET tools, the editor-free parity.
  run(dir, 'node scripts/new-game.mjs tin-moon', env);
  const bj = path.join(dir, 'studio/bible/bible.json');
  fs.mkdirSync(path.dirname(bj), { recursive: true });
  fs.writeFileSync(bj, JSON.stringify({ ...(fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : {}), phase: { open: 2 } }));
  const st = run(dir, 'node harness/engine.mjs start unity --by prod-1', env);
  const track = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'engine/tin-moon/engine.json'), 'utf8')); } catch { return {}; } })();
  const tasks = JSON.parse(run(dir, 'node harness/task.mjs list', env).stdout || '{"backlog":[]}').backlog.filter((t) => t.role === 'engine-porter');
  const par = run(dir, 'node qa/parity.mjs', env);
  const purity = run(dir, 'node harness/unity.mjs purity', env);
  report('2.46.0: npm run engine -- start unity copies engine/_unity (pure sim, .NET test and parity projects, no build folders), records the editor gate and the editor-free parity command, queues the port into Assets/Sim, and parity waits while the sim is still the template', st.status === 0 && track.engine === 'unity' && track.gate === 'node harness/unity.mjs gate engine/tin-moon' && /dotnet run --project engine\/tin-moon\/tools\/SimCli -- parity \{seeds\}/.test(track.parity?.command || '') && fs.existsSync(path.join(dir, 'engine/tin-moon/Assets/Sim/Sim.cs')) && fs.existsSync(path.join(dir, 'engine/tin-moon/tools/SimTests/SimTests.csproj')) && !fs.existsSync(path.join(dir, 'engine/tin-moon/Library')) && tasks.some((t) => /Assets\/Sim\/ \(pure C#: npm run engine:sim must pass\)/.test(t.title)) && /SKIP the port in engine\/tin-moon\/ is still the template/.test(out(par)) && purity.status === 0 && /PASS sim purity/.test(out(purity)), `${out(st)}\n${JSON.stringify(track)}\n${JSON.stringify(tasks.map((t) => t.title))}\n${out(par)}\n${out(purity)}`);

  // 5. Adopting an existing Unity project: its sim checks are required, the editor's are optional; no Assets/Sim warns.
  const { gatesFor } = await imp('harness/adopt.mjs');
  const withSim = path.join(tmpRoot, `unity-game-246-${process.pid}`);
  fs.cpSync(tpl, withSim, { recursive: true });
  const g1 = gatesFor('runway', withSim);
  const noSim = path.join(tmpRoot, `unity-plain-246-${process.pid}`);
  fs.mkdirSync(path.join(noSim, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(noSim, 'Assets/Scripts'), { recursive: true });
  fs.writeFileSync(path.join(noSim, 'ProjectSettings/ProjectVersion.txt'), 'm_EditorVersion: 6000.0.85f1\n');
  fs.writeFileSync(path.join(noSim, 'Assets/Scripts/Plane.cs'), 'using UnityEngine; public class Plane : MonoBehaviour { void Update() { transform.position += Vector3.forward * Time.deltaTime * Random.value; } }\n');
  const { spawnSync } = await import('node:child_process');
  const gg = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  gg(noSim, 'init', '-q', '-b', 'main'); gg(noSim, 'add', '-A'); gg(noSim, 'commit', '-qm', 'start');
  const ad = run(dir, `node scripts/onboard-game.mjs --path "${noSim}" --name "Plain Runway" --adopt`, env);
  const ids = (g) => g.gates.map((x) => `${x.id}${x.required === false ? '?' : ''}`).join(',');
  report('2.46.0: adopting a Unity project declares its checks: sim purity and the .NET sim tests (required) when it has a pure sim, the editor\'s Edit Mode and Play Mode tests (optional until every machine has the editor); one with no pure sim gets a warning saying why', ids(g1) === 'sim-purity,sim,unity-editmode?,unity-playmode?' && g1.shared.includes('game/runway/Packages/manifest.json') && /node harness\/unity\.mjs gate game\/runway --platform PlayMode/.test(g1.gates.find((x) => x.id === 'unity-playmode')?.command || '') && ad.status === 0 && /a Unity project with no pure sim assembly/.test(out(ad)), `${ids(g1)}\n${JSON.stringify(g1.shared)}\n${out(ad)}`);
}
