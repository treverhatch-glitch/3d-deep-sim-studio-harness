/**
 * qa/selftest-2582j.mjs — P-044: the War Room browser checks wait for the page state instead of reading it once.
 *   main's war-room-browser job failed on 2 of 4 pushes on "Stop ends it and hands its task back" (once on Pause):
 *   the agent had ended, but the check read the page before the War Room's next refresh.
 *   qa/wait-for.mjs asks again until the state holds (or must keep holding), and on time-out says what it saw;
 *   qa/hud-check.mjs uses it for every check after an action, and `--only stop-pause --repeat <n>` runs the
 *   Stop/Pause checks alone. No browser needed here: the helper runs on a fake clock, hud-check is read.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2582J({ dir, report }) {
  let mod = null;
  let why = '';
  try {
    mod = await import(pathToFileURL(path.join(dir, 'qa', 'wait-for.mjs')).href);
  } catch (e) {
    why = `qa/wait-for.mjs did not load: ${String(e.message).split('\n')[0]}`;
  }
  // A fake clock: sleeping moves time on at once, so the timings are exact and the checks take no time.
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; }, at: () => t };
  };
  const guard = async (name, fn) => {
    if (!mod) return report(name, false, why);
    try {
      const [ok, detail] = await fn();
      report(name, ok, detail);
    } catch (e) {
      report(name, false, e.stack || String(e));
    }
  };

  await guard('P-044: waitFor resolves when the state shows up late (a slow refresh), not on the first look', async () => {
    const c = clock();
    const r = await mod.waitFor(() => ({ ok: c.at() >= 4000, seen: c.at() >= 4000 ? 'No agents started from here yet' : 'builder-1 · builder · T-018' }), { timeout: 15000, interval: 250, now: c.now, sleep: c.sleep });
    // And on real timers: a state that turns true after 300 ms.
    let shown = false;
    setTimeout(() => (shown = true), 300);
    const real = await mod.waitFor(() => shown, { timeout: 5000, interval: 50 });
    return [r.ok && r.ms >= 4000 && r.ms <= 4250 && r.polls > 1 && /No agents/.test(r.seen) && real.ok && real.ms >= 250, JSON.stringify({ r, real })];
  });

  await guard('P-044: waitFor times out at its limit and says what the page showed last', async () => {
    const c = clock();
    const r = await mod.waitFor(() => ({ ok: false, seen: 'builder-1 · builder · custom/unknown · T-018 · heartbeat 0 min ago' }), { timeout: 15000, interval: 250, now: c.now, sleep: c.sleep });
    return [!r.ok && r.ms >= 15000 && r.ms < 15250 && /15\.0 s/.test(r.message) && /builder-1 · builder · custom\/unknown · T-018 · heartbeat 0 min ago/.test(r.message), JSON.stringify(r)];
  });

  await guard('P-044: with holdMs the state must keep holding (a list that empties, then shows the agent again, does not pass)', async () => {
    const c = clock();
    // Empty at 1 s, listed again at 2 s (a stale refresh), empty for good from 2.5 s.
    const empty = (t) => (t >= 1000 && t < 2000) || t >= 2500;
    const r = await mod.waitFor(() => ({ ok: empty(c.at()), seen: empty(c.at()) ? 'none' : 'builder-1' }), { timeout: 15000, holdMs: 2500, now: c.now, sleep: c.sleep });
    const c2 = clock();
    // Flickers every second for the whole wait: it never holds 2.5 s, so it fails and says so.
    const flick = await mod.waitFor(() => ({ ok: Math.floor(c2.at() / 1000) % 2 === 0, seen: 'builder-2' }), { timeout: 6000, holdMs: 2500, now: c2.now, sleep: c2.sleep });
    return [r.ok && r.ms >= 5000 && r.ms <= 5250 && !flick.ok && /did not hold for 2\.5 s/.test(flick.message) && /builder-2/.test(flick.message), JSON.stringify({ r, flick })];
  });

  await guard('P-044: a look that throws counts as "not yet", and its error is what the failure shows', async () => {
    const c = clock();
    const late = await mod.waitFor(() => { if (c.at() < 1000) throw new Error('element is detached'); return true; }, { timeout: 5000, now: c.now, sleep: c.sleep });
    const c2 = clock();
    const never = await mod.waitFor(() => { throw new Error('locator.innerText: Target closed'); }, { timeout: 2000, now: c2.now, sleep: c2.sleep });
    return [late.ok && late.ms >= 1000 && !never.ok && /Target closed/.test(never.message), JSON.stringify({ late, never })];
  });

  await guard('P-044: the wait is 15 s on Linux, twice that on Windows, and HUD_WAIT_MS sets it', async () => {
    const lin = mod.waitBudget(15000, { env: {}, platform: 'linux' });
    const win = mod.waitBudget(15000, { env: {}, platform: 'win32' });
    const set = mod.waitBudget(15000, { env: { HUD_WAIT_MS: '45000' }, platform: 'win32' });
    const bad = mod.waitBudget(15000, { env: { HUD_WAIT_MS: 'soon' }, platform: 'linux' });
    return [lin === 15000 && win === 30000 && set === 45000 && bad === 15000, JSON.stringify({ lin, win, set, bad })];
  });

  // hud-check itself (read, not run: it needs Chromium and takes about a minute).
  {
    const src = fs.readFileSync(path.join(dir, 'qa', 'hud-check.mjs'), 'utf8');
    const readOnce = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\b(check|needsBuild)\(/.test(l) && /await page\./.test(l));
    const waitsFor = (label) => new RegExp(`expect\\('${label}', launchedEmpty\\(page\\), \\{ holdMs: 2500`).test(src);
    const stopPause = waitsFor('Stop ends it and hands its task back') && waitsFor('Pause stops it and hands its task back');
    // The one fixed pause left lets the HUB and the fake model shut down before the copy is deleted.
    const fixedPauses = src.split('\n').filter((l) => /await wait\(\d+\);/.test(l)).length;
    report('P-044: hud-check never reads the page once for a check: Stop and Pause wait for an empty list that holds through a refresh, and no check sits behind a fixed pause', readOnce.length === 0 && stopPause && fixedPauses <= 1 && /from '\.\/wait-for\.mjs'/.test(src), JSON.stringify({ readOnce: readOnce.slice(0, 5), stopPause, fixedPauses }));
  }

  // --only / --repeat: checked before Playwright loads, so these need no browser.
  {
    const hc = (...args) => spawnSync(process.execPath, ['qa/hud-check.mjs', ...args], { cwd: dir, encoding: 'utf8', timeout: 120000, env: { ...process.env, PLAYWRIGHT_CHROMIUM: path.join(dir, 'no-such-chromium') } });
    const noOnly = hc('--repeat', '3');
    const wrong = hc('--only', 'everything');
    const notNum = hc('--only', 'stop-pause', '--repeat', 'lots');
    const said = (r, re) => r.status === 2 && re.test(`${r.stdout}${r.stderr}`);
    report('P-044: hud-check --only stop-pause --repeat <n> is how to repeat the Stop/Pause checks; a wrong section or count stops at once (exit 2) instead of running everything', said(noOnly, /--repeat .*--only/) && said(wrong, /--only takes one of: stop-pause/) && said(notNum, /whole number/), [noOnly, wrong, notNum].map((r) => `${r.status}: ${`${r.stdout}${r.stderr}`.slice(0, 200)}`).join(' | '));
  }
}
