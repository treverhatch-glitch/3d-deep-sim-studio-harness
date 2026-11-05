/**
 * qa/selftest-2773b.mjs — 2.77.3 (b): a crew's 48-hour run on 2.77.1 (H2/B-112, C2/B-108, M6).
 *   H2  after a flake verdict of "real: fails when run alone" a train sat idle for 35+ min holding train.lock (its status
 *       still "verify 1 … ETA ~4 min"): it went on running the other failing files alone, each a child that could wait
 *       (for a slot, or forever) with no status. Now the triage ends at the first real label, a busy alone-run is "not
 *       run" (never real), each run shows in the status, and a stall watch ends a train whose status stops moving.
 *   C2  every e2e file had a fixed vite port (strictPort); two verifies of the same file collided and the triager called
 *       it a flake or real. Now "port-collision" is its own label (never real, never quarantined, the lanes not handed
 *       back), and the game gate warns about fixed test ports.
 *   M6  with few heavy slots builders' verifies took every freed slot and the train never found room. Now a train
 *       waiting for a slot gets the next free one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2773B({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readJ = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  // A person's terminal: no agent markers (the runner itself may run inside an agent's shell).
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_VERIFY_DETACH: 'off',
    STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TRAIN_BISECT: 'prefix', STUDIO_LANDING_BUILD: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2773b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_config_node_options: '', npm_lifecycle_event: '', CLAUDECODE: '',
  };
  let n = 0;
  const made = [];
  // A studio with a made-up game: game/demo's runner reads game/demo/notes/*.md (a lane adds them):
  //   RED <file>        the file fails;   HANGALONE <file>  run alone, it never ends (a child that waits forever);
  //   PORT <file>       beside other files it fails on "Port 46117 is already in use"; alone it passes;
  //   HANG              every run of the tests never ends.
  const studio = (name) => {
    const S = path.join(tmpRoot, `2773b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2773b.jsonl');
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
      "try { fs.appendFileSync(path.join(main, '.studio', 'runs-2773b.log'), `${list.join(',')}\\n`); } catch {}",
      "const hang = () => { console.log('[demo] waiting forever'); setTimeout(() => process.exit(9), 150000); };",
      "if (/^HANG$/m.test(notes)) hang();",
      "else if (list.length === 1 && notes.includes(`HANGALONE ${path.basename(list[0])}`)) hang();",
      "else {",
      "  let bad = 0;",
      "  for (const f of list) {",
      "    const b = path.basename(f);",
      "    if (notes.includes(`RED ${b}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; }",
      "    else if (notes.includes(`PORT ${b}`) && list.length > 1) { console.log('Error: Port 46117 is already in use'); console.log(` FAIL  ${f} > serves the page`); bad += 1; }",
      "    else console.log(` \\u2713 ${f} (1 test)`);",
      "  }",
      "  console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
      "  process.exit(bad ? 1 : 0);",
      "}", ''].join('\n'));
    for (const t of ['a', 'b', 'c']) writeIn(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    writeIn(S, 'studio/NEXT.md', '# Studio Task Queue\n\n## IN_PROGRESS\n- [>] **T-951** [P1] (`builder`) — made-up task T-951\n\n## BACKLOG\n\n## DONE\n');
    fs.rmSync(path.join(S, 'studio', 'beta.json'), { force: true });
    gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    const st = { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
    st.lane = (lname, task, notes) => {
      const d = path.join(S, '.lanes', lname);
      gitIn(S, 'worktree', 'add', '-q', '-b', `lane/${lname}`, d, 'main');
      writeIn(d, 'game/demo/notes/n.md', `${notes}\n`);
      gitIn(d, 'add', '-A');
      gitIn(d, 'commit', '-q', '--no-verify', '-m', `${task}: work`, '-m', `Studio-Task: ${task}`);
      return { task, agent: `builder-${lname}`, dir: d, branch: `lane/${lname}`, head: gitIn(d, 'rev-parse', 'HEAD').stdout.trim(), at: new Date().toISOString() };
    };
    st.queue = (lanes) => writeIn(S, '.studio/train/queue.json', `${JSON.stringify(lanes, null, 2)}\n`);
    st.queued = () => readJ(path.join(S, '.studio/train/queue.json')) || [];
    st.events = () => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    st.runs = () => { try { return fs.readFileSync(path.join(S, '.studio', 'runs-2773b.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
    return st;
  };
  // A probe in its own process group (POSIX) so a hung train and its children are killed as a whole on a timeout.
  const killTree = (child) => {
    try { if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }); else process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  };
  const probeAsync = (S, code, env, ms) => new Promise((resolve) => {
    const f = path.join(S, `.probe-2773b-${++n}.mjs`);
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
  const trainProbe = (S) => `import { runTrain } from ${u(S, 'harness/train.mjs')};
const calls = { handBack: [] }; const logs = [];
const r = await runTrain({ root: process.cwd(), by: 'tester', now: true, quietJob: true, deps: { precheck: (l) => ({ ok: true, head: l.head }), close: () => ({ ok: true }), handBack: (l, note) => calls.handBack.push([l.task, String(note).slice(0, 300)]) }, log: (m) => logs.push(m) });
console.log(JSON.stringify({ ok: r.ok, id: r.id, landed: r.landed, dropped: r.dropped, deferred: r.deferred, held: (r.held || []).map((h) => ({ task: h.task, tier: h.tier, why: h.why })), stalled: r.stalled || null, message: r.message, calls, logs: logs.slice(-30) }));
`;

  // ---- H2 (B-112): the triage ends at the first real label; a train goes on ----
  await guard('2.77.3 (b, H2/B-112): a red train whose first failing file fails alone ("real") goes on at once: the other failing file is not run alone (here that run would never end), the train bisects and hands the lane back as for any real red, its status says "flake check 1 of 2", and train.lock is released (fails on 2.77.2: after the real verdict it ran the next file alone, a child that never returned, holding the lock)', async () => {
    const st = studio('real');
    st.queue([st.lane('r1', 'T-951', 'RED a.test.mjs\nRED b.test.mjs\nHANGALONE b.test.mjs')]);
    // 2.78.2: per-file triage is now STUDIO_FLAKE_TOGETHER=off; the together path is checked in selftest-2782b
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_FLAKE_TOGETHER: 'off' }, 75000);
    const runs = st.runs();
    const triage = st.events().find((e) => e.type === 'test.flake_triage');
    const statuses = (p.j?.logs || []).filter((l) => /flake check 1 of 2: game\/demo\/tests\/a\.test\.mjs alone/.test(l));
    const ok = !p.timedOut && p.j && (p.j.calls.handBack || []).some(([t]) => t === 'T-951') && !runs.includes('game/demo/tests/b.test.mjs')
      && runs.includes('game/demo/tests/a.test.mjs') && triage && (triage.meta?.labels || []).length === 1 && triage.meta.labels[0].label === 'real'
      && statuses.length === 1 && (p.j.logs || []).some((l) => /1 more failing test file\(s\) not run alone: .*a\.test\.mjs fails alone, so this red is real/.test(l))
      && !fs.existsSync(path.join(st.S, '.studio', 'locks', 'train.lock'));
    return [ok, `${JSON.stringify({ j: p.j, tail: p.j ? '' : p.text.slice(-800) }).slice(0, 2500)}\n${JSON.stringify({ timedOut: p.timedOut, ms: p.ms, runs, labels: triage?.meta?.labels || null, handBack: (p.j?.calls?.handBack || []).map(([t]) => t), lock: fs.existsSync(path.join(st.S, '.studio', 'locks', 'train.lock')) })}`];
  });

  // ---- H2: a busy alone-run is "not run", never "real" ----
  await guard('2.77.3 (b, H2/B-112): a flake alone-run refused for want of a machine:heavy slot ("[heavy] waited … did not run") is "not run": no label, never "real", and the triage stops; the run waits at most STUDIO_FLAKE_WAIT_MIN for a slot (its STUDIO_HEAVY_WAIT_MIN) (fails on 2.77.2: the refusal was labelled "real: fails when run alone")', async () => {
    const st = studio('busy');
    const D = path.join(tmpRoot, `2773b-busy-copy-${process.pid}-${++n}`);
    writeIn(D, 'scripts/run-gates.mjs', [
      "import fs from 'node:fs';",
      "fs.appendFileSync(process.env.WAIT_LOG, `${process.env.STUDIO_HEAVY_WAIT_MIN}\\n`);",
      "console.log('[heavy] waited 7 min for the machine:heavy lock and it is still held: verify (pid 1). game did not run (it never runs on top of other heavy work).');",
      "process.exit(3);", ''].join('\n'));
    made.push(D);
    const waitLog = path.join(D, 'wait.log');
    const text = '[gates] FAIL game\n[game-gates] FAIL game:unit: exit 1\n[game-gates] failing test files in game:unit: ["game/demo/tests/a.test.mjs","game/demo/tests/b.test.mjs"]\n';
    const p = await probeAsync(st.S, `import { flakeTriage } from ${u(st.S, 'harness/train.mjs')};
const lines = [];
const r = flakeTriage({ root: process.cwd(), dir: ${JSON.stringify(D)} }, { id: 'tr-busy', tree: 'cafe1234', text: ${JSON.stringify(text)}, log: (m) => lines.push(m) });
console.log(JSON.stringify({ labels: (r?.labels || []).map((x) => x.label), notRun: r?.notRun || null, lines }));
`, { ...st.env, WAIT_LOG: waitLog, STUDIO_HEAVY_WAIT_MIN: '60', STUDIO_FLAKE_WAIT_MIN: '7' }, 60000);
    const waits = (() => { try { return fs.readFileSync(waitLog, 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
    const rows = (() => { try { return fs.readFileSync(path.join(st.S, '.studio', 'flakes.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; } })();
    const ok = p.j && p.j.labels.length === 0 && /did not run/.test(p.j.notRun?.why || '') && waits.length === 1 && waits[0] === '7' && rows.length === 0;
    return [ok, JSON.stringify({ j: p.j, waits, rows, tail: p.j ? '' : p.text.slice(-1200) }).slice(0, 2500)];
  });

  // ---- H2: the stall watch ends a train whose status stops moving ----
  await guard('2.77.3 (b, H2/B-112): a train whose verify never returns (its status unchanged for STUDIO_TRAIN_STALL_MIN) ends its attempt: the watch stops its children, records task.train.stalled with why, the train ends with nothing landed and nobody handed back, the lane keeps its place in the queue (marked stalledIn), and train.lock is released (fails on 2.77.2: no stall watch; the train held the lock until killed)', async () => {
    const st = studio('stall');
    const lane = st.lane('s1', 'T-951', 'HANG');
    st.queue([lane]);
    const p = await probeAsync(st.S, trainProbe(st.S), { ...st.env, STUDIO_TRAIN_STALL_MIN: '0.12', STUDIO_TRAIN_STALL_GRACE_S: '120' }, 75000);
    const evs = st.events();
    const stalled = evs.find((e) => e.type === 'task.train.stalled');
    const ended = evs.find((e) => e.type === 'task.train.stall_ended');
    const q = st.queued().find((e) => e.task === 'T-951');
    const ok = !p.timedOut && p.j && !(p.j.calls.handBack || []).length && !(p.j.landed || []).length && !(p.j.dropped || []).length && /status stayed at "verify 1/.test(p.j.stalled?.why || '')
      && stalled && /STUDIO_TRAIN_STALL_MIN/.test(stalled.msg) && ended && q && q.stalledIn?.head === lane.head && !fs.existsSync(path.join(st.S, '.studio', 'locks', 'train.lock'));
    return [ok, `${JSON.stringify({ j: p.j, stalled: stalled?.msg, ended: ended?.msg, tail: p.j ? '' : p.text.slice(-800) }).slice(0, 2500)}\n${JSON.stringify({ timedOut: p.timedOut, ms: p.ms, handBack: (p.j?.calls?.handBack || []).map(([t]) => t), stalledIn: q?.stalledIn || null, events: Boolean(stalled) + '/' + Boolean(ended), lock: fs.existsSync(path.join(st.S, '.studio', 'locks', 'train.lock')) })}`];
  });

  await guard('2.77.3 (b, H2/B-112): a train that hangs in its own code (no child to stop) is ended STUDIO_TRAIN_STALL_GRACE_S after the stall, with life.json saying why, so the reaper frees its lock; a check of the train waiting in the machine:heavy queue (a bounded wait) counts as moving (fails on 2.77.2: the process stayed alive, the lock held)', async () => {
    const st = studio('stall2');
    const p = await probeAsync(st.S, `import fs from 'node:fs'; import path from 'node:path';
import { beginTrainLife } from ${u(st.S, 'harness/train-life.mjs')};
const id = '20261105-010203-' + process.pid;
// A check of the train waiting in the machine:heavy queue counts as the train moving (that wait is bounded).
try {
  const w = await import(${u(st.S, 'harness/train-watch.mjs')});
  fs.mkdirSync(path.join('.studio', 'locks'), { recursive: true });
  const qf = path.join('.studio', 'locks', 'machine-heavy-queue-1.wait');
  fs.writeFileSync(qf, JSON.stringify({ pid: 1, owner: 'train-T1-flake' }));
  const unit = { waiting: w.waitingForSlot(process.cwd(), 'T1'), other: w.waitingForSlot(process.cwd(), 'T2'), fireIdle: w.stallLook({ root: process.cwd(), id: 'none', now: Date.now(), limitMs: 1000, start: Date.now() - 5000 }).fire, fireAlive: w.stallLook({ root: process.cwd(), id: 'none', now: Date.now(), limitMs: 1000, start: Date.now() - 5000, alive: Date.now() }).fire };
  fs.rmSync(qf, { force: true });
  fs.writeFileSync(path.join('.studio', 'unit-2773b.json'), JSON.stringify(unit));
} catch {}
beginTrainLife(process.cwd(), { id, by: 'tester' });
fs.mkdirSync(path.join('.studio', 'train', id), { recursive: true });
fs.writeFileSync(path.join('.studio', 'train', id, 'status.json'), JSON.stringify({ train: id, step: 'recheck', text: 're-check 1' }));
fs.writeFileSync(path.join('.studio', 'id-2773b.txt'), id);
setInterval(() => {}, 1000);
await new Promise(() => {});
`, { ...st.env, STUDIO_TRAIN_STALL_MIN: '0.05', STUDIO_TRAIN_STALL_GRACE_S: '2' }, 40000);
    let id = ''; try { id = fs.readFileSync(path.join(st.S, '.studio', 'id-2773b.txt'), 'utf8'); } catch {}
    const life = readJ(path.join(st.S, '.studio', 'train', id, 'life.json'));
    const unit = readJ(path.join(st.S, '.studio', 'unit-2773b.json'));
    const ok = unit?.waiting === true && unit.other === false && unit.fireIdle === true && unit.fireAlive === false && !p.timedOut && life?.stalled?.why2 && /STUDIO_TRAIN_STALL_GRACE_S/.test(life.stalled.why2) && /re-check 1/.test(life.stalled.why || '');
    return [ok, `${p.text.slice(-500)}\n${JSON.stringify({ unit, timedOut: p.timedOut, ms: p.ms, code: p.code, signal: p.signal, stalled: life?.stalled || null })}`];
  });

  // ---- C2a (B-108): port collisions ----
  await guard('2.77.3 (b, C2/B-108): a failing file whose alone-run (or whose red run, when it passes alone) shows "Port N is already in use" / EADDRINUSE is labelled "port-collision" with a why naming the port and saying to give the test a free port; it is never "real", never a load flake, and never proposed for quarantine however often it repeats; a timeout-only re-run with a collision in the output is "port-collision" too (fails on 2.77.2: "real" and "load-flake", quarantined after 3)', async () => {
    const st = studio('pc');
    const p = await probeAsync(st.S, `import fs from 'node:fs'; import path from 'node:path';
import { labelTest, maybeQuarantine, recordTimeoutFlakes, readQuarantine } from ${u(st.S, 'harness/flakes.mjs')};
const seq = (...r) => { let i = 0; return () => r[i++] || { ok: true }; };
const alone = labelTest({ check: 'game:unit', file: 'game/demo/tests/panel.e2e.test.mjs', runAlone: seq({ ok: false, text: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:46117\\n FAIL  game/demo/tests/panel.e2e.test.mjs > opens' }) });
const red = labelTest({ check: 'game:unit', file: 'game/demo/tests/hud.e2e.test.mjs', runAlone: seq({ ok: true }, { ok: true }), redText: 'Error: Port 46200 is already in use\\n FAIL  game/demo/tests/hud.e2e.test.mjs > lays out' });
// 2.78.0 (PU-56): a file that fails alone is re-run at quiet low load before it is real, so the plain failure fails both runs.
const real = labelTest({ check: 'game:unit', file: 'game/demo/tests/x.test.mjs', runAlone: seq({ ok: false, text: ' FAIL  x > adds up' }, { ok: false, text: ' FAIL  x > adds up' }) });
const root = process.cwd();
fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
let q = null;
for (let i = 0; i < 4; i += 1) { const row = { at: new Date().toISOString(), test: 'game/demo/tests/hud.e2e.test.mjs', check: 'game:unit', label: red.label, why: red.why }; fs.appendFileSync(path.join(root, '.studio', 'flakes.jsonl'), JSON.stringify(row) + '\\n'); q = maybeQuarantine(root, row) || q; }
const tf = recordTimeoutFlakes(root, { check: 'game:unit', files: ['game/demo/tests/hall.e2e.test.mjs'], text: 'Error: Port 46341 is already in use\\nTest timed out in 120000ms' });
console.log(JSON.stringify({ alone, red, real: real.label, q, list: readQuarantine(root), tf: tf.map((r) => ({ label: r.label, why: r.why })) }));
`, st.env, 60000);
    const j = p.j || {};
    const ok = j.alone?.label === 'port-collision' && /port 46117/.test(j.alone.why) && /free port/.test(j.alone.why) && /Not a timing flake/.test(j.alone.why)
      && j.red?.label === 'port-collision' && j.red.runs.length === 1 && /port 46200/.test(j.red.why) && j.real === 'real' && !j.q && !(j.list || []).length
      && j.tf?.[0]?.label === 'port-collision' && /port 46341/.test(j.tf[0].why);
    return [ok, `${p.j ? '' : p.text.slice(-600)}\n${JSON.stringify({ alone: j.alone?.label, aloneWhy: String(j.alone?.why || '').slice(0, 120), red: j.red?.label, redRuns: j.red?.runs?.length, real: j.real, quarantined: Boolean(j.q), list: (j.list || []).length, timeout: j.tf?.[0]?.label })}`];
  });

  await guard('2.77.3 (b, C2/B-108): a train red only on a port collision (the file passes alone) hands nobody back: the lane waits for the next train (task.train.port_collision names the port), and a second train that hits it at the same head holds the lane for the Producer instead of looping (fails on 2.77.2: the bisection with the whole gate named the lane the culprit and handed it back)', async () => {
    const st = studio('pctrain');
    const lane = st.lane('p1', 'T-951', 'PORT c.test.mjs');
    st.queue([lane]);
    const p1 = await probeAsync(st.S, trainProbe(st.S), st.env, 90000);
    const q1 = st.queued().find((e) => e.task === 'T-951');
    const p2 = await probeAsync(st.S, trainProbe(st.S), st.env, 90000);
    const q2 = st.queued().find((e) => e.task === 'T-951');
    const pc = st.events().find((e) => e.type === 'task.train.port_collision');
    const ok = p1.j && !(p1.j.calls.handBack || []).length && (p1.j.deferred || []).some((d) => d.task === 'T-951' && /port collision/.test(d.why)) && q1?.portCollisionIn?.head === lane.head
      && pc && /46117/.test(pc.msg) && p2.j && !(p2.j.calls.handBack || []).length && (p2.j.held || []).some((h) => h.task === 'T-951') && q2?.held;
    return [ok, `${JSON.stringify({ j1: p1.j, j2: p2.j, pc: pc?.msg, tail: p1.j ? '' : p1.text.slice(-800) }).slice(0, 2500)}\n${JSON.stringify({ handBack1: (p1.j?.calls?.handBack || []).map(([t]) => t), deferred1: (p1.j?.deferred || []).map((d) => d.task), portIn1: q1?.portCollisionIn || null, handBack2: (p2.j?.calls?.handBack || []).map(([t]) => t), held2: (p2.j?.held || []).map((h) => h.task), q2held: Boolean(q2?.held), event: Boolean(pc) })}`];
  });

  // ---- C2b: fixed test ports are flagged (advisory), and the template ships none ----
  await guard('2.77.3 (b, C2/B-108): the game gate warns (advisory, the check still passes) about an e2e test or test config that starts a server on a fixed port with strictPort, naming file:line and the port; a test on port 0 and a config with strictPort: false are not flagged; the example cartridge, the template and the harness\'s own configs have none; studio/rules/test-ports.md says why (fails on 2.77.2: no such check)', async () => {
    const st = studio('ports');
    writeIn(st.S, 'game/demo/tests/e2e/panel.e2e.test.mjs', "const server = await createServer({ server: { port: 46117, strictPort: true } });\n");
    writeIn(st.S, 'game/demo/tests/e2e/free.e2e.test.mjs', "const server = await createServer({ server: { port: 0, strictPort: true } });\n");
    writeIn(st.S, 'game/demo/vite.config.mjs', "export default { server: { port: 5199, strictPort: false } };\n");
    const r = run(st.S, 'node scripts/run-gates.mjs --no-detach --only game', st.env);
    const t = out(r);
    const warns = t.split('\n').filter((l) => /WARN game:test-ports/.test(l));
    const scan = run(st.S, 'node harness/test-ports.mjs --json cartridges web vite.config.mjs', st.env);
    let sj = null; try { sj = JSON.parse(String(scan.stdout || '').trim().split('\n').pop()); } catch {}
    const ok = r.status === 0 && /WARN game:test-ports: game\/demo\/tests\/e2e\/panel\.e2e\.test\.mjs:1 starts a test server on the fixed port 46117/.test(t) && !warns.some((l) => /free\.e2e|5199/.test(l))
      && sj && Array.isArray(sj.findings) && sj.findings.length === 0 && fs.existsSync(path.join(harnessRoot, 'studio', 'rules', 'test-ports.md'));
    const why = { status: r.status, warn: /WARN game:test-ports: game\/demo\/tests\/e2e\/panel\.e2e\.test\.mjs:1 starts a test server on the fixed port 46117/.test(t), others: warns.filter((l) => /free\.e2e|5199/.test(l)), sj: Boolean(sj), findings: sj?.findings?.length };
    return [ok, `${t.split('\n').filter((l) => /test-ports/.test(l)).join('\n').slice(-900)}\n${JSON.stringify({ ...why, rule: fs.existsSync(path.join(harnessRoot, 'studio', 'rules', 'test-ports.md')), scan: out(scan).slice(-300) })}`];
  });

  // ---- M6: a train waiting for a slot gets the next free one ----
  await guard('2.77.3 (b, M6): while a merge train waits for a machine:heavy slot (the train-wait marker), a builder\'s verify doesn\'t take a free slot (it waits, naming the train), a train\'s landing check takes it and clears the marker, the train\'s release leaves a short hand-off for its next check, and a daemon pass that finds no room leaves the marker (fails on 2.77.2: the builder took the slot; no marker)', async () => {
    const st = studio('m6');
    const p = await probeAsync(st.S, `import fs from 'node:fs'; import path from 'node:path';
import * as H from ${u(st.S, 'harness/heavy.mjs')};
import { trainDaemonPass } from ${u(st.S, 'harness/train-daemon.mjs')};
const root = process.cwd();
const locks = path.join(root, '.studio', 'locks');
fs.mkdirSync(locks, { recursive: true });
const marker = path.join(locks, 'machine-heavy-train-wait.json');
const now = Date.now();
fs.writeFileSync(marker, JSON.stringify({ at: now, seen: now, ttlMs: 300000, why: 'train daemon: no room', pid: process.pid }));
const r = {};
const lines = [];
try { const lk = H.acquireHeavy(root, 'builder verify', { kind: 'verify', env: { ...process.env, STUDIO_GATE_PRIORITY: '' }, log: (m) => lines.push(m) }); r.builder = 'took it'; lk.release(); } catch (e) { r.builder = e.code || e.message; r.builderMsg = e.message; }
try { const lk = H.acquireHeavy(root, 'train verify', { kind: 'verify', owner: 'train-x1', env: { ...process.env, STUDIO_GATE_PRIORITY: 'landing', STUDIO_LOCK_OWNER: 'train-x1' } }); r.train = 'took it'; r.clearedOnTake = !fs.existsSync(marker); lk.release(); } catch (e) { r.train = e.code || e.message; }
const ho = (() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; } })();
r.handoff = Boolean(ho && ho.handoff);
try { fs.rmSync(marker, { force: true }); } catch {}
const hold = H.acquireHeavy(root, 'a builder verify', { kind: 'verify', env: { ...process.env, STUDIO_GATE_PRIORITY: '' } });
const env = { ...process.env };
const d = await trainDaemonPass({ root, env, queue: [{ task: 'T-951', at: new Date(0).toISOString() }], lock: null, running: null, next: null, stopped: null, winddown: null, drain: null, rules: { min: 1, waitMin: 0 }, heldNow: () => false, heldOut: () => false, spawnTrain: () => { throw new Error('must not start'); } });
r.daemon = d;
r.daemonMarker = (() => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; } })();
hold.release();
console.log(JSON.stringify({ r, lines: lines.slice(-4) }));
`, { ...st.env, STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_WAIT_MIN: '0.05', STUDIO_HEAVY_POLL_MS: '200', STUDIO_TRAIN_AUTO: '', STUDIO_TRAIN: '' }, 60000);
    const r = p.j?.r || {};
    const ok = r.builder === 'HEAVY_BUSY' && /merge train waiting for the next free slot/.test(r.builderMsg || '') && r.train === 'took it' && r.clearedOnTake === true && r.handoff === true
      && r.daemon?.started === false && /no room on the machine/.test(r.daemon.why || '') && /takes the next free slot/.test(r.daemon.why || '') && r.daemonMarker && !r.daemonMarker.handoff && /no room|budget|slot/.test(r.daemonMarker.why || '');
    return [ok, `${p.j ? JSON.stringify(p.j.lines) : p.text.slice(-600)}\n${JSON.stringify(r)}`.slice(-1500)];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}
