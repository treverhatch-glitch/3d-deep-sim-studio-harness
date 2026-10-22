#!/usr/bin/env node
/**
 * scripts/check-module-size.mjs — game modules too big for parallel lanes (studio/rules/lanes.md).
 *
 *   node scripts/check-module-size.mjs [--max 300]
 *
 * Lists JavaScript and TypeScript files in web/, game/ and src/ (not the sim) over the limit. Optional
 * gate: it fails so the Producer queues the split, but verify doesn't require it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const max = Number(process.argv.includes('--max') ? process.argv[process.argv.indexOf('--max') + 1] : 300);
const walk = (d, out = []) => {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'build', '.git', '.lanes', '.studio'].includes(e.name)) continue;
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(m?js|tsx?|jsx)$/.test(e.name) && !/\.min\./.test(e.name)) out.push(f);
  }
  return out;
};
const big = ['web', 'game', 'src'].flatMap((d) => walk(path.join(root, d))).filter((f) => !/[\\/]sim[\\/]/.test(f)).map((f) => ({ f: path.relative(root, f).split(path.sep).join('/'), n: fs.readFileSync(f, 'utf8').split('\n').length })).filter((x) => x.n > max).sort((a, b) => b.n - a.n);
if (big.length) {
  console.log(`[module-size] ${big.length} module(s) over ${max} lines; split them so builders can work in parallel lanes:`);
  for (const x of big) console.log(`  ${x.f}: ${x.n} lines`);
  process.exit(1);
}
console.log(`[module-size] PASS — no game module over ${max} lines`);
