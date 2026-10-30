/**
 * qa/selftest-240.mjs — the 2.40.0 checks: a quieter watchdog log (opt-in) and the health report's counts for
 * the watchdog, silent greens, whole-game reds and unwired code.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest240({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p240-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const evFile = path.join(dir, '.studio', 'events-240.jsonl');
  const quietFile = path.join(tmpRoot, `quiet-240-${process.pid}.json`);

  // 1. The same error every 3 minutes: logged once an hour with a count when quiet is on; every time when off.
  const code = (env) => `import { logActions } from ${u('harness/watchdog.mjs')};
const t0 = Date.parse('2026-10-31T00:00:00Z');
const env = ${JSON.stringify(env)};
const pass = (m) => logActions([{ kind: 'error', msg: 'layout step: ENOENT after ' + (m * 7) + ' tries' }, { kind: 'park', task: 'T-' + (m + 1), msg: 'parked T-' + (m + 1) }], { now: t0 + m * 60000, env, file: ${JSON.stringify(quietFile)} }).length;
const counts = [0, 3, 6, 9, 61, 64].map(pass);
console.log(JSON.stringify({ counts }));`;
  const q = probe(code({ STUDIO_WATCHDOG_QUIET_MIN: '60' }), { AGENT_EVENTS_FILE: evFile });
  const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const repeated = lines.find((e) => e.meta?.repeated);
  fs.rmSync(evFile, { force: true });
  const loud = probe(code({}), { AGENT_EVENTS_FILE: evFile });
  report('2.40.0: with STUDIO_WATCHDOG_QUIET_MIN the same watchdog action (numbers ignored) is logged once per window and then with how often it repeated; different tasks are still logged; off by default', JSON.stringify(q.counts) === JSON.stringify([2, 1, 1, 1, 2, 1]) && repeated?.meta?.repeated === 3 && /\(repeated 3 more times since 00:00 UTC\)/.test(repeated.msg) && JSON.stringify(loud.counts) === JSON.stringify([2, 2, 2, 2, 2, 2]), JSON.stringify({ q, loud, repeated }));

  // 2. The health report counts the watchdog per landing and the 2.36-2.38 signals.
  const t = (m) => new Date(Date.UTC(2026, 9, 31, 0, m)).toISOString();
  const evs = [
    { type: 'lane.merged', task: 'T-1', ts: t(1) }, { type: 'lane.merged', task: 'T-2', ts: t(2) },
    ...[3, 4, 5, 6, 7].map((m) => ({ type: 'watchdog.action', ts: t(m) })),
    { type: 'gate.silent_green', ts: t(8) }, { type: 'whole.red', ts: t(9) }, { type: 'whole.environment', ts: t(10) }, { type: 'task.unwired', ts: t(11) }, { type: 'task.unwired', ts: t(12) },
  ];
  const h = probe(`import { health, renderHealth } from ${u('harness/health.mjs')};
const h = health(${JSON.stringify(evs)}, { since: 0, now: Date.parse(${JSON.stringify(t(60))}) });
console.log(JSON.stringify({ h, text: renderHealth(h) }));`);
  report('2.40.0: the harness health report counts watchdog log lines per landing, checks that ran nothing, whole-game reds (and environment re-runs) and unwired code noted at done', h.h?.watchdogEvents === 5 && h.h.watchdogPerLanding === 2.5 && h.h.silentGreens === 1 && h.h.wholeRed === 1 && h.h.wholeEnvironment === 1 && h.h.unwired === 2 && /Watchdog log lines: 5 \(2\.5 per landing\); checks that ran nothing: 1; whole-game reds: 1 \(environment 1\); unwired code noted at done: 2/.test(h.text), JSON.stringify(h));
}
