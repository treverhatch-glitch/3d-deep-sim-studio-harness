/**
 * qa/selftest-276h.mjs — 2.76.0 (helper h): the merge train.
 *   B-85    files the game's own build/test scripts write (git-ignored unpacked art, a .tsbuild/ folder, .vite-cache) no
 *           longer make a verify "dirty": the ignored files a verify's checks wrote are remembered as output, a
 *           "generated" glob (the game's studio.gates.json) names more, an ignored folder of harmless files is judged by
 *           its files; and a train verify whose gates are all green and whose only "dirt" is ignored non-config files is
 *           green with a trust note, never a hand-back. The other side (2.71.1) still holds: an untracked vitest.config,
 *           a config-like name under a "generated" glob, a generated file edited by hand and an ignored root .npmrc keep
 *           a verify dirty, and the train hands such a lane back.
 *   B-88    a train records its end on every exit path it can see (an exception in a step, an unhandled rejection, a
 *           signal), and a train whose process is gone is found (the next train, the daemon's pass): task.train.died with
 *           "died: <last step>", its status and lock cleared, its lanes kept moving.
 *   W-0081  a queued lane whose copy is missing is recreated from its branch, not handed back.
 *   beta    in beta mode the hand-back cap holds the lane for the beta actors (orchestrator, Producer) and files ONE
 *           Producer rescue task, never "a person looks"; infrastructure hand-backs (a missing copy, a CRLF/hash
 *           mismatch, a re-queue, a dead train, a timeout-only red) never count toward the cap and a release survives
 *           them for the same commit.
 *   B-91/92 a lane carrying another open task's commits (Studio-Task trailer) is refused before its verify, naming them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest276H({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-276h-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `276h-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-276h.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-276h-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);

  // ONLY_276H=b85,b88,… runs some parts (a maintainer's shortcut; the full selftest runs them all).
  const want = (k) => !process.env.ONLY_276H || process.env.ONLY_276H.split(',').includes(k);
  // ---- B-85: generated files are output, not hidden inputs ----
  if (want('b85')) {
    // A made-up web game whose only check writes what a pretest step would: unpacked art (only when missing, as an
    // unpack step does), a tsbuildinfo folder and a Vite cache, all git-ignored.
    const gen = `import fs from 'node:fs';
const w = (p, t) => { fs.mkdirSync(p.replace(/\\/[^/]*$/, ''), { recursive: true }); fs.writeFileSync(p, t); };
for (const f of ['a.jpg', 'b.jpg']) if (!fs.existsSync('web/mini/public/art/refs/' + f)) w('web/mini/public/art/refs/' + f, 'jpg ' + f);
w('web/mini/.tsbuild/app.tsbuildinfo', JSON.stringify({ t: 1 }));
w('web/mini/.vite-cache/deps/_metadata.json', '{}');
process.exit(process.env.FAIL_276H ? 1 : 0);
`;
    const { S, env } = studio('b85', (S) => {
      writeIn(S, 'web/mini/gen.mjs', gen);
      writeIn(S, 'web/mini/README.md', '# mini\n');
      writeIn(S, 'web/mini/studio.gates.json', `${JSON.stringify({ generated: ['public/textures/**'] }, null, 2)}\n`);
      writeIn(S, 'studio/game.json', `${JSON.stringify({ game: 'mini' })}\n`);
      writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node web/mini/gen.mjs', required: true, lite: true }] }, null, 2)}\n`);
      fs.appendFileSync(path.join(S, '.gitignore'), '\nweb/mini/public/art/refs/\nweb/mini/public/textures/\nweb/mini/public/art/*.bin\nweb/mini/.tsbuild/\nweb/mini/.vite-cache/\n/.npmrc\n');
    });
    const gatesDir = path.join(S, '.studio', 'gates');
    const verify = (owner, extra = {}) => run(S, 'node scripts/run-gates.mjs --no-detach', { ...env, STUDIO_LOCK_OWNER: owner, ...extra });
    const recOf = (owner) => { try { return JSON.parse(fs.readFileSync(path.join(gatesDir, `${owner}-full.json`), 'utf8')); } catch { return null; } };
    const tree = gitIn(S, 'rev-parse', 'HEAD^{tree}').stdout.trim();
    const fresh = () => { for (const d of [path.join(gatesDir, 'trees'), path.join(S, '.studio', 'train'), path.join(S, '.studio', 'gates-last-full.json'), path.join(S, '.studio', 'gates-last.json')]) fs.rmSync(d, { recursive: true, force: true }); for (const f of fs.existsSync(gatesDir) ? fs.readdirSync(gatesDir) : []) if (f.endsWith('.json')) fs.rmSync(path.join(gatesDir, f), { force: true }); };
    const trainVerify = (name) => { fresh(); return probe(S, env, `vt-${name}`, `import { verifyTree } from ${u(S, 'harness/train.mjs')};
const logs = [];
const r = verifyTree({ root: process.cwd(), dir: process.cwd() }, { id: 'tt-${name}', n: 1, tree: ${JSON.stringify(tree)}, changed: [], all: false, seen: new Map(), log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, why: r.why, logs }));
`); };
    await guard('2.76.0 (B-85 (1)(2)): a second verify in the same checkout, after the check itself wrote git-ignored unpacked art (public/art/refs/), a .tsbuild/ folder of *.tsbuildinfo and a .vite-cache/, is clean (dirty false, nothing hidden); the files were remembered as the checks\' output (fails on 2.75.0: dirty true, "web/mini/.tsbuild/" and the art folder listed as hidden inputs)', () => {
      const v1 = verify('b85-1');
      const r1 = recOf('b85-1');
      const v2 = verify('b85-2');
      const r2 = recOf('b85-2');
      const made = fs.existsSync(path.join(S, 'web/mini/public/art/refs/a.jpg')) && fs.existsSync(path.join(S, 'web/mini/.tsbuild/app.tsbuildinfo'));
      return [made && v1.status === 0 && r1?.dirty === false && v2.status === 0 && r2?.dirty === false && !r2.hidden, `${JSON.stringify({ r1: r1 && { dirty: r1.dirty, hidden: r1.hidden }, r2: r2 && { dirty: r2.dirty, hidden: r2.hidden } })}\n${out(v2).slice(-1200)}`];
    });
    await guard('2.76.0 (B-85 (1)): an ignored file the game declares as generated ("generated": ["public/textures/**"] in its studio.gates.json), present before the verify, counts as output: the verify is clean (fails on 2.75.0: "web/mini/public/textures/" was a hidden input, dirty)', () => {
      writeIn(S, 'web/mini/public/textures/grass.png', 'png');
      const v = verify('b85-glob');
      const r = recOf('b85-glob');
      return [v.status === 0 && r?.dirty === false && !r.hidden && /generate/.test(out(v)), `${JSON.stringify(r && { dirty: r.dirty, hidden: r.hidden })}\n${out(v).slice(-1200)}`];
    });
    await guard('2.76.0 (B-85, the 2.71.1 side): still dirty: an untracked vitest.config in the game; a config-like file (vite.config.ts) inside a "generated" glob\'s folder; a remembered generated file edited by hand since; an ignored root .npmrc. Each one is named in the record (passes on 2.75.0 too: it guards 2.71.1\'s purpose)', () => {
      const res = {};
      writeIn(S, 'web/mini/vitest.config.ts', 'export default { test: { include: ["src/misc/**"] } }\n');
      verify('b85-u'); res.untracked = recOf('b85-u');
      fs.rmSync(path.join(S, 'web/mini/vitest.config.ts'), { force: true });
      writeIn(S, 'web/mini/public/textures/vite.config.ts', 'export default {}\n');
      verify('b85-c'); res.config = recOf('b85-c');
      fs.rmSync(path.join(S, 'web/mini/public/textures/vite.config.ts'), { force: true });
      fs.writeFileSync(path.join(S, 'web/mini/public/art/refs/a.jpg'), 'jpg a, edited by hand after the verify wrote it');
      const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(S, 'web/mini/public/art/refs/a.jpg'), t, t);
      verify('b85-e'); res.edited = recOf('b85-e');
      fs.rmSync(path.join(S, 'web/mini/public/art/refs/a.jpg'), { force: true });
      verify('b85-reset');
      writeIn(S, '.npmrc', 'registry=https://registry.example.invalid/\n');
      verify('b85-n'); res.npmrc = recOf('b85-n');
      fs.rmSync(path.join(S, '.npmrc'), { force: true });
      const has = (r, re) => r?.dirty === true && (r.hidden || []).some((h) => re.test(h));
      return [has(res.untracked, /web\/mini\/vitest\.config\.ts$/) && has(res.config, /textures/) && has(res.edited, /art\/refs/) && has(res.npmrc, /^\.npmrc$/), JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, r]) => [k, r && { dirty: r.dirty, hidden: r.hidden }])))];
    });
    await guard('2.76.0 (B-85 (3)): a train verify whose gates all pass and whose record is "dirty" only from an ignored non-config file (not generated, not declared) is green with a trust note (a task.train.trust_note event), not "its record is not a clean full verify" (fails on 2.75.0: ok false, the lane handed back)', () => {
      writeIn(S, 'web/mini/public/art/notes.bin', 'a cache file nobody declared');
      const t = trainVerify('note');
      fs.rmSync(path.join(S, 'web/mini/public/art/notes.bin'), { force: true });
      return [t.ok === true && t.logs?.some((l) => /trust note/.test(l)), JSON.stringify(t).slice(0, 2500)];
    });
    await guard('2.76.0 (B-85 (3), the other side): the same train verify beside an untracked vitest.config in the game is not green: its record is not a clean full verify, so the lane is handed back (passes on 2.75.0 too)', () => {
      writeIn(S, 'web/mini/vitest.config.ts', 'export default {}\n');
      const t = trainVerify('untracked');
      fs.rmSync(path.join(S, 'web/mini/vitest.config.ts'), { force: true });
      return [t.ok === false && /not a clean full verify/.test(t.why || '') && !t.logs?.some((l) => /trust note/.test(l)), JSON.stringify(t).slice(0, 2500)];
    });
  }

  // ---- B-88: a train records its end, and a dead one is found ----
  if (want('b88')) {
    const { S, ev, env } = studio('b88');
    const head = gitIn(S, 'rev-parse', 'HEAD').stdout.trim();
    const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    const tdir = (id) => path.join(S, '.studio', 'train', id);
    const st = (id) => { try { return JSON.parse(fs.readFileSync(path.join(tdir(id), 'status.json'), 'utf8')); } catch { return null; } };
    const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'queue.json'), 'utf8')); } catch { return []; } };
    const died = () => events(ev).filter((e) => e.type === 'task.train.died');
    await guard('2.76.0 (B-88): a step that throws mid-train (the lane check) is recorded: task.train.died with the step it died in, status "died", life.json ended, and the error still reaches the caller (fails on 2.75.0: no end recorded, status stuck)', () => {
      const r = probe(S, env, 'crash', `import { runTrain } from ${u(S, 'harness/train.mjs')};
let threw = '';
try { await runTrain({ root: process.cwd(), by: 'tester', lanes: [{ task: 'T-901', agent: 'builder-x', dir: process.cwd(), branch: 'main', head: ${JSON.stringify(head)} }], quietJob: true, deps: { precheck: () => { throw new Error('the lane check crashed'); }, handBack: () => {} }, log: () => {} }); } catch (e) { threw = e.message; }
console.log(JSON.stringify({ threw }));
`);
      const d = died().find((e) => /the lane check crashed/.test(e.msg));
      const id = d?.meta?.train;
      const life = id ? JSON.parse(fs.readFileSync(path.join(tdir(id), 'life.json'), 'utf8')) : null;
      return [r.threw === 'the lane check crashed' && d && d.meta.step === 'precheck' && /died: precheck/.test(d.msg) && st(id)?.step === 'died' && life?.ended?.how === 'died', JSON.stringify({ r, d, st: id && st(id), life }).slice(0, 2500)];
    });
    await guard('2.76.0 (B-88): a train process stopped by Ctrl+C (SIGINT) records its death on the way out (POSIX; on Windows a signal can\'t be sent to a child this way, so the reaper covers it) (fails on 2.75.0: nothing to record it)', async () => {
      if (process.platform === 'win32') return [true, 'skipped on Windows'];
      const ready = path.join(tmpRoot, `b88-ready-${process.pid}`);
      const f = path.join(tmpRoot, `b88-sig-${process.pid}.mjs`);
      fs.writeFileSync(f, `import fs from 'node:fs';
import { beginTrainLife } from ${u(S, 'harness/train-life.mjs')};
const id = '20261104-010203-' + process.pid;
const h = beginTrainLife(process.cwd(), { id, by: 'sig-test' });
fs.writeFileSync(${JSON.stringify(ready)}, id);
setInterval(() => {}, 1000);
`);
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [f], { cwd: S, env: { ...process.env, ...env }, windowsHide: true, stdio: 'ignore' });
      let exited = null;
      const gone = new Promise((res) => child.on('exit', (c) => { exited = c; res(c); }));
      const t0 = Date.now();
      while (!fs.existsSync(ready) && exited === null && Date.now() - t0 < 60000) await new Promise((res) => setTimeout(res, 100));
      const id = fs.existsSync(ready) ? fs.readFileSync(ready, 'utf8') : '';
      if (exited === null) child.kill('SIGINT');
      const code = await gone;
      fs.rmSync(f, { force: true }); fs.rmSync(ready, { force: true });
      const d = died().find((e) => e.meta?.train === id);
      return [id && code === 130 && d && /SIGINT/.test(d.msg) && st(id)?.step === 'died', JSON.stringify({ id, code, d, st: id && st(id) })];
    });
    await guard('2.76.0 (B-88): a train whose process is gone (killed: nothing in it ran) is found by the next train\'s reaper: task.train.died "died: verify", its status "died", the train lock that still names it freed, its task done\'s own lane queued again (not a hand-back) and a queued lane kept in place; a train from before 2.76 (status.json only, stuck) is found by the pid in its id; a second death with the same head holds the lane for the Producer (fails on 2.75.0: no reaper; status stuck at verify)', () => {
      const p1 = deadPid(); const p2 = deadPid(); const p3 = deadPid();
      const id1 = `20261104-044849-${p1}`; const id2 = `20261104-050000-${p2}`; const id3 = `20261104-060000-${p3}`;
      const w = (rel, j) => writeIn(S, rel, `${JSON.stringify(j, null, 2)}\n`);
      w(`.studio/train/${id1}/status.json`, { train: id1, step: 'verify', text: 'verify 1: lanes 1-2, T-911, T-912' });
      w(`.studio/train/${id1}/life.json`, { id: id1, pid: p1, by: 'builder-s157', at: new Date().toISOString(), lanes: [{ task: 'T-911', agent: 'builder-a', dir: S, branch: 'lane/a', head: 'a'.repeat(40), own: true }, { task: 'T-912', agent: 'builder-b', dir: S, branch: 'lane/b', head: 'b'.repeat(40), fromQueue: true }], ended: null });
      w('.studio/locks/train.lock', { pid: p1, at: Date.now(), id: id1, by: 'builder-s157' });
      w('.studio/train/queue.json', [{ task: 'T-912', agent: 'builder-b', dir: S, branch: 'lane/b', head: 'b'.repeat(40), at: new Date().toISOString() }]);
      w(`.studio/train/${id2}/status.json`, { train: id2, step: 'verify', text: 'verify 1' });
      const r1 = probe(S, env, 'reap', `import { reapTrains } from ${u(S, 'harness/train.mjs')};
console.log(JSON.stringify(reapTrains(process.cwd(), {})));
`);
      const q1 = queue();
      const lockGone = !fs.existsSync(path.join(S, '.studio', 'locks', 'train.lock'));
      // A second train dies with T-912 at the same head.
      w(`.studio/train/${id3}/status.json`, { train: id3, step: 'verify', text: 'verify 1' });
      w(`.studio/train/${id3}/life.json`, { id: id3, pid: p3, by: 'train-daemon', at: new Date().toISOString(), lanes: [{ task: 'T-912', agent: 'builder-b', dir: S, branch: 'lane/b', head: 'b'.repeat(40), fromQueue: true }], ended: null });
      const r2 = probe(S, env, 'reap2', `import { reapTrains } from ${u(S, 'harness/train.mjs')};
console.log(JSON.stringify(reapTrains(process.cwd(), {})));
`);
      const q2 = queue();
      const d1 = died().find((e) => e.meta?.train === id1);
      const ok = d1 && /died: verify/.test(d1.msg) && st(id1)?.step === 'died' && lockGone && st(id2)?.step === 'died' && died().some((e) => e.meta?.train === id2)
        && q1.find((e) => e.task === 'T-911')?.diedIn?.train === id1 && q1.find((e) => e.task === 'T-912')?.diedIn?.train === id1
        && !events(ev).some((e) => e.type === 'task.paused')
        && q2.find((e) => e.task === 'T-912')?.held && /two trains died/.test(q2.find((e) => e.task === 'T-912').held.why);
      return [ok, JSON.stringify({ r1, r2, q1, q2, lockGone, d1 }).slice(0, 3000)];
    });
    await guard('2.76.0 (B-88): the train daemon\'s pass records a dead train too (task.train.died), so its stuck status no longer reads as running (fails on 2.75.0)', async () => {
      const p = deadPid(); const id = `20261104-070000-${p}`;
      writeIn(S, `.studio/train/${id}/status.json`, JSON.stringify({ train: id, step: 'verify', text: 'verify 2' }));
      writeIn(S, '.studio/locks/train.lock', JSON.stringify({ pid: p, at: Date.now(), id, by: 'train-daemon' }));
      const r = probe(S, env, 'daemon', `import { trainDaemonPass } from ${u(S, 'harness/train-daemon.mjs')};
const r = await trainDaemonPass({ root: process.cwd(), env: { ...process.env, STUDIO_TRAIN_AUTO: 'on' }, spawnTrain: () => ({ pid: 1 }), dryRun: false, queue: [], room: { ok: true } });
console.log(JSON.stringify(r));
`);
      return [died().some((e) => e.meta?.train === id) && st(id)?.step === 'died', JSON.stringify({ r, st: st(id) })];
    });
  }

  // ---- W-0081, the hand-back cap in beta mode, infrastructure hand-backs, kept releases, mixed lanes (B-91/92) ----
  if (want('lanes')) {
    const tasks = ['T-921', 'T-922', 'T-923', 'T-924', 'T-925', 'T-926', 'T-927'];
    const { S, ev, env } = studio('lanes', (S) => {
      writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node -e "process.exit(0)"', required: true, lite: true, cache: false }] }, null, 2)}\n`);
      writeIn(S, 'studio/NEXT.md', `# Studio Task Queue\n\n## IN_PROGRESS\n${tasks.map((t) => `- [>] **${t}** [P1] (\`builder\`) — made-up task ${t}`).join('\n')}\n\n## BACKLOG\n\n## DONE\n`);
      fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    });
    const person = { ...env, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_LOCK_OWNER: '' };
    const queueF = path.join(S, '.studio', 'train', 'queue.json');
    const queue = () => { try { return JSON.parse(fs.readFileSync(queueF, 'utf8')); } catch { return []; } };
    const mainHas = (rel) => gitIn(S, 'cat-file', '-e', `main:${rel}`).status === 0;
    const lane = (name, task, files, { tags = [task], extra = [] } = {}) => {
      const d = path.join(S, '.lanes', name);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${name}`, d, 'main');
      for (const c of [...extra, { files, tags }]) {
        for (const [rel, text] of Object.entries(c.files)) writeIn(d, rel, text);
        gitIn(d, 'add', '-A');
        gitIn(d, 'commit', '-q', '--no-verify', '-m', `${task}: work`, ...c.tags.map((t) => ['-m', `Studio-Task: ${t}`]).flat());
      }
      return { task, agent: `builder-${name}`, dir: d, branch: `lane/${name}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date().toISOString() };
    };
    const train = (name, hb = 0, extraEnv = {}) => probe(S, { ...env, ...extraEnv }, `train-${name}`, `import { runTrain } from ${u(S, 'harness/train.mjs')};
const calls = { handBack: [], rescue: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: () => ({ ok: true }), handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(0, 600)]), handBacks: () => ${hb}, fileRescue: (x) => { calls.rescue.push(x); return { id: 'T-990', title: 'Rescue ' + x.task + ': handed back ' + x.n + ' times' }; } }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ landed: r.landed, dropped: r.dropped, held: r.held, calls, logs: logs.slice(-25) }));
`);
    const setQueue = (list) => writeIn(S, '.studio/train/queue.json', `${JSON.stringify(list, null, 2)}\n`);
    await guard('2.76.0 (W-0081): a queued lane whose copy folder is gone is made again from its branch (task.train.lane_recreated) and lands, not handed back as "its lane copy … is gone" (fails on 2.75.0: dropped)', () => {
      const L = lane('w81', 'T-921', { 'docs/w81-276h.md': '# notes\n' });
      fs.rmSync(L.dir, { recursive: true, force: true });
      setQueue([L]);
      const t = train('w81');
      const made = events(ev).some((e) => e.type === 'task.train.lane_recreated' && e.task === 'T-921');
      return [made && t.landed?.includes('T-921') && mainHas('docs/w81-276h.md') && fs.existsSync(path.join(L.dir, 'docs/w81-276h.md')), JSON.stringify(t).slice(0, 2500)];
    });
    await guard('2.76.0 (beta, Priority 1): infrastructure hand-backs (a missing lane copy, a CRLF hash mismatch, a re-queue, a dead train, a timeout-only red re-run alone, a mixed lane) don\'t count toward the hand-back cap; a real one does (fails on 2.75.0: 7 counted)', () => {
      const evF = path.join(S, '.studio', 'events-276h.jsonl');
      const msgs = ['Not landed by merge train x: its lane copy /x/.lanes/a is gone', 'Not landed by merge train x: the protected approval was hashed on CRLF bytes and the committed blobs are LF', 'Not landed by merge train x: re-queued after its copy was made again', 'Not landed by merge train x: train 20261104-044849-34540 died during verify', 'Not landed by merge train x: timeout-flake: 2 test file(s) timed out and passed alone', 'Not landed by merge train x: a mixed lane: it carries commits of another task that hasn\'t landed', 'Not landed by merge train x: the checks fail on main + this lane (game)'];
      fs.appendFileSync(evF, msgs.map((m, i) => `${JSON.stringify({ id: `evt_hb_${i}`, ts: new Date().toISOString(), type: 'task.paused', task: 'T-923', agent: 'train', status: 'paused', msg: `Handed back T-923: ${m}`, meta: { reasonKey: `k${i}` } })}\n`).join(''));
      const r = probe(S, env, 'hbcount', `import { handBackCount } from ${u(S, 'harness/train.mjs')};
console.log(JSON.stringify({ n: handBackCount('T-923') }));
`);
      return [r.n === 1, JSON.stringify(r)];
    });
    // Beta mode on (studio/beta.json committed by a person), with the orchestrator opus-1.
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'the-owner', at: new Date().toISOString(), why: 'beta: the harness is still being built', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    gitIn(S, 'add', 'studio/beta.json'); gitIn(S, 'commit', '-q', '--no-verify', '-m', 'beta: on');
    await guard('2.76.0 (beta, Priority 1): in beta mode a tier-B lane over the hand-back cap is held for the orchestrator and the Producer (held.beta, "no owner needed") with ONE Producer rescue task "Rescue <ID>: handed back N times", and the orchestrator releases it with --by opus-1, no owner key or --permission (fails on 2.75.0: "a person looks", no task, opus-1 refused)', () => {
      const L = lane('cap', 'T-922', { 'misc/cap-276h.txt': 'a change no tier rule names\n' });
      setQueue([L]);
      const t = train('cap', 5);
      const e = queue().find((x) => x.task === 'T-922');
      const rel = probe(S, { ...env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' }, 'release-beta', `import { releaseLane } from ${u(S, 'harness/train.mjs')};
console.log(JSON.stringify(releaseLane(process.cwd(), 'T-922', { by: 'opus-1' })));
`);
      const ok = e?.held?.beta === true && /orchestrator or the Producer/.test(e.held.why) && !/a person looks/.test(e.held.why) && t.calls?.rescue?.length === 1 && t.calls.rescue[0].task === 'T-922' && rel.ok === true;
      return [ok, JSON.stringify({ t, e, rel }).slice(0, 3000)];
    });
    gitIn(S, 'rm', '-q', 'studio/beta.json'); gitIn(S, 'commit', '-q', '--no-verify', '-m', 'beta: off');
    await guard('2.76.0 (Priority 1): a release made for a commit survives an infrastructure hand-back: the lane leaves the queue (its copy was missing) and is queued again at the same head, and the next train lands it without holding it again for the hand-back count (fails on 2.75.0: held again, "handed back 6 times")', () => {
      const L = lane('rel', 'T-924', { 'misc/rel-276h.txt': 'a tier-B change\n' });
      setQueue([L]);
      train('rel-1', 5);
      const rel = probe(S, person, 'release', `import { releaseLane } from ${u(S, 'harness/train.mjs')};
console.log(JSON.stringify(releaseLane(process.cwd(), 'T-924', { by: 'the-owner' })));
`);
      setQueue([{ ...L, at: new Date().toISOString() }]); // taken out and queued again at the same head: no release on the entry
      const t = train('rel-2', 6);
      return [rel.ok === true && t.landed?.includes('T-924') && mainHas('misc/rel-276h.txt'), JSON.stringify({ rel, t }).slice(0, 3000)];
    });
  }
}
