#!/usr/bin/env node
/**
 * scripts/check-vfx.mjs — 2.56.0 (PU-15) proof, in a real browser: a demo page exposes window.__studioVfx with
 * clean effects and planted faults, and `harness/vfx.mjs` must pass the clean ones and name each fault:
 *   burst (one-shot, ends empty) and ring (loop, seamless) pass;
 *   linger never ends; jumpy jumps where its loop wraps; wide spills past the stage; strobe flashes 5 times a
 *   second; noisy uses unseeded randomness; empty draws nothing.
 * Runs in CI's war-room-browser job (it needs Chromium); skips (exit 0) without it.
 *
 *   node scripts/check-vfx.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkEffect, starterSpec } from '../harness/vfx.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vfx-check-'));
const page = path.join(tmp, 'effects.html');
// Plain 2D canvas drawing: a stand-in for any game's effect, drawn at time t from a seed.
fs.writeFileSync(page, `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="studio-vfx-stage" width="128" height="128" style="display:block;background:#000"></canvas>
<script>
const c = document.getElementById('studio-vfx-stage'); const x = c.getContext('2d');
const rng = (seed) => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const clear = () => { x.fillStyle = '#000'; x.fillRect(0, 0, 128, 128); };
const dot = (px, py, r, col) => { x.fillStyle = col; x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); };
const effects = {
  burst(t, r, d) { const k = t / d; if (k >= 1) return; for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + r() * 0.2; const dist = 8 + k * 40; dot(64 + Math.cos(a) * dist, 64 + Math.sin(a) * dist, 4 * (1 - k), '#ffcc33'); } },
  linger(t, r, d) { const k = Math.min(1, t / d); dot(64, 64, 10 + 20 * k, '#ff5533'); },
  ring(t, r, d) { const a = (t / d) * Math.PI * 2; dot(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 6, '#33ccff'); },
  jumpy(t, r, d) { const a = (t / d) * Math.PI; dot(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30, 6, '#33ccff'); },
  wide(t, r, d) { const k = t / d; if (k >= 1) return; dot(64, 64, 20 + 80 * k, '#88ff88'); },
  strobe(t, r, d) { if (t >= d) return; if (Math.floor(t / 100) % 2 === 0) { x.fillStyle = '#ffffff'; x.fillRect(4, 4, 120, 120); } },
  noisy(t, r, d) { if (t >= d) return; for (let i = 0; i < 20; i++) dot(20 + Math.random() * 88, 20 + Math.random() * 88, 3, '#ff66ff'); },
  empty() {},
};
window.__studioVfx = { render(id, { tMs, seed }) { clear(); if (tMs < 0) return; const d = window.__dur[id]; effects[id](tMs, rng(seed), d); } };
window.__dur = { burst: 400, linger: 400, ring: 1000, jumpy: 1000, wide: 400, strobe: 1000, noisy: 400, empty: 400 };
</script></body></html>`);

const spec = (id, kind, ms) => ({ ...starterSpec(id, { kind, ms }), communicates: `test effect ${id}`, stage: { w: 128, h: 128, background: '#000000' }, frames: 8, url: page });
const cases = [
  { id: 'burst', kind: 'one-shot', ms: 400, fail: [] },
  { id: 'ring', kind: 'loop', ms: 1000, fail: [] },
  { id: 'linger', kind: 'one-shot', ms: 400, fail: ['ends-empty'] },
  { id: 'jumpy', kind: 'loop', ms: 1000, fail: ['loop-seam'] },
  { id: 'wide', kind: 'one-shot', ms: 400, fail: ['stays-inside'] },
  { id: 'strobe', kind: 'one-shot', ms: 1000, fail: ['flash-rate'] },
  { id: 'noisy', kind: 'one-shot', ms: 400, fail: ['same-seed'] },
  { id: 'empty', kind: 'one-shot', ms: 400, fail: ['draws'] },
];
let problems = 0;
for (const c of cases) {
  const r = await checkEffect(spec(c.id, c.kind, c.ms), { log: () => {} });
  if (r.error && /Playwright is not installed|Chromium did not start/.test(r.error)) { console.log(`[vfx-check] skipped: ${r.error}`); process.exit(0); }
  if (r.error) { console.log(`[vfx-check] FAIL ${c.id}: ${r.error}`); problems++; continue; }
  const failed = r.report.checks.filter((k) => !k.ok).map((k) => k.id);
  const ok = JSON.stringify(failed) === JSON.stringify(c.fail) && fs.existsSync(path.join(process.cwd(), r.report.contact));
  console.log(`[vfx-check] ${ok ? 'PASS' : 'FAIL'} ${c.id}: expected ${c.fail.join(', ') || 'no failures'}, got ${failed.join(', ') || 'no failures'}`);
  if (!ok) problems++;
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(problems ? `[vfx-check] FAIL ${problems}` : '[vfx-check] PASS: clean effects pass, every planted fault is named');
process.exit(problems ? 1 : 0);
