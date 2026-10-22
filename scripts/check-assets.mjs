#!/usr/bin/env node
/**
 * scripts/check-assets.mjs — every file the game ships has a record of who may use it.
 *
 * Fails when a file in assets/, public/assets/ or cartridges/<name>/assets/ has no record in
 * studio/assets/manifest.json, changed since it was recorded, or when game code points at the
 * reference library (references/ or STUDIO_REFERENCE_DIR) or at the art department's staging folder
 * (assets/staging/, not approved yet). Record files with `npm run asset -- add`.
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

// assets/staging/ is the art department's work in progress: not shipped, so not recorded yet.
const shipped = [...walk(path.join(root, 'assets')).filter((f) => !rel(f).startsWith('assets/staging/')), ...walk(path.join(root, 'public', 'assets'))];
const carts = path.join(root, 'cartridges');
if (fs.existsSync(carts)) for (const c of fs.readdirSync(carts)) shipped.push(...walk(path.join(carts, c, 'assets')));

const problems = [];
for (const f of shipped) {
  const r = rel(f);
  const entry = byFile.get(r);
  if (!entry) problems.push(`${r} has no record: npm run asset -- add ${r} --use game --owner "…" --licence "…" --by <person> (or move it to the reference library)`);
  else if (entry.use !== 'game') problems.push(`${r} is recorded as a reference, not for the game`);
  else if (entry.sha256 !== crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')) problems.push(`${r} changed since ${entry.declaredBy} recorded it; record the new version: npm run asset -- update ${r} --by <person>`);
}

// 2.30b (G7): scouted art ships only under CC0 or CC-BY, with the author for CC-BY, and CREDITS.md matches the ledger.
const credited = manifest.assets.filter((a) => a.scouted);
if (credited.length) {
  const { allowedLicence, creditsText } = await import('../harness/asset-scout.mjs');
  for (const a of manifest.assets.filter((x) => x.scouted)) {
    const kind = allowedLicence(a.licence);
    if (!kind) problems.push(`${a.file} was scouted under "${a.licence}", not CC0 or CC-BY: it can't ship (keep it as a reference)`);
    else if (kind === 'CC-BY' && !a.author) problems.push(`${a.file} is CC-BY with no author to credit`);
  }
  let credits = '';
  try {
    credits = fs.readFileSync(path.join(root, 'CREDITS.md'), 'utf8');
  } catch {}
  if (credits !== creditsText(manifest)) problems.push('CREDITS.md is missing or out of date with the asset ledger: npm run scout -- credits');
}

const refDir = process.env.STUDIO_REFERENCE_DIR ? rel(path.resolve(root, process.env.STUDIO_REFERENCE_DIR)) : 'references';
const code = ['cartridges', 'src', 'public', 'web'].flatMap((d) => walk(path.join(root, d))).filter((f) => /\.(mjs|js|ts|tsx|jsx|json|html|css)$/.test(f));
for (const f of code) {
  const text = fs.readFileSync(f, 'utf8');
  if (new RegExp(`['"\`(/]${refDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`).test(text)) problems.push(`${rel(f)} points at the reference library (${refDir}/): references are for designing from, never shipped`);
  if (/['"`(/]assets\/staging\//.test(text)) problems.push(`${rel(f)} points at assets/staging/: that is work in progress; the game loads approved assets (assets/approved/), so get it approved in the Asset studio first`);
}

if (problems.length) {
  console.log(`[assets] FAIL ${problems.length} problem(s):`);
  console.log(problems.map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`[assets] PASS — ${shipped.length} shipped file(s) recorded${shipped.length ? '' : ' (no assets yet)'}`);
