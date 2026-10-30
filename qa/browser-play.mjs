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
 *   4. requires the expected outcome before `browser.maxMs`. Real input against a 60 Hz sim lands on
 *      different ticks each run, so a bot that can die sometimes loses (Jed's test #2: 3 wins, 1 loss on
 *      one build). A loss with the screen matching the sim at every check passes with a note, unless
 *      the cartridge sets `browser.mustWin: true`. Every input is recorded with its tick
 *      (qa/reports/<run>-inputs.json, or the sim's own log when window.__sim.getActions() exists),
 *      so a loss can be replayed with harness/replay.mjs --trace;
 *   5. runs the browser regressions in qa/regressions/browser/*.mjs (renderer bugs, see docs/BUGS.md).
 * It saves start, middle and end screenshots and a report to qa/reports/.
 *
 * The cartridge declares its build in qa.mjs: export const browser = { page | url, query, scenario,
 * input, wiring, maxMs, controls }. `controls` lists every button, key and clickable spot with what it
 * should do ({ name, key | click | mouse, when?, expect(before, after) }); each one is tried before the
 * play, and one that does nothing fails (CONTROL-DEAD). `page` is served from this repo on 127.0.0.1; `url` (or --url, PLAYTEST_URL)
 * points at your own dev server. A cartridge without `browser` passes with a note. When Chromium is
 * missing it fails for a real game, and only notes it for the template cartridge.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { launchChromium } from './chromium.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { cartridgeFromArgv, loadCartridge, isTemplateCartridge } from '../harness/cartridge.mjs';
import { runProbes, checkSimFeatures } from './fun-probes.mjs';
import { checkEffects } from '../harness/control-effects.mjs';

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
  if (!b && !urlArg) {
    // A game with a renderer folder and no browser contract hasn't been played: that fails (run #1 printed
    // SKIP and PASS for Next Floor). A sim-only game, or the template, may skip.
    const renderer = ['game', 'web'].map((d) => `${d}/${cart.name}`).find((d) => fs.existsSync(path.join(REPO_ROOT, d)));
    if (renderer && !isTemplateCartridge(cart.name)) {
      fail('BROWSER-CONTRACT-MISSING', `${renderer}/ is a renderer, but cartridges/${cart.name}/qa.mjs declares no browser build, so nobody played it in a browser. Add export const browser = { page or dist, input, wiring } (copy cartridges/example-sim/qa.mjs).`);
      return { ...report, passed: false };
    }
    return { ...report, skipped: `cartridges/${cart.name}/qa.mjs declares no browser build (export const browser = { page, input, wiring })`, passed: true };
  }
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { ...report, skipped: 'Playwright is not installed (npm install, then npx playwright install chromium)', passed: isTemplateCartridge(cart.name) };
  }
  const args = process.platform === 'darwin' ? ['--use-angle=metal'] : [];
  const browser = await launchChromium(chromium, { args });
  if (browser.error) return { ...report, skipped: `Chromium did not start (${browser.error.message.split('\n')[0]}; tried ${browser.tried.join(', ')}); npx playwright install chromium`, passed: isTemplateCartridge(cart.name) };

  let srv = null;
  let url = urlArg || process.env.PLAYTEST_URL || b?.url || null;
  // A PLAYTEST_URL left in .env from the example, with nothing answering (Gemini's run): play the
  // cartridge's own page or build instead, and say so.
  if (!urlArg && url && url === process.env.PLAYTEST_URL && (b?.page || b?.dist)) {
    const up = await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (!up) {
      report.notes = [...(report.notes || []), `PLAYTEST_URL (${url}) isn't answering; played the cartridge's own ${b.dist ? 'build' : 'page'} instead. Clear PLAYTEST_URL in .env unless a dev server should be used.`];
      url = null;
    }
  }
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

    // Every control the cartridge lists does what it should (Solar Outpost: pads that couldn't be
    // clicked, and empty space that bought a building). Each control: { name, key | click | mouse: [x, y],
    // when?(state) (wait until it's fair to try), expect(before, after) }. Then a fresh page for the play.
    if (Array.isArray(b?.controls) && b.controls.length) {
      report.controls = [];
      for (const c of b.controls) {
        if (typeof c.when === 'function') {
          const until = Date.now() + Number(c.waitForMs || 10000);
          while (Date.now() < until && !c.when(await page.evaluate(() => window.__sim.getState()))) await sleep(100);
        }
        const before = await page.evaluate(() => window.__sim.getState());
        let err = null;
        if (c.key) await page.keyboard.press(c.key);
        else if (c.click) await page.click(c.click, { timeout: 3000 }).catch((e) => (err = e.message.split('\n')[0]));
        else if (c.mouse) await page.mouse.click(c.mouse[0], c.mouse[1]);
        await sleep(Number(c.waitMs ?? 300));
        const after = await page.evaluate(() => window.__sim.getState());
        let ok = err ? false : typeof c.expect === 'function' ? Boolean(c.expect(before, after)) : null;
        // 2.39.0: what the Game Bible says this control must change (harness/control-effects.mjs), checked here
        // on the same before/after states, so the game's own `expect` can't be the only judge.
        const effects = err ? [] : checkEffects(c.id || c.name, before, after);
        const effectWhy = effects.filter((e) => !e.ok).map((e) => e.why).join('; ');
        if (effects.length && !err) ok = (ok === null ? true : ok) && !effectWhy;
        // 2.32.0: the id ties the result to the Game Bible's controls list (qa/controls-check.mjs).
        report.controls.push({ id: c.id || c.name, name: c.name, ok, ...(err ? { why: err } : effectWhy ? { why: `Game Bible: ${effectWhy}` } : {}), ...(effects.length ? { effects } : {}) });
        if (ok === false) fail('CONTROL-DEAD', `${c.name}: ${err ? `couldn't be pressed (${err})` : effectWhy ? `didn't change what the Game Bible says (${effectWhy})` : `didn't do what it should${c.what ? ` (${c.what})` : ''}`}`);
      }
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__sim && typeof window.__sim.getState === 'function', null, { timeout: 8000 }).catch(() => {});
      await sleep(300);
    }

    // 2.30b (J1, J4): the real-input fun probes and the sim features, on a fresh page, then a fresh page for the play.
    report.declared = { probes: b?.probes || [], simFeatures: cart.simFeatures || [] };
    const wantProbes = (b?.probes || []).filter((p) => p !== 'camera');
    if (wantProbes.length || cart.simFeatures?.length) {
      report.probes = await runProbes(page, { ...b, probes: wantProbes });
      report.simFeatures = await checkSimFeatures(page, cart.simFeatures || [], b || {}, report.probes);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.__sim && typeof window.__sim.getState === 'function', null, { timeout: 8000 }).catch(() => {});
      await sleep(300);
    }
    // Play: the scenario's policy picks actions from the live state; real keys and clicks perform them.
    const playStart = Date.now();
    const sc = cart.scenarios[b?.scenario || 'start-to-win'];
    const expect = sc?.expect || 'won';
    const until = Date.now() + Number(maxMs || b?.maxMs || 30000);
    let outcome = null;
    let last = null;
    let midShot = false;
    const mismatches = new Set();
    // The inputs, with the tick the bot chose them on (the game applies each one a tick or two later).
    const timeline = [];
    const seed = await page.evaluate(() => window.__sim.getState()?.seed ?? null).catch(() => null);
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
        // Look without firing (a game where a click means look + shoot): { move: [x, y] }.
        else if (input.move) await page.mouse.move(input.move[0], input.move[1]);
        report.inputs += 1;
        if (timeline.length < 20000) timeline.push({ tick: snap.state.tick, action: act });
      }
      await sleep(25);
    }
    await shot(page, 'end');
    report.playSeconds = Math.round((Date.now() - playStart) / 100) / 10;
    // Pace: a perfect player's time against the Bible's play length (Gemini's run: a phase gone in
    // 15 s of a 10-minute session). A note for the people, not a failure: speed is a design choice.
    if (outcome) {
      try {
        const len = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8')).answers?.playLength;
        const minutes = { demo: 15, short: 60, medium: 300, long: 1200 }[len];
        if (minutes && report.playSeconds < minutes * 60 * 0.05) report.notes = [...(report.notes || []), `pace: a perfect player reaches "${outcome}" in ${report.playSeconds} s of real play; the Bible says ${len === 'demo' ? 'a 15-30 minute demo' : `a ${len} game`}. If that's too fast for a person to read and choose, slow the clock (ms per tick).`];
      } catch {
        // no Bible yet
      }
    }
    report.outcome = outcome;
    report.ticks = last?.state?.tick ?? null;
    // The inputs as a trace harness/replay.mjs reads: the sim's own log when it keeps one, else the bot's.
    const simLog = await page.evaluate(() => (typeof window.__sim.getActions === 'function' ? window.__sim.getActions() : null)).catch(() => null);
    const trace = { cartridge: cart.name, seed, tick: report.ticks, description: `browser-play ${runId}: ${outcome || 'no outcome'} at tick ${report.ticks}`, actions: Array.isArray(simLog) ? simLog : timeline, exact: Array.isArray(simLog) };
    fs.mkdirSync(REPORTS, { recursive: true });
    fs.writeFileSync(path.join(REPORTS, `${runId}-inputs.json`), `${JSON.stringify(trace)}\n`);
    report.trace = `qa/reports/${runId}-inputs.json`;
    if ((b?.probes || []).includes('camera')) {
      const inside = [...mismatches].some((m) => /camera is inside/.test(m));
      report.probes = [...(report.probes || []), ...(await runProbes(page, { ...b, probes: ['camera'] }, { cameraInside: inside }))];
    }
    for (const p of report.probes || []) if (!p.ok) fail(p.unwired ? 'PROBE-UNWIRED' : 'FUN-PROBE', `${p.name}: ${p.why}`);
    for (const f of report.simFeatures || []) if (!f.ok) fail('SIM-ONLY', `${f.name}: ${f.why}`);
    if ([...mismatches].length) fail('BROWSER-WIRING', `the screen doesn't match the sim (${mismatches.size}): ${[...mismatches].slice(0, 3).join('; ')}`, { mismatches: [...mismatches].slice(0, 20) });
    const frozen = report.findings.some((f) => f.id === 'BROWSER-FROZEN');
    // "The browser game works" is separate from "the bot won": a real outcome with the screen matching
    // the sim at every check is a pass with a note, unless the cartridge says the bot must win.
    // Only when nothing else failed: a dead control (keys that never arrive) loses too, and that is a bug.
    if (!frozen && outcome && outcome !== expect && !mismatches.size && !b?.mustWin && !report.findings.length) {
      report.notes = [...(report.notes || []), `the bot ${outcome} at tick ${report.ticks} (expected ${expect}); the screen matched the sim at all ${report.checks} checks, so the browser build works. Real-time input lands on different ticks each run. Replay it: node harness/replay.mjs --trace ${report.trace}${trace.exact ? '' : ' (approximate: the bot\'s ticks, not the sim\'s)'}. Set browser.mustWin: true to make a loss fail.`];
    } else if (!frozen && outcome !== expect) fail('BROWSER-NO-OUTCOME', `playing with real input ended ${outcome || 'without an outcome'} at tick ${report.ticks}; expected ${expect}. Inputs: ${report.trace}`);

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
  if (report.passed && save && !urlArg && !(process.env.PLAYTEST_URL && url === process.env.PLAYTEST_URL)) {
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
  for (const n of r.notes || []) console.log(`[browser-play] note: ${n}`);
  for (const f of r.findings) console.error(`[browser-play] FAIL ${f.id}: ${f.summary}`);
  if (r.ticks === undefined && !r.passed) process.exit(1);
  console.log(`[browser-play] ${r.passed ? 'PASS' : 'FAIL'} ${r.cartridge}: ${r.outcome || 'no outcome'} at tick ${r.ticks}, ${r.inputs} real inputs, ${r.checks} screen checks. Report ${r.file}; screenshots ${r.screenshots.join(', ')}`);
  process.exit(r.passed ? 0 : 1);
}
