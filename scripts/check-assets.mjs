#!/usr/bin/env node
/**
 * scripts/check-assets.mjs — every file the game ships has a record of who may use it.
 *
 * Fails when a file in assets/, public/assets/ or cartridges/<name>/assets/ has no record in
 * studio/assets/manifest.json, changed since it was recorded, or when game code points at the
 * reference library (references/ or STUDIO_REFERENCE_DIR). Record files with `npm run asset -- add`.
 * No assets at all is fine.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(root, p).split(path.sep).join('/');
let manifest = { assets: [] };
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'assets', 'manifest.json'), 'utf8'));
} catch {
  /* no manifest yet */
}
const byFile = new Map(manifest.assets.map((a) => [a.file, a]));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'README.md' || e.name === '.gitkeep') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const shipped = [...walk(path.join(root, 'assets')), ...walk(path.join(root, 'public', 'assets'))];
const carts = path.join(root, 'cartridges');
if (fs.existsSync(carts)) for (const c of fs.readdirSync(carts)) shipped.push(...walk(path.join(carts, c, 'assets')));

const problems = [];
for (const f of shipped) {
  const r = rel(f);
  const entry = byFile.get(r);
  if (!entry) problems.push(`${r} has no record: npm run asset -- add ${r} --use game --owner "…" --licence "…" --by <person> (or move it to the reference library)`);
  else if (entry.use !== 'game') problems.push(`${r} is recorded as a reference, not for the game`);
  else if (entry.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')) problems.push(`${r} changed since ${entry.declaredBy} recorded it; record the new version: npm run asset -- add ${r} --use game --owner "…" --licence "…" --by <person>`);
}

const refDir = process.env.STUDIO_REFERENCE_DIR ? rel(path.resolve(root, process.env.STUDIO_REFERENCE_DIR)) : 'references';
const code = ['cartridges', 'src', 'public'].flatMap((d) => walk(path.join(root, d))).filter((f) => /\.(mjs|js|ts|tsx|jsx|json|html|css)$/.test(f));
for (const f of code) {
  const text = fs.readFileSync(f, 'utf8');
  if (new RegExp(`['"\`(/]${refDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(text)) problems.push(`${rel(f)} points at the reference library (${refDir}/): references are for designing from, never shipped`);
}

if (problems.length) {
  console.log(`[assets] FAIL ${problems.length} problem(s):`);
  console.log(problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`[assets] PASS — ${shipped.length} shipped file(s) recorded${shipped.length ? '' : ' (no assets yet)'}`);
