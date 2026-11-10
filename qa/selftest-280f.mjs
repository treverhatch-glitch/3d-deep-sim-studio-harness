/**
 * qa/selftest-280f.mjs — 2.80 (f): the trial's small fixes.
 *   N4/N13  a quarantined test file the lane itself changed runs in that lane's game check (it can prove its own fix).
 *   N12     qa/test-golden.py judges a regression the way the Node side does: a "kind": "test" file has no replay to hash.
 *   N14     done-check prints one progress line before it replays the regressions on the old code.
 *   R3-6    the selftest's template tree never reads the adopted game's files into its buffer.
 *   N6      `task done --no-op "<why>"` closes a chore: it skips "Changes exist" and "Full verify" only.
 *   #28     a Unity run with no results file at all is NOT RUN (environment), never the lane's failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest280F({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_LANDING_BUILD: 'off',
    STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-280f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  const made = [];
  let n = 0;

  // ---- N4/N13: a quarantined file the lane changes runs in the lane ----
  // A made-up vitest (list/run) in game/demo; its config skips STUDIO_TEST_QUARANTINE; game/demo/notes.md "RED b.test.mjs" makes b fail.
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
  const webStudio = (name) => {
    const S = path.join(tmpRoot, `280f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    for (const f of ['beta.json', 'game.json', 'quarantine.json']) fs.rmSync(path.join(S, 'studio', f), { force: true });
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'cd game/demo && npm test' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/package.json', `${JSON.stringify({ name: 'demo', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2)}\n`);
    writeIn(S, 'game/demo/vitest.config.mjs', HONOUR);
    writeIn(S, 'game/demo/fake-vitest.mjs', FAKE);
    writeIn(S, 'game/demo/node_modules/.bin/vitest', '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.mjs" "$@"\n');
    try { fs.chmodSync(path.join(S, 'game/demo/node_modules/.bin/vitest'), 0o755); } catch {}
    writeIn(S, 'game/demo/node_modules/.bin/vitest.cmd', '@node "%~dp0\\..\\..\\fake-vitest.mjs" %*\r\n');
    for (const t of ['a', 'b']) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    writeIn(S, 'game/demo/notes.md', 'RED b.test.mjs\n');
    writeIn(S, 'studio/quarantine.json', `${JSON.stringify([{ test: 'tests/b.test.mjs', status: 'active', check: 'game:unit' }], null, 2)}\n`);
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return S;
  };
  const gg = (S, args = []) => { const r = spawnSync(process.execPath, ['harness/game-gates.mjs', ...args], { windowsHide: true, cwd: S, env: { ...process.env, ...base }, encoding: 'utf8', timeout: 180000 }); return { status: r.status, text: `${r.stdout || ''}${r.stderr || ''}` }; };
  await guard('2.80 (f, N4/N13): a quarantined test file the lane changes (--changed game/demo/tests/b.test.mjs) is not skipped: the gate says "running tests/b.test.mjs: this lane changes it" and runs it (it fails here, as its RED note says); a lane that does not change it still skips it and passes (fails on 2.79.2: the lane run skipped the file it fixes)', () => {
    const S = webStudio('lanechg');
    const other = gg(S, ['--changed', 'game/demo/tests/a.test.mjs']);
    const mine = gg(S, ['--changed', 'game/demo/tests/b.test.mjs']);
    const ok = other.status === 0 && /quarantined test file\(s\) skipped/.test(other.text) && !/this lane changes it/.test(other.text)
      && mine.status === 1 && /running tests\/b\.test\.mjs: this lane changes it/.test(mine.text) && !/quarantined test file\(s\) skipped/.test(mine.text);
    return [ok, JSON.stringify({ other: [other.status, other.text.slice(-700)], mine: [mine.status, mine.text.slice(-900)] })];
  });

  // ---- N12: the Python golden check skips a regression that is a seeded game test ----
  await guard('2.80 (f, N12): qa/test-golden.py exits 0 with a qa/regressions/ file of "kind": "test" (no replay, no sha256) beside the real goldens, as the Node check does (fails on 2.79.2: it demanded a 256-bit sha256 of every regression file)', () => {
    const R = path.join(tmpRoot, `280f-py-${process.pid}-${++n}`);
    made.push(R);
    fs.mkdirSync(path.join(R, 'qa', 'regressions'), { recursive: true });
    for (const e of fs.readdirSync(harnessRoot, { withFileTypes: true })) {
      if (/^(\.git|\.lanes|\.studio|qa)$/.test(e.name)) continue;
      try { if (e.isDirectory()) fs.symlinkSync(path.join(harnessRoot, e.name), path.join(R, e.name), 'junction'); else fs.copyFileSync(path.join(harnessRoot, e.name), path.join(R, e.name)); } catch {}
    }
    fs.symlinkSync(path.join(harnessRoot, 'qa', 'golden'), path.join(R, 'qa', 'golden'), 'junction');
    for (const f of ['test-golden.py', 'hash-vectors.json']) fs.copyFileSync(path.join(harnessRoot, 'qa', f), path.join(R, 'qa', f));
    writeIn(R, 'qa/regressions/BUG-unit.json', `${JSON.stringify({ id: 'BUG-unit', kind: 'test', test: { file: 'game/x/a.test.ts', name: 'a' }, seed: 1, description: 'x', fixed: true })}\n`);
    const py = spawnSync(process.platform === 'win32' ? 'python' : 'python3', [path.join(R, 'qa', 'test-golden.py')], { windowsHide: true, cwd: R, encoding: 'utf8', timeout: 170000 });
    const text = `${py.stdout || ''}${py.stderr || ''}`;
    return [py.status === 0 && !/FAIL/.test(text) && /PASS/.test(text), text.slice(-1200)];
  });

  // ---- N14, N6: done-check on a copy of the harness ----
  const D = path.join(tmpRoot, `280f-dc-${process.pid}-${++n}`);
  made.push(D);
  fs.cpSync(dir, D, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(D, 'node_modules'), 'junction'); } catch {} }
  const env = { STUDIO_LOCK_OWNER: 'builder-f1', STUDIO_DONE_UNCOMMITTED: 'allow', ...ident };
  gitIn(D, 'init', '-q', '-b', 'main'); gitIn(D, 'add', '-A'); gitIn(D, 'commit', '-qm', 'base', '--no-verify');
  const addTask = (title, type) => (run(D, `node harness/task.mjs add "${title}" --role builder --type ${type} --size 2 --origin dev --asked "test"`, env).stdout.match(/T-\d+/) || [])[0];
  const text = (r) => `${r.stdout || ''}${r.stderr || ''}`;

  await guard('2.80 (f, N14): done-check prints "[done-check] replaying 1 regression(s) on the commit before the fix ...: this can take minutes" before it replays the bug\'s regression on the old code (fails on 2.79.2: silent until the result)', () => {
    const id = addTask('Bug: crates stack on one tile', 'bug');
    const st = run(D, `node harness/task.mjs start ${id} --agent builder-f1`, env);
    const reg = JSON.parse(fs.readFileSync(path.join(harnessRoot, 'qa', 'regressions', 'example-same-tick.json'), 'utf8'));
    writeIn(D, 'qa/regressions/BUG-280f.json', `${JSON.stringify({ ...reg, id: 'BUG-280f' }, null, 2)}\n`);
    gitIn(D, 'add', '-A'); gitIn(D, 'commit', '-qm', 'fix', '--no-verify', '--trailer', `Studio-Task: ${id}`);
    const r = run(D, `node harness/done-check.mjs ${id}`, env);
    return [Boolean(id) && st.status === 0 && /\[done-check\] replaying 1 regression\(s\) on the commit before the fix \(\w+\^\): this can take minutes/.test(text(r)), `${id} ${text(st)} ${text(r)}`.slice(-1500)];
  });

  await guard('2.80 (f, N6): `task done <chore> --check --no-op "<why>"` with no change in the task no longer lists "Changes exist for this task" or "Full verify green after the last change" (fails on 2.79.2: both were still required, so only --force was left)', () => {
    const id = addTask('Chore: tidy the notes folder', 'chore');
    const st = run(D, `node harness/task.mjs start ${id} --agent builder-f1`, env);
    const r = run(D, `node harness/task.mjs done ${id} --agent builder-f1 --check --no-op "already tidy in the notes folder"`, env);
    const t = text(r);
    return [Boolean(id) && st.status === 0 && !/Changes exist for this task|no changes found for|Full verify green after the last change/.test(t), `${id} ${text(st)} ${t}`.slice(-1500)];
  });

  // ---- #28: a Unity run with no results file ----
  const unity = await import(pathToFileURL(path.join(dir, 'harness', 'unity.mjs')).href);
  await guard('2.80 (f, #28): judgeRun with no results file and a log with no compile error is NOT RUN (notRun kind "no-results"), for exit 1 and for a kill; a compile error in the log, or our own timeout, stays a FAIL (fails on 2.79.2: every no-results run was the lane\'s FAIL)', () => {
    const miss = path.join(tmpRoot, `280f-no-such-results-${process.pid}.xml`);
    const died = unity.judgeRun('EditMode', miss, 'Loading project\n', 1);
    const killed = unity.judgeRun('PlayMode', miss, 'Loading project\n', null, { signal: 'SIGKILL' });
    const compile = unity.judgeRun('EditMode', miss, 'Assets/A.cs(3,1): error CS1002: ; expected\n', 1);
    const slow = unity.judgeRun('EditMode', miss, 'Loading project\n', null, { signal: 'timeout' });
    const ok = died.ok === false && died.notRun?.kind === 'no-results' && killed.notRun && !compile.notRun && compile.ok === false && !slow.notRun && slow.ok === false;
    return [ok, JSON.stringify({ died: died.notRun, killed: killed.notRun, compile: compile.notRun, slow: slow.notRun })];
  });

  for (const S of made) { try { gitIn(S, 'worktree', 'prune'); fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {} }
}
