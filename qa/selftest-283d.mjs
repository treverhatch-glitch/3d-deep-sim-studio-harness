/**
 * qa/selftest-283d.mjs — 2.83 (d): the task CLI's missing commands, driven through the real CLI in a studio copy.
 *
 *   after     task after <ID> --remove / --set / --clear edit a task's --after list (studio/task-holds.json); an id that is
 *             on neither NEXT.md nor DONE.md is refused by task add --after and task after
 *   train     task train dequeue <ID> [--engine x]; a word that is not a train subcommand starts no train; status lists the
 *             running batch and the waiting queue apart
 *   track     task track <ID> web; a native studio sends a task that names web code to the web track (harness/native.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283D({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s283d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_TRAIN_DETACH: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-283d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `283d-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setGame = (game) => write(S, 'studio/game.json', `${JSON.stringify(game, null, 2)}\n`);
  setGame({ engines: { unity: {} } });
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-283d.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const task = (args, extra = {}) => run(S, `node harness/task.mjs ${args}`, envOf(extra));
  const holds = () => readJson(path.join(S, 'studio', 'task-holds.json'))?.tasks || {};
  const afterOf = (id) => holds()[id]?.after || [];
  const trainFile = (f) => path.join(S, '.studio', f);
  const reset = () => { for (const x of ['train', 'locks']) fs.rmSync(trainFile(x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-283d-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const nextText = () => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');

  // ================= 1. task after --remove / --set / --clear =================
  {
    const a1 = task('after T-003 T-001,T-002 --by human');
    const list1 = [...afterOf('T-003')];
    const rm = task('after T-003 --remove T-001 --by human');
    const list2 = [...afterOf('T-003')];
    const st = task('after T-003 --set T-004,T-005 --by human');
    const list3 = [...afterOf('T-003')];
    const noop = task('after T-003 --remove T-099 --by human');
    const list3b = [...afterOf('T-003')];
    const cl = task('after T-003 --clear --by human');
    const list4 = [...afterOf('T-003')];
    const unk = task('after T-777 --clear --by human');
    const holdEvents = events().filter((e) => e.type === 'task.hold' && e.task === 'T-003');
    await guard('2.83 task after: an id is added, --remove drops the named ones, --set replaces the list, --clear empties it, each prints the resulting list and emits a task.hold event, and an unknown task id exits 1 (fails before this fix: there was no `task after` and the overseer edited studio/task-holds.json by hand)', () => [
      a1.status === 0 && list1.join() === 'T-001,T-002' && rm.status === 0 && list2.join() === 'T-002' && /now waits for: T-002/.test(out(rm))
        && st.status === 0 && list3.join() === 'T-004,T-005' && noop.status === 0 && list3b.join() === 'T-004,T-005'
        && cl.status === 0 && list4.length === 0 && /waits for no task/.test(out(cl)) && !holds()['T-003']?.after
        && unk.status === 1 && holdEvents.length >= 4,
      `${out(a1)}|${out(rm)}|${out(st)}|${out(noop)}|${out(cl)}|${out(unk)} lists ${[list1, list2, list3, list4].map((l) => l.join('+')).join(' / ')} events ${holdEvents.length}`,
    ]);
  }

  // ================= 2. an unknown --after id is refused =================
  {
    const before = nextText();
    const add = task('add "Fix the fee rounding" --after T-999 --lane game/demo --agent producer-1', { STUDIO_ROLE: 'producer' });
    const same = nextText() === before;
    const hb = JSON.stringify(holds());
    const af = task('after T-004 T-999 --by human');
    const holdsSame = JSON.stringify(holds()) === hb;
    const okDone = task('after T-004 T-000 --by human');
    const okOpen = task('after T-004 T-001 --by human');
    await guard('2.83 --after on an unknown id: task add --after T-999 queues nothing and exits 1, task after <ID> T-999 exits 1 with a plain reason and leaves the list alone, an id on the done list or the open board is accepted (fails before this fix: the planner then reported "T-x waits for T-y, which isn\'t on the board" 41 times)', () => [
      add.status === 1 && same && /T-999 is not a task id on the board/.test(out(add)) && af.status === 1 && /T-999 is not a task id on the board/.test(out(af)) && holdsSame
        && okDone.status === 0 && okOpen.status === 0 && afterOf('T-004').join() === 'T-000,T-001',
      `add ${add.status} same ${same} af ${af.status} holdsSame ${holdsSame} done ${okDone.status} open ${okOpen.status} list ${afterOf('T-004')} ${out(add).slice(0, 150)}`,
    ]);
  }

  // ================= 3. task train dequeue =================
  {
    // T-005 is in progress and its lane is queued in the game's train and in the unity queue.
    const start = task('start T-005 --agent claude-d');
    const inProg = /IN_PROGRESS[\s\S]*\*\*T-005\*\*[\s\S]*## BACKLOG/.test(nextText());
    const entry = (t) => ({ task: t, agent: 'claude-d', branch: 'feat/a', head: 'a'.repeat(40), at: '2026-01-01T00:00:00.000Z' });
    fs.mkdirSync(trainFile('train'), { recursive: true });
    fs.writeFileSync(trainFile('train/queue.json'), JSON.stringify([entry('T-005'), entry('T-004')]));
    fs.writeFileSync(trainFile('train/unity-queue.json'), JSON.stringify([entry('T-005'), entry('T-004')]));
    // a train running right now, with T-004 in its batch
    fs.mkdirSync(trainFile('locks'), { recursive: true });
    fs.writeFileSync(trainFile('locks/unity-train.lock'), JSON.stringify({ id: 'U-1', pid: process.pid, at: Date.now(), by: 'x', lanes: ['T-004'] }));
    const busy = task('train dequeue T-004 --engine unity --by human');
    const stillQueued = (readJson(trainFile('train/unity-queue.json')) || []).map((e) => e.task).join();
    const dq = task('train dequeue T-005 --engine unity --by human');
    const unityLeft = (readJson(trainFile('train/unity-queue.json')) || []).map((e) => e.task).join();
    const gameQ = (readJson(trainFile('train/queue.json')) || []).map((e) => e.task).join();
    const backBack = /BACKLOG[\s\S]*\*\*T-005\*\*/.test(nextText()) && !/IN_PROGRESS[\s\S]*\*\*T-005\*\*[\s\S]*## BACKLOG/.test(nextText());
    const gd = task('train dequeue T-005 --by human');
    const miss = task('train dequeue T-005 --by human');
    const gameLeft = (readJson(trainFile('train/queue.json')) || []).map((e) => e.task).join();
    const evs = events().filter((e) => e.type === 'task.train.dequeued');
    await guard('2.83 task train dequeue: removes the lane from the engine queue (--engine) or the game queue, emits task.train.dequeued, hands the task back so it can start again, and refuses (exit 1) a lane that is in a train running now or one that is not queued (fails before this fix: no such subcommand, the overseer called dequeueUnity from node)', () => [
      start.status === 0 && inProg && busy.status === 1 && /running right now/.test(out(busy)) && stillQueued === 'T-005,T-004'
        && dq.status === 0 && unityLeft === 'T-004' && gameQ === 'T-005,T-004' && backBack && /handed back/.test(out(dq))
        && gd.status === 0 && gameLeft === 'T-004' && miss.status === 1 && /not in the train queue/.test(out(miss)) && evs.length === 2 && evs[0].meta?.engine === 'unity',
      `${out(start)}|${out(busy)}|${out(dq)}|${out(gd)}|${out(miss)} queues ${stillQueued} / ${unityLeft} / ${gameQ} / ${gameLeft} back ${backBack} events ${evs.length}`,
    ]);

    // ---- 5. status: the running batch and the waiting queue as two lists (the lock and T-004 from above) ----
    fs.writeFileSync(trainFile('train/unity-queue.json'), JSON.stringify([entry('T-004'), entry('T-003')]));
    const stt = task('train status --engine unity');
    await guard('2.83 task train status --engine: lists the running train\'s batch and the waiting queue as two lists: the branch the train is landing on the first, the one that waits on the second (fails before this fix: the running batch was only inside the "train running" line)', () => [
      stt.status === 0 && /Running unity train batch \(1\): T-004/i.test(out(stt)) && /1 \w+ branch\(es\) wait in the queue/.test(out(stt)) && !/\n  T-004 /.test(out(stt)) && /\n  T-003 /.test(out(stt)) && !/No \w+ branch waits/.test(out(stt)),
      out(stt),
    ]);
  }

  // ================= 4. an unknown train subcommand starts nothing =================
  {
    reset();
    fs.mkdirSync(trainFile('train'), { recursive: true });
    const marks = () => events().filter((e) => /train/i.test(String(e.type || '')) && !/dequeued|left/.test(e.type)).length;
    const r1 = task('train log --engine unity');
    const r2 = task('train frobnicate');
    const r3 = task('train --unity log');
    const r4 = task('train status --engine unity');
    const ranTrain = fs.existsSync(trainFile('train/unity-last.json')) || fs.existsSync(trainFile('locks/train.lock'));
    await guard('2.83 task train <unknown word>: prints the usage, exits 2 and starts no train, with or without --engine/--unity; `train status` still works (fails before this fix: `train log --engine unity` started a real train)', () => [
      [r1, r2, r3].every((r) => r.status === 2 && /not a train subcommand, so no train was started/.test(out(r))) && !ranTrain && marks() === 0 && r4.status === 0,
      `${r1.status}:${out(r1)}|${r2.status}|${r3.status}|${r4.status} events ${marks()} ranTrain ${ranTrain}`,
    ]);
  }

  // ================= 6. task track <ID> web =================
  {
    reset();
    const add = task('add "Add fuel pricing to the apron" --track engine:unity --lane Assets/Scripts --agent producer-1', { STUDIO_ROLE: 'producer' });
    const id = events().filter((e) => e.type === 'task.added').pop()?.task;
    const before = id ? task(`track ${id}`) : { stdout: '' };
    const set = id ? task(`track ${id} web --by human`) : { stdout: '', status: 9 };
    const after = id ? task(`track ${id}`) : { stdout: '' };
    const r = probe(`import { engineTask } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness/engine-tracks.mjs')).href)};
console.log(JSON.stringify({ rec: engineTask(${JSON.stringify(id || 'none')}, { root: process.cwd() }) }));`);
    await guard('2.83 task track <ID> web: a task on an engine track is set back to the web track: its engine record is gone, `track <ID>` says it has none, and a task.track event is emitted (fails before this fix: only engine:<name> was accepted)', () => [
      id && /engine:unity/.test(out(before)) && set.status === 0 && /web track/.test(out(set)) && /has no engine track/.test(out(after)) && r.rec === null
        && events().some((e) => e.type === 'task.track' && e.task === id && e.meta?.track === 'web'),
      `${out(add)}|${out(before)}|${out(set)}|${out(after)}|${JSON.stringify(r)}`,
    ]);
  }

  // ================= 7. native studio: web code goes to the web track =================
  {
    reset();
    setGame({ game: 'demo', native: 'unity', engines: { unity: {} } });
    const add = (title, more = '') => { const n = events().filter((e) => e.type === 'task.added').length; const r = task(`add "${title}" ${more} --agent producer-1`, { STUDIO_ROLE: 'producer' }); const e = events().filter((x) => x.type === 'task.added')[n]; return { r, track: e?.meta?.track ?? null }; };
    const w1 = add('Fix the fee rounding rules in game/demo/sim/fees.ts', '--lane game/demo/sim');
    const w2 = add('Fix the TypeScript fee total in fees.ts');
    const w3 = add('Rules bug in the economy', '--scope web/demo/rules.js');
    const e1 = add('Add tow-truck pricing to the gate');
    const e2 = add('Add the ramp prefab under Assets/Scripts/Ramp.cs');
    const w4 = add('Fix the hub rounding', '--track engine:unity --lane game/demo/sim');
    await guard('2.83 native studio: a builder task with no --track that names a path under game/<game>/ (title or --lane) or a .ts file goes on the web track and says "names web code ... --track engine:unity to override"; --scope web code too; an engine-only task still gets engine:unity; an explicit --track is kept (fails before this fix: the TypeScript bug task went to the engine track)', () => [
      w1.track === 'web' && w2.track === 'web' && w3.track === 'web' && /names web code \(game\/demo\/sim\/fees\.ts is the web game's folder\): web track; --track engine:unity to override/.test(out(w1.r)) && /fees\.ts is a web file/.test(out(w2.r))
        && e1.track === 'engine:unity' && e2.track === 'engine:unity' && !/names web code/.test(out(e1.r) + out(e2.r)) && w4.track === 'engine:unity',
      [w1, w2, w3, e1, e2, w4].map((x) => `${x.track} ${out(x.r).replace(/\s+/g, ' ').slice(0, 110)}`).join(' | '),
    ]);
    // the pure function
    const mk = (name, game) => { const R = path.join(T, `web-${name}`); write(R, 'studio/game.json', JSON.stringify(game)); return fwd(R); };
    const roots = { native: mk('n', { game: 'demo', native: 'unity', engines: { unity: {} } }), plain: mk('p', { game: 'demo', engines: { unity: {}, godot: {} } }), off: mk('o', { game: 'demo', native: false, engines: { unity: {} } }) };
    const p = probe(`import { webCodeNamed } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness/native.mjs')).href)};
const r = ${JSON.stringify(roots)};
console.log(JSON.stringify({
  folder: webCodeNamed('fix rounding in cartridges/demo/sim/fees', r.native), dotted: webCodeNamed('see ./web/demo/a', r.native), other: webCodeNamed('fix Assets/game/demo.cs and engine/game/demo/x', r.native),
  ts: webCodeNamed('Fix the fee rounding in fees.ts', r.native), tsx: webCodeNamed('Panel.tsx crashes', r.native), mjs: webCodeNamed('harness/task.mjs is slow', r.native),
  engine: webCodeNamed('Add Assets/Scripts/Fuel.cs and Assets/Prefabs/Ramp.prefab', r.native), product: webCodeNamed('Upgrade Node.js for the build', r.native), empty: webCodeNamed('', r.native),
  plain: webCodeNamed('fix fees.ts in game/demo/sim', r.plain), off: webCodeNamed('fix fees.ts in game/demo/sim', r.off),
}));`);
    await guard('2.83 webCodeNamed (pure): a path under the web game folder or a .ts/.tsx/.mjs file name is web code with the reason; an engine path only, a bare "Node.js", an empty text and another folder\'s game/demo are not; a studio that is not native is untouched (fails before this fix: the function did not exist)', () => [
      p.folder?.web && /cartridges\/demo\/sim\/fees/.test(p.folder.why) && p.dotted?.web && p.ts?.web && /fees\.ts/.test(p.ts.why) && p.tsx?.web && p.mjs?.web
        && !p.engine?.web && !p.product?.web && !p.empty?.web && !p.other?.web && !p.plain?.web && !p.off?.web && p.plain?.why === '',
      JSON.stringify(p),
    ]);
  }
}
