/**
 * qa/selftest-242.mjs — the 2.42.0 checks: the Godot binary, the project, the export templates and gdUnit4
 * agree on the version (harness/godot-version.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest242({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p242-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  // The Marina box: a 4.7 project with export presets, only 4.7.2 templates installed, gdUnit4 set up for 4.7.2,
  // and a 4.5.1 binary running the gate.
  w('engine/zz-v/project.godot', '[application]\nconfig/name="zz"\nconfig/features=PackedStringArray("4.7", "Forward Plus")\n');
  w('engine/zz-v/export_presets.cfg', '[preset.0]\nname="Web"\nplatform="Web"\n');
  const templates = path.join(tmpRoot, `templates-242-${process.pid}`);
  fs.mkdirSync(path.join(templates, '4.7.2.stable'), { recursive: true });
  w('studio/godot-unit.json', JSON.stringify({ enabled: true, project: 'engine/zz-v', tests: 'res://tests', gdunit: 'v7.0.0', godot: '4.7.2', watch: ['sim'] }));
  const env = { STUDIO_GODOT_TEMPLATES: templates };

  // 1. Each mismatch named, with what to do; a matching set has none.
  const v = probe(`import { checkGodotVersions, parseVersion, newer } from ${u('harness/godot-version.mjs')};
const bad = checkGodotVersions('engine/zz-v', { binary: parseVersion('4.5.1.stable.official.f62fdbde1') });
const good = checkGodotVersions('engine/zz-v', { binary: parseVersion('4.7.2.stable.official') });
console.log(JSON.stringify({ bad, good, order: [newer('4.10', '4.9'), newer('4.5', '4.7'), newer('4.7', '4.7')] }));`, env);
  report('2.42.0: a Godot binary of another version than the project, missing export templates for the binary, and gdUnit4 set up for another version are each named; a matching set has no problem; versions compare as numbers (4.10 > 4.9)', v.bad?.problems?.length === 3 && /the project is Godot 4\.7 but the gate runs Godot 4\.5\.1: an older Godot may not open it/.test(v.bad.problems[0]) && /export templates for Godot 4\.5\.1\.stable aren't installed .*has 4\.7\.2\.stable/.test(v.bad.problems[1]) && /gdUnit4 is set up for Godot 4\.7\.2/.test(v.bad.problems[2]) && v.good?.problems?.length === 0 && JSON.stringify(v.order) === '[true,false,false]', JSON.stringify(v));

  // 2. The engine gate: notes by default, fails with STUDIO_GODOT_PIN=fail. A fake Godot that reports 4.5.1.
  if (process.platform === 'win32') {
    report('2.42.0: the engine gate warns or fails on a Godot version mismatch (skipped on Windows: the fake Godot is a shell script)', true);
    return;
  }
  const fake = path.join(tmpRoot, `fake-godot-242-${process.pid}`);
  fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "4.5.1.stable.official.f62fdbde1"; fi\nexit 0\n', { mode: 0o755 });
  const genv = { ...env, STUDIO_GODOT: fake, STUDIO_GATE_SLOTS: '0' };
  const warn = run(dir, 'node harness/game-gates.mjs --paths engine/zz-v', genv);
  const fail = run(dir, 'node harness/game-gates.mjs --paths engine/zz-v', { ...genv, STUDIO_GODOT_PIN: 'fail' });
  report('2.42.0: the engine gate prints each Godot version mismatch as a WARN and still passes by default; STUDIO_GODOT_PIN=fail fails it with the reasons', warn.status === 0 && /WARN engine:engine\/zz-v: Godot version: the project is Godot 4\.7/.test(out(warn)) && /PASS engine:engine\/zz-v/.test(out(warn)) && fail.status !== 0 && /FAIL engine:engine\/zz-v: Godot version: the project is Godot 4\.7/.test(out(fail)), `${out(warn)}\n---\n${out(fail)}`);
}
