#!/usr/bin/env node
/**
 * Lightweight budget check. Looks for obvious over-budget patterns.
 * Full GPU profiling is not done here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = path.join(root, 'studio', 'rules', 'renderer-budget.md');
const maxDrawCalls = 100;
const maxLights = 8;

if (!fs.existsSync(rules)) {
  console.log('[renderer-budget] no rules file, skip');
  process.exit(0);
}

const scanRoot = path.join(root, 'cartridges');
let failed = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full);
    else if (/\.(mjs|js|ts|tsx)$/.test(ent.name)) {
      const text = fs.readFileSync(full, 'utf8');
      const lights = (text.match(/new\s+THREE\.\w*Light/g) || []).length;
      if (lights > maxLights) {
        console.error(`[renderer-budget] FAIL ${full}: ${lights} lights > ${maxLights}`);
        failed += 1;
      }
    }
  }
}
walk(scanRoot);
if (failed) process.exit(1);
console.log(`[renderer-budget] PASS (max lights ${maxLights}, draw-call budget documented at ${maxDrawCalls})`);
