#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: npm run new-game <name>');
  process.exit(1);
}
const src = path.join(root, 'cartridges', '_template');
const dest = path.join(root, 'cartridges', name);
if (fs.existsSync(dest)) {
  console.error(`cartridge ${name} already exists`);
  process.exit(1);
}
fs.cpSync(src, dest, { recursive: true });
const goldenDir = path.join(root, 'qa', 'golden');
fs.mkdirSync(goldenDir, { recursive: true });
const golden = {
  name: `${name}-1337`,
  cartridge: name,
  seed: 1337,
  tick: 50,
  actions: [],
  hash: 'REPLACE_WITH_64BIT',
  hashWidth: 64,
};
fs.writeFileSync(path.join(goldenDir, `${name}-1337.json`), JSON.stringify(golden, null, 2) + '\n');
console.log(`created cartridges/${name}`);
console.log('next: play it, then node qa/check-golden.mjs --update');
