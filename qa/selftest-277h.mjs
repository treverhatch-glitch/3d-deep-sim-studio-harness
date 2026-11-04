/**
 * qa/selftest-277h.mjs — 2.77.0 (helper h): the merge train, second batch (the crew's Priority 9 and B-96).
 *   P9.1    main moving while a train verifies: an added approval, the Bible's prose, decisions and asks are record files
 *           (the verify stands); a file only some checks read (the Bible's controls list) re-runs just those checks on
 *           the new tree (green lands on the same verify, red verifies again).
 *   P9.2    a task queued for the train can't be started (task start, the supervisor's pick); queueing the same commit
 *           again never voids its release.
 *   P9.3/6  known-red-on-main: a test red on main itself (it fails alone on main's tree) is listed once with its evidence;
 *           a train whose only reds are such tests lands (reported, not blocking), never for a test the lane changed;
 *           the entry clears when main is green on it.
 *   B-96    a new lane copy for a task gets the task's newest approval commit from any lane branch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest277H({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-277h-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `277h-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-277h.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-277h-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);

  const want = (k) => !process.env.ONLY_277H || process.env.ONLY_277H.split(',').includes(k);
  // A studio with made-up tasks T-941..T-960 in progress, lane copies made by git, and a train run in a probe with
  // stand-in board steps (the lane's own check passes; closing a task is a no-op).
  const tasks = Array.from({ length: 20 }, (_, i) => `T-${941 + i}`);
  const trainStudio = (name, gates, setup = () => {}) => {
    const st = studio(name, (S) => {
      writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates }, null, 2)}\n`);
      writeIn(S, 'studio/NEXT.md', `# Studio Task Queue\n\n## IN_PROGRESS\n${tasks.map((t) => `- [>] **${t}** [P1] (\`builder\`) — made-up task ${t}`).join('\n')}\n\n## BACKLOG\n\n## DONE\n`);
      fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
      setup(S);
    });
    const { S } = st;
    st.mainHas = (rel) => gitIn(S, 'cat-file', '-e', `main:${rel}`).status === 0;
    st.lane = (lname, task, files, { tags = [task], from = 'main' } = {}) => {
      const d = path.join(S, '.lanes', lname);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${lname}`, d, from);
      for (const [rel, text] of Object.entries(files)) writeIn(d, rel, text);
      gitIn(d, 'add', '-A');
      gitIn(d, 'commit', '-q', '--no-verify', '-m', `${task}: work`, ...tags.map((t) => ['-m', `Studio-Task: ${t}`]).flat());
      return { task, agent: `builder-${lname}`, dir: d, branch: `lane/${lname}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date().toISOString() };
    };
    st.setQueue = (list) => writeIn(S, '.studio/train/queue.json', `${JSON.stringify(list, null, 2)}\n`);
    st.train = (tname, extraEnv = {}) => probe(S, { ...st.env, ...extraEnv }, `train-${tname}`, `import { runTrain } from ${u(S, 'harness/train.mjs')};
const calls = { handBack: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: () => ({ ok: true }), handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(0, 800)]) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, held: r.held, verifies: r.verifies, message: r.message, calls, logs: logs.slice(-30) }));
`);
    return st;
  };

  // ---- P9.1: main moving with record files while the train verifies ----
  if (want('p91')) {
    // The game's check commits a spec's files on the main checkout once, while the train verifies (as a person's
    // approval or the Director's Bible edit would). The controls check reads the Bible's controls list.
    const spec = path.join(tmpRoot, `move-277h-${process.pid}.json`);
    const st = trainStudio('p91', [
      { id: 'controls', command: 'node qa/controls-277h.mjs', required: true, lite: true, cache: false },
      { id: 'game', command: 'node qa/move-277h.mjs', required: true, lite: true, cache: false },
    ], (S) => {
      writeIn(S, 'qa/controls-277h.mjs', "import fs from 'node:fs';\nlet t = '';\ntry { t = fs.readFileSync('studio/bible/controls.json', 'utf8'); } catch {}\nif (t.includes('BROKEN')) { console.log('[controls] FAIL a control has no passing result'); process.exit(1); }\nconsole.log('[controls] PASS');\n");
      writeIn(S, 'qa/move-277h.mjs', [
        "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
        `const spec = ${JSON.stringify(spec)};`,
        "if (fs.existsSync(spec) && process.env.STUDIO_MAIN_ROOT) {",
        "  const s = JSON.parse(fs.readFileSync(spec, 'utf8')); fs.rmSync(spec);",
        "  const root = process.env.STUDIO_MAIN_ROOT;",
        "  for (const [rel, text] of Object.entries(s.files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }",
        "  const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];",
        "  spawnSync('git', ['add', '--', ...Object.keys(s.files)], { cwd: root, env, windowsHide: true });",
        "  const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', s.message, '--', ...Object.keys(s.files)], { cwd: root, env, encoding: 'utf8', windowsHide: true });",
        "  if (c.status !== 0) { console.error('FAIL could not move main: ' + c.stderr); process.exit(1); }",
        "}",
        "console.log('[game] PASS');", ''].join('\n'));
      writeIn(S, 'studio/bible/controls.json', `${JSON.stringify({ controls: [{ id: 'pan', input: 'drag' }] }, null, 2)}\n`);
      writeIn(S, 'studio/approvals/protected-old.json', '{"approval":{"by":"the-owner"},"files":[]}\n');
    });
    const { ev } = st;
    const moved = (since) => events(ev).slice(since).filter((e) => e.type === 'task.train.board_move');
    await guard('2.77.0 (P9.1): main gains a new approval, a decision record, an ask and the Bible\'s prose while the train verifies: the verify stands (ONE verify, a board_move event naming them), the lane lands (fails on 2.76.0: "it changes studio/approvals/…, which is not a board or record file", a second verify)', () => {
      const n0 = events(ev).length;
      const L = st.lane('p91a', 'T-941', { 'docs/p91a-277h.md': '# a\n' });
      st.setQueue([L]);
      fs.writeFileSync(spec, JSON.stringify({ message: 'owner: approval, decision, ask, Bible prose', files: { 'studio/approvals/protected-945b6542be113845.json': '{"approval":{"by":"the-owner"},"files":[]}\n', 'studio/decisions/0003-made-up.md': '# Decision\n', 'studio/asks/A-901.json': '{"id":"A-901"}\n', 'studio/bible/BIBLE.md': '# The Bible\n\nmore\n' } }));
      const t = st.train('p91a');
      const bm = moved(n0)[0];
      return [t.landed?.includes('T-941') && t.verifies === 1 && bm && bm.meta.files.length === 4 && st.mainHas('studio/asks/A-901.json'), JSON.stringify({ t, bm }).slice(0, 3000)];
    });
    await guard('2.77.0 (P9.1): main changes the Bible\'s controls list (read by the controls check) while the train verifies: only that check runs again on the new tree, green, and the lane lands on the same verify (fails on 2.76.0: a second full verify)', () => {
      const n0 = events(ev).length;
      const L = st.lane('p91b', 'T-942', { 'docs/p91b-277h.md': '# b\n' });
      st.setQueue([L]);
      fs.writeFileSync(spec, JSON.stringify({ message: 'director: a new control', files: { 'studio/bible/controls.json': `${JSON.stringify({ controls: [{ id: 'pan', input: 'drag' }, { id: 'zoom', input: 'wheel' }] }, null, 2)}\n` } }));
      const t = st.train('p91b');
      const bm = moved(n0)[0];
      return [t.landed?.includes('T-942') && t.verifies === 1 && bm && (bm.meta.rechecked || []).join(',') === 'controls', JSON.stringify({ t, bm }).slice(0, 3000)];
    });
    await guard('2.77.0 (P9.1, the guard): main changes the controls list so the controls check fails: the re-check is red, so the train verifies again in full and the lane doesn\'t land on the old verify; a changed (not added) approval is re-checked too, never just accepted (fails on 2.76.0 in its second part: boardOnlyMove had no re-check list)', () => {
      const n0 = events(ev).length;
      const L = st.lane('p91c', 'T-943', { 'docs/p91c-277h.md': '# c\n' });
      st.setQueue([L]);
      fs.writeFileSync(spec, JSON.stringify({ message: 'director: break a control', files: { 'studio/bible/controls.json': '{"controls":"BROKEN"}\n' } }));
      const t = st.train('p91c');
      const probeM = probe(st.S, st.env, 'bom', `import { boardOnlyMove } from ${u(st.S, 'harness/train.mjs')};
import { spawnSync } from 'node:child_process';
const g = (...a) => spawnSync('git', a, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }).stdout.trim();
const before = g('rev-parse', 'main');
const fsm = await import('node:fs');
fsm.writeFileSync('studio/approvals/protected-old.json', '{"approval":{"by":"someone-else"},"files":["x"]}\\n');
g('commit', '-q', '--no-verify', '-am', 'edit an approval');
const r = boardOnlyMove(process.cwd(), before, g('rev-parse', 'main'), undefined, { lanes: [] });
console.log(JSON.stringify(r));
`);
      return [!t.landed?.includes('T-943') && t.verifies >= 2 && !moved(n0).length && probeM.ok === true && (probeM.recheck || []).includes('protected'), JSON.stringify({ t, probeM }).slice(0, 3000)];
    });
    fs.writeFileSync(path.join(st.S, 'studio/bible/controls.json'), `${JSON.stringify({ controls: [{ id: 'pan', input: 'drag' }] }, null, 2)}\n`);
    gitIn(st.S, 'commit', '-q', '--no-verify', '-am', 'controls fixed');
  }

  // ---- P9.2: a task queued for the train can't be started by another session ----
  if (want('p92')) {
    const st = trainStudio('p92', [{ id: 'game', command: 'node -e "process.exit(0)"', required: true, lite: true, cache: false }], (S) => {
      writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-952** [P1] (`builder`) — in progress, queued\n\n## BACKLOG\n- [ ] **T-951** [P0] (`builder`) — waiting, queued and released\n- [ ] **T-953** [P1] (`builder`) — waiting, not queued\n\n## DONE\n');
    });
    const { S, env } = st;
    const head = gitIn(S, 'rev-parse', 'HEAD').stdout.trim();
    st.setQueue([
      { task: 'T-951', agent: 'builder-a', dir: path.join(S, '.lanes', 'builder-a'), branch: 'lane/builder-a', head, at: new Date().toISOString(), held: { tier: 'C', why: 'protected', head }, released: { by: 'the-owner', head, at: new Date().toISOString() } },
      { task: 'T-952', agent: 'builder-b', dir: path.join(S, '.lanes', 'builder-b'), branch: 'lane/builder-b', head, at: new Date().toISOString() },
    ]);
    const tk = (cmd, agent) => run(S, `node harness/task.mjs ${cmd}${agent ? ` --agent ${agent}` : ''}`, { ...env, STUDIO_LOCK_OWNER: agent || '' });
    await guard('2.77.0 (P9.2): a waiting task whose lane is queued (and released) for the train is neither offered (task next) nor startable (task start: "queued for the merge train"); an in-progress queued task can\'t be claimed by another agent (its lane agent keeps it); a task not queued starts as before (fails on 2.76.0: builder-z started T-951 and T-952)', () => {
      const next = tk('next --role builder', 'builder-z');
      const s1 = tk('start T-951', 'builder-z');
      const s2 = tk('start T-952', 'builder-z');
      const s3 = tk('start T-952', 'builder-b');
      const s4 = tk('start T-953', 'builder-y');
      const ok = !/T-951/.test(out(next)) && s1.status !== 0 && /queued for the merge train/.test(out(s1)) && s2.status !== 0 && /queued for the merge train/.test(out(s2)) && s3.status === 0 && s4.status === 0;
      return [ok, [next, s1, s2, s3, s4].map((r) => `${r.status}: ${out(r).slice(-300)}`).join('\n---\n')];
    });
    await guard('2.77.0 (P9.2): a second lane copy queueing the same commit for a released task keeps the release (passes on 2.76.0 too: the release goes with the commit)', () => {
      const r = probe(S, env, 'requeue', `import { enqueue, readQueue } from ${u(S, 'harness/train.mjs')};
enqueue(process.cwd(), { task: 'T-951', agent: 'builder-c', dir: ${JSON.stringify(path.join(S, '.lanes', 'builder-c'))}, branch: 'lane/builder-c', head: ${JSON.stringify(head)} });
console.log(JSON.stringify(readQueue(process.cwd()).find((e) => e.task === 'T-951')));
`);
      return [r.released?.by === 'the-owner' && r.agent === 'builder-c', JSON.stringify(r)];
    });
  }
}
