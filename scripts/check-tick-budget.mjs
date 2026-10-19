#!/usr/bin/env node
import { createInitialState, step } from '../cartridges/example-sim/index.mjs';

const ticks = 200;
const budgetMs = Number(process.env.TICK_BUDGET_MS || 50);
let state = createInitialState(1337);
const start = Date.now();
for (let i = 0; i < ticks; i++) state = step(state);
const elapsed = Date.now() - start;
const perTick = elapsed / ticks;
if (elapsed > budgetMs) {
  console.error(`[tick-budget] FAIL ${elapsed}ms for ${ticks} ticks > ${budgetMs}ms`);
  process.exit(1);
}
console.log(`[tick-budget] PASS ${elapsed}ms total, ${perTick.toFixed(3)} ms/tick`);
