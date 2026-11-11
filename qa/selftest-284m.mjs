/**
 * qa/selftest-284m.mjs — 2.84 (m): three faults from the first 100 minutes of a native-engine studio on 2.83.
 *
 *   merge    at launch the harness merges the engine's target into the task's engine worktree and, on a conflict, aborts
 *            and told the session to run `git -C <dir> merge <target>`, which a launched session may not run. Three
 *            sessions in a row on each of three tasks handed back "the merge needs a person". Now `npm run engine --
 *            merge <ID>` (harness/engine-tracks.mjs engineTargetMerge) leaves the conflict in the task's own worktree
 *            for the session to resolve, and a launch that meets the same conflict with no new commit since parks once
 *            instead of starting another session.
 *   phantom  a tracked file a `.gitattributes` filter rule makes look modified in every checkout refused `task done`
 *            ("1 uncommitted file(s) ... commit them first"). Now such a file (bytes = the committed blob) is left out of
 *            the dirty lists and named once (harness/eol-only.mjs splitPhantom).
 *   ignore   two branches that changed Play Mode tests and UI files forced the whole batch to the full rules command
 *            (28.5 minutes). Now rules.focus.ignore (and play.focus.ignore) leaves such paths out of the mapping.
 * Each check fails before this change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest284M({ dir, root, report, tmpRoot }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HEAVY_SLOTS: '0',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_LANELESS: 'shared', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_HEARTBEAT_SEC: '1',
    STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_STALL: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_OVERLAP: 'off', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284m-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  const T = path.join(tmpRoot, `s284m-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  let n = 0;
  // A studio copy with its own git and events file, and a made-up engine repo beside it (target port/main, checked out
  // in the land script's gate worktree, as a real engine studio has it).
  const studio = (name, { shared = {}, rules = null, land = 'node -e "process.exit(0)"' } = {}) => {
    const S = path.join(tmpRoot, `284m-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
    const R = path.join(T, `repo-${n}`);
    const GW = path.join(T, `gate-${n}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main'); write(R, 'base.txt', 'base\n'); write(R, 'Game.csproj', '<Project>\n  <Item>A</Item>\n</Project>\n');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev'); g(R, 'worktree', 'add', '-q', GW, 'port/main');
    write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, ...(rules ? { rules } : {}) } } }, null, 2)}\n`);
    const ev = path.join(S, '.studio', 'events-284m.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
    return { S, R, GW, ev, env };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(S, `.probe-284m-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env, encoding: 'utf8', timeout: 180000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const addTask = (S, env, title) => (out(spawnSync(process.execPath, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', '--track', 'engine:unity', '--size', '2'], { windowsHide: true, cwd: S, encoding: 'utf8', env })).match(/\b(T-\d+)\b/) || [])[1];
  const launchLane = (S, env, id) => probe(S, env, `const et = await import(${u(S, 'harness/engine-tracks.mjs')});
const la = et.engineLaunch({ task: ${JSON.stringify(id)}, agent: 'bld-1', role: 'builder' });
console.log(JSON.stringify({ dir: la?.dir || null, branch: la?.branch || null, error: la?.error || null }));`);
  // The command a session runs, through the engine CLI's dispatch (npm run engine -- merge <ID>).
  const merge = (S, env, id, ...more) => spawnSync(process.execPath, ['harness/engine.mjs', 'merge', id, ...more], { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 120000 });
  // Both sides of a one-line conflict in the project file: the target's and the lane's.
  const sideTarget = (GW, item) => { write(GW, 'Game.csproj', `<Project>\n  <Item>A</Item>\n  <Item>${item}</Item>\n</Project>\n`); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', `target adds ${item}`); };
  const sideLane = (L, item) => { write(L, 'Game.csproj', `<Project>\n  <Item>A</Item>\n  <Item>${item}</Item>\n</Project>\n`); g(L, 'add', '-A'); g(L, 'commit', '-qm', `lane adds ${item}`); };

  // ---- 1. merge: the command a session may run ----
  {
    const { S, GW, env, ev } = studio('merge');
    const id = addTask(S, env, 'Port the fees rules');
    const la = launchLane(S, env, id);
    const L = la.dir;
    sideLane(L, 'FeesPanel'); sideTarget(GW, 'LoansPanel');
    const headBefore = g(L, 'rev-parse', 'HEAD').stdout.trim();
    const m1 = merge(S, env, id);
    const marked = read(path.join(L, 'Game.csproj')) || '';
    const c1 = merge(S, env, id, '--continue');
    const headAfterC1 = g(L, 'rev-parse', 'HEAD').stdout.trim();
    // Resolved by keeping both sides, staged, then continued.
    write(L, 'Game.csproj', '<Project>\n  <Item>A</Item>\n  <Item>LoansPanel</Item>\n  <Item>FeesPanel</Item>\n</Project>\n');
    g(L, 'add', 'Game.csproj');
    const c2 = merge(S, env, id, '--continue');
    const parents = g(L, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ').length - 1;
    const after = read(path.join(L, 'Game.csproj')) || '';
    const msg = g(L, 'log', '-1', '--format=%s').stdout.trim();
    const tipNow = g(GW, 'rev-parse', 'HEAD').stdout.trim();
    const hasTarget = g(L, 'merge-base', '--is-ancestor', tipNow, 'HEAD').status === 0;
    await guard('2.84 (m) engine merge, a conflict: `npm run engine -- merge <ID>` merges the target into the task\'s own engine worktree and LEAVES the conflict there (markers in the file, the file named with what to do and the --continue command, exit 2); `--continue` is refused while the markers remain; after the file is resolved and `git add`ed, `--continue` commits a merge commit (two parents, the launch merge\'s message) and the lane holds both sides and the target (fails before this fix: there was no such command; the launch told the session to run `git -C <dir> merge`, which a launched session may not run)', () => [
      Boolean(L) && m1.status === 2 && /Game\.csproj: edit it to keep both sides/.test(out(m1)) && new RegExp(`git -C \\S+ add Game\\.csproj, then npm run engine -- merge ${id} --continue`).test(out(m1)) && /<{7}/.test(marked) && />{7}/.test(marked)
        && c1.status === 2 && /conflict markers in Game\.csproj|unmerged path/.test(out(c1)) && headAfterC1 === headBefore
        && c2.status === 0 && parents === 2 && /LoansPanel/.test(after) && /FeesPanel/.test(after) && !/<{7}/.test(after) && hasTarget && new RegExp(`^Merge port/main into \\S+ \\(engine pass ${id}\\)$`).test(msg),
      JSON.stringify({ st: [m1.status, c1.status, c2.status], c1head: headAfterC1 === headBefore, hasTarget, after, c1: out(c1).slice(-500), m1: out(m1).slice(-900), c1: out(c1).slice(-500), c2: out(c2).slice(-400), parents, msg, marked: marked.slice(0, 300) }).slice(0, 3200)]);

    // --abort: a second conflict, put back.
    sideLane(L, 'FuelPanel'); sideTarget(GW, 'TaxPanel');
    const before2 = read(path.join(L, 'Game.csproj'));
    const head2 = g(L, 'rev-parse', 'HEAD').stdout.trim();
    const m2 = merge(S, env, id);
    const ab = merge(S, env, id, '--abort');
    const st = g(L, 'status', '--porcelain').stdout.trim();
    const inMerge = g(L, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
    await guard('2.84 (m) engine merge, --abort: after a conflicting `engine -- merge`, `--abort` puts the worktree back exactly where it was (same HEAD, same file, clean status, no merge in progress) (fails before this fix: no such command)', () => [
      m2.status === 2 && ab.status === 0 && !inMerge && st === '' && read(path.join(L, 'Game.csproj')) === before2 && g(L, 'rev-parse', 'HEAD').stdout.trim() === head2,
      JSON.stringify({ m2: out(m2).slice(-400), ab: out(ab).slice(-300), st, inMerge }).slice(0, 1500)]);

    // A clean merge is committed at once.
    write(GW, 'Clean.txt', 'clean\n'); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target adds a file');
    // (the two conflicting sides above are still apart: resolve them first so only the clean change is new)
    const m3a = merge(S, env, id);
    write(L, 'Game.csproj', '<Project>\n  <Item>A</Item>\n  <Item>TaxPanel</Item>\n  <Item>FuelPanel</Item>\n</Project>\n'); g(L, 'add', 'Game.csproj');
    const m3b = merge(S, env, id, '--continue');
    write(GW, 'Clean2.txt', 'clean\n'); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target adds another file');
    const m4 = merge(S, env, id);
    const p4 = g(L, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ').length - 1;
    await guard('2.84 (m) engine merge, clean: with no conflict the target is merged and committed at once (a merge commit, the new file there, nothing left to continue) (fails before this fix: no such command)', () => [
      m3a.status === 2 && m3b.status === 0 && m4.status === 0 && /no conflict/.test(out(m4)) && p4 === 2 && fs.existsSync(path.join(L, 'Clean2.txt')) && g(L, 'status', '--porcelain').stdout.trim() === '',
      JSON.stringify({ m3a: out(m3a).slice(-300), m3b: out(m3b).slice(-300), m4: out(m4).slice(-300), p4 }).slice(0, 1500)]);

    // Who may run it: a session launched for another task, or an agent without the claim, is refused.
    sideLane(L, 'DockPanel'); sideTarget(GW, 'GatePanel');
    const other = merge(S, { ...env, STUDIO_LOCK_OWNER: 'bld-9', STUDIO_ROLE: 'builder', STUDIO_TASK_PIN: 'T-999' }, id);
    const noClaim = merge(S, { ...env, STUDIO_AGENT: 'bld-8' }, id);
    const untouched = g(L, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0 && !/<{7}/.test(read(path.join(L, 'Game.csproj')) || '');
    const steps = events(ev).filter((e) => e.type === 'engine.target_merge' && e.task === id).map((e) => e.meta?.step);
    await guard('2.84 (m) engine merge, who: a launched session pinned to ANOTHER task is refused, and so is an agent that does not hold the task\'s claim; neither touches the worktree; the command\'s engine.target_merge events say started, conflict (with the files), done and aborted (fails before this fix: no such command)', () => [
      other.status === 1 && /launched for T-999/.test(out(other)) && noClaim.status === 1 && /does not hold/.test(out(noClaim)) && untouched
        && ['started', 'conflict', 'done', 'aborted'].every((s) => steps.includes(s)) && events(ev).some((e) => e.type === 'engine.target_merge' && e.meta?.step === 'conflict' && (e.meta.files || []).includes('Game.csproj')),
      JSON.stringify({ other: out(other).slice(-300), noClaim: out(noClaim).slice(-300), untouched, steps }).slice(0, 1500)]);
  }

  // ---- 1b. the launch: its note and event name the command; the same conflict again starts no session ----
  {
    const { S, R, GW, env, ev } = studio('launch');
    const id = addTask(S, env, 'Port the loans rules');
    const branch = `unity/${String(id).toLowerCase()}`;
    // The task's branch exists with its own side of the project file; the target gets the other side.
    g(R, 'checkout', '-q', '-b', branch, 'port/main');
    write(R, 'Game.csproj', '<Project>\n  <Item>A</Item>\n  <Item>LoansPanel</Item>\n</Project>\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'lane side');
    g(R, 'checkout', '-q', 'dev');
    sideTarget(GW, 'FeesPanel');
    write(S, '.studio/engine/tasks.json', JSON.stringify({ [id]: { engine: 'unity', track: 'engine:unity', branch } }));
    const agentJs = path.join(T, 'stand-in-agent.mjs');
    fs.writeFileSync(agentJs, `import { spawnSync } from 'node:child_process';
const [task] = process.argv.slice(2);
const st = spawnSync(process.execPath, ['harness/task.mjs', 'start', task, '--agent', process.env.STUDIO_LOCK_OWNER], { cwd: process.env.STUDIO_MAIN_ROOT, encoding: 'utf8', windowsHide: true, env: process.env });
console.log('[stand-in] start: ' + String(st.stdout || '').trim().split('\\n').pop());
`);
    const launch = (agent) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', agent, '--model', 'fake-1', '--task', id, '--one-task'], { windowsHide: true, cwd: S, encoding: 'utf8', timeout: 240000, env: { ...env, STUDIO_BUILDER_CMD: `node "${fwd(agentJs)}" ${id}` } });
    const r1 = launch('bld-a');
    const r2 = launch('bld-b');
    const r3 = launch('bld-c');
    const all = events(ev);
    const conflictEv = all.filter((e) => e.type === 'engine.target_conflict' && e.task === id);
    const starts = (a) => all.filter((e) => e.type === 'agent.session.start' && e.agent === a).length;
    const parks = all.filter((e) => e.type === 'task.hold' && e.task === id && /Parked/.test(e.msg || ''));
    const L = path.join(S, '.lanes', 'engine', id);
    const sy = probe(S, env, `const et = await import(${u(S, 'harness/engine-tracks.mjs')});
const r = et.syncEngineTarget({ task: ${JSON.stringify(id)}, dir: ${JSON.stringify(L)} });
console.log(JSON.stringify({ note: r?.note || '', conflicts: r?.conflicts || [] }));`);
    const detail = () => JSON.stringify({ id, conflictEv: conflictEv.map((e) => e.msg), sy, starts: [starts('bld-a'), starts('bld-b'), starts('bld-c')], parks: parks.map((e) => e.msg), r1: out(r1).slice(-500), r2: out(r2).slice(-500), r3: out(r3).slice(-300) }).slice(0, 3400);
    await guard('2.84 (m) the launch note: a launch whose target merge conflicts still aborts it (the session starts from a clean tree), and its note and the engine.target_conflict event give `npm run engine -- merge <ID>` with a sentence that small conflicts in project files usually want both sides kept, and no longer `git -C ... merge` (fails before this fix: they said "run git -C <dir> merge port/main", which a launched session may not run)', () => [
      conflictEv.length >= 1 && new RegExp(`npm run engine -- merge ${id}`).test(conflictEv[0].msg) && /both sides kept/.test(conflictEv[0].msg) && !/git -C \S+ merge/.test(conflictEv[0].msg)
        && new RegExp(`npm run engine -- merge ${id}`).test(sy.note || '') && /both sides kept/.test(sy.note || '') && !/git -C \S+ merge/.test(sy.note || '') && sy.conflicts?.includes('Game.csproj')
        && g(L, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status !== 0 && g(L, 'status', '--porcelain').stdout.trim() === '',
      detail()]);
    await guard('2.84 (m) the same conflict again: the first launch starts its session; the second launch, meeting the same conflicted files with no new commit in the worktree, starts no session and parks the task once with the files named; a third launch starts none either and does not park it again (fails before this fix: every launch started a session that handed back "the merge needs a person")', () => [
      starts('bld-a') === 1 && starts('bld-b') === 0 && starts('bld-c') === 0 && parks.length === 1 && /Game\.csproj/.test(parks[0].msg) && /no new commit/.test(parks[0].msg) && /Not started/.test(out(r2)),
      detail()]);
  }

  // ---- 2. phantom: a file only a filter rule makes look changed ----
  {
    const upper = path.join(T, 'upper-filter.mjs');
    fs.writeFileSync(upper, "let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => process.stdout.write(s.toUpperCase()));\n");
    const { S, R, env } = studio('phantom', { shared: { '.gitattributes': '*.dat filter=x\n', 'Icons/Logo.dat': 'logo bytes\n', 'Real.txt': 'real\n' } });
    const id = addTask(S, env, 'Port the icons');
    const la = launchLane(S, env, id);
    const L = la.dir;
    // The filter is defined only now: the committed blob is the raw bytes, and git now cleans the file before comparing.
    g(R, 'config', 'filter.x.clean', `node "${fwd(upper)}"`);
    const later = new Date(Date.now() + 10000);
    fs.utimesSync(path.join(L, 'Icons', 'Logo.dat'), later, later);
    const shows = g(L, 'status', '--porcelain').stdout;
    const look = () => probe(S, env, `const et = await import(${u(S, 'harness/engine-tracks.mjs')});
const dc = await import(${u(S, 'harness/done-check.mjs')});
const wt = await import(${u(S, 'harness/worktree.mjs')});
const id = ${JSON.stringify(id)};
const w = et.engineWork(id, {});
const row = (dc.engineWorkChecks({ id })?.rows || []).find((r) => /is committed/.test(r.label)) || null;
const lane = wt.laneDirty(${JSON.stringify(L)});
console.log(JSON.stringify({ work: w && { dirty: w.dirty, phantom: w.phantom }, row, lane: { dirty: lane.dirty, phantom: lane.phantom } }));`);
    const p1 = look();
    const dc1 = spawnSync(process.execPath, ['harness/done-check.mjs', id], { windowsHide: true, cwd: S, encoding: 'utf8', env });
    write(L, 'Real.txt', 'really edited\n');
    write(L, 'new.txt', 'untracked\n');
    const p2 = look();
    await guard('2.84 (m) phantom files: a tracked file that a .gitattributes filter makes git report as modified, though its bytes are the committed blob, is not counted by task done\'s check (its "is committed" row passes and says it ignored 1 file), by engineWork or by the lane check, which each name it as ignored (fails before this fix: "1 uncommitted file(s) ... commit them first" for a file nobody touched)', () => [
      / M Icons\/Logo\.dat/.test(shows) && p1.row?.ok === true && /ignored 1 file\(s\) git reports as modified whose content equals the committed version \(a filter or line-ending rule\): Icons\/Logo\.dat/.test(p1.row.label)
        && p1.work?.dirty.length === 0 && p1.work.phantom.join() === 'Icons/Logo.dat' && p1.lane?.dirty.length === 0 && p1.lane.phantom.join() === 'Icons/Logo.dat'
        && /\[x\] Everything on .* is committed \(ignored 1 file\(s\)/.test(out(dc1)),
      JSON.stringify({ shows, p1, dc1: out(dc1).slice(-800) }).slice(0, 2500)]);
    await guard('2.84 (m) phantom files, real work still counts: next to the ignored file, a really edited tracked file and an untracked file are still uncommitted work in task done\'s check, engineWork and the lane check, and the ignored file is still not among them', () => [
      p2.row?.ok === false && /Real\.txt/.test(p2.row.why) && /new\.txt/.test(p2.row.why) && !/Logo\.dat/.test(p2.row.why)
        && p2.work?.dirty.slice().sort().join() === 'Real.txt,new.txt' && p2.lane?.dirty.map((l) => l.slice(3)).sort().join() === 'Real.txt,new.txt' && p2.lane.phantom.join() === 'Icons/Logo.dat',
      JSON.stringify({ p2 }).slice(0, 2000)]);
  }

  // ---- 3. ignore: paths that cannot affect the rules tests ----
  {
    const focus = { test: 'node -e "0" -- "{filter}"', map: [{ match: '^Assets/Sim/([A-Za-z]+)/', filter: 'Category=$1' }], join: '|', fullEveryHours: 24 };
    const { S, env } = studio('ignore', { rules: { test: 'node -e "0"', focus: { ...focus, ignore: ['^Assets/Tests/PlayMode/', '^Assets/UI/', '(['] } }, land: 'node -e "process.exit(0)" {branch}' });
    const r = probe(S, env, `const er = await import(${u(S, 'harness/engine-rules.mjs')});
const cfg = er.rulesConfig('unity', { root: process.cwd() });
const noIg = { ...cfg, focus: { ...cfg.focus, ignore: [] } };
const smoke = { ...cfg, focus: { ...cfg.focus, smoke: 'Category=Smoke' } };
const mixed = ['Assets/Sim/Fees/Rules.cs', 'Assets/Tests/PlayMode/PanelTests.cs', 'Assets/UI/Panel.cs'];
const only = ['Assets/Tests/PlayMode/PanelTests.cs', 'Assets/UI/Panel.cs'];
const pick = (s) => ({ mode: s.mode, filter: s.filter, unchanged: s.unchanged || false, ignored: s.ignored || [], bad: s.ignoreBad || [], why: s.why });
const play = er.playSelection({ changed: mixed, cfg: { play: { focus: { map: [{ match: '^Assets/Sim/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], ignore: ['^Assets/UI/', '^Assets/Tests/PlayMode/', '(['] } } } });
console.log(JSON.stringify({ ignore: cfg.focus.ignore, withIgnore: pick(er.rulesSelection({ changed: mixed, cfg })), without: pick(er.rulesSelection({ changed: mixed, cfg: noIg })), onlyNoSmoke: pick(er.rulesSelection({ changed: only, cfg })), onlySmoke: pick(er.rulesSelection({ changed: only, cfg: smoke })), play: pick(play) }));`);
    const show = spawnSync(process.execPath, ['harness/engine.mjs', 'rules', 'show'], { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 120000 });
    await guard('2.84 (m) rules.focus.ignore: a batch that changes a mapped rules file plus a Play Mode test and a UI file runs in focus with the mapped filter alone (the two ignored paths named); without the ignore entries the same batch falls back to the full command (fails before this fix: any path no map entry matches forced the full rules run, 28.5 minutes for a crew\'s first batch)', () => [
      r.withIgnore?.mode === 'focus' && r.withIgnore.filter === 'Category=Fees' && r.withIgnore.ignored.length === 2 && r.without?.mode === 'full' && /matches no rules\.focus\.map entry/.test(r.without.why),
      JSON.stringify(r).slice(0, 2500)]);
    await guard('2.84 (m) rules.focus.ignore, nothing else changed: when only ignored paths changed, the rules selection is the smoke filter alone in focus mode, or with no smoke the "unchanged" answer used when nothing under rules.paths changed (the target\'s kept result); play.focus.ignore leaves the same paths out of the Play Mode focus', () => [
      r.onlyNoSmoke?.mode === 'full' && r.onlyNoSmoke.unchanged === true && r.onlySmoke?.mode === 'focus' && r.onlySmoke.filter === 'Category=Smoke' && r.play?.mode === 'focus' && r.play.filter === 'Game.PlayTests.Fees',
      JSON.stringify(r).slice(0, 2500)]);
    await guard('2.84 (m) rules.focus.ignore, a bad pattern: an ignore entry that is not a valid regex is skipped (the others still apply, the selection names it) and `engine -- rules show` lists the ignore patterns, marking the bad one, without a crash', () => [
      r.ignore?.length === 3 && r.withIgnore?.bad?.join() === '([' && r.play?.bad?.join() === '([' && show.status === 0 && /ignore: \^Assets\/Tests\/PlayMode\/, \^Assets\/UI\/, \(\[ \(not a valid regex: skipped\)/.test(out(show)),
      JSON.stringify({ r, show: out(show).slice(-800) }).slice(0, 2500)]);
  }
}
