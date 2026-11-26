/**
 * qa/selftest-298e.mjs — 2.98 (c): a task with a checklist lands in slices until its list is empty, and `task split`
 * makes child tasks from its open items so a second porter works while the first lane waits for a train. A plain task
 * closes on landing as before. A studio copy, a made-up engine repo and a land-script stand-in, as in
 * qa/selftest-293c.mjs; the engine train is the real one (runUnityTrain with the board's trainDeps).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest298E({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `298e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  write(S, 'studio/game.json', '{}\n');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298e.jsonl');
  const envOf = () => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S });
  const evs = eventsFileOf(evFile);
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-298e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const task = (args) => spawnSync(process.execPath, [path.join(S, 'harness', 'task.mjs'), ...args], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 300000 });
  const holds = () => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } };
  const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')); } catch { return []; } };
  const next = () => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
  const done = () => { try { return fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8'); } catch { return ''; } };
  const where = (id) => (done().includes(`**${id}**`) ? 'done' : (next().split('## BACKLOG')[1] || '').includes(`**${id}**`) ? 'backlog' : next().includes(`**${id}**`) ? 'in-progress' : 'gone');
  const line = (id, title, mark) => `- [${mark}] **${id}** [P1] (\`engine-porter\`) — ${title}`;
  write(S, 'studio/NEXT.md', `# Studio Task Queue\n\n## IN_PROGRESS\n${[['T-401', 'Port Fees rounding'], ['T-402', 'Port MapNav costs'], ['T-403', 'Port Game/Sim ticks'], ['T-501', 'Port tools/SimTests runner']].map(([i, t]) => line(i, t, '>')).join('\n')}\n\n## BACKLOG\n\n## DONE\n`);
  write(S, 'studio/DONE.md', '# Done\n');
  write(S, '.studio/engine/tasks.json', `${JSON.stringify(Object.fromEntries(['T-401', 'T-402', 'T-403', 'T-501'].map((i) => [i, { engine: 'unity', track: 'engine:unity' }])))}\n`);

  // ---- a made-up engine repo: one branch per lane; the land stand-in merges branches into the gate worktree ----
  const R = path.join(T, 'repo');
  const GW = path.join(T, 'gate');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main');
  write(R, 'Sim/State.cs', 'namespace Game.Sim { class State { } }\n');
  g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  g(R, 'checkout', '-q', '-b', 'dev');
  g(R, 'worktree', 'add', '-q', GW, 'port/main');
  const work = (br, file) => { g(R, 'checkout', '-q', br); write(R, file, `${br} ${file}\n`); g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} ${file}`); g(R, 'checkout', '-q', 'dev'); };
  for (const br of ['feat/a', 'feat/b', 'feat/c', 'feat/p1', 'feat/p2', 'feat/p']) g(R, 'branch', br, 'port/main');
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import { spawnSync } from 'node:child_process';
const [gw, ...srcs] = process.argv.slice(2);
const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: gw, encoding: 'utf8', windowsHide: true });
for (const s of srcs) { const m = git('merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git('merge', '--abort'); process.exit(2); } }
`);
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: `node "${fwd(landStub)}" "${fwd(GW)}" {branch}`, target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: false } } }, null, 2)}\n`);
  const Q = (lanes) => probe(`import { queueUnityTask } from ${u('harness/unity-train.mjs')};
const r = ${JSON.stringify(lanes)}.map(([task, branch, agent]) => queueUnityTask(process.cwd(), { engine: 'unity', task, branch, agent: agent || 'porter-a' }));
console.log(JSON.stringify(r.map((x) => ({ ok: x.ok, message: x.message }))));`);
  const TRAIN = () => probe(`import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const { trainDeps } = await import(${u('harness/task.mjs')});
const handed = [];
const r = await runUnityTrain({ root: process.cwd(), log: () => {}, deps: { ...trainDeps({}, { forDone: true }), handBack: (lane, note) => handed.push({ task: lane.task, note }) } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, handed }));`);
  const list = path.join(T, 'list.txt');
  fs.writeFileSync(list, '- Fees.Round\n- Fees.Total\n\n- [ ] Fees.Refund\n');

  try {
    // ================= e1, e7: a landing with open items is a slice; a task without a list closes =================
    const add = task(['add', 'Port the Fees rounding table', '--role', 'engine-porter', '--track', 'unity', '--checklist-file', list]);
    const added = (out(add).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const addedItems = added ? holds()[added]?.checklist || [] : [];
    for (const t of ['Fees.Round', 'Fees.Total', 'Fees.Refund']) task(['checklist', 'T-401', 'add', t]);
    work('feat/a', 'Fees.cs'); work('feat/b', 'MapNav.cs');
    const d1 = task(['done', 'T-401', '--train', '--agent', 'porter-a', '--branch', 'feat/a']);
    Q([['T-402', 'feat/b']]);
    const show = task(['show', 'T-401']);
    const t1 = TRAIN();
    const sl = evs().filter((e) => e.type === 'task.slice_landed' && e.task === 'T-401');
    await guard('2.98 (e1) a task with 3 open checklist items, queued with plain `task done --train`, lands as a slice: back in the backlog (ready), not done, a task.slice_landed event naming the open items; task done said "3 checklist item(s) are still open: queued as a slice" and task show says "0 of 3 done"; task add --checklist-file read one item a line (fails before this fix: the first landing closed the task)', () => [
      added && addedItems.map((i) => i.text).join() === 'Fees.Round,Fees.Total,Fees.Refund' && d1.status === 0 && /3 checklist item\(s\) are still open: queued as a slice; the task closes when the list is empty/.test(out(d1))
        && /"progress": "0 of 3 done"/.test(show.stdout) && t1.landed?.includes('T-401') && where('T-401') === 'backlog' && sl.length === 1 && /3 checklist item\(s\) are still open/.test(sl[0].msg),
      JSON.stringify({ add: out(add).slice(-300), addedItems, d1: out(d1).slice(-600), show: show.stdout.slice(0, 400), t1, where: where('T-401') })]);
    await guard('2.98 (e7) a task with no checklist lands in the same train and closes as it always did (one task.done, no slice)', () => [
      t1.landed?.includes('T-402') && where('T-402') === 'done' && !evs().some((e) => e.type === 'task.slice_landed' && e.task === 'T-402') && evs().filter((e) => e.type === 'task.done' && e.task === 'T-402').length === 1,
      JSON.stringify({ t1, where: where('T-402') })]);

    // ================= e4: a skip needs a reason and then counts as not open =================
    const noWhy = task(['checklist', 'T-401', 'skip', 'Fees.Refund']);
    const stillOpen = (holds()['T-401']?.checklist || []).find((i) => i.text === 'Fees.Refund')?.state;
    const skip = task(['checklist', 'T-401', 'skip', 'Fees.Refund', '--why', 'refunds are not in this game']);
    const ls = task(['checklist', 'T-401', 'list']);
    const direct = task(['done', 'T-401', '--agent', 'porter-a']);
    await guard('2.98 (e4) a skip without --why is refused and changes nothing; with a reason the item counts as not open ("1 of 3 done (1 skipped)", the reason in the list); a direct `task done` (no train) with items open is refused at once and closes nothing (fails before this fix: no checklist command)', () => [
      noWhy.status !== 0 && /needs a reason/.test(out(noWhy)) && stillOpen === 'open' && skip.status === 0 && /1 of 3 done \(1 skipped\)/.test(out(ls)) && /\[-\] Fees\.Refund \(skipped: refunds are not in this game\)/.test(out(ls))
        && direct.status !== 0 && /2 checklist item\(s\) are still open\..*Nothing was closed/.test(out(direct)) && where('T-401') === 'backlog',
      JSON.stringify({ noWhy: out(noWhy), skip: out(skip), ls: out(ls), direct: out(direct).slice(-500) })]);

    // ================= e2: the last item done, the next landing closes it =================
    task(['checklist', 'T-401', 'done', 'fees.round', 'Fees.Total']);
    work('feat/a', 'Fees2.cs');
    const d2 = task(['done', 'T-401', '--train', '--agent', 'porter-a', '--branch', 'feat/a']);
    const t2 = TRAIN();
    await guard('2.98 (e2) once every item is done or skipped, task done --train no longer says "still open" and the next landing closes the task (one task.done)', () => [
      d2.status === 0 && !/still open/.test(out(d2)) && t2.landed?.includes('T-401') && where('T-401') === 'done' && evs().filter((e) => e.type === 'task.done' && e.task === 'T-401').length === 1,
      JSON.stringify({ d2: out(d2).slice(-400), t2, where: where('T-401') })]);

    // ================= e3: --final closes it now, the open items in the note =================
    for (const t of ['Ticks.Step', 'Ticks.Pause']) task(['checklist', 'T-403', 'add', t]);
    work('feat/c', 'Ticks.cs');
    const d3 = task(['done', 'T-403', '--train', '--final', '--agent', 'porter-a', '--branch', 'feat/c']);
    const t3 = TRAIN();
    await guard('2.98 (e3) task done --train --final on a task with 2 open items queues it without the slice words, and its landing closes it with "closed with 2 checklist item(s) open: Ticks.Step; Ticks.Pause" on its done line; the mark is cleared (fails before this fix: no --final, no list)', () => [
      d3.status === 0 && !/still open/.test(out(d3)) && t3.landed?.includes('T-403') && where('T-403') === 'done' && /closed with 2 checklist item\(s\) open: Ticks\.Step; Ticks\.Pause/.test(done()) && !holds()['T-403']?.final,
      JSON.stringify({ d3: out(d3).slice(-400), t3, done: done().slice(0, 800) })]);

    // ================= e5, e6: split — a second porter works while the first lane waits; the parent closes with its parts =================
    for (const t of ['Runner.Load', 'Runner.Run', 'Runner.Report', 'Runner.Filter']) task(['checklist', 'T-501', 'add', t]);
    work('feat/p', 'Runner.cs');
    Q([['T-501', 'feat/p']]);
    probe(`import { claim } from ${u('harness/lock.mjs')}; claim('task:T-501', 'porter-a'); console.log('{}');`);
    const startParent = task(['start', 'T-501', '--agent', 'porter-b']);
    const split = task(['split', 'T-501', '--every', '2', '--by', 'overseer']);
    const kids = holds()['T-501']?.split?.children || [];
    const startKid = kids[0] ? task(['start', kids[0], '--agent', 'porter-b']) : null;
    const kidItems = kids.map((k) => (holds()[k]?.checklist || []).map((i) => i.text).join());
    const engineRec = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'tasks.json'), 'utf8')); } catch { return {}; } })();
    await guard('2.98 (e5) while T-501\'s lane waits in the engine queue (a second `task start` on it is refused), `task split T-501 --every 2` makes two normal engine tasks from its 4 open items (2 each, on its engine track), marks the items as moved, and a second porter starts one of them at once (fails before this fix: "split" was no command; the only way in was the refused start)', () => [
      !/"owner": "porter-b"/.test(startParent.stdout) && split.status === 0 && kids.length === 2 && kidItems.join('|') === 'Runner.Load,Runner.Run|Runner.Report,Runner.Filter'
        && kids.every((k) => engineRec[k]?.track === 'engine:unity') && (holds()['T-501']?.checklist || [0]).every((i) => i.state === 'split') && startKid && /"owner": "porter-b"/.test(startKid.stdout),
      JSON.stringify({ startParent: out(startParent).slice(-300), split: out(split).slice(-400), kids, kidItems, holds: holds()['T-501'], rec: kids.map((k) => engineRec[k]), startKid: startKid && out(startKid).slice(0, 300) })]);

    const tp = TRAIN();
    const parentStart = task(['start', 'T-501', '--agent', 'porter-c']);
    for (const [k, br] of kids.map((k, i) => [k, `feat/p${i + 1}`])) { work(br, `${k}.cs`); task(['checklist', k, 'done', '1', '2']); }
    Q(kids.map((k, i) => [k, `feat/p${i + 1}`, i ? 'porter-a' : 'porter-b']));
    const tk = TRAIN();
    const parentDone = evs().filter((e) => e.type === 'task.done' && e.task === 'T-501');
    await guard('2.98 (e6) the parent\'s queued lane lands as a slice while its parts are open (back in the backlog, and a new start on it is refused with "split into"); both parts land in one train as two lanes, and the parent then closes by itself with "its parts landed" (fails before this fix: the parent closed at its first landing)', () => [
      tp.landed?.includes('T-501') && parentStart.status !== 0 && /split into/.test(out(parentStart)) && tk.landed?.length === 2 && kids.every((k) => where(k) === 'done')
        && where('T-501') === 'done' && parentDone.length === 1 && /its parts landed/.test(done()),
      JSON.stringify({ tp, parentStart: out(parentStart).slice(-400), tk, kids: kids.map(where), parent: where('T-501'), q: queue() })]);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
