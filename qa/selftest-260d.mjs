/**
 * qa/selftest-260d.mjs — 2.60.0 (helper d): heavy work's process trees, unknown lane tasks, slow seeded tests.
 *   #5:  a machine:heavy holder records its process tree; `node harness/heavy.mjs stop --by <name>` kills the whole
 *        tree (a grandchild included), frees the slot, records heavy.stop, and is refused in a worker session; a
 *        killed holder's children (orphans) are found and stopped by the next take; a full verify's gates run in the
 *        holder's own process group, so a stop gets them; the Windows path (taskkill /T /F, orphans by parent pid
 *        and start) with an injected process list.
 *   #6a: createLaneCopy with a task id that isn't on the board is refused and writes nothing; an old key for an
 *        unknown task is dropped by the next write of .studio/lane-branches.json.
 *   #6b: a manifest's "slowTests" passes the gate's load factor to the game's test command as
 *        STUDIO_TEST_TIMEOUT_SCALE (printed, never below 1).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest260D({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-260d.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_HEAVY_OWN_GROUP: '', STUDIO_HEAVY_REEXEC: '', STUDIO_GATE_PRIORITY: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_GAME: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_GAME_GATE_TIMEOUT_MS: '', STUDIO_GAME_GATE_TIMEOUT_SCALE: '', STUDIO_TEST_TIMEOUT_SCALE: '', STUDIO_TEST_LOADAVG: '0', STUDIO_PROC_LIST_STUB: '', STUDIO_PROC_IDENTITY_STUB: '', STUDIO_WORKTREES: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p260d-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const lockF = path.join(dir, '.studio', 'locks', 'machine-heavy-1.lock');
  // A node script that starts a child that starts a sleeping grandchild; each writes "<depth>:<pid>" to a file.
  const treeF = path.join(tmpRoot, `tree-260d-${process.pid}.mjs`);
  fs.writeFileSync(treeF, `import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [, , out, depth = '0'] = process.argv;
const d = Number(depth);
fs.appendFileSync(out, d + ':' + process.pid + '\\n');
if (d < 2) spawn(process.execPath, [process.argv[1], out, String(d + 1)], { stdio: 'ignore' });
setTimeout(() => {}, 600000);
`);
  const pidsOf = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => Number(l.split(':')[1])); } catch { return []; } };
  // Gone: no such process, or a zombie (ended; on a box whose init doesn't collect orphans it stays one).
  const gone = (pid) => {
    if (process.platform === 'linux') {
      try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) === 'Z'; } catch { return true; }
    }
    try { process.kill(pid, 0); return false; } catch (e) { return e.code !== 'EPERM'; }
  };
  const kids = [];
  const pidFiles = [];
  // `node harness/heavy.mjs run --label <x> -- node tree.mjs <file>`: the holder and its three-deep tree.
  const holder = (label) => {
    const f = path.join(tmpRoot, `pids-260d-${label}-${process.pid}.txt`);
    fs.rmSync(f, { force: true });
    pidFiles.push(f);
    const c = spawn(process.execPath, ['harness/heavy.mjs', 'run', '--label', label, '--', 'node', `"${treeF}"`, `"${f}"`, '0'], { cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
    kids.push(c);
    const up = until(() => readJson(lockF)?.label === label && pidsOf(f).length === 3, 20000 * SLOW);
    return { c, f, up, tree: () => pidsOf(f), lock: () => readJson(lockF) };
  };
  // Between checks: whatever a check left running (on the old code nothing stops it) is killed, and the slot freed.
  const clearUp = () => {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch {} }
    for (const f of pidFiles) for (const p of pidsOf(f)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    const h = readJson(lockF);
    if (h?.pid) { try { process.kill(h.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(lockF, { force: true });
  };
  const evts = () => { try { return fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const gatesFile = path.join(dir, 'studio', 'gates.json');
  const gatesBefore = fs.readFileSync(gatesFile, 'utf8');

  try {
    // ---------- #5: heavy stop kills the holder's whole tree ----------
    {
      const h = holder('tree-260d');
      const rec = h.lock();
      const worker = run(dir, 'node harness/heavy.mjs stop --by somebody', { ...base, STUDIO_ROLE: 'builder' });
      const workerName = run(dir, 'node harness/heavy.mjs stop --all --by somebody', { ...base, STUDIO_LOCK_OWNER: 'builder-s3' });
      const noBy = run(dir, 'node harness/heavy.mjs stop', base);
      const stillUp = h.tree().every((p) => !gone(p)) && !gone(rec?.pid);
      const stop = run(dir, 'node harness/heavy.mjs stop --label tree-260d --by tester', { ...base, STUDIO_LOCK_OWNER: 'opus-bot' });
      const tree = [rec?.pid, ...h.tree()];
      const allGone = until(() => tree.every(gone), 8000 * SLOW);
      const ev = evts().filter((e) => e.type === 'heavy.stop').pop();
      guard('#5: node harness/heavy.mjs stop --label <x> --by <name> kills the holder\'s whole tree (holder, child, grandchild), frees the machine:heavy slot and records a heavy.stop event; the holder records its tree root, groups and how it is killed (2.59.1: no stop command; the crew killed the tree by hand with taskkill /T /F)', () => [
        h.up && rec?.tree?.root === rec.pid && rec.tree.groups?.length >= 1 && /group|taskkill/.test(rec.tree.kill || '') && stillUp
          && stop.status === 0 && /stopped tree-260d/.test(out(stop)) && /slot is free/.test(out(stop)) && allGone && !fs.existsSync(lockF)
          && ev?.agent === 'tester' && ev.meta?.recordedBy === 'opus-bot' && ev.meta?.freed === true && tree.every((p) => ev.meta.killed.includes(p)),
        JSON.stringify({ up: h.up, rec, stillUp, stop: out(stop), tree, alive: tree.filter((p) => !gone(p)), lock: readJson(lockF), ev }).slice(0, 2500)]);
      guard('#5: heavy stop is refused in a worker session (a launched builder role, or a worker agent\'s name) and without --by, and kills nothing then (harness/permission.mjs\'s worker test)', () => [
        worker.status === 3 && /refused: a launched builder session/.test(out(worker)) && workerName.status === 3 && /builder-s3 is a worker agent/.test(out(workerName)) && noBy.status === 2 && /--by <name>/.test(out(noBy)) && stillUp,
        JSON.stringify({ worker: out(worker), workerName: out(workerName), noBy: out(noBy), stillUp })]);
      clearUp();
    }

    // ---------- #5: a killed holder whose children still run ----------
    {
      const h = holder('orphan-260d');
      const rec = h.lock();
      const tree = h.tree();
      if (rec?.pid) try { process.kill(rec.pid, 'SIGKILL'); } catch {}
      const holderDead = Boolean(rec?.pid) && until(() => gone(rec.pid), 5000 * SLOW);
      const orphansUp = tree.every((p) => !gone(p));
      const status = run(dir, 'node harness/heavy.mjs status --json', base);
      const next = run(dir, 'node harness/heavy.mjs run --label next-260d -- node --version', base);
      const reaped = until(() => tree.every(gone), 8000 * SLOW);
      const ev = evts().filter((e) => e.type === 'heavy.reap').pop();
      guard('#5: a holder killed on its own leaves its children running (orphans); status names them, and the next take finds them in the holder\'s recorded tree, stops them, frees the slot and runs (2.59.1: the slot was freed but the orphans kept running)', () => [
        h.up && holderDead && orphansUp && /still run/.test(out(status)) && next.status === 0 && /orphan-260d .*is gone/.test(out(next)) && /left \d process\(es\) of its tree running/.test(out(next))
          && reaped && !fs.existsSync(lockF) && ev?.meta?.pid === rec?.pid && tree.every((p) => ev.meta.killed.includes(p)),
        JSON.stringify({ up: h.up, holderDead, orphansUp, status: out(status).slice(-600), next: out(next).slice(-800), alive: tree.filter((p) => !gone(p)), ev }).slice(0, 2500)]);
      clearUp();
    }

    // ---------- #5: a full verify's gates are in the holder's group ----------
    if (process.platform !== 'win32') {
      const f = path.join(tmpRoot, `pids-260d-verify-${process.pid}.txt`);
      fs.rmSync(f, { force: true });
      pidFiles.push(f);
      fs.writeFileSync(gatesFile, JSON.stringify({ gates: [{ id: 'tree', command: `node "${treeF}" "${f}" 0`, required: true }] }, null, 2));
      const v = spawn(process.execPath, ['scripts/run-gates.mjs', '--full'], { cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
      kids.push(v);
      const up = until(() => readJson(lockF)?.label?.startsWith('full verify') && pidsOf(f).length === 3, 30000 * SLOW);
      const rec = readJson(lockF);
      const stop = run(dir, 'node harness/heavy.mjs stop --all --by tester', base);
      const tree = [rec?.pid, ...pidsOf(f)];
      const allGone = until(() => tree.every(gone), 8000 * SLOW);
      const fullRec = readJson(path.join(dir, '.studio', 'verify-running', 'full.json'));
      guard('#5: a full verify (scripts/run-gates.mjs) holds machine:heavy as the leader of its own process group, so heavy stop --all kills its gates\' whole tree (gate, child, grandchild) and frees the slot; its full-verify record is then stale (2.59.1: no stop; the gates ran in the caller\'s group)', () => [
        up && rec?.tree?.groups?.includes(rec.pid) && rec.pid !== v.pid && stop.status === 0 && allGone && !fs.existsSync(lockF) && (!fullRec || gone(fullRec.pid)),
        JSON.stringify({ up, rec, vpid: v.pid, stop: out(stop), alive: tree.filter((p) => p && !gone(p)), fullRec }).slice(0, 2000)]);
      fs.writeFileSync(gatesFile, gatesBefore);
      clearUp();
    }

    // ---------- #5: the Windows path, with an injected process list ----------
    {
      const sim = probe(`import { killHolderTree, stopHeavy } from ${u('harness/heavy.mjs')};
import { winProcsFrom } from ${u('harness/proc-identity.mjs')};
const T = 1700000000000;
// root 5000 started at T; 5001 its child (cmd.exe), 5002 npm under it, 5003 a vitest worker under that.
const table = () => [
  { pid: 5001, ppid: 5000, start: T + 1000, cmd: 'cmd.exe' }, { pid: 5002, ppid: 5001, start: T + 2000, cmd: 'node.exe' },
  { pid: 5003, ppid: 5002, start: T + 3000, cmd: 'node.exe' }, { pid: 4999, ppid: 5000, start: T - 60000, cmd: 'old.exe' },
  { pid: 7000, ppid: 1, start: T - 99999, cmd: 'explorer.exe' }];
const fake = (procs) => {
  const cmds = [];
  const kill = (pid) => { const drop = new Set([pid]); let more = true; while (more) { more = false; for (const p of procs) if (!drop.has(p.pid) && drop.has(p.ppid)) { drop.add(p.pid); more = true; } } procs = procs.filter((p) => !drop.has(p.pid)); };
  return { cmds, listProcs: () => procs, exec: (cmd, args) => { cmds.push([cmd, ...args].join(' ')); kill(Number(args[args.length - 1])); }, signal: () => { throw new Error('no signals on Windows'); }, platform: 'win32', graceMs: 200, self: 1 };
};
const h = { pid: 5000, identity: { start: T, self: true }, label: 'full verify', tree: { root: 5000, groups: [], kill: 'taskkill /T /F <root>' } };
// 1: the holder alive: one taskkill /T /F on its root.
const a = fake([{ pid: 5000, ppid: 900, start: T + 50, cmd: 'node.exe' }, ...table()]);
const ra = killHolderTree(h, a);
// 2: the holder killed alone: its orphans still name pid 5000 (Windows doesn't re-parent); the older 4999 isn't one.
const b = fake(table());
const rb = killHolderTree(h, b);
// 3: pid 5000 reused by a new program at T+10 min: the old orphans go, the new program and its child stay.
const c = fake([{ pid: 5000, ppid: 900, start: T + 600000, cmd: 'other.exe' }, { pid: 5004, ppid: 5000, start: T + 600500, cmd: 'child.exe' }, ...table()]);
const rc = killHolderTree(h, c);
const parsed = winProcsFrom('self|42\\r\\n42|1|' + (Date.now()) + '|powershell.exe\\r\\n5001|5000|' + (T + 1000) + '|cmd.exe\\r\\n5009|5000||System\\r\\n');
const refused = stopHeavy(process.cwd(), { by: 'x', env: { STUDIO_ROLE: 'qa-playtester' } });
console.log(JSON.stringify({ a: { cmds: a.cmds, killed: ra.killed, survivors: ra.survivors }, b: { cmds: b.cmds, killed: rb.killed }, c: { cmds: c.cmds, killed: rc.killed, left: c.listProcs().map((p) => p.pid) }, parsed, refused: refused.code }));`);
      guard('#5 (Windows logic, simulated): a live holder\'s tree is killed with one taskkill /T /F /PID <root>; a holder killed alone has its orphans found by parent pid and start (taskkill /T /F on each top orphan; an older process naming the same pid is spared); with the pid reused, the new program and its child are spared; the PowerShell listing is parsed (pid|ppid|start|name); a worker is refused (UNTESTED on real Windows)', () => [
        JSON.stringify(sim.a?.cmds) === JSON.stringify(['taskkill /T /F /PID 5000']) && sim.a.killed.join() === '5000,5001,5002,5003' && sim.a.survivors.length === 0
          && JSON.stringify(sim.b?.cmds) === JSON.stringify(['taskkill /T /F /PID 5001']) && sim.b.killed.join() === '5001,5002,5003'
          && JSON.stringify(sim.c?.cmds) === JSON.stringify(['taskkill /T /F /PID 5001']) && sim.c.left.includes(5000) && sim.c.left.includes(5004) && sim.c.left.includes(4999) && !sim.c.left.includes(5003)
          && sim.parsed?.length === 2 && sim.parsed[0].pid === 5001 && sim.parsed[0].ppid === 5000 && sim.parsed[1].start === null && sim.refused === 3,
        JSON.stringify(sim).slice(0, 2000)]);
    }

    // ---------- #6a: createLaneCopy refuses an unknown task id ----------
    {
      const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
      if (!fs.existsSync(path.join(dir, '.git'))) { g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); }
      g('add', '-A');
      g('commit', '-q', '--no-verify', '-m', 'base 260d');
      const added = out(run(dir, 'node harness/task.mjs add "Lane check for 260d" --role builder --priority P2', base));
      const known = (added.match(/"id": "(T-\d+)"/) || [])[1];
      const branchesF = path.join(dir, '.studio', 'lane-branches.json');
      fs.mkdirSync(path.dirname(branchesF), { recursive: true });
      const planted = `${JSON.stringify({ 'T-98760': 'lane/ghost-1', 'T-98760:carried': ['lane/ghost-0'] }, null, 2)}\n`;
      fs.writeFileSync(branchesF, planted);
      const mk = (agent, task) => probe(`import { createLaneCopy, removeLaneCopy } from ${u('harness/worktree.mjs')};
const r = createLaneCopy(${JSON.stringify(agent)}, { task: ${JSON.stringify(task)} });
if (r.dir) removeLaneCopy(${JSON.stringify(agent)}, { keepBranch: true });
console.log(JSON.stringify(r));`);
      const bad = mk('lane-260d', 'T-98765');
      const afterBad = fs.readFileSync(branchesF, 'utf8');
      const noCopy = !fs.existsSync(path.join(dir, '.lanes', 'lane-260d'));
      const noBranch = !/lane\/lane-260d/.test(g('branch', '--list').stdout);
      const good = mk('lane-260e', known);
      const afterGood = readJson(branchesF) || {};
      guard('#6a: createLaneCopy with a task id that isn\'t on the board is refused with a clear message, makes no copy or branch and leaves .studio/lane-branches.json untouched; a real task still gets its copy, and that write drops the old key of an unknown task (2.59.1: the guessed id got a copy and a stale key)', () => [
        Boolean(known) && /T-98765 is not on the board/.test(bad.error || '') && afterBad === planted && noCopy && noBranch
          && good.dir && afterGood[known] === good.branch && !('T-98760' in afterGood) && !('T-98760:carried' in afterGood)
          && evts().some((e) => e.type === 'lane.branches_pruned' && /T-98760/.test(e.msg)),
        JSON.stringify({ known, bad, afterBad, noCopy, noBranch, good, afterGood }).slice(0, 2000)]);
    }

    // ---------- #6b: slow tests get the gate's load factor ----------
    {
      const dumpF = path.join(tmpRoot, `env-260d-${process.pid}.txt`);
      const dumpJs = path.join(tmpRoot, `envdump-260d-${process.pid}.mjs`);
      fs.writeFileSync(dumpJs, `import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], (process.env.STUDIO_TEST_TIMEOUT_SCALE || 'unset') + ' ' + (process.env.STUDIO_SLOW_TESTS || '') + '\\n');\n`);
      const man = (slowTests) => write('game/slow260d/studio.gates.json', JSON.stringify({ gates: [{ id: 'test', command: `node "${dumpJs}" "${dumpF}"`, required: true }], ...(slowTests ? { slowTests } : {}) }));
      const cores = Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1);
      const gg = (env = {}) => {
        fs.rmSync(dumpF, { force: true });
        const r = run(dir, 'node harness/game-gates.mjs --json', { ...base, STUDIO_GAME: 'slow260d', STUDIO_GAME_GATE_CI: 'off', ...env });
        let j = null;
        try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
        let seen = '';
        try { seen = fs.readFileSync(dumpF, 'utf8').trim(); } catch {}
        return { r, j, seen };
      };
      man({ pattern: '**/*.slow.test.ts', timeoutScale: true });
      const loaded = gg({ STUDIO_TEST_LOADAVG: String(cores * 2.5) });
      const quiet = gg();
      const lowGiven = gg({ STUDIO_TEST_TIMEOUT_SCALE: '0.5' });
      man({ pattern: '**/*.slow.test.ts', timeoutScale: true, minScale: 2 });
      const floor = gg();
      man({ pattern: '**/*.slow.test.ts', timeoutScale: false });
      const offRun = gg({ STUDIO_TEST_LOADAVG: String(cores * 2.5) });
      man(null);
      const none = gg({ STUDIO_TEST_LOADAVG: String(cores * 2.5) });
      guard('#6b: a manifest\'s "slowTests" gives the game\'s test command STUDIO_TEST_TIMEOUT_SCALE = the gate\'s load factor (x2.5 under load, printed and kept in the row) with the pattern in STUDIO_SLOW_TESTS; quiet it is 1, never below 1 (a lower value already set is raised), minScale sets a floor; timeoutScale false or no slowTests passes nothing (2.59.1: the per-test timeout got no factor)', () => [
        loaded.seen === '2.5 **/*.slow.test.ts' && /per-test timeouts x2\.5 \(STUDIO_TEST_TIMEOUT_SCALE=2\.5; the gate's load factor 2\.5\)/.test(out(loaded.r)) && loaded.j?.rows?.[0]?.testTimeoutScale === 2.5
          && quiet.seen === '1 **/*.slow.test.ts' && /per-test timeouts x1 /.test(out(quiet.r)) && lowGiven.seen.startsWith('1 ') && floor.seen.startsWith('2 ')
          && offRun.seen === 'unset' && none.seen === 'unset' && [loaded, quiet, lowGiven, floor, offRun, none].every((x) => x.j?.ok === true),
        JSON.stringify({ loaded: { seen: loaded.seen, err: String(loaded.r.stderr).slice(-400), row: loaded.j?.rows }, quiet: quiet.seen, lowGiven: lowGiven.seen, floor: floor.seen, offRun: offRun.seen, none: none.seen }).slice(0, 2000)]);
      fs.rmSync(path.join(dir, 'game', 'slow260d'), { recursive: true, force: true });
      for (const f of [dumpF, dumpJs]) fs.rmSync(f, { force: true });
    }
  } finally {
    fs.writeFileSync(gatesFile, gatesBefore);
    clearUp();
    for (const f of [treeF, ...pidFiles]) fs.rmSync(f, { force: true });
  }
}
