#!/usr/bin/env node
// Seeds a few clearly labelled demo events so a fresh clone's War Room isn't empty. Every event is marked
// meta.demo and its message starts with "[demo]"; none carries token numbers. Don't run it in a real studio.
//   node scripts/seed-demo-events.mjs [--force]
import fs from 'node:fs';
import { emitEvent, getEventPaths } from '../harness/event.mjs';

const { primary } = getEventPaths();
const lines = fs.existsSync(primary) ? fs.readFileSync(primary, 'utf8').split('\n').filter(Boolean).length : 0;
if (lines > 0 && !process.argv.includes('--force')) {
  console.log(`[seed-demo-events] ${lines} events already in the log; this is a real studio, so nothing was seeded. Use --force to add demo events anyway.`);
  process.exit(0);
}
const demo = [
  ['task.start', 'producer', 'T-001', 'studio/NEXT.md', 14200, 'Triaged studio/NEXT.md'],
  ['sim.step', 'builder', 'T-002', 'cartridges/example-sim/index.mjs', 22400, 'Seeded tick step for the example cartridge'],
  ['asset.glb', 'asset-3d', 'T-003', 'tools/blender/generate_glb.py', 9100, 'Generated crate, cone and vehicle placeholders'],
  ['qa.pass', 'qa-playtester', 'T-004', 'qa/playtest.mjs', 16500, 'Playtest seed 42069 to tick 120'],
  ['review.pass', 'reviewer', 'T-005', 'scripts/check-sim-isolation.mjs', 5400, 'Sim isolation check passed'],
];
for (const [type, agent, task, target, durationMs, msg] of demo) {
  emitEvent({ type, agent, task, target, durationMs, msg: `[demo] ${msg}`, meta: { demo: true } });
}
console.log(`[seed-demo-events] Added ${demo.length} demo events (marked [demo], no token numbers) to .studio/events.jsonl`);
