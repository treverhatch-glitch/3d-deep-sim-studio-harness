#!/usr/bin/env node
/**
 * scripts/check-tick-budget.mjs — the sim must stay fast enough to replay and soak.
 * Times 200 ticks of each game cartridge (best of 3) against TICK_BUDGET_MS_PER_TICK (default 1 ms).
 */
import { listCartridges, loadCartridge } from '../harness/cartridge.mjs';

const ticks = 200;
const budget = Number(process.env.TICK_BUDGET_MS_PER_TICK || 1);
let failed = 0;
for (const name of listCartridges()) {
  const cart = await loadCartridge(name);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    let state = cart.init(1337);
    const start = performance.now();
    for (let i = 0; i < ticks; i++) state = cart.step(state, null);
    best = Math.min(best, (performance.now() - start) / ticks);
  }
  if (best > budget) {
    console.error(`[tick-budget] FAIL ${name}: ${best.toFixed(3)} ms/tick > ${budget} ms/tick`);
    failed += 1;
  } else {
    console.log(`[tick-budget] PASS ${name}: ${best.toFixed(3)} ms/tick (budget ${budget})`);
  }
}
if (failed) process.exit(1);
