/**
 * harness/upgrade-smoke.mjs — 2.73.0 (f): `npm run upgrade -- --smoke [--keep] [--json]`, right after taking a harness
 * update. Does the updated harness work here, before the crew starts on it?
 *
 *   copy         a scratch copy of the studio's harness (harness/, scripts/, qa/*.mjs, studio/ without the board, keys or
 *                approvals, the top-level files) in the OS temp folder, its own git repo, node_modules linked; a fresh
 *                empty board and a made-up game ("smoke": one source file, one test). Never the real board.
 *   verify       a tiny verify there: scripts/run-gates.mjs with four gates (protected, secrets, hooks, the made-up game's test)
 *   train        a tiny train there: a throwaway made-up task added, started in its own lane copy, one commit through the
 *                hooks, `task done --train`, then `task train --now`; PASS when it lands (studio/DONE.md of the copy)
 *   machine      the machine scan in the studio (npm run machine: writes .studio/machine.json, the scan's own cache)
 *   supervisor   one supervisor pass in dry run in the copy (no agent is started: the launcher is stubbed)
 * PASS / FAIL per item with a Fix line under each FAIL, exit 1 on any FAIL, and one `upgrade.smoke` event in the studio's
 * log (meta: the items, the harness version, the time it took). The copy is removed at the end (--keep keeps it and
 * prints where); links are unlinked first, so the studio's node_modules is never touched.
 * Code only: no model, no tokens, no network. UNTESTED on Windows: the junction for node_modules and its removal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BOARD = new Set(['studio/NEXT.md', 'studio/DONE.md', 'studio/task-holds.json', 'studio/pending-review.json', 'studio/proposed.json']);
const SKIP_STUDIO = /^studio\/(handoffs|keys|approvals|logs|research|daily|meetings|reviews|producer|done|decisions)\//;
const item = (id, status, detail, fix = '') => ({ id, status, detail, ...(fix ? { fix } : {}) });
const tail = (r, n = 6) => `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-n).join(' / ').slice(0, 700);

/** Which tracked files the copy takes (repo-relative, forward slashes). */
export function smokeFiles(tracked) {
  return tracked.filter((f) => {
    if (!f || f.includes('..')) return false;
    if (!f.includes('/')) return f !== '.env';
    if (/^(harness|scripts)\//.test(f)) return true;
    if (/^qa\/[^/]+\.(mjs|js|py)$/.test(f)) return true;
    if (/^studio\//.test(f)) return !BOARD.has(f) && !SKIP_STUDIO.test(f) && f !== 'studio/game.json';
    return false;
  });
}

const FRESH_NEXT = '# Studio Task Queue (`studio/NEXT.md`)\n\n> Managed by `node harness/task.mjs`.\n\n## IN_PROGRESS\n_No task currently in progress._\n\n## BACKLOG\n\n## DONE\n_Finished tasks are in `studio/DONE.md`._\n';
const FRESH_DONE = '# Finished tasks (`studio/DONE.md`)\n\n> Managed by `node harness/task.mjs`. Newest first.\n\n## DONE\n';
const RUNNER = [
  "import fs from 'node:fs'; import path from 'node:path';",
  "const G = 'game/smoke';",
  "const args = process.argv.slice(2); const related = args[0] === '--related';",
  "const files = related ? args.slice(1).map((f) => `tests/${path.basename(f).split('.')[0]}.test.mjs`).filter((t) => fs.existsSync(`${G}/${t}`)) : fs.readdirSync(`${G}/tests`).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);",
  'let bad = 0;',
  "for (const t of files) { const src = `${G}/src/${path.basename(t).split('.')[0]}.mjs`; const fail = fs.existsSync(src) && fs.readFileSync(src, 'utf8').includes('BREAKS'); console.log(fail ? ` FAIL  ${t} > adds up` : ` \\u2713 ${t} (1 test)`); if (fail) bad += 1; }",
  "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${files.length - bad} passed (${files.length})`);",
  'process.exit(bad ? 1 : 0);', ''].join('\n');

/** The environment for every command run in the copy: the studio's switches that would reach outside it are cleared. */
export function smokeEnv(base, scratch) {
  const e = { ...base };
  for (const k of Object.keys(e)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR)$/.test(k)) delete e[k];
    if (/^STUDIO_(GATE_|TRAIN_|TEST_|PROTECT_|VERIFY_|UPGRADE_)/.test(k)) delete e[k];
  }
  for (const k of ['STUDIO_MAIN_ROOT', 'STUDIO_LOCK_OWNER', 'STUDIO_ROLE', 'STUDIO_AGENT', 'STUDIO_TASK_BASE', 'STUDIO_HARNESS_REF', 'GITHUB_BASE_REF', 'npm_lifecycle_event', 'NODE_OPTIONS', 'npm_config_node_options', 'STUDIO_REPORT_WEBHOOK', 'HUB_TOKEN']) delete e[k];
  return {
    ...e,
    AGENT_EVENTS_FILE: path.join(scratch, '.studio', 'events.jsonl'),
    STUDIO_GAME: 'smoke', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HEAVY_SLOTS: '0',
    STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_UPGRADE_REFRESH: 'off', STUDIO_HOOKS_CHECK: 'on',
    STUDIO_LANE_LIVE_MIN: '0', STUDIO_WORKAROUND_DETECT: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_REPORT_HOUR: 'off', STUDIO_HARNESS_SCOUT: 'off', STUDIO_TRAIN_AUTO: 'off',
    STUDIO_OWNER_KEY: path.join(scratch, '.studio', 'no-owner-key.pem'),
    GIT_AUTHOR_NAME: 'studio smoke', GIT_AUTHOR_EMAIL: 'smoke@example.invalid', GIT_COMMITTER_NAME: 'studio smoke', GIT_COMMITTER_EMAIL: 'smoke@example.invalid',
  };
}

/** Remove a folder without following links: every link (node_modules, a lane's junction) is unlinked first. */
export function removeTree(dir) {
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const f = path.join(d, ent.name);
      let st = null;
      try { st = fs.lstatSync(f); } catch { continue; }
      if (st.isSymbolicLink()) { try { fs.unlinkSync(f); } catch { try { fs.rmdirSync(f); } catch { /* left for rmSync, which never follows it */ } } } else if (st.isDirectory()) walk(f);
    }
  };
  walk(dir);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); return true; } catch { return false; }
}

function makeCopy(root, scratch, env) {
  const git = (args, cwd = scratch) => spawnSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const ls = spawnSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (ls.status !== 0) return { ok: false, why: `git ls-files failed in the studio: ${tail(ls)}` };
  const files = smokeFiles(ls.stdout.split('\0'));
  for (const f of files) {
    const src = path.join(root, ...f.split('/'));
    let st = null; try { st = fs.lstatSync(src); } catch { continue; }
    if (!st.isFile()) continue;
    const dst = path.join(scratch, ...f.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const write = (rel, text) => { const f = path.join(scratch, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  write('studio/NEXT.md', FRESH_NEXT);
  write('studio/DONE.md', FRESH_DONE);
  write('studio/game.json', `${JSON.stringify({ game: 'smoke' }, null, 2)}\n`);
  write('studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write('game/smoke/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/smoke/run-tests.mjs', related: 'node game/smoke/run-tests.mjs --related {files}' }] }, null, 2)}\n`);
  write('game/smoke/run-tests.mjs', RUNNER);
  write('game/smoke/src/base.mjs', 'export const base = 1;\n');
  write('game/smoke/tests/base.test.mjs', '// base\n');
  write('.studio/events.jsonl', '');
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {} }
  const steps = [['init', '-q', '-b', 'main'], ['config', 'core.autocrlf', 'false'], ['config', 'user.name', 'studio smoke'], ['config', 'user.email', 'smoke@example.invalid'], ['add', '-A'], ['commit', '-qm', 'smoke: a scratch copy of the studio\'s harness', '--no-verify'], ['config', 'core.hooksPath', 'scripts/hooks']];
  for (const s of steps) { const r = git(s); if (r.status !== 0) return { ok: false, why: `git ${s[0]} failed in the copy: ${tail(r)}` }; }
  return { ok: true, files: files.length };
}

function tinyTrain(scratch, env, run) {
  const add = run(scratch, ['harness/task.mjs', 'add', 'Code: smoke change (a throwaway made-up task)', '--role', 'builder', '--priority', 'P1']);
  const id = (`${add.stdout}`.match(/"id": "(T-\d+)"/) || [])[1];
  if (!id) return item('train', 'FAIL', `task add gave no task id in the copy: ${tail(add)}`, 'run npm run task -- add "Code: x" --role builder in a scratch studio and read the error; npm run upgrade -- --rollback --by <you> if it is the update');
  const probe = path.join(scratch, '.studio', 'smoke-lane.mjs');
  fs.writeFileSync(probe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(scratch, 'harness', 'worktree.mjs')).href)};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  const agent = 'smoke-a';
  const made = run(scratch, [probe, agent, id]);
  const lane = path.join(scratch, '.lanes', agent);
  if (!fs.existsSync(lane)) return item('train', 'FAIL', `no lane copy for ${id}: ${tail(made)}`, 'see npm run lanes in a scratch studio; npm run upgrade -- --rollback --by <you> if it is the update');
  const as = { STUDIO_MAIN_ROOT: scratch, STUDIO_LOCK_OWNER: agent };
  const st = run(lane, ['harness/task.mjs', 'start', id, '--agent', agent], as);
  if (st.status !== 0) return item('train', 'FAIL', `task start ${id} refused in its lane: ${tail(st)}`, 'npm run upgrade -- --smoke --keep and read the copy\'s .studio/events.jsonl');
  fs.mkdirSync(path.join(lane, 'game', 'smoke', 'src'), { recursive: true });
  fs.writeFileSync(path.join(lane, 'game', 'smoke', 'src', 'smoke1.mjs'), 'export const smoke1 = 1;\n');
  fs.writeFileSync(path.join(lane, 'game', 'smoke', 'tests', 'smoke1.test.mjs'), '// smoke1\n');
  const gEnv = { ...env, ...as };
  const ga = spawnSync('git', ['add', '-A'], { cwd: lane, encoding: 'utf8', env: gEnv, windowsHide: true });
  const gc = spawnSync('git', ['commit', '-q', '-m', `${id}: add smoke1`], { cwd: lane, encoding: 'utf8', env: gEnv, windowsHide: true });
  if (ga.status !== 0 || gc.status !== 0) return item('train', 'FAIL', `the lane's commit was refused by the hooks: ${tail(gc)}`, 'npm run upgrade -- --smoke --keep and commit in the kept lane copy to see the hook\'s message');
  const done = run(lane, ['harness/task.mjs', 'done', id, '--agent', agent, '--train'], as);
  const train = run(scratch, ['harness/task.mjs', 'train', '--by', 'smoke', '--now']);
  let doneMd = '';
  try { doneMd = fs.readFileSync(path.join(scratch, 'studio', 'DONE.md'), 'utf8'); } catch {}
  if (new RegExp(`\\b${id}\\b`).test(doneMd)) return item('train', 'PASS', `${id} (made up) started in a lane copy, queued with task done --train and landed by task train --now in the copy`);
  return item('train', 'FAIL', `${id} did not land: done ${done.status}: ${tail(done, 4)}; train ${train.status}: ${tail(train, 4)}`, 'npm run upgrade -- --smoke --keep, then read the copy\'s .studio/train/ logs; npm run upgrade -- --rollback --by <you> to go back to the harness before the update');
}

function supervisorPass(scratch, run) {
  const probe = path.join(scratch, '.studio', 'smoke-supervisor.mjs');
  fs.writeFileSync(probe, [
    `import { supervise } from ${JSON.stringify(pathToFileURL(path.join(scratch, 'harness', 'supervisor.mjs')).href)};`,
    "const deps = { sessions: () => [], startAgent: () => ({ ok: false, why: 'smoke: no agent is started' }), launchableRoles: () => [], nextAgentName: (r) => `${r}-smoke`, pauseAgent: () => ({ ok: true }), lanesInline: true, reportInline: true };",
    'const r = await supervise({ deps, dryRun: true }, { startedAt: Date.now() - 1000, names: [] }, Date.now());',
    "console.log(JSON.stringify({ ok: true, started: (r && r.started) || [], why: ((r && r.why) || []).slice(0, 4) }));",
    'process.exit(0);', ''].join('\n'));
  const r = run(scratch, [probe]);
  const j = (() => { try { return JSON.parse(String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return null; } })();
  if (r.status === 0 && j?.ok) return item('supervisor', 'PASS', `one supervisor pass in dry run: ${j.started.length} started${j.why.length ? `; ${j.why.join('; ').slice(0, 200)}` : ''}`);
  return item('supervisor', 'FAIL', `the supervisor pass failed in the copy: ${tail(r)}`, 'node harness/supervisor.mjs --help, then npm run upgrade -- --smoke --keep; npm run upgrade -- --rollback --by <you> if it is the update');
}

/** The smoke: { ok, items, lines, scratch? }. root: the studio's main checkout. */
export async function smoke({ root, env = process.env, keep = false, now = Date.now(), tmp = os.tmpdir() } = {}) {
  const t0 = Date.now();
  const items = [];
  const scratch = fs.mkdtempSync(path.join(tmp, 'studio-smoke-'));
  const senv = smokeEnv(env, scratch);
  const run = (cwd, args, extra = {}) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...senv, ...extra }, maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60000, windowsHide: true });
  try {
    const c = makeCopy(root, scratch, senv);
    items.push(c.ok ? item('copy', 'PASS', `a scratch copy of the studio's harness (${c.files} files, a fresh empty board, the made-up game "smoke")`) : item('copy', 'FAIL', c.why, 'check the free space in the OS temp folder and that git works here'));
    if (c.ok) {
      const v = run(scratch, ['scripts/run-gates.mjs', '--no-detach']);
      items.push(v.status === 0 ? item('verify', 'PASS', 'a tiny verify (protected, secrets, hooks, the made-up game\'s test) is green in the copy') : item('verify', 'FAIL', `the tiny verify is red in the copy (exit ${v.status}): ${tail(v)}`, 'npm run upgrade -- --smoke --keep and run node scripts/run-gates.mjs in the kept copy; npm run upgrade -- --rollback --by <you> if it is the update'));
      items.push(tinyTrain(scratch, senv, run));
    } else items.push(item('verify', 'FAIL', 'not run: no copy', 'see the copy item'), item('train', 'FAIL', 'not run: no copy', 'see the copy item'));
    const m = spawnSync(process.execPath, [path.join(root, 'harness', 'machine.mjs'), '--json'], { cwd: root, encoding: 'utf8', env, timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    let prof = null; try { prof = JSON.parse(m.stdout); } catch {}
    if (m.status === 0 && prof === null && /null/.test(m.stdout)) items.push(item('machine', 'PASS', 'the machine scan is off here (STUDIO_MACHINE_SCAN=off)'));
    else items.push(m.status === 0 && prof?.ram ? item('machine', 'PASS', `the machine scan works: ${prof.ram.totalGb ?? '?'} GB RAM, ${prof.disk?.freeGb ?? '?'} GB disk free, ${(prof.gpus || []).length} GPU(s)`) : item('machine', 'FAIL', `npm run machine failed (exit ${m.status}): ${tail(m)}`, 'npm run machine and read its "Not read" line; STUDIO_MACHINE_SCAN=off falls back to safe defaults'));
    items.push(c.ok ? supervisorPass(scratch, run) : item('supervisor', 'FAIL', 'not run: no copy', 'see the copy item'));
  } finally {
    if (!keep) removeTree(scratch);
  }
  const ok = !items.some((i) => i.status === 'FAIL');
  const ms = Date.now() - t0;
  let version = '?'; try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '?'; } catch {}
  try {
    const ev = await import(pathToFileURL(path.join(root, 'harness', 'event.mjs')).href);
    ev.emitEvent({ type: 'upgrade.smoke', agent: String(env.STUDIO_LOCK_OWNER || 'upgrade').slice(0, 60), status: ok ? 'ok' : 'blocked', msg: `upgrade smoke of harness ${version}: ${ok ? 'PASS' : `FAIL (${items.filter((i) => i.status === 'FAIL').map((i) => i.id).join(', ')})`} in ${Math.round(ms / 1000)} s`, meta: { version, ok, ms, items: items.map(({ id, status, detail }) => ({ id, status, detail: String(detail).slice(0, 300) })) } });
  } catch { /* the result stands */ }
  return { ok, items, ms, version, scratch: keep ? scratch : null };
}
