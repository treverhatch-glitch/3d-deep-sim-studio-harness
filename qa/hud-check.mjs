#!/usr/bin/env node
/**
 * qa/hud-check.mjs — open the War Room in a real browser and use it like a person would.
 *
 *   node qa/hud-check.mjs [--shots <folder>] [--only stop-pause [--repeat <n>]]
 *
 * Copies the repo to a temporary folder, fills it with a small studio (a signed Bible, tasks, an
 * agent at work, an idea, a playtest), starts the HUB there and drives Chromium through all three
 * views at desktop and phone sizes: no console errors, no sideways scroll, the agent drawer, adding a
 * task, messaging the Producer, live updates, pitching an idea, answering a follow-up, the
 * data-sharing box, the MAX SPEED lever and the pace, the studio's questions, approving the art
 * department's designs, the Liaison chat (on a fake local model), and starting and stopping an agent. Your own studio is never touched. Skips (exit 0) when Playwright or Chromium
 * isn't installed; set PLAYWRIGHT_CHROMIUM to a Chromium binary to use a specific one.
 *
 * Every check waits for the state it expects (qa/wait-for.mjs: up to 15 s, 30 s on Windows, HUD_WAIT_MS
 * to change it) and, when it times out, prints what the page showed (P-044: reading the page once ran
 * before the War Room's next refresh). `--only stop-pause --repeat 30` sets the studio up once and runs
 * just the agent start/Stop/+ Hire/Pause checks 30 times, with a pass count and the seconds per round.
 * HUD_TRACE=1 prints each Stop/Pause press and how long each check waited.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitFor, waitBudget } from './wait-for.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? '' : null);
const shotsAt = arg('--shots') ? path.resolve(arg('--shots')) : null;
const SECTIONS = ['stop-pause'];
const only = arg('--only');
const repeat = arg('--repeat') === null ? 1 : Number(arg('--repeat'));
if (only !== null && !SECTIONS.includes(only)) {
  console.error(`[hud] --only takes one of: ${SECTIONS.join(', ')}`);
  process.exit(2);
}
if (!Number.isInteger(repeat) || repeat < 1 || (repeat > 1 && !only)) {
  console.error('[hud] --repeat takes a whole number of rounds, with --only <section> (repeat the whole check from a loop instead)');
  process.exit(2);
}
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('[hud] SKIP Playwright is not installed (npm install)');
  process.exit(0);
}
const { launchChromium } = await import('./chromium.mjs');
const browser = await launchChromium(chromium);
if (browser.error) {
  console.log(`[hud] SKIP Chromium did not start (${browser.error.message.split('\n')[0]}; tried ${browser.tried.join(', ')}). Run: npx playwright install chromium`);
  process.exit(0);
}

// A throwaway studio: tracked files only, sharing node_modules.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-check-'));
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
const files = listed.status === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
if (files.length) for (const f of files) fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.existsSync(path.join(root, f)) && fs.copyFileSync(path.join(root, f), path.join(dir, f));
else fs.cpSync(root, dir, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git|\.studio)([\\/]|$)/.test(path.relative(root, s) ? `/${path.relative(root, s)}` : '') });
fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
const env = { ...process.env, STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '', STUDIO_WATCH_INTERVAL: '0', STUDIO_BACKUP_DIR: '', STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} T-003 wait' };
const sh = (...args) => spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
const git = (...args) => spawnSync('git', ['-c', 'user.name=hud', '-c', 'user.email=hud@example.com', ...args], { cwd: dir, encoding: 'utf8' });
git('init', '-q');
git('add', '-A');
git('commit', '-q', '-m', 'init', '--no-verify');
sh('harness/intake.mjs', '--answers', 'studio/templates/intake-example.json');
sh('harness/bible.mjs', 'sign', '--by', 'hatch');
sh('harness/task.mjs', 'start', 'T-002', '--agent', 'balancer-1', '--model', 'gemini-2.5-pro');
sh('harness/event.mjs', '--type', 'task.progress', '--agent', 'balancer-1', '--task', 'T-002', '--msg', 'sweeping spawnCost 40..120');
sh('harness/ideas.mjs', 'add', 'Night market events', '--by', 'hatch');
sh('qa/playtest.mjs', '--stage', '1', '--quiet');
fs.mkdirSync(path.join(dir, 'studio/art'), { recursive: true });
fs.mkdirSync(path.join(dir, 'assets/placeholder'), { recursive: true });
fs.writeFileSync(path.join(dir, 'studio/art/concept.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAGElEQVR4nGP4z8DwHwxRAQMDAwMDLjcDALOLD/G4jBqDAAAAAElFTkSuQmCC', 'base64'));
fs.writeFileSync(path.join(dir, 'assets/placeholder/crate.glb'), 'glTF placeholder');
sh('harness/art.mjs', 'propose', 'studio/art/concept.png', '--kind', 'style', '--title', 'Mossy pastel, soft light', '--by', 'art-1');
sh('harness/art.mjs', 'propose', 'assets/placeholder/crate.glb', '--title', 'Garden crate', '--thumb', 'studio/art/concept.png', '--by', 'art-1');
// 2.30e: two ended sessions (one finished its task) and a free model call with no usage, for the ledger tiles.
{
  // Over a day old, so the top bar's tokens-today stays "not tracked" (its own check below).
  const t = (minAgo) => new Date(Date.now() - (26 * 60 + minAgo) * 60000).toISOString();
  const ev = [
    { ts: t(50), type: 'agent.session.start', agent: 'builder-h1', task: 'T-101', meta: { role: 'builder', tool: 'claude' } },
    { ts: t(40), type: 'task.done', agent: 'builder-h1', task: 'T-101' },
    { ts: t(39), type: 'agent.session.end', agent: 'builder-h1', model: 'claude-sonnet', tokensIn: 2000, tokensOut: 1000, meta: { role: 'builder', tool: 'claude', turns: 12 } },
    { ts: t(30), type: 'agent.session.start', agent: 'builder-h2', task: 'T-102', meta: { role: 'builder', tool: 'claude' } },
    { ts: t(20), type: 'agent.session.end', agent: 'builder-h2', model: 'claude-sonnet', tokensIn: 3000, tokensOut: 500, meta: { role: 'builder', tool: 'claude', turns: 40 } },
    { ts: t(10), type: 'route.success', agent: 'liaison', provider: 'nvidia-nim', model: 'glm-flash', meta: { free: true, chars: 4000 } },
  ];
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  fs.appendFileSync(path.join(dir, '.studio', 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
// A fake local model for the Liaison chat: it answers with a brief straight away.
const fakeModel = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fake-cheap', choices: [{ message: { content: 'BRIEF {"kind":"idea","title":"Fireflies at dusk","summary":"Fireflies light the garden at dusk and visitors stay longer.","detail":""}' } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
});
await new Promise((r) => fakeModel.listen(0, '127.0.0.1', r));
env.OLLAMA_BASE_URL = `http://127.0.0.1:${fakeModel.address().port}/v1`;
env.STUDIO_PREPARE_CHAIN = 'ollama-local';
// A saved playable build for the Arcade: the browser check passes, so the build is kept.
// When the game's own browser check fails there is no build to play: the Arcade checks that need one are
// skipped and say why, instead of turning the HUD red for the game's bug (Jed's run: one red became three).
// (--only stop-pause never opens the Arcade, so it skips this.)
const noBuild = only ? true : sh('qa/browser-play.mjs', '--no-shots').status !== 0;
// 2.30c: a task the circuit breaker parked (two hand-backs for the same reason), and an overnight summary.
const trip = (() => {
  try {
    return JSON.parse(sh('harness/task.mjs', 'add', 'Tidy the credits screen', '--infra', '--role', 'reviewer').stdout).id;
  } catch {
    return null;
  }
})();
for (let i = 0; i < 2 && trip; i++) {
  sh('harness/task.mjs', 'start', trip, '--agent', 'rev-9');
  sh('harness/task.mjs', 'pause', trip, '--agent', 'rev-9', '--note', 'verify failed: the docs gate cannot find docs/CREDITS.md');
}
sh('harness/overnight.mjs', '--since', '8h');
sh('harness/ask.mjs', 'Which floor first?', '--options', 'Cubicle,Food court', '--default', 'Cubicle', '--timeout', '4h', '--why', 'it teaches the controls', '--by', 'prod-1');
fs.writeFileSync(path.join(dir, 'studio/floors.json'), JSON.stringify({ maxParallel: 2 }));
// 2.30h: the Director's card reads the flow pass and the CI watch.
fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
fs.writeFileSync(path.join(dir, '.studio/director-flow.json'), JSON.stringify({ at: new Date().toISOString(), state: 'starved', starved: true, idleFor: 12, builders: { running: 0, slots: 3, idle: 3, agents: [] }, agents: { running: 0, max: 4 }, ready: { total: 5, byRole: { builder: 5 }, held: 1 }, expired: [], actions: ['handed back T-1 (claim ran out)'], launcherWhy: 'builder: no tool set to start it' }));
fs.writeFileSync(path.join(dir, '.studio/ci-watch.json'), JSON.stringify({ sha: 'abcdef1234', state: 'red', failing: ['ci/windows'] }));
const bFloors = JSON.parse(fs.readFileSync(path.join(dir, "studio/bible/bible.json"), "utf8"));
bFloors.phase.floors = [{ n: 2, stage: 'build', by: 'hatch', openedAt: new Date().toISOString() }];
fs.writeFileSync(path.join(dir, 'studio/bible/bible.json'), JSON.stringify(bFloors));

const port = await new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const token = crypto.randomBytes(24).toString('hex');
const hub = spawn(process.execPath, ['hub/server.mjs'], { cwd: dir, env: { ...env, HUB_TOKEN: token, HUB_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let hubLog = '';
hub.stdout.on('data', (d) => (hubLog += d));
hub.stderr.on('data', (d) => (hubLog += d));
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 60; i++) {
  if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!(await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false))) {
  console.error(`[hud] FAIL the HUB did not start in the test copy:\n${hubLog.slice(-1500)}`);
  hub.kill();
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

let failed = 0;
let total = 0;
let skipped = 0;
const trace = process.env.HUD_TRACE === '1' ? (msg) => console.log(`[hud] trace ${msg}`) : () => {};
const needsBuild = (label, ok, detail) => {
  if (!noBuild) return check(label, ok, detail);
  skipped += 1;
  console.log(`[hud] SKIP ${label}: no playable build (the game's browser check failed; npm run play:browser says why)`);
};
const check = (label, ok, detail = '') => {
  total += 1;
  if (!ok) failed += 1;
  console.log(`[hud] ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
};
const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// P-044: a check after an action waits for the state it expects instead of reading the page once (the page
// refreshes every 2 s; on a busy CI box the result can land after a fixed pause). WAIT is one check's time;
// STOP_WAIT covers a stop, which kills a process tree, saves a patch and hands the task back.
const WAIT = waitBudget(15000);
const STOP_WAIT = waitBudget(30000);
const text = async (page, sel) => {
  const l = page.locator(sel);
  return (await l.count()) ? l.first().innerText() : `(no ${sel} on the page)`;
};
/** Wait until probe() says { ok: true } (holding for holdMs if given), then PASS; on time-out FAIL with what was seen. */
const expect = async (label, probe, { timeout = WAIT, holdMs = 0, interval = 250, more = null, gate = check } = {}) => {
  const r = await waitFor(probe, { timeout, holdMs, interval });
  trace(`${r.ok ? 'ok' : 'timed out'} after ${(r.ms / 1000).toFixed(1)} s: ${label}`);
  gate(label, r.ok, r.ok ? '' : `${r.message}${more ? await more() : ''}`);
  return r;
};
// A check that needs the saved build is skipped (not waited for) when there is none.
const expectBuild = (label, probe, opts = {}) => (noBuild ? needsBuild(label, false) : expect(label, probe, { ...opts, gate: needsBuild }));
// 2.41.0: what each agent's record and log said, printed when a stop check fails (the CI failure couldn't be
// reproduced locally; this shows its cause next time).
const agentsDiag = () => {
  const d = path.join(dir, '.studio', 'agents');
  if (!fs.existsSync(d)) return '';
  const out = [];
  for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json'))) {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch {}
    const log = (() => { try { return fs.readFileSync(path.join(dir, j.log || ''), 'utf8').split('\n').slice(-6).join(' | '); } catch { return ''; } })();
    out.push(`${f}: status ${j.status} pid ${j.pid} supervisor ${j.supervisor} task ${j.task} started ${j.startedAt} ended ${j.endedAt || '-'} reason ${j.reason || '-'}; log: ${log.slice(-600)}`);
  }
  const ev = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter((l) => /agent\.(stopped|paused|session|wake|refresh|failover)|launch/.test(l)).slice(-15).join('\n'); } catch { return ''; } })();
  return `\n--- agent records ---\n${out.join('\n')}\n--- agent events ---\n${ev}`;
};
const noAgents = (t) => /No agents started from here yet/.test(t);
const launchedEmpty = (page) => async () => {
  const t = await text(page, '#o-launched');
  return { ok: noAgents(t), seen: t };
};
// 2.41.0: press Stop (or Pause) once for each agent listed, by name, and wait for the list to empty; an
// agent still listed after that gets one more press. P-044: each press waits for the HUB's answer before the
// next one (it was a fixed half second).
const stopEach = async (page, attr) => {
  for (let round = 0; round < 2; round++) {
    if (noAgents(await text(page, '#o-launched'))) return;
    const names = [...new Set(await page.locator(`#o-launched [data-${attr}]`).evaluateAll((els, a) => els.map((e) => e.getAttribute(`data-${a}`)), attr))];
    for (const name of names) {
      // The list is redrawn every 2 s; a press that lands mid-redraw is lost (no request), so a press the HUB
      // didn't answer is made again while the button is there.
      for (let press = 1; press <= 3; press++) {
        const btn = page.locator(`#o-launched [data-${attr}="${name}"]`);
        if (!(await btn.count())) break;
        const answered = page.waitForResponse((r) => r.url().endsWith('/api/agents') && r.request().method() === 'POST', { timeout: waitBudget(8000) });
        answered.catch(() => {});
        const clicked = await btn.first().click({ timeout: WAIT }).then(() => true, (e) => (trace(`${attr} ${name}: the press failed (${String(e.message).split('\n')[0]})`), false));
        const res = clicked ? await answered.catch(() => null) : null;
        trace(`${attr} ${name} (round ${round + 1}, press ${press}): HUB answered ${res ? res.status() : 'nothing'}`);
        if (res) break;
      }
    }
    const r = await waitFor(launchedEmpty(page), { timeout: STOP_WAIT });
    trace(`${attr} round ${round + 1}: list ${r.ok ? 'empty' : 'still listed'} after ${(r.ms / 1000).toFixed(1)} s${r.ok ? '' : `: ${r.seen.replace(/\s+/g, ' ').slice(0, 300)}`}`);
    if (r.ok) return;
  }
};
const skinOf = (page) => page.evaluate(() => document.body.dataset.skin);
const goTo = async (page, to) => {
  const cur = await skinOf(page);
  if (cur !== to) await page.click(`#${cur} .switch[data-to="${to}"]`);
  await expect.quiet(async () => ({ ok: (await skinOf(page)) === to, seen: `view ${await skinOf(page)}` }));
};
// Waits that aren't checks of their own (they decide what is checked next).
expect.quiet = (probe, opts = {}) => waitFor(probe, { timeout: WAIT, ...opts });

/** Start agent, Stop, + Hire, Pause: the checks that flaked on main (P-044). */
const agentChecks = async (page) => {
  await goTo(page, 'ops');
  await page.selectOption('#o-arole', 'builder');
  await page.click('#o-agentform button');
  await expect('Start agent launches one, and it shows with its heartbeat', async () => {
    const t = await text(page, '#o-launched');
    return { ok: /builder-/.test(t) && /heartbeat/.test(t), seen: `${t} | message: ${await text(page, '#o-actmsg')}` };
  });
  // Stop every agent started from the page (the bug note above woke a builder too).
  // Stopping kills the process tree, saves a patch and hands the task back: on Windows, or a busy CI box, that
  // takes a few seconds (Gemini's run raced it). Each agent is stopped by name, once (2.41.0: clicking "the
  // first" Stop every 3 s kept hitting an agent still stopping and never reached the second), then the page
  // must say so, and keep saying so through a full refresh (2.5 s; the page refreshes every 2 s).
  await stopEach(page, 'stopagent');
  await expect('Stop ends it and hands its task back', launchedEmpty(page), { holdMs: 2500, more: agentsDiag });
  // + Hire in an open room of the Studio view: an agent for that department, which Pause hands back.
  await goTo(page, 'tycoon');
  await page.locator('#tycoon [data-hire="engineering"]').first().click();
  await goTo(page, 'ops');
  await expect('+ Hire in an open room hires an agent for that department, with a Pause button', async () => {
    const t = await text(page, '#o-launched');
    return { ok: /builder-/.test(t) && (await page.locator('#o-launched [data-pauseagent]').count()) > 0, seen: `${t} | message: ${await text(page, '#o-actmsg')}` };
  });
  await stopEach(page, 'pauseagent');
  await expect('Pause stops it and hands its task back', launchedEmpty(page), { holdMs: 2500, more: agentsDiag });
};

try {
  for (const [w, h, size] of only ? [] : [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const skin of ['ops', 'tycoon', 'plan', 'assets', 'arcade']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errs.push(m.text()));
      page.on('pageerror', (e) => errs.push(String(e)));
      page.on('response', (r) => r.status() >= 400 && r.url().startsWith(BASE) && errs.push(`${r.status()} ${r.url()}`));
      const loaded = Date.now();
      await page.goto(`${BASE}/?skin=${skin}`);
      // Wait for the first refresh to draw this view (every view has the signals strip with the pace), then
      // keep watching for errors until 3.5 s after the load: "no errors" can be watched for, not waited for.
      const drawn = await expect.quiet(async () => {
        const t = await text(page, `#${skin} [data-signals]`);
        return { ok: /Pace/.test(t), seen: t };
      });
      if (Date.now() - loaded < 3500) await wait(3500 - (Date.now() - loaded));
      const wide = await page.evaluate((s) => [...document.querySelectorAll(`#${s} *`)].filter((e) => !e.closest('.ticker') && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}`), skin);
      check(`${size} ${skin}: loads without errors`, errs.length === 0 && drawn.ok, [drawn.ok ? '' : `the view never drew: ${drawn.message}`, ...errs.slice(0, 3)].filter(Boolean).join(' | '));
      check(`${size} ${skin}: nothing runs off the side`, wide.length === 0, wide.join(', '));
      if (skin === 'ops') {
        await expect(`${size} ops: the Director card shows the flow (starved, builders 0/3) and the red CI job (2.30h)`, async () => {
          const t = await text(page, '#o-director');
          return { ok: /starved/.test(t) && /builders 0\/3/.test(t) && /ci\/windows/.test(t), seen: t };
        });
        await expect(`${size} ops: the Floors card shows the main phase and Floor 2 (2.30f)`, async () => {
          const t = await text(page, '#o-floors');
          return { ok: /Main Phase 1/.test(t) && /Floor 2/.test(t), seen: t };
        });
      }
      if (shotsAt) {
        fs.mkdirSync(shotsAt, { recursive: true });
        await page.screenshot({ path: path.join(shotsAt, `${size}-${skin}.png`), fullPage: true });
        const floorsCard = page.locator('#o-floors');
        if (skin === 'ops' && await floorsCard.count()) await floorsCard.first().screenshot({ path: path.join(shotsAt, `floors-${size}-${skin}.png`) }).catch(() => {});
      }
      await ctx.close();
    }
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  // When each Game plan refresh (GET /api/bible) was asked for and that it finished: "after the next refresh".
  const planLoads = [];
  const asked = new WeakMap();
  page.on('request', (r) => asked.set(r, Date.now()));
  page.on('requestfinished', (r) => r.method() === 'GET' && new URL(r.url()).pathname === '/api/bible' && planLoads.push(asked.get(r) || 0));
  await page.goto(`${BASE}/?skin=ops&token=${token}`);
  if (!only) {
    await expect('the token leaves the address bar', () => ({ ok: !page.url().includes('token='), seen: page.url().replace(/token=[^&#]*/, 'token=(hidden)') }));
    await expect('the Ops view lists the working agent', async () => {
      const t = await text(page, '#o-agents');
      return { ok: /balancer-1/.test(t), seen: t };
    });
    await page.locator('#o-agents').getByText('balancer-1').first().click();
    await expect('clicking an agent opens its drawer on its task', async () => {
      const hidden = await page.locator('#drawer').getAttribute('aria-hidden');
      const body = await text(page, '#dr-body');
      return { ok: hidden === 'false' && /T-002/.test(body), seen: `drawer aria-hidden=${hidden} | ${body}` };
    });
    await page.keyboard.press('Escape');
    await expect('Escape closes the drawer', async () => {
      const hidden = await page.locator('#drawer').getAttribute('aria-hidden');
      return { ok: hidden === 'true', seen: `drawer aria-hidden=${hidden}` };
    });
    await page.fill('#o-name', 'hatch');
    await page.click('#o-save');
    await page.fill('#o-title', 'Docs: write the visitors hand-off');
    await page.click('#o-add button');
    await expect('adding a task from the page queues it', async () => {
      const q = await text(page, '#o-queue');
      const inNext = /visitors hand-off/.test(read('studio/NEXT.md'));
      return { ok: inNext && /visitors hand-off|more in studio\/NEXT\.md/.test(q), seen: `in NEXT.md: ${inNext} | message: ${await text(page, '#o-actmsg')} | queue: ${q.slice(0, 400)}` };
    });
    await page.fill('#o-msg', 'Please check the balance sweep tonight');
    await page.click('#o-inbox button');
    await expect('a message reaches the Producer\'s inbox', () => ({ ok: /balance sweep tonight/.test(read('studio/producer/INBOX.md')), seen: `INBOX.md: ${read('studio/producer/INBOX.md').slice(-300)}` }));
    const stopState = async () => {
      const file = fs.existsSync(path.join(dir, '.studio/STOP.json'));
      const banner = await page.locator('#o-stop').isVisible();
      const btn = await text(page, '#o-stopbtn');
      return { file, banner, btn, seen: `STOP.json ${file ? 'there' : 'absent'} | banner ${banner ? 'shown' : 'hidden'} | button "${btn}"` };
    };
    await page.click('#o-stopbtn');
    await expect('Stop all agents stops the studio and says so', async () => {
      const s = await stopState();
      return { ok: s.file && s.banner && /Resume/.test(s.btn), seen: s.seen };
    });
    await page.click('#o-stopbtn');
    await expect('Resume clears it', async () => {
      const s = await stopState();
      return { ok: !s.file && !s.banner, seen: s.seen };
    });
    await expect('the queue lists every open task and scrolls in its box', async () => {
      const qbox = await page.locator('#o-queue').evaluate((e) => ({ scrolls: getComputedStyle(e).overflowY === 'auto', shown: e.querySelectorAll('.task').length }));
      return { ok: qbox.scrolls && qbox.shown >= 10, seen: JSON.stringify(qbox) };
    });
    sh('harness/event.mjs', '--type', 'task.progress', '--agent', 'balancer-1', '--task', 'T-002', '--msg', 'LIVE-CHECK 77');
    await expect('new events appear without reloading', async () => {
      const t = await text(page, '#o-timeline');
      return { ok: /LIVE-CHECK 77/.test(t), seen: t.slice(0, 400) };
    });
    await goTo(page, 'tycoon');
    await expect('the Studio view seats the Producer and the person in the Producer\'s office', async () => {
      const office = await text(page, '#t-office');
      return { ok: /prod-1/.test(office) && /hatch/.test(office), seen: office };
    });
    await expect('unmeasured numbers say so instead of showing 0, and Checks names a red check', async () => {
      const top = await text(page, '#tycoon .top');
      return { ok: /not tracked/.test(await text(page, '#t-tokens')) && !/Fans/.test(top), seen: top };
    });
    await goTo(page, 'plan');
    await expect('the Game plan shows the signed Bible, the open phase and the idea', async () => {
      const plan = await text(page, '#plan');
      return { ok: /Signed by hatch/.test(plan) && /Phase 1/.test(plan) && /I-001/.test(plan), seen: plan.slice(0, 600) };
    });
    await page.fill('#p-ititle', 'Rainy day visitors');
    await page.click('#p-idea button');
    await expect('pitching an idea adds a card and says R&D has it', async () => {
      const msg = await text(page, '#p-msg');
      const board = /Rainy day visitors/.test(await text(page, '#p-board'));
      const inNext = /Idea: shape I-002/.test(read('studio/NEXT.md'));
      return { ok: board && inNext && /No tool is set to start R&D/.test(msg), seen: `card on the board: ${board} | in NEXT.md: ${inNext} | message: ${msg}` };
    });
    const fu = page.locator('#p-fu input[data-key]');
    const fuShown = await expect.quiet(async () => ({ ok: (await fu.count()) > 0, seen: await text(page, '#p-fu') }));
    if (fuShown.ok) {
      await fu.first().fill('Moss spreads slower in shade');
      await page.click('#p-fu button');
      await expect('answering a follow-up saves it to the Bible', () => ({ ok: /Moss spreads slower/.test(read('studio/bible/bible.json')), seen: `follow-ups in the Bible: ${JSON.stringify(JSON.parse(read('studio/bible/bible.json') || '{}').followups ?? '(none)').slice(0, 300)}` }));
    } else check('follow-up questions are shown', false, fuShown.message);
    await expect('the sharing box starts ticked, and an automated visit is not recorded as the dev seeing it', async () => {
      const ticked = await page.isChecked('#p-share');
      const file = read('studio/data-consent.json');
      return { ok: ticked && !/"shown": true/.test(file || ''), seen: `ticked ${ticked} | ${file || '(no file)'}` };
    });
    await page.click('#p-share');
    await expect('unticking the box records a decline', () => ({ ok: /"how": "declined"/.test(read('studio/data-consent.json')), seen: read('studio/data-consent.json') || '(no file)' }));
    // Wait for a Game plan refresh asked for after the decline was saved, then the box must stay unticked
    // (held 1 s, so that refresh has drawn).
    const declinedAt = Date.now();
    await expect('the box stays unticked after the next refresh', async () => {
      const refreshed = planLoads.some((t) => t > declinedAt);
      const ticked = await page.isChecked('#p-share');
      return { ok: refreshed && !ticked, seen: `a refresh since the decline: ${refreshed} | ticked ${ticked} | ${await text(page, '#p-sharemsg')}` };
    }, { timeout: waitBudget(20000), holdMs: 1000 });
    // The lever is on every view; pulling it turns MAX SPEED on for the whole studio.
    await page.click('#plan [data-speed]');
    await expect('the MAX SPEED lever turns boost on, and every view shows it', async () => {
      const boost = JSON.parse(read('studio/mode.json') || '{}').boost;
      const on = await page.locator('[data-speed][aria-pressed="true"]').count();
      const all = await page.locator('.skin [data-speed]').count();
      return { ok: boost?.on === true && on === all, seen: `mode.json boost ${JSON.stringify(boost ?? null)} | levers pressed ${on} of ${all}` };
    });
    await page.click('#plan [data-mode="fast"]');
    await expect('choosing a pace in the Game plan records it', async () => {
      const mode = JSON.parse(read('studio/mode.json') || '{}').mode;
      const msg = await text(page, '#p-modemsg');
      return { ok: mode === 'fast' && /Fast and furious/.test(msg), seen: `mode.json mode ${mode} | message: ${msg}` };
    });
    await expect('the studio\'s question shows with its default and deadline', async () => {
      const t = await text(page, '#p-asks');
      return { ok: /Which floor first\?/.test(t) && /if you don't answer by/.test(t), seen: t };
    });
    await page.click('#p-asks [data-answer="Food court"]');
    await expect('answering it with one click records the answer', () => ({ ok: /"answer": "Food court"/.test(read('studio/asks/A-001.json')), seen: read('studio/asks/A-001.json') || '(no file)' }));
    await expect('the signals strip shows the pace on every view', async () => {
      const pace = await page.locator('[data-signals] .sig.pace').count();
      const strips = await page.locator('.skin [data-signals]').count();
      return { ok: pace === strips, seen: `pace shown on ${pace} of ${strips} strips` };
    });
    // The Liaison chat: the model reads a brief back; nothing moves until "Yes, send it".
    await page.fill('#p-chatin', 'I want fireflies in the garden at night');
    await page.click('#p-chat button');
    await expect('the Liaison reads back what it understood, with a yes button', async () => {
      const log = await text(page, '#p-chatlog');
      const yes = await page.locator('#p-chatlog [data-brief="confirm"]').count();
      const sent = /Fireflies/.test(read('studio/NEXT.md'));
      return { ok: /Fireflies at dusk/.test(log) && yes === 1 && !sent, seen: `yes buttons ${yes} | already in NEXT.md: ${sent} | ${log}` };
    });
    await page.click('#p-chatlog [data-brief="confirm"]');
    await expect('saying yes sends it to R&D and says what happens next', async () => {
      const log = await text(page, '#p-chatlog');
      const inNext = /Idea: shape I-\d+ Fireflies at dusk/.test(read('studio/NEXT.md'));
      return { ok: inNext && /sent on as I-/.test(log), seen: `in NEXT.md: ${inNext} | ${log}` };
    });
    await expect('the Game plan points to the Asset studio with what is waiting', async () => {
      const t = await text(page, '#p-designs');
      return { ok: /2 waiting for you/.test(t), seen: t };
    });
    // The Asset studio (view 4): designs by number and round, thumbs up, words for the next round, references.
    await goTo(page, 'assets');
    await expect('the Asset studio shows each design by number and round, with its picture', async () => {
      const waiting = await text(page, '#a-waiting');
      const imgOk = await page.locator('#a-waiting img').first().evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
      const sig = (await page.locator('#assets [data-signals] .sig.you').getAttribute('title', { timeout: 1000 }).catch(() => null)) || '';
      return { ok: /#1\s*Mossy pastel/.test(waiting) && /#2\s*Garden crate/.test(waiting) && /round 1/.test(waiting) && imgOk && /2 designs waiting in the Asset studio/.test(sig), seen: `picture loaded: ${imgOk} | signal: ${sig || '(none)'} | ${waiting}` };
    });
    await page.locator('#a-waiting .acard', { hasText: 'Garden crate' }).locator('input[data-note]').fill('make it rounder, like a planter');
    await page.locator('#a-waiting .acard', { hasText: 'Garden crate' }).locator('[data-art="changes"]').click();
    await expect('"Change this" gives the art department its next round with your words', async () => {
      const msg = await text(page, '#a-msg');
      const inNext = /Art: round 2 of #2 Garden crate: make it rounder/.test(read('studio/NEXT.md'));
      const works = await text(page, '#a-works');
      return { ok: inNext && /round 2 of #2/.test(msg) && /Garden crate/.test(works), seen: `in NEXT.md: ${inNext} | message: ${msg} | in the works: ${works}` };
    });
    await page.fill('#a-saytext', 'crate #2 needs a lid too');
    await page.click('#a-say button');
    await expect('typed feedback naming #2 joins its open round instead of a new task', async () => {
      const msg = await text(page, '#a-msg');
      const rounds = (read('studio/NEXT.md').match(/of #2 Garden crate/g) || []).length;
      return { ok: rounds === 1 && /added to its open round/.test(msg), seen: `tasks for #2 in NEXT.md: ${rounds} | message: ${msg}` };
    });
    await page.locator('#a-waiting .acard', { hasText: 'Mossy pastel' }).locator('[data-art="approve"]').click();
    await expect('a thumbs up on the style sheet makes it the art reference', async () => {
      const msg = await text(page, '#a-msg');
      const inBible = /"artReference"/.test(read('studio/bible/bible.json'));
      const approved = await text(page, '#a-approved');
      return { ok: inBible && /art reference/.test(msg) && /Mossy pastel/.test(approved), seen: `in the Bible: ${inBible} | message: ${msg} | approved: ${approved}` };
    });
    await page.setInputFiles('#a-reffile', path.join(dir, 'studio/art/concept.png'));
    await page.fill('#a-reflabel', 'the moss colour I want');
    await page.click('#a-ref button');
    await expect('a labelled reference from the dev is listed for the art department', async () => {
      const refs = await text(page, '#a-refs');
      const saved = /the moss colour I want/.test(read('studio/art/references.json'));
      return { ok: /the moss colour I want/.test(refs) && saved, seen: `in references.json: ${saved} | message: ${await text(page, '#a-refmsg')} | listed: ${refs}` };
    });
    // The Arcade (view 5): the last good build plays in the page; notes go out; the dungeon is read-only.
    await goTo(page, 'arcade');
    await expectBuild('the Arcade plays the last build that passed the browser check', async () => {
      const src = (await page.locator('#r-frame').getAttribute('src')) || '';
      const hud = await page.frameLocator('#r-frame').locator('.hud').innerText({ timeout: 1000 }).catch(() => '');
      const build = await text(page, '#r-build');
      return { ok: /\/play\/[^/]+\/web\/example-sim\/index\.html/.test(src) && /Credits\s*\d+/.test(hud) && /won at tick/.test(build), seen: `frame ${src || '(none)'} | game HUD: ${hud || '(empty)'} | ${build}` };
    });
    await page.locator('#r-dungeon').click({ position: { x: 20, y: 20 } });
    await page.keyboard.press('ArrowRight');
    await expect('the dungeon shows a task when the hero walks into its room', async () => {
      const card = await text(page, '#r-card');
      return { ok: /T-\d+/.test(card), seen: card };
    });
    await page.fill('#r-notetext', 'the end screen text overlaps the HUD');
    await page.selectOption('#r-notekind', 'bug');
    await page.click('#r-note button');
    await expectBuild('a note taken while playing becomes a bug task, saved with the build it was about', async () => {
      const inNext = /Bug: the end screen text overlaps the HUD \(seen playing build /.test(read('studio/NEXT.md'));
      const inNotes = /the end screen text overlaps/.test(read('studio/playtest/NOTES.md'));
      return { ok: inNext && inNotes, seen: `in NEXT.md: ${inNext} | in NOTES.md: ${inNotes} | message: ${await text(page, '#r-notemsg')}` };
    });
    // "Is it fun?": a person's verdict on the build being played (what lets a phase close).
    await page.click('#arcade [data-fun="yes"]');
    await expectBuild('"Yes, it\'s fun" in the Arcade records a verdict on the build being played', async () => {
      const v = read('studio/playtest/verdicts.json');
      const msg = await text(page, '#r-notemsg');
      return { ok: /"fun": "yes"/.test(v) && /"build": "/.test(v) && /is fun/.test(msg), seen: `message: ${msg} | verdicts.json: ${v || '(no file)'}` };
    });
  }

  // The agent checks: once in a full run; --only stop-pause --repeat <n> runs just these, n times.
  const rounds = [];
  for (let i = 1; i <= repeat; i++) {
    if (repeat > 1) console.log(`[hud] stop-pause round ${i} of ${repeat}`);
    const before = failed;
    const started = Date.now();
    await agentChecks(page);
    rounds.push({ ok: failed === before, s: (Date.now() - started) / 1000 });
  }
  if (only) {
    const secs = rounds.map((r) => r.s).sort((a, b) => a - b);
    const mid = secs[Math.floor((secs.length - 1) / 2)];
    console.log(`[hud] ${only}: ${rounds.filter((r) => r.ok).length} of ${rounds.length} rounds passed; seconds per round min ${secs[0].toFixed(1)}, median ${mid.toFixed(1)}, max ${secs[secs.length - 1].toFixed(1)} (${rounds.map((r) => `${r.ok ? '' : 'FAIL '}${r.s.toFixed(1)}`).join(', ')})`);
  }

  if (!only) {
    // Throw it all away and restart: two warnings back to back; Cancel on the second changes nothing.
    await page.click('#o-restart');
    const warn1 = await expect.quiet(async () => {
      const t = await text(page, '#o-restartbox');
      return { ok: /Throw away/.test(t) && /git tag/.test(t), seen: t };
    });
    await page.click('#o-restartyes');
    const warn2 = await expect.quiet(async () => {
      const t = await text(page, '#o-restartbox');
      return { ok: /Last warning/.test(t), seen: t };
    });
    await page.click('#o-restartno');
    const cancelled = await expect.quiet(async () => {
      const hidden = await page.locator('#o-restartbox').isHidden();
      const msg = await text(page, '#o-actmsg');
      return { ok: hidden && /Nothing changed/.test(msg), seen: `box ${hidden ? 'hidden' : 'still shown'} | message: ${msg}` };
    });
    const kept = fs.existsSync(path.join(dir, 'cartridges/example-sim/index.mjs')) && !/archive\//.test(spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).stdout || '');
    check('the restart button warns twice, and Cancel on the second warning changes nothing', warn1.ok && warn2.ok && cancelled.ok && kept, [warn1, warn2, cancelled].map((r) => (r.ok ? r.seen : r.message)).join(' / ') + (kept ? '' : ' / the game or the tags changed'));
    // 2.30c: the breaker card with Unblock, the Producer's wake line and the overnight summary in Ops.
    await goTo(page, 'ops');
    await expect('2.30c: a task the circuit breaker parked has a card with Unblock, and the status line says when the Producer starts and where the overnight summary is', async () => {
      const holdTxt = await text(page, '#o-holdlist');
      const statusTxt = await text(page, '#o-status');
      const button = trip ? await page.locator(`#o-holdlist [data-need="unblock"][data-task="${trip}"]`).count() : 0;
      return { ok: Boolean(trip) && /circuit breaker/.test(holdTxt) && button === 1 && /Producer: /.test(statusTxt) && /overnight-\d{4}-\d{2}-\d{2}\.md/.test(statusTxt), seen: `parked task ${trip || '(none)'} | Unblock buttons ${button} | ${holdTxt} | ${statusTxt}` };
    });
    await page.locator('#o-hold').scrollIntoViewIfNeeded().catch(() => {});
    if (shotsAt) await page.screenshot({ path: path.join(shotsAt, '230c-ops-breaker-card.png'), fullPage: false });
    if (shotsAt) await page.locator('#o-status').screenshot({ path: path.join(shotsAt, '230c-status-line.png') }).catch(() => {});
    await page.locator(`#o-holdlist [data-need="unblock"][data-task="${trip}"]`).click({ timeout: WAIT }).catch(() => {});
    await expect('2.30c: Unblock clears the breaker: the card goes and the task can start again', async () => {
      const holdTxt = await text(page, '#o-holdlist');
      let hold = null;
      try { hold = (JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks || {})[trip] || null; } catch {}
      return { ok: !/circuit breaker/.test(holdTxt) && !hold?.parked, seen: `hold ${JSON.stringify(hold)} | ${holdTxt}` };
    });
    if (shotsAt) await page.screenshot({ path: path.join(shotsAt, '230c-ops-after-unblock.png'), fullPage: false });
  }
  check('no script errors while using it', errs.length === 0, errs.join(' | '));

  if (!only) {
    // 2.30e: the token ledger tiles, from the seeded sessions: 3k tokens for the one finished task, 1 of 2
    // sessions ended with no task done, turns 12 / 40, and the free model flagged as estimated.
    await page.setViewportSize({ width: 1280, height: 800 });
    const tileText = async (id) => (await page.locator(`#o-ledger [data-tile="${id}"]`).innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ');
    // The no-done share counts every session in this run's events (earlier steps start and pause agents), so compare with the ledger's own number.
    const ledgerNoDone = () => { try { return Math.round(JSON.parse(spawnSync(process.execPath, [path.join(dir, 'harness/ledger.mjs'), '--json'], { cwd: dir, encoding: 'utf8' }).stdout).noDonePct); } catch { return 'x'; } };
    const tilesNow = async () => ({ count: await page.locator('#o-ledger .tile').count(), task: await tileText('tokens-per-task'), nodone: await tileText('no-done'), turns: await tileText('turns'), budget: await tileText('budget'), note: await page.locator('#o-ledger .tiles-note').innerText({ timeout: 1000 }).catch(() => '') });
    await expect('the ledger tiles show tokens per finished task, no-done %, turns p50/p95 and the budget', async () => {
      const tiles = await tilesNow();
      const nd = ledgerNoDone();
      return { ok: tiles.count === 4 && /3k tokens per finished task/.test(tiles.task) && new RegExp(`^${nd}% sessions with no task done`).test(tiles.nodone.trim()) && /12 \/ 40 turns/.test(tiles.turns) && /(\d+%|cap off) daily budget used/.test(tiles.budget) && /nvidia-nim \(est\.\)/.test(tiles.note), seen: `ledger says ${nd}% no-done | ${JSON.stringify(tiles)}` };
    }, { interval: 1000, timeout: waitBudget(40000) }); // the HUB caches the ledger for 30 s (harness/hud.mjs): a session that ended since shows after that
    await expect('every token count on the ledger tiles names its model (one model, or a mixed share)', async () => {
      const taskModel = await page.locator('#o-ledger [data-tile="tokens-per-task"] [data-models]').innerText({ timeout: 1000 }).catch(() => '');
      const note = await page.locator('#o-ledger .tiles-note').innerText({ timeout: 1000 }).catch(() => '');
      return { ok: /claude|mixed: /.test(taskModel) && /Models: /.test(note), seen: JSON.stringify({ taskModel, note }) };
    });
    const box = page.locator('#o-ledgerbox');
    await box.scrollIntoViewIfNeeded();
    if (shotsAt) fs.mkdirSync(shotsAt, { recursive: true }), await box.screenshot({ path: path.join(shotsAt, 'ledger-tiles-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect('the ledger tiles wrap on a phone with no sideways scroll', async () => {
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      const n = await page.locator('#o-ledger .tile').count();
      return { ok: !sideways && n === 4, seen: `scrollWidth past the screen: ${sideways} | tiles ${n}` };
    });
    if (shotsAt) await box.screenshot({ path: path.join(shotsAt, 'ledger-tiles-phone.png') });
  }
} finally {
  await browser.close();
  hub.kill();
  fakeModel.close();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `[hud] ${failed} of ${total} checks failed` : `[hud] ok: ${total} checks${only ? ` (--only ${only}${repeat > 1 ? `, ${repeat} rounds` : ''})` : ' across the Ops, Studio and Game plan views'}${skipped ? ` (${skipped} skipped: no playable build)` : ''}`);
process.exit(failed ? 1 : 0);
