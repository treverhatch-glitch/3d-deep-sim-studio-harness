/**
 * qa/selftest-279d.mjs — 2.79 (d): the 2.78.2 crew's harness bugs (request section 2, items 2, 7-14).
 *   2.2   `npm run agent -- start` runs the session in the background (--attach keeps it in the shell), prints pid and log.
 *   2.7   idle lane copies: the janitor's automatic run and `npm run lanes -- prune --idle <hours> [--dry-run]` remove the
 *         worktree of a copy nobody needs (branch kept); never one with a queued task, a claim, unsaved or unlanded work.
 *   2.8   `npm run lanes` with no arguments reads git's worktree files (no git process per copy); --full or a name reads all.
 *   2.9   the protected-step router reads the hand-back's structured field (meta.ownerStep), not the words of its note.
 *   2.10  an approval signed in a lane copy is logged in the main checkout's events (already fixed in 2.78.2; regression).
 *   2.11  `review <ID>` from main finds the task's lane branch when the current branch has no tagged commit.
 *   2.12  the divergence reference is built under <repo>/.studio/tmp, not the system temp folder.
 *   2.13  a Director's or reviewer's task with no type set (its title typed it "bug") skips the game's checks on notes only.
 *   2.14  the quarantine line never says "skipped" for a test config that ignores the list (already fixed in 2.78.2).
 * A tiny studio per check (a copy of the harness, git, lane copies made by the harness); no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest279D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const OLD = '2026-10-01T00:00:00Z';
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
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
    STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LANE_LIVE_MIN: '0', STUDIO_LANDING_BUILD: 'off', STUDIO_TRAIN_PIPELINE: 'off',
    STUDIO_FLAKE_TRIAGE: 'off', STUDIO_WHOLE_GAME: 'off', STUDIO_SLOW_TIER: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_VERIFY_KEY_DIR: path.join(tmpRoot, 'verify-keys-279d'),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279d-${process.pid}.pem`),
  };
  let n = 0;
  const made = [];
  const kids = [];
  /** A tiny studio: a copy of the harness, a one-check game, git (the base commit dated OLD, so a copy is idle on arrival). */
  const studio = (name, { old = true } = {}) => {
    const S = path.join(tmpRoot, `279d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    for (const f of ['beta.json', 'game.json', 'quarantine.json']) fs.rmSync(path.join(S, 'studio', f), { force: true });
    const ev = path.join(S, '.studio', 'events-279d.jsonl');
    writeIn(S, '.studio/events-279d.jsonl', '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/check.mjs', ["import fs from 'node:fs';", "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.pid} ${process.cwd()}\\n`);", "console.log('notes ok');", ''].join('\n'));
    writeIn(S, 'game/demo/notes/shared.md', '# Shared\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A');
    spawnSync('git', ['commit', '-qm', 'studio', '--no-verify'], { windowsHide: true, cwd: S, encoding: 'utf8', env: gEnv(old ? { GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD } : {}) });
    made.push(S);
    const mark = path.join(S, '.studio', 'runs-279d.txt');
    const env = { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S, TRAIN_MARK: mark };
    const evs = () => textIn(S, '.studio/events-279d.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const runs = () => textIn(S, '.studio/runs-279d.txt').split('\n').filter(Boolean).length;
    return { S, env, ev, evs, runs };
  };
  const node = (cwd, args, env, timeout = 240000) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout });
  const task = (cwd, line, env, timeout) => node(cwd, ['harness/task.mjs', ...line], env, timeout);
  const probe = (S, code, env, cwd = S) => { const f = path.join(cwd, `.probe-279d-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(cwd, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const addTask = (st, title, role = 'builder') => (out(task(st.S, ['add', title, '--role', role, '--priority', 'P1'], st.env)).match(/"id":\s*"(T-\d+)"/) || [])[1];
  /** A task, its lane copy (.lanes/<agent>) made by the harness, the task started there, one note committed. */
  const lane = (st, agent, title, rel, text, { role = 'builder' } = {}) => {
    const { S, env } = st;
    const id = addTask(st, title, role);
    const lp = path.join(S, `.lane-279d-${++n}.mjs`);
    fs.writeFileSync(lp, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const mk = node(S, [lp, agent, id], env);
    fs.rmSync(lp, { force: true });
    const ld = path.join(S, '.lanes', agent);
    const as = { ...env, STUDIO_LOCK_OWNER: agent };
    const s1 = task(ld, ['start', id, '--agent', agent], as);
    writeIn(ld, rel, text);
    g(ld, 'add', '--', rel);
    const c = g(ld, 'commit', '-qm', `${id}: ${title}\n\nStudio-Task: ${id}`, '--no-verify');
    return { id, agent, dir: ld, as, ok: Boolean(id) && fs.existsSync(ld) && s1.status === 0 && c.status === 0, log: `${out(mk).slice(-300)}\n${out(s1).slice(-400)}\n${out(c)}` };
  };
  /** A plain lane copy the way a crashed session leaves it: a worktree on its own branch, old (nothing in it for days). */
  const idleCopy = (S, name, { dirty = false, commit = false, claim = null } = {}) => {
    const L = path.join(S, '.lanes', name);
    const add = g(S, 'worktree', 'add', '-q', '-b', `lane/${name}`, L);
    writeIn(L, 'docs/bulk.txt', 'x'.repeat(2048));
    g(L, 'add', '-A');
    spawnSync('git', ['commit', '-qm', `${name} bulk`, '--no-verify'], { windowsHide: true, cwd: L, encoding: 'utf8', env: gEnv({ GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD }) });
    if (!commit) g(L, 'reset', '-q', '--hard', 'main'); // nothing of its own: the docs/bulk.txt commit is dropped again
    if (commit) writeIn(L, 'docs/bulk.txt', 'x'.repeat(2048));
    if (dirty) writeIn(L, 'docs/unsaved.txt', 'unsaved work\n');
    if (claim) node(S, ['harness/lock.mjs', 'claim', `path:docs/${name}`, '--owner', claim], { ...base, STUDIO_MAIN_ROOT: S, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-279d.jsonl') });
    const old = new Date(OLD);
    try { fs.utimesSync(L, old, old); } catch {}
    return { name, dir: L, ok: add.status === 0 };
  };
  const branches = (S) => g(S, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').stdout.split('\n').filter(Boolean);

  try {
    // ---- 2.2: `agent start` runs in the background ----
    {
      const st = studio('start');
      const { S, env } = st;
      const id = addTask(st, 'Docs: note for the background start');
      const agentEnv = { ...env, STUDIO_HEARTBEAT_SEC: '1', STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} wait' };
      // --attach: the session stays in this process: the command returns when the agent ends (a short one here).
      const id2 = addTask(st, 'Docs: note for the attached start');
      const att = node(S, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'builder-d2', '--task', id2, '--model', 'fake-1'], { ...env, STUDIO_BUILDER_CMD: 'node qa/fixtures/agents/fake-agent.mjs {agent} {task} quit' }, 120000);
      const t0 = Date.now();
      const r = node(S, ['harness/agent.mjs', 'start', '--role', 'builder', '--agent', 'builder-d1', '--task', id, '--model', 'fake-1'], agentEnv, 25000);
      const took = Date.now() - t0;
      const recFile = path.join(S, '.studio', 'agents', 'builder-d1.json');
      const rec = () => readIn(S, '.studio/agents/builder-d1.json');
      const upMs = await until(() => rec()?.pid, 20000);
      const pid = rec()?.supervisor || rec()?.pid;
      const stop = node(S, ['harness/agent.mjs', 'stop', 'builder-d1', '--by', 'selftest'], agentEnv, 60000);
      await until(() => rec()?.status !== 'running', 20000);
      void recFile; void stop;
      await guard('2.79 (d, 2.2): `npm run agent -- start` with no flag returns at once (exit 0, the session is the launcher\'s own background process), prints "started in the background" with the supervisor\'s pid and the log file, and the agent keeps running until it is stopped; `--attach` keeps the old foreground run (no "started in the background", the command ends with the session) (fails on 2.78.2: start ran the agent in the starter\'s shell, so the command did not return while the agent waited and died with that shell)', () => [
        r.status === 0 && !r.error && took < 20000 && /started in the background/.test(out(r)) && /pid \d+/.test(out(r)) && /\.studio\/agents\/builder-d1\.log/.test(out(r)) && upMs && pid > 0
          && att.status === 0 && !att.error && !/started in the background/.test(out(att)) && Boolean(readIn(S, '.studio/agents/builder-d2.json')),
        JSON.stringify({ took, r: out(r).slice(-300), err: r.error?.code || null, rec: rec(), att: out(att).slice(-300), attErr: att.error?.code || null }).slice(0, 1500)]);
    }

    // ---- 2.7: idle lane copies ----
    {
      const st = studio('idle');
      const { S, env } = st;
      const idle1 = idleCopy(S, 'idle-a');
      const idle2 = idleCopy(S, 'idle-b');
      const idle3 = idleCopy(S, 'idle-c');
      const dirty = idleCopy(S, 'dirty-d', { dirty: true });
      const own = idleCopy(S, 'unlanded-e', { commit: true });
      // unlanded-e: a commit of its own that main doesn't have
      writeIn(own.dir, 'docs/own.txt', 'work\n'); g(own.dir, 'add', '-A');
      spawnSync('git', ['commit', '-qm', 'its own work', '--no-verify'], { windowsHide: true, cwd: own.dir, encoding: 'utf8', env: gEnv({ GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD }) });
      fs.utimesSync(own.dir, new Date(OLD), new Date(OLD));
      const queued = idleCopy(S, 'queued-f');
      const claimed = idleCopy(S, 'claimed-g', { claim: 'claimed-g' });
      const fresh = idleCopy(S, 'fresh-h');
      fs.utimesSync(fresh.dir, new Date(), new Date()); // touched now: not idle
      const head = g(S, 'rev-parse', 'refs/heads/lane/queued-f').stdout.trim();
      writeIn(S, '.studio/train/queue.json', `${JSON.stringify([{ task: 'T-901', agent: 'queued-f', branch: 'lane/queued-f', head, at: new Date().toISOString() }], null, 2)}\n`);
      const copiesOk = [idle1, idle2, idle3, dirty, own, queued, claimed, fresh].every((c) => c.ok && fs.existsSync(c.dir));
      const exists = (c) => fs.existsSync(c.dir);
      const dry = node(S, ['harness/lanes.mjs', 'prune', '--idle', '12', '--dry-run'], env);
      const afterDry = [idle1, idle2, idle3].every(exists);
      const worker = node(S, ['harness/lanes.mjs', 'prune', '--idle', '12', '--by', 'builder-7'], { ...env, STUDIO_ROLE: 'builder' });
      const afterWorker = [idle1, idle2, idle3].every(exists);
      const real = node(S, ['harness/lanes.mjs', 'prune', '--idle', '12', '--by', 'pat'], env);
      const gone = [idle1, idle2, idle3].map((c) => !exists(c));
      const kept = [dirty, own, queued, claimed, fresh].map(exists);
      const brs = branches(S);
      await guard('2.79 (d, 2.7): `npm run lanes -- prune --idle 12` removes the lane copies nothing needs (no running session, no queued task, no live claim, no uncommitted change, no commit that isn\'t on main, untouched for 12 h), keeps the branches, prints each removal and the disk freed, and keeps a copy with unsaved changes, a commit of its own, a queued task, a live claim or a recent touch; --dry-run changes nothing; a worker is refused (fails on 2.78.2: `lanes prune` is not a command: usage error, nothing removed)', () => [
        copiesOk && dry.status === 0 && /Would remove 3 idle lane copy/.test(out(dry)) && afterDry
          && worker.status === 2 && afterWorker
          && real.status === 0 && /Removed 3 idle lane copy/.test(out(real)) && /freed/.test(out(real)) && /removed \.lanes\/idle-a/.test(out(real).replace(/\\/g, '/')) && /kept \.lanes\/queued-f: its task is queued for a train/.test(out(real).replace(/\\/g, '/'))
          && gone.every(Boolean) && kept.every(Boolean) && ['lane/idle-a', 'lane/idle-b', 'lane/idle-c'].every((b) => brs.includes(b)),
        JSON.stringify({ copiesOk, dry: out(dry).slice(-400), worker: [worker.status, out(worker).slice(-200)], real: out(real).slice(-900), gone, kept, brs }).slice(0, 2500)]);

      // The janitor's automatic run (what a finished train or verify job starts): the same rule; STUDIO_LANE_IDLE_HOURS=off keeps them.
      const st2 = studio('idle2');
      const j1 = idleCopy(st2.S, 'idle-j1');
      const j2 = idleCopy(st2.S, 'idle-j2', { dirty: true });
      const off = node(st2.S, ['harness/janitor.mjs', '--yes', '--auto', '--root', st2.S], { ...st2.env, STUDIO_LANE_IDLE_HOURS: 'off' });
      const keptOff = exists(j1) && exists(j2);
      const on = node(st2.S, ['harness/janitor.mjs', '--yes', '--auto', '--root', st2.S], st2.env);
      const pruned = st2.evs().find((e) => e.type === 'lanes.pruned');
      await guard('2.79 (d, 2.7): the janitor\'s automatic run (`janitor --yes --auto`, started after each train and verify job) removes an idle lane copy after STUDIO_LANE_IDLE_HOURS (default 12) with a lanes.pruned event, keeps a copy with unsaved changes, and leaves every copy alone with STUDIO_LANE_IDLE_HOURS=off (fails on 2.78.2: the automatic run never touched lane copies)', () => [
        off.status === 0 && keptOff && on.status === 0 && !exists(j1) && exists(j2) && branches(st2.S).includes('lane/idle-j1') && pruned?.meta?.agents?.includes('idle-j1'),
        JSON.stringify({ off: out(off).slice(-200), on: out(on).slice(-200), j1: exists(j1), j2: exists(j2), pruned: pruned?.msg || null }).slice(0, 1200)]);
    }

    // ---- 2.8: the cheap lane listing ----
    {
      const st = studio('cheap');
      const { S, env } = st;
      const N = 12;
      for (let i = 0; i < N; i += 1) idleCopy(S, `lane-${String(i).padStart(2, '0')}`);
      const headRef = g(S, 'rev-parse', 'refs/heads/lane/lane-03').stdout.trim();
      const traced = (args) => {
        const tf = path.join(S, `.studio/git-trace-${++n}.txt`);
        const r = node(S, ['harness/lanes.mjs', ...args], { ...env, GIT_TRACE: tf });
        const lines = textIn(S, path.relative(S, tf)).split('\n').filter((l) => /\btrace: (built-in|exec|run_command): /.test(l) && /\bgit\b/.test(l));
        const calls = lines.filter((l) => /built-in: git /.test(l)).length;
        return { r, calls };
      };
      const cheap = traced(['--json']);
      const full = traced(['--json', '--full']);
      const named = traced(['--json', 'lane-03']);
      const parse = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return null; } };
      const cj = parse(cheap.r); const fj = parse(full.r); const nj = parse(named.r);
      const row = (j, a) => j?.lanes?.find((l) => l.agent === a);
      await guard(`2.79 (d, 2.8): \`npm run lanes\` with no arguments lists ${N} lane copies (task, agent, branch, head) from git's worktree files with a handful of git processes in all (not three or more per copy), \`--full\` still reads ahead/behind and dirty for every lane and prints a progress line on stderr, and \`npm run lanes -- <agent>\` reads the one lane in full (fails on 2.78.2: the bare listing ran git per copy and gave no progress line)`, () => [
        cheap.r.status === 0 && cj?.lanes?.length === N && row(cj, 'lane-03')?.branch === 'lane/lane-03' && row(cj, 'lane-03')?.head === headRef && row(cj, 'lane-03')?.ahead === undefined && cheap.calls <= 8
          && full.r.status === 0 && fj?.lanes?.length === N && row(fj, 'lane-03')?.ahead === 0 && row(fj, 'lane-03')?.behind === 0 && full.calls >= N * 3 && /lanes: reading lane copies/.test(String(full.r.stderr || ''))
          && named.r.status === 0 && nj?.lanes?.length === 1 && nj.lanes[0].agent === 'lane-03' && nj.lanes[0].ahead === 0 && named.calls < full.calls,
        JSON.stringify({ err: String(full.r.stderr || '').slice(-100), row: row(cj, 'lane-03'), rowF: row(fj, 'lane-03'), cheap: cheap.calls, full: full.calls, named: named.calls, n: [cj?.lanes?.length, fj?.lanes?.length, nj?.lanes?.length], st: [cheap.r.status, full.r.status, named.r.status] })]);
    }

    // ---- 2.9: the protected-step router reads a structured field ----
    {
      const st = studio('route');
      const { S, env } = st;
      const { publicKey: pubK, privateKey: privK } = crypto.generateKeyPairSync('ed25519');
      writeIn(S, 'studio/keys/owner-ed25519.pub.pem', pubK.export({ type: 'spki', format: 'pem' }));
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key', '--no-verify');
      void privK;
      const ts = (ms) => new Date(Date.now() - ms).toISOString();
      const evs = (extra) => [{ ts: ts(5000), type: 'task.start', agent: 'builder-1', task: 'T-5', msg: 'start' }, { ts: ts(1000), type: 'task.paused', agent: 'builder-1', task: 'T-5', ...extra }];
      const route = (events) => probe(S, `const lp = await import(${u(S, 'harness/line-producer.mjs')}); const r = await lp.protectedRoutes({ tasks: [{ id: 'T-5', state: 'ready' }], events: ${JSON.stringify(events)}, act: false }); console.log(JSON.stringify({ n: r.length }));`, env).j;
      const words = route(evs({ msg: 'Handed back T-5: the protected gate now PASSES; the game check still fails on tick 40, see notes' }));
      const field = route(evs({ msg: 'Handed back T-5: waiting on a re-pin', meta: { ownerStep: 'protected-file' } }));
      const otherField = route(evs({ msg: 'Handed back T-5: the protected file needs the owner', meta: { ownerStep: 'weakened-test' } }));
      // The harness's own refusal writes the field: a lane that changed a protected file is refused by task done, and its hand-back carries it.
      const a = lane(st, 'bld-p1', 'Controls note p1', 'qa/controls-check.mjs', `${textIn(S, 'qa/controls-check.mjs')}\n// re-pinned by the lane\n`);
      const refused = task(a.dir, ['done', a.id, '--agent', a.agent], { ...a.as, STUDIO_DONE_QUEUE: '0' });
      const pa = task(a.dir, ['pause', a.id, '--agent', a.agent, '--note', 'protected gate now PASSES, but the lane waits'], a.as);
      const b = lane(st, 'bld-p2', 'Docs: plain note p2', 'game/demo/notes/p2.md', '# P2\n');
      const pb = task(b.dir, ['pause', b.id, '--agent', b.agent, '--note', 'protected gate now PASSES, but the lane waits'], b.as);
      const paused = (id) => st.evs().filter((e) => e.type === 'task.paused' && e.task === id).pop();
      const notDone = st.evs().filter((e) => e.type === 'task.not_done' && e.task === a.id).pop();
      await guard('2.79 (d, 2.9): the Line\'s protected-step router reads the hand-back\'s structured field (meta.ownerStep, written from the harness\'s own refusal: a task done refused for a protected file puts it on task.not_done and the hand-back after it carries it): a passing note that says "protected gate now PASSES" is not routed, a hand-back with the field is, and a hand-back of a lane the harness never refused for it carries none (fails on 2.78.2: the router matched the word "protected" in the note, and nothing wrote a field)', () => [
        words?.n === 0 && field?.n === 1 && otherField?.n === 0 && a.ok && b.ok && /protected check fails/.test(out(refused)) && notDone?.meta?.ownerStep === 'protected-file'
          && paused(a.id)?.meta?.ownerStep === 'protected-file' && paused(b.id) && !paused(b.id).meta?.ownerStep && pa.status === 0 && pb.status === 0,
        JSON.stringify({ a: a.log.slice(0, 150), words, field, otherField, notDone: notDone?.meta, pa: paused(a.id)?.meta, pb: paused(b.id)?.meta, refused: out(refused).slice(-500) })]);
    }

    // ---- 2.10: an approval signed in a lane copy is logged in the main checkout's events ----
    {
      const st = studio('approve');
      const { S, env } = st;
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const keyFile = path.join(tmpRoot, `279d-owner-${process.pid}-${++n}.pem`);
      fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      writeIn(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'owner key', '--no-verify');
      const a = lane(st, 'bld-a1', 'Controls note a1', 'qa/controls-check.mjs', `${textIn(S, 'qa/controls-check.mjs')}\n// re-pinned by lane a1\n`);
      const laneEv = (dirp) => { try { return fs.readFileSync(path.join(dirp, '.studio', 'events.jsonl'), 'utf8'); } catch { return ''; } };
      const e = { ...env, AGENT_EVENTS_FILE: '', STUDIO_OWNER_KEY: keyFile };
      const ap = node(a.dir, ['harness/approve.mjs', 'protected', '--note', `${a.id}: the owner re-pins the controls check`, '--by', 'pat'], e);
      const mainEvents = textIn(S, '.studio/events.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      const lanesEmpty = !fs.existsSync(path.join(a.dir, '.studio', 'events.jsonl')) || fs.realpathSync(path.join(a.dir, '.studio')) === fs.realpathSync(path.join(S, '.studio'));
      const linked = fs.lstatSync(path.join(a.dir, '.studio')).isSymbolicLink();
      const mainHas = mainEvents.some((x) => x.type === 'approval.protected');
      await guard('2.79 (d, 2.10): `approve -- protected` signed in a lane copy the harness made (a worktree whose .studio is the main checkout\'s) logs approval.protected in the main checkout\'s events, the copy\'s .studio being the main checkout\'s (already fixed in 2.78.2: the event path follows the copy\'s .studio link; kept as a regression check)', () => [
        a.ok && ap.status === 0 && mainHas && lanesEmpty && linked,
        JSON.stringify({ a: a.log.slice(0, 200), laneEvents: laneEv(a.dir).slice(-200), mainHas, ap: [ap.status, out(ap).slice(-500)] })]);
    }

    // ---- 2.11: review from main finds the task's lane branch ----
    {
      const st = studio('review');
      const { S, env } = st;
      const id = addTask(st, 'Docs: review me');
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
      g(S, 'checkout', '-q', '-b', 'lane/rev-1');
      writeIn(S, 'docs/reviewed.md', '# reviewed\n'); g(S, 'add', '-A');
      g(S, 'commit', '-qm', `${id}: the work\n\nStudio-Task: ${id}\nStudio-Model: claude-opus-5-5`, '--no-verify');
      g(S, 'checkout', '-q', 'main');
      const gather = (extra = {}) => probe(S, `const r = await import(${u(S, 'harness/review.mjs')}); const g = r.gather(${JSON.stringify(id)}, { implementer: 'claude-opus-5-5' }); console.log(JSON.stringify({ err: g.error || null, n: g.commits?.length || 0, branch: g.onBranch || null }));`, { ...env, ...extra }).j;
      const byGrep = gather();
      writeIn(S, '.studio/lane-branches.json', `${JSON.stringify({ [id]: 'lane/rev-1' }, null, 2)}\n`);
      const byRegistry = gather();
      writeIn(S, '.studio/lane-branches.json', '{}\n');
      const noTask = probe(S, `const r = await import(${u(S, 'harness/review.mjs')}); const g = r.gather('T-999', { implementer: 'x' }); console.log(JSON.stringify({ err: g.error || null }));`, env).j;
      await guard('2.79 (d, 2.11): `review <ID>` run from main, where the current branch has no commit tagged Studio-Task: <ID>, finds the task\'s lane branch (the registry\'s, or the branch whose commits carry the tag) and reviews its commits; a task nobody committed for still says so (fails on 2.78.2: "No commits tagged Studio-Task: <ID> yet", it read the current branch only)', () => [
        byGrep?.err === null && byGrep.n === 1 && byGrep.branch === 'lane/rev-1' && byRegistry?.err === null && byRegistry.n === 1 && /No task T-999/.test(noTask?.err || ''),
        JSON.stringify({ byGrep, byRegistry, noTask })]);
    }

    // ---- 2.12: the divergence reference is built under <repo>/.studio/tmp ----
    {
      const st = studio('div', { old: false });
      const { S, env } = st;
      writeIn(S, 'docs/change.md', 'a change\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'a second commit', '--no-verify');
      const where = path.join(tmpRoot, `279d-where-${process.pid}-${++n}.txt`);
      const code = `const d = await import(${u(S, 'harness/divergence.mjs')}); const r = await d.gameDivergence({ root: process.cwd(), game: {}, gate: 'check', conf: { command: 'node -e "require(\\'fs\\').appendFileSync(process.env.WHERE_OUT, process.cwd() + String.fromCharCode(10))"' }, env: { ...process.env, WHERE_OUT: ${JSON.stringify(where)}, STUDIO_DIVERGENCE_REF: 'HEAD~1' } }); console.log(JSON.stringify({ r: Object.keys(r) }));`;
      const r = probe(S, code, env);
      const seen = (() => { try { return fs.readFileSync(where, 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
      const under = path.join(real(S), '.studio', 'tmp');
      const refDir = seen.find((l) => real(l) !== real(S));
      const leftovers = (() => { try { return fs.readdirSync(path.join(S, '.studio', 'tmp')).filter((x) => /^studio-div/.test(x)); } catch { return []; } })();
      await guard('2.79 (d, 2.12): the divergence reference is checked out and run under <repo>/.studio/tmp (where node finds the repo\'s node_modules), not the system temp folder, and the folder is removed afterwards (fails on 2.78.2: mkdtemp in os.tmpdir(), where a build finds no node_modules)', () => [
        r.status === 0 && Boolean(refDir) && real(refDir).startsWith(under + path.sep) && leftovers.length === 0,
        JSON.stringify({ seen, under, leftovers, r: out(r).slice(-300) })]);
    }

    // ---- 2.13: a Director's or reviewer's task with no type set skips the game's checks on notes only ----
    {
      const st = studio('skip');
      const { S, env } = st;
      const probeSkip = (type, files, role) => probe(S, `const d = await import(${u(S, 'harness/done-check.mjs')}); console.log(JSON.stringify(d.skipGameChecks(${JSON.stringify(type)}, ${JSON.stringify(files)}, process.env, ${JSON.stringify({ role })})));`, env).j;
      const typed = probeSkip('direction', ['studio/notes/plan.md'], 'director');
      const titledBug = probeSkip('chore', ['studio/notes/plan.md'], 'director');
      const reviewerChange = probeSkip('change', ['studio/reviews/x.md', 'docs/a.md'], 'reviewer');
      const withCode = probeSkip('bug', ['studio/notes/plan.md', 'cartridges/demo/sim.js'], 'director');
      const builder = probeSkip('bug', ['studio/notes/plan.md'], 'builder');
      await guard('2.79 (d, 2.13): a Director\'s or reviewer\'s task that changed only notes, docs or studio records skips the game\'s checks whether or not a type is set on it (a title with a prefix such as "Chore: …" types it "chore"); a builder task, or a director task that changed game code, still runs them; task.mjs passes the task\'s role (fails on 2.78.2: only the types direction/review/docs/idea/research/study skipped, so a director task typed "bug" by its title ran the whole game suite)', () => [
        typed?.skip === true && titledBug?.skip === true && reviewerChange?.skip === true && withCode?.skip === false && builder?.skip === false
          && /role: target\.role/.test(textIn(S, 'harness/task.mjs')),
        JSON.stringify({ typed, titledBug, reviewerChange, withCode, builder })]);
    }

    // ---- 2.14: the quarantine line never says "skipped" for a test config that ignores the list ----
    {
      const st = studio('quar');
      const { S, env } = st;
      const FAKE = [
        "import fs from 'node:fs'; import path from 'node:path'; import { pathToFileURL } from 'node:url';",
        "const cfg = (await import(pathToFileURL(path.resolve('vitest.config.mjs')).href + `?t=${Date.now()}`)).default || {};",
        "const ex = (cfg.exclude || []).map(String);",
        "const args = process.argv.slice(2); const sub = args[0]; const pos = args.slice(1).filter((a) => !a.startsWith('-') && !/^\\d+$/.test(a));",
        "const all = fs.readdirSync('tests').filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);",
        "let list = (pos.length ? pos : all).filter((f) => !ex.some((e) => f === e || f.endsWith(`/${e}`)));",
        "if (sub === 'list') { for (const f of list) console.log(f); process.exit(0); }",
        "for (const f of list) console.log(` \\u2713 ${f} (1 test)`);",
        "console.log(`Test Files  ${list.length} passed (${list.length})`);", ''].join('\n');
      writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
      writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'cd game/demo && npm test' }] }, null, 2)}\n`);
      writeIn(S, 'game/demo/package.json', `${JSON.stringify({ name: 'demo', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2)}\n`);
      writeIn(S, 'game/demo/vitest.config.mjs', 'export default { exclude: [] };\n');
      writeIn(S, 'game/demo/fake-vitest.mjs', FAKE);
      writeIn(S, 'game/demo/node_modules/.bin/vitest', '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.mjs" "$@"\n');
      try { fs.chmodSync(path.join(S, 'game/demo/node_modules/.bin/vitest'), 0o755); } catch {}
      writeIn(S, 'game/demo/node_modules/.bin/vitest.cmd', '@node "%~dp0\\..\\..\\fake-vitest.mjs" %*\r\n');
      for (const t of ['a', 'b']) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
      writeIn(S, 'studio/quarantine.json', `${JSON.stringify([{ test: 'tests/b.test.mjs', status: 'active', check: 'game:unit' }], null, 2)}\n`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'web game', '--no-verify');
      const r = spawnSync(process.execPath, ['harness/game-gates.mjs'], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180000 });
      const text = out(r);
      await guard('2.79 (d, 2.14): with a quarantined test file and a test config that never reads STUDIO_TEST_QUARANTINE, the game check never says it "skipped" the file (it says the config does not honour the list) (already fixed in 2.78.2: "skipped" needs the runner\'s list mode to confirm it; kept as a regression check)', () => [
        !/skipped by the game's runner/.test(text) && /quarantine NOT honoured/.test(text),
        text.slice(-700)]);
    }
  } finally {
    for (const k of kids) { try { process.kill(k, 'SIGKILL'); } catch {} }
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
  }
  void crypto; void until; void readIn;
}
