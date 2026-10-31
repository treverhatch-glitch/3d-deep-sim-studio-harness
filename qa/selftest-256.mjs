/**
 * qa/selftest-256.mjs — 2.56.0 (PU-15): the visual-effect spec and the frame checks, without a browser.
 * The browser proof (stills from a real page, planted faults named) is scripts/check-vfx.mjs, in CI's browser job.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest256({ dir, run, report }) {
  const v = await import(pathToFileURL(path.join(dir, 'harness', 'vfx.mjs')).href);
  const base = { ...v.starterSpec('hit-flash', { kind: 'one-shot', ms: 300 }), communicates: 'the hit landed' };
  const starter = v.validateSpec(v.starterSpec('x'));
  const bad = v.validateSpec({ ...base, phases: [{ name: 'a', ms: 100 }], stage: { w: 4000, h: 10 }, flash: { maxPerSecond: 10 } });
  report('2.56.0 (PU-15): an effect spec must say what it communicates, have phases that add up to its duration, a small stage and a flash limit of at most 3 a second; a filled-in starter is usable',
    v.validateSpec(base).length === 0 && starter.some((p) => /communicates/.test(p)) && bad.some((p) => /add up to 100 ms/.test(p)) && bad.some((p) => /stage/.test(p)) && bad.some((p) => /at most 3/.test(p)), JSON.stringify({ starter, bad }));
  const ts = v.sampleTimes({ ...base, frames: 5 });
  const dense = v.flashTimes({ ...base, durationMs: 2000 });
  report('2.56.0 (PU-15): stills are taken at fixed effect times from 0 to the end, and the flash pass samples 30 a second, never in real time',
    JSON.stringify(ts) === '[0,75,150,225,300]' && dense.length === 60 && dense[0] === 0 && dense.at(-1) === 2000, JSON.stringify({ ts, n: dense.length }));
  const f = (t, changed, edge = 0, lum = 0.1) => ({ t, changed, edge, lum });
  const clean = { frames: [f(0, 0.02), f(150, 0.1), f(300, 0)], dense: [{ t: 0, changed: 0.02, lum: 0.1 }, { t: 300, changed: 0, lum: 0 }], same: 0 };
  const ok = v.judge(base, clean);
  const ids = (r) => r.checks.filter((c) => !c.ok).map((c) => c.id);
  const never = v.judge(base, { ...clean, frames: [f(0, 0.02), f(150, 0.1), f(300, 0.08)] });
  const edge = v.judge(base, { ...clean, frames: [f(0, 0.02), f(150, 0.3, 40), f(300, 0)] });
  const strobeDense = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, changed: i % 3 === 0 ? 0.9 : 0, lum: i % 3 === 0 ? 0.95 : 0.05 }));
  const strobe = v.judge({ ...base, durationMs: 1000 }, { ...clean, dense: strobeDense });
  const random = v.judge(base, { ...clean, same: 0.03 });
  const blank = v.judge(base, { ...clean, frames: [f(0, 0), f(150, 0), f(300, 0)] });
  const loop = { ...base, kind: 'loop', phases: [{ name: 'cycle', ms: 300 }] };
  const seamless = v.judge(loop, { ...clean, frames: [f(0, 0.01), f(150, 0.01), f(300, 0.01)], seam: 0 });
  const jumpy = v.judge(loop, { ...clean, frames: [f(0, 0.01), f(150, 0.01), f(300, 0.01)], seam: 0.014 });
  report('2.56.0 (PU-15): the checks pass a clean effect and name each fault: a one-shot that never ends, a loop that jumps, an effect touching its stage edge, a 10-a-second full-stage strobe, unseeded randomness, and nothing drawn',
    ok.ok && JSON.stringify(ids(never)) === '["ends-empty"]' && JSON.stringify(ids(edge)) === '["stays-inside"]' && JSON.stringify(ids(strobe)) === '["flash-rate"]' && JSON.stringify(ids(random)) === '["same-seed"]' && ids(blank).includes('draws') && seamless.ok && JSON.stringify(ids(jumpy)) === '["loop-seam"]',
    JSON.stringify({ ok: ids(ok), never: ids(never), edge: ids(edge), strobe: ids(strobe), random: ids(random), blank: ids(blank), seamless: ids(seamless), jumpy: ids(jumpy) }));
  const cli = run(dir, 'node harness/vfx.mjs new ui-press --kind loop --ms 600');
  const val = run(dir, 'node harness/vfx.mjs validate ui-press');
  report('2.56.0 (PU-15): npm run vfx -- new writes a starter spec that validate refuses until it says what the effect communicates',
    cli.status === 0 && val.status !== 0 && /communicates/.test(`${val.stdout}`), `${cli.stdout}${cli.stderr}${val.stdout}`);
}
