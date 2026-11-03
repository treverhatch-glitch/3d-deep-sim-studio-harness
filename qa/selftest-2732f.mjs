/**
 * qa/selftest-2732f.mjs — 2.73.2 (helper f): a session end is recorded once; .env changes reach running processes.
 *   B-72 a   a session whose agent has exited while its launcher is still alive (wrapping up: handing the work back,
 *            maybe closing the task itself) lists as ending, not STALLED: the agent list, the watch pass and the
 *            silent-agent release leave it to the launcher
 *   B-72 b   the watchdog's stall end is logged and acted on once per session, not on every pass
 *   B-72 c   one agent.session.end per session, whoever records it (a stop's endAsDead, then the launcher's clean-up)
 *   B-72/76  the watchdog's stall end of a running launcher's agent records exitCause stall (by watchdog), so the
 *            "two sessions in a row" halt never counts it as the tool failing
 *   B-74 a   a running launcher's heartbeat picks up a stall limit changed in .env (the session is ended on the new
 *            limit), one env.reloaded event names the keys and never a secret's value, identity lines never load
 *   B-74 b   precedence in a child started by a process that loaded .env: a value inherited from .env follows the file,
 *            a value its starter set itself wins; the train daemon's pass reads the new STUDIO_TRAIN_AUTO
 *   B-74 c   `npm run studio:reload-env` makes a running supervisor reload now and says what changed
 * Each check fails on 2.73.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2732F({ dir, run, report, tmpRoot, root }) {
  void run; void root;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  // Names these checks set from .env or rely on being unset: never inherited from the shell running the self-test.
  const UNSET = ['STUDIO_STALL_MIN', 'STUDIO_STALL_PLAN_MIN', 'STUDIO_SESSION_MAX_MIN', 'STUDIO_STALL', 'STUDIO_TRAIN_AUTO', 'STUDIO_TRAIN_MIN', 'STUDIO_TRAIN_WAIT_MIN', 'STUDIO_TRAIN', 'HUB_TOKEN', 'STUDIO_ENV_FROM_FILE', 'STUDIO_STALL_RELEASE_MIN', 'STUDIO_DONE_RUNNING_MAX_MIN'];
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_GAMEDEV_SKIP: 'refill,milestones,launch,landing,tiers,review,cycle', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2732f-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  let n = 0;
  const studio = (name, envText = null) => {
    const S = path.join(tmpRoot, `2732f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2732f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (envText !== null) fs.writeFileSync(path.join(S, '.env'), envText);
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2732f-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: r.stderr?.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(250); } return fn(); };
  const readRec = (S, agent) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.json`), 'utf8')); } catch { return null; } };
  // A stand-in agent that does nothing for `secs` seconds (outside the studio copy, so it never changes its git status).
  const sleeper = path.join(tmpRoot, `sleeper-2732f-${process.pid}.mjs`);
  fs.writeFileSync(sleeper, "setTimeout(() => process.exit(0), Number(process.argv[2] || 30) * 1000);\n");
  const M = 60000;

  // ---- B-72 a: an ending session isn't STALLED ----
  await guard('2.73.2 (B-72): a session whose agent process is gone while its launcher is still alive (wrapping up, 8 min without a heartbeat) lists as ending, not STALLED: sessions() says not stalled, `npm run agent -- list` says ending, the watch pass raises no "stalled" finding and the silent-agent release (STUDIO_STALL_RELEASE_MIN) doesn\'t hand its task back (fails on 2.73.1: STALLED, a stall finding for the Producer, and its task freed beside the launcher)', async () => {
    const { S, env } = studio('ending');
    const r = probe(S, { ...env, STUDIO_STALL_RELEASE_MIN: '5' }, 'ending', `import fs from 'node:fs'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
const root = path.resolve('.'); const M = 60000; const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const launcher = spawn(process.execPath, [${JSON.stringify(sleeper)}, '60'], { windowsHide: true, stdio: 'ignore' });
const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
fs.mkdirSync(path.join(root, '.studio', 'agents'), { recursive: true });
const startedAt = iso(now - 40 * M);
fs.writeFileSync(path.join(root, '.studio', 'agents', 'builder-e1.json'), JSON.stringify({ agent: 'builder-e1', role: 'builder', tool: 'custom', model: 'fake-1', pid: dead, supervisor: launcher.pid, status: 'running', startedAt, lastBeat: iso(now - 8 * M), task: 'T-001' }));
const { claim } = await import(${u(S, 'harness/lock.mjs')});
claim('task:T-001', 'builder-e1', 3600);
const { sessions } = await import(${u(S, 'harness/agent.mjs')});
const s = sessions().find((x) => x.agent === 'builder-e1');
const { watchPass, releaseStalled } = await import(${u(S, 'harness/watch.mjs')});
const w = watchPass({ dryRun: true });
const rel = releaseStalled({ dryRun: true, prevPassAt: now - 60000 });
const list = spawnSync(process.execPath, ['harness/agent.mjs', 'list'], { windowsHide: true, cwd: root, encoding: 'utf8', env: process.env }).stdout;
launcher.kill();
console.log(JSON.stringify({ running: s?.running, stalled: s?.stalled, ending: s?.ending || null, findings: w.findings.filter((f) => f.agent === 'builder-e1').map((f) => f.kind), released: rel.filter((x) => x.agent === 'builder-e1').length, line: list.split('\\n').find((l) => l.includes('builder-e1')) || '' }));
`);
    const ok = r.running === true && r.stalled === false && Boolean(r.ending) && !r.findings?.includes('stalled') && r.released === 0 && /^ending/.test(r.line || '') && !/STALLED/.test(r.line || '');
    return [ok, JSON.stringify(r)];
  });

  // ---- B-72 b: the watchdog's stall end once ----
  await guard('2.73.2 (B-72): the watchdog\'s pass ends a stalled session once: three passes over a running session past STUDIO_STALL_MIN log one "Ended <agent>" (session.stall) and kill once; after its agent is gone the session is left to its launcher (fails on 2.73.1: "Ended" logged and the kill tried on every pass while the heartbeat was fresh)', async () => {
    const { S, ev, env } = studio('once');
    const r = probe(S, { ...env, STUDIO_STALL_MIN: '1' }, 'once', `import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const root = path.resolve('.'); const M = 60000; const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const launcher = spawn(process.execPath, [${JSON.stringify(sleeper)}, '60'], { windowsHide: true, stdio: 'ignore' });
const agentP = spawn(process.execPath, [${JSON.stringify(sleeper)}, '60'], { windowsHide: true, stdio: 'ignore' });
let agentExited = false; agentP.on('exit', () => { agentExited = true; });
await new Promise((r) => setTimeout(r, 300));
fs.mkdirSync(path.join(root, '.studio', 'agents'), { recursive: true });
const startedAt = iso(now - 30 * M);
const rec = () => ({ agent: 'builder-o1', role: 'builder', tool: 'custom', model: 'fake-1', pid: agentP.pid, supervisor: launcher.pid, status: 'running', startedAt, lastBeat: iso(Date.now() - 30000), task: null });
const { gamedevPass } = await import(${u(S, 'harness/gamedev-loop.mjs')});
const acts = [];
for (let i = 0; i < 3; i++) {
  // the launcher's heartbeat keeps the record fresh (it rewrites the record every beat)
  const cur = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.studio', 'agents', 'builder-o1.json'), 'utf8')); } catch { return null; } })();
  fs.writeFileSync(path.join(root, '.studio', 'agents', 'builder-o1.json'), JSON.stringify({ ...rec(), ...(cur?.agentExited ? { agentExited: cur.agentExited } : {}), lastBeat: iso(Date.now() - 30000) }));
  for (const a of await gamedevPass(Date.now())) acts.push(a.kind);
  await new Promise((r) => setTimeout(r, 400));
}
launcher.kill(); try { agentP.kill(); } catch {}
console.log(JSON.stringify({ acts, agentExited }));
`);
    const ends = events(ev).filter((e) => e.type === 'session.stall' && e.meta?.target === 'builder-o1');
    const ok = ends.length === 1 && (r.acts || []).filter((k) => k === 'stall').length === 1 && r.agentExited === true;
    return [ok, `session.stall events: ${ends.length}; actions ${JSON.stringify(r.acts)}; agent killed: ${r.agentExited}\n${r._err || ''}`];
  });

  // ---- B-72 c: one agent.session.end ----
  await guard('2.73.2 (B-72): one agent.session.end per session: after a stop ended a session whose launcher looked gone (endAsDead), the launcher\'s own late clean-up and the watch pass\'s markGone record no second end (fails on 2.73.1: the clean-up logged a second end, which the halt rule and the token report count again)', async () => {
    const { S, ev, env } = studio('end1');
    const r = probe(S, env, 'end1', `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const root = path.resolve('.'); const now = Date.now(); const iso = (t) => new Date(t).toISOString();
const dead = () => spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
fs.mkdirSync(path.join(root, '.studio', 'agents'), { recursive: true });
const rec = { agent: 'builder-d1', role: 'builder', tool: 'custom', model: 'fake-1', pid: dead(), supervisor: dead(), status: 'running', startedAt: iso(now - 20 * 60000), lastBeat: iso(now - 20 * 60000), task: null };
fs.writeFileSync(path.join(root, '.studio', 'agents', 'builder-d1.json'), JSON.stringify(rec));
const a = await import(${u(S, 'harness/agent.mjs')});
const st = a.stopAgent(rec, { by: 'watchdog' });
a.cleanUp('builder-d1', { code: 1, log: '', role: 'builder', tool: 'custom', model: 'fake-1' });
a.markGone();
console.log(JSON.stringify({ ended: st.ended, status: JSON.parse(fs.readFileSync(path.join(root, '.studio', 'agents', 'builder-d1.json'), 'utf8')).status }));
`);
    const ends = events(ev).filter((e) => e.type === 'agent.session.end' && e.agent === 'builder-d1');
    return [r.ended === true && r.status === 'ended' && ends.length === 1, `agent.session.end events: ${ends.length} (${ends.map((e) => e.msg).join(' | ')}); ${JSON.stringify(r)}`];
  });

  // ---- B-72 / B-76: a watchdog stall end is a stall end ----
  await guard('2.73.2 (B-72, B-76): the watchdog\'s stall end of a running launcher\'s agent is recorded as a stall end (agent.session.end meta.exitCause.kind stall, by watchdog), once, with the record marked ended, so the "two sessions in a row ended with exit N" halt never counts it (fails on 2.73.1: exitCause signal/exit, which the halt rule counted, so two watchdog ends halted the builders)', async () => {
    const { S, ev, env } = studio('wd');
    const lenv = childEnv({ ...env, STUDIO_STALL: 'off', STUDIO_BUILDER_CMD: `node ${JSON.stringify(sleeper)} 40` });
    const st = spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'builder-w1', '--model', 'fake-1', '--detach'], { windowsHide: true, cwd: S, encoding: 'utf8', env: lenv, timeout: 60000 });
    const up = await waitFor(() => { const x = readRec(S, 'builder-w1'); return x?.pid && x.status === 'running' && !x.starting ? x : null; }, 20000);
    if (!up) return [false, `the launcher never started: ${out(st)}`];
    await sleep(1500);
    const r = probe(S, { ...env, STUDIO_STALL_MIN: '0.01' }, 'wd', `const { gamedevPass } = await import(${u(S, 'harness/gamedev-loop.mjs')});
const a = (await gamedevPass(Date.now())).map((x) => x.kind); await new Promise((r) => setTimeout(r, 1500));
const b = (await gamedevPass(Date.now())).map((x) => x.kind);
console.log(JSON.stringify({ a, b }));`);
    const done = await waitFor(() => readRec(S, 'builder-w1')?.status === 'ended', 30000);
    const ends = events(ev).filter((e) => e.type === 'agent.session.end' && e.agent === 'builder-w1');
    const stalls = events(ev).filter((e) => e.type === 'session.stall' && e.meta?.target === 'builder-w1');
    const c = ends[0]?.meta?.exitCause || {};
    return [done && ends.length === 1 && stalls.length === 1 && c.kind === 'stall' && c.by === 'watchdog', `ended ${done}; ${ends.length} end(s), ${stalls.length} stall(s); exitCause ${JSON.stringify(c)}; passes ${JSON.stringify(r)}`];
  });

  // ---- B-74 a: the launcher's heartbeat reloads .env ----
  await guard('2.73.2 (B-74): a running launcher picks up a stall limit changed in .env after it started: its next heartbeat ends the session on the new STUDIO_STALL_MIN; one env.reloaded event names the changed keys, never a secret\'s value, and an identity line added to .env is not loaded (fails on 2.73.1: .env was read once at start, so the session ran to its end on the old limit)', async () => {
    const { S, ev, env } = studio('reload', 'STUDIO_STALL_MIN=40\nHUB_TOKEN=old-secret-2732f-aaaa\n');
    const lenv = childEnv({ ...env, STUDIO_BUILDER_CMD: `node ${JSON.stringify(sleeper)} 25` });
    const st = spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'builder-r1', '--model', 'fake-1', '--detach'], { windowsHide: true, cwd: S, encoding: 'utf8', env: lenv, timeout: 60000 });
    const up = await waitFor(() => { const x = readRec(S, 'builder-r1'); return x?.pid && x.status === 'running' && !x.starting ? x : null; }, 20000);
    if (!up) return [false, `the launcher never started: ${out(st)}`];
    await sleep(2500);
    const f = path.join(S, '.env');
    fs.writeFileSync(f, 'STUDIO_STALL_MIN=0.02\nHUB_TOKEN=new-secret-2732f-bbbb\nSTUDIO_LOCK_OWNER=opus-x\n');
    const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
    const t0 = Date.now();
    const done = await waitFor(() => readRec(S, 'builder-r1')?.status === 'ended', 30000);
    const secs = Math.round((Date.now() - t0) / 1000);
    const all = events(ev);
    const rel = all.filter((e) => e.type === 'env.reloaded');
    const end = all.find((e) => e.type === 'agent.session.end' && e.agent === 'builder-r1');
    const stall = all.find((e) => e.type === 'session.stall' && e.meta?.target === 'builder-r1');
    const text = JSON.stringify(rel);
    const ok = done && secs < 20 && Boolean(stall) && end?.meta?.exitCause?.kind === 'stall' && rel.length === 1 && rel[0].meta?.keys?.includes('STUDIO_STALL_MIN') && rel[0].meta?.keys?.includes('HUB_TOKEN') && !rel[0].meta.keys.includes('STUDIO_LOCK_OWNER') && !/secret-2732f/.test(text) && /STUDIO_STALL_MIN 40 -> 0\.02/.test(rel[0].msg || '');
    return [ok, `ended ${done} ${secs} s after the edit; stall: ${stall?.msg || 'none'}; end: ${end?.msg || 'none'} ${JSON.stringify(end?.meta?.exitCause || null)}; env.reloaded: ${text.slice(0, 900)}`];
  });

  // ---- B-74 b: precedence, and the train daemon's pass ----
  await guard('2.73.2 (B-74): in a process started by one that loaded .env, a value it inherited from .env follows the file when .env changes, a value its starter set itself still wins, and a line removed from .env gives the default back; the train daemon\'s pass reads the new STUDIO_TRAIN_AUTO (fails on 2.73.1: the inherited values never changed and the daemon kept training)', async () => {
    const { S, env } = studio('prec', 'STUDIO_TRAIN_AUTO=on\nSTUDIO_TRAIN_MIN=3\nSTUDIO_TRAIN_WAIT_MIN=9\nSTUDIO_SCOUT_DAY=sun\n');
    const go = path.join(tmpRoot, `go-2732f-${process.pid}-${++n}`);
    const r = probe(S, env, 'prec', `import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
await import(${u(S, 'harness/event.mjs')});
const root = path.resolve('.');
const child = ${JSON.stringify(path.join(tmpRoot, `child-2732f-${process.pid}.mjs`))};
fs.writeFileSync(child, \`import fs from 'node:fs';
await import(${u(S, 'harness/event.mjs')});
const before = { min: process.env.STUDIO_TRAIN_MIN, wait: process.env.STUDIO_TRAIN_WAIT_MIN, auto: process.env.STUDIO_TRAIN_AUTO };
while (!fs.existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 100));
const { trainDaemonPass } = await import(${u(S, 'harness/train-daemon.mjs')});
const d = await trainDaemonPass({ root: process.cwd(), dryRun: true, auto: { on: true }, trainOn: true, queue: [], lock: null, running: null });
console.log(JSON.stringify({ before, after: { min: process.env.STUDIO_TRAIN_MIN ?? null, wait: process.env.STUDIO_TRAIN_WAIT_MIN ?? null, auto: process.env.STUDIO_TRAIN_AUTO ?? null, scout: process.env.STUDIO_SCOUT_DAY ?? null, role: process.env.STUDIO_ROLE ?? null }, why: d.why }));\`);
const p = spawn(process.execPath, [child], { windowsHide: true, cwd: root, env: { ...process.env, STUDIO_TRAIN_WAIT_MIN: '7' }, stdio: ['ignore', 'pipe', 'pipe'] });
let o = ''; let e = ''; p.stdout.on('data', (b) => { o += b; }); p.stderr.on('data', (b) => { e += b; });
await new Promise((r) => setTimeout(r, 1500));
const f = path.join(root, '.env');
fs.writeFileSync(f, 'STUDIO_TRAIN_AUTO=off\\nSTUDIO_TRAIN_MIN=5\\nSTUDIO_TRAIN_WAIT_MIN=11\\nSTUDIO_ROLE=director\\n');
const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
fs.writeFileSync(${JSON.stringify(go)}, '1');
await new Promise((r) => p.on('exit', r));
console.log(o.trim().split('\\n').filter((x) => x.startsWith('{')).pop() || JSON.stringify({ err: e.slice(-1500) }));
`);
    const ok = r.before?.min === '3' && r.before?.wait === '7' && r.after?.min === '5' && r.after?.wait === '7' && r.after?.auto === 'off' && r.after?.scout === null && r.after?.role !== 'director' && /STUDIO_TRAIN_AUTO is off/.test(r.why || '');
    return [ok, JSON.stringify(r)];
  });

  // ---- B-74 c: npm run studio:reload-env ----
  await guard('2.73.2 (B-74): `npm run studio:reload-env` makes a running supervisor reload .env now (a changed value whose file kept its time and size is picked up only on request) and prints what changed (fails on 2.73.1: no such command)', async () => {
    const { S, ev, env } = studio('cli', 'STUDIO_STALL_MIN=15\n');
    const f = path.join(S, '.env');
    const stat0 = fs.statSync(f);
    const ready = path.join(tmpRoot, `ready-2732f-${process.pid}-${++n}`);
    const supCode = path.join(tmpRoot, `sup-2732f-${process.pid}-${n}.mjs`);
    fs.writeFileSync(supCode, `import fs from 'node:fs'; import path from 'node:path';
await import(${u(S, 'harness/event.mjs')});
const m = await import(${u(S, 'harness/env-reload.mjs')});
fs.writeFileSync(path.join(process.cwd(), '.studio', 'supervisor.json'), JSON.stringify({ pid: process.pid, status: 'running', startedAt: new Date().toISOString() }));
m.watchReloadRequests({ by: 'supervisor', intervalMs: 200 });
fs.writeFileSync(${JSON.stringify(ready)}, '1');
setTimeout(() => { console.log(JSON.stringify({ stall: process.env.STUDIO_STALL_MIN })); process.exit(0); }, 6000);
setInterval(() => {}, 1000);`);
    const { spawn } = await import('node:child_process');
    const sup = spawn(process.execPath, [supCode], { windowsHide: true, cwd: S, env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let so = ''; sup.stdout.on('data', (b) => { so += b; }); sup.stderr.on('data', (b) => { so += b; });
    if (!(await waitFor(() => fs.existsSync(ready), 15000))) { sup.kill(); return [false, `the stand-in supervisor never started: ${so}`]; }
    fs.writeFileSync(f, 'STUDIO_STALL_MIN=40\n'); fs.utimesSync(f, stat0.atime, stat0.mtime);
    const cli = spawnSync(process.execPath, ['harness/env-reload.mjs', '--by', 'tester'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout: 30000 });
    await new Promise((r) => sup.on('exit', r));
    const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8'));
    const rel = events(ev).filter((e) => e.type === 'env.reloaded');
    const ok = cli.status === 0 && /reloaded \.env: STUDIO_STALL_MIN 15 -> 40/.test(out(cli)) && /"stall":"40"/.test(so) && rel.length === 1 && rel[0].meta?.asked?.by === 'tester' && pkg.scripts?.['studio:reload-env'] === 'node harness/env-reload.mjs';
    return [ok, `cli: ${out(cli).slice(-600)}\nsupervisor: ${so.slice(-400)}\nevents: ${JSON.stringify(rel).slice(0, 400)}`];
  });
}
