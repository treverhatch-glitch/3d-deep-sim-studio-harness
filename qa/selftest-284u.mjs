/**
 * qa/selftest-284u.mjs — 2.84 (u): control of the engine train: which lanes it takes, stopping it, its automatic start,
 * and coming back after a reboot.
 *
 * What a crew hit in one day: an art batch had to land apart from 16 queued ports and there was no way to pick lanes (a
 * local env-var patch did it); the automatic start began a port train 40 seconds after the overseer stopped one; `task
 * train cancel` covered only the game's own train; one risky branch stalled a 16-branch train; after a reboot nothing
 * came back. harness/engine-train-control.mjs (selectBatch, cancelEngineTrain, setEngineAuto), the batch at the top of
 * harness/unity-train.mjs, enginePass in harness/line-producer.mjs, the train commands in harness/task.mjs and
 * harness/boot.mjs. The scaffolding (a studio copy, a made-up engine repo, a stand-in land script) is
 * qa/selftest-284h.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284U({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Running (a killed process not yet reaped, Linux state Z, runs nothing: not running).
  const alive = (pid) => { try { process.kill(Number(pid), 0); } catch (e) { return e.code === 'EPERM'; } try { const st = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf8'); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3)); } catch { return true; } };
  const T = path.join(tmpRoot, `s284u-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_TRAIN_DETACH: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284u-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `284u-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-284u.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const evs = (re) => events().filter((e) => re.test(e.type));
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probeFile = (code) => { const f = path.join(S, `.probe-284u-${++pn}.mjs`); fs.writeFileSync(f, code); return f; };
  const probe = (code, env = {}) => {
    const f = probeFile(code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const cli = (args, env = {}, script = 'harness/task.mjs') => spawnSync(process.execPath, [script, ...args], { windowsHide: true, cwd: S, env: envOf(env), encoding: 'utf8', timeout: 120000 });
  const resetState = () => { for (const x of ['train', 'engine', 'engine-shots', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };

  // ---- a made-up engine repo: the target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'base.txt', 'base\n');
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
  // The land script stand-in: merges its sources into the gate worktree and passes (284h's, without the red paths).
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs }) + '\\n');
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // A land run that hangs: it starts a merge in the gate worktree (MERGE_HEAD left), leaves an untracked file, records its
  // pid and sleeps. Only a cancel ends it.
  const sleeper = path.join(T, 'land-sleeper.mjs');
  fs.writeFileSync(sleeper, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
git(gw, 'merge', '--no-ff', '--no-commit', 'refs/heads/' + srcs[0]);
fs.writeFileSync(path.join(gw, 'leftover-from-land.tmp'), 'x');
fs.writeFileSync(ctl + '-started', JSON.stringify({ pid: process.pid, srcs }));
setTimeout(() => {}, 180000);
`);
  const runsOf = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cfgFor = (E, ctl, extra = {}, script = landStub) => ({ land: `node "${fwd(script)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const queue = (E, lanes, engine = 'unity') => { fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'train', `${engine}-queue.json`), JSON.stringify(lanes.map(([task, branch, more], i) => ({ task, agent: `porter-${i}`, branch, head: E.heads[branch], at: new Date(Date.now() - 600000 + i).toISOString(), ...(more || {}) })))); };
  const qTasks = (engine = 'unity') => (readJson(path.join(S, '.studio', 'train', `${engine}-queue.json`)) || []).map((e) => e.task);
  const TRAIN = (opts = {}) => `import { runUnityTrain, readUnityQueue } from ${u('harness/unity-train.mjs')};
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), ...${JSON.stringify(opts)}, log: () => {}, deps: { handBack: (lane) => handed.push(lane.task) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, message: r.message, batch: r.batch || null, handed, queue: readUnityQueue(process.cwd()).map((e) => e.task) }));`;
  const lanes4 = { 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' }, 'feat/c': { 'c.txt': 'c\n' }, 'feat/d': { 'd.txt': 'd\n' } };

  // ================= 1. --only and its env alias =================
  {
    resetState();
    const E = engineRepo(lanes4);
    const ctl = path.join(T, 'ctl-only');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-101', 'feat/a'], ['T-102', 'feat/b'], ['T-103', 'feat/c']]);
    const unknown = probe(TRAIN({ only: 'T-101,T-109' }));
    const runs0 = runsOf(ctl).length;
    const r = probe(TRAIN({ only: 'T-103,T-101' }));
    queue(E, [['T-104', 'feat/d'], ['T-102', 'feat/b']]);
    const alias = probe(TRAIN(), { STUDIO_UNITY_TRAIN_ONLY: 'T-102' });
    await guard('2.84 (u) train --only: an id not in the queue is refused before anything starts, naming it (no land run, the queue as it was); --only T-103,T-101 lands just those two in queue order and T-102 stays queued; STUDIO_UNITY_TRAIN_ONLY (the deprecated alias of the local patch) lands only T-102 and leaves T-104 queued (fails before this fix: there was no --only, every queued lane rode)', () => [
      unknown.ok === false && /T-109/.test(unknown.message || '') && !/T-101 /.test(unknown.message || '') && runs0 === 0 && unknown.queue?.join() === 'T-101,T-102,T-103'
        && r.ok === true && r.landed?.join() === 'T-101,T-103' && r.queue?.join() === 'T-102' && /2 of 3 queued: only T-103,T-101; 1 wait/.test(r.batch || '')
        && alias.landed?.join() === 'T-102' && alias.queue?.join() === 'T-104',
      JSON.stringify({ unknown, runs0, r, alias }).slice(0, 3000)]);
  }

  // ================= 2. lane tags =================
  {
    resetState();
    const E = engineRepo(lanes4);
    const ctl = path.join(T, 'ctl-tag');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-201', 'feat/a'], ['T-202', 'feat/b', { tag: 'art' }], ['T-203', 'feat/c']]);
    const plain = probe(TRAIN());
    const PASS = `const lp = await import(${u('harness/line-producer.mjs')}); const started = [];
const rows = await lp.enginePass({ now: Date.now(), deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, sessions: async () => [], startTrain: async (e) => { started.push(e); return { pid: 1 }; } } });
console.log(JSON.stringify({ start: rows[0]?.start, started: started.length, why: rows[0]?.why, queued: rows[0]?.queued, tagged: rows[0]?.tagged || 0 }));`;
    const auto = probe(PASS);
    const status = cli(['train', 'status', '--engine', 'unity']);
    const byTag = probe(TRAIN({ tag: 'art' }));
    // task tag re-tags a queued lane (and the engine record); a plain train then leaves it, a train for its tag takes it.
    write(S, '.studio/engine/tasks.json', JSON.stringify({ 'T-204': { engine: 'unity', track: 'engine:unity', branch: 'feat/d' } }));
    queue(E, [['T-204', 'feat/d']]);
    const tg = cli(['tag', 'T-204', 'sound']);
    const tagEv = evs(/^task\.tag$/);
    const rec = readJson(path.join(S, '.studio', 'engine', 'tasks.json'))?.['T-204'];
    const plain2 = probe(TRAIN());
    const untag = cli(['tag', 'T-204', 'none']);
    const q2 = readJson(path.join(S, '.studio', 'train', 'unity-queue.json'));
    // done --train --tag: the queue entry and the record carry the tag.
    const qd = probe(`import { queueUnityTask, readUnityQueue } from ${u('harness/unity-train.mjs')}; import { engineTask } from ${u('harness/engine-tracks.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: 'T-204', agent: 'b1', branch: 'feat/d', tag: 'art' });
console.log(JSON.stringify({ ok: r.ok, tag: readUnityQueue(process.cwd()).find((e) => e.task === 'T-204')?.tag || null, rec: engineTask('T-204')?.tag || null, msg: r.message }));`);
    await guard('2.84 (u) lane tags: a plain train lands the untagged T-201 and T-203 and leaves T-202 (tag art) queued; the automatic start (enginePass) starts nothing for a queue of only tagged lanes and says why; train status --engine shows the tag and how many wait per tag; train --tag art lands T-202; `task tag T-204 sound` re-tags a queued lane (queue entry, engine record, a task.tag event) so a plain train leaves it, `task tag T-204 none` clears it; queueing with tag "art" (task done --train --tag art) records it on the entry and the record (fails before this fix: there were no tags, so the automatic train swept art into a port train)', () => [
      plain.landed?.join() === 'T-201,T-203' && plain.queue?.join() === 'T-202' && /untagged lanes only \(1 tagged/.test(plain.batch || '')
        && auto.started === 0 && auto.start === false && auto.queued === 0 && auto.tagged === 1 && /1 tagged lane\(s\) wait \(art 1\)/.test(auto.why || '')
        && status.status === 0 && /T-202 .*tag art/.test(out(status)) && /art 1 waiting/.test(out(status))
        && byTag.landed?.join() === 'T-202' && byTag.queue?.length === 0
        && tg.status === 0 && tagEv.length === 1 && tagEv[0].meta?.tag === 'sound' && rec?.tag === 'sound' && plain2.landed?.length === 0 && plain2.queue?.join() === 'T-204'
        && untag.status === 0 && q2?.[0]?.task === 'T-204' && !q2[0].tag
        && qd.ok === true && qd.tag === 'art' && qd.rec === 'art',
      JSON.stringify({ plain, auto, status: out(status).slice(-600), byTag, tg: out(tg).slice(-300), tagEv: tagEv.map((e) => e.meta), rec, plain2, untag: out(untag).slice(-300), q2, qd }).slice(0, 3000)]);
  }

  // ================= 3. the cap and grouping by risk =================
  {
    const pure = probe(`import { selectBatch } from ${u('harness/engine-train-control.mjs')};
const q = Array.from({ length: 14 }, (_, i) => ({ task: 'T-' + (300 + i), branch: 'b' + i }));
const cls = (l) => (['T-301', 'T-303', 'T-305', 'T-307', 'T-309'].includes(l.task) ? 'full' : 'focus');
console.log(JSON.stringify({ a: selectBatch(q, { batchMax: 6, group: 'play', classOf: cls }).why, b: selectBatch(q, { batchMax: 6, group: 'play', classOf: cls }).lanes.map((l) => l.task) }));`);
    await guard('2.84 (u) the batch says why it is what it is: 14 queued, 9 of class focus at the head, batchMax 6 and batchGroup play give exactly "6 of 14 queued: class focus, cap 6; 8 wait (5 full, 3 focus)" and the first six focus lanes (fails before this fix: there was no cap, no grouping and no why)', () => [
      pure.a === '6 of 14 queued: class focus, cap 6; 8 wait (5 full, 3 focus)' && pure.b?.join() === 'T-300,T-302,T-304,T-306,T-308,T-310',
      JSON.stringify(pure).slice(0, 1500)]);

    resetState();
    const E = engineRepo(lanes4);
    const ctl = path.join(T, 'ctl-cap');
    setEngines({ unity: cfgFor(E, ctl, { batchMax: 2 }) });
    queue(E, [['T-311', 'feat/a'], ['T-312', 'feat/b'], ['T-313', 'feat/c']]);
    const capped = probe(TRAIN());
    const startEv = evs(/^task\.train\.unity\.start$/).pop();
    const capEnv = (() => { queue(E, [['T-313', 'feat/c'], ['T-314', 'feat/d']]); return probe(TRAIN(), { STUDIO_ENGINE_BATCH_MAX: '1' }); })();
    await guard('2.84 (u) batchMax: with engines.unity.batchMax 2 a train of three queued lanes lands two and leaves the third queued, and its start event says "2 of 3 queued: cap 2; 1 wait"; STUDIO_ENGINE_BATCH_MAX 1 overrides it (fails before this fix: a train took every queued lane)', () => [
      capped.landed?.join() === 'T-311,T-312' && capped.queue?.join() === 'T-313' && /2 of 3 queued: cap 2; 1 wait/.test(startEv?.msg || '') && startEv?.meta?.batch === '2 of 3 queued: cap 2; 1 wait'
        && capEnv.landed?.join() === 'T-313' && capEnv.queue?.join() === 'T-314',
      JSON.stringify({ capped, startEv, capEnv }).slice(0, 2500)]);

    const PLAY = { focus: { map: [{ match: '^Assets/Scripts/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', join: ';' } };
    const risk = { 'port/a': { 'Assets/Scripts/Economy/A.cs': 'a\n' }, 'port/b': { 'Assets/Scripts/Hangar/B.cs': 'b\n' }, 'art/x': { 'Assets/Art/logo.png': 'png\n' }, 'port/c': { 'Assets/Scripts/Economy/C.cs': 'c\n' } };
    resetState();
    const E2 = engineRepo(risk);
    const ctl2 = path.join(T, 'ctl-group');
    setEngines({ unity: cfgFor(E2, ctl2, { play: PLAY, batchGroup: 'play' }) });
    queue(E2, [['T-321', 'port/a'], ['T-322', 'port/b'], ['T-323', 'art/x'], ['T-324', 'port/c']]);
    const ports = probe(TRAIN());
    resetState();
    const E3 = engineRepo(risk);
    setEngines({ unity: cfgFor(E3, path.join(T, 'ctl-group2'), { play: PLAY, batchGroup: 'play' }) });
    queue(E3, [['T-331', 'art/x'], ['T-332', 'port/a'], ['T-333', 'port/b'], ['T-334', 'port/c']]);
    const riskyFirst = probe(TRAIN());
    resetState();
    const E4 = engineRepo(risk);
    setEngines({ unity: cfgFor(E4, path.join(T, 'ctl-group3'), { batchGroup: 'play' }) });
    queue(E4, [['T-341', 'port/a'], ['T-342', 'art/x'], ['T-343', 'port/b']]);
    const noFocus = probe(TRAIN());
    await guard('2.84 (u) batchGroup play: with a play.focus config a queue of [port, port, risky, port] lands the three ports on one run (class focus) and leaves the risky lane queued; with the risky lane first, it lands alone (class full) and the three ports wait; with no play.focus every lane is class full and all three ride together (fails before this fix: one risky branch rode with every port)', () => [
      ports.landed?.join() === 'T-321,T-322,T-324' && ports.queue?.join() === 'T-323' && /class focus/.test(ports.batch || '') && /1 wait \(1 full\)/.test(ports.batch || '')
        && riskyFirst.landed?.join() === 'T-331' && riskyFirst.queue?.join() === 'T-332,T-333,T-334' && /class full/.test(riskyFirst.batch || '') && /3 wait \(3 focus\)/.test(riskyFirst.batch || '')
        && noFocus.landed?.join() === 'T-341,T-342,T-343' && noFocus.queue?.length === 0,
      JSON.stringify({ ports, riskyFirst, noFocus }).slice(0, 2500)]);
  }

  // ================= 4. cancel a running engine train =================
  {
    resetState();
    const E = engineRepo(lanes4);
    const ctl = path.join(T, 'ctl-cancel');
    const target0 = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    setEngines({ unity: cfgFor(E, ctl, {}, sleeper) });
    queue(E, [['T-401', 'feat/a'], ['T-402', 'feat/b']]);
    const noTrain = cli(['train', 'cancel', '--engine', 'unity', '--by', 'overseer']);
    const pf = probeFile(TRAIN());
    const child = spawn(process.execPath, [pf], { windowsHide: true, cwd: S, env: envOf(), stdio: 'ignore' });
    let started = null;
    for (let i = 0; i < 300 && !started; i++) { await wait(200); started = readJson(`${ctl}-started`); }
    const lock = readJson(path.join(S, '.studio', 'locks', 'unity-train.lock'));
    const refsBefore = g(E.R, 'for-each-ref', '--format=%(refname)', 'refs/heads/unity-train/').stdout.trim();
    const mergeBefore = g(E.GW, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
    const worker = cli(['train', 'cancel', '--engine', 'unity', '--by', 'builder-3'], { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-3' });
    const workerFile = fs.existsSync(path.join(S, '.studio', 'train', 'unity-cancel.json'));
    const c = cli(['train', 'cancel', '--engine', 'unity', '--by', 'overseer', '--why', 'an art window']);
    let childGone = false;
    for (let i = 0; i < 50 && !childGone; i++) { childGone = child.exitCode !== null || child.signalCode !== null; if (!childGone) await wait(200); }
    const cf = readJson(path.join(S, '.studio', 'train', 'unity-cancel.json'));
    const status = g(E.GW, 'status', '--porcelain').stdout.trim();
    const gwHead = g(E.GW, 'rev-parse', 'HEAD').stdout.trim();
    const mergeAfter = g(E.GW, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
    const refsAfter = g(E.R, 'for-each-ref', '--format=%(refname)', 'refs/heads/unity-train/').stdout.trim();
    const cancelEv = evs(/^task\.train\.unity\.cancelled$/);
    const dropped = evs(/^task\.train\.unity\.dropped$/);
    let sleeperAlive = started?.pid ? alive(started.pid) : null;
    for (let i = 0; i < 25 && sleeperAlive; i++) { await wait(200); sleeperAlive = alive(started.pid); }
    try { if (sleeperAlive) process.kill(started.pid); } catch { /* started by this test */ }
    try { if (!childGone) child.kill(); } catch { /* started by this test */ }
    try { fs.rmSync(pf, { force: true }); } catch {}
    await guard('2.84 (u) train cancel --engine: with no engine train running it is refused ("No Unity train is running"); while a land run hangs (a merge in progress and an untracked file in the gate worktree, an integration ref) a worker session is refused and writes nothing; the overseer\'s cancel writes .studio/train/unity-cancel.json naming the train FIRST, ends the train and its land run, puts the gate worktree back clean at port/main (merge aborted, untracked file gone), deletes the train\'s integration ref, releases the lock, leaves T-401 and T-402 queued with nobody handed back, sends one task.train.unity.cancelled event and prints the hint to turn the automatic start off (fails before this fix: train cancel covered only the game\'s own train)', () => [
      noTrain.status !== 0 && /No Unity train is running/.test(out(noTrain))
        && started && lock?.id && /unity-train\//.test(refsBefore) && mergeBefore === true
        && worker.status !== 0 && /worker/i.test(out(worker)) && workerFile === false
        && c.status === 0 && cf?.train === lock.id && cf.by === 'overseer' && cf.why === 'an art window' && /train auto off --engine unity/.test(out(c))
        && childGone && sleeperAlive === false && !fs.existsSync(path.join(S, '.studio', 'locks', 'unity-train.lock'))
        && status === '' && gwHead === target0 && mergeAfter === false && refsAfter === ''
        && qTasks().join() === 'T-401,T-402' && dropped.length === 0 && cancelEv.length === 1 && cancelEv[0].meta?.train === lock.id,
      JSON.stringify({ noTrain: out(noTrain).slice(-300), started, lock, refsBefore, mergeBefore, worker: out(worker).slice(-300), workerFile, c: out(c).slice(-800), childGone, cf, status, gwHead, target0, mergeAfter, refsAfter, q: qTasks(), dropped: dropped.length, cancelEv: cancelEv.map((e) => e.meta), sleeperAlive }).slice(0, 3000)]);
  }

  // ================= 5. the automatic start off and on =================
  {
    resetState();
    const E = engineRepo(lanes4);
    const ctl = path.join(T, 'ctl-auto');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-501', 'feat/a']]);
    const PASS = `const lp = await import(${u('harness/line-producer.mjs')}); const started = [];
const rows = await lp.enginePass({ now: Date.now(), deps: { root: process.cwd(), rigBudget: async () => ({ running: [], freeGb: 64 }), machine: { cpu: { busy: 0.05 } }, webTrain: false, sessions: async () => [], startTrain: async (e) => { started.push(e); return { pid: 1 }; } } });
console.log(JSON.stringify({ start: rows[0]?.start, started: started.length, why: rows[0]?.why }));`;
    const clearStarts = () => fs.rmSync(path.join(S, '.studio', 'line', 'engine-trains.json'), { force: true });
    const worker = cli(['train', 'auto', 'off', '--engine', 'unity', '--by', 'builder-2'], { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-2' });
    const workerFile = fs.existsSync(path.join(S, '.studio', 'train', 'unity-auto.json'));
    const off = cli(['train', 'auto', 'off', '--engine', 'unity', '--by', 'overseer', '--why', 'art window', '--hours', '2']);
    const af = readJson(path.join(S, '.studio', 'train', 'unity-auto.json'));
    clearStarts(); const p1 = probe(PASS);
    clearStarts(); const p2 = probe(PASS);
    const offEvents = evs(/^task\.train\.unity\.auto_off$/);
    const status = cli(['train', 'status', '--engine', 'unity']);
    const person = probe(TRAIN());
    queue(E, [['T-502', 'feat/b']]);
    // --hours ran out: on by itself.
    write(S, '.studio/train/unity-auto.json', JSON.stringify({ off: true, by: 'overseer', at: new Date(Date.now() - 3 * 3600000).toISOString(), until: new Date(Date.now() - 60000).toISOString() }));
    clearStarts(); const expired = probe(PASS);
    const expiredGone = !fs.existsSync(path.join(S, '.studio', 'train', 'unity-auto.json'));
    cli(['train', 'auto', 'off', '--engine', 'unity', '--by', 'overseer']);
    clearStarts(); const p3 = probe(PASS);
    const on = cli(['train', 'auto', 'on', '--engine', 'unity', '--by', 'overseer']);
    clearStarts(); const p4 = probe(PASS);
    const gameAuto = cli(['train', 'auto']);
    const hoursOk = af?.until && Math.abs(Date.parse(af.until) - Date.now() - 2 * 3600000) < 10 * 60000;
    await guard('2.84 (u) train auto off|on --engine: a worker session is refused and writes nothing; the overseer\'s `off --hours 2` writes .studio/train/unity-auto.json (until in 2 h), and the automatic start (enginePass) starts nothing and says so in its why, as ONE task.train.unity.auto_off reminder over two passes; train status --engine shows OFF; a person\'s train --engine still lands T-501; once --hours has run out the next pass starts the train and removes the file; off again stops it, `on` resumes it; plain `train auto` still answers for the game\'s train (fails before this fix: there was no engine switch, the automatic start began a train 40 s after one was stopped)', () => [
      worker.status !== 0 && workerFile === false
        && off.status === 0 && af?.off === true && af.by === 'overseer' && af.why === 'art window' && hoursOk
        && p1.started === 0 && p1.start === false && /automatic start is off \(train auto off by overseer: art window; until/.test(p1.why || '') && p2.started === 0 && offEvents.filter((e) => e.meta?.reminder).length === 1
        && status.status === 0 && /automatic start: OFF \(by overseer/.test(out(status))
        && person.landed?.join() === 'T-501'
        && expired.started === 1 && expiredGone
        && p3.started === 0 && on.status === 0 && p4.started === 1
        && gameAuto.status === 0 && !/--engine/.test(out(gameAuto)),
      JSON.stringify({ worker: out(worker).slice(-300), workerFile, off: out(off).slice(-300), af, p1, p2, offEvents: offEvents.map((e) => e.meta), status: out(status).slice(-500), person, expired, expiredGone, p3, on: out(on).slice(-200), p4, gameAuto: out(gameAuto).slice(-200) }).slice(0, 3000)]);
  }

  // ================= 6. after a reboot =================
  {
    resetState();
    const r = probe(`import { bootInstall } from ${u('harness/boot.mjs')};
const calls = []; const exec = (f, a) => { calls.push([f, ...a]); return { status: 0, stdout: 'SUCCESS', stderr: '' }; };
const winDry = await bootInstall({ root: 'C:\\\\studios\\\\my-studio', platform: 'win32', node: 'C:\\\\node\\\\node.exe', argv: ['--dry-run'], exec });
const n0 = calls.length;
const win = await bootInstall({ root: 'C:\\\\studios\\\\my-studio', platform: 'win32', node: 'C:\\\\node\\\\node.exe', argv: [], exec });
const winRm = await bootInstall({ root: 'C:\\\\studios\\\\my-studio', platform: 'win32', node: 'C:\\\\node\\\\node.exe', argv: ['--remove'], exec });
const n1 = calls.length;
const winWorker = await bootInstall({ root: 'C:\\\\studios\\\\my-studio', platform: 'win32', node: 'C:\\\\node\\\\node.exe', argv: [], exec, env: { ...process.env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-1' } });
const lin = await bootInstall({ root: '/srv/my-studio', platform: 'linux', node: '/usr/bin/node', argv: [], exec });
const mac = await bootInstall({ root: '/Users/a/my-studio', platform: 'darwin', node: '/usr/local/bin/node', argv: [], exec });
console.log(JSON.stringify({ winDry: winDry.lines, n0, win: win.lines, winRm: winRm.lines, n1, winWorker: { ok: winWorker.ok, lines: winWorker.lines }, lin: lin.lines, mac: mac.lines, calls }));`);
    const cliDry = cli(['install', '--dry-run', '--no-supervisor'], {}, 'harness/boot.mjs');
    const sch = r.calls?.[0] || [];
    await guard('2.84 (u) studio:boot -- install: on a Windows-shaped run --dry-run prints the schtasks /Create /SC ONLOGON line (task name with the studio folder\'s name, node and boot.mjs paths) and registers nothing; without it the injected schtasks stand-in is called once with those arguments, --remove calls /Delete, a worker session is refused; on Linux it prints the crontab @reboot line and a systemd user unit, on macOS the crontab line, and runs nothing; the real command with --dry-run on this machine prints and changes nothing (fails before this fix: there was no install, so nothing brought the studio back after a reboot)', () => [
      r.winDry?.some((l) => /schtasks \/Create \/SC ONLOGON \/TN "Studio boot \(my-studio\)" \/TR .*node\.exe.*harness\\boot\.mjs.* \/F/.test(l)) && r.winDry.some((l) => /--dry-run: nothing was registered/.test(l)) && r.n0 === 0
        && sch[0] === 'schtasks' && sch.slice(1, 7).join(' ') === '/Create /SC ONLOGON /TN Studio boot (my-studio) /TR' && /^"C:\\node\\node\.exe" "C:\\studios\\my-studio\\harness\\boot\.mjs"$/.test(sch[7] || '') && sch[8] === '/F'
        && r.calls?.[1]?.slice(0, 2).join(' ') === 'schtasks /Delete' && r.n1 === 2 && r.winWorker?.ok === false && r.calls.length === 2
        && r.lin?.some((l) => /@reboot '\/usr\/bin\/node' '\/srv\/my-studio\/harness\/boot\.mjs' >> '\/srv\/my-studio\/\.studio\/logs\/boot\.log'/.test(l)) && !r.lin.some((l) => / && /.test(l)) && r.lin.some((l) => /ExecStart=\/usr\/bin\/node \/srv\/my-studio\/harness\/boot\.mjs/.test(l))
        && r.mac?.some((l) => /@reboot '[^']+' '\/Users\/a\/my-studio\/harness\/boot\.mjs'/.test(l)) && !r.mac.some((l) => /systemd/.test(l))
        && cliDry.status === 0 && (process.platform === 'win32' ? /schtasks \/Create/.test(out(cliDry)) : /@reboot '/.test(out(cliDry))) && !/Studio boot:/.test(out(cliDry)),
      JSON.stringify({ r, cliDry: out(cliDry).slice(-800) }).slice(0, 3000)]);

    // studio:boot: a stale engine train lock (its process gone) is cleared, the engine queue kept and reported.
    resetState();
    const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
    write(S, '.studio/locks/mock-train.lock', JSON.stringify({ pid: dead, id: 'old-train', by: 'line-producer', at: Date.now() - 3600000, lanes: ['T-601'] }));
    write(S, '.studio/train/mock-queue.json', JSON.stringify([{ task: 'T-601', branch: 'feat/a', head: 'x', at: new Date().toISOString() }, { task: 'T-602', branch: 'feat/b', head: 'y', at: new Date().toISOString(), tag: 'art' }]));
    const qBefore = fs.readFileSync(path.join(S, '.studio', 'train', 'mock-queue.json'), 'utf8');
    const b = probe(`import { boot } from ${u('harness/boot.mjs')};
const r = await boot({ root: process.cwd(), argv: ['--no-supervisor'] });
console.log(JSON.stringify({ swept: r.swept, lines: r.lines }));`);
    const qAfter = fs.readFileSync(path.join(S, '.studio', 'train', 'mock-queue.json'), 'utf8');
    await guard('2.84 (u) studio:boot after a reboot: a stale .studio/locks/<engine>-train.lock of any engine (its process gone) is cleared, the engine queue is left byte for byte, and the card says "mock: 2 branch(es) queued (1 tagged …)" and that the automatic start resumes them (fails before this fix: only the Unity lock was swept and the card never named the engine queues)', () => [
      b.swept?.some((x) => x.file === '.studio/locks/mock-train.lock' && x.action === 'cleared') && !fs.existsSync(path.join(S, '.studio', 'locks', 'mock-train.lock'))
        && qAfter === qBefore && b.lines?.some((l) => /engine\s+mock: 2 branch\(es\) queued \(1 tagged/.test(l) && /automatic start resumes them/.test(l)),
      JSON.stringify(b).slice(0, 2500)]);
  }
}
