/**
 * qa/selftest-259d.mjs — 2.59.0 (helper d): heavy work on one machine, from a crew orchestrator's final brief.
 *   #11a: a machine:heavy lock (harness/heavy.mjs): one heavy run at a time (full verify, the Unity gate, wrapped
 *         browser playtests); a waiter names the holder and fails clearly past its limit; a dead holder is stale.
 *   #11b: a second full verify of the same checkout while one runs is refused, naming it; a dead one's record is
 *         ignored; `npm run verify -- --wait` shows another owner's running full verify.
 *   #11c: the supervisor (and the watcher's auto-start, the same pass) starts no agent under STUDIO_RAM_FLOOR_GB.
 *   #2:   a game check's timeout is scaled for load (another heavy holder) and printed; a hang still fails.
 *   #16:  the Unity gate runs the studio's land command under machine:heavy and maps its exit codes; skipped with no
 *         command; task done for a task on the Unity track runs it and closes only on a pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest259D({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const until = (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms && !fn()) nap(50); return fn(); };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '', STUDIO_GATE_PRIORITY: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_LOCK_OWNER: '', STUDIO_GAME: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_GAME_GATE_TIMEOUT_MS: '', STUDIO_GAME_GATE_TIMEOUT_SCALE: '', STUDIO_TEST_LOADAVG: '0', STUDIO_RAM_FLOOR_GB: '', STUDIO_TEST_FREEMEM_MB: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-259d.jsonl') };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p259d-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const lockF = path.join(dir, '.studio', 'locks', 'machine-heavy-1.lock');
  const sleepF = path.join(tmpRoot, `sleep-259d-${process.pid}.mjs`);
  fs.writeFileSync(sleepF, 'setTimeout(() => {}, Number(process.argv[2] || 1000));\n');
  const kids = [];
  // A live machine:heavy holder: `node harness/heavy.mjs run` around a sleep.
  const holder = (ms, label = 'holder-259d') => {
    const c = spawn(process.execPath, ['harness/heavy.mjs', 'run', '--label', label, '--', 'node', `"${sleepF}"`, String(ms)], { cwd: dir, env: { ...process.env, ...base }, stdio: 'ignore' });
    kids.push(c);
    const up = until(() => readJson(lockF)?.label === label, 15000 * SLOW);
    // Gone once its lock is (this process can't reap the child while it blocks, so its exit code isn't seen here).
    return { c, up, gone: () => until(() => readJson(lockF)?.pid !== c.pid, 30000 * SLOW) };
  };
  const gatesFile = path.join(dir, 'studio', 'gates.json');
  const gatesBefore = fs.readFileSync(gatesFile, 'utf8');
  const gameJson = path.join(dir, 'studio', 'game.json');
  const gameBefore = fs.existsSync(gameJson) ? fs.readFileSync(gameJson, 'utf8') : null;

  try {
    // ---------- #11a: the machine:heavy lock ----------
    {
      const h = holder(4000 * SLOW);
      const busy = probe(`import { acquireHeavy } from ${u('harness/heavy.mjs')};
const logs = [];
let err = null, got = null;
const t = Date.now();
try { got = acquireHeavy(process.cwd(), 'waiter-short', { log: (m) => logs.push(m) }); } catch (e) { err = { code: e.code, msg: e.message }; }
const short = { err, got: Boolean(got?.held), ms: Date.now() - t, logs: logs.join(' | ') };
logs.length = 0;
const t2 = Date.now();
const lk = acquireHeavy(process.cwd(), 'waiter-long', { log: (m) => logs.push(m), env: { ...process.env, STUDIO_HEAVY_WAIT_MIN: '1' } });
const long = { held: lk.held, waitedMs: Date.now() - t2, logs: logs.join(' | ') };
lk.release();
console.log(JSON.stringify({ short, long }));`, { STUDIO_HEAVY_WAIT_MIN: '0.02' });
      h.gone();
      // A dead holder, and (Linux) a live pid whose recorded start is another program's: both stale.
      const stale = probe(`import fs from 'node:fs';
import path from 'node:path';
import { acquireHeavy, heavyHolders } from ${u('harness/heavy.mjs')};
const f = path.join(process.cwd(), '.studio', 'locks', 'machine-heavy-1.lock');
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify({ pid: 999999, at: Date.now(), label: 'dead-verify' }));
const t = Date.now();
const a = acquireHeavy(process.cwd(), 'after-dead', { log: () => {} });
const dead = { held: a.held, ms: Date.now() - t };
a.release();
let reused = null;
if (process.platform === 'linux') {
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, identity: { start: 1, proc: 'linux:1@not-this-boot' }, at: Date.now(), label: 'reused-pid' }));
  reused = { listed: heavyHolders(process.cwd()).length };
  const b = acquireHeavy(process.cwd(), 'after-reused', { log: () => {} });
  reused.held = b.held; b.release();
}
console.log(JSON.stringify({ dead, reused }));`, { STUDIO_HEAVY_WAIT_MIN: '0.05' });
      guard('#11a: machine:heavy is exclusive: a second taker waits naming the holder and fails clearly (HEAVY_BUSY) past STUDIO_HEAVY_WAIT_MIN, or gets it once the holder ends; a dead holder (or a reused pid, Linux) is stale and taken over at once (2.58.5: no such lock, heavy runs overlapped)', () => [
        h.up && busy.short?.err?.code === 'HEAVY_BUSY' && /holder-259d/.test(busy.short.err.msg) && /holder-259d/.test(busy.short.logs) && !busy.short.got
          && busy.long?.held === 'machine-heavy-1.lock' && busy.long.waitedMs > 300 && /waits for the machine:heavy lock.*holder-259d/.test(busy.long.logs) && /got the machine:heavy lock/.test(busy.long.logs)
          && stale.dead?.held === 'machine-heavy-1.lock' && stale.dead.ms < 1500 && (process.platform !== 'linux' || (stale.reused?.listed === 0 && stale.reused?.held === 'machine-heavy-1.lock')),
        JSON.stringify({ up: h.up, busy, stale }).slice(0, 2500)]);
    }

    // ---------- #11a + #11b: verify takes machine:heavy; one full verify per checkout ----------
    {
      fs.writeFileSync(gatesFile, JSON.stringify({ gates: [
        { id: 'quick', command: `node "${sleepF}" 100`, required: true, lite: true },
        { id: 'slowish', command: `node "${sleepF}" ${Math.round(3500 * SLOW)}`, required: true, lite: true },
      ] }, null, 2));
      const lastFull = path.join(dir, '.studio', 'gates-last-full.json');
      const verify = (env = {}, args = '') => run(dir, `node scripts/run-gates.mjs ${args}`, { ...base, ...env });

      // A full verify while another heavy holder runs: it waits, names it, and fails clearly; --only quick (not heavy) runs.
      const h = holder(6000 * SLOW);
      fs.rmSync(lastFull, { force: true });
      const blocked = verify({ STUDIO_HEAVY_WAIT_MIN: '0.03' });
      const noRecord = !fs.existsSync(lastFull);
      const partial = verify({ STUDIO_HEAVY_WAIT_MIN: '0.03' }, '--only quick');
      h.gone();
      const h2 = holder(1500 * SLOW);
      const waited = verify({ STUDIO_HEAVY_WAIT_MIN: '1' });
      h2.gone();
      guard('#11a: a full verify takes machine:heavy: beside a live holder it waits naming it, then fails clearly with no record written; a partial non-heavy run (--only quick) doesn\'t wait (2.58.5: it ran on top of the other heavy work)', () => [
        h.up && blocked.status === 1 && /machine:heavy/.test(out(blocked)) && /holder-259d/.test(out(blocked)) && /did not run/.test(out(blocked)) && noRecord && partial.status === 0 && !/machine:heavy/.test(out(partial)),
        JSON.stringify({ up: h.up, blocked: out(blocked).slice(-900), partial: out(partial).slice(-500) })]);
      guard('#11a: a waiting verify runs once the holder ends (it waits rather than failing, up to its limit)', () => [
        h2.up && waited.status === 0 && /waits for the machine:heavy lock/.test(out(waited)) && /got the machine:heavy lock/.test(out(waited)),
        out(waited).slice(-900)]);

      // #11b: two full verifies of one checkout (owners a and b, both in their shell's own process).
      const fullF = path.join(dir, '.studio', 'verify-running', 'full.json');
      const first = spawn(process.execPath, ['scripts/run-gates.mjs'], { cwd: dir, env: { ...process.env, ...base, STUDIO_LOCK_OWNER: 'loop-a' }, stdio: 'ignore' });
      kids.push(first);
      const upA = until(() => readJson(fullF)?.owner === 'loop-a', 15000 * SLOW);
      const second = verify({ STUDIO_LOCK_OWNER: 'loop-b' });
      const waitB = run(dir, 'node scripts/run-gates.mjs --wait', { ...base, STUDIO_LOCK_OWNER: 'loop-b' });
      // Its exit code can't be read here (this process blocks, so it isn't reaped): its own record says how it ended.
      const cleared = until(() => !fs.existsSync(fullF), 30000 * SLOW);
      const recA = readJson(path.join(dir, '.studio', 'gates', 'loop-a-full.json'));
      const firstGreen = Boolean(recA?.rows?.length === 2 && recA.rows.every((r) => r.ok));
      // A record left by a verify whose shell died: ignored.
      fs.mkdirSync(path.dirname(fullF), { recursive: true });
      fs.writeFileSync(fullF, JSON.stringify({ pid: 999999, identity: { start: 1 }, owner: 'killed-shell', args: [], startedAt: new Date().toISOString() }));
      const afterStale = verify({ STUDIO_LOCK_OWNER: 'loop-b' });
      guard('#11b: a second full verify of the same checkout while one runs is refused naming the holder and npm run verify -- --wait; the first finishes and clears its record; a dead verify\'s record is ignored (evidence: a stopped verify loop\'s child ran a second full verify beside the first; 2.58.5 ran both)', () => [
        upA && second.status === 1 && /refused: a full verify of this checkout is already running: loop-a/.test(out(second)) && /npm run verify -- --wait/.test(out(second)) && !/PASS {2}slowish/.test(out(second))
          && firstGreen && cleared && afterStale.status === 0 && /2\/2 passed/.test(out(afterStale)) && !fs.existsSync(fullF),
        JSON.stringify({ upA, second: out(second).slice(-700), recA: recA?.rows, cleared, afterStale: out(afterStale).slice(-400) })]);
      guard('#11b: npm run verify -- --wait (another owner) shows the full verify running in the checkout and exits with its result (2.58.5: "no verify has run apart for loop-b", exit 1)', () => [
        waitB.status === 0 && /the full verify running in this checkout is loop-a's/.test(out(waitB)) && /all required gates green/.test(out(waitB)),
        out(waitB).slice(-700)]);
    }

    // ---------- #11c: RAM floor ----------
    {
      const sup = (mb) => probe(`import { supervise } from ${u('harness/supervisor.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const starts = [];
const deps = { sessions: () => [], startAgent: (o) => { starts.push(o.agent); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'ram${mb}-', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ started: r.started, why: r.why, starts, events: readRecentEvents(500).filter((e) => e.type === 'supervisor.ram_low').length }));`, { STUDIO_TEST_FREEMEM_MB: String(mb), STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '' });
      run(dir, 'node harness/task.mjs add "Build the memory floor probe" --role builder', base);
      const low = sup(1024);
      const low2 = sup(1024);
      const high = sup(16384);
      guard('#11c: under STUDIO_RAM_FLOOR_GB (3) free memory the supervisor pass starts no agent and says why (one line per pass, one supervisor.ram_low event, not repeated on the next pass); with enough free memory it starts them (2.58.5: started regardless)', () => [
        Array.isArray(low.started) && low.started.length === 0 && low.starts.length === 0 && low.why.filter((w) => /free memory 1 GB is under the floor \(STUDIO_RAM_FLOOR_GB=3\)/.test(w)).length === 1 && low.events === 1 && low2.events === 1
          && high.starts?.length > 0 && !high.why.some((w) => /free memory/.test(w)),
        JSON.stringify({ low, low2: { events: low2.events }, high: { starts: high.starts, why: high.why } }).slice(0, 2000)]);
    }

    // ---------- #2: a game check's timeout scaled for load ----------
    {
      write('game/heavy259/studio.gates.json', JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" ${Math.round(2600 * SLOW)}`, required: true }] }));
      const genv = { STUDIO_GAME: 'heavy259', STUDIO_GAME_GATE_TIMEOUT_MS: String(Math.round(2000 * SLOW)), STUDIO_GAME_GATE_CI: 'off' };
      const gg = (env = {}) => {
        const r = run(dir, 'node harness/game-gates.mjs --json', { ...base, ...genv, ...env });
        let j = null;
        try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
        return { r, j };
      };
      const quiet = gg();
      const h = holder(10000 * SLOW);
      const busy = gg();
      write('game/heavy259/studio.gates.json', JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" 60000`, required: true }] }));
      const hang = gg();
      h.gone();
      const base2 = Math.round(2000 * SLOW / 1000);
      guard('#2: with another heavy job live, a game check\'s timeout is scaled (base x 2), printed with the reason and kept in its row, so a check that needs 2.6 s of a 2 s budget passes; on a quiet machine the base stands (2.58.5: timed out at the base under load)', () => [
        quiet.j?.ok === false && /timed out after/.test(JSON.stringify(quiet.j)) && !/x \d/.test(out(quiet.r))
          && h.up && busy.j?.ok === true && busy.j.rows?.[0]?.timeoutMs === 2 * Math.round(2000 * SLOW) && /holder-259d/.test(busy.j.rows[0].timeoutWhy || '')
          && new RegExp(`\\[game-gates\\] game:nap: timeout ${2 * base2} s \\(${base2} s x 2: 1 other heavy job running`).test(out(busy.r)),
        JSON.stringify({ quiet: quiet.j, busy: busy.j, busyErr: String(busy.r.stderr).slice(-600) }).slice(0, 2500)]);
      guard('#2: a real hang still fails, at the scaled value, and says so ("timed out after 4 s (... 2 s x 2 for load)")', () => [
        hang.j?.ok === false && new RegExp(`timed out after ${2 * base2} s \\(STUDIO_GAME_GATE_TIMEOUT_MS ${base2} s x 2 for load\\)`).test(JSON.stringify(hang.j)),
        JSON.stringify(hang.j).slice(0, 1500)]);
      fs.rmSync(path.join(dir, 'game', 'heavy259'), { recursive: true, force: true });
    }

    // ---------- #16: the Unity gate ----------
    {
      const stub = path.join(tmpRoot, `unity-land-259d-${process.pid}.mjs`);
      fs.writeFileSync(stub, `import fs from 'node:fs';
const locks = fs.readdirSync(${JSON.stringify(path.join(dir, '.studio', 'locks'))}).filter((f) => f.startsWith('machine-heavy-') && f.endsWith('.lock'));
console.log('land ' + process.argv.slice(2).join(' ') + ' heavy=' + locks.join(',') + ' held=' + (process.env.STUDIO_HEAVY_HELD ? 'yes' : 'no'));
process.exit(Number(process.env.UNITY_STUB_CODE ?? 0));
`);
      const ugate = (env = {}, args = '--branch feat/dock --json') => {
        const r = run(dir, `node harness/unity-gate.mjs ${args}`, { ...base, ...env });
        let j = null;
        try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
        return { code: r.status, j, text: out(r) };
      };
      // No land command: skipped with a note.
      fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: {} }, null, 2));
      const skipped = ugate();
      guard('#16: with no Unity land command (studio/game.json engines.unity.land) the Unity gate is skipped with a note and exits 0 (2.58.5: no such gate)', () => [
        skipped.code === 0 && skipped.j?.status === 'skipped' && /no Unity land command is configured/.test(skipped.j.why || ''),
        skipped.text.slice(-600)]);
      fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: { unity: { land: `node "${stub}" {branch}` } } }, null, 2));
      const codes = {};
      for (const c of [0, 1, 2, 3, 4, 9]) codes[c] = ugate({ UNITY_STUB_CODE: String(c) });
      const want = { 0: ['pass', 0], 1: ['red', 1], 2: ['conflict', 1], 3: ['refused', 3], 4: ['error', 1], 9: ['error', 1] };
      const mapped = Object.entries(want).every(([c, [s, x]]) => codes[c].j?.status === s && codes[c].code === x && codes[c].j.code === Number(c));
      const ranLocked = /land feat\/dock heavy=machine-heavy-1\.lock held=yes/.test(codes[1].j?.tail || '');
      const h = holder(6000 * SLOW);
      const blocked = ugate({ STUDIO_HEAVY_WAIT_MIN: '0.03', UNITY_STUB_CODE: '0' });
      h.gone();
      const rec = readJson(path.join(dir, '.studio', 'gates', 'unity-last.json'));
      guard('#16: the Unity gate runs the configured command ({branch} filled) under machine:heavy and maps 0 pass, 1 red, 2 conflict, 3 refused, 4 and others error (CLI exit 0/1/1/3/1/1); beside a live heavy holder it is refused (busy, exit 3), naming it; each run is recorded', () => [
        mapped && ranLocked && h.up && blocked.code === 3 && blocked.j?.status === 'refused' && /holder-259d/.test(blocked.j.why || '') && rec?.status === 'refused',
        JSON.stringify({ codes: Object.fromEntries(Object.entries(codes).map(([c, v]) => [c, { code: v.code, status: v.j?.status, tail: v.j?.tail }])), blocked: blocked.j, rec }).slice(0, 2500)]);

      // task done on a Unity-track task runs it ({task} filled in; this copy has no git branch to fill {branch}).
      fs.writeFileSync(gameJson, JSON.stringify({ ...(gameBefore ? JSON.parse(gameBefore) : {}), engines: { unity: { land: `node "${stub}" {task}` } } }, null, 2));
      const denv = { STUDIO_DONE_GAME_GATES: 'skip', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_REACHABILITY: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_WEAKENED_TESTS: 'off' };
      const add = (title, track) => (run(dir, `node harness/task.mjs add "${title}" --role engine-porter${track ? ` --track ${track}` : ''}`, { ...base, ...denv }).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
      const tu = add('Plan the Unity port of the dock rules', 'engine:unity');
      const tw = add('Plan the web dock tooltip copy', null);
      run(dir, `node harness/task.mjs start ${tu} --agent porter-259d`, { ...base, ...denv });
      const red = run(dir, `node harness/task.mjs done ${tu} --agent porter-259d`, { ...base, ...denv, UNITY_STUB_CODE: '1' });
      const busy = run(dir, `node harness/task.mjs done ${tu} --agent porter-259d`, { ...base, ...denv, UNITY_STUB_CODE: '3' });
      const green = run(dir, `node harness/task.mjs done ${tu} --agent porter-259d`, { ...base, ...denv, UNITY_STUB_CODE: '0' });
      run(dir, `node harness/task.mjs start ${tw} --agent porter-259e`, { ...base, ...denv });
      const before = readJson(path.join(dir, '.studio', 'gates', 'unity-last.json'))?.at;
      const web = run(dir, `node harness/task.mjs done ${tw} --agent porter-259e`, { ...base, ...denv, UNITY_STUB_CODE: '1' });
      const afterWeb = readJson(path.join(dir, '.studio', 'gates', 'unity-last.json'))?.at;
      const doneMd = fs.existsSync(path.join(dir, 'studio', 'DONE.md')) ? fs.readFileSync(path.join(dir, 'studio', 'DONE.md'), 'utf8') : '';
      guard('#16: task done on a task added with --track engine:unity runs the Unity gate: red keeps it open ("the Unity gate says red"), a refusal says busy and "run task done again later", a pass closes it; a task off the Unity track never runs it (2.58.5: closed without it)', () => [
        tu && red.status !== 0 && /the Unity gate says red/.test(out(red)) && new RegExp(`land ${tu} heavy=machine-heavy-1\\.lock held=yes`).test(out(red)) && busy.status !== 0 && /the Unity gate is busy/.test(out(busy)) && /Run task done again later/.test(out(busy))
          && green.status === 0 && new RegExp(`\\*\\*${tu}\\*\\*`).test(doneMd) && web.status === 0 && before === afterWeb,
        JSON.stringify({ tu, tw, red: out(red).slice(-500), busy: out(busy).slice(-400), green: out(green).slice(-400), web: out(web).slice(-300), before, afterWeb })]);
    }
  } finally {
    for (const c of kids) { try { if (c.exitCode === null) c.kill(); } catch {} }
    fs.writeFileSync(gatesFile, gatesBefore);
    if (gameBefore === null) fs.rmSync(gameJson, { force: true }); else fs.writeFileSync(gameJson, gameBefore);
    fs.rmSync(sleepF, { force: true });
  }
}
