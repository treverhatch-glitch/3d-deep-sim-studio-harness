/**
 * qa/selftest-2782b.mjs — 2.78.2 (b): a red merge train costs minutes, not hours, on one shared PC.
 *   Together  the flake triager ran each failing file alone, then again at quiet low load: ~20 min a file (4 files:
 *             80 min). A check's failing files now run TOGETHER at low load (one run), then the still-failing ones
 *             together on a quiet machine; each file is labelled from the run's own per-file result, per file when the
 *             output can't be split.
 *   Budget    one red cost 1-2 h (train 111009: 106 min, nothing landed). STUDIO_TRAIN_RED_BUDGET_MIN (30) caps the red
 *             chain: the newest lane is handed back, a prefix lands only on a green full verify, the rest re-queue.
 *   Perf      wall-clock tests (ms budgets) gate merges on a busy PC. A game:perf step runs them alone on a quiet machine;
 *             never quiet: "not run (busy)", a WARN, never red.
 *   Quiet     an engine-porter session counts as "not quiet" (the porter starts and stops Unity between steps).
 *   Spare     the parallel bisect took all 3 heavy slots (a builder verify waited 858 s): it leaves one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782B({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TRAIN_BISECT: 'prefix', STUDIO_LANDING_BUILD: 'off',
    STUDIO_TRAIN_PIPELINE: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  let n = 0;
  const made = [];
  // A studio with a made-up game: game/demo's runner reads game/demo/notes/*.md (a lane adds them):
  //   RED <file>   the file fails;   LOAD <file>   it fails unless it runs with one test worker (STUDIO_TEST_WORKERS=1).
  // It honours STUDIO_TEST_ONLY / STUDIO_TEST_EXCLUDE (globs, as a game's test config does). Every run is logged in
  // .studio/runs-2782b.log: "<files> workers=<n> only=<..> exclude=<..>".
  const studio = (name, { tests = ['a', 'b'] } = {}) => {
    const S = path.join(tmpRoot, `2782b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2782b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/run-tests.mjs', [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const re = (g) => new RegExp(`^${g.split('**/').map((p) => p.split('*').map((x) => x.replace(/[.+?^${}()|[\\]\\\\]/g, '\\\\$&')).join('[^/]*')).join('(?:.*/)?')}$`);",
      "const globs = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map(re);",
      "const only = globs(process.env.STUDIO_TEST_ONLY); const skip = globs(process.env.STUDIO_TEST_EXCLUDE);",
      "const files = process.argv.slice(2);",
      "const d = 'game/demo/tests';",
      "let list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
      "if (only.length) list = list.filter((f) => only.some((r) => r.test(f)));",
      "list = list.filter((f) => !skip.some((r) => r.test(f)));",
      "const notes = fs.existsSync('game/demo/notes') ? fs.readdirSync('game/demo/notes').map((f) => fs.readFileSync(path.join('game/demo/notes', f), 'utf8')).join('\\n') : '';",
      "const main = process.env.STUDIO_MAIN_ROOT || process.cwd();",
      "try { fs.appendFileSync(path.join(main, '.studio', 'runs-2782b.log'), `${list.join(',')} workers=${process.env.STUDIO_TEST_WORKERS || '-'} only=${process.env.STUDIO_TEST_ONLY || '-'} exclude=${process.env.STUDIO_TEST_EXCLUDE || '-'}\\n`); } catch {}",
      "let bad = 0;",
      "for (const f of list) {",
      "  const b = path.basename(f);",
      "  if (notes.includes(`RED ${b}`) || (notes.includes(`LOAD ${b}`) && process.env.STUDIO_TEST_WORKERS !== '1')) { console.log(` FAIL  ${f} > adds up`); bad += 1; }",
      "  else console.log(` \\u2713 ${f} (1 test)`);",
      "}",
      "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
      "process.exit(bad ? 1 : 0);", ''].join('\n'));
    for (const t of tests) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-951** [P1] (`builder`) — made-up task T-951\n- [>] **T-952** [P1] (`builder`) — made-up task T-952\n- [>] **T-953** [P1] (`builder`) — made-up task T-953\n\n## BACKLOG\n\n## DONE\n');
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'game.json'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'quarantine.json'), { force: true });
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const st = { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
    let tick = 0;
    // A lane copy with one commit (a notes file); `at` is its queue time (later = newer).
    st.lane = (lname, task, notes, file = `game/demo/notes/${lname}.md`) => {
      const d = path.join(S, '.lanes', lname);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${lname}`, d, 'main');
      writeIn(d, file, `${notes}\n`); gitIn(d, 'add', '-A');
      gitIn(d, 'commit', '-q', '--no-verify', '-m', `${task}: work`, '-m', `Studio-Task: ${task}`);
      return { task, agent: `builder-${lname}`, dir: d, branch: `lane/${lname}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date(Date.now() - 3600000 + (tick += 1) * 60000).toISOString() };
    };
    st.queue = (lanes) => writeIn(S, '.studio/train/queue.json', `${JSON.stringify(lanes, null, 2)}\n`);
    st.queued = () => readJ(path.join(S, '.studio/train/queue.json')) || [];
    st.events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    st.runs = () => { try { return fs.readFileSync(path.join(S, '.studio', 'runs-2782b.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    st.flakes = () => { try { return fs.readFileSync(path.join(S, '.studio', 'flakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    return st;
  };
  const killTree = (child) => {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  const probeAsync = (S, code, env, ms) => new Promise((resolve) => {
    const f = path.join(S, `.probe-2782b-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const child = spawn(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let so = ''; let se = '';
    child.stdout.on('data', (d) => { so += d; }); child.stderr.on('data', (d) => { se += d; });
    const timer = setTimeout(() => { killTree(child); }, ms);
    const t0 = Date.now();
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const l = so.split('\n').filter((x) => x.startsWith('{')).pop();
      let j = null; try { j = JSON.parse(l); } catch {}
      resolve({ code, signal, j, ms: Date.now() - t0, timedOut: Date.now() - t0 >= ms - 50, text: `${so}${se}` });
    });
  });
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  // runTrain with board stubs: close and hand-back are recorded.
  const trainProbe = (S) => `import { runTrain } from ${u(S, 'harness/train.mjs')};
const calls = { handBack: [], close: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: (l, ctx) => { calls.close.push([l.task, ctx.record ? 'record' : 'none']); return { ok: true }; }, handBack: (l, note) => calls.handBack.push([l.task, String(note).replace(/^[\\s\\S]*?End of hand-back facts\\.\\n/, '').slice(0, 900)]) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, id: r.id, landed: r.landed, dropped: r.dropped, deferred: r.deferred, verifies: r.verifies, rechecks: r.rechecks || 0, message: r.message, calls, logs: logs.slice(-40) }));
`;
  const fake = (fn) => { const calls = []; const f = (a) => { calls.push(a); return fn(a); }; f.calls = calls; return f; };
  const failText = (check, files) => `[game-gates] FAIL ${check}: exit 1\n[game-gates] failing test files in ${check}: ${JSON.stringify(files)}\n`;

  // ---- Together: a check's failing files run in one run, then one quiet re-run ----
  await guard('2.78.2 (b, together): with STUDIO_FLAKE_TOGETHER=on, four failing files of one check are triaged in three runs, not eight: all four together at low load, the three still failing together at quiet low load, then the first still failing BY ITSELF (real only once it fails alone; the triage stops at the first real), each labelled from that run\'s per-file result (load-flake, load-sensitive, real; runs[].together in the rows); a file that fails only beside the others passes by itself and is load-flake, not real; an output that names no failing file falls back to one run per file; unset (the default, the owner\'s call) is together like on; STUDIO_FLAKE_TOGETHER=off: one run per file, as 2.78.1 (fails on 2.78.1: one or two runs per file)', async () => {
    const { triageRed } = await imp('harness/flakes.mjs');
    const files = ['game/demo/tests/a.test.mjs', 'game/demo/tests/b.test.mjs', 'game/demo/tests/c.test.mjs', 'game/demo/tests/d.test.mjs'];
    const text = failText('game:unit', files);
    // a passes at low load; b passes once the machine is quiet; c and d fail everywhere (crowd: c fails only beside others).
    const mk = (crowd) => (a) => {
      const list = a.files || [a.file];
      const f = list.filter((x) => (crowd && /c\.test/.test(x) ? list.length > 1 : a.quiet ? /[cd]\.test/.test(x) : a.lowLoad ? !/a\.test/.test(x) : true));
      return { ok: !f.length, text: f.length ? failText('game:unit', f) : 'ok' };
    };
    const one = (name, runAlone, env = { STUDIO_FLAKE_TOGETHER: 'on' }) => {
      const R = fs.mkdtempSync(path.join(tmpRoot, `2782b-${name}-`)); made.push(R);
      const r = triageRed({ root: R, dir: R, text, train: 'tx', tree: 'bbbb', runAlone, env: { STUDIO_FLAKE_QUIET_WAIT_MIN: '0', ...env }, rng: null, emit: () => {}, now: Date.now(), together: true });
      return { labels: r.labels.map((l) => `${path.basename(l.test)}:${l.label}`), together: r.labels.map((l) => (l.runs || []).map((x) => x.together || 0).join('/')), calls: runAlone.calls.map((c) => `${(c.files || [c.file]).map((f) => path.basename(f, '.test.mjs')).join('')}${c.lowLoad ? '-low' : ''}${c.quiet ? '-quiet' : ''}`), real: r.real || null };
    };
    const tog = one('tog', fake(mk(false)));
    const crowd = one('crowd', fake(mk(true)));
    const noname = one('noname', fake((a) => ((a.files || []).length > 1 ? { ok: false, text: '[game-gates] FAIL game:unit: exit 1\n' } : mk(false)(a))));
    const dflt = one('default', fake(mk(false)), {});
    const offed = one('off', fake(mk(false)), { STUDIO_FLAKE_TOGETHER: 'off' });
    const perFile = (x) => x.calls.every((c) => /^[abcd](-|$)/.test(c));
    const ok = tog.calls.join(',') === 'abcd-low,bcd-low-quiet,c-low-quiet' && tog.labels.join(',') === 'a.test.mjs:load-flake,b.test.mjs:load-sensitive,c.test.mjs:real' && tog.together.join(',') === '4,4/3,4/3/0' && /c\.test/.test(tog.real || '')
      && crowd.calls.join(',') === 'abcd-low,bcd-low-quiet,c-low-quiet,d-low-quiet' && crowd.labels.join(',') === 'a.test.mjs:load-flake,b.test.mjs:load-sensitive,c.test.mjs:load-flake,d.test.mjs:real'
      && noname.calls[0] === 'abcd-low' && noname.calls.length > 2 && noname.calls.slice(1).every((c) => /^[abcd](-|$)/.test(c))
      && dflt.calls.join(',') === tog.calls.join(',') && dflt.labels.join(',') === tog.labels.join(',') && !perFile(dflt) && perFile(offed);
    return [ok, JSON.stringify({ tog, crowd, noname, dflt: dflt.calls, offed: offed.calls })];
  });

  await guard('2.78.2 (b, together): in a train with STUDIO_FLAKE_TOGETHER=on, three failing files of one check (LOAD: they fail unless one test worker runs them) run alone in ONE run with all three at one test worker, and each gets its own label in .studio/flakes.jsonl (no single-file low-load run) (fails on 2.78.1: each file ran alone, then again on its own at quiet low load)', async () => {
    const st = studio('trainTog', { tests: ['a', 'b', 'c'] });
    st.queue([st.lane('l1', 'T-951', 'LOAD a.test.mjs\nLOAD b.test.mjs\nLOAD c.test.mjs')]);
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_FLAKE_QUIET_WAIT_MIN: '0.02', STUDIO_FLAKE_TOGETHER: 'on' }, 200000);
    const runs = st.runs();
    const low = runs.filter((r) => / workers=1 /.test(r));
    const rows = st.flakes();
    const all3 = (r) => ['a', 'b', 'c'].every((t) => r.includes(`game/demo/tests/${t}.test.mjs`));
    const ok = !p.timedOut && p.j && low.length === 1 && all3(low[0]) && rows.length === 3 && rows.every((r) => r.runs?.[0]?.together === 3 && r.label === 'load-flake');
    return [ok, JSON.stringify({ runs, rows: rows.map((r) => [r.test, r.label, r.runs]), j: p.j ? { dropped: p.j.dropped, logs: p.j.logs.slice(-14) } : p.text.slice(-1500) }).slice(0, 3800)];
  });

  // ---- Budget: the red chain is capped ----
  await guard('2.78.2 (b, budget): past STUDIO_TRAIN_RED_BUDGET_MIN the train stops (no quiet re-run, no bisect re-check): it hands back the NEWEST lane, saying it ran past its budget with the red\'s summary, lands nothing that no full verify passed, re-queues the other lanes, and logs task.train.red_budget (fails on 2.78.1: no budget; the triage and bisection ran)', async () => {
    const st = studio('budget');
    const a = st.lane('l1', 'T-951', 'RED a.test.mjs');
    const b = st.lane('l2', 'T-952', 'green notes');
    const c = st.lane('l3', 'T-953', 'more green notes');
    st.queue([a, b, c]);
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_TRAIN_RED_BUDGET_MIN: '0.0001', STUDIO_FLAKE_QUIET_WAIT_MIN: '0.02' }, 200000);
    const evs = st.events();
    const rb = evs.find((e) => e.type === 'task.train.red_budget');
    const q = st.queued().map((e) => e.task);
    const hb = (p.j?.calls?.handBack || []).map(([t]) => t);
    const note = (p.j?.calls?.handBack || [])[0]?.[1] || '';
    const ok = !p.timedOut && p.j && hb.join(',') === 'T-953' && /ran past its time budget/.test(note) && /newest lane/.test(note) && /a\.test\.mjs/.test(note)
      && !(p.j.landed || []).length && rb && rb.meta?.handedBack === 'T-953' && (rb.meta?.requeued || []).join(',') === 'T-951,T-952' && q.includes('T-951') && q.includes('T-952') && !q.includes('T-953')
      && p.j.rechecks === 0 && !(p.j.logs || []).some((l) => /again, on a quiet machine/.test(l));
    return [ok, JSON.stringify({ j: p.j ? { landed: p.j.landed, rechecks: p.j.rechecks } : p.text.slice(-1200), hb, q, rb: rb ? rb.meta : null, note: note.slice(0, 300) }).slice(0, 2500)];
  });

  await guard('2.78.2 (b, budget): past the budget, the longest prefix of the other lanes whose exact tree a full verify already passed lands (here T-951\'s own green verify of its tree on main), the newest lane is handed back; STUDIO_TRAIN_RED_BUDGET_MIN=off and 0 mean no cap (fails on 2.78.1: no red_budget event, the chain ran its re-checks)', async () => {
    const st = studio('budgetPrefix');
    const a = st.lane('l1', 'T-951', 'green notes');
    const b = st.lane('l2', 'T-952', 'RED a.test.mjs');
    // T-951's own full verify of its tree (as its builder's verify would leave it).
    const v = spawnSync(process.execPath, [path.join(a.dir, 'scripts', 'run-gates.mjs'), '--no-detach'], { windowsHide: true, cwd: a.dir, env: { ...process.env, ...st.env, STUDIO_LOCK_OWNER: 'builder-l1' }, encoding: 'utf8', timeout: 120000 });
    st.queue([a, b]);
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_TRAIN_RED_BUDGET_MIN: '0.0001' }, 200000);
    const rb = st.events().find((e) => e.type === 'task.train.red_budget');
    const hb = (p.j?.calls?.handBack || []).map(([t]) => t);
    const { redBudgetMin } = await imp('harness/train.mjs');
    const ok = v.status === 0 && !p.timedOut && p.j && (p.j.landed || []).join(',') === 'T-951' && hb.join(',') === 'T-952' && rb && (rb.meta?.landing || []).join(',') === 'T-951' && p.j.rechecks === 0
      && redBudgetMin({}) === 30 && redBudgetMin({ STUDIO_TRAIN_RED_BUDGET_MIN: 'off' }) === 0 && redBudgetMin({ STUDIO_TRAIN_RED_BUDGET_MIN: '0' }) === 0;
    return [ok, JSON.stringify({ verify: v.status, vtail: `${v.stdout || ''}${v.stderr || ''}`.slice(-400), hb, rb: rb ? { msg: rb.msg, meta: rb.meta } : null, j: p.j ? { landed: p.j.landed, rechecks: p.j.rechecks, message: p.j.message, logs: p.j.logs.slice(-12) } : p.text.slice(-1500) }).slice(0, 3800)];
  });

  // ---- Perf: wall-clock tests run alone on a quiet machine ----
  const gg = (S, env) => { const r = spawnSync(process.execPath, ['harness/game-gates.mjs'], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 }); return { status: r.status, text: `${r.stdout || ''}${r.stderr || ''}` }; };
  const porter = (S, pid = process.pid, agent = 'porter-1') => writeIn(S, `.studio/agents/${agent}.json`, JSON.stringify({ agent, role: 'engine-porter', status: 'running', pid, startedAt: new Date().toISOString() }));
  await guard('2.78.2 (b, perf): with perf tests listed (studio/game.json "perfTests", or STUDIO_PERF_TESTS), the unit check leaves them out (STUDIO_TEST_EXCLUDE) and a game:perf step runs only them (STUDIO_TEST_ONLY, one test worker) on a quiet machine: PASS when green, FAIL (red, with its failing file) when red; busy (an engine-porter session) it is "not run (busy)", a WARN and the check stays green; a landing run waits STUDIO_PERF_WAIT_MIN first, holding new verifies back; in a train\'s focused re-check of game:perf, busy is a busy refusal ("[heavy] ... did not run"); STUDIO_PERF_TESTS=off: the perf file runs in the unit check again (fails on 2.78.1: no game:perf step, the perf test ran inside the unit check)', async () => {
    const st = studio('perf', { tests: ['a', 'p.perf'] });
    const S = st.S;
    const env = { ...st.env, STUDIO_GAME: '' };
    writeIn(S, 'studio/game.json', `${JSON.stringify({ game: 'demo', perfTests: ['**/*.perf.test.mjs'] }, null, 2)}\n`);
    const green = gg(S, env);
    const runsGreen = st.runs();
    writeIn(S, 'game/demo/notes/p.md', 'RED p.perf.test.mjs\n');
    const red = gg(S, env);
    porter(S);
    const busy = gg(S, env);
    const t0 = Date.now();
    const landing = gg(S, { ...env, STUDIO_GATE_PRIORITY: 'landing', STUDIO_PERF_WAIT_MIN: '0.03' });
    const landMs = Date.now() - t0;
    const focus = gg(S, { ...env, STUDIO_GATE_FOCUS: JSON.stringify({ 'game:perf': ['game/demo/tests/p.perf.test.mjs'] }) });
    fs.rmSync(path.join(S, '.studio', 'agents'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.studio', 'runs-2782b.log'), { force: true });
    const offed = gg(S, { ...env, STUDIO_PERF_TESTS: 'off' });
    const runsOff = st.runs();
    const P = 'game/demo/tests/p.perf.test.mjs';
    const ok = green.status === 0 && /PASS game:perf/.test(green.text) && /PASS game:unit/.test(green.text)
      && runsGreen.some((r) => r.startsWith('game/demo/tests/a.test.mjs ') && /exclude=\*\*\/\*\.perf\.test\.mjs/.test(r)) && runsGreen.some((r) => r.startsWith(`${P} workers=1 only=**/*.perf.test.mjs`))
      && red.status === 1 && /FAIL game:perf/.test(red.text) && /failing test files in game:perf: \["game\/demo\/tests\/p\.perf\.test\.mjs"\]/.test(red.text) && /PASS game:unit/.test(red.text)
      && busy.status === 0 && /WARN game:perf: not run \(busy\)/.test(busy.text) && /porter-1 \(an engine-porter session/.test(busy.text)
      && landing.status === 0 && /no quiet machine within 0\.03 min \(STUDIO_PERF_WAIT_MIN\)/.test(landing.text) && /holding new builder and lane verifies back/.test(landing.text) && landMs >= 1500
      && focus.status === 1 && /\[heavy\] game:perf did not run/.test(focus.text)
      && offed.status === 1 && !/game:perf/.test(offed.text) && runsOff.some((r) => r.includes(P) && r.includes('a.test.mjs'));
    return [ok, JSON.stringify({ green: green.text.slice(-700), runsGreen, red: red.status, busy: busy.text.split('\n').filter((l) => /game:perf/.test(l)).slice(0, 4), landing: landing.text.split('\n').filter((l) => /game:perf/.test(l)).slice(0, 4), landMs, focus: [focus.status, focus.text.split('\n').filter((l) => /perf/.test(l)).slice(0, 3)], offed: [offed.status, runsOff] }).slice(0, 3800)];
  });

  // ---- Quiet: an engine-porter session is other work ----
  await guard('2.78.2 (b, quiet): a live engine-porter (or engine-worker) session counts as other work for the quiet wait (harness/flake-quiet.mjs otherWork), whether or not Unity runs at that moment; a dead one, the session this process runs in (STUDIO_LOCK_OWNER), another role, or STUDIO_QUIET_BUSY_ROLES=off does not (fails on 2.78.1: only a Unity process counted)', async () => {
    const st = studio('quiet');
    const S = st.S;
    const { otherWork } = await imp('harness/flake-quiet.mjs');
    const e = { ...base, STUDIO_HEAVY_PROGRAMS: 'off' };
    const none = otherWork(S, { env: e });
    porter(S);
    const live = otherWork(S, { env: e });
    const own = otherWork(S, { env: { ...e, STUDIO_LOCK_OWNER: 'porter-1' } });
    const offed = otherWork(S, { env: { ...e, STUDIO_QUIET_BUSY_ROLES: 'off' } });
    fs.rmSync(path.join(S, '.studio', 'agents'), { recursive: true, force: true });
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
    porter(S, dead.pid || 999999, 'porter-dead');
    writeIn(S, '.studio/agents/builder-9.json', JSON.stringify({ agent: 'builder-9', role: 'builder', status: 'running', pid: process.pid }));
    const deadW = otherWork(S, { env: e });
    const ok = none.length === 0 && live.length === 1 && /porter-1 \(an engine-porter session/.test(live[0]) && own.length === 0 && offed.length === 0 && deadW.length === 0;
    return [ok, JSON.stringify({ none, live, own, offed, deadW })];
  });

  // ---- Spare: the parallel bisect leaves a heavy slot for builders ----
  await guard('2.78.2 (b, spare): with 3 machine:heavy slots (STUDIO_HEAVY_SLOTS=3, or in the main checkout\'s .env) and room for more re-checks, the parallel bisect checks at most 2 prefixes at once (max(1, slots - 1)), saying a slot stays free for builders; STUDIO_TRAIN_BISECT_SPARE=0 gives 3; one slot still gives 1 (fails on 2.78.1: 3, every slot)', async () => {
    const st = studio('spare');
    const { bisectWidth } = await imp('harness/train-parallel.mjs');
    const big = { os: { platform: 'linux' }, cores: { logical: 32 }, ram: { totalGb: 128, freeGb: 100 }, gpus: [], at: Date.now() };
    const env = { ...process.env, STUDIO_TRAIN_BISECT_PARALLEL: '4', STUDIO_HEAVY_SLOTS: '3', STUDIO_RESERVE_RAM_GB: '', STUDIO_TEST_WORKERS: '', STUDIO_MACHINE_SCAN: '', STUDIO_HEAVY_SLOTS_LIVE: '', STUDIO_TRAIN_BISECT_SPARE: '' };
    const w3 = await bisectWidth({ root: st.S, env, machine: big, holders: [], nFiles: 1 });
    const w0 = await bisectWidth({ root: st.S, env: { ...env, STUDIO_TRAIN_BISECT_SPARE: '0' }, machine: big, holders: [], nFiles: 1 });
    const w1 = await bisectWidth({ root: st.S, env: { ...env, STUDIO_HEAVY_SLOTS: '1' }, machine: big, holders: [], nFiles: 1 });
    writeIn(st.S, '.env', 'STUDIO_HEAVY_SLOTS=3\n');
    const wf = await bisectWidth({ root: st.S, env: { ...env, STUDIO_HEAVY_SLOTS: '' }, machine: big, holders: [], nFiles: 1 });
    const ok = w3.k === 2 && /stay free for builders \(STUDIO_TRAIN_BISECT_SPARE\)/.test(w3.why) && w0.k === 3 && w1.k === 1 && wf.k === 2;
    return [ok, JSON.stringify({ w3, w0, w1, wf })];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
