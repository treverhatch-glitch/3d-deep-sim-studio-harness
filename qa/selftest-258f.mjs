/**
 * qa/selftest-258f.mjs — 2.58.0 (F): verify survives being reaped and doesn't dirty the repo.
 *   F1: `npm run verify` runs the gates in a process of its own; killing the foreground (its whole process tree) leaves
 *       the run going, it writes its record, and `--wait` shows it with its exit code. One run per owner at a time.
 *   F2: game checks run with CI=true; tracked files a verify changed are named (changedByVerify in the record);
 *       the onboarding doc asks games for `*.snap text eol=lf`.
 * A stub game (STUDIO_GAME=stubgame) whose one check blocks until the test writes a flag file, so the kill lands
 * while the run is under way on any machine, however slow.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export async function selftest258F({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await sleep(50); } };
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' });
  const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
  const stub = path.join(dir, 'game', 'stubgame');
  const runsOf = () => { try { return fs.readFileSync(path.join(stub, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
  const mode = (m) => { fs.writeFileSync(path.join(stub, 'mode.txt'), m); fs.rmSync(path.join(stub, 'runs.log'), { force: true }); fs.rmSync(path.join(stub, 'go.txt'), { force: true }); };
  const go = () => fs.writeFileSync(path.join(stub, 'go.txt'), 'go');
  // Everything an outer verify or agent session could pass down is set here: this test decides.
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_GAME: 'stubgame', STUDIO_VERIFY_RUN: '', STUDIO_VERIFY_DETACH: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_COMPACT_OUTPUT: 'off', STUDIO_MAIN_ROOT: '', STUDIO_GAME_GATE_CI: '', CI: '', npm_lifecycle_event: '' };
  const envFor = (owner, extra = {}) => ({ ...process.env, ...base, STUDIO_LOCK_OWNER: owner, ...extra });
  // As `npm run verify` starts it (npm sets npm_lifecycle_event), output collected as it comes.
  const start = (owner, args, extra = {}) => {
    const p = spawn(process.execPath, ['scripts/run-gates.mjs', ...args], { cwd: dir, env: envFor(owner, { npm_lifecycle_event: 'verify', ...extra }), stdio: ['ignore', 'pipe', 'pipe'] });
    const h = { p, text: '', code: undefined };
    p.stdout.on('data', (d) => { h.text += d; });
    p.stderr.on('data', (d) => { h.text += d; });
    h.done = new Promise((r) => p.on('close', (code, sig) => { h.code = code ?? sig; r(h.code); }));
    return h;
  };
  const sync = (owner, args, extra = {}) => spawnSync(process.execPath, ['scripts/run-gates.mjs', ...args], { cwd: dir, env: envFor(owner, extra), encoding: 'utf8', timeout: 60000 });
  // What a reaper does (tree-kill): every process under the foreground, found by parent pid, killed at once.
  const killTree = (pid) => {
    // Same shape on every OS: the pids it killed (Windows CI crashed on `.includes` of taskkill's result object).
    if (process.platform === 'win32') return spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).status === 0 ? [pid] : [];
    const kids = new Map();
    for (const l of (spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout || '').split('\n')) {
      const [c, pp] = l.trim().split(/\s+/).map(Number);
      if (c && pp) kids.set(pp, [...(kids.get(pp) || []), c]);
    }
    const all = [];
    const walk = (x) => { all.push(x); for (const k of kids.get(x) || []) walk(k); };
    walk(pid);
    for (const x of all) try { process.kill(x, 'SIGKILL'); } catch {}
    return all;
  };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

  fs.mkdirSync(path.join(stub, '__snapshots__'), { recursive: true });
  fs.writeFileSync(path.join(stub, 'studio.gates.json'), JSON.stringify({ gates: [{ id: 'check', command: 'node game/stubgame/check.mjs', required: true }] }, null, 2));
  fs.writeFileSync(path.join(stub, 'check.mjs'), `import fs from 'node:fs';
const d = 'game/stubgame';
const mode = fs.existsSync(d + '/mode.txt') ? fs.readFileSync(d + '/mode.txt', 'utf8') : '';
fs.appendFileSync(d + '/runs.log', 'CI=' + process.env.CI + '\\n');
if (mode.includes('block')) { const end = Date.now() + 30000; while (!fs.existsSync(d + '/go.txt') && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); }
if (mode.includes('crlf')) { const f = d + '/__snapshots__/a.test.ts.snap'; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\\r?\\n/g, '\\r\\n')); }
if (mode.includes('append')) fs.appendFileSync(d + '/b.txt', 'written by the check\\n');
if (mode.includes('fail')) { console.log('FAIL stub > breaks on purpose'); process.exit(3); }
console.log(' Tests  1 passed (1)');
`);
  fs.writeFileSync(path.join(stub, '__snapshots__', 'a.test.ts.snap'), 'exports[`a`] = `1`;\n\nexports[`b`] = `2`;\n');
  fs.writeFileSync(path.join(stub, 'b.txt'), 'one\n');
  fs.writeFileSync(path.join(stub, 'c.txt'), 'one\n');
  fs.writeFileSync(path.join(stub, '.gitignore'), 'runs.log\nmode.txt\ngo.txt\n');
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  const handles = [];

  try {
    // F1: the foreground's whole process tree is killed mid-run; the run finishes, records, and --wait shows it.
    mode('block fail');
    const fg = start('f1', ['--only', 'game']);
    handles.push(fg);
    const st0 = await waitFor(() => { const s = readJson('.studio/verify-running/f1.json'); return s?.hostPid && runsOf().length ? s : null; });
    await sleep(1000);
    const killed = st0 ? killTree(fg.p.pid) : [];
    await fg.done;
    const hostSurvived = Boolean(st0?.hostPid && alive(st0.hostPid));
    // Re-attach while it still runs (the check is held), then let it end: --wait follows it to its exit code.
    const attach = start('f1', ['--wait'], { npm_lifecycle_event: '' });
    handles.push(attach);
    await waitFor(() => /is still running/.test(attach.text));
    go();
    await attach.done;
    const w = sync('f1', ['--wait']); // after the end: the finished run
    const rec = readJson('.studio/gates/f1.json');
    const st1 = readJson('.studio/verify-running/f1.json');
    report('2.58.0 (F1): killing a running `npm run verify` and every process under it leaves the gates running; they write the verify record (right head); `npm run verify -- --wait` re-attaches to the running one, or shows the finished one, and exits with its code',
      Boolean(st0) && killed.includes(fg.p.pid) && hostSurvived && attach.code === 1 && /\[verify\] the verify for f1 \(--only game\) started .* is still running/.test(attach.text) && /\[gates\] 1 required gate\(s\) failed: game/.test(attach.text)
        && w.status === 1 && /\[verify\] the verify for f1 \(--only game\) started .* finished .* on [0-9a-f]{8} with exit code 1/.test(out(w)) && /\[gates\] FAIL game/.test(out(w))
        && runsOf().length === 1 && rec?.head === head && rec?.verifyRun === st1?.runId && rec?.rows?.some((r) => r.id === 'game' && !r.ok) && st1?.state === 'done' && st1?.code === 1,
      `${JSON.stringify({ st0, killed, hostSurvived, runs: runsOf(), rec: rec && { head: rec.head, verifyRun: rec.verifyRun, rows: rec.rows }, st1, head })}\n--- fg:\n${fg.text.slice(-800)}\n--- attach (exit ${attach.code}):\n${attach.text.slice(0, 400)}\n--- wait (exit ${w.status}):\n${out(w).slice(0, 600)}`);

    // F1: npm run verify detaches by default and keeps its output and exit codes; --no-detach and direct calls don't.
    mode('');
    const pass = start('f2', ['--only', 'game']); handles.push(pass); await pass.done;
    const runA = readJson('.studio/verify-running/f2.json')?.runId;
    mode('fail');
    const failRun = start('f2', ['--only', 'game']); handles.push(failRun); await failRun.done;
    const runB = readJson('.studio/verify-running/f2.json')?.runId;
    mode('');
    const noDetach = sync('f2', ['--only', 'game', '--no-detach'], { npm_lifecycle_event: 'verify' });
    const direct = sync('f2', ['--only', 'game']);
    const runC = readJson('.studio/verify-running/f2.json')?.runId;
    // 2.59.0+: a game check prints its load-scaled timeout only while the machine is busy, so that one line can differ
    // between two runs; it is information, not output to compare.
    const norm = (t) => t.replace(/\r/g, '').split('\n').filter((l) => !l.startsWith('[verify]') && !/^\[game-gates\] \S+: timeout \d+ s \(/.test(l)).map((l) => l.replace(/\d+ ms/, 'N ms').replace(/\s+/g, ' ')).join('\n').trim();
    report('2.58.0 (F1): `npm run verify` runs the gates apart by default with the same output and exit codes (0 green, 1 red); --no-detach, and harness callers of the script, run in-process as before',
      pass.code === 0 && failRun.code === 1 && /^\[verify\] the gates run in a process of their own/.test(pass.text) && /\[gates\] 1\/1 passed/.test(pass.text) && /\[gates\] 1 required gate\(s\) failed: game/.test(failRun.text)
        && runA && runB && runA !== runB && noDetach.status === 0 && direct.status === 0 && runC === runB && !/\[verify\]/.test(out(noDetach) + out(direct)) && norm(pass.text) === norm(out(direct)),
      `${JSON.stringify({ pass: pass.code, fail: failRun.code, runA, runB, runC, noDetach: noDetach.status, direct: direct.status })}\n--- detached:\n${pass.text.slice(-1200)}\n--- direct:\n${out(direct).slice(-1200)}`);

    // F1: one run per owner. The same options attach to the running one; other options wait for it to end.
    mode('block');
    const a = start('f3', ['--only', 'game']); handles.push(a);
    await waitFor(() => runsOf().length === 1);
    const b = start('f3', ['--only', 'game']); handles.push(b);
    await waitFor(() => /already running/.test(b.text));
    const c = start('f3', ['--only', 'game,secrets']); handles.push(c);
    await waitFor(() => /starts when it ends/.test(c.text));
    const runsWhileBlocked = runsOf().length;
    go();
    await Promise.all([a.done, b.done, c.done]);
    report('2.58.0 (F1): a second `npm run verify` for the same owner attaches to the running one (one run, both get its result); one with other options waits and then runs',
      runsWhileBlocked === 1 && runsOf().length === 2 && a.code === 0 && b.code === 0 && c.code === 0 && /with the same options is already running/.test(b.text) && /\[gates\] 1\/1 passed/.test(b.text) && /this one starts when it ends/.test(c.text) && /\[gates\] 2\/2 passed/.test(c.text),
      `${JSON.stringify({ runsWhileBlocked, runs: runsOf(), a: a.code, b: b.code, c: c.code })}\n--- b:\n${b.text.slice(-800)}\n--- c:\n${c.text.slice(-800)}`);

    // F2: game checks see CI=true (test runners don't write snapshots during a verify); STUDIO_GAME_GATE_CI=off leaves it.
    mode('');
    sync('f4', ['--only', 'game']);
    const ciOn = runsOf();
    mode('');
    sync('f4', ['--only', 'game'], { STUDIO_GAME_GATE_CI: 'off' });
    const ciOff = runsOf();
    report('2.58.0 (F2): the game\'s own checks run with CI=true in their env (STUDIO_GAME_GATE_CI=off leaves CI as it was)',
      JSON.stringify(ciOn) === '["CI=true"]' && JSON.stringify(ciOff) === '["CI="]', JSON.stringify({ ciOn, ciOff }));

    // F2: a check that rewrites tracked files is named, in the output and the record; edits made before the run are not.
    fs.appendFileSync(path.join(stub, 'b.txt'), 'edited before the verify\n');
    fs.appendFileSync(path.join(stub, 'c.txt'), 'edited before the verify\n');
    mode('crlf append');
    const dirty = sync('f5', ['--only', 'game']);
    const rec5 = readJson('.studio/gates/f5.json');
    mode('');
    g('checkout', '--', '.');
    const clean = sync('f5', ['--only', 'game']);
    const rec6 = readJson('.studio/gates/f5.json');
    report('2.58.0 (F2): a verify that changes tracked files names them (a check rewrote a snapshot\'s line endings, and a file already edited) and records them as changedByVerify; untouched edits aren\'t named; the exit code stays 0',
      dirty.status === 0 && /\[gates\] WARN this verify changed 2 tracked file\(s\): game\/stubgame\/__snapshots__\/a\.test\.ts\.snap, game\/stubgame\/b\.txt\n/.test(out(dirty)) && !/c\.txt/.test(out(dirty))
        && JSON.stringify(rec5?.changedByVerify) === JSON.stringify(['game/stubgame/__snapshots__/a.test.ts.snap', 'game/stubgame/b.txt']) && clean.status === 0 && !/WARN this verify changed/.test(out(clean)) && JSON.stringify(rec6?.changedByVerify) === '[]',
      `${out(dirty).slice(-1200)}\n${JSON.stringify({ rec5: rec5?.changedByVerify, rec6: rec6?.changedByVerify })}`);

    // F2: the onboarding doc tells games to keep generated test files' line endings fixed; verify's doc names --wait.
    const onboard = fs.readFileSync(path.join(dir, 'docs', 'ONBOARDING-A-GAME.md'), 'utf8');
    const work = fs.readFileSync(path.join(dir, 'docs', 'WORK-ORGANIZATION.md'), 'utf8');
    report('2.58.0 (F2): docs: games add `*.snap text eol=lf` to .gitattributes and check runs use CI=true (snapshot updates are a deliberate -u run); verify running apart and --wait are explained',
      /\*\.snap text eol=lf/.test(onboard) && /CI=true/.test(onboard) && /-u\b/.test(onboard) && /npm run verify -- --wait/.test(work) && /--no-detach/.test(work) && /changedByVerify/.test(work), '');
  } finally {
    go();
    for (const h of handles) if (h.code === undefined) try { h.p.kill(); } catch {}
    // A run still going (a failure above) would hold the copy open: stop it.
    for (const o of ['f1', 'f2', 'f3']) {
      const s = readJson(`.studio/verify-running/${o}.json`);
      if (s?.hostPid && alive(s.hostPid)) { if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(s.hostPid), '/T', '/F'], { stdio: 'ignore' }); else try { process.kill(-s.hostPid, 'SIGKILL'); } catch {} }
    }
    await sleep(200);
  }
}
