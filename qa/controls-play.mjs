#!/usr/bin/env node
/**
 * qa/controls-play.mjs — 2.45.0: press a web game's real controls in a real browser and check what the Game
 * Bible says each one must change. For a game that isn't a cartridge (an adopted Vite/React/three.js game
 * under game/<slug>/), which qa/browser-play.mjs can't drive: it knows only window.__sim.
 *
 * The game says how to reach it in game/<slug>/studio.browser.json (onboarding writes a starter):
 *   {
 *     "serve":  { "command": "npx vite --port {port} --strictPort", "url": "http://127.0.0.1:{port}/" },
 *     "url":    "http://127.0.0.1:5173/"         // instead of serve, for a server that is already running
 *     "init":   "sessionStorage.setItem('screen','play')",   // runs in the page before the game's scripts
 *     "start":  [{ "click": "[data-testid=new-game]" }, { "wait": 500 }],   // from the first screen to play
 *     "ready":  "Boolean(window.__game)",        // true once the game can be played
 *     "state":  "({ cash: window.__game.cash, speed: window.__game.speed })",   // the values effects read
 *     "holdMs": 150,                             // how long a key is held down
 *     "settleMs": 3000,                          // the longest wait for an effect to show after a press
 *     "controls": { "speed.pause": { "key": "Space" }, "buy": { "click": "#buy" }, "map": { "click": { "x": 400, "y": 300 } } }
 *   }
 * A Bible control whose input reads "key X" needs no entry here. Each press: state before, press, then state
 * again every 100 ms until the Bible's effects hold or settleMs passes. A control with no effect in the Bible
 * is reported as not checked (ok: null), which the controls check treats as not a pass.
 *
 * Writes qa/reports/controls-web-<time>.json ({ controls: [{ id, ok, why, effects }] }), which qa/controls-check.mjs
 * reads for the web track like a browser-play report. The server it starts is stopped at the end, children
 * included. Exit 1 when a control failed or couldn't be checked.
 *
 *   npm run play:controls                 the active game
 *   npm run play:controls -- --only speed.pause,view.hall
 *   npm run play:controls -- --url http://127.0.0.1:5173/   a server that is already running
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from '../harness/event.mjs';
import { bibleControls, checkEffects, effectsOf } from '../harness/control-effects.mjs';
import { launchChromium } from './chromium.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

export function manifestFile(gameRoot, root = REPO_ROOT) {
  return path.join(root, gameRoot, 'studio.browser.json');
}

/** How to press a control: the manifest's entry, else the Bible's "key X" input. */
export function actionFor(id, entry, manifest) {
  const m = manifest?.controls?.[id];
  if (m && (m.key || m.click || m.keys)) return m;
  const k = String(entry?.input || '').match(/^\s*(?:key|press)\s+([A-Za-z0-9]+|Space|Enter|Escape|Tab|Arrow(?:Up|Down|Left|Right))\b/i);
  if (k) return { key: /^[a-z]$/i.test(k[1]) ? `Key${k[1].toUpperCase()}` : /^\d$/.test(k[1]) ? `Digit${k[1]}` : k[1] };
  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function stopTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {}
}

async function waitForUrl(url, ms, child) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) return `the server exited (code ${child.exitCode})`;
    try { const r = await fetch(url); if (r.status < 500) return null; } catch {}
    await sleep(300);
  }
  return `nothing answered at ${url} in ${Math.round(ms / 1000)}s`;
}

export async function controlsPlay({ root = REPO_ROOT, game = null, url = null, only = null, reportsDir = path.join(root, 'qa', 'reports'), log = console.log } = {}) {
  if (!game) {
    const { studioGame } = await import('../harness/game-gates.mjs');
    game = await studioGame();
  }
  if (!game?.root) return { error: 'no studio game (game/<slug>/) is active: this check is for a game that is not a cartridge (npm run play:browser drives cartridges)' };
  const mf = manifestFile(game.root, root);
  const manifest = readJson(mf);
  if (!manifest) return { error: `${path.relative(root, mf)} is missing or not JSON: say how to serve the game and read its state (see qa/controls-play.mjs)` };
  const bible = bibleControls(path.join(root, 'studio', 'bible', 'controls.json'));
  const want = [...bible.values()].filter((c) => (!Array.isArray(c.tracks) || c.tracks.includes('web')) && (!only || only.includes(c.id)));
  if (!want.length) return { error: 'the Game Bible lists no web controls to press (studio/bible/controls.json)' };

  let chromium;
  try { ({ chromium } = await import('playwright')); } catch { return { error: 'Playwright is not installed (npm install, then npx playwright install chromium)' }; }

  let server = null;
  const serverLog = [];
  let target = url || manifest.url || null;
  if (!target) {
    const s = manifest.serve;
    if (!s?.command) return { error: `${path.relative(root, mf)} has neither "url" nor "serve.command"` };
    const port = await freePort();
    const cmd = s.command.replaceAll('{port}', String(port));
    target = (s.url || 'http://127.0.0.1:{port}/').replaceAll('{port}', String(port));
    server = spawn(cmd, { cwd: path.join(root, s.cwd || game.root), shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none', PORT: String(port) } });
    const keep = (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); };
    server.stdout.on('data', keep);
    server.stderr.on('data', keep);
    log(`[controls-play] serving: ${cmd}`);
    const err = await waitForUrl(target, Number(s.timeoutMs) || 90000, server);
    if (err) { stopTree(server); return { error: `${err}: ${serverLog.join('').trim().split('\n').slice(-4).join(' | ')}` }; }
  }

  const report = { game: game.name, url: target, at: new Date().toISOString(), controls: [], pageErrors: [] };
  let browser = null;
  try {
    browser = await launchChromium(chromium, { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    if (browser.error) return { error: `Chromium did not start (${browser.error.message.split('\n')[0]}): npx playwright install chromium` };
    const page = await browser.newPage({ viewport: manifest.viewport || { width: 1280, height: 800 } });
    page.on('pageerror', (e) => { if (report.pageErrors.length < 20) report.pageErrors.push(String(e.message || e).slice(0, 300)); });
    if (manifest.init) await page.addInitScript(manifest.init);
    await page.goto(target, { waitUntil: 'load', timeout: 60000 });
    // The steps from the page's first screen to play (New Game, pick a start…), each one of
    // { click: selector } | { key: code } | { eval: js } | { waitFor: js } | { wait: ms }.
    for (const [i, st] of (Array.isArray(manifest.start) ? manifest.start : []).entries()) {
      try {
        if (st.click) await page.click(st.click, { timeout: Number(st.timeoutMs) || 15000 });
        else if (st.key) await page.keyboard.press(st.key);
        else if (st.eval) await page.evaluate(st.eval);
        else if (st.waitFor) await page.waitForFunction(st.waitFor, null, { timeout: Number(st.timeoutMs) || 30000, polling: 250 });
        if (st.wait) await sleep(Number(st.wait));
      } catch (e) {
        return { error: `start step ${i + 1} (${JSON.stringify(st)}) failed: ${e.message.split('\n')[0]}${report.pageErrors.length ? `; page errors: ${report.pageErrors.slice(0, 2).join(' | ')}` : ''}` };
      }
    }
    const readyExpr = manifest.ready || 'true';
    const ready = await page.waitForFunction(readyExpr, null, { timeout: Number(manifest.readyMs) || 60000, polling: 250 }).then(() => true).catch(() => false);
    if (!ready) return { error: `the game never became ready (${readyExpr}) at ${target}${report.pageErrors.length ? `; page errors: ${report.pageErrors.slice(0, 2).join(' | ')}` : ''}` };
    const stateExpr = manifest.state || 'window.__sim.getState()';
    const readState = () => page.evaluate(`JSON.parse(JSON.stringify(${stateExpr}))`);
    const first = await readState().catch((e) => ({ __error: e.message }));
    if (first?.__error || first === undefined || first === null) return { error: `the state expression failed (${stateExpr}): ${first?.__error || 'it returned nothing'}` };
    await page.mouse.move(Math.round((manifest.viewport?.width || 1280) / 2), Math.round((manifest.viewport?.height || 800) / 2));
    const holdMs = Number(manifest.holdMs) || 150;
    const settleMs = Number(manifest.settleMs) || 3000;
    for (const c of want) {
      const act = actionFor(c.id, c, manifest);
      if (!act) { report.controls.push({ id: c.id, name: c.name, ok: null, why: `no way to press it: add "${c.id}" to ${path.relative(root, mf)} controls ({ "key": … } or { "click": … })` }); continue; }
      let err = null;
      if (act.before) await page.evaluate(act.before).catch((e) => { err = `its "before" failed: ${e.message.split('\n')[0]}`; });
      const before = err ? null : await readState().catch((e) => { err = `state: ${e.message.split('\n')[0]}`; return null; });
      if (!err) {
        try {
          for (const k of act.keys || (act.key ? [act.key] : [])) { await page.keyboard.down(k); await sleep(act.holdMs || holdMs); await page.keyboard.up(k); }
          if (act.click) {
            if (typeof act.click === 'string') await page.click(act.click, { timeout: 5000 });
            else await page.mouse.click(act.click.x, act.click.y);
          }
        } catch (e) { err = `couldn't press it: ${e.message.split('\n')[0]}`; }
      }
      let effects = [];
      let after = null;
      if (!err) {
        const until = Date.now() + (act.settleMs || settleMs);
        do {
          await sleep(100);
          after = await readState().catch(() => null);
          effects = after ? checkEffects(c.id, before, after, bible) : [];
        } while (effects.some((e) => !e.ok) && Date.now() < until);
      }
      const bad = effects.filter((e) => !e.ok).map((e) => e.why).join('; ');
      const ok = err ? false : effects.length ? !bad : null;
      report.controls.push({ id: c.id, name: c.name, ok, ...(err ? { why: err } : bad ? { why: `Game Bible: ${bad}` } : !effects.length ? { why: 'the Game Bible names no effect for it, so nothing checked what it does' } : {}), ...(effects.length ? { effects } : {}) });
      log(`[controls-play] ${ok === true ? 'PASS' : ok === false ? 'FAIL' : 'NOT CHECKED'} ${c.id}${ok === true ? ` (${effects.map((e) => `${e.path}: ${JSON.stringify(e.before)} → ${JSON.stringify(e.after)}`).join(', ')})` : ` — ${report.controls.at(-1).why}`}`);
    }
  } finally {
    if (browser && !browser.error) await browser.close().catch(() => {});
    stopTree(server);
  }
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `controls-web-${Date.now()}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const failed = report.controls.filter((c) => c.ok !== true);
  return { ok: failed.length === 0, file: path.relative(root, file).split(path.sep).join('/'), report, failed };
}

/** A starter studio.browser.json for an adopted web game, or null when it doesn't look like one. */
export function starterManifest(gameDir) {
  const pkg = readJson(path.join(gameDir, 'package.json'));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const s = pkg.scripts || {};
  let command = null;
  if (deps.vite) command = 'npx vite --port {port} --strictPort --host 127.0.0.1';
  else if (deps.next) command = 'npx next dev -p {port}';
  else if (s.dev) command = 'npm run dev -- --port {port}';
  else if (s.start) command = 'npm start';
  if (!command) return null;
  return {
    note: 'How qa/controls-play.mjs (npm run play:controls) reaches this game: serve it, wait until ready, read the state the Game Bible\'s effects name, press each control. Fill in "start" (the clicks from the first screen to play), "ready" and "state" (the game needs a dev-only handle on window), and "controls" for clicks or keys the Bible\'s input doesn\'t spell as "key X".',
    serve: { command, url: 'http://127.0.0.1:{port}/' },
    init: '',
    start: [],
    ready: 'Boolean(window.__sim)',
    state: 'window.__sim.getState()',
    holdMs: 150,
    settleMs: 3000,
    controls: {},
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const res = await controlsPlay({ url: arg('--url'), only: arg('--only') ? arg('--only').split(',') : null });
  if (res.error) { console.error(`[controls-play] FAIL ${res.error}`); process.exit(1); }
  if (res.report.pageErrors.length) console.log(`[controls-play] note: ${res.report.pageErrors.length} page error(s): ${res.report.pageErrors.slice(0, 3).join(' | ')}`);
  console.log(`[controls-play] ${res.ok ? 'PASS' : 'FAIL'} ${res.report.controls.length - res.failed.length}/${res.report.controls.length} control(s) did what the Game Bible says → ${res.file}`);
  process.exit(res.ok ? 0 : 1);
}
