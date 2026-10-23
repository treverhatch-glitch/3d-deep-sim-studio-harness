/**
 * qa/selftest-230n.mjs — the 2.30n checks, run by qa/selftest.mjs on a copy of the repo.
 * The gates follow the studio's game (its own checks, not example-sim's), the Godot engine gate, engine
 * cache churn ignored, the lane copy's main checkout and identity from its path, task done refusing a lane
 * copy with no main checkout, --force needing --reason, the system spec being this task's, and a live lane
 * copy never removed by a cleanup. The lane-root checks are in qa/selftest-230n-lane.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest230n({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); if (mode) fs.chmodSync(path.join(dir, rel), mode); };
  const base = { STUDIO_LOCK_OWNER: 'builder-n1', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_DONE_NOOP: 'allow' };

  const none = run(dir, 'node harness/game-gates.mjs', base);
  report('2.30n: with no studio game set the game gate passes and defers to the cartridge gates', none.status === 0 && /no studio game set/.test(out(none)), out(none));

  w('web/zz-game/index.html', '<!doctype html>\n');
  w('web/zz-game/sim/qa.mjs', "console.log(process.env.ZZ_QA === 'pass' ? 'PASS all' : 'FAIL reckless: expected lost'); process.exit(process.env.ZZ_QA === 'pass' ? 0 : 1);\n");
  const env = { ...base, STUDIO_GAME: 'zz-game' };
  const bad = run(dir, 'node harness/game-gates.mjs', env);
  report('2.30n: the game gate runs the studio game\'s own sim/qa.mjs and fails when it fails', bad.status !== 0 && /FAIL game:qa/.test(out(bad)), out(bad));
  const good = run(dir, 'node harness/game-gates.mjs', { ...env, ZZ_QA: 'pass' });
  report('2.30n: ...and passes when the game\'s scenarios pass', good.status === 0 && /PASS game:qa/.test(out(good)), out(good));

  w('web/zz-game/studio.gates.json', JSON.stringify({ gates: [{ id: 'playtest', command: 'node -e "process.exit(0)"' }, { id: 'scenarios', command: 'node web/zz-game/sim/qa.mjs' }] }));
  const man = run(dir, 'node harness/game-gates.mjs', { ...env, ZZ_QA: 'pass' });
  report('2.30n: a game\'s studio.gates.json declares its checks', man.status === 0 && /PASS game:playtest/.test(out(man)) && /PASS game:scenarios/.test(out(man)), out(man));
  w('web/zz-empty/index.html', '<!doctype html>\n');
  const empty = run(dir, 'node harness/game-gates.mjs', { ...base, STUDIO_GAME: 'zz-empty' });
  report('2.30n: a game that declares no checks fails the gate instead of passing silently', empty.status !== 0 && /declares no checks/.test(out(empty)), out(empty));

  const v = run(dir, 'node scripts/run-gates.mjs --tier fast --no-cache', env);
  report('2.30n: verify skips example-sim\'s cartridge gates for a non-cartridge game and runs its own checks', /cartridge gates are skipped/.test(out(v)) && /FAIL game/.test(out(v)) && !/PASS golden\b/.test(out(v)) && v.status !== 0, out(v).slice(-3000));

  const add = run(dir, 'node harness/task.mjs add "Coordinate the harbour notes" --role producer --origin dev --asked "test"', env);
  const id = (out(add).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${id} --agent builder-n1`, env);
  const blocked = run(dir, `node harness/task.mjs done ${id} --agent builder-n1`, env);
  report('2.30n: task done refuses when the studio game\'s checks fail', Boolean(id) && blocked.status !== 0 && /game's checks fail/.test(out(blocked)), `${out(add)}${out(blocked)}`);
  const noReason = run(dir, `node harness/task.mjs done ${id} --agent builder-n1 --force`, env);
  const shortR = run(dir, `node harness/task.mjs done ${id} --agent builder-n1 --force --reason "meh"`, env);
  report('2.30n: --force without a 10+ character --reason is refused', noReason.status !== 0 && shortR.status !== 0 && /--force needs --reason/.test(out(noReason)), `${out(noReason)}${out(shortR)}`);
  const passes = run(dir, `node harness/task.mjs done ${id} --agent builder-n1`, { ...env, ZZ_QA: 'pass' });
  report('2.30n: task done passes once the game\'s checks pass', passes.status === 0, out(passes));

  w('godot/zz/project.godot', 'config_version=5\n');
  w('godot/zz/main.gd', 'extends Node\n');
  // 2.30o: a node stand-in (a .cmd wrapper on Windows), not a shell script: Windows can't run a .sh (EFTYPE in the 2.30n CI).
  w('fake-godot.mjs', "console.log('Godot Engine v4.7.2.stable'); if (process.env.ZZ_GODOT === 'bad') console.log('SCRIPT ERROR: Parse Error: Unexpected identifier'); process.exit(0);\n");
  if (process.platform === 'win32') w('fake-godot.cmd', `@node "%~dp0fake-godot.mjs" %*\r\n`);
  else w('fake-godot', `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(path.join(dir, 'fake-godot.mjs')).href)});\n`, 0o755);
  const genv = { ...base, STUDIO_GODOT: path.join(dir, process.platform === 'win32' ? 'fake-godot.cmd' : 'fake-godot') };
  const gBad = run(dir, 'node harness/game-gates.mjs --paths godot/zz/main.gd', { ...genv, ZZ_GODOT: 'bad' });
  const gOk = run(dir, 'node harness/game-gates.mjs --paths godot/zz/main.gd', genv);
  const gNot = run(dir, 'node harness/game-gates.mjs --paths web/zz-game/index.html', { ...genv, ZZ_GODOT: 'bad' });
  report('2.30n: the engine gate runs Godot for files in a Godot project and fails on a SCRIPT ERROR line', gBad.status !== 0 && /FAIL engine:godot\/zz/.test(out(gBad)) && gOk.status === 0 && /PASS engine:godot\/zz/.test(out(gOk)) && !/engine:/.test(out(gNot)), `${out(gBad)}${out(gOk)}${out(gNot)}`);

  const real = process.env.STUDIO_GODOT_REAL || '/workspace/tools/godot472/Godot_v4.7.2-stable_linux.x86_64';
  if (fs.existsSync(real)) {
    w('godot/zr/project.godot', 'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n');
    w('godot/zr/main.tscn', '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n');
    w('godot/zr/tools/gate.gd', 'extends SceneTree\nvar frames := 0\nfunc _initialize() -> void:\n\tvar scene = load(ProjectSettings.get_setting("application/run/main_scene"))\n\tif scene == null:\n\t\tprint("ERROR: the main scene did not load")\n\t\tquit(1)\n\t\treturn\n\troot.add_child(scene.instantiate())\nfunc _process(_d: float) -> bool:\n\tframes += 1\n\tif frames >= 5:\n\t\tquit(0)\n\treturn false\n');
    w('godot/zr/main.gd', 'extends Node\nfunc _ready() -> void:\n\tprint("ok")\n');
    const renv = { ...base, STUDIO_GODOT: real };
    const rOk = run(dir, 'node harness/game-gates.mjs --paths godot/zr/main.gd', renv);
    w('godot/zr/main.gd', 'extends Node\nfunc _ready() -> void:\n\tthis is not gdscript(\n');
    const rBad = run(dir, 'node harness/game-gates.mjs --paths godot/zr/main.gd', renv);
    report('2.30n: real Godot 4.7.2: the engine gate passes a good project and fails when the main script does not load', rOk.status === 0 && rBad.status !== 0, `${out(rOk)}${out(rBad)}`);
  }

  const churn = run(dir, `node -e "import('./harness/game-gates.mjs').then(m=>console.log(JSON.stringify(['godot/a/.godot/x.cache','godot/a/icon.png.import','godot/a/main.gd.uid','godot/a/main.gd'].map(m.isEngineChurn))))"`);
  report('2.30n: Godot import/editor cache files (.godot/, *.import, *.uid) are ignored as churn; scripts are not', out(churn).trim() === '[true,true,true,false]', out(churn));

  // Lane copies: identity from the lane's name; a lane whose main checkout can't be found refuses done.
  const copyInto = (to) => { fs.mkdirSync(to, { recursive: true }); spawnSync('cp', ['-a', ...['harness', 'package.json', 'studio', 'qa', 'scripts'].map((x) => path.join(dir, x)), to]); };
  const laneDir = path.join(dir, '.lanes', 'zz-builder');
  copyInto(laneDir);
  const who = run(laneDir, `node -e "import('./harness/task.mjs').then(t=>console.log(t.whoAmI({})))"`, { STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: 'someone-else' });
  report('2.30n: in a lane copy the agent is the lane\'s name, not an inherited STUDIO_LOCK_OWNER', who.stdout.trim().split('\n').pop() === 'zz-builder', out(who));
  fs.rmSync(laneDir, { recursive: true, force: true });
  const orphan = path.join(dir, 'zz-nogit', '.lanes', 'zz-builder');
  copyInto(orphan);
  const noRoot = run(orphan, 'node harness/task.mjs done T-999 --agent zz-builder', { ...base, STUDIO_MAIN_ROOT: '' });
  report('2.30n: task done in a lane copy whose main checkout can\'t be found refuses instead of skipping the merge', noRoot.status !== 0 && /STUDIO_MAIN_ROOT isn't set/.test(out(noRoot)), out(noRoot));
  fs.rmSync(path.join(dir, 'zz-nogit'), { recursive: true, force: true });

  const sys = run(dir, 'node harness/task.mjs add "System: tide tables" --role builder --type system --size 2 --origin dev --asked "test"', base);
  const sid = (out(sys).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${sid} --agent builder-n1`, base);
  w('studio/bible/systems/other-system.md', `# Another system\n\nT-1 only.\n\n## For the next agent\n${'word '.repeat(90)}\n`);
  const chk = () => run(dir, `node -e "import('./harness/done-check.mjs').then(m=>import('./harness/task.mjs').then(t=>{const q=t.parseNextQueue();const k=[...q.inProgress,...q.backlog].find(x=>x.id==='${sid}');const c=m.checkDone(k);console.log(JSON.stringify(c.checks.find(x=>/^Spec for this task/.test(x.label))))}))"`, base);
  const other = chk();
  w('studio/bible/systems/tide-tables.md', `# Tide tables (${sid})\n\n## For the next agent\n${'word '.repeat(90)}\n`);
  const mine = chk();
  report('2.30n: the system done-check wants a spec naming this task, not any spec written meanwhile', /"ok":false/.test(out(other)) && /"ok":true/.test(out(mine)), `${out(other)}${out(mine)}`);

  // 2.30o: finding a process by its working folder needs /proc (Linux). Elsewhere (the 2.30n Windows CI) the
  // live check rests on claims and recent changes, so test that instead of a live process.
  if (process.platform !== 'linux') {
    const lw = path.join(dir, '.lanes', 'zz-live');
    fs.mkdirSync(lw, { recursive: true });
    const rmw = (min) => run(dir, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.removeLaneCopy('zz-live',{ifIdle:true}))))"`, { STUDIO_LANE_LIVE_MIN: min });
    const keptW = rmw('20');
    const stillW = fs.existsSync(lw);
    const goneW = rmw('0');
    report('2.30n: lane cleanup keeps a recently changed copy and removes it once idle (non-Linux: no /proc process check)', /"kept":true/.test(out(keptW)) && stillW && !fs.existsSync(lw), `${out(keptW)}${out(goneW)}`);
  } else {
  const live = path.join(dir, '.lanes', 'zz-live');
  fs.mkdirSync(live, { recursive: true });
  const p = spawn('sleep', ['30'], { cwd: live, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  const rm = () => run(dir, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.removeLaneCopy('zz-live',{ifIdle:true}))))"`, { STUDIO_LANE_LIVE_MIN: '0' });
  const kept = rm();
  const stillThere = fs.existsSync(live);
  p.kill();
  await new Promise((r) => setTimeout(r, 200));
  const gone = rm();
  report('2.30n: lane cleanup keeps a copy a live process is working in, and removes it once idle', /"kept":true/.test(out(kept)) && stillThere && !fs.existsSync(live), `${out(kept)}${out(gone)}`);
  }

  // The other half: the lane-root derivation (qa/selftest-230n-lane.mjs).
  const { selftest230nLane } = await import(pathToFileURL(path.join(dir, 'qa', 'selftest-230n-lane.mjs')).href);
  await selftest230nLane({ dir, run, report, tmpRoot });
}
