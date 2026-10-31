/**
 * qa/selftest-258a.mjs — 2.58.0 part A: what task done trusts and how a task is typed.
 *   Size growth from the merge-base (crew report): once a task's branch takes in the studio's main branch, the size
 *          ratchet compares with the merge-base of HEAD and main, so main's growth isn't the task's; its own still is.
 *   Chore type (crew report): build, toolchain, CI and dependency work ("Fix the build", "Chore: …", "[chore]") closes
 *          on its changes and a green verify, without a regression; "Fix a bug in …" is still a bug.
 * Token-shaped values are put together at run time, so this file never holds one and the repo's scan stays clean.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest258A({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  const head = () => g('rev-parse', 'HEAD').stdout.trim();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  // GDScript, so the size check needs no parser package in the copy.
  const lines = (n, tag = 'v') => `${Array.from({ length: n }, (_, i) => `var ${tag}${i} = ${i}`).join('\n')}\n`;
  const ownerKey = path.join(tmpRoot, `owner-258a-${process.pid}.pem`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_OWNER_KEY: ownerKey, STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '' };
  const as = (agent) => ({ ...env, STUDIO_LOCK_OWNER: agent });
  const add = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const start = (id, agent) => run(dir, `node harness/task.mjs start ${id} --agent ${agent}`, as(agent));
  const done = (id, agent) => run(dir, `node harness/task.mjs done ${id} --agent ${agent}`, as(agent));
  const doneCheck = (id, agent) => run(dir, `node harness/done-check.mjs ${id}`, as(agent));
  // Only the named files: the board (studio/NEXT.md) stays a working-tree file, as it does between agents.
  const commit = (msg, ...files) => { g('add', '--', ...files); return g('commit', '-qm', msg, '--no-verify'); };
  const commitTask = (id, msg, ...files) => commit(`${msg}\n\nStudio-Task: ${id}`, ...files);
  const probe = (name, code, penv = env) => {
    const f = path.join(dir, `.probe-258a-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, penv);
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r) }; } catch { return { _out: out(r).slice(-1500) }; }
  };
  const verify = (agent) => run(dir, 'node scripts/run-gates.mjs', as(agent));
  const plant = (agent, rec) => write(`.studio/gates/${agent}-full.json`, JSON.stringify({ at: new Date(Date.now() + 2000).toISOString(), partial: false, scope: 'full', rows: [{ id: 'protected', ok: true, required: true }, { id: 'secrets', ok: true, required: true }], ...rec }));

  // The studio: a quick, real verify (the two checks task done also runs), a game with its own check settings, and
  // two game files for the size ratchet.
  write('studio/gates.json', `${JSON.stringify({ gates: [{ id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true }, { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true }] }, null, 2)}\n`);
  write('studio/game.json', `${JSON.stringify({ cartridge: 'example-sim' }, null, 2)}\n`);
  write('game/pier/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'node tools/test.mjs', required: true }] }, null, 2)}\n`);
  write('game/sg/src/own.gd', lines(10, 'own'));
  write('game/sg/src/main.gd', lines(10, 'main'));
  write('game/sg/art/icon.png.import', '[remap]\nimporter="texture"\n');
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false');
  g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');

  // 1. Size growth from the merge-base: the task's branch takes in a main commit that grows a file past the limit.
  const t1 = add('Grow the own module');
  g('switch', '-q', '-c', 'task/sg');
  start(t1, 'sg-1');
  write('game/sg/src/own.gd', lines(30, 'own'));
  commitTask(t1, 'own grows', 'game/sg/src/own.gd');
  g('switch', '-q', 'main');
  write('game/sg/src/main.gd', lines(40, 'main'));
  commit('main grows main.gd', 'game/sg/src/main.gd');
  const mainTip = head();
  g('switch', '-q', 'task/sg');
  const merged = g('merge', '-q', '--no-edit', 'main');
  const s1 = probe('size', `import * as m from ${u('harness/done-check.mjs')};
console.log(JSON.stringify({ grew: m.sizeGrowth('${t1}', ['game/sg/src/own.gd', 'game/sg/src/main.gd']), base: typeof m.sizeBase === 'function' ? m.sizeBase('${t1}') : null }));`, { ...env, STUDIO_FILE_MAX_LINES: '20' });
  report('2.58.0: once a task\'s branch merges the studio\'s main in, the size ratchet compares with the merge-base (main\'s 40-line file isn\'t the task\'s growth); the task\'s own file grown past the limit is still refused',
    merged.status === 0 && Array.isArray(s1.grew) && s1.grew.some((x) => /game\/sg\/src\/own\.gd is 3\d lines.*over the limit of 20/.test(x)) && !s1.grew.some((x) => /main\.gd/.test(x)) && s1.base === mainTip, `${out(merged)}\n${JSON.stringify(s1).slice(-1500)}`);
  g('switch', '-q', 'main');

  // 2. The chore type.
  const ty = probe('types', `import { taskType } from ${u('harness/done-check.mjs')};
const t = (title, extra = {}) => taskType({ title, role: 'builder', ...extra });
const chores = ['Chore: bump vite', 'chore(deps): bump vite', 'Build: Node 22 for vitest', 'build(deps): bump three', 'Build fails on Windows', 'Toolchain: Node 22', 'Tooling: lint rules', 'Infra: a runner', 'CI: cache npm', 'Deps: bump three', 'Dependencies: refresh the lockfile', 'Fix build', 'Fix the build', 'Fix build: tsc errors', 'Fix build on Windows', 'Fix CI', 'Fix toolchain', 'Fix deps', 'Fix dependencies', 'Bump vite [chore]', 'Fix: vite config [chore]'];
console.log(JSON.stringify({ chore: chores.map((x) => [x, t(x)]).filter(([, y]) => y !== 'chore'), detail: t('Bump vite', { detail: 'type: chore' }), bug: t('Fix a bug in the fee panel'), menu: t('Fix build menu crash'), build: t('Build the stairwell'), review: t('Review: [chore] the toolchain change') }));`);
  report('2.58.0: titles starting chore, build (as a label or with a toolchain word), toolchain, tooling, infra, ci, deps, dependencies, "Fix the build/CI/toolchain/deps", a [chore] tag or "type: chore" are chores; "Fix a bug in …" and "Fix build menu …" stay bugs, "Build the stairwell" a change, a review a review',
    Array.isArray(ty.chore) && ty.chore.length === 0 && ty.detail === 'chore' && ty.bug === 'bug' && ty.menu === 'bug' && ty.build === 'change' && ty.review === 'review', JSON.stringify(ty).slice(-1500));

  const t2 = add('Fix the build: vite config for Node 22');
  start(t2, 'ch-1');
  write('toolchain/node-version.txt', '22\n');
  commitTask(t2, 'node 22', 'toolchain/node-version.txt');
  const v2 = verify('ch-1');
  const d2 = done(t2, 'ch-1');
  const t3 = add('Fix a bug in the fee panel');
  start(t3, 'bug-1');
  write('toolchain/fee-note.txt', 'fees\n');
  commitTask(t3, 'fee panel', 'toolchain/fee-note.txt');
  verify('bug-1');
  const d3 = done(t3, 'bug-1');
  report('2.58.0: a chore ("Fix the build: …") closes with its changes and a green verify after them, no regression; "Fix a bug in …" with the same evidence is refused for its missing regression',
    v2.status === 0 && d2.status === 0 && /"status": "done"/.test(out(d2)) && d3.status !== 0 && /is a "bug" task/.test(out(d3)) && /no regression in qa\/regressions/.test(out(d3)), `${out(v2).slice(-600)}\n---\n${out(d2).slice(-1500)}\n---\n${out(d3).slice(-1500)}`);
}
