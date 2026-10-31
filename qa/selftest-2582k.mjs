/**
 * qa/selftest-2582k.mjs — 2.58.2 (PU-29): a gate catches commits that skipped the hooks and tests that were weakened.
 *   Hooks: the commit-msg hook stamps each commit the pre-commit hook passed (Studio-Hooks); `node harness/hook-stamp.mjs
 *          check` lists commits since the base without a valid stamp (--no-verify, an amend without hooks), keeps a clean
 *          rebase and a hooked merge valid, lets marked harness commits and owner-approved ones through.
 *   Tests: `node harness/test-weakening.mjs` flags removed asserts, skip/only, raised timeouts, wider tolerances, seed or
 *          tick special cases, deleted tests and goldens changed without a Golden-Reason; a genuine addition passes; the
 *          owner's signed approval lets exactly an intended change through, an agent's own signature doesn't.
 *   Both run at task done.
 * The words the weakened-test gate looks for are put together at run time, so this file never trips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest2582K({ dir, run, report, tmpRoot, root }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  const head = () => g('rev-parse', 'HEAD').stdout.trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const read = (rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
  const edit = (rel, from, to) => { const t = read(rel); if (!t.includes(from)) throw new Error(`${rel}: no "${from}"`); write(rel, t.replace(from, to)); };
  const ownerKey = path.join(tmpRoot, `owner-2582k-${process.pid}.pem`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_GAME_GATES: 'skip',
    STUDIO_OWNER_KEY: ownerKey, STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', GITHUB_SHA: '', STUDIO_HOOKS_CHECK: '', STUDIO_WEAKENED_TESTS: '', STUDIO_LOCK_OWNER: '' };
  const json = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; } };
  const hooks = (extra = {}) => { const r = run(dir, 'node harness/hook-stamp.mjs check --json', { ...env, ...extra }); return { status: r.status, ...json(r), _out: out(r) }; };
  const hooksText = (extra = {}) => run(dir, 'node harness/hook-stamp.mjs check', { ...env, ...extra });
  const weak = (extra = {}) => { const r = run(dir, 'node harness/test-weakening.mjs --json', { ...env, ...extra }); return { status: r.status, ...json(r), _out: out(r) }; };
  const commit = (msg, ...flags) => { g('add', '-A'); return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', ...(msg === null ? [] : ['-m', msg]), ...flags], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }); };
  const stampOf = (rev = 'HEAD') => (g('log', '-1', '--format=%B', rev).stdout.match(/^Studio-Hooks: .+$/m) || [''])[0];
  const kinds = (w) => (w.findings || []).map((f) => f.kind);
  const reset = () => { g('checkout', '-q', '--', '.'); g('clean', '-qfd', '--', 'game'); };

  // Words the weakened-test gate looks for, built here so this file holds none of them.
  const W = { SKIP: ['.', 'sk', 'ip'].join(''), ONLY: ['.', 'on', 'ly'].join(''), IGNORE: ['[', 'Ign', 'ore("flaky")]'].join(''), SEED: ['if (se', 'ed === 2) continue;'].join('') };
  const TEST = 'game/demo/tests/bounds.test.mjs';
  const CS = 'game/demo/Demo.Tests/BoundsTests.cs';
  const GD = 'game/demo/test/test_bounds.gd';

  // The studio: hooks installed, an owner key, a test file in three languages.
  fs.rmSync(ownerKey, { force: true });
  const kg = run(dir, 'node harness/approve.mjs keygen', env);
  write(TEST, [
    "import { test, expect } from 'vitest';",
    'const EPS = 1e-6;',
    "test('stays in bounds', () => {",
    '  const s = run(7);',
    '  expect(s.x).toBeLessThan(100);',
    '  expect(s.y).toBeGreaterThan(0);',
    '  expect(s.speed).toBeCloseTo(1.5, 5);',
    '  expect(Math.abs(s.drift)).toBeLessThan(EPS);',
    '}, { timeout: 5000 });',
    "test('scores', () => {",
    '  for (const seed of [1, 2, 3]) {',
    '    const r = run(seed);',
    '    expect(r.score).toBe(10);',
    '  }',
    '});',
    '',
  ].join('\n'));
  write(CS, 'using NUnit.Framework;\npublic class BoundsTests {\n  [Test]\n  public void StaysInBounds() {\n    Assert.AreEqual(1.0, Sim.Speed(), 0.001);\n  }\n}\n');
  write(GD, 'extends GdUnitTestSuite\n\nfunc test_bounds() -> void:\n\tassert_int(sim.x).is_less(100)\n\tassert_float(sim.speed).is_equal_approx(1.5, 0.01)\n');
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('config', 'core.hooksPath', 'scripts/hooks');
  const base = commit('studio', '-m', 'Golden-Reason: the first recording');
  const baseStamp = stampOf();
  g('switch', '-q', '-c', 'feat');

  // H1: a normal hooked commit carries a stamp and passes.
  write('game/demo/src/a.mjs', 'export const a = 1;\n');
  const c1 = commit('add a');
  const s1 = stampOf();
  const h1 = hooks();
  report('2.58.2 (PU-29): a normal commit made with the hooks gets a Studio-Hooks stamp (version, tree, patch-id) and the hooks gate passes it',
    kg.status === 0 && base.status === 0 && /^Studio-Hooks: v[0-9a-f]{8} t[0-9a-f]{12} [ps][0-9a-f]{12}$/.test(baseStamp) && c1.status === 0 && /^Studio-Hooks: v[0-9a-f]{8} t[0-9a-f]{12} [ps][0-9a-f]{12}$/.test(s1) && h1.status === 0 && h1.ok && h1.enforced && h1.checked === 1 && !h1.open?.length,
    `${out(base).slice(-400)}\n${baseStamp}\n${s1}\n${h1._out.slice(-800)}`);

  // H2: a commit with --no-verify is flagged by name, with the fix.
  write('game/demo/src/b.mjs', 'export const b = 2;\n');
  commit('sneak b', '--no-verify');
  const sneak = head();
  const h2 = hooks();
  const h2t = hooksText();
  report('2.58.2 (PU-29): a commit made with --no-verify is flagged: the hooks gate fails, names the commit and says how to re-commit it with the hooks',
    h2.status !== 0 && !h2.ok && h2.open?.length === 1 && h2.open?.[0]?.sha === sneak && h2t.status !== 0 && out(h2t).includes(sneak.slice(0, 8)) && /sneak b/.test(out(h2t)) && /git reset --soft [0-9a-f]{12}~1/.test(out(h2t)) && /git commit -C ORIG_HEAD/.test(out(h2t)),
    `${h2._out.slice(-600)}\n---\n${out(h2t).slice(-900)}`);

  // H2b: the next commit isn't stamped while HEAD is unchecked (it could be an amend laundering it), even after unsetting
  // core.hooksPath the stamped base keeps the gate on, and re-committing with the hooks fixes everything.
  write('game/demo/src/b.mjs', 'export const b = 3;\n');
  commit(null, '--amend', '--no-edit');
  const laundered = { stamp: stampOf(), check: hooks() };
  g('config', '--unset', 'core.hooksPath');
  const unset = hooks();
  g('config', 'core.hooksPath', 'scripts/hooks');
  g('reset', '-q', '--soft', `${sneak}~1`);
  const recommit = commit(null, '-C', 'ORIG_HEAD');
  const fixed = hooks();
  report('2.58.2 (PU-29): amending a --no-verify commit with the hooks doesn\'t launder it (no stamp: the hooks only saw the amendment); unsetting core.hooksPath doesn\'t switch the gate off (the base carries stamps); re-committing with the hooks (git reset --soft …~1, git commit -C ORIG_HEAD) passes',
    laundered.stamp === '' && laundered.check.status !== 0 && unset.status !== 0 && unset.enforced && recommit.status === 0 && stampOf() !== '' && fixed.status === 0 && fixed.checked === 2,
    `${JSON.stringify({ s: laundered.stamp, l: laundered.check.why, u: unset.why })}\n${fixed._out.slice(-600)}`);

  // H3: an amend without the hooks changes the content under the old stamp: flagged.
  write('game/demo/src/c.mjs', 'export const c = 1;\n');
  commit('add c');
  write('game/demo/src/c.mjs', 'export const c = 99; // slipped in\n');
  commit(null, '--amend', '--no-edit', '--no-verify');
  const h3 = hooks();
  report('2.58.2 (PU-29): changing a hooked commit with git commit --amend --no-verify is flagged (its old stamp doesn\'t match the new content)',
    h3.status !== 0 && h3.open?.length === 1 && h3.open?.[0]?.sha === head() && /doesn't match its content/.test(h3.open?.[0]?.why), h3._out.slice(-800));
  g('reset', '-q', '--hard', 'HEAD~1');

  // H4: a clean rebase onto a moved main keeps every stamp valid (patch-id), and a hooked merge is stamped.
  write('game/demo/src/c.mjs', 'export const c = 1;\n');
  commit('add c again');
  g('switch', '-q', 'main');
  write('game/demo/src/m.mjs', 'export const m = 1;\n');
  commit('main moves');
  g('switch', '-q', 'feat');
  const rb = g('rebase', '-q', 'main');
  const h4a = hooks();
  g('switch', '-q', 'main');
  write('game/demo/src/n.mjs', 'export const n = 1;\n');
  commit('main moves again');
  g('switch', '-q', 'feat');
  const mg = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-edit', 'main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const mergeMsg = g('log', '-1', '--format=%B').stdout;
  const h4b = hooks();
  report('2.58.2 (PU-29): no false flags after a clean rebase onto a moved main (the stamp\'s patch-id still matches) or after a merge made with the hooks (a merge stamp on its own line)',
    rb.status === 0 && h4a.status === 0 && h4a.checked === 3 && mg.status === 0 && /^Merge branch 'main' into feat\n\nStudio-Hooks: v[0-9a-f]{8} t[0-9a-f]{12} merge$/m.test(mergeMsg) && h4b.status === 0 && !h4b.open?.length,
    `${h4a._out.slice(-500)}\n${mergeMsg}\n${h4b._out.slice(-500)}`);

  // H5: harness commits are exempt only when marked with a known kind (and its companion trailer).
  write('game/demo/src/d.mjs', 'export const d = 1;\n');
  commit('Drop X-001: try d\n\nStudio-Experiment-Drop: X-001\nStudio-Harness: experiment-drop', '--no-verify');
  const h5a = hooks();
  write('game/demo/src/e.mjs', 'export const e = 1;\n');
  commit('board update\n\nStudio-Harness: board', '--no-verify');
  const h5b = hooks();
  report('2.58.2 (PU-29): a harness commit made without hooks passes only when marked (Studio-Harness: experiment-drop with its Studio-Experiment-Drop trailer); an unknown kind is flagged like any other',
    h5a.status === 0 && h5a.exempt >= 1 && h5b.status !== 0 && h5b.open?.length === 1 && /isn't a commit the harness makes/.test(h5b.open?.[0]?.why), `${h5a._out.slice(-500)}\n${h5b._out.slice(-700)}`);

  // H6: the owner's approval lets a commit through; an agent's own key doesn't; the next commit is stamped again.
  const agentKey = path.join(tmpRoot, `agent-2582k-${process.pid}.pem`);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(agentKey, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const forged = run(dir, 'node harness/approve.mjs hooks --note "agent approving its own skip"', { ...env, STUDIO_OWNER_KEY: agentKey });
  const h6a = hooks();
  fs.rmSync(path.join(dir, 'studio/approvals'), { recursive: true, force: true });
  const ap = run(dir, 'node harness/approve.mjs hooks --note "the owner made this board commit by hand"', env);
  const h6b = hooks();
  commit('the approval');
  const afterApproval = stampOf();
  const h6c = hooks();
  report('2.58.2 (PU-29): a commit that skipped the hooks passes with the owner\'s signed approval (npm run approve -- hooks); signed with another key it still fails; once approved, the next commit is stamped again',
    forged.status === 0 && h6a.status !== 0 && ap.status === 0 && h6b.status === 0 && h6b.approved?.length === 1 && afterApproval !== '' && h6c.status === 0, `${out(ap).slice(-400)}\n${h6a.why}\n${h6b.why}\n${afterApproval}\n${h6c._out.slice(-500)}`);

  // H7: CI's own merge of a pull request is judged by the PR head; the switch turns the gate off.
  g('switch', '-q', '-c', 'ci', 'main');
  spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.invalid', 'merge', '-q', '--no-ff', '--no-verify', '--no-edit', 'feat'], { cwd: dir, encoding: 'utf8' });
  const ciHead = head();
  const ciEnv = { STUDIO_PROTECT_BASE: 'main' };
  const h7a = hooks(ciEnv);
  const h7b = hooks({ ...ciEnv, GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: ciHead });
  const h7c = hooks({ ...ciEnv, STUDIO_HOOKS_CHECK: 'off' });
  g('switch', '-q', 'feat'); g('branch', '-q', '-D', 'ci');
  report('2.58.2 (PU-29): CI\'s merge commit of a pull request (GITHUB_SHA, unstamped) isn\'t judged, the PR head is; locally that unmarked merge is flagged; STUDIO_HOOKS_CHECK=off turns the gate off',
    h7a.status !== 0 && h7a.open?.some((o) => o.sha === ciHead) && h7b.status === 0 && h7c.status === 0 && h7c.off, `${h7a.why}\n${h7b._out.slice(-600)}\n${h7c.why}`);

  // Weakened tests: each kind, as uncommitted edits (judged like committed ones), reverted after each.
  const w0 = weak();
  const kind = (label, k, file, apply, minCount = 1) => {
    reset();
    apply();
    const w = weak();
    const hits = (w.findings || []).filter((f) => f.kind === k && f.file === file);
    report(`2.58.2 (PU-29): weakened test flagged: ${label} (${k}, named file:line)`, w.status !== 0 && !w.ok && hits.length >= minCount && hits.every((f) => Number.isInteger(f.line) && f.line > 0), w._out.slice(-900));
    reset();
    return w;
  };
  kind('an assertion removed', 'assert-removed', TEST, () => edit(TEST, '  expect(s.y).toBeGreaterThan(0);\n', ''));
  kind('an assertion commented out', 'assert-removed', TEST, () => edit(TEST, '  expect(s.y)', '  // expect(s.y)'));
  kind('a test skipped (.skip)', 'skip-added', TEST, () => edit(TEST, "test('scores'", `test${W.SKIP}('scores'`));
  kind('only one test run (.only)', 'only-added', TEST, () => edit(TEST, "test('scores'", `test${W.ONLY}('scores'`));
  kind('a test timeout raised', 'timeout-raised', TEST, () => edit(TEST, '{ timeout: 5000 }', '{ timeout: 60000 }'));
  kind('toBeCloseTo precision lowered and an epsilon raised', 'tolerance-widened', TEST, () => { edit(TEST, 'toBeCloseTo(1.5, 5)', 'toBeCloseTo(1.5, 1)'); edit(TEST, 'EPS = 1e-6', 'EPS = 1e-2'); }, 2);
  kind('a C# delta and a gdUnit approx tolerance raised', 'tolerance-widened', CS, () => { edit(CS, '0.001)', '0.5)'); edit(GD, '1.5, 0.01)', '1.5, 0.5)'); });
  kind('a condition special-casing a seed', 'seed-special-case', TEST, () => edit(TEST, '    const r = run(seed);', `    ${W.SEED}\n    const r = run(seed);`));
  kind('a test file deleted', 'test-deleted', CS, () => fs.rmSync(path.join(dir, CS)));
  kind('a C# test ignored and a gdUnit assert removed', 'skip-added', CS, () => { edit(CS, '  [Test]\n', `  [Test]\n  ${W.IGNORE}\n`); edit(GD, '\tassert_int(sim.x).is_less(100)\n', ''); });
  // A golden changed in a commit without Golden-Reason (with --no-verify: the commit-msg hook refuses it otherwise).
  const golden = fs.readdirSync(path.join(dir, 'qa/golden')).find((f) => f.endsWith('.json'));
  const goldenRel = `qa/golden/${golden}`;
  fs.appendFileSync(path.join(dir, goldenRel), '\n');
  commit('retune', '--no-verify');
  const wg = weak();
  g('reset', '-q', '--hard', 'HEAD~1');
  fs.appendFileSync(path.join(dir, goldenRel), '\n');
  commit('retune', '-m', 'Golden-Reason: the bounds fix moves the final tick');
  const wg2 = weak();
  g('reset', '-q', '--hard', 'HEAD~1');
  report('2.58.2 (PU-29): weakened test flagged: a golden file changed in a commit without a Golden-Reason trailer (golden-edited); with the trailer it passes',
    wg.status !== 0 && wg.findings?.some((f) => f.kind === 'golden-edited' && f.file === goldenRel) && wg2.status === 0, `${wg._out.slice(-600)}\n${wg2._out.slice(-400)}`);

  // A genuine addition: new tests with new asserts, a new test with its own timeout and a tick it waits for, a reworded assert.
  edit(TEST, '    expect(r.score).toBe(10);', '    expect(r.score).toEqual(10);');
  fs.appendFileSync(path.join(dir, TEST), "test('jumps', () => {\n  const s = start();\n  for (let tick = 0; tick < 200; tick++) { if (tick === 100) s.press('jump'); s.step(); }\n  expect(s.y).toBeGreaterThan(1);\n}, { timeout: 20000 });\n");
  write('game/demo/tests/score.test.mjs', "import { test, expect } from 'vitest';\ntest('score starts at zero', () => { expect(start().score).toBe(0); });\n");
  const add = commit('more tests');
  const wa = weak();
  report('2.58.2 (PU-29): a genuine test addition passes (new tests and asserts, a new test with its own timeout and a tick it acts on, an assert reworded in place)',
    w0.status === 0 && !w0.findings?.length && add.status === 0 && wa.status === 0 && !wa.findings?.length && wa.enforced, `${w0._out.slice(-300)}\n${wa._out.slice(-900)}`);

  // Approval: the owner signs exactly the findings listed; an agent's signature doesn't count; a later change needs a new one.
  edit(TEST, "test('scores'", `test${W.SKIP}('scores'`);
  commit('skip the flaky score test');
  const forgedT = run(dir, 'node harness/approve.mjs tests --note "agent approving its own skip"', { ...env, STUDIO_OWNER_KEY: agentKey });
  const wf = weak();
  for (const f of fs.existsSync(path.join(dir, 'studio/approvals')) ? fs.readdirSync(path.join(dir, 'studio/approvals')).filter((x) => x.startsWith('tests-')) : []) fs.rmSync(path.join(dir, 'studio/approvals', f));
  const apT = run(dir, 'node harness/approve.mjs tests --note "the score test is replaced by score.test.mjs"', env);
  const wok = weak();
  edit(TEST, '  expect(s.x).toBeLessThan(100);\n', '');
  const wmore = weak();
  reset();
  report('2.58.2 (PU-29): an owner approval (npm run approve -- tests) lets exactly the intended weakening through; one signed with an agent\'s own key doesn\'t; a further weakening fails again',
    forgedT.status === 0 && wf.status !== 0 && apT.status === 0 && wok.status === 0 && wok.approved?.length === 1 && wmore.status !== 0 && wmore.findings?.length === 1 && wmore.findings?.[0]?.kind === 'assert-removed',
    `${wf.why}\n${out(apT).slice(-400)}\n${wok.why}\n${wmore._out.slice(-600)}`);
  const off = weak({ STUDIO_WEAKENED_TESTS: 'off' });
  report('2.58.2 (PU-29): STUDIO_WEAKENED_TESTS=off turns the weakened-test gate off (it says so)', off.status === 0 && off.off && /STUDIO_WEAKENED_TESTS=off/.test(off.why), off._out);

  // Task done runs both: an unhooked commit and a weakened test each stop it, even with an "all ok" verify record.
  // The size check before them reads JavaScript with the harness's typescript; the selftest copy has no node_modules
  // of its own, so link the harness's (as the map-find check does) or task done stops on that check first.
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const as = { ...env, STUDIO_LOCK_OWNER: 'k-1' };
  const tid = (out(run(dir, 'node harness/task.mjs add "Tune the demo bounds" --role builder --priority P1', env)).match(/"id": "(T-\d+)"/) || [])[1];
  run(dir, `node harness/task.mjs start ${tid} --agent k-1`, as);
  const plant = () => write('.studio/gates/k-1-full.json', JSON.stringify({ at: new Date(Date.now() + 2000).toISOString(), partial: false, scope: 'full', head: head(), dirty: false, rows: [{ id: 'protected', ok: true, required: true }, { id: 'secrets', ok: true, required: true }] }));
  write('game/demo/src/t.mjs', 'export const t = 1;\n');
  edit(TEST, '  expect(s.x).toBeLessThan(100);\n', '');
  g('add', 'game/demo/src/t.mjs', TEST); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', `tune\n\nStudio-Task: ${tid}`], { cwd: dir });
  plant();
  const d1 = run(dir, `node harness/task.mjs done ${tid} --agent k-1`, as);
  report('2.58.2 (PU-29): task done runs the hooks check itself: a commit made with --no-verify and a removed assert each stop it, even with an "all ok" verify of this commit',
    Boolean(tid) && d1.status !== 0 && /the hooks check fails/.test(out(d1)) && /re-commit/.test(out(d1)) && /the weakened-tests check fails/.test(out(d1)) && /assert-removed/.test(out(d1)), out(d1).slice(-1800));
}
