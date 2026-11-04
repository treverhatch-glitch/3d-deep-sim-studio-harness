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

  // ---- B-85: generated files are output, not hidden inputs ----
  {
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
}
