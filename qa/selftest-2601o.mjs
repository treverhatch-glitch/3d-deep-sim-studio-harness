/**
 * qa/selftest-2601o.mjs — 2.60.1 (helper o): landing, stamps, goldens and the train (B-29 to B-33).
 *   B-29: a commit on main that changes only board/record files (harness/train-board.json) while a train is verified
 *         doesn't restart the verify: the lanes merge again onto the new main and land on the same verify. A move of
 *         anything else (studio/protected.json here) still means a new verify (a guard; 2.60.0 did that too).
 *   B-30: in a lane copy started without STUDIO_MAIN_ROOT, with origin/main stale and an unstamped commit on main itself,
 *         the hooks check judges from the main checkout's local main (main's own commit is not the lane's), and so do
 *         the protected check (approve show) and, outside a lane, a branch whose main is ahead of origin/main.
 *   B-32: the hooks check and restamp print the same "base <ref> <sha>".
 *   B-31: merging main into a lane, a golden staged exactly as main has it needs no Golden-Reason; one resolved to
 *         anything else still does (a guard; 2.60.0 refused both).
 *   B-33: task done --train refused for another check names that check (first line and the task.not_done event), and
 *         the verify row the train covers is marked so, not "[ ]".
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2601O({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
  const g = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(extra) });
  const head = (cwd, ref = 'HEAD') => g(cwd, ['rev-parse', ref]).stdout.trim();
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_TASK_BASE: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_EXPERIMENT: '', STUDIO_AGENT_MODEL: '', STUDIO_HARNESS_REF: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2601o-${process.pid}.pem`), STUDIO_MAIN_COMMIT: '', ...ident };
  // Fresh copies of the harness for the parts that need their own repository (made before `dir` becomes one).
  const nm = path.join(dir, 'node_modules');
  const copy = (name) => {
    const d = path.join(tmpRoot, `2601o-${name}-${process.pid}`);
    fs.cpSync(dir, d, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(d, 'node_modules'), 'junction'); } catch {} }
    return d;
  };
  const dirB = copy('base');
  const dirG = copy('golden');
  const dirD = copy('done');

  // ================= B-29: a board-only move of main keeps the train's verify =================
  {
    const mark = path.join(tmpRoot, `train-runs-2601o-${process.pid}.txt`);
    const moveSpec = path.join(tmpRoot, `train-move-2601o-${process.pid}.json`);
    const events = path.join(dir, '.studio', 'events-2601o.jsonl');
    const env = { ...base, STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', AGENT_EVENTS_FILE: events, TRAIN_MARK: mark, TRAIN_MOVE: moveSpec };
    const runs = () => { try { return fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const mainHas = (rel) => g(dir, ['cat-file', '-e', `main:${rel}`]).status === 0;
    const doneBoard = () => { try { return fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8'); } catch { return ''; } };
    write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    // The game's check counts its runs; once (TRAIN_MOVE names a spec) it commits files on the main checkout while the
    // train's verify runs, as a person's board command would.
    write(dir, 'game/demo/check.mjs', [
      "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
      "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.cwd()}\\n`);",
      "const spec = process.env.TRAIN_MOVE;",
      "if (spec && fs.existsSync(spec) && process.env.STUDIO_MAIN_ROOT) {",
      "  const s = JSON.parse(fs.readFileSync(spec, 'utf8')); fs.rmSync(spec);",
      "  const root = process.env.STUDIO_MAIN_ROOT;",
      "  for (const [rel, text] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }",
      "  const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];",
      "  spawnSync('git', ['add', '--', ...Object.keys(s.files)], { cwd: root, env });",
      "  const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', s.message, '--', ...Object.keys(s.files)], { cwd: root, env, encoding: 'utf8' });",
      "  if (c.status !== 0) { console.error(`FAIL could not move main: ${c.stderr}`); process.exit(1); }",
      "}",
      "console.log('notes ok');", ''].join('\n'));
    write(dir, 'game/demo/notes/shared.md', '# Shared\n');
    g(dir, ['init', '-q', '-b', 'main']); g(dir, ['config', 'core.autocrlf', 'false']);
    g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'studio', '--no-verify']);
    g(dir, ['config', 'core.hooksPath', 'scripts/hooks']);
    const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
    const laneProbe = path.join(tmpRoot, `lane-2601o-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
    const lane = (agent, title, rel, text) => {
      const id = addTask(title);
      const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(dir, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
      const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      write(ld, rel, text);
      g(ld, ['add', rel]);
      const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: gEnv(as) });
      const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
      return { id, agent, dir: ld, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0 && q.status === 0, log: `${out(made)}\n${out(st).slice(-300)}\n${out(c)}\n${out(q).slice(-600)}` };
    };
    const train = () => run(dir, 'node harness/task.mjs train --by tester', env);

    // 1. Board-only: the owner's type record and NEXT.md committed on main during the verify.
    await guard('2.60.1 (B-29): a commit on main that changes only board/record files (studio/task-types.json, studio/NEXT.md) while the train is verified doesn\'t restart the verify: the lane merges again onto the new main, the tree is checked to be the verified one plus those files, and it lands on ONE verify run, the board commit kept, the event naming the reused verify and the files (fails on 2.60.0: "moved", a second verify)', () => {
      const a = lane('bld-a', 'Docs: note a', 'game/demo/notes/a.md', '# A\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'owner: type record and board', files: { 'studio/task-types.json': `${JSON.stringify({ note: 'test', tasks: {} }, null, 2)}\n`, 'studio/NEXT.md': `${fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')}\n<!-- board note -->\n` } }));
      const r0 = runs();
      const t = train();
      const boardCommit = g(dir, ['log', '-1', '--format=%H', '--grep', 'owner: type record and board', 'main']).stdout.trim();
      const bm = evs().find((e) => e.type === 'task.train.board_move');
      const landed = evs().filter((e) => e.type === 'task.train.landed').pop();
      const ok = a.ok && t.status === 0 && runs() - r0 === 1 && !fs.existsSync(moveSpec) && mainHas('game/demo/notes/a.md') && mainHas('studio/task-types.json')
        && /^[0-9a-f]{40}$/.test(boardCommit) && g(dir, ['merge-base', '--is-ancestor', boardCommit, 'main']).status === 0
        && new RegExp(`\\b${a.id}\\b`).test(doneBoard())
        && bm && (bm.meta?.files || []).join(',') === 'studio/NEXT.md,studio/task-types.json' && /verify reused/.test(out(t))
        && landed && /reused across a board-only move/.test(landed.msg) && head(dir, 'main^{tree}') === landed.meta?.tree
        && !evs().some((e) => e.type === 'task.train.moved');
      return [ok, `lane ${a.ok} ${a.log.slice(-500)}\nruns=${runs() - r0}\n${out(t).slice(-1800)}\nboard_move=${JSON.stringify(bm?.meta)}\nlanded=${landed?.msg}`];
    });

    // 2. Guard: studio/protected.json moved on main: a new verify, as before.
    await guard('2.60.1 (B-29, guard): a commit on main that changes studio/protected.json (not a board file) during the verify still means the train is built again and verified again (2 verify runs, a "moved" event, no board_move); boardOnlyMove refuses a code file and a deleted board file (2.60.0 re-verified every move; boardOnlyMove is new)', async () => {
      const b = lane('bld-b', 'Docs: note b', 'game/demo/notes/b.md', '# B\n');
      const prot = JSON.parse(fs.readFileSync(path.join(dir, 'studio/protected.json'), 'utf8'));
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'owner: protected list', files: { 'studio/protected.json': `${JSON.stringify({ ...prot, note: `${prot.note} (edited)` }, null, 2)}\n` } }));
      const before = evs().filter((e) => e.type === 'task.train.board_move').length;
      const r0 = runs();
      const t = train();
      const moved = evs().some((e) => e.type === 'task.train.moved');
      const twice = runs() - r0 === 2;
      // boardOnlyMove on made-up commits: a code file; a deleted handoff.
      write(dir, 'studio/handoffs/x.md', '# x\n');
      g(dir, ['add', 'studio/handoffs/x.md']); g(dir, ['commit', '-qm', 'handoff', '--no-verify']);
      const h0 = head(dir);
      g(dir, ['rm', '-q', 'studio/handoffs/x.md']); g(dir, ['commit', '-qm', 'drop handoff', '--no-verify']);
      const h1 = head(dir);
      write(dir, 'studio/handoffs/y.md', '# y\n'); g(dir, ['add', 'studio/handoffs/y.md']); g(dir, ['commit', '-qm', 'handoff y', '--no-verify']);
      const h2 = head(dir);
      write(dir, 'game/demo/notes/code.md', '# c\n'); g(dir, ['add', 'game/demo/notes/code.md']); g(dir, ['commit', '-qm', 'code', '--no-verify', '--', 'game/demo/notes/code.md'], { STUDIO_MAIN_COMMIT: 'allow' });
      const h3 = head(dir);
      const { boardOnlyMove } = await import(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href);
      const del = boardOnlyMove(dir, h0, h1);
      const add = boardOnlyMove(dir, h1, h2);
      const code = boardOnlyMove(dir, h2, h3);
      const ok = b.ok && t.status === 0 && moved && twice && evs().filter((e) => e.type === 'task.train.board_move').length === before && mainHas('game/demo/notes/b.md')
        && del.ok === false && /deletes studio\/handoffs\/x\.md/.test(del.why) && add.ok === true && add.files.join() === 'studio/handoffs/y.md' && code.ok === false && /game\/demo\/notes\/code\.md/.test(code.why);
      return [ok, `lane ${b.ok} ${b.log.slice(-400)}\nmoved=${moved} runs=${runs() - r0}\n${out(t).slice(-1500)}\n${JSON.stringify({ del, add, code })}`];
    });
    try { fs.rmSync(laneProbe, { force: true }); fs.rmSync(moveSpec, { force: true }); } catch {}
  }

  // ================= B-30 / B-32: one base for the hooks check, restamp and the protected check =================
  {
    const d = dirB;
    const env = { ...base, STUDIO_HOOKS_CHECK: 'on' };
    g(d, ['init', '-q', '-b', 'main']); g(d, ['config', 'core.autocrlf', 'false']);
    g(d, ['add', '-A']); g(d, ['commit', '-qm', 'studio', '--no-verify']);
    g(d, ['config', 'core.hooksPath', 'scripts/hooks']);
    // A first commit through the hooks (it lists the commits the checkout already had as exempt, as on taking the hooks).
    write(d, 'studio/notes/first.md', '# first\n'); g(d, ['add', 'studio/notes/first.md']);
    const c0 = spawnSync('git', ['commit', '-qm', 'first stamped commit'], { cwd: d, encoding: 'utf8', env: gEnv(env) });
    const origin = path.join(tmpRoot, `2601o-origin-${process.pid}.git`);
    g(tmpRoot, ['init', '-q', '--bare', origin]);
    g(d, ['remote', 'add', 'origin', origin]); g(d, ['push', '-q', 'origin', 'main']); g(d, ['fetch', '-q', 'origin']);
    // main's own commit, made without the hooks and never pushed: origin/main is now stale (an ancestor of main).
    write(d, 'studio/notes/board.md', '# board\n'); g(d, ['add', 'studio/notes/board.md']); g(d, ['commit', '-qm', 'board note on main', '--no-verify']);
    const mainTip = head(d, 'main');
    // A lane copy as a sub-agent sees it: no STUDIO_MAIN_ROOT.
    const ld = path.join(d, '.lanes', 'bld-x');
    g(d, ['worktree', 'add', '-q', '-b', 'lane/bld-x', ld, 'main']);
    write(ld, 'docs/lane-x.md', '# lane x\n'); g(ld, ['add', 'docs/lane-x.md']);
    const c = spawnSync('git', ['commit', '-qm', 'lane x work'], { cwd: ld, encoding: 'utf8', env: gEnv(env) });
    const stamped = /Studio-Hooks:/.test(g(ld, ['log', '-1', '--format=%B']).stdout);

    let chk = null;
    await guard('2.60.1 (B-30): in a lane copy started without STUDIO_MAIN_ROOT, with origin/main stale and an unstamped commit on main itself, the hooks check judges from the main checkout\'s local main (passes, "base main <sha>"), and the protected check names the same base (fails on 2.60.0: origin/main was used and main\'s own commit failed the lane\'s check)', () => {
      chk = run(ld, 'node harness/hook-stamp.mjs check', env);
      const show = run(ld, 'node harness/approve.mjs show', env);
      const ok = c0.status === 0 && c.status === 0 && stamped && chk.status === 0 && new RegExp(`\\[hooks\\] base main ${mainTip.slice(0, 8)}`).test(out(chk))
        && /\bmain has no owner key/.test(out(show)) && !/origin\/main/.test(out(show));
      return [ok, `commit ${c.status} stamped=${stamped} ${out(c).slice(-400)}\ncheck:\n${out(chk).slice(-1200)}\nshow:\n${out(show).slice(-500)}`];
    });
    await guard('2.60.1 (B-32): restamp in that lane prints the same "base <ref> <sha>" line as the hooks check, and both judge from main (fails on 2.60.0: restamp named no base and the check took origin/main)', () => {
      const rs = run(ld, 'node harness/hook-stamp.mjs restamp', env);
      const want = `base main ${mainTip.slice(0, 8)}`;
      const ok = rs.status === 0 && out(rs).includes(`[restamp] ${want}`) && out(chk || {}).includes(`[hooks] ${want}`);
      return [ok, `restamp:\n${out(rs).slice(-800)}\ncheck:\n${out(chk || {}).slice(-400)}`];
    });
    await guard('2.60.1 (B-30): outside a lane, a branch whose local main is ahead of a stale origin/main judges from local main (main\'s own unpushed commit is not the branch\'s); on main itself origin/main is still the base, naming what is not pushed yet (fails on 2.60.0: origin/main for the branch too)', () => {
      g(d, ['checkout', '-q', '-b', 'feat/y', 'main']);
      write(d, 'docs/feat-y.md', '# y\n'); g(d, ['add', 'docs/feat-y.md']);
      const cf = spawnSync('git', ['commit', '-qm', 'feat y'], { cwd: d, encoding: 'utf8', env: gEnv({ ...env, STUDIO_MAIN_COMMIT: 'allow' }) });
      const onBranch = run(d, 'node harness/hook-stamp.mjs check', env);
      g(d, ['checkout', '-q', 'main']);
      const onMain = run(d, 'node harness/hook-stamp.mjs check --json', env);
      let j = {};
      try { j = JSON.parse(String(onMain.stdout).trim().split('\n').pop()); } catch {}
      const ok = cf.status === 0 && onBranch.status === 0 && new RegExp(`\\[hooks\\] base main ${mainTip.slice(0, 8)}`).test(out(onBranch)) && j.base === 'origin/main' && j.ok === false;
      return [ok, `commit ${cf.status} ${out(cf).slice(-300)}\nbranch:\n${out(onBranch).slice(-800)}\nmain: ${JSON.stringify(j).slice(0, 1500)}`];
    });
  }

  // ================= B-31: goldens that arrive unchanged in a merge need no Golden-Reason =================
  {
    const d = dirG;
    const env = { ...base };
    const gold = 'qa/golden/demo-2601o.json';
    write(d, gold, '{ "win": 10 }\n');
    g(d, ['init', '-q', '-b', 'main']); g(d, ['config', 'core.autocrlf', 'false']);
    g(d, ['add', '-A']); g(d, ['commit', '-qm', 'studio', '--no-verify']);
    g(d, ['config', 'core.hooksPath', 'scripts/hooks']);
    const commit = (args) => spawnSync('git', ['commit', '-q', ...args], { cwd: d, encoding: 'utf8', env: gEnv(env) });
    g(d, ['branch', 'lane/a']); g(d, ['branch', 'lane/b']);
    write(d, gold, '{ "win": 12 }\n'); g(d, ['add', gold]);
    const cm = commit(['-m', 'retune the win tick', '-m', 'Golden-Reason: the bounds fix moves the win tick']);
    g(d, ['checkout', '-q', 'lane/a']);
    write(d, 'docs/lane-a.md', '# a\n'); g(d, ['add', 'docs/lane-a.md']); commit(['-m', 'lane a work']);
    await guard('2.60.1 (B-31): merging main into a lane, a golden main changed (with its own Golden-Reason) and that arrives unchanged needs no Golden-Reason on the merge commit (fails on 2.60.0: the commit-msg hook diffed the staged goldens against the lane\'s HEAD and refused)', () => {
      const m = spawnSync('git', ['merge', '--no-edit', '-m', 'merge main into lane a', 'main'], { cwd: d, encoding: 'utf8', env: gEnv(env) });
      const merged = g(d, ['rev-parse', '-q', '--verify', 'HEAD^2']).status === 0 && g(d, ['show', `HEAD:${gold}`]).stdout.includes('12');
      return [cm.status === 0 && m.status === 0 && merged, `${out(cm).slice(-300)}\nmerge ${m.status}: ${out(m).slice(-800)}`];
    });
    await guard('2.60.1 (B-31, guard): a golden resolved to anything but main\'s version in a merge (a combination of both sides) still needs a Golden-Reason: refused without one, accepted with one (2.60.0 refused it too)', () => {
      g(d, ['checkout', '-q', 'lane/b']);
      write(d, gold, '{ "win": 11 }\n'); g(d, ['add', gold]);
      const own = commit(['-m', 'lane b retune', '-m', 'Golden-Reason: lane b moves it']);
      const m = spawnSync('git', ['merge', '--no-edit', 'main'], { cwd: d, encoding: 'utf8', env: gEnv(env) });
      write(d, gold, '{ "win": 13 }\n'); g(d, ['add', gold]);
      const bare = commit(['--no-edit']);
      const stillMerging = g(d, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
      const reasoned = commit(['-m', 'merge main into lane b', '-m', 'Golden-Reason: both fixes together move it to 13']);
      const ok = own.status === 0 && m.status !== 0 && bare.status !== 0 && /Golden-Reason/.test(out(bare)) && stillMerging && reasoned.status === 0 && g(d, ['rev-parse', '-q', '--verify', 'HEAD^2']).status === 0;
      return [ok, `own ${own.status}\nmerge ${m.status} ${out(m).slice(-300)}\nbare ${bare.status} ${out(bare).slice(-500)}\nreasoned ${reasoned.status} ${out(reasoned).slice(-300)}`];
    });
  }

  // ================= B-33: task done --train names the check that blocks =================
  {
    const d = dirD;
    const events = path.join(d, '.studio', 'events-2601o.jsonl');
    const env = { ...base, AGENT_EVENTS_FILE: events, STUDIO_REACHABILITY: 'fail', STUDIO_LOCK_OWNER: 'bld-d' };
    g(d, ['init', '-q', '-b', 'main']); g(d, ['config', 'core.autocrlf', 'false']);
    g(d, ['add', '-A']); g(d, ['commit', '-qm', 'studio', '--no-verify']);
    await guard('2.60.1 (B-33): task done --train refused by another check (new code not wired in) while its verify is stale names that check on the first line and in the task.not_done event, and lists the verify row as "(the train\'s verify covers this)", not "[ ]" (fails on 2.60.0: both named the exempt verify row)', () => {
      const id = (out(run(d, 'node harness/task.mjs add "Make the crate glow" --role builder --priority P1', env)).match(/"id": "(T-\d+)"/) || [])[1];
      const st = run(d, `node harness/task.mjs start ${id} --agent bld-d`, env);
      // New game code that nothing in the game imports yet (the reachability check, made a failing one here).
      const sim = 'cartridges/example-sim/glow.mjs';
      write(d, sim, 'export const glow = 1;\n');
      g(d, ['add', sim]); g(d, ['commit', '-qm', `${id}: glow`, '-m', `Studio-Task: ${id}`, '--no-verify']);
      const dn = run(d, `node harness/task.mjs done ${id} --agent bld-d --train`, env);
      const text = out(dn);
      let evs = [];
      try { evs = fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      const nd = evs.filter((e) => e.type === 'task.not_done' && e.task === id).pop();
      const first = text.trim().split('\n')[0];
      const ok = st.status === 0 && dn.status !== 0 && new RegExp(`^${id} is not done: New game code is wired`).test(first)
        && nd && /wired/.test(nd.msg) && !/verify/i.test(nd.msg)
        && /\(the train's verify covers this\) Full verify green after the last change/.test(text) && !/\[ \] Full verify green/.test(text);
      return [ok, `${out(st).slice(-200)}\n---\n${text.slice(-1500)}\nevent: ${nd?.msg}`];
    });
  }
}
