#!/usr/bin/env node
/**
 * harness/asset-scout.mjs — the art asset scout (2.30b, G7).
 *
 * Finds free art the game may ship and pulls it in with its licence on record. Only CC0 and CC-BY are
 * allowed for the game; anything else (CC-BY-SA, NC, ND, "free for personal use", unknown) is refused and
 * pointed at the reference library (npm run asset -- add <file> --use reference), which is never shipped.
 *
 *   npm run scout -- find "<what>"          search the CC0 sources with an API (Poly Haven, ambientCG) and
 *                                            list the per-item sources (Kenney, OpenGameArt, Sketchfab) to check
 *   npm run scout -- pull <url|file> --licence CC0|CC-BY-4.0 --author "<who>" --source <page> --title "<name>" [--by <you>]
 *   npm run scout -- credits                 rewrite CREDITS.md from the asset ledger
 *
 * Agents may pull (the allowlist is the check; a person approved it). Pulled files go to assets/scouted/<source>/,
 * the ledger (studio/assets/manifest.json) marks them scouted: true, and CREDITS.md is regenerated.
 * scripts/check-assets.mjs fails on a disallowed licence, a CC-BY file with no author, or a stale CREDITS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, MANIFEST, entryFor } from './assets.mjs';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const CREDITS = path.join(REPO_ROOT, 'CREDITS.md');
export const SOURCES = [
  { id: 'polyhaven', name: 'Poly Haven', licence: 'CC0', api: true, page: 'https://polyhaven.com' },
  { id: 'ambientcg', name: 'ambientCG', licence: 'CC0', api: true, page: 'https://ambientcg.com' },
  { id: 'kenney', name: 'Kenney', licence: 'CC0', api: false, page: 'https://kenney.nl/assets', search: (q) => `https://kenney.nl/assets?search=${encodeURIComponent(q)}` },
  { id: 'opengameart', name: 'OpenGameArt', licence: 'per item', api: false, page: 'https://opengameart.org', search: (q) => `https://opengameart.org/art-search-advanced?keys=${encodeURIComponent(q)}&field_art_licenses_tid[]=4&field_art_licenses_tid[]=2` },
  { id: 'sketchfab', name: 'Sketchfab', licence: 'per item', api: false, page: 'https://sketchfab.com', search: (q) => `https://sketchfab.com/search?q=${encodeURIComponent(q)}&features=downloadable&licenses=7c23a1ba438d4306920229c12afcb5f9&licenses=322a749bcfa841b29dff1e8a1bb74b0b&type=models` },
];

/** CC0 or CC-BY (any version). Returns 'CC0' | 'CC-BY' | null. SA, NC and ND are not allowed. */
export function allowedLicence(l) {
  const s = String(l || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (/^(CC0|CC-0|CC0-1\.0|PUBLIC-DOMAIN)$/.test(s)) return 'CC0';
  if (/^CC-?BY(-\d(\.\d)?)?$/.test(s)) return 'CC-BY';
  return null;
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'asset';

/** Search the CC0 sources with an API; `fetch` is injectable so tests run offline. */
export async function scout(q, { fetch: f = globalThis.fetch, limit = 8 } = {}) {
  const want = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => want.every((w) => text.toLowerCase().includes(w));
  const results = [];
  const errors = [];
  try {
    const r = await f('https://api.polyhaven.com/assets');
    const all = await r.json();
    for (const [id, a] of Object.entries(all || {})) {
      if (!hit(`${id} ${a.name || ''} ${(a.tags || []).join(' ')} ${(a.categories || []).join(' ')}`)) continue;
      results.push({ source: 'polyhaven', id, title: a.name || id, licence: 'CC0', author: Object.keys(a.authors || {}).join(', ') || 'Poly Haven', page: `https://polyhaven.com/a/${id}` });
    }
  } catch (err) {
    errors.push(`Poly Haven: ${String(err?.message || err)}`);
  }
  try {
    const r = await f(`https://ambientcg.com/api/v2/full_json?type=Material&limit=${limit}&q=${encodeURIComponent(q)}`);
    const j = await r.json();
    for (const a of j?.foundAssets || []) results.push({ source: 'ambientcg', id: a.assetId, title: a.displayName || a.assetId, licence: 'CC0', author: 'ambientCG', page: `https://ambientcg.com/view?id=${a.assetId}` });
  } catch (err) {
    errors.push(`ambientCG: ${String(err?.message || err)}`);
  }
  const check = SOURCES.filter((s) => !s.api).map((s) => ({ source: s.id, name: s.name, licence: s.licence, url: s.search(q) }));
  return { results: results.slice(0, limit * 2), check, errors };
}

/** The CREDITS.md text for the ledger: every game asset that names an author or needs a credit. */
export function creditsText(m = readManifest()) {
  const rows = (m.assets || []).filter((a) => a.use === 'game' && (a.creditRequired || a.scouted || a.author));
  const lines = ['# Credits', '', 'Art the game ships that was made by others. Written by `npm run scout -- credits` from studio/assets/manifest.json; do not edit by hand.', ''];
  if (!rows.length) lines.push('No third-party assets yet.');
  for (const a of rows) lines.push(`- ${a.credit || `"${a.title || path.basename(a.file)}" by ${a.author || 'unknown'}`}, ${a.licence}${a.source ? `, ${a.source}` : ''} (${a.file})`);
  return `${lines.join('\n')}\n`;
}
export function writeCredits() {
  fs.writeFileSync(CREDITS, creditsText());
  return CREDITS;
}

/** Pull one asset (a URL or a local file) into assets/scouted/<source>/ with its licence on record. */
export async function pull({ from, licence, author = '', source = '', title = '', by = '', fetch: f = globalThis.fetch }) {
  const kind = allowedLicence(licence);
  if (!kind) return { ok: false, message: `"${licence || 'no licence'}" isn't on the allowlist (CC0 or CC-BY). It can't ship; keep it to design from: npm run asset -- add <file> --use reference` };
  if (kind === 'CC-BY' && !author) return { ok: false, message: 'CC-BY needs the author to credit: --author "<who>"' };
  if (!source) return { ok: false, message: 'Say where it came from: --source <the asset page URL>' };
  const isUrl = /^https?:\/\//.test(String(from || ''));
  if (!isUrl && !(from && fs.existsSync(from) && fs.statSync(from).isFile())) return { ok: false, message: `No file or URL at ${from}` };
  const host = (() => {
    try {
      return new URL(source).hostname.replace(/^www\./, '').split('.')[0];
    } catch {
      return 'other';
    }
  })();
  const name = path.basename(isUrl ? new URL(from).pathname : from) || `${slug(title)}.bin`;
  const rel = `assets/scouted/${slug(host)}/${name}`;
  const dest = path.join(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isUrl) {
    const r = await f(from);
    if (!r.ok) return { ok: false, message: `Download failed: ${r.status}` };
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  } else fs.copyFileSync(from, dest);
  const m = readManifest();
  const existing = m.assets.find((a) => a.file === rel);
  const id = existing?.id || `A-${String(m.assets.reduce((x, a) => Math.max(x, Number(a.id.slice(2))), 0) + 1).padStart(3, '0')}`;
  const who = by || 'asset-scout';
  const credit = kind === 'CC-BY' ? `"${title || name}" by ${author}, ${licence}, ${source}` : '';
  const entry = { ...entryFor(rel, { id, owner: author || 'public domain (CC0)', licence, origin: source, by: who, author, credit, madeBy: who }), title: title || name, scouted: true };
  m.assets = existing ? m.assets.map((a) => (a.file === rel ? entry : a)) : [...m.assets, entry];
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  writeCredits();
  emitEvent({ type: 'asset.added', agent: who, to: 'producer', msg: `${id} ${rel} scouted (${licence}${author ? `, ${author}` : ''}) from ${source}` });
  return { ok: true, asset: entry };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  const [cmd, arg] = argv;
  if (cmd === 'find') {
    const r = await scout(arg || '');
    for (const x of r.results) console.log(`  ${x.source.padEnd(10)} ${x.title} (${x.licence}, ${x.author}) ${x.page}`);
    if (!r.results.length) console.log('  no CC0 hits from the API sources');
    console.log('Check these by hand (licence per item; only CC0 or CC-BY can ship):');
    for (const c of r.check) console.log(`  ${c.name.padEnd(11)} ${c.url}`);
    for (const e of r.errors) console.log(`  (skipped ${e})`);
  } else if (cmd === 'pull') {
    const r = await pull({ from: arg, licence: opt('licence'), author: opt('author'), source: opt('source'), title: opt('title'), by: opt('by') || process.env.STUDIO_LOCK_OWNER || '' });
    console.log(r.ok ? `${r.asset.id} ${r.asset.file} recorded (${r.asset.licence}); CREDITS.md updated` : r.message);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'credits') console.log(`wrote ${path.relative(REPO_ROOT, writeCredits())}`);
  else {
    console.log('npm run scout -- find "<what>" | pull <url|file> --licence CC0|CC-BY-4.0 --author … --source <page> --title … | credits');
    process.exit(cmd ? 1 : 0);
  }
}
