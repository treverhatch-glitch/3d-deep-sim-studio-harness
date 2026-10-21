#!/usr/bin/env node
/**
 * qa/clip.mjs — a short gameplay video of the real build, to share or attach to a task.
 *
 *   npm run clip [-- --seconds 20] [--task T-012] [--name floor-3]
 *   npm run shot [-- --query "floor=3&cam=2,4,90"] [--wait 1500] [--task T-012]   one screenshot of the real build
 *
 * clip: plays the cartridge's scenario in the browser build with real input (the same run as
 * `npm run play:browser`), records it, and converts it to an mp4 under 10 MB with ffmpeg when ffmpeg
 * is installed (otherwise it keeps the .webm). Clips go to qa/reports/clips/ and show in the War Room's
 * Arcade view; with --task the clip is also copied to studio/proof/<task>/ so it travels with the commit.
 * shot: opens the build with extra query parameters (the game reads them in playtest mode to pick a
 * floor or pose the camera), waits, and saves a PNG to qa/reports/; add it as proof with npm run proof.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { playInBrowser } from './browser-play.mjs';

export const CLIPS = path.join(REPO_ROOT, 'qa', 'reports', 'clips');
const argv = process.argv.slice(2);
const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
const task = flag('task');
const keep = (file) => {
  if (!task) return null;
  const dest = path.join(REPO_ROOT, 'studio', 'proof', task, path.basename(file));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  return path.relative(REPO_ROOT, dest).split(path.sep).join('/');
};

if (argv[0] === 'shot' || process.env.npm_lifecycle_event === 'shot') {
  const { loadCartridge, cartridgeFromArgv } = await import('../harness/cartridge.mjs');
  const cart = await loadCartridge(cartridgeFromArgv(argv));
  const b = cart.browser;
  if (!b?.page && !b?.url && !process.env.PLAYTEST_URL) {
    console.error(`cartridges/${cart.name}/qa.mjs declares no browser build (docs/BROWSER-PLAY.md).`);
    process.exit(1);
  }
  const { chromium } = await import('playwright');
  const http = await import('node:http');
  let srv = null;
  let url = process.env.PLAYTEST_URL || b.url;
  if (!url) {
    srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const file = path.resolve(REPO_ROOT, rel);
      if (!/^(web|cartridges|assets|public)\//.test(rel) || !file.startsWith(REPO_ROOT + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript' }[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${srv.address().port}/${b.page}`;
  }
  const q = [b.query, flag('query')].filter(Boolean).join('&');
  const { launchChromium } = await import('./chromium.mjs');
  const browser = await launchChromium(chromium, { args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  if (browser.error) throw new Error(`Chromium did not start (${browser.error.message.split('\n')[0]}; tried ${browser.tried.join(', ')}). Run: npx playwright install chromium`);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}${q}`, { waitUntil: 'load' });
  await page.waitForTimeout(Number(flag('wait') || 1500));
  fs.mkdirSync(path.join(REPO_ROOT, 'qa', 'reports'), { recursive: true });
  const out = path.join(REPO_ROOT, 'qa', 'reports', `shot_${Date.now()}${flag('name') ? `-${flag('name').replace(/[^\w-]+/g, '-')}` : ''}.png`);
  await page.screenshot({ path: out });
  await browser.close();
  srv?.close();
  const rel = path.relative(REPO_ROOT, out).split(path.sep).join('/');
  console.log(`Saved ${rel}. Add it as proof: npm run proof -- add <task> ${rel} "<what it shows>"`);
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-'));
const r = await playInBrowser({ shots: false, video: tmp, maxMs: Number(flag('seconds') || 20) * 1000, save: false });
if (r.skipped || !r.video) {
  console.error(`No clip: ${r.skipped || 'the browser recorded no video'}`);
  process.exit(1);
}
fs.mkdirSync(CLIPS, { recursive: true });
const base = `clip_${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}${flag('name') ? `-${flag('name').replace(/[^\w-]+/g, '-')}` : ''}`;
// Frames to an mp4 at the rate they were painted (ffmpeg). Without ffmpeg, keep the frames' last image.
const fps = Math.min(30, Math.max(5, Math.round(r.video.frames / r.video.seconds)));
let out = path.join(CLIPS, `${base}.mp4`);
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(r.video.dir, 'frame_%05d.jpg'), '-vf', 'scale=960:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { encoding: 'utf8' });
if (ff.status !== 0) {
  out = path.join(CLIPS, `${base}.jpg`);
  fs.copyFileSync(path.join(r.video.dir, `frame_${String(r.video.frames - 1).padStart(5, '0')}.jpg`), out);
}
fs.rmSync(tmp, { recursive: true, force: true });
const rel = path.relative(REPO_ROOT, out).split(path.sep).join('/');
const kept = keep(out);
const bytes = fs.statSync(out).size;
const mb = bytes < 1e6 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
emitEvent({ type: 'qa.clip', agent: process.env.STUDIO_LOCK_OWNER || 'qa', task, msg: `Clip of ${r.cartridge}: ${r.outcome || 'played'} at tick ${r.ticks} (${rel}, ${mb})` });
console.log(`Saved ${rel} (${mb}${ff.status === 0 ? `, ${r.video.frames} frames, ${r.video.seconds.toFixed(1)} s` : '; install ffmpeg to get an mp4 instead of the last frame'})${kept ? `; kept with ${task} in ${kept}` : ''}.`);
