#!/usr/bin/env node
/**
 * harness/assets.mjs — the game dev's own files (3D models, music, sound, maps, art), with a record
 * of whether each one may go in the game.
 *
 *   npm run asset -- add <file> --use game --owner "<who owns it>" --licence "<own work | licence name>" [--source "<where from>"] --by <person>
 *   npm run asset -- add <file or url> --use reference --game "…" --feature "…" [--by <name>]
 *   npm run asset -- add <file> --use game --generated "<tool>:<model>" --prompt <file> --terms "<plan or terms>" --by <person>
 *   npm run asset -- update <file> --by <person>                     re-record after a re-export (new checksum)
 *   npm run asset -- import-manifest <pack>/MANIFEST.json --by <person> [--pack <name>]   a whole pack at once
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

// Files already where the game loads them are recorded where they are; anything else is copied into
// assets/<pack>/ (namespaced, so two packs can both have a button_panel.glb).
const IN_PLACE = /^(assets|public|web)\/|^cartridges\/[^/]+\/assets\//;
const relOf = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/**
 * One ledger entry. Fields kept apart, because a CC0 author doesn't own the copy the game uses:
 * author (who made it), source (where from), licence, creditRequired + credit (the line to show),
 * declaredBy (the person who vouched), rightsHolder (who holds the right to ship it: the studio or
 * the dev), madeBy (the agent that made or fetched it), generated ({ tool, model, prompt, terms }
 * for AI-made art: the first thing a buyer or a store asks).
 */
function entryFor(rel, { id, owner, licence, origin, by, author = '', credit = '', madeBy = '', generated = null, design = null, pack = null }) {
  const holder = owner || by;
  return {
    id,
    file: rel,
    pack: pack || rel.split('/').slice(1, -1).join('/').replace(/^(approved|staging)\//, '') || null,
    sha256: sha256(path.join(REPO_ROOT, rel)),
    use: 'game',
    owner: holder,
    rightsHolder: holder,
    author: author || null,
    licence: generated ? `generated (${generated.tool}${generated.model ? `, ${generated.model}` : ''})` : licence,
    creditRequired: Boolean(credit) || /\bCC[- ]?BY\b/i.test(licence || ''),
    credit: credit || null,
    source: origin,
    madeBy: madeBy || null,
    generated,
    design,
    declaredBy: by,
    declaredAt: new Date().toISOString(),
    statement: generated
      ? `${by} stated that ${holder} may use this ${generated.tool}-generated file in this game${generated.terms ? ` under ${generated.terms}` : ''}.`
      : `${by} stated that ${holder} owns this file or holds a licence (${licence}) to use it in this game.`,
  };
}

export async function addAsset({ source, use, owner = '', licence = '', origin = '', by = '', game = '', feature = '', author = '', credit = '', madeBy = '', generated = null, pack = 'own' }) {
  if (use === 'reference') {
    const r = await addRef({ source, game: game || 'our own', feature: feature || path.basename(String(source || '')), by: by || 'game-dev' });
    return r.ok ? { ok: true, reference: r.ref.id, note: r.note } : r;
  }
  if (use !== 'game') return { ok: false, message: '--use game (it goes in the game) or --use reference (to design from, never shipped).' };
  if (!by || AGENTISH.test(by)) return { ok: false, message: 'A person declares a game asset: --by <your name>. (An agent proposes it with npm run art -- propose; the dev approves it.)' };
  if (!generated && (!owner || !licence)) return { ok: false, message: 'Say who holds the right to ship it and on what terms: --owner "<who>" --licence "<own work | CC0 | CC-BY 4.0 | …>" (or --generated "<tool>:<model>" --prompt <file> --terms "<plan or terms>" for AI-made art).' };
  const file = path.resolve(String(source || ''));
  if (!source || !fs.existsSync(file) || !fs.statSync(file).isFile()) return { ok: false, message: `No file at ${source}. (Download it first; game assets are kept as files.)` };
  let rel = relOf(file);
  if (rel.startsWith('..') || !IN_PLACE.test(rel) || /^assets\/staging\//.test(rel)) {
    const safePack = String(pack || 'own').replace(/[^a-z0-9/_-]/gi, '-').replace(/^\/+|\/+$/g, '') || 'own';
    rel = `assets/${safePack}/${path.basename(file)}`;
    const dest = path.join(REPO_ROOT, rel);
    if (fs.existsSync(dest) && path.resolve(dest) !== file && sha256(dest) !== sha256(file)) return { ok: false, message: `${rel} already exists with different content; use --pack <name> or rename the file.` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(dest) !== file) fs.copyFileSync(file, dest);
  }
  const m = readManifest();
  const existing = m.assets.find((a) => a.file === rel);
  const id = existing?.id || `A-${String(m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1).padStart(3, '0')}`;
  const entry = entryFor(rel, { id, owner, licence, origin, by, author, credit, madeBy, generated });
  m.assets = existing ? m.assets.map((a) => (a.file === rel ? entry : a)) : [...m.assets, entry];
  writeManifest(m);
  emitEvent({ type: 'asset.added', agent: by, to: 'producer', msg: `${id} ${rel} declared for the game by ${by} (${entry.rightsHolder}, ${entry.licence})${madeBy ? `, made by ${madeBy}` : ''}` });
  return { ok: true, asset: entry };
}

/** Re-record a file after it was re-exported: new checksum, same record, by a person. */
export function updateAsset(file, by) {
  if (!by || AGENTISH.test(by)) return { ok: false, message: 'A person re-records an asset: --by <your name>.' };
  const rel = relOf(path.resolve(REPO_ROOT, String(file || '')));
  const m = readManifest();
  const a = m.assets.find((x) => x.file === rel);
  if (!a) return { ok: false, message: `${rel} has no record yet: npm run asset -- add ${rel} …` };
  if (!fs.existsSync(path.join(REPO_ROOT, rel))) return { ok: false, message: `${rel} is gone.` };
  const was = a.sha256;
  Object.assign(a, { sha256: sha256(path.join(REPO_ROOT, rel)), updatedBy: by, updatedAt: new Date().toISOString() });
  writeManifest(m);
  emitEvent({ type: 'asset.updated', agent: by, msg: `${a.id} ${rel} re-recorded by ${by}${was === a.sha256 ? ' (unchanged)' : ''}` });
  return { ok: true, asset: a };
}

/**
 * Record a whole pack from its MANIFEST.json: { files: [{ file, author, source, licence, credit, generated }] },
 * paths relative to the manifest. Files stay where they are when they are already in assets/ or public/.
 */
export async function importManifest(manifestFile, { by, owner = '', pack = '' }) {
  const mf = path.resolve(String(manifestFile || ''));
  let j;
  try {
    j = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (err) {
    return { ok: false, message: `Can't read ${manifestFile}: ${err.message}` };
  }
  const files = Array.isArray(j) ? j : j.files || j.assets || [];
  const done = [];
  const failed = [];
  for (const f of files) {
    const src = path.resolve(path.dirname(mf), f.file || f.path || '');
    const r = await addAsset({ source: src, use: 'game', owner: owner || f.rightsHolder || f.owner || by, licence: f.licence || f.license || '', origin: f.source || f.source_url || f.url || '', by, author: f.author || '', credit: f.credit || '', madeBy: f.madeBy || f.made_by || j.madeBy || '', generated: f.generated || null, pack: pack || j.pack || path.basename(path.dirname(mf)) });
    if (r.ok) done.push(r.asset.id);
    else failed.push(`${f.file || f.path}: ${r.message}`);
  }
  return { ok: failed.length === 0, done, failed, message: failed.join('\n') };
}

/** A design approved in the Asset studio (npm run art -- approve): recorded like a declaration, with who made it. */
export function recordApproved({ file, by, licence, source = '', design, maker, author = '', generated = null, provisional = false }) {
  const abs = path.join(REPO_ROOT, file);
  if (!fs.existsSync(abs)) return { ok: false, message: `${file} is gone; propose it again.` };
  const m = readManifest();
  const existing = m.assets.find((a) => a.file === file);
  const id = existing?.id || `A-${String(m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1).padStart(3, '0')}`;
  const entry = { ...entryFor(file, { id, owner: 'this studio', licence: licence || 'own work (made in this studio)', origin: source || `made by ${maker}`, by, author, madeBy: maker, generated, design }), ...(provisional ? { provisional: true } : {}) };
  entry.statement = `${by} approved design ${design} for the game${provisional ? ' provisionally, while the game dev was away' : ''}; ${maker} made or sourced it (${entry.licence}${source ? `, from ${source}` : ''}).`;
  m.assets = existing ? m.assets.map((a) => (a.file === file ? entry : a)) : [...m.assets, entry];
  writeManifest(m);
  emitEvent({ type: 'asset.added', agent: by, to: 'producer', msg: `${entry.id} ${file} approved for the game by ${by}${provisional ? ' (provisional)' : ''} (design ${design}, ${entry.licence})` });
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
  const gen = flag('generated') ? { tool: flag('generated').split(':')[0], model: flag('generated').split(':').slice(1).join(':') || null, prompt: flag('prompt') || null, terms: flag('terms') || null, at: new Date().toISOString().slice(0, 10) } : null;
  const fail = (m) => {
    console.error(m);
    process.exit(1);
  };
  if (cmd === 'add') {
    const r = await addAsset({ source: a1, use: flag('use'), owner: flag('owner') || '', licence: flag('licence') || flag('license') || '', origin: flag('source') || '', by: flag('by') || '', game: flag('game') || '', feature: flag('feature') || '', author: flag('author') || '', credit: flag('credit') || '', madeBy: flag('made-by') || '', generated: gen, pack: flag('pack') || 'own' });
    if (!r.ok) fail(r.message);
    console.log(r.asset ? `${r.asset.id} ${r.asset.file} recorded for the game. ${r.asset.statement}` : `Kept as reference ${r.reference} (never shipped). ${r.note}`);
  } else if (cmd === 'update') {
    const r = updateAsset(a1, flag('by'));
    if (!r.ok) fail(r.message);
    console.log(`${r.asset.id} ${r.asset.file} re-recorded.`);
  } else if (cmd === 'import-manifest') {
    const r = await importManifest(a1, { by: flag('by') || '', owner: flag('owner') || '', pack: flag('pack') || '' });
    console.log(`Recorded ${r.done.length} file(s)${r.done.length ? `: ${r.done.join(', ')}` : ''}.`);
    if (!r.ok) fail(r.message);
  } else {
    const m = readManifest();
    console.log(m.assets.length ? m.assets.map((a) => `${a.id} ${a.file} (${a.licence}${a.creditRequired ? `, credit: ${a.credit || 'required'}` : ''}; rights: ${a.rightsHolder || a.owner}${a.author ? `; author ${a.author}` : ''}${a.madeBy ? `; made by ${a.madeBy}` : ''}; declared by ${a.declaredBy} ${a.declaredAt.slice(0, 10)})`).join('\n') : 'No game assets recorded yet.');
  }
}
