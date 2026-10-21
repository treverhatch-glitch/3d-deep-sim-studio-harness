#!/usr/bin/env node
/**
 * qa/browser-play.mjs — play the game's browser build like a player, and check the screen matches the sim.
 *
 *   node qa/browser-play.mjs [--cartridge name] [--url http://127.0.0.1:5173/?playtest=1] [--shots]
 *   npm run play:browser
 *
 * "Green but broken" is a sim that passes every gate while the game in the browser is blank, frozen,
 * or shows the wrong numbers. This gate opens the browser build in Chromium and:
 *   1. fails on script errors, a blank canvas, or a clock that doesn't move;
 *   2. plays the cartridge's scenario (start-to-win by default) with real key presses and clicks,
 *      chosen by the scenario's own policy and turned into input by the cartridge's `browser.input`;
 *   3. reads window.__sim (the sim) and window.__view() (what the page shows) in the same instant and
 *      fails on any mismatch the cartridge's `browser.wiring(state, view)` reports, or when the
 *      camera is inside geometry (`view.camera.inside`);
 *   4. requires the expected outcome before `browser.maxMs`;
 *   5. runs the browser regressions in qa/regressions/browser/*.mjs (renderer bugs, see docs/BUGS.md).
 * It saves start, middle and end screenshots and a report to qa/reports/.
 *
 * The cartridge declares its build in qa.mjs: export const browser = { page | url, query, scenario,
 * input, wiring, maxMs }. `page` is served from this repo on 127.0.0.1; `url` (or --url, PLAYTEST_URL)
 * points at your own dev server. A cartridge without `browser` passes with a note. When Chromium is
 * missing it fails for a real game, and only notes it for the template cartridge.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { cartridgeFromArgv, loadCartridge, isTemplateCartridge } from '../harness/cartridge.mjs';

const REPORTS = path.join(REPO_ROOT, 'qa', 'reports');
export const BROWSER_REGRESSIONS = path.join(REPO_ROOT, 'qa', 'regressions', 'browser');
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.glb': 'model/gltf-binary', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

/** Serve the repo's web/ and cartridges/ folders (and assets/) on 127.0.0.1 for the browser build. */
// dist: a bundled game's build folder, served at the root; otherwise the repo's web/, cartridges/, assets/, public/.
function serveRepo(dist = null) {
  const base = dist ? path.resolve(REPO_ROOT, dist) : REPO_ROOT;
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || (dist ? 'index.html' : '');
    const file = path.resolve(base, rel);
    if ((!dist && !/^(web|cartridges|assets|public)\//.test(rel)) || !file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many colours cover a real share (0.3%+) of the canvas: a blank or cleared canvas has one. */
async function canvasColours(page) {
  const el = page.locator('canvas').first();
  if (!(await el.count())) return { colours: 0, why: 'no <canvas> on the page' };
  const png = (await el.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    const count = new Map();
    let n = 0;
    for (let i = 0; i < d.length; i += 4 * 3) {
      const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      count.set(k, (count.get(k) || 0) + 1);
      n += 1;
    }
    return { colours: [...count.values()].filter((c) => c / n >= 0.003).length };
  }, png);
}

export async function playInBrowser({ cartridge, url: urlArg, shots = true, video = null, maxMs = null, save = true } = {}) {
  const cart = await loadCartridge(cartridge || cartridgeFromArgv([]));
  const b = cart.browser;
  const report = { cartridge: cart.name, at: new Date().toISOString(), findings: [], screenshots: [], inputs: 0, checks: 0 };
  const fail = (id, summary, extra = {}) => report.findings.push({ id, severity: 'P1', summary, ...extra });
  if (!b && !urlArg) return { ...report, skipped: `cartridges/${cart.name}/qa.mjs declares no browser build (export const browser = { page, input, wiring })`, passed: true };
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { ...report, skipped: 'Playwright is not installed (npm install, then npx playwright install chromium)', passed: isTemplateCartridge(cart.name) };
  }
  const exe = process.env.PLAYWRIGHT_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const args = process.platform === 'darwin' ? ['--use-angle=metal'] : [];
  const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args }).catch((err) => ({ error: err }));
  if (browser.error) return { ...report, skipped: `Chromium did not start (${browser.error.message.split('\n')[0]}); npx playwright install chromium`, passed: isTemplateCartridge(cart.name) };

  let srv = null;
  let url = urlArg || process.env.PLAYTEST_URL || b?.url || null;
  if (!url && b?.dist) {
    // A bundled game (Vite and the like): build it, then play the build, never the dev server.
    if (b.build) {
      const { spawnSync } = await import('node:child_process');
      const built = spawnSync(b.build, { cwd: REPO_ROOT, shell: true, encoding: 'utf8' });
      if (built.status !== 0) {
        await browser.close();
        fail('BROWSER-BUILD-FAILED', `\`${b.build}\` failed: ${(built.stderr || built.stdout).trim().split('\n').slice(-2).join(' ')}`);
        return { ...report, passed: false };
      }
    }
    report.built = Boolean(b.build);
    srv = await serveRepo(b.dist);
    url = `http://127.0.0.1:${srv.address().port}/${b.distPage || 'index.html'}${b.query ? `?${b.query}` : ''}`;
  } else if (!url && b?.page) {
    srv = await serveRepo();
    url = `http://127.0.0.1:${srv.address().port}/${b.page}${b.query ? `?${b.query}` : ''}`;
  }
  report.url = url;
  const runId = `browser_${Date.now()}`;
  const shot = async (page, name) => {
    if (!shots) return;
    fs.mkdirSync(REPORTS, { recursive: true });
    const f = path.join(REPORTS, `${runId}-${name}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    report.screenshots.push(path.relative(REPO_ROOT, f).split(path.sep).join('/'));
  };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    // A clip: Chromium's own screencast, one JPEG per painted frame (needs no Playwright ffmpeg build).
    let cast = null;
    if (video) {
      cast = { frames: [], cdp: await ctx.newCDPSession(page) };
      fs.mkdirSync(video, { recursive: true });
      cast.cdp.on('Page.screencastFrame', ({ data, sessionId, metadata }) => {
        const f = path.join(video, `frame_${String(cast.frames.length).padStart(5, '0')}.jpg`);
        fs.writeFileSync(f, Buffer.from(data, 'base64'));
        cast.frames.push({ f, t: metadata.timestamp });
        cast.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      });
      await cast.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 960, maxHeight: 540, everyNthFrame: 2 });
    }
    report.cast = cast;
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
    page.on('response', (r) => r.status() >= 400 && !/\/favicon\.ico$/.test(r.url()) && errors.push(`${r.status()} for ${r.url()}`));
    // Headless Chromium has no pointer lock; games that need it get a stand-in so input still reaches them.
    await page.addInitScript(() => {
      Element.prototype.requestPointerLock = function requestPointerLock() {
        Object.defineProperty(document, 'pointerLockElement', { value: this, configurable: true });
        document.dispatchEvent(new Event('pointerlockchange'));
        return Promise.resolve();
      };
    });
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch((err) => ({ err }));
    if (res?.err || (res && !res.ok())) {
      fail('BROWSER-NOT-LOADED', `the page didn't load: ${res?.err ? res.err.message.split('\n')[0] : `HTTP ${res.status()}`}`);
      return { ...report, passed: false };
    }
    await page.waitForFunction(() => window.__sim && typeof window.__sim.getState === 'function', null, { timeout: 8000 }).catch(() => {});
    const hasSim = await page.evaluate(() => Boolean(window.__sim?.getState));
    const hasView = await page.evaluate(() => typeof window.__view === 'function');
    if (!hasSim) {
      fail('BROWSER-NO-SIM', 'window.__sim is missing with ?playtest=1: the gate can\'t see the game\'s state');
      return { ...report, passed: false };
    }
    if (!hasView) fail('BROWSER-NO-VIEW', 'window.__view() is missing: the gate can\'t compare the screen with the sim (return the HUD values, what was drawn, and camera.inside)');
    await sleep(500);
    await shot(page, 'start');
    const look = await canvasColours(page);
    if (look.colours <= 1) fail('BROWSER-BLANK', look.why || `the canvas is blank (${look.colours} colour${look.colours === 1 ? '' : 's'})`);
    const t0 = await page.evaluate(() => window.__sim.getState().tick);
    await sleep(1000);
    const t1 = await page.evaluate(() => window.__sim.getState().tick);
    if (!(t1 > t0)) fail('BROWSER-FROZEN', `the clock didn't move: tick ${t0} after a second of play`);

    // Play: the scenario's policy picks actions from the live state; real keys and clicks perform them.
    const sc = cart.scenarios[b?.scenario || 'start-to-win'];
    const expect = sc?.expect || 'won';
    const until = Date.now() + Number(maxMs || b?.maxMs || 30000);
    let outcome = null;
    let last = null;
    let midShot = false;
    const mismatches = new Set();
    while (!report.findings.some((f) => f.id === 'BROWSER-FROZEN') && Date.now() < until) {
      const snap = await page.evaluate(() => ({ state: window.__sim.getState(), view: typeof window.__view === 'function' ? window.__view() : null }));
      last = snap;
      report.checks += 1;
      if (snap.view && b?.wiring) for (const m of b.wiring(snap.state, snap.view)) mismatches.add(`tick ${snap.state.tick}: ${m}`);
      if (snap.view?.camera?.inside) mismatches.add(`tick ${snap.state.tick}: the camera is inside geometry`);
      outcome = cart.outcome(snap.state);
      if (outcome) break;
      if (!midShot && snap.state.tick >= (sc?.maxTicks || 200) / 2) {
        midShot = true;
        await shot(page, 'middle');
      }
      const acts = typeof sc?.policy === 'function' ? sc.policy(snap.state, snap.state.tick) : null;
      for (const act of acts ? (Array.isArray(acts) ? acts : [acts]) : []) {
        const input = b?.input ? b.input(act) : null;
        if (!input) continue;
        if (input.key) await page.keyboard.press(input.key);
        else if (input.click) await page.click(input.click);
        else if (input.mouse) await page.mouse.click(input.mouse[0], input.mouse[1]);
        report.inputs += 1;
      }
      await sleep(25);
    }
    await shot(page, 'end');
    report.outcome = outcome;
    report.ticks = last?.state?.tick ?? null;
    if ([...mismatches].length) fail('BROWSER-WIRING', `the screen doesn't match the sim (${mismatches.size}): ${[...mismatches].slice(0, 3).join('; ')}`, { mismatches: [...mismatches].slice(0, 20) });
    if (!report.findings.some((f) => f.id === 'BROWSER-FROZEN') && outcome !== expect) fail('BROWSER-NO-OUTCOME', `playing with real input ended ${outcome || 'without an outcome'} at tick ${report.ticks}; expected ${expect}`);

    // Browser regressions: one file per renderer bug, each a check on the running page.
    if (fs.existsSync(BROWSER_REGRESSIONS)) {
      for (const f of fs.readdirSync(BROWSER_REGRESSIONS).filter((n) => n.endsWith('.mjs')).sort()) {
        const mod = await import(pathToFileURL(path.join(BROWSER_REGRESSIONS, f)).href);
        const r = await mod.check({ page, sim: last?.state, view: last?.view }).catch((err) => ({ ok: false, why: String(err?.message || err) }));
        report.regressions = [...(report.regressions || []), { file: `qa/regressions/browser/${f}`, ok: Boolean(r?.ok), why: r?.why || null }];
        if (!r?.ok) fail('BROWSER-REGRESSION', `${f}: ${r?.why || 'failed'}`);
      }
    }
    if (errors.length) fail('BROWSER-SCRIPT-ERROR', `${errors.length} script error(s): ${errors.slice(0, 2).join(' | ')}`);
  } finally {
    if (report.cast) {
      await report.cast.cdp.send('Page.stopScreencast').catch(() => {});
      const fr = report.cast.frames;
      if (fr.length > 1) report.video = { dir: video, frames: fr.length, seconds: Math.max(0.1, fr[fr.length - 1].t - fr[0].t) };
    }
    delete report.cast;
    await browser.close();
    srv?.close();
  }
  report.passed = report.findings.length === 0;
  // A pass means this build is playable: save it for npm run play and the Arcade (unchanged builds aren't saved twice).
  if (report.passed && save && !urlArg && !process.env.PLAYTEST_URL) {
    const { snapshotBuild } = await import('../harness/builds.mjs');
    const s = snapshotBuild(cart, report);
    if (s.ok) report.build = s.build.id;
  }
  fs.mkdirSync(REPORTS, { recursive: true });
  report.file = `qa/reports/${runId}.json`;
  fs.writeFileSync(path.join(REPO_ROOT, report.file), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const r = await playInBrowser({ cartridge: flag('cartridge') || undefined, url: flag('url') || undefined, shots: !argv.includes('--no-shots') });
  if (r.skipped) {
    console.log(`[browser-play] ${r.passed ? 'SKIP' : 'FAIL'} ${r.cartridge}: ${r.skipped}${r.passed ? '' : ' (a real game needs the browser check)'}`);
    process.exit(r.passed ? 0 : 1);
  }
  emitEvent({ type: r.passed ? 'qa.browser.pass' : 'qa.browser.fail', agent: process.env.STUDIO_LOCK_OWNER || 'qa', msg: `${r.cartridge} in the browser: ${r.passed ? `${r.outcome} at tick ${r.ticks} with ${r.inputs} real inputs, ${r.checks} screen checks` : r.findings.map((f) => f.id).join(', ')}` });
  for (const f of r.findings) console.error(`[browser-play] FAIL ${f.id}: ${f.summary}`);
  console.log(`[browser-play] ${r.passed ? 'PASS' : 'FAIL'} ${r.cartridge}: ${r.outcome || 'no outcome'} at tick ${r.ticks}, ${r.inputs} real inputs, ${r.checks} screen checks. Report ${r.file}; screenshots ${r.screenshots.join(', ')}`);
  process.exit(r.passed ? 0 : 1);
}
