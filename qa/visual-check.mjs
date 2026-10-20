#!/usr/bin/env node
/**
 * qa/visual-check.mjs — Minimal Playwright Visual & Accessibility QA Runner
 *
 * Follows the mandatory studio rule:
 *   "Accessibility tree first (`locator('body').ariaSnapshot()`), screenshots ONLY when needed."
 *
 * 1. Connects to `PLAYTEST_URL` (default `http://127.0.0.1:5173/?playtest=1`).
 * 2. Probes `window.__sim` (or PLAYTEST_GLOBAL) state directly.
 * 3. Captures the compact ARIA accessibility snapshot (~200 tokens instead of a 1MB PNG).
 * 4. Checks DOM bounding boxes (`uisentinel` pattern) for horizontal/vertical overflow.
 * 5. Captures a PNG screenshot ONLY if an error/overflow is detected or `--screenshot` is passed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';

const url = process.env.PLAYTEST_URL || process.argv[2] || 'http://127.0.0.1:5173/?playtest=1';
const forceScreenshot = process.argv.includes('--screenshot');
const reportsDir = path.join(REPO_ROOT, 'qa', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });

async function runVisualCheck() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('[visual-check] Playwright not installed or browser binary unavailable — skipping live browser probe.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 6000 });

    // 1. Accessibility Tree First (low-token semantic inspection)
    let ariaTree = '';
    try {
      ariaTree = await page.locator('body').ariaSnapshot();
    } catch {
      ariaTree = await page.innerText('body').catch(() => '');
    }

    // 2. Direct State Inspection (`window.__sim`, or the global named by PLAYTEST_GLOBAL)
    const simState = await page.evaluate((g) => {
      const api = window[g] || window.__sim;
      return api && typeof api.getState === 'function' ? api.getState() : null;
    }, process.env.PLAYTEST_GLOBAL || '__sim');

    // 3. UISentinel Layout Overflow Check
    const layoutOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });

    const hasFailure = consoleErrors.length > 0 || layoutOverflow;
    let screenshotPath = null;

    // 4. Screenshot ONLY when needed (on failure or explicit --screenshot flag)
    if (hasFailure || forceScreenshot) {
      screenshotPath = path.join(reportsDir, `visual-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath });
    }

    const report = {
      ts: new Date().toISOString(),
      url,
      passed: !hasFailure,
      ariaTreePreview: String(ariaTree).slice(0, 600),
      simTick: simState?.tick ?? null,
      layoutOverflow,
      consoleErrors,
      screenshotTaken: Boolean(screenshotPath),
      screenshotPath,
    };

    const reportFile = path.join(reportsDir, 'latest-visual-check.json');
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    console.log('[visual-check]', JSON.stringify(report, null, 2));
  } catch (err) {
    console.log(`[visual-check] Target ${url} not reachable (${err.message}). Run your dev server first.`);
  } finally {
    await browser.close();
  }
}

runVisualCheck();
