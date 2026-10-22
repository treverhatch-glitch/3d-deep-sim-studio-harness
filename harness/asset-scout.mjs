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
 *   npm run scout -- find "<what>" --kind model|texture|palette|reference|any   (2.30e: textures, palettes, references)
 *   npm run scout -- palette <lospec-slug>   pull a CC0/CC-BY palette into the ledger; it becomes studio/art/palette.json
 *   npm run scout -- find "<what>" --min-quality 6 [--vision]   2.30e: every hit gets a 0-10 quality score (harness/scout-quality.mjs)
 *   npm run scout -- credits                 rewrite CREDITS.md from the asset ledger
 *
 * Agents may pull (the allowlist is the check; a person approved it). Pulled files go to assets/scouted/<source>/,
 * the ledger (studio/assets/manifest.json) marks them scouted: true, and CREDITS.md is regenerated.
 * scripts/check-assets.mjs fails on a disallowed licence, a CC-BY file with no author, or a stale CREDITS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManifest, MANIFEST, entryFor } from './assets.mjs';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { judgeResults } from './scout-quality.mjs';

export const CREDITS = path.join(REPO_ROOT, 'CREDITS.md');
export const SOURCES = [
  { id: 'polyhaven', name: 'Poly Haven', licence: 'CC0', api: true, page: 'https://polyhaven.com' },
  { id: 'ambientcg', name: 'ambientCG', licence: 'CC0', api: true, page: 'https://ambientcg.com' },
  { id: 'lospec', name: 'Lospec', licence: 'per item', api: false, page: 'https://lospec.com/palette-list', search: (q) => `https://lospec.com/palette-list?q=${encodeURIComponent(q)}` },
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
export async function scout(q, { fetch: f = globalThis.fetch, limit = 8, kind = 'any', minQuality = 0, vision = false, env = process.env } = {}) {
  const want = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (text) => want.every((w) => text.toLowerCase().includes(w));
  const results = [];
  const errors = [];
  if (['any', 'model', 'texture', 'reference'].includes(kind)) {
    try {
      const r = await f('https://api.polyhaven.com/assets');
      const all = await r.json();
      for (const [id, a] of Object.entries(all || {})) {
        // type: 0 hdri, 1 texture, 2 model
        const assetKind = { 0: 'hdri', 1: 'texture', 2: 'model' }[a.type];
        if (kind !== 'any' && kind !== assetKind && !(kind === 'reference' && assetKind === 'hdri')) continue;
        if (!hit(`${id} ${a.name || ''} ${(a.tags || []).join(' ')} ${(a.categories || []).join(' ')}`)) continue;
        results.push({ source: 'polyhaven', id, title: a.name || id, licence: 'CC0', author: Object.keys(a.authors || {}).join(', ') || 'Poly Haven', page: `https://polyhaven.com/a/${id}`, kind: assetKind,
          resolution: a.max_resolution, polycount: a.polycount, downloads: a.download_count, tags: a.tags, thumb: a.thumbnail_url });
      }
    } catch (err) {
      errors.push(`Poly Haven: ${String(err?.message || err)}`);
    }
  }
  if (['any', 'texture'].includes(kind)) {
    try {
      const r = await f(`https://ambientcg.com/api/v2/full_json?type=Material&limit=${limit}&include=downloadData,tagData,imageData,mapData&q=${encodeURIComponent(q)}`);
      const j = await r.json();
      for (const a of j?.foundAssets || []) {
        results.push({ source: 'ambientcg', id: a.assetId, title: a.displayName || a.assetId, licence: 'CC0', author: 'ambientCG', page: `https://ambientcg.com/view?id=${a.assetId}`, kind: 'texture',
          maps: a.maps, downloads: a.downloadCount != null ? Number(a.downloadCount) : undefined, tags: a.tags, thumb: a.previewImage?.['256-PNG'] || a.previewImage?.['128-PNG'] });
      }
    } catch (err) {
      errors.push(`ambientCG: ${String(err?.message || err)}`);
    }
  }
  const check = SOURCES.filter((s) => !s.api && (kind === 'palette' ? s.id === 'lospec' : s.id !== 'lospec')).map((s) => ({ source: s.id, name: s.name, licence: s.licence, url: s.search(q) }));
  const judged = await judgeResults(results, { minQuality, vision, fetch: f, env, query: q });
  return { results: judged.slice(0, limit * 2), check, errors, dropped: results.length - judged.length };
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
export async function pull({ from, licence, author = '', source = '', title = '', by = '', kind: assetKind = null, quality = '', fetch: f = globalThis.fetch }) {
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
  const entry = { ...entryFor(rel, { id, owner: author || 'public domain (CC0)', licence, origin: source, by: who, author, credit, madeBy: who, kind: assetKind }), title: title || name, scouted: true };
  if (quality !== '' && Number.isFinite(Number(quality))) entry.quality = Number(quality);
  m.assets = existing ? m.assets.map((a) => (a.file === rel ? entry : a)) : [...m.assets, entry];
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
  writeCredits();
  emitEvent({ type: 'asset.added', agent: who, to: 'producer', msg: `${id} ${rel} scouted (${licence}${author ? `, ${author}` : ''}) from ${source}` });
  return { ok: true, asset: entry };
}

/**
 * Pull a colour palette from Lospec (palette-list/<slug>.json). The licence comes from the palette's page;
 * only CC0 or CC-BY is taken, like any other asset. The file lands in assets/scouted/lospec/, goes in the
 * ledger (kind: palette, with the credit for CC-BY) and becomes the art department's palette:
 * studio/art/palette.json, which `npm run adapt` recolours to.
 */
export async function scoutPalette(name, { fetch: f = globalThis.fetch, by = '' } = {}) {
  const id = slug(name);
  const pageUrl = `https://lospec.com/palette-list/${id}`;
  try {
    const [jsonRes, pageRes] = await Promise.all([f(`${pageUrl}.json`), f(pageUrl)]);
    if (!jsonRes.ok) return { ok: false, message: `No palette "${id}" on Lospec (${jsonRes.status})` };
    const data = await jsonRes.json();
    const html = pageRes.ok ? await pageRes.text() : '';
    const named = (html.match(/licen[cs]e[^<]{0,40}?(CC[- ]BY[- ](?:SA|NC|ND)[\w.-]*|CC0|CC[- ]BY(?:[- ]\d(?:\.\d)?)?)/i) || [])[1] || '';
    const kind = allowedLicence(named);
    if (!kind) return { ok: false, message: `Palette "${id}" has ${named ? `licence "${named}"` : 'no licence on its page'}; only CC0 or CC-BY can ship. Copy the colours by hand into studio/art/palette.json as your own if you made them.` };
    const colors = (data.colors || []).map((c) => `#${String(c).replace(/^#/, '').toLowerCase()}`).filter((c) => /^#[0-9a-f]{6}$/.test(c));
    if (!colors.length) return { ok: false, message: `Palette "${id}" has no colours` };
    const author = data.author || '';
    if (kind === 'CC-BY' && !author) return { ok: false, message: `Palette "${id}" is CC-BY but names no author to credit` };
    const palette = { name: data.name || id, colors, source: pageUrl, licence: named.toUpperCase().replace(/\s+/g, '-'), author };
    const rel = `assets/scouted/lospec/${id}.json`;
    fs.mkdirSync(path.join(REPO_ROOT, 'assets/scouted/lospec'), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, rel), `${JSON.stringify(palette, null, 2)}\n`);
    const active = path.join(REPO_ROOT, 'studio', 'art', 'palette.json');
    fs.mkdirSync(path.dirname(active), { recursive: true });
    fs.writeFileSync(active, `${JSON.stringify({ ...palette, file: rel }, null, 2)}\n`);
    const m = readManifest();
    const existing = m.assets.find((x) => x.file === rel);
    const aid = existing?.id || `A-${String(m.assets.reduce((x, y) => Math.max(x, Number(y.id.slice(2)) || 0), 0) + 1).padStart(3, '0')}`;
    const who = by || 'asset-scout';
    const credit = kind === 'CC-BY' ? `"${palette.name}" palette by ${author}, ${palette.licence}, ${pageUrl}` : '';
    const entry = { ...entryFor(rel, { id: aid, owner: author || 'public domain (CC0)', licence: palette.licence, origin: pageUrl, by: who, author, credit, madeBy: who, kind: 'palette' }), title: palette.name, scouted: true };
    m.assets = existing ? m.assets.map((x) => (x.file === rel ? entry : x)) : [...m.assets, entry];
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    fs.writeFileSync(MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
    writeCredits();
    emitEvent({ type: 'asset.added', agent: who, to: 'producer', msg: `${aid} palette "${palette.name}" (${colors.length} colours, ${palette.licence}) from ${pageUrl}` });
    return { ok: true, file: active, palette, asset: entry };
  } catch (err) {
    return { ok: false, message: `Couldn't fetch palette "${id}": ${err.message}` };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  const [cmd, arg] = argv;
  if (cmd === 'find') {
    const kind = opt('kind') || 'any';
    if (!['model', 'texture', 'palette', 'reference', 'any'].includes(kind)) {
      console.error('Error: --kind must be model, texture, palette, reference, or any.');
      process.exit(1);
    }
    const minQuality = Number(opt('min-quality') || 0);
    const vision = argv.includes('--vision') || process.env.STUDIO_SCOUT_VISION === '1';
    const r = await scout(arg || '', { kind, minQuality, vision, ...(opt('fetch') ? { fetch: (await import(pathToFileURL(path.resolve(opt('fetch'))).href)).default } : {}) });
    for (const x of r.results) console.log(`  q${x.quality.toFixed(1).padStart(4)}  ${x.source.padEnd(10)} ${x.kind ? `[${x.kind}] ` : ''}${x.title} (${x.licence}, ${x.author}) ${x.page}\n          quality: ${x.qualityWhy}`);
    if (r.dropped) console.log(`  (${r.dropped} below --min-quality ${minQuality} left out)`);
    if (kind === 'reference') console.log('References are for designing from, never shipped: npm run asset -- add <file> --use reference (any licence; not in CREDITS.md).');
    if (kind === 'palette') console.log('Pull one: npm run scout -- palette <slug> (CC0 or CC-BY only; becomes studio/art/palette.json).');
    if (!r.results.length) console.log('  no CC0 hits from the API sources');
    console.log('Check these by hand (licence per item; only CC0 or CC-BY can ship):');
    for (const c of r.check) console.log(`  ${c.name.padEnd(11)} ${c.url}`);
    for (const e of r.errors) console.log(`  (skipped ${e})`);
  } else if (cmd === 'pull') {
    const r = await pull({ from: arg, licence: opt('licence'), author: opt('author'), source: opt('source'), title: opt('title'), by: opt('by') || process.env.STUDIO_LOCK_OWNER || '', kind: opt('kind'), quality: opt('quality') });
    console.log(r.ok ? `${r.asset.id} ${r.asset.file} recorded (${r.asset.licence}); CREDITS.md updated` : r.message);
    process.exit(r.ok ? 0 : 1);
  } else if (cmd === 'palette') {
    // --fetch <module>: an offline stand-in for fetch (the self-test uses it).
    const f = opt('fetch') ? (await import(pathToFileURL(path.resolve(opt('fetch'))).href)).default : globalThis.fetch;
    const r = await scoutPalette(arg, { fetch: f, by: opt('by') || process.env.STUDIO_LOCK_OWNER || '' });
    if (r.ok) console.log(`Wrote CC0 palette '${r.palette.name}' to ${path.relative(REPO_ROOT, r.file)}`);
    else {
      console.error(r.message);
      process.exit(1);
    }
  } else if (cmd === 'credits') console.log(`wrote ${path.relative(REPO_ROOT, writeCredits())}`);
  else {
    console.log('npm run scout -- find "<what>" [--kind model|texture|palette|reference|any] | pull <url|file> --licence CC0|CC-BY-4.0 --author … --source <page> --title … [--kind model|texture] | palette <slug> | credits');
    process.exit(cmd ? 1 : 0);
  }
}
