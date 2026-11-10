/**
 * harness/asset-need.mjs — 2.67.1 (l): one asset flow. `npm run asset -- need "<what>"` asks for an asset once and the
 * harness looks for it in order, logging what each step found and why it moved on:
 *
 *   npm run asset -- need "<what>" --for unity|web --budget <tris> [--size <m>] [--style <ref image or words>] [--tags a,b] [--kind model] [--by <you>]
 *   npm run asset -- needs [<id>] [--all]          open needs (or one need's trail and brief)
 *   npm run asset -- library refresh <dir>         index a shared folder (sha256 per file; append-only, never deletes)
 *
 *   (a) library first: the studio's own ledger, other ledgers and folder indexes listed in studio/assets.json "libraries";
 *       matched by words/tags, kind, triangles, size and the licence policy; an optional configured `scorer` adds an
 *       advisory style score (ranking only, never a gate).
 *   (b) reuse first: the same need again (same words, target and budget) answers "already in library: <id>" and stops.
 *   (c) internet scout (asset-scout.mjs's sources and licence rules, CC0/CC-BY only) plus configured offer lists and
 *       Sketchfab where a key is configured (the key is never printed).
 *   (d) pull + adapt: the existing pull, then a target profile. Unity: scale and pivot normalised to metres (bottom
 *       centre) in the glTF JSON, a box collider, a prefab stub, the licence row; LOD1-2, FBX conversion and HDRP mask
 *       maps are configured commands run under machine:heavy, skipped with a note when not installed.
 *   (e) else make: ONE make task for the asset role with the brief, deduped by need id.
 *
 * Need records live in .studio/assets/needs/<id>.json. Every source and command comes from studio/assets.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent, actor } from './event.mjs';
import { readManifest, writeManifest, entryFor, MANIFEST, sha256 } from './assets.mjs';
import { readJson } from './fsafe.mjs';

export const NEEDS_DIR = path.join(STUDIO_STATE_DIR, 'assets', 'needs');
export const LIBRARY_CACHE_DIR = path.join(STUDIO_STATE_DIR, 'assets', 'library');
export const CONFIG_FILE = path.join(REPO_ROOT, 'studio', 'assets.json');
const MODEL_EXT = ['.glb', '.gltf', '.fbx', '.obj', '.blend'];
const INDEX_EXT = [...MODEL_EXT, '.png', '.jpg', '.jpeg', '.webp', '.tga', '.wav', '.ogg', '.mp3', '.flac'];
const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'with', 'and', 'in', 'on', 'to', 'asset', 'model']);

const writeJson = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); };
const now = () => new Date().toISOString();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'asset';
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const posix = (p) => p.split(path.sep).join('/');

/** studio/assets.json, with studio/game.json "assets" as a fallback for commands. */
export function readConfig() {
  const c = readJson(CONFIG_FILE, {}) || {};
  const g = readJson(path.join(REPO_ROOT, 'studio', 'game.json'), {}) || {};
  return { bar: 6, makeRole: 'asset-3d', ...(g.assets || {}), ...c, commands: { ...(g.assets?.commands || {}), ...(c.commands || {}) }, scout: { web: true, lists: [], ...(c.scout || {}) } };
}

// ---------- words, licences, matching ----------

const stem = (w) => (w.length > 3 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
export const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
export const needKey = ({ what, target, budget }) => `${[...new Set(words(what))].sort().join(' ')}|${target || ''}|${Number(budget) || 0}`;

/**
 * The library's licence policy (research 3): commercial-use licences ship; CC-BY ships with a credit (needs an author);
 * NC and ND are blocked; share-alike asks a game dev; AI-made is flagged; unknown is blocked. studio/assets.json
 * "licences": { "allow": [regex], "block": [regex], "ask": [regex] } adds rules, checked first.
 */
export function libraryLicence(licence, { author = '', generated = null } = {}, cfg = {}) {
  const s = String(licence || '').trim();
  const u = s.toUpperCase().replace(/[\s_]+/g, '-');
  const rules = cfg.licences || {};
  const any = (list) => (list || []).some((re) => { try { return new RegExp(re, 'i').test(s); } catch { return false; } });
  const ai = Boolean(generated) || /^GENERATED\b/.test(u);
  if (any(rules.block)) return { ok: false, cls: 'blocked', why: `"${s}" is blocked by studio/assets.json licences.block` };
  if (any(rules.ask)) return { ok: false, cls: 'ask', why: `"${s}": a game dev decides (studio/assets.json licences.ask)` };
  if (any(rules.allow)) return { ok: true, cls: 'allowed', ai, why: `"${s}" allowed by studio/assets.json` };
  if (!s && !ai) return { ok: false, cls: 'unknown', why: 'no licence on record' };
  if (/(^|-)NC(-|$)|NON-?COMMERCIAL/.test(u)) return { ok: false, cls: 'nc', why: `"${s}" is non-commercial (NC): it can't ship` };
  if (/(^|-)ND(-|$)|NO-?DERIV/.test(u)) return { ok: false, cls: 'nd', why: `"${s}" forbids changes (ND): it can't be adapted` };
  if (/(^|-)SA(-|$)|SHARE-?ALIKE|(^|-)L?GPL/.test(u)) return { ok: false, cls: 'share-alike', why: `"${s}" is share-alike: a game dev decides before it ships` };
  if (/PERSONAL|EDITORIAL|ALL-RIGHTS-RESERVED/.test(u)) return { ok: false, cls: 'blocked', why: `"${s}" doesn't allow shipping` };
  if (ai) return { ok: true, cls: 'generated', ai: true, why: `AI-made (${s || generated?.tool}): flagged; its tool's terms follow it` };
  if (/^(CC0|CC-0|CC0-1\.0|PUBLIC-DOMAIN|UNLICENSE)$/.test(u)) return { ok: true, cls: 'cc0', ai, why: 'CC0' };
  if (/^CC-?BY(-\d(\.\d)?)?$/.test(u)) return author ? { ok: true, cls: 'cc-by', ai, credit: true, why: 'CC-BY: ships with a credit' } : { ok: false, cls: 'cc-by', why: 'CC-BY with no author to credit' };
  if (/OWN-WORK|MADE-IN-THIS-STUDIO|^MIT|APACHE|^BSD|ZLIB|ROYALTY-?FREE|COMMERCIAL/.test(u)) return { ok: true, cls: 'commercial', ai, why: `"${s}" allows commercial use` };
  return { ok: false, cls: 'unknown', why: `"${s}" isn't a licence the policy knows: a game dev records it` };
}

/** Score one candidate against a need: { pass, score 0-10, why[] }. */
export function judge(need, c, cfg = {}) {
  const want = [...new Set(words(need.what))];
  const have = new Set(words([c.title, c.file && path.basename(c.file, path.extname(c.file)), c.file && path.dirname(c.file), ...(c.tags || []), c.pack].filter(Boolean).join(' ')));
  const hit = want.filter((w) => have.has(w));
  const why = [];
  let score = want.length ? (10 * hit.length) / want.length : 0;
  const reject = (w) => ({ pass: false, score: Math.round(score * 10) / 10, why: [...why, w] });
  if (need.kind && c.kind && need.kind !== c.kind) return reject(`kind ${c.kind}, need ${need.kind}`);
  const tags = need.tags || [];
  const missing = tags.filter((t) => !have.has(stem(t.toLowerCase())));
  if (missing.length) return reject(`missing tag(s) ${missing.join(', ')}`);
  if (need.budget && c.tris != null && c.tris > need.budget) return reject(`${c.tris} tris > budget ${need.budget}`);
  if (need.budget && c.tris == null) { score -= 1; why.push('triangles unknown (-1)'); }
  const tol = Number(cfg.sizeTolerance ?? 0.5);
  // A model's size is fixed by the Unity profile (scaled to --size), so size only matters when the profile can't rescale: an exact-size need.
  if (need.size && c.dims && need.exactSize) {
    const m = Math.max(...c.dims);
    if (Math.abs(m - need.size) > need.size * tol) return reject(`size ${m.toFixed(2)} m, need ${need.size} m`);
  }
  const lic = c._licence;
  if (lic && !lic.ok) return reject(lic.why);
  if (lic?.ai) why.push('AI-made: flagged');
  why.unshift(`matched ${hit.length}/${want.length} word(s)${hit.length ? ` (${hit.join(', ')})` : ''}`);
  score = Math.max(0, Math.round(score * 10) / 10);
  const bar = Number(cfg.bar ?? 6);
  return score >= bar ? { pass: true, score, why } : { pass: false, score, why: [...why, `score ${score} < bar ${bar}`] };
}

// ---------- glTF (pure JSON) ----------

/** { json, bin } from a .gltf or .glb buffer. */
export function readGltf(buf, ext) {
  if (ext !== '.glb') return { json: JSON.parse(buf.toString('utf8')), bin: null };
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
  let off = 12; let json = null; let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off); const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a && !json) json = JSON.parse(buf.toString('utf8', off + 8, off + 8 + len));
    else if (type === 0x004e4942 && !bin) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}
export function writeGltf(json, bin, ext) {
  if (ext !== '.glb') return Buffer.from(`${JSON.stringify(json, null, 2)}\n`);
  const pad = (b, fill) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4), fill)]) : b);
  const jb = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const parts = [Buffer.alloc(12), Buffer.alloc(8), jb];
  parts[1].writeUInt32LE(jb.length, 0); parts[1].writeUInt32LE(0x4e4f534a, 4);
  if (bin) { const bb = pad(Buffer.from(bin), 0); const h = Buffer.alloc(8); h.writeUInt32LE(bb.length, 0); h.writeUInt32LE(0x004e4942, 4); parts.push(h, bb); }
  const total = parts.reduce((n, b) => n + b.length, 0);
  parts[0].write('glTF', 0, 'ascii'); parts[0].writeUInt32LE(2, 4); parts[0].writeUInt32LE(total, 8);
  return Buffer.concat(parts);
}
const trs = (n) => {
  if (Array.isArray(n.matrix)) return n.matrix.slice();
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1]; const [sx, sy, sz] = n.scale || [1, 1, 1]; const [tx, ty, tz] = n.translation || [0, 0, 0];
  return [(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0, 2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0, 2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0, tx, ty, tz, 1];
};
const mul = (a, b) => { const o = new Array(16).fill(0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
const sceneRoots = (json) => {
  const s = (json.scenes || [])[json.scene ?? 0];
  if (s?.nodes) return s.nodes;
  const kids = new Set((json.nodes || []).flatMap((n) => n.children || []));
  return (json.nodes || []).map((_, i) => i).filter((i) => !kids.has(i));
};

/** Triangles and the world-space bounding box (POSITION min/max through node transforms) of a glTF's scene. */
export function gltfInfo(json) {
  let tris = 0; const min = [Infinity, Infinity, Infinity]; const max = [-Infinity, -Infinity, -Infinity];
  const acc = json.accessors || [];
  const walk = (i, parent, seen) => {
    const n = (json.nodes || [])[i]; if (!n || seen.has(i)) return; seen.add(i);
    const m = mul(parent, trs(n));
    for (const p of (json.meshes || [])[n.mesh]?.primitives || []) {
      const pos = acc[p.attributes?.POSITION]; if (!pos) continue;
      const count = p.indices != null ? acc[p.indices]?.count || 0 : pos.count || 0;
      const mode = p.mode ?? 4;
      tris += mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      if (Array.isArray(pos.min) && Array.isArray(pos.max)) {
        for (let k = 0; k < 8; k++) {
          const v = apply(m, [k & 1 ? pos.max[0] : pos.min[0], k & 2 ? pos.max[1] : pos.min[1], k & 4 ? pos.max[2] : pos.min[2]]);
          for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[a]); max[a] = Math.max(max[a], v[a]); }
        }
      }
    }
    for (const c of n.children || []) walk(c, m, seen);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const seen = new Set();
  for (const r of sceneRoots(json)) walk(r, I, seen);
  const bbox = Number.isFinite(min[0]) ? { min: min.map(r6), max: max.map(r6) } : null;
  return { tris, bbox, dims: bbox ? bbox.max.map((v, a) => r6(v - bbox.min[a])) : null };
}
const fileInfo = (abs) => {
  const ext = path.extname(abs).toLowerCase();
  if (!['.gltf', '.glb'].includes(ext)) return {};
  try { const { tris, dims } = gltfInfo(readGltf(fs.readFileSync(abs), ext).json); return { tris, dims }; } catch { return {}; }
};

/** Wrap the scene in a root node that scales to `sizeM` (largest side, metres) and puts the pivot at the bottom centre. */
export function normaliseGltf(json, { sizeM = null } = {}) {
  const info = gltfInfo(json);
  if (!info.bbox) return { ok: false, why: 'no POSITION min/max to measure (not normalised)' };
  const maxDim = Math.max(...info.dims);
  const s = sizeM && maxDim > 0 ? r6(sizeM / maxDim) : 1;
  const [cx, cz] = [(info.bbox.min[0] + info.bbox.max[0]) / 2, (info.bbox.min[2] + info.bbox.max[2]) / 2];
  const roots = sceneRoots(json);
  json.nodes = json.nodes || [];
  json.nodes.push({ name: 'studio_root', scale: [s, s, s], translation: [r6(-cx * s), r6(-info.bbox.min[1] * s), r6(-cz * s)], children: roots });
  if (!json.scenes?.length) { json.scenes = [{ nodes: [] }]; json.scene = 0; }
  json.scenes[json.scene ?? 0].nodes = [json.nodes.length - 1];
  const dims = info.dims.map((d) => r6(d * s));
  json.asset = { ...(json.asset || {}), extras: { ...(json.asset?.extras || {}), studio: { unit: 'm', pivot: 'bottom-centre', scale: s, sourceDims: info.dims, dims } } };
  return { ok: true, json, scale: s, dims, tris: info.tris };
}

// ---------- configured commands ----------

export function splitArgs(cmd) {
  const out = []; let cur = ''; let q = null; let any = false;
  for (const ch of String(cmd || '')) {
    if (q) { if (ch === q) q = null; else cur += ch; } else if (ch === '"' || ch === "'") { q = ch; any = true; } else if (/\s/.test(ch)) { if (cur || any) out.push(cur); cur = ''; any = false; } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}
/** The program's full path, or null when it isn't installed (PATH, and PATHEXT on Windows). */
export function findProgram(prog, env = process.env) {
  if (!prog) return null;
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
  if (path.isAbsolute(prog) || /[\\/]/.test(prog)) { const f = path.resolve(REPO_ROOT, prog); return exts.map((e) => f + e).find(isFile) || null; }
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) for (const e of exts) if (isFile(path.join(d, prog + e))) return path.join(d, prog + e);
  return null;
}
/** Run a configured command (placeholders {in} {out} {ratio} {style} …), under machine:heavy when heavy. Never through a shell glob. */
export async function runConfigured(name, cmd, vars, { heavy = true, timeoutMs = 30 * 60000 } = {}) {
  if (!cmd) return { ran: false, note: `${name}: no command configured (studio/assets.json commands.${name}); skipped` };
  const argv = splitArgs(cmd).map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)));
  const prog = findProgram(argv[0]);
  if (!prog) return { ran: false, note: `${name}: ${argv[0]} is not installed here; skipped (configure studio/assets.json commands.${name} or install it)` };
  const go = () => spawnSync(prog, argv.slice(1), { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(prog) });
  let r;
  if (heavy) { const { withHeavy } = await import('./heavy.mjs'); r = withHeavy(REPO_ROOT, `asset ${name}`, go, { owner: actor() }); } else r = go();
  const ok = r.status === 0;
  return { ran: true, ok, out: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-2000), note: `${name}: ${ok ? 'done' : `failed (exit ${r.status ?? r.error?.code})`}` };
}

// ---------- the library ----------

const cacheFor = (dir) => path.join(LIBRARY_CACHE_DIR, `${slug(path.basename(path.resolve(dir)))}-${crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 8)}.json`);
const kindOf = (f) => { const e = path.extname(f).toLowerCase(); return MODEL_EXT.includes(e) ? 'model' : ['.wav', '.ogg', '.mp3', '.flac'].includes(e) ? 'audio' : 'texture'; };

/** Metadata a shared folder already carries: manifest/index JSON files and studio-library/1 catalogs, by file and by sha256. */
function folderMeta(dir) {
  const byFile = new Map(); const bySha = new Map();
  const put = (e) => { if (!e || typeof e !== 'object') return; const f = e.file || e.path || e.blob; if (f) byFile.set(posix(String(f)).replace(/^\.\//, ''), e); if (e.sha256) bySha.set(e.sha256, e); };
  for (const n of ['manifest.json', 'MANIFEST.json', 'index.json', 'library.json', path.join('studio', 'assets', 'manifest.json')]) {
    const j = readJson(path.join(dir, n)); if (!j) continue;
    for (const e of Array.isArray(j) ? j : j.files || j.assets || j.items || []) put(e);
  }
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const n of names.filter((x) => /^catalog.*\.jsonl$/i.test(x))) {
    for (const line of String(fs.readFileSync(path.join(dir, n), 'utf8')).split('\n')) { try { const e = JSON.parse(line); if (!e.op || e.op === 'add') put(e); } catch {} }
  }
  return { byFile, bySha };
}

/**
 * Index a shared library folder (Drive for desktop or any folder): sha256 per file, metadata from a manifest/index there.
 * Append-only: entries are never removed; a file that went away or changed is marked missing and a new entry added.
 */
export function refreshLibrary(dir, { log = () => {} } = {}) {
  const abs = path.resolve(String(dir || ''));
  if (!dir || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { ok: false, message: `No folder at ${dir}.` };
  const file = cacheFor(abs);
  const idx = readJson(file, null) || { schema: 'studio-library-index/1', dir: abs, items: [] };
  const meta = folderMeta(abs);
  const seen = new Set(); let added = 0; let marked = 0;
  const walk = (d) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && INDEX_EXT.includes(path.extname(e.name).toLowerCase())) {
        const rel = posix(path.relative(abs, full)); const st = fs.statSync(full);
        const prev = idx.items.find((x) => x.file === rel && !x.missing);
        const sha = prev && prev.bytes === st.size && prev.mtimeMs === st.mtimeMs ? prev.sha256 : sha256(full);
        seen.add(`${rel}\n${sha}`);
        if (prev?.sha256 === sha) continue;
        const m = meta.byFile.get(rel) || meta.bySha.get(sha) || {};
        const info = fileInfo(full);
        idx.items.push({ id: `L-${sha.slice(0, 10)}`, file: rel, sha256: sha, bytes: st.size, mtimeMs: st.mtimeMs, kind: m.kind || kindOf(rel), title: m.title || m.name || path.basename(rel, path.extname(rel)), tags: Array.isArray(m.tags) ? m.tags : [],
          tris: m.metrics?.tris ?? m.tris ?? info.tris ?? null, dims: m.metrics?.bboxM ?? m.dims ?? info.dims ?? null, licence: m.licence?.spdx || m.licence || m.license || '', author: m.author || m.origin?.author || '', credit: m.credit || m.licence?.credit || '',
          source: m.source || m.origin?.source || '', generated: m.generated || m.origin?.generated || null, addedAt: now() });
        added++;
      }
    }
  };
  walk(abs);
  for (const it of idx.items) if (!it.missing && !seen.has(`${it.file}\n${it.sha256}`)) { it.missing = true; it.missingSince = now(); marked++; }
  idx.refreshedAt = now();
  writeJson(file, idx);
  log(`indexed ${abs}: ${added} new, ${marked} marked missing (kept), ${idx.items.length} in the index -> ${posix(path.relative(REPO_ROOT, file))}`);
  return { ok: true, file, added, marked, total: idx.items.length };
}

/** Every candidate from the configured libraries: [{ lib, id, file, abs, sha256, kind, title, tags, tris, dims, licence, … }]. */
export function libraryItems(cfg = readConfig(), notes = []) {
  const out = [];
  const fromManifest = (lib, mf, root) => {
    const m = readJson(mf, null);
    if (!m) { if (lib !== 'studio') notes.push(`library ${lib}: no ledger at ${mf}`); return; }
    for (const a of m.assets || []) {
      if (a.use && a.use !== 'game') continue;
      const abs = path.join(root, a.file || '');
      out.push({ lib, id: a.id, file: a.file, abs, sha256: a.sha256, kind: a.kind, title: a.title || '', tags: a.tags || [], pack: a.pack, licence: a.licence, author: a.author, credit: a.credit, source: a.source, generated: a.generated, ...(a.tris != null ? { tris: a.tris } : {}), ...fileInfo(abs) });
    }
  };
  fromManifest('studio', MANIFEST, REPO_ROOT);
  for (const [i, l] of (cfg.libraries || []).entries()) {
    const lib = l.id || `lib${i + 1}`;
    if (l.type === 'manifest' && l.path) {
      const mf = path.resolve(REPO_ROOT, l.path);
      if (path.resolve(mf) === path.resolve(MANIFEST)) continue;
      fromManifest(lib, mf, path.resolve(REPO_ROOT, l.root || (/studio[\\/]assets[\\/]manifest\.json$/.test(mf) ? path.join(path.dirname(mf), '..', '..') : path.dirname(mf))));
    } else if (l.type === 'folder' && (l.dir || l.index)) {
      const idxFile = l.index ? path.resolve(REPO_ROOT, l.index) : cacheFor(path.resolve(REPO_ROOT, l.dir));
      const idx = readJson(idxFile, null);
      if (!idx) { notes.push(`library ${lib}: not indexed yet (npm run asset -- library refresh ${l.dir || ''})`); continue; }
      const base = idx.dir || l.dir;
      for (const it of idx.items || []) if (!it.missing) out.push({ ...it, lib, abs: path.join(base, it.file) });
    } else notes.push(`library ${lib}: type must be manifest (with path) or folder (with dir)`);
  }
  return out;
}
const libraryShas = (cfg) => { const m = new Map(); for (const it of libraryItems(cfg)) if (it.sha256 && !m.has(it.sha256)) m.set(it.sha256, it); return m; };

// ---------- need records ----------

const needFile = (id) => path.join(NEEDS_DIR, `${id}.json`);
export function readNeeds() {
  let names = []; try { names = fs.readdirSync(NEEDS_DIR).filter((n) => /^N-\d+\.json$/.test(n)); } catch {}
  return names.map((n) => readJson(path.join(NEEDS_DIR, n))).filter(Boolean).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}
const nextId = () => `N-${String(readNeeds().reduce((x, n) => Math.max(x, Number(n.id.slice(2)) || 0), 0) + 1).padStart(3, '0')}`;

export function briefText(need, cfg = readConfig()) {
  // 2.67.1: the asset track's brief template (studio/templates/asset-brief.md) is the default; studio/assets.json briefTemplate overrides it.
  const tplPath = cfg.briefTemplate || 'studio/templates/asset-brief.md';
  const tpl = (() => { try { return fs.readFileSync(path.resolve(REPO_ROOT, tplPath), 'utf8'); } catch { return null; } })();
  const vars = { need: need.id, what: need.what, for: need.target, budget: need.budget || 'not set', size: need.size ? `${need.size} m (largest side)` : 'not set', style: need.style || 'none given', tags: (need.tags || []).join(', ') || 'none', licence: 'own work (made in this studio); record it with npm run asset -- add … --by <person>', role: cfg.makeRole || 'asset-3d' };
  const filled = [`# Make asset ${need.id}: ${need.what}`, '', `- Target: ${vars.for}`, `- Triangle budget: ${vars.budget}`, `- Size: ${vars.size}`, `- Style: ${vars.style}`, '- Nothing in the library or online passed the bar; the trail is in `npm run asset -- needs ' + need.id + '`.', ''];
  // A template with {placeholders} is filled; a fill-in-the-blanks one (the asset track's) follows the need's facts.
  if (tpl) return /\{(what|budget|size|style|for)\}/.test(tpl) ? tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : `${filled.join('\n')}\n${tpl}`;
  return [`# Make asset ${need.id}: ${need.what}`, '', `- Target: ${vars.for}`, `- Triangle budget: ${vars.budget}`, `- Size: ${vars.size}, real metres, pivot at the bottom centre`, `- Style reference: ${vars.style}`, `- Tags: ${vars.tags}`, `- Licence: ${vars.licence}`,
    '- Nothing in the library or online passed the bar; the trail is in `npm run asset -- needs ' + need.id + '`.', `- How the role works: studio/roles/${vars.role}.md`].join('\n');
}

// ---------- the flow ----------

async function scoutOffers(need, cfg, trail, { fetch: f } = {}) {
  const offers = [];
  for (const l of [].concat(cfg.scout.lists || [])) {
    const file = path.resolve(REPO_ROOT, l); const j = readJson(file, null);
    if (!j) { trail.push({ step: 'scout', source: posix(l), found: 0, why: `offer list ${l} not readable; skipped` }); continue; }
    const items = (Array.isArray(j) ? j : j.offers || j.items || []).map((o) => ({ ...o, source: o.source || `list:${path.basename(l)}`, file: o.file ? path.resolve(path.dirname(file), o.file) : null }));
    trail.push({ step: 'scout', source: posix(l), found: items.length, why: 'configured offer list' });
    offers.push(...items);
  }
  if (cfg.scout.web !== false) {
    try {
      const { scout } = await import('./asset-scout.mjs');
      const r = await scout(need.what, { kind: need.kind === 'model' ? 'model' : 'any', ...(f ? { fetch: f } : {}) });
      for (const x of r.results) offers.push({ ...x, tris: x.polycount ?? null, byHand: true });
      trail.push({ step: 'scout', source: 'web', found: r.results.length, why: `Poly Haven/ambientCG API${r.errors.length ? `; ${r.errors.join('; ')}` : ''}; their multi-file downloads are pulled by hand (npm run scout -- pull)` });
    } catch (err) { trail.push({ step: 'scout', source: 'web', found: 0, why: `scout failed: ${err.message}` }); }
    const keyName = cfg.scout.sketchfabKeyEnv || 'STUDIO_SKETCHFAB_KEY';
    const key = process.env[keyName];
    if (!key) trail.push({ step: 'scout', source: 'sketchfab', found: 0, why: `no ${keyName} set; Sketchfab skipped` });
    else {
      try {
        const ff = f || globalThis.fetch; const h = { headers: { Authorization: `Token ${key}` } };
        const r = await ff(`https://api.sketchfab.com/v3/search?type=models&downloadable=true&license=cc0&license=by&q=${encodeURIComponent(need.what)}`, h);
        const j = await r.json();
        const items = (j.results || []).map((m) => ({ source: 'sketchfab', id: m.uid, title: m.name, tags: (m.tags || []).map((t) => t.name || t), tris: m.faceCount ?? null, licence: m.license?.slug === 'cc0' ? 'CC0' : m.license?.slug === 'by' ? 'CC-BY-4.0' : m.license?.label || '', author: m.user?.displayName || m.user?.username || '', page: m.viewerUrl, sketchfab: m.uid }));
        trail.push({ step: 'scout', source: 'sketchfab', found: items.length, why: 'Sketchfab API (key configured, not shown)' });
        offers.push(...items);
      } catch (err) { trail.push({ step: 'scout', source: 'sketchfab', found: 0, why: `Sketchfab failed: ${String(err.message).replace(key, '***')}` }); }
    }
  }
  return offers;
}

/** Fetch an offer's file into the need's folder: a local file, a direct URL, or Sketchfab's glb link. */
async function download(offer, dest, cfg, { fetch: f } = {}) {
  const ff = f || globalThis.fetch;
  if (offer.file) { if (!fs.existsSync(offer.file)) return { ok: false, why: `offer file ${offer.file} missing` }; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(offer.file, dest); return { ok: true }; }
  let url = offer.url;
  if (!url && offer.sketchfab) {
    const key = process.env[cfg.scout.sketchfabKeyEnv || 'STUDIO_SKETCHFAB_KEY'];
    const r = await ff(`https://api.sketchfab.com/v3/models/${offer.sketchfab}/download`, { headers: { Authorization: `Token ${key}` } });
    const j = await r.json().catch(() => ({}));
    url = j.glb?.url;
    if (!url) return { ok: false, why: 'Sketchfab offers only a zipped glTF for this model; pull it by hand (npm run scout -- pull)' };
  }
  if (!url) return { ok: false, why: 'no direct download; pull it by hand from its page (npm run scout -- pull)' };
  const r = await ff(url);
  if (!r.ok) return { ok: false, why: `download failed: ${r.status}` };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return { ok: true };
}

/** The target profile on a pulled asset. Unity: normalised glTF, collider, prefab stub, licence row; heavy steps by command. */
export async function applyProfile(need, asset, cfg, trail) {
  const out = { files: [] };
  const srcAbs = path.join(REPO_ROOT, asset.file);
  let ext = path.extname(asset.file).toLowerCase();
  const name = slug(path.basename(asset.file, ext));
  const outDir = path.join(REPO_ROOT, 'assets', 'adapted', need.target === 'unity' ? 'unity' : 'web', name);
  fs.mkdirSync(outDir, { recursive: true });
  let inAbs = srcAbs;
  if (ext === '.fbx' || ext === '.obj' || ext === '.blend') {
    const conv = path.join(outDir, `${name}.source.glb`);
    const r = await runConfigured('convert', cfg.commands.convert, { in: srcAbs, out: conv });
    trail.push({ step: 'profile', what: 'convert to glTF', why: r.note });
    if (!r.ok || !fs.existsSync(conv)) { trail.push({ step: 'profile', what: 'stop', why: `${ext} needs the convert command (Blender) before the ${need.target} profile; the pulled file is kept` }); return { ...out, incomplete: true }; }
    inAbs = conv; ext = '.glb';
  }
  const { validateGltf } = await import('./art-adapt.mjs');
  const buf = fs.readFileSync(inAbs);
  const problems = validateGltf(buf, ext, path.dirname(inAbs));
  if (problems.length) { trail.push({ step: 'profile', what: 'validate', why: `not a valid glTF 2.0: ${problems.join('; ')}` }); return { ...out, incomplete: true }; }
  const { json, bin } = readGltf(buf, ext);
  const n = normaliseGltf(json, { sizeM: need.size || null });
  if (!n.ok) { trail.push({ step: 'profile', what: 'normalise', why: n.why }); return { ...out, incomplete: true }; }
  const lod0 = path.join(outDir, `${name}${ext}`);
  fs.writeFileSync(lod0, writeGltf(n.json, bin, ext));
  out.files.push(lod0);
  trail.push({ step: 'profile', what: 'normalise', why: `scale ${n.scale} to metres${need.size ? ` (largest side ${need.size} m)` : ' (no --size: glTF units kept, metres by spec)'}, pivot bottom centre; ${n.dims.join(' x ')} m, ${n.tris} tris` });
  const lods = [{ level: 0, file: posix(path.relative(REPO_ROOT, lod0)), ratio: 1 }];
  const collider = { type: 'box', center: [0, r6(n.dims[1] / 2), 0], size: n.dims };
  const credit = { asset: asset.id, licence: asset.licence, author: asset.author || null, credit: asset.credit || null, source: asset.source || null };
  const steps = ['validate-gltf', 'normalise-metres-pivot'];
  if (need.target === 'unity') {
    for (const [lvl, ratio] of [[1, (cfg.lodRatios || [1, 0.5, 0.25])[1]], [2, (cfg.lodRatios || [1, 0.5, 0.25])[2]]]) {
      const f = path.join(outDir, `${name}.lod${lvl}${ext}`);
      const r = await runConfigured('lod', cfg.commands.lod, { in: lod0, out: f, ratio, level: lvl });
      trail.push({ step: 'profile', what: `LOD${lvl}`, why: r.note });
      if (r.ok && fs.existsSync(f)) { lods.push({ level: lvl, file: posix(path.relative(REPO_ROOT, f)), ratio }); out.files.push(f); } else lods.push({ level: lvl, file: null, ratio, pending: r.note });
    }
    // HDRP mask map (R metallic, G AO, B detail mask, A smoothness): a configured command only, see docs/ART-PIPELINE.md.
    const mm = path.join(outDir, `${name}_MaskMap.png`);
    const r = await runConfigured('maskmap', cfg.commands.maskmap, { in: lod0, out: mm, dir: outDir });
    trail.push({ step: 'profile', what: 'HDRP mask map', why: r.note });
    if (r.ok && fs.existsSync(mm)) out.files.push(mm);
    const stub = { schema: 'studio-prefab-stub/1', name, need: need.id, model: lods[0].file, unit: 'm', pivot: 'bottom-centre', scale: n.scale, dims: n.dims, tris: n.tris, lods, collider, maskMap: fs.existsSync(mm) ? posix(path.relative(REPO_ROOT, mm)) : null, licence: credit,
      note: 'A stub for the Unity side: make a prefab with this model, an LODGroup from lods (pending ones need the lod command), and a BoxCollider of this size.' };
    const stubFile = path.join(outDir, `${name}.prefab.json`);
    writeJson(stubFile, stub);
    out.files.push(stubFile);
    steps.push('lod', 'collider', 'prefab-stub');
    trail.push({ step: 'profile', what: 'prefab stub', why: `box collider ${n.dims.join(' x ')} m, ${lods.filter((l) => l.file).length}/3 LODs, licence row ${asset.licence}` });
  }
  // The licence row: each output recorded in the ledger, derived from the pulled asset (credit carried), CREDITS rewritten.
  const m = readManifest();
  for (const f of out.files) {
    const rel = posix(path.relative(REPO_ROOT, f));
    const existing = m.assets.find((a) => a.file === rel);
    const id = existing?.id || `A-${String(m.assets.reduce((x, a) => Math.max(x, Number(String(a.id).slice(2)) || 0), 0) + 1).padStart(3, '0')}`;
    const e = entryFor(rel, { id, owner: asset.owner, licence: asset.licence, origin: asset.source || '', by: asset.declaredBy || actor(), author: asset.author || '', credit: asset.credit || '', madeBy: 'asset-need', kind: f.endsWith('.prefab.json') ? 'prefab-stub' : asset.kind });
    Object.assign(e, { derivedFrom: asset.id, adapted: { steps, profile: need.target, need: need.id } });
    m.assets = existing ? m.assets.map((a) => (a.file === rel ? e : a)) : [...m.assets, e];
  }
  writeManifest(m);
  const { writeCredits } = await import('./asset-scout.mjs');
  writeCredits();
  out.licence = credit;
  return out;
}

const relOut = (f) => posix(path.relative(REPO_ROOT, f));

/** The whole flow for one need. Returns { ok, need, message }. */
export async function assetNeed(opts, { fetch: f, log = () => {} } = {}) {
  const cfg = readConfig();
  const target = String(opts.for || opts.target || '').toLowerCase();
  if (!opts.what) return { ok: false, message: 'Say what you need: npm run asset -- need "<what>" --for unity|web --budget <tris>' };
  if (!['unity', 'web'].includes(target)) return { ok: false, message: '--for unity or --for web' };
  const budget = Number(opts.budget) || 0;
  const by = opts.by || actor();
  const draft = { what: String(opts.what), target, budget, size: Number(opts.size) || null, exactSize: Boolean(opts.exactSize), style: opts.style || null, tags: String(opts.tags || '').split(',').map((t) => t.trim()).filter(Boolean), kind: opts.kind || 'model' };
  const key = needKey(draft);
  const say = (m) => { log(m); return m; };

  // (b) reuse first: the same need again.
  const prev = readNeeds().find((x) => x.key === key && ['found', 'pulled', 'make'].includes(x.status));
  if (prev && prev.status !== 'make') {
    prev.trail.push({ step: 'reuse', at: now(), by, why: 'asked again: same words, target and budget' });
    writeJson(needFile(prev.id), prev);
    return { ok: true, need: prev, reused: true, message: say(`already in library: ${prev.result.id} (${prev.result.file}) — need ${prev.id}, ${prev.status} ${prev.at.slice(0, 10)}`) };
  }
  const need = prev || { id: nextId(), ...draft, key, by, at: now(), status: 'open', trail: [] };
  const trail = need.trail;
  const save = () => writeJson(needFile(need.id), need);
  if (prev) trail.push({ step: 'reuse', at: now(), by, why: `asked again; make task ${prev.make?.task || '(none)'} still open: looking in the library once more` });
  save();

  // (a) the library.
  const notes = [];
  const items = libraryItems(cfg, notes);
  for (const n of notes) trail.push({ step: 'library', why: n });
  const bySha = new Map(); const hits = []; const dupes = [];
  for (const it of items) {
    if (it.sha256 && bySha.has(it.sha256)) { dupes.push(`${it.lib}:${it.file} is the same file as ${bySha.get(it.sha256).lib}:${bySha.get(it.sha256).file}`); continue; }
    if (it.sha256) bySha.set(it.sha256, it);
    it._licence = libraryLicence(it.licence, it, cfg);
    const j = judge(need, it, cfg);
    if (j.pass) hits.push({ it, j });
    else if (j.score >= Number(cfg.bar ?? 6) || j.why.some((w) => /licen|NC|ND|share|credit|blocked/i.test(w))) trail.push({ step: 'library', candidate: `${it.lib}:${it.id}`, file: it.file, score: j.score, why: `skipped: ${j.why.join('; ')}` });
  }
  if (dupes.length) trail.push({ step: 'library', why: `duplicates by content hash (counted once): ${dupes.slice(0, 5).join('; ')}` });
  if (hits.length && cfg.scorer && need.style) {
    for (const h of hits.slice(0, 5)) {
      const r = await runConfigured('scorer', cfg.scorer, { file: h.it.abs, style: need.style, what: need.what }, { heavy: false, timeoutMs: 120000 });
      const s = r.ok ? Number((String(r.out).match(/-?\d+(\.\d+)?/) || [])[0]) : NaN;
      h.style = Number.isFinite(s) ? s : null;
      trail.push({ step: 'library', candidate: `${h.it.lib}:${h.it.id}`, why: `style score (advisory): ${h.style ?? r.note}` });
    }
  }
  hits.sort((a, b) => (b.j.score - a.j.score) || ((b.style ?? -1) - (a.style ?? -1)));
  trail.push({ step: 'library', at: now(), found: hits.length, why: `${items.length} item(s) searched in ${1 + (cfg.libraries || []).length} source(s); ${hits.length} passed the bar (${cfg.bar ?? 6})` });
  if (hits.length) {
    const { it, j } = hits[0];
    need.status = 'found';
    need.result = { lib: it.lib, id: it.id, file: it.file, abs: it.lib === 'studio' ? undefined : it.abs, licence: it.licence, score: j.score, why: j.why, ...(it._licence?.ai ? { aiMade: true } : {}) };
    if (it.lib !== 'studio') need.result.bringIn = it._licence?.cls === 'cc0' || it._licence?.cls === 'cc-by' ? `npm run scout -- pull "${it.abs}" --licence ${it.licence} --author "${it.author || ''}" --source "${it.source || `library:${it.lib}`}" --title "${it.title || it.id}"` : `a person records it: npm run asset -- add "${it.abs}" --use game --owner "…" --licence "${it.licence}" --by <person>`;
    trail.push({ step: 'done', at: now(), why: `library hit ${it.lib}:${it.id} (${it.file}), score ${j.score}: stopped before the internet` });
    save();
    emitEvent({ type: 'asset.need', agent: by, msg: `${need.id} "${need.what}": found in library ${it.lib}:${it.id}` });
    return { ok: true, need, message: say(`found in library: ${it.lib}:${it.id} ${it.file} (score ${j.score}; ${j.why.join('; ')})${need.result.bringIn ? `\n  bring it in: ${need.result.bringIn}` : ''}`) };
  }
  if (prev) {
    trail.push({ step: 'done', at: now(), why: `still nothing in the library; make task ${prev.make?.task} already filed, not filed again` });
    save();
    return { ok: true, need, message: say(`already asked: need ${need.id}, make task ${prev.make?.task || '(none)'} — not filed again`) };
  }

  // (c) the internet.
  const offers = await scoutOffers(need, cfg, trail, { fetch: f });
  const ranked = [];
  for (const o of offers) {
    const { allowedLicence } = await import('./asset-scout.mjs');
    const kind = allowedLicence(o.licence);
    o._licence = !kind ? { ok: false, why: `"${o.licence || 'no licence'}" isn't CC0 or CC-BY (scout rule)` } : kind === 'CC-BY' && !o.author ? { ok: false, why: 'CC-BY with no author' } : { ok: true };
    const j = judge(need, { ...o, kind: o.kind || (o.file || o.url ? kindOf(o.file || o.url) : need.kind) }, cfg);
    if (j.pass) ranked.push({ o, j }); else trail.push({ step: 'scout', candidate: `${o.source}:${o.id || o.title}`, score: j.score, why: `skipped: ${j.why.join('; ')}` });
  }
  ranked.sort((a, b) => b.j.score - a.j.score);
  const shas = libraryShas(cfg);
  for (const { o, j } of ranked) {
    const fname = path.basename(o.file || (o.url ? new URL(o.url).pathname : '') || `${slug(o.title)}.glb`);
    const dest = path.join(NEEDS_DIR, need.id, fname);
    const d = await download(o, dest, cfg, { fetch: f });
    if (!d.ok) { trail.push({ step: 'scout', candidate: `${o.source}:${o.id || o.title}`, score: j.score, page: o.page || null, why: `passed (${j.why.join('; ')}) but ${d.why}` }); continue; }
    const sha = sha256(dest);
    const dup = shas.get(sha);
    if (dup) {
      need.status = 'found';
      need.result = { lib: dup.lib, id: dup.id, file: dup.file, licence: dup.licence, duplicateOf: `${o.source}:${fname}` };
      trail.push({ step: 'done', at: now(), why: `${o.source} offer "${o.title}" is the same file (sha256) as ${dup.lib}:${dup.id} ${dup.file}: not pulled again` });
      save();
      return { ok: true, need, message: say(`already in library: ${dup.lib}:${dup.id} ${dup.file} (same content as the ${o.source} offer ${fname})`) };
    }
    // (d) pull + adapt.
    const { pull } = await import('./asset-scout.mjs');
    const p = await pull({ from: dest, licence: o.licence, author: o.author || '', source: o.page || o.source, title: o.title || fname, by, kind: need.kind });
    if (!p.ok) { trail.push({ step: 'pull', candidate: `${o.source}:${o.title}`, why: `pull refused: ${p.message}` }); continue; }
    trail.push({ step: 'pull', at: now(), asset: p.asset.id, file: p.asset.file, why: `${o.source} "${o.title}" (${o.licence}${o.author ? `, ${o.author}` : ''}), score ${j.score}` });
    const prof = await applyProfile(need, p.asset, cfg, trail);
    need.status = 'pulled';
    need.result = { lib: 'studio', id: p.asset.id, file: p.asset.file, licence: p.asset.licence, outputs: prof.files.map(relOut), ...(prof.incomplete ? { incomplete: true } : {}) };
    trail.push({ step: 'done', at: now(), why: `pulled ${p.asset.id} and ran the ${need.target} profile${prof.incomplete ? ' (incomplete: see the notes above)' : ''}` });
    save();
    emitEvent({ type: 'asset.need', agent: by, to: 'producer', msg: `${need.id} "${need.what}": pulled ${p.asset.id} from ${o.source} (${o.licence}), ${need.target} profile` });
    const skipped = trail.filter((t) => t.step === 'profile' && /skipped|not installed/.test(t.why)).map((t) => `  ${t.what}: ${t.why}`);
    return { ok: true, need, message: say(`pulled ${p.asset.id} ${p.asset.file} (${o.licence}) and ran the ${need.target} profile:\n${prof.files.map((x) => `  ${relOut(x)}`).join('\n')}${skipped.length ? `\n${skipped.join('\n')}` : ''}`) };
  }

  // (e) else make: one task, deduped by need id.
  need.brief = briefText(need, cfg);
  const title = `Make asset: ${need.what} (${need.target}${need.budget ? `, <= ${need.budget} tris` : ''}${need.size ? `, ${need.size} m` : ''}) [need ${need.id}; brief: npm run asset -- needs ${need.id}]`.slice(0, 200);
  let made;
  try {
    const { addTask, parseNextQueue } = await import('./task.mjs');
    const board = parseNextQueue();
    const open = [...board.inProgress, ...board.backlog].find((t) => String(t.title).includes(`[need ${need.id};`));
    made = open ? { id: open.id, duplicate: true } : addTask({ title, role: cfg.makeRole || 'asset-3d', priority: cfg.makePriority || 'P2', agent: by, meta: { need: need.id, why: `asset need ${need.id}: nothing in the library or online passed the bar` } });
  } catch (err) { made = { error: true, message: err.message }; }
  need.status = 'make';
  need.make = { task: made?.id || null, proposed: Boolean(made?.proposed), error: made?.error ? made.message : undefined };
  trail.push({ step: 'make', at: now(), why: made?.id ? `${made.proposed ? 'proposed' : 'filed'} ${made.id} for ${cfg.makeRole || 'asset-3d'}${made.duplicate ? ' (already open)' : ''}` : `could not file the make task: ${made?.message || 'unknown'}` });
  save();
  emitEvent({ type: 'asset.need', agent: by, to: 'producer', msg: `${need.id} "${need.what}": nothing passed the bar; make task ${made?.id || 'not filed'}` });
  return { ok: Boolean(made?.id), need, message: say(made?.id ? `nothing passed the bar: ${made.proposed ? 'proposed' : 'filed'} make task ${made.id} for ${cfg.makeRole || 'asset-3d'} (need ${need.id})` : `nothing passed the bar, and the make task was not filed: ${made?.message}`) };
}

export function needsText(id = null, { all = false } = {}) {
  const list = readNeeds();
  if (id) {
    const n = list.find((x) => x.id === id);
    if (!n) return `No need ${id}.`;
    return [`${n.id} "${n.what}" for ${n.target}, budget ${n.budget || '-'}${n.size ? `, ${n.size} m` : ''}: ${n.status}${n.result ? ` -> ${n.result.lib}:${n.result.id} ${n.result.file}` : ''}${n.make?.task ? ` (make task ${n.make.task})` : ''}`,
      ...n.trail.map((t) => `  [${t.step}] ${t.candidate ? `${t.candidate} ` : ''}${t.what ? `${t.what}: ` : ''}${t.why}`), ...(n.brief ? ['', n.brief] : [])].join('\n');
  }
  const shown = list.filter((n) => all || ['open', 'make'].includes(n.status));
  return shown.length ? shown.map((n) => `${n.id} ${n.status.padEnd(6)} "${n.what}" (${n.target}, ${n.budget || '-'} tris)${n.make?.task ? ` make task ${n.make.task}` : ''}${n.result ? ` -> ${n.result.id}` : ''}`).join('\n') : `No ${all ? '' : 'open '}asset needs.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const pos = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; } else pos.push(argv[i]); }
  const [cmd, a1, a2] = pos;
  const fail = (m) => { console.error(m); process.exit(1); };
  if (cmd === 'need') {
    const r = await assetNeed({ what: a1, for: flag('for'), budget: flag('budget'), size: flag('size'), exactSize: argv.includes('--exact-size'), style: flag('style'), tags: flag('tags'), kind: flag('kind'), by: flag('by') }, { log: (x) => console.log(x) });
    if (!r.ok) fail(r.message);
    if (r.need) console.log(`(need ${r.need.id}: npm run asset -- needs ${r.need.id} shows the trail)`);
  } else if (cmd === 'needs') console.log(needsText(a1 || null, { all: argv.includes('--all') }));
  else if (cmd === 'library' && a1 === 'refresh') {
    const r = refreshLibrary(a2, { log: (x) => console.log(x) });
    if (!r.ok) fail(r.message);
  } else fail('npm run asset -- need "<what>" --for unity|web --budget <tris> [--size <m>] [--style <ref>] [--tags a,b] | needs [<id>] [--all] | library refresh <dir>');
}
