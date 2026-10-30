#!/usr/bin/env node
/**
 * scripts/check-engine-template.mjs — prove the shipped Godot template (engine/_godot/) with a real Godot:
 * its port matches the web template game seed by seed (outcome, tick, credits), and its gate passes.
 *
 *   STUDIO_GODOT=/path/to/godot node scripts/check-engine-template.mjs
 *
 * CI downloads Godot and runs this (the engine-godot job). Without a Godot it skips with a note.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../harness/event.mjs';
import { loadCartridge, runScenario } from '../harness/cartridge.mjs';
import { parseCheck } from '../harness/gdscript-parse.mjs';

const godot = process.env.STUDIO_GODOT || (spawnSync(process.platform === 'win32' ? 'where' : 'which', ['godot']).status === 0 ? 'godot' : null);
if (!godot) {
  console.log('[engine-template] SKIP no Godot (set STUDIO_GODOT to the program)');
  process.exit(0);
}
const tpl = path.join(REPO_ROOT, 'engine', '_godot');
const g = (args) => spawnSync(godot, ['--headless', '--path', tpl, ...args], { encoding: 'utf8', timeout: 300000 });
g(['--import']);
const seeds = [1, 2, 3, 4, 5, 1337];
const out = g(['--script', 'res://tools/parity.gd', '--', seeds.join(',')]);
const eng = Object.fromEntries(String(out.stdout).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((o) => [o.seed, o]));
const cart = await loadCartridge('example-sim');
const problems = [];
for (const s of seeds) {
  const r = runScenario(cart, 'start-to-win', { seed: s });
  const e = eng[s];
  if (!e) problems.push(`seed ${s}: Godot printed nothing`);
  else if (e.outcome !== r.outcome || e.tick !== r.ticksRun || e['resources.credits'] !== r.state.resources.credits) problems.push(`seed ${s}: web ${r.outcome}@${r.ticksRun} (${r.state.resources.credits} credits), Godot ${e.outcome}@${e.tick} (${e['resources.credits']})`);
}
const gate = g(['--script', 'res://tools/gate.gd']);
if (gate.status !== 0 || /SCRIPT ERROR/.test(gate.stdout + gate.stderr)) problems.push(`the template's gate failed (exit ${gate.status}): ${(gate.stdout + gate.stderr).trim().split('\n').slice(-3).join(' ')}`);
// 2.32.0: the gate presses every control for real, and a dead control fails it. A copy of the template
// with the Buy button unwired must fail on exactly that control (the Marina Godot build had dead buttons
// and passed every gate).
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const ctlOut = path.join(os.tmpdir(), `engine-template-controls-${process.pid}.json`);
  const ok = spawnSync(godot, ['--headless', '--path', tpl, '--script', 'res://tools/gate.gd'], { encoding: 'utf8', timeout: 300000, env: { ...process.env, STUDIO_CONTROLS_OUT: ctlOut } });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(ctlOut, 'utf8')); } catch {}
  const ids = (res?.controls || []).filter((c) => c.ok).map((c) => c.id).sort().join(',');
  if (ok.status !== 0 || ids !== 'buy-button,buy-unit') problems.push(`the template's controls didn't all pass by real input (passed: ${ids || 'none'}): ${(ok.stdout + ok.stderr).trim().split('\n').filter((l) => /\[gate\]/.test(l)).slice(-4).join(' | ')}`);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-dead-control-'));
  fs.cpSync(tpl, broken, { recursive: true, filter: (s) => !/[\\/]\.godot([\\/]|$)/.test(s) });
  const mainGd = path.join(broken, 'main.gd');
  fs.writeFileSync(mainGd, fs.readFileSync(mainGd, 'utf8').replace('buy_button.pressed.connect(buy)', 'pass # unwired for the dead-control check'));
  spawnSync(godot, ['--headless', '--path', broken, '--import'], { encoding: 'utf8', timeout: 300000 });
  const dead = spawnSync(godot, ['--headless', '--path', broken, '--script', 'res://tools/gate.gd'], { encoding: 'utf8', timeout: 300000 });
  if (dead.status === 0 || !/control buy-button did nothing/.test(dead.stdout + dead.stderr)) problems.push('a template with the Buy button unwired still passed its gate: the real-input controls check is not working');
  fs.rmSync(broken, { recursive: true, force: true });
}
// 2.30h (7): every template script parses on its own, not just the ones the gate loads.
const parsed = parseCheck(tpl, { godot });
if (parsed.error) problems.push(parsed.error);
for (const b of parsed.broken) problems.push(`${b.file} doesn't parse: ${b.error}`);
for (const p of problems) console.error(`[engine-template] FAIL ${p}`);
if (problems.length) process.exit(1);
console.log(`[engine-template] PASS the Godot port matches the web game on ${seeds.length} seeds (outcome, tick, credits), and its gate passes; ${parsed.checked} GDScript file(s) parse`);
