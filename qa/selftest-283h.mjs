/**
 * qa/selftest-283h.mjs — 2.83 (h): the disk an engine's work leaves behind (harness/engine-clean.mjs).
 *
 *   lanes    a landed, clean engine lane folder is removed (event written); unlanded, dirty and fresh lanes are kept
 *            with the reason; `npm run lanes -- prune` names the engine lane
 *   builds   the newest N build folders stay, LATEST.txt points at the newest, unsafe settings touch nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283H({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s283h-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = { ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_HOOKS_CHECK: 'off', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };

  // ---- a studio copy with its own git and events file ----
  const S = path.join(tmpRoot, `283h-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', '.lanes']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const evFile = path.join(S, '.studio', 'events-283h.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mod = JSON.stringify(pathToFileURL(path.join(S, 'harness', 'engine-clean.mjs')).href);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-283h-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ---- a made-up engine repo: target port/main, lanes as worktrees under the studio's .lanes/engine ----
  const R = path.join(T, 'repo');
  const GW = path.join(T, 'gate');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main');
  write(R, '.gitignore', 'scratch.tmp\n');
  write(R, 'base.txt', 'base\n');
  g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  g(R, 'checkout', '-q', '-b', 'dev');
  g(R, 'worktree', 'add', '-q', GW, 'port/main');
  const laneDir = (t) => path.join(S, '.lanes', 'engine', t);
  const mkLane = (t, branch, work = true) => {
    g(R, 'branch', branch, 'port/main');
    fs.mkdirSync(path.dirname(laneDir(t)), { recursive: true });
    const w = g(R, 'worktree', 'add', '-q', laneDir(t), branch);
    if (work) { write(laneDir(t), `${t}.txt`, `${t}\n`); g(laneDir(t), 'add', '-A'); g(laneDir(t), 'commit', '-qm', `${t} work`); }
    return w;
  };
  const land = (branch) => g(GW, 'merge', '--no-ff', '-m', `land ${branch}`, `refs/heads/${branch}`);
  mkLane('T-1', 'feat/t1'); mkLane('T-2', 'feat/t2'); mkLane('T-3', 'feat/t3'); mkLane('T-4', 'feat/t4');
  land('feat/t1'); land('feat/t3'); land('feat/t4');
  write(laneDir('T-3'), 'notes.txt', 'unsaved\n');           // landed, but an untracked file that is not ignored
  write(laneDir('T-4'), 'scratch.tmp', 'ignored\n');          // landed, only a git-ignored file
  mkLane('T-5', 'feat/t5', false);                            // fresh: made from the target, no work yet
  fs.writeFileSync(path.join(S, 'studio', 'game.json'), `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW) } } }, null, 2)}\n`);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');

  const one = (t) => probe(`import { removeLandedLane } from ${mod};
const r = removeLandedLane({ root: process.cwd(), engine: 'unity', task: ${JSON.stringify(t)} });
console.log(JSON.stringify(r));`);

  // ================= lanes =================
  const r1 = one('T-1');
  await guard('2.83 engine lane: a landed, clean lane folder is removed with plain git worktree remove, git forgets it, and one engine.lane.removed event names the task and folder (fails before this fix: nothing removed a landed engine lane)', () => {
    const ev = events().find((e) => e.type === 'engine.lane.removed');
    const listed = g(R, 'worktree', 'list', '--porcelain').stdout;
    return [r1.removed === true && !fs.existsSync(laneDir('T-1')) && !listed.includes('T-1') && ev?.task === 'T-1' && String(ev.msg).includes('T-1'), JSON.stringify({ r1, ev })];
  });
  const r2 = one('T-2');
  await guard('2.83 engine lane: a lane whose commit is not on the target is kept, with the reason (fails before this fix: no rule existed)', () => [r2.removed === false && fs.existsSync(laneDir('T-2')) && /not on port\/main/.test(r2.why), JSON.stringify(r2)]);
  const r3 = one('T-3');
  await guard('2.83 engine lane: a landed lane with an untracked file that is not git-ignored is kept and the reason names the file (fails before this fix: no rule existed)', () => [r3.removed === false && fs.existsSync(path.join(laneDir('T-3'), 'notes.txt')) && /untracked|change/.test(r3.why) && /notes\.txt/.test(r3.why), JSON.stringify(r3)]);
  const r4 = one('T-4');
  await guard(`2.83 engine lane: a landed lane holding only a git-ignored file is removed (git worktree remove accepts it; observed: ${r4.removed ? 'removed' : `kept, ${r4.why}`}) (fails before this fix: no rule existed)`, () => [r4.removed === true && !fs.existsSync(laneDir('T-4')), JSON.stringify(r4)]);
  const r5 = one('T-5');
  await guard('2.83 engine lane: a fresh lane sitting on the target\'s own tip is kept (it may be a launched pass with nobody committed yet) (fails before this fix: no rule existed)', () => [r5.removed === false && fs.existsSync(laneDir('T-5')) && /tip/.test(r5.why), JSON.stringify(r5)]);
  fs.mkdirSync(laneDir('T-9'), { recursive: true }); write(laneDir('T-9'), 'x.txt', 'x\n');
  const pr = probe(`import { pruneEngineLanes } from ${mod};
console.log(JSON.stringify({ rs: pruneEngineLanes({ root: process.cwd(), engine: 'unity', dryRun: true }) }));`);
  await guard('2.83 engine lane: pruneEngineLanes lists every folder under .lanes/engine; a plain folder that is no worktree of the engine repo is kept with that reason (fails before this fix: no such function)', () => [Array.isArray(pr.rs) && pr.rs.some((x) => x.task === 'T-9' && !x.removed && /not a registered worktree/.test(x.why)) && pr.rs.some((x) => x.task === 'T-2' && !x.removed), JSON.stringify(pr)]);
  // a landed lane for the CLI: T-6
  mkLane('T-6', 'feat/t6'); land('feat/t6');
  const cli = spawnSync(process.execPath, [path.join(S, 'harness', 'lanes.mjs'), 'prune', '--idle', '100000', '--dry-run'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 240000 });
  await guard('2.83 engine lane: `lanes prune --dry-run` names the landed engine lane as one it would remove and leaves it on disk (fails before this fix: the output never mentioned .lanes/engine)', () => [/engine lane would remove [^\n]*\.lanes\/engine\/T-6[^\n]*landed/.test(out(cli)) && fs.existsSync(laneDir('T-6')), out(cli).slice(-1500)]);
  const cli2 = spawnSync(process.execPath, [path.join(S, 'harness', 'lanes.mjs'), 'prune', '--idle', '100000', '--by', 'tester'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 240000 });
  await guard('2.83 engine lane: `lanes prune` (not a dry run) removes it and says so (fails before this fix: the landed engine lane stayed for ever)', () => [/engine lane removed [^\n]*\.lanes\/engine\/T-6/.test(out(cli2)) && !fs.existsSync(laneDir('T-6')), out(cli2).slice(-1500)]);

  // ================= builds =================
  const B = path.join(T, 'builds');
  const mkBuilds = () => {
    fs.rmSync(B, { recursive: true, force: true });
    for (const n of ['gate-20261101', 'gate-20261102', 'gate-20261103', 'gate-20261104', 'gate-20261105']) write(B, `${n}/Game.exe`, n);
    write(B, 'other-20260101/keep.txt', 'k'); write(B, 'gate-note.txt', 'file, not a folder');
  };
  const call = (args) => probe(`import { pruneBuilds } from ${mod};
const a = ${JSON.stringify(args)};
console.log(JSON.stringify(pruneBuilds({ ...a, root: process.cwd() })));`);
  const names = () => fs.readdirSync(B).sort();
  mkBuilds();
  const b1 = call({ dir: B, keep: 2 });
  await guard('2.83 builds: keeps the newest 2 gate-* folders, removes the older, leaves non-matching folders and files alone, and LATEST.txt holds the absolute path of the newest (fails before this fix: build folders piled up)', () => [
    b1.kept?.join() === 'gate-20261105,gate-20261104' && b1.removed?.length === 3 && names().join() === 'gate-20261104,gate-20261105,gate-note.txt,other-20260101,LATEST.txt'.split(',').sort().join()
      && fs.readFileSync(path.join(B, 'LATEST.txt'), 'utf8') === `${path.join(B, 'gate-20261105')}\n` && events().some((e) => e.type === 'engine.builds.pruned' && e.meta?.removed === 3), JSON.stringify({ b1, names: names() })]);
  mkBuilds();
  const b2 = call({ dir: B, keep: 1, latest: 'gate-20261102' });
  await guard('2.83 builds: the folder named by latest is kept besides the newest, and LATEST.txt points at it (fails before this fix: no such function)', () => [
    b2.kept?.join() === 'gate-20261105,gate-20261102' && fs.existsSync(path.join(B, 'gate-20261102')) && !fs.existsSync(path.join(B, 'gate-20261104')) && fs.readFileSync(path.join(B, 'LATEST.txt'), 'utf8') === `${path.join(B, 'gate-20261102')}\n`, JSON.stringify({ b2, names: names() })]);
  mkBuilds();
  const before = JSON.stringify(names());
  const refusals = [['a relative dir', { dir: path.relative(process.cwd(), B), keep: 1 }], ['the studio root', { dir: S, keep: 1 }], ['a pattern of only "*"', { dir: B, keep: 1, pattern: '*' }], ['a pattern with 2 literal characters', { dir: B, keep: 1, pattern: 'ga*' }], ['a filesystem root', { dir: path.parse(S).root, keep: 1 }], ['a parent of the studio', { dir: path.dirname(S), keep: 1 }]];
  const got = refusals.map(([n, a]) => [n, call(a)]);
  await guard('2.83 builds: refuses and touches nothing for a relative dir, the studio root, a parent of it, a filesystem root, and a pattern like "*" or "ga*" (fails before this fix: no such function)', () => [
    got.every(([, r]) => r.refused && !r.removed?.length) && JSON.stringify(names()) === before && !fs.existsSync(path.join(B, 'LATEST.txt')) && fs.existsSync(path.join(S, 'studio')), JSON.stringify(got)]);
  fs.writeFileSync(path.join(S, 'studio', 'game.json'), `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', builds: { dir: fwd(B), keep: 2 } } } }, null, 2)}\n`);
  const bc = probe(`import { buildsConfig } from ${mod};
const root = process.cwd();
console.log(JSON.stringify({ a: buildsConfig('unity', { root, env: {} }), b: buildsConfig('unity', { root, env: { STUDIO_ENGINE_KEEP_BUILDS: '5' } }), c: buildsConfig('unity', { root, env: { STUDIO_ENGINE_KEEP_BUILDS: 'off' } }), d: buildsConfig('unity', { root, env: { STUDIO_ENGINE_KEEP_BUILDS: '0' } }), e: buildsConfig('godot', { root, env: {} }) }));`);
  await guard('2.83 builds: engines.<x>.builds gives { dir, keep, pattern } (pattern default gate-*); STUDIO_ENGINE_KEEP_BUILDS overrides keep, 0 or off disables, an engine with no builds setting gives null', () => [
    bc.a?.keep === 2 && bc.a.pattern === 'gate-*' && path.resolve(bc.a.dir) === path.resolve(B) && bc.b?.keep === 5 && bc.c === null && bc.d === null && bc.e === null, JSON.stringify(bc)]);
}
