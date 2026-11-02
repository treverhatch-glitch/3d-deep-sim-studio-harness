/**
 * qa/selftest-267e.mjs — 2.67.0 (e): the supervisor's --help never starts a supervisor (B-47's last command: a helper's
 * smoke load of `node harness/supervisor.mjs --help` started a real one, twice).
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest267E({ dir, run, report }) {
  const status = path.join(dir, '.studio', 'supervisor.json');
  try { fs.rmSync(status, { force: true }); } catch {}
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off' };
  const h = run(dir, 'node harness/supervisor.mjs --help', env);
  const h2 = run(dir, 'node harness/supervisor.mjs -h --foreground', env);
  const text = `${h.stdout || ''}${h.stderr || ''}`;
  report('2.67.0 (e, B-47): `node harness/supervisor.mjs --help` (and -h --foreground) prints usage and exits 0 at once; no supervisor starts (no .studio/supervisor.json written) (fails on 2.66.0: --help started a real supervisor)',
    h.status === 0 && h2.status === 0 && /Usage:/.test(text) && /studio:start/.test(text) && !fs.existsSync(status),
    `${text.slice(-800)}\nstatus file: ${fs.existsSync(status)}`);
  // 2.67.0: `node harness/stall.mjs` as the entry module must load: once task-hold.mjs imported reclassify.mjs, the
  // cycle back through worktree.mjs read PLANNING_ROLES from stall.mjs before it existed (CI Node 24, 2.30o checks).
  const st = run(dir, 'node harness/stall.mjs --no-such-command', env);
  report('2.67.0 (e): `node harness/stall.mjs` loads as the entry module (PLANNING_ROLES lives in harness/planning-roles.mjs, so no import cycle reads it before it exists) (fails on the first 2.67.0 build: ReferenceError)',
    !/ReferenceError|before initialization/.test(`${st.stdout || ''}${st.stderr || ''}`), `${st.stdout || ''}${st.stderr || ''}`.slice(-600));
  // 2.68.0: a halt seen on the pass that finds the time up is still recorded (CI Windows, 2.67.1: the second exit-127
  // session ended after --until, the supervisor stopped first and no halt was written).
  const events = path.join(dir, '.studio', 'events-267e.jsonl');
  fs.mkdirSync(path.dirname(events), { recursive: true });
  const t0 = Date.now() - 60000;
  fs.writeFileSync(events, ['rnd-s1', 'rnd-s2'].map((a, i) => JSON.stringify({ ts: new Date(t0 + 10000 * (i + 1)).toISOString(), type: 'agent.session.end', agent: a, meta: { code: 127, tool: 'custom', role: 'rnd' } })).join('\n') + '\n');
  const probe = path.join(dir, 'probe-267e-halt.mjs');
  fs.writeFileSync(probe, `import { supervise } from './harness/supervisor.mjs';
const state = { startedAt: ${t0}, names: ['rnd-s1', 'rnd-s2'] };
const r = await supervise({ until: Date.now() - 1000, dryRun: true }, state);
console.log(JSON.stringify({ stop: Boolean(r.stop), halted: state.halted ? { code: state.halted.code, why: state.halted.why } : null }));
`);
  const hp = run(dir, `node "${probe}"`, { ...env, AGENT_EVENTS_FILE: events, STUDIO_RND_CMD: 'no-such-agent-tool-267e' });
  let hj = {};
  try { hj = JSON.parse(String(hp.stdout).trim().split('\n').pop()); } catch {}
  report('2.68.0 (e): when the pass that finds --until reached also sees two sessions in a row ended with exit 127, the supervisor stops AND records the halt with its reason (fails on 2.67.2: the stop returned first and the halt was lost)',
    hj.stop === true && hj.halted?.code === 127 && /wasn't found/.test(hj.halted?.why || ''), `${hp.stdout || ''}${hp.stderr || ''}`.slice(-800));
}
