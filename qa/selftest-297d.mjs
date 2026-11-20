/**
 * qa/selftest-297d.mjs — 2.97 (d): a drain means no new train; a train never runs old code over new files; the upgrade
 * fetches first. On the studio's machine a train started during a drain waited in memory, the upgrade merged new harness
 * files, and at drain off it ran a whole train with the old modules; the upgrade merged a remote branch fetched hours
 * before. Here: a train command during a drain ends at once (exit 3); drain off starts the queued lanes' train; a train
 * that waited for the lock while the harness changed starts the same command again, once; `--merge <remote>/<branch>`
 * fetches first, a failed fetch merges nothing, a branch needs --not-main, --no-fetch and a local ref still work.
 * Scaffolding as qa/selftest-295d.mjs (a studio copy) and qa/selftest-296e.mjs (an upgrade studio and its remote).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

const WIN = process.platform === 'win32';
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await nap(300); } }
const kill = (pid) => { try { if (WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else process.kill(Number(pid), 'SIGKILL'); } catch { /* gone */ } };

export async function selftest297D({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s297d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_UPGRADE_REFRESH: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-297d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const started = [];
  const copyStudio = (name) => {
    const S = path.join(T, name);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(S, '.env'), '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    return S;
  };
  const bump = (S, version, file) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(S, 'package.json'), `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
    write(S, `harness/${file}`, `export const v = '${version}';\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', `harness ${version}`, '--no-verify');
  };

  try {
    // ================= (d1, d2) the drain =================
    const S = copyStudio('studio');
    const envS = { ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-297d.jsonl'), STUDIO_MAIN_ROOT: S };
    const cli = (args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env: { ...envS, ...extra }, encoding: 'utf8', timeout: 60000 });
    const u = fileUrlRelSOf(S);
    const probe = (code) => {
      const f = path.join(S, `.probe-297d-${started.length}-${Date.now()}.mjs`);
      fs.writeFileSync(f, code);
      const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envS, encoding: 'utf8', timeout: 60000 });
      try { fs.rmSync(f, { force: true }); } catch { /* swept with the folder */ }
      try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; }
    };
    cli(['harness/task.mjs', 'drain', 'on', '--by', 'selftest', '--why', 'upgrade']);
    const timed = (args) => { const t0 = Date.now(); const r = cli(args); return { r, ms: Date.now() - t0 }; };
    const web = timed(['harness/task.mjs', 'train', '--by', 'pat', '--now', '--foreground']);
    const eng = timed(['harness/task.mjs', 'train', '--engine', 'unity', '--by', 'pat']);
    const daemon = timed(['harness/train-daemon.mjs', 'run']);
    const lockLeft = fs.existsSync(path.join(S, '.studio', 'locks', 'train.lock'));
    const inner = probe(`import { kickTrain } from ${u('harness/train-detach.mjs')};
import { engineWindow } from ${u('harness/line-producer.mjs')};
const spawned = [];
const k = await kickTrain(process.cwd(), { by: 'b', deps: { supervisor: () => null, auto: () => ({ on: true }), trainOn: () => true, spawn: () => { spawned.push(1); return { ok: true, pid: 1 }; } } });
const f = { engine: 'unity', label: 'Unity', auto: true, queued: 1, engineSlots: 1, slotFree: true, window: 'slot' };
console.log(JSON.stringify({ how: k.how, line: k.line, spawned: spawned.length, drained: engineWindow({ ...f, drain: 'by selftest' }), open: engineWindow(f) }));`);
    const one = (x) => x.r.status === 3 && x.ms < 30000 && out(x.r).trim().split('\n').length === 1 && /^No train was started: the drain is on \(by selftest: upgrade\)/.test(out(x.r).trim());
    await guard('2.97 (d1) drain on: `task train`, `task train --engine unity` and the train daemon\'s `run` end at once with one plain line and exit 3, holding no lock; a queued task done starts no train (kickTrain says the drain); the Line Producer starts no engine train (fails before this fix: the train waited in memory for drain off, then ran with the modules it had loaded)', () => [
      one(web) && one(eng) && daemon.r.status === 3 && /the drain is on/.test(out(daemon.r)) && daemon.ms < 30000 && !lockLeft
        && inner.how === 'drain' && inner.spawned === 0 && /drain off starts their train/.test(inner.line) && inner.drained?.start === false && /the drain is on/.test(inner.drained?.why) && inner.open?.start === true,
      JSON.stringify({ web: [web.r.status, web.ms, out(web.r).slice(-400)], eng: [eng.r.status, eng.ms, out(eng.r).slice(-300)], daemon: [daemon.r.status, daemon.ms, out(daemon.r).slice(-300)], lockLeft, inner })]);

    // A lane in the queue (its copy is gone, so the train it gets drops it): drain off starts a train for it.
    write(S, '.studio/train/queue.json', JSON.stringify([{ task: 'T-901', agent: 'b-1', dir: path.join(S, '.lanes', 'gone'), branch: 'lane/gone', head: g(S, 'rev-parse', 'HEAD').stdout.trim(), at: new Date(Date.now() - 60000).toISOString() }]));
    const offR = cli(['harness/task.mjs', 'drain', 'off', '--by', 'selftest']);
    const kicked = Number((out(offR).match(/A train started for it, detached \(pid (\d+)/) || [])[1]) || null;
    if (kicked) started.push(kicked);
    const gone = kicked ? await until(() => !alive(kicked), 120000) : false;
    const dlog = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'train', 'daemon.log'), 'utf8'); } catch { return ''; } })();
    await guard('2.97 (d2) drain off with a lane queued starts its train by the usual starter (no supervisor: one detached train, train-daemon.mjs run), which runs and ends (fails before this fix: drain off started nothing; the train that had waited in memory ran instead)', () => [
      offR.status === 0 && /^Drain off\./.test(out(offR)) && Boolean(kicked) && gone && dlog.length > 0 && !/the drain is on/.test(dlog),
      JSON.stringify({ status: offR.status, out: out(offR).slice(-500), kicked, gone, dlog: dlog.slice(-600) })]);
    fs.rmSync(path.join(S, '.studio', 'train', 'queue.json'), { force: true });

    // ================= (d3) a train that waited while the harness changed =================
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { windowsHide: true, stdio: 'ignore' });
    started.push(holder.pid);
    const lockFile = path.join(S, '.studio', 'locks', 'train.lock');
    const waitedRun = async (n, extra = {}) => {
      write(S, '.studio/locks/train.lock', JSON.stringify({ pid: holder.pid, at: Date.now(), id: `held-297d-${n}`, by: 'other' }));
      const log = path.join(T, `train-${n}.log`);
      const fd = fs.openSync(log, 'a');
      const c = spawn(process.execPath, ['harness/task.mjs', 'train', '--by', 'pat', '--now', '--wait', '3', '--foreground'], { windowsHide: true, cwd: S, env: { ...envS, ...extra }, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      started.push(c.pid);
      const text = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
      const waiting = await until(() => /waiting for it/.test(text()), 60000);
      bump(S, `9.9.${n}`, `zz-297d-${n}.mjs`);
      fs.rmSync(lockFile, { force: true });
      const firstGone = await until(() => !alive(c.pid), 60000);
      const next = Number((text().match(/Started again on the new code \(pid (\d+)\)/) || [])[1]) || null;
      if (next) started.push(next);
      const nextGone = next ? await until(() => !alive(next), 120000) : true;
      await nap(500);
      return { waiting: Boolean(waiting), firstGone: Boolean(firstGone), first: c, next, nextGone: Boolean(nextGone), text: text() };
    };
    const a = await waitedRun(1);
    const restarts = (a.text.match(/the harness changed while this train waited \([^)]*-> 9\.9\.1\): starting again on the new code/g) || []).length;
    const afterRestart = a.text.slice(a.text.indexOf('Started again'));
    await guard('2.97 (d3) a train waiting for another train\'s lock when the harness changes (version and harness/ tree) says "the harness changed while this train waited (<old> -> 9.9.1): starting again on the new code" as it takes the lock, starts the same command again as a new process writing to the same log, and exits; the new process runs the train on the new code without starting again (fails before this fix: it ran on with the old modules)', () => [
      a.waiting && a.firstGone && Boolean(a.next) && a.next !== a.first.pid && a.nextGone && restarts === 1 && /"train":/.test(afterRestart) && !/harness changed again/.test(a.text) && !fs.existsSync(lockFile),
      JSON.stringify({ ...a, first: a.first.pid, restarts, text: a.text.slice(-1500) })]);
    const b = await waitedRun(2, { STUDIO_TRAIN_RESTARTED: '1' });
    await guard('2.97 (d3) a train that was already started again once and sees the harness change again ends with a plain line (exit 3) and starts nothing (no loop)', () => [
      b.waiting && b.firstGone && !b.next && b.first.exitCode === 3 && /the harness changed again while this train waited .*it was started again once already, so it stops here/.test(b.text) && !/Started again/.test(b.text),
      JSON.stringify({ ...b, first: [b.first.pid, b.first.exitCode], text: b.text.slice(-1200) })]);

    // ================= (d4 .. d7) the upgrade fetches first; a branch needs --not-main =================
    const U = copyStudio('up');
    const envU = { ...base, AGENT_EVENTS_FILE: path.join(U, '.studio', 'events-297d.jsonl'), STUDIO_MAIN_ROOT: '' };
    const B = path.join(T, 'remote.git');
    g(T, 'init', '-q', '--bare', '-b', 'main', B);
    g(U, 'checkout', '-q', '-b', 'release');
    bump(U, '9.9.8', 'zz-297d-r1.mjs');
    g(U, 'remote', 'add', 'origin', B); g(U, 'push', '-q', 'origin', 'release:main', 'release:x'); g(U, 'fetch', '-q', 'origin');
    bump(U, '9.9.9', 'zz-297d-r2.mjs');
    const r2 = g(U, 'rev-parse', 'HEAD').stdout.trim();
    g(U, 'push', '-q', B, 'release:refs/heads/x'); // pushed by path: the copy of origin/x here stays at the older commit
    g(U, 'checkout', '-q', 'main');
    const up = (...args) => spawnSync(process.execPath, ['harness/upgrade-guard.mjs', '--merge', ...args, '--by', 'Dana'], { windowsHide: true, cwd: U, encoding: 'utf8', env: envU, timeout: 240000 });
    const head = () => g(U, 'rev-parse', 'HEAD').stdout.trim();
    const has = (f) => fs.existsSync(path.join(U, 'harness', f));
    const h0 = head();
    const branchNo = up('origin/x');
    const h1 = head();
    g(U, 'remote', 'set-url', 'origin', path.join(T, 'no-such-remote.git'));
    const fetchNo = up('origin/main');
    const h2 = head();
    const r1Before = has('zz-297d-r1.mjs');
    const noFetch = up('origin/main', '--no-fetch');
    g(U, 'remote', 'set-url', 'origin', B);
    await guard('2.97 (d6) `--merge origin/x` (not the remote\'s main) is refused without --not-main in plain words, nothing merged (fails before this fix: it merged, saying only that a branch can change)', () => [
      branchNo.status === 1 && /origin\/x is not origin\/main: a branch can change, or fail its checks, after you take it\. Take origin\/main, or add --not-main if you mean it\./.test(out(branchNo)) && h1 === h0,
      JSON.stringify({ status: branchNo.status, out: out(branchNo).slice(-500) })]);
    await guard('2.97 (d5) a fetch that fails stops the upgrade with the reason and "nothing was merged; `--no-fetch` merges the copy that is here" (fails before this fix: it merged the copy here without a word)', () => [
      fetchNo.status === 1 && /couldn't fetch origin\/main \(.+\); nothing was merged; `--no-fetch` merges the copy that is here/.test(out(fetchNo)) && h2 === h0 && !r1Before,
      JSON.stringify({ status: fetchNo.status, out: out(fetchNo).slice(-500) })]);
    const moved = up('origin/x', '--not-main');
    const r2Short = r2.slice(0, 7);
    await guard('2.97 (d4) `--merge origin/x --not-main` fetches first: the branch moved on its remote after the last fetch, and its new commit is merged; the upgrade says what it takes (short id, date, subject) (fails before this fix: the stale copy was merged)', () => [
      moved.status === 0 && has('zz-297d-r2.mjs') && g(U, 'merge-base', '--is-ancestor', r2, 'HEAD').status === 0
        && new RegExp(`origin/x \\(fetched now\\) is ${r2Short}[0-9a-f]* \\(\\d{4}-\\d\\d-\\d\\d\\) harness 9\\.9\\.9`).test(out(moved)),
      JSON.stringify({ status: moved.status, out: out(moved).slice(-700) })]);
    g(U, 'checkout', '-q', '-b', 'local-rel', 'release');
    bump(U, '9.9.10', 'zz-297d-local.mjs');
    g(U, 'checkout', '-q', '-b', 'by-id', 'local-rel');
    bump(U, '9.9.11', 'zz-297d-id.mjs');
    const byId = g(U, 'rev-parse', 'HEAD').stdout.trim();
    g(U, 'checkout', '-q', 'main');
    const local = up('local-rel');
    const idM = up(byId);
    await guard('2.97 (d7) `--no-fetch` merges the copy of origin/main that is here; a local branch and a commit id merge with neither a fetch nor --not-main', () => [
      noFetch.status === 0 && /origin\/main \(not fetched: the copy here\) is /.test(out(noFetch)) && /PASS merged origin\/main/.test(out(noFetch))
        && local.status === 0 && has('zz-297d-local.mjs') && !/fetched|--not-main/.test(out(local)) && idM.status === 0 && has('zz-297d-id.mjs'),
      JSON.stringify({ noFetch: [noFetch.status, out(noFetch).slice(-400)], local: [local.status, out(local).slice(-400)], id: [idM.status, out(idM).slice(-300)] })]);
  } finally {
    for (const pid of started) if (alive(pid)) kill(pid);
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ }
  }
}
