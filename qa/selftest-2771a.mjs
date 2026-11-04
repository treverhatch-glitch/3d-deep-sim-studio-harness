/**
 * qa/selftest-2771a.mjs — 2.77.1 (B-98): `task train leave` stops a train that is already running with that lane.
 *   Before 2.77.1 leaveTrain only removed the lane from the queue file; the running train (it checks with spawnSync, so it
 *   only looks between steps) went on with flake re-checks of the old tree for an hour, holding a heavy machine slot.
 *   Now leaveTrain writes .studio/train/<train id>.cancel.json and the train looks for it before each verify, each
 *   re-check and each round, and ends like a train that lands nothing (lanes kept, nobody handed back, a
 *   task.train.cancelled event).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2771A({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_AUTO: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2771a-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const tasks = ['T-941', 'T-942', 'T-943', 'T-944'];
  // A train studio: made-up tasks in progress, lane copies made by git, one gate that is red (and slow) when
  // docs/bad-2771.txt is in the tree and appends a line to .studio/gate-runs-2771.log each time it runs.
  const trainStudio = (name) => {
    const S = path.join(tmpRoot, `2771a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2771a.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'slow', command: 'node qa/slow-2771a.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'qa/slow-2771a.mjs', [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const main = process.env.STUDIO_MAIN_ROOT || process.cwd();",
      "fs.mkdirSync(path.join(main, '.studio'), { recursive: true });",
      "fs.appendFileSync(path.join(main, '.studio', 'gate-runs-2771.log'), 'run\\n');",
      "if (fs.existsSync('docs/bad-2771.txt')) setTimeout(() => { console.log('[slow] FAIL the bad file is in the tree'); process.exit(1); }, 3000);",
      "else console.log('[slow] PASS');", ''].join('\n'));
    writeIn(S, 'studio/NEXT.md', `# Studio Task Queue\n\n## IN_PROGRESS\n${tasks.map((t) => `- [>] **${t}** [P1] (\`builder\`) — made-up task ${t}`).join('\n')}\n\n## BACKLOG\n\n## DONE\n`);
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    const st = { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_TRAIN_BISECT: 'prefix' } };
    st.lane = (lname, task, files) => {
      const d = path.join(S, '.lanes', lname);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${lname}`, d, 'main');
      for (const [rel, text] of Object.entries(files)) writeIn(d, rel, text);
      gitIn(d, 'add', '-A');
      gitIn(d, 'commit', '-q', '--no-verify', '-m', `${task}: work`, '-m', `Studio-Task: ${task}`);
      return { task, agent: `builder-${lname}`, dir: d, branch: `lane/${lname}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date().toISOString() };
    };
    // four lanes; the last one carries the bad file, so a red train bisects through several re-checks
    const lanes = tasks.map((t, i) => st.lane(`a${i}`, t, i === 3 ? { 'docs/bad-2771.txt': 'bad\n' } : { [`docs/ok-${i}-2771a.md`]: `# ${i}\n` }));
    writeIn(S, '.studio/train/queue.json', `${JSON.stringify(lanes, null, 2)}\n`);
    const probe = path.join(tmpRoot, `probe-2771a-${name}-${process.pid}.mjs`);
    fs.writeFileSync(probe, `import { runTrain } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness/train.mjs')).href)};
const calls = { handBack: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: () => ({ ok: true }), handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(0, 300)]) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, deferred: r.deferred, message: r.message, calls, logs: logs.slice(-25) }));
`);
    // the train, started asynchronously (it checks with spawnSync, so a leave must come from another process)
    st.start = () => {
      const child = spawn(process.execPath, [probe], { windowsHide: true, cwd: S, env: { ...process.env, ...st.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let so = ''; let se = '';
      child.stdout.on('data', (d) => { so += d; }); child.stderr.on('data', (d) => { se += d; });
      const done = new Promise((resolve) => child.on('close', (code) => resolve(code)));
      return { child, done, text: () => `${so}${se}`, json: () => { const l = so.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: `${so}${se}`.slice(-2500) }; } } };
    };
    st.events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    st.gateRuns = () => { try { return fs.readFileSync(path.join(S, '.studio', 'gate-runs-2771.log'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    st.queued = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio/train/queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
    return st;
  };
  // Poll a condition (no fixed sleeps): true once it holds, false after ms.
  const until = async (cond, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  await guard('2.77.1 (B-98): `train leave` of a lane in a running train (a slow red that re-checks) stops the train within one step: the re-check in flight finishes, no further re-check or verify starts, a task.train.cancelled event names who and why, nobody is handed back, the other lanes stay queued (fails on 2.77.0: the train goes on re-checking)', async () => {
    const st = trainStudio('leave');
    const t = st.start();
    const sawRecheck = await until(() => st.events().some((e) => e.type === 'task.train.recheck'));
    const before = st.events().filter((e) => e.type === 'task.train.recheck').length;
    const lv = run(st.S, 'node harness/task.mjs train leave T-941 --by tester --why "B-98 test: the lane left"', st.env);
    const closed = await Promise.race([t.done, new Promise((r) => setTimeout(() => r('timeout'), 120000))]);
    if (closed === 'timeout') t.child.kill();
    const j = t.json();
    const evs = st.events();
    const rechecks = evs.filter((e) => e.type === 'task.train.recheck').length;
    const cancelled = evs.find((e) => e.type === 'task.train.cancelled');
    const marker = fs.readdirSync(path.join(st.S, '.studio', 'train')).filter((f) => /\.cancel\.json$/.test(f));
    const ok = sawRecheck && lv.status === 0 && closed !== 'timeout' && rechecks === before && cancelled && /T-941/.test(cancelled.msg) && /tester/.test(cancelled.msg) && /B-98 test/.test(cancelled.msg)
      && !(j.calls?.handBack || []).length && !(j.landed || []).length && !(j.dropped || []).length
      && ['T-942', 'T-943', 'T-944'].every((x) => st.queued().includes(x)) && !st.queued().includes('T-941') && marker.length === 1
      && !fs.existsSync(path.join(st.S, '.studio', 'locks', 'train.lock'));
    return [ok, JSON.stringify({ sawRecheck, before, rechecks, lv: out(lv).slice(-400), closed, j, cancelled: cancelled?.msg, marker, queued: st.queued(), gateRuns: st.gateRuns() }).slice(0, 3000)];
  });

  await guard('2.77.1 (B-98): with no leave, the same train behaves as before: it re-checks more than once and hands the bad lane back (passes on 2.77.0 too)', async () => {
    const st = trainStudio('stay');
    const t = st.start();
    const closed = await Promise.race([t.done, new Promise((r) => setTimeout(() => r('timeout'), 300000))]);
    if (closed === 'timeout') t.child.kill();
    const j = t.json();
    const evs = st.events();
    const rechecks = evs.filter((e) => e.type === 'task.train.recheck').length;
    const ok = closed !== 'timeout' && rechecks >= 2 && !evs.some((e) => e.type === 'task.train.cancelled') && (j.calls?.handBack || []).some(([x]) => x === 'T-944');
    return [ok, JSON.stringify({ closed, rechecks, j, types: [...new Set(evs.map((e) => e.type))] }).slice(0, 3000)];
  });
}
