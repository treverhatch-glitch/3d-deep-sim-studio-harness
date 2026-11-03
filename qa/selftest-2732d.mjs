/**
 * qa/selftest-2732d.mjs — 2.73.2 (helper d): per-test timeouts that fit the test workers (B-71).
 *   B-71  game-gates sizes test workers to the machine but the game's vitest kept its short testTimeout, so tests failed
 *         on time alone. Now a check whose command (or the npm script it calls) runs vitest/jest/node --test gets
 *         --testTimeout / --hookTimeout / --test-timeout = the game's own x ceil(4 x workers / cores) (1..4), never lower
 *         than the game set, shown in the check's row; a runtime flag (no file changes: the weakened-tests gate is quiet).
 * Each check fails on 2.73.1 (no such flag, no such module).
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
}
