#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayToTick } from '../cartridges/example-sim/index.mjs';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'regressions');
if (!fs.existsSync(dir)) {
  console.log('[regressions] none');
  process.exit(0);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
if (!files.length) {
  console.log('[regressions] none');
  process.exit(0);
}
for (const file of files) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const result = replayToTick({ seed: spec.seed, tick: spec.tick, actions: spec.actions || [] });
  console.log(`[regressions] replayed ${file} hash=${result.hash}`);
}
