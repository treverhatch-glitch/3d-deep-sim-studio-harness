/**
 * qa/selftest-241.mjs — the 2.41.0 check: a new browser regression must pass twice, never failing, before it
 * is protected (STUDIO_TWO_GREENS=on, opt-in).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest241({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const reports = path.join(dir, 'qa', 'reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(path.join(dir, 'qa', 'regressions', 'browser'), { recursive: true });
  const reg = path.join(dir, 'qa', 'regressions', 'browser', 'T-50.mjs');
  fs.writeFileSync(reg, 'export async function check() { return { ok: true }; }\n');
  // Written a few seconds before the plays, as in a real run (a report's "at" has whole milliseconds; a file's
  // time has finer ones, so a report written in the same millisecond would look older than the change).
  const t = (Date.now() - 5000) / 1000;
  fs.utimesSync(reg, t, t);
  let k = 0;
  const play = (ok) => {
    const id = 1793400000000 + (++k);
    fs.writeFileSync(path.join(reports, `browser_${id}.json`), JSON.stringify({ at: new Date().toISOString(), passed: ok, regressions: [{ file: 'qa/regressions/browser/T-50.mjs', ok, why: ok ? null : 'the HUD overlapped the end screen at tick 300' }] }));
  };
  let n = 0;
  const label = 'The new regression passed twice in a row, never failing (it is not flaky)';
  const probe = (env = {}) => {
    const f = path.join(tmpRoot, `p241-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, `import { checkDone } from ${u('harness/done-check.mjs')};
const r = checkDone({ id: 'T-50', title: 'Bug: the HUD overlaps the end screen', role: 'builder', part: 'renderer' }, Date.now() - 60000);
const c = r.checks.find((x) => x.label === ${JSON.stringify(label)});
console.log(JSON.stringify(c || null));`);
    const r = run(dir, `node "${f}"`, { STUDIO_VISUAL_GATE: 'off', ...env });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  play(true);
  const off = probe();
  const once = probe({ STUDIO_TWO_GREENS: 'on' });
  play(true);
  const twice = probe({ STUDIO_TWO_GREENS: 'on' });
  play(false);
  const flaky = probe({ STUDIO_TWO_GREENS: 'on' });
  report('2.41.0: with STUDIO_TWO_GREENS=on a new browser regression closes a renderer bug only after two passing plays since the last change and no failing one (a flaky test is named, not protected); off by default', off === null && once?.ok === false && /passed once since your last change/.test(once.why || '') && twice?.ok === true && flaky?.ok === false && /failed in 1 of 3 browser plays .*the HUD overlapped the end screen/.test(flaky.why || ''), JSON.stringify({ off, once, twice, flaky }));
}
