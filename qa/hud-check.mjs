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
fs.mkdirSync(path.join(dir, 'studio/art'), { recursive: true });
fs.mkdirSync(path.join(dir, 'assets/placeholder'), { recursive: true });
fs.writeFileSync(path.join(dir, 'studio/art/concept.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAIAAABxZ0isAAAAGElEQVR4nGP4z8DwHwxRAQMDAwMDLjcDALOLD/G4jBqDAAAAAElFTkSuQmCC', 'base64'));
fs.writeFileSync(path.join(dir, 'assets/placeholder/crate.glb'), 'glTF placeholder');
sh('harness/art.mjs', 'propose', 'studio/art/concept.png', '--kind', 'style', '--title', 'Mossy pastel, soft light', '--by', 'art-1');
sh('harness/art.mjs', 'propose', 'assets/placeholder/crate.glb', '--title', 'Garden crate', '--thumb', 'studio/art/concept.png', '--by', 'art-1');
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
sh('qa/browser-play.mjs', '--no-shots');
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
  check('the Arcade plays the last build that passed the browser check', /\/play\/[^/]+\/web\/example-sim\/index\.html/.test(await page.locator('#r-frame').getAttribute('src')) && /Credits\s*\d+/.test(frameText) && /won at tick/.test(await page.locator('#r-build').innerText()), frameText + (await page.locator('#r-build').innerText()));
  await page.locator('#r-dungeon').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ArrowRight');
  await wait(400);
  check('the dungeon shows a task when the hero walks into its room', /T-\d+/.test(await page.locator('#r-card').innerText()), await page.locator('#r-card').innerText());
  await page.fill('#r-notetext', 'the end screen text overlaps the HUD');
  await page.selectOption('#r-notekind', 'bug');
  await page.click('#r-note button');
  await wait(1500);
  check('a note taken while playing becomes a bug task, saved with the build it was about', /Bug: the end screen text overlaps the HUD \(seen playing build /.test(read('studio/NEXT.md')) && /the end screen text overlaps/.test(read('studio/playtest/NOTES.md')), await page.locator('#r-notemsg').innerText());
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
  await wait(1000);
  check('Stop ends it and hands its task back', /No agents started from here yet/.test(await page.locator('#o-launched').innerText()));
  check('no script errors while using it', errs.length === 0, errs.join(' | '));
} finally {
  await browser.close();
  hub.kill();
  fakeModel.close();
  await wait(300);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `[hud] ${failed} of ${total} checks failed` : `[hud] ok: ${total} checks across the Ops, Studio and Game plan views`);
process.exit(failed ? 1 : 0);
