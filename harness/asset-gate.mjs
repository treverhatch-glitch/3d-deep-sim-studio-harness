#!/usr/bin/env node
/**
 * harness/asset-gate.mjs — 2.67.1 (j): the asset track's gate, and its hand-off to the engine track.
 *
 * An asset task (task add --track asset, or any task whose change adds or changes files under the game's declared
 * asset paths) is checked at `task done` before it lands. Every limit comes from the game's manifest, studio/game.json
 * (protected: only the owner changes it, so a branch can't loosen its own limits), with these defaults:
 *
 *   "assets": {
 *     "paths": ["assets", "public/assets"],          where asset files live (declaring it turns the gate on for
 *                                                     every task that touches them; without it only --track asset)
 *     "manifest": "studio/assets/manifest.json",     the rows (npm run asset -- add writes them): file, licence, credit
 *     "triangleBudget": { "lod0": 2500, "lod1": 1200, "lod2": 500 },   or one number, or [n0, n1, n2]
 *     "textureMaxPx": 2048,                          the longest side of any texture (PNG/JPEG, loose or in a .glb)
 *     "previewRequired": true,                       a model needs <name>.preview.png (or _preview / .jpg / .webp)
 *     "sizeTolerance": 0.15, "sizeRequired": false,  scale: the bounding box against the stated size
 *     "brandNames": [],                              no brand marks in file names, glTF names or the row
 *     "licences": { "allow": [...], "ask": [...], "block": [...] },   replace the defaults list by list
 *     "roundTrip": { "command": "blender -b --factory-startup -P tools/x.py -- {file}", "timeoutMin": 20 }
 *   }
 *
 * The checks (each failure names the file, a Fix line from harness/gate-fix.mjs ASSET_FIXES, and is kept for the
 * task's next hand-back facts):
 *   licence     a row for every new asset file; the licence on the allow list; CC-BY (or a row saying a credit is
 *               required) needs its credit line; NC / ND blocked; SA (copyleft) needs a game dev's yes (tier C:
 *               `node harness/asset-gate.mjs allow <file> --by <person> --permission "<their words>"`, which a worker
 *               can't record); an AI-made row needs its recorded terms and is listed for the Steam AI disclosure.
 *   triangles   per LOD (mesh or node name ending _LOD<n>, else LOD 0), from the glTF JSON: indices count / 3
 *               (POSITION count when unindexed); within triangleBudget.
 *   texture     PNG/JPEG headers (loose files, and images embedded in a .glb or a data: URI): longest side within
 *               textureMaxPx.
 *   preview     a preview render next to each model when previewRequired.
 *   preview-*   2.70.0 (v): the preview checks (harness/asset-review.mjs): blank, black, white, magenta, clipped, small;
 *               an up-axis warning. When every check passes, `review` in the result lists each model with its
 *               previews' numbers and checksums: task done asks a session that can view images for a look and lands
 *               the asset only once it is answered (npm run asset -- review <asset> --pass|--fail "why" --by <name>).
 *   roundtrip   the configured export/re-import command (a Blender script; a Unity batchmode run if the studio puts
 *               one in it) runs under machine:heavy (2.70.0: a Blender command in the GPU area when the scan shows a GPU,
 *               one harness Blender job at a time, with -t <n> threads: harness/blender-job.mjs) and must exit 0. No command, or its program isn't installed: skipped
 *               with a note. {file} runs it once per model, else once with {files}.
 *   scale       (owner, 11:30) the model's bounding box in metres (LOD 0 meshes' POSITION min/max through their nodes'
 *               world transforms) within the expected size ("size": { "w", "d", "h" } in its manifest row, else in
 *               <name>.asset.json next to it) ± sizeTolerance (default 15%; a row or sidecar may set its own). No size
 *               recorded: a note, or a failure when "sizeRequired" is true. glTF is Y-up: w = x, h = y, d = z. A game's
 *               own engine-side model check (an import that measures the prefab) can run as the roundTrip command.
 *   brand       no configured brand name (case-insensitive, punctuation ignored) in the file name, glTF node, mesh,
 *               material, texture or image names, or the manifest row.
 *   name        a file name with characters a command line could misread (anything but letters, digits, . _ - and
 *               spaces) is refused before any command runs.
 *
 *   node harness/asset-gate.mjs [--task T-012] [--files a.glb,b.png] [--no-round-trip] [--json]
 *        exit 0 pass or skipped, 1 a check failed, 3 the heavy lock stayed busy (try again later)
 *   node harness/asset-gate.mjs allow <file> --by <person> --permission "<their words or a link>"
 *        record a game dev's yes for a share-alike (SA) licence on that file (its current checksum)
 *
 * The asset ("make") task's brief template is studio/templates/asset-brief.md (ASSET_BRIEF_TEMPLATE).
 *
 * When an asset task lands (task done, or the merge train), the harness files one engine-track task
 * ("Wire in <asset>", --track engine:unity for an engine-porter when the studio has the Unity engine configured, else a
 * builder task), --after the asset task, naming the files. Never twice for the same asset task (an asset.handoff event).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { agentOnPermission } from './permission.mjs';

export const MODEL_EXT = ['.glb', '.gltf', '.fbx', '.obj', '.blend', '.dae', '.usd', '.usdz'];
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.tga', '.ktx2', '.exr', '.hdr'];
const ASSET_EXT = [...MODEL_EXT, ...IMAGE_EXT, '.bin'];
// 2.70.0 (v): one view per file too (<name>.preview-front.png, -34, -top: harness/asset-review.mjs VIEWS).
const PREVIEW_RE = /[._-]preview(?:-(?:front|34|top))?\.(png|jpe?g|webp)$/i;

export const ASSET_DEFAULTS = {
  paths: ['assets', 'public/assets'],
  manifest: 'studio/assets/manifest.json',
  triangleBudget: { lod0: 2500, lod1: 1200, lod2: 500 },
  textureMaxPx: 2048,
  previewRequired: true,
  brandNames: [],
  licences: {
    // The owner's rule (2026-11-02): commercial-use licences ship; CC-BY ships with its credit; NC/ND never; SA asks.
    allow: ['own work', 'own', 'CC0', 'public domain', 'MIT', 'Apache', 'BSD', 'Zlib', 'Unlicense', 'OFL', 'CC-BY', 'royalty-free', 'commercial', 'generated'],
    ask: ['SA', 'share-alike', 'GPL', 'LGPL', 'AGPL', 'copyleft'],
    block: ['NC', 'ND', 'non-commercial', 'noncommercial', 'no-derivatives', 'noderivatives', 'editorial'],
  },
  roundTrip: null,
  sizeTolerance: 0.15,
  sizeRequired: false,
};

/** 2.67.1 (j): where the asset ("make") task's brief template lives (a stable path other tools copy it from). */
export const ASSET_BRIEF_TEMPLATE = 'studio/templates/asset-brief.md';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const slash = (p) => String(p).split(path.sep).join('/').replace(/^\.\//, '');

/** The game's asset settings (studio/game.json "assets") merged over the defaults; declared = the block exists. */
export function assetConfig(root = REPO_ROOT) {
  const a = readJson(path.join(root, 'studio', 'game.json'))?.assets;
  const own = a && typeof a === 'object' && !Array.isArray(a) ? a : null;
  const lic = own?.licences && typeof own.licences === 'object' ? own.licences : {};
  const list = (v, d) => (Array.isArray(v) ? v.map(String) : d);
  return {
    declared: Boolean(own),
    paths: list(own?.paths, ASSET_DEFAULTS.paths).map((p) => slash(p).replace(/\/+$/, '')).filter(Boolean),
    manifest: typeof own?.manifest === 'string' && own.manifest.trim() ? own.manifest.trim() : ASSET_DEFAULTS.manifest,
    triangleBudget: own?.triangleBudget ?? ASSET_DEFAULTS.triangleBudget,
    textureMaxPx: Number(own?.textureMaxPx) > 0 ? Number(own.textureMaxPx) : ASSET_DEFAULTS.textureMaxPx,
    previewRequired: own?.previewRequired === undefined ? ASSET_DEFAULTS.previewRequired : Boolean(own.previewRequired),
    brandNames: list(own?.brandNames, ASSET_DEFAULTS.brandNames).filter((b) => b.trim()),
    licences: { allow: list(lic.allow, ASSET_DEFAULTS.licences.allow), ask: list(lic.ask, ASSET_DEFAULTS.licences.ask), block: list(lic.block, ASSET_DEFAULTS.licences.block) },
    sizeTolerance: Number(own?.sizeTolerance) >= 0 && own?.sizeTolerance !== null && own?.sizeTolerance !== undefined ? Number(own.sizeTolerance) : ASSET_DEFAULTS.sizeTolerance,
    sizeRequired: Boolean(own?.sizeRequired),
    roundTrip: own?.roundTrip && typeof own.roundTrip === 'object' && typeof own.roundTrip.command === 'string' && own.roundTrip.command.trim() ? own.roundTrip : null,
  };
}

/** The budget for LOD n: a number (every LOD), an array (by index, the last one after), or { lod0, lod1 … }. */
export function lodBudget(budget, n) {
  if (typeof budget === 'number') return budget;
  if (Array.isArray(budget)) return budget.length ? Number(budget[Math.min(n, budget.length - 1)]) : Infinity;
  if (budget && typeof budget === 'object') {
    for (let i = n; i >= 0; i--) {
      const v = budget[`lod${i}`] ?? budget[`LOD${i}`] ?? budget[String(i)];
      if (v !== undefined) return Number(v);
    }
  }
  return Infinity;
}

export const isAssetFile = (rel) => ASSET_EXT.includes(path.extname(rel).toLowerCase());
export const isModel = (rel) => MODEL_EXT.includes(path.extname(rel).toLowerCase());
export const isPreview = (rel) => PREVIEW_RE.test(rel);
export const underPaths = (rel, paths) => paths.some((p) => rel === p || rel.startsWith(`${p}/`));

// ---------- images ----------

/** { format, w, h } from a PNG or JPEG's first bytes, or null (another format, or not an image). */
export function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf.toString('latin1', 12, 16) === 'IHDR') return { format: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { format: 'jpeg', w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  return null;
}

// ---------- glTF ----------

/** The JSON and binary chunk of a .glb, or the JSON of a .gltf. Throws on a malformed file. */
export function readGltf(buf, ext) {
  if (ext === '.gltf') return { json: JSON.parse(buf.toString('utf8')), bin: null };
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('not a binary glTF (no glTF magic)');
  let off = 12;
  let json = null;
  let bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8').replace(/[\0 ]+$/, ''));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('no JSON chunk');
  return { json, bin };
}

// 2.67.1 (j, owner 11:30): scale within spec. 4x4 column-major matrices, as glTF stores them.
const mul = (a, b) => { const o = Array.from({ length: 16 }, () => 0); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function nodeMatrix(n) {
  if (Array.isArray(n.matrix) && n.matrix.length === 16) return n.matrix.map(Number);
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
    (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
    (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * The model's bounding box in metres (glTF units), LOD 0 meshes only: each mesh's POSITION accessor min/max corners
 * through its node's world transform (parents' translation, rotation and scale applied). { min, max, size: [x, y, z] }
 * or null (no POSITION min/max). glTF is Y-up: x = width, y = height, z = depth.
 */
export function gltfBounds(json) {
  const nodes = json.nodes || [];
  const acc = json.accessors || [];
  const parent = new Map();
  nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const world = (i, seen = new Set()) => { if (seen.has(i)) return IDENT; seen.add(i); const p = parent.get(i); return p === undefined ? nodeMatrix(nodes[i]) : mul(world(p, seen), nodeMatrix(nodes[i])); };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  nodes.forEach((n, i) => {
    if (n.mesh === undefined) return;
    const mesh = json.meshes?.[n.mesh];
    if ((lodOf(mesh?.name) ?? lodOf(n.name) ?? 0) !== 0) return;
    const m = world(i);
    for (const p of mesh?.primitives || []) {
      const a = acc[p.attributes?.POSITION];
      if (!Array.isArray(a?.min) || !Array.isArray(a?.max)) continue;
      for (let k = 0; k < 8; k++) {
        const v = [k & 1 ? a.max[0] : a.min[0], k & 2 ? a.max[1] : a.min[1], k & 4 ? a.max[2] : a.min[2]];
        for (let r = 0; r < 3; r++) { const t = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]; lo[r] = Math.min(lo[r], t); hi[r] = Math.max(hi[r], t); }
      }
    }
  });
  if (!Number.isFinite(lo[0])) return null;
  return { min: lo, max: hi, size: hi.map((h, r) => Math.round((h - lo[r]) * 1e4) / 1e4) };
}

/** The expected size { w, d, h } (metres) from a row's or sidecar's "size": { w, d, h } or [w, d, h]; null when none. */
export function expectedSize(spec) {
  const s = spec?.size ?? spec?.sizeM;
  const arr = Array.isArray(s) ? s : s && typeof s === 'object' ? [s.w ?? s.width, s.d ?? s.depth, s.h ?? s.height] : null;
  if (!arr || arr.length < 3 || arr.some((x) => !(Number(x) > 0))) return null;
  return { w: Number(arr[0]), d: Number(arr[1]), h: Number(arr[2]) };
}

const lodOf = (name) => { const m = String(name || '').match(/[_.\s-]lod[_-]?(\d+)$/i); return m ? Number(m[1]) : null; };

/**
 * What a glTF holds: { lods: { <n>: triangles }, meshes: [{ name, lod, triangles }], names: [...], images: [{ name, w, h }] }.
 * Triangles per primitive: indices count / 3, else POSITION count / 3 (mode 4); strips and fans count - 2; points and
 * lines none. Each mesh counts once (instances are the renderer's business). A mesh's LOD is its own name's _LOD<n>,
 * else the name of the first node that uses it, else 0.
 */
export function gltfInfo(buf, ext, { readUri = null } = {}) {
  const { json, bin } = readGltf(buf, ext);
  const acc = json.accessors || [];
  const nodes = json.nodes || [];
  const meshes = (json.meshes || []).map((m, i) => {
    let tris = 0;
    for (const p of m.primitives || []) {
      const mode = p.mode ?? 4;
      const count = p.indices !== undefined ? Number(acc[p.indices]?.count || 0) : Number(acc[p.attributes?.POSITION]?.count || 0);
      if (mode === 4) tris += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) tris += Math.max(0, count - 2);
    }
    const node = nodes.find((n) => n.mesh === i);
    const lod = lodOf(m.name) ?? lodOf(node?.name) ?? 0;
    return { name: m.name || node?.name || `mesh ${i}`, lod, triangles: tris };
  });
  const lods = {};
  for (const m of meshes) lods[m.lod] = (lods[m.lod] || 0) + m.triangles;
  const bbox = gltfBounds(json);
  const names = [...nodes, ...(json.meshes || []), ...(json.materials || []), ...(json.textures || []), ...(json.images || []), ...(json.scenes || [])].map((x) => x?.name).filter((n) => typeof n === 'string' && n);
  for (const im of json.images || []) if (typeof im.uri === 'string' && !im.uri.startsWith('data:')) names.push(path.basename(im.uri));
  const images = [];
  for (const [i, im] of (json.images || []).entries()) {
    let bytes = null;
    if (im.bufferView !== undefined && bin) {
      const bv = json.bufferViews?.[im.bufferView];
      if (bv) bytes = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
    } else if (typeof im.uri === 'string' && im.uri.startsWith('data:')) {
      bytes = Buffer.from(im.uri.slice(im.uri.indexOf(',') + 1), 'base64');
    } else if (typeof im.uri === 'string' && readUri) bytes = readUri(im.uri);
    const s = bytes ? imageSize(bytes) : null;
    if (s) images.push({ name: im.name || (typeof im.uri === 'string' && !im.uri.startsWith('data:') ? path.basename(im.uri) : `image ${i}`), w: s.w, h: s.h });
  }
  return { lods, meshes, names, images, bbox };
}

// ---------- licences ----------

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const hasSeq = (hay, needle) => needle.length > 0 && hay.some((_, i) => needle.every((t, j) => hay[i + j] === t));

/** 'block' | 'ask' | 'allow' | 'unknown' for a licence, by whole words (block first, then ask, then allow). */
export function classifyLicence(licence, lists = ASSET_DEFAULTS.licences) {
  const t = tokens(licence);
  if (!t.length) return 'unknown';
  for (const kind of ['block', 'ask', 'allow']) if ((lists[kind] || []).some((e) => hasSeq(t, tokens(e)))) return kind;
  return 'unknown';
}
export const isCcBy = (licence) => hasSeq(tokens(licence), ['cc', 'by']);

/** The manifest's rows ({ assets: [...] } or a plain list), by file path. */
export function manifestRows(root, cfg) {
  const m = readJson(path.join(root, cfg.manifest));
  const rows = Array.isArray(m) ? m : Array.isArray(m?.assets) ? m.assets : [];
  const by = new Map();
  for (const r of rows) if (r && typeof r.file === 'string') by.set(slash(r.file), r);
  return by;
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A game dev's recorded yes for a share-alike licence on this file at this checksum (asset.licence_yes). */
export function licenceYes(rel, hash) {
  return readRecentEvents(20000).filter((e) => e.type === 'asset.licence_yes' && e.meta?.file === rel && e.meta?.sha256 === hash).pop() || null;
}

/** Record a game dev's yes for an SA licence: a person, or a Producer/Director/outside agent on a person's permission. */
export function allowLicence(rel, { by = '', permission = '', root = REPO_ROOT, env = process.env } = {}) {
  const file = slash(rel);
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return { ok: false, why: `${file} doesn't exist` };
  if (!String(by).trim()) return { ok: false, why: 'say whose yes it is: --by <person>' };
  const p = agentOnPermission({ permission, env });
  if (!p.ok) return { ok: false, why: p.why };
  const hash = sha(abs);
  emitEvent({ type: 'asset.licence_yes', agent: p.recordedBy, to: 'producer', msg: `${by} said yes to shipping ${file} under its share-alike licence (recorded by ${p.recordedBy}: "${String(permission).trim().slice(0, 200)}")`.slice(0, 500), meta: { file, sha256: hash, by: String(by).trim(), recordedBy: p.recordedBy, via: p.via, permission: String(permission).trim().slice(0, 500), tier: 'C' } });
  return { ok: true, why: `${file}: ${by}'s yes recorded (tier C, ${p.via})` };
}

// ---------- which files ----------

/**
 * The asset files a task's change adds or changes: `files` when given, else the lane's diff / STUDIO_GATE_CHANGED,
 * else git (added, changed or renamed since the task's base commit, plus untracked files), under the asset paths.
 */
export function changedAssetFiles(root, cfg, { files = null, base = null } = {}) {
  let list = files;
  if (!list) {
    const env = String(process.env.STUDIO_GATE_CHANGED || '').split(',').filter(Boolean);
    if (env.length) list = env;
  }
  if (!list && base) {
    const d = spawnSync('git', ['diff', '--name-only', '--diff-filter=AMR', `${base}`, 'HEAD', '--', ...cfg.paths], { windowsHide: true, cwd: root, encoding: 'utf8' });
    const u = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...cfg.paths], { windowsHide: true, cwd: root, encoding: 'utf8' });
    list = [...(d.status === 0 ? d.stdout.split('\n') : []), ...(u.status === 0 ? u.stdout.split('\n') : [])];
  }
  return [...new Set((list || []).map((f) => slash(String(f).trim())).filter(Boolean))].filter((f) => isAssetFile(f) && underPaths(f, cfg.paths) && fs.existsSync(path.join(root, f)));
}

// ---------- the round trip ----------

/** Is the command's program on PATH (or an existing path)? Cross-platform (PATHEXT on Windows). */
export function programInstalled(cmd, env = process.env) {
  const m = String(cmd).trim().match(/^"([^"]+)"|^(\S+)/);
  const prog = m ? m[1] || m[2] : '';
  if (!prog) return { ok: false, prog };
  if (/[\\/]/.test(prog)) return { ok: fs.existsSync(prog), prog };
  const exts = process.platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) { try { if (fs.statSync(path.join(dir, prog + e)).isFile()) return { ok: true, prog }; } catch { /* not here */ } }
  }
  return { ok: false, prog };
}

const PLAIN_NAME = /^[A-Za-z0-9._/ -]+$/;

export async function runRoundTrip(root, cfg, models, { env, log }) {
  const rt = cfg.roundTrip;
  if (!rt) return { skipped: true, note: 'no round-trip command is configured (studio/game.json "assets": { "roundTrip": { "command": "blender -b --factory-startup -P <script> -- {file}" } }): export/re-import not checked' };
  if (!models.length) return { skipped: true, note: 'no model file in the change: the round trip has nothing to run' };
  const inst = programInstalled(rt.command, env);
  if (!inst.ok) return { skipped: true, note: `the round-trip program "${inst.prog}" isn't installed here: export/re-import not checked (it runs on a machine that has it)` };
  const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : s);
  const cmds = rt.command.includes('{file}') ? models.map((f) => ({ f, cmd: rt.command.replaceAll('{file}', q(f)).replaceAll('{files}', q(f)) })) : [{ f: models.join(', '), cmd: rt.command.replaceAll('{files}', models.map(q).join(' ')) }];
  const timeoutMin = Number(rt.timeoutMin || 20);
  const { acquireHeavy, heavyRoot } = await import('./heavy.mjs');
  // 2.70.0 (t): the claim follows the program (Blender: the GPU area when the scan shows a GPU; Unity: the Unity cap),
  // and a Blender command gets -t <n> render threads (harness/blender-job.mjs).
  const hroot = await heavyRoot();
  const bj = await import('./blender-job.mjs');
  const kind = bj.blenderKind(rt.command, 'asset-roundtrip');
  if (bj.isBlenderCommand(rt.command)) {
    let profile = null;
    try { profile = (await import('./heavy-budget.mjs')).machineProfile(hroot, { env }); } catch {}
    const th = bj.blenderThreads({ env, profile });
    for (const c of cmds) c.cmd = bj.withBlenderThreads(c.cmd, th.n);
    log(`[asset-gate] Blender render threads: ${th.n} (${th.why}) unless the command sets its own -t`);
  }
  let lk;
  try {
    lk = acquireHeavy(hroot, 'asset round trip', { log, env, kind });
  } catch (err) {
    if (err.code !== 'HEAVY_BUSY') throw err;
    return { busy: true, why: `the machine:heavy lock stayed busy: ${err.message.replace(/^\[heavy\]\s*/, '')}` };
  }
  const failures = [];
  try {
    for (const { f, cmd } of cmds) {
      log(`[asset-gate] round trip: ${cmd}`);
      const once = () => spawnSync(cmd, { cwd: root, shell: true, encoding: 'utf8', env: { ...env, STUDIO_HEAVY_HELD: '1' }, timeout: timeoutMin * 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
      let r = once();
      // 2.68.0 (n): killed for memory (heavy-budget.mjs oomSignature): run once more, with a note.
      const oom = /^(off|0|false|no)$/i.test(String(env.STUDIO_HEAVY_OOM_RETRY || '')) ? '' : (await import('./heavy-budget.mjs')).oomSignature(r);
      if (oom) { log(`[asset-gate] round trip died out of memory (${oom}): running it once more`); r = once(); }
      const tail = `${r.stdout || ''}${r.stderr || ''}`.trimEnd().split('\n').slice(-8).join('\n');
      if (r.error?.code === 'ETIMEDOUT') failures.push({ file: f, why: `the round-trip command timed out after ${timeoutMin} min`, tail });
      else if (r.status !== 0) failures.push({ file: f, why: `the round-trip command exited ${r.status ?? r.signal}`, tail });
    }
  } finally {
    lk.release();
  }
  return { failures, ran: cmds.length };
}

// ---------- the gate ----------

const normBrand = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Run the asset checks. { status: pass|fail|busy|skipped, ok, files, failures: [{ check, file, why, fix }], notes,
 * steamDisclosure: [files] }. roundTrip false: every check but the round trip (task done --check).
 */
export async function runAssetGate({ root = REPO_ROOT, files = null, task = null, base = null, roundTrip = true, env = process.env, log = () => {} } = {}) {
  const cfg = assetConfig(root);
  const { assetFix } = await import('./gate-fix.mjs');
  const all = changedAssetFiles(root, cfg, { files, base });
  const notes = [];
  const failures = [];
  const steam = [];
  const fail = (check, file, why) => failures.push({ check, file, why, fix: assetFix(check, file) });
  const review = { required: false, items: [] }; // 2.70.0 (v)
  if (!all.length) return { status: 'skipped', ok: true, files: [], failures, notes: [`no asset file under ${cfg.paths.join(', ')} in the change`], task };
  const rows = manifestRows(root, cfg);
  const brands = cfg.brandNames.map((b) => ({ b, n: normBrand(b) })).filter((x) => x.n.length >= 2);
  const brandIn = (text) => { const n = normBrand(text); return brands.find((x) => n.includes(x.n))?.b || null; };
  for (const rel of all) {
    const abs = path.join(root, rel);
    const ext = path.extname(rel).toLowerCase();
    if (!PLAIN_NAME.test(rel)) { fail('name', rel, 'the file name has characters a command line could misread (only letters, digits, . _ - and spaces)'); continue; }
    const fb = brandIn(path.basename(rel));
    if (fb) fail('brand', rel, `the file name contains the brand name "${fb}"`);
    // licence rows (a preview render is the studio's own picture of the asset, not a shipped asset of its own)
    if (!isPreview(rel) && ext !== '.bin') {
      const row = rows.get(rel);
      if (!row) fail('licence', rel, `no row in ${cfg.manifest}`);
      else {
        const lic = String(row.licence || row.license || '').trim();
        const kind = /^generated\b/i.test(lic) || row.generated ? (cfg.licences.block.some((e) => hasSeq(tokens(lic), tokens(e))) ? 'block' : 'generated') : classifyLicence(lic, cfg.licences);
        if (kind === 'generated') {
          if (!row.generated?.terms) fail('licence', rel, 'an AI-made asset with no recorded terms (the plan or terms it was made under)');
          steam.push(rel);
        } else if (kind === 'block') fail('licence', rel, `licence "${lic}" is blocked (non-commercial or no-derivatives terms never ship)`);
        else if (kind === 'ask') {
          if (!licenceYes(rel, sha(abs))) fail('licence-ask', rel, `licence "${lic}" is share-alike/copyleft: it ships only with a game dev's yes (tier C), none is recorded for this file's current checksum`);
          else notes.push(`${rel}: share-alike licence shipped on a recorded yes`);
        } else if (kind === 'unknown') fail('licence', rel, lic ? `licence "${lic}" is not on the allow list (studio/game.json assets.licences)` : 'the row has no licence');
        if (kind !== 'block' && (isCcBy(lic) || row.creditRequired) && !String(row.credit || '').trim()) fail('credit', rel, `licence "${lic}" needs a credit line and the row has none`);
        const rb = brandIn(JSON.stringify(row));
        if (rb) fail('brand', rel, `its manifest row contains the brand name "${rb}"`);
      }
    }
    // textures
    if (IMAGE_EXT.includes(ext)) {
      const s = imageSize(fs.readFileSync(abs));
      if (s && Math.max(s.w, s.h) > cfg.textureMaxPx) fail('texture', rel, `${s.w}x${s.h} is over the texture budget (${cfg.textureMaxPx} px on the longest side)`);
    }
    // models
    if (ext === '.glb' || ext === '.gltf') {
      let info = null;
      try {
        info = gltfInfo(fs.readFileSync(abs), ext, { readUri: (u) => { try { return fs.readFileSync(path.join(path.dirname(abs), decodeURIComponent(u))); } catch { return null; } } });
      } catch (err) {
        fail('triangles', rel, `the glTF can't be read: ${err.message}`);
      }
      if (info) {
        for (const [lod, tris] of Object.entries(info.lods)) {
          const b = lodBudget(cfg.triangleBudget, Number(lod));
          if (tris > b) fail('triangles', rel, `LOD ${lod} has ${tris} triangles, over its budget of ${b}`);
        }
        for (const im of info.images) if (Math.max(im.w, im.h) > cfg.textureMaxPx) fail('texture', rel, `embedded texture ${im.name} is ${im.w}x${im.h}, over the texture budget (${cfg.textureMaxPx} px)`);
        for (const n of info.names) { const b = brandIn(n); if (b) { fail('brand', rel, `the glTF name "${n}" contains the brand name "${b}"`); break; } }
        // 2.67.1 (j, owner 11:30): scale within the stated size (row "size", else <name>.asset.json), ± the tolerance.
        const side = readJson(path.join(root, `${rel.slice(0, -ext.length)}.asset.json`));
        const row = rows.get(rel);
        const want = expectedSize(row) || expectedSize(side);
        const tol = Number(row?.sizeTolerance ?? side?.sizeTolerance ?? cfg.sizeTolerance);
        if (!want) {
          if (cfg.sizeRequired) fail('scale', rel, 'no expected size: its manifest row or <name>.asset.json has no "size": { "w", "d", "h" } in metres');
          else notes.push(`${rel}: no expected size recorded ("size": { "w", "d", "h" } in its row or ${path.basename(rel.slice(0, -ext.length))}.asset.json): scale not checked`);
        } else if (!info.bbox) fail('scale', rel, 'its bounding box can\'t be read (no POSITION min/max in the glTF)');
        else {
          const [x, y, z] = info.bbox.size;
          const off = [['width (x)', x, want.w], ['height (y)', y, want.h], ['depth (z)', z, want.d]].filter(([, got, exp]) => Math.abs(got - exp) > exp * tol + 1e-6);
          if (off.length) fail('scale', rel, `its size is ${x} x ${z} x ${y} m (w x d x h), expected ${want.w} x ${want.d} x ${want.h} m ± ${Math.round(tol * 100)}%: ${off.map(([n, got, exp]) => `${n} ${got} m vs ${exp} m`).join(', ')}`);
        }
      }
    }
    if (isModel(rel) && cfg.previewRequired) {
      const stem = rel.slice(0, -ext.length);
      const found = ['.preview', '_preview', '-preview', '.preview-front', '.preview-34', '.preview-top'].flatMap((s) => ['.png', '.jpg', '.jpeg', '.webp'].map((e) => `${stem}${s}${e}`)).some((p) => fs.existsSync(path.join(root, p)));
      if (!found) fail('preview', rel, `no preview render next to it (${path.basename(stem)}.preview.png, or one per view: .preview-front.png, .preview-34.png, .preview-top.png)`);
    }
    if (isModel(rel)) await previewReview(rel, ext);
  }
  for (const f of steam) notes.push(`${f}: AI-made, list it in the Steam AI disclosure (pre-generated content)`);
  const models = all.filter((f) => isModel(f) && PLAIN_NAME.test(f));
  if (roundTrip) {
    const rt = await runRoundTrip(root, cfg, models, { env, log });
    if (rt.busy) return finish({ status: 'busy', ok: false, why: rt.why });
    if (rt.skipped) notes.push(`round trip skipped: ${rt.note}`);
    for (const f of rt.failures || []) fail('roundtrip', f.file, `${f.why}${f.tail ? `\n${f.tail.split('\n').map((l) => `    ${l}`).join('\n')}` : ''}`);
  } else notes.push('round trip not run (task done --check); task done runs it');
  return finish({ status: failures.length ? 'fail' : 'pass', ok: !failures.length });

  /** 2.70.0 (v): the preview checks for one model, and (when they pass) its entry for the review a person or agent answers. */
  async function previewReview(rel, ext) {
    const ar = await import('./asset-review.mjs');
    const rcfg = ar.reviewConfig(root);
    review.required = rcfg.review;
    const pv = ar.checkPreviews(root, rel, rcfg);
    for (const f of pv.failures) fail(f.check, f.file, f.why);
    notes.push(...pv.notes, ...pv.warnings.map((w) => `WARNING ${w}`));
    if (pv.failures.length || !pv.previews.length) return;
    const row = rows.get(rel) || null;
    let info = null;
    if (ext === '.glb' || ext === '.gltf') { try { info = gltfInfo(fs.readFileSync(path.join(root, rel)), ext); } catch { /* the triangles check reported it */ } }
    const side = readJson(path.join(root, `${rel.slice(0, -ext.length)}.asset.json`));
    const added = task ? readRecentEvents(20000).filter((e) => e.type === 'task.added' && e.task === task).pop() : null;
    const title = String(added?.msg || '').replace(/^Queued [A-Z]+-\d+ \[\w+\] \([\w-]+\): /, '');
    const hashes = { [rel]: sha(path.join(root, rel)) };
    for (const p of pv.previews) hashes[p.file] = p.sha256;
    const asset = ar.assetSlug(rel, cfg.paths);
    review.items.push({ asset, state: ar.reviewState(root, asset, hashes), model: rel, previews: pv.previews, warnings: pv.warnings, notes: pv.notes, hashes, row, facts: ar.briefFacts(root, { model: rel, row, side, info, task, title }) });
  }

  function finish(res) {
    review.pending = review.required ? review.items.filter((it) => it.state !== 'passed').map((it) => it.asset) : [];
    const full = { ...res, files: all, failures, notes, steamDisclosure: steam, review, ...(task ? { task } : {}), at: new Date().toISOString() };
    try { fs.mkdirSync(path.join(root, '.studio', 'gates'), { recursive: true }); fs.writeFileSync(path.join(root, '.studio', 'gates', 'asset-last.json'), JSON.stringify(full, null, 2)); } catch { /* evidence only */ }
    return full;
  }
}

/** The text people (and the hand-back facts) read: one FAIL line per failure, each with its Fix. */
export function assetGateText(res) {
  const lines = [];
  for (const f of res.failures || []) lines.push(`[asset-gate] FAIL ${f.check} ${f.file}: ${f.why}`, `[asset-gate] Fix: ${f.fix}`);
  for (const n of res.notes || []) lines.push(`[asset-gate] note: ${n}`);
  if (res.status === 'busy') lines.push(`[asset-gate] BUSY: ${res.why}`);
  if (res.status === 'pass') lines.push(`[asset-gate] PASS ${res.files.length} asset file(s)`);
  // 2.70.0 (v): the checks pass; a look is still due before it lands.
  if (res.status === 'pass' && res.review?.required) {
    for (const it of res.review.items || []) {
      if (it.state === 'passed') lines.push(`[asset-gate] review ${it.asset}: passed (its current files)`);
      else if (it.state === 'failed') lines.push(`[asset-gate] REVIEW ${it.asset}: failed, and the files haven't changed since: fix what the reviewer said`);
      else lines.push(`[asset-gate] REVIEW ${it.asset}: the checks pass; it lands after a look by a session that can view images (task done files the request: npm run asset -- review ${it.asset} --pass|--fail "why" --by <name>)`);
    }
  }
  if (res.status === 'skipped') lines.push('[asset-gate] SKIP no asset file in the change');
  return lines.join('\n');
}

/** Is this task on the asset track, or does the game declare asset paths (so any task touching them is checked)? */
export function assetGateApplies(track, root = REPO_ROOT) {
  return track === 'asset' || assetConfig(root).declared;
}

// ---------- the hand-off ----------

/** Does the studio have the Unity engine configured (studio/game.json engines.unity, or a Unity engine track)? */
export function unityConfigured(root = REPO_ROOT) {
  const u = readJson(path.join(root, 'studio', 'game.json'))?.engines?.unity;
  if (u && typeof u === 'object') return true;
  try {
    for (const d of fs.readdirSync(path.join(root, 'engine'))) if (readJson(path.join(root, 'engine', d, 'engine.json'))?.engine === 'unity') return true;
  } catch { /* no engine folder */ }
  return false;
}

/**
 * File the one engine-track task for a landed asset task: "Wire in <asset>", --after it, naming the files. `addTask`
 * is task.mjs's (injected: no import cycle). Returns { id } | { already } | { refused } | null (nothing to wire).
 */
export function fileAssetHandoff({ task, files = null, addTask, root = REPO_ROOT, agent = 'producer' } = {}) {
  if (!task || typeof addTask !== 'function') return null;
  const evs = readRecentEvents(20000);
  const prev = evs.find((e) => e.type === 'asset.handoff' && e.meta?.from === task);
  if (prev) return { already: true, id: prev.meta?.id || null };
  const gate = evs.filter((e) => e.type === 'asset.gate' && e.task === task && e.meta?.status === 'pass').pop();
  const list = (files || gate?.meta?.files || []).filter((f) => !isPreview(f));
  if (!list.length) return null;
  const added = evs.filter((e) => e.type === 'task.added' && e.task === task).pop()?.meta || {};
  const unity = unityConfigured(root);
  const named = list.filter(isModel).length ? list.filter(isModel) : list;
  const short = named.map((f) => path.basename(f));
  let what = short.slice(0, 3).join(', ');
  if (short.length > 3) what += ` and ${short.length - 3} more`;
  const title = `Wire in ${what} (asset task ${task}: ${list.join(', ')})`.slice(0, 240);
  const meta = {
    after: [task],
    assetFiles: list,
    ...(unity ? { track: 'engine:unity' } : {}),
    ...(added.phase !== undefined ? { phase: added.phase } : {}),
    ...(added.serves ? { serves: added.serves } : {}),
    ...(added.idea ? { idea: added.idea } : {}),
    ...(added.prototype ? { prototype: true } : {}),
    ...(added.infra ? { infra: true } : {}),
    origin: 'agent',
  };
  const r = addTask({ title, role: unity ? 'engine-porter' : 'builder', priority: 'P2', agent, meta: { ...meta, promoted: true } });
  if (!r || r.error) {
    emitEvent({ type: 'asset.handoff_refused', agent, task, to: 'producer', status: 'warn', msg: `${task} landed but its engine task wasn't queued: ${r?.message || 'no answer'}. Queue "${title}" by hand.`.slice(0, 600), meta: { from: task, files: list } });
    return { refused: r?.message || 'not queued' };
  }
  emitEvent({ type: 'asset.handoff', agent, task, to: unity ? 'engine-porter' : 'builder', msg: `${task} landed: ${r.id} wires in ${what}${unity ? ' (Unity track)' : ''}`.slice(0, 400), meta: { from: task, id: r.id, files: list, track: unity ? 'engine:unity' : null } });
  return { id: r.id, title, track: unity ? 'engine:unity' : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  if (argv[0] === 'allow') {
    const r = allowLicence(argv[1] || '', { by: flag('by') || '', permission: flag('permission') || '' });
    (r.ok ? console.log : console.error)(`[asset-gate] ${r.why}`);
    process.exit(r.ok ? 0 : 2);
  }
  if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    console.log('Usage: node harness/asset-gate.mjs [--task T-012] [--files a.glb,b.png] [--base <commit>] [--no-round-trip] [--json]\n       node harness/asset-gate.mjs allow <file> --by <person> --permission "<their words or a link>"');
    process.exit(0);
  }
  const files = flag('files') ? flag('files').split(',').filter(Boolean) : null;
  const res = await runAssetGate({ files, task: flag('task'), base: flag('base'), roundTrip: !argv.includes('--no-round-trip'), log: (m) => console.error(m) });
  if (argv.includes('--json')) console.log(JSON.stringify(res));
  else console.log(assetGateText(res));
  process.exit(res.status === 'pass' || res.status === 'skipped' ? 0 : res.status === 'busy' ? 3 : 1);
}
