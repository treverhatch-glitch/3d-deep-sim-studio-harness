#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const maxLights = 8;
const maxDrawHints = 100;
const dirs = ['cartridges', 'src'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
let failed = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (/\.(mjs|js|ts|tsx)$/.test(ent.name)) {
      const text = fs.readFileSync(full, 'utf8');
      const lights = (text.match(/Light\s*\(|new\s+\w*Light/g) || []).length;
      const draws = (text.match(/drawCalls\s*[:=]\s*(\d+)/g) || [])
        .map((s) => Number(s.match(/\d+/)[0]))
        .filter((n) => n > maxDrawHints);
      if (lights > maxLights) {
        console.error(`[renderer-budget] FAIL ${path.relative(root, full)}: ${lights} lights > ${maxLights}`);
        failed += 1;
      }
      if (draws.length) {
        console.error(`[renderer-budget] FAIL ${path.relative(root, full)}: drawCalls over ${maxDrawHints}`);
        failed += 1;
      }
    }
  }
}
for (const d of dirs) walk(d);
if (failed) process.exit(1);
console.log(`[renderer-budget] PASS (lights<=${maxLights}, drawCalls<=${maxDrawHints})`);
