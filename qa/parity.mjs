#!/usr/bin/env node
/**
 * qa/parity.mjs — the web game and its engine port play the same seeds and must agree.
 *
 *   npm run parity [-- --seeds 1,2,3,4,5]
 *
 * The only link between the two versions: each keeps its own recordings (hashes differ by engine), but
 * for the same seed the start-to-win scenario must reach the same outcome on the same tick (and any
 * other field the track lists in parity.compare). The engine's parity command (engine/<game>/engine.json)
 * gets the seeds and prints one JSON line per seed: {"seed":1,"outcome":"won","tick":300}.
 * No engine track: nothing to compare, and it passes with a note.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { activeCartridge, loadCartridge, runScenario } from '../harness/cartridge.mjs';
import { readTrack, engineCommand, logEngine } from '../harness/engine.mjs';

export async function parity({ seeds = [1, 2, 3, 4, 5] } = {}) {
  const t = readTrack();
  if (!t) return { ok: true, skipped: 'no engine track (npm run engine)' };
  // Until a porter changes the template's sim, comparing it with another game only repeats one known
  // failure in every builder's verify (test #3: 13 parity fails, all "still the template").
  const game = activeCartridge().name;
  const read = (p) => { try { return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'); } catch { return null; } };
  const tpl = read('engine/_godot/sim/sim.gd');
  // The template is a real port of the template game, so a copy of that game still compares.
  const sameGame = read(`cartridges/${game}/index.mjs`) === read('cartridges/example-sim/index.mjs');
  if (!sameGame && tpl && t.folder && /parity\.gd/.test(t.parity?.command || '') && read(path.join(t.folder, 'sim', 'sim.gd')) === tpl) {
    return { ok: true, skipped: `the port in ${t.folder}/ is still the template; parity starts once a porter changes ${t.folder}/sim/sim.gd` };
  }
  // 2.46.0: the same for a Unity track (engine/_unity's Assets/Sim/Sim.cs).
  const tplCs = read('engine/_unity/Assets/Sim/Sim.cs');
  if (!sameGame && tplCs && t.folder && t.engine === 'unity' && read(path.join(t.folder, 'Assets', 'Sim', 'Sim.cs')) === tplCs) {
    return { ok: true, skipped: `the port in ${t.folder}/ is still the template; parity starts once a porter changes ${t.folder}/Assets/Sim/Sim.cs` };
  }
  // 2.46.0: a pinned port is compared with the web rules it follows (port-src/, npm run engine -- port --from),
  // not the live ones: the web game keeps changing while it is ported, and a web commit the port hasn't taken
  // yet is drift to queue (npm run engine -- drift --queue), not a parity failure in every porter's verify.
  let cart = null;
  let against = 'the live web rules';
  const pinned = t.portFrom?.sha && t.folder ? path.join(REPO_ROOT, t.folder, 'port-src') : null;
  if (pinned && fs.existsSync(path.join(pinned, 'index.mjs'))) {
    try { cart = await loadCartridge(activeCartridge().name, { dir: pinned }); against = `the web rules pinned at ${t.portFrom.sha.slice(0, 7)}`; } catch {}
  }
  cart ??= await loadCartridge(activeCartridge().name);
  const web = Object.fromEntries(seeds.map((seed) => {
    const r = runScenario(cart, 'start-to-win', { seed });
    return [seed, { seed, outcome: r.outcome, tick: r.ticksRun, state: r.state }];
  }));
  const cmd = engineCommand(t, 'parity', { seeds });
  const r = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 10 * 60000, maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) return { ok: false, problems: [`the engine's parity command failed (exit ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`], web };
  const eng = {};
  for (const line of String(r.stdout).split('\n')) {
    try {
      const o = JSON.parse(line.trim());
      if (o && o.seed != null) eng[Number(o.seed)] = o;
    } catch {
      // engine log lines
    }
  }
  const problems = [];
  for (const seed of seeds) {
    const e = eng[seed];
    if (!e) {
      problems.push(`seed ${seed}: the engine printed no result`);
      continue;
    }
    for (const k of t.parity.compare || ['outcome', 'tick']) {
      // A field of the result (outcome, tick), or a dotted path into the final state (resources.credits).
      const w = k in web[seed] && k !== 'state' ? web[seed][k] : k.split('.').reduce((o, p) => (o == null ? o : o[p]), web[seed].state);
      if (String(e[k]) !== String(w)) problems.push(`seed ${seed}: ${k} is ${w} on the web, ${e[k]} in ${t.label}`);
    }
  }
  for (const v of Object.values(web)) delete v.state;
  return { ok: problems.length === 0, problems, web, engine: eng, compared: t.parity.compare, against };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const flag = (k) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : null);
  const seeds = (flag('seeds') || '1,2,3,4,5').split(',').map(Number).filter((n) => Number.isFinite(n));
  const r = await parity({ seeds });
  if (r.skipped) {
    console.log(`[parity] SKIP ${r.skipped}`);
    process.exit(0);
  }
  for (const p of r.problems) console.error(`[parity] FAIL ${p}`);
  if (r.ok) console.log(`[parity] PASS ${seeds.length} seeds agree on ${r.compared.join(' and ')} (against ${r.against})`);
  logEngine(`parity ${r.ok ? 'PASS' : 'FAIL'} on seeds ${seeds.join(',')}${r.ok ? '' : `: ${r.problems[0]}`}`, process.env.STUDIO_LOCK_OWNER || 'qa');
  emitEvent({ type: r.ok ? 'qa.parity.pass' : 'qa.parity.fail', agent: process.env.STUDIO_LOCK_OWNER || 'qa', msg: r.ok ? `Web and engine agree on ${seeds.length} seeds` : `Web and engine disagree: ${r.problems[0]}` });
  process.exit(r.ok ? 0 : 1);
}
