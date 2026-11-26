/**
 * qa/selftest-296c.mjs — 2.96 (c): the engine train's queue. A lane that waits for another task (task after) is left out
 * before the batch is picked (no class, no seat, one event, listed once in train status) and rides once the hold clears; a
 * head that cannot go does not decide the class or shrink the batch; a hold set after the train started takes the lane out
 * before the land run; engines.<x>.merge.union merges list files both sides only grew, and nothing else.
 * Scaffolding as qa/selftest-294a.mjs (a studio copy, made-up engine repos, a stand-in for the land script).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest296C({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s296c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `296c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296c.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-296c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };
  // The holds (task after) and the board the train reads (deps.board): T-9 is the task the held lanes wait for.
  const boardFile = path.join(S, '.studio', 'board-296c.json');
  const setHolds = (tasks) => write(S, 'studio/task-holds.json', `${JSON.stringify({ tasks }, null, 2)}\n`);
  const setDone = (ids) => fs.writeFileSync(boardFile, JSON.stringify({ inProgress: [], backlog: [], done: ids.map((id) => ({ id })) }));

  let rn = 0;
  const engineRepo = (files0, lanes, after = null) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(files0)) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    // The target moves on after the lanes left it (in the gate worktree, where port/main is checked out).
    if (after) { for (const [f, t] of Object.entries(after)) write(GW, f, t); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target moves'); }
    return { R, GW, heads };
  };
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const qTasks = () => (readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || []).map((e) => e.task);
  // deps.markRunning runs right before the land loop: with <ctl>-hold it sets a hold (the owner, after the train started).
  const TRAIN = (ctl = '') => `import fs from 'node:fs'; import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const hold = ${JSON.stringify(ctl ? `${ctl}-hold` : '')};
const deps = { board: () => JSON.parse(fs.readFileSync(${JSON.stringify(boardFile)}, 'utf8')), handBack: (lane) => handed.push(lane.task),
  markRunning: () => { if (hold && fs.existsSync(hold)) { fs.writeFileSync(${JSON.stringify(path.join(S, 'studio', 'task-holds.json'))}, fs.readFileSync(hold, 'utf8')); fs.rmSync(hold); } } };
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, held: r.held || null, union: r.union || null, handed, message: r.message, batch: r.batch, logs: logs.filter((l) => /held|union|batch|picked again/.test(l)) }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const startCls = () => evs(/^task\.train\.unity\.start$/).map((e) => e.meta?.cls || null);
  const PLAY = { focus: { map: [{ match: '^Game/Sim/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', join: ';' } };
  const files0 = { 'Game/Sim/Fees/Fees.cs': 'class Fees { }\n', 'Game/Sim/registry.txt': 'list:\n  a\nend\n', 'notes.txt': 'n\n', 'Art/logo.txt': 'logo\n' };

  try {
    // ================= (c1) a held head =================
    {
      resetState();
      setDone([]);
      setHolds({ 'T-11': { after: ['T-9'] } });
      const E = engineRepo(files0, { 'art/x': { 'Art/logo.txt': 'logo2\n' }, 'port/a': { 'Game/Sim/Fees/A.cs': 'a\n' }, 'port/b': { 'Game/Sim/MapNav/B.cs': 'b\n' }, 'port/c': { 'Game/Sim/Fees/C.cs': 'c\n' } });
      const ctl = path.join(T, 'ctl-held');
      setEngines({ unity: cfgFor(E, ctl, { play: PLAY, batchGroup: 'play', batchMax: 2 }) });
      queue(E, [['T-11', 'art/x'], ['T-12', 'port/a'], ['T-13', 'port/b'], ['T-14', 'port/c']]);
      const r1 = probe(TRAIN());
      const q1 = qTasks();
      const r2 = probe(TRAIN());
      const heldEv = evs(/^task\.train\.unity\.held$/);
      const st = spawnSync(process.execPath, ['harness/task.mjs', 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
      const said = out(st).split('\n').filter((l) => /^\s*T-11\b/.test(l));
      await guard('2.96 (c1) a queued lane that waits for another task (task after) is left out before the pick: it sets no class and takes no seat, the other class rides on a full batch (T-12, T-13 of class focus, cap 2); the held lane stays queued, is not deferred and not handed back (fails before this fix: the held head was picked first, set the class to full, took a seat and was deferred, and nothing landed)', () => [
        r1.landed?.join() === 'T-12,T-13' && !r1.deferred?.length && !r1.handed?.length && startCls()[0] === 'focus' && q1.join() === 'T-11,T-14' && r1.held?.[0]?.task === 'T-11', J({ r1, q1, cls: startCls() })]);
      await guard('2.96 (c2) the held lane makes one event the first time it is left out, not one per train, and train status lists it once as "T-11 held: waits for T-9 (task after)" (fails before this fix: a deferred event every train, and status listed it as a lane waiting for the next train)', () => [
        r2.landed?.join() === 'T-14' && heldEv.length === 1 && heldEv[0].task === 'T-11' && said.length === 1 && /^T-11 held: waits for T-9 \(task after\)/.test(said[0]), J({ r2, n: heldEv.length, said, st: out(st).slice(-800) })]);
      setDone(['T-9']);
      const r3 = probe(TRAIN());
      await guard('2.96 (c3) once the task it waits for is done, the next train takes the lane and it lands (fails before this fix: the same, but only after trains it blocked)', () => [
        r3.landed?.join() === 'T-11' && !qTasks().length && !r3.held, J({ r3 })]);
    }

    // ================= (c4) a head that cannot go =================
    {
      resetState();
      setDone([]);
      setHolds({});
      const E = engineRepo(files0, { 'art/x': { 'Art/logo.txt': 'logo-lane\n' }, 'port/a': { 'Game/Sim/Fees/A.cs': 'a\n' }, 'port/b': { 'Game/Sim/MapNav/B.cs': 'b\n' } }, { 'Art/logo.txt': 'logo-target\n' });
      const ctl = path.join(T, 'ctl-conflict');
      setEngines({ unity: cfgFor(E, ctl, { play: PLAY, batchGroup: 'play', batchMax: 2 }) });
      queue(E, [['T-21', 'art/x'], ['T-22', 'port/a'], ['T-23', 'port/b']]);
      const r1 = probe(TRAIN());
      await guard('2.96 (c4) a head that conflicts with the target is handed back and does not decide the class: the batch is picked again without it and T-22, T-23 (class focus, cap 2) land on the same train (fails before this fix: the head set class full, rode alone and was handed back; nothing landed)', () => [
        r1.handed?.join() === 'T-21' && r1.landed?.join() === 'T-22,T-23' && startCls()[0] === 'focus' && /picked again without T-21/.test(r1.batch || ''), J({ r1, cls: startCls() })]);
    }
    {
      resetState();
      const E = engineRepo(files0, { 'port/a': { 'Game/Sim/Fees/A.cs': 'a\n' }, 'port/b': { 'Game/Sim/MapNav/B.cs': 'b\n' }, 'port/c': { 'Game/Sim/Fees/C.cs': 'c\n' } });
      const ctl = path.join(T, 'ctl-clash');
      setEngines({ unity: cfgFor(E, ctl, { batchMax: 2 }) });
      queue(E, [['T-31', 'port/a'], ['T-32', 'port/b'], ['T-33', 'port/c']]);
      const qf = path.join(S, '.studio', 'train', 'unity-queue.json');
      fs.writeFileSync(qf, JSON.stringify(readJson(qf).map((e) => (e.task === 'T-31' ? { ...e, clash: { with: ['T-32'] } } : e))));
      const r1 = probe(TRAIN());
      await guard('2.96 (c5) a head deferred in this train (it does not compile with T-32, found at the queue door) does not shrink the batch: it waits, and T-32 and T-33 fill the two seats (fails before this fix: the batch was T-31, T-32 and only T-32 landed)', () => [
        r1.deferred?.map((d) => d.task).join() === 'T-31' && r1.landed?.join() === 'T-32,T-33' && qTasks().join() === 'T-31', J({ r1 })]);
    }

    // ================= (c6) a hold set after the train started =================
    {
      resetState();
      setDone([]);
      setHolds({});
      const E = engineRepo(files0, { 'port/a': { 'Game/Sim/Fees/A.cs': 'a\n' }, 'port/b': { 'Game/Sim/MapNav/B.cs': 'b\n' } });
      const ctl = path.join(T, 'ctl-late');
      setEngines({ unity: cfgFor(E, ctl) });
      queue(E, [['T-41', 'port/a'], ['T-42', 'port/b']]);
      fs.writeFileSync(`${ctl}-hold`, JSON.stringify({ tasks: { 'T-41': { after: ['T-9'] } } }));
      const r1 = probe(TRAIN(ctl));
      const runs = runsOf(ctl);
      await guard('2.96 (c6) a hold set after the train started takes the lane out before its land run: the one land run lands T-42 alone, T-41 stays queued, is not handed back and not blamed, and one held event says so (fails before this fix: the hold was not looked at again and T-41 landed)', () => [
        r1.landed?.join() === 'T-42' && !r1.handed?.length && !r1.dropped?.length && qTasks().join() === 'T-41' && runs.length === 1 && runs[0].srcs.join() === 'port/b'
          && r1.held?.some((h) => h.task === 'T-41' && h.at === 'land') && evs(/^task\.train\.unity\.held$/).length === 1, J({ r1, runs })]);
    }

    // ================= (c7-c10) list files that only grow =================
    const unionLanes = {
      'u/b': { 'Game/Sim/registry.txt': 'list:\n  a\n  b\nend\n' }, 'u/c': { 'Game/Sim/registry.txt': 'list:\n  a\n  c\nend\n' }, 'u/b2': { 'Game/Sim/registry.txt': 'list:\n  a\n  b\nend\n', 'Game/Sim/B2.cs': 'b2\n' },
      'u/rm': { 'Game/Sim/registry.txt': 'list:\n  a2\n  e\nend\n' }, 'u/n1': { 'notes.txt': 'n\nn1\n' }, 'u/n2': { 'notes.txt': 'n\nn2\n' }, 'u/d': { 'Game/Sim/registry.txt': 'list:\n  a\n  d\nend\n' },
    };
    {
      resetState();
      const E = engineRepo(files0, unionLanes);
      const ctl = path.join(T, 'ctl-union');
      setEngines({ unity: cfgFor(E, ctl, { merge: { union: ['Game/Sim/registry.txt'] } }) });
      queue(E, [['T-51', 'u/b'], ['T-52', 'u/c'], ['T-53', 'u/b2'], ['T-54', 'u/rm'], ['T-55', 'u/n1'], ['T-56', 'u/n2']]);
      const r1 = probe(TRAIN());
      const reg = g(E.R, 'show', 'port/main:Game/Sim/registry.txt').stdout;
      const uev = evs(/^task\.train\.unity\.union$/);
      await guard('2.96 (c7) merge.union: two lanes that add different lines to a listed file both ride and the landed file holds both, the target\'s lines first, then the lanes in batch order; one union event and the summary name the file (fails before this fix: the second lane was deferred to the next train)', () => [
        ['T-51', 'T-52', 'T-53', 'T-55'].every((t) => r1.landed?.includes(t)) && /^list:\n {2}a\n {2}b\n {2}c\nend\n$/.test(reg) && uev.length === 1 && /Game\/Sim\/registry\.txt/.test(uev[0].msg) && /merged as a union: Game\/Sim\/registry\.txt/.test(r1.message || ''), J({ r1, reg, uev: uev.map((e) => e.msg) })]);
      await guard('2.96 (c8) a third lane that adds the same line appears once: T-53 adds "b" as T-51 did and rides with T-51 and T-52; the file has one "b" next to "c" (fails before this fix: T-52 waited, so no union with a shared line was ever made)', () => [
        r1.landed?.includes('T-53') && r1.landed?.includes('T-52') && reg.split('\n').filter((l) => l === '  b').length === 1 && reg.includes('  c\n'), J({ reg })]);
      await guard('2.96 (c9) a lane that changes or removes a line of the listed file still conflicts (T-54 waits for the next train), and two lanes adding to a file not listed still conflict (T-56 waits) (fails if the union were applied to anything but pure additions to listed files)', () => [
        r1.deferred?.map((d) => d.task).sort().join() === 'T-54,T-56', J({ r1 })]);
      queue(E, [['T-57', 'u/d']]);
      const r2 = probe(TRAIN());
      const reg2 = g(E.R, 'show', 'port/main:Game/Sim/registry.txt').stdout;
      await guard('2.96 (c10) a lane against the target: T-57 adds "d" where the target added b and c since it branched; it is merged as a union with the target and lands through the integration branch: the file holds a, b, c, d (fails before this fix: it conflicted with the target and was handed back)', () => [
        r2.landed?.join() === 'T-57' && !r2.handed?.length && /^list:\n {2}a\n {2}b\n {2}c\n {2}d\nend\n$/.test(reg2) && r2.union?.[0]?.with === 'the target', J({ r2, reg2 })]);
    }
    {
      resetState();
      const E = engineRepo(files0, unionLanes);
      const ctl = path.join(T, 'ctl-nounion');
      setEngines({ unity: cfgFor(E, ctl) });
      queue(E, [['T-61', 'u/b'], ['T-62', 'u/c']]);
      const r1 = probe(TRAIN());
      await guard('2.96 (c11) no merge.union setting: every merge is 2.95\'s: T-62 conflicts with T-61 in the same file and waits for the next train; no union event (fails before this fix: never; it guards that the default stays as in 2.95)', () => [
        r1.landed?.join() === 'T-61' && r1.deferred?.map((d) => d.task).join() === 'T-62' && !evs(/^task\.train\.unity\.union$/).length && !r1.union, J({ r1 })]);
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
