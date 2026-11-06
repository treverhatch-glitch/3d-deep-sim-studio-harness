/**
 * qa/selftest-279b.mjs — 2.79 (b): the 2.78.2 train and lane-copy regressions.
 *   - A queued lane keeps its copy when its session ends (agent.mjs dropCopies); an unqueued one is removed as before.
 *   - Nothing writes .lanes/<name>/.studio after the copy is gone (event.mjs boardRoot / STUDIO_STATE_DIR resolve <main>).
 *   - A lane folder with no .git is not a copy: laneNow says so (never "on main"), the train moves the folder to
 *     .studio/lane-leftovers/ and makes the copy again from the lane's branch.
 *   - Hand-backs the train tags infra (meta.handBackCause) never count toward STUDIO_TRAIN_MAX_HANDBACKS.
 *   - `train auto off` stops every automatic train start (task done's kick, the speculative train, the daemon's pass); a
 *     person's own `task train` still runs.
 *   - The queue write retries a rename that Windows (or anything) refuses for a moment (EPERM/EBUSY).
 *   - A record whose pid is now another program's (a different start identity) is not alive.
 * A tiny studio (a git repo made from the harness copy) with lane copies made by the harness, as selftest-2782a.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest279B({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch {} if (v) return true; if (Date.now() - t0 > ms) return false; await wait(200); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_TEST_LOADAVG: '0',
    STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LANE_LIVE_MIN: '0', STUDIO_LANDING_BUILD: 'off', STUDIO_TRAIN_PIPELINE: 'auto',
    STUDIO_FLAKE_TRIAGE: 'off', STUDIO_WHOLE_GAME: 'off', STUDIO_SLOW_TIER: 'off', STUDIO_VERIFY_KEY_DIR: path.join(tmpRoot, 'verify-keys-279b'),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279b-${process.pid}.pem`),
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `279b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    writeIn(S, '.studio/keep', '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/check.mjs', "console.log('ok');\n");
    writeIn(S, 'game/demo/notes/shared.md', '# Shared\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    // No AGENT_EVENTS_FILE: the events go where the code sends them (main's .studio/events.jsonl).
    const env = { ...base, STUDIO_MAIN_ROOT: '' };
    delete env.STUDIO_MAIN_ROOT;
    const evs = () => textIn(S, '.studio/events.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    return { S, env, evs };
  };
  const node = (cwd, args, env, timeout = 240000) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const task = (cwd, line, env, timeout) => node(cwd, ['harness/task.mjs', ...line], env, timeout);
  const probe = (S, code, env) => { const f = path.join(S, `.probe-279b-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  /** A task and its lane copy (.lanes/<agent>) made by the harness, with one commit on its branch. */
  const lane = (st, agent, title) => {
    const { S, env } = st;
    const a = task(S, ['add', title, '--role', 'builder', '--priority', 'P1'], env);
    const id = (out(a).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const lp = path.join(S, `.lane-279b-${++n}.mjs`);
    fs.writeFileSync(lp, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const mk = node(S, [lp, agent, id], env);
    const ld = path.join(S, '.lanes', agent);
    const as = { ...env, STUDIO_LOCK_OWNER: agent };
    const s1 = task(ld, ['start', id, '--agent', agent], as);
    writeIn(ld, `game/demo/notes/${agent}.md`, `# ${agent}\n`);
    g(ld, 'add', '--', `game/demo/notes/${agent}.md`);
    const c = g(ld, 'commit', '-qm', `${id}: ${title}`, '--no-verify');
    const branch = g(ld, 'symbolic-ref', '--short', 'HEAD').stdout.trim();
    const head = g(ld, 'rev-parse', 'HEAD').stdout.trim();
    return { id, agent, dir: ld, as, branch, head, ok: Boolean(id) && fs.existsSync(ld) && s1.status === 0 && c.status === 0, log: `${out(a).slice(-300)}\n${out(mk).slice(-300)}\n${out(s1).slice(-400)}\n${out(c)}` };
  };

  try {
    // ---- 1a. a queued lane's copy survives the session's end ----
    {
      const st = studio('keep');
      const { S, env } = st;
      const q = lane(st, 'bld-keep', 'Docs: queued note');
      const f = lane(st, 'bld-free', 'Docs: unqueued note');
      // The "session" is a command that queues its lane (as task done does) and exits; the launcher then ends it.
      const queuer = path.join(S, '.queuer-279b.mjs');
      fs.writeFileSync(queuer, `import fs from 'node:fs'; import path from 'node:path';
const f = path.join(${JSON.stringify(S)}, '.studio', 'train', 'queue.json');
fs.mkdirSync(path.dirname(f), { recursive: true });
const q = process.env.QUEUE_IT ? [{ task: process.env.QUEUE_IT, agent: process.env.STUDIO_LOCK_OWNER || '', dir: process.cwd(), branch: process.env.QUEUE_BRANCH, head: process.env.QUEUE_HEAD, at: new Date().toISOString() }] : [];
if (q.length) fs.writeFileSync(f, JSON.stringify(q));
`);
      // Each lane copy is made by the launcher for its own agent name; here the copies exist already, so the launcher reuses
      // them through a one-turn session started by name. Starting as the agent that owns the copy: reuseCopy needs a prior
      // session, so the check drives runAgent's own end-of-session cleanup through its exported queuedCopy + removeLaneCopy
      // decision on a real session end below.
      const r1 = probe(S, `const ag = await import(${u(S, 'harness/agent.mjs')}); const wt = await import(${u(S, 'harness/worktree.mjs')});
import fs from 'node:fs';
`.replace("import fs from 'node:fs';\n", '') + `
import('node:fs').then(async (fs) => {
  const q = ${JSON.stringify([{ task: q.id, agent: 'bld-keep', dir: q.dir, branch: q.branch, head: q.head, at: new Date().toISOString() }])};
  fs.mkdirSync(${JSON.stringify(path.join(S, '.studio', 'train'))}, { recursive: true });
  fs.writeFileSync(${JSON.stringify(path.join(S, '.studio', 'train', 'queue.json'))}, JSON.stringify(q));
  const keep = await ag.queuedCopy('bld-keep', [${JSON.stringify(q.dir)}], ${JSON.stringify(S)});
  const free = await ag.queuedCopy('bld-free', [${JSON.stringify(f.dir)}], ${JSON.stringify(S)});
  fs.writeFileSync(${JSON.stringify(path.join(S, '.studio', 'train', 'unity-queue.json'))}, JSON.stringify([{ task: 'T-99', agent: 'bld-free', branch: 'x' }]));
  const engine = await ag.queuedCopy('bld-free', [${JSON.stringify(f.dir)}], ${JSON.stringify(S)});
  console.log(JSON.stringify({ keep, free, engine }));
});
`, env);
      // The end-to-end part: a real session (a custom command) in a copy made for it, which queues its lane and exits.
      const cmdFile = path.join(S, '.session-279b.mjs');
      fs.writeFileSync(cmdFile, `import fs from 'node:fs'; import path from 'node:path';
const main = process.env.STUDIO_MAIN_ROOT || ${JSON.stringify(S)};
if (process.argv[2] === 'queue') {
  const f = path.join(main, '.studio', 'train', 'queue.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify([{ task: 'T-777', agent: process.env.STUDIO_LOCK_OWNER, dir: process.cwd(), branch: 'x', head: 'y', at: new Date().toISOString() }]));
}
`);
      fs.rmSync(path.join(S, '.studio', 'train', 'queue.json'), { force: true });
      fs.rmSync(path.join(S, '.studio', 'train', 'unity-queue.json'), { force: true });
      const t1 = task(S, ['add', 'Docs: session one', '--role', 'builder', '--priority', 'P1', '--lane', 'game/demo'], env);
      const t2 = task(S, ['add', 'Docs: session two', '--role', 'builder', '--priority', 'P1', '--lane', 'game/demo'], env);
      const id1 = (out(t1).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const id2 = (out(t2).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const cmd = (mode) => `"${process.execPath}" "${cmdFile}" ${mode}`;
      const s1 = node(S, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'bld-sq', '--tool', 'custom', '--model', 'm', '--task', id1, '--lane', 'game/demo'], { ...env, STUDIO_AGENT_CMD: cmd('queue') }, 120000);
      const s2 = node(S, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'bld-sf', '--tool', 'custom', '--model', 'm', '--task', id2, '--lane', 'game/demo'], { ...env, STUDIO_AGENT_CMD: cmd('none') }, 120000);
      const evText = textIn(S, '.studio/events.jsonl');
      await guard('2.79 (b, item 1a): a lane copy whose task waits in a train queue (the game queue, or an engine queue) is kept when its session ends (lane.kept names the queue); an unqueued copy is removed as before (fails on 2.78.2: dropCopies removes every copy, queued or not)', async () => [
        r1.j?.keep?.task === q.id && r1.j.keep.train === 'merge' && r1.j.free === null && r1.j.engine?.task === 'T-99' && r1.j.engine.train === 'unity'
          && fs.existsSync(path.join(S, '.lanes', 'bld-sq', '.git')) && !fs.existsSync(path.join(S, '.lanes', 'bld-sf'))
          && /"type":"lane\.kept"[^\n]*bld-sq/.test(evText),
        JSON.stringify({ r1: r1.j || out(r1).slice(-600), s1: out(s1).slice(-500), s2: out(s2).slice(-500), lanes: fs.existsSync(path.join(S, '.lanes')) ? fs.readdirSync(path.join(S, '.lanes')) : [], ev: evText.split('\\n').filter((l) => /lane\\.|bld-sq|start_refused/.test(l)).map((l) => l.slice(0, 260)).slice(-8), q: textIn(S, '.studio/train/queue.json').slice(0, 300), log: textIn(S, '.studio/agents/bld-sq.log').slice(0, 600), evt: evText.split('\\n').filter((l) => /bld-sq/.test(l)).map((l) => (l.match(/"type":"[^"]+"/) || [''])[0] + (l.match(/"msg":"[^"]{0,160}/) || [''])[0]).slice(0, 12) }).slice(0, 3000)]);
    }

    // ---- 1b. nothing writes .lanes/<name>/.studio after the copy is gone ----
    {
      const st = studio('evt');
      const { S, env } = st;
      const a = lane(st, 'bld-ev', 'Docs: event note');
      const sig = path.join(S, '.signal-279b');
      const script = path.join(a.dir, '.late-279b.mjs');
      // Everything is imported at start (the copy's own harness); the event is emitted only after the copy is removed.
      fs.writeFileSync(script, `import fs from 'node:fs';
import { emitEvent } from './harness/event.mjs';
import { STUDIO_STATE_DIR } from './harness/event.mjs';
const t0 = Date.now();
while (!fs.existsSync(${JSON.stringify(sig)}) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
emitEvent({ type: 'probe.late', agent: 'bld-ev', msg: 'written after the copy was removed' });
console.log(JSON.stringify({ state: STUDIO_STATE_DIR }));
`);
      const child = spawn(process.execPath, [script], { cwd: a.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ident, ...env } });
      let so = '';
      child.stdout.on('data', (d) => { so += d; });
      child.stderr.on('data', (d) => { so += d; });
      await wait(1500);
      const rm = probe(S, `const wt = await import(${u(S, 'harness/worktree.mjs')}); wt.removeLaneCopy('bld-ev', { keepBranch: true }); console.log(JSON.stringify({ gone: !${JSON.stringify(a.dir)} }));`, env);
      const goneNow = !fs.existsSync(path.join(a.dir, '.git'));
      fs.writeFileSync(sig, 'go');
      const code = await new Promise((res) => { const t = setTimeout(() => { try { child.kill(); } catch {} res(-1); }, 30000); child.on('exit', (c) => { clearTimeout(t); res(c); }); });
      const late = st.evs().find((e) => e.type === 'probe.late');
      await guard('2.79 (b, item 1b): an event emitted by a process whose lane copy was removed under it lands in the main studio\'s events.jsonl and makes no .lanes/<name>/.studio (fails on 2.78.2: boardRoot needs the copy\'s .git file, so the folder is recreated with a .studio of its own)', async () => [
        goneNow && code === 0 && Boolean(late) && !fs.existsSync(path.join(S, '.lanes', 'bld-ev', '.studio')),
        JSON.stringify({ goneNow, code, so: so.slice(-400), rm: out(rm).slice(-300), late: Boolean(late), laneDir: fs.existsSync(a.dir) ? fs.readdirSync(a.dir, { recursive: true }).slice(0, 12) : null })]);
    }

    // ---- 1c. a lane folder with no .git is moved aside and the copy made again; the train never says "on main" ----
    {
      const st = studio('left');
      const { S, env } = st;
      const a = lane(st, 'bld-lf', 'Docs: leftover note');
      // The copy goes (the branch stays); something writes .studio/ into the folder: it exists, with no .git.
      const rm = probe(S, `const wt = await import(${u(S, 'harness/worktree.mjs')}); wt.removeLaneCopy('bld-lf', { keepBranch: true }); console.log(JSON.stringify({ ok: true }));`, env);
      writeIn(a.dir, '.studio/events.jsonl', '{}\n');
      const entry = { task: a.id, agent: a.agent, dir: a.dir, branch: a.branch, head: a.head, at: new Date().toISOString() };
      const r = probe(S, `const tr = await import(${u(S, 'harness/train.mjs')}); const tl = await import(${u(S, 'harness/train-lanes.mjs')});
const lane = ${JSON.stringify(entry)};
const before = tr.laneNow(lane);
const logs = [];
const dry = await tr.runTrain({ root: process.cwd(), dryRun: true, now: true, by: 'person', lanes: [{ ...lane, fromQueue: false }], log: (m) => logs.push(m), deps: {} });
const rc = tl.recreateLaneCopy(process.cwd(), lane, { log: (m) => logs.push(m) });
const after = tr.laneNow(lane);
console.log(JSON.stringify({ before, rc: { ok: rc.ok, why: rc.why, branch: rc.branch }, after, logs: logs.filter((l) => /again|leftover|moved|on main/.test(l)).slice(0, 6), dry: String(dry.message || '').slice(0, 200) }));
`, env);
      const left = (() => { try { return fs.readdirSync(path.join(S, '.studio', 'lane-leftovers')); } catch { return []; } })();
      await guard('2.79 (b, item 1c): a lane folder that exists with no .git counts as missing: laneNow reports it (not main\'s branch), the train moves it to .studio/lane-leftovers/<name>-<time>/ and makes the copy again from the lane branch (fails on 2.78.2: laneNow reads the main checkout\'s branch, so the lane is handed back "its copy is on main now")', async () => [
        r.j?.before?.leftover === true && !r.j.before.branch && r.j.rc?.ok === true && r.j.rc.branch === a.branch && r.j.after?.branch === a.branch && r.j.after.head === a.head
          && left.length === 1 && /^bld-lf-/.test(left[0]) && fs.existsSync(path.join(S, '.lanes', 'bld-lf', '.git')) && /would make it again/.test((r.j.logs || []).join('\n')) && !/on main/.test((r.j.logs || []).join('\n')),
        JSON.stringify({ rm: out(rm).slice(-200), r: r.j || out(r).slice(-800), left }).slice(0, 2500)]);
    }

    // ---- 1d. an infrastructure hand-back does not count toward STUDIO_TRAIN_MAX_HANDBACKS ----
    {
      const st = studio('hb');
      const { S, env } = st;
      const mk = task(S, ['add', 'Docs: hb note', '--role', 'builder', '--priority', 'P1'], env);
      const id = (out(mk).match(/"id":\s*"(T-\d+)"/) || [])[1];
      const r = probe(S, `const ev = await import(${u(S, 'harness/event.mjs')}); const tr = await import(${u(S, 'harness/train.mjs')});
const id = ${JSON.stringify(id)};
const note = (why) => \`Handed back \${id}: Not landed by merge train t1: \${why}\`;
const paused = (why, cause) => ev.emitEvent({ type: 'task.paused', agent: 'builder-x', task: id, status: 'paused', msg: note(why), meta: { reasonKey: 'k-' + why.length, ...(cause ? { handBackCause: cause } : {}) } });
paused('the lane copy could not be read after EPERM', 'infra'); paused('queue.json rename EBUSY', 'infra'); paused('the train stalled', 'infra'); paused('another thing', 'infra');
const onlyInfra = tr.handBackCount(id);
paused('the gate game failed: 3 tests', 'red'); paused('it conflicts with main in a.js', 'conflict');
console.log(JSON.stringify({ onlyInfra, withOwn: tr.handBackCount(id) }));
`, env);
      // The train's own hand-back carries the cause through the board's handBack dep (task.mjs trainDeps -> pauseTask).
      const r2 = probe(S, `const t = await import(${u(S, 'harness/task.mjs')}); const busy = await import(${u(S, 'harness/busy.mjs')}); const d = t.trainDeps(busy);
const src = String(d.handBack);
console.log(JSON.stringify({ passesCause: /handBackCause/.test(src) }));
`, env);
      await guard('2.79 (b, item 1d): hand-backs the train tags infra (meta.handBackCause, set from the drop\'s cause: a copy made again, EPERM/EBUSY, a dead train) are not counted toward STUDIO_TRAIN_MAX_HANDBACKS; red and conflict ones are, and the board\'s hand-back carries the cause (fails on 2.78.2: every "Not landed by merge train" hand-back counts)', async () => [
        r.j?.onlyInfra === 0 && r.j.withOwn === 2 && r2.j?.passesCause === true,
        JSON.stringify({ r: r.j || out(r).slice(-600), r2: r2.j || out(r2).slice(-400) })]);
    }

    // ---- 2. train auto off: every automatic start refuses; a person's own train runs ----
    {
      const st = studio('auto');
      const { S, env } = st;
      writeIn(S, '.studio/train/auto.json', `${JSON.stringify({ off: true, by: 'person', why: 'a Unity train runs', at: new Date().toISOString() })}\n`);
      const a = lane(st, 'bld-au', 'Docs: auto note');
      const qf = path.join(S, '.studio', 'train', 'queue.json');
      writeIn(S, '.studio/train/queue.json', `${JSON.stringify([{ task: a.id, agent: a.agent, dir: a.dir, branch: a.branch, head: a.head, at: new Date(Date.now() - 3600000).toISOString() }])}\n`);
      writeIn(S, '.studio/train/running.json', '{}\n');
      const r = probe(S, `const td = await import(${u(S, 'harness/train-detach.mjs')}); const dm = await import(${u(S, 'harness/train-daemon.mjs')}); const pl = await import(${u(S, 'harness/train-pipeline.mjs')});
const root = process.cwd();
const spawned = [];
const kick = await td.kickTrain(root, { by: 'bld-au', waitMin: 7, deps: { supervisor: () => null, spawn: (o) => { spawned.push('kick'); return { ok: true, pid: 4242 }; } } });
const pass = await dm.trainDaemonPass({ root, env: process.env, spawnTrain: () => { spawned.push('daemon'); return { pid: 1 }; }, emit: () => {}, room: { ok: true }, lock: null, next: null, running: null, drain: null, winddown: null, stopped: null });
const nxt = await pl.pipelineKick(root, { after: 'train-x', spawn: () => { spawned.push('next'); return { pid: 2 }; }, log: () => {} });
console.log(JSON.stringify({ kick: { how: kick.how, line: String(kick.line).slice(0, 160) }, pass: { started: pass.started, why: String(pass.why).slice(0, 120) }, nxt: { started: nxt.started, why: String(nxt.why).slice(0, 120) }, spawned }));
`, env);
      // A person's own `task train` still runs (a dry run answers without landing anything).
      const manual = task(S, ['train', '--dry-run', '--by', 'person'], env);
      // Turn the daemon back on: the same kick starts a train (so the refusals above are the switch, nothing else).
      fs.rmSync(path.join(S, '.studio', 'train', 'auto.json'), { force: true });
      const r2 = probe(S, `const td = await import(${u(S, 'harness/train-detach.mjs')}); const spawned = [];
const kick = await td.kickTrain(process.cwd(), { by: 'bld-au', waitMin: 7, deps: { supervisor: () => null, spawn: () => { spawned.push('kick'); return { ok: true, pid: 4243 }; } } });
console.log(JSON.stringify({ how: kick.how, spawned }));
`, env);
      await guard('2.79 (b, item 2): with `train auto off` set, a queued task done\'s kick, the daemon\'s pass and the speculative train start nothing (each says the switch is off), a person\'s `task train` still runs, and with the switch on the same kick starts a train (fails on 2.78.2: kickTrain and pipelineKick never read the switch)', async () => [
        r.j?.kick?.how === 'off' && /train auto is off/.test(r.j.kick.line) && r.j.pass?.started === false && /train auto is off/.test(r.j.pass.why) && r.j.nxt?.started === false && /train auto is off/.test(r.j.nxt.why) && (r.j.spawned || []).length === 0
          && manual.status === 0 && !/auto is off/.test(out(manual)) && r2.j?.how === 'spawned' && r2.j.spawned.length === 1,
        JSON.stringify({ r: r.j || out(r).slice(-800), manual: out(manual).slice(-300), manualStatus: manual.status, r2: r2.j || out(r2).slice(-300) }).slice(0, 2500)]);
    }

    // ---- 3. the train's queue write retries a rename another process makes fail for a moment ----
    {
      const st = studio('perm');
      const { S, env } = st;
      const r = probe(S, `import('node:fs').then(async ({ default: fs }) => {
  const tr = await import(${u(S, 'harness/train.mjs')});
  const code = process.platform === 'win32' ? 'EPERM' : 'EBUSY';
  const real = fs.renameSync;
  let thrown = 0;
  fs.renameSync = (from, to) => { if (/queue\\.json$/.test(String(to)) && thrown < 2) { thrown++; throw Object.assign(new Error('simulated lock'), { code }); } return real(from, to); };
  let err = null;
  try { tr.enqueue(process.cwd(), { task: 'T-5', agent: 'a', dir: process.cwd(), branch: 'b', head: 'h' }); } catch (e) { err = e.code || e.message; }
  fs.renameSync = real;
  console.log(JSON.stringify({ thrown, err, queued: tr.readQueue(process.cwd()).map((e) => e.task) }));
});
`, env);
      await guard('2.79 (b, item 3): a rename of queue.json refused with EPERM/EBUSY twice is retried (fsafe writeAtomic) and the entry is queued, the train does not die (fails on 2.78.2: writeQueue renames once and throws)', async () => [
        r.j?.thrown === 2 && r.j.err === null && r.j.queued?.includes('T-5'),
        JSON.stringify(r.j || out(r).slice(-800))]);
    }

    // ---- 4. a reused pid is not alive ----
    {
      const st = studio('pid');
      const { S, env } = st;
      const r = probe(S, `const b = await import(${u(S, 'harness/busy.mjs')}); const pi = await import(${u(S, 'harness/proc-identity.mjs')}); const fs = await import('node:fs'); const path = await import('node:path');
const dir = path.join(process.cwd(), '.studio');
fs.mkdirSync(path.join(dir, 'done-running'), { recursive: true });
const mark = (name, rec) => fs.writeFileSync(path.join(dir, 'done-running', name + '.json'), JSON.stringify({ task: name, agent: 'a', pid: process.pid, at: new Date().toISOString(), ...rec }));
await b.markDoneRunning('T-OWN', 'a', { dir });
const own = JSON.parse(fs.readFileSync(path.join(dir, 'done-running', 'T-OWN.json'), 'utf8'));
mark('T-REUSED', { identity: { start: Date.now() - 3 * 86400000 } });
mark('T-OLD', {});
console.log(JSON.stringify({
  writes: Boolean(own.identity?.start),
  own: Boolean(b.doneRunning('T-OWN', { dir })),
  reused: Boolean(b.doneRunning('T-REUSED', { dir })),
  old: Boolean(b.doneRunning('T-OLD', { dir })),
  liveAsReused: pi.liveAs(process.pid, { start: Date.now() - 3 * 86400000 }),
  liveAsSelf: pi.liveAs(process.pid, pi.selfIdentity()),
}));
`, env);
      await guard('2.79 (b, item 4): a done-running marker records its writer\'s start identity; a marker whose pid is alive but whose recorded start differs (the number now belongs to another program) is not a running done, while the writer\'s own marker and an old marker with no identity still are (fails on 2.78.2: busy.mjs alive() is a bare kill(pid, 0))', async () => [
        r.j?.writes === true && r.j.own === true && r.j.reused === false && r.j.old === true && r.j.liveAsReused === false && r.j.liveAsSelf === true,
        JSON.stringify(r.j || out(r).slice(-800))]);
    }
  } finally {
    for (const S of made) {
      try { g(S, 'worktree', 'prune'); } catch {}
      try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
    }
  }
}
