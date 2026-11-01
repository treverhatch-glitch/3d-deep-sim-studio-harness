/**
 * qa/selftest-259b.mjs — 2.59.0 (helper b): from a crew orchestrator's final brief (harness 2.58.3, Windows).
 *   H-13: a clean rebase onto a main that changed lines near a commit's hunks invalidated its hook stamp (the patch-id
 *         hashes context lines). The stamp now carries the change's patch-id without context (Studio-Patch-U0); an
 *         edited commit still fails, and a stamp from before keeps the old rule. task done re-commits stale-stamped
 *         commits through the real hooks after its own rebase, and `npm run hooks -- restamp` does it by hand in a lane.
 *   H-12: the commit-msg hook tagged a commit with every task the agent held; now the lane's own task, the subject's
 *         leading id (when held), or the only lock, else none with a note.
 *   #6:   a lane copy runs its own committed harness; when main changed harness/ or scripts/ since the lane branched,
 *         its gates and the hooks check refuse and name the files (rebase), unless STUDIO_LANE_HARNESS=own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest259B({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '',
    GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', GITHUB_SHA: '', STUDIO_HOOKS_CHECK: '', STUDIO_LOCK_OWNER: '', STUDIO_LANE_HARNESS: '', STUDIO_HOOKS_RESTAMP: '',
    STUDIO_LANE_LOCKS: '', STUDIO_MAIN_COMMIT: '', STUDIO_WORKTREES: '', STUDIO_AGENT_MODEL: '', STUDIO_EXPERIMENT: '', AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-259b.jsonl') };
  const gIn = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const g = (...a) => gIn(dir, ...a);
  const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const commitIn = (cwd, msgs, extra = {}, flags = []) => {
    gIn(cwd, 'add', '-A');
    return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', ...[].concat(msgs).flatMap((m) => ['-m', m]), ...flags], { cwd, encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
  };
  const msgOf = (cwd, rev = 'HEAD') => gIn(cwd, 'log', '-1', '--format=%B', rev).stdout;
  const sha = (cwd, rev = 'HEAD') => gIn(cwd, 'rev-parse', rev).stdout.trim();
  const json = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; } };
  const check = (cwd, extra = {}) => { const r = run(cwd, 'node harness/hook-stamp.mjs check --json', { ...env, STUDIO_HOOKS_CHECK: 'on', ...extra }); return { r, j: json(r) }; };
  const lines20 = (n0 = 1) => Array.from({ length: 20 }, (_, i) => `export const v${i + n0} = ${i + n0};`).join('\n') + '\n';
  const edit = (root, rel, from, to) => { const f = path.join(root, rel); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(from, to)); };
  /** An old-format stamp: the same commit message without the Studio-Patch-U0 line (as 2.58.5's hooks wrote it). */
  const oldStamp = (cwd) => {
    const f = path.join(tmpRoot, `msg-259b-${process.pid}.txt`);
    fs.writeFileSync(f, msgOf(cwd).split('\n').filter((l) => !/^Studio-Patch-U0:/.test(l)).join('\n'));
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--amend', '--no-verify', '-F', f], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
    fs.rmSync(f, { force: true });
    return r;
  };
  const A = 'game/demo/src/a.mjs';
  const B = 'game/demo/src/b.mjs';

  // The studio: hooks installed, a game file of 20 lines, a lane copy for opus-7 on T-001.
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('config', 'core.hooksPath', 'scripts/hooks');
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  write(dir, A, lines20());
  write(dir, B, lines20(101));
  const base = commitIn(dir, ['studio', 'Golden-Reason: the first recording']);

  // ---- H-13: a clean rebase onto lines changed 2 above the commit's hunk ----
  g('switch', '-q', '-c', 'feat');
  edit(dir, A, 'export const v10 = 10;', 'export const v10 = 100;');
  const c1 = commitIn(dir, 'T-001: lane change');
  const m1 = msgOf(dir);
  g('switch', '-q', 'main');
  edit(dir, A, 'export const v7 = 7;', 'export const v7 = 70;');
  commitIn(dir, 'main edits a line 2 above the lane hunk');
  g('switch', '-q', 'feat');
  const rb = g('rebase', '-q', 'main');
  const h1 = check(dir, { STUDIO_PROTECT_BASE: 'main' });
  report('2.59.0 (H-13): a lane commit rebased cleanly onto a main that edited a line 2 above its hunk keeps a valid hook stamp: the stamp carries the change\'s patch-id without context (Studio-Patch-U0) and the hooks gate passes (old: "its stamp doesn\'t match its content", as T-093 on opus-29)',
    base.status === 0 && c1.status === 0 && /^Studio-Hooks: v[0-9a-f]{8} t[0-9a-f]{12} p[0-9a-f]{12}$/m.test(m1) && /^Studio-Patch-U0: p[0-9a-f]{12}$/m.test(m1) && rb.status === 0 && h1.r.status === 0 && h1.j.ok === true && !h1.j.open?.length,
    JSON.stringify({ base: out(base).slice(-400), c1: out(c1).slice(-400), m1, rb: out(rb), j: h1.j }).slice(0, 2500));

  // An edited commit still fails: one added line differs (the message, stamps and all, kept).
  edit(dir, A, 'export const v10 = 100;', 'export const v10 = 101;');
  gIn(dir, 'add', '-A');
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--amend', '--no-verify', '-C', 'HEAD'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const h2 = check(dir, { STUDIO_PROTECT_BASE: 'main' });
  // And a stamp without the -U0 id (made before 2.59.0) keeps the old rule after the same kind of rebase.
  g('reset', '-q', '--hard', 'main');
  g('switch', '-q', '-c', 'feat-old', 'main~1');
  edit(dir, A, 'export const v10 = 10;', 'export const v10 = 100;');
  commitIn(dir, 'T-001: lane change, old stamp');
  const os1 = oldStamp(dir);
  const preOld = check(dir, { STUDIO_PROTECT_BASE: 'main~1' });
  g('rebase', '-q', 'main');
  const h3 = check(dir, { STUDIO_PROTECT_BASE: 'main' });
  report('2.59.0 (H-13): the -U0 match is no loophole: a rebased commit with one added line changed after the hooks ran still fails, and a stamp without Studio-Patch-U0 (2.58.5\'s) keeps the old rule (valid on its own tree, stale after a rebase near its hunk)',
    h2.r.status !== 0 && h2.j.ok === false && h2.j.open?.length === 1 && os1.status === 0 && !/Studio-Patch-U0/.test(msgOf(dir)) && preOld.j.ok === true && h3.r.status !== 0 && h3.j.open?.length === 1,
    JSON.stringify({ h2: h2.j, preOld: preOld.j, h3: h3.j, os1: out(os1) }).slice(0, 2500));
  g('switch', '-q', 'main');
  g('branch', '-D', 'feat', 'feat-old');

  // ---- the lane copy ----
  const agent = 'opus-7';
  const mk = run(dir, `node -e "import('./harness/worktree.mjs').then((m) => console.log(JSON.stringify(m.createLaneCopy('${agent}', { task: 'T-001' }))))"`, env);
  const lane = path.join(dir, '.lanes', agent);
  const inLane = { STUDIO_LOCK_OWNER: agent, STUDIO_MAIN_ROOT: dir };
  for (const t of ['T-001', 'T-002', 'T-003']) run(dir, `node harness/lock.mjs claim task:${t} --owner ${agent}`, env);

  // H-12: in the lane, the commit is tagged with the lane's own task, not all three the agent holds.
  const C = 'game/demo/src/c.mjs';
  write(lane, C, 'export const c = 1;\n');
  const c2 = commitIn(lane, 'add c', inLane);
  const m2 = msgOf(lane);
  const tagged = (m2.match(/^Studio-Task: (.*)$/m) || [])[1] || null;
  const dc = run(lane, `node -e "import('./harness/done-check.mjs').then((m) => console.log(JSON.stringify({ t2: m.taskChanges('T-002', Date.now() - 3600e3).committed, t1: m.taskChanges('T-001', Date.now() - 3600e3).committed })))"`, { ...env, ...inLane });
  const dcj = json(dc);
  report('2.59.0 (H-12): a commit in a lane copy is tagged Studio-Task with the lane\'s own task (T-001), not every task the agent holds (T-001, T-002, T-003), so done-check counts it for T-001 only (old: "Studio-Task: T-001, T-002, T-003", a change for all three)',
    fs.existsSync(path.join(lane, '.git')) && c2.status === 0 && tagged === 'T-001' && Array.isArray(dcj.t1) && dcj.t1.includes(C) && Array.isArray(dcj.t2) && !dcj.t2.includes(C),
    JSON.stringify({ mk: out(mk).slice(-600), c2: out(c2).slice(-600), m2, dcj }).slice(0, 2500));

  // H-12 on the main checkout (no lane): the subject's leading id when held; none (with a note) when it can't tell;
  // the only lock when there is one.
  const onMain = { STUDIO_LOCK_OWNER: 'opus-8', STUDIO_MAIN_COMMIT: 'allow' };
  for (const t of ['T-004', 'T-005']) run(dir, `node harness/lock.mjs claim task:${t} --owner opus-8`, env);
  write(dir, 'studio/notes-259b.md', 'one\n');
  const s1 = commitIn(dir, 'T-005: note one', onMain);
  const t1 = (msgOf(dir).match(/^Studio-Task: (.*)$/m) || [])[1] || null;
  write(dir, 'studio/notes-259b.md', 'two\n');
  const s2 = commitIn(dir, 'note two', onMain);
  const t2 = (msgOf(dir).match(/^Studio-Task: (.*)$/m) || [])[1] || null;
  run(dir, 'node harness/lock.mjs release task:T-004 --owner opus-8', env);
  write(dir, 'studio/notes-259b.md', 'three\n');
  const s3 = commitIn(dir, 'note three', onMain);
  const t3 = (msgOf(dir).match(/^Studio-Task: (.*)$/m) || [])[1] || null;
  report('2.59.0 (H-12): outside a lane the commit-msg hook takes the subject\'s leading task id when the agent holds it (T-005 of T-004, T-005), writes no Studio-Task with a note when nothing says which, and the only lock when there is one (old: "T-004, T-005" on both)',
    s1.status === 0 && t1 === 'T-005' && s2.status === 0 && t2 === null && /holds 2 tasks \(T-004, T-005\)/.test(out(s2)) && s3.status === 0 && t3 === 'T-005',
    JSON.stringify({ t1, t2, t3, s2: out(s2).slice(-800) }).slice(0, 2000));
  run(dir, 'node harness/lock.mjs release task:T-005 --owner opus-8', env);

  // ---- restamp by hand, and task done's own rebase ----
  // The lane's commit carries an old-format stamp; main edits a line 2 above its hunk; the lane rebases cleanly.
  edit(lane, A, 'export const v15 = 15;', 'export const v15 = 150;');
  const c3 = commitIn(lane, 'T-001: v15', inLane);
  oldStamp(lane);
  const preRestamp = sha(lane);
  edit(dir, A, 'export const v12 = 12;', 'export const v12 = 120;');
  commitIn(dir, 'main edits v12', onMain);
  const rb2 = gIn(lane, 'rebase', '-q', 'main');
  const stale = check(lane, inLane);
  const inMain = run(dir, 'npm run --silent hooks -- restamp --json', { ...env, ...onMain });
  write(lane, 'game/demo/src/dirty.mjs', 'x\n');
  gIn(lane, 'add', 'game/demo/src/dirty.mjs');
  const dirtyR = run(lane, 'npm run --silent hooks -- restamp --json', { ...env, ...inLane });
  gIn(lane, 'rm', '-q', '--cached', 'game/demo/src/dirty.mjs'); fs.rmSync(path.join(lane, 'game/demo/src/dirty.mjs'));
  const before = { head: sha(lane), tree: sha(lane, 'HEAD^{tree}'), tasks: gIn(lane, 'log', '--format=%(trailers:key=Studio-Task,valueonly)', 'main..HEAD').stdout.trim() };
  const rs = run(lane, 'npm run --silent hooks -- restamp --json', { ...env, ...inLane });
  const rsj = json(rs);
  const after = check(lane, inLane);
  const backupOk = rsj.backup && sha(lane, rsj.backup) === before.head;
  report('2.59.0: npm run hooks -- restamp, in a lane copy, re-commits the rebased commits whose stamps went stale through the real hooks (same files, same Studio-Task, a new stamp with Studio-Patch-U0) and keeps the old head as backup/<lane>-pre-restamp-<time>; it refuses on the main checkout and with uncommitted changes (old: no such command)',
    c3.status === 0 && rb2.status === 0 && stale.j.ok === false && inMain.status !== 0 && /main checkout/.test(json(inMain).why || '') && dirtyR.status !== 0 && /uncommitted/.test(json(dirtyR).why || '')
      && rs.status === 0 && rsj.ok === true && rsj.replayed >= 1 && backupOk && /^backup\/opus-7-pre-restamp-\d{8}-\d{6}/.test(rsj.backup) && sha(lane, 'HEAD^{tree}') === before.tree
      && gIn(lane, 'log', '--format=%(trailers:key=Studio-Task,valueonly)', 'main..HEAD').stdout.trim() === before.tasks && /^Studio-Patch-U0: /m.test(msgOf(lane)) && after.j.ok === true && preRestamp !== sha(lane),
    JSON.stringify({ stale: stale.j, inMain: json(inMain), dirty: json(dirtyR), rsj, rsOut: out(rs).slice(-800), after: after.j, before, tasks: gIn(lane, 'log', '--format=%(trailers:key=Studio-Task,valueonly)', 'main..HEAD').stdout }).slice(0, 3000));

  // task done's own rebase (deliver): an old-format stamp made stale by it is re-committed through the hooks.
  edit(lane, A, 'export const v18 = 18;', 'export const v18 = 180;');
  commitIn(lane, 'T-001: v18', inLane);
  oldStamp(lane);
  edit(dir, A, 'export const v20 = 20;', 'export const v20 = 200;');
  commitIn(dir, 'main edits v20', onMain);
  const mainBefore = sha(dir);
  const deliver = (task) => run(lane, `node -e "import('./harness/worktree.mjs').then((m) => console.log(JSON.stringify(m.deliver('${task}', { runChecks: false }))))"`, { ...env, ...inLane });
  const d1 = deliver('T-001');
  const d1j = json(d1);
  const landed = check(dir, { STUDIO_PROTECT_BASE: mainBefore });
  report('2.59.0 (H-13): task done\'s own rebase re-commits a lane commit whose stamp the rebase made stale through the real hooks, so what lands on main passes the hooks gate (old: it landed with a stale stamp)',
    d1j.ok === true && d1j.merged >= 1 && sha(dir) !== mainBefore && landed.j.ok === true && landed.j.checked >= 1 && !landed.j.open?.length,
    JSON.stringify({ d1: d1j, out: out(d1).slice(-1200), landed: landed.j }).slice(0, 2500));

  // ... and when the hooks refuse the replayed commit, it doesn't land: never a stamp without the hooks.
  gIn(lane, 'merge', '-q', '--ff-only', 'main');
  edit(lane, A, 'export const v3 = 3;', 'export const v3 = 30;');
  commitIn(lane, 'T-001: v3', inLane);
  oldStamp(lane);
  edit(dir, A, 'export const v1 = 1;', 'export const v1 = 10;');
  commitIn(dir, 'main edits v1', onMain);
  run(dir, `node harness/lock.mjs claim path:${A} --owner opus-9`, env);
  const mainBefore2 = sha(dir);
  const d2 = run(lane, `node -e "import('./harness/worktree.mjs').then((m) => console.log(JSON.stringify(m.deliver('T-001', { runChecks: false }))))"`, { ...env, ...inLane, STUDIO_LANE_LOCKS: 'block' });
  const d2j = json(d2);
  const backups = gIn(lane, 'branch', '--list', 'backup/*').stdout.trim().split('\n').filter(Boolean);
  report('2.59.0 (H-13): when the hooks refuse a commit task done re-commits after its rebase (a file locked by another agent, lane locks set to block), nothing lands and the lane keeps its rebased commits; no stamp is written by hand (old: landed with the stale stamp)',
    d2j.ok === false && /hooks/.test(d2j.message || '') && sha(dir) === mainBefore2 && /locked by opus-9/.test(d2j.message || '') && backups.length === 1,
    JSON.stringify({ d2: d2j, out: out(d2).slice(-1200), backups }).slice(0, 2500));
  run(dir, `node harness/lock.mjs release path:${A} --owner opus-9`, env);

  // A commit that skipped the hooks before the rebase is not re-committed by task done (no laundering).
  gIn(lane, 'reset', '-q', '--hard', 'main');
  edit(lane, A, 'export const v5 = 5;', 'export const v5 = 50;');
  commitIn(lane, 'T-001: v5 without hooks', inLane, ['--no-verify']);
  edit(dir, A, 'export const v8 = 8;', 'export const v8 = 80;');
  commitIn(dir, 'main edits v8', onMain);
  const rb3 = gIn(lane, 'rebase', '-q', 'main');
  const rsAuto2 = run(lane, `node harness/hook-stamp.mjs restamp --auto --json --base ${sha(dir)} --was ${gIn(lane, 'rev-parse', 'ORIG_HEAD').stdout.trim()} --was-base ${sha(dir, 'HEAD~1')}`, { ...env, ...inLane });
  report('2.59.0 (H-13): task done\'s re-stamp leaves alone a commit that had no valid stamp before its rebase (made with --no-verify): it stays unstamped and the hooks gate still lists it',
    rb3.status === 0 && json(rsAuto2).ok === true && json(rsAuto2).skipped === true && !/^Studio-Hooks:/m.test(msgOf(lane)) && check(lane, inLane).j.ok === false,
    JSON.stringify({ rb3: out(rb3), rsAuto2: json(rsAuto2) }).slice(0, 2000));
  gIn(lane, 'reset', '-q', '--hard', 'main');

  // ---- #6: the lane's harness is older than main's ----
  write(dir, 'harness/zz-259b-probe.mjs', '// a harness fix that landed on main\n');
  commitIn(dir, 'harness: a fix on main', onMain);
  const gates = run(lane, 'node scripts/run-gates.mjs --only hooks --no-detach', { ...env, ...inLane });
  const hk = run(lane, 'node harness/hook-stamp.mjs check', { ...env, ...inLane });
  const own = run(lane, 'node scripts/run-gates.mjs --only hooks --no-detach', { ...env, ...inLane, STUDIO_LANE_HARNESS: 'own' });
  edit(lane, B, 'export const v120 = 120;', 'export const v120 = 1200;');
  const note = commitIn(lane, 'T-001: b again', inLane);
  report('2.59.0 (#6): in a lane copy whose branch point is behind a harness change on main, npm run verify and the hooks check refuse and name the file and the fix (rebase), STUDIO_LANE_HARNESS=own runs the lane\'s own copy, and a commit there gets a note, not a refusal (old: the lane\'s old harness judged, T-061)',
    gates.status !== 0 && /harness\/zz-259b-probe\.mjs/.test(out(gates)) && /git rebase main/.test(out(gates)) && hk.status !== 0 && /zz-259b-probe/.test(out(hk))
      && own.status === 0 && /STUDIO_LANE_HARNESS=own/.test(out(own)) && note.status === 0 && /zz-259b-probe/.test(out(note)),
    JSON.stringify({ gates: out(gates).slice(-800), hk: out(hk).slice(-600), own: out(own).slice(-600), note: out(note).slice(-600) }).slice(0, 3000));

  // After the rebase the lane runs main's harness: no refusal. A lane's own harness edit (main unchanged) is no drift.
  gIn(lane, 'rebase', '-q', 'main');
  const gates2 = run(lane, 'node scripts/run-gates.mjs --only hooks --no-detach', { ...env, ...inLane });
  write(lane, 'harness/zz-259b-lane.mjs', '// the lane\'s own harness task\n');
  commitIn(lane, 'T-001: a harness change in the lane', inLane);
  const gates3 = run(lane, 'node scripts/run-gates.mjs --only hooks --no-detach', { ...env, ...inLane });
  report('2.59.0 (#6): after git rebase main the lane\'s gates run (no refusal), and a harness change the lane makes itself (main unchanged) is not refused: the studio\'s branch only overrules an older lane copy',
    gates2.status === 0 && !/not run/.test(out(gates2)) && gates3.status === 0 && !/not run/.test(out(gates3)),
    JSON.stringify({ gates2: out(gates2).slice(-800), gates3: out(gates3).slice(-800) }).slice(0, 2000));
}
