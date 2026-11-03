/**
 * qa/chromium.mjs — start a Chromium for the browser checks, wherever this runs.
 *
 * Order: PLAYWRIGHT_CHROMIUM, a preinstalled /opt/pw-browsers/chromium, Playwright's own download
 * (npx playwright install chromium), then the Chrome or Edge already on the machine. On Windows,
 * Gemini's Solar Outpost run found the checks looked only in /opt/pw-browsers and failed; Chrome and
 * Edge are now tried there by their usual paths and by Playwright's channels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { browserGpuMode, machineProfile } from '../harness/heavy-budget.mjs';

/**
 * 2.70.0 (t): headless Chromium renders WebGL on the CPU (SwiftShader) unless told otherwise, so browser playtests
 * kept the CPU busy while the GPU sat at 1-7%. STUDIO_BROWSER_GPU=on|off|auto (default off; auto = on when the machine
 * scan shows a GPU) adds these flags. UNVERIFIED on the crew's PC: whether they give a hardware renderer there is not
 * known yet, so the run's report records the renderer the page actually got (pageRenderer) and says once when the
 * flags are on but a CPU renderer (SwiftShader, llvmpipe) is in use.
 */
export function browserGpuFlags(platform = process.platform) {
  if (platform === 'win32') return ['--enable-gpu', '--use-angle=d3d11'];
  if (platform === 'darwin') return ['--use-angle=metal'];
  return ['--enable-gpu', '--use-gl=angle'];
}
/** { on, mode, why, flags }: the GPU setting for this launch (the machine scan from the studio root, for auto). */
export function browserGpu(env = process.env, { platform = process.platform, root = process.cwd(), profile } = {}) {
  let p = profile;
  if (p === undefined) { try { p = machineProfile(root, { env }); } catch { p = null; } }
  const m = browserGpuMode(env, p);
  return { ...m, flags: m.on ? browserGpuFlags(platform) : [] };
}
/** A renderer name that means WebGL runs on the CPU. */
export const isCpuRenderer = (name) => /swiftshader|llvmpipe|softpipe|software|basic render driver/i.test(String(name || ''));
/** The page's WebGL renderer: { renderer, vendor, unmasked } (UNMASKED_RENDERER via the debug extension when available), or null. */
export async function pageRenderer(page) {
  try {
    return await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return { renderer: null, vendor: null, unmasked: false, webgl: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      return { renderer: r ? String(r) : null, vendor: v ? String(v) : null, unmasked: Boolean(ext), webgl: true };
    });
  } catch { return null; }
}
let cpuNoteSaid = false;
/**
 * What a run's report records about rendering: { gpu: mode, flags, renderer, vendor, cpuRenderer, note? }. With the
 * flags on and a CPU renderer in use it says "GPU flags on but CPU renderer in use" once per process (log). With
 * STUDIO_RENDERER_FILE set (harness/visual-proof.mjs sets it for a capture) the record is also written there, so the
 * visual baseline knows which renderer drew it.
 */
export async function rendererReport(browser, page, { log = (m) => console.error(m), env = process.env } = {}) {
  const g = browser?.__gpu || { mode: 'off', on: false, flags: [] };
  const r = page ? await pageRenderer(page) : null;
  const out = { gpu: g.mode || 'off', flags: g.flags || [], renderer: r?.renderer ?? null, vendor: r?.vendor ?? null, unmasked: Boolean(r?.unmasked), cpuRenderer: r?.renderer ? isCpuRenderer(r.renderer) : null };
  if (g.on && out.cpuRenderer) {
    out.note = `GPU flags on but CPU renderer in use (${out.renderer}); the flags are UNVERIFIED on this machine`;
    if (!cpuNoteSaid) { cpuNoteSaid = true; try { log(`[browser] ${out.note}`); } catch {} }
  }
  if (env.STUDIO_RENDERER_FILE) { try { fs.mkdirSync(path.dirname(env.STUDIO_RENDERER_FILE), { recursive: true }); fs.writeFileSync(env.STUDIO_RENDERER_FILE, `${JSON.stringify({ ...out, at: new Date().toISOString() })}\n`); } catch {} }
  return out;
}

/** Browsers to try, in order, as Playwright launch options. */
export function chromiumCandidates(env = process.env, platform = process.platform) {
  const out = [];
  const add = (o, label) => out.push({ opts: o, label });
  if (env.PLAYWRIGHT_CHROMIUM) add({ executablePath: env.PLAYWRIGHT_CHROMIUM }, `PLAYWRIGHT_CHROMIUM (${env.PLAYWRIGHT_CHROMIUM})`);
  if (fs.existsSync('/opt/pw-browsers/chromium')) add({ executablePath: '/opt/pw-browsers/chromium' }, '/opt/pw-browsers/chromium');
  add({}, "Playwright's Chromium");
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      for (const rel of ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']) {
        const p = path.win32.join(r, rel);
        if (fs.existsSync(p)) add({ executablePath: p }, p);
      }
    }
    add({ channel: 'chrome' }, 'Chrome (channel)');
    add({ channel: 'msedge' }, 'Edge (channel)');
  } else if (platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) if (fs.existsSync(p)) add({ executablePath: p }, p);
  } else {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
      const w = spawnSync('which', [name], { windowsHide: true, encoding: 'utf8' });
      const p = (w.stdout || '').trim();
      if (w.status === 0 && p) add({ executablePath: p }, p);
    }
  }
  return out;
}

/**
 * Launch the first browser that starts. Returns the browser (with __gpu: the GPU setting it got), or { error, tried }
 * when none did.
 */
export async function launchChromium(chromium, extra = {}, { env = process.env, platform = process.platform, profile } = {}) {
  const tried = [];
  let last = null;
  // 2.70.0 (t): the GPU flags when STUDIO_BROWSER_GPU says so (added once, beside the caller's own args).
  const gpu = browserGpu(env, { platform, profile });
  const opts = gpu.flags.length ? { ...extra, args: [...new Set([...(extra.args || []), ...gpu.flags])] } : extra;
  for (const c of chromiumCandidates(env, platform)) {
    try {
      const b = await chromium.launch({ ...opts, ...c.opts });
      b.__from = c.label;
      b.__gpu = gpu;
      return b;
    } catch (err) {
      last = err;
      tried.push(c.label);
    }
  }
  return { error: last || new Error('no browser found'), tried };
}
