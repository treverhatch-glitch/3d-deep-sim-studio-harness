/**
 * qa/selftest-291b.mjs — 2.91 (w1, w2): two fixes from a live studio.
 *   w1  the idle stop does not fire while finished work waits on a train (a done, a landing, a queued lane)
 *   w2  each resume command names the other stop (the studio stop and the supervisor's stop or halt) when it is still set
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlIn as u, guardCap3000Of, importInDirOf, out } from './kit.mjs';

export async function selftest291B({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const imp = importInDirOf(dir);
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX)/i.test(k)) clean[k] = '';
  const env = { ...clean, STUDIO_WATCHDOG: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-291b-${process.pid}.pem`), CI: '', NODE_OPTIONS: '' };
  const S = path.join(tmpRoot, `291b-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(S, '.env'), '');
  const run = (args) => out(spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 120000 }));
  const stopFile = path.join(S, '.studio', 'STOP.json');
  const supStop = path.join(S, '.studio', 'supervisor-stop');
  const supStatus = path.join(S, '.studio', 'supervisor.json');

  // ================= w1: the idle stop =================
  const W = await imp('harness/watchdog.mjs');
  const now = Date.parse('2026-03-03T12:00:00Z');
  const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const lim = { checkMin: 15, handBacks: 3, idleHours: 2 };
  const ends = [1, 2, 3].map((i) => ({ type: 'agent.session.end', agent: `b-${i}`, task: `T-${i}`, ts: at(30) }));
  const base = [{ type: 'setup.init', ts: at(300) }, ...ends];
  const reason = (extra) => W.idleStopReason(now, { events: [...base, ...extra], lim, auto: true });
  await guard('2.91 (w1) idle stop: with task sessions and nothing finished it still fires (3 sessions, 2 h); fails before this fix: n/a, this is the rule kept', () => {
    const r = reason([]);
    return [r?.ran === 3 && r.hours === 2, JSON.stringify(r)];
  });
  await guard('2.91 (w1) idle stop: it does not fire when a task was queued for an engine train in the window; fails before this fix: it stopped a studio with 21 finished tasks queued for a 7 h engine train', () => {
    const r = reason([{ type: 'task.train.forge.queued', agent: 'b-1', task: 'T-1', ts: at(20) }]);
    return [r === null, JSON.stringify(r)];
  });
  await guard('2.91 (w1) idle stop: it does not fire for the web train\'s queue events (task.train.queued, task.done.queued); fails before this fix: it fired', () => {
    const a = reason([{ type: 'task.train.queued', agent: 'b-1', task: 'T-1', ts: at(20) }]);
    const b = reason([{ type: 'task.done.queued', agent: 'b-1', task: 'T-1', ts: at(20) }]);
    return [a === null && b === null, JSON.stringify({ a, b })];
  });
  await guard('2.91 (w1) idle stop: it does not fire for a landing (web or engine); and a queue event older than the window does not count; fails before this fix: the landings did not count', () => {
    const web = reason([{ type: 'task.train.landed', agent: 'train', ts: at(20), meta: { lanes: ['T-1'] } }]);
    const eng = reason([{ type: 'task.train.forge.landed', agent: 'forge-train', ts: at(20), meta: { lanes: ['T-1'] } }]);
    const old = reason([{ type: 'task.train.forge.queued', agent: 'b-1', task: 'T-1', ts: at(200) }]);
    return [web === null && eng === null && old?.ran === 3, JSON.stringify({ web, eng, old })];
  });

  // ================= w2: the resume verbs name the other stop =================
  const writeStop = () => fs.writeFileSync(stopFile, `${JSON.stringify({ by: 'dana', reason: 'checking the build', at: at(5) })}\n`);
  const clear = () => { for (const f of [stopFile, supStop, supStatus]) fs.rmSync(f, { force: true }); };
  const SUP_STOPPED = /supervisor is still stopped.*npm run studio:start/;
  const SUP_HALTED = /supervisor is halted.*npm run studio:resume -- --by <name>/;
  const STOP_NAMED = /still stopped by dana \(checking the build\).*no new task starts until it is resumed.*npm run task -- resume --by <name>/;
  await guard('2.91 (w2) task resume: after "Studio resumed" it says the supervisor is still stopped and gives npm run studio:start; fails before this fix: it said nothing', () => {
    clear(); writeStop(); fs.writeFileSync(supStop, at(1));
    const t = run(['harness/task.mjs', 'resume', '--by', 'tester']);
    return [/Studio resumed/.test(t) && SUP_STOPPED.test(t) && !SUP_HALTED.test(t) && !fs.existsSync(stopFile) && fs.existsSync(supStop), t.slice(-600)];
  });
  await guard('2.91 (w2) task resume: with a halted supervisor it says so and gives npm run studio:resume -- --by <name>; fails before this fix: it said nothing', () => {
    clear();
    const probe = path.join(tmpRoot, `probe-291b-${process.pid}.mjs`);
    fs.writeFileSync(probe, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { selfIdentity } from ${u(S, 'harness/proc-identity.mjs')};
fs.writeFileSync('.studio/supervisor.json', JSON.stringify({ pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: Date.now(), halted: { why: 'two sessions ended the same way' } }));
const r = spawnSync(process.execPath, ['harness/task.mjs', 'resume', '--by', 'tester'], { windowsHide: true, encoding: 'utf8', env: process.env });
console.log(JSON.stringify({ text: String(r.stdout) + String(r.stderr) }));`);
    const r = spawnSync(process.execPath, [probe], { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 120000 });
    try { fs.rmSync(probe, { force: true }); } catch { /* swept later */ }
    const text = (() => { try { return JSON.parse(String(r.stdout).trim().split('\n').filter((x) => x.startsWith('{')).pop()).text; } catch { return out(r); } })();
    return [/not stopped/.test(text) && SUP_HALTED.test(text) && !SUP_STOPPED.test(text), text.slice(-600)];
  });
  await guard('2.91 (w2) task resume: with no supervisor stop and no halt it prints only its own line; fails before this fix: n/a, the quiet case is kept', () => {
    clear(); writeStop();
    const t = run(['harness/task.mjs', 'resume', '--by', 'tester']);
    return [t.trim() === 'Studio resumed. Agents can start tasks again.', t.slice(-600)];
  });
  await guard('2.91 (w2) studio:resume: when the studio stop is set it says who stopped it and why, that no task starts, and gives npm run task -- resume --by <name>; fails before this fix: it said nothing', () => {
    clear(); writeStop();
    const t = run(['harness/supervisor.mjs', 'resume', '--by', 'tester']);
    return [/Not halted/.test(t) && STOP_NAMED.test(t) && fs.existsSync(stopFile), t.slice(-600)];
  });
  await guard('2.91 (w2) studio:resume: with the studio not stopped it prints only its own line; fails before this fix: n/a, the quiet case is kept', () => {
    clear();
    const t = run(['harness/supervisor.mjs', 'resume', '--by', 'tester']);
    return [/Not halted/.test(t) && !/still stopped/.test(t), t.slice(-600)];
  });
  await guard('2.91 (w2) studio:start: when the studio stop is set it names it after "running on its own"; with none set it does not; fails before this fix: it said nothing', () => {
    const start = () => {
      const t = run(['harness/supervisor.mjs']);
      const pid = Number(/pid (\d+)/.exec(t)?.[1] || 0);
      if (pid) { try { process.kill(pid); } catch { /* gone already */ } }
      return t;
    };
    clear(); writeStop();
    const a = start();
    clear();
    const b = start();
    clear();
    return [/running on its own/.test(a) && STOP_NAMED.test(a) && /running on its own/.test(b) && !/still stopped/.test(b), JSON.stringify({ a: a.slice(-500), b: b.slice(-300) })];
  });
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ }
}
