/**
 * qa/selftest-238.mjs — the 2.38.0 checks: built but not wired (harness/reachability.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest238({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p238-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };

  // 1. The parser: every way a module is pulled in.
  const p = probe(`import { specifiers, htmlEntries } from ${u('harness/reachability.mjs')};
console.log(JSON.stringify({ s: specifiers("import a from './a.mjs';\\nimport { b } from \\"./b.js\\";\\nimport './side.mjs';\\nexport * from './re.mjs';\\nconst c = await import('./lazy.mjs');\\nconst d = require('./old.cjs');\\nnew Worker('./w.js', { type: 'module' });\\nimport three from 'three';").sort(), h: htmlEntries('<script type=\\"module\\" src=\\"./main.mjs\\"></script><script type=\\"module\\">import \\"./boot.mjs\\";</script>').sort() }));`);
  report('2.38.0: reachability reads static, side-effect, re-export, dynamic, require and Worker imports, and <script src> plus inline module imports', JSON.stringify(p.s) === JSON.stringify(['./a.mjs', './b.js', './lazy.mjs', './old.cjs', './re.mjs', './side.mjs', './w.js', 'three']) && JSON.stringify(p.h) === JSON.stringify(['./boot.mjs', './main.mjs']), JSON.stringify(p));

  // 2. A web game: wired, test-only and demo-only modules.
  w('web/zz-r/index.html', '<!doctype html><script type="module" src="./main.mjs"></script>\n');
  w('web/zz-r/main.mjs', "import { a } from './sys/a.mjs';\nimport { al } from '@/alias.mjs';\nconst lazy = () => import('./sys/lazy.mjs');\n");
  w('web/zz-r/tsconfig.json', '{\n  // aliases, as a Vite project has them\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["sys/*"] } },\n}\n');
  w('web/zz-r/sys/alias.mjs', "import { r } from '/sys/rooted.mjs';\nexport const al = 6;\n");
  w('web/zz-r/sys/rooted.mjs', 'export const r = 7;\n');
  w('web/zz-r/sys/a.mjs', "import { c } from './c.js';\nexport const a = 1;\n");
  w('web/zz-r/sys/c.ts', 'export const c = 2;\n');
  w('web/zz-r/sys/lazy.mjs', 'export const l = 3;\n');
  w('web/zz-r/sys/crew.mjs', 'export const crew = 4; // built and tested, never wired\n');
  w('web/zz-r/tests/crew.test.mjs', "import { crew } from '../sys/crew.mjs';\n");
  w('web/zz-r/demos/crew.html', '<script type="module" src="../sys/crew.mjs"></script>\n');
  const files = ['web/zz-r/main.mjs', 'web/zz-r/sys/alias.mjs', 'web/zz-r/sys/rooted.mjs', 'web/zz-r/sys/a.mjs', 'web/zz-r/sys/c.ts', 'web/zz-r/sys/lazy.mjs', 'web/zz-r/sys/crew.mjs', 'web/zz-r/tests/crew.test.mjs'];
  const r1 = probe(`import { unreached } from ${u('harness/reachability.mjs')};
console.log(JSON.stringify(unreached(${JSON.stringify(files)})));`);
  report('2.38.0: a web module only a test or a demo page imports is flagged as built but not wired; modules reached from index.html (including dynamic imports, a .ts behind a ".js" import, a tsconfig "@/" alias and a "/x" path from the page folder) are not; tests are never flagged', JSON.stringify(r1) === JSON.stringify(['web/zz-r/sys/crew.mjs']), JSON.stringify(r1));

  // 3. A Godot project: main scene, autoload, class_name use; an orphan script.
  w('engine/zz-g/project.godot', '[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nBus="*res://bus.gd"\n');
  w('engine/zz-g/main.tscn', '[gd_scene format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n');
  w('engine/zz-g/main.gd', 'extends Node\nvar econ := Economy.new()\n');
  w('engine/zz-g/economy.gd', 'class_name Economy\nextends RefCounted\n');
  w('engine/zz-g/bus.gd', 'extends Node\n');
  w('engine/zz-g/orphan.gd', 'class_name Turnaround\nextends Node\n');
  w('engine/zz-g/tests/test_orphan.gd', 'extends GdUnitTestSuite\nvar t := Turnaround.new()\n');
  const gfiles = ['engine/zz-g/main.gd', 'engine/zz-g/economy.gd', 'engine/zz-g/bus.gd', 'engine/zz-g/orphan.gd', 'engine/zz-g/tests/test_orphan.gd'];
  const r2 = probe(`import { unreached } from ${u('harness/reachability.mjs')};
console.log(JSON.stringify(unreached(${JSON.stringify(gfiles)})));`);
  report('2.38.0: a Godot script reached from the main scene, an autoload or a class_name a reached script uses is wired; one only its test uses is flagged', JSON.stringify(r2) === JSON.stringify(['engine/zz-g/orphan.gd']), JSON.stringify(r2));

  // 4. The done-check: a build task whose new module nothing reaches gets a note by default, a failing check
  // with STUDIO_REACHABILITY=fail, and passes the check once it is wired.
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const env = { AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-238.jsonl'), STUDIO_TASK_BUDGET: 'off', STUDIO_REFILL_WAKE: 'off', STUDIO_VISUAL_GATE: 'off' };
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start', '--no-verify');
  const add = run(dir, 'node harness/task.mjs add "Add the crew turnaround system" --role builder', env);
  const id = (out(add).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${id} --agent builder-r1`, env);
  w('web/zz-r/sys/turnaround.mjs', 'export const turnaround = () => 5;\n');
  w('web/zz-r/tests/turnaround.test.mjs', "import { turnaround } from '../sys/turnaround.mjs';\n");
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `turnaround\n\nStudio-Task: ${id}`, '--no-verify');
  const warn = run(dir, `node harness/done-check.mjs ${id}`, env);
  const fail = run(dir, `node harness/done-check.mjs ${id}`, { ...env, STUDIO_REACHABILITY: 'fail' });
  w('web/zz-r/main.mjs', "import { a } from './sys/a.mjs';\nimport { al } from '@/alias.mjs';\nimport { turnaround } from './sys/turnaround.mjs';\nconst lazy = () => import('./sys/lazy.mjs');\n");
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', `wire it\n\nStudio-Task: ${id}`, '--no-verify');
  const wired = run(dir, `node harness/done-check.mjs ${id}`, { ...env, STUDIO_REACHABILITY: 'fail' });
  report('2.38.0: the done-check notes a build task\'s module that nothing in the game reaches (default), refuses it with STUDIO_REACHABILITY=fail, and stops once it is wired in', /note: web\/zz-r\/sys\/turnaround\.mjs is not reached from the game/.test(out(warn)) && !/\[ \] New game code is wired/.test(out(warn)) && /\[ \] New game code is wired into the game: web\/zz-r\/sys\/turnaround\.mjs/.test(out(fail)) && !/turnaround\.mjs is not reached/.test(out(wired)), `${out(warn)}\n---\n${out(fail)}\n---\n${out(wired)}`);
}
