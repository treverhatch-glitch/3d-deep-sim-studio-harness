/**
 * qa/selftest-293c.mjs — 2.93 (c): four small steering changes for the engine train. A preQueue entry may pick tasks by
 * "titles" (and its command gets STUDIO_TASK_ID and STUDIO_TASK_TITLE); a queued branch whose task waits (`task after`)
 * for an open task is left out of a batch; `train slice` marks a queued branch as a slice or not; `task duplicate`
 * closes a waiting task as a copy of another. A studio copy, a made-up engine repo and stand-ins for the land script
 * and the pre-queue command, as in qa/selftest-292a.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, writeIn as write } from './kit.mjs';

export async function selftest293C({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s293c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|COMPUTERNAME|OS|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(k)) delete clean[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-293c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings, board) ----
  const S = path.join(tmpRoot, `293c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-293c.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventsFileOf(evFile);
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-293c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const task = (args, env = {}) => spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), ...args], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
  const resetState = () => {
    for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 80, retryDelay: 500 });
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });
    fs.writeFileSync(evFile, '');
  };
  const queueFile = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')); } catch { return []; } };
  const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const holds = () => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } };
  // The board: [id, title, 'open' | 'wait' | 'done'] (open = in progress).
  const board = (rows) => {
    const line = (id, title, mark) => `- [${mark}] **${id}** [P1] (\`builder\`) — ${title}`;
    write(S, 'studio/NEXT.md', `# Studio Task Queue\n\n## IN_PROGRESS\n${rows.filter((r) => r[2] === 'open').map((r) => line(r[0], r[1], '>')).join('\n')}\n\n## BACKLOG\n${rows.filter((r) => r[2] === 'wait').map((r) => line(r[0], r[1], ' ')).join('\n')}\n\n## DONE\n${rows.filter((r) => r[2] === 'done').map((r) => line(r[0], r[1], 'x')).join('\n')}\n`);
    write(S, 'studio/DONE.md', '# Done\n');
  };
  const engineTasks = (ids) => write(S, '.studio/engine/tasks.json', `${JSON.stringify(Object.fromEntries(ids.map((i) => [i, { engine: 'unity', track: 'engine:unity' }])))}\n`);

  // ---- a made-up engine repo ----
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'Sim/State.cs', 'namespace Game.Sim { class State { } }\n');
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
  // The land script's stand-in: merges the branches into the gate worktree.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: gw, encoding: 'utf8', windowsHide: true });
for (const s of srcs) { const m = git('merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git('merge', '--abort'); console.log('conflict ' + s); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The pre-queue command's stand-in: records the task env it got; exits 1 when STUB_FAIL is the task's id.
  const pqLog = path.join(T, 'prequeue-log.jsonl');
  const pqStub = path.join(T, 'pq-stub.mjs');
  fs.writeFileSync(pqStub, `import fs from 'node:fs';
const E = process.env;
fs.appendFileSync(${JSON.stringify(pqLog)}, JSON.stringify({ id: E.STUDIO_TASK_ID ?? null, title: E.STUDIO_TASK_TITLE ?? null, name: E.PQ_NAME || '' }) + '\\n');
if (E.STUDIO_TASK_ID === E.STUB_FAIL) { console.log('the stub says no'); process.exit(1); }
`);
  const cfgFor = (E, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const pqEntry = (extra) => ({ run: `node "${fwd(pqStub)}"`, say: 'Fix the wire.', ...extra });
  const Q = (id, branch, title = '') => `import { queueUnityTask } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: ${JSON.stringify(id)}, branch: ${JSON.stringify(branch)}, agent: 'porter-a', title: ${JSON.stringify(title)} });
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message }));`;
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const { trainDeps } = await import(${u('harness/task.mjs')});
const handed = []; const logs = [];
const d = trainDeps({}, { forDone: true });
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { ...d, handBack: (lane, note) => handed.push({ task: lane.task, note }) } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, held: r.held || null, handed, logs: logs.filter((l) => /pre-queue|regular/.test(l)) }));`;
  const ctlRun = (id, args) => task(['train', 'slice', id, '--engine', 'unity', ...args]);

  // ================= 1. preQueue by title =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Sim/b.txt': 'b\n' } });
    setEngines({ unity: cfgFor(E, { preQueue: [pqEntry({ titles: ['\\bwire\\b'], env: { PQ_NAME: 'wire' } })] }) });
    fs.rmSync(pqLog, { force: true });
    const hit = probe(Q('T-101', 'feat/a', 'Wire the Game/Sim hooks'), { STUB_FAIL: 'T-101' });
    const miss = probe(Q('T-102', 'feat/b', 'Fix the lamp'), { STUB_FAIL: 'T-102' });
    const calls = jsonl(pqLog);
    await guard('293c 1: an entry with only "titles" (no "touches") runs for a task whose title matches and is refused by it, and does not run for a title that does not match (fails before this fix: an entry with no "touches" was left out, so the wire task was queued unchecked)', () => [
      hit.ok === false && hit.error === 'pre-queue' && /is for T-101, and the check for it/.test(hit.message) && /Fix the wire, then task done T-101 --train again/.test(hit.message)
        && miss.ok === true && calls.length === 1 && calls[0].id === 'T-101',
      JSON.stringify({ hit, miss, calls }).slice(0, 2500)]);
    await guard('293c 1: the command gets STUDIO_TASK_ID and STUDIO_TASK_TITLE beside its own env (fails before this fix: neither was set)', () => [
      calls[0]?.id === 'T-101' && calls[0]?.title === 'Wire the Game/Sim hooks' && calls[0]?.name === 'wire',
      JSON.stringify(calls)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/a.txt': 'a\n' }, 'feat/b': { 'Sim/b.txt': 'b\n' }, 'feat/c': { 'docs/c.txt': 'c\n' }, 'feat/d': { 'docs/d.txt': 'd\n' } });
    setEngines({ unity: cfgFor(E, { preQueue: [pqEntry({ touches: 'Sim/*', titles: ['wire'] })] }) });
    fs.rmSync(pqLog, { force: true });
    probe(Q('T-111', 'feat/a', 'Wire the hooks'));
    probe(Q('T-112', 'feat/b', 'Fix the lamp'));
    probe(Q('T-113', 'feat/c', 'Wire the docs'));
    probe(Q('T-114', 'feat/d', 'Fix the docs'));
    await guard('293c 1: with both "touches" and "titles", the entry runs only when both are met: files and title (T-111) yes; files only, title only, or neither (T-112, T-113, T-114) no (fails before this fix: "touches" alone decided, so T-112 would have run)', () => [
      jsonl(pqLog).map((c) => c.id).join() === 'T-111', JSON.stringify(jsonl(pqLog))]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    setEngines({ unity: cfgFor(E, { preQueue: [pqEntry({ titles: ['('] }), pqEntry({ titles: ['wire'], env: { PQ_NAME: 'good' } }), { run: 'node -e 0' }] }) });
    fs.rmSync(pqLog, { force: true });
    const r = probe(Q('T-121', 'feat/a', 'Wire it'));
    await guard('293c 1: a bad regular expression leaves that entry out, is said once in the command\'s output, and does not crash; the good entry still runs; an entry with neither "touches" nor "titles" stays left out (fails before this fix: not said)', () => [
      r.ok === true && (r.message.match(/not a valid regular expression/g) || []).length === 1 && /"\("/.test(r.message) && jsonl(pqLog).length === 1 && jsonl(pqLog)[0].name === 'good',
      JSON.stringify({ r, calls: jsonl(pqLog) }).slice(0, 2000)]);
  }
  {
    // At train start: the target moved, so the check runs again with the task's title from the board.
    resetState();
    board([['T-131', 'Wire the hooks', 'open'], ['T-132', 'Fix the lamp', 'open']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    setEngines({ unity: cfgFor(E, { preQueue: [pqEntry({ titles: ['wire'] })] }) });
    queueUnityOf(S)(E, [['T-131', 'feat/a'], ['T-132', 'feat/b']]);
    fs.rmSync(pqLog, { force: true });
    const r = probe(TRAIN, { STUB_FAIL: 'T-131' });
    const calls = jsonl(pqLog);
    await guard('293c 1: at train start (the re-run) a titles entry reads the task\'s title from the board and its env: T-131 is refused by it, T-132 is not checked (fails before this fix: no title, no env)', () => [
      calls.length === 1 && calls[0].id === 'T-131' && calls[0].title === 'Wire the hooks' && r.dropped?.map((x) => `${x.task}:${x.cause}`).join() === 'T-131:pre-queue' && r.landed?.join() === 'T-132',
      JSON.stringify({ r, calls }).slice(0, 2500)]);
  }

  // ================= 2. task after holds a queued branch =================
  {
    resetState();
    board([['T-201', 'Held lane', 'open'], ['T-202', 'Other lane', 'open'], ['T-203', 'First task', 'open']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    setEngines({ unity: cfgFor(E) });
    engineTasks(['T-201', 'T-202']);
    queueUnityOf(S)(E, [['T-201', 'feat/a'], ['T-202', 'feat/b']]);
    const af = task(['after', 'T-201', '--set', 'T-203', '--by', 'overseer']);
    const r1 = probe(TRAIN);
    // 2.96 (c): changed on purpose: a held lane is left out before the pick (a held event, not a deferral).
    const dEv = evs().filter((e) => e.type === 'task.train.unity.held' && e.task === 'T-201');
    await guard('293c 2: a queued lane whose task waits (task after) for an open task is left out of the batch with the reason "waits for T-203 (task after)" and the other lane lands; 2.96: left out before the pick (one held event, not deferred) (fails before this fix: the held lane rode the train)', () => [
      af.status === 0 && r1.landed?.join() === 'T-202' && !r1.deferred?.length && r1.held?.some((x) => x.task === 'T-201' && /^waits for T-203 \(task after\)$/.test(x.why)) && dEv.length === 1 && queueFile().some((e) => e.task === 'T-201'),
      JSON.stringify({ af: out(af), r1, dEv: dEv.length, q: queueFile().map((e) => e.task) }).slice(0, 2500)]);
    board([['T-201', 'Held lane', 'open'], ['T-203', 'First task', 'done']]);
    const r2 = probe(TRAIN);
    await guard('293c 2: once the other task is done the held lane rides the next train with no further step (fails before this fix: n/a, it rode the first train)', () => [
      r2.landed?.join() === 'T-201', JSON.stringify(r2).slice(0, 1500)]);
  }
  {
    resetState();
    board([['T-211', 'Held lane', 'open'], ['T-212', 'First task', 'open']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    setEngines({ unity: cfgFor(E) });
    engineTasks(['T-211']);
    task(['after', 'T-211', '--set', 'T-212', '--by', 'overseer']);
    const d = task(['done', 'T-211', '--train', '--agent', 'porter-a', '--branch', 'feat/a']);
    const q = queueFile();
    await guard('293c 2: task done --train still queues a held lane and says in its output that it waits for T-212 (fails before this fix: nothing said)', () => [
      q.some((e) => e.task === 'T-211') && /It waits for T-212 \(task after\): a train leaves it out until then\./.test(out(d)),
      out(d).slice(-1500)]);
    const cli1 = task(['train', '--engine', 'unity', '--by', 'overseer', '--foreground']);
    await guard('293c 2: the real command (task train --engine unity) leaves the held lane out with the reason and does not crash; 2.96: the batch line says "T-211 waits for T-212 (task after)" (fails before this fix: the held lane rode the train)', () => [
      /T-211 waits for T-212 \(task after\)/.test(out(cli1)) && queueFile().some((e) => e.task === 'T-211') && !/unsettled|ERR_/.test(out(cli1)), out(cli1).slice(-1500)]);
    task(['after', 'T-211', '--clear', '--by', 'overseer']);
    const cli2 = task(['train', '--engine', 'unity', '--by', 'overseer', '--foreground']);
    await guard('293c 2: when the hold is released the lane rides the next train, run as the real command (fails before this fix: n/a)', () => [cli2.status === 0 && !queueFile().some((e) => e.task === 'T-211'), out(cli2).slice(-1500)]);
  }

  // ================= 3. train slice =================
  {
    resetState();
    board([['T-301', 'Slice lane', 'open'], ['T-302', 'Whole lane', 'open']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'b.txt': 'b\n' } });
    setEngines({ unity: cfgFor(E) });
    engineTasks(['T-301', 'T-302']);
    queueUnityOf(S)(E, [['T-301', 'feat/a'], ['T-302', 'feat/b']]);
    const before = JSON.stringify(queueFile());
    const on = ctlRun('T-301', ['--by', 'overseer']);
    const markedOn = Boolean(holds()['T-301']?.slice);
    const same = JSON.stringify(queueFile()) === before;
    const markEv = evs().filter((e) => e.type === 'task.train.unity.slice_marked');
    await guard('293c 3: train slice <ID> marks the queued entry as a slice (the task\'s slice mark, as task done --train --slice puts it), changes nothing else in the queue, and writes one slice_marked event (fails before this fix: not a train subcommand)', () => [
      on.status === 0 && markedOn && same && markEv.length === 1 && /marked as a slice/.test(out(on)), JSON.stringify({ o: out(on), holds: holds(), markEv: markEv.length }).slice(0, 1500)]);
    const noEntry = ctlRun('T-399', ['--by', 'overseer']);
    const worker = ctlRun('T-302', ['--by', 'engine-porter-1']);
    await guard('293c 3: train slice refuses plainly when the task has no entry in that queue, and when the actor is a worker (the same rule as train auto); nothing is marked (fails before this fix: no such verb)', () => [
      noEntry.status !== 0 && /T-399 is not in the .* queue, so nothing was changed/.test(out(noEntry)) && worker.status !== 0 && /worker's name/.test(out(worker)) && !holds()['T-302']?.slice,
      JSON.stringify({ n: out(noEntry), w: out(worker) }).slice(0, 1500)]);
    const r = probe(TRAIN);
    const b = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const d = fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8');
    await guard('293c 3: a branch marked as a slice lands and its task stays open (back in the backlog, mark cleared), while the unmarked lane closes (fails before this fix: a branch queued without --slice closed its task)', () => [
      r.landed?.join() === 'T-301,T-302' && /\*\*T-301\*\*/.test(b.split('## BACKLOG')[1] || '') && !/T-301/.test(d) && !holds()['T-301']?.slice && /T-302/.test(d + b.split('## DONE')[1]) && !/T-302/.test((b.split('## BACKLOG')[1] || '').split('## DONE')[0]),
      JSON.stringify({ r, b: b.slice(0, 700), d: d.slice(0, 300) }).slice(0, 2500)]);
  }
  {
    resetState();
    board([['T-311', 'Slice lane', 'open']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    setEngines({ unity: cfgFor(E) });
    engineTasks(['T-311']);
    queueUnityOf(S)(E, [['T-311', 'feat/a']]);
    ctlRun('T-311', ['--by', 'overseer']);
    const off = ctlRun('T-311', ['--by', 'overseer', '--off']);
    const offEv = evs().filter((e) => e.type === 'task.train.unity.slice_marked' && e.meta?.slice === false);
    await guard('293c 3: train slice --off removes the mark and says the task closes when it lands (fails before this fix: no such verb)', () => [
      off.status === 0 && !holds()['T-311']?.slice && offEv.length === 1 && /no longer a slice/.test(out(off)), out(off)]);
    const run = probe(`import { withUnityTrainLock } from ${u('harness/unity-train.mjs')};
import { spawnSync } from 'node:child_process';
await withUnityTrainLock(process.cwd(), { lanes: ['T-311'] }, async () => {
  const r = spawnSync(process.execPath, ['harness/task.mjs', 'train', 'slice', 'T-311', '--engine', 'unity', '--by', 'overseer'], { cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  console.log(JSON.stringify({ status: r.status, text: String(r.stdout) + String(r.stderr) }));
});`);
    await guard('293c 3: train slice refuses when the task\'s train is already running with it, and marks nothing (fails before this fix: no such verb)', () => [
      run.status === 1 && /is in a .* train that is running right now, so nothing was changed/.test(run.text || '') && !holds()['T-311']?.slice, JSON.stringify(run).slice(0, 1200)]);
  }

  // ================= 4. task duplicate =================
  {
    resetState();
    board([['T-401', 'Fix the lamp fault', 'wait'], ['T-402', 'Fix the lamp', 'done'], ['T-403', 'Busy task', 'open'], ['T-404', 'Queued task', 'wait'], ['T-405', 'Plain task', 'wait']]);
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    setEngines({ unity: cfgFor(E) });
    engineTasks(['T-404']);
    queueUnityOf(S)(E, [['T-404', 'feat/a']]);
    const same = task(['duplicate', 'T-405', '--of', 'T-405', '--by', 'overseer']);
    const unknown = task(['duplicate', 'T-405', '--of', 'T-999', '--by', 'overseer']);
    const busy = task(['duplicate', 'T-403', '--of', 'T-402', '--by', 'overseer']);
    const queued = task(['duplicate', 'T-404', '--of', 'T-402', '--by', 'overseer']);
    const boardNow = () => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    await guard('293c 4: duplicate refuses a task that is its own copy, a T-x that is not on the board or in the done list, a task in progress, and a task queued for a train; each says why and the board is unchanged (fails before this fix: no such verb)', () => [
      same.status !== 0 && /cannot be a duplicate of itself/.test(out(same)) && unknown.status !== 0 && /T-999 is not on the board or in the done list/.test(out(unknown))
        && busy.status !== 0 && /T-403 is in progress/.test(out(busy)) && queued.status !== 0 && /T-404 is queued for a train/.test(out(queued))
        && ['T-403', 'T-404', 'T-405'].every((t) => boardNow().includes(`**${t}**`)) && !evs().some((e) => e.type === 'task.duplicate'),
      JSON.stringify([same, unknown, busy, queued].map(out)).slice(0, 2000)]);
    const ok = task(['duplicate', 'T-401', '--of', 'T-402', '--by', 'overseer', '--why', 'fixed by T-402']);
    const dEv = evs().filter((e) => e.type === 'task.duplicate');
    const doneText = fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8');
    await guard('293c 4: duplicate closes a waiting task without starting it: it leaves the board, is not on the done list (not landed work), and one task.duplicate event names both IDs and the why (fails before this fix: no such verb)', () => [
      ok.status === 0 && /T-401 is closed as a duplicate of T-402/.test(out(ok)) && !boardNow().includes('**T-401**') && !doneText.includes('T-401')
        && dEv.length === 1 && dEv[0].task === 'T-401' && dEv[0].meta?.of === 'T-402' && /fixed by T-402/.test(dEv[0].meta?.why || ''),
      JSON.stringify({ o: out(ok), dEv }).slice(0, 2000)]);
    const rows = probe(`import { attemptRows, buildAttempts } from ${u('harness/metrics.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const evs = readRecentEvents(20000);
console.log(JSON.stringify({ attempts: buildAttempts(evs).filter((a) => a.task === 'T-401').length, rows: attemptRows(evs).filter((r) => r.task === 'T-401').length }));`);
    await guard('293c 4: a duplicate is not counted as a failure: it has no session attempt in the metrics, so there is nothing to label failed (fails before this fix: it could only be closed with task impossible after task start)', () => [
      rows.attempts === 0 && rows.rows === 0, JSON.stringify(rows)]);
  }
  try { fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(S, { recursive: true, force: true }); } catch { /* the runner's sweep */ }
}
