#!/usr/bin/env node
/**
 * harness/asset-review.mjs — 2.70.0 (v): a vision check on asset previews before an asset lands.
 *
 * The crew's orchestrator used to look at every asset preview by eye before it landed (wrong scale, model off-frame,
 * black or empty renders, untextured pink, upside-down). The harness can't look (no paid service, no model call), so
 * this splits the job in two:
 *
 * 1. Deterministic preview checks (pure Node, harness/png.mjs decodes the PNG): for each preview render the asset gate
 *    finds next to a model, it measures and records
 *      blank      one colour covers more than blankShare (98%) of the frame and no object stands out of the
 *                 background (fewer than 0.05% of the pixels, at least 64): an empty render. A small object that
 *                 does stand out is judged by "small" instead (a wrong scale, not an empty render)
 *      black      more than darkShare of the pixels are near black (luma <= 16): an unlit or failed render
 *      white      more than lightShare of the pixels are near white (luma >= 240): a blown-out render
 *      magenta    the missing-texture magenta is over magentaMaxShare (10%) of the object's pixels: untextured pink
 *      clipped    object pixels on the frame's outer ring (edgeMinPixels or more): the model runs off the frame
 *      small      the object's bounding box is under minFrameShare (10%) of the frame and its longer side under half
 *                 the frame: too small, usually the wrong scale (a thin, tall object that fills one way isn't small)
 *      up-axis    (a warning only, a question for the reviewer) more object mass in the top half of its box than
 *                 the bottom (ratio over upWarnRatio) in the front view, and in the 3/4 view when there is one
 *    The object is every pixel that differs from the background (the most common colour on the frame's border, or
 *    transparent pixels) by more than bgTolerance (sum of RGB differences). Each hard finding is an asset-gate failure
 *    with a plain-words line and a Fix line (harness/gate-fix.mjs ASSET_FIXES): the asset goes straight back to its
 *    maker with the findings and no review is asked for. A preview the decoder can't read (a JPEG, 16-bit or
 *    interlaced PNG) is a note: the reviewer still looks at it.
 *
 *    Where previews live (the render step writes them): next to the model, one view per file at a fixed size
 *    (previewSize, 512 px square by default):
 *      <name>.preview-front.png   <name>.preview-34.png   <name>.preview-top.png
 *    The older single <name>.preview.png (or _preview / -preview) counts as the front view.
 *
 * 2. A review request, not a self-review: when the checks pass, the asset still needs a look by a session that can
 *    view images. task done writes .studio/asset-reviews/<asset>.md (the preview paths, the brief's facts, the checks'
 *    numbers and the questions to answer: scale against the reference, style match, orientation, obvious defects) and
 *    files ONE asset-review task for the role in studio/asset-review.json "role" (default art-director: the role that
 *    owns the look and runs on a model that reads images), once per asset and checksum. The asset lands only once the
 *    review is answered:
 *
 *      npm run asset -- review <asset> --pass --by <name>
 *      npm run asset -- review <asset> --fail "what is wrong" --by <name>
 *      npm run asset -- reviews                       assets waiting for a review, oldest first
 *
 *    Who may answer: anyone but the worker who made the asset (the asset task's claimants and the row's madeBy):
 *    another agent under its own name, a person in their own terminal, an agent recording a person's verdict on their
 *    permission (--by <person> --permission "<their words or a link>", never a worker), or the outside agent under the
 *    owner's delegation for asset-review (harness/delegation.mjs). A pass counts for the files' current checksums only:
 *    a re-export asks again. A fail files a fix task with the reviewer's words. Both write a review note in
 *    studio/reviews/ (the review task's own done check reads it).
 *
 * Thresholds: studio/asset-review.json over REVIEW_DEFAULTS. The file silences checks, so a lane that changes it is
 * tier C (harness/tiers.mjs SILENCERS): a game dev releases it, or an outside agent with their permission.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { decodePng } from './png.mjs';

export const REVIEW_CONFIG_REL = 'studio/asset-review.json';
export const REVIEWS_DIR_REL = '.studio/asset-reviews';
export const VIEWS = ['front', '34', 'top'];
export const REVIEW_DEFAULTS = {
  review: true,
  role: 'art-director',
  previewSize: 512,
  blankShare: 0.98,
  darkShare: 0.98,
  lightShare: 0.98,
  magentaMaxShare: 0.1,
  minFrameShare: 0.1,
  edgeMinPixels: 2,
  upWarnRatio: 1.5,
  bgTolerance: 48,
};

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, j) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); };
const slash = (p) => String(p).split(path.sep).join('/').replace(/^\.\//, '');
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const r3 = (x) => Math.round(x * 1000) / 1000;
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

/** studio/asset-review.json over the defaults (a bad value keeps its default). */
export function reviewConfig(root = REPO_ROOT) {
  const own = readJson(path.join(root, REVIEW_CONFIG_REL));
  const o = own && typeof own === 'object' && !Array.isArray(own) ? own : {};
  const out = { ...REVIEW_DEFAULTS };
  for (const [k, d] of Object.entries(REVIEW_DEFAULTS)) {
    if (o[k] === undefined || o[k] === null) continue;
    if (typeof d === 'number' && Number.isFinite(Number(o[k])) && Number(o[k]) >= 0) out[k] = Number(o[k]);
    else if (typeof d === 'boolean') out[k] = o[k] !== false && !/^(off|false|no|0)$/i.test(String(o[k]));
    else if (typeof d === 'string' && /^[a-z][\w-]{1,40}$/i.test(String(o[k]))) out[k] = String(o[k]);
  }
  return out;
}

/** The asset's name for the review command: its path under the asset folder, without the extension ("props-crate"). */
export function assetSlug(rel, paths = []) {
  let s = slash(rel);
  const root = [...paths].sort((a, b) => b.length - a.length).find((p) => s.startsWith(`${p}/`));
  if (root) s = s.slice(root.length + 1);
  s = s.slice(0, s.length - path.extname(s).length);
  return s.replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'asset';
}

/** The preview files next to a model, by view: [{ view, file }] (the old single preview counts as the front view). */
export function previewFiles(root, rel) {
  const ext = path.extname(rel);
  const stem = rel.slice(0, -ext.length);
  const exts = ['.png', '.jpg', '.jpeg', '.webp'];
  const first = (names) => names.find((n) => fs.existsSync(path.join(root, n))) || null;
  const out = [];
  for (const v of VIEWS) {
    const f = first(['.preview-', '_preview-', '-preview-'].flatMap((s) => exts.map((e) => `${stem}${s}${v}${e}`)));
    if (f) out.push({ view: v, file: f });
  }
  if (!out.some((p) => p.view === 'front')) {
    const f = first(['.preview', '_preview', '-preview'].flatMap((s) => exts.map((e) => `${stem}${s}${e}`)));
    if (f) out.unshift({ view: 'front', file: f, single: true });
  }
  return out;
}

/**
 * Measure one decoded preview: { w, h, dominant: { share, hex }, dark, light, background, objectPx, magenta, bbox:
 * { x, y, w, h, share, longSide }, edgePx, top, bottom, upRatio }. Pure.
 */
export function measurePreview({ width: w, height: h, rgba }, cfg = REVIEW_DEFAULTS) {
  const n = w * h;
  const hist = new Uint32Array(32769);
  let dark = 0;
  let light = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]; const g = rgba[i * 4 + 1]; const b = rgba[i * 4 + 2]; const a = rgba[i * 4 + 3];
    if (a < 16) { hist[32768]++; continue; }
    hist[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)]++;
    const l = (r * 299 + g * 587 + b * 114) / 1000;
    if (l <= 16) dark++;
    else if (l >= 240) light++;
  }
  let top = 0;
  for (let k = 1; k < hist.length; k++) if (hist[k] > hist[top]) top = k;
  const hex = top === 32768 ? 'transparent' : `#${[(top >> 10) & 31, (top >> 5) & 31, top & 31].map((c) => ((c << 3) | 4).toString(16).padStart(2, '0')).join('')}`;
  // The background: the most common colour on the frame's border.
  const border = new Map();
  const onBorder = (x, y) => { const i = (y * w + x) * 4; const a = rgba[i + 3]; const k = a < 16 ? -1 : ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3); border.set(k, (border.get(k) || 0) + 1); };
  for (let x = 0; x < w; x++) { onBorder(x, 0); if (h > 1) onBorder(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { onBorder(0, y); if (w > 1) onBorder(w - 1, y); }
  const bgKey = [...border.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
  let bg = null;
  if (bgKey !== -1) {
    let sr = 0; let sg = 0; let sb = 0; let c = 0;
    const add = (x, y) => { const i = (y * w + x) * 4; if (rgba[i + 3] < 16) return; const k = ((rgba[i] >> 3) << 10) | ((rgba[i + 1] >> 3) << 5) | (rgba[i + 2] >> 3); if (k !== bgKey) return; sr += rgba[i]; sg += rgba[i + 1]; sb += rgba[i + 2]; c++; };
    for (let x = 0; x < w; x++) { add(x, 0); if (h > 1) add(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { add(0, y); if (w > 1) add(w - 1, y); }
    bg = [sr / c, sg / c, sb / c];
  }
  let objectPx = 0; let magenta = 0; let edgePx = 0;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  const rows = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 16) continue;
      const r = rgba[i]; const g = rgba[i + 1]; const b = rgba[i + 2];
      if (bg && Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) <= cfg.bgTolerance) continue;
      objectPx++; rows[y]++;
      if (r >= 180 && b >= 180 && g <= 80) magenta++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edgePx++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const bbox = objectPx ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
  let upper = 0; let lower = 0;
  if (bbox) {
    const mid = bbox.y + bbox.h / 2;
    for (let y = bbox.y; y <= y1; y++) { if (y + 0.5 < mid) upper += rows[y]; else lower += rows[y]; }
    bbox.share = r3((bbox.w * bbox.h) / n);
    bbox.longSide = r3(Math.max(bbox.w / w, bbox.h / h));
  }
  return {
    w, h,
    dominant: { share: r3(hist[top] / n), hex },
    dark: r3(dark / n), light: r3(light / n),
    background: bgKey === -1 ? 'transparent' : `rgb(${bg.map((v) => Math.round(v)).join(',')})`,
    objectPx, objectShare: r3(objectPx / n),
    magenta: objectPx ? r3(magenta / objectPx) : 0,
    bbox, edgePx,
    top: upper, bottom: lower,
    upRatio: bbox ? r3(upper / Math.max(1, lower)) : null,
  };
}

/** The hard findings for one measured preview: [{ check, why }] (blank, black or white stop the rest). */
export function previewFindings(m, cfg = REVIEW_DEFAULTS, { view = 'front' } = {}) {
  const out = [];
  if (m.dark > cfg.darkShare) return [{ check: 'preview-black', why: `the ${view} view is all black (${pct(m.dark)} of the pixels near black): the render failed or the scene has no light` }];
  if (m.light > cfg.lightShare) return [{ check: 'preview-white', why: `the ${view} view is all white (${pct(m.light)} of the pixels near white): the render is blown out or empty` }];
  const speck = Math.max(64, Math.round(m.w * m.h * 0.0005));
  if (m.objectPx < speck && (m.dominant.share > cfg.blankShare || !m.objectPx)) return [{ check: 'preview-blank', why: `the ${view} view is almost one colour (${pct(m.dominant.share)} ${m.dominant.hex}): the render is empty, the model isn't in front of the camera` }];
  if (m.magenta > cfg.magentaMaxShare) out.push({ check: 'preview-magenta', why: `${pct(m.magenta)} of the model in the ${view} view is the missing-texture magenta: a texture didn't load (untextured pink)` });
  if (m.edgePx >= cfg.edgeMinPixels) out.push({ check: 'preview-clipped', why: `the model touches the edge of the ${view} view (${m.edgePx} px on the frame's border): it is clipped, off-frame or the camera is too close` });
  if (m.bbox && m.bbox.share < cfg.minFrameShare && m.bbox.longSide < 0.5) out.push({ check: 'preview-small', why: `the model fills only ${pct(m.bbox.share)} of the ${view} view (box ${m.bbox.w}x${m.bbox.h} px of ${m.w}x${m.h}): too small for the frame, often a wrong scale (centimetres as metres)` });
  return out;
}

/**
 * Check every preview of one model: { previews: [{ view, file, sha256, measured | error }], failures: [{ check, file,
 * why }], notes: [], warnings: [] }.
 */
export function checkPreviews(root, rel, cfg = reviewConfig(root)) {
  const previews = [];
  const failures = [];
  const notes = [];
  const warnings = [];
  const list = previewFiles(root, rel);
  if (list.length && list.length < VIEWS.length) notes.push(`${rel}: ${list.length} preview view(s) (${list.map((p) => p.view).join(', ')}); the render step should write all three, ${VIEWS.map((v) => `<name>.preview-${v}.png`).join(', ')}, at ${cfg.previewSize} px`);
  for (const p of list) {
    const abs = path.join(root, p.file);
    const row = { view: p.view, file: p.file, sha256: sha(abs) };
    let img = null;
    try { img = decodePng(fs.readFileSync(abs)); } catch (err) { row.error = err.message; }
    if (!img || !img.width || !img.height) {
      notes.push(`${p.file}: preview checks not run (${row.error || 'not a PNG'}): the reviewer looks at it`);
      previews.push(row);
      continue;
    }
    const m = measurePreview(img, cfg);
    row.measured = m;
    previews.push(row);
    if (m.w !== cfg.previewSize || m.h !== cfg.previewSize) notes.push(`${p.file}: ${m.w}x${m.h} px, the fixed preview size is ${cfg.previewSize}x${cfg.previewSize}`);
    for (const f of previewFindings(m, cfg, { view: p.view })) failures.push({ ...f, file: p.file });
  }
  // The up axis: a warning when the front view (and the 3/4 view, when there is one) is top-heavy.
  const measured = (v) => previews.find((p) => p.view === v && p.measured && p.measured.bbox)?.measured;
  const front = measured('front');
  const q = measured('34');
  if (front && front.upRatio > cfg.upWarnRatio && (!q || q.upRatio > cfg.upWarnRatio)) warnings.push(`${rel}: more of the model is in the top half of its box than the bottom (front ${front.upRatio}x${q ? `, 3/4 ${q.upRatio}x` : ''}): it may be upside down (Y-up export?), or it is a top-heavy shape: the reviewer decides`);
  return { previews, failures, notes, warnings };
}

// ---------- the review record ----------

export const recordFile = (root, asset) => path.join(root, REVIEWS_DIR_REL, `${asset}.json`);
export const requestFile = (root, asset) => path.join(root, REVIEWS_DIR_REL, `${asset}.md`);
export const readRecord = (root, asset) => readJson(recordFile(root, asset));
const sameHashes = (a, b) => { const ka = Object.keys(a || {}).sort(); const kb = Object.keys(b || {}).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]); };

/** 'passed' | 'failed' | 'pending' | 'none' for an asset at these checksums. */
export function reviewState(root, asset, hashes) {
  const r = readRecord(root, asset);
  if (!r || !sameHashes(r.hashes, hashes)) return 'none';
  if (r.verdict === 'pass') return 'passed';
  if (r.verdict === 'fail') return 'failed';
  return 'pending';
}

/** Assets waiting for a review (a request with no verdict), oldest first: [{ asset, task, reviewTask, at, request }]. */
export function pendingReviews(root = REPO_ROOT) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, REVIEWS_DIR_REL)).filter((f) => f.endsWith('.json')); } catch { return []; }
  return names.map((f) => readJson(path.join(root, REVIEWS_DIR_REL, f))).filter((r) => r && r.asset && !r.verdict)
    .map((r) => ({ asset: r.asset, task: r.task || null, reviewTask: r.reviewTask || null, at: r.requestedAt || null, request: `${REVIEWS_DIR_REL}/${r.asset}.md` }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.asset.localeCompare(b.asset));
}

/** The digest's / brief's words for the waiting reviews: '' when none. */
export function pendingReviewsLine(root = REPO_ROOT, { max = 3 } = {}) {
  const p = pendingReviews(root);
  if (!p.length) return '';
  const shown = p.slice(0, max).map((r) => `${r.asset}${r.reviewTask ? ` (${r.reviewTask})` : ''}${r.at ? ` since ${String(r.at).slice(5, 16).replace('T', ' ')}` : ''}`);
  return `${p.length} asset${p.length === 1 ? '' : 's'} wait${p.length === 1 ? 's' : ''} for a review, oldest first: ${shown.join(', ')}${p.length > max ? ` +${p.length - max} more` : ''} (npm run asset -- review <asset> --pass|--fail "why" --by <you>)`;
}

/** The review request people (and the review session) read. */
export function requestText(item, { task, reviewTask = null, role, makers = [] } = {}) {
  const L = [];
  L.push(`# Asset review: ${item.asset}`, '');
  L.push(`Asset task: ${task || 'unknown'}${makers.length ? ` (made by ${makers.join(', ')})` : ''}. Review task: ${reviewTask || 'not filed yet'} (role ${role}).`);
  L.push(`Model: ${item.model}`, '', '## Previews (open each image and look at it)', '');
  for (const p of item.previews) {
    const m = p.measured;
    L.push(`- ${p.view === '34' ? '3/4' : p.view}: ${p.file}${m ? ` (${m.w}x${m.h} px)` : ` (not measured: ${p.error || 'not a PNG'})`}`);
  }
  L.push('', '## What the brief says', '');
  for (const f of item.facts || []) L.push(`- ${f}`);
  L.push('', '## What the checks measured (they passed)', '');
  for (const p of item.previews) {
    const m = p.measured;
    if (!m) continue;
    L.push(`- ${p.view === '34' ? '3/4' : p.view}: one colour ${pct(m.dominant.share)} (${m.dominant.hex}); near black ${pct(m.dark)}, near white ${pct(m.light)}; background ${m.background}; model ${pct(m.objectShare)} of the pixels${m.bbox ? `, box ${m.bbox.w}x${m.bbox.h} px at ${m.bbox.x},${m.bbox.y} (${pct(m.bbox.share)} of the frame), ${m.edgePx} px on the border` : ''}; magenta ${pct(m.magenta)} of the model; top/bottom mass ${m.upRatio ?? 'n/a'}`);
  }
  for (const n of item.notes || []) L.push(`- note: ${n}`);
  for (const wn of item.warnings || []) L.push(`- WARNING: ${wn}`);
  L.push('', '## Answer these (by looking at the images)', '');
  L.push('1. Scale: next to the reference or the stated size above, is it the right size for the game (not a toy, not a building)?');
  L.push('2. Style: does it match the style sheet and the brief\'s style refs (palette, detail, shading)?');
  L.push(`3. Orientation: is it the right way up and facing forward in the front view?${(item.warnings || []).length ? ' (the up-axis warning above)' : ''}`);
  L.push('4. Obvious defects: holes, flipped faces, stretched or missing textures, floating parts, wrong pivot?');
  L.push('', '## Record the answer', '');
  L.push(`npm run asset -- review ${item.asset} --pass --by <you>`);
  L.push(`npm run asset -- review ${item.asset} --fail "<what is wrong, in words the maker can act on>" --by <you>`);
  L.push('', `The worker who made the asset${makers.length ? ` (${makers.join(', ')})` : ''} can't pass its own review. A pass counts for these files' current checksums only.`);
  return `${L.join('\n')}\n`;
}

/** The brief's facts for the request: the manifest row's size, licence and credit, the measured size, the task's brief. */
export function briefFacts(root, { model, row = null, side = null, info = null, task = null, title = '' } = {}) {
  const facts = [];
  if (title) facts.push(`Task: ${title}`);
  const s = row?.size ?? side?.size;
  if (s) facts.push(`Stated size (m): ${Array.isArray(s) ? `w ${s[0]} x d ${s[1]} x h ${s[2]}` : `w ${s.w ?? s.width} x d ${s.d ?? s.depth} x h ${s.h ?? s.height}`}`);
  else facts.push('Stated size: none recorded (judge the scale by eye against the reference)');
  if (info?.bbox) facts.push(`Measured box (m, glTF Y-up): w ${info.bbox.size[0]} x d ${info.bbox.size[2]} x h ${info.bbox.size[1]}`);
  if (info?.lods) facts.push(`Triangles: ${Object.entries(info.lods).map(([l, t]) => `LOD${l} ${t}`).join(', ')}`);
  if (row) facts.push(`Licence: ${row.licence || row.license || 'none'}${row.credit ? `; credit: ${row.credit}` : ''}${row.madeBy ? `; made by ${row.madeBy}` : ''}`);
  if (task) {
    const brief = [path.join(root, '.studio', 'briefs', `${task}.md`)].find((f) => fs.existsSync(f));
    if (brief) {
      const text = fs.readFileSync(brief, 'utf8');
      for (const k of ['What', 'Used in', 'Real-world size', 'Style refs']) {
        const m = text.match(new RegExp(`^\\s*-\\s*${k}:\\s*(.+)$`, 'mi'));
        if (m) facts.push(`${k}: ${m[1].trim().slice(0, 200)}`);
      }
      facts.push(`Brief: .studio/briefs/${task}.md`);
    }
  }
  return facts;
}

// ---------- at task done ----------

const taskAdded = (evs, id) => evs.filter((e) => e.type === 'task.added' && e.task === id).pop() || null;
const roleOf = (ev) => (String(ev?.msg || '').match(/^Queued [A-Z]+-\d+ \[\w+\] \(([\w-]+)\)/) || [])[1] || null;

/** The workers who made the asset: the asset task's claimants, the agent running done, and the row's madeBy. */
function makersOf({ task, agent = null, rows = [], evs = null } = {}) {
  const ev = evs || readRecentEvents(20000);
  const set = new Set();
  for (const e of ev) if (e.task === task && e.type === 'task.start' && e.agent) set.add(String(e.agent));
  if (agent) set.add(String(agent));
  for (const r of rows) if (r?.madeBy) set.add(String(r.madeBy));
  return [...set].filter((n) => n && !/^(producer|harness)$/i.test(n));
}

/**
 * task done's half of the review (harness/task.mjs calls it after the asset gate passes). For each model the gate
 * checked: passed (its current checksums) → nothing; failed → a refusal naming the fix task; otherwise (not checkOnly)
 * the request is written and ONE review task filed (once per asset and checksums), and task done refuses until the
 * answer. checkOnly: a note only. Returns null | { note } | { error, message, reviews }.
 */
export function reviewsAtDone({ task, res, agent = null, checkOnly = false, addTask = null, root = REPO_ROOT } = {}) {
  const items = res?.review?.items || [];
  if (!res?.review?.required || !items.length) return null;
  const cfg = reviewConfig(root);
  const evs = readRecentEvents(20000);
  const waiting = [];
  const failed = [];
  for (const it of items) {
    const state = reviewState(root, it.asset, it.hashes);
    if (state === 'passed') continue;
    if (state === 'failed') { const r = readRecord(root, it.asset); failed.push({ ...it, record: r }); continue; }
    if (checkOnly) { waiting.push({ ...it }); continue; }
    const prev = readRecord(root, it.asset);
    const makers = [...new Set([...(prev && sameHashes(prev.hashes, it.hashes) ? prev.makers || [] : []), ...makersOf({ task, agent, rows: it.row ? [it.row] : [], evs })])];
    let reviewTask = prev && sameHashes(prev.hashes, it.hashes) ? prev.reviewTask : null;
    if (!reviewTask && typeof addTask === 'function') {
      const added = taskAdded(evs, task)?.meta || {};
      const title = `Review asset ${it.asset} (asset task ${task}): look at its previews in ${REVIEWS_DIR_REL}/${it.asset}.md and answer pass or fail`.slice(0, 240);
      const meta = {
        assetReview: it.asset, assetTask: task, assetFiles: [it.model, ...it.previews.map((p) => p.file)],
        ...(added.phase !== undefined ? { phase: added.phase } : {}), ...(added.serves ? { serves: added.serves } : {}),
        ...(added.prototype ? { prototype: true } : {}), infra: true, origin: 'agent', promoted: true,
      };
      const r = addTask({ title, role: cfg.role, priority: 'P2', agent: 'producer', meta });
      if (r?.id && !r.error) reviewTask = r.id;
      else emitEvent({ type: 'asset.review_refused', agent: agent || 'harness', task, to: 'producer', status: 'warn', msg: `${task}: the review task for ${it.asset} wasn't queued: ${r?.message || 'no answer'}. Queue "${title}" by hand (role ${cfg.role}).`.slice(0, 600), meta: { asset: it.asset } });
    }
    const record = { asset: it.asset, model: it.model, task, reviewTask, role: cfg.role, makers, hashes: it.hashes, requestedAt: prev && sameHashes(prev.hashes, it.hashes) ? prev.requestedAt : new Date().toISOString(), verdict: null, history: prev?.history || [] };
    writeJson(recordFile(root, it.asset), record);
    fs.writeFileSync(requestFile(root, it.asset), requestText(it, { task, reviewTask, role: cfg.role, makers }));
    if (!prev || !sameHashes(prev.hashes, it.hashes) || prev.reviewTask !== reviewTask) emitEvent({ type: 'asset.review_requested', agent: agent || 'harness', task, to: cfg.role, msg: `${task}: ${it.asset} passed its checks and waits for a look${reviewTask ? ` (${reviewTask}, ${cfg.role})` : ''}: ${REVIEWS_DIR_REL}/${it.asset}.md`.slice(0, 400), meta: { asset: it.asset, reviewTask, model: it.model } });
    waiting.push({ ...it, reviewTask });
  }
  if (failed.length) {
    return { error: 'asset-review', reviews: failed.map((f) => f.asset), message: `${task} is not done: ${failed.map((f) => `${f.asset}'s review failed (${f.record?.by || 'a reviewer'}: "${String(f.record?.why || '').slice(0, 200)}")${f.record?.fixTask ? `; ${f.record.fixTask} fixes it` : ''}`).join('; ')}. Change the asset (a re-export asks for a new review) and run task done again.` };
  }
  if (!waiting.length) return null;
  const list = waiting.map((w) => `${w.asset}${w.reviewTask ? ` (${w.reviewTask})` : ''}`).join(', ');
  if (checkOnly) return { note: `[asset-review] the checks pass; at task done ${list} still need${waiting.length === 1 ? 's' : ''} a look (a review task for ${cfg.role}); the asset lands once it is answered` };
  emitEvent({ type: 'task.not_done', agent: agent || 'harness', task, status: 'blocked', msg: `${task} not done yet: waiting for the asset review of ${list}`.slice(0, 400) });
  return { error: 'asset-review', reviews: waiting.map((w) => w.asset), message: `${task} is not done: the asset checks pass, and ${list} now wait${waiting.length === 1 ? 's' : ''} for a look by a session that can view images (role ${cfg.role}; requests in ${REVIEWS_DIR_REL}/). You can't pass your own review. Pause meanwhile (npm run task -- pause ${task} --note "waiting for the asset review"); once it is answered, run task done ${task} again.` };
}

// ---------- the answer ----------

/**
 * Who may record a verdict. { ok, via, by, recordedBy, permission, why }. The maker never passes its own asset; any
 * other agent (under its own name), a person, an agent on a person's permission (never a worker), or the outside agent
 * under the owner's delegation for asset-review may.
 */
export async function reviewDecider({ by, permission = '', verdict = 'pass', makers = [], env = process.env, root = REPO_ROOT } = {}) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: 'say who reviewed it: --by <name>' };
  const lower = (s) => String(s || '').trim().toLowerCase();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const asAgent = String(env.STUDIO_AGENT || '').trim();
  const mk = new Set(makers.map(lower));
  const self = [who, owner, asAgent].find((n) => n && mk.has(lower(n)));
  if (self && verdict === 'pass') return { ok: false, why: `${self} made this asset: the worker who made an asset can't pass its own review (another agent, a person, or the delegated outside agent can)` };
  const { AGENT_SHELL, WORKER_NAME, agentOnPermission } = await import('./permission.mjs');
  const { agentLikeName } = await import('./agent-env.mjs');
  try {
    const dl = await import('./delegation.mjs');
    const d = dl.delegationFor({ action: 'asset-review', by: who, env });
    if (d.ok) { dl.recordUse(d, { action: 'asset-review' }); return { ok: true, via: d.autonomous ? 'autonomous' : 'delegation', by: who, recordedBy: who, permission: d.permission, at: d.at, ...(d.autonomous ? { autonomous: true } : {}) }; }
  } catch { /* no delegation: the other rules apply */ }
  const role = String(env.STUDIO_ROLE || '').trim();
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  const selfName = owner || asAgent;
  const agentShell = Boolean(role || marker || selfName);
  const stateDir = path.join(root, '.studio');
  const agentName = agentLikeName(who, { stateDir }) || WORKER_NAME.test(who);
  if (agentName) {
    if (selfName && lower(selfName) !== lower(who)) return { ok: false, why: `this shell works as ${selfName}: --by names yourself (${selfName}) or the person whose verdict this is (with --permission)` };
    return { ok: true, via: 'agent', by: who, recordedBy: who, permission: '' };
  }
  if (agentShell) {
    const p = agentOnPermission({ permission, env });
    if (!p.ok) return { ok: false, why: `an agent records a person's verdict only on their permission: ${p.why} (or answer under your own name: --by ${selfName || '<your agent name>'})` };
    return { ok: true, via: p.via, by: who, recordedBy: p.recordedBy, permission: String(permission).trim().slice(0, 300) };
  }
  return { ok: true, via: 'person', by: who, recordedBy: who, permission: '' };
}

/** Find the asset's record by its name, its model's path or the model's file name. */
export function findAsset(root, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const direct = readRecord(root, n.replace(/[^A-Za-z0-9._-]+/g, '-'));
  if (direct) return direct;
  let names = [];
  try { names = fs.readdirSync(path.join(root, REVIEWS_DIR_REL)).filter((f) => f.endsWith('.json')); } catch { return null; }
  const all = names.map((f) => readJson(path.join(root, REVIEWS_DIR_REL, f))).filter((r) => r?.asset);
  const want = slash(n);
  return all.find((r) => r.model === want) || (all.filter((r) => path.basename(r.model || '', path.extname(r.model || '')) === n).length === 1 ? all.find((r) => path.basename(r.model || '', path.extname(r.model || '')) === n) : null);
}

/**
 * Record a verdict: `npm run asset -- review <asset> --pass|--fail "why" --by <name>`. A fail files a fix task with the
 * reviewer's words. Both write a review note in studio/reviews/. `board` = { addTask, dropTask, parseNextQueue }
 * (task.mjs, injected). Returns { ok, message, fixTask? }.
 */
export async function recordVerdict({ asset, verdict, why = '', by, permission = '', root = REPO_ROOT, env = process.env, board = null } = {}) {
  const rec = findAsset(root, asset);
  if (!rec) return { ok: false, message: `No review request for "${asset}" (${REVIEWS_DIR_REL}/). npm run asset -- reviews lists the assets waiting.` };
  if (!['pass', 'fail'].includes(verdict)) return { ok: false, message: 'Say the verdict: --pass, or --fail "what is wrong".' };
  if (verdict === 'fail' && String(why || '').trim().length < 5) return { ok: false, message: 'Say what is wrong: --fail "<what the maker should change>" (5+ characters).' };
  // The files still the ones the request named?
  const current = {};
  for (const f of Object.keys(rec.hashes || {})) { try { current[f] = sha(path.join(root, f)); } catch { current[f] = null; } }
  if (!sameHashes(current, rec.hashes)) return { ok: false, message: `${rec.asset}'s files changed since the request (${Object.keys(rec.hashes).filter((f) => current[f] !== rec.hashes[f]).join(', ')}): its next task done asks for a new review.` };
  const d = await reviewDecider({ by, permission, verdict, makers: rec.makers || [], env, root });
  if (!d.ok) return { ok: false, message: `Refused: ${d.why}.` };
  const at = new Date().toISOString();
  const words = String(why || '').trim().slice(0, 600);
  const out = { ...rec, verdict, by: d.by, recordedBy: d.recordedBy, via: d.via, ...(d.permission ? { permission: d.permission } : {}), why: words, at, history: [...(rec.history || []), { verdict, by: d.by, via: d.via, why: words, at }].slice(-20) };
  let fixTask = null;
  const evs = readRecentEvents(20000);
  if (verdict === 'fail' && board?.addTask) {
    const added = taskAdded(evs, rec.task);
    const meta = added?.meta || {};
    const title = `Fix asset ${rec.asset} after its review (asset task ${rec.task}): ${words}`.slice(0, 240);
    const r = board.addTask({ title, role: roleOf(added) || 'asset-3d', priority: 'P1', agent: 'producer', meta: { track: 'asset', fixOf: rec.task, assetReview: rec.asset, assetFiles: [rec.model], ...(meta.phase !== undefined ? { phase: meta.phase } : {}), ...(meta.serves ? { serves: meta.serves } : {}), ...(meta.prototype ? { prototype: true } : {}), ...(meta.infra ? { infra: true } : {}), origin: 'agent', promoted: true } });
    if (r?.id && !r.error) fixTask = r.id;
  }
  if (fixTask) out.fixTask = fixTask;
  writeJson(recordFile(root, rec.asset), out);
  // A review note (the review task's done check reads studio/reviews/).
  try {
    const dir = path.join(root, 'studio', 'reviews');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `asset-${rec.asset}-${at.slice(0, 10)}.md`), `# Asset review: ${rec.asset}\n\nReviewed: ${rec.task}${rec.reviewTask ? ` (review task ${rec.reviewTask})` : ''}, ${rec.model}\nVerdict: ${verdict === 'pass' ? 'approved' : 'request changes'}\nBy: ${d.by} (${d.via}${d.recordedBy !== d.by ? `, recorded by ${d.recordedBy}` : ''})\n${words ? `Why: ${words}\n` : ''}${fixTask ? `Fix task: ${fixTask}\n` : ''}Request: ${REVIEWS_DIR_REL}/${rec.asset}.md\n`);
  } catch { /* the record above is what the gate reads */ }
  emitEvent({ type: 'asset.review', agent: d.recordedBy, task: rec.task, to: roleOf(taskAdded(evs, rec.task)) || 'producer', status: verdict === 'pass' ? 'ok' : 'blocked', msg: (verdict === 'pass' ? `${rec.asset} passed its review (${d.by}${d.via !== 'agent' && d.via !== 'person' ? `, ${d.via}` : ''}): task done ${rec.task} lands it` : `${rec.asset} failed its review (${d.by}): ${words}${fixTask ? `; ${fixTask} fixes it` : ''}`).slice(0, 500), meta: { asset: rec.asset, verdict, by: d.by, via: d.via, reviewTask: rec.reviewTask || null, fixTask } });
  // 2.71.0 (x): one decision-log record (harness/decisions.mjs); a revert asks for the review again.
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'asset-review', subject: rec.asset, by: d.by, as: dm.asCaller(d, env), why: words || `${verdict} (${rec.task})`, evidence: `${verdict}, ${rec.task}${fixTask ? `, fix task ${fixTask}` : ''}`, undo: { kind: 'asset-review-reopen', asset: rec.asset, task: rec.task, text: `the asset waits for a new review (npm run asset -- review ${rec.asset} --pass|--fail "…" --by <name>)` }, root }); } catch {}
  // The review task is answered: take it off the queue when nobody has started it (a session working it closes it).
  if (rec.reviewTask && board?.dropTask && board?.parseNextQueue) {
    try { if (board.parseNextQueue().backlog.some((t) => t.id === rec.reviewTask)) board.dropTask(rec.reviewTask, { by: d.recordedBy, why: `answered: ${rec.asset} ${verdict === 'pass' ? 'passed' : 'failed'} its review (${d.by})` }); } catch { /* it stays for its session */ }
  }
  return { ok: true, fixTask, message: verdict === 'pass' ? `${rec.asset}: review passed by ${d.by} (${d.via}). task done ${rec.task} lands it now.` : `${rec.asset}: review failed by ${d.by}: "${words}".${fixTask ? ` ${fixTask} fixes it.` : ''}` };
}

/**
 * 2.71.0 (x): a reverted review decision (npm run decisions -- revert): the asset waits for a review again (verdict
 * cleared, history kept). An asset whose task already landed says so: its files are on main; a person looks again.
 */
export function reopenReview(root, asset, { by = 'someone', why = '' } = {}) {
  const rec = findAsset(root, asset);
  if (!rec) return { ok: false, message: `No review record for "${asset}"` };
  if (!rec.verdict) return { ok: true, message: `${rec.asset} already waits for a review` };
  const at = new Date().toISOString();
  writeJson(recordFile(root, rec.asset), { ...rec, verdict: null, reopened: { by, why: String(why).slice(0, 300), at, was: { verdict: rec.verdict, by: rec.by } }, history: [...(rec.history || []), { verdict: 'reopened', by, why: String(why).slice(0, 300), at }].slice(-20) });
  emitEvent({ type: 'asset.review_requested', agent: by, task: rec.task, to: rec.role || 'producer', msg: `${rec.asset}'s review (${rec.verdict} by ${rec.by}) was reverted by ${by}: it waits for a new review${why ? ` (${why})` : ''}`.slice(0, 400), meta: { asset: rec.asset, reopened: true } });
  return { ok: true, message: `${rec.asset} waits for a new review (its ${rec.verdict} by ${rec.by} is reverted; if ${rec.task} already landed, the asset is on main: review it again and fix forward)` };
}

async function main(argv) {
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const [cmd, name] = argv;
  if (cmd === 'reviews') {
    const p = pendingReviews();
    console.log(p.length ? p.map((r) => `${r.asset}  ${r.task || ''}${r.reviewTask ? ` review ${r.reviewTask}` : ''}  since ${r.at || '?'}  ${r.request}`).join('\n') : 'No asset waits for a review.');
    return 0;
  }
  if (cmd === 'review') {
    const verdict = argv.includes('--pass') ? 'pass' : argv.includes('--fail') ? 'fail' : null;
    if (argv.includes('--pass') && argv.includes('--fail')) { console.error('[asset-review] --pass or --fail, not both'); return 2; }
    const t = await import('./task.mjs');
    const r = await recordVerdict({ asset: name, verdict, why: flag('fail') || flag('why') || '', by: flag('by') || '', permission: flag('permission') || '', board: { addTask: t.addTask, dropTask: t.dropTask, parseNextQueue: t.parseNextQueue } });
    (r.ok ? console.log : console.error)(`[asset-review] ${r.message}`);
    return r.ok ? 0 : 2;
  }
  if (cmd === 'check' && name) {
    const r = checkPreviews(REPO_ROOT, slash(name));
    console.log(JSON.stringify(r, null, 2));
    return r.failures.length ? 1 : 0;
  }
  console.log('Usage: npm run asset -- review <asset> --pass --by <name>\n       npm run asset -- review <asset> --fail "what is wrong" --by <name> [--permission "<their words>"]\n       npm run asset -- reviews\n       node harness/asset-review.mjs check <model file>      the preview checks alone');
  return cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0;
}

// No top-level await: the review command imports task.mjs, which imports this module (a cycle that awaits would hang).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`[asset-review] ${err.stack || err.message}`); process.exitCode = 1; });
}
