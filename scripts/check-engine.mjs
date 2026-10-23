#!/usr/bin/env node
/**
 * scripts/check-engine.mjs — the engine track's gate: run the engine's own headless tests and smoke run.
 *
 *   npm run engine:gate
 *
 * The harness only needs the exit code and the log (and screenshots, if the engine's gate writes any
 * under engine/<game>/captures/). The command comes from engine/<game>/engine.json ("gate"); for Godot,
 * `godot --headless --path engine/<game> --script res://tools/gate.gd`, which should import the
 * project, run the unit tests and play a smoke run that fails on any SCRIPT ERROR (SendIt's tools/gate.sh
 * did exactly this; engine/_godot/tools/gate.gd is the worked one). No engine track: passes with a note. The engine isn't installed:
 * fails with what to install (this gate is optional in studio/gates.json until a track exists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { readTrack, ENGINES, engineBin, engineCommand, logEngine } from '../harness/engine.mjs';
import { parseCheck, formatBroken } from '../harness/gdscript-parse.mjs';

const t = readTrack();
if (!t) {
  console.log('[engine] no engine track (npm run engine); nothing to check');
  process.exit(0);
}
const cmd = engineCommand(t, 'gate');
// The program the gate runs: the engine (STUDIO_GODOT / godot on the PATH), or whatever engine.json names.
const bin = (cmd.match(/^"([^"]+)"|^(\S+)/) || []).slice(1).find(Boolean) || engineBin(t.engine);
const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0 || fs.existsSync(bin);
if (!found) {
  console.error(`[engine] FAIL ${bin} isn't installed or on the PATH. Install ${ENGINES[t.engine]?.label || t.engine} (headless works), or set ${ENGINES[t.engine]?.env || 'its path'} in .env to the program's full path.`);
  process.exit(1);
}
const start = Date.now();
const r = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 20 * 60000, maxBuffer: 64 * 1024 * 1024 });
const out = `${r.stdout || ''}${r.stderr || ''}`;
fs.mkdirSync(path.join(REPO_ROOT, 'qa', 'reports'), { recursive: true });
const logFile = path.join('qa', 'reports', `engine_${Date.now()}.log`);
fs.writeFileSync(path.join(REPO_ROOT, logFile), out);
// Godot's SCRIPT ERROR, Unity's unhandled exceptions, Unreal's script errors: any one fails the gate.
const scriptErrors = (out.match(/SCRIPT ERROR|Unhandled exception|LogScript: Error|Parse Error/gi) || []).length;
// 2.30h (7): a Godot run only loads the scripts its smoke run touches; every .gd must parse on its own too.
let parse = { checked: 0, broken: [] };
// The parse check needs Godot itself (STUDIO_GODOT or godot on the PATH), which may differ from the gate's
// program (a wrapper script). Without one it is skipped with a note; the gate's own run still counts.
const godot = t.engine === 'godot' ? engineBin('godot') : null;
const haveGodot = godot && (fs.existsSync(godot) || spawnSync(process.platform === 'win32' ? 'where' : 'which', [godot], { encoding: 'utf8' }).status === 0);
if (godot && !haveGodot && t.folder && fs.existsSync(path.join(REPO_ROOT, t.folder, 'project.godot'))) console.log(`[engine] note: GDScript parse check skipped: Godot not found (set STUDIO_GODOT)`);
if (haveGodot && t.folder && fs.existsSync(path.join(REPO_ROOT, t.folder, 'project.godot'))) {
  parse = parseCheck(path.join(REPO_ROOT, t.folder), { godot });
  if (parse.error) parse.broken.push({ file: '(godot)', error: parse.error });
  if (parse.broken.length) console.error(`[engine] ${parse.broken.length} GDScript file(s) don't parse:\n${formatBroken(parse)}`);
}
// 2.30h: a Godot gate that only rendered smoke frames checked nothing. When the run reports frames, it must
// also show at least one test script that ran (a "[gate] PASS|FAIL <file>.gd" line or "N test script(s)" with N > 0).
const framesOnly = t.engine === 'godot' && /smoke frames/i.test(out) && !/\[gate\] (?:PASS|FAIL) \S+\.gd/.test(out) && !/\b[1-9]\d* test script\(s\)/.test(out);
if (framesOnly) console.error('[engine] the Godot gate rendered smoke frames but ran no test: frames alone are not a check. Add a test in res://tests/.');
const ok = r.status === 0 && scriptErrors === 0 && parse.broken.length === 0 && !framesOnly;
emitEvent({ type: ok ? 'qa.engine.pass' : 'qa.engine.fail', agent: process.env.STUDIO_LOCK_OWNER || 'qa', track: t.track, msg: `${t.label} gate ${ok ? 'passed' : 'failed'} in ${Math.round((Date.now() - start) / 1000)} s${scriptErrors ? `, ${scriptErrors} script error(s)` : ''}` });
logEngine(`gate ${ok ? 'PASS' : 'FAIL'}: exit ${r.status}${scriptErrors ? `, ${scriptErrors} script error(s)` : ''}, log ${logFile}`, process.env.STUDIO_LOCK_OWNER || 'qa');
console[ok ? 'log' : 'error'](`[engine] ${ok ? 'PASS' : 'FAIL'} ${t.label}: exit ${r.status}${scriptErrors ? `, ${scriptErrors} script error(s)` : ''}${framesOnly ? ', frames only (no test ran)' : ''}${parse.checked ? `, ${parse.checked - parse.broken.length}/${parse.checked} GDScript file(s) parse` : ''}. Log ${logFile}`);
process.exit(ok ? 0 : 1);
