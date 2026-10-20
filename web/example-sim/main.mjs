/**
 * web/example-sim/main.mjs — the example game's browser build: draws the sim and takes input.
 *
 * Presentation only: it imports the pure cartridge and never changes its rules. With ?playtest=1 it
 * exposes window.__sim (the sim's state) and window.__view() (what the screen shows), which the
 * browser play gate (qa/browser-play.mjs) compares while it plays with real keys and clicks.
 * ?seed=N picks the seed, ?speed=N runs N ticks per frame.
 */
import { createInitialState, step, nextUnitCost, unitCount, outcome } from '../../cartridges/example-sim/index.mjs';

const q = new URLSearchParams(location.search);
const seed = Number(q.get('seed') || 1337);
const speed = Math.max(1, Math.min(16, Number(q.get('speed') || 1)));
let state = createInitialState(seed);
let queued = [];
let frames = 0;
let drawn = 0;

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

const buy = () => queued.push({ type: 'spawn', kind: 'vehicle', id: `bought-${state.tick + 1}-${queued.length}`, x: 0, z: (state.tick % 7) });
addEventListener('keydown', (e) => {
  if (e.key === 'b' || e.key === 'B') buy();
});
$('buy').addEventListener('click', buy);

function draw() {
  ctx.fillStyle = '#173023';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#21452f';
  for (let x = 0; x < canvas.width; x += 40) ctx.fillRect(x, 0, 1, canvas.height);
  drawn = 0;
  for (const e of state.entities) {
    const px = 20 + ((e.x * 6) % (canvas.width - 40));
    const py = 40 + ((e.z + 3) % 8) * 38;
    ctx.fillStyle = e.kind === 'crate' ? '#c89b5a' : '#7fd17f';
    ctx.fillRect(px, py, e.kind === 'crate' ? 18 : 14, e.kind === 'crate' ? 18 : 10);
    drawn += 1;
  }
  $('hud-credits').textContent = String(Math.floor(state.resources.credits));
  $('hud-energy').textContent = String(state.resources.energy);
  $('hud-units').textContent = String(unitCount(state));
  $('hud-cost').textContent = String(nextUnitCost(state));
  const end = outcome(state);
  $('end').textContent = end === 'won' ? 'You won.' : end === 'lost' ? 'Out of power.' : '';
}

function frame() {
  if (!outcome(state)) {
    for (let i = 0; i < speed && !outcome(state); i++) {
      const acts = queued;
      queued = [];
      state = step(state, acts.length ? acts : null);
    }
  }
  draw();
  frames += 1;
  requestAnimationFrame(frame);
}

if (q.get('playtest') === '1') {
  window.__sim = { getState: () => state, reset: (s = seed) => (state = createInitialState(s)) };
  // What the player sees, read from the page itself (not from the sim), so a wiring bug shows up.
  window.__view = () => ({
    frames,
    hud: { credits: Number($('hud-credits').textContent), energy: Number($('hud-energy').textContent), units: Number($('hud-units').textContent) },
    drawn,
    camera: { inside: false },
    end: $('end').textContent,
  });
}
requestAnimationFrame(frame);
