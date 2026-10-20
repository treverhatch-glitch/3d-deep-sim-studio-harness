#!/usr/bin/env node
/**
 * harness/refs.mjs — the reference library: games, features, videos and files to design from.
 *
 *   npm run ref -- add <url or file> --game "…" --feature "…" [--at 1:23] [--take "…"] [--avoid "…"] [--by <name>]
 *   npm run ref -- attach R-001 <file>          add your own copy (a clip you saved, a screenshot)
 *   npm run ref -- frames R-001 [--every 2] [--max 8]   pull stills from a video for agents that read images
 *   npm run ref -- list | show R-001
 *
 * Files are kept, not just linked: each reference gets a folder in the library with the media and a
 * note. The library lives in STUDIO_REFERENCE_DIR (point it at a Google Drive, Dropbox or OneDrive
 * folder on this computer so it syncs and stays reachable), or `references/` in the repo (ignored by
 * git, so big files never reach a public repo). The index of all references,
 * studio/references/library.json and LIBRARY.md, is small and committed in your private copy.
 *
 * A link to a file (video, image, audio, model) is downloaded. A link to a web page (a YouTube
 * video, a store page) is kept as a link with its timestamp: save the clip with the site's own
 * download or offline feature, or record it yourself, and `attach` it. Check a source's terms before
 * downloading from it. Everything here is a reference: it is never shipped in the game (the assets
 * gate makes sure).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

const INDEX = path.join(REPO_ROOT, 'studio', 'references', 'library.json');
export const libraryDir = () => path.resolve(REPO_ROOT, process.env.STUDIO_REFERENCE_DIR || 'references');
const MAX_MB = () => Number(process.env.STUDIO_REFERENCE_MAX_MB || 300);
const MEDIA = /^(video|image|audio)\/|^model\/|^application\/(octet-stream|pdf|zip)/;
const now = () => new Date().toISOString();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ref';

export function readRefs() {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return [];
  }
}
function writeRefs(list) {
  fs.mkdirSync(path.dirname(INDEX), { recursive: true });
  fs.writeFileSync(INDEX, `${JSON.stringify(list, null, 2)}\n`);
  const lines = ['# Reference library', '', `> Written by \`npm run ref\`. Media is in \`${process.env.STUDIO_REFERENCE_DIR ? 'STUDIO_REFERENCE_DIR' : 'references/'}\` (one folder per reference). References are for designing from; they are never shipped.`, ''];
  for (const r of list) {
    lines.push(`## ${r.id} ${r.game}: ${r.feature}`, `- Source: ${r.url || r.original || 'a local file'}${r.at ? ` at ${r.at}` : ''}`, `- Kept: ${r.files.length ? r.files.map((f) => `\`${f}\``).join(', ') : 'link only (attach a saved copy with `npm run ref -- attach`)'}`);
    if (r.take) lines.push(`- Take: ${r.take}`);
    if (r.avoid) lines.push(`- Avoid: ${r.avoid}`);
    if (r.frames?.length) lines.push(`- Stills for agents: ${r.frames.length} in \`${r.folder}/frames/\``);
    lines.push('');
  }
  fs.writeFileSync(path.join(path.dirname(INDEX), 'LIBRARY.md'), lines.join('\n'));
}

function folderFor(r) {
  const dir = path.join(libraryDir(), r.folder);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function download(url, dir) {
  const head = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!head.ok) throw new Error(`HTTP ${head.status}`);
  const type = head.headers.get('content-type') || '';
  if (!MEDIA.test(type)) {
    head.body?.cancel?.();
    return { page: true, type };
  }
  const len = Number(head.headers.get('content-length') || 0);
  if (len && len > MAX_MB() * 1048576) {
    head.body?.cancel?.();
    throw new Error(`${Math.round(len / 1048576)} MB is over STUDIO_REFERENCE_MAX_MB (${MAX_MB()})`);
  }
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download').replace(/[^\w.-]+/g, '_') || 'download';
  const buf = Buffer.from(await head.arrayBuffer());
  fs.writeFileSync(path.join(dir, name), buf);
  return { file: name, type, bytes: buf.length };
}

export async function addRef({ source, game = '', feature = '', at = '', take = '', avoid = '', by = 'game-dev' }) {
  if (!source) return { ok: false, message: 'Give a link or a file: npm run ref -- add <url or file> --game "…" --feature "…"' };
  if (!game || !feature) return { ok: false, message: 'Say which game and which feature: --game "…" --feature "…" (what to look at).' };
  const list = readRefs();
  const n = list.reduce((m, r) => Math.max(m, Number(r.id.slice(2))), 0) + 1;
  const id = `R-${String(n).padStart(3, '0')}`;
  const r = { id, game, feature, at, take, avoid, by, addedAt: now(), folder: `${id}-${slug(`${game} ${feature}`)}`, files: [], frames: [] };
  const dir = folderFor(r);
  let note = '';
  if (/^https?:\/\//i.test(source)) {
    r.url = source;
    try {
      const d = await download(source, dir);
      if (d.page) note = `That link is a web page (${d.type || 'unknown type'}), so it is kept as a link${at ? ` at ${at}` : ''}. Save the clip with the site's own download or offline feature, or record it yourself, then: npm run ref -- attach ${id} <file>`;
      else {
        r.files.push(d.file);
        note = `Downloaded ${d.file} (${Math.round(d.bytes / 1024)} KB).`;
      }
    } catch (err) {
      note = `Kept as a link; downloading failed (${err.message}). Attach a copy with: npm run ref -- attach ${id} <file>`;
    }
  } else {
    const file = path.resolve(source);
    if (!fs.existsSync(file)) return { ok: false, message: `No file at ${source}` };
    r.original = path.basename(file);
    fs.copyFileSync(file, path.join(dir, path.basename(file)));
    r.files.push(path.basename(file));
    note = `Copied ${path.basename(file)} into the library.`;
  }
  fs.writeFileSync(path.join(dir, 'NOTE.md'), `# ${id} ${game}: ${feature}\n\n${r.url ? `Link: ${r.url}${at ? ` at ${at}` : ''}\n` : ''}Take: ${take || '?'}\nAvoid: ${avoid || '?'}\nAdded by ${by}, ${r.addedAt}\n`);
  list.push(r);
  writeRefs(list);
  emitEvent({ type: 'ref.added', agent: by, msg: `${id} ${game}: ${feature}${r.files.length ? ' (kept a copy)' : ' (link)'}` });
  return { ok: true, ref: r, note };
}

export function attachRef(id, file) {
  const list = readRefs();
  const r = list.find((x) => x.id === id);
  if (!r) return { ok: false, message: `No reference ${id}.` };
  const src = path.resolve(file || '');
  if (!file || !fs.existsSync(src)) return { ok: false, message: `No file at ${file}` };
  fs.copyFileSync(src, path.join(folderFor(r), path.basename(src)));
  r.files = [...new Set([...r.files, path.basename(src)])];
  writeRefs(list);
  return { ok: true, ref: r };
}

/** Stills from a kept video, for agents whose model reads images but not video. Needs ffmpeg. */
export function framesRef(id, { every = 2, max = 8 } = {}) {
  const list = readRefs();
  const r = list.find((x) => x.id === id);
  if (!r) return { ok: false, message: `No reference ${id}.` };
  const video = r.files.findLast((f) => /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(f));
  if (!video) return { ok: false, message: `${id} has no video kept. Attach one first: npm run ref -- attach ${id} <file>` };
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return { ok: false, message: 'ffmpeg is not installed (https://ffmpeg.org/download.html).' };
  const dir = folderFor(r);
  const out = path.join(dir, 'frames');
  fs.mkdirSync(out, { recursive: true });
  const start = r.at ? ['-ss', String(r.at)] : [];
  const res = spawnSync('ffmpeg', ['-y', ...start, '-i', path.join(dir, video), '-vf', `fps=1/${every}`, '-frames:v', String(max), path.join(out, 'still-%02d.jpg')], { encoding: 'utf8' });
  if (res.status !== 0) return { ok: false, message: `ffmpeg failed: ${res.stderr.split('\n').slice(-3).join(' ')}` };
  r.frames = fs.readdirSync(out).filter((f) => f.endsWith('.jpg')).sort();
  writeRefs(list);
  return { ok: true, frames: r.frames.map((f) => path.join(r.folder, 'frames', f)) };
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
  const [cmd = 'list', a1, a2] = pos;
  const fail = (m) => {
    console.error(m);
    process.exit(1);
  };
  if (cmd === 'add') {
    const r = await addRef({ source: a1, game: flag('game') || '', feature: flag('feature') || '', at: flag('at') || '', take: flag('take') || '', avoid: flag('avoid') || '', by: flag('by') || process.env.STUDIO_LOCK_OWNER || 'game-dev' });
    if (!r.ok) fail(r.message);
    console.log(`${r.ref.id} added to the library (${path.relative(REPO_ROOT, path.join(libraryDir(), r.ref.folder)) || r.ref.folder}). ${r.note}`);
  } else if (cmd === 'attach') {
    const r = attachRef(a1, a2);
    if (!r.ok) fail(r.message);
    console.log(`Kept ${path.basename(a2)} with ${a1}.`);
  } else if (cmd === 'frames') {
    const r = framesRef(a1, { every: Number(flag('every') || 2), max: Number(flag('max') || 8) });
    if (!r.ok) fail(r.message);
    console.log(`${r.frames.length} stills:\n${r.frames.join('\n')}`);
  } else if (cmd === 'show') {
    const r = readRefs().find((x) => x.id === a1);
    if (!r) fail(`No reference ${a1}`);
    console.log(JSON.stringify(r, null, 2));
  } else {
    const list = readRefs();
    console.log(list.length ? list.map((r) => `${r.id} ${r.game}: ${r.feature}${r.at ? ` @${r.at}` : ''} (${r.files.length ? `${r.files.length} file(s)` : 'link only'})`).join('\n') : 'No references yet: npm run ref -- add <url or file> --game "…" --feature "…"');
  }
}
