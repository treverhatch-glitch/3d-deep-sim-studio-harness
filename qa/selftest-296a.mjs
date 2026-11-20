/**
 * qa/selftest-296a.mjs — 2.96 (a): every run the harness starts is measured, and heavy work can be admitted by what it
 * measured. Before, memory came from static claims and floors (a land run waited for 18.8-21 GB, the size of a stage it
 * skips), a test command's own peak file was wrong, quick tests were not counted, and nothing knew a run's CPU. Here: a
 * run's tree is sampled into a CSV (a grandchild's memory too; a helper that dies or prints rubbish changes nothing);
 * costs per kind come from the samples; with studio/game.json machine.admit "measured" a job waits while its need does
 * not fit beside the running jobs' remaining growth (and the CPU cap), starts when it does, and a pair slower together
 * stops overlapping; with the setting off every decision is 2.95's. Scaffolding as qa/selftest-295d.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, gitUserCrlfOf, gEnvOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest296A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '3', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_HEAVY_POLL_MS: '100', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `296a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (j) => write(S, 'studio/game.json', `${JSON.stringify(j, null, 2)}\n`);
  setGame({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-296a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const kids = [];
  const sDir = path.join(S, '.studio', 'engine', 'unity-samples');
  // Fake runs have pids no process has (ended wrappers); a live pid stands for a run going on.
  const livePid = () => { const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300000)'], { windowsHide: true, stdio: 'ignore' }); kids.push(c); return c.pid; };
  let fakePid = 2000000000;
  const csv = (name, { kind, pid = (fakePid += 1), at, gbs, cpu = 5, everyMs = 10000, end = 0, ppid = 1, engine = 'unity' }) => {
    const rows = gbs.map((gb, i) => `${at + i * 60000},20,,,${40},${gb},${cpu},3`).join('\n');
    fs.mkdirSync(sDir, { recursive: true });
    fs.writeFileSync(path.join(sDir, `${name}.csv`), `# ${JSON.stringify({ v: 1, kind, engine, pid, ppid, at, everyMs })}\nt,availGb,commitUsedGb,commitLimitGb,cpuPct,treeGb,treeCpuPct,procs\n${rows}\n${end === null ? '' : `# end ${JSON.stringify({ at: at + gbs.length * 60000, code: end })}\n`}`);
  };
  const resetCosts = () => { fs.rmSync(sDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(path.join(S, '.studio', 'engine-ram.json'), { force: true }); };
  const H = Date.now() - 6 * 3600000;

  try {
    // ---- 1. samples for every run ----
    const R1 = probe(`import { runLimitedSync } from ${u('harness/run-limited.mjs')};
import { runSample, readRun, summarize } from ${u('harness/run-cost.mjs')};
const sample = runSample(process.cwd(), 'unity', 'quick', { label: 'a quick test' });
sample.everyMs = 200;
// A shell, a node, and its child that holds the memory (a child of a child).
const inner = "const b = Buffer.alloc(300 * 1024 * 1024, 1); setTimeout(() => { b[0] = 2; }, 2500)";
const r = runLimitedSync(process.execPath + ' -e ' + JSON.stringify("require('child_process').spawnSync(process.execPath, ['-e', " + JSON.stringify(inner) + "], { stdio: 'inherit', windowsHide: true }); console.log('done-ok')"), { sample, encoding: 'utf8', timeoutMs: 120000 });
const run = readRun(sample.file);
console.log(JSON.stringify({ status: r.status, out: String(r.stdout), file: sample.file.split('unity-samples')[1], kind: run?.meta?.kind, rows: run?.rows?.length, ended: Boolean(run?.end), code: run?.end?.code, sum: run ? summarize(run) : null}));`);
    await guard('2.96 (a1) a run started with runSample is sampled into .studio/engine/unity-samples/<run>.csv: its kind, rows while it ran and an end line with its exit code; the run itself is unchanged (fails before this fix: nothing sampled a run)', () => [
      R1.status === 0 && /done-ok/.test(R1.out || '') && R1.kind === 'quick' && R1.rows >= 3 && R1.ended && R1.code === 0, JSON.stringify(R1)]);
    await guard('2.96 (a2) the tree\'s peak is found when a child of a child holds the memory (300 MB in a grandchild of the run: peak over 0.2 GB) (fails before this fix: the test command\'s own peak file was the only number, and it was wrong)', () => [
      R1.sum && R1.sum.peakGb >= 0.2 && R1.sum.peakGb < 2, JSON.stringify(R1.sum)]);

    const R3 = probe(`import fs from 'node:fs';
import { runLimitedSync } from ${u('harness/run-limited.mjs')};
import { readRun } from ${u('harness/run-cost.mjs')};
fs.writeFileSync('rubbish-helper.mjs', "process.stdout.write('S|x|y\\\\nnot a sample\\\\n\\\\u0000\\\\u0001\\\\n'); setTimeout(() => process.exit(3), 100);");
fs.writeFileSync('good-helper.mjs', "let n = 0; const t = setInterval(() => { n++; console.log('S|' + Date.now() + '|8589934592|17179869184|34359738368|50|1073741824|100|4'); if (n > 50) clearInterval(t); }, 100);");
const cmd = process.execPath + ' -e "setTimeout(() => console.log(42), 1200)"';
const a = runLimitedSync(cmd, { sample: { file: 'a.csv', meta: { kind: 'x', engine: 'unity' }, everyMs: 100, helper: 'rubbish-helper.mjs' }, encoding: 'utf8', timeoutMs: 60000 });
const b = runLimitedSync(cmd, { sample: { file: 'no-such-dir/b.csv', meta: { kind: 'x' }, everyMs: 100 }, encoding: 'utf8', timeoutMs: 60000 });
const c = runLimitedSync(cmd, { sample: { file: 'c.csv', meta: { kind: 'x', engine: 'unity' }, everyMs: 100, helper: 'good-helper.mjs' }, encoding: 'utf8', timeoutMs: 60000 });
const ra = readRun('a.csv'); const rc = readRun('c.csv');
console.log(JSON.stringify({ a: [a.status, String(a.stdout).trim()], b: [b.status, String(b.stdout).trim()], c: [c.status, String(c.stdout).trim()], aRows: ra?.rows.length, aEnd: Boolean(ra?.end), cRows: rc?.rows.length, cRow: rc?.rows[0] }));`);
    await guard('2.96 (a3) a sampler helper that prints rubbish and dies, or a samples file that cannot be written, never fails the run: same exit code and output; a helper\'s one-line-per-sample protocol is read (Windows\' helper stands in: 1 GB tree, 8 GB free, commit 16 of 32 GB) (fails before this fix: no sampler)', () => [
      R3.a?.[0] === 0 && R3.a[1] === '42' && R3.b?.[0] === 0 && R3.b[1] === '42' && R3.c?.[0] === 0 && R3.c[1] === '42' && R3.aRows === 0 && R3.aEnd && R3.cRows >= 3 && Math.abs(R3.cRow.treeGb - 1) < 0.01 && Math.abs(R3.cRow.availGb - 8) < 0.01 && Math.abs(R3.cRow.commitLimitGb - 32) < 0.01, JSON.stringify(R3)]);

    // ---- 2. costs per kind, pruning ----
    resetCosts();
    for (let i = 0; i < 3; i += 1) csv(`r${i}`, { kind: 'rules', at: H + i * 7200000, gbs: [1, 1, 11.5, 1, 1, 1], cpu: 5, end: i === 2 ? 1 : 0 });
    csv('l0', { kind: 'land no-rules', at: H + 30 * 60000, gbs: [2, 4, 9.6], cpu: 30 });
    csv('only-red', { kind: 'compile', at: H, gbs: [2, 3], end: 1 });
    for (let i = 0; i < 64; i += 1) csv(`old${i}`, { kind: 'quick', at: Date.now() - (15 * 86400000) - i * 1000, gbs: [0.5] });
    const R4 = probe(`import fs from 'node:fs';
import { foldRuns, kindCost } from ${u('harness/run-cost.mjs')};
const e = foldRuns(process.cwd(), 'unity');
const left = fs.readdirSync('.studio/engine/unity-samples').length;
console.log(JSON.stringify({ rules: kindCost(e, 'rules'), land: kindCost(e, 'land no-rules'), compile: kindCost(e, 'compile'), quick: kindCost(e, 'quick'), left, peaks: Object.keys(JSON.parse(fs.readFileSync('.studio/engine-ram.json', 'utf8')).unity) }));`);
    await guard('2.96 (a4) costs per kind from the samples, kept in .studio/engine-ram.json beside the land peaks: rules peak 11.5 GB (reserves 12.7), CPU 5%, 6 min, peak in the middle; a land run without the rules stage on its own kind; a kind with no passing run is not used (fails before this fix: no cost per kind)', () => [
      R4.rules?.peakGb === 11.5 && R4.rules.needGb === 12.7 && R4.rules.cpuPct === 5 && R4.rules.minutes === 6 && R4.rules.when === 'middle' && R4.rules.measured && R4.land?.peakGb === 9.6 && R4.land.when === 'end' && R4.compile && !R4.compile.measured && R4.peaks.includes('kinds'), JSON.stringify(R4)]);
    await guard('2.96 (a5) samples are pruned: files older than 14 days go (64 of them), the newest stay (fails before this fix: nothing to prune)', () => [
      R4.left === 5, JSON.stringify({ left: R4.left })]);

    // ---- 3. admission by reservation ----
    const decide = (extra, env = {}) => probe(`import { measuredAdmit } from ${u('harness/run-cost.mjs')};
console.log(JSON.stringify(measuredAdmit({ root: process.cwd(), engine: 'unity', ${extra} })));`, env);
    setGame({ machine: { admit: 'measured' } });
    const landPid = livePid();
    csv('land-now', { kind: 'land no-rules', pid: landPid, at: Date.now() - 60000, gbs: [5.5], cpu: 30, end: null, everyMs: 600000 });
    fs.writeFileSync(path.join(sDir, 'land-now.csv'), fs.readFileSync(path.join(sDir, 'land-now.csv'), 'utf8').replace(/\n(\d+),/, `\n${Date.now() - 1000},`));
    const wait1 = decide("kind: 'rules', label: 'the rules check', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(20 * 1024) });
    await guard('2.96 (a6) with machine.admit "measured" a rules check (11.5 GB peak) waits beside a land run that still has to grow, and says so in numbers: needs 12.7 GB, 17 GB free above the floor, the land run still has 5.1 GB to grow (fails before this fix: static claims and floors, no growth counted)', () => [
      wait1.decided && !wait1.ok && wait1.area === 'ram' && /needs 12\.7 GB, 17 GB free above the floor; land no-rules still has 5\.1 GB to grow/.test(wait1.line), JSON.stringify(wait1)]);
    const big = decide("kind: 'rules', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(55 * 1024) });
    await guard('2.96 (a7) the same two jobs on a machine with 64 GB (55 GB free, stubbed) run together: the reservation fits, no special case (fails before this fix: one heavy slot by count)', () => [
      big.decided && big.ok && /fits/.test(big.line), JSON.stringify(big)]);
    fs.appendFileSync(path.join(sDir, 'land-now.csv'), `# end ${JSON.stringify({ at: Date.now(), code: 0 })}\n`);
    const after = decide("kind: 'rules', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(20 * 1024) });
    await guard('2.96 (a8) once the land run has ended the rules check starts on the same free RAM (fails before this fix: no measured admission)', () => [
      after.decided && after.ok, JSON.stringify(after)]);
    const cpu1 = decide("kind: 'land no-rules', cpuNowPct: 60", { STUDIO_TEST_FREEMEM_MB: String(40 * 1024) });
    setGame({ machine: { admit: 'measured', cpuCapPct: 95 } });
    const cpu2 = decide("kind: 'land no-rules', cpuNowPct: 60", { STUDIO_TEST_FREEMEM_MB: String(40 * 1024) });
    setGame({ machine: { admit: 'measured' } });
    await guard('2.96 (a9) the CPU cap holds a job back: 60% busy plus the land run\'s measured 30% is over the default 85% cap and it waits for CPU; with machine.cpuCapPct 95 it starts (fails before this fix: CPU was counted in threads claimed, never measured)', () => [
      cpu1.decided && !cpu1.ok && cpu1.area === 'cpu' && /60% busy now plus its 30% is over the 85% cap/.test(cpu1.line) && cpu2.ok, JSON.stringify({ cpu1, cpu2 })]);
    const none = decide("kind: 'rules Sim/Move', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(24 * 1024) });
    const red = decide("kind: 'compile', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(24 * 1024) });
    const hand = decide("kind: 'rules', handGb: 30, cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(24 * 1024) });
    await guard('2.96 (a10) a kind with no number (or no passing run) is left to today\'s rule and says so; rules.focus.splitGb set by hand (30 GB) wins over the measured 12.7 GB (fails before this fix: no measured numbers to fall back from)', () => [
      !none.decided && /has no measured peak yet .*today's rule decides/.test(none.why) && !red.decided && hand.decided && !hand.ok && hand.needGb === 30, JSON.stringify({ none, red, hand })]);
    const wrongPid = livePid();
    csv('wrong-now', { kind: 'rules', pid: wrongPid, at: Date.now() - 1000, gbs: [14], end: null, everyMs: 600000 });
    fs.writeFileSync(path.join(sDir, 'wrong-now.csv'), fs.readFileSync(path.join(sDir, 'wrong-now.csv'), 'utf8').replace(/\n(\d+),/, `\n${Date.now() - 500},`));
    const wrong = decide("kind: 'land no-rules', cpuNowPct: 20", { STUDIO_TEST_FREEMEM_MB: String(60 * 1024) });
    fs.rmSync(path.join(sDir, 'wrong-now.csv'), { force: true });
    await guard('2.96 (a11) a running job above its own measured need (14 GB now, 12.7 GB measured) makes the numbers doubtful: today\'s rule decides, never more on a guess (fails before this fix: no check)', () => [
      !wrong.decided && /looks wrong/.test(wrong.why), JSON.stringify(wrong)]);

    const holdPid = livePid();
    const held = decide(`kind: 'rules', cpuNowPct: 20, holders: [{ pid: ${holdPid}, label: 'unity land', claim: { kind: 'unity', ramGb: 8 }, measure: { engine: 'unity', kind: 'land no-rules' } }]`, { STUDIO_TEST_FREEMEM_MB: String(20 * 1024) });
    await guard('2.96 (a17) a land run that holds its slot but has no sample yet counts its measured need (10.6 GB), not its 8 GB claim, so a rules check (12.7 GB) waits on 17 GB above the floor (fails before this fix: only static claims counted)', () => [
      held.decided && !held.ok && /unity land is counted at 10\.6 GB \(no sample of it yet\)/.test(held.line), JSON.stringify(held)]);

    // runParts: the measured number beats rules.peak (20 GB would wait; the measured decision admits).
    const R12 = probe(`import { runParts } from ${u('harness/rules-parts.mjs')};
const start = () => new Promise((r) => setTimeout(() => r({ status: 'pass' }), 300));
const parts = [{ filter: 'a', gb: 20 }, { filter: 'b', gb: 20 }];
const old = await runParts({ parts, start, max: 2, gb: 4, floorGb: 3, freeGb: () => 16, pollMs: 50 });
const now = await runParts({ parts, start, max: 2, gb: 4, floorGb: 3, freeGb: () => 16, pollMs: 50, admitPart: () => ({ decided: true, ok: true, line: 'measured: needs 1.6 GB, 13 GB free above the floor: it fits' }) });
console.log(JSON.stringify({ old: old.atOnce, now: now.atOnce, said: now.decisions }));`);
    await guard('2.96 (a12) the measured number beats rules.peak: a part whose rules.peak says 20 GB waits on 16 GB free, the same part admitted by its measured need runs beside the first (fails before this fix: rules.peak always decided)', () => [
      R12.old === 1 && R12.now === 2 && R12.said.some((l) => /measured: needs 1\.6 GB/.test(l)), JSON.stringify(R12)]);

    // acquireHeavy: off is 2.95 (the land floor holds it back on 4.5 GB free); on, its measured 1 GB starts it.
    csv('lw', { kind: 'land with-rules', at: H, gbs: [0.2, 0.5], cpu: 0 });
    const take = (env) => probe(`import { acquireHeavy } from ${u('harness/heavy.mjs')};
let res;
try { const lk = acquireHeavy(process.cwd(), 'unity land', { env: process.env, kind: 'unity', engine: 'unity', minFreeGb: 12, waitMin: 0.02, measure: { engine: 'unity', kind: 'land with-rules' }, log: (m) => console.error(m) }); res = { ok: true }; lk.release(); } catch (e) { res = { ok: false, floor: Boolean(e.floor), msg: e.message }; }
console.log(JSON.stringify(res));`, { STUDIO_TEST_FREEMEM_MB: '4608', STUDIO_HEAVY_SLOTS: '1', ...env });
    setGame({});
    const off1 = take();
    setGame({ machine: { admit: 'measured', cpuCapPct: 100 } });
    const on1 = take();
    await guard('2.96 (a13) with the setting off acquireHeavy decides as 2.95 (4.5 GB free under the 12 GB floor, or 60% of a small machine\'s RAM: not run); on, the land run\'s measured need (1 GB, 1.5 GB free above the floor; CPU cap 100% as this shared test machine is busy) starts it without the floor (fails before this fix: the floor and claims always decided)', () => [
      off1.ok === false && off1.floor === true && on1.ok === true, JSON.stringify({ off1, on1 })]);

    // ---- 4. overlap that does not pay ----
    resetCosts();
    for (let i = 0; i < 3; i += 1) csv(`ra${i}`, { kind: 'rules', at: H - 20 * 3600000 + i * 3600000, gbs: [1, 1, 1, 1, 1] });
    for (let i = 0; i < 3; i += 1) csv(`qa${i}`, { kind: 'quick', at: H - 10 * 3600000 + i * 3600000, gbs: [0.5, 0.5] });
    for (let i = 0; i < 3; i += 1) { const at = H + i * 3600000; csv(`rt${i}`, { kind: 'rules', at, gbs: [1, 1, 1, 1, 1, 1, 1] }); csv(`qt${i}`, { kind: 'quick', at: at + 60000, gbs: [0.5, 0.5] }); }
    const R14 = probe(`import { foldRuns } from ${u('harness/run-cost.mjs')};
const e = foldRuns(process.cwd(), 'unity');
console.log(JSON.stringify({ pairs: e.pairs }));`);
    const qPid = livePid();
    csv('quick-now', { kind: 'quick', pid: qPid, at: Date.now() - 1000, gbs: [0.2], end: null, everyMs: 600000 });
    fs.writeFileSync(path.join(sDir, 'quick-now.csv'), fs.readFileSync(path.join(sDir, 'quick-now.csv'), 'utf8').replace(/\n(\d+),/, `\n${Date.now() - 500},`));
    const pairWait = decide("kind: 'rules', cpuNowPct: 10", { STUDIO_TEST_FREEMEM_MB: String(60 * 1024) });
    const stoppedEv = evs(/^machine\.overlap_stopped$/);
    await guard('2.96 (a14) a pair slower together than alone by more than 10% after 3 runs each (rules: 7 min beside quick, 5 min alone: 40% slower) stops overlapping: one machine.overlap_stopped event with the numbers, and a rules check waits while a quick test runs, saying until when (fails before this fix: overlap was never checked)', () => [
      Object.keys(R14.pairs || {}).join() === 'quick + rules' && stoppedEv.length === 1 && /7 min beside quick \(3 runs\) and 5 min alone \(3 runs\): 40% slower/.test(stoppedEv[0].msg) && pairWait.decided && !pairWait.ok && pairWait.area === 'pair' && /do not run together until/.test(pairWait.line), JSON.stringify({ R14, ev: stoppedEv, pairWait })]);

    // ---- 5. show the numbers ----
    const R15 = probe(`import { runningLines, costLines } from ${u('harness/run-cost.mjs')};
import { unityStatusText } from ${u('harness/unity-train.mjs')};
import { unityLine } from ${u('harness/unity-gate.mjs')};
console.log(JSON.stringify({ running: runningLines(process.cwd()), costs: costLines(process.cwd(), 'unity'), status: unityStatusText(process.cwd(), { engine: 'unity' }), line: unityLine({ status: 'pass', engine: 'unity', why: 'passed and landed', ms: 61000, measured: { peakGb: 9.6, cpuPct: 31, minutes: 47 } }) }));`);
    await guard('2.96 (a15) train status shows each running job with its RAM and CPU now, its peak so far and its reservation; rules show lists each kind\'s measured peak, CPU and minutes and the setting; the land result line carries peak, CPU and minutes (fails before this fix: none of these numbers were shown)', () => [
      /Running quick: 0\.2 GB and 5% CPU now, 0\.2 GB at most so far; reservation 1 GB/.test(R15.status || '') && R15.costs?.some((l) => /^ {2}rules: peak 1 GB \(reserves 1\.5 GB\), CPU 5%, [\d.]+ min/.test(l)) && /measured admission: on/.test(R15.costs?.[0] || '') && R15.costs.some((l) => /not run together: quick \+ rules/.test(l)) && /\(61 s; peak 9\.6 GB, CPU 31%, 47 min\)/.test(R15.line || ''), JSON.stringify(R15)]);

    // The land run itself: sampled, its numbers in the result and the engine.land event.
    setGame({ engines: { unity: { land: `${JSON.stringify(process.execPath)} -e "const b = Buffer.alloc(200 * 1024 * 1024, 1); setTimeout(() => { b[0] = 1; }, 1500)"`, timeoutMin: 5 } }, machine: { sampleSec: 0.2 } });
    const R16 = probe(`import { runUnityGate } from ${u('harness/unity-gate.mjs')};
const r = await runUnityGate({ engine: 'unity', branch: 'feat-a', env: { ...process.env, STUDIO_RULES_GREEN: '1' } });
console.log(JSON.stringify({ status: r.status, measured: r.measured }));`, { STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_SLOTS: '1' });
    const landEv = evs(/^engine\.land$/).pop();
    await guard('2.96 (a16) a land run is sampled as its kind (rules green: "land no-rules"): its result and the engine.land event carry its peak RAM, mean CPU and minutes (fails before this fix: the event had only ms)', () => [
      R16.status === 'pass' && R16.measured?.peakGb >= 0.15 && landEv?.meta?.kind === 'land no-rules' && landEv.meta.peakGb >= 0.15 && Number.isFinite(landEv.meta.minutes), JSON.stringify({ R16, meta: landEv?.meta })]);
  } finally {
    for (const c of kids) { try { c.kill(); } catch { /* ended */ } }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
