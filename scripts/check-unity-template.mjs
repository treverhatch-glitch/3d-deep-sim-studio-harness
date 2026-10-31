#!/usr/bin/env node
/**
 * scripts/check-unity-template.mjs — 2.46.0: prove the shipped Unity template (engine/_unity/) without the
 * editor: the sim is pure (harness/unity.mjs purity), its tests pass with .NET, the C# port matches the web
 * template game seed by seed (outcome, tick, credits), and the purity check catches a planted
 * UnityEngine.Random and Time.deltaTime in a copy.
 *
 *   node scripts/check-unity-template.mjs          (needs the .NET 8 SDK: dotnet, or STUDIO_DOTNET)
 *
 * CI's engine-unity-sim job runs this. Without .NET it skips with a note. The editor's own run (Edit Mode and
 * Play Mode, the controls test) is the engine-unity-editor job, which runs once the licence secrets exist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../harness/event.mjs';
import { loadCartridge, runScenario } from '../harness/cartridge.mjs';
import { dotnetBin, runSim, simPurity } from '../harness/unity.mjs';

const has = spawnSync(dotnetBin(), ['--version'], { encoding: 'utf8' }).status === 0;
if (!has) {
  console.log('[unity-template] SKIP no .NET SDK (install .NET 8, or set STUDIO_DOTNET)');
  process.exit(0);
}
const tpl = path.join(REPO_ROOT, 'engine', '_unity');
const problems = [];

const sim = runSim(tpl, { log: () => {} });
if (!sim.ok) problems.push(...sim.problems.map((p) => `sim: ${p}`));
else console.log(`[unity-template] sim: purity clean, ${sim.total} test(s) passed with .NET`);

const seeds = [1, 2, 3, 4, 5, 1337];
const out = spawnSync(dotnetBin(), ['run', '--project', path.join(tpl, 'tools', 'SimCli'), '--', 'parity', seeds.join(',')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } });
const eng = Object.fromEntries(String(out.stdout).split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((o) => [o.seed, o]));
const cart = await loadCartridge('example-sim');
for (const s of seeds) {
  const r = runScenario(cart, 'start-to-win', { seed: s });
  const e = eng[s];
  if (!e) problems.push(`seed ${s}: the C# port printed nothing (${(out.stderr || '').trim().split('\n').slice(-2).join(' ')})`);
  else if (e.outcome !== r.outcome || e.tick !== r.ticksRun || e['resources.credits'] !== r.state.resources.credits) problems.push(`seed ${s}: web ${r.outcome}@${r.ticksRun} (${r.state.resources.credits} credits), C# ${e.outcome}@${e.tick} (${e['resources.credits']})`);
}
if (!problems.some((p) => /^seed/.test(p))) console.log(`[unity-template] parity: the C# port matches the web game on ${seeds.length} seeds (outcome, tick, credits)`);

// A copy with engine time and engine randomness planted in the sim must fail the purity check.
const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-impure-'));
fs.cpSync(path.join(tpl, 'Assets'), path.join(broken, 'Assets'), { recursive: true });
fs.cpSync(path.join(tpl, 'ProjectSettings'), path.join(broken, 'ProjectSettings'), { recursive: true });
const cs = path.join(broken, 'Assets', 'Sim', 'Sim.cs');
fs.writeFileSync(cs, fs.readFileSync(cs, 'utf8').replace('int drift = JsRound(', 'int drift = (int)(UnityEngine.Random.value * Time.deltaTime) + JsRound('));
const asm = path.join(broken, 'Assets', 'Sim', 'Sim.asmdef');
fs.writeFileSync(asm, fs.readFileSync(asm, 'utf8').replace('"noEngineReferences": true', '"noEngineReferences": false'));
const dirty = simPurity(broken);
const caught = ['UnityEngine', 'Unity time', 'noEngineReferences'].filter((k) => dirty.problems.some((p) => p.includes(k)));
if (dirty.ok || caught.length !== 3) problems.push(`the purity check missed planted engine code in the sim (caught: ${caught.join(', ') || 'nothing'})`);
else console.log('[unity-template] purity: a planted UnityEngine.Random, Time.deltaTime and noEngineReferences=false are all caught');
fs.rmSync(broken, { recursive: true, force: true });

// A copy whose sim breaks a rule its tests check must fail the sim run, counted from .NET's own results.
{
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-failing-'));
  fs.cpSync(tpl, copy, { recursive: true, filter: (s) => !/[\\/](bin|obj|TestResults|Library|Temp)([\\/]|$)/.test(s) });
  const f = path.join(copy, 'Assets', 'Sim', 'Sim.cs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('state.Credits -= cost;', 'state.Credits -= 0; // planted: buying is free'));
  const r = runSim(copy, { log: () => {} });
  if (r.ok || !r.failed) problems.push(`a sim where buying is free still passed its tests (${r.problems.join('; ') || 'no failure counted'})`);
  else console.log(`[unity-template] tests: a planted rule break fails ${r.failed} of ${r.total} sim test(s)`);
  fs.rmSync(copy, { recursive: true, force: true });
}

for (const p of problems) console.error(`[unity-template] FAIL ${p}`);
if (problems.length) process.exit(1);
console.log('[unity-template] PASS');
