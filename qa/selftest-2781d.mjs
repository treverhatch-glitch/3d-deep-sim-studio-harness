/**
 * qa/selftest-2781d.mjs — 2.78.1 (d): the crew's train and handout bugs after a day on 2.78.0.
 *   Load     T-173 bounced 3 times on tests that pass alone while Unity and builders shared the PC; the PU-56 quiet
 *            re-run waits for a quiet machine every time. A file the record already trusts as load-sensitive
 *            (STUDIO_LOAD_SENSITIVE_TRUST quiet-confirmed labels, never real since) skips the quiet wait; the alone
 *            low-load pass is still required; the train logs "trusted".
 *   B-114    "T-124 waiting on T-152: done, but 14 commits on lane/builder-agy11 not merged yet" after T-152's work landed
 *            through another task (new hashes), a rescue, or before the event window.
 *   Partial  T-173 landed its checked commits but stayed open: its lane gained a merge of main after the check.
 *   Empty    a tier-A close-out lane that changes no file still waited for a full train verify.
 *   B-106    a discarded speculative train was reported "died silently" (train-dead alert).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
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
    STUDIO_TRAIN_PIPELINE: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  let n = 0;
  const made = [];
  const F = 'game/demo/tests/a.test.mjs';
  // A studio with a made-up game: game/demo's runner reads game/demo/notes/*.md (a lane adds them):
  //   RED <file>   the file fails;   LOAD <file>   it fails unless it runs with one test worker (STUDIO_TEST_WORKERS=1).
  // Every run is logged in .studio/runs-2781d.log (so a test can tell whether a verify ran).
  const studio = (name) => {
    const S = path.join(tmpRoot, `2781d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2781d.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    writeIn(S, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
    writeIn(S, 'game/demo/run-tests.mjs', [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const files = process.argv.slice(2);",
      "const d = 'game/demo/tests';",
      "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
      "const notes = fs.existsSync('game/demo/notes') ? fs.readdirSync('game/demo/notes').map((f) => fs.readFileSync(path.join('game/demo/notes', f), 'utf8')).join('\\n') : '';",
      "const main = process.env.STUDIO_MAIN_ROOT || process.cwd();",
      "try { fs.appendFileSync(path.join(main, '.studio', 'runs-2781d.log'), `${list.join(',')} workers=${process.env.STUDIO_TEST_WORKERS || '-'}\\n`); } catch {}",
      "let bad = 0;",
      "for (const f of list) {",
      "  const b = path.basename(f);",
      "  if (notes.includes(`RED ${b}`) || (notes.includes(`LOAD ${b}`) && process.env.STUDIO_TEST_WORKERS !== '1')) { console.log(` FAIL  ${f} > adds up`); bad += 1; }",
      "  else console.log(` \\u2713 ${f} (1 test)`);",
      "}",
      "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
      "process.exit(bad ? 1 : 0);", ''].join('\n'));
    for (const t of ['a', 'b']) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-951** [P1] (`builder`) — made-up task T-951\n- [>] **T-952** [P1] (`builder`) — made-up task T-952\n\n## BACKLOG\n\n## DONE\n');
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const st = { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
    // A lane copy with one commit: notes (a file under game/demo/notes) or, with notes === null, an empty commit.
    st.lane = (lname, task, notes, file = 'game/demo/notes/n.md') => {
      const d = path.join(S, '.lanes', lname);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${lname}`, d, 'main');
      if (notes !== null) { writeIn(d, file, `${notes}\n`); gitIn(d, 'add', '-A'); }
      gitIn(d, 'commit', '-q', '--no-verify', ...(notes === null ? ['--allow-empty'] : []), '-m', `${task}: work`, '-m', `Studio-Task: ${task}`);
      return { task, agent: `builder-${lname}`, dir: d, branch: `lane/${lname}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date().toISOString() };
    };
    st.queue = (lanes) => writeIn(S, '.studio/train/queue.json', `${JSON.stringify(lanes, null, 2)}\n`);
    st.queued = () => readJ(path.join(S, '.studio/train/queue.json')) || [];
    st.events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    st.runs = () => { try { return fs.readFileSync(path.join(S, '.studio', 'runs-2781d.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    return st;
  };
  const killTree = (child) => {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  const probeAsync = (S, code, env, ms) => new Promise((resolve) => {
    const f = path.join(S, `.probe-2781d-${++n}.mjs`);
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
  // runTrain with board stubs: close and hand-back are recorded; `onRunning` (code run when the train marks a lane
  // running, i.e. after its check and before its build) lets a test change a lane copy mid-train.
  const trainProbe = (S, onRunning = '') => `import { spawnSync } from 'node:child_process';
import { runTrain } from ${u(S, 'harness/train.mjs')};
const calls = { handBack: [], close: [] }; const logs = [];
const markRunning = (task) => { ${onRunning} };
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: (l, ctx) => { calls.close.push([l.task, ctx.record ? 'record' : 'none']); return { ok: true }; }, handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(0, 300)]), markRunning } , log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, id: r.id, landed: r.landed, dropped: r.dropped, deferred: r.deferred, verifies: r.verifies, message: r.message, calls, logs: logs.slice(-40) }));
`;
  const fake = (...answers) => { const calls = []; const f = (a) => { calls.push(a); const r = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof r === 'function' ? r(a) : r; }; f.calls = calls; return f; };
  const seedTrust = (R, rows, list = true) => {
    fs.mkdirSync(path.join(R, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(R, '.studio', 'flakes.jsonl'), rows.map((r) => JSON.stringify({ test: F, check: 'game:unit', why: 'x', train: 't0', tree: 'aaaa', runs: [], ...r })).join('\n') + (rows.length ? '\n' : ''));
    if (list) fs.writeFileSync(path.join(R, '.studio', 'load-sensitive.json'), `${JSON.stringify([{ test: F, check: 'game:unit', first: rows[0]?.at || '2026-11-04T00:00:00.000Z', last: rows[rows.length - 1]?.at || '2026-11-04T00:00:00.000Z', count: rows.length }], null, 2)}\n`);
  };
  const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();

  // ---- Load failures: a trusted load-sensitive file skips the quiet wait ----
  await guard('2.78.1 (d, load): a file recorded load-sensitive twice in the window on a quiet machine (never real since) that fails alone skips the quiet wait: it runs alone at low load at once (no quiet request, so a machine that never goes quiet doesn\'t make it "real, unconfirmed under load"), passes, and is labelled load-sensitive with trusted:true in .studio/flakes.jsonl; with one label, a "real" label since, STUDIO_LOAD_SENSITIVE_TRUST=off, or a fail at low load it takes the quiet path as before (fails on 2.78.0: always the quiet wait, so here "real")', async () => {
    const { triageRed, readFlakes } = await imp('harness/flakes.mjs');
    const text = `[game-gates] FAIL game:unit: x\n[game-gates] failing test files in game:unit: ["${F}"]\n`;
    // alone (normal load): red; a quiet request: the machine never goes quiet; alone at low load without quiet: green.
    const ra = () => fake((a) => (a.quiet ? { ok: false, quietUnreached: true } : a.lowLoad ? { ok: true } : { ok: false }));
    const one = (name, rows, env = {}, list = true, runAlone = ra()) => {
      const R = fs.mkdtempSync(path.join(tmpRoot, `2781d-${name}-`)); made.push(R);
      seedTrust(R, rows, list);
      const r = triageRed({ root: R, dir: R, text, train: 'tx', tree: 'bbbb', runAlone, env, rng: null, emit: () => {}, now: Date.now() });
      const last = readFlakes(R).pop() || null;
      return { label: r.labels[0]?.label || null, trusted: Boolean(r.labels[0]?.trusted), rowTrusted: Boolean(last?.trusted), quietAsked: runAlone.calls.some((c) => c.quiet), calls: runAlone.calls.map((c) => `${c.lowLoad ? 'low' : 'normal'}${c.quiet ? '+quiet' : ''}`), why: r.labels[0]?.why || '' };
    };
    const two = [{ at: ago(30), label: 'load-sensitive' }, { at: ago(5), label: 'load-sensitive' }];
    const trusted = one('trust', two);
    const single = one('one', two.slice(1));
    const realSince = one('real', [...two, { at: ago(2), label: 'real' }]);
    const offed = one('off', two, { STUDIO_LOAD_SENSITIVE_TRUST: 'off' });
    const unlisted = one('unlisted', two, {}, false);
    const old = one('old', [{ at: ago(24 * 9), label: 'load-sensitive' }, { at: ago(24 * 8), label: 'load-sensitive' }]);
    const selfTrust = one('self', [{ at: ago(30), label: 'load-sensitive', trusted: true }, { at: ago(5), label: 'load-sensitive', trusted: true }]);
    const lowRed = one('lowred', two, {}, true, fake((a) => (a.quiet ? { ok: false } : { ok: false })));
    const ok = trusted.label === 'load-sensitive' && trusted.trusted && trusted.rowTrusted && !trusted.quietAsked && trusted.calls.join(',') === 'normal,low' && /STUDIO_LOAD_SENSITIVE_TRUST/.test(trusted.why)
      && [single, realSince, offed, unlisted, old, selfTrust].every((x) => x.label === 'real' && x.quietAsked && /unconfirmed under load/.test(x.why))
      && lowRed.label === 'real' && lowRed.calls.join(',') === 'normal,low,low+quiet';
    return [ok, JSON.stringify({ trusted, single, realSince, offed, unlisted, old, selfTrust, lowRed })];
  });

  await guard('2.78.1 (d, load): in a train, a lane whose only red is a trusted load-sensitive file lands without waiting for a quiet machine: the file is re-run alone at low load (one test worker), the lane is not handed back, and task.train.load_sensitive says "trusted" (meta.trusted names the file) (fails on 2.78.0: no trusted path; the quiet re-run ran and the event has no "trusted")', async () => {
    const st = studio('trainload');
    seedTrust(st.S, [{ at: ago(30), label: 'load-sensitive' }, { at: ago(5), label: 'load-sensitive' }]);
    st.queue([st.lane('l1', 'T-951', 'LOAD a.test.mjs')]);
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_FLAKE_QUIET_WAIT_MIN: '0.02' }, 150000);
    const evs = st.events();
    const ls = evs.find((e) => e.type === 'task.train.load_sensitive');
    const runs = st.runs();
    const ok = !p.timedOut && p.j && (p.j.landed || []).includes('T-951') && !(p.j.calls.handBack || []).length && ls && /trusted/.test(ls.msg) && (ls.meta?.trusted || []).includes(F)
      && runs.some((r) => r.startsWith(F) && /workers=1/.test(r)) && !(p.j.logs || []).some((l) => /waiting up to .* for a quiet machine/.test(l));
    return [ok, `${JSON.stringify({ j: p.j, ls: ls || null, runs, tail: p.j ? '' : p.text.slice(-1200) }).slice(0, 3500)}`];
  });

  // ---- B-114: a dependency whose work landed through another task, a rescue, or before the event window ----
  await guard('2.78.1 (d, B-114): "waiting on T-152: done, but N commits on lane/… not merged yet" no longer shows when T-152\'s work is on main under other hashes (each commit\'s patch is on main), when a done "Rescue: T-153" task landed, or when T-154\'s landing is older than the 20000-event window (its closing record is in a rolled events file); a forced done with work not on main, and a done task with no record, still wait; STUDIO_DEP_LANDED_EVIDENCE=off restores 2.78.0 (fails on 2.78.0: all three waited)', async () => {
    const st = studio('b114');
    const S = st.S;
    // T-152's branch: two commits; main later got the same changes through another task (cherry-picked: new hashes).
    const mk = (b, files) => { gitIn(S, 'checkout', '-q', '-b', b, 'main'); for (const [f, t] of files) { writeIn(S, f, t); gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-q', '--no-verify', '-m', `${b}: ${f}`); } gitIn(S, 'checkout', '-q', 'main'); };
    mk('lane/builder-agy11', [['game/demo/src/cal.mjs', 'export const cal = 1;\n'], ['game/demo/src/cash.mjs', 'export const cash = 2;\n']]);
    mk('lane/builder-agy12', [['game/demo/src/res.mjs', 'export const res = 3;\n']]);
    mk('lane/builder-agy13', [['game/demo/src/old.mjs', 'export const old = 4;\n']]);
    mk('lane/builder-agy14', [['game/demo/src/forced.mjs', 'export const f = 5;\n']]);
    mk('lane/builder-agy15', [['game/demo/src/none.mjs', 'export const n = 6;\n']]);
    for (const c of gitIn(S, 'rev-list', '--reverse', 'main..lane/builder-agy11').stdout.trim().split('\n')) gitIn(S, 'cherry-pick', '-x', c);
    writeIn(S, 'studio/task-holds.json', `${JSON.stringify({ tasks: { 'T-124': { after: ['T-152'] }, 'T-125': { after: ['T-153'] }, 'T-126': { after: ['T-154'] }, 'T-127': { after: ['T-155'] }, 'T-128': { after: ['T-156'] } } }, null, 2)}\n`);
    writeIn(S, '.studio/lane-branches.json', `${JSON.stringify({ 'T-152': 'lane/builder-agy11', 'T-153': 'lane/builder-agy12', 'T-154': 'lane/builder-agy13', 'T-155': 'lane/builder-agy14', 'T-156': 'lane/builder-agy15' }, null, 2)}\n`);
    const e = (type, task, ts, meta) => JSON.stringify({ ts, type, agent: 'x', task, msg: `${type} ${task || ''}`, ...(meta ? { meta } : {}) });
    const t0 = '2026-11-04T10:00:00.000Z';
    // The rolled file (older): T-154 landed. The live file: 20000 other events, then T-152 forced after its done, the
    // rescue T-184 of T-153 landed by a train while T-153 was forced, T-155 forced.
    fs.writeFileSync(path.join(S, '.studio', 'events-2781d-2026-11-04T09-00-00-000Z.jsonl'), `${e('task.done', 'T-154', t0)}\n${e('lane.merged', 'T-154', t0)}\n`);
    const filler = Array.from({ length: 20000 }, (_, i) => e('agent.heartbeat', null, t0).replace('"msg"', `"i":${i},"msg"`));
    fs.writeFileSync(st.ev, `${filler.join('\n')}\n${[e('task.done', 'T-152', t0), e('task.forced', 'T-152', t0), e('task.done', 'T-153', t0), e('task.forced', 'T-153', t0), e('task.done', 'T-184', t0), e('task.train.landed', null, t0, { train: 'tr1', lanes: ['T-184'] }), e('task.done', 'T-155', t0), e('task.forced', 'T-155', t0)].join('\n')}\n`);
    const code = `import { handoutBlock } from ${u(S, 'harness/handout.mjs')};
import { unmerged } from ${u(S, 'harness/worktree.mjs')};
const q = { done: ['T-152', 'T-153', 'T-154', 'T-155', 'T-156'].map((id) => ({ id, title: 'made-up ' + id })).concat([{ id: 'T-184', title: 'Rescue: T-153 stuck (budget)' }]), inProgress: [], backlog: [] };
const w = (id) => handoutBlock(id, q, { unmerged: (b) => unmerged(b, process.cwd()) })?.why || null;
console.log(JSON.stringify({ carried: w('T-124'), rescue: w('T-125'), old: w('T-126'), forced: w('T-127'), none: w('T-128') }));
`;
    const run = async (env) => (await probeAsync(S, code, { ...st.env, ...env, STUDIO_MAIN_ROOT: S }, 60000)).j;
    const now = await run({});
    const off = await run({ STUDIO_DEP_LANDED_EVIDENCE: 'off' });
    const ok = now && now.carried === null && now.rescue === null && now.old === null && /waiting on T-155: done, but 1 commit on lane\/builder-agy14 not merged yet/.test(now.forced || '') && /waiting on T-156/.test(now.none || '')
      && off && /waiting on T-152: done, but 2 commits/.test(off.carried || '') && /waiting on T-153/.test(off.rescue || '') && /waiting on T-154/.test(off.old || '');
    return [ok, JSON.stringify({ off, now })];
  });

  // ---- Partial landing: only merges of main after the check ----
  await guard('2.78.1 (d, partial): a lane that gained only a merge of main after its check (no new content) closes as landed when the train lands what was checked: deps.close is called, it leaves the queue, task.train.main_merges_only is logged and no task.train.partial; a lane that gained a real commit still lands as checked and stays open and queued (fails on 2.78.0: the merge-of-main lane stayed open and queued, a partial)', async () => {
    const st = studio('partial');
    const a = st.lane('m1', 'T-951', '// T-951 notes', 'game/demo/notes/m1.md');
    const b = st.lane('m2', 'T-952', '// T-952 notes', 'game/demo/notes/m2.md');
    // main moves on (another task's file) after both lanes branched.
    writeIn(st.S, 'game/demo/src/other.mjs', 'export const other = 1;\n'); gitIn(st.S, 'add', '-A'); gitIn(st.S, 'commit', '-qm', 'other task', '--no-verify');
    st.queue([a, b]);
    // Mid-train: T-951's copy merges main (a merge of main, nothing new); T-952's copy commits new work.
    const onRunning = `if (task === 'T-951') spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'merge', '-q', '--no-edit', 'main'], { cwd: ${JSON.stringify(a.dir)} });
if (task === 'T-952') { spawnSync(process.execPath, ['-e', "require('fs').writeFileSync('game/demo/notes/m2b.md', 'more\\\\n')"], { cwd: ${JSON.stringify(b.dir)} }); spawnSync('git', ['add', '-A'], { cwd: ${JSON.stringify(b.dir)} }); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', 'T-952: more'], { cwd: ${JSON.stringify(b.dir)} }); }`;
    const p = await probeAsync(st.S, trainProbe(st.S, onRunning), st.env, 150000);
    const evs = st.events();
    const mm = evs.find((e) => e.type === 'task.train.main_merges_only' && e.task === 'T-951');
    const partial = evs.filter((e) => e.type === 'task.train.partial').map((e) => e.task);
    const q = st.queued().map((e) => e.task);
    const closed = (p.j?.calls?.close || []).map(([t]) => t);
    const aMerged = gitIn(a.dir, 'rev-list', '--parents', '-n', '1', 'HEAD').stdout.trim().split(' ').length === 3;
    const ok = !p.timedOut && p.j && aMerged && mm && closed.includes('T-951') && !closed.includes('T-952') && partial.join(',') === 'T-952' && !q.includes('T-951') && q.includes('T-952') && (p.j.landed || []).includes('T-951');
    return [ok, JSON.stringify({ aMerged, mm: mm?.msg || null, partial, q, closed, j: p.j ? { landed: p.j.landed, message: p.j.message, logs: p.j.logs.slice(-12) } : p.text.slice(-1200) }).slice(0, 3500)];
  });

  // ---- Empty-diff lanes ----
  await guard('2.78.1 (d, empty): a tier-A lane whose tip changes no file against main (an empty close-out commit) lands and closes without a verify (no game check runs, task.train.empty_diff); with a real lane in the same train the empty one lands first and the real one is verified on the new main and lands; STUDIO_TRAIN_EMPTY_DIFF=off verifies it as before (fails on 2.78.0: a full verify of main ran for the empty lane)', async () => {
    const one = studio('empty1');
    const l1 = one.lane('e1', 'T-951', null);
    one.queue([l1]);
    const p1 = await probeAsync(one.S, trainProbe(one.S), one.env, 120000);
    const e1 = one.events().find((e) => e.type === 'task.train.empty_diff');
    const runs1 = one.runs();
    const mixed = studio('empty2');
    mixed.queue([mixed.lane('e2', 'T-951', null), mixed.lane('r2', 'T-952', '// T-952 work')]);
    const p2 = await probeAsync(mixed.S, trainProbe(mixed.S), mixed.env, 150000);
    const e2 = mixed.events().find((e) => e.type === 'task.train.empty_diff');
    const runs2 = mixed.runs();
    const landedEvs = mixed.events().filter((e) => e.type === 'task.train.landed').map((e) => (e.meta?.lanes || []).join('+'));
    const offd = studio('empty3');
    offd.queue([offd.lane('e3', 'T-951', null)]);
    const p3 = await probeAsync(offd.S, trainProbe(offd.S), { ...offd.env, STUDIO_TRAIN_EMPTY_DIFF: 'off' }, 120000);
    const ok = p1.j && (p1.j.landed || []).includes('T-951') && (p1.j.calls.close || []).some(([t, rec]) => t === 'T-951' && rec === 'none') && runs1.length === 0 && e1 && (e1.meta?.lanes || []).join(',') === 'T-951'
      && gitIn(one.S, 'merge-base', '--is-ancestor', l1.head, 'main').status === 0
      && p2.j && ['T-951', 'T-952'].every((t) => (p2.j.landed || []).includes(t)) && e2 && (e2.meta?.lanes || []).join(',') === 'T-951' && runs2.length >= 1 && landedEvs.join(',') === 'T-951,T-952'
      && p3.j && (p3.j.landed || []).includes('T-951') && p3.j.verifies >= 1;
    return [ok, JSON.stringify({ p1: p1.j ? { landed: p1.j.landed, verifies: p1.j.verifies, close: p1.j.calls.close, message: p1.j.message } : p1.text.slice(-800), runs1, e1: e1?.msg || null, p2: p2.j ? { landed: p2.j.landed, verifies: p2.j.verifies, message: p2.j.message } : p2.text.slice(-800), runs2, landedEvs, e2: e2?.meta || null, p3: p3.j ? { landed: p3.j.landed, verifies: p3.j.verifies } : p3.text.slice(-500) }).slice(0, 3500)];
  });

  // ---- B-106: a discarded speculative train is not "dead" ----
  await guard('2.78.1 (d, B-106): a speculative train that started and was discarded (task.train.next_discarded, no done event, heartbeat long stopped) is not reported "died silently", nor is one whose life.json recorded its end; one with neither still is (fails on 2.78.0: the discarded train was a train-dead alert)', async () => {
    const st = studio('b106');
    const at = new Date(Date.now() - 50 * 60000).toISOString();
    const ids = ['20261105-030001-111', '20261105-030002-222', '20261105-030003-333'];
    const lines = ids.map((id) => JSON.stringify({ ts: at, type: 'task.train.start', agent: 'train-next', msg: `train ${id}: started`, meta: { train: id, speculative: true } }));
    lines.push(JSON.stringify({ ts: at, type: 'task.train.next_discarded', agent: 'train-next', msg: `train ${ids[0]}: discarded: train A went red`, meta: { train: ids[0], speculative: true } }));
    fs.writeFileSync(st.ev, `${lines.join('\n')}\n`);
    for (const id of ids) { fs.mkdirSync(path.join(st.S, '.studio', 'train', id), { recursive: true }); fs.writeFileSync(path.join(st.S, '.studio', 'train', id, 'beat'), String(Date.now() - 45 * 60000)); }
    fs.writeFileSync(path.join(st.S, '.studio', 'train', ids[1], 'life.json'), JSON.stringify({ id: ids[1], pid: 1, at, lanes: [], ended: { at, how: 'done', summary: 'discarded' } }));
    const p = await probeAsync(st.S, `import { commFacts, alertsNow } from ${u(st.S, 'harness/communicator.mjs')};
const f = await commFacts({ root: process.cwd(), now: Date.now(), state: {}, deps: { machine: null, needs: [] } });
const a = alertsNow(f, { state: {} }).filter((x) => x.key.startsWith('train-dead:')).map((x) => x.key);
console.log(JSON.stringify({ unended: (f.unendedTrains || []).map((t) => t.id), alerts: a }));
`, st.env, 60000);
    const ok = p.j && p.j.unended.join(',') === ids[2] && p.j.alerts.join(',') === `train-dead:${ids[2]}`;
    return [ok, JSON.stringify({ j: p.j, tail: p.j ? '' : p.text.slice(-800) })];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
  void out;
}
