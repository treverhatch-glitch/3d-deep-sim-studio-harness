/**
 * qa/chromium.mjs — start a Chromium for the browser checks, wherever this runs.
 *
 * Order: PLAYWRIGHT_CHROMIUM, a preinstalled /opt/pw-browsers/chromium, Playwright's own download
 * (npx playwright install chromium), then the Chrome or Edge already on the machine. On Windows,
 * Gemini's Solar Outpost run found the checks looked only in /opt/pw-browsers and failed; Chrome and
 * Edge are now tried there by their usual paths and by Playwright's channels.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Browsers to try, in order, as Playwright launch options. */
export function chromiumCandidates(env = process.env, platform = process.platform) {
  const out = [];
  const add = (o, label) => out.push({ opts: o, label });
  if (env.PLAYWRIGHT_CHROMIUM) add({ executablePath: env.PLAYWRIGHT_CHROMIUM }, `PLAYWRIGHT_CHROMIUM (${env.PLAYWRIGHT_CHROMIUM})`);
  if (fs.existsSync('/opt/pw-browsers/chromium')) add({ executablePath: '/opt/pw-browsers/chromium' }, '/opt/pw-browsers/chromium');
  add({}, "Playwright's Chromium");
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      for (const rel of ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe']) {
        const p = path.win32.join(r, rel);
        if (fs.existsSync(p)) add({ executablePath: p }, p);
      }
    }
    add({ channel: 'chrome' }, 'Chrome (channel)');
    add({ channel: 'msedge' }, 'Edge (channel)');
  } else if (platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) if (fs.existsSync(p)) add({ executablePath: p }, p);
  } else {
    for (const name of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']) {
      const w = spawnSync('which', [name], { encoding: 'utf8' });
      const p = (w.stdout || '').trim();
      if (w.status === 0 && p) add({ executablePath: p }, p);
    }
  }
  return out;
}

/** Launch the first browser that starts. Returns the browser, or { error, tried } when none did. */
export async function launchChromium(chromium, extra = {}) {
  const tried = [];
  let last = null;
  for (const c of chromiumCandidates()) {
    try {
      const b = await chromium.launch({ ...extra, ...c.opts });
      b.__from = c.label;
      return b;
    } catch (err) {
      last = err;
      tried.push(c.label);
    }
  }
  return { error: last || new Error('no browser found'), tried };
}
