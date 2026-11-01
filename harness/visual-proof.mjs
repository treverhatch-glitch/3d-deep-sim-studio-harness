#!/usr/bin/env node
/**
 * harness/visual-proof.mjs — 2.30o: a render task proves itself with pictures.
 *
 * In the Marina run Godot tasks passed with no visible change (a boat that never moved, a scene that
 * looked the same). A render task (Godot, graphics, visuals, a scene, a model) now needs before/after
 * captures from fixed, named cameras:
 *
 *   .studio/proof/<TASK>/visual/before/<camera>.png     taken when the task starts (or by `capture`)
 *   .studio/proof/<TASK>/visual/after/<camera>.png      taken before `task done`
 *
 * The check fails when a capture is missing, a frame is blank (almost no luminance variation, or almost
 * fully transparent), or a before/after pair is near-identical (mean luminance change below
 * STUDIO_VISUAL_DIFF_MIN, 0.01 = 1%; 2.65.0: or STUDIO_VISUAL_NOISE_K times the camera's measured noise, see
 * visualLimits). The result is written as the `visual` part of the task's verdict
 * (harness/verdict-split.mjs).
 *
 * Godot capture (a real frame, not an editor check): import headless, then run the main scene with a
 * window under OpenGL (`--rendering-driver opengl3`; the dummy headless renderer draws nothing), through
 * xvfb-run when there is no display, and save one PNG per camera. Cameras: Camera3D/Camera2D nodes named in
 * --cams (or the project's studio.cameras list, or every camera in the group "studio_capture").
 *
 *   node harness/visual-proof.mjs capture <TASK> before|after --godot <project> [--cams a,b] [--frames 30]
 *   node harness/visual-proof.mjs capture <TASK> before|after [--cams a,b]   (the game's own capture command)
 *   node harness/visual-proof.mjs check <TASK> [--json]           exit 1 when the visual proof fails
 *   node harness/visual-proof.mjs stats <file.png>                  blank-frame numbers for one image
 *   node harness/visual-proof.mjs diff <a.png> <b.png>              mean change between two images
 *
 * 2.59.0: a game that isn't a Godot project (a web game, any engine) names its own capture command in its check
 * manifest, <game root>/studio.gates.json: "visual": { "capture": "node tools/capture.mjs {out} {cams}" }. The
 * command writes one <camera>.png per camera into {out}; the same before/after check applies. The manifest is a
 * protected file, so the owner approves the command once. Placeholders: {out} (absolute folder), {cams} (comma
 * list, may be empty), {task}, {phase} (before|after).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { decodePng } from './png.mjs';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { gameCapture } from './visual-capture.mjs';

const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
/**
 * 2.65.0: the noise baseline. Two captures of unchanged code differed by 0.58-0.68% (the crew's web game), against the
 * 1% "near-identical" line: a small real change might not clear the noise. So "before" is captured twice per camera
 * (before/ and before-noise/), and a camera's change must reach max(diffMin, noiseK x its measured noise)
 * (STUDIO_VISUAL_NOISE_K, 2). That bar is capped (STUDIO_VISUAL_NOISE_CAP, 0.05): a camera whose bar would pass the
 * cap is too noisy to judge, an error naming it, never a pass. A camera with no second before capture is judged
 * against diffMin as before (and the check says no noise was measured).
 */
export const visualLimits = (env = process.env) => ({
  diffMin: num(env.STUDIO_VISUAL_DIFF_MIN, 0.01),
  blankStd: num(env.STUDIO_VISUAL_BLANK_STD, 0.02),
  minOpaque: num(env.STUDIO_VISUAL_MIN_OPAQUE, 0.5),
  noiseK: Math.max(1, num(env.STUDIO_VISUAL_NOISE_K, 2)),
  noiseCap: Math.min(0.5, Math.max(0.001, num(env.STUDIO_VISUAL_NOISE_CAP, 0.05))),
});
/** The second "before" capture, for the noise baseline. */
export const NOISE_SIDE = 'before-noise';
/** The change a camera must show: { need, noise, tooNoisy }. noise null: not measured. */
export function noiseBar(noise, limits = visualLimits()) {
  if (noise === null || noise === undefined || !Number.isFinite(noise)) return { need: limits.diffMin, noise: null, tooNoisy: false };
  const need = Math.max(limits.diffMin, limits.noiseK * noise);
  return { need: +need.toFixed(5), noise, tooNoisy: need > limits.noiseCap };
}

export const proofDir = (task) => path.join(STUDIO_STATE_DIR, 'proof', task, 'visual');

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Luminance on a fixed grid (so different sizes compare), plus opacity. */
function grid(img, n = 64) {
  const out = new Float64Array(n * n);
  let opaque = 0;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const x = Math.min(img.width - 1, Math.floor(((gx + 0.5) * img.width) / n));
      const y = Math.min(img.height - 1, Math.floor(((gy + 0.5) * img.height) / n));
      const i = (y * img.width + x) * 4;
      const a = img.rgba[i + 3] / 255;
      if (a > 0.5) opaque++;
      out[gy * n + gx] = lum(img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]) * a;
    }
  }
  return { cells: out, opaque: opaque / (n * n) };
}

/** Blank-frame numbers: luminance mean and standard deviation, the opaque share, and the verdict. */
export function imageStats(img, limits = visualLimits()) {
  const { cells, opaque } = grid(img);
  let m = 0;
  for (const v of cells) m += v;
  m /= cells.length;
  let s = 0;
  for (const v of cells) s += (v - m) ** 2;
  const std = Math.sqrt(s / cells.length);
  const blank = std < limits.blankStd || opaque < limits.minOpaque;
  return { width: img.width, height: img.height, mean: +m.toFixed(4), std: +std.toFixed(4), opaque: +opaque.toFixed(3), blank, why: blank ? (opaque < limits.minOpaque ? `mostly transparent (${Math.round(opaque * 100)}% opaque)` : `blank: luminance barely varies (std ${std.toFixed(4)} < ${limits.blankStd})`) : '' };
}

/** Mean absolute luminance change between two images on the same grid (0..1). */
export function imageDiff(a, b) {
  const ga = grid(a).cells; const gb = grid(b).cells;
  let d = 0;
  for (let i = 0; i < ga.length; i++) d += Math.abs(ga[i] - gb[i]);
  return +(d / ga.length).toFixed(5);
}

const load = (f) => decodePng(fs.readFileSync(f));
const pngs = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png')).sort() : []);

/** Check a task's visual proof: { ok, cameras: [...], why } */
export function checkVisualProof(task, { dir = proofDir(task), limits = visualLimits() } = {}) {
  const before = pngs(path.join(dir, 'before'));
  const after = pngs(path.join(dir, 'after'));
  const problems = [];
  const cameras = [];
  if (!after.length) problems.push(`no after captures in ${path.relative(REPO_ROOT, path.join(dir, 'after')) || dir}`);
  if (!before.length) problems.push(`no before captures in ${path.relative(REPO_ROOT, path.join(dir, 'before')) || dir}`);
  for (const f of after) {
    const cam = f.replace(/\.png$/i, '');
    const row = { camera: cam };
    try {
      const A = load(path.join(dir, 'after', f));
      row.after = imageStats(A, limits);
      if (row.after.blank) problems.push(`${cam}: after frame is ${row.after.why}`);
      if (!before.includes(f)) problems.push(`${cam}: no before capture from the same camera`);
      else {
        const B = load(path.join(dir, 'before', f));
        row.before = imageStats(B, limits);
        row.diff = imageDiff(B, A);
        // 2.65.0: the camera's own noise (two captures of the same code), when a second before capture exists.
        const nf = path.join(dir, NOISE_SIDE, f);
        const bar = noiseBar(fs.existsSync(nf) ? imageDiff(B, load(nf)) : null, limits);
        row.noise = bar.noise;
        row.need = bar.need;
        const pct = (x) => `${(x * 100).toFixed(2)}%`;
        const barWords = bar.noise === null ? `${pct(bar.need)}; no noise measured: no ${NOISE_SIDE} capture` : `${pct(bar.need)}: ${bar.need > limits.diffMin ? `${limits.noiseK} x its noise ${pct(bar.noise)}` : `the minimum; its noise is ${pct(bar.noise)}`}`;
        row.bar = barWords;
        if (bar.tooNoisy) { row.tooNoisy = true; problems.push(`${cam}: the scene is too noisy to judge: two captures of the same code differ by ${pct(bar.noise)}, so a change would have to reach ${pct(bar.need)}, over the cap ${pct(limits.noiseCap)} (STUDIO_VISUAL_NOISE_CAP); make the capture steady (fixed seed, time and animation) and capture before again`); }
        else if (row.diff < bar.need) problems.push(`${cam}: before and after are near-identical (change ${pct(row.diff)} < ${barWords})`);
      }
    } catch (e) {
      problems.push(`${cam}: unreadable capture (${e.message})`);
    }
    cameras.push(row);
  }
  const noise = cameras.filter((c) => c.noise !== undefined).map((c) => `${c.camera}: change ${c.diff === undefined ? 'n/a' : `${(c.diff * 100).toFixed(2)}%`}, needs ${c.bar}`);
  return { ok: problems.length === 0, cameras, problems, why: problems.join('; '), noise };
}

/**
 * 2.65.0: capture "before" for the noise baseline: the capture into before/, then the same again into before-noise/.
 * capture(outDir) -> { ok, files, why, log }. The second run failing leaves no noise folder (the check then says no
 * noise was measured), never a failed before.
 */
export function captureBeforeTwice(capture, dir) {
  const first = capture(path.join(dir, 'before'));
  const nd = path.join(dir, NOISE_SIDE);
  try { fs.rmSync(nd, { recursive: true, force: true }); } catch {}
  if (!first.ok || /^(off|0|false|no)$/i.test(String(process.env.STUDIO_VISUAL_NOISE || ''))) return { ...first, noise: false };
  const second = capture(nd);
  if (!second.ok) { try { fs.rmSync(nd, { recursive: true, force: true }); } catch {} }
  return { ...first, noise: second.ok, noiseWhy: second.ok ? '' : second.why };
}

/** The GDScript that captures named cameras; written fresh each run (harness-owned, not the game's). */
export function captureScript() {
  return `extends SceneTree
# 2.30o studio capture: load the main scene, let it settle, save one PNG per named camera.
var cams: PackedStringArray
var out_dir := ""
var settle := 30
var frame := 0
var queue: Array = []
var current = null
var wait := 0
func _initialize() -> void:
\tvar args := OS.get_cmdline_user_args()
\tfor i in args.size():
\t\tif args[i] == "--out": out_dir = args[i + 1]
\t\telif args[i] == "--cams": cams = args[i + 1].split(",", false)
\t\telif args[i] == "--frames": settle = int(args[i + 1])
\tvar scene = load(ProjectSettings.get_setting("application/run/main_scene"))
\tif scene == null:
\t\tprint("ERROR: studio capture: the main scene did not load")
\t\tquit(2)
\t\treturn
\troot.add_child(scene.instantiate())
func _all_cams(n: Node, acc: Array) -> void:
\tif n is Camera3D or n is Camera2D: acc.append(n)
\tfor c in n.get_children(): _all_cams(c, acc)
func _process(_d: float) -> bool:
\tframe += 1
\tif frame == settle:
\t\tvar found: Array = []
\t\t_all_cams(root, found)
\t\tif cams.is_empty():
\t\t\tfor c in found:
\t\t\t\tif c.is_in_group("studio_capture"): cams.append(c.name)
\t\tif cams.is_empty() and found.size() > 0: cams.append(found[0].name)
\t\tfor name in cams:
\t\t\tvar hit = null
\t\t\tfor c in found:
\t\t\t\tif c.name == name: hit = c
\t\t\tif hit == null: print("ERROR: studio capture: no camera named ", name)
\t\t\telse: queue.append(hit)
\t\tif queue.is_empty():
\t\t\tquit(3)
\t\treturn false
\tif frame > settle:
\t\tif current == null:
\t\t\tif queue.is_empty():
\t\t\t\tquit(0)
\t\t\t\treturn false
\t\t\tcurrent = queue.pop_front()
\t\t\tcurrent.make_current()
\t\t\twait = 3
\t\telif wait > 0:
\t\t\twait -= 1
\t\telse:
\t\t\tvar img := root.get_viewport().get_texture().get_image()
\t\t\tvar p := out_dir.path_join(String(current.name) + ".png")
\t\t\timg.save_png(p)
\t\t\tprint("studio capture: saved ", p)
\t\t\tcurrent = null
\treturn false
`;
}

const has = (bin) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

/** Capture a Godot project's named cameras into outDir. Returns { ok, files, why, log }. */
export function captureGodot(project, outDir, { cams = [], frames = 30, bin = process.env.STUDIO_GODOT || 'godot', timeoutMs = num(process.env.STUDIO_GODOT_TIMEOUT_MS, 300000) } = {}) {
  const proj = path.resolve(REPO_ROOT, project);
  if (!fs.existsSync(path.join(proj, 'project.godot'))) return { ok: false, files: [], why: `no project.godot in ${project}` };
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of pngs(outDir)) fs.rmSync(path.join(outDir, f));
  const scriptFile = path.join(os.tmpdir(), `studio-capture-${process.pid}-${Date.now()}.gd`);
  fs.writeFileSync(scriptFile, captureScript());
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const opts = { cwd: REPO_ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, shell };
  let log = '';
  const imp = spawnSync(bin, ['--headless', '--path', proj, '--import'], opts);
  log += `${imp.stdout || ''}${imp.stderr || ''}`;
  if (imp.error) { fs.rmSync(scriptFile, { force: true }); return { ok: false, files: [], why: `could not run Godot (${bin}): ${imp.error.code || imp.error.message}`, log }; }
  const runArgs = ['--path', proj, '--rendering-driver', process.env.STUDIO_GODOT_CAPTURE_DRIVER || 'opengl3', '--resolution', process.env.STUDIO_GODOT_CAPTURE_SIZE || '1280x720', '--script', scriptFile, '--', '--out', path.resolve(outDir), '--frames', String(frames), ...(cams.length ? ['--cams', cams.join(',')] : [])];
  const needX = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const r = needX && has('xvfb-run')
    ? spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x720x24', bin, ...runArgs], opts)
    : spawnSync(bin, runArgs, opts);
  log += `${r.stdout || ''}${r.stderr || ''}`;
  fs.rmSync(scriptFile, { force: true });
  const files = pngs(outDir);
  const err = log.split('\n').find((l) => /studio capture: no camera|main scene did not load|SCRIPT ERROR|Parse Error/.test(l));
  if (r.error) return { ok: false, files, why: `capture run failed: ${r.error.code || r.error.message}`, log };
  if (!files.length) return { ok: false, files, why: `no frames saved (exit ${r.status})${err ? `: ${err.trim()}` : ''}`, log };
  return { ok: !err, files, why: err ? err.trim() : '', log };
}

const quoteArg = (v) => (process.platform === 'win32' ? `"${String(v).replace(/"/g, '""')}"` : `'${String(v).replace(/'/g, `'\\''`)}'`);

/** 2.59.0: run the game's own capture command into outDir. Returns { ok, files, why, log } like captureGodot. */
export function captureWithCommand(template, outDir, { cams = [], task = '', phase = '', timeoutMs = num(process.env.STUDIO_VISUAL_CAPTURE_TIMEOUT_MS, 300000) } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of pngs(outDir)) fs.rmSync(path.join(outDir, f));
  const vals = { out: path.resolve(outDir), cams: cams.join(','), task, phase };
  const cmd = template.replace(/\{(out|cams|task|phase)\}/g, (_, k) => (vals[k] === '' ? '""' : quoteArg(vals[k])));
  const r = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const log = `${r.stdout || ''}${r.stderr || ''}`;
  const files = pngs(outDir);
  if (r.error) return { ok: false, files, why: `capture command failed: ${r.error.code || r.error.message}`, log };
  if (r.status !== 0) return { ok: false, files, why: `capture command exited ${r.status}`, log };
  if (!files.length) return { ok: false, files, why: 'the capture command saved no .png in {out}', log };
  return { ok: true, files, why: '', log };
}

/** Record the visual result in the task's split verdict. */
export async function recordVisual(task, res) {
  const { setPart } = await import('./verdict-split.mjs');
  // 2.65.0: each camera's noise and the bar it had to clear go into the verdict (the proof JSON) too.
  return setPart(task, 'visual', { ok: res.ok, why: res.why || (res.noise?.length ? `noise baseline: ${res.noise.join('; ')}` : ''), evidence: res.cameras?.map((c) => `${c.camera}: change ${c.diff ?? 'n/a'}${c.noise !== undefined ? `, noise ${c.noise ?? 'not measured'}, needs ${c.need}${c.tooNoisy ? ' (too noisy to judge)' : ''}` : ''}`) || [] });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2);
  const opt = (k, d = null) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const [cmd, x, y] = a;
  if (cmd === 'stats' && x) { console.log(JSON.stringify(imageStats(load(x)))); process.exit(0); }
  if (cmd === 'diff' && x && y) { console.log(JSON.stringify({ diff: imageDiff(load(x), load(y)) })); process.exit(0); }
  if (cmd === 'capture' && x && /^(before|after)$/.test(y || '') && opt('--godot')) {
    const cap = (d) => captureGodot(opt('--godot'), d, { cams: String(opt('--cams', '')).split(',').filter(Boolean), frames: num(opt('--frames'), 30) });
    const res = y === 'before' ? captureBeforeTwice(cap, proofDir(x)) : cap(path.join(proofDir(x), y));
    if (y === 'before' && res.ok) console.log(`[visual] noise baseline: ${res.noise ? `captured before twice (${NOISE_SIDE}/)` : `no second capture${res.noiseWhy ? ` (${res.noiseWhy})` : ''}; the check uses the plain ${(visualLimits().diffMin * 100).toFixed(2)}%`}`);
    console.log(`[visual] ${res.ok ? 'captured' : 'FAIL'} ${y} for ${x}: ${res.files.join(', ') || 'nothing'}${res.why ? ` (${res.why})` : ''}`);
    if (!res.ok && res.log) console.log(res.log.split('\n').slice(-15).join('\n'));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'capture' && x && /^(before|after)$/.test(y || '') && !opt('--godot')) {
    const g = gameCapture();
    if (!g.capture) {
      console.log(`[visual] FAIL ${y} for ${x}: no capture command. ${g.godot ? `This is a Godot project: add --godot ${g.root}.` : g.manifest ? `The owner adds "visual": { "capture": "..." } to ${g.manifest}.` : 'Pass --godot <project>, or set the game (studio/game.json) and its capture command.'}`);
      process.exit(1);
    }
    const cap = (d) => captureWithCommand(g.capture, d, { cams: String(opt('--cams', '')).split(',').filter(Boolean), task: x, phase: y });
    const res = y === 'before' ? captureBeforeTwice(cap, proofDir(x)) : cap(path.join(proofDir(x), y));
    if (y === 'before' && res.ok) console.log(`[visual] noise baseline: ${res.noise ? `captured before twice (${NOISE_SIDE}/)` : `no second capture${res.noiseWhy ? ` (${res.noiseWhy})` : ''}; the check uses the plain ${(visualLimits().diffMin * 100).toFixed(2)}%`}`);
    console.log(`[visual] ${res.ok ? 'captured' : 'FAIL'} ${y} for ${x}: ${res.files.join(', ') || 'nothing'}${res.why ? ` (${res.why})` : ''}`);
    if (!res.ok && res.log) console.log(res.log.split('\n').slice(-15).join('\n'));
    process.exit(res.ok ? 0 : 1);
  }
  if (cmd === 'check' && x) {
    const res = checkVisualProof(x);
    await recordVisual(x, res);
    emitEvent({ type: res.ok ? 'visual.pass' : 'visual.fail', agent: process.env.STUDIO_LOCK_OWNER || 'harness', task: x, msg: `${x} visual proof ${res.ok ? 'passed' : `failed: ${res.why}`}`.slice(0, 400) });
    if (a.includes('--json')) console.log(JSON.stringify(res));
    else console.log(`[visual] ${res.ok ? 'PASS' : 'FAIL'} ${x}${res.why ? `: ${res.why}` : ''}${res.ok && res.noise?.length ? ` (noise baseline: ${res.noise.join('; ')})` : ''}`);
    process.exit(res.ok ? 0 : 1);
  }
  console.log('Usage: node harness/visual-proof.mjs capture <TASK> before|after [--godot <project>] [--cams a,b] | check <TASK> | stats <png> | diff <a> <b>');
  process.exit(2);
}
