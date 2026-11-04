/**
 * qa/selftest-2771c.mjs — 2.77.1 (helper c): three small issues from the crew's Windows PC.
 *   M1 (B-101)  the War Room machine tile divided ALL used RAM by the running sessions ("10.2 GB per session, room for 0
 *               more, Limit: RAM" at 20.4 GB used and 2 sessions), counting the OS, browsers and Unity editors. Now
 *               (used now - used at the last idle sample) / sessions, "average incl. other apps" without a baseline,
 *               room-for-N from the scheduler's own per-session figure (STUDIO_SESSION_RAM_GB, 0.6), the sample's age.
 *   M4          `npm run comm -- test` (and `report -- post`) called process.exit() with fetch's socket still closing: on
 *               Windows node printed "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... win\async.c, line 76".
 *               Now process.exitCode and a drained loop. UNTESTED ON WINDOWS: the libuv assertion itself; here the check is
 *               that process.exit is never called on the post path, the code is right and the command ends promptly.
 *   M5          studio:boot trusted "supervisor.json running + the pid exists"; the OS reuses pids, so another program on
 *               the dead supervisor's number made boot say "running" and start nothing. Now the pid is asked what program
 *               it is (start time against the record) and the stale sweep marks the old record stopped.
 *               UNTESTED ON WINDOWS: the PowerShell start-time query (readStarts) itself; here Linux /proc answers it.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2771C({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_REHEARSAL: '', STUDIO_WORKTREES: '', STUDIO_LANELESS: '', STUDIO_SESSION_RAM_GB: '', STUDIO_RAM_FLOOR_GB: '', STUDIO_SUPERVISOR_SEC: '',
    STUDIO_PROC_IDENTITY_STUB: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2771c-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `2771c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2771c.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-2771c-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const want = (k) => !process.env.ONLY_2771C || process.env.ONLY_2771C.split(',').includes(k);

  // ---- M1: the machine tile ----
  const m1Code = (S) => `import fs from 'node:fs'; import path from 'node:path';
import { machineTiles } from ${u(S, 'harness/war-room.mjs')};
const root = process.cwd();
const now = Date.parse('2026-11-05T12:00:00.000Z');
const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const put = (usedGb, minAgo) => { fs.mkdirSync(path.join(root, '.studio'), { recursive: true }); fs.writeFileSync(path.join(root, '.studio', 'machine.json'), JSON.stringify({ at: at(minAgo), os: 'win32', ram: { totalGb: 32, freeGb: Math.round((32 - usedGb) * 10) / 10 }, cpu: { busy: 0.3 }, gpus: [], disk: { freeGb: 100 } })); };
const base = process.env.M1_MODE === 'nobase' ? null : (put(8, 12), machineTiles({ root, sessions: 0, env: process.env, now }));
put(20.4, 3);
const t = machineTiles({ root, sessions: 2, env: process.env, now });
console.log(JSON.stringify({ base: base && base.ram, t }));
`;
  if (want('m1')) await guard('2.77.1 (B-101): with an idle sample as baseline the tile shows (used now - baseline) / sessions ("per session": 20.4 GB used, 8 GB idle, 2 sessions = 6.2 GB), the sample age ("sampled 3 min ago") and the baseline (fails on 2.77.0: 10.2 GB "per session", no age, no baseline)', async () => {
    const { S, env } = studio('m1a');
    const r = probe(S, env, 'm1a', m1Code(S));
    const t = r.t || {};
    const ok = t.ram?.usedGb === 20.4 && t.ram.perSessionGb === 6.2 && t.ram.perSessionLabel === 'per session' && t.ram.baselineGb === 8 && t.sampleAgeMin === 3 && t.sampleAgeText === 'sampled 3 min ago';
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });
  if (want('m1')) await guard('2.77.1 (B-101): without a baseline the figure is labelled "average incl. other apps" (10.2 GB = 20.4 / 2), never "per session" (fails on 2.77.0: no label at all)', async () => {
    const { S, env } = studio('m1b');
    const r = probe(S, { ...env, M1_MODE: 'nobase' }, 'm1b', m1Code(S));
    const t = r.t || {};
    return [t.ram?.perSessionGb === 10.2 && t.ram.perSessionLabel === 'average incl. other apps' && t.ram.baselineGb === null && t.sampleAgeText === 'sampled 3 min ago', JSON.stringify(r).slice(0, 1500)];
  });
  if (want('m1')) await guard('2.77.1 (B-101): room for N more is the scheduler\'s rule (free - 3 GB floor) / STUDIO_SESSION_RAM_GB (0.6 default, as heavy-budget.mjs sessionCap): 11.6 GB free = 14 more, no "Limit: RAM"; with 2 GB a session = 4 more (fails on 2.77.0: "room for 0", Limit: RAM, from 10.2 GB per session)', async () => {
    const { S, env } = studio('m1c');
    const a = probe(S, env, 'm1c', m1Code(S)).t || {};
    const { S: S2, env: env2 } = studio('m1d');
    const b = probe(S2, { ...env2, STUDIO_SESSION_RAM_GB: '2' }, 'm1d', m1Code(S2)).t || {};
    // the same figure sessionCap uses
    const hb = probe(S, env, 'm1e', `import { sessionRamGb } from ${u(S, 'harness/heavy-budget.mjs')}; console.log(JSON.stringify({ per: sessionRamGb({ env: process.env, root: process.cwd() }) }));`);
    const ok = a.ram?.roomForMore === 14 && a.limit === null && a.ram.schedulerPerSessionGb === 0.6 && hb.per === 0.6 && b.ram?.roomForMore === 4 && b.ram.schedulerPerSessionGb === 2;
    return [ok, JSON.stringify({ a: a.ram, alimit: a.limit, b: b.ram, hb })];
  });

  // ---- M4: the post CLIs exit by exitCode, not process.exit ----
  const cliRun = async (S, script, args, env) => {
    const hits = [];
    const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hits.push(b.length); res.writeHead(204); res.end(); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const marker = path.join(tmpRoot, `exit-marker-2771c-${process.pid}-${++n}.txt`);
    const pre = path.join(tmpRoot, `exit-spy-2771c-${process.pid}-${n}.mjs`);
    fs.writeFileSync(pre, `import fs from 'node:fs'; const real = process.exit; process.exit = (c) => { try { fs.appendFileSync(${JSON.stringify(marker)}, 'process.exit(' + c + ')\\n'); } catch {} return real.call(process, c); };\n`);
    const url = `http://127.0.0.1:${srv.address().port}/hook`;
    const t0 = Date.now();
    const res = await new Promise((resolve) => {
      const c = spawn(process.execPath, ['--import', pathToFileURL(pre).href, path.join(S, script), ...args], { cwd: S, windowsHide: true, env: { ...process.env, ...env, STUDIO_COMM_WEBHOOK: url, STUDIO_REPORT_WEBHOOK: url, STUDIO_REPORT_FORMAT: 'json' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = '';
      c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { so += d; });
      const kill = setTimeout(() => { try { c.kill(); } catch {} }, 20000);
      c.on('close', (code) => { clearTimeout(kill); resolve({ code, so }); });
    });
    const ms = Date.now() - t0;
    const exitCalls = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    await new Promise((r) => srv.close(r));
    fs.rmSync(marker, { force: true }); fs.rmSync(pre, { force: true });
    return { ...res, ms, hits: hits.length, exitCalls };
  };
  if (want('m4')) await guard('2.77.1 (M4): `comm -- test` posts and ends with exit code 0 without calling process.exit while the fetch socket is open, and ends promptly (<10 s); UNTESTED ON WINDOWS (the libuv assertion), checked here: no process.exit call (fails on 2.77.0: process.exit(0) is called right after the post)', async () => {
    const { S, env } = studio('m4a');
    const r = await cliRun(S, 'harness/communicator.mjs', ['test'], env);
    return [r.code === 0 && r.hits === 1 && r.exitCalls === '' && /posted the test line/.test(r.so) && r.ms < 10000, JSON.stringify({ code: r.code, hits: r.hits, exitCalls: r.exitCalls, ms: r.ms, so: r.so.slice(-600) })];
  });
  if (want('m4')) await guard('2.77.1 (M4): `report -- post` has the same exit: posted, code 0, no process.exit call, prompt; UNTESTED ON WINDOWS (fails on 2.77.0: process.exit(0) after the post)', async () => {
    const { S, env } = studio('m4b');
    const r = await cliRun(S, 'harness/report-post.mjs', ['post', '--what', 'next'], env);
    return [r.code === 0 && r.hits >= 1 && r.exitCalls === '' && /posted the next report/.test(r.so) && r.ms < 15000, JSON.stringify({ code: r.code, hits: r.hits, exitCalls: r.exitCalls, ms: r.ms, so: r.so.slice(-600) })];
  });
  if (want('m4')) await guard('2.77.1 (M4): a failing post still ends with exit code 1 and a message, no process.exit call (webhook refuses the connection) (fails on 2.77.0: process.exit(1) is called)', async () => {
    const { S, env } = studio('m4c');
    // a port nothing listens on: the connection is refused at once
    const tmp = http.createServer();
    await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
    const closedPort = tmp.address().port;
    await new Promise((r) => tmp.close(r));
    const hook = `http://127.0.0.1:${closedPort}/hook`;
    const pre = path.join(tmpRoot, `exit-spy-2771c-fail-${process.pid}-${++n}.mjs`);
    const marker = path.join(tmpRoot, `exit-marker-2771c-fail-${process.pid}-${n}.txt`);
    fs.writeFileSync(pre, `import fs from 'node:fs'; const real = process.exit; process.exit = (c) => { try { fs.appendFileSync(${JSON.stringify(marker)}, 'process.exit(' + c + ')\\n'); } catch {} return real.call(process, c); };\n`);
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, path.join(S, 'harness', 'communicator.mjs'), 'test'], { cwd: S, windowsHide: true, encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env, STUDIO_COMM_WEBHOOK: hook } });
    const exitCalls = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '';
    fs.rmSync(pre, { force: true }); fs.rmSync(marker, { force: true });
    return [r.status === 1 && exitCalls === '' && /not posted/.test(out(r)), JSON.stringify({ status: r.status, exitCalls, o: out(r).slice(-500) })];
  });
  if (want('m4')) await guard('2.77.1 (M4): exitWhenDrained sets exitCode, calls exit only after its grace and only if the loop is still alive; its timer is unreffed so a drained loop never reaches it (unit; fails on 2.77.0: harness/exit-drain.mjs does not exist)', async () => {
    const { S, env } = studio('m4d');
    const r = probe(S, env, 'm4d', `import { exitWhenDrained } from ${u(S, 'harness/exit-drain.mjs')};
const calls = [];
const fake = { exitCode: undefined };
const t = exitWhenDrained(3, { graceMs: 30, exit: (c) => calls.push(c), proc: fake });
const early = calls.length;
await new Promise((res) => setTimeout(res, 120));
const keepAlive = setInterval(() => {}, 1000); // a stuck handle: the timer is the last resort
const calls2 = [];
exitWhenDrained(7, { graceMs: 30, exit: (c) => calls2.push(c), proc: fake });
await new Promise((res) => setTimeout(res, 120));
clearInterval(keepAlive);
console.log(JSON.stringify({ early, exitCode: fake.exitCode, fired: calls, fired2: calls2, unref: typeof t.hasRef === 'function' ? t.hasRef() : null }));`);
    return [r.early === 0 && Array.isArray(r.fired) && r.fired[0] === 3 && r.exitCode === 7 && Array.isArray(r.fired2) && r.fired2[0] === 7 && r.unref === false, JSON.stringify(r)];
  });

  // ---- M5: studio:boot starts the supervisor when the recorded one isn't really alive ----
  const m5Code = (S) => `import fs from 'node:fs'; import path from 'node:path';
import * as boot from ${u(S, 'harness/boot.mjs')};
const { startDaemons, staleSweep } = boot;
import { selfIdentity } from ${u(S, 'harness/proc-identity.mjs')};
const root = process.cwd();
const sf = path.join(root, '.studio', 'supervisor.json');
const mode = process.env.M5_MODE;
const pid = Number(process.env.M5_PID) || 0;
const iso = (ms) => new Date(ms).toISOString();
const rec = { status: 'running', pid, startedAt: iso(Date.now() - 3600000), lastLoop: iso(Date.now() - (mode === 'recent' ? 20000 : 3600000)), sessions: 0, tasksDone: 0 };
if (mode === 'dead' || mode === 'reused') rec.identity = { start: Date.now() - 3600000, self: true };
if (mode === 'real' || mode === 'recent') { rec.pid = process.pid; rec.identity = selfIdentity(); }
fs.mkdirSync(path.dirname(sf), { recursive: true });
fs.writeFileSync(sf, JSON.stringify(rec, null, 2));
const calls = [];
const start = (r, script, args, log) => { calls.push({ script, args }); return 424242; };
const sweep = staleSweep({ root, dry: false, emit: () => {} });
const d = await startDaemons({ root, env: { HUB_PORT: '1' }, argv: ['--no-hub'], up: async () => false, start, waitMs: 0, emit: () => {} });
console.log(JSON.stringify({ mode, calls, sup: d.supervisor, sweep: sweep.map((s) => ({ file: s.file, action: s.action })), after: JSON.parse(fs.readFileSync(sf, 'utf8')).status, aliveNow: boot.supervisorAlive ? boot.supervisorAlive(JSON.parse(fs.readFileSync(sf, 'utf8'))) : null }));
`;
  const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { windowsHide: true, encoding: 'utf8' }); return Number(r.stdout); };
  const heldPid = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  const supStarts = (r) => (r.calls || []).filter((c) => /supervisor\.mjs$/.test(c.script));
  if (want('m5')) await guard('2.77.1 (M5): supervisor.json "running" with a dead pid: the stale record is marked stopped and boot starts a supervisor (--foreground) (also true on 2.77.0: a regression guard)', async () => {
    const { S, env } = studio('m5a');
    const r = probe(S, { ...env, M5_MODE: 'dead', M5_PID: String(deadPid()) }, 'm5a', m5Code(S));
    return [supStarts(r).length === 1 && supStarts(r)[0].args.includes('--foreground') && r.sup?.state === 'started' && r.after === 'stopped', JSON.stringify(r)];
  });
  if (want('m5')) await guard('2.77.1 (M5): supervisor.json "running" whose pid now belongs to ANOTHER program (a reused pid; start time differs from the record): boot marks the record stopped and starts a supervisor (fails on 2.77.0: boot says "running", starts nothing, and a supervisor started anyway refuses as "already running")', async () => {
    const { S, env } = studio('m5b');
    const c = heldPid();
    try {
      await new Promise((res) => setTimeout(res, 300)); // let it exist (a process, not a timing assumption on its work)
      const r = probe(S, { ...env, M5_MODE: 'reused', M5_PID: String(c.pid) }, 'm5b', m5Code(S));
      return [supStarts(r).length === 1 && r.sup?.state === 'started' && r.after === 'stopped' && r.aliveNow === false && (r.sweep || []).some((s) => /supervisor\.json/.test(s.file) && s.action === 'cleared'), JSON.stringify(r)];
    } finally { try { c.kill(); } catch {} }
  });
  if (want('m5')) await guard('2.77.1 (M5): a supervisor that really runs (its own pid and start time on record, loop recent) is left alone: boot says running and starts nothing (over-fix guard; also true on 2.77.0)', async () => {
    const { S, env } = studio('m5c');
    const r = probe(S, { ...env, M5_MODE: 'real' }, 'm5c', m5Code(S));
    return [supStarts(r).length === 0 && r.sup?.state === 'running' && r.after === 'running', JSON.stringify(r)];
  });
  if (want('m5')) await guard('2.77.1 (M5): when the OS cannot say what the process is, a stale last loop (1 h) means not running and a recent one (20 s) means running (supervisorAlive with an unreadable query; fails on 2.77.0: no supervisorAlive)', async () => {
    const { S, env } = studio('m5d');
    const r = probe(S, env, 'm5d', `import * as boot from ${u(S, 'harness/boot.mjs')};
const supervisorAlive = boot.supervisorAlive;
const now = Date.now(); const iso = (ms) => new Date(now - ms).toISOString();
const unreadable = () => new Map([[77, { error: 'timeout' }]]);
const mk = (loopAgo) => ({ status: 'running', pid: 77, identity: { start: now - 7200000, self: true }, lastLoop: iso(loopAgo) });
const opts = { alive: () => true, starts: unreadable, now, env: {} };
console.log(JSON.stringify({ stale: supervisorAlive(mk(3600000), opts), fresh: supervisorAlive(mk(20000), opts), stopped: supervisorAlive({ ...mk(1000), status: 'stopped' }, opts) }));`);
    return [r.stale === false && r.fresh === true && r.stopped === false, JSON.stringify(r)];
  });
}
