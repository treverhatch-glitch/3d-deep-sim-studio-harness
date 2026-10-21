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
import { readTrack, ENGINES, engineBin, engineCommand } from '../harness/engine.mjs';

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
const ok = r.status === 0 && scriptErrors === 0;
emitEvent({ type: ok ? 'qa.engine.pass' : 'qa.engine.fail', agent: process.env.STUDIO_LOCK_OWNER || 'qa', track: t.track, msg: `${t.label} gate ${ok ? 'passed' : 'failed'} in ${Math.round((Date.now() - start) / 1000)} s${scriptErrors ? `, ${scriptErrors} script error(s)` : ''}` });
console[ok ? 'log' : 'error'](`[engine] ${ok ? 'PASS' : 'FAIL'} ${t.label}: exit ${r.status}${scriptErrors ? `, ${scriptErrors} script error(s)` : ''}. Log ${logFile}`);
process.exit(ok ? 0 : 1);
