/**
 * qa/selftest-298g.mjs — 2.98 (e): disk. Idle lane copies are pruned when free disk is short (off unless
 * studio/game.json disk.pruneUnderGb is set), the lane copies' size is measured and carries its age, and `train cancel`
 * removes that train's rules checkouts. A studio copy, lane copies made by the harness, a made-up engine repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest298G({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298g-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_LANE_LIVE_MIN: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298g-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `298g-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (o) => write(S, 'studio/game.json', `${JSON.stringify(o, null, 2)}\n`);
  setGame({});
  // The studio's one commit is old, so a copy's idle time is its folder's own time (set below).
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A');
  spawnSync('git', ['commit', '-qm', 'studio', '--no-verify'], { cwd: S, windowsHide: true, env: { ...process.env, ...ident, GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' } });
  const evFile = path.join(S, '.studio', 'events-298g.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-298g-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const lane = (a) => path.join(S, '.lanes', a);
  const hoursAgo = (h) => { const t = (Date.now() - h * 3600000) / 1000; return t; };
  const make = (a, h) => {
    probe(`import { createLaneCopy } from ${u('harness/worktree.mjs')}; createLaneCopy(${JSON.stringify(a)}, { task: null }); console.log('{}');`);
    const t = hoursAgo(h); fs.utimesSync(lane(a), t, t);
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    write(S, `.studio/agents/${a}.json`, JSON.stringify({ agent: a, role: 'builder', task: null, status: 'done' }));
  };
  const landed = (...agents) => fs.appendFileSync(evFile, agents.map((a) => `${JSON.stringify({ type: 'lane.merged', agent: a, at: new Date().toISOString() })}\n`).join(''));
  // Free disk: starts at `start` GB and grows by `step` GB with each copy removed (the pass's own event).
  const SHORT = (start, step = 0) => `import { pruneWhenShort } from ${u('harness/janitor.mjs')}; import { emitEvent } from ${u('harness/event.mjs')};
let free = ${start}; const emit = (e) => { emitEvent(e); if (e.type === 'disk.pruned') free += ${step}; };
const r = await pruneWhenShort({ root: process.cwd(), freeGb: () => free, emit });
console.log(JSON.stringify({ off: r.off || false, short: r.short, removed: r.removed.map((x) => x.what), kept: r.kept }));`;
  const why = (r, name) => (r.kept || []).find((k) => k.what === `.lanes/${name}`)?.why || '';
  const procs = [];

  try {
    // ================= 1. prune when short =================
    for (const [a, h] of [['l-old', 5], ['l-dirty', 5], ['l-queued', 5], ['l-live', 5], ['l-open', 5], ['l-recent', 0]]) make(a, h);
    landed('l-old', 'l-dirty', 'l-queued', 'l-live', 'l-recent');
    write(lane('l-dirty'), 'docs/wip.md', 'half done\n');
    write(S, '.studio/train/queue.json', JSON.stringify([{ task: 'T-1', agent: 'l-queued', branch: 'lane/l-queued', head: 'abc', at: new Date().toISOString() }]));
    write(S, '.studio/locks/path_x.lock', JSON.stringify({ key: 'path:x', owner: 'l-live', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
    const sizeOld = probe(`import { measureTree } from ${u('harness/lane-disk.mjs')}; console.log(JSON.stringify(measureTree(${JSON.stringify(lane('l-old'))})));`);

    setGame({ disk: { pruneUnderGb: 60 } });
    const a = probe(SHORT(10));
    const pruned = evs(/^disk\.pruned$/);
    await guard('2.98 (g1) with disk.pruneUnderGb set and free disk under it, a landed, clean, idle copy is removed, with one event saying what, how big and why it was safe; a dirty one, a queued one, a live one, an unlanded one and a recent one are kept, each with its reason (fails before this fix: nothing was removed)', () => [
      a.short === true && a.removed?.join() === '.lanes/l-old' && !fs.existsSync(lane('l-old')) && sizeOld.bytes > 0
        && pruned.length === 1 && /l-old/.test(pruned[0].msg) && /Safe because/.test(pruned[0].msg) && pruned[0].meta?.bytes > 0
        && fs.existsSync(path.join(lane('l-dirty'), 'docs', 'wip.md')) && /uncommitted/.test(why(a, 'l-dirty'))
        && /queued for a train/.test(why(a, 'l-queued')) && /holds a claim/.test(why(a, 'l-live'))
        && /not landed/.test(why(a, 'l-open')) && /ago \(under/.test(why(a, 'l-recent')) && [...'l-queued l-live l-open l-recent'.split(' ')].every((n) => fs.existsSync(lane(n))),
      JSON.stringify({ a, pruned: pruned.map((e) => e.msg) })]);

    // ---- an engine copy that is not a registered worktree is never removed ----
    fs.mkdirSync(path.join(S, '.lanes', 'engine', 'T-9'), { recursive: true }); write(S, '.lanes/engine/T-9/a.txt', 'x');
    const eng = probe(SHORT(10));
    await guard('2.98 (g1b) an engine folder that is not a registered worktree of an engine repo is kept, with the test it failed', () => [
      fs.existsSync(path.join(S, '.lanes', 'engine', 'T-9', 'a.txt')) && (eng.kept || []).some((k) => k.what === '.lanes/engine/T-9' && /registered worktree/.test(k.why)), JSON.stringify(eng)]);
    fs.rmSync(path.join(S, '.lanes', 'engine'), { recursive: true, force: true });

    // ================= 2. off without the setting =================
    make('l-off', 5); landed('l-off');
    setGame({ disk: { idleHours: 1 } });
    const noLine = probe(SHORT(1));
    setGame({});
    const none2 = probe(SHORT(1));
    const pass2 = probe(`import { shortPass } from ${u('harness/lane-disk.mjs')}; const r = await shortPass({ root: process.cwd(), inline: true, freeGb: () => 1 }); console.log(JSON.stringify(r));`);
    setGame({ disk: { pruneUnderGb: 60 } });
    const over = probe(SHORT(500));
    const pass = probe(`import { shortPass } from ${u('harness/lane-disk.mjs')}; const r = await shortPass({ root: process.cwd(), inline: true, freeGb: () => 500 }); console.log(JSON.stringify(r));`);
    await guard('2.98 (g2) without disk.pruneUnderGb nothing is ever removed (a missing setting, one with no pruneUnderGb, free disk at 1 GB; also not through the supervisor\'s call), and with it set but free disk over the line nothing is removed either (fails before this fix: there was no setting)', () => [
      none2.off === true && noLine.off === true && over.short === false && pass.ran === false && pass2.ran === false && fs.existsSync(lane('l-off'))
        && evs(/^disk\.pruned$/).length === 1, JSON.stringify({ none2, noLine, over, pass, pass2 })]);

    // ================= 3. it stops once free disk is over the line =================
    setGame({ disk: { pruneUnderGb: 60, idleHours: 1 } });
    for (const [n, h] of [['l-s1', 9], ['l-s2', 8], ['l-s3', 7]]) make(n, h);
    landed('l-s1', 'l-s2', 'l-s3');
    const stop = probe(SHORT(40, 15));
    await guard('2.98 (g3) copies go oldest first and it stops once free disk is back over the line (40 GB, 15 GB freed by each: the two oldest go, the newest stays, and the pass says why)', () => [
      stop.removed?.join() === '.lanes/l-s1,.lanes/l-s2' && fs.existsSync(lane('l-s3')) && /back over 60 GB/.test(why(stop, 'l-s3')), JSON.stringify(stop)]);

    // ================= 4. the size is measured and carries its age =================
    const L = path.join(T, 'sz'); fs.mkdirSync(path.join(L, '.lanes', 'a'), { recursive: true });
    write(L, '.lanes/a/one.bin', 'x'.repeat(2048));
    for (let i = 0; i < 700; i++) write(L, `.lanes/a/many/f${i}.txt`, '');
    const t0 = Date.now();
    const SZ = (now, extra = '') => probe(`import { laneCopiesSize } from ${u('harness/lane-disk.mjs')}; import { machineLine } from ${u('harness/machine.mjs')};
const r = laneCopiesSize({ root: ${JSON.stringify(L)}, now: ${now}${extra} });
console.log(JSON.stringify({ ...r, line: machineLine({ ram: {}, cpu: {}, gpus: [], disk: { freeGb: 50, lanes: { bytes: r.bytes, atLeast: r.atLeast, at: r.at } }, power: {} }) }));`);
    const s1 = SZ(t0);
    write(L, '.lanes/a/two.bin', 'y'.repeat(1048576));
    const s2 = SZ(t0 + 120000);
    const s3 = SZ(t0 + 6 * 60000);
    const cut = SZ(t0 + 20 * 60000, ', maxAgeMs: 0, capMs: -1');
    const du = probe(`import { diskUsers } from ${u('harness/engine-clean.mjs')}; const r = diskUsers({ root: ${JSON.stringify(L)}, now: ${t0 + 7 * 60000} }); console.log(JSON.stringify({ line: r.line }));`);
    await guard('2.98 (g4) the lane copies\' size changes when a file is added (a measure over 5 minutes old is taken again, one under it is shown with its age), always says how old it is, and says "at least" when the walk was cut short (fails before this fix: the number came from a file written hours before, with no age)', () => [
      s1.bytes > 2000 && s1.bytes < 20000 && /measured just now/.test(s1.text) && s2.bytes === s1.bytes && /measured 2 min ago/.test(s2.text) && s3.bytes > s1.bytes + 1000000 && /measured just now/.test(s3.text)
        && cut.atLeast === true && /^at least /.test(cut.text) && /lane copies at least .*measured/.test(cut.line) && /measured/.test(s1.line) && /lane copies [^~]*~[\d.]+ GB, measured/.test(du.line || ''),
      JSON.stringify({ s1: s1.text, s2: s2.text, s3: s3.text, cut: cut.text, line: s1.line, du })]);

    // ================= 5. train cancel removes that train's rules checkouts =================
    const R = path.join(T, 'repo'); const GW = path.join(T, 'gate');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main'); write(R, 'base.txt', 'base\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev'); g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const sha = g(R, 'rev-parse', 'port/main').stdout.trim().slice(0, 10);
    setGame({ engines: { unity: { land: 'node -e 0 {branch}', target: 'port/main', cwd: R.split(path.sep).join('/'), gateWorktree: GW.split(path.sep).join('/'), timeoutMin: 5, rules: false } } });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { windowsHide: true, stdio: 'ignore' });
    procs.push(child);
    write(S, '.studio/locks/unity-train.lock', JSON.stringify({ id: 'TR-298', pid: child.pid, at: Date.now(), lanes: [], targetAt: null }));
    const mk = (n) => { g(R, 'worktree', 'add', '-q', '--detach', path.join(S, '.studio', 'tmp', n), 'port/main'); write(path.join(S, '.studio', 'tmp'), `${n}/big.bin`, 'z'.repeat(300000)); };
    const mine = [`rules-TR-298-${sha}`, `rules-TR-298-ahead-${sha}`]; const theirs = `rules-TR-299-${sha}`;
    for (const n of [...mine, theirs]) mk(n);
    const c = spawnSync(process.execPath, ['harness/task.mjs', 'train', 'cancel', '--engine', 'unity', '--by', 'overseer', '--why', 'a test'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    const tmp = (n) => fs.existsSync(path.join(S, '.studio', 'tmp', n));
    const listed = g(R, 'worktree', 'list', '--porcelain').stdout;
    await guard('2.98 (g5) train cancel removes that train\'s rules checkouts (.studio/tmp/rules-<train>-*, also the check ahead\'s) through removeCheckout, says how many and how much it freed, and leaves another train\'s (fails before this fix: they were left, 1.3 GB each)', () => [
      /cancelled by overseer/.test(out(c)) && mine.every((n) => !tmp(n)) && tmp(theirs) && !/rules-TR-298/.test(listed) && /rules-TR-299/.test(listed) && /2 rules checkout\(s\) removed, \d/.test(out(c)), out(c).slice(-700)]);
  } finally {
    for (const p of procs) { try { process.kill(p.pid); } catch { /* gone */ } }
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
