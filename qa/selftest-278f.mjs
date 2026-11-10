/**
 * qa/selftest-278f.mjs — 2.78.0 (helper f): plan-time waves (the replay bench measure it also tested was cut in 2.80.0).
 *   PU-60  plan-time scope and waves in shadow mode (harness/plan-waves.mjs): an overlap graph of the ready tasks,
 *          coloured into waves, the serialized share, a waves.shadow event at most every STUDIO_WAVES_MIN minutes, and a
 *          replay over past events. (Not harness/waves.mjs: that is the fun-check waves module.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278F({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_WAVES: '', STUDIO_WAVES_MIN: '', STUDIO_WAVES_MAX_SHARE: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-278f-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `278f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-278f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-278f-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const want = (k) => !process.env.ONLY_278F || process.env.ONLY_278F.split(',').includes(k);

  // ---- PU-60 ----
  if (want('scope')) await guard('2.78.0 (PU-60): parseScope reads "--scope a,b" as globs (braces keep their commas, prose with spaces is dropped, duplicates collapse); globsOverlap tells src/sim/** from src/ui/**, a file from its folder glob, and a file from a different folder (fails on 2.77.1: no harness/plan-waves.mjs)', async () => {
    const st = studio('scope');
    const r = probe(st.S, st.env, 'scope', `import { parseScope, globsOverlap } from ${u(st.S, 'harness/plan-waves.mjs')};
console.log(JSON.stringify({
  p: parseScope('src/sim/**, {a,b}/x.ts ,free text here,src/sim/**,./docs/A.md'),
  none: parseScope(''), arr: parseScope(['x/*.js', 'y']),
  o: [globsOverlap('src/sim/**', 'src/sim/a.ts'), globsOverlap('src/sim/**', 'src/ui/**'), globsOverlap('src/sim', 'src/sim/a.ts'), globsOverlap('src/sim/a.ts', 'src/sim/b.ts'), globsOverlap('src/**', 'src/ui/hud.ts'), globsOverlap('docs/A.md', 'src/**'), globsOverlap('src/*.ts', 'src/ui/**'), globsOverlap('**', 'x/y.ts')],
}));`);
    const ok = JSON.stringify(r.p) === JSON.stringify(['src/sim/**', '{a,b}/x.ts', 'docs/A.md']) && r.none.length === 0 && JSON.stringify(r.arr) === JSON.stringify(['x/*.js', 'y'])
      && JSON.stringify(r.o) === JSON.stringify([true, false, true, false, true, false, true, true]);
    return [ok, JSON.stringify(r)];
  });

  if (want('plan')) await guard('2.78.0 (PU-60): a fixture queue with overlapping scopes (and one task with only overlap history) is coloured into waves where no two tasks overlap; the serialized share is computed; running lanes that overlap ready tasks are listed; over 60% is flagged "over-serialize" (fails on 2.77.1: no waves planner)', async () => {
    const st = studio('plan');
    const r = probe(st.S, st.env, 'plan', `import { planWaves, gather, firstOverlap } from ${u(st.S, 'harness/plan-waves.mjs')};
const tasks = [
  { id: 'T-1', scope: ['src/sim/**'] }, { id: 'T-2', scope: ['src/sim/a.ts'] }, { id: 'T-3', scope: ['src/ui/**'] },
  { id: 'T-4', scope: ['src/ui/hud.ts', 'src/sim/b.ts'] }, { id: 'T-5', scope: ['docs/**'] }, { id: 'T-6', scope: [] },
];
const running = [{ id: 'T-9', agent: 'builder-9', scope: ['src/ui/**'] }, { id: 'T-8', agent: 'builder-8', scope: [], files: ['docs/x.md'] }];
const p = planWaves({ ready: tasks, running });
const overlap = (a, b) => firstOverlap(tasks.find((t) => t.id === a).scope, tasks.find((t) => t.id === b).scope);
const clean = p.waves.every((w) => w.every((a, i) => w.slice(i + 1).every((b) => !overlap(a, b))));
const chain = planWaves({ ready: ['T-11', 'T-12', 'T-13', 'T-14', 'T-15'].map((id) => ({ id, scope: ['src/**'] })) });
// history: T-21 has no scope, but a hotspot.overlap event named it with T-22 on src/x.ts
const events = [
  { ts: '2026-11-01T00:00:00.000Z', type: 'task.added', task: 'T-22', meta: { scope: 'src/**' } },
  { ts: '2026-11-01T00:00:01.000Z', type: 'task.added', task: 'T-21', meta: {} },
  { ts: '2026-11-01T00:10:00.000Z', type: 'hotspot.overlap', meta: { file: 'src/x.ts', line: 3, lanes: ['T-21 (builder-1)', 'T-22 (builder-2)'] } },
];
const g = gather({ q: { backlog: [{ id: 'T-21', title: 'a' }, { id: 'T-22', title: 'b' }], inProgress: [] }, readyIds: ['T-21', 'T-22'], events });
const h = planWaves(g);
console.log(JSON.stringify({ p, clean, chain: { waves: chain.waves.length, share: chain.serializedShare, over: chain.overSerialize }, hist: { waves: h.waves, edges: h.edges.length } }));`);
    const p = r.p || {};
    const ok = JSON.stringify(p.waves) === JSON.stringify([['T-1', 'T-3', 'T-5', 'T-6'], ['T-2', 'T-4']]) && r.clean === true
      && p.serialized === 2 && Math.abs(p.serializedShare - 0.333) < 0.001 && p.overSerialize === false && JSON.stringify(p.unscoped) === JSON.stringify(['T-6'])
      && JSON.stringify((p.runningOverlaps || []).map((o) => `${o.running}>${o.ready}`)) === JSON.stringify(['T-9>T-3', 'T-9>T-4', 'T-8>T-5'])
      && r.chain.waves === 5 && r.chain.share === 0.8 && r.chain.over === true
      && r.hist.edges === 1 && r.hist.waves.length === 2;
    return [ok, JSON.stringify(r)];
  });

  if (want('shadow')) await guard('2.78.0 (PU-59/60): shadow mode logs one waves.shadow event at most every STUDIO_WAVES_MIN minutes (30), none with STUDIO_WAVES=off or an empty queue, carries the over-serialize flag, and never touches the board or which task starts (fails on 2.77.1: no waves.shadow)', async () => {
    const st = studio('shadow');
    const nextBefore = fs.readFileSync(path.join(st.S, 'studio', 'NEXT.md'), 'utf8');
    const r = probe(st.S, st.env, 'shadow', `import { shadowPass } from ${u(st.S, 'harness/plan-waves.mjs')};
const mk = (id) => ({ id, title: id, role: 'builder' });
const q = { backlog: ['T-1', 'T-2', 'T-3'].map(mk), inProgress: [], done: [] };
const events = ['T-1', 'T-2', 'T-3'].map((id, i) => ({ ts: '2026-11-01T00:00:0' + i + '.000Z', type: 'task.added', task: id, meta: { scope: 'src/**' } }));
const t0 = Date.parse('2026-11-01T12:00:00.000Z');
const deps = { q, readyIds: ['T-1', 'T-2', 'T-3'], events };
const a = await shadowPass({ now: t0, deps });
const b = await shadowPass({ now: t0 + 10 * 60000, deps });
const c = await shadowPass({ now: t0 + 31 * 60000, deps });
const off = await shadowPass({ now: t0 + 120 * 60000, deps, env: { ...process.env, STUDIO_WAVES: 'off' } });
const empty = await shadowPass({ now: t0 + 200 * 60000, deps: { q: { backlog: [], inProgress: [] }, readyIds: [], events } });
console.log(JSON.stringify({ a: [a.ran, a.plan && a.plan.serializedShare], b: [b.ran, b.why], c: c.ran, off: [off.ran, off.why], empty: [empty.ran, empty.why] }));`);
    const ev = events(st.ev).filter((e) => e.type === 'waves.shadow');
    const nextAfter = fs.readFileSync(path.join(st.S, 'studio', 'NEXT.md'), 'utf8');
    const ok = r.a && r.a[0] === true && r.b[0] === false && r.c === true && r.off[0] === false && /off/.test(r.off[1]) && r.empty[0] === false
      && ev.length === 2 && ev[0].meta.overSerialize === true && ev[0].meta.serialized === 2 && /over-serialize/.test(ev[0].msg) && nextAfter === nextBefore;
    return [ok, JSON.stringify({ r, ev: ev.map((e) => e.msg) })];
  });

  if (want('replay')) await guard('2.78.0 (PU-60): `plan-waves.mjs replay --events <file> --days 14` counts the recorded hotspot.overlap events waves would have avoided (scopes known before them overlap), the distinct pairs, those it could not avoid, and roughly the extra wall time (the later task waits out the overlap) (fails on 2.77.1: no replay)', async () => {
    const st = studio('replay');
    const T = (min) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + min * 60000).toISOString();
    const evs = [
      { ts: '2026-09-01T00:00:00.000Z', type: 'hotspot.overlap', meta: { file: 'old.ts', lanes: ['T-90 (a)', 'T-91 (b)'] } }, // outside the 14 days
      { ts: T(0), type: 'task.added', task: 'T-1', meta: { scope: 'src/sim/**' } },
      { ts: T(0), type: 'task.added', task: 'T-2', meta: { scope: 'src/sim/a.ts,docs/**' } },
      { ts: T(0), type: 'task.added', task: 'T-3', meta: {} },
      { ts: T(0), type: 'task.added', task: 'T-4', meta: { scope: 'src/ui/**' } },
      { ts: T(1), type: 'task.start', task: 'T-1', agent: 'a' },
      { ts: T(10), type: 'task.start', task: 'T-2', agent: 'b' },
      { ts: T(11), type: 'task.start', task: 'T-3', agent: 'c' },
      { ts: T(12), type: 'task.start', task: 'T-4', agent: 'd' },
      { ts: T(20), type: 'hotspot.overlap', meta: { file: 'src/sim/a.ts', line: 4, lanes: ['T-1 (a)', 'T-2 (b)'] } },
      { ts: T(21), type: 'hotspot.overlap', meta: { file: 'src/sim/a.ts', line: 9, lanes: ['T-1 (a)', 'T-2 (b)'] } },
      { ts: T(22), type: 'hotspot.overlap', meta: { file: 'src/other.ts', line: 1, lanes: ['T-3 (c)', 'T-4 (d)'] } },
      { ts: T(60), type: 'task.done', task: 'T-1' },
      { ts: T(90), type: 'task.done', task: 'T-2' },
    ];
    const f = path.join(st.S, 'events-replay.jsonl');
    fs.writeFileSync(f, `${evs.map((e) => JSON.stringify(e)).join('\r\n')}\r\n`); // CRLF on purpose
    const r = run(st.S, `node harness/plan-waves.mjs replay --events "${f}" --days 14 --json`, st.env);
    let j = null; try { j = JSON.parse(out(r)); } catch {}
    const txt = out(run(st.S, `node harness/plan-waves.mjs replay --events "${f}" --days 14`, st.env));
    const ok = j && j.overlapEvents === 3 && j.avoidedEvents === 2 && j.avoidedPairs === 1 && j.notAvoided === 1 && j.taskStarts === 4 && j.extraWallMs === 50 * 60000
      && /avoided 2 of them \(1 distinct task pair/.test(txt) && /50 min/.test(txt);
    return [ok, JSON.stringify({ j, txt })];
  });

  if (want('cli')) await guard('2.78.0 (PU-60): `node harness/plan-waves.mjs` and `--json` run on the studio\'s own board and print the waves and the serialized share; the fun-check module harness/waves.mjs is untouched (fails on 2.77.1: no planner)', async () => {
    const st = studio('cli');
    const a = run(st.S, 'node harness/plan-waves.mjs', st.env);
    const b = run(st.S, 'node harness/plan-waves.mjs --json', st.env);
    let j = null; try { j = JSON.parse(out(b)); } catch {}
    const fun = fs.readFileSync(path.join(st.S, 'harness', 'waves.mjs'), 'utf8');
    const ok = a.status === 0 && /^Waves for \d+ ready task/.test(out(a)) && /serialized: \d+ of \d+ ready/.test(out(a)) && j && Array.isArray(j.waves) && typeof j.serializedShare === 'number'
      && /Fun check in waves/.test(fun) && /export function joinWave/.test(fun);
    return [ok, JSON.stringify({ a: out(a), b: out(b).slice(0, 600) })];
  });
}
