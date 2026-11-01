#!/usr/bin/env node
/**
 * scripts/check-tick-budget.mjs — the sim must stay fast enough to replay and soak.
 * Times 200 ticks of each game cartridge (best of 3) against its budget: "tickBudgetMs" in
 * cartridges/<name>/cartridge.json (2.58.4: a cartridge that drives a real game's sim, at a few ms a tick, says so),
 * else TICK_BUDGET_MS_PER_TICK, else 1 ms.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CARTRIDGES_DIR, listCartridges, loadCartridge } from '../harness/cartridge.mjs';

const ticks = 200;
const globalBudget = Number(process.env.TICK_BUDGET_MS_PER_TICK || 1);
/** The cartridge's own budget, when cartridge.json sets a positive tickBudgetMs. */
export function cartridgeBudget(name) {
  try {
    const v = Number(JSON.parse(fs.readFileSync(path.join(CARTRIDGES_DIR, name, 'cartridge.json'), 'utf8')).tickBudgetMs);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}
let failed = 0;
for (const name of listCartridges()) {
  const own = cartridgeBudget(name);
  const budget = own ?? globalBudget;
  const from = own != null ? `cartridges/${name}/cartridge.json` : process.env.TICK_BUDGET_MS_PER_TICK ? 'TICK_BUDGET_MS_PER_TICK' : 'default';
  const cart = await loadCartridge(name);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    let state = cart.init(1337);
    const start = performance.now();
    for (let i = 0; i < ticks; i++) state = cart.step(state, null);
    best = Math.min(best, (performance.now() - start) / ticks);
  }
  if (best > budget) {
    console.error(`[tick-budget] FAIL ${name}: ${best.toFixed(3)} ms/tick > ${budget} ms/tick (budget from ${from})`);
    failed += 1;
  } else {
    console.log(`[tick-budget] PASS ${name}: ${best.toFixed(3)} ms/tick (budget ${budget}, from ${from})`);
  }
}
if (failed) process.exit(1);
