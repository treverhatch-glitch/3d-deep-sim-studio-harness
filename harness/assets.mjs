#!/usr/bin/env node
/**
 * harness/assets.mjs — the game dev's own files (3D models, music, sound, maps, art), with a record
 * of whether each one may go in the game.
 *
 *   npm run asset -- add <file> --use game --owner "<who owns it>" --licence "<own work | licence name>" [--source "<where from>"] --by <person>
 *   npm run asset -- add <file or url> --use reference --game "…" --feature "…" [--by <name>]
 *   npm run asset -- list
 *
 * --use game: the person states they own it or hold a licence to use it in this game. The file is
 * copied to assets/ and recorded in studio/assets/manifest.json with who said so, when, the licence
 * and a checksum. The harness records the statement; it can't check it. (This is not legal advice:
 * a product built on this needs proper terms written by a lawyer.)
 * --use reference: it goes to the reference library (`npm run ref`), to design from, never shipped.
 *
 * The `assets` gate (scripts/check-assets.mjs) fails when a file in assets/ has no record, changed
 * since it was recorded, or when game code points at the reference library.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { addRef } from './refs.mjs';

export const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
export const MANIFEST = path.join(REPO_ROOT, 'studio', 'assets', 'manifest.json');
const AGENTISH = /^(producer|director|liaison|builder|rnd|planner|reviewer|watch|agent|claude|codex|cursor|grok|gemini)(-|$)/i;

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { assets: [] };
  }
}
function writeManifest(m) {
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
}

export async function addAsset({ source, use, owner = '', licence = '', origin = '', by = '', game = '', feature = '' }) {
  if (use === 'reference') {
    const r = await addRef({ source, game: game || 'our own', feature: feature || path.basename(String(source || '')), by: by || 'game-dev' });
    return r.ok ? { ok: true, reference: r.ref.id, note: r.note } : r;
  }
  if (use !== 'game') return { ok: false, message: '--use game (it goes in the game) or --use reference (to design from, never shipped).' };
  if (!by || AGENTISH.test(by)) return { ok: false, message: 'A person declares a game asset: --by <your name>.' };
  if (!owner || !licence) return { ok: false, message: 'Say who owns it and on what terms: --owner "<who>" --licence "<own work | licence name>". You are stating you own it or may use it in this game.' };
  const file = path.resolve(String(source || ''));
  if (!source || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, message: `No file at ${source}. (Download it first; game assets are kept as files.)` };
  const m = readManifest();
  const n = m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1;
  const id = `A-${String(n).padStart(3, '0')}`;
  const rel = `assets/${path.basename(file)}`;
  if (fs.existsSync(path.join(REPO_ROOT, rel)) && path.resolve(REPO_ROOT, rel) !== file) return { ok: false, message: `${rel} already exists; rename the file first.` };
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  if (path.resolve(REPO_ROOT, rel) !== file) fs.copyFileSync(file, path.join(REPO_ROOT, rel));
  const entry = { id, file: rel, sha256: sha256(path.join(REPO_ROOT, rel)), use: 'game', owner, licence, source: origin, declaredBy: by, declaredAt: new Date().toISOString(), statement: `${by} stated that ${owner} owns this file or holds a licence (${licence}) to use it in this game.` };
  m.assets.push(entry);
  writeManifest(m);
  emitEvent({ type: 'asset.added', agent: by, to: 'producer', msg: `${id} ${rel} declared for the game by ${by} (owner ${owner}, ${licence})` });
  return { ok: true, asset: entry };
}

/** The game dev approved a studio-made design under assets/ (npm run art -- approve): record it like a declaration. */
export function recordApproved({ file, by, licence, source = '', design, maker }) {
  const abs = path.join(REPO_ROOT, file);
  if (!fs.existsSync(abs)) return { ok: false, message: `${file} is gone; propose it again.` };
  const m = readManifest();
  const existing = m.assets.find((a) => a.file === file);
  if (existing) {
    Object.assign(existing, { sha256: sha256(abs), declaredBy: by, declaredAt: new Date().toISOString(), design });
    writeManifest(m);
    return { ok: true, asset: existing };
  }
  const n = m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1;
  const entry = { id: `A-${String(n).padStart(3, '0')}`, file, sha256: sha256(abs), use: 'game', owner: 'this studio', licence: licence || 'own work (made in this studio)', source: source || `made by ${maker}`, declaredBy: by, declaredAt: new Date().toISOString(), design, statement: `${by} approved design ${design} for the game; ${maker} made or sourced it (${licence || 'own work'}${source ? `, from ${source}` : ''}).` };
  m.assets.push(entry);
  writeManifest(m);
  emitEvent({ type: 'asset.added', agent: by, to: 'producer', msg: `${entry.id} ${file} approved for the game by ${by} (design ${design}, ${entry.licence})` });
  return { ok: true, asset: entry };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++;
    } else pos.push(argv[i]);
  }
  const [cmd = 'list', a1] = pos;
  if (cmd === 'add') {
    const r = await addAsset({ source: a1, use: flag('use'), owner: flag('owner') || '', licence: flag('licence') || flag('license') || '', origin: flag('source') || '', by: flag('by') || '', game: flag('game') || '', feature: flag('feature') || '' });
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(r.asset ? `${r.asset.id} ${r.asset.file} recorded for the game. ${r.asset.statement}` : `Kept as reference ${r.reference} (never shipped). ${r.note}`);
  } else {
    const m = readManifest();
    console.log(m.assets.length ? m.assets.map((a) => `${a.id} ${a.file} (${a.licence}; owner ${a.owner}; declared by ${a.declaredBy} ${a.declaredAt.slice(0, 10)})`).join('\n') : 'No game assets recorded yet.');
  }
}
