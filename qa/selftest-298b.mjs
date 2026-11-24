/**
 * qa/selftest-298b.mjs — 2.98 (b): the engine train's queue. The train reads engines.<x> again before each step (a change
 * between the rules check and the land run is used and logged); a lane whose tree adds nothing is handed back as an empty
 * lane and refused at the queue door; a full head waits for a skip batch (engines.<x>.batchSkipFirst, at most twice);
 * with no untagged lane the automatic start takes the oldest tag group (engines.<x>.tagsWhenIdle).
 * Scaffolding as qa/selftest-296c.mjs (a studio copy, made-up engine repos, a stand-in for the land script).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest298B({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298b-${process.pid}`);
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
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `298b-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const gameJson = path.join(S, 'studio', 'game.json');
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298b.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-298b-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  let rn = 0;
  // A made-up engine repo: port/main checked out in a gate worktree; each lane a branch with its own files. `after`: the
  // target moves on once the lanes left it. `mergeOnly`: branches that only merge the target in (no change of their own).
  const engineRepo = (files0, lanes, { after = null, mergeOnly = [] } = {}) => {
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
    for (const br of mergeOnly) g(R, 'branch', br, 'port/main');
    if (after) { for (const [f, t] of Object.entries(after)) write(GW, f, t); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target moves'); }
    for (const br of mergeOnly) { g(R, 'checkout', '-q', br); g(R, 'merge', '-q', '--no-ff', '-m', `merge port/main into ${br}`, 'port/main'); heads[br] = g(R, 'rev-parse', br).stdout.trim(); g(R, 'checkout', '-q', 'dev'); }
    return { R, GW, heads };
  };
  // The land script's stand-in: a compile-only run (STUDIO_LAND_ONLY=compile) is recorded and lands nothing.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, only: process.env.STUDIO_LAND_ONLY || '' }) + '\\n');
if (process.env.STUDIO_LAND_ONLY === 'compile') { console.log('compiled'); process.exit(0); }
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const qFile = path.join(S, '.studio', 'train', 'unity-queue.json');
  const qTasks = () => (readJson(qFile) || []).map((e) => e.task);
  // swap: a game.json the rules check's stand-in writes while it runs (the overseer changing a setting mid-train).
  const TRAIN = ({ swap = null } = {}) => `import fs from 'node:fs'; import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const closed = []; const logs = [];
const swap = ${JSON.stringify(swap)};
const deps = { handBack: (lane) => handed.push(lane.task), close: (lane) => { closed.push(lane.task); return { ok: true }; },
  ...(swap ? { rulesGate: ({ lanes }) => { fs.writeFileSync(${JSON.stringify(gameJson)}, swap); return { why: 'checked (stand-in)', ran: true, runs: 1, ms: 1, dropped: [], kept: lanes }; } } : {}) };
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, handed, closed, message: r.message, batch: r.batch, logs: logs.filter((l) => /config changed|empty lane|batch/.test(l)) }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const startCls = () => evs(/^task\.train\.unity\.start$/).map((e) => e.meta?.cls || null);

  try {
    // ================= (b1) a setting changed during the train =================
    {
      resetState();
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/a': { 'Game/Sim/Fees/A.cs': 'a\n' } });
      const ctl = path.join(T, 'ctl-fresh');
      const rules = { test: 'node -e 0' };
      setEngines({ unity: cfgFor(E, ctl, { rules }) });
      queue(E, [['T-61', 'port/a']]);
      const swap = `${JSON.stringify({ engines: { unity: cfgFor(E, ctl, { rules, compileFirst: true }) } }, null, 2)}\n`;
      const r1 = probe(TRAIN({ swap }));
      const runs = runsOf(ctl);
      const ch = evs(/^task\.train\.unity\.config_changed$/);
      await guard('2.98 (b1) engines.unity.compileFirst turned on while the rules check ran is used by the land run that follows (a compile-only run, then the land run) and said in one line "config changed while this train ran: compileFirst unset -> true" and one config_changed event (fails before this fix: the train kept the config it read at its start and ran no compile check)', () => [
        r1.landed?.join() === 'T-61' && runs.map((x) => x.only).join() === 'compile,' && r1.logs?.filter((l) => /config changed while this train ran: compileFirst unset -> true/.test(l)).length === 1 && ch.length === 1, J({ r1, runs, ch: ch.map((e) => e.msg) })]);
    }

    // ================= (b2, b3) a lane that changes nothing =================
    {
      resetState();
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/b': { 'Game/Sim/Fees/B.cs': 'b\n' } }, { after: { 'a.txt': 'a2\n' }, mergeOnly: ['port/m'] });
      const ctl = path.join(T, 'ctl-empty');
      setEngines({ unity: cfgFor(E, ctl) });
      queue(E, [['T-71', 'port/m'], ['T-72', 'port/b']]);
      const r1 = probe(TRAIN());
      const runs = runsOf(ctl);
      await guard('2.98 (b2) a lane whose branch holds only a merge of the target is handed back "empty lane: nothing to land (its tree adds nothing over port/main)", is not in the batch (the one land run lands port/b only) and its task is not closed; the other lane lands (fails before this fix: the empty lane was landed and its task closed)', () => [
        r1.landed?.join() === 'T-72' && r1.handed?.join() === 'T-71' && r1.closed?.join() === 'T-72' && /^empty lane: nothing to land \(its tree adds nothing over port\/main\)/.test(r1.dropped?.find((d) => d.task === 'T-71')?.why || '')
          && runs.length === 1 && runs[0].srcs.join() === 'port/b' && !qTasks().length, J({ r1, runs })]);
      const door = probe(`import { queueUnityTask, readUnityQueue } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: 'T-73', agent: 'b1', branch: 'port/m' });
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message, queued: readUnityQueue(process.cwd()).map((e) => e.task) }));`);
      await guard('2.98 (b3) the same branch is refused at the queue door with the same words and is not queued (fails before this fix: it was queued, its one merge commit counted as work)', () => [
        door.ok === false && door.error === 'empty' && /empty lane: nothing to land \(its tree adds nothing over port\/main\)/.test(door.message || '') && !door.queued?.length, J({ door })]);
    }

    // ================= (b4, b5) a full head and quick lanes =================
    const PLAY = { focus: { skip: ['^Game/Rules/'] } };
    const quick = Object.fromEntries([2, 3, 4, 5, 6].map((n) => [`port/r${n}`, { [`Game/Rules/R${n}.cs`]: `r${n}\n` }]));
    const lanes8 = [['T-81', 'art/x'], ...[2, 3, 4, 5, 6].map((n) => [`T-8${n}`, `port/r${n}`])];
    {
      resetState();
      const E = engineRepo({ 'Art/logo.txt': 'logo\n' }, { 'art/x': { 'Art/logo.txt': 'logo2\n' }, ...quick });
      const ctl = path.join(T, 'ctl-skip');
      setEngines({ unity: cfgFor(E, ctl, { play: PLAY, batchGroup: 'play', batchMax: 2, batchSkipFirst: 1 }) });
      queue(E, lanes8);
      const r1 = probe(TRAIN());
      const pass1 = (readJson(qFile) || []).find((e) => e.task === 'T-81')?.passedOver;
      const r2 = probe(TRAIN());
      const r3 = probe(TRAIN());
      await guard('2.98 (b4) head T-81 is class full and five skip lanes wait: the skip batch goes first and the batch line says so; the full head is passed over twice (the count on its queue entry), then it goes on the third train (fails before this fix: the full lane rode alone first)', () => [
        r1.landed?.join() === 'T-82,T-83' && /the head T-81 is class full and 5 skip lanes wait: the skip batch goes first/.test(r1.batch || '') && pass1 === 1
          && r2.landed?.join() === 'T-84,T-85' && r3.landed?.join() === 'T-81' && startCls().join() === 'skip,skip,full' && qTasks().join() === 'T-86', J({ r1, r2, r3, pass1, cls: startCls() })]);
    }
    {
      resetState();
      const E = engineRepo({ 'Art/logo.txt': 'logo\n' }, { 'art/x': { 'Art/logo.txt': 'logo2\n' }, ...quick });
      const ctl = path.join(T, 'ctl-noskip');
      setEngines({ unity: cfgFor(E, ctl, { play: PLAY, batchGroup: 'play', batchMax: 2, batchSkipFirst: 0 }) });
      queue(E, lanes8);
      const r1 = probe(TRAIN());
      await guard('2.98 (b5) batchSkipFirst 0 keeps the order as it was: the full head T-81 goes first, by itself (fails if the setting could not turn the rule off)', () => [
        r1.landed?.join() === 'T-81' && startCls().join() === 'full' && !/skip batch goes first/.test(r1.batch || ''), J({ r1, cls: startCls() })]);
    }

    // ================= (b6) tag groups when the queue is otherwise empty =================
    {
      resetState();
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/a': { 'A.cs': 'a\n' }, 'port/b': { 'B.cs': 'b\n' }, 'port/c': { 'C.cs': 'c\n' } });
      const ctl = path.join(T, 'ctl-tags');
      const t0 = Date.now() - 3600000;
      const tagged = [['T-91', 'port/a', 'art', 20], ['T-92', 'port/b', 'sound', 0], ['T-93', 'port/c', 'art', 10]];
      fs.mkdirSync(path.dirname(qFile), { recursive: true });
      fs.writeFileSync(qFile, JSON.stringify(tagged.map(([task, branch, tag, m]) => ({ task, agent: 'p', branch, head: E.heads[branch], tag, at: new Date(t0 + m * 60000).toISOString() }))));
      const PASS = `const lp = await import(${u('harness/line-producer.mjs')}); const started = [];
const rows = await lp.enginePass({ now: Date.now(), deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, drain: null, sessions: async () => [], startTrain: async (e, o) => { started.push({ e, tag: o?.tag || null }); return { pid: 1 }; } } });
console.log(JSON.stringify({ start: rows[0]?.start, started, why: rows[0]?.why, tag: rows[0]?.tag || null }));`;
      setEngines({ unity: cfgFor(E, ctl) });
      const on = probe(PASS);
      const st = spawnSync(process.execPath, ['harness/task.mjs', 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
      resetState();
      fs.mkdirSync(path.dirname(qFile), { recursive: true });
      fs.writeFileSync(qFile, JSON.stringify(tagged.map(([task, branch, tag, m]) => ({ task, agent: 'p', branch, head: E.heads[branch], tag, at: new Date(t0 + m * 60000).toISOString() }))));
      setEngines({ unity: cfgFor(E, ctl, { tagsWhenIdle: false }) });
      const off = probe(PASS);
      await guard('2.98 (b6) no untagged lane and two tag groups: the automatic start runs a train for the tag whose oldest lane waited longest (sound, queued first) and says why; train status names the rule; with tagsWhenIdle false nothing starts (fails before this fix: nothing ever started for tagged lanes)', () => [
        on.started?.length === 1 && on.started[0].tag === 'sound' && on.tag === 'sound' && /tag sound goes/.test(on.why || '') && /tagsWhenIdle\)/.test(out(st))
          && off.started?.length === 0 && off.start === false && /tagged lane\(s\) wait/.test(off.why || ''), J({ on, off, st: out(st).slice(-600) })]);
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
