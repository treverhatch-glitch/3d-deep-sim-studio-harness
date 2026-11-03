/**
 * qa/selftest-2732d.mjs — 2.73.2 (helper d): per-test timeouts that fit the test workers (B-71), and the fix for a check
 * main is stuck red on trains alone and first (B-75).
 *   B-71  game-gates sizes test workers to the machine but the game's vitest kept its short testTimeout, so tests failed
 *         on time alone. Now a check whose command (or the npm script it calls) runs vitest/jest/node --test gets
 *         --testTimeout / --hookTimeout / --test-timeout = the game's own x ceil(4 x workers / cores) (1..4), never lower
 *         than the game set, shown in the check's row; a runtime flag (no file changes: the weakened-tests gate is quiet).
 *   B-75  a train that found main red on a game check (or the same check red in two trains in a row) remembers it; the
 *         next train puts a queued lane that changes that check's configuration (its vitest config here) first and alone.
 * Each check fails on 2.73.1 (no such flag, no such module, the fix lane trained with the others and stayed red).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2732D({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_HEAVY_SLOTS: '0', STUDIO_TEST_LOADAVG: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_SELF_TRIAGE: 'off', STUDIO_TIMEOUT_RERUN: 'off', STUDIO_GAME_GATE_CI: 'off', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', ...ident };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-2732d-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...base, ...env });
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return JSON.parse(line); } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ---------- B-71: a game check run through game-gates with 25 test workers on a 28-thread machine ----------
  {
    const S = path.join(tmpRoot, `2732d-gates-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/gates', '.studio/locks', '.studio/train', '.studio/gates-last.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const argsLog = path.join(tmpRoot, `args-2732d-${process.pid}.log`);
    // A fake vitest: its one heavy test takes 40 s under this load, so it passes only with a per-test timeout of 40 s or
    // more (the game's config says 15 s; --testTimeout, when given, wins as with the real runner).
    write(S, 'game/tt/vitest.mjs', [
      "import fs from 'node:fs';",
      "fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "const flag = process.argv.find((a) => a.startsWith('--testTimeout='));",
      "const cfg = Number((fs.readFileSync('vite.config.mjs', 'utf8').match(/testTimeout:\\s*([\\d_]+)/) || [])[1]?.replace(/_/g, '')) || 5000;",
      "const ms = flag ? Number(flag.split('=')[1]) : cfg;",
      "if (ms < 40000) { console.log(' FAIL  src/heavy.test.ts > heavy > soak');",
      "  console.log(`Error: Test timed out in ${ms}ms.`);",
      "  console.log(' Test Files  1 failed | 2 passed (3)'); console.log('      Tests  1 failed | 9 passed (10)'); process.exit(1); }",
      "console.log(' Test Files  3 passed (3)'); console.log('      Tests  10 passed (10)');", ''].join('\n'));
    write(S, 'game/tt/package.json', `${JSON.stringify({ name: 'tt', private: true, type: 'module', scripts: { test: 'node vitest.mjs run' } }, null, 2)}\n`);
    write(S, 'game/tt/vite.config.mjs', "export default { test: { environment: 'node', testTimeout: 15_000 } };\n");
    write(S, 'game/tt/src/heavy.test.ts', "import { it, expect } from 'vitest';\nit('soak', () => { expect(1).toBe(1); });\n");
    write(S, 'game/tt/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'cd game/tt && npm run test --silent' }] }, null, 2)}\n`);
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    g(S, 'checkout', '-q', '-b', 'lane/tt');
    write(S, 'game/tt/src/sim.ts', 'export const x = 1;\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'lane work', '--no-verify');
    const machine = JSON.stringify({ os: 'linux', cores: { logical: 28, performance: 8, efficiency: 12 }, ram: { totalGb: 32, freeGb: 20 } });
    const genv = { ...base, STUDIO_GAME: 'tt', STUDIO_TEST_WORKERS: '25', STUDIO_TEST_MACHINE: machine, ARGS_LOG: argsLog, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-2732d.jsonl') };
    const gg = (env = {}) => {
      fs.rmSync(argsLog, { force: true });
      const r = run(S, 'node harness/game-gates.mjs --json', { ...genv, ...env });
      let j = null;
      try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
      let args = [];
      try { args = fs.readFileSync(argsLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
      return { r, j, args, row: j?.rows?.find((x) => x.id === 'game:test') || null };
    };
    const loaded = gg();
    const status = g(S, 'status', '--porcelain').stdout.trim();
    const weak = run(S, 'node harness/test-weakening.mjs --json', { ...genv, STUDIO_WEAKENED_TESTS: 'on', STUDIO_PROTECT_BASE: 'main' });
    let wj = null;
    try { wj = JSON.parse(String(weak.stdout).trim().split('\n').pop()); } catch {}
    const offRun = gg({ STUDIO_TEST_TIMEOUT_SCALE: 'off' });
    const quiet = gg({ STUDIO_TEST_WORKERS: '2' });
    await guard('2.73.2 (d, B-71): a game check whose npm script runs vitest, with 25 test workers on 28 logical cores, gets --testTimeout=60000 --hookTimeout=40000 (its config\'s 15 s and vitest\'s 10 s hook default x ceil(4 x 25 / 28) = 4), passes, prints "per-test timeout 60 s" and keeps "testTimeout": { ms 60000, baseMs 15000, factor 4, flags } in its row; no file changes (git status clean) and the weakened-tests gate finds nothing; STUDIO_TEST_TIMEOUT_SCALE=off and 2 workers pass no flag (red on the 15 s timeout) (fails on 2.73.1: no flag, the check is red on time alone)', () => [
      loaded.r.status === 0 && loaded.j?.ok === true && JSON.stringify(loaded.args[0]) === JSON.stringify(['run', '--testTimeout=60000', '--hookTimeout=40000'])
        && /\[game-gates\] game:test: per-test timeout 60 s \(vitest, npm script "test": --testTimeout=60000 --hookTimeout=40000; x4 \(25 test workers on 28 logical cores/.test(out(loaded.r))
        && loaded.row?.testTimeout?.ms === 60000 && loaded.row.testTimeout.baseMs === 15000 && loaded.row.testTimeout.factor === 4 && loaded.row.testTimeout.hookMs === 40000 && loaded.row.testTimeout.applied === true && /vite\.config\.mjs/.test(loaded.row.testTimeout.from || '')
        && status === '' && weak.status === 0 && Array.isArray(wj?.findings) && wj.findings.length === 0
        && offRun.r.status === 1 && JSON.stringify(offRun.args[0]) === '["run"]' && /STUDIO_TEST_TIMEOUT_SCALE=off/.test(out(offRun.r))
        && quiet.r.status === 1 && JSON.stringify(quiet.args[0]) === '["run"]' && quiet.row?.testTimeout?.applied === false,
      JSON.stringify({ loaded: { status: loaded.r.status, args: loaded.args, row: loaded.row, tail: out(loaded.r).slice(-1500) }, status, weak: out(weak).slice(-600), off: { s: offRun.r.status, a: offRun.args }, quiet: { s: quiet.r.status, a: quiet.args, row: quiet.row?.testTimeout } }).slice(0, 3000)]);
    fs.rmSync(S, { recursive: true, force: true });
    fs.rmSync(argsLog, { force: true });
  }

  // ---------- B-71: the pure rules: never lower, unreadable left alone, jest, node --test, the override ----------
  {
    const P = path.join(tmpRoot, `2732d-pure-${process.pid}`);
    write(P, 'game/a/package.json', JSON.stringify({ scripts: { test: 'tsc -b && vitest run', t2: 'vitest run --testTimeout=9000', j: 'jest' }, jest: { testTimeout: 7000 } }));
    write(P, 'game/a/vite.config.ts', 'export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 30_000 } })\n');
    write(P, 'game/b/vite.config.ts', 'const slow = 3;\nexport default defineConfig({ test: { testTimeout: 5000 * slow } })\n');
    write(P, 'game/c/vitest.config.mjs', 'export default { test: { projects: ["a", "b"] } }\n');
    const r = probe('pure', `import { scaleTestTimeouts as s, workerFactor } from ${u('harness/test-timeouts.mjs')};
const P = ${JSON.stringify(P)};
const at = (command, workers = 25, env = {}, cores = 28) => s({ command, root: P, workers, cores, env });
console.log(JSON.stringify({
  wf: [workerFactor(2, 28), workerFactor(7, 28), workerFactor(8, 28), workerFactor(25, 28), workerFactor(64, 8), workerFactor(1, 2)],
  big: at('cd game/a && npm run test --silent').command,
  flagged: at('cd game/a && npm run t2').info,
  expr: at('cd game/b && npx vitest run').info,
  proj: at('cd game/c && npx vitest run').info,
  jest: at('cd game/a && npm run j').command,
  node: at('node --test --test-timeout=2000 t/*.test.mjs').command,
  nodeNone: at('node --test t/x.test.mjs').info,
  scale: at('cd game/a && npx vitest run', 25, { STUDIO_TEST_TIMEOUT_SCALE: '1.5' }).command,
  gate: s({ command: 'cd game/a && npx vitest run', root: P, workers: 2, cores: 28, gateFactor: 2.5, env: {} }).command,
  none: at('node tools/check.mjs').info,
}));
`);
    await guard('2.73.2 (d, B-71): the factor is ceil(4 x workers / cores), 1..4 (2/28 -> 1, 8/28 -> 2, 25/28 -> 4, 64/8 -> 4, 1 worker -> 1); the base is the game\'s own (120 s config -> --testTimeout=480000, hook 30 s -> 120000, never lower); a timeout the harness can\'t read (an expression, a vitest projects config, a flag already in the npm script) is left alone saying why; jest gets its package.json "jest" testTimeout x4, node --test its own --test-timeout x4 (none: nothing to scale); STUDIO_TEST_TIMEOUT_SCALE=1.5 replaces the worker factor; the gate\'s load factor counts; a plain node check is untouched (fails on 2.73.1: no harness/test-timeouts.mjs)', () => [
      JSON.stringify(r.wf) === '[1,1,2,4,4,1]' && r.big === 'cd game/a && npm run test --silent -- --testTimeout=480000 --hookTimeout=120000'
        && r.flagged?.applied === false && /already passes --testTimeout/.test(r.flagged.why) && r.expr?.applied === false && /isn't a number literal/.test(r.expr.why)
        && r.proj?.applied === false && /projects/.test(r.proj.why) && r.jest === 'cd game/a && npm run j -- --testTimeout=28000'
        && r.node === 'node --test --test-timeout=8000 t/*.test.mjs' && r.nodeNone?.applied === false && /nothing to scale/.test(r.nodeNone.why)
        && r.scale === 'cd game/a && npx vitest run --testTimeout=180000 --hookTimeout=45000' && r.gate === 'cd game/a && npx vitest run --testTimeout=300000 --hookTimeout=75000' && r.none === null,
      JSON.stringify(r).slice(0, 2500)]);
    fs.rmSync(P, { recursive: true, force: true });
  }

  // ---------- B-75: main red on a game check; the lane that changes its config trains alone and first ----------
  {
    const S = path.join(tmpRoot, `2732d-train-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/locks', '.studio/gates', '.studio/train', '.studio/decisions.jsonl', '.studio/gates-last.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const events = path.join(S, '.studio', 'events-2732d.jsonl');
    const env = { ...base, STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_DONE_NOOP: 'allow', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_MIN: '', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_WAIT_MIN: '', STUDIO_TRAIN_RIDE_ALONG: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2732d-${process.pid}.pem`), AGENT_EVENTS_FILE: events };
    const person = { ...env, STUDIO_LOCK_OWNER: '' };
    const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const board = () => `${fs.existsSync(path.join(S, 'studio/NEXT.md')) ? fs.readFileSync(path.join(S, 'studio/NEXT.md'), 'utf8') : ''}`;
    const doneBoard = () => `${fs.existsSync(path.join(S, 'studio/DONE.md')) ? fs.readFileSync(path.join(S, 'studio/DONE.md'), 'utf8') : ''}`;
    const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
    const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
    write(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    write(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    // The game's check: its slow test needs 60 s under this machine's load (120 s with a note that says HEAVY: a lane that
    // really breaks it); the timeout is its test config's.
    write(S, 'game/demo/check.mjs', [
      "import fs from 'node:fs';",
      "const ms = Number((fs.readFileSync('game/demo/vitest.config.mjs', 'utf8').match(/testTimeout:\\s*([\\d_]+)/) || [])[1]?.replace(/_/g, '')) || 5000;",
      "const heavy = fs.existsSync('game/demo/notes/b.md') && fs.readFileSync('game/demo/notes/b.md', 'utf8').includes('HEAVY');",
      "if (ms < (heavy ? 120000 : 60000)) { console.log(' FAIL  game/demo/src/pacing.test.ts > pacing > a season'); console.log(`Error: Test timed out in ${ms}ms.`); process.exit(1); }",
      "console.log('demo ok');", ''].join('\n'));
    write(S, 'game/demo/vitest.config.mjs', 'export default { test: { testTimeout: 15_000 } };\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    g(S, 'config', 'core.hooksPath', 'scripts/hooks');
    const addTask = (title) => (out(run(S, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
    const laneProbe = path.join(tmpRoot, `lane-2732d-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
    const lane = (agent, title, files) => {
      const id = addTask(title);
      run(S, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(S, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: S, STUDIO_LOCK_OWNER: agent };
      const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
      g(ld, 'add', '-A');
      const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
      return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(st)}\n${out(c)}` };
    };
    const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
    const train = () => run(S, 'node harness/task.mjs train --by tester', env);
    const n1 = lane('doc-a', 'Docs: note a', { 'game/demo/notes/a.md': '# A\n' });
    const n2 = lane('doc-b', 'Docs: note b', { 'game/demo/notes/b.md': '# B\nHEAVY\n' });
    const fx = lane('fix-t', 'Tests: per-test timeout that fits the workers', { 'game/demo/vitest.config.mjs': 'export default { test: { testTimeout: 60_000 } };\n' });
    const n3 = lane('doc-c', 'Docs: note c', { 'game/demo/notes/c.md': '# C\n' });
    const qs = [n1, n2, fx, n3].map(queueIt);
    const t1 = train(); // main is red: nothing lands; the fix (a protected test config) is held for the owner
    const streakFile = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'red-streak.json'), 'utf8')); } catch { return null; } };
    const after1 = { done: [n1, n2, fx, n3].some((l) => isDone(l.id)), streak: streakFile() };
    const rel = run(S, `node harness/task.mjs train release ${fx.id} --by Dana`, person);
    const since = evs().length;
    const t2 = train(); // the fix first and alone (it lands), then a train of the other three on the green main
    const ev2 = evs().slice(since);
    const ff = ev2.find((e) => e.type === 'task.train.fix_first');
    const mainCfg = g(S, 'show', 'main:game/demo/vitest.config.mjs').stdout || '';
    const fixLanded = isDone(fx.id) && /60_000/.test(mainCfg);
    // The trains of this run, in order, as the log names them ("this train: ..."), and the landings in order.
    const trains2 = out(t2).split('\n').filter((l) => /: this train: /.test(l)).map((l) => l.split(': this train: ')[1]);
    const landings = ev2.filter((e) => e.type === 'task.train.landed').map((e) => (e.meta?.lanes || []).join(','));
    const streakAfter = streakFile();
    await guard('2.73.2 (d, B-75): with main red on its game check (a 15 s per-test timeout), once the queued lane that changes that check\'s test config (vitest.config.mjs, third of four in the queue) is released, a train that finds main red records it (.studio/train/red-streak.json); the next train puts it first and alone (task.train.fix_first naming the check and the file, "this train: <fix> (tier C, alone)", "trains alone and first"), it lands first on main; on the now-green main the follow-on trains of the other 3 find the lane that really breaks the check (a HEAVY note) and hand it back, the other two land, and the red streak is cleared (fails on 2.73.1: the fix rode with the other lanes, the combined train stayed red, "main itself is red" deferred every lane, nothing landed)', () => [
      [n1, n2, fx, n3].every((l) => l.ok) && qs.every((q) => q.status === 0) && /itself fails its checks/.test(out(t1)) && !after1.done && after1.streak?.trains?.[0]?.redMain === true && after1.streak.trains[0].gates.includes('game') && rel.status === 0
        && fixLanded && ff?.task === fx.id && ff.meta?.gates?.includes('game') && ff.meta?.files?.includes('game/demo/vitest.config.mjs')
        && /trains alone and first/.test(out(t2)) && trains2[0] === `${fx.id} (tier C, alone)` && trains2[1] === `${n1.id} (tier A), ${n2.id} (tier A), ${n3.id} (tier A)`
        && landings[0] === fx.id && landings.slice(1).join(',').split(',').sort().join(',') === [n1.id, n3.id].sort().join(',') && JSON.stringify(streakAfter?.trains) === '[]'
        && isDone(n1.id) && isDone(n3.id) && !isDone(n2.id) && ev2.some((e) => e.type === 'task.train.dropped' && e.task === n2.id) && queue().length === 0,
      JSON.stringify({ after1, t2s: t2.status, lanes: [n1, n2, fx, n3].map((l) => l.ok || l.log.slice(-300)), q: qs.map((q) => q.status === 0 || out(q).slice(-300)), t1: out(t1).slice(-800), rel: out(rel).slice(-300), t2: out(t2).slice(-1500), trains2, landings, ff: ff?.meta, mainCfg, queue: queue(), streakAfter }).slice(0, 3500)]);
    try { fs.rmSync(laneProbe, { force: true }); } catch {}
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {}
  }

  // ---------- B-75: the pure rules: two reds in a row, a landing clears, once per head, off ----------
  {
    const P = path.join(tmpRoot, `2732d-ff-${process.pid}`);
    fs.mkdirSync(P, { recursive: true });
    const r = probe('ff', `import { noteTrainRed, noteTrainLanded, stuckChecks, noteFixTried, fixFirstOrder } from ${u('harness/train-fix-first.mjs')};
const P = ${JSON.stringify(P)};
const git = (cwd, args) => args[0] === 'show' ? { status: 1, stdout: '' } : { status: 0, stdout: args.at(-1).endsWith('fix') ? 'web/g/vite.config.ts\\nweb/g/src/a.ts\\n' : 'web/g/src/b.ts\\n' };
const lanes = [{ task: 'T-1', head: 'h-doc' }, { task: 'T-2', head: 'h-fix' }, { task: 'T-3', head: 'h-doc2' }];
const o = (env = {}) => fixFirstOrder(P, lanes, { tip: 'tip', gameIds: ['game'], git, env });
const r = {};
r.none = stuckChecks(P);
noteTrainRed(P, { id: 'a', gates: ['game', 'docs'] });
r.one = stuckChecks(P);
noteTrainRed(P, { id: 'b', gates: ['game'] });
r.two = stuckChecks(P);
r.order = o().lanes.map((l) => l.task + (l.fixFirst ? '*' : ''));
r.off = o({ STUDIO_TRAIN_FIX_FIRST: 'off' }).fix;
r.own = fixFirstOrder(P, [{ ...lanes[0], own: true }, lanes[1]], { tip: 'tip', gameIds: ['game'], git }).fix;
noteFixTried(P, 'T-2', 'h-fix');
const again = o();
r.again = again.fix; r.note = again.note;
noteTrainLanded(P);
r.cleared = stuckChecks(P);
noteTrainRed(P, { id: 'c', gates: ['docs'] }); noteTrainRed(P, { id: 'd', gates: ['docs'] });
r.notGame = stuckChecks(P);
noteTrainRed(P, { id: 'e', gates: ['game'], redMain: true });
r.redMain = stuckChecks(P);
console.log(JSON.stringify(r));
`);
    await guard('2.73.2 (d, B-75): a game check red in two trains in a row (or red on main itself in one) is "stuck"; a lane whose diff changes a game test config (web/g/vite.config.ts) is moved first and marked to run alone; STUDIO_TRAIN_FIX_FIRST=off, an agent\'s own train for another lane, and a fix lane already tried at the same head move nothing (the note says why); a landing clears the streak; a non-game check never counts (fails on 2.73.1: no harness/train-fix-first.mjs)', () => [
      r.none === null && r.one === null && JSON.stringify(r.two?.gates) === '["game"]' && /last two trains in a row \(a, b\)/.test(r.two?.why || '')
        && JSON.stringify(r.order) === '["T-2*","T-1","T-3"]' && r.off === null && r.own === null && r.again === null && /already trained alone at this commit/.test(r.note || '')
        && r.cleared === null && r.notGame === null && JSON.stringify(r.redMain?.gates) === '["game"]' && /on main itself in train e/.test(r.redMain?.why || ''),
      JSON.stringify(r).slice(0, 2000)]);
    fs.rmSync(P, { recursive: true, force: true });
  }
}
