#!/usr/bin/env node
/**
 * qa/soak.mjs — many seeds, long runs: determinism and invariants for every game cartridge.
 *   node qa/soak.mjs --seeds 8 --ticks 500 [--cartridge name]
 */
import { cartridgeFromArgv, listCartridges, loadCartridge, replay, runScenario } from '../harness/cartridge.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
}
const seeds = arg('--seeds', 5);
const ticks = arg('--ticks', 300);
const names = process.argv.includes('--cartridge') ? [cartridgeFromArgv()] : listCartridges();

let failed = 0;
for (const name of names) {
  const cart = await loadCartridge(name);
  for (let i = 0; i < seeds; i++) {
    const seed = 1000 + i * 7919;
    const runs = [replay(cart, { seed, tick: ticks })];
    for (const sc of Object.keys(cart.scenarios)) runs.push(runScenario(cart, sc, { seed }));
    for (const r of runs) {
      const again = r.scenario ? runScenario(cart, r.scenario, { seed }) : replay(cart, { seed, tick: ticks });
      const label = `${name} seed ${seed}${r.scenario ? ` ${r.scenario}` : ''}`;
      if (r.findings.length) {
        console.error(`[soak] FAIL ${label}: tick ${r.failingTick} ${r.findings[0].id} — ${r.findings[0].summary}`);
        failed += 1;
      } else if (again.hash !== r.hash) {
        console.error(`[soak] FAIL ${label}: non-deterministic ${r.hash} != ${again.hash}`);
        failed += 1;
      }
    }
  }
  console.log(`[soak] ${name}: ${seeds} seeds x (${ticks}-tick replay + ${Object.keys(cart.scenarios).length} scenario(s)) checked`);
}
if (failed) process.exit(1);
console.log('[soak] ok');
