#!/usr/bin/env node
/**
 * scripts/balance-sweep.mjs — sweep one TUNING knob of a cartridge across seeds and score it.
 *
 *   node scripts/balance-sweep.mjs [--config studio/balance/sweep.json] [--write]
 *
 * Config: { cartridge, scenario, knob, values, seeds, target: { winRate: [lo, hi], medianTick: [lo, hi] } }
 * The knob must exist in the cartridge's exported TUNING table. Each value is played as the scenario's
 * policy across every seed. Exit 1 when the cartridge's current value is outside the target band,
 * or when the cartridge ignores the override. --write saves the table to studio/balance/latest.md.
 * This is a proxy: a person still picks the final number (studio/balance/decision-*.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCartridge, runScenario } from '../harness/cartridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cfgPath = argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : path.join(root, 'studio', 'balance', 'sweep.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`[balance] FAIL no sweep config at ${path.relative(root, cfgPath)}`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const cart = await loadCartridge(cfg.cartridge);
const { knob, scenario = 'start-to-win', seeds = [1, 2, 3, 4], target = {} } = cfg;
if (!cart.hasTuning || !(knob in cart.tuning)) {
  console.error(`[balance] FAIL cartridge ${cart.name} has no TUNING.${knob}. Export a TUNING table from index.mjs.`);
  process.exit(1);
}
const current = cart.tuning[knob];
const values = [...new Set([...(cfg.values || []), current])].sort((a, b) => a - b);
const [winLo, winHi] = target.winRate || [0, 1];
const [tickLo, tickHi] = target.medianTick || [0, Infinity];
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const rows = [];
const hashes = new Set();
for (const value of values) {
  const runs = seeds.map((seed) => runScenario(cart, scenario, { seed, tuning: { [knob]: value } }));
  runs.forEach((r) => hashes.add(r.sha256));
  const wins = runs.filter((r) => r.outcome === 'won');
  const winRate = wins.length / runs.length;
  const med = median(wins.map((r) => r.ticksRun));
  const broken = runs.filter((r) => r.findings.length).length;
  const inBand = !broken && winRate >= winLo && winRate <= winHi && med !== null && med >= tickLo && med <= tickHi;
  rows.push({ value, winRate, med, min: wins.length ? Math.min(...wins.map((r) => r.ticksRun)) : null, max: wins.length ? Math.max(...wins.map((r) => r.ticksRun)) : null, lost: runs.filter((r) => r.outcome === 'lost').length, broken, inBand });
}

const mid = (tickLo + (Number.isFinite(tickHi) ? tickHi : tickLo)) / 2;
const best = rows.filter((r) => r.inBand).sort((a, b) => Math.abs(a.med - mid) - Math.abs(b.med - mid))[0];
const cur = rows.find((r) => r.value === current);
const md = [
  `# Balance sweep: ${cart.name} · ${knob}`,
  '',
  `Scenario \`${scenario}\`, ${seeds.length} seeds. Target: win rate ${winLo}–${winHi}, median win tick ${tickLo}–${tickHi}.`,
  '',
  `| ${knob} | win rate | median win tick | fastest–slowest | lost | broken | in band |`,
  '|---:|---:|---:|---:|---:|---:|:---:|',
  ...rows.map((r) => `| ${r.value}${r.value === current ? ' (current)' : ''} | ${Math.round(r.winRate * 100)}% | ${r.med ?? '–'} | ${r.min === null ? '–' : `${r.min}–${r.max}`} | ${r.lost} | ${r.broken} | ${r.inBand ? 'yes' : 'no'} |`),
  '',
  best ? `Closest to the middle of the band: **${knob} = ${best.value}** (median ${best.med}).` : 'No value lands in the target band.',
  `Current value ${current} is ${cur.inBand ? 'inside' : 'OUTSIDE'} the band.`,
  '',
  'Proxy only. A person picks the final number in studio/balance/decision-YYYY-MM-DD.md.',
  '',
].join('\n');
console.log(md);
if (argv.includes('--write')) fs.writeFileSync(path.join(root, 'studio', 'balance', 'latest.md'), md);

if (values.length > 1 && hashes.size <= seeds.length) {
  console.error(`[balance] FAIL changing ${knob} changed nothing: does createInitialState(seed, tuning) use its tuning argument?`);
  process.exit(1);
}
if (!cur.inBand) {
  console.error(`[balance] FAIL current ${knob}=${current} is outside the target band${best ? `; try ${best.value}` : ''}`);
  process.exit(1);
}
console.log(`[balance] PASS ${knob}=${current} is inside the target band`);
