/**
 * qa/selftest-283a.mjs — 2.83: an engine task's session is accounted where its work is.
 *
 * A crew ran 26 hours as a native-engine studio. 89 of its 227 sessions were recorded as "committed nothing" although
 * their work was committed in the engine repository; 25 tasks were parked for "2 sessions with no work"; the crew
 * breaker stopped launching builders for "0 landed" while their lanes waited in the engine train. These checks hold
 * the fixes:
 *   record    the branch a launch gives a task is the task's branch for task done (no --branch needed)
 *   work      engineWork reads commits and leftovers in the task's engine worktree
 *   session   a real launched session that commits in its engine worktree is not "no work", and its hand-back says
 *             what is in that worktree; one whose branch waits in the engine train is left to the train
 *   breaker   sessions that queued their lane for a train do not trip the crew breaker
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest283A({ dir, root, report, tmpRoot }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HEAVY_SLOTS: '0',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_LANELESS: 'shared', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_HEARTBEAT_SEC: '1',
    STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_STALL: 'off', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_OVERLAP: 'off', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-283a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };
  const T = path.join(tmpRoot, `s283a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  let n = 0;
  // A studio copy with its own git and events file, and a made-up engine repo beside it (target port/main).
  const studio = (name) => {
    const S = path.join(tmpRoot, `283a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
    const R = path.join(T, `repo-${n}`);
    const GW = path.join(T, `gate-${n}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main'); write(R, 'base.txt', 'base\n'); write(R, '.gitignore', 'Ignored~/\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev'); g(R, 'worktree', 'add', '-q', GW, 'port/main');
    write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: 'node -e "process.exit(0)"', target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5 } } }, null, 2)}\n`);
    const ev = path.join(S, '.studio', 'events-283a.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
    return { S, R, GW, ev, env };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(S, `.probe-283a-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env, encoding: 'utf8', timeout: 180000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const addTask = (S, env, title) => (out(spawnSync(process.execPath, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1', '--track', 'engine:unity', '--size', '2'], { windowsHide: true, cwd: S, encoding: 'utf8', env })).match(/\b(T-\d+)\b/) || [])[1];

  // ---- record + work: the launch's branch is the task's branch; engineWork reads the worktree ----
  {
    const { S, env, ev } = studio('record');
    const id = addTask(S, env, 'Port the fees rules');
    const r = probe(S, env, `const et = await import(${u(S, 'harness/engine-tracks.mjs')});
import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const id = ${JSON.stringify(id || 'T-000')};
const before = et.engineTask(id);
const la = et.engineLaunch({ task: id, agent: 'bld-1', role: 'builder' });
const after = et.engineTask(id);
const dc = await import(${u(S, 'harness/done-check.mjs')});
const rows = dc.engineWorkChecks({ id })?.rows || [];
const w0 = et.engineWork(id, { since: new Date(Date.now() - 60000).toISOString() });
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: la.dir, encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(la.dir, 'Fees.txt'), 'fees\\n'); git('add', '-A'); git('commit', '-qm', id + ' fees');
fs.writeFileSync(path.join(la.dir, 'left.txt'), 'x\\n'); fs.mkdirSync(path.join(la.dir, 'Ignored~'), { recursive: true }); fs.writeFileSync(path.join(la.dir, 'Ignored~', 'big.bin'), 'x');
const w1 = et.engineWork(id, { since: new Date(Date.now() - 60000).toISOString() });
console.log(JSON.stringify({ id, before: before && { engine: before.engine, branch: before.branch }, la: { branch: la.branch, error: la.error || null, dir: la.dir && la.dir.split(path.sep).join('/') }, after: after && { engine: after.engine, branch: after.branch }, noBranchRow: rows.filter((x) => /branch recorded|branch for this pass/.test(x.label + ' ' + (x.why || ''))).map((x) => x.why), w0: w0 && { commits: w0.commits, dirty: w0.dirty }, w1: w1 && { commits: w1.commits, dirty: w1.dirty, branch: w1.branch } }));`);
    await guard('2.83 engine record: a task added on an engine track gets its branch at launch, and that branch is the task\'s branch from then on: the engine record holds engine, track and branch, and task done\'s check has no "no branch recorded" row (fails before this fix: the launch saved a record holding only the branch, which the reader ignored, so a builder had to pass --train --branch by hand)', () => [
      /^T-\d+$/.test(r.id || '') && r.before?.engine === 'unity' && !r.before.branch && r.la?.branch === `unity/${String(r.id).toLowerCase()}` && !r.la.error && r.after?.branch === r.la.branch && r.after.engine === 'unity' && Array.isArray(r.noBranchRow) && r.noBranchRow.length === 0,
      JSON.stringify(r).slice(0, 2500)]);
    await guard('2.83 engine work: engineWork reads the task\'s engine worktree: no commit and nothing left before any work; after one commit and one stray file it says 1 commit and names the stray file, and a git-ignored file is not a leftover', () => [
      r.w0?.commits === 0 && r.w0.dirty.length === 0 && r.w1?.commits === 1 && r.w1.dirty.length === 1 && r.w1.dirty[0] === 'left.txt' && r.w1.branch === r.la?.branch,
      JSON.stringify({ w0: r.w0, w1: r.w1, _: r._raw || '' }).slice(0, 1500)]);
    void ev;
  }

  // ---- session: a launched session that works in its engine worktree ----
  // The stand-in agent claims its task, commits in the task's engine worktree and, by mode, leaves a stray file there
  // or puts its branch in the engine train's queue (what task done --train does), then exits.
  const agentJs = path.join(T, 'stand-in-agent.mjs');
  fs.writeFileSync(agentJs, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const [task, mode] = process.argv.slice(2);
const S = process.env.STUDIO_MAIN_ROOT;
const me = process.env.STUDIO_LOCK_OWNER;
const st = spawnSync(process.execPath, ['harness/task.mjs', 'start', task, '--agent', me], { cwd: S, encoding: 'utf8', windowsHide: true, env: process.env });
console.log('[stand-in] start: ' + String(st.stdout || '').trim().split('\\n').pop() + String(st.stderr || '').trim().slice(-300));
const lane = path.join(S, '.lanes', 'engine', task);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: lane, encoding: 'utf8', windowsHide: true });
if (mode !== 'idle') { fs.writeFileSync(path.join(lane, 'Fees.txt'), 'fees ' + mode + '\\n'); git('add', '-A'); console.log('[stand-in] commit: ' + git('commit', '-qm', task + ' fees').status); }
if (mode === 'stray') fs.writeFileSync(path.join(lane, 'left.txt'), 'x\\n');
if (mode === 'queue') {
  const head = git('rev-parse', 'HEAD').stdout.trim(); const branch = git('symbolic-ref', '--short', 'HEAD').stdout.trim();
  fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
  fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task, agent: me, branch, head, at: new Date().toISOString() }]));
}
`);
  const launch = (S, env, agent, id, mode) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', agent, '--model', 'fake-1', '--task', id, '--one-task'], { windowsHide: true, cwd: S, encoding: 'utf8', timeout: 240000, env: { ...env, STUDIO_BUILDER_CMD: `node "${fwd(agentJs)}" ${id} ${mode}` } });
  {
    const { S, env, ev } = studio('session');
    const idA = addTask(S, env, 'Port the fees rules');
    const idB = addTask(S, env, 'Port the loans rules');
    const idC = addTask(S, env, 'Port the fuel rules');
    const rA = launch(S, env, 'bld-a', idA, 'stray');
    const rB = launch(S, env, 'bld-b', idB, 'queue');
    const rC1 = launch(S, env, 'bld-c', idC, 'idle');
    const rC2 = launch(S, env, 'bld-d', idC, 'idle');
    const all = events(ev);
    const end = (a) => all.filter((e) => e.type === 'agent.session.end' && e.agent === a).pop();
    const paused = (id) => all.filter((e) => e.type === 'task.paused' && e.task === id);
    const parked = (id) => all.filter((e) => e.type === 'task.hold' && e.task === id && /Parked/.test(e.msg || ''));
    const eA = end('bld-a'); const eB = end('bld-b'); const eC = end('bld-d');
    const detail = () => JSON.stringify({ idA, idB, idC, A: { msg: eA?.msg, outcome: eA?.meta?.outcome, paused: paused(idA).map((e) => e.msg) }, B: { msg: eB?.msg, outcome: eB?.meta?.outcome, paused: paused(idB).map((e) => e.msg), parked: parked(idB).length }, C: { msg: eC?.msg, outcome: eC?.meta?.outcome, parked: parked(idC).map((e) => e.msg) }, tailA: out(rA).slice(-700), tailB: out(rB).slice(-400), tailC: `${out(rC1).slice(-300)} | ${out(rC2).slice(-300)}` }).slice(0, 3400);
    await guard('2.83 engine session, committed work: a launched builder that claims its task and commits in the task\'s engine worktree is not "no work": its end records the commit (outcome.commits 1, engineCommits 1, noWork false), the task is not parked, and its hand-back says what is in that worktree: 1 commit this session and the stray file it left (fails before this fix: "it claimed T-n but committed nothing", and "No uncommitted work" with a file sitting in the engine worktree)', () => [
      Boolean(eA) && eA.meta?.outcome?.commits >= 1 && eA.meta.outcome.engineCommits === 1 && eA.meta.outcome.noWork === false && eA.meta.outcome.engineDirty === 1 && !/committed nothing/.test(eA.msg || '')
        && paused(idA).length === 1 && /unity worktree .*\.lanes\/engine\//.test(paused(idA)[0].msg) && /1 commit\(s\) this session, 1 uncommitted file\(s\) left there \(left\.txt\)/.test(paused(idA)[0].msg) && parked(idA).length === 0,
      detail()]);
    await guard('2.83 engine session, queued for the engine train: a session whose task\'s branch waits in the engine train\'s queue when it ends is left to that train: no hand-back, no park, and its end says done by queueing (outcome.queuedForTrain) (fails before this fix: "ended without task done or a hand-back", the task handed back and, after two such ends, parked while its lane waited in the train)', () => [
      Boolean(eB) && eB.meta?.outcome?.queuedForTrain === true && eB.meta.outcome.noWork === false && paused(idB).length === 0 && parked(idB).length === 0 && !/handed back/.test(eB.msg || ''),
      detail()]);
    await guard('2.83 engine session, no work: the no-work rule still holds for an engine task: two sessions in a row that claim it and commit nothing anywhere park it with the reason', () => [
      Boolean(eC) && eC.meta?.outcome?.noWork === true && parked(idC).length === 1 && /2 sessions in a row ended with no work/.test(parked(idC)[0].msg),
      detail()]);
  }

  // ---- breaker: queued lanes are progress ----
  {
    const { S, env } = studio('breaker');
    const r = probe(S, env, `const cw = await import(${u(S, 'harness/crew-watch.mjs')});
const now = Date.parse('2026-11-11T05:00:00Z');
const mk = (queued) => { const evs = []; for (let i = 0; i < 8; i += 1) { const a = 'builder-s' + i; const t0 = now - (50 - i * 5) * 60000;
  evs.push({ ts: new Date(t0).toISOString(), type: 'agent.session.start', agent: a, task: 'T-' + (500 + i), meta: { role: 'builder' } });
  evs.push({ ts: new Date(t0 + 240000).toISOString(), type: 'agent.session.end', agent: a, task: 'T-' + (500 + i), tokensIn: 1000, tokensOut: 100, meta: { role: 'builder', outcome: queued && i < 3 ? { task: 'T-' + (500 + i), done: true, commits: 1, noWork: false, stuck: false, counts: true, queuedForTrain: true } : { task: 'T-' + (500 + i), done: false, commits: 1, noWork: false, stuck: false, counts: true, why: 'it made 1 commit(s) but did not call task done' } } }); }
  return evs; };
const h = (evs) => { const r = cw.crewHealth(evs, { now, env: { STUDIO_CREW_MAX_SESSIONS: '6' } }).builder; return { sessions: r.sessions, landed: r.landed, queued: r.queued, unhealthy: r.unhealthy }; };
console.log(JSON.stringify({ withQueued: h(mk(true)), without: h(mk(false)) }));`);
    await guard('2.83 crew breaker: eight builder sessions in the hour with nothing landed yet do not trip the breaker when three of them ended by queueing their lane for a train (the landing comes when the train runs); with none queued the breaker still trips (fails before this fix: productive engine builders were stopped for "0 landed" while their lanes waited in a train that takes most of an hour)', () => [
      r.withQueued?.sessions === 8 && r.withQueued.queued === 3 && r.withQueued.unhealthy === false && r.without?.unhealthy === true && r.without.queued === 0,
      JSON.stringify(r).slice(0, 1500)]);
  }
}
