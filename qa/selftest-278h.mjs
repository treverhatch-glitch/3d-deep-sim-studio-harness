/**
 * qa/selftest-278h.mjs — 2.78.0 (helper h): B-105, a lane refresh must never write through the lane's studio/ link.
 *   The crew's evidence (2.77.1, Windows): the train dropped T-226 ("git merge failed: studio/task-holds.json"), and a
 *   builder's verify said "needs git rebase main ... then npm run hooks -- restamp, which I may not run". A lane copy's
 *   studio/ is a link (a junction on Windows, a symlink elsewhere) to the main checkout's; a merge of main saw main's live
 *   board files through it as local changes. Now the refresh marks the link's paths left out again first
 *   (lane-sparse.mjs protectSharedLinks), the harness refreshes a stale lane itself when a verify runs, and the
 *   message no longer sends a builder to restamp.
 *   (a) main moves (a harness file and a studio/ board file): the refresh brings the harness change in, main's live studio/
 *       files stay as they were (bytes and git status), the link is still a link
 *   (b) a real conflict in a non-studio file stops the refresh, names the file, leaves the lane as it was
 *   (c) a builder's verify refreshes its own lane (no restamp instruction), and the text never says restamp
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278H({ dir, run, report, tmpRoot, root }) {
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
    STUDIO_LANE_REFRESHED: '', STUDIO_TRAIN_REFRESH: '', STUDIO_LANE_HARNESS: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-278h-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);

  // A studio fixture (a git repo of the harness) whose lane copies are made by createLaneCopy, as a real run does.
  const S = path.join(tmpRoot, `278h-${process.pid}-${++n}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
  fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
  const ev = path.join(S, '.studio', 'events-278h.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
  writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node -e "process.exit(0)"', required: true, lite: true, cache: false }] }, null, 2)}\n`);
  writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n\n## BACKLOG\n\n## DONE\n');
  writeIn(S, 'studio/task-holds.json', '{ "holds": [] }\n');
  writeIn(S, 'game/conflict-278h.txt', 'line 1\nshared line\nline 3\n');
  fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
  gitIn(S, 'init', '-q', '-b', 'main');
  gitIn(S, 'config', 'core.autocrlf', 'false');
  gitIn(S, 'config', 'core.eol', 'lf');
  gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
  const env = { ...base, AGENT_EVENTS_FILE: ev };
  const probe = (name, code, extra = {}) => {
    const f = path.join(tmpRoot, `probe-278h-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const makeLane = (agent) => {
    const r = probe(`mk-${agent}`, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};
const c = createLaneCopy(${JSON.stringify(agent)}, {});
console.log(JSON.stringify({ dir: c.dir || null, branch: c.branch || null, error: c.error || null }));
`);
    if (!r.dir) throw new Error(`no lane copy: ${JSON.stringify(r)}`);
    // The state the crew's lanes were in: the studio/ entries no longer left out of the lane's index.
    const tracked = gitIn(r.dir, 'ls-files', '-z', '--', 'studio/').stdout.split('\0').filter(Boolean);
    if (tracked.length) spawnSync('git', ['update-index', '--no-skip-worktree', '-z', '--stdin'], { cwd: r.dir, input: `${tracked.join('\0')}\0`, windowsHide: true, env: gEnv() });
    return r;
  };
  const refresh = (name, lane) => probe(name, `import { refreshLane } from ${u(S, 'harness/lanes.mjs')};
const r = await refreshLane(process.cwd(), { task: null, agent: ${JSON.stringify(path.basename(lane.dir))}, dir: ${JSON.stringify(lane.dir)}, branch: ${JSON.stringify(lane.branch)} }, { by: 'tester', busyOk: true, tests: false, env: { ...process.env } });
console.log(JSON.stringify(r));
`);
  const studioDigest = () => {
    const h = crypto.createHash('sha256');
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { h.update(path.relative(S, p).replace(/\\/g, '/')); h.update(fs.readFileSync(p)); } } };
    walk(path.join(S, 'studio'));
    return h.digest('hex');
  };
  const mainStatus = () => gitIn(S, 'status', '--porcelain').stdout;
  const isLink = (d) => { try { return fs.lstatSync(path.join(d, 'studio')).isSymbolicLink() && fs.realpathSync(path.join(d, 'studio')) === fs.realpathSync(path.join(S, 'studio')); } catch { return false; } };
  const mainCommit = (files, msg) => { for (const [rel, text] of Object.entries(files)) writeIn(S, rel, text); gitIn(S, 'add', '--', ...Object.keys(files)); const c = gitIn(S, 'commit', '-q', '--no-verify', '-m', msg); if (c.status !== 0) throw new Error(c.stderr); };

  // ---- (a) the harness change comes in; main's live studio/ is untouched ----
  const A = makeLane('builder-h278a');
  await guard('2.78.0 (B-105): main changes a harness file and a studio/ board file; the refresh merges main into the lane copy (the harness file arrives, the committed board change is in its tree) and main\'s live studio/ files are untouched (bytes and git status unchanged), studio/ is still a link (fails on 2.77.1: refused "uncommitted work in it (studio/…)", or on the crew\'s git "git merge failed: studio/task-holds.json")', () => {
    mainCommit({ 'harness/zz-278h.mjs': '// harness change on main (made up)\n', 'studio/task-holds.json': '{ "holds": ["T-1"] }\n' }, 'main: a harness file and a board file');
    writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-970** [P1] (`builder`) — live, not committed\n\n## BACKLOG\n\n## DONE\n');
    const digest = studioDigest(); const status = mainStatus();
    const r = refresh('refresh-a', A);
    const inLane = fs.existsSync(path.join(A.dir, 'harness', 'zz-278h.mjs'));
    const boardInTree = gitIn(A.dir, 'show', 'HEAD:studio/task-holds.json').stdout.includes('T-1');
    const liveNext = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').includes('live, not committed');
    const ok = r.status === 'ok' && r.merged === true && inLane && boardInTree && liveNext && studioDigest() === digest && mainStatus() === status && isLink(A.dir);
    return [ok, JSON.stringify({ r, inLane, boardInTree, liveNext, sameDigest: studioDigest() === digest, sameStatus: mainStatus() === status, link: isLink(A.dir) }).slice(0, 3000)];
  });

  // ---- (b) a real conflict still stops it, naming the file ----
  const B = makeLane('builder-h278b');
  await guard('2.78.0 (B-105): a real conflict in a non-studio file stops the refresh: status "conflict", the file named, the merge aborted, the lane\'s head and files as they were, main\'s studio/ untouched (fails on 2.77.1: refused "uncommitted work in it (studio/…)", no conflict reported)', () => {
    writeIn(B.dir, 'game/conflict-278h.txt', 'line 1\nlane side\nline 3\n');
    gitIn(B.dir, 'add', '-A'); gitIn(B.dir, 'commit', '-q', '--no-verify', '-m', 'lane: its side');
    mainCommit({ 'game/conflict-278h.txt': 'line 1\nmain side\nline 3\n', 'harness/zz2-278h.mjs': '// another harness change (made up)\n', 'studio/task-holds.json': '{ "holds": ["T-2"] }\n' }, 'main: the other side');
    const head = gitIn(B.dir, 'rev-parse', 'HEAD').stdout.trim();
    const digest = studioDigest(); const status = mainStatus();
    const r = refresh('refresh-b', B);
    const gd = gitIn(B.dir, 'rev-parse', '--absolute-git-dir').stdout.trim();
    const ok = r.status === 'conflict' && (r.files || []).includes('game/conflict-278h.txt') && /game\/conflict-278h\.txt/.test(r.why || '')
      && gitIn(B.dir, 'rev-parse', 'HEAD').stdout.trim() === head && !fs.existsSync(path.join(gd, 'MERGE_HEAD'))
      && fs.readFileSync(path.join(B.dir, 'game', 'conflict-278h.txt'), 'utf8') === 'line 1\nlane side\nline 3\n'
      && studioDigest() === digest && mainStatus() === status && isLink(B.dir);
    return [ok, JSON.stringify({ r }).slice(0, 3000)];
  });

  // ---- (c) a builder is not told to run restamp; its verify refreshes the lane ----
  const C = makeLane('builder-h278c');
  await guard('2.78.0 (B-105): a builder\'s verify in a lane copy behind main on harness files refreshes the lane itself (main merged in, studio/ left alone) and runs on the new code; the drift text no longer says "git rebase" or "restamp" and names the hand-back (fails on 2.77.1: "FAIL not run: ... Rebase on it ... restamp")', () => {
    mainCommit({ 'harness/zz3-278h.mjs': '// a third harness change (made up)\n', 'studio/task-holds.json': '{ "holds": ["T-3"] }\n' }, 'main: a third harness change');
    const digest = studioDigest(); const status = mainStatus();
    const v = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--only', 'game', '--no-detach'], { cwd: C.dir, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env, STUDIO_MAIN_ROOT: S, STUDIO_LOCK_OWNER: 'builder-h278c', STUDIO_ROLE: 'builder' }, timeout: 240000 });
    const text = out(v);
    const arrived = fs.existsSync(path.join(C.dir, 'harness', 'zz3-278h.mjs'));
    return [v.status === 0 && arrived && !/restamp/i.test(text) && !/git rebase/i.test(text) && studioDigest() === digest && mainStatus() === status && isLink(C.dir), `${v.status}: ${text.slice(-2500)}`];
  });
  await guard('2.78.0 (B-105): the drift text a launched worker sees when the refresh could not run says to hand the task back (npm run task -- pause) because the lane is refreshed for the next session, and never "restamp" or "git rebase" (a person or Producer still gets the rebase fix; fails on 2.77.1: the worker was told "Rebase on it: git rebase main (then npm run hooks -- restamp ...)")', async () => {
    const hs = await import(pathToFileURL(path.join(S, 'harness', 'hook-stamp.mjs')).href);
    const d = { branch: 'main', files: ['harness/a.mjs', 'harness/b.mjs'] };
    const t = hs.laneDriftText(d, { builder: true });
    const person = hs.laneDriftText(d);
    const ws = [await hs.workerSession({ STUDIO_ROLE: 'builder' }), await hs.workerSession({ STUDIO_LOCK_OWNER: 'builder-x1' }), await hs.workerSession({ STUDIO_ROLE: 'producer' }), await hs.workerSession({})];
    return [!/restamp/i.test(t) && !/git rebase/i.test(t) && /npm run task -- pause/.test(t) && /refreshed for the next session/.test(t) && /git rebase main/.test(person) && ws.join() === 'true,true,false,false', JSON.stringify({ t, person, ws })];
  });
  try { for (const l of [A, B, C]) gitIn(S, 'worktree', 'remove', '--force', l.dir); } catch {}
}
