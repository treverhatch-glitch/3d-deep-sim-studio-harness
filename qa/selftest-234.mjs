/**
 * qa/selftest-234.mjs — the 2.34.0 checks: the harness's own health numbers and the morning report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest234({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p234-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const t = (m) => new Date(Date.UTC(2026, 9, 30, 0, m)).toISOString();
  const evs = [
    { type: 'agent.session.start', agent: 'b1', task: 'T-1', ts: t(0) },
    { type: 'task.done.start', agent: 'b1', task: 'T-1', ts: t(10) },
    { type: 'task.not_done', agent: 'b1', task: 'T-1', msg: 'T-1 not done yet: no code changed since it started', ts: t(11) },
    { type: 'task.not_done', agent: 'b1', task: 'T-1', msg: 'T-1 not done yet: 3 uncommitted changes (a, b, c)', ts: t(12) },
    { type: 'gates.run', agent: 'b1', meta: { ms: 30000, scoped: true }, ts: t(13) },
    { type: 'task.done.start', agent: 'b1', task: 'T-1', ts: t(14) },
    { type: 'lane.merged', agent: 'b1', task: 'T-1', ts: t(20) },
    { type: 'task.done', agent: 'b1', task: 'T-1', ts: t(20) },
    { type: 'agent.session.end', agent: 'b1', tokensIn: 500000, tokensOut: 20000, meta: { cacheRead: 1000000 }, ts: t(21) },
    { type: 'task.paused', agent: 'director', task: 'T-2', msg: 'Handed back T-2: The claim ran out with no running session on it', ts: t(22) },
    { type: 'task.paused', agent: 'b2', task: 'T-3', msg: 'Handed back T-3: stuck on the shader', ts: t(23) },
    { type: 'task.done', agent: 'grokbot-3', task: 'T-4', ts: t(24) },
    { type: 'gates.run', agent: 'b1', meta: { ms: 700000, scoped: false }, ts: t(25) },
  ];
  const h = probe(`import { health } from ${u('harness/health.mjs')};
console.log(JSON.stringify(health(${JSON.stringify(evs)}, { since: 0, now: Date.parse(${JSON.stringify(t(60))}) })));`, { STUDIO_CACHE_READ_WEIGHT: '0.1' });
  report('2.34.0: the harness health numbers: refusals per landing and why, harness-caused hand-backs, verify scoped vs unscoped, done-to-landed time, tokens per landing, untracked dones, and the misses against target', h.landings === 1 && h.refusalsPerLanding === 2 && h.reasons?.['no code changed'] === 1 && h.reasons?.['uncommitted files'] === 1 && h.harnessCausedShare === 0.5 && h.verifyMedianSec?.scoped === 30 && h.verifyMedianSec?.unscoped === 700 && h.doneMedianMin === 6 && h.tokensPerLanding === 620000 && h.untrackedDones === 1 && h.misses?.length === 3, JSON.stringify(h));

  // A verify records a gates.run event; task done --check records no task.done.start.
  const evFile = path.join(dir, '.studio', 'events-234.jsonl');
  const env = { AGENT_EVENTS_FILE: evFile, STUDIO_TASK_BUDGET: 'off', STUDIO_REFILL_WAKE: 'off' };
  run(dir, 'node scripts/run-gates.mjs --only secrets', env);
  const add = run(dir, 'node harness/task.mjs add "Health probe: a check-only done" --role builder', env);
  const id = (out(add).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${id} --agent builder-h1`, env);
  run(dir, `node harness/task.mjs done ${id} --agent builder-h1 --check`, { ...env, STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow' });
  const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const gr = lines.find((e) => e.type === 'gates.run');
  report('2.34.0: every verify writes a gates.run event (time, scoped, partial, failures); task done --check writes no task.done.start', Boolean(gr) && Number.isFinite(gr.meta?.ms) && gr.meta.partial === true && !lines.some((e) => e.type === 'task.done.start'), JSON.stringify(lines.map((e) => e.type)));

  // The morning report lists a task parked by its budget under "Needs you".
  run(dir, `node harness/task.mjs park ${id} --by budget --why "used its budget: 6 sessions (limit 6)"`, env);
  const m = run(dir, 'node harness/health.mjs --morning --since 1d', env);
  report('2.34.0: npm run harness-health -- --morning lists what is parked under "Needs you"', m.status === 0 && /## Needs you/.test(m.stdout) && new RegExp(`${id} is parked by`).test(m.stdout), out(m));
}
