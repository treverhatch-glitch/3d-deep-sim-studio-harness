/**
 * qa/selftest-279t.mjs — 2.79 (t): the game tester (harness/tester.mjs, qa/tester-drive.mjs) on the Line Producer's
 * schedule, and the stage-1 playtest it replaces in a game studio.
 *   tester-schedule   a run is due only when BOTH STUDIO_TESTER_EVERY_HOURS (24) passed AND STUDIO_TESTER_MIN_LANDINGS
 *                     (10) landings happened since the last run; `now` asks for one anyway; STUDIO_TESTER=off stops the
 *                     schedule, not `now`
 *   tester-no-slot    the Line's testerPass waits on a starved rig and on a taken gate slot, starts the build when a slot
 *                     is free, launches qa-playtester with its own seat (extra 1, detached, tools alternate), and takes no
 *                     heavy slot, no train slot and no task hold, even after a red run
 *   tester-plan       the plan is picked from a seeded RNG over the game's modes/styles/goals, recorded in run.json, and
 *                     the same seed (now --seed) gives the same plan; defaults when the game lists none
 *   tester-brief      the brief lists what landed since the last run (ids and titles), the rotating regression area and
 *                     the Bible's features; the genre comparison only every STUDIO_TESTER_COMPARE_EVERY runs
 *   tester-drive      qa/tester-drive.mjs serves a temp dist folder and drives a tiny page in Chromium (click by testid,
 *                     key, shot, console, state) across separate calls; every action is logged; replay --to <step>
 *                     reproduces the state at that step and screenshots it (skipped with a note without Chromium)
 *   tester-report     finish publishes qa/reports/tester/<run>/ (report, summary.json of the documented shape, shots,
 *                     action log), files each bug as a P1 bug task with its images in studio/proof/<task>/ and the
 *                     replay command, dedupes a bug already open, and sends one inbox item, one tester.report event and
 *                     one Studio Status notice
 *   tester-wire       a landed task with a task.unwired note gets ONE "Wire <module> into the game" task (P2); a second
 *                     pass adds none; STUDIO_TESTER_WIRE_TASKS=off adds none
 *   tester-stage1     a game studio's playtest task passes its done-check with "replaced by the game tester (npm run
 *                     tester)" and the gate runner skips the template playtest gate; a template studio keeps both
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function selftest279T({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const put = (S, rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
  const readIn = (S, rel) => { try { return JSON.parse(fs.readFileSync(path.join(S, rel), 'utf8')); } catch { return null; } };
  const textIn = (S, rel) => { try { return fs.readFileSync(path.join(S, rel), 'utf8'); } catch { return ''; } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_OVERLAP: 'off', STUDIO_REACHABILITY: 'warn', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', CI: '', NODE_OPTIONS: '', npm_lifecycle_event: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279t-${process.pid}.pem`) };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `279t-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'game.json'), { force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    made.push(S);
    return S;
  };
  // A probe: a module run in the temp studio with a clean environment; its last stdout line is JSON.
  let pn = 0;
  const probe = (S, code, env = {}, timeout = 120000) => {
    const f = path.join(S, `.probe-279t-${++pn}.mjs`);
    fs.writeFileSync(f, `import path from 'node:path';\nconst S = ${JSON.stringify(S)};\nconst imp = (rel) => import(new URL(rel, ${JSON.stringify(pathToFileURL(S + path.sep).href)}).href);\n${code}\n`);
    const r = spawnSync(process.execPath, [f], { cwd: S, encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, ...base, ...env } });
    const last = String(r.stdout || '').trim().split('\n').pop();
    let j = null;
    try { j = JSON.parse(last); } catch {}
    return { j, out: `${r.stdout || ''}${r.stderr || ''}`.slice(-1500), status: r.status };
  };
  const HOUR = 3600000;
  const T0 = Date.parse('2026-11-01T00:00:00Z');
  const landedEv = (ids, at) => ({ ts: new Date(at).toISOString(), type: 'task.train.landed', agent: 'train', meta: { lanes: ids } });

  await guard('tester-schedule (fails on 2.78.2: no harness/tester.mjs, so nothing schedules a game tester run)', async () => {
    const S = studio('sched');
    const r = probe(S, `
      const t = await imp('harness/tester.mjs');
      const ev = (k, at) => Array.from({ length: k }, (_, i) => ({ ts: new Date(at + i * 1000).toISOString(), type: i % 2 ? 'lane.merged' : 'task.train.landed', task: 'T-' + (100 + i), meta: { lanes: ['T-' + (100 + i)] } }));
      const T0 = ${T0}, H = ${HOUR};
      const st = (s) => t.writeTesterState(S, s);
      const pass = async (now, events, env = {}) => (await t.testerPass({ root: S, now, env, act: false, rig: { known: true, byRam: 3, cpuHold: false }, deps: { events, gateFree: async () => ({ free: true, why: 'test' }) } }));
      const last = { id: 'r1', at: new Date(T0).toISOString() };
      st({ since: new Date(T0 - 99 * H).toISOString(), last });
      const a = await pass(T0 + 23 * H, ev(12, T0 + H));            // 23 h, 12 landings: not due
      const b = await pass(T0 + 25 * H, ev(9, T0 + H));             // 25 h, 9 landings: not due
      const c = await pass(T0 + 25 * H, ev(10, T0 + H));            // 25 h, 10 landings: due
      const old = await pass(T0 + 25 * H, ev(10, T0 - 5 * H));      // landings before the last run don't count
      const off = await pass(T0 + 25 * H, ev(10, T0 + H), { STUDIO_TESTER: 'off' });
      st({ since: new Date(T0 - 99 * H).toISOString(), last, asked: { by: 'patch', at: new Date(T0 + H).toISOString() } });
      const nowAsk = await pass(T0 + 2 * H, [], { STUDIO_TESTER: 'off' });
      const knobs = await (async () => { st({ since: new Date(T0 - 99 * H).toISOString(), last }); return pass(T0 + 3 * H, ev(2, T0 + H), { STUDIO_TESTER_EVERY_HOURS: '2', STUDIO_TESTER_MIN_LANDINGS: '2' }); })();
      console.log(JSON.stringify({ a: [a.state, a.why], b: [b.state, b.why], c: [c.state, c.why], old: old.state, off: [off.state, off.why], nowAsk: [nowAsk.state, nowAsk.why], knobs: knobs.state }));
    `);
    const j = r.j || {};
    const ok = j.a?.[0] === 'idle' && /23 of 24 h/.test(j.a[1]) && j.b?.[0] === 'idle' && /9 of 10/.test(j.b[1]) && j.c?.[0] === 'due' && j.old === 'idle'
      && j.off?.[0] === 'idle' && /STUDIO_TESTER=off/.test(j.off[1]) && j.nowAsk?.[0] === 'due' && /patch/.test(j.nowAsk[1]) && j.knobs === 'due';
    return [ok, JSON.stringify(j) + (ok ? '' : r.out)];
  });

  // A tiny game: its build writes dist/index.html with a Buy button (data-testid) and window.__sim.
  const PAGE = '<!doctype html><html><body><button data-testid="buy" onclick="window.__sim.n++;document.getElementById(\'n\').textContent=window.__sim.n">Buy</button><span id="n">0</span><script>window.__sim={n:0};document.addEventListener("keydown",function(e){if(e.key==="b"){window.__sim.n+=10;document.getElementById("n").textContent=window.__sim.n}});console.error("boom")</script></body></html>';
  const gameStudio = (name, tester = {}) => {
    const S = studio(name);
    put(S, 'game/demo/build.mjs', `import fs from 'node:fs';\nfs.mkdirSync('game/demo/dist', { recursive: true });\nfs.writeFileSync('game/demo/dist/index.html', ${JSON.stringify(PAGE)});\n`);
    put(S, 'studio/game.json', `${JSON.stringify({ game: 'demo', tester: { build: 'node game/demo/build.mjs', dist: 'game/demo/dist', testids: true, ...tester } }, null, 2)}\n`);
    return S;
  };

  await guard('tester-no-slot (fails on 2.78.2: the Line Producer has no testerPass: nothing starts a tester, nothing checks the rig or a gate slot for one)', async () => {
    const S = gameStudio('slot', { areas: ['start', 'money'] });
    const r = probe(S, `
      const lp = await imp('harness/line-producer.mjs');
      const t = await imp('harness/tester.mjs');
      const fs = (await import('node:fs')).default;
      const starts = [];
      const agent = { nextAgentName: () => 'qa-playtester-' + (starts.length + 1), startAgent: (o, d) => { starts.push({ ...o, detach: d?.detach }); return { ok: true, agent: o.agent, tool: o.tool, model: 'm' }; } };
      let sessions = [];
      const holdsBefore = fs.existsSync(path.join(S, 'studio', 'task-holds.json')) ? fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8') : null;
      const env = { STUDIO_TESTER_TOOLS: 'claude,agy' };
      const deps = (gate) => ({ root: S, tester: { events: [], sha: null, agent, sessions: () => sessions, gateFree: async () => gate, inlineBuild: true } });
      t.writeTesterState(S, { since: new Date(0).toISOString(), asked: { by: 'patch', at: new Date().toISOString() } });
      const starved = await lp.testerPass({ env, rig: { known: true, cpuHold: true, cpuBusy: 0.97 }, deps: deps({ free: true }) });
      const busy = await lp.testerPass({ env, rig: { known: true, byRam: 2 }, deps: deps({ free: false, why: 'every gate slot is taken (2 of 2)' }) });
      const st0 = t.readTesterState(S);
      const go = await lp.testerPass({ env, rig: { known: true, byRam: 2 }, deps: deps({ free: true }) });
      const st1 = t.readTesterState(S);
      const built = fs.existsSync(path.join(st1.current.dir, 'dist', 'index.html'));
      // The session ends without a summary: the next pass finishes the run red-less (no verdicts), holds nothing.
      sessions = [{ agent: st1.current.agent, running: false }];
      const fin = await lp.testerPass({ env, rig: { known: true, byRam: 2 }, deps: deps({ free: true }) });
      // A second run (asked again): its build fails: red verdicts, no agent, still no hold.
      fs.writeFileSync(path.join(S, 'game/demo/build.mjs'), 'process.exit(3)\\n');
      t.writeTesterState(S, { ...t.readTesterState(S), asked: { by: 'patch', at: new Date().toISOString() } });
      const red = await lp.testerPass({ env, rig: { known: true, byRam: 2 }, deps: deps({ free: true }) });
      const st2 = t.readTesterState(S);
      t.writeTesterState(S, { ...t.readTesterState(S), asked: { by: 'patch', at: new Date().toISOString() } });
      fs.writeFileSync(path.join(S, 'game/demo/build.mjs'), ${JSON.stringify(`import fs from 'node:fs';\nfs.mkdirSync('game/demo/dist', { recursive: true });\nfs.writeFileSync('game/demo/dist/index.html', 'x');\n`)});
      const third = await lp.testerPass({ env, rig: { known: true, byRam: 2 }, deps: deps({ free: true }) });
      const locks = fs.existsSync(path.join(S, '.studio', 'locks')) ? fs.readdirSync(path.join(S, '.studio', 'locks')) : [];
      const holdsAfter = fs.existsSync(path.join(S, 'studio', 'task-holds.json')) ? fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8') : null;
      const trainQ = fs.existsSync(path.join(S, '.studio', 'train', 'queue.json'));
      console.log(JSON.stringify({ starved: [starved.state, starved.why], busy: [busy.state, busy.why], st0cur: st0.current || null, go: go.state, built, starts: starts.map((s) => ({ role: s.role, tool: s.tool, extra: s.extra, detach: s.detach, note: /tester -- brief/.test(s.note || '') })), fin: fin.state, red: [red.state, red.why], redVerdicts: st2.last?.verdicts, redTool: st2.last?.tool, third: third.state, locks, holdsSame: holdsBefore === holdsAfter, trainQ, runLock: fs.existsSync(path.join(S, '.studio', 'tester', 'run.lock')) }));
    `);
    const j = r.j || {};
    const ok = j.starved?.[0] === 'due' && /CPU 97%/.test(j.starved[1]) && j.busy?.[0] === 'due' && /gate slot/.test(j.busy[1]) && j.st0cur === null
      && j.go === 'playing' && j.built && j.starts?.length === 2 && j.starts[0].role === 'qa-playtester' && j.starts[0].extra === 1 && j.starts[0].detach === true && j.starts[0].note
      && j.starts[0].tool === 'claude' && j.redTool === 'agy' && j.starts[1].tool === 'claude' && j.fin === 'finished' && j.red?.[0] === 'finished' && /build failed/.test(j.red[1]) && j.redVerdicts?.start === 'red' && j.redVerdicts?.money === 'red'
      && j.third === 'playing' && !(j.locks || []).some((f) => /heavy|train|gate/.test(f)) && j.holdsSame && !j.trainQ;
    return [ok, JSON.stringify(j) + (ok ? '' : r.out)];
  });

  await guard('tester-plan (fails on 2.78.2: no seeded plan picker, nothing recorded to repeat a run)', async () => {
    const S = gameStudio('plan', { modes: [{ name: 'quick', query: 'start=quick' }, 'sandbox', 'story'], styles: ['a', 'b', 'c', 'd'], goals: ['g1', 'g2', 'g3'] });
    const r = probe(S, `
      const t = await imp('harness/tester.mjs');
      const cfg = await t.testerConfig(S);
      const p1 = t.pickPlan(cfg, 12345), p2 = t.pickPlan(cfg, 12345);
      const many = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(t.pickPlan(cfg, i + 1)))).size;
      const def = t.pickPlan({}, 7);
      const deps = { events: [], sha: null, bible: [], spawnBuild: () => ({ pid: 0 }) };
      t.writeTesterState(S, { since: new Date(0).toISOString() });
      const a = await t.startRun({ root: S, seed: 999, deps });
      const runA = (await import('node:fs')).default.readFileSync(path.join(a.run.dir, 'run.json'), 'utf8');
      t.writeTesterState(S, { ...t.readTesterState(S), current: null });
      (await import('node:fs')).default.rmSync(path.join(S, '.studio', 'tester', 'run.lock'), { force: true });
      const b = await t.startRun({ root: S, seed: 999, deps });
      const runB = (await import('node:fs')).default.readFileSync(path.join(b.run.dir, 'run.json'), 'utf8');
      console.log(JSON.stringify({ p1, same: JSON.stringify(p1) === JSON.stringify(p2), many, def, a: JSON.parse(runA).plan, b: JSON.parse(runB).plan, cfgSource: cfg.source }));
    `);
    const j = r.j || {};
    const okModes = ['quick', 'sandbox', 'story'].includes(j.p1?.mode) && ['a', 'b', 'c', 'd'].includes(j.p1?.style) && ['g1', 'g2', 'g3'].includes(j.p1?.goal) && (j.p1.mode !== 'quick' || j.p1.query === 'start=quick');
    const ok = okModes && j.same && j.many >= 10 && ['cautious', 'greedy', 'ignore-staff', 'max-speed', 'idle'].includes(j.def?.style) && j.def?.mode === null
      && j.a?.seed === 999 && JSON.stringify(j.a) === JSON.stringify(j.b) && /game\.json/.test(j.cfgSource);
    return [ok, JSON.stringify(j) + (ok ? '' : r.out)];
  });

  await guard('tester-brief (fails on 2.78.2: no tester brief: no landed features, regression area or Bible list for a playtester)', async () => {
    const S = gameStudio('brief', { areas: ['start', 'money', 'hud'] });
    put(S, 'studio/bible/bible.json', `${JSON.stringify({ version: 1, answers: { title: 'Demo', references: ['A classic tycoon game: its build menu'] }, pillars: [], phases: { 1: {}, 2: {}, 3: {} }, layers: { currency: { answer: 'yes', phase: 1 }, 'tech-tree': { answer: 'no' } }, signed: null, phase: { open: 1, history: [], floors: [] } }, null, 2)}\n`);
    put(S, 'studio/bible/systems/S-staff.md', '# Staff hiring\n\nHire staff.\n');
    const r = probe(S, `
      const t = await imp('harness/tester.mjs');
      const fs = (await import('node:fs')).default;
      const T0 = ${T0};
      const events = [
        { ts: new Date(T0 - 10000).toISOString(), type: 'task.added', task: 'T-301', msg: 'Queued T-301 [P1] (builder): Add the build menu', meta: { phase: 1, serves: 'layer:currency' } },
        { ts: new Date(T0 - 9000).toISOString(), type: 'task.added', task: 'T-302', msg: 'Queued T-302 [P2] (builder): Staff panel', meta: {} },
        { ts: new Date(T0 - 8000).toISOString(), type: 'task.added', task: 'T-299', msg: 'Queued T-299 [P2] (builder): Old thing', meta: {} },
        ${JSON.stringify(landedEv(['T-299'], T0 - 7 * HOUR))},
        ${JSON.stringify(landedEv(['T-301'], T0 + HOUR))},
        { ts: new Date(T0 + 2 * ${HOUR}).toISOString(), type: 'lane.merged', task: 'T-302' },
      ];
      const env = { STUDIO_TESTER_COMPARE_EVERY: '2' };
      const deps = { events, sha: null, spawnBuild: () => ({ pid: 0 }) };
      const briefs = [];
      t.writeTesterState(S, { since: new Date(0).toISOString(), last: { id: 'r0', at: new Date(T0).toISOString() } });
      for (let i = 0; i < 2; i++) {
        const r = await t.startRun({ root: S, env, now: T0 + (5 + i) * ${HOUR}, deps });
        briefs.push(fs.readFileSync(path.join(r.run.dir, 'brief.md'), 'utf8'));
        t.writeTesterState(S, { ...t.readTesterState(S), current: null });
        fs.rmSync(path.join(S, '.studio', 'tester', 'run.lock'), { force: true });
      }
      console.log(JSON.stringify({ briefs }));
    `);
    const [b1, b2] = r.j?.briefs || ['', ''];
    const ok = /T-301: Add the build menu \(phase 1, layer:currency\)/.test(b1) && /T-302: Staff panel/.test(b1) && !/T-299/.test(b1)
      && /Regression area this run: \*\*start\*\*/.test(b1) && /Regression area this run: \*\*money\*\*/.test(b2)
      && /`layer:currency` Currencies \(phase 1\)/.test(b1) && !/tech-tree/.test(b1) && /`system:S-staff` Staff hiring/.test(b1) && /`control:buy-unit`/.test(b1)
      && /working.*broken.*missing.*not-reached/s.test(b1) && !/Compare with the genre/.test(b1) && /Compare with the genre/.test(b2) && /A classic tycoon game/.test(b2);
    return [ok, ok ? 'landed, area, Bible and compare as expected' : `${b1.slice(0, 1800)}\n---\n${b2.slice(0, 600)}\n${r.out}`];
  });

  await guard('tester-drive (fails on 2.78.2: no qa/tester-drive.mjs; npm run shot serves only web|cartridges|assets|public)', async () => {
    const S = studio('drive');
    const run = path.join(S, '.studio', 'tester', 'runs', 'manual');
    put(S, '.studio/tester/runs/manual/dist/index.html', PAGE);
    put(S, '.studio/tester/runs/manual/run.json', JSON.stringify({ id: 'manual', page: 'index.html' }));
    const drive = (...a) => { const r = spawnSync(process.execPath, ['qa/tester-drive.mjs', ...a, '--run', run], { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...base } }); let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {} return { j, out: `${r.stdout}${r.stderr}` }; };
    const serve = drive('serve');
    const open = drive('open');
    if (!open.j?.ok && /Chromium did not start|Executable doesn't exist|playwright install/i.test(open.out)) { drive('close'); return [true, `skipped: Chromium is not available here (${open.out.split('\n')[0].slice(0, 200)})`]; }
    const click = drive('click', '--testid', 'buy');
    const key = drive('key', 'b');
    const shot = drive('shot', 'after-buy');
    const cons = drive('console');
    const state = drive('state');
    const miss = drive('click', '--testid', 'nope', '--timeout', '400');
    const close = drive('close');
    const log = textIn(S, '.studio/tester/runs/manual/actions.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const rp = (to) => { const r = spawnSync(process.execPath, ['qa/tester-drive.mjs', 'replay', path.join(run, 'actions.jsonl'), '--to', String(to), '--out', path.join(run, `replay-${to}`)], { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...base } }); try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { out: `${r.stdout}${r.stderr}` }; } };
    const r3 = rp(3);
    const r4 = rp(4);
    const ok = serve.j?.ok && /^http:\/\/127\.0\.0\.1:\d+\//.test(serve.j.url) && open.j?.ok && click.j?.ok && key.j?.ok && shot.j?.ok && fs.existsSync(path.join(run, 'shots', 'after-buy.png'))
      && cons.j?.errors?.some((e) => e.text === 'boom') && state.j?.sim === '{"n":11}' && miss.j?.ok === false && close.j?.ok
      && log.map((l) => l.cmd).join() === 'serve,open,click,key,shot,console,state,click,close' && log.every((l, i) => l.step === i + 1 && l.ts) && log[7].ok === false
      && r3.state?.sim === '{"n":1}' && r4.state?.sim === '{"n":11}' && fs.existsSync(r4.file || '') && !fs.existsSync(path.join(run, 'driver.json'));
    return [ok, JSON.stringify({ serve: serve.j, open: open.j, click: click.j, state: state.j, miss: miss.j, log: log.map((l) => `${l.step}:${l.cmd}`), r3: r3.state, r4: r4.state }) + (ok ? '' : `${open.out}${r3.out || ''}`)];
  });

  await guard('tester-report (fails on 2.78.2: no tester finish: no report folder, no bug tasks with proof, no inbox item or status line)', async () => {
    const S = gameStudio('report', { areas: ['start', 'money'] });
    const r = probe(S, `
      const t = await imp('harness/tester.mjs');
      const fs = (await import('node:fs')).default;
      const deps = { events: [], sha: null, bible: [{ id: 'layer:currency', name: 'Currencies', kind: 'layer' }], spawnBuild: () => ({ pid: 0 }) };
      const queued = [];
      const one = async (seed) => {
        t.writeTesterState(S, { ...t.readTesterState(S), since: new Date(0).toISOString(), current: null });
        const s = await t.startRun({ root: S, seed, deps });
        const d = s.run.dir;
        fs.writeFileSync(path.join(d, 'shots', 'cash.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
        fs.writeFileSync(path.join(d, 'actions.jsonl'), JSON.stringify({ step: 1, cmd: 'serve', args: {} }) + '\\n');
        fs.writeFileSync(path.join(d, 'report.md'), '# Run\\n\\nPlayed.\\n');
        fs.writeFileSync(path.join(d, 'summary.json'), JSON.stringify({ verdicts: { start: 'green', money: 'red', hud: 'purple' }, bible: { 'layer:currency': { status: 'broken', shot: 'shots/cash.png' } }, bugs: [{ title: 'Cash stays frozen while the HUD shows a daily loss', area: 'money', step: 9, steps: ['open', 'wait 60000'], expected: 'cash goes down', actual: 'cash stays', images: ['shots/cash.png', '../../../../etc/passwd'] }] }));
        return t.finishRun({ root: S, deps: { queueNotice: (n) => queued.push(n) } });
      };
      const f1 = await one(1);
      const again = await t.finishRun({ root: S, id: f1.summary.run });
      const f2 = await one(2);
      const board = (await imp('harness/task.mjs')).parseNextQueue();
      const bugs = [...board.inProgress, ...board.backlog].filter((x) => /Cash stays frozen/.test(x.title));
      const id = f1.summary.bugs[0].task;
      const out = path.join(S, 'qa', 'reports', 'tester', f1.summary.run);
      const proof = path.join(S, 'studio', 'proof', id || 'none');
      const events = (await imp('harness/event.mjs')).readRecentEvents(500).filter((e) => e.type === 'tester.report');
      console.log(JSON.stringify({ f1: f1.summary, again: again.already, f2bug: f2.summary.bugs[0], bugs, files: fs.existsSync(out) ? fs.readdirSync(out).sort() : [], shots: fs.existsSync(path.join(out, 'shots')) ? fs.readdirSync(path.join(out, 'shots')) : [], proof: fs.existsSync(proof) ? fs.readdirSync(proof).sort() : [], proofMd: fs.existsSync(proof) ? fs.readdirSync(proof).filter((x) => x.endsWith('.md')).map((x) => fs.readFileSync(path.join(proof, x), 'utf8')).join('') : '', inbox: fs.readFileSync(path.join(S, 'studio', 'producer', 'INBOX.md'), 'utf8').split('\\n').filter((l) => /game tester/.test(l)), events: events.map((e) => ({ to: e.to, cc: e.meta?.cc, run: e.meta?.run })), queued }));
    `);
    const j = r.j || {};
    const b = j.bugs?.[0] || {};
    const s = j.f1 || {};
    const ok = s.run && s.plan?.seed === 1 && s.verdicts?.start === 'green' && s.verdicts?.money === 'red' && !('hud' in (s.verdicts || {})) && s.problems?.some((p) => /purple/.test(p))
      && s.bible?.['layer:currency']?.status === 'broken' && Array.isArray(s.bugs) && s.bugs[0]?.task && s.bugs[0].duplicate === false && s.report === `qa/reports/tester/${s.run}/report.md`
      && j.again === true && j.f2bug?.duplicate === true && j.f2bug?.task === s.bugs[0].task && j.bugs?.length === 1 && b.priority === 'P1' && /^Bug: Cash stays frozen/.test(b.title)
      && ['actions.jsonl', 'brief.md', 'report.md', 'run.json', 'shots', 'summary.json'].every((f) => j.files.includes(f)) && j.shots?.includes('cash.png')
      && j.proof?.includes('cash.png') && !j.proof.includes('passwd') && /replay qa\/reports\/tester\/.+\/actions\.jsonl --to 9/.test(j.proofMd) && /1\. open/.test(j.proofMd)
      && j.inbox?.length === 2 && /Producer, the Director and/.test(j.inbox[0]) && j.events?.length === 2 && j.events[0].to === 'producer' && j.events[0].cc?.includes('director')
      && j.queued?.length === 2 && j.queued[0].key === `tester:${s.run}` && /Director/.test(j.queued[0].text);
    return [ok, JSON.stringify({ ...j, proofMd: (j.proofMd || '').slice(0, 300) }).slice(0, 2500) + (ok ? '' : r.out)];
  });

  await guard('tester-wire (fails on 2.78.2: a task.unwired note was only printed; nothing files a "Wire <module> into the game" task)', async () => {
    const S = studio('wire');
    put(S, 'game/sky/index.html', '<!doctype html><script type="module" src="./src/main.mjs"></script>\n');
    put(S, 'game/sky/src/main.mjs', "import './used.mjs';\n");
    put(S, 'game/sky/src/used.mjs', 'export const u = 1;\n');
    put(S, 'game/sky/src/orphan.mjs', 'export const o = 1;\n');
    const r = probe(S, `
      const lp = await imp('harness/line-producer.mjs');
      const events = [
        { ts: new Date().toISOString(), type: 'task.added', task: 'T-401', msg: 'Queued T-401 [P1] (builder): Orphan system' },
        { ts: new Date().toISOString(), type: 'task.unwired', task: 'T-401', msg: 'T-401: game/sky/src/orphan.mjs is not reached from the game (nothing imports it from an entry point; tests and demos don\\'t count): wire it in' },
        { ts: new Date().toISOString(), type: 'task.unwired', task: 'T-402', msg: 'T-402: game/sky/src/used.mjs is not reached from the game' },
        { ts: new Date().toISOString(), type: 'task.train.landed', meta: { lanes: ['T-401', 'T-402'] } },
        { ts: new Date().toISOString(), type: 'task.unwired', task: 'T-403', msg: 'T-403: game/sky/src/orphan.mjs is not reached from the game' },
      ];
      const pass = (env = {}) => lp.testerPass({ env: { STUDIO_TESTER: 'off', ...env }, act: true, rig: null, deps: { root: S, tester: { events, filesOf: () => [] } } });
      const off = await pass({ STUDIO_TESTER_WIRE_TASKS: 'off' });
      const a = await pass();
      const b = await pass();
      const board = (await imp('harness/task.mjs')).parseNextQueue();
      const wire = [...board.inProgress, ...board.backlog].filter((x) => /^Wire /.test(x.title));
      console.log(JSON.stringify({ off: off.wire, a: a.wire, b: b.wire, wire }));
    `);
    const j = r.j || {};
    const ok = j.off?.on === false && j.off.added.length === 0 && j.a?.added?.length === 1 && j.a.added[0].module === 'game/sky/src/orphan.mjs' && j.a.added[0].of === 'T-401'
      && j.b?.added?.length === 0 && j.wire?.length === 1 && j.wire[0].title === 'Wire game/sky/src/orphan.mjs into the game' && j.wire[0].priority === 'P2';
    return [ok, JSON.stringify(j) + (ok ? '' : r.out)];
  });

  await guard('tester-stage1 (fails on 2.78.2: a game studio\'s playtest task still needs a template-cartridge stage-1 report, and the playtest gate plays the template)', async () => {
    const run = (S, task) => { const r = spawnSync(process.execPath, ['harness/done-check.mjs', task], { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...base } }); return `${r.stdout}${r.stderr}`; };
    const addPlaytest = (S) => { const r = probe(S, `const tm = await imp('harness/task.mjs'); const x = tm.addTask({ title: 'Playtest: the first minutes', role: 'qa-playtester', priority: 'P2', agent: 'producer', meta: { promoted: true } }); console.log(JSON.stringify(x));`); return r.j?.id; };
    const G = gameStudio('s1game');
    const P = studio('s1tpl');
    const gid = addPlaytest(G);
    const pid = addPlaytest(P);
    const g = run(G, gid);
    const p = run(P, pid);
    const gates = (S) => { put(S, 'studio/gates.json', `${JSON.stringify({ cartridge: 'example-sim', gates: [{ id: 'playtest', cartridge: true, command: 'node -e "process.exit(0)"', required: true, lite: true }, { id: 'noop', command: 'node -e "process.exit(0)"', required: true, lite: true }] }, null, 2)}\n`); const r = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--no-detach', '--no-cache'], { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 180000, env: { ...process.env, ...base, STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_VERIFY_DETACH: 'off' } }); return `${r.stdout}${r.stderr}`; };
    const keep = probe(G, `const c = await imp('harness/tester-config.mjs'); console.log(JSON.stringify([c.stage1Replaced(S, {}).replaced]));`).j;
    const gg = gates(G);
    const pg = gates(P);
    const ok = /\[x\] Stage-1 playtest: replaced by the game tester \(npm run tester\)/.test(g) && !/Playtest report since the task started/.test(g)
      && /\[ \] Playtest report since the task started/.test(p) && !/replaced by the game tester/.test(p)
      && /skipped[^\n]*playtest \(replaced by the game tester \(npm run tester\)\)/.test(gg) && !/replaced by the game tester/.test(pg) && JSON.stringify(keep) === '[true]';
    return [ok, ok ? 'game studio: replaced (done-check and gate); template studio: kept' : `GAME:\n${g.slice(-800)}\nTEMPLATE:\n${p.slice(-600)}\nGATES game:\n${gg.slice(-900)}\nGATES template:\n${pg.slice(-500)}`];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
}
