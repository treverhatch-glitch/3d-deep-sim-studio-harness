/**
 * qa/selftest-280b.mjs — 2.80 (b1): the hub's timed passes run in the supervisor's loop.
 *
 * The War Room hub goes in 2.80. Until 2.79.2 it ran, on its own timers, the watch pass with the retro, learn, run report
 * and the Director's daily ping (STUDIO_WATCH_INTERVAL), the watchdog (STUDIO_GAMEDEV_INTERVAL) and a second flow pass.
 * harness/studio-passes.mjs schedules the first two from the supervisor; the supervisor's own flow pass stays the only one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest280B({ dir, report }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const load = async () => (await import(u('harness/studio-passes.mjs'))).timedPasses;
  // Fakes: every pass records its call; `throwing` names the passes that throw; `step` records the bounded steps.
  const fakes = (throwing = []) => {
    const calls = [];
    const lines = [];
    const steps = [];
    const pass = (name, out) => () => { calls.push(name); if (throwing.includes(name)) throw new Error(`${name} broke`); return out; };
    return {
      calls, lines, steps,
      deps: {
        watchPass: pass('watchPass', { findings: [{ msg: 'a finding' }] }),
        retroIfDue: pass('retroIfDue', { file: 'retro.md', suggestions: [1] }),
        learnIfDue: pass('learnIfDue', null),
        runReportIfDue: pass('runReportIfDue', { ok: true, dest: 'run.md' }),
        dailyPingIfDue: pass('dailyPingIfDue', null),
        watchdogPass: async () => { calls.push('watchdogPass'); if (throwing.includes('watchdogPass')) throw new Error('watchdog broke'); return { on: true, actions: [{ msg: 'refilled' }] }; },
        log: (l) => lines.push(l),
        warn: (l) => lines.push(l),
        step: (label, fn) => { steps.push(label); return fn(); },
      },
    };
  };
  const t0 = 1_800_000_000_000;
  const env = { STUDIO_WATCH_INTERVAL: '300', STUDIO_GAMEDEV_INTERVAL: '180' };
  const WATCH = ['watchPass', 'retroIfDue', 'learnIfDue', 'runReportIfDue', 'dailyPingIfDue'];

  await guard('2.80 (b1): nothing runs before one full interval since the supervisor started; the watchdog first at 180 s, the watch group at 300 s (fails on 2.79.2: harness/studio-passes.mjs does not exist; the hub ran the watch pass 5 s after it started)', async () => {
    const timedPasses = await load();
    const f = fakes();
    const last = {};
    const at = async (s) => (await timedPasses({ now: t0 + s * 1000, since: t0, last, env, deps: f.deps })).ran.join(',');
    const seen = [await at(0), await at(60), await at(179), await at(180), await at(299), await at(300)];
    return [JSON.stringify(seen) === JSON.stringify(['', '', '', 'gamedev', '', 'watch']) && f.calls.join(',') === ['watchdogPass', ...WATCH].join(','), JSON.stringify({ seen, calls: f.calls })];
  });

  await guard('2.80 (b1): each pass runs once per interval, in one bounded step per group, and logs one line as the hub did (fails on 2.79.2: no timedPasses)', async () => {
    const timedPasses = await load();
    const f = fakes();
    const last = {};
    for (let s = 0; s <= 900; s += 60) await timedPasses({ now: t0 + s * 1000, since: t0, last, env, deps: f.deps });
    const n = (k) => f.calls.filter((c) => c === k).length;
    // 60 s loop: watch at 300, 600, 900 (3); gamedev at 180, 360, 540, 720, 900 (5).
    const ok = WATCH.every((k) => n(k) === 3) && n('watchdogPass') === 5
      && f.steps.filter((s) => s === 'timed-watch').length === 3 && f.steps.filter((s) => s === 'timed-gamedev').length === 5
      && f.lines.includes('[watch] a finding') && f.lines.includes('[retro] wrote retro.md: 1 suggestion(s)') && f.lines.includes('[run-report] updated run.md') && f.lines.includes('[gamedev] refilled');
    return [ok, JSON.stringify({ calls: f.calls, steps: f.steps, lines: f.lines })];
  });

  await guard('2.80 (b1): a pass that throws is logged and the others still run (fails on 2.79.2: in the hub a throwing watchPass skipped the retro, learn, run report and daily ping)', async () => {
    const timedPasses = await load();
    const f = fakes(['watchPass', 'learnIfDue', 'watchdogPass']);
    const r = await timedPasses({ now: t0 + 300000, since: t0, last: {}, env, deps: f.deps });
    return [f.calls.join(',') === [...WATCH, 'watchdogPass'].join(',') && r.ran.join(',') === 'watch,gamedev'
      && f.lines.includes('[watch] watchPass broke') && f.lines.includes('[learn] learnIfDue broke') && f.lines.includes('[gamedev] watchdog broke'),
      JSON.stringify({ calls: f.calls, lines: f.lines })];
  });

  await guard('2.80 (b1), 2.81: STUDIO_WATCH_INTERVAL=0 skips only the watch pass (the retro, learn pass, run report, daily ping and the watchdog still run: 2.80.0 ran none of them), STUDIO_GAMEDEV_INTERVAL=0 skips only the watchdog, a dry run runs none (fails on 2.79.2: no timedPasses)', async () => {
    const timedPasses = await load();
    const late = t0 + 3600000;
    const off = fakes();
    await timedPasses({ now: late, since: t0, last: {}, env: { STUDIO_WATCH_INTERVAL: '0', STUDIO_GAMEDEV_INTERVAL: '180' }, deps: off.deps });
    const noGd = fakes();
    await timedPasses({ now: late, since: t0, last: {}, env: { STUDIO_WATCH_INTERVAL: '300', STUDIO_GAMEDEV_INTERVAL: '0' }, deps: noGd.deps });
    const dry = fakes();
    await timedPasses({ now: late, since: t0, last: {}, env, dryRun: true, deps: dry.deps });
    const defaults = fakes();
    await timedPasses({ now: t0 + 299000, since: t0, last: {}, env: {}, deps: defaults.deps });
    return [off.calls.join(',') === [...WATCH.filter((n) => n !== 'watchPass'), 'watchdogPass'].join(',') && noGd.calls.join(',') === WATCH.join(',') && dry.calls.length === 0 && defaults.calls.join(',') === 'watchdogPass',
      JSON.stringify({ off: off.calls, noGd: noGd.calls, dry: dry.calls, defaults: defaults.calls })];
  });

  await guard('2.80 (b1, b2): there is no hub/ directory left to schedule the watch, retro, learn, run report, daily ping, watchdog or flow passes, and the supervisor calls timedPasses from its loop with its start time and dry run (fails on 2.79.2: the hub ran them on setInterval timers)', () => {
    const sup = fs.readFileSync(path.join(dir, 'harness', 'supervisor.mjs'), 'utf8');
    const hubRuns = fs.existsSync(path.join(dir, 'hub'));
    const tick = sup.slice(sup.indexOf('const tick = async () => {'), sup.indexOf('const loop = async () => {'));
    const call = /import\('\.\/studio-passes\.mjs'\)\.then\(\(\{ timedPasses \}\) => timedPasses\(\{ since: state\.startedAt, [^\n]*dryRun: opts\.dryRun[^\n]*boundedStep\(label, fn, \{ state \}\)/.test(tick);
    const flows = (tick.match(/flowPass\(/g) || []).length;
    return [!hubRuns && call && flows === 1, JSON.stringify({ hubRuns, call, flows })];
  });
}
