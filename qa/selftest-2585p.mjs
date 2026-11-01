/**
 * qa/selftest-2585p.mjs — 2.58.5 (H-7): the hooks gate no longer reads a whole range's diffs into memory.
 *
 * Found on a studio whose base branch (the harness upstream) is far behind: the range since the base holds the game's
 * whole import with its binary art, and as soon as one commit needed the patch-id fallback (a lane rebased by task done,
 * a rebased commit on main) the gate ran `git log -p --binary` over all of it and Node threw ERR_STRING_TOO_LONG, so
 * every landing failed. Now only the commits that need a patch-id get one, streamed from git into git patch-id; the
 * grandfather list does the same, the weakened-tests gate reads only the files its rules judge, and an output too big
 * to read fails a gate instead of passing it on a list cut short.
 *
 * STUDIO_HOOKS_MAX_BUFFER (bytes) lowers the read limit so a few 3 MB files stand in for gigabytes of art; GIT_TRACE
 * shows which git commands ran.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2585P({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '',
    GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', GITHUB_SHA: '', STUDIO_HOOKS_CHECK: '', STUDIO_WEAKENED_TESTS: '', STUDIO_LOCK_OWNER: '', STUDIO_HOOKS_MAX_BUFFER: '', GIT_TRACE: '' };
  const SMALL = String(1024 * 1024); // 1 MB: each art file below is 3 MB, its binary diff about 4 MB
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const write = (rel, data) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), data); };
  const commit = (msg, flags = [], extra = {}) => { g('add', '-A'); return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', msg, ...flags], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, ...extra } }); };
  const head = () => g('rev-parse', 'HEAD').stdout.trim();
  const stampOf = (rev) => (g('log', '-1', '--format=%B', rev).stdout.match(/^Studio-Hooks: v[0-9a-f]{8} t([0-9a-f]{12}) ([ps])([0-9a-f]{12})$/m) || []);
  const json = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; } };
  let traceN = 0;
  const traced = (cmd, extra = {}) => {
    const trace = path.join(tmpRoot, `trace-2585p-${process.pid}-${++traceN}.log`);
    fs.rmSync(trace, { force: true });
    const r = run(dir, cmd, { ...env, GIT_TRACE: trace, ...extra });
    let t = '';
    try { t = fs.readFileSync(trace, 'utf8'); } catch {}
    return { r, j: json(r), lines: t.split('\n').filter((l) => /trace: (built-in|exec|run_command)/.test(l)) };
  };
  const gate = { STUDIO_HOOKS_CHECK: 'on', STUDIO_PROTECT_BASE: 'main', STUDIO_HOOKS_MAX_BUFFER: SMALL };
  // A whole-range diff: git log with -p over a base..head range, or over --branches (the old grandfather list).
  const rangeDiffs = (lines) => lines.filter((l) => /\blog\b/.test(l) && /\s-p(\s|$)/.test(l) && (/\S\.\.\S/.test(l) || /--branches/.test(l)));

  // The studio: hooks installed, base on main; a lane with 3 MB of binary art, rebased onto a moved main.
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('config', 'core.hooksPath', 'scripts/hooks');
  const base = commit('studio', ['-m', 'Golden-Reason: the first recording']);
  g('switch', '-q', '-c', 'feat');
  write('game/demo/art/big1.bin', crypto.randomBytes(3 * 1024 * 1024));
  const art1 = commit('import art', [], { STUDIO_HOOKS_MAX_BUFFER: SMALL });
  write('game/demo/src/a.mjs', 'export const a = 1;\n');
  const code1 = commit('add a');
  g('switch', '-q', 'main');
  write('game/demo/src/m.mjs', 'export const m = 1;\n');
  commit('main moves');
  g('switch', '-q', 'feat');
  const rb = g('rebase', '-q', 'main');
  const [art1Sha, code1Sha] = ['HEAD~1', 'HEAD'].map((r) => g('rev-parse', r).stdout.trim());
  write('game/demo/art/big2.bin', crypto.randomBytes(3 * 1024 * 1024));
  const art2 = commit('more art', [], { STUDIO_HOOKS_MAX_BUFFER: SMALL });
  const art2Sha = head();

  // H-7: the check judges the rebased lane with a 1 MB read limit and never runs a whole-range `git log -p`.
  const a = traced('node harness/hook-stamp.mjs check --json', gate);
  report('2.58.5 (H-7): the hooks gate patch-ids only the commits that need it (2 rebased ones, not the new 3 MB art commit whose tree matches) and streams them: it passes with a 1 MB read limit and runs no whole-range git log -p (old: one git log -p --binary over base..HEAD, ERR_STRING_TOO_LONG on a game\'s art)',
    base.status === 0 && art1.status === 0 && code1.status === 0 && rb.status === 0 && art2.status === 0 && stampOf(art2Sha).length > 0
      && a.r.status === 0 && a.j.ok === true && a.j.checked === 3 && !(a.j.open || []).length && a.j.patchIds === 2 && a.lines.length > 0 && !rangeDiffs(a.lines).length,
    JSON.stringify({ base: out(base).slice(-300), art1: out(art1).slice(-300), j: a.j, rangeDiffs: rangeDiffs(a.lines) }).slice(0, 2500));

  // The rebased commits were judged by patch-id (their stamp's tree no longer matches), and the gate's ids are the ids
  // the commit-msg hook stamped (git diff --cached against the parent): the 3 MB binary commit and a text one.
  const { patchIdsOf, patchIdOf } = await import(pathToFileURL(path.join(dir, 'harness', 'hook-stamp.mjs')).href);
  const ids = typeof patchIdsOf === 'function' ? await patchIdsOf([art1Sha, code1Sha], 'p', dir) : new Map();
  const treeOf = (sha) => g('rev-parse', `${sha}^{tree}`).stdout.trim();
  const buffered = (sha) => patchIdOf(g('-c', 'core.quotePath=true', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--indent-heuristic', '-U3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--binary', '--ignore-submodules=none', '--submodule=short', `${sha}~1`, sha).stdout, dir, 'p')?.id.slice(0, 12);
  const rebased = [art1Sha, code1Sha].map((sha) => ({ sha, stamp: stampOf(sha), tree: treeOf(sha) }));
  report('2.58.5 (H-7): a rebased commit (stamp tree no longer its tree) is still validated by patch-id: the streamed ids equal the ones the commit-msg hook stamped and the old buffered diff gave, for the 3 MB binary commit and a text commit',
    rebased.every((x) => x.stamp.length && !x.tree.startsWith(x.stamp[1]) && ids.get(x.sha) === x.stamp[3] && buffered(x.sha) === x.stamp[3]),
    JSON.stringify({ rebased, ids: [...ids], buffered: [art1Sha, code1Sha].map(buffered) }));

  // A commit with --no-verify is still caught, and so is one that copies a stamped message onto other content.
  write('game/demo/src/b.mjs', 'export const b = 2;\n');
  commit('sneak b', ['--no-verify']);
  const sneak = head();
  write('game/demo/art/big3.bin', crypto.randomBytes(3 * 1024 * 1024));
  commit(g('log', '-1', '--format=%B', code1Sha).stdout, ['--no-verify']);
  const copied = head();
  const c = traced('node harness/hook-stamp.mjs check --json', gate);
  const openShas = (c.j.open || []).map((o) => o.sha);
  report('2.58.5 (H-7): a --no-verify commit is still caught with the streamed patch-ids (1 MB read limit), and so is a 3 MB commit carrying a copied stamp (its patch-id doesn\'t match); both listed with their patch-ids, no whole-range git log -p',
    c.r.status !== 0 && c.j.ok === false && openShas.length === 2 && openShas.includes(sneak) && openShas.includes(copied) && (c.j.open || []).every((o) => /^[0-9a-f]{12}$/.test(o.pid || '')) && !rangeDiffs(c.lines).length,
    JSON.stringify({ j: c.j, rangeDiffs: rangeDiffs(c.lines) }).slice(0, 2000));

  // A list too big to read fails the gate; it never passes on a list cut short (spawnSync stops at maxBuffer).
  const f = traced('node harness/hook-stamp.mjs check --json', { ...gate, STUDIO_HOOKS_MAX_BUFFER: '64' });
  const fw = traced('node harness/test-weakening.mjs --json', { STUDIO_WEAKENED_TESTS: 'on', STUDIO_PROTECT_BASE: 'main', STUDIO_HOOKS_MAX_BUFFER: '64' });
  report('2.58.5 (H-7): a git output too big to read fails the hooks and weakened-tests gates with the reason, instead of judging what was read (old: a cut list, silently)',
    f.r.status !== 0 && f.j.ok === false && /too big|not read|over 64 bytes/.test(f.j.error || '') && fw.r.status !== 0 && fw.j.ok === false && /too big|over 64 bytes/.test(fw.j.error || ''),
    JSON.stringify({ f: f.j, fw: fw.j }).slice(0, 1500));

  // The weakened-tests gate reads only the files its rules judge: a 3 MB fixture under a test folder isn't diffed, and
  // a removed assert next to it is still flagged.
  g('switch', '-q', '-c', 'tests', 'main');
  const T = 'game/demo/tests/bounds.test.mjs';
  write(T, ["import { test, expect } from 'vitest';", "test('bounds', () => {", '  expect(1).toBe(1);', '  expect(2).toBe(2);', '});', ''].join('\n'));
  commit('a test');
  g('branch', '-f', 'main', 'HEAD');
  write('game/demo/tests/fixtures/recording.json', JSON.stringify({ frames: Array.from({ length: 60000 }, (_, i) => ({ i, v: crypto.randomBytes(16).toString('hex') })) }));
  write(T, ["import { test, expect } from 'vitest';", "test('bounds', () => {", '  expect(1).toBe(1);', '});', ''].join('\n'));
  g('add', '-A'); // staged, so git diff <base> holds it (an untracked file isn't in it)
  const w = traced('node harness/test-weakening.mjs --json', { STUDIO_WEAKENED_TESTS: 'on', STUDIO_PROTECT_BASE: 'main', STUDIO_HOOKS_MAX_BUFFER: SMALL });
  const fixtureRead = w.lines.filter((l) => /\bdiff\b/.test(l) && /-U0/.test(l) && /recording\.json/.test(l));
  report('2.58.5 (H-7): the weakened-tests gate diffs only test code and test-runner configs: a 3 MB fixture under tests/ is not read (1 MB read limit), the removed assert beside it is still flagged',
    fs.statSync(path.join(dir, 'game/demo/tests/fixtures/recording.json')).size > 2 * 1024 * 1024 && w.r.status !== 0 && (w.j.findings || []).some((x) => x.kind === 'assert-removed' && x.file === T) && w.lines.length > 0 && !fixtureRead.length,
    JSON.stringify({ j: w.j, fixtureRead }).slice(0, 1500));
  g('reset', '-q', '--hard'); g('clean', '-qfd', '--', 'game');

  // The grandfather list (P-068) patch-ids only the unstamped commits, streamed: a 3 MB unstamped art commit on a local
  // branch is listed with the right id with a 1 MB read limit, and no `git log -p --branches` runs.
  g('switch', '-q', '-c', 'local-art', 'main');
  write('game/demo/art/local.bin', crypto.randomBytes(3 * 1024 * 1024));
  commit('local art before the upgrade', ['--no-verify']);
  const localArt = head();
  const want = (spawnSync('git', ['patch-id', '--verbatim'], { cwd: dir, encoding: 'utf8', input: g('-c', 'core.quotePath=true', 'show', '--format=commit %H', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers', '--indent-heuristic', '-U3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', '--binary', '--ignore-submodules=none', '--submodule=short', localArt).stdout, maxBuffer: 256 * 1024 * 1024 }).stdout.trim().split(/\s+/)[0].slice(0, 12));
  const gf = traced('node harness/hook-stamp.mjs grandfather --json', { STUDIO_HOOKS_MAX_BUFFER: SMALL });
  let listed = {};
  try { listed = JSON.parse(fs.readFileSync(path.join(dir, '.git', 'studio-hooks-grandfather.json'), 'utf8')); } catch {}
  report('2.58.5 (H-7): node harness/hook-stamp.mjs grandfather patch-ids only the unstamped local commits, streamed: a 3 MB unstamped art commit is listed by sha and the right patch-id with a 1 MB read limit, and no git log -p --branches runs',
    gf.r.status === 0 && gf.j.ok === true && (listed.shas || []).includes(localArt) && /^[0-9a-f]{12}$/.test(want || '') && (listed.pids || []).includes(want) && !rangeDiffs(gf.lines).length,
    JSON.stringify({ j: gf.j, want, pids: listed.pids, rangeDiffs: rangeDiffs(gf.lines) }).slice(0, 1500));
}
