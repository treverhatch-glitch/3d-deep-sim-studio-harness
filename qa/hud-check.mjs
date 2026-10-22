#!/usr/bin/env node
/**
 * qa/hud-check.mjs — open the War Room in a real browser and use it like a person would.
 *
 *   node qa/hud-check.mjs [--shots <folder>]
 *
 * Copies the repo to a temporary folder, fills it with a small studio (a signed Bible, tasks, an
 * agent at work, an idea, a playtest), starts the HUB there and drives Chromium through all three
 * views at desktop and phone sizes: no console errors, no sideways scroll, the agent drawer, adding a
 * task, messaging the Producer, live updates, pitching an idea, answering a follow-up, the
 * data-sharing box, the MAX SPEED lever and the pace, the studio's questions, approving the art
 * department's designs, the Liaison chat (on a fake local model), and starting and stopping an agent. Your own studio is never touched. Skips (exit 0) when Playwright or Chromium
 * isn't installed; set PLAYWRIGHT_CHROMIUM to a Chromium binary to use a specific one.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
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
const noBuild = sh('qa/browser-play.mjs', '--no-shots').status !== 0;
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
// Poll until a condition holds (or the deadline passes): for steps whose time varies by machine.
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await wait(500);
  }
  return false;
};

try {
  for (const [w, h, size] of [[1280, 900, 'desktop'], [390, 844, 'phone']]) {
    for (const skin of ['ops', 'tycoon', 'plan', 'assets', 'arcade']) {
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
  check('unmeasured numbers say so instead of showing 0, and Checks names a red check', /not tracked/.test(await page.locator('#t-tokens').innerText()) && !/Fans/.test(await page.locator('#tycoon .top').innerText()), await page.locator('#tycoon .top').innerText());
  await page.click('#tycoon .switch[data-to="plan"]');
  await wait(2500);
  const plan = await page.locator('#plan').innerText();
  check('the Game plan shows the signed Bible, the open phase and the idea', /Signed by hatch/.test(plan) && /Phase 1/.test(plan) && /I-001/.test(plan));
  await page.fill('#p-ititle', 'Rainy day visitors');
  await page.click('#p-idea button');
  await wait(5500);
  check('pitching an idea adds a card and says R&D has it', /Rainy day visitors/.test(await page.locator('#p-board').innerText()) && /Idea: shape I-002/.test(read('studio/NEXT.md')) && /No tool is set to start R&D/.test(await page.locator('#p-msg').innerText()), await page.locator('#p-msg').innerText());
  const fu = page.locator('#p-fu input[data-key]');
  if (await fu.count()) {
    await fu.first().fill('Moss spreads slower in shade');
    await page.click('#p-fu button');
    await wait(1200);
    check('answering a follow-up saves it to the Bible', /Moss spreads slower/.test(read('studio/bible/bible.json')));
  } else check('follow-up questions are shown', false);
  check('the sharing box starts ticked, and an automated visit is not recorded as the dev seeing it', (await page.isChecked('#p-share')) && !/"shown": true/.test(read('studio/data-consent.json') || ''), read('studio/data-consent.json') || '(no file)');
  await page.click('#p-share');
  await wait(1200);
  check('unticking the box records a decline', /"how": "declined"/.test(read('studio/data-consent.json')));
  await wait(5500);
  check('the box stays unticked after the next refresh', !(await page.isChecked('#p-share')));
  // The lever is on every view; pulling it turns MAX SPEED on for the whole studio.
  await page.click('#plan [data-speed]');
  await wait(2500);
  const boost = JSON.parse(read('studio/mode.json') || '{}').boost;
  check('the MAX SPEED lever turns boost on, and every view shows it', boost?.on === true && (await page.locator('[data-speed][aria-pressed="true"]').count()) === (await page.locator('.skin [data-speed]').count()));
  await page.click('#plan [data-mode="fast"]');
  await wait(2000);
  check('choosing a pace in the Game plan records it', JSON.parse(read('studio/mode.json') || '{}').mode === 'fast' && /Fast and furious/.test(await page.locator('#p-modemsg').innerText()));
  check('the studio\'s question shows with its default and deadline', /Which floor first\?/.test(await page.locator('#p-asks').innerText()) && /if you don't answer by/.test(await page.locator('#p-asks').innerText()));
  await page.click('#p-asks [data-answer="Food court"]');
  await wait(1500);
  check('answering it with one click records the answer', /"answer": "Food court"/.test(read('studio/asks/A-001.json')));
  check('the signals strip shows the pace on every view', (await page.locator('[data-signals] .sig.pace').count()) === (await page.locator('.skin [data-signals]').count()));
  // The Liaison chat: the model reads a brief back; nothing moves until "Yes, send it".
  await page.fill('#p-chatin', 'I want fireflies in the garden at night');
  await page.click('#p-chat button');
  await wait(2500);
  check('the Liaison reads back what it understood, with a yes button', /Fireflies at dusk/.test(await page.locator('#p-chatlog').innerText()) && (await page.locator('#p-chatlog [data-brief="confirm"]').count()) === 1 && !/Fireflies/.test(read('studio/NEXT.md')), await page.locator('#p-chatlog').innerText());
  await page.click('#p-chatlog [data-brief="confirm"]');
  await wait(1500);
  check('saying yes sends it to R&D and says what happens next', /Idea: shape I-\d+ Fireflies at dusk/.test(read('studio/NEXT.md')) && /sent on as I-/.test(await page.locator('#p-chatlog').innerText()), await page.locator('#p-chatlog').innerText());
  check('the Game plan points to the Asset studio with what is waiting', /2 waiting for you/.test(await page.locator('#p-designs').innerText()), await page.locator('#p-designs').innerText());
  // The Asset studio (view 4): designs by number and round, thumbs up, words for the next round, references.
  await page.click('#plan .switch[data-to="assets"]');
  await wait(2500);
  const waiting = await page.locator('#a-waiting').innerText();
  const imgOk = await page.locator('#a-waiting img').first().evaluate((i) => i.complete && i.naturalWidth > 0).catch(() => false);
  check('the Asset studio shows each design by number and round, with its picture', /#1\s*Mossy pastel/.test(waiting) && /#2\s*Garden crate/.test(waiting) && /round 1/.test(waiting) && imgOk && /2 designs waiting in the Asset studio/.test(await page.locator('#assets [data-signals] .sig.you').getAttribute('title')), waiting + (await page.locator('#assets [data-signals]').innerText()));
  await page.locator('#a-waiting .acard', { hasText: 'Garden crate' }).locator('input[data-note]').fill('make it rounder, like a planter');
  await page.locator('#a-waiting .acard', { hasText: 'Garden crate' }).locator('[data-art="changes"]').click();
  await wait(1500);
  check('"Change this" gives the art department its next round with your words', /Art: round 2 of #2 Garden crate: make it rounder/.test(read('studio/NEXT.md')) && /round 2 of #2/.test(await page.locator('#a-msg').innerText()) && /Garden crate/.test(await page.locator('#a-works').innerText()), await page.locator('#a-msg').innerText());
  await page.fill('#a-saytext', 'crate #2 needs a lid too');
  await page.click('#a-say button');
  await wait(1500);
  check('typed feedback naming #2 joins its open round instead of a new task', (read('studio/NEXT.md').match(/of #2 Garden crate/g) || []).length === 1 && /added to its open round/.test(await page.locator('#a-msg').innerText()), await page.locator('#a-msg').innerText());
  await page.locator('#a-waiting .acard', { hasText: 'Mossy pastel' }).locator('[data-art="approve"]').click();
  await wait(1500);
  check('a thumbs up on the style sheet makes it the art reference', /"artReference"/.test(read('studio/bible/bible.json')) && /art reference/.test(await page.locator('#a-msg').innerText()) && /Mossy pastel/.test(await page.locator('#a-approved').innerText()), await page.locator('#a-msg').innerText());
  await page.setInputFiles('#a-reffile', path.join(dir, 'studio/art/concept.png'));
  await page.fill('#a-reflabel', 'the moss colour I want');
  await page.click('#a-ref button');
  await wait(2000);
  check('a labelled reference from the dev is listed for the art department', /the moss colour I want/.test(await page.locator('#a-refs').innerText()) && /the moss colour I want/.test(read('studio/art/references.json')), await page.locator('#a-refmsg').innerText());
  // The Arcade (view 5): the last good build plays in the page; notes go out; the dungeon is read-only.
  await page.click('#assets .switch[data-to="arcade"]');
  await wait(3500);
  const frameText = await page.frameLocator('#r-frame').locator('.hud').innerText().catch(() => '');
  needsBuild('the Arcade plays the last build that passed the browser check', /\/play\/[^/]+\/web\/example-sim\/index\.html/.test(await page.locator('#r-frame').getAttribute('src')) && /Credits\s*\d+/.test(frameText) && /won at tick/.test(await page.locator('#r-build').innerText()), frameText + (await page.locator('#r-build').innerText()));
  await page.locator('#r-dungeon').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ArrowRight');
  await wait(400);
  check('the dungeon shows a task when the hero walks into its room', /T-\d+/.test(await page.locator('#r-card').innerText()), await page.locator('#r-card').innerText());
  await page.fill('#r-notetext', 'the end screen text overlaps the HUD');
  await page.selectOption('#r-notekind', 'bug');
  await page.click('#r-note button');
  await wait(1500);
  needsBuild('a note taken while playing becomes a bug task, saved with the build it was about', /Bug: the end screen text overlaps the HUD \(seen playing build /.test(read('studio/NEXT.md')) && /the end screen text overlaps/.test(read('studio/playtest/NOTES.md')), await page.locator('#r-notemsg').innerText());
  // "Is it fun?": a person's verdict on the build being played (what lets a phase close).
  await page.click('#arcade [data-fun="yes"]');
  await wait(800);
  needsBuild('"Yes, it\'s fun" in the Arcade records a verdict on the build being played', /"fun": "yes"/.test(read('studio/playtest/verdicts.json')) && /"build": "/.test(read('studio/playtest/verdicts.json')) && /is fun/.test(await page.locator('#r-notemsg').innerText()), (await page.locator('#r-notemsg').innerText()) + read('studio/playtest/verdicts.json'));
  await page.click('#arcade .switch[data-to="ops"]');
  await wait(800);
  await page.selectOption('#o-arole', 'builder');
  await page.click('#o-agentform button');
  await wait(4000);
  check('Start agent launches one, and it shows with its heartbeat', /builder-/.test(await page.locator('#o-launched').innerText()) && /heartbeat/.test(await page.locator('#o-launched').innerText()), await page.locator('#o-actmsg').innerText());
  // Stop every agent started from the page (the bug note above woke a builder too).
  for (let k = 0; k < 4 && (await page.locator('#o-launched [data-stopagent]').count()); k++) {
    await page.locator('#o-launched [data-stopagent]').first().click();
    await wait(3000);
  }
  // Stopping kills the process tree, saves a patch and hands the task back: on Windows that takes a few
  // seconds (Gemini's run raced it), so wait for the page to say so instead of a fixed pause.
  await until(async () => /No agents started from here yet/.test(await page.locator('#o-launched').innerText()), 20000);
  check('Stop ends it and hands its task back', /No agents started from here yet/.test(await page.locator('#o-launched').innerText()), await page.locator('#o-launched').innerText());
  // + Hire in an open room of the Studio view: an agent for that department, which Pause hands back.
  await page.click('#ops .switch[data-to="tycoon"]');
  await wait(800);
  await page.locator('#tycoon [data-hire="engineering"]').first().click();
  await wait(4000);
  await page.click('#tycoon .switch[data-to="ops"]');
  await wait(1500);
  const hired = await page.locator('#o-launched').innerText();
  check('+ Hire in an open room hires an agent for that department, with a Pause button', /builder-/.test(hired) && (await page.locator('#o-launched [data-pauseagent]').count()) > 0, hired);
  for (let k = 0; k < 4 && (await page.locator('#o-launched [data-pauseagent]').count()); k++) {
    await page.locator('#o-launched [data-pauseagent]').first().click();
    await wait(3000);
  }
  await until(async () => /No agents started from here yet/.test(await page.locator('#o-launched').innerText()), 20000);
  check('Pause stops it and hands its task back', /No agents started from here yet/.test(await page.locator('#o-launched').innerText()), await page.locator('#o-launched').innerText());
  // Throw it all away and restart: two warnings back to back; Cancel on the second changes nothing.
  await page.click('#o-restart');
  await wait(800);
  const warn1 = await page.locator('#o-restartbox').innerText();
  await page.click('#o-restartyes');
  await wait(300);
  const warn2 = await page.locator('#o-restartbox').innerText();
  await page.click('#o-restartno');
  await wait(300);
  check('the restart button warns twice, and Cancel on the second warning changes nothing', /Throw away/.test(warn1) && /git tag/.test(warn1) && /Last warning/.test(warn2) && (await page.locator('#o-restartbox').isHidden()) && /Nothing changed/.test(await page.locator('#o-actmsg').innerText()) && fs.existsSync(path.join(dir, 'cartridges/example-sim/index.mjs')) && !/archive\//.test(spawnSync('git', ['tag', '-l'], { cwd: dir, encoding: 'utf8' }).stdout || ''), warn1 + ' / ' + warn2);
  // 2.30c: the breaker card with Unblock, the Producer's wake line and the overnight summary in Ops.
  await page.click('#tycoon .switch[data-to="ops"]').catch(() => {});
  await wait(1500);
  const holdTxt = await page.locator('#o-holdlist').innerText();
  const statusTxt = await page.locator('#o-status').innerText();
  check('2.30c: a task the circuit breaker parked has a card with Unblock, and the status line says when the Producer starts and where the overnight summary is', Boolean(trip) && /circuit breaker/.test(holdTxt) && (await page.locator(`#o-holdlist [data-need="unblock"][data-task="${trip}"]`).count()) === 1 && /Producer: /.test(statusTxt) && /overnight-\d{4}-\d{2}-\d{2}\.md/.test(statusTxt), `${holdTxt}\n${statusTxt}`);
  await page.locator('#o-hold').scrollIntoViewIfNeeded().catch(() => {});
  if (shotsAt) await page.screenshot({ path: path.join(shotsAt, '230c-ops-breaker-card.png'), fullPage: false });
  if (shotsAt) await page.locator('#o-status').screenshot({ path: path.join(shotsAt, '230c-status-line.png') }).catch(() => {});
  await page.locator(`#o-holdlist [data-need="unblock"][data-task="${trip}"]`).click().catch(() => {});
  await until(async () => !/circuit breaker/.test(await page.locator('#o-holdlist').innerText()), 10000);
  const holds = JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks || {};
  check('2.30c: Unblock clears the breaker: the card goes and the task can start again', !/circuit breaker/.test(await page.locator('#o-holdlist').innerText()) && !holds[trip]?.parked, JSON.stringify(holds[trip] || null));
  if (shotsAt) await page.screenshot({ path: path.join(shotsAt, '230c-ops-after-unblock.png'), fullPage: false });
  check('no script errors while using it', errs.length === 0, errs.join(' | '));

  // 2.30e: the token ledger tiles, from the seeded sessions: 3k tokens for the one finished task, 1 of 2
  // sessions ended with no task done, turns 12 / 40, and the free model flagged as estimated.
  await page.setViewportSize({ width: 1280, height: 800 });
  await until(async () => (await page.locator('#o-ledger .tile').count()) === 4, 15000);
  const tileText = async (id) => (await page.locator(`#o-ledger [data-tile="${id}"]`).innerText().catch(() => '')).replace(/\s+/g, ' ');
  // The no-done share counts every session in this run's events (earlier steps start and pause agents), so compare with the ledger's own number.
  const ledgerNoDone = (() => { try { return Math.round(JSON.parse(spawnSync(process.execPath, [path.join(dir, 'harness/ledger.mjs'), '--json'], { cwd: dir, encoding: 'utf8' }).stdout).noDonePct); } catch { return 'x'; } })();
  const tiles = { task: await tileText('tokens-per-task'), nodone: await tileText('no-done'), turns: await tileText('turns'), budget: await tileText('budget'), note: await page.locator('#o-ledger .tiles-note').innerText().catch(() => '') };
  check('the ledger tiles show tokens per finished task, no-done %, turns p50/p95 and the budget', /3k tokens per finished task/.test(tiles.task) && new RegExp(`^${ledgerNoDone}% sessions with no task done`).test(tiles.nodone.trim()) && /12 \/ 40 turns/.test(tiles.turns) && /(\d+%|cap off) daily budget used/.test(tiles.budget) && /nvidia-nim \(est\.\)/.test(tiles.note), JSON.stringify(tiles));
  const taskModel = await page.locator('#o-ledger [data-tile="tokens-per-task"] [data-models]').innerText().catch(() => '');
  check('every token count on the ledger tiles names its model (one model, or a mixed share)', /claude|mixed: /.test(taskModel) && /Models: /.test(tiles.note), JSON.stringify({ taskModel, note: tiles.note }));
  const box = page.locator('#o-ledgerbox');
  await box.scrollIntoViewIfNeeded();
  if (shotsAt) fs.mkdirSync(shotsAt, { recursive: true }), await box.screenshot({ path: path.join(shotsAt, 'ledger-tiles-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await wait(300);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('the ledger tiles wrap on a phone with no sideways scroll', !sideways && (await page.locator('#o-ledger .tile').count()) === 4, `scrollWidth past the screen: ${sideways}`);
  if (shotsAt) await box.screenshot({ path: path.join(shotsAt, 'ledger-tiles-phone.png') });
} finally {
  await browser.close();
  hub.kill();
  fakeModel.close();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `[hud] ${failed} of ${total} checks failed` : `[hud] ok: ${total} checks across the Ops, Studio and Game plan views${skipped ? ` (${skipped} skipped: no playable build)` : ''}`);
process.exit(failed ? 1 : 0);
