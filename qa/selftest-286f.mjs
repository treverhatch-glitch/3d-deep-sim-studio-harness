/**
 * qa/selftest-286f.mjs — 2.86 (f): an engine task's worktree should not cost the whole engine project, and the disk must
 * not fill silently (harness/engine-worktree.mjs, engine-tracks.mjs engineLaunch / merge / lane --full, engine-clean.mjs
 * laneRemoval, machine.mjs disk watch).
 *
 *   sparse     a listed role's worktree holds only the sparse folders and the repo's top files; another role's is full;
 *              its brief says so; git too old: full with one line
 *   merge      the target merges into a sparse worktree with a change outside the folders; a conflict outside them says
 *              how to widen; `npm run engine -- lane <ID> --full` fills it
 *   removal    a done or dropped task's worktree goes (branch kept); in progress, queued and uncommitted work keep it
 *   disk       one machine.disk_low a day under STUDIO_DISK_WARN_GB naming the biggest users; STUDIO_DISK_MIN_FREE_GB stops
 *   atomic     a failed creation leaves no folder, no registration and no branch
 *
 * Small throwaway git repos only (a made-up engine repo: Art/, Rules/, tools/tests/, docs/).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest286F({ dir, root, run, report, tmpRoot }) {
  void root;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s286f-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = { ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_HOOKS_CHECK: 'off', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };

  // ---- a studio copy with its own git and events file ----
  const S = path.join(tmpRoot, `286f-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', '.lanes']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const evFile = path.join(S, '.studio', 'events-286f.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const href = (f) => JSON.stringify(pathToFileURL(path.join(S, 'harness', f)).href);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-286f-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const cli = (args, extra = {}) => spawnSync(process.execPath, args.map((a, i) => (i === 0 ? path.join(S, a) : a)), { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 240000 });

  // ---- a made-up engine repo: target port/main, a big art folder and a few source folders ----
  const R = path.join(T, 'repo');
  const GW = path.join(T, 'gate');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main');
  // The repo says its own line endings, so the harness's git (the machine's settings: core.autocrlf is true on a stock Windows
  // git) and this file's git read the same files the same way. Without it a fresh checkout looks modified to the other one.
  g(R, 'config', 'core.autocrlf', 'false');
  write(R, '.gitignore', 'scratch.tmp\n');
  write(R, 'Game.sln', 'sln\n');
  write(R, 'Art/big/hero.bin', 'x'.repeat(4096));
  write(R, 'Art/big/tree.bin', 'y'.repeat(4096));
  write(R, 'Rules/econ/Econ.cs', 'econ\n');
  write(R, 'tools/tests/Rules.Tests.csproj', 'proj\n');
  write(R, 'tools/other/x.txt', 'other\n');
  write(R, 'docs/a.md', 'doc\n');
  g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  g(R, 'checkout', '-q', '-b', 'dev');
  g(R, 'worktree', 'add', '-q', GW, 'port/main');
  const sparse = { roles: ['engine-porter'], paths: ['Rules', 'tools/tests'] };
  fs.writeFileSync(path.join(S, 'studio', 'game.json'), `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), sparse } } }, null, 2)}\n`);
  // The board: T-11..T-19 open, T-15 done.
  const next = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').replace('## BACKLOG\n', `## BACKLOG\n${[11, 12, 13, 14, 16, 17, 18].map((n) => `- [ ] **T-${n}** [P2] (\`engine-porter\`) — Port rule ${n}\n`).join('')}`);
  fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), next);
  const done = fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8').replace('## DONE\n', '## DONE\n- [x] **T-15** [P2] (`engine-porter`) — Port rule 15\n');
  fs.writeFileSync(path.join(S, 'studio', 'DONE.md'), done);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const laneDir = (t) => path.join(S, '.lanes', 'engine', t);
  const files = (d) => { const o = []; const walk = (q, rel) => { for (const e of fs.readdirSync(q, { withFileTypes: true })) { if (e.name === '.git') continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(q, e.name), r); else o.push(r); } }; walk(d, ''); return o.sort(); };
  const launch = (task, role) => probe(`import { engineLaunch, setEngineTask } from ${href('engine-tracks.mjs')};
setEngineTask(${JSON.stringify(task)}, { engine: 'unity', branch: ${JSON.stringify(`feat/${task.toLowerCase()}`)} }, { root: process.cwd() });
const r = engineLaunch({ task: ${JSON.stringify(task)}, agent: 'porter-a', role: ${JSON.stringify(role)}, root: process.cwd() });
console.log(JSON.stringify(r));`);

  // ================= sparse =================
  const l1 = launch('T-11', 'engine-porter');
  const l2 = launch('T-12', 'builder');
  await guard('2.86 (f) sparse: a worktree made for a role in engines.<x>.sparse.roles holds only the sparse folders and the repo\'s top files (no Art/, no docs/), its brief line says it is sparse and how to widen it, and another role\'s worktree is full (fails before this fix: every engine worktree was the whole project)', () => {
    const f1 = fs.existsSync(laneDir('T-11')) ? files(laneDir('T-11')) : [];
    const f2 = fs.existsSync(laneDir('T-12')) ? files(laneDir('T-12')) : [];
    const ok = f1.join() === ['.gitignore', 'Game.sln', 'Rules/econ/Econ.cs', 'tools/tests/Rules.Tests.csproj'].join() && f2.includes('Art/big/hero.bin') && f2.includes('docs/a.md')
      && /This worktree is sparse: it holds only Rules, tools\/tests/.test(l1.note || '') && /npm run engine -- lane T-11 --full/.test(l1.note || '') && !/sparse/.test(l2.note || '')
      && g(laneDir('T-11'), 'status', '--porcelain').stdout.trim() === '' && g(R, 'config', '--get', 'core.sparseCheckout').stdout.trim() !== 'true';
    return [ok, JSON.stringify({ f1, f2, l1, l2 })];
  });
  const commit = probe(`import { spawnSync } from 'node:child_process';
const d = ${JSON.stringify(laneDir('T-11'))};
const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: d, encoding: 'utf8' });
const fs = await import('node:fs');
fs.writeFileSync(d + '/Rules/econ/Econ.cs', 'econ v2\\n');
g('add', '-A'); const c = g('commit', '-qm', 'port econ');
const diff = spawnSync('git', ['diff', '--name-only', 'port/main...feat/t-11'], { cwd: ${JSON.stringify(R)}, encoding: 'utf8' }).stdout.trim();
const { engineWork } = await import(${href('engine-tracks.mjs')});
console.log(JSON.stringify({ c: c.status, diff, art: fs.existsSync(d + '/Art'), work: engineWork('T-11', { root: process.cwd() }) }));`);
  await guard('2.86 (f) sparse: a commit in a sparse worktree touches only what was changed (the branch diff against the target is that one file) and the done check\'s view of the worktree sees one commit and no left-over files (fails before this fix: there was no sparse worktree to commit in)', () => [commit.c === 0 && commit.art === false && commit.diff === 'Rules/econ/Econ.cs' && commit.work?.commits === 1 && commit.work?.dirty?.length === 0, JSON.stringify(commit)]);
  const old = probe(`import { addEngineWorktree } from ${href('engine-worktree.mjs')};
import { spawnSync } from 'node:child_process';
const run = (cwd, args) => (args[0] === '--version' ? { status: 0, stdout: 'git version 2.30.1\\n', stderr: '' } : spawnSync('git', args, { cwd, encoding: 'utf8' }));
const r = addEngineWorktree({ repo: ${JSON.stringify(R)}, dir: ${JSON.stringify(path.join(T, 'old-git'))}, branch: 'feat/old', base: 'port/main', create: true, sparse: ['Rules'], run });
console.log(JSON.stringify(r));`);
  await guard('2.86 (f) sparse: with a git older than 2.38 the worktree is made full and one line says why (fails before this fix: no such rule)', () => [old.ok === true && old.sparse === null && /older than 2\.38.*full, not sparse/.test(old.fallback || '') && fs.existsSync(path.join(T, 'old-git', 'Art', 'big', 'hero.bin')), JSON.stringify(old)]);

  // ================= merge =================
  // The target moves on outside the sparse folders (art), with no conflict.
  g(GW, 'checkout', '-q', 'port/main');
  write(GW, 'Art/big/tree.bin', 'z'.repeat(4096)); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'new art');
  const m1 = probe(`import { engineTargetMerge } from ${href('engine-tracks.mjs')};
console.log(JSON.stringify(await engineTargetMerge('T-11', { root: process.cwd(), env: {} })));`);
  await guard('2.86 (f) merge: npm run engine -- merge brings a target change outside the sparse folders into a sparse worktree with no conflict, commits it, and writes no art file into the worktree (fails before this fix: there was no sparse worktree)', () => {
    const f = files(laneDir('T-11'));
    const inBranch = g(R, 'show', 'feat/t-11:Art/big/tree.bin').stdout.startsWith('zzz');
    return [m1.ok === true && m1.step === 'done' && inBranch && !f.some((x) => x.startsWith('Art/')) && g(laneDir('T-11'), 'status', '--porcelain').stdout.trim() === '', JSON.stringify({ m1, f })];
  });
  // A conflict outside the folders: the task's branch changed the art too (as a full worktree once did).
  fs.writeFileSync(path.join(T, 'art-branch.bin'), 'B'.repeat(4096));
  const h = g(laneDir('T-11'), 'hash-object', '-w', path.join(T, 'art-branch.bin')).stdout.trim();
  g(laneDir('T-11'), 'update-index', '--cacheinfo', `100644,${h},Art/big/hero.bin`);
  g(laneDir('T-11'), 'update-index', '--skip-worktree', 'Art/big/hero.bin'); // outside the cone: not in the folder, not a deletion
  g(laneDir('T-11'), 'commit', '-qm', 'branch art');
  write(GW, 'Art/big/hero.bin', 'T'.repeat(4096)); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target art');
  const m2 = probe(`import { engineTargetMerge } from ${href('engine-tracks.mjs')};
console.log(JSON.stringify(await engineTargetMerge('T-11', { root: process.cwd(), env: {} })));`);
  await guard('2.86 (f) merge: a conflict in a file outside the sparse folders is named as outside them, and the message says how to widen (merge --abort, then npm run engine -- lane <ID> --full) (fails before this fix: no sparse worktree, no such line)', () => {
    const t = (m2.lines || []).join('\n');
    return [m2.step === 'conflict' && (m2.outside || []).includes('Art/big/hero.bin') && /outside this sparse worktree's folders \(Rules, tools\/tests\)/.test(t) && /npm run engine -- merge T-11 --abort, then npm run engine -- lane T-11 --full/.test(t), t];
  });
  const ab = probe(`import { engineTargetMerge } from ${href('engine-tracks.mjs')};
console.log(JSON.stringify(await engineTargetMerge('T-11', { mode: 'abort', root: process.cwd(), env: {} })));`);
  const full = cli(['harness/engine.mjs', 'lane', 'T-11', '--full']);
  await guard('2.86 (f) merge: after the abort the art file the merge wrote is gone again, and `npm run engine -- lane T-11 --full` makes the worktree full (every file there, the task\'s record says full) (fails before this fix: no such command)', () => {
    const f = files(laneDir('T-11'));
    const rec = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'tasks.json'), 'utf8'))['T-11'] || {};
    return [ab.ok === true && full.status === 0 && /now a full worktree/.test(out(full)) && f.includes('Art/big/hero.bin') && f.includes('docs/a.md') && rec.full === true, JSON.stringify({ ab, full: out(full), f, rec })];
  });

  // ================= removal =================
  const mk = (t, { work = true, landTo = false } = {}) => {
    const b = `feat/${t.toLowerCase()}`;
    g(R, 'branch', b, 'port/main');
    fs.mkdirSync(path.dirname(laneDir(t)), { recursive: true });
    g(R, 'worktree', 'add', '-q', laneDir(t), b);
    if (work) { write(laneDir(t), `${t}.txt`, `${t}\n`); g(laneDir(t), 'add', '-A'); g(laneDir(t), 'commit', '-qm', `${t} work`); }
    if (landTo) { g(GW, 'merge', '--no-ff', '-q', '-m', `land ${b}`, `refs/heads/${b}`); }
  };
  mk('T-15');                         // done on the board, its commit not on the target (finished without a train)
  mk('T-16', { landTo: true });       // landed, but its task is claimed again (in progress)
  mk('T-17', { landTo: true });       // landed, but queued for a train again
  mk('T-18', { landTo: true }); write(laneDir('T-18'), 'notes.txt', 'unsaved\n'); // landed, uncommitted work
  mk('T-19', { work: false });        // dropped (a task.dropped event), fresh on the tip
  mk('T-14', { landTo: true });       // landed, open: removed as before
  g(GW, 'commit', '-q', '--allow-empty', '-m', 'move on');
  fs.mkdirSync(path.join(S, '.studio', 'locks'), { recursive: true });
  fs.writeFileSync(path.join(S, '.studio', 'locks', 'task_T-16.x.lock'), JSON.stringify({ key: 'task:T-16', owner: 'porter-b', expiresAt: new Date(Date.now() + 3600000).toISOString() }));
  fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
  fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task: 'T-17', branch: 'feat/t-17' }]));
  fs.appendFileSync(evFile, `${JSON.stringify({ ts: new Date().toISOString(), type: 'task.dropped', task: 'T-19', agent: 'prod', msg: 'dropped T-19' })}\n`);
  const lst = cli(['harness/engine.mjs', 'lanes']);
  const rm = probe(`import { pruneEngineLanes } from ${href('engine-clean.mjs')};
console.log(JSON.stringify({ rs: pruneEngineLanes({ root: process.cwd(), engine: 'unity' }) }));`);
  const by = (t) => (rm.rs || []).find((x) => x.task === t) || {};
  const hasBranch = (b) => g(R, 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`).status === 0;
  await guard('2.86 (f) removal: a done task\'s worktree (its commit not on the target) and a dropped task\'s are removed and their branches kept; a landed open one is removed as before (fails before this fix: only a landed lane that the train itself checked went; 37 stayed on a crew\'s PC)', () => [
    by('T-15').removed === true && !fs.existsSync(laneDir('T-15')) && hasBranch('feat/t-15') && by('T-19').removed === true && hasBranch('feat/t-19') && by('T-14').removed === true && events().some((e) => e.type === 'engine.lane.removed' && e.task === 'T-15'), JSON.stringify(rm)]);
  await guard('2.86 (f) removal: a landed worktree whose task is in progress (claimed) or queued for a train is kept with that reason, and uncommitted work keeps one with a clear "uncommitted work" line naming the file (fails before this fix: a landed lane went even with its task claimed or queued)', () => [
    by('T-16').removed === false && /in progress \(claimed by porter-b\)/.test(by('T-16').why) && fs.existsSync(laneDir('T-16'))
      && by('T-17').removed === false && /queued for a train/.test(by('T-17').why)
      && by('T-18').removed === false && /notes\.txt.*uncommitted work/.test(by('T-18').why), JSON.stringify(rm)]);
  await guard('2.86 (f) removal: `npm run engine -- lanes` lists each engine worktree with its size class (sparse/full), its state and whether it is safe to remove (fails before this fix: no such listing)', () => {
    const t = out(lst);
    return [lst.status === 0 && /T-11\s+full\s+open\s+keep/.test(t) && /T-12\s+full/.test(t) && /T-15\s+full\s+done\s+safe to remove/.test(t) && /T-16\s+full\s+in progress\s+keep/.test(t) && /T-17\s+full\s+queued\s+keep/.test(t), t];
  });
  const pure = probe(`import { laneRemoval } from ${href('engine-clean.mjs')};
const f = { target: 'port/main', onTarget: true, atTip: false, dirty: [], status: 'open' };
console.log(JSON.stringify({ landed: laneRemoval(f), merging: laneRemoval({ ...f, merging: true }), handed: laneRemoval({ ...f, onTarget: false, ahead: 2 }), fresh: laneRemoval({ ...f, atTip: true }), freshDone: laneRemoval({ ...f, atTip: true, status: 'done' }) }));`);
  await guard('2.86 (f) removal: laneRemoval, the one rule: landed is safe; a merge in progress, a handed-back task with unlanded commits and a fresh lane of an open task are kept; a fresh lane of a done task is safe (fails before this fix: no such function)', () => [
    pure.landed?.safe === true && pure.merging?.safe === false && pure.handed?.safe === false && /2 commit/.test(pure.handed.why) && pure.fresh?.safe === false && pure.freshDone?.safe === true, JSON.stringify(pure)]);

  // ================= disk =================
  const GB = 1024 ** 3;
  const disk = probe(`import { sampleMachine, diskStop } from ${href('machine.mjs')};
const ev = [];
const statfs = (free) => () => ({ bavail: (free * ${GB}) / 4096, blocks: (1000 * ${GB}) / 4096, bsize: 4096 });
const opts = { root: process.cwd(), env: { STUDIO_MACHINE_SAMPLE_S: '300' }, platform: 'linux', run: () => ({ ok: false, stdout: '', why: 'stub' }), read: () => { throw new Error('stub'); }, list: () => [], cpus: () => [], wait: () => {}, emit: (e) => ev.push(e), janitor: () => null, statfs: statfs(55) };
const t0 = Date.now();
for (const h of [0, 1, 5, 23]) await sampleMachine({ ...opts, now: t0 + h * 3600000 });
const n1 = ev.filter((e) => e.type === 'machine.disk_low').length;
await sampleMachine({ ...opts, now: t0 + 25 * 3600000 });
const low = ev.filter((e) => e.type === 'machine.disk_low');
const stop = diskStop({ root: process.cwd(), env: {}, statfs: statfs(12) });
const go = diskStop({ root: process.cwd(), env: {}, statfs: statfs(55) });
const off = diskStop({ root: process.cwd(), env: { STUDIO_DISK_MIN_FREE_GB: 'off' }, statfs: statfs(12) });
console.log(JSON.stringify({ n1, low: low.map((e) => e.msg), stop, go, off }));`);
  await guard('2.86 (f) disk: 55 GB free of 1000 (over the old 50 GB budget) is under STUDIO_DISK_WARN_GB (60): one machine.disk_low a day (4 samples in 23 h: one event; 25 h later: a second), naming the biggest users (the engine worktrees by sparse/full) (fails before this fix: no event until under 50 GB, then one every 6 h, naming nothing)', () => [
    disk.n1 === 1 && disk.low?.length === 2 && /disk low: 55 GB free \(under 60 GB, STUDIO_DISK_WARN_GB\)/.test(disk.low[0]) && /biggest: .*unity engine worktrees \(\d+: \d+ full, \d+ sparse\)/.test(disk.low[0]), JSON.stringify(disk)]);
  await guard('2.86 (f) disk: under the disk budget (STUDIO_DISK_MIN_FREE_GB: 50 GB of a 1000 GB volume) the stop says no new engine worktree or lane copy is started and that it is a harness reason; 55 GB free and STUDIO_DISK_MIN_FREE_GB=off do not stop (fails before this fix: no stop existed)', () => [
    disk.stop?.stop === true && /12 GB free .*under 50 GB, STUDIO_DISK_MIN_FREE_GB\): no new engine worktree or lane copy is started \(a harness reason, not the task's/.test(disk.stop.why) && disk.go?.stop === false && disk.off?.stop === false, JSON.stringify(disk)]);
  const sup = fs.readFileSync(path.join(S, 'harness', 'supervisor.mjs'), 'utf8');
  await guard('2.86 (f) disk: the supervisor checks the stop before a start that would make a new lane copy or engine worktree, says why in its line and notes no start refusal against the task (fails before this fix: nothing looked)', () => [/disk \|\|= \(await import\('\.\/machine\.mjs'\)\)\.diskStop\(\{\}\);\s*if \(disk\.stop && await needsNewCopy\(g\)\) \{\s*why\.push\(`\$\{g\.tasks\[0\]\?\.id\}: \$\{disk\.why\}`\);\s*continue;/.test(sup), 'the disk stop is not in the supervisor start loop']);

  // The same through a real pass of the supervisor, in a studio copy with git, one tool and two ready tasks (the launcher is a
  // stand-in that records what it was asked to start): under the budget the task that needs a new lane copy is not started and
  // the pass says why; with the budget off the same pass asks for it.
  {
    const gd = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd: dir, encoding: 'utf8', env: gEnv() });
    if (!fs.existsSync(path.join(dir, '.git'))) { gd('init', '-q', '-b', 'main'); gd('add', '-A'); gd('commit', '-qm', 'studio', '--no-verify'); }
    const senv = { TZ: 'UTC', STUDIO_QUOTA_PROBE: 'off', STUDIO_CLAUDE_PROBE_CMD: 'node -e "process.exit(3)"', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_AUTO_FINISH: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_RND_TOOL: 'claude', STUDIO_TOOL_CLAUDE_CMD: 'node -e 0' };
    run(dir, 'node harness/mode.mjs set fast --by selftest', senv);
    run(dir, 'node harness/budget.mjs order claude', senv);
    for (const t of ['Polish the dock labels', 'Polish the pier labels']) run(dir, `node harness/task.mjs add "${t}" --role rnd --priority P0`, senv);
    const dh = (f) => JSON.stringify(pathToFileURL(path.join(dir, 'harness', f)).href);
    fs.writeFileSync(path.join(dir, '.probe-286f-pass.mjs'), `import * as agent from ${dh('agent.mjs')};
import { supervise } from ${dh('supervisor.mjs')};
const calls = [];
const deps = { sessions: agent.sessions, launchableRoles: agent.launchableRoles, nextAgentName: agent.nextAgentName, startAgent: (o) => { calls.push(o.task); return { ok: false, message: 'stand-in: nothing is started' }; } };
process.env.STUDIO_DISK_MIN_FREE_GB = '99999999';
const low = await supervise({ dryRun: true, deps }, { startedAt: Date.now() });
const lowCalls = calls.slice();
process.env.STUDIO_DISK_MIN_FREE_GB = '0';
const free = await supervise({ dryRun: true, deps }, { startedAt: Date.now() });
console.log(JSON.stringify({ lowWhy: low.why, lowCalls, freeCalls: calls.slice(lowCalls.length), freeWhy: free.why }));
`);
    const pr = run(dir, 'node .probe-286f-pass.mjs', senv);
    let pass = {};
    try { pass = JSON.parse(String(pr.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop()); } catch { pass = { _raw: out(pr).slice(-2500) }; }
    const held = (pass.lowWhy || []).map((w) => /^(T-\d+): disk low: .*STUDIO_DISK_MIN_FREE_GB\): no new engine worktree or lane copy is started/.exec(w)?.[1]).filter(Boolean);
    await guard('2.86 (f) disk: a real supervisor pass under the disk budget does not start the task that needs a new lane copy and says so, naming the task and the setting; the same pass with the budget off asks the launcher for that task (fails before this fix: it was started with no room for its copy)', () => [
      held.length >= 1 && held.every((id) => !pass.lowCalls.includes(id)) && held.some((id) => (pass.freeCalls || []).includes(id)) && !(pass.freeWhy || []).some((w) => /disk low/.test(w)), JSON.stringify(pass).slice(0, 2500)]);
  }

  // ================= atomic =================
  const at = probe(`import { addEngineWorktree } from ${href('engine-worktree.mjs')};
import { spawnSync } from 'node:child_process';
const run = (cwd, args) => (args[0] === 'read-tree' ? { status: 1, stdout: '', stderr: 'error: unable to create file: Filename too long' } : spawnSync('git', args, { cwd, encoding: 'utf8' }));
const r = addEngineWorktree({ repo: ${JSON.stringify(R)}, dir: ${JSON.stringify(laneDir('T-13'))}, branch: 'feat/t-13', base: 'port/main', create: true, sparse: ['Rules'], run });
console.log(JSON.stringify(r));`);
  await guard('2.86 (f) atomic: a creation that fails half way (checking the files out: "Filename too long") leaves no folder, no worktree registration and no new branch, and says nothing was left behind (fails before this fix: a failed step left the half-made worktree)', () => {
    const listed = g(R, 'worktree', 'list', '--porcelain').stdout;
    return [Boolean(at.error) && at.cleaned === true && /Filename too long/.test(at.error) && /nothing was left behind/.test(at.error) && !fs.existsSync(laneDir('T-13')) && !listed.includes('T-13') && !hasBranch('feat/t-13'), JSON.stringify({ at, listed })];
  });

  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp */ }
}
