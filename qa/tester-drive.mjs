#!/usr/bin/env node
/**
 * qa/tester-drive.mjs — 2.79 (t): the game tester's hands. A small CLI the tester agent calls one step at a time to play
 * the real build in a real browser (Playwright through qa/chromium.mjs launchChromium). The browser stays open between
 * calls: the first `serve` or `open` starts a background driver (a node process of its own, no window; its port, token
 * and pid in <run>/driver.json) that `close`, or STUDIO_TESTER_DRIVER_IDLE_MIN (20) minutes without a command, ends.
 *
 *   node qa/tester-drive.mjs serve [--dist <folder>]          serve the build (default: the run's dist/)
 *   node qa/tester-drive.mjs open [--query "<q>"] [--path <page>] [--url <url>] [--width 1280 --height 720]
 *   node qa/tester-drive.mjs click --testid <id> | --text "<label>" | --xy <x>,<y>
 *   node qa/tester-drive.mjs key <Key> [--times <n>]
 *   node qa/tester-drive.mjs drag --from <x>,<y> --to <x>,<y>
 *   node qa/tester-drive.mjs wait <ms> | --testid <id>
 *   node qa/tester-drive.mjs shot <name>                      <run>/shots/<name>.png
 *   node qa/tester-drive.mjs console                          page errors and console errors since the page opened
 *   node qa/tester-drive.mjs state                            window.__sim / window.__view, when the game exposes them
 *   node qa/tester-drive.mjs close
 *   node qa/tester-drive.mjs replay <actions.jsonl> [--to <step>] [--out <folder>]   replay a run to a step, screenshot it
 *
 * The run folder: --run <dir>, else STUDIO_TESTER_RUN_DIR, else the run going (.studio/tester/state.json, written by
 * harness/tester.mjs). Every action is appended with its step number and time to <run>/actions.jsonl; `replay` re-runs
 * the acting steps (open, click, key, drag, wait, shot) in a fresh browser up to --to and saves replay-<step>.png: the
 * repro a bug task carries.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ACTING = new Set(['open', 'click', 'key', 'drag', 'wait', 'shot']);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const xy = (v) => { const m = String(v || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/); return m ? { x: Number(m[1]), y: Number(m[2]) } : null; };
const safeName = (n) => String(n || 'shot').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'shot';

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) out[k] = true; else { out[k] = v; i++; } } else out._.push(a);
  }
  return out;
}

/** The run folder: --run, STUDIO_TESTER_RUN_DIR, or the run going (the main checkout's .studio/tester/state.json). */
export async function resolveRun(args, env = process.env) {
  if (typeof args.run === 'string') return path.resolve(args.run);
  if (env.STUDIO_TESTER_RUN_DIR) return path.resolve(env.STUDIO_TESTER_RUN_DIR);
  let root = ROOT;
  try { root = (await import('../harness/worktree.mjs')).mainRoot(); } catch {}
  const st = readJson(path.join(root, '.studio', 'tester', 'state.json'));
  return st?.current?.dir || null;
}

// ---- the driver (background): the browser, the build's server, and the control port --------------------------------

/** One acting step on a page. ctx: { page, runDir, base, errors }. Returns a result object. */
export async function act(ctx, cmd, a) {
  const { page } = ctx;
  const timeout = Number(a.timeout) || 10000;
  if (cmd === 'open') {
    const url = typeof a.url === 'string' ? a.url : `${ctx.base}${typeof a.path === 'string' ? a.path.replace(/^\/+/, '') : (ctx.page0 || '')}`;
    const full = a.query ? `${url}${url.includes('?') ? '&' : '?'}${String(a.query).replace(/^\?/, '')}` : url;
    if (a.width || a.height) await page.setViewportSize({ width: Number(a.width) || 1280, height: Number(a.height) || 720 });
    await page.goto(full, { waitUntil: 'load', timeout: Math.max(timeout, 30000) });
    return { url: full, title: await page.title().catch(() => '') };
  }
  if (cmd === 'click') {
    if (typeof a.testid === 'string') await page.getByTestId(a.testid).first().click({ timeout });
    else if (typeof a.text === 'string') await page.getByText(a.text, { exact: false }).first().click({ timeout });
    else { const p = xy(a.xy); if (!p) throw new Error('click needs --testid, --text or --xy x,y'); await page.mouse.click(p.x, p.y); }
    return {};
  }
  if (cmd === 'key') { const k = String(a._[1] || a.key || ''); if (!k) throw new Error('key needs a key name (Space, Enter, ArrowUp, b)'); for (let i = 0; i < Math.min(50, Number(a.times) || 1); i++) await page.keyboard.press(k); return {}; }
  if (cmd === 'drag') {
    const f = xy(a.from); const t = xy(a.to);
    if (!f || !t) throw new Error('drag needs --from x,y --to x,y');
    await page.mouse.move(f.x, f.y); await page.mouse.down(); await page.mouse.move(t.x, t.y, { steps: 12 }); await page.mouse.up();
    return {};
  }
  if (cmd === 'wait') {
    if (typeof a.testid === 'string') { await page.getByTestId(a.testid).first().waitFor({ state: 'visible', timeout: Math.max(timeout, 30000) }); return {}; }
    await page.waitForTimeout(Math.min(120000, Math.max(0, Number(a._[1] || a.ms) || 1000)));
    return {};
  }
  if (cmd === 'shot') {
    const dir = path.join(ctx.outDir || ctx.runDir, 'shots');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safeName(a._[1] || a.name)}.png`);
    await page.screenshot({ path: file });
    return { shot: path.relative(ctx.outDir || ctx.runDir, file).split(path.sep).join('/'), file };
  }
  if (cmd === 'console') { const e = ctx.errors.slice(); if (a.clear) ctx.errors.length = 0; return { errors: e }; }
  if (cmd === 'state') {
    return await page.evaluate(() => {
      const dump = (v) => { if (v === undefined || v === null) return null; try { const s = typeof v.serialize === 'function' ? v.serialize() : typeof v.getState === 'function' ? v.getState() : v.state !== undefined ? v.state : v; const t = typeof s === 'string' ? s : JSON.stringify(s); return t.length > 20000 ? `${t.slice(0, 20000)}…` : t; } catch (e) { return `(not readable: ${e.message})`; } };
      return { sim: dump(window.__sim), view: dump(window.__view) };
    });
  }
  throw new Error(`unknown command ${cmd}`);
}

async function newBrowser() {
  const { chromium } = await import('playwright');
  const { launchChromium } = await import('./chromium.mjs');
  const browser = await launchChromium(chromium, { args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] });
  if (browser.error) throw new Error(`Chromium did not start (${String(browser.error.message).split('\n')[0]}; tried ${browser.tried.join(', ')}). Run: npx playwright install chromium`);
  return browser;
}
async function newPage(browser, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push({ kind: 'pageerror', text: String(e.message || e).slice(0, 500) }));
  page.on('console', (m) => { if (m.type() === 'error') errors.push({ kind: 'console', text: m.text().slice(0, 500) }); });
  return page;
}

async function daemon(args) {
  const runDir = path.resolve(args.run);
  const run = readJson(path.join(runDir, 'run.json')) || {};
  const dist = path.resolve(typeof args.dist === 'string' ? args.dist : run.dist || path.join(runDir, 'dist'));
  const token = crypto.randomBytes(16).toString('hex');
  const idleMs = Math.max(1, Number(process.env.STUDIO_TESTER_DRIVER_IDLE_MIN) || 20) * 60000;
  const { serveStatic } = await import('./static-serve.mjs');
  const srv = run.url ? null : await serveStatic({ root: dist });
  const base = run.url ? run.url.replace(/[^/]*$/, '') : srv.url;
  const ctx = { runDir, base, page0: run.url ? run.url.split('/').pop() : (run.page || ''), errors: [], page: null, browser: null };
  let step = Number((readJson(path.join(runDir, 'driver.json')) || {}).step) || 0;
  try { step = Math.max(step, fs.readFileSync(path.join(runDir, 'actions.jsonl'), 'utf8').split('\n').filter(Boolean).length); } catch {}
  let idle = null;
  let control = null;
  const end = async () => { try { await ctx.browser?.close(); } catch {} try { await srv?.close(); } catch {} try { control?.close(); } catch {} try { fs.rmSync(path.join(runDir, 'driver.json'), { force: true }); } catch {} process.exit(0); };
  const touch = () => { clearTimeout(idle); idle = setTimeout(end, idleMs); idle.unref?.(); };
  const log = (rec) => fs.appendFileSync(path.join(runDir, 'actions.jsonl'), `${JSON.stringify(rec)}\n`);
  control = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      touch();
      let msg = null;
      try { msg = JSON.parse(body); } catch {}
      if (!msg || msg.token !== token) { res.writeHead(403).end(); return; }
      const { cmd, a } = msg;
      const reply = (o) => { res.writeHead(200, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(o)); };
      if (cmd === 'close') { log({ step: ++step, ts: new Date().toISOString(), cmd, args: {} }); reply({ ok: true, step }); setTimeout(end, 50); return; }
      if (cmd === 'serve') { reply({ ok: true, url: base, dist: run.url ? null : dist }); return; }
      const rec = { step: ++step, ts: new Date().toISOString(), cmd, args: Object.fromEntries(Object.entries(a || {}).filter(([k]) => k !== 'run')) };
      try {
        if (!ctx.page) {
          if (cmd !== 'open') throw new Error('no page open yet: run open first');
          ctx.browser = await newBrowser();
          ctx.page = await newPage(ctx.browser, ctx.errors);
        }
        const r = await act(ctx, cmd, a || { _: [] });
        log({ ...rec, ok: true, ...(r.shot ? { shot: r.shot } : {}), ...(r.url ? { url: r.url } : {}) });
        reply({ ok: true, step: rec.step, ...r });
      } catch (e) {
        log({ ...rec, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 300) });
        reply({ ok: false, step: rec.step, error: String(e.message || e).split('\n')[0] });
      }
    });
  });
  await new Promise((r) => control.listen(0, '127.0.0.1', r));
  if (!fs.existsSync(path.join(runDir, 'actions.jsonl')) || !fs.readFileSync(path.join(runDir, 'actions.jsonl'), 'utf8').includes('"cmd":"serve"')) log({ step: ++step, ts: new Date().toISOString(), cmd: 'serve', args: { dist: run.url ? null : dist, url: run.url || null, page: ctx.page0 } });
  fs.writeFileSync(path.join(runDir, 'driver.json'), JSON.stringify({ pid: process.pid, port: control.address().port, token, url: base, dist: run.url ? null : dist, at: new Date().toISOString() }));
  touch();
}

// ---- the client --------------------------------------------------------------------------------------------------

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function post(port, body, ms = 180000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), connection: 'close' }, timeout: ms }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => { try { resolve(JSON.parse(t)); } catch { reject(new Error(`driver answered ${res.statusCode}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error('the driver did not answer in time')));
    req.on('error', reject);
    req.end(data);
  });
}

/** The live driver for a run folder, started when there is none and `start` is set: { port, token } or null. */
export async function ensureDriver(runDir, { start = true, dist = null } = {}) {
  const d = readJson(path.join(runDir, 'driver.json'));
  if (d && alive(d.pid)) return d;
  if (!start) return null;
  fs.mkdirSync(runDir, { recursive: true });
  const fd = fs.openSync(path.join(runDir, 'driver.log'), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', '--run', runDir, ...(dist ? ['--dist', dist] : [])], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true, env: process.env });
  child.unref();
  try { fs.closeSync(fd); } catch {}
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const x = readJson(path.join(runDir, 'driver.json'));
    if (x && x.pid === child.pid) return x;
    if (!alive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the driver did not start (see ${path.join(runDir, 'driver.log')})`);
}

/** Replay a run's action log up to a step in a fresh browser; saves replay-<step>.png. { ok, step, file, failed? }. */
export async function replay(logFile, { to = Infinity, out = null } = {}) {
  const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const runDir = path.dirname(path.resolve(logFile));
  const serveRec = lines.find((l) => l.cmd === 'serve') || {};
  const dist = serveRec.args?.dist && fs.existsSync(serveRec.args.dist) ? serveRec.args.dist : fs.existsSync(path.join(runDir, 'dist')) ? path.join(runDir, 'dist') : null;
  const { serveStatic } = await import('./static-serve.mjs');
  const srv = serveRec.args?.url ? null : dist ? await serveStatic({ root: dist }) : null;
  if (!srv && !serveRec.args?.url) throw new Error('the log names no build folder that still exists, and no url');
  const base = srv ? srv.url : serveRec.args.url.replace(/[^/]*$/, '');
  const outDir = path.resolve(out || path.join(runDir, 'replay'));
  fs.mkdirSync(outDir, { recursive: true });
  const errors = [];
  const browser = await newBrowser();
  let last = 0;
  let failed = null;
  try {
    const page = await newPage(browser, errors);
    const ctx = { page, runDir, outDir, base, page0: serveRec.args?.page || '', errors };
    for (const l of lines) {
      if (!(l.step <= to)) break;
      if (!ACTING.has(l.cmd)) continue;
      // Re-run what the tester did, failed steps included (a click that failed then may be the bug); ignore a re-failure.
      try { await act(ctx, l.cmd, { _: [l.cmd, ...(l.args?._ || []).slice(1)], ...l.args }); } catch (e) { if (l.ok !== false) failed = { step: l.step, error: String(e.message).split('\n')[0] }; }
      last = l.step;
    }
    const file = path.join(outDir, `replay-${last}.png`);
    await page.screenshot({ path: file });
    let state = null;
    try { state = await act(ctx, 'state', { _: [] }); } catch {}
    return { ok: !failed, step: last, file, errors, state, ...(failed ? { failed } : {}) };
  } finally { await browser.close().catch(() => {}); await srv?.close(); }
}

async function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (cmd === 'daemon') return daemon(a);
  if (cmd === 'replay') {
    const log = a._[1];
    if (!log || !fs.existsSync(log)) { console.error('Usage: node qa/tester-drive.mjs replay <actions.jsonl> [--to <step>] [--out <folder>]'); return 1; }
    const r = await replay(log, { to: a.to !== undefined ? Number(a.to) : Infinity, out: typeof a.out === 'string' ? a.out : null });
    console.log(JSON.stringify(r));
    return r.ok ? 0 : 1;
  }
  const known = ['serve', 'open', 'click', 'key', 'drag', 'wait', 'shot', 'console', 'state', 'close'];
  if (!known.includes(cmd)) { console.error(`Usage: node qa/tester-drive.mjs ${known.join('|')}|replay … (see the header of qa/tester-drive.mjs)`); return 1; }
  const runDir = await resolveRun(a);
  if (!runDir) { console.error('No tester run is going: pass --run <folder> (or set STUDIO_TESTER_RUN_DIR).'); return 1; }
  const d = await ensureDriver(runDir, { start: cmd !== 'close', dist: typeof a.dist === 'string' ? a.dist : null });
  if (!d) { console.log('The driver is not running.'); return 0; }
  const r = await post(d.port, { token: d.token, cmd, a });
  console.log(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'daemon') await main(argv);
  else { try { process.exitCode = await main(argv); } catch (e) { console.error(String(e.message || e)); process.exitCode = 1; } }
}
