/**
 * qa/selftest-2601m.mjs — 2.60.1 (helper m): load, the machine:heavy lock and Unity, from the crew's report.
 *   B-17: on Windows (no load average) a game check's timeout didn't scale with the CPU busy and a Unity editor open:
 *         a CPU probe stands in for the load average, an editor outside the lock counts as heavy work, and the
 *         timeout is never below 1.5 x the check's last quiet run (capped, printed whenever it isn't the base).
 *   B-35: the editor's runs in harness/unity.mjs (gate, build) take machine:heavy; a heavy take waits (bounded) and
 *         then refuses under the memory floor; `heavy.mjs status` lists an editor outside the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2601M({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-2601m.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_REAP: '', STUDIO_HEAVY_OWN_GROUP: '', STUDIO_HEAVY_REEXEC: '', STUDIO_GATE_PRIORITY: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_GAME: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_GAME_GATE_TIMEOUT_MS: '', STUDIO_GAME_GATE_TIMEOUT_SCALE: '', STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR: '', STUDIO_GAME_GATE_TIMEOUT_FLOOR: '', STUDIO_TEST_TIMEOUT_SCALE: '', STUDIO_TEST_LOADAVG: '0', STUDIO_TEST_CPU_BUSY: '', STUDIO_CPU_PROBE: '', STUDIO_CPU_BUSY_THRESHOLD: '', STUDIO_HEAVY_PROGRAMS: 'Unity.exe,Unity', STUDIO_PROC_LIST_STUB: '', STUDIO_PROC_IDENTITY_STUB: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_HEAVY_RAM_WAIT_MIN: '', STUDIO_TEST_FREEMEM_MB: '', STUDIO_UNITY: '', STUDIO_UNITY_PIN: '', STUDIO_WORKTREES: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p2601m-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const lockF = path.join(dir, '.studio', 'locks', 'machine-heavy-1.lock');
  const sleepF = path.join(tmpRoot, `sleep-2601m-${process.pid}.mjs`);
  fs.writeFileSync(sleepF, 'setTimeout(() => {}, Number(process.argv[2] || 1000));\n');
  const kids = [];
  const holder = (ms, label = 'holder-2601m') => {
    const c = spawn(process.execPath, ['harness/heavy.mjs', 'run', '--label', label, '--', 'node', `"${sleepF}"`, String(ms)], { cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
    kids.push(c);
    const up = until(() => readJson(lockF)?.label === label, 15000 * SLOW);
    return { c, up, gone: () => until(() => readJson(lockF)?.pid !== c.pid, 30000 * SLOW) };
  };
  const stubF = path.join(tmpRoot, `procs-2601m-${process.pid}.json`);
  const timesF = path.join(dir, '.studio', 'gates', 'game-gate-times.json');

  try {
    // ---------- B-17 (1): the CPU probe where there is no load average ----------
    {
      const r = probe(`import fs from 'node:fs';
import { loadFactor, cpuBusy } from ${u('harness/heavy.mjs')};
// Two os.cpus() samples: between them each of 2 cores was busy 63 of 100 ms (or 10 of 100).
const sampler = (busyMs) => { let k = 0; const calls = []; const f = () => { const i = k++; calls.push(i); return [0, 1].map(() => ({ times: { user: 1000 + i * busyMs, nice: 0, sys: 0, irq: 0, idle: 5000 + i * (100 - busyMs) } })); }; f.calls = calls; return f; };
const busy = sampler(63), quiet = sampler(10), linux = sampler(63);
const env = { ...process.env, STUDIO_TEST_LOADAVG: '' };
const win = loadFactor(process.cwd(), { env, platform: 'win32', cpuSample: busy, cpus: 2 });
const winQuiet = loadFactor(process.cwd(), { env, platform: 'win32', cpuSample: quiet, cpus: 2 });
const withLoad = loadFactor(process.cwd(), { env, platform: 'linux', loadavg: 0.5, cpuSample: linux, cpus: 2 });
const direct = cpuBusy({ cpus: sampler(63), wait: () => {} });
const injected = loadFactor(process.cwd(), { env: { ...env, STUDIO_TEST_CPU_BUSY: '0.63' }, cpus: 2 });
console.log(JSON.stringify({ win, winQuiet, withLoad, direct, injected, busyCalls: busy.calls.length, linuxCalls: linux.calls.length }));`, { STUDIO_TEST_LOADAVG: '' });
      guard('B-17: where there is no load average (Windows) two os.cpus() samples measure how busy the CPU is; 63% busy (over STUDIO_CPU_BUSY_THRESHOLD 0.6) raises the factor and says why, 10% leaves it at 1, a real load average is used instead of the probe, and STUDIO_TEST_CPU_BUSY stands in for it (2.60.0: os.loadavg() is all zeros on Windows, factor 1, no line)', () => [
        r.win?.factor > 1 && /CPU 63% busy/.test(r.win.why) && r.busyCalls === 2 && r.winQuiet?.factor === 1 && r.withLoad?.factor === 1 && r.linuxCalls === 0
          && Math.abs(r.direct - 0.63) < 0.001 && r.injected?.factor === r.win.factor,
        JSON.stringify(r).slice(0, 1500)]);
    }

    // ---------- B-17 (2) + B-35: a Unity editor outside the lock ----------
    {
      write('game/load2601/studio.gates.json', JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" ${Math.round(2600 * SLOW)}`, required: true }] }));
      const genv = { STUDIO_GAME: 'load2601', STUDIO_GAME_GATE_TIMEOUT_MS: String(Math.round(2000 * SLOW)), STUDIO_GAME_GATE_CI: 'off', STUDIO_GAME_GATE_TIMEOUT_FLOOR: 'off' };
      const gg = (env = {}) => {
        const r = run(dir, 'node harness/game-gates.mjs --json', { ...base, ...genv, ...env });
        let j = null;
        try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
        return { r, j };
      };
      const now = Date.now();
      fs.writeFileSync(stubF, JSON.stringify([
        { pid: 1, ppid: 0, pgid: 1, start: now - 3600000, cmd: 'init' },
        { pid: 424242, ppid: 1, pgid: 424242, start: now - 1200000, cmd: 'Unity.exe' },
        { pid: 424243, ppid: 424242, pgid: 424242, start: now - 1100000, cmd: 'Unity.exe' },
        { pid: 424244, ppid: 1, pgid: 424244, start: now - 1000000, cmd: 'Unity Hub.exe' },
      ]));
      const quiet = gg();
      const withEditor = gg({ STUDIO_PROC_LIST_STUB: stubF });
      const status = run(dir, 'node harness/heavy.mjs status --json', { ...base, STUDIO_PROC_LIST_STUB: stubF });
      const statusText = run(dir, 'node harness/heavy.mjs status', { ...base, STUDIO_PROC_LIST_STUB: stubF });
      let sj = null;
      try { sj = JSON.parse(String(status.stdout).trim().split('\n').pop()); } catch {}
      const b = Math.round(2000 * SLOW / 1000);
      guard('B-17: a Unity editor running outside machine:heavy (its import workers and Unity Hub not counted) counts as another heavy job: a game check that needs 2.6 s of a 2 s base passes at x2, and the line names the editor; without it the base stands (2.60.0: the editor was invisible, the check timed out at 600 s)', () => [
        quiet.j?.ok === false && !/timeout \d+ s \(/.test(out(quiet.r))
          && withEditor.j?.ok === true && withEditor.j.rows?.[0]?.timeoutMs === 2 * Math.round(2000 * SLOW)
          && new RegExp(`game:nap: timeout ${2 * b} s \\(${b} s x 2: Unity\\.exe \\(pid 424242, for 20 min\\) running outside the machine:heavy lock`).test(out(withEditor.r)) && !/424243|Unity Hub/.test(out(withEditor.r)),
        JSON.stringify({ quiet: quiet.j, withEditor: withEditor.j, err: String(withEditor.r.stderr).slice(-700) }).slice(0, 2500)]);
      guard('B-35: `heavy.mjs status` lists a Unity editor outside the lock as an implicit holder (JSON "implicit" and a line naming the wrapper), and only the top editor process', () => [
        status.status === 0 && sj?.implicit?.length === 1 && sj.implicit[0].pid === 424242 && /implicit holder \(outside the lock\): Unity\.exe \(pid 424242/.test(out(statusText)) && /heavy\.mjs run --label/.test(out(statusText)),
        JSON.stringify({ sj, text: out(statusText).slice(-600) })]);

      // An editor inside a holder's tree is the holder's (not counted twice).
      const inTree = probe(`import fs from 'node:fs';
import path from 'node:path';
import { implicitHolders } from ${u('harness/heavy.mjs')};
const f = path.join(process.cwd(), '.studio', 'locks', 'machine-heavy-1.lock');
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now(), label: 'unity build' }));
const procs = [{ pid: process.pid, ppid: 1, start: Date.now() - 5000, cmd: 'node' }, { pid: 515151, ppid: process.pid, start: Date.now() - 1000, cmd: 'Unity.exe' }, { pid: 525252, ppid: 1, start: Date.now() - 1000, cmd: 'Unity' }];
const got = implicitHolders(process.cwd(), { procs, self: -1 });
fs.rmSync(f, { force: true });
const none = implicitHolders(process.cwd(), { procs, self: -1, env: { ...process.env, STUDIO_HEAVY_PROGRAMS: 'off' } });
console.log(JSON.stringify({ got: got.map((p) => p.pid), none: none.length }));`);
      guard('B-35: a Unity editor started inside a machine:heavy holder\'s tree belongs to that holder and is not an implicit one; another editor outside it is; STUDIO_HEAVY_PROGRAMS=off counts none', () => [
        JSON.stringify(inTree.got) === '[525252]' && inTree.none === 0, JSON.stringify(inTree).slice(0, 800)]);

      // ---------- B-17 (3): the floor from the last quiet run ----------
      fs.rmSync(timesF, { force: true });
      const fenv = { STUDIO_GAME_GATE_TIMEOUT_FLOOR: '' };
      write('game/load2601/studio.gates.json', JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" ${Math.round(1800 * SLOW)}`, required: true }] }));
      const first = gg(fenv);
      const rec1 = readJson(timesF)?.['load2601:game:nap'];
      // Under load the probe doesn't see, the suite takes 2.3 s: over the 2 s base, under 1.5 x the quiet ~1.9 s.
      write('game/load2601/studio.gates.json', JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" ${Math.round(2300 * SLOW)}`, required: true }] }));
      const slower = gg(fenv);
      const rec2 = readJson(timesF)?.['load2601:game:nap'];
      // A run at factor > 1 records nothing.
      const scaled = gg({ ...fenv, STUDIO_TEST_CPU_BUSY: '1' });
      const rec3 = readJson(timesF)?.['load2601:game:nap'];
      guard('B-17: a game check\'s timeout is never below 1.5 x its last quiet passing run (kept per game and check in .studio/gates/game-gate-times.json): quiet 1.9 s, then 2.3 s passes with a 2 s base, the line printed naming why (2.60.0: timed out at the base); a run at factor > 1 records nothing', () => [
        first.j?.ok === true && !/timeout \d+ s \(/.test(out(first.r)) && rec1?.ms >= 1800 * SLOW
          && slower.j?.ok === true && slower.j.rows?.[0]?.timeoutMs === Math.round(rec1.ms * 1.5) && /at least 1\.5 x its last quiet run of \d+ s \(STUDIO_GAME_GATE_TIMEOUT_FLOOR\)/.test(out(slower.r)) && /last quiet run/.test(slower.j.rows[0].timeoutWhy || '')
          && rec2?.ms >= 2300 * SLOW && scaled.j?.ok === true && rec3?.ms === rec2.ms && rec3?.at === rec2.at,
        JSON.stringify({ rec1, first: first.j?.rows, slower: slower.j?.rows, err: String(slower.r.stderr).slice(-600), rec2, rec3 }).slice(0, 2500)]);
      fs.rmSync(path.join(dir, 'game', 'load2601'), { recursive: true, force: true });
      fs.rmSync(timesF, { force: true });

      const caps = probe(`import { scaledTimeout, recordGateTime } from ${u('harness/heavy.mjs')};
const root = process.cwd();
recordGateTime(root, 'g:small', 100);
recordGateTime(root, 'g:huge', 100000);
recordGateTime(root, 'g:mid', 1800);
const small = scaledTimeout(2000, root, { label: 'g:small' });
const huge = scaledTimeout(2000, root, { label: 'g:huge' });
const mid = scaledTimeout(2000, root, { label: 'g:mid' });
const hugeCap5 = scaledTimeout(2000, root, { label: 'g:huge', env: { ...process.env, STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR: '5' } });
const offScale = scaledTimeout(2000, root, { label: 'g:mid', env: { ...process.env, STUDIO_GAME_GATE_TIMEOUT_SCALE: 'off' } });
const offFloor = scaledTimeout(2000, root, { label: 'g:mid', env: { ...process.env, STUDIO_GAME_GATE_TIMEOUT_FLOOR: 'off' } });
const two = scaledTimeout(2000, root, { label: 'g:mid', env: { ...process.env, STUDIO_GAME_GATE_TIMEOUT_FLOOR: '2' } });
console.log(JSON.stringify({ small: small.ms, huge: huge.ms, hugeCapped: huge.floor?.capped, hugeWhy: huge.floor?.why, mid: mid.ms, hugeCap5: hugeCap5.ms, offScale: offScale.ms, offFloor: offFloor.ms, two: two.ms }));`);
      guard('B-17: the floor never lowers the base (a 0.1 s quiet run: 2 s stands), is capped at STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR x the base like the load factor (100 s quiet: 6 s, saying so; max 5: 10 s), takes its multiplier from STUDIO_GAME_GATE_TIMEOUT_FLOOR, and is off with the floor or the scaling off', () => [
        caps.small === 2000 && caps.huge === 6000 && caps.hugeCapped === true && /capped at 3 x the base/.test(caps.hugeWhy || '') && caps.mid === 2700 && caps.hugeCap5 === 10000 && caps.offScale === 2000 && caps.offFloor === 2000 && caps.two === 3600,
        JSON.stringify(caps)]);
    }

    // ---------- B-35: the memory floor at a heavy take ----------
    {
      const ram = probe(`import fs from 'node:fs';
import { acquireHeavy } from ${u('harness/heavy.mjs')};
const logs = [];
let err = null, got = null;
const t = Date.now();
try { got = acquireHeavy(process.cwd(), 'unity build', { log: (m) => logs.push(m) }); } catch (e) { err = { code: e.code, ram: e.ram, msg: e.message }; }
const low = { err, got: Boolean(got?.held), ms: Date.now() - t, logs: logs.join(' | '), lock: fs.existsSync('.studio/locks/machine-heavy-1.lock') };
logs.length = 0;
let k = 0;
const later = acquireHeavy(process.cwd(), 'unity build', { log: (m) => logs.push(m), freemem: () => (k++ < 3 ? 1 : 8) * 1024 ** 3 });
const freed = { held: later.held, calls: k, logs: logs.join(' | ') };
later.release();
logs.length = 0;
const plenty = acquireHeavy(process.cwd(), 'unity build', { log: (m) => logs.push(m), env: { ...process.env, STUDIO_TEST_FREEMEM_MB: '8000' } });
const ok = { held: plenty.held, logs: logs.join(' | ') };
plenty.release();
console.log(JSON.stringify({ low, freed, ok }));`, { STUDIO_HEAVY_RAM_FLOOR_GB: '3', STUDIO_TEST_FREEMEM_MB: '1000', STUDIO_HEAVY_RAM_WAIT_MIN: '0.02' });
      const cli = run(dir, `node harness/heavy.mjs run --label "unity import" -- node "${sleepF}" 10`, { ...base, STUDIO_RAM_FLOOR_GB: '3', STUDIO_HEAVY_RAM_FLOOR_GB: '', STUDIO_TEST_FREEMEM_MB: '1000', STUDIO_HEAVY_RAM_WAIT_MIN: '0.01' });
      guard('B-35: a heavy take checks free memory: under the floor it waits saying so, up to STUDIO_HEAVY_RAM_WAIT_MIN, then refuses (HEAVY_BUSY, naming the free and floor GB) with no lock taken; it starts once memory is free again, and at once with enough; heavy.mjs run exits 3 under STUDIO_RAM_FLOOR_GB (2.60.0: memory was checked only at agent start; 2.9 GB free during a build)', () => [
        ram.low?.err?.code === 'HEAVY_BUSY' && ram.low.err.ram === true && /free memory is 1 GB, under the floor \(STUDIO_HEAVY_RAM_FLOOR_GB=3\)/.test(ram.low.err.msg) && /did not start/.test(ram.low.err.msg) && /waits: free memory is 1 GB/.test(ram.low.logs) && !ram.low.lock && !ram.low.got
          && ram.freed?.held === 'machine-heavy-1.lock' && ram.freed.calls >= 4 && /waits: free memory/.test(ram.freed.logs) && /back over the floor/.test(ram.freed.logs)
          && ram.ok?.held === 'machine-heavy-1.lock' && !/memory/.test(ram.ok.logs)
          && cli.status === 3 && /STUDIO_RAM_FLOOR_GB=3/.test(out(cli)),
        JSON.stringify({ ram, cli: out(cli).slice(-500), cliStatus: cli.status }).slice(0, 2500)]);
    }

    // ---------- B-35: harness/unity.mjs gate and build take machine:heavy ----------
    if (process.platform === 'win32') {
      report('B-35: harness/unity.mjs gate and build run the editor under machine:heavy (skipped on Windows: the stand-in editor is a POSIX script)', true, '');
    } else {
      const proj = 'game/unity2601';
      write(`${proj}/ProjectSettings/ProjectVersion.txt`, 'm_EditorVersion: 6000.3.1f1\n');
      write(`${proj}/Assets/Editor/StudioBuild.cs`, '// stand-in\n');
      write(`${proj}/Assets/Sim/Sim.asmdef`, JSON.stringify({ name: 'Sim', noEngineReferences: true }));
      write(`${proj}/Assets/Sim/Rules.cs`, 'namespace Sim { public static class Rules { public static int Add(int a, int b) => a + b; } }\n');
      const seenF = path.join(tmpRoot, `unity-seen-2601m-${process.pid}.txt`);
      const fake = path.join(tmpRoot, `fake-unity-2601m-${process.pid}.mjs`);
      fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const a = process.argv.slice(2);
const at = (k) => a[a.indexOf(k) + 1];
fs.appendFileSync(${JSON.stringify(seenF)}, (a.includes('-runTests') ? 'tests ' + at('-testPlatform') : 'build') + ' ' + (process.env.STUDIO_HEAVY_HELD || 'none') + '\\n');
if (a.includes('-runTests')) fs.writeFileSync(at('-testResults'), '<test-run total="1" passed="1" failed="0" skipped="0" result="Passed"></test-run>');
else console.log('[build] PASS stand-in');
`);
      fs.chmodSync(fake, 0o755);
      const uenv = { ...base, STUDIO_UNITY: fake };
      const seen = () => { try { return fs.readFileSync(seenF, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
      fs.rmSync(seenF, { force: true });
      const h = holder(8000 * SLOW);
      const busyBuild = run(dir, `node harness/unity.mjs build ${proj}`, { ...uenv, STUDIO_HEAVY_WAIT_MIN: '0.02' });
      const busyGate = run(dir, `node harness/unity.mjs gate ${proj}`, { ...uenv, STUDIO_HEAVY_WAIT_MIN: '0.02' });
      const ranWhileBusy = seen();
      h.gone();
      const build = run(dir, `node harness/unity.mjs build ${proj}`, uenv);
      const gate = run(dir, `node harness/unity.mjs gate ${proj}`, uenv);
      const lines = seen();
      const tok = (l) => l.split(' ').pop();
      guard('B-35: harness/unity.mjs build and gate run the editor under machine:heavy: beside a live holder they don\'t start the editor and exit 3 naming the holder; free, the editor sees STUDIO_HEAVY_HELD, and gate holds one slot for Edit Mode and Play Mode (2.60.0: agent-run editor builds and tests ran beside a full verify)', () => [
        h.up && busyBuild.status === 3 && /did not start/.test(out(busyBuild)) && /holder-2601m/.test(out(busyBuild)) && busyGate.status === 3 && /did not run/.test(out(busyGate)) && ranWhileBusy.length === 0
          && build.status === 0 && gate.status === 0 && lines.length === 3 && lines.every((l) => /machine-heavy-1\.lock:\d+$/.test(l))
          && lines[1].startsWith('tests EditMode') && lines[2].startsWith('tests PlayMode') && tok(lines[1]) === tok(lines[2]),
        JSON.stringify({ up: h.up, busyBuild: out(busyBuild).slice(-500), busyGate: out(busyGate).slice(-400), ranWhileBusy, build: out(build).slice(-300), gate: out(gate).slice(-400), lines }).slice(0, 2500)]);
      fs.rmSync(path.join(dir, proj), { recursive: true, force: true });
      for (const f of [seenF, fake]) fs.rmSync(f, { force: true });
    }
  } finally {
    for (const c of kids) { try { c.kill('SIGKILL'); } catch {} }
    for (const f of [sleepF, stubF]) fs.rmSync(f, { force: true });
    fs.rmSync(lockF, { force: true });
  }
}
