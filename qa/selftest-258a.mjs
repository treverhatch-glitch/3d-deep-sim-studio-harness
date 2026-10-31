/**
 * qa/selftest-258a.mjs — 2.58.0 part A: what task done trusts and how a task is typed.
 *   Size growth from the merge-base (crew report): once a task's branch takes in the studio's main branch, the size
 *          ratchet compares with the merge-base of HEAD and main, so main's growth isn't the task's; its own still is.
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
}
