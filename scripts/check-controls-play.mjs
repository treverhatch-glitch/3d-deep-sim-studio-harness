#!/usr/bin/env node
/**
 * scripts/check-controls-play.mjs — 2.45.0 proof, in a real browser: qa/controls-play.mjs serves a small
 * web game that isn't a cartridge (no window.__sim), clicks through its title screen, presses each control
 * from the Game Bible, and checks the effect. A live key and a live button pass; a key wired to nothing fails;
 * a `to` effect already true before the press fails (the press proved nothing); the server is gone after;
 * qa/controls-check.mjs accepts the report for the web track. Runs in CI's war-room-browser job (it needs
 * Chromium); skips (exit 0) without it.
 *
 *   node scripts/check-controls-play.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { controlsPlay } from '../qa/controls-play.mjs';
import { controlsCheck } from '../qa/controls-check.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'controls-play-'));
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };

// The game: a title screen, then play. Space pauses, 3 sets speed 3, the Buy button spends cash. J does nothing.
w('game/demo/index.html', `<!doctype html><html><body>
<button id="start">New game</button>
<div id="play" hidden><button id="buy">Buy</button></div>
<script>
  const g = { cash: 100, speed: 1, playing: false };
  document.getElementById('start').onclick = () => { g.playing = true; document.getElementById('play').hidden = false; document.getElementById('start').hidden = true; window.__game = g; };
  document.getElementById('buy').onclick = () => { setTimeout(() => { g.cash -= 10; }, 300); };
  window.addEventListener('keydown', (e) => {
    if (!g.playing) return;
    if (e.code === 'Space') g.speed = g.speed === 0 ? 1 : 0;
    if (e.code === 'Digit3') g.speed = 3;
  });
</script></body></html>`);
w('game/demo/server.mjs', `import http from 'node:http'; import fs from 'node:fs';
const page = fs.readFileSync(new URL('./index.html', import.meta.url));
http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(page); }).listen(Number(process.argv[2]), '127.0.0.1');`);
w('game/demo/studio.browser.json', JSON.stringify({
  serve: { command: 'node server.mjs {port}', url: 'http://127.0.0.1:{port}/' },
  start: [{ click: '#start' }],
  ready: 'Boolean(window.__game)',
  state: '({ cash: window.__game.cash, speed: window.__game.speed })',
  settleMs: 2000,
  controls: { buy: { click: '#buy' } },
}));
const bible = (controls) => w('studio/bible/controls.json', JSON.stringify({ tracks: ['web'], controls }));
const game = { name: 'demo', root: 'game/demo' };
const reportsDir = path.join(tmp, 'qa', 'reports');
const quiet = () => {};

const problems = [];
const expect = (ok, what) => { console.log(`[controls-play-check] ${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };

bible([
  { id: 'speed.pause', input: 'key Space', effect: { path: 'speed', to: 0 } },
  { id: 'speed.3', input: 'key 3', effect: { path: 'speed', to: 3 } },
  { id: 'buy', input: 'click Buy', effect: { path: 'cash', change: -10 } },
  { id: 'dead', input: 'key J', effect: { path: 'cash', change: 'down' } },
  { id: 'again', input: 'key 3', effect: { path: 'speed', to: 3 } },
  { id: 'unchecked', input: 'key 3' },
]);
const res = await controlsPlay({ root: tmp, game, reportsDir, log: quiet });
if (res.error && /Playwright is not installed|Chromium did not start/.test(res.error)) {
  console.log(`[controls-play-check] skipped: ${res.error}`);
  process.exit(0);
}
if (res.error) { console.log(`[controls-play-check] FAIL ${res.error}`); process.exit(1); }
const by = Object.fromEntries(res.report.controls.map((c) => [c.id, c]));
expect(by['speed.pause']?.ok === true && by['speed.3']?.ok === true, 'keys from the Bible\'s "key X" input are pressed and their effects hold (speed 1 → 0 → 3)');
expect(by.buy?.ok === true, 'a click from studio.browser.json passes once its delayed effect shows (cash -10 after 300 ms)');
expect(by.dead?.ok === false && /cash should go down/.test(by.dead.why || ''), 'a key wired to nothing fails with the Bible\'s reason');
expect(by.again?.ok === false && /already 3 before the press/.test(by.again.why || ''), 'a `to` effect already true before the press fails: the press proved nothing');
expect(by.unchecked?.ok === null, 'a control with no effect in the Bible is reported as not checked');
expect(res.ok === false && fs.existsSync(path.join(tmp, res.file)), `the run fails and writes its report (${res.file})`);

// The server it started is stopped.
const port = Number((res.report.url.match(/:(\d+)\//) || [])[1]);
let answered = false;
try { await fetch(`http://127.0.0.1:${port}/`); answered = true; } catch {}
expect(!answered, `the game server it started is stopped (port ${port} no longer answers)`);

// The controls check reads the report for the web track; a fully passing run passes it.
bible([
  { id: 'speed.pause', input: 'key Space', effect: { path: 'speed', to: 0 } },
  { id: 'buy', input: 'click Buy', effect: { path: 'cash', change: -10 } },
]);
const good = await controlsPlay({ root: tmp, game, reportsDir, log: quiet });
const cc = await controlsCheck({ bibleFile: path.join(tmp, 'studio/bible/controls.json'), reportsDir, template: false });
expect(good.ok === true && cc.ok === true && cc.checked === 2, `qa/controls-check.mjs passes the web track on a controls-play report (${cc.problems.join('; ') || 'no problems'})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(problems.length ? `[controls-play-check] FAIL ${problems.length}` : '[controls-play-check] PASS');
process.exit(problems.length ? 1 : 0);
