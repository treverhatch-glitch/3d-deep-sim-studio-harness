/**
 * qa/selftest-286a.mjs — 2.86 (a, B-139): new harness code takes effect after an upgrade.
 *
 *   1  the code stamp: the installed version and HEAD (read from .git without git), the harness/ tree; a board-only commit
 *      is not new code
 *   2  a supervisor on old code says so once and hands over to exactly one successor with the same options; its halt, end
 *      time and agents carry over; a running session's record is untouched and still running; never two at once
 *   3  with STUDIO_SUPERVISOR_SELF_RESTART=off (or in a terminal, or an old systemd unit) it warns once and keeps running
 *   4  `upgrade --merge` with a board writer running commits the board itself through the hooks (stamped, accepted by the
 *      hooks gate) under the board lock, and ends naming the supervisor still on the old code
 *   5  `npm run harness-health` and `npm run studio:status` show "supervisor runs <old>, installed <new>"
 *
 * Stand-ins for every spawn of a supervisor; no real waits (injected clocks and alive checks). No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest286A({ dir, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, Boolean(ok), ok ? '' : String(d || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX|INVOCATION_ID$|XPC_SERVICE_NAME$)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData']) if (process.env[k]) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_UPGRADE_REFRESH: 'off',
    STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_HEALTH_CI: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-286a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  let n = 0;
  const studio = (name, { git = true } = {}) => {
    const S = path.join(tmpRoot, `286a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.writeFileSync(path.join(S, '.env'), '');
    const ev = path.join(S, '.studio', 'events-286a.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify'); }
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-286a-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-2000) }; } catch { return { _raw: out(r).slice(-3000) }; }
  };
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 180000 });
  // A process this test starts and ends itself: it stands for a running agent session or supervisor.
  const sleepers = [];
  const sleeper = () => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true }); sleepers.push(c); return c.pid; };

  try {
    // ================= 1. the code stamp =================
    {
      const R = path.join(tmpRoot, `286a-stamp-${process.pid}-${++n}`);
      const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), text); };
      const commit = (msg) => { g(R, 'add', '-A'); g(R, 'commit', '-qm', msg, '--no-verify'); return g(R, 'rev-parse', 'HEAD').stdout.trim(); };
      fs.mkdirSync(R, { recursive: true });
      g(R, 'init', '-q', '-b', 'main');
      put('package.json', '{ "name": "studio", "version": "1.0.0" }\n'); put('harness/x.mjs', 'export const x = 1;\n'); put('studio/NEXT.md', '# board\n');
      const c0 = commit('base');
      g(R, 'pack-refs', '--all'); // HEAD's branch read from packed-refs too
      const W = path.join(tmpRoot, `286a-stamp-wt-${process.pid}-${n}`);
      g(R, 'worktree', 'add', '-q', '-b', 'side', W);
      const r = probe(R, base, `import * as cs from ${u(dir, 'harness/code-stamp.mjs')};
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const root = process.cwd(); const r = {}; let gitCalls = 0;
const git = (cwd, args) => { gitCalls += 1; const x = spawnSync('git', args, { cwd, encoding: 'utf8' }); return x.status === 0 ? x.stdout.trim() : ''; };
const commit = (msg) => { spawnSync('git', ['add', '-A'], { cwd: root }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', msg, '--no-verify'], { cwd: root }); };
let t = 1000000;
r.a = cs.codeStamp({ root, now: t, git });
r.headOk = r.a.head === ${JSON.stringify(c0)};
r.wtHead = cs.readHead(${JSON.stringify(W)}) === ${JSON.stringify(c0)};
const calls0 = gitCalls; r.cached = cs.codeStamp({ root, now: t + 30000, git }) === r.a && gitCalls === calls0;
fs.writeFileSync(path.join(root, 'studio', 'NEXT.md'), '# board\\n- a row\\n'); commit('board: a row');
r.b = cs.codeStamp({ root, now: t += 61000, git });
fs.writeFileSync(path.join(root, 'harness', 'x.mjs'), 'export const x = 2;\\n'); commit('harness: x is 2');
r.c = cs.codeStamp({ root, now: t += 61000, git });
const callsC = gitCalls; r.d = cs.codeStamp({ root, now: t += 61000, git }); r.noGitSameHead = gitCalls === callsC;
fs.writeFileSync(path.join(root, 'package.json'), '{ "name": "studio", "version": "1.1.0" }\\n'); commit('1.1.0');
r.e = cs.codeStamp({ root, now: t += 61000, git });
r.boardOnly = cs.sameCode(r.a, r.b); r.harnessMoved = cs.sameCode(r.b, r.c); r.versionMoved = cs.sameCode(r.c, r.e);
r.words = cs.stampWords(r.e);
console.log(JSON.stringify(r));`);
      await guard('2.86 (a1): the code stamp is package.json\'s version + HEAD (read from the .git files, a packed ref and a worktree\'s too, cached a minute, git run only when HEAD moved) + the harness/ tree; a HEAD that moved with a board-only commit is the same code, a harness/ change or a new version is not (fails before this fix: no code stamp existed, so nothing could tell a long-running process ran old code)', () => [
        r.headOk && r.wtHead && r.cached && r.noGitSameHead && r.a?.version === '1.0.0' && r.b.head !== r.a.head && r.boardOnly === true && r.harnessMoved === false && r.versionMoved === false
          && r.e?.version === '1.1.0' && /^1\.1\.0 \([0-9a-f]{8}\)$/.test(r.words || ''),
        JSON.stringify(r).slice(0, 2500)]);
    }

    // ================= 2. a supervisor on old code restarts itself, once, keeping its state and the sessions =================
    {
      const { S, env, ev } = studio('restart', { git: false });
      const agentPid = sleeper();
      const r = probe(S, { ...env, SLEEPER: String(agentPid) }, `import fs from 'node:fs'; import path from 'node:path';
import * as sup from ${u(S, 'harness/supervisor.mjs')};
import * as cs from ${u(S, 'harness/code-stamp.mjs')};
import { sessions } from ${u(S, 'harness/agent.mjs')};
const root = process.cwd(); const stateDir = path.join(root, '.studio'); const r = {};
const pid = Number(process.env.SLEEPER);
fs.mkdirSync(path.join(stateDir, 'agents'), { recursive: true });
const rec = JSON.stringify({ agent: 'builder-s1', role: 'builder', task: 'T-1', status: 'running', pid, supervisor: pid, startedAt: new Date().toISOString(), lastBeat: new Date().toISOString() }, null, 2);
fs.writeFileSync(path.join(stateDir, 'agents', 'builder-s1.json'), rec);
const old = { version: '2.85.0', head: 'a'.repeat(40), harness: 'b'.repeat(40) };
const installed = { version: '2.86.0', head: 'c'.repeat(40), harness: 'd'.repeat(40) };
const t0 = Date.parse('2026-11-14T10:00:00Z');
const state = { pid: 111, startedAt: t0, code: old, opts: { until: '2026-11-15T08:00:00.000Z', window: null, budget: null, lanes: 'auto' }, halted: { why: 'two sessions in a row ended with exit 1' }, extended: { by: 'Dana', to: '2026-11-15T08:00:00.000Z' }, names: ['builder-s1'], roleBackoff: { reviewer: { count: 2, until: t0 + 600000 } } };
const evs = []; const spawned = []; const logs = [];
const spawnFn = (cmd, args, o) => { spawned.push({ cmd, args, detached: o.detached }); return { pid: 4242, on() {}, unref() {} }; };
const how = cs.restartHow({ env: {}, tty: false, root });
const argv = ['--until', '23:00', '--lanes', 'auto', '--after', '99'];
r.p1 = sup.codeChangePass(state, { installed, how, argv, idle: false, pid: 111, stateDir, emit: (e) => evs.push(e), log: (l) => logs.push(l), spawnFn, now: t0 + 60000 });
r.p2 = sup.codeChangePass(state, { installed, how, argv, idle: true, pid: 111, stateDir, emit: (e) => evs.push(e), log: (l) => logs.push(l), spawnFn, now: t0 + 120000 });
r.how = how.how; r.events = evs.map((e) => e.type); r.eventMeta = evs[0]?.meta; r.spawned = spawned;
r.handoffFile = fs.existsSync(path.join(stateDir, cs.HANDOFF_FILE));
// The successor: waits for its predecessor to end (never two at once), then takes the handed-off state.
let ticks = 0; const clock = () => ticks * 250;
r.waited = await cs.waitGone(111, { alive: () => ticks < 3, sleep: async () => { ticks += 1; }, now: clock });
ticks = 0; r.neverTwo = await cs.waitGone(111, { alive: () => true, timeoutMs: 1000, sleep: async () => { ticks += 1; }, now: clock });
r.notWhileAlive = cs.takeHandoff(stateDir, { alive: () => true, now: t0 + 130000 });
const h = cs.takeHandoff(stateDir, { alive: () => false, now: t0 + 130000 });
r.handoff = h ? { from: h.from, until: h.opts?.until, halted: h.state?.halted?.why, names: h.state?.names, extended: h.state?.extended?.by, reviewer: h.state?.roleBackoff?.reviewer?.count, haltCheckFrom: h.state?.haltCheckFrom } : null;
r.takenOnce = cs.takeHandoff(stateDir, { alive: () => false, now: t0 + 131000 }) === null;
r.sessionSame = fs.readFileSync(path.join(stateDir, 'agents', 'builder-s1.json'), 'utf8') === rec;
r.sessionRunning = sessions().filter((s) => s.agent === 'builder-s1').map((s) => s.running);
const exitHow = cs.restartHow({ env: { XPC_SERVICE_NAME: 'com.studio.x' }, root });
const st2 = { code: old, startedAt: t0 };
r.exit = sup.codeChangePass(st2, { installed, how: exitHow, argv: [], idle: true, pid: 112, stateDir, emit: () => {}, log: () => {}, spawnFn });
r.mainWired = /codeChangePass\\(state, \\{ installed: codeStamp/.test(fs.readFileSync(${JSON.stringify(path.join(S, 'harness', 'supervisor.mjs'))}, 'utf8')) && /takeHandoff\\(STUDIO_STATE_DIR/.test(fs.readFileSync(${JSON.stringify(path.join(S, 'harness', 'supervisor.mjs'))}, 'utf8'));
console.log(JSON.stringify(r));`);
      const args = r.spawned?.[0]?.args || [];
      await guard('2.86 (a2): a supervisor whose code is older than the installed harness emits harness.code_changed ONCE (with both versions), waits while a step of its pass still runs, then starts exactly ONE detached successor with the same options (--until, --lanes) plus --foreground --after <its pid>; under launchd it exits 75 for the service manager instead (fails before this fix: the supervisor never looked at the installed code and ran 2.84 for 20 h after the update)', () => [
        r.how === 'spawn' && r.p1?.pending === true && r.p1.restart === null && r.p2?.restart === 'spawn' && r.p2.successor === 4242 && r.events?.length === 1 && r.events[0] === 'harness.code_changed'
          && r.eventMeta?.from?.version === '2.85.0' && r.eventMeta?.to?.version === '2.86.0' && r.spawned.length === 1 && r.spawned[0].detached === true
          && /supervisor\.mjs$/.test(args[0] || '') && args.slice(1).join(' ') === '--until 23:00 --lanes auto --foreground --after 111'
          && r.exit?.restart === 'exit' && r.exit.exitCode === 75 && r.mainWired === true,
        JSON.stringify(r).slice(0, 2500)]);
      await guard('2.86 (a2): the successor never runs beside its predecessor (it waits for that pid to end, and gives up rather than start a second), and takes the predecessor\'s halt, extended end time, the agents it started and its role back-off once; a running agent session\'s record is not touched and the launcher still reads it as running (fails before this fix: there was no hand-over, so a restart lost the halt and the extended end time)', () => [
        r.waited === true && r.neverTwo === false && r.notWhileAlive === null && r.handoff?.from === 111 && r.handoff.until === '2026-11-15T08:00:00.000Z' && /exit 1/.test(r.handoff.halted || '')
          && r.handoff.names?.[0] === 'builder-s1' && r.handoff.extended === 'Dana' && r.handoff.reviewer === 2 && r.handoff.haltCheckFrom === Date.parse('2026-11-14T10:00:00Z')
          && r.takenOnce === true && r.sessionSame === true && JSON.stringify(r.sessionRunning) === '[true]' && events(ev).length >= 0,
        JSON.stringify(r).slice(0, 2500)]);
    }

    // ================= 3. self-restart off, a terminal, an old systemd unit: warn once, keep running =================
    {
      const { S, env } = studio('warn', { git: false });
      const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as sup from ${u(S, 'harness/supervisor.mjs')};
import * as cs from ${u(S, 'harness/code-stamp.mjs')};
const root = process.cwd(); const stateDir = path.join(root, '.studio'); const r = {};
const old = { version: '2.85.0', head: 'a'.repeat(40), harness: 'b'.repeat(40) };
const installed = { version: '2.86.0', head: 'c'.repeat(40), harness: 'd'.repeat(40) };
const evs = []; const logs = []; let spawns = 0;
const spawnFn = () => { spawns += 1; return { pid: 1, on() {}, unref() {} }; };
const how = cs.restartHow({ env: { STUDIO_SUPERVISOR_SELF_RESTART: 'off' }, root });
const state = { code: old, startedAt: Date.now() };
r.passes = [1, 2, 3].map(() => sup.codeChangePass(state, { installed, how, argv: ['--until', '8h'], idle: true, pid: 77, stateDir, emit: (e) => evs.push(e), log: (l) => logs.push(l), spawnFn }).restart);
r.events = evs.map((e) => [e.type, e.status]); r.logs = logs; r.spawns = spawns; r.handoff = fs.existsSync(path.join(stateDir, cs.HANDOFF_FILE));
r.tty = cs.restartHow({ env: {}, tty: true, root });
r.oldUnit = cs.restartHow({ env: { INVOCATION_ID: 'x' }, unitText: '[Service]\\nRestart=on-failure\\n', root });
r.newUnit = cs.restartHow({ env: { INVOCATION_ID: 'x' }, unitText: '[Service]\\nRestart=on-failure\\nKillMode=process\\n', root });
r.unitWrites = /KillMode=process/.test(fs.readFileSync(path.join(root, 'harness', 'supervisor.mjs'), 'utf8'));
console.log(JSON.stringify(r));`);
      await guard('2.86 (a3): with STUDIO_SUPERVISOR_SELF_RESTART=off the supervisor on old code warns ONCE (one harness.code_changed, status warn, one loud console block naming the restart command) over three passes, starts nothing and keeps running; in a terminal a person watches, or as a systemd unit without KillMode=process (its stop would end every session), it also only warns; a unit with KillMode=process (now written by --install) restarts by exit (fails before this fix: nothing warned at all)', () => [
        JSON.stringify(r.passes) === '[null,null,null]' && r.events?.length === 1 && r.events[0][0] === 'harness.code_changed' && r.events[0][1] === 'warn'
          && r.logs.length === 1 && /OLD HARNESS CODE/.test(r.logs[0]) && /npm run studio:stop, then npm run studio:start/.test(r.logs[0]) && r.spawns === 0 && r.handoff === false
          && r.tty?.how === null && /terminal/.test(r.tty.why) && r.oldUnit?.how === null && /systemd/.test(r.oldUnit.why) && r.newUnit?.how === 'exit' && r.unitWrites === true,
        JSON.stringify(r).slice(0, 2500)]);
    }

    // ================= 4. upgrade --merge: the board committed through the hooks under the lock; the end report =================
    {
      const { S, env, ev } = studio('upgrade');
      g(S, 'config', 'core.hooksPath', 'scripts/hooks');
      // The update: a harness change and a new version, on a branch (the "remote" ref).
      g(S, 'checkout', '-q', '-b', 'release');
      fs.writeFileSync(path.join(S, 'harness', 'zz-286a-update.mjs'), 'export const updated = true;\n');
      const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8'));
      const fromVersion = pkg.version;
      fs.writeFileSync(path.join(S, 'package.json'), `${JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2)}\n`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'release 9.9.9', '--no-verify');
      g(S, 'checkout', '-q', 'main');
      // A supervisor started before the update (its code stamped), and a running agent session.
      const supPid = sleeper();
      const agentPid = sleeper();
      const pre = probe(S, env, `import * as cs from ${u(S, 'harness/code-stamp.mjs')}; console.log(JSON.stringify(cs.codeStamp({ root: process.cwd(), fresh: true })));`);
      fs.writeFileSync(path.join(S, '.studio', 'supervisor.json'), JSON.stringify({ pid: supPid, status: 'running', startedAt: new Date(Date.now() - 3600000).toISOString(), code: { version: pre.version, head: pre.head, harness: pre.harness }, restart: { how: 'spawn', why: 'it runs on its own' } }));
      fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(S, '.studio', 'agents', 'builder-s9.json'), JSON.stringify({ agent: 'builder-s9', status: 'running', pid: agentPid, supervisor: agentPid, startedAt: new Date().toISOString() }));
      // A board row a running crew wrote, not committed yet.
      const next = path.join(S, 'studio', 'NEXT.md');
      const rowA = '- [ ] **T-901** [P1] (`builder`) — written by the crew before the upgrade';
      const rowB = '- [ ] **T-902** [P1] (`builder`) — written by the crew while the upgrade ran';
      fs.writeFileSync(next, fs.readFileSync(next, 'utf8').replace('## BACKLOG\n', `## BACKLOG\n${rowA}\n`));
      const writer = path.join(tmpRoot, `writer-286a-${process.pid}-${++n}.mjs`);
      const marker = path.join(tmpRoot, `writer-286a-${process.pid}-${n}.trying`);
      const done = path.join(tmpRoot, `writer-286a-${process.pid}-${n}.done`);
      fs.writeFileSync(writer, `import fs from 'node:fs';
import { withBoard } from ${u(S, 'harness/task.mjs')};
const f = ${JSON.stringify(next)};
fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now()));
withBoard(() => { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('## BACKLOG\\n', '## BACKLOG\\n' + ${JSON.stringify(rowB)} + '\\n')); fs.writeFileSync(${JSON.stringify(done)}, String(Date.now())); });`);
      const r = probe(S, { ...env, STUDIO_BOARD_LOCK_WAIT_MS: '120000' }, `import fs from 'node:fs'; import path from 'node:path'; import { spawn, spawnSync } from 'node:child_process';
import { upgradeMerge } from ${u(S, 'harness/upgrade-guard.mjs')};
const root = process.cwd(); const r = {};
let child = null;
// Inside the upgrade's locks: a board writer starts and tries to write (it must wait until the merge is committed).
const inLock = () => {
  child = spawn(process.execPath, [${JSON.stringify(writer)}], { cwd: root, stdio: 'ignore', windowsHide: true, env: process.env });
  const until = Date.now() + 30000;
  while (!fs.existsSync(${JSON.stringify(marker)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  r.writerTrying = fs.existsSync(${JSON.stringify(marker)});
};
const res = await upgradeMerge({ ref: 'release', by: 'Dana', root, deps: { inLock } });
r.ok = res.ok; r.lines = res.lines; r.boardCommits = res.boardCommits; r.oldCode = res.oldCode;
r.doneBeforeEnd = fs.existsSync(${JSON.stringify(done)});
await new Promise((ok) => { if (!child || child.exitCode !== null) ok(); else child.on('exit', ok); setTimeout(ok, 60000); });
const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout;
const bc = (res.boardCommits || [])[0];
r.boardMsg = bc ? git('log', '-1', '--format=%B', bc) : '';
r.boardParent = bc ? git('rev-parse', bc + '^').trim() : '';
r.mergeNext = git('show', 'HEAD:studio/NEXT.md');
r.mergeParents = git('log', '-1', '--format=%P', 'HEAD').trim().split(' ').length;
r.mergeHeadLeft = spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: root }).status === 0;
r.status = git('status', '--porcelain', '--untracked-files=no');
r.diff = git('diff', '-U0', '--', 'studio/NEXT.md').split('\\n').filter((l) => /^[+-]/.test(l) && !/^(\\+\\+\\+|---) /.test(l));
if (bc) {
  const hs = await import(${u(S, 'harness/hook-stamp.mjs')});
  const c = await hs.checkHookStamps({ env: { ...process.env, STUDIO_HOOKS_CHECK: 'on' }, range: { base: r.boardParent, head: bc } });
  r.gate = { ok: c.ok, open: (c.open || []).length, checked: c.checked, enforced: c.enforced };
}
console.log(JSON.stringify(r));`);
      const evs = events(ev);
      await guard('2.86 (a4): `upgrade --merge` with an uncommitted board row and a board writer running commits the board itself as "board: snapshot before harness upgrade" THROUGH the hooks (Studio-Hooks stamp; the hooks gate accepts it, no exemption), holding the board lock: the writer that tried during the merge waited until the merge was committed, its row is not in the merge, and the tree holds nothing else (no MERGE_HEAD, nothing staged) (fails before this fix: --merge refused a dirty board, and the overseer\'s retry loop had to commit it with --no-verify, turning the hooks gate red for every task)', () => [
        r.ok === true && r.writerTrying === true && r.doneBeforeEnd === true && r.boardCommits?.length === 1 && /^board: snapshot before harness upgrade to 9\.9\.9/.test(r.boardMsg || '')
          && /^Studio-Hooks: /m.test(r.boardMsg) && !/^Studio-Harness:/m.test(r.boardMsg) && r.gate?.ok === true && r.gate.open === 0 && r.gate.enforced === true
          && r.mergeNext.includes('T-901') && !r.mergeNext.includes('T-902') && r.mergeParents === 2 && r.mergeHeadLeft === false
          && r.status.trim() === 'M studio/NEXT.md' && r.diff.length === 1 && r.diff[0].includes('T-902'),
        JSON.stringify({ gate: r.gate, status: r.status, diff: r.diff, parents: r.mergeParents, mergeHead: r.mergeHeadLeft, trying: r.writerTrying, done: r.doneBeforeEnd, boardCommits: r.boardCommits }).slice(0, 3000) + (r._raw || '')]);
      const words = (r.lines || []).join('\n');
      await guard('2.86 (a4): the upgrade ends by naming the supervisor still on the old code and what will happen ("supervisor runs <old>, installed 9.9.9: it restarts itself at its next pass"), says the running agent session keeps its old code until it ends and that this is fine, and emits one upgrade.old_code event (fails before this fix: the upgrade said nothing about running processes)', () => [
        new RegExp(`still on the old code: supervisor runs ${fromVersion.replace(/\./g, '\\.')} \\([0-9a-f]{8}\\), installed 9\\.9\\.9 \\([0-9a-f]{8}\\): it restarts itself at its next pass`).test(words)
          && /1 agent session\(s\) \(builder-s9\) keep running on the code they started with until they end; nothing of theirs was stopped or changed, and that is fine/.test(words)
          && evs.filter((e) => e.type === 'upgrade.old_code').length === 1 && r.oldCode?.[0]?.name === 'supervisor',
        words.slice(-2500)]);
    }

    // ================= 5. health and studio:status show the mismatch =================
    {
      const { S, env } = studio('health');
      const supPid = sleeper();
      const ver = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')).version;
      fs.writeFileSync(path.join(S, '.studio', 'supervisor.json'), JSON.stringify({ pid: supPid, status: 'running', startedAt: new Date().toISOString(), sessions: 0, tasksDone: 0, code: { version: '2.84.0', head: 'a'.repeat(40), harness: 'b'.repeat(40) }, restart: { how: null, why: 'STUDIO_SUPERVISOR_SELF_RESTART is off', byHand: 'npm run studio:stop, then npm run studio:start' } }));
      const h = node(S, ['harness/health.mjs'], env);
      const st = node(S, ['harness/supervisor.mjs', 'status'], env);
      const pre = probe(S, env, `import * as cs from ${u(S, 'harness/code-stamp.mjs')}; import fs from 'node:fs'; import path from 'node:path';
const stateDir = path.join(process.cwd(), '.studio'); const installed = cs.codeStamp({ root: process.cwd() });
fs.writeFileSync(path.join(stateDir, 'supervisor.json'), JSON.stringify({ pid: ${supPid}, status: 'running', startedAt: '2026-11-01T00:00:00Z' }));
const older = cs.oldCodeReport({ stateDir, installed, since: Date.parse('2026-11-14T00:00:00Z'), alive: () => true }).map((o) => o.line);
const unknownNoSince = cs.oldCodeReport({ stateDir, installed, alive: () => true }).length;
console.log(JSON.stringify({ older, unknownNoSince }));`);
      const re = new RegExp(`supervisor runs 2\\.84\\.0 \\(aaaaaaaa\\), installed ${ver.replace(/\./g, '\\.')} \\([0-9a-f]{8}\\): STUDIO_SUPERVISOR_SELF_RESTART is off: restart it: npm run studio:stop, then npm run studio:start`);
      await guard('2.86 (a5): `npm run harness-health` and `npm run studio:status` show "supervisor runs <old>, installed <new>" with the restart command while a running supervisor is on old code; a supervisor older than 2.86 (no stamp) that started before the update is named too (fails before this fix: neither showed which code the supervisor ran)', () => [
        re.test(out(h)) && /- Old harness code: /.test(out(h)) && re.test(out(st)) && /Old code: supervisor runs 2\.84\.0/.test(out(st))
          && /^supervisor runs the code it started with at 2026-11-01 00:00 UTC, installed .*: it is older than 2\.86 and can't tell: restart it/.test(pre.older?.[0] || '') && pre.unknownNoSince === 0,
        `${out(h).slice(-1200)}\n---\n${out(st).slice(-800)}\n---\n${JSON.stringify(pre).slice(0, 800)}`]);
    }
  } finally {
    for (const c of sleepers) { try { c.kill(); } catch { /* gone */ } }
  }
}
