#!/usr/bin/env node
/**
 * qa/hud-check.mjs — open the War Room in a real browser and use it like a person would.
 *
 *   node qa/hud-check.mjs [--shots <folder>]
 *
 * Copies the repo to a temporary folder, fills it with a small studio (a signed Bible, tasks, an
 * agent at work, an idea, a playtest), starts the HUB there and drives Chromium through all three
 * views at desktop and phone sizes: no console errors, no sideways scroll, the agent drawer, adding a
 * task, messaging the Producer, live updates, pitching an idea, answering a follow-up, and the
 * data-sharing box. Your own studio is never touched. Skips (exit 0) when Playwright or Chromium
 * isn't installed; set PLAYWRIGHT_CHROMIUM to a Chromium binary to use a specific one.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const shotsAt = argv.includes('--shots') ? path.resolve(argv[argv.indexOf('--shots') + 1]) : null;
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('[hud] SKIP Playwright is not installed (npm install)');
  process.exit(0);
}
const exe = process.env.PLAYWRIGHT_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {}).catch((err) => {
  console.log(`[hud] SKIP Chromium did not start (${err.message.split('\n')[0]}). Run: npx playwright install chromium`);
  process.exit(0);
});

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
sh('harness/ask.mjs', 'Which floor first?', '--options', 'Cubicle,Food court', '--default', 'Cubicle', '--timeout', '4h', '--why', 'it teaches the controls', '--by', 'prod-1');

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
const check = (label, ok, detail = '') => {
  total += 1;
  if (!ok) failed += 1;
  console.log(`[hud] ${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
};
const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8') : '');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (const [w, h, size] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const skin of ['ops', 'tycoon', 'plan']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const errs = [];
      page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && errs.push(m.text()));
      page.on('pageerror', (e) => errs.push(String(e)));
      page.on('response', (r) => r.status() >= 400 && r.url().startsWith(BASE) && errs.push(`${r.status()} ${r.url()}`));
      await page.goto(`${BASE}/?skin=${skin}`);
      await wait(3500);
      const wide = await page.evaluate((s) => [...document.querySelectorAll(`#${s} *`)].filter((e) => !e.closest('.ticker') && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > innerWidth + 1).slice(0, 3).map((e) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}`), skin);
      check(`${size} ${skin}: loads without errors`, errs.length === 0, errs.slice(0, 3).join(' | '));
      check(`${size} ${skin}: nothing runs off the side`, wide.length === 0, wide.join(', '));
      if (shotsAt) {
        fs.mkdirSync(shotsAt, { recursive: true });
        await page.screenshot({ path: path.join(shotsAt, `${size}-${skin}.png`), fullPage: true });
      }
      await ctx.close();
    }
  }

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${BASE}/?skin=ops&token=${token}`);
  await wait(2500);
  check('the token leaves the address bar', !page.url().includes('token='));
  check('the Ops view lists the working agent', /balancer-1/.test(await page.locator('#o-agents').innerText()));
  await page.locator('#o-agents').getByText('balancer-1').first().click();
  await wait(1200);
  check('clicking an agent opens its drawer on its task', (await page.locator('#drawer').getAttribute('aria-hidden')) === 'false' && /T-002/.test(await page.locator('#dr-body').innerText()));
  await page.keyboard.press('Escape');
  await wait(300);
  check('Escape closes the drawer', (await page.locator('#drawer').getAttribute('aria-hidden')) === 'true');
  await page.fill('#o-name', 'hatch');
  await page.click('#o-save');
  await page.fill('#o-title', 'Docs: write the visitors hand-off');
  await page.click('#o-add button');
  await wait(2500);
  check('adding a task from the page queues it', /visitors hand-off/.test(read('studio/NEXT.md')) && /visitors hand-off|more in studio\/NEXT\.md/.test(await page.locator('#o-queue').innerText()), await page.locator('#o-actmsg').innerText());
  await page.fill('#o-msg', 'Please check the balance sweep tonight');
  await page.click('#o-inbox button');
  await wait(1200);
  check('a message reaches the Producer\'s inbox', /balance sweep tonight/.test(read('studio/producer/INBOX.md')));
  await page.click('#o-stopbtn');
  await wait(2500);
  check('Stop all agents stops the studio and says so', fs.existsSync(path.join(dir, '.studio/STOP.json')) && (await page.locator('#o-stop').isVisible()) && /Resume/.test(await page.locator('#o-stopbtn').innerText()));
  await page.click('#o-stopbtn');
  await wait(2500);
  check('Resume clears it', !fs.existsSync(path.join(dir, '.studio/STOP.json')) && !(await page.locator('#o-stop').isVisible()));
  const qbox = await page.locator('#o-queue').evaluate((e) => ({ scrolls: getComputedStyle(e).overflowY === 'auto', shown: e.querySelectorAll('.task').length }));
  check('the queue lists every open task and scrolls in its box', qbox.scrolls && qbox.shown >= 10, JSON.stringify(qbox));
  sh('harness/event.mjs', '--type', 'task.progress', '--agent', 'balancer-1', '--task', 'T-002', '--msg', 'LIVE-CHECK 77');
  await wait(3000);
  check('new events appear without reloading', /LIVE-CHECK 77/.test(await page.locator('#o-timeline').innerText()));
  await page.click('#ops .switch[data-to="tycoon"]');
  await wait(2000);
  const office = await page.locator('#t-office').innerText();
  check('the Studio view seats the Producer and the person in the Producer\'s office', /prod-1/.test(office) && /hatch/.test(office));
  await page.click('#tycoon .switch[data-to="plan"]');
  await wait(2500);
  const plan = await page.locator('#plan').innerText();
  check('the Game plan shows the signed Bible, the open phase and the idea', /Signed by hatch/.test(plan) && /Phase 1/.test(plan) && /I-001/.test(plan));
  await page.fill('#p-ititle', 'Rainy day visitors');
  await page.click('#p-idea button');
  await wait(5500);
  check('pitching an idea adds a card', /Rainy day visitors/.test(await page.locator('#p-board').innerText()));
  const fu = page.locator('#p-fu input[data-key]');
  if (await fu.count()) {
    await fu.first().fill('Moss spreads slower in shade');
    await page.click('#p-fu button');
    await wait(1200);
    check('answering a follow-up saves it to the Bible', /Moss spreads slower/.test(read('studio/bible/bible.json')));
  } else check('follow-up questions are shown', false);
  check('the sharing box starts ticked and is recorded as shown', (await page.isChecked('#p-share')) && /"shown": true/.test(read('studio/data-consent.json')));
  await page.click('#p-share');
  await wait(1200);
  check('unticking the box records a decline', /"how": "declined"/.test(read('studio/data-consent.json')));
  await wait(5500);
  check('the box stays unticked after the next refresh', !(await page.isChecked('#p-share')));
  // The lever is on every view; pulling it turns MAX SPEED on for the whole studio.
  await page.click('#plan [data-speed]');
  await wait(2500);
  const boost = JSON.parse(read('studio/mode.json') || '{}').boost;
  check('the MAX SPEED lever turns boost on, and every view shows it', boost?.on === true && (await page.locator('[data-speed][aria-pressed="true"]').count()) === 3);
  await page.click('#plan [data-mode="fast"]');
  await wait(2000);
  check('choosing a pace in the Game plan records it', JSON.parse(read('studio/mode.json') || '{}').mode === 'fast' && /Fast and furious/.test(await page.locator('#p-modemsg').innerText()));
  check('the studio\'s question shows with its default and deadline', /Which floor first\?/.test(await page.locator('#p-asks').innerText()) && /if you don't answer by/.test(await page.locator('#p-asks').innerText()));
  await page.click('#p-asks [data-answer="Food court"]');
  await wait(1500);
  check('answering it with one click records the answer', /"answer": "Food court"/.test(read('studio/asks/A-001.json')));
  check('the signals strip shows the pace on every view', (await page.locator('[data-signals] .sig.pace').count()) === 3);
  await page.click('#plan .switch[data-to="ops"]');
  await wait(800);
  await page.selectOption('#o-arole', 'builder');
  await page.click('#o-agentform button');
  await wait(4000);
  check('Start agent launches one, and it shows with its heartbeat', /builder-/.test(await page.locator('#o-launched').innerText()) && /heartbeat/.test(await page.locator('#o-launched').innerText()), await page.locator('#o-actmsg').innerText());
  await page.locator('#o-launched [data-stopagent]').first().click();
  await wait(4000);
  check('Stop ends it and hands its task back', /No agents started from here yet/.test(await page.locator('#o-launched').innerText()));
  check('no script errors while using it', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  hub.kill();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `[hud] ${failed} of ${total} checks failed` : `[hud] ok: ${total} checks across the Ops, Studio and Game plan views`);
process.exit(failed ? 1 : 0);
