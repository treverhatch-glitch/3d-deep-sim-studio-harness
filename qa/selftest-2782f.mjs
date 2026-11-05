/**
 * qa/selftest-2782f.mjs — 2.78.2 (f): what the harness tells the game's test runner, and whether it is heard.
 *   Quarantine  game-gates printed "N quarantined test file(s) skipped by the game's runner" while the game's test
 *               config never read STUDIO_TEST_QUARANTINE: the tests ran and failed trains. Now "skipped" only once the
 *               runner's list mode drops them (once per test config, cached); else a WARN "quarantine NOT honoured";
 *               onboarding's check and the upgrade preflight FAIL such a config.
 *   Focus       a test check with no "focus" made every train re-check re-run the whole suite. A check whose npm
 *               script runs vitest or jest gets one inferred; a test check with neither FAILs onboarding / preflight.
 *   Timing      ms-budget asserts in the normal suites: an advisory "WARN game:test-timing" names them.
 *   Perf        a lane verify whose game:perf step said "not run (busy)" stood for the train's verify of the same tree:
 *               the train now runs that step on the tree before it counts the record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782F({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TRAIN_BISECT: 'prefix', STUDIO_LANDING_BUILD: 'off',
    STUDIO_TRAIN_PIPELINE: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  let n = 0;
  const made = [];

  // ---- A web-style game: game/demo runs `npm test` (its script: `vitest run`), a made-up vitest in its node_modules ----
  // The made-up vitest reads game/demo/vitest.config.mjs ({ exclude: [...] }) and game/demo/tests/*.test.mjs:
  //   `vitest list --filesOnly` prints the files not excluded; `vitest run [files]` runs them (a file named in
  //   game/demo/notes.md as "RED <name>" fails). Every run is logged in game/demo/runs.log.
  const FAKE = [
    "import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';",
    "const cfg = (await import(pathToFileURL(path.resolve('vitest.config.mjs')).href + `?t=${Date.now()}`)).default || {};",
    "const ex = (cfg.exclude || []).map(String);",
    "const args = process.argv.slice(2); const sub = args[0]; const pos = args.slice(1).filter((a) => !a.startsWith('-') && !/^\\d+$/.test(a));",
    "const all = fs.readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);",
    "let list = (pos.length ? pos : all).filter((f) => !ex.some((e) => f === e || f.endsWith(`/${e}`)));",
    "fs.appendFileSync('runs.log', `${sub} ${list.join(',')}\\n`);",
    "if (sub === 'list') { for (const f of list) console.log(f); process.exit(0); }",
    "const notes = fs.existsSync('notes.md') ? fs.readFileSync('notes.md', 'utf8') : '';",
    "let bad = 0;",
    "for (const f of list) { if (notes.includes(`RED ${path.basename(f)}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`); }",
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    "process.exit(bad ? 1 : 0);", ''].join('\n');
  const HONOUR = "export default { exclude: [...JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]'), ...(process.env.STUDIO_TEST_EXCLUDE || '').split(',').filter(Boolean)] };\n";
  const IGNORE = 'export default { exclude: [] };\n';
  const webStudio = (name, { config = IGNORE, gate = { id: 'unit', command: 'cd game/demo && npm test' }, script = 'vitest run', tests = ['a', 'b'] } = {}) => {
    const S = path.join(tmpRoot, `2782f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    for (const f of ['beta.json', 'game.json', 'quarantine.json']) fs.rmSync(path.join(S, 'studio', f), { force: true });
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [gate] }, null, 2)}\n`);
    writeIn(S, 'game/demo/package.json', `${JSON.stringify({ name: 'demo', private: true, type: 'module', scripts: { test: script } }, null, 2)}\n`);
    writeIn(S, 'game/demo/vitest.config.mjs', config);
    writeIn(S, 'game/demo/fake-vitest.mjs', FAKE);
    writeIn(S, 'game/demo/run-plain.mjs', "console.log('ran'); process.exit(0);\n");
    writeIn(S, 'game/demo/node_modules/.bin/vitest', '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.mjs" "$@"\n');
    try { fs.chmodSync(path.join(S, 'game/demo/node_modules/.bin/vitest'), 0o755); } catch {}
    writeIn(S, 'game/demo/node_modules/.bin/vitest.cmd', '@node "%~dp0\\..\\..\\fake-vitest.mjs" %*\r\n');
    for (const t of tests) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return S;
  };
  const quarantine = (S, tests) => writeIn(S, 'studio/quarantine.json', `${JSON.stringify(tests.map((t) => ({ test: t, status: 'active', check: 'game:unit' })), null, 2)}\n`);
  const gg = (S, env = {}) => { const r = spawnSync(process.execPath, ['harness/game-gates.mjs'], { windowsHide: true, cwd: S, env: { ...process.env, ...base, ...env }, encoding: 'utf8', timeout: 180000 }); return { status: r.status, text: `${r.stdout || ''}${r.stderr || ''}` }; };
  const runs = (S) => { try { return fs.readFileSync(path.join(S, 'game/demo/runs.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const lines = (t, re) => t.split('\n').filter((l) => re.test(l)).slice(0, 4);

  // ---- 13 (a): "skipped" only when verified ----
  await guard('2.78.2 (f, quarantine): with a quarantined file and a test config that never reads STUDIO_TEST_QUARANTINE, game-gates runs the runner\'s list mode (npx --no vitest list --filesOnly, in the check\'s folder) without and with the variable, finds the file still listed and prints "WARN game:quarantine: quarantine NOT honoured by the game\'s test config (game/demo/vitest.config.mjs): 1 quarantined tests still run" (never "skipped"; the row counts 0 skipped); a config that reads it gets "skipped by the game\'s runner (... verified ...)", the verdict cached in .studio/test-config-check.json (a second run lists nothing again); STUDIO_QUARANTINE_VERIFY=off: "not verified", never "skipped" (fails on 2.78.1: "1 quarantined test file(s) skipped by the game\'s runner" whatever the config did)', async () => {
    const S = webStudio('qIgnore');
    quarantine(S, ['tests/b.test.mjs']);
    writeIn(S, 'game/demo/notes.md', 'RED b.test.mjs\n');
    const bad = gg(S);
    const badJson = spawnSync(process.execPath, ['harness/game-gates.mjs', '--json'], { windowsHide: true, cwd: S, env: { ...process.env, ...base }, encoding: 'utf8', timeout: 180000 });
    let row = null; try { row = JSON.parse(String(badJson.stdout).trim().split('\n').pop()).rows.find((r) => r.id === 'game:unit'); } catch {}
    const S2 = webStudio('qHonour', { config: HONOUR });
    quarantine(S2, ['tests/b.test.mjs']);
    writeIn(S2, 'game/demo/notes.md', 'RED b.test.mjs\n');
    const good = gg(S2);
    const runs1 = runs(S2).length;
    const good2 = gg(S2);
    const listsAfter = runs(S2).slice(runs1).filter((l) => l.startsWith('list'));
    const cache = readJ(path.join(S2, '.studio', 'test-config-check.json'));
    const offed = gg(S, { STUDIO_QUARANTINE_VERIFY: 'off' });
    const ok = /\[game-gates\] WARN game:quarantine: quarantine NOT honoured by the game's test config \(game\/demo\/vitest\.config\.mjs\): 1 quarantined tests still run/.test(bad.text) && !/skipped by the game's runner/.test(bad.text) && bad.status === 1
      && row?.quarantine?.skipped === 0 && row?.quarantine?.state === 'not-honoured'
      && good.status === 0 && /1 quarantined test file\(s\) skipped by the game's runner \(STUDIO_TEST_QUARANTINE; verified/.test(good.text) && !/NOT honoured/.test(good.text)
      && /cached for this test config/.test(good2.text) && listsAfter.length === 0 && cache && Object.values(cache).some((v) => v.state === 'honoured')
      && runs(S2).some((l) => l === 'list tests/a.test.mjs,tests/b.test.mjs') && runs(S2).some((l) => l === 'list tests/a.test.mjs')
      && /not verified that its test config skips them: STUDIO_QUARANTINE_VERIFY=off/.test(offed.text) && !/skipped by the game's runner/.test(offed.text);
    return [ok, JSON.stringify({ bad: [bad.status, lines(bad.text, /quarantin/)], row: row?.quarantine, good: [good.status, lines(good.text, /quarantin/)], good2: lines(good2.text, /quarantin/), listsAfter, runs: runs(S2), offed: lines(offed.text, /quarantin/) }).slice(0, 3800)];
  });

  // ---- 13 (b) + 14 (b): onboarding's check and the upgrade preflight FAIL ----
  await guard('2.78.2 (f, check): `npm run onboard -- --check` (and the upgrade preflight\'s items) FAIL "game-tests/quarantine:unit" for a test config that ignores STUDIO_TEST_QUARANTINE, with a Fix naming the config and STUDIO_TEST_QUARANTINE / STUDIO_TEST_EXCLUDE, and PASS it for one that reads it; a test check with no "focus" whose command runs neither vitest nor jest (npm test -> node run-plain.mjs) FAILs "game-tests/focus:unit" with a Fix naming "focus"; the same check with a declared focus, or an npm script that runs vitest (inferred), PASSes (fails on 2.78.1: no --check, and the preflight has no game-tests items)', async () => {
    const run = (S) => { const r = spawnSync(process.execPath, ['scripts/onboard-game.mjs', '--check'], { windowsHide: true, cwd: S, env: { ...process.env, ...base }, encoding: 'utf8', timeout: 180000 }); return { status: r.status, text: `${r.stdout || ''}${r.stderr || ''}` }; };
    const S = webStudio('chkIgnore');
    const bad = run(S);
    const S2 = webStudio('chkHonour', { config: HONOUR });
    const good = run(S2);
    const S3 = webStudio('chkPlain', { script: 'node run-plain.mjs' });
    const plain = run(S3);
    const S4 = webStudio('chkFocus', { script: 'node run-plain.mjs', gate: { id: 'unit', command: 'cd game/demo && npm test', focus: 'cd game/demo && node run-plain.mjs {files}' } });
    const focused = run(S4);
    // The preflight's own list, read from the studio (its game-tests items; the rest of the preflight is not judged here).
    let pf = null;
    try {
      const probe = path.join(S, '.probe-2782f-pf.mjs');
      fs.writeFileSync(probe, `import { preflight } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'upgrade-preflight.mjs')).href)};\nconst r = await preflight({ root: process.cwd() });\nconsole.log(JSON.stringify(r.items.filter((i) => /^game-tests/.test(i.id))));\n`);
      const r = spawnSync(process.execPath, [probe], { windowsHide: true, cwd: S, env: { ...process.env, ...base }, encoding: 'utf8', timeout: 180000 });
      pf = JSON.parse(String(r.stdout).trim().split('\n').pop());
    } catch {}
    const ok = bad.status === 1 && /\[onboard check\] FAIL game-tests\/quarantine:unit: quarantine NOT honoured by the game's test config \(game\/demo\/vitest\.config\.mjs\)/.test(bad.text) && /Fix: in game\/demo\/vitest\.config\.mjs, make test\.exclude read them: .*STUDIO_TEST_QUARANTINE.*STUDIO_TEST_EXCLUDE/.test(bad.text)
      && /PASS game-tests\/focus:unit: a train re-check runs single test files \(focus inferred/.test(bad.text)
      && good.status === 0 && /PASS game-tests\/quarantine:unit: its test config honours STUDIO_TEST_QUARANTINE/.test(good.text)
      && plain.status === 1 && /FAIL game-tests\/focus:unit: the test check unit has no "focus" command/.test(plain.text) && /Fix: add "focus": /.test(plain.text)
      && focused.status === 0 && /PASS game-tests\/focus:unit: a train re-check runs single test files \(the manifest's "focus" command\)/.test(focused.text)
      && Array.isArray(pf) && pf.some((i) => i.id === 'game-tests/quarantine:unit' && i.status === 'FAIL' && /STUDIO_TEST_QUARANTINE/.test(i.fix || ''));
    return [ok, JSON.stringify({ bad: [bad.status, lines(bad.text, /game-tests|Fix/)], good: [good.status, lines(good.text, /game-tests/)], plain: [plain.status, lines(plain.text, /game-tests|Fix/)], focused: [focused.status, lines(focused.text, /focus/)], pf }).slice(0, 3800)];
  });

  // ---- 14 (a): the inferred focus command ----
  await guard('2.78.2 (f, focus): a train\'s focused re-check of a check whose command is `cd game/demo && npm test` (its script: vitest run) runs only the failing file through an inferred "cd game/demo && npx vitest run {files}", saying "focus inferred: ..." once; inferFocus keeps a script\'s --config and gives `npx jest {files}` for jest; STUDIO_FOCUS_INFER=off: the whole check runs, as before (fails on 2.78.1: "the whole check runs, not a focused re-check": npm test doesn\'t clearly run vitest)', async () => {
    const S = webStudio('focus', { tests: ['a', 'b', 'c'] });
    writeIn(S, 'game/demo/notes.md', 'RED b.test.mjs\n');
    const focus = JSON.stringify({ 'game:unit': ['tests/b.test.mjs'] });
    const f1 = gg(S, { STUDIO_GATE_FOCUS: focus });
    const r1 = runs(S);
    fs.rmSync(path.join(S, 'game/demo/runs.log'), { force: true });
    const f2 = gg(S, { STUDIO_GATE_FOCUS: focus, STUDIO_FOCUS_INFER: 'off' });
    const r2 = runs(S);
    const inferFocus = (await imp('harness/train-focus.mjs')).inferFocus || (() => ({ focus: undefined, why: 'no inferFocus' }));
    const R = fs.mkdtempSync(path.join(tmpRoot, '2782f-inf-')); made.push(R);
    writeIn(R, 'g/package.json', JSON.stringify({ scripts: { test: 'tsc -b && vitest run -c vitest.unit.config.ts', jt: 'jest --ci', plain: 'node x.mjs' } }));
    const a = inferFocus('cd g && npm test', { root: R, env: {} });
    const b = inferFocus('npm run unpack && cd g && npm run jt', { root: R, env: {} });
    const c = inferFocus('cd g && npm run plain', { root: R, env: {} });
    const ok = /\[game-gates\] game:unit: focus inferred: cd game\/demo && npx vitest run \{files\}/.test(f1.text) && (f1.text.match(/focus inferred:/g) || []).length <= 2
      && r1.length === 1 && r1[0] === 'run tests/b.test.mjs' && f1.status === 1
      && /the whole check runs, not a focused re-check/.test(f2.text) && r2.some((l) => l === 'run tests/a.test.mjs,tests/b.test.mjs,tests/c.test.mjs')
      && a.focus === 'cd g && npx vitest run --config vitest.unit.config.ts {files}' && b.focus === 'npm run unpack && cd g && npx jest {files}' && c.focus === null;
    return [ok, JSON.stringify({ f1: lines(f1.text, /focus|focused/), r1, f2: lines(f2.text, /focus|whole/), r2, a, b, c }).slice(0, 3800)];
  });

  // ---- 15: wall-clock asserts outside the perf tests ----
  await guard('2.78.2 (f, timing): game-gates prints "WARN game:test-timing: <file>:<line> asserts on wall-clock time" for a test asserting an elapsed performance.now() / Date.now() / hrtime value (or an average of one) against a bound, never for one under the perf globs, one that only logs or seeds with Date.now(), or a lower bound (waited at least N ms); the check stays green; STUDIO_TEST_TIMING=off hides it (fails on 2.78.1: no such check)', async () => {
    const S = webStudio('timing', { config: HONOUR, tests: ['a'] });
    writeIn(S, 'studio/game.json', `${JSON.stringify({ game: 'demo', perfTests: ['**/*.perf.test.mjs'] }, null, 2)}\n`);
    writeIn(S, 'game/demo/tests/layout.test.mjs', "import { expect, it } from 'vitest';\nit('lays out fast', () => {\n  const t0 = performance.now();\n  layout();\n  const ms = performance.now() - t0;\n  expect(ms).toBeLessThan(40);\n});\n");
    writeIn(S, 'game/demo/tests/probe.test.mjs', "let total = 0;\nfor (const k of kinds) { const t = performance.now(); probe(k); total += performance.now() - t; }\nconst avg = total / kinds.length;\nexpect(avg).toBeLessThan(2); // each kind averages under 2 ms\nconst s = process.hrtime.bigint();\nrun();\nassert.ok(Number(process.hrtime.bigint() - s) / 1e6 < 16);\n");
    writeIn(S, 'game/demo/tests/fine.test.mjs', "const seed = Date.now();\nconst t0 = performance.now();\nconsole.log('took', performance.now() - t0);\nexpect(sim(seed).score).toBeLessThan(40);\nconst w = Date.now();\nawait wait(100);\nexpect(Date.now() - w).toBeGreaterThanOrEqual(100);\n");
    writeIn(S, 'game/demo/tests/budget.perf.test.mjs', "const t0 = performance.now();\nf();\nexpect(performance.now() - t0).toBeLessThan(40);\n");
    const r = gg(S);
    const offed = gg(S, { STUDIO_TEST_TIMING: 'off' });
    const w = lines(r.text, /game:test-timing/).concat(r.text.split('\n').filter((l) => /game:test-timing/.test(l)).slice(4));
    const ok = r.status === 0 && w.some((l) => /WARN game:test-timing: game\/demo\/tests\/layout\.test\.mjs:6 asserts on wall-clock time \(expect\(ms\)\.toBeLessThan\(40\);\)/.test(l))
      && w.some((l) => /probe\.test\.mjs:4 /.test(l)) && w.some((l) => /probe\.test\.mjs:7 /.test(l))
      && !w.some((l) => /fine\.test\.mjs|budget\.perf\.test\.mjs/.test(l)) && w.some((l) => /3 wall-clock assertion\(s\) in 2 test file\(s\) outside the perf tests \(\*\*\/\*\.perf\.test\.mjs\).*STUDIO_TEST_TIMING=off/.test(l))
      && offed.status === 0 && !/game:test-timing/.test(offed.text);
    return [ok, JSON.stringify({ status: r.status, w, offed: offed.status, tail: r.text.slice(-600) }).slice(0, 3800)];
  });

  // ---- 2.78.2 (b) follow-up: a reused verify whose game:perf step did not run ----
  // The 2782b studio: game/demo's runner (node) reads game/demo/notes/*.md ("RED <file>") and honours STUDIO_TEST_ONLY /
  // STUDIO_TEST_EXCLUDE; runs are logged in .studio/runs-2782f.log.
  const trainStudio = (name) => {
    const S = path.join(tmpRoot, `2782f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2782f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/run-tests.mjs', [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const re = (g) => new RegExp(`^${g.split('**/').map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('[^/]*')).join('(?:.*/)?')}$`);",
      "const globs = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map(re);",
      "const only = globs(process.env.STUDIO_TEST_ONLY); const skip = globs(process.env.STUDIO_TEST_EXCLUDE);",
      "const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));",
      "const d = 'game/demo/tests';",
      "let list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
      "if (only.length) list = list.filter((f) => only.some((r) => r.test(f)));",
      "list = list.filter((f) => !skip.some((r) => r.test(f)));",
      "const notes = fs.existsSync('game/demo/notes') ? fs.readdirSync('game/demo/notes').map((f) => fs.readFileSync(path.join('game/demo/notes', f), 'utf8')).join('\\n') : '';",
      "const main = process.env.STUDIO_MAIN_ROOT || process.cwd();",
      "try { fs.appendFileSync(path.join(main, '.studio', 'runs-2782f.log'), `${list.join(',')} only=${process.env.STUDIO_TEST_ONLY || '-'} owner=${process.env.STUDIO_LOCK_OWNER || '-'}\\n`); } catch {}",
      "let bad = 0;",
      "for (const f of list) { const b = path.basename(f); if (notes.includes(`RED ${b}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`); }",
      "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
      "process.exit(bad ? 1 : 0);", ''].join('\n'));
    for (const t of ['a', 'p.perf']) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    writeIn(S, 'studio/game.json', `${JSON.stringify({ game: 'demo', perfTests: ['**/*.perf.test.mjs'] }, null, 2)}\n`);
    writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-961** [P1] (`builder`) — made-up task T-961\n\n## BACKLOG\n\n## DONE\n');
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'quarantine.json'), { force: true });
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const env = { ...base, STUDIO_GAME: '', AGENT_EVENTS_FILE: ev, STUDIO_PERF_WAIT_MIN: '0.02', STUDIO_TRAIN_BUSY_WAIT_MIN: '0' };
    const lane = (notes) => {
      const d = path.join(S, '.lanes', 'l1');
      gitIn(S, 'worktree', 'add', '-q', '-b', 'lane/l1', d, 'main');
      writeIn(d, 'game/demo/notes/l1.md', `${notes}\n`); gitIn(d, 'add', '-A');
      gitIn(d, 'commit', '-q', '--no-verify', '-m', 'T-961: work', '-m', 'Studio-Task: T-961');
      return { task: 'T-961', agent: 'builder-l1', dir: d, branch: 'lane/l1', head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date(Date.now() - 600000).toISOString() };
    };
    const porter = () => writeIn(S, '.studio/agents/porter-1.json', JSON.stringify({ agent: 'porter-1', role: 'engine-porter', status: 'running', pid: process.pid, startedAt: new Date().toISOString() }));
    const unporter = () => fs.rmSync(path.join(S, '.studio', 'agents'), { recursive: true, force: true });
    const runsLog = () => { try { return fs.readFileSync(path.join(S, '.studio', 'runs-2782f.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    return { S, env, lane, porter, unporter, runsLog, ev };
  };
  const killTree = (child) => {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  const probeAsync = (S, code, env, ms) => new Promise((resolve) => {
    const f = path.join(S, `.probe-2782f-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const child = spawn(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let so = ''; let se = '';
    child.stdout.on('data', (d) => { so += d; }); child.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => { killTree(child); }, ms);
    const t0 = Date.now();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const l = so.split('\n').filter((x) => x.startsWith('{')).pop();
      let j = null; try { j = JSON.parse(l); } catch {}
      resolve({ code, signal, j, ms: Date.now() - t0, timedOut: Date.now() - t0 >= ms - 50, text: `${so}${se}` });
    });
  });
  const trainProbe = (S) => `import { runTrain } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness/train.mjs')).href)};
const calls = { handBack: [], close: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: (l, ctx) => { calls.close.push([l.task, ctx.record ? 'record' : 'none']); return { ok: true }; }, handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(-600)]) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, verifies: r.verifies, message: r.message, calls, logs: logs.filter((m) => /game:perf|reused/.test(m)).slice(0, 30) }));
`;
  await guard('2.78.2 (f, perf): a lane verify whose game:perf step said "not run (busy)" (an engine-porter session ran) is marked in its record (the game row\'s perfNotRun); the merge train that reuses it for the same tree first runs game:perf alone on that tree (STUDIO_GATE_FOCUS game:perf, STUDIO_TEST_ONLY the perf globs): green, T-961 lands; red (the perf test fails), T-961 does not land; still busy at the train, the run is a busy refusal and T-961 is deferred, neither landed nor handed back (fails on 2.78.1: the train landed on the lane\'s verify with no perf run)', async () => {
    const out = {};
    for (const kind of ['green', 'red', 'busy']) {
      const t = trainStudio(`perf-${kind}`);
      const l = t.lane(kind === 'red' ? 'RED p.perf.test.mjs' : 'green notes');
      t.porter();
      const v = spawnSync(process.execPath, [path.join(l.dir, 'scripts', 'run-gates.mjs'), '--no-detach'], { windowsHide: true, cwd: l.dir, env: { ...process.env, ...t.env, STUDIO_LOCK_OWNER: 'builder-l1' }, encoding: 'utf8', timeout: 180000 });
      const vText = `${v.stdout || ''}${v.stderr || ''}`;
      const rec = readJ(path.join(t.S, '.studio', 'gates', 'builder-l1-full.json')) || readJ(path.join(l.dir, '.studio', 'gates', 'builder-l1-full.json'));
      if (kind !== 'busy') t.unporter();
      writeIn(t.S, '.studio/train/queue.json', `${JSON.stringify([l], null, 2)}\n`);
      const before = t.runsLog().length;
      const p = await probeAsync(t.S, trainProbe(t.S), t.env, 300000);
      const trainRuns = t.runsLog().slice(before);
      out[kind] = { verify: v.status, busyLine: /WARN game:perf: not run \(busy\)/.test(vText), recMark: Boolean((rec?.rows || []).find((r) => r.perfNotRun)), landed: p.j?.landed || null, handBack: (p.j?.calls?.handBack || []).map(([x]) => x), deferred: p.j?.deferred || null, trainRuns, logs: p.j?.logs || [], tail: p.j ? '' : p.text.slice(-800) };
    }
    const said = (k) => out[k].logs.some((m) => /the reused verify of tree \w+ did not run its perf tests/.test(m));
    const perfRan = (k) => out[k].trainRuns.some((r) => r.startsWith('game/demo/tests/p.perf.test.mjs only=**/*.perf.test.mjs'));
    const ok = ['green', 'red', 'busy'].every((k) => out[k].verify === 0 && out[k].busyLine && out[k].recMark && said(k))
      && (out.green.landed || []).join(',') === 'T-961' && perfRan('green')
      && !(out.red.landed || []).includes('T-961') && perfRan('red') && out.red.logs.some((m) => /game:perf on tree \w+: red/.test(m))
      && !(out.busy.landed || []).includes('T-961') && !out.busy.handBack.includes('T-961') && !perfRan('busy') && out.busy.logs.some((m) => /game:perf on tree \w+ did not run/.test(m));
    return [ok, JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { ...v, logs: v.logs.slice(0, 4).map((m) => m.slice(0, 200)) }]))).slice(0, 3800)];
  });

  for (const S of made) { try { gitIn(S, 'worktree', 'prune'); fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {} }
}
