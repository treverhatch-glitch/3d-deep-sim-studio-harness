/**
 * qa/selftest-2651a.mjs — 2.65.1 (helper a): the game check's load reading, a first run with no quiet time, and one
 * merge-tree helper for the lane table and the queue.
 *   B-17 (1): the load probe's reading is printed for every game check, scaled or not (load factor, reasons or "nothing
 *             scaling it", the CPU-busy sample, whether a quiet-run floor is recorded); loadFactor returns the busy
 *             fraction it measured.
 *   B-17 (2): a check with no quiet run recorded yet that times out gets self-triage's one re-run at the cap, logged as
 *             "no quiet run recorded yet"; a re-run's pass at load factor 1 is the quiet run, under load only its
 *             lastPass, which stands in for the floor until a quiet run is recorded.
 *   3:        harness/lanes.mjs and harness/train-predict.mjs share harness/merge-tree.mjs: one git version reading, the
 *             union-file exemption and file:line places in both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2651A({ dir, run, report, tmpRoot }) {
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-2651a.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_HELD: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_GAME: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_GAME_GATE_CI: 'off', STUDIO_GAME_GATE_TIMEOUT_MS: '', STUDIO_GAME_GATE_TIMEOUT_SCALE: '', STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR: '', STUDIO_GAME_GATE_TIMEOUT_FLOOR: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_TEST_TIMEOUT_SCALE: '', STUDIO_TEST_LOADAVG: '0', STUDIO_TEST_CPU_BUSY: '', STUDIO_CPU_PROBE: '', STUDIO_CPU_BUSY_THRESHOLD: '', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_PROC_LIST_STUB: '', STUDIO_SELF_TRIAGE: '', STUDIO_SILENT_GREEN: 'off', STUDIO_GATE_RELATED: '', STUDIO_WHOLE_GAME: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TEST_GIT_VERSION: '', STUDIO_TRAIN_PREDICT: '', npm_lifecycle_event: '', AGENT_EVENTS_FILE: events };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p2651a-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const sleepF = path.join(tmpRoot, `sleep-2651a-${process.pid}.mjs`);
  fs.writeFileSync(sleepF, 'setTimeout(() => { console.log("3 tests passed"); }, Number(process.argv[2] || 1000));\n');
  const timesF = path.join(dir, '.studio', 'gates', 'game-gate-times.json');
  const B = Math.round(2000 * SLOW); // the base timeout in the game checks below
  const bs = Math.round(B / 1000);
  const gameWith = (name, ms) => write(`game/${name}/studio.gates.json`, JSON.stringify({ gates: [{ id: 'nap', command: `node "${sleepF}" ${Math.round(ms * SLOW)}`, required: true }] }));
  const gg = (name, env = {}) => {
    const r = run(dir, 'node harness/game-gates.mjs --json', { ...base, STUDIO_GAME: name, STUDIO_GAME_GATE_TIMEOUT_MS: String(B), ...env });
    let j = null;
    try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    return { r, j, text: out(r) };
  };
  const readings = (text) => text.split('\n').filter((l) => /^\[game-gates\] \S+: load factor /.test(l));
  const scaledLine = /timeout \d+ s \(/; // the existing tests' meaning of "the timeout was scaled" (2601m, 258f)

  // ---------- B-17 (1): the reading, every time ----------
  {
    const lf = probe(`import { loadFactor } from ${u('harness/heavy.mjs')};
const env = { ...process.env, STUDIO_TEST_LOADAVG: '' };
const sampler = (busyMs) => { let k = 0; return () => { const i = k++; return [0, 1].map(() => ({ times: { user: 1000 + i * busyMs, nice: 0, sys: 0, irq: 0, idle: 5000 + i * (100 - busyMs) } })); }; };
const win = loadFactor(process.cwd(), { env, platform: 'win32', cpuSample: sampler(45), cpus: 2 });
const linux = loadFactor(process.cwd(), { env, platform: 'linux', loadavg: 0.4, cpus: 2 });
console.log(JSON.stringify({ win, linux }));`, { STUDIO_TEST_LOADAVG: '' });
    guard('B-17 (2.65.1): loadFactor returns the CPU busy fraction its probe measured (Windows, 45% busy: 0.45, factor still 1) and null where a load average is used instead (fails on 2.65.0: only { factor, why })', () => [
      Math.abs((lf.win?.busy ?? -1) - 0.45) < 0.001 && lf.win.factor === 1 && lf.linux?.busy === null && lf.linux?.load === 0.4 && lf.linux?.factor === 1,
      JSON.stringify(lf).slice(0, 1200)]);

    fs.rmSync(timesF, { force: true });
    gameWith('read2651', 300);
    const quiet = gg('read2651', { STUDIO_TEST_CPU_BUSY: '0.45' });
    const rq = readings(quiet.text);
    const busy = gg('read2651', { STUDIO_TEST_CPU_BUSY: '0.9' });
    const rb = readings(busy.text);
    const off = gg('read2651', { STUDIO_GAME_GATE_TIMEOUT_SCALE: 'off' });
    guard('B-17 (2.65.1): a game check that isn\'t scaled prints the probe\'s reading anyway: "load factor 1 (nothing scaling it)", the CPU sample (45% busy, threshold 60%), "quiet-run floor: none recorded yet" and "timeout 2 s, not scaled", in one line that the existing "timeout N s (" scaled-line test never matches (fails on 2.65.0: nothing printed, as on the crew\'s PC)', () => [
      quiet.j?.ok === true && rq.length === 1 && /load factor 1 \(nothing scaling it\)/.test(rq[0]) && /CPU 45% busy \(STUDIO_CPU_BUSY_THRESHOLD 60%\)/.test(rq[0])
        && /quiet-run floor: none recorded yet/.test(rq[0]) && new RegExp(`timeout ${bs} s, not scaled$`).test(rq[0]) && !scaledLine.test(quiet.text) && !/^\[game-gates\] \S+: timeout \d+ s \(/.test(rq[0]),
      quiet.text.slice(-1500)]);
    guard('B-17 (2.65.1): once a quiet run is recorded the reading says so (its time and the floor); under load the reading names the reason and the CPU sample and is followed by the scaled "timeout N s (" line, as before; STUDIO_GAME_GATE_TIMEOUT_SCALE=off says the factor was not measured (fails on 2.65.0: no reading line)', () => [
      busy.j?.ok === true && rb.length === 1 && /load factor \d\.\d \(CPU 90% busy/.test(rb[0]) && /quiet-run floor: recorded \(last quiet run \d+ s, .* UTC; floor \d+ s\)/.test(rb[0]) && !/not scaled/.test(rb[0])
        && new RegExp(`\\[game-gates\\] game:nap: timeout \\d+ s \\(${bs} s x `).test(busy.text) && readJson(timesF)?.['read2651:game:nap']?.ms > 0
        && readings(off.text).length === 1 && /load factor not measured \(STUDIO_GAME_GATE_TIMEOUT_SCALE=off\)/.test(readings(off.text)[0]) && !scaledLine.test(off.text),
      `${busy.text.slice(-1200)}\n---\n${off.text.slice(-600)}`]);
    fs.rmSync(path.join(dir, 'game', 'read2651'), { recursive: true, force: true });
  }

  // ---------- B-17 (2): a first run with no quiet time ----------
  {
    fs.rmSync(timesF, { force: true });
    // Quiet machine, a suite that needs 2.6 s of a 2 s base, never run before.
    gameWith('first2651', 2600);
    const g1 = gg('first2651');
    const rec1 = readJson(timesF)?.['first2651:game:nap'];
    const ev1 = evs().filter((e) => e.type === 'selftriage.rerun-timeout' && e.meta?.gate === 'first2651:game:nap');
    const g2 = gg('first2651');
    guard('B-17 (2.65.1): a game check with no quiet run recorded that times out at its base on a quiet machine (factor 1) runs once more at the cap (3 x 2 s), logged as self-triage with the reason "no quiet run recorded yet", and passes; that pass at factor 1 is recorded as its quiet run, so the next run passes first time with the floor (1.5 x it) and no re-run (fails on 2.65.0: "not a load timeout", red, never a floor)', () => [
      g1.j?.ok === true && /no quiet run recorded yet; once more at the cap, \d+ s/.test(g1.text) && new RegExp(`timed out after ${bs} s`).test(g1.text) === false
        && ev1.length === 1 && ev1[0].meta?.reason === 'no quiet run recorded yet' && ev1[0].meta?.rerunMs === 3 * B && /no quiet run recorded yet/.test(ev1[0].msg || '')
        && rec1?.ms >= 2600 * SLOW && rec1?.lastPass?.ms >= 2600 * SLOW
        && g2.j?.ok === true && g2.j.rows?.[0]?.timeoutMs === Math.min(3 * B, Math.round(rec1.ms * 1.5)) && !/once more at the cap/.test(g2.text) && /quiet-run floor: recorded/.test(g2.text),
      JSON.stringify({ rec1, ev1: ev1.map((e) => e.msg), g1: g1.text.slice(-1400), g2: g2.j?.rows }).slice(0, 3000)]);

    // Once per check per window, never past the cap; and a floor that is off asks for no re-run.
    fs.rmSync(timesF, { force: true });
    gameWith('first2651', 2600);
    const g3 = gg('first2651');
    gameWith('nofloor2651', 2600);
    const g4 = gg('nofloor2651', { STUDIO_GAME_GATE_TIMEOUT_FLOOR: 'off' });
    guard('B-17 (2.65.1): the no-quiet-run re-run is once per check per window (the same check timing out again with no quiet run gets "no re-run (already fixed once ..." and fails at the base) and only while the floor is on (STUDIO_GAME_GATE_TIMEOUT_FLOOR=off: no re-run, as in 2.65.0)', () => [
      g3.j?.ok === false && /no re-run \(already fixed once/.test(g3.text) && new RegExp(`timed out after ${bs} s`).test(g3.text)
        && g4.j?.ok === false && !/once more at the cap/.test(g4.text) && new RegExp(`timed out after ${bs} s`).test(g4.text)
        && evs().filter((e) => e.type === 'selftriage.rerun-timeout' && e.meta?.gate === 'first2651:game:nap').length === 1,
      `${g3.text.slice(-900)}\n---\n${g4.text.slice(-700)}`]);

    // A re-run that passes under load: its lastPass, not a quiet run; it stands in for the floor until one is recorded.
    fs.rmSync(timesF, { force: true });
    gameWith('load2651', 4600);
    const g5 = gg('load2651', { STUDIO_TEST_CPU_BUSY: '0.7' });
    const rec5 = readJson(timesF)?.['load2651:game:nap'];
    const g6 = gg('load2651', { STUDIO_TEST_CPU_BUSY: '0' });
    const rec6 = readJson(timesF)?.['load2651:game:nap'];
    const r6 = readings(g6.text)[0] || '';
    guard('B-17 (2.65.1): a re-run that passes under load (factor 1.9) records no quiet run, only its lastPass (4.6 s at factor 1.9); the next quiet run, which needs more than the base, gets the floor from that lastPass (capped at 3 x the base, the reading says it stands in) instead of timing out, and its pass at factor 1 becomes the quiet run (fails on 2.65.0: no lastPass, the quiet run times out at the base)', () => [
      g5.j?.ok === true && /once more at the cap/.test(g5.text) && !(rec5?.ms > 0) && rec5?.lastPass?.ms >= 4600 * SLOW && rec5.lastPass.factor > 1
        && g6.j?.ok === true && g6.j.rows?.[0]?.timeoutMs === 3 * B && /the last passing run, \d+ s at load factor 1\.9, stands in/.test(r6) && /no quiet run recorded yet\)/.test(g6.j.rows[0].timeoutWhy || '')
        && rec6?.ms >= 4600 * SLOW,
      JSON.stringify({ rec5, rec6, g5: g5.text.slice(-900), g6: g6.text.slice(-900), row: g6.j?.rows }).slice(0, 3000)]);
    for (const g of ['first2651', 'nofloor2651', 'load2651']) fs.rmSync(path.join(dir, 'game', g), { recursive: true, force: true });
    fs.rmSync(timesF, { force: true });
  }

  // ---------- 3: one merge-tree helper ----------
  {
    const repo = path.join(tmpRoot, `mt-2651a-${process.pid}`);
    fs.mkdirSync(repo, { recursive: true });
    for (const d of ['harness', 'scripts', 'qa', 'studio']) fs.cpSync(path.join(dir, d), path.join(repo, d), { recursive: true });
    fs.copyFileSync(path.join(dir, 'package.json'), path.join(repo, 'package.json'));
    fs.rmSync(path.join(repo, 'studio', 'game.json'), { force: true });
    const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const genv = () => { const e = { ...process.env, ...ident }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: genv() });
    const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
    w('game/uni/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node -e 0' }], unionFiles: ['game/uni/index.mjs'] }, null, 2)}\n`);
    w('game/uni/index.mjs', "export * from './a.mjs';\n");
    w('game/uni/real.txt', 'one\ntwo\nthree\nfour\n');
    g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
    g('add', '-A'); g('commit', '-qm', 'base', '--no-verify');
    const lane = (branch, rel, text) => { g('checkout', '-q', '-b', branch, 'main'); w(rel, text); g('add', '-A'); g('commit', '-qm', branch, '--no-verify'); g('checkout', '-q', 'main'); };
    lane('lane/u1', 'game/uni/index.mjs', "export * from './a.mjs';\nexport * from './u1.mjs';\n");
    lane('lane/u2', 'game/uni/real.txt', 'one\ntwo\nthree\nFOUR-U2\n');
    w('game/uni/index.mjs', "export * from './a.mjs';\nexport * from './main.mjs';\n");
    w('game/uni/real.txt', 'one\ntwo\nthree\nFOUR-MAIN\n');
    g('add', '-A', 'game'); g('commit', '-qm', 'main moves', '--no-verify');
    w('.studio/lane-branches.json', JSON.stringify({ 'T-901': 'lane/u1', 'T-902': 'lane/u2' }));
    const mtProbe = (env = {}) => {
      const f = path.join(tmpRoot, `mt-2651a-probe-${++n}.mjs`);
      fs.writeFileSync(f, `import { spawnSync } from 'node:child_process';
const at = (p) => new URL(p, ${JSON.stringify(pathToFileURL(`${repo}/`).href)}).href;
const { laneTable } = await import(at('harness/lanes.mjs'));
const tp = await import(at('harness/train-predict.mjs'));
const root = process.cwd();
const rev = (r) => spawnSync('git', ['rev-parse', r], { cwd: root, encoding: 'utf8' }).stdout.trim();
const t = await laneTable(root, { stamps: false });
const tip = rev('main');
const u1 = tp.predictLane(root, { lane: { task: 'T-901', head: rev('lane/u1') }, tip, unionFiles: ['game/uni/index.mjs'] });
const u2 = tp.predictLane(root, { lane: { task: 'T-902', head: rev('lane/u2') }, tip, unionFiles: ['game/uni/index.mjs'] });
const rows = Object.fromEntries(t.lanes.map((r) => [r.task, r.conflicts]));
console.log(JSON.stringify({ rows, notes: t.notes, u1: { mode: u1.mode, why: u1.why, main: u1.main, union: u1.union }, u2: { mode: u2.mode, why: u2.why, main: u2.main } }));`);
      const r = spawnSync(process.execPath, [f], { cwd: repo, encoding: 'utf8', env: { ...genv(), ...base, STUDIO_GAME: 'uni', AGENT_EVENTS_FILE: path.join(repo, '.studio', 'ev.jsonl'), ...env } });
      fs.rmSync(f, { force: true });
      try { return { ...JSON.parse(String(r.stdout).trim().split('\n').pop()), _out: out(r) }; } catch { return { _out: out(r).slice(-2000) }; }
    };
    const now = mtProbe();
    guard('3 (2.65.1): `npm run lanes` judges conflicts as the queue does (harness/merge-tree.mjs): a lane whose conflict with main is only in the manifest\'s unionFiles shows none (a note says the union driver merges it) where task done --train queues it clean, and a real conflict names file:line in both (fails on 2.65.0: the table listed the union file as a conflict, files only)', () => {
      const u1 = now.rows?.['T-901'] || null;
      const u2 = now.rows?.['T-902'] || null;
      return [Array.isArray(u1) && u1.length === 0 && now.notes?.some((x) => /game\/uni\/index\.mjs conflicts only as a union file/.test(x)) && now.u1?.mode === 'merge-tree' && now.u1.main === null && now.u1.union?.includes('game/uni/index.mjs')
        && u2?.[0]?.with === 'main' && u2[0].files?.includes('game/uni/real.txt') && u2[0].places?.some((p) => p.file === 'game/uni/real.txt' && p.line === 4)
        && now.u2?.main?.places?.some((p) => p.file === 'game/uni/real.txt' && p.line === 4),
      JSON.stringify(now).slice(0, 2500)];
    });
    const old = mtProbe({ STUDIO_TEST_GIT_VERSION: 'git version 2.37.1' });
    const ver = probe(`import { gitVersion, mergeTreeSupport } from ${u('harness/merge-tree.mjs')};
const a = gitVersion(); const b = gitVersion();
console.log(JSON.stringify({ a, same: a === b, old: mergeTreeSupport(process.cwd(), 'git version 2.37.1'), now: mergeTreeSupport(process.cwd(), 'git version 2.43.0') }));`);
    guard('3 (2.65.1): one git version reading for both (cached per process): with git 2.37 the table notes "git 2.37.1 has no merge-tree --write-tree (2.38+)" and the queue prediction is off with the same words; 2.38+ is supported (fails on 2.65.0: no harness/merge-tree.mjs, the table read its own version)', () => [
      old.notes?.some((x) => /^git 2\.37\.1 has no merge-tree --write-tree \(2\.38\+\): conflicts are predicted from overlapping changed lines/.test(x)) && old.u1?.mode === 'off' && old.u1.why === 'git 2.37.1 has no merge-tree --write-tree (2.38+)'
        && Array.isArray(ver.a) && ver.same === true && ver.old?.ok === false && ver.now?.ok === true,
      JSON.stringify({ old, ver }).slice(0, 2000)]);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
  }
}
