#!/usr/bin/env node
/**
 * harness/vfx.mjs — 2.56.0 (PU-15): a spec, stepped capture and frame checks for visual effects (particles,
 * VFX, UI feedback such as hit flashes and button presses), in any genre, 2D or 3D.
 *
 *   npm run vfx -- new <id> [--kind one-shot|loop] [--ms 400]   write a starter spec: studio/vfx/<id>.json
 *   npm run vfx -- validate <id>                                 check the spec itself
 *   npm run vfx -- check <id> [--url <page>] [--task T-12]       capture stills, a contact sheet, run the checks
 *   npm run vfx -- list                                          specs and their last result
 *
 * The idea (from the effect-authoring pattern reviewed in studio/logs/research/PIXELFX-REVIEW-2026-10-31.md;
 * ideas only, no code taken): an effect is judged from stills taken at fixed effect times, never by recording
 * in real time. A headless browser with no GPU can draw a 3D scene at a fraction of a frame per second, but a
 * handful of small stills still takes about a minute.
 *
 * The game's side: a page (in playtest mode, never in a player build) exposes
 *   window.__studioVfx = {
 *     render(id, { tMs, seed, w, h }),   // draw effect `id` as it looks `tMs` after it starts; tMs < 0 clears it
 *   }
 * drawing into an element with id "studio-vfx-stage" of w x h pixels on a fixed background. It may return a
 * promise. Engines (Godot, Unity): the same contract through STUDIO_VFX_CAPTURE_CMD, a command that writes one PNG
 * per requested time ({id} {seed} {w} {h} {times} {out}); documented here, not built or tested yet.
 *
 * Checks (by rule, on the captured frames; taste is left to the art review):
 *   ends-empty     a one-shot's last frame is back to the background
 *   loop-seam      a loop's frame at the end matches its frame at the start (no jump where it wraps)
 *   stays-inside   nothing touches the stage edge (an effect clipped by, or spilling past, its bounds)
 *   flash-rate     no more than spec.flash.maxPerSecond (default 3) full-stage flashes a second
 *   same-seed      the same seed draws the same frame twice (no unseeded randomness)
 *   draws          something is drawn at all (a blank effect isn't a pass)
 * Results: .studio/vfx/<id>/report.json, contact.png, frames/; an event vfx.checked; --task copies the contact
 * sheet and report to studio/proof/<task>/ for the reviewer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';

export const SPEC_DIR = (root = REPO_ROOT) => path.join(root, 'studio', 'vfx');
export const OUT_DIR = (id) => path.join(STUDIO_STATE_DIR, 'vfx', id);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** A starter spec: every field a person or agent fills in before building the effect. */
export function starterSpec(id, { kind = 'one-shot', ms = 400 } = {}) {
  const third = Math.round(ms / 3);
  return {
    id,
    communicates: 'What the player should understand at a glance (e.g. "the hit landed", "the button took the press")',
    kind,
    durationMs: ms,
    phases: kind === 'loop' ? [{ name: 'cycle', ms }] : [{ name: 'anticipation', ms: third }, { name: 'impact', ms: third }, { name: 'dissipate', ms: ms - 2 * third }],
    stage: { w: 192, h: 192, background: '#000000' },
    anchor: 'center',
    palette: [],
    budget: { frameMs: 2, note: 'how much of a frame the effect may cost in the game' },
    flash: { maxPerSecond: 3, fullStageShare: 0.5 },
    seed: 1,
    frames: 12,
    url: null,
  };
}

/** Problems with a spec, as sentences (empty when it's usable). */
export function validateSpec(s) {
  const p = [];
  if (!s || typeof s !== 'object') return ['not a JSON object'];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(s.id || ''))) p.push('id: lower-case letters, digits and dashes');
  if (!String(s.communicates || '').trim() || /^What the player should understand/.test(s.communicates)) p.push('communicates: say what the effect tells the player');
  if (!['one-shot', 'loop'].includes(s.kind)) p.push('kind: "one-shot" or "loop"');
  if (!(Number(s.durationMs) > 0)) p.push('durationMs: how long one play (or one loop cycle) lasts, in ms');
  if (!Array.isArray(s.phases) || !s.phases.length) p.push('phases: at least one { name, ms }');
  else {
    const sum = s.phases.reduce((a, x) => a + (Number(x.ms) || 0), 0);
    if (sum !== Number(s.durationMs)) p.push(`phases add up to ${sum} ms, not durationMs ${s.durationMs}`);
  }
  if (!(Number(s.stage?.w) >= 16 && Number(s.stage?.h) >= 16 && Number(s.stage.w) <= 1024 && Number(s.stage.h) <= 1024)) p.push('stage: { w, h } between 16 and 1024 pixels (small stills are the point)');
  if (!(Number(s.frames) >= 4 && Number(s.frames) <= 32)) p.push('frames: 4 to 32 stills for the contact sheet');
  if (!Number.isInteger(Number(s.seed))) p.push('seed: an integer, so a capture repeats');
  if (s.flash && !(Number(s.flash.maxPerSecond) > 0 && Number(s.flash.maxPerSecond) <= 3)) p.push('flash.maxPerSecond: at most 3 (photosensitivity guidance)');
  return p;
}

/** The effect times to capture for the contact sheet: from 0 to the end, evenly. */
export function sampleTimes(spec) {
  const n = Number(spec.frames) || 12;
  const d = Number(spec.durationMs);
  return Array.from({ length: n }, (_, i) => Math.round((d * i) / (n - 1)));
}

/** Dense times for the flash check: 30 a second (at most 120), never real time. */
export function flashTimes(spec) {
  const d = Number(spec.durationMs);
  const n = Math.min(120, Math.max(8, Math.ceil((d / 1000) * 30)));
  return Array.from({ length: n }, (_, i) => Math.round((d * i) / (n - 1)));
}

/**
 * Judge an effect from frame measurements. stats = {
 *   frames: [{ t, changed, edge, lum }],   changed: share of stage pixels differing from the background; edge:
 *                                         changed pixels on the stage border; lum: mean luminance 0..1
 *   dense: [{ t, changed, lum }],          the flash pass
 *   seam: share differing between t = 0 and t = end (loops), same: share differing between two renders of one
 *   time with one seed }
 */
export function judge(spec, stats) {
  const checks = [];
  const add = (id, ok, why) => checks.push({ id, ok: Boolean(ok), why: ok ? '' : why });
  const frames = stats.frames || [];
  const maxChanged = Math.max(0, ...frames.map((f) => f.changed));
  add('draws', maxChanged > 0.002, 'nothing was drawn on the stage at any captured time (is the hook drawing into #studio-vfx-stage?)');
  if (spec.kind === 'one-shot') {
    // Measured against the effect's own size, so a small effect's leftovers count as much as a big one's.
    const last = frames[frames.length - 1];
    const left = last ? last.changed / Math.max(maxChanged, 1e-6) : 1;
    add('ends-empty', last && last.changed <= 0.005 && left <= 0.05, `the last frame (t=${last?.t} ms) still shows ${(100 * left).toFixed(0)}% of the effect at its largest: a one-shot must end back at the background`);
  } else {
    // The jump where the loop wraps, against how much the effect draws at those two moments.
    const a = frames[0]?.changed || 0;
    const b = frames[frames.length - 1]?.changed || 0;
    const jump = (stats.seam ?? 1) / Math.max(a, b, 1e-6);
    add('loop-seam', jump <= 0.25, `the frame at the end of the cycle differs from the start by ${(100 * jump).toFixed(0)}% of what the effect draws there: the loop jumps where it wraps`);
  }
  const edgy = frames.filter((f) => f.edge > 0);
  if (!spec.allowEdge) add('stays-inside', !edgy.length, `drawn pixels touch the stage edge at t=${edgy.slice(0, 4).map((f) => f.t).join(', ')} ms: the effect is clipped by, or spills past, its bounds`);
  const share = Number(spec.flash?.fullStageShare) || 0.5;
  const max = Number(spec.flash?.maxPerSecond) || 3;
  let flashes = 0;
  const dense = stats.dense || [];
  for (let i = 1; i < dense.length; i++) if (dense[i].changed >= share && dense[i].lum - dense[i - 1].lum >= 0.25) flashes++;
  const perSecond = flashes / Math.max(0.001, Number(spec.durationMs) / 1000);
  add('flash-rate', perSecond <= max, `${flashes} full-stage flashes in ${spec.durationMs} ms (${perSecond.toFixed(1)} a second, limit ${max})`);
  add('same-seed', (stats.same ?? 1) === 0, `two renders of the same time with seed ${spec.seed} differ by ${(100 * (stats.same ?? 1)).toFixed(2)}%: the effect uses unseeded randomness`);
  return { ok: checks.every((c) => c.ok), checks };
}

/** Measure PNG frames in the browser (no image library needed): stats for judge(). */
async function measure(page, { blank, frames, dense, seamPair, samePair, bg }) {
  return page.evaluate(async ({ blank, frames, dense, seamPair, samePair, bg }) => {
    const load = (b64) => new Promise((res, rej) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.drawImage(im, 0, 0); res(x.getImageData(0, 0, c.width, c.height)); }; im.onerror = rej; im.src = `data:image/png;base64,${b64}`; });
    const tol = 24;
    const diff = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > tol) n++; return n / (a.data.length / 4); };
    const lum = (a) => { let s = 0; for (let i = 0; i < a.data.length; i += 4) s += (0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2]) / 255; return s / (a.data.length / 4); };
    const edge = (a, b) => { const w = a.width; const h = a.height; let n = 0; const on = (x, y) => { const i = (y * w + x) * 4; return Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > tol; }; for (let x = 0; x < w; x++) { if (on(x, 0)) n++; if (on(x, h - 1)) n++; } for (let y = 0; y < h; y++) { if (on(0, y)) n++; if (on(w - 1, y)) n++; } return n; };
    const B = await load(blank);
    const out = { frames: [], dense: [] };
    for (const f of frames) { const im = await load(f.png); out.frames.push({ t: f.t, changed: diff(im, B), edge: edge(im, B), lum: lum(im) }); }
    for (const f of dense) { const im = await load(f.png); out.dense.push({ t: f.t, changed: diff(im, B), lum: lum(im) }); }
    if (seamPair) out.seam = diff(await load(seamPair[0]), await load(seamPair[1]));
    if (samePair) out.same = diff(await load(samePair[0]), await load(samePair[1]));
    void bg;
    return out;
  }, { blank, frames, dense, seamPair, samePair, bg });
}

/** Lay the stills out as one contact-sheet PNG (an HTML grid, screenshotted). */
async function contactSheet(page, spec, frames, file) {
  const cols = Math.min(6, frames.length);
  const html = `<!doctype html><html><body style="margin:0;background:#222;font:12px sans-serif;color:#ddd"><div style="padding:8px">${spec.id} · ${spec.kind} · ${spec.durationMs} ms · seed ${spec.seed}</div><div id="g" style="display:grid;grid-template-columns:repeat(${cols},${spec.stage.w}px);gap:6px;padding:0 8px 8px">${frames.map((f) => `<div><img src="data:image/png;base64,${f.png}" width="${spec.stage.w}" height="${spec.stage.h}" style="display:block"><div>t=${f.t} ms</div></div>`).join('')}</div></body></html>`;
  await page.setContent(html);
  await page.locator('body').screenshot({ path: file });
}

/** Capture and check one effect. Returns { ok, report } or { error }. */
export async function checkEffect(spec, { url = null, task = null, log = console.log } = {}) {
  const problems = validateSpec(spec);
  if (problems.length) return { error: `the spec isn't usable: ${problems.join('; ')}` };
  const pageUrl = url || spec.url;
  if (!pageUrl) return { error: 'no page to capture from: pass --url <page> (or set "url" in the spec), a page that exposes window.__studioVfx in playtest mode' };
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { error: 'Playwright is not installed (npm i -D playwright, then npx playwright install chromium)' }; }
  const { launchChromium } = await import(pathToFileURL(path.join(REPO_ROOT, 'qa', 'chromium.mjs')).href);
  const browser = await launchChromium(chromium);
  if (browser.error) return { error: `Chromium did not start (${browser.error.message})` };
  const out = OUT_DIR(spec.id);
  fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(320, spec.stage.w + 40), height: Math.max(240, spec.stage.h + 40) } });
    const target = /^[a-z]+:\/\//i.test(pageUrl) ? pageUrl : pathToFileURL(path.resolve(REPO_ROOT, pageUrl)).href;
    await page.goto(target);
    await page.waitForFunction(() => Boolean(window.__studioVfx?.render), null, { timeout: 30000 });
    const stage = page.locator('#studio-vfx-stage');
    const shot = async (tMs, seed = spec.seed) => {
      await page.evaluate(async ({ id, tMs, seed, w, h }) => { await window.__studioVfx.render(id, { tMs, seed, w, h }); }, { id: spec.id, tMs, seed, w: spec.stage.w, h: spec.stage.h });
      return (await stage.screenshot()).toString('base64');
    };
    const blank = await shot(-1);
    const frames = [];
    for (const t of sampleTimes(spec)) frames.push({ t, png: await shot(t) });
    frames.forEach((f, i) => fs.writeFileSync(path.join(out, 'frames', `${String(i).padStart(2, '0')}-t${f.t}.png`), Buffer.from(f.png, 'base64')));
    const dense = [];
    for (const t of flashTimes(spec)) dense.push({ t, png: await shot(t) });
    const mid = Math.round(Number(spec.durationMs) / 2);
    const samePair = [await shot(mid), await shot(mid)];
    const seamPair = spec.kind === 'loop' ? [frames[0].png, frames[frames.length - 1].png] : null;
    const helper = await browser.newPage();
    const stats = await measure(helper, { blank, frames, dense, seamPair, samePair, bg: spec.stage.background });
    const verdict = judge(spec, stats);
    const contact = path.join(out, 'contact.png');
    await contactSheet(helper, spec, frames, contact);
    const report = { id: spec.id, at: new Date().toISOString(), ok: verdict.ok, checks: verdict.checks, url: pageUrl, frames: frames.map((f) => f.t), contact: path.relative(REPO_ROOT, contact).split(path.sep).join('/'), stats: { frames: stats.frames, seam: stats.seam ?? null, same: stats.same } };
    fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (task) {
      const dest = path.join(REPO_ROOT, 'studio', 'proof', task);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(contact, path.join(dest, `vfx-${spec.id}-contact.png`));
      fs.copyFileSync(path.join(out, 'report.json'), path.join(dest, `vfx-${spec.id}-report.json`));
    }
    emitEvent({ type: 'vfx.checked', agent: process.env.STUDIO_LOCK_OWNER || 'vfx', task: task || undefined, status: verdict.ok ? 'ok' : 'warn', msg: `${spec.id}: ${verdict.ok ? 'all checks pass' : `failed ${verdict.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`} (contact sheet ${report.contact})`, meta: { id: spec.id, failed: verdict.checks.filter((c) => !c.ok).map((c) => c.id) } });
    log(`[vfx] ${spec.id}: ${verdict.ok ? 'PASS' : 'FAIL'} — contact sheet ${report.contact}`);
    for (const c of verdict.checks) log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.id}${c.ok ? '' : `: ${c.why}`}`);
    return { ok: verdict.ok, report };
  } finally {
    await browser.close();
  }
}

export function readSpec(id, root = REPO_ROOT) {
  return readJson(path.join(SPEC_DIR(root), `${id}.json`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const [cmd, id] = argv;
  if (cmd === 'new' && id) {
    const f = path.join(SPEC_DIR(), `${id}.json`);
    if (fs.existsSync(f)) { console.error(`[vfx] ${path.relative(REPO_ROOT, f)} exists already`); process.exit(1); }
    fs.mkdirSync(SPEC_DIR(), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify(starterSpec(id, { kind: flag('kind') || 'one-shot', ms: Number(flag('ms')) || 400 }), null, 2)}\n`);
    console.log(`[vfx] wrote ${path.relative(REPO_ROOT, f)}: fill in what it communicates, its phases and stage, then npm run vfx -- check ${id} --url <page>`);
    process.exit(0);
  }
  if (cmd === 'validate' && id) {
    const s = readSpec(id);
    const p = s ? validateSpec(s) : [`no spec at studio/vfx/${id}.json (npm run vfx -- new ${id})`];
    console.log(p.length ? `[vfx] ${id}: ${p.length} problem(s)\n${p.map((x) => `  - ${x}`).join('\n')}` : `[vfx] ${id}: the spec is usable`);
    process.exit(p.length ? 1 : 0);
  }
  if (cmd === 'check' && id) {
    const s = readSpec(id);
    if (!s) { console.error(`[vfx] no spec at studio/vfx/${id}.json (npm run vfx -- new ${id})`); process.exit(1); }
    const r = await checkEffect(s, { url: flag('url'), task: flag('task') });
    if (r.error) { console.error(`[vfx] ${r.error}`); process.exit(2); }
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'list') {
    const dir = SPEC_DIR();
    const ids = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
    if (!ids.length) console.log('[vfx] no effect specs yet (npm run vfx -- new <id>)');
    for (const x of ids) { const r = readJson(path.join(OUT_DIR(x), 'report.json')); console.log(`  ${x}: ${r ? `${r.ok ? 'pass' : `FAIL ${r.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`} (${r.at.slice(0, 16)})` : 'not checked yet'}`); }
    process.exit(0);
  }
  console.log('Usage: npm run vfx -- new <id> [--kind one-shot|loop] [--ms 400] | validate <id> | check <id> [--url <page>] [--task T-12] | list');
  process.exit(cmd ? 1 : 0);
}
