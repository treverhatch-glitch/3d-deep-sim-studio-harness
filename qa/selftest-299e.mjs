/**
 * qa/selftest-299e.mjs — 2.99 (e): a tag group that has waited past engines.<x>.tagMaxWaitHours runs next (one group at a
 * time, an untagged train between two), its wait counted from when its tag was set; the Line Producer tests waiting lanes
 * against a moved target and hands back those that no longer merge (engines.<x>.queueRetestHours); engines.<x>.merge.newer
 * takes a listed JSON file whole from the side whose date field is later.
 * Scaffolding as qa/selftest-298b.mjs (a studio copy, made-up engine repos, a stand-in for the land script).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest299E({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s299e-${process.pid}`);
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
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-299e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `299e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-299e.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-299e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  let rn = 0;
  // A made-up engine repo: port/main checked out in a gate worktree; each lane a branch with its own files.
  const engineRepo = (files0, lanes) => {
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
    return { R, GW, heads };
  };
  // The target moves on (a commit in the gate worktree).
  const moveTarget = (E, files) => { for (const [f, t] of Object.entries(files)) write(E.GW, f, t); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', 'target moves'); };
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  const cfgFor = (E, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const qFile = path.join(S, '.studio', 'train', 'unity-queue.json');
  const qNow = () => readJson(qFile) || [];
  const H = 3600000;
  const iso = (ms) => new Date(ms).toISOString();
  const writeQueue = (E, rows) => { fs.mkdirSync(path.dirname(qFile), { recursive: true }); fs.writeFileSync(qFile, JSON.stringify(rows.map(([task, branch, tag, hoursAgo]) => ({ task, agent: `porter-${task}`, branch, head: E.heads[branch], at: iso(Date.now() - hoursAgo * H), ...(tag ? { tag } : {}) })))); };
  const PASS = `const lp = await import(${u('harness/line-producer.mjs')}); const started = [];
const rows = await lp.enginePass({ now: Date.now(), deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, drain: null, sessions: async () => [], startTrain: async (e, o) => { started.push({ e, tag: o?.tag || null }); return { pid: 1 }; } } });
console.log(JSON.stringify({ start: rows[0]?.start, started, why: rows[0]?.why, tag: rows[0]?.tag || null }));`;
  const status = () => out(spawnSync(process.execPath, ['harness/task.mjs', 'train', 'status', '--engine', 'unity'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 }));
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const { nextTag } = await import(pathToFileURL(path.join(dir, 'harness', 'engine-train-control.mjs')).href);

  try {
    // ================= (e1) a tag group over the limit runs next =================
    {
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/a': { 'A.cs': 'a\n' }, 'port/b': { 'B.cs': 'b\n' }, 'port/u': { 'U.cs': 'u\n' } });
      const run = (tagMaxWaitHours, artHours) => {
        resetState();
        setEngines({ unity: cfgFor(E, tagMaxWaitHours === undefined ? {} : { tagMaxWaitHours }) });
        writeQueue(E, [['T-11', 'port/a', 'art', artHours], ['T-12', 'port/b', 'art', 1], ['T-13', 'port/u', null, 0.1]]);
        return { pass: probe(PASS), st: status() };
      };
      const over = run(undefined, 26.5);
      const under = run(undefined, 23);
      const off = run(0, 200);
      await guard('2.99 (e1) a tag group whose oldest lane has waited 26 h runs as the next train although an untagged lane waits, and the Line Producer and train status say "tag art has waited 26 h (limit 24): it runs next"; at 23 h the untagged lane goes; tagMaxWaitHours 0 turns it off (fails before this fix: a tag group ran only when the untagged queue was empty)', () => [
        over.pass.started?.length === 1 && over.pass.started[0].tag === 'art' && /tag art has waited 26 h \(limit 24\): it runs next/.test(over.pass.why || '') && /tag art has waited 26 h \(limit 24\): it runs next/.test(over.st)
          && under.pass.started?.length === 1 && under.pass.started[0].tag === null && !/tag art has waited/.test(under.st)
          && off.pass.started?.length === 1 && off.pass.started[0].tag === null && !/tag art has waited/.test(off.pass.why || ''), J({ over: over.pass, under: under.pass, off: off.pass })]);
    }

    // ================= (e2) two overdue groups: oldest first, one untagged train between =================
    {
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/a': { 'A.cs': 'a\n' }, 'port/s': { 'S.cs': 's\n' }, 'port/u': { 'U.cs': 'u\n' }, 'port/v': { 'V.cs': 'v\n' } });
      resetState();
      setEngines({ unity: cfgFor(E) });
      writeQueue(E, [['T-21', 'port/s', 'sound', 30], ['T-22', 'port/a', 'art', 50], ['T-23', 'port/u', null, 0.1], ['T-24', 'port/v', null, 0.1]]);
      const p1 = probe(PASS);
      const tr = probe(`import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const r = await runUnityTrain({ root: process.cwd(), tag: 'art', log: () => {}, deps: { handBack: () => {}, close: () => ({ ok: true }) } });
console.log(JSON.stringify({ landed: r.landed }));`);
      const last = readJson(path.join(S, '.studio', 'train', 'unity-last.json'));
      const p2 = probe(PASS);
      const st2 = status();
      const q = [{ task: 'A', tag: 'art', at: iso(Date.now() - 50 * H) }, { task: 'S', tag: 'sound', at: iso(Date.now() - 30 * H) }, { task: 'U', at: iso(Date.now()) }];
      const pure = [nextTag(q), nextTag(q.slice(1), { lastTag: 'art' }), nextTag(q.slice(1), { lastTag: null }), nextTag(q.slice(1), { lastTag: 'art', cfg: { tagsWhenIdle: false } })];
      await guard('2.99 (e2) two overdue groups: the older one (art, 50 h) runs first; its train records its tag; the next pass starts an untagged train and says sound "runs next after one untagged train"; then sound goes; tagsWhenIdle false turns the overdue road off too (fails before this fix: neither tag group ever ran while untagged lanes waited)', () => [
        p1.started?.[0]?.tag === 'art' && tr.landed?.join() === 'T-22' && last?.tag === 'art'
          && p2.started?.[0]?.tag === null && /tag sound has waited 30 h \(limit 24\): it runs next after one untagged train \(the last train was tag art\)/.test(p2.why || '') && /after one untagged train/.test(st2)
          && pure[0]?.tag === 'art' && pure[0].go === true && pure[1]?.tag === 'sound' && pure[1].go === false && pure[2]?.go === true && pure[3] === null, J({ p1, tr, last, p2, pure, st2: st2.slice(-800) })]);
    }

    // ================= (e3) the wait counts from when the tag was set =================
    {
      const E = engineRepo({ 'a.txt': 'a\n' }, { 'port/a': { 'A.cs': 'a\n' }, 'port/b': { 'B.cs': 'b\n' } });
      resetState();
      setEngines({ unity: cfgFor(E) });
      const r = probe(`import { queueUnityTask, setQueueTag, readUnityQueue } from ${u('harness/unity-train.mjs')};
const root = process.cwd(); const sleep = () => new Promise((r) => setTimeout(r, 15)); const e = () => readUnityQueue(root).find((x) => x.task === 'T-31');
const q1 = queueUnityTask(root, { engine: 'unity', task: 'T-31', agent: 'p', branch: 'port/a', tag: 'art' }); const a = e(); await sleep();
setQueueTag(root, 'T-31', 'art'); const b = e(); await sleep();
const q2 = queueUnityTask(root, { engine: 'unity', task: 'T-31', agent: 'p', branch: 'port/a', tag: 'art' }); const c = e(); await sleep();
setQueueTag(root, 'T-31', 'sound'); const d = e(); await sleep();
setQueueTag(root, 'T-31', null); const f = e();
queueUnityTask(root, { engine: 'unity', task: 'T-32', agent: 'p', branch: 'port/b' }); await sleep(); setQueueTag(root, 'T-32', 'art'); const g = readUnityQueue(root).find((x) => x.task === 'T-32');
console.log(JSON.stringify({ ok: [q1.ok, q2.ok], a, b, c, d, f, g }));`);
      const late = nextTag([{ task: 'X', at: iso(Date.now() - 30 * H), tag: 'art', tagAt: iso(Date.now() - 2 * H) }, { task: 'U', at: iso(Date.now()) }]);
      const old = nextTag([{ task: 'X', at: iso(Date.now() - 30 * H), tag: 'art' }, { task: 'U', at: iso(Date.now()) }]);
      await guard('2.99 (e3) a lane queued with a tag has tagAt = its queue time; the same tag again and a re-queue keep it; a new tag sets it anew; untagging removes it; a lane tagged after queueing counts from then: queued 30 h ago but tagged 2 h ago is not overdue (an entry with no tagAt counts from its queue time) (fails before this fix: no tagAt was kept)', () => [
        r.ok?.join() === 'true,true' && r.a?.tagAt === r.a?.at && r.b?.tagAt === r.a.tagAt && r.c?.tagAt === r.a.tagAt && r.c?.at === r.a.at && r.d?.tag === 'sound' && r.d.tagAt > r.a.tagAt
          && r.f && !('tagAt' in r.f) && !r.f.tag && r.g?.tagAt > r.g?.at && late === null && old?.road === 'overdue' && old.waitedH === 30, J({ r, late, old })]);
    }
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
