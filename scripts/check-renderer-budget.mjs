#!/usr/bin/env node
/**
 * scripts/check-renderer-budget.mjs — keep the renderer inside its budget, measured in a real browser.
 *
 *   RENDER_URL=http://127.0.0.1:5173/?playtest=1 node scripts/check-renderer-budget.mjs   measure
 *   node scripts/check-renderer-budget.mjs                                                 static fallback
 *
 * Measured: opens RENDER_URL in Chromium (Playwright), waits for the game's `window.__render`
 * counters ({ drawCalls, triangles, lights, frameMs }, updated every frame; see
 * studio/rules/renderer-budget.md), samples them for RENDER_SAMPLE_MS (default 3000), and fails when
 * the worst sample is over the budget in the rule's ```json budget block.
 * Without RENDER_URL (or without Playwright) it falls back to scanning the code for light counts and
 * drawCalls hints, and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rulePath = path.join(root, 'studio', 'rules', 'renderer-budget.md');

export function readBudget() {
  const text = fs.existsSync(rulePath) ? fs.readFileSync(rulePath, 'utf8') : '';
  const m = text.match(/```json budget\s*\n([\s\S]*?)```/);
  try {
    return { drawCalls: 150, triangles: 500000, lights: 8, frameMs: 16.7, ...(m ? JSON.parse(m[1]) : {}) };
  } catch {
    return { drawCalls: 150, triangles: 500000, lights: 8, frameMs: 16.7 };
  }
}

async function measure(url, budget) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return { skipped: 'Playwright is not installed' };
  }
  const { launchChromium } = await import('../qa/chromium.mjs');
  const browser = await launchChromium(chromium);
  if (browser.error) return { skipped: `Chromium did not start (${browser.error.message.split('\n')[0]})` };
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const ready = await page.waitForFunction(() => window.__render && typeof window.__render.drawCalls === 'number', null, { timeout: Number(process.env.RENDER_READY_MS || 15000) }).then(() => true, () => false);
    if (!ready) return { error: 'the page never set window.__render = { drawCalls, triangles, lights, frameMs } (see studio/rules/renderer-budget.md)' };
    const worst = await page.evaluate(async (ms) => {
      const w = { drawCalls: 0, triangles: 0, lights: 0, frameMs: 0, samples: 0 };
      const end = performance.now() + ms;
      while (performance.now() < end) {
        const r = window.__render || {};
        for (const k of ['drawCalls', 'triangles', 'lights', 'frameMs']) if (Number.isFinite(r[k])) w[k] = Math.max(w[k], r[k]);
        w.samples += 1;
        await new Promise((res) => requestAnimationFrame(res));
      }
      return w;
    }, Number(process.env.RENDER_SAMPLE_MS || 3000));
    const over = Object.keys(budget).filter((k) => worst[k] > budget[k]).map((k) => `${k} ${Math.round(worst[k] * 10) / 10} > ${budget[k]}`);
    return { worst, over };
  } finally {
    await browser.close();
  }
}

function staticScan(budget) {
  const dirs = ['cartridges', 'src'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
  const problems = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(mjs|js|ts|tsx)$/.test(ent.name)) {
        const text = fs.readFileSync(full, 'utf8');
        const lights = (text.match(/Light\s*\(|new\s+\w*Light/g) || []).length;
        if (lights > budget.lights) problems.push(`${path.relative(root, full)}: ${lights} lights > ${budget.lights}`);
        if ((text.match(/drawCalls\s*[:=]\s*(\d+)/g) || []).some((s) => Number(s.match(/\d+/)[0]) > budget.drawCalls)) problems.push(`${path.relative(root, full)}: drawCalls over ${budget.drawCalls}`);
      }
    }
  };
  dirs.forEach(walk);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const budget = readBudget();
  const url = process.env.RENDER_URL;
  if (url) {
    const r = await measure(url, budget);
    if (r.error) {
      console.error(`[renderer-budget] FAIL ${r.error}`);
      process.exit(1);
    }
    if (!r.skipped) {
      const w = r.worst;
      const line = `drawCalls ${w.drawCalls}, triangles ${w.triangles}, lights ${w.lights}, frame ${Math.round(w.frameMs * 10) / 10} ms (worst of ${w.samples} frames)`;
      if (r.over.length) {
        console.error(`[renderer-budget] FAIL measured over budget: ${r.over.join('; ')}\n  ${line}`);
        process.exit(1);
      }
      console.log(`[renderer-budget] PASS measured: ${line}`);
      process.exit(0);
    }
    console.log(`[renderer-budget] could not measure (${r.skipped}); static scan instead`);
  }
  const problems = staticScan(budget);
  if (problems.length) {
    problems.forEach((p) => console.error(`[renderer-budget] FAIL ${p}`));
    process.exit(1);
  }
  console.log(`[renderer-budget] PASS static scan only (lights<=${budget.lights}, drawCalls<=${budget.drawCalls}). Set RENDER_URL to measure a running build.`);
}
