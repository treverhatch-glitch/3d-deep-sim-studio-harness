/**
 * qa/selftest-267h.mjs — 2.67.0 (helper h): test hygiene and upgrade friction (B-48, B-49, B-29, B-38).
 *   B-48: harness/test-rng.mjs reads the game's "testRandomness" (studio.gates.json) and flags a test file that starts a
 *         seeded game while a setup file routes the sim's dice to the shared Math.random and the file never isolates,
 *         and an unseeded game in a test; the game gate lists it as game:test-rng, a WARN (STUDIO_TEST_RNG=required
 *         fails), and a hand-back carries the findings as a fact.
 *   B-49: `upgrade --merge` ends with `lanes refresh --all`: refreshed / conflicted / skipped (a running session is not
 *         touched); STUDIO_UPGRADE_REFRESH=off keeps the old behaviour.
 *   B-29: a commit on main of studio/NEXT.md, DONE.md and a hand-off during a train's verify keeps the verify (already
 *         true on 2.66.0, kept as a guard), and so does a hold record changed for a task outside the train (new); a hold
 *         changed for a lane of the train still means a new verify.
 *   B-38: an owner type outranks the title on a red trunk (only fix tasks start), in the hand-off's open bugs and in the
 *         token norms; `task visual <ID> off` exists and turns the render requirement off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest267H({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
  const g = (cwd, args, extra = {}) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(extra) });
  const head = (cwd, ref = 'HEAD') => g(cwd, ['rev-parse', ref]).stdout.trim();
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const lastJson = (r) => { try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return null; } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_TASK_BASE: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT_MODEL: '', STUDIO_HARNESS_REF: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-267h-${process.pid}.pem`), STUDIO_MAIN_COMMIT: '',
    STUDIO_TEST_RNG: '', STUDIO_UPGRADE_REFRESH: '', STUDIO_REACHABILITY: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_GATE_RELATED: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  const copy = (name) => {
    const d = path.join(tmpRoot, `267h-${name}-${process.pid}`);
    fs.cpSync(dir, d, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(d, 'node_modules'), 'junction'); } catch {} }
    return d;
  };
  const probe = (cwd, name, code, env) => {
    const f = path.join(cwd, `.probe-267h-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node ${path.basename(f)}`, env);
    const j = lastJson(r);
    return j ? { ...j, _out: out(r).slice(-1500) } : { _out: out(r).slice(-2500) };
  };
  const u = (cwd, rel) => JSON.stringify(pathToFileURL(path.join(cwd, rel)).href);
  const dirA = copy('rng');
  const dirB = copy('upgrade');
  const dirC = copy('train');
  const dirD = copy('type');

  // ================= B-48: a seeded game on the shared Math.random, an unseeded game =================
  {
    const env = { ...base, STUDIO_GAME: 'dice' };
    const manifest = `${JSON.stringify({
      gates: [{ id: 'unit', command: 'node game/dice/unit.mjs' }],
      testRandomness: { seededCalls: ['\\bbeginNew\\s*\\('], sharedRandomSetup: ['\\bforceSimRandom\\s*\\(\\s*Math\\.random'], isolateCall: 'forceSimRandom(null)' },
    }, null, 2)}\n`;
    write(dirA, 'game/dice/studio.gates.json', manifest);
    write(dirA, 'game/dice/unit.mjs', "console.log('Tests  3 passed (3)');\n");
    write(dirA, 'game/dice/src/test/setup.ts', "import { forceSimRandom } from '../sim/dice';\n// every test rolls the worker's dice\nforceSimRandom(Math.random);\n");
    write(dirA, 'game/dice/src/a.test.ts', "import { beginNew } from './sim/game';\n\nit('ends day 3', () => {\n  const g = beginNew(42);\n  expect(g.day).toBe(1);\n});\n");
    write(dirA, 'game/dice/src/b.test.ts', "import { beginNew } from './sim/game';\nimport { forceSimRandom } from './sim/dice';\nbeforeEach(() => forceSimRandom( null ));\nit('ok', () => { expect(beginNew(7).day).toBe(1); });\n");
    write(dirA, 'game/dice/src/c.test.ts', "import { beginNew } from './sim/game';\n// beginNew() in a comment is not a call\nit('a', () => { const g = beginNew(); expect(g).toBeTruthy(); });\nit('b', () => { const g = beginNew(Math.floor(Math.random() * 9)); expect(g).toBeTruthy(); });\n");
    write(dirA, 'game/dice/src/sim/game.ts', "export function beginNew(seed?: number) { return { day: 1, seed: seed ?? 0 }; }\nexport const demo = () => beginNew();\n");
    write(dirA, 'game/dice/src/sim/dice.ts', 'export function forceSimRandom(_f: unknown) {}\n');

    await guard('2.67.0 (B-48): node harness/test-rng.mjs reads the game\'s "testRandomness" and flags a.test.ts (beginNew(42) while src/test/setup.ts routes the dice to Math.random, never isolated: shared-random) and c.test.ts twice (beginNew() and a seed from Math.random: unseeded-game); b.test.ts (isolates), the comment and the sim\'s own unseeded call are not flagged; exit 1 (fails on 2.66.0: no harness/test-rng.mjs)', () => {
      const r = run(dirA, 'node harness/test-rng.mjs --json', env);
      const j = lastJson(r);
      const f = (j?.findings || []).map((x) => `${x.file}:${x.line}:${x.kind}`);
      const want = ['game/dice/src/a.test.ts:4:shared-random', 'game/dice/src/c.test.ts:3:unseeded-game', 'game/dice/src/c.test.ts:4:unseeded-game'];
      const text = run(dirA, 'node harness/test-rng.mjs', env);
      const ok = r.status === 1 && j?.mode === 'warn' && JSON.stringify(f) === JSON.stringify(want)
        && /src\/test\/setup\.ts:3 routes the sim's dice there/.test(j.findings[0].message) && /forceSimRandom\(null\)/.test(j.findings[0].message)
        && /game\/dice\/src\/a\.test\.ts:4 \[TEST_RNG shared-random\]/.test(out(text)) && /advisory/.test(out(text));
      return [ok, `${out(r).slice(-2000)}\n${out(text).slice(-800)}`];
    });

    await guard('2.67.0 (B-48): the game gate lists game:test-rng as an advisory check: exit 0 with "WARN game:test-rng" (the game\'s own check passes); STUDIO_TEST_RNG=required makes it fail ("FAIL game:test-rng", exit 1); the manifest is only read; gate-fix has its Fix line (fails on 2.66.0: no game:test-rng)', () => {
      const warn = run(dirA, 'node harness/game-gates.mjs', env);
      const req = run(dirA, 'node harness/game-gates.mjs', { ...env, STUDIO_TEST_RNG: 'required' });
      const fix = run(dirA, 'node harness/gate-fix.mjs game:test-rng', env);
      const ok = warn.status === 0 && /\[game-gates\] WARN game:test-rng/.test(out(warn)) && /\[game-gates\] PASS game:unit/.test(out(warn))
        && req.status === 1 && /\[game-gates\] FAIL game:test-rng/.test(out(req))
        && fs.readFileSync(path.join(dirA, 'game/dice/studio.gates.json'), 'utf8') === manifest && /isolate call/.test(out(fix));
      return [ok, `warn=${warn.status}\n${out(warn).slice(-1200)}\nreq=${req.status}\n${out(req).slice(-1200)}\n${out(fix)}`];
    });

    await guard('2.67.0 (B-48): a hand-back carries the findings as a fact ("- Test randomness (advisory, …): 3 finding(s): game/dice/src/a.test.ts:4 shared-random, …"); a game without "testRandomness" gets no such line (fails on 2.66.0)', () => {
      const p = probe(dirA, 'facts', `import { buildFacts, renderFacts } from ${u(dirA, 'harness/handback-facts.mjs')};
const f = buildFacts('T-990', { dir: process.cwd() });
console.log(JSON.stringify({ text: renderFacts(f) }));\n`, env);
      const none = probe(dirA, 'facts-none', `import { buildFacts, renderFacts } from ${u(dirA, 'harness/handback-facts.mjs')};
console.log(JSON.stringify({ text: renderFacts(buildFacts('T-990', { dir: process.cwd() })) }));\n`, { ...env, STUDIO_GAME: 'other' });
      const ok = /- Test randomness \(advisory, node harness\/test-rng\.mjs\): 3 finding\(s\): game\/dice\/src\/a\.test\.ts:4 shared-random, game\/dice\/src\/c\.test\.ts:3 unseeded-game/.test(p.text || '')
        && typeof none.text === 'string' && !/Test randomness/.test(none.text);
      return [ok, `${p.text || p._out}\n---\n${none.text || none._out}`];
    });
  }

  // ================= B-49: upgrade --merge refreshes the lanes =================
  {
    const S = dirB;
    const events = path.join(S, '.studio', 'events-267h.jsonl');
    const env = { ...base, STUDIO_GAME: 'demo', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', AGENT_EVENTS_FILE: events };
    write(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs', paths: ['game/demo/**'] }] }, null, 2)}\n`);
    write(S, 'game/demo/check.mjs', "console.log('demo ok');\n");
    write(S, 'game/demo/main.txt', 'alpha\nbeta\n');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    g(S, ['config', 'core.hooksPath', 'scripts/hooks']);
    const addTask = (title) => (out(run(S, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
    const ids = { x: addTask('Lane x note'), y: addTask('Lane y main line'), z: addTask('Lane z busy') };
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const laneProbe = path.join(tmpRoot, `lane-267h-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const mkLane = (agent, id, rel, text) => {
      run(S, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(S, '.lanes', agent);
      write(ld, rel, text);
      g(ld, ['add', rel]);
      const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${rel}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: gEnv({ ...env, STUDIO_MAIN_ROOT: S }) });
      return { agent, id, dir: ld, ok: c.status === 0, log: out(c), head: head(ld) };
    };
    const X = mkLane('bld-x', ids.x, 'game/demo/x.txt', 'x\n');
    const Y = mkLane('bld-y', ids.y, 'game/demo/main.txt', 'alpha\nBETA-Y\n');
    const Z = mkLane('bld-z', ids.z, 'game/demo/z.txt', 'z\n');
    // The update: a harness-side file and the line lane y changes.
    const upstream = (branch, files) => {
      g(S, ['checkout', '-q', '-b', branch]);
      for (const [rel, text] of Object.entries(files)) write(S, rel, text);
      g(S, ['add', '-A', ...Object.keys(files)]); g(S, ['commit', '-qm', `update ${branch}`, '--no-verify']);
      g(S, ['checkout', '-q', 'main']);
    };
    upstream('upstream-a', { 'scripts/zz-267h-a.txt': 'update a\n', 'game/demo/main.txt': 'alpha\nBETA-UPDATE\n' });
    write(S, '.studio/agents/bld-z.json', JSON.stringify({ agent: 'bld-z', role: 'builder', task: Z.id, status: 'running', pid: process.pid, startedAt: new Date().toISOString() }));
    const person = { ...env, STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '' };

    await guard('2.67.0 (B-49): a person\'s upgrade --merge ends with lanes refresh --all: lane x is refreshed (main merged in, its own commit kept), lane y conflicts with the update (merge aborted, head unchanged, the file named), lane z whose session is running is skipped and untouched; the upgrade still passes (fails on 2.66.0: no refresh, the lanes stay behind)', () => {
      const r = run(S, 'node harness/upgrade-guard.mjs --merge upstream-a --by pat', person);
      const o = out(r);
      const mainNow = head(S, 'main');
      const ok = X.ok && Y.ok && Z.ok && r.status === 0 && /\[upgrade\] PASS merged upstream-a/.test(o)
        && /\[upgrade\] lanes: 1 refreshed, 1 conflicted, 0 red, 1 skipped/.test(o)
        && new RegExp(`refreshed ${X.id}: merged main`).test(o) && new RegExp(`conflicted ${Y.id}: merging main conflicts in game/demo/main\\.txt`).test(o) && new RegExp(`skipped ${Z.id}: someone is working in it \\(bld-z's session is running`).test(o)
        && g(X.dir, ['merge-base', '--is-ancestor', mainNow, 'HEAD']).status === 0 && g(X.dir, ['merge-base', '--is-ancestor', X.head, 'HEAD']).status === 0
        && head(Y.dir) === Y.head && !fs.existsSync(path.join(g(Y.dir, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'MERGE_HEAD')) && head(Z.dir) === Z.head;
      return [ok, `lanes ${X.log}${Y.log}${Z.log}\n${o.slice(-3000)}`];
    });

    await guard('2.67.0 (B-49): STUDIO_UPGRADE_REFRESH=off keeps the old behaviour: the update merges, the lanes are not refreshed (lane x stays behind main) and the output says how to refresh them (fails on 2.66.0: no such line)', () => {
      fs.rmSync(path.join(S, '.studio/agents/bld-z.json'), { force: true });
      upstream('upstream-b', { 'scripts/zz-267h-b.txt': 'update b\n' });
      const before = head(X.dir);
      const r = run(S, 'node harness/upgrade-guard.mjs --merge upstream-b --by pat', { ...person, STUDIO_UPGRADE_REFRESH: 'off' });
      const ok = r.status === 0 && /\[upgrade\] PASS merged upstream-b/.test(out(r)) && /\[upgrade\] lanes: not refreshed \(STUDIO_UPGRADE_REFRESH=off/.test(out(r))
        && head(X.dir) === before && g(X.dir, ['merge-base', '--is-ancestor', head(S, 'main'), 'HEAD']).status !== 0 && head(Z.dir) === Z.head;
      return [ok, out(r).slice(-2000)];
    });
  }

  // ================= B-29: board-only commits during a train's verify =================
  {
    const D = dirC;
    const mark = path.join(tmpRoot, `train-runs-267h-${process.pid}.txt`);
    const moveSpec = path.join(tmpRoot, `train-move-267h-${process.pid}.json`);
    const events = path.join(D, '.studio', 'events-267h.jsonl');
    const env = { ...base, STUDIO_GAME: 'demo', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_TRAIN: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', AGENT_EVENTS_FILE: events, TRAIN_MARK: mark, TRAIN_MOVE: moveSpec };
    const runs = () => { try { return fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const mainHas = (rel) => g(D, ['cat-file', '-e', `main:${rel}`]).status === 0;
    write(D, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    write(D, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    // The game's check counts its runs; when TRAIN_MOVE names a spec it commits files on the main checkout while the
    // train's verify runs, as a person's board command would.
    write(D, 'game/demo/check.mjs', [
      "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
      "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.cwd()}\\n`);",
      'const spec = process.env.TRAIN_MOVE;',
      'if (spec && fs.existsSync(spec) && process.env.STUDIO_MAIN_ROOT) {',
      "  const s = JSON.parse(fs.readFileSync(spec, 'utf8')); fs.rmSync(spec);",
      '  const root = process.env.STUDIO_MAIN_ROOT;',
      '  for (const [rel, text] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }',
      "  const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];",
      "  spawnSync('git', ['add', '--', ...Object.keys(s.files)], { cwd: root, env });",
      "  const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', s.message, '--', ...Object.keys(s.files)], { cwd: root, env, encoding: 'utf8' });",
      "  if (c.status !== 0) { console.error(`FAIL could not move main: ${c.stderr}`); process.exit(1); }",
      '}',
      "console.log('notes ok');", ''].join('\n'));
    write(D, 'game/demo/notes/shared.md', '# Shared\n');
    g(D, ['init', '-q', '-b', 'main']); g(D, ['config', 'core.autocrlf', 'false']);
    g(D, ['add', '-A']); g(D, ['commit', '-qm', 'studio', '--no-verify']);
    g(D, ['config', 'core.hooksPath', 'scripts/hooks']);
    const addTask = (title) => (out(run(D, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
    const laneProbe = path.join(tmpRoot, `lane-267h-c-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u(D, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const lane = (agent, title, rel, text) => {
      const id = addTask(title);
      const made = run(D, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(D, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: D, STUDIO_LOCK_OWNER: agent };
      const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      write(ld, rel, text);
      g(ld, ['add', rel]);
      const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: gEnv(as) });
      const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
      return { id, agent, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0 && q.status === 0, log: `${out(made)}\n${out(st).slice(-300)}\n${out(c)}\n${out(q).slice(-600)}` };
    };
    const train = () => run(D, 'node harness/task.mjs train --by tester', env);
    const read = (rel) => { try { return fs.readFileSync(path.join(D, rel), 'utf8'); } catch { return ''; } };

    await guard('2.67.0 (B-29): a commit on main of studio/NEXT.md, studio/DONE.md and a hand-off (studio/handoffs/) while the train is verified never restarts the verify: one verify run, a board_move naming the three files, the lane landed (already true on 2.66.0 since 2.60.1: kept as a guard)', () => {
      const a = lane('bld-a', 'Docs: note a', 'game/demo/notes/a.md', '# A\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'board: next, done and a hand-off', files: { 'studio/NEXT.md': `${read('studio/NEXT.md')}\n<!-- board note -->\n`, 'studio/DONE.md': `${read('studio/DONE.md')}\n<!-- done note -->\n`, 'studio/handoffs/T-901.md': '# T-901 hand-off\nwhere it stopped\n' } }));
      const r0 = runs();
      const t = train();
      const bm = evs().filter((e) => e.type === 'task.train.board_move').pop();
      const ok = a.ok && t.status === 0 && runs() - r0 === 1 && !fs.existsSync(moveSpec) && mainHas('game/demo/notes/a.md') && mainHas('studio/handoffs/T-901.md')
        && (bm?.meta?.files || []).join(',') === 'studio/DONE.md,studio/NEXT.md,studio/handoffs/T-901.md' && !evs().some((e) => e.type === 'task.train.moved');
      return [ok, `lane ${a.ok} ${a.log.slice(-500)}\nruns=${runs() - r0}\n${out(t).slice(-1500)}\nboard_move=${JSON.stringify(bm?.meta)}`];
    });

    await guard('2.67.0 (B-29): a hold record (studio/task-holds.json, as `task yes` writes it) committed on main during the verify for a task that is not in the train keeps the verify: one run, board_move names it (fails on 2.66.0: "not a board or record file", a second verify)', () => {
      const b = lane('bld-b', 'Docs: note b', 'game/demo/notes/b.md', '# B\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'holds: yes for another task', files: { 'studio/task-holds.json': `${JSON.stringify({ tasks: { 'T-990': { needsYes: { by: 'producer', why: 'waits for the dev' } } } }, null, 2)}\n` } }));
      const r0 = runs();
      const before = evs().filter((e) => e.type === 'task.train.board_move').length;
      const t = train();
      const bms = evs().filter((e) => e.type === 'task.train.board_move');
      const ok = b.ok && t.status === 0 && runs() - r0 === 1 && bms.length === before + 1 && (bms.pop().meta?.files || []).join(',') === 'studio/task-holds.json' && mainHas('game/demo/notes/b.md');
      return [ok, `lane ${b.ok} ${b.log.slice(-500)}\nruns=${runs() - r0}\n${out(t).slice(-1500)}`];
    });

    await guard('2.67.0 (B-29, guard): a hold record changed for a lane of the running train still means a new verify (two runs, a "moved" log naming the lane); recordEntriesChanged names only the tasks whose entries changed and refuses another key', async () => {
      const c = lane('bld-c', 'Docs: note c', 'game/demo/notes/c.md', '# C\n');
      const holds = JSON.parse(read('studio/task-holds.json') || '{"tasks":{}}');
      holds.tasks[c.id] = { needsYes: { by: 'producer', why: 'the owner wants to look' } };
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'holds: the train lane', files: { 'studio/task-holds.json': `${JSON.stringify(holds, null, 2)}\n` } }));
      const r0 = runs();
      const t = train();
      const { recordEntriesChanged } = await import(pathToFileURL(path.join(D, 'harness', 'train.mjs')).href);
      write(D, 'studio/task-holds.json', `${JSON.stringify({ ...holds, extra: 1 }, null, 2)}\n`);
      g(D, ['add', 'studio/task-holds.json']); g(D, ['commit', '-qm', 'holds extra', '--no-verify']);
      const extra = recordEntriesChanged(D, 'HEAD~1', 'HEAD', 'studio/task-holds.json', 'tasks');
      const ok = c.ok && t.status === 0 && runs() - r0 === 2 && new RegExp(`studio/task-holds\\.json for ${c.id}, a lane of this train`).test(out(t)) && extra.ok === false && /more than "tasks"/.test(extra.why);
      return [ok, `lane ${c.ok} ${c.log.slice(-400)}\nruns=${runs() - r0}\n${out(t).slice(-1800)}\nextra=${JSON.stringify(extra)}`];
    });
  }

  // ================= B-38: an owner type outranks the title everywhere =================
  {
    const env = { ...base, GIT_AUTHOR_NAME: 'pat', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'pat', GIT_COMMITTER_EMAIL: 'owner@example.com', STUDIO_PRODUCER_NAME: 'prod-1' };
    const task = (cmd, e = {}) => run(dirD, `node harness/task.mjs ${cmd}`, { ...env, ...e });
    const add = (title) => { try { return JSON.parse(task(`add "${title}" --role builder`).stdout).id; } catch { return null; } };
    g(dirD, ['init', '-q', '-b', 'main']); g(dirD, ['config', 'core.autocrlf', 'false']);
    g(dirD, ['add', '-A']); g(dirD, ['commit', '-qm', 'base', '--no-verify']);
    const tFix = add('Fix the water shader foam');
    const tAdd = add('Add the crane menu');
    const tRender = add('Render the water foam pass');
    const r1 = task(`type ${tFix} docs --by pat --why "only the shader notes change, nothing to replay"`);
    const r2 = task(`type ${tAdd} bug --by pat --why "the menu crashes the sim on open"`);

    await guard('2.67.0 (B-38): on a red trunk only fix tasks start, and the owner type decides: a "Fix …" title the owner made "docs" is refused, an "Add …" title the owner made "bug" starts (fails on 2.66.0: the title decided both)', () => {
      const red = task('trunk red --by pat --why "the whole-game check is red"');
      const s1 = task(`start ${tFix} --agent bld-1`, { STUDIO_LOCK_OWNER: 'bld-1' });
      const s2 = task(`start ${tAdd} --agent bld-2`, { STUDIO_LOCK_OWNER: 'bld-2' });
      task('trunk green --by pat');
      const ok = r1.status === 0 && r2.status === 0 && red.status === 0 && s1.status !== 0 && /trunk is red/.test(out(s1)) && s2.status === 0;
      return [ok, `${out(r1).slice(-300)}\n${out(r2).slice(-300)}\n${out(red)}\ns1=${s1.status} ${out(s1).slice(-600)}\ns2=${s2.status} ${out(s2).slice(-600)}`];
    });

    await guard('2.67.0 (B-38): the hand-off\'s open bugs follow the owner type (the "Add …" task the owner made a bug is listed, the "Fix …" task made docs is not), and the token norms group a retyped task under its owner type (fails on 2.66.0: title and queued type won)', () => {
      const p = probe(dirD, 'bugs', `import { buildHandoff } from ${u(dirD, 'harness/handoff.mjs')};
import { tokenNorms } from ${u(dirD, 'harness/token-norms.mjs')};
const h = buildHandoff();
const ev = [{ type: 'task.added', task: 'T-950', meta: { type: 'bug' } }, { type: 'task.retyped', task: 'T-950', meta: { from: 'bug', to: 'docs' } }];
for (let i = 0; i < 5; i++) ev.push({ type: 'agent.session.end', agent: 'b' + i, task: 'T-950', tokensIn: 100 + i, tokensOut: 10 });
console.log(JSON.stringify({ bugs: h.bugs.map((t) => t.id), norms: Object.keys(tokenNorms({ events: ev })) }));\n`, env);
      const ok = Array.isArray(p.bugs) && p.bugs.includes(tAdd) && !p.bugs.includes(tFix) && JSON.stringify(p.norms) === '["docs"]';
      return [ok, JSON.stringify(p).slice(-2000)];
    });

    await guard('2.67.0 (B-38): `task visual <ID> off` exists: a render-looking title needs visual proof until the owner turns it off, then done-check\'s render decision says the owner\'s word (confirmed on 2.66.0 too)', () => {
      const before = task(`visual ${tRender}`);
      const set = task(`visual ${tRender} off --by pat --why "the foam pass is tuned numbers only"`);
      const after = task(`visual ${tRender}`);
      const ok = /visual proof needed/.test(out(before)) && set.status === 0 && /visual proof: off/.test(out(after));
      return [ok, `${out(before)}\n${out(set)}\n${out(after)}`];
    });
  }

  for (const d of [dirA, dirB, dirC, dirD]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {} }
}
