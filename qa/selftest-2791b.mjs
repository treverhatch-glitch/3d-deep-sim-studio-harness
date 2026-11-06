/**
 * qa/selftest-2791b.mjs — 2.79.1 (b): the Line Producer never freezes the line, plans for engine lands, and the boost says
 * when it ends.
 *   freeze    a parked chain-breaker pages the orchestrator once and the line keeps filling; lane-less ready tasks are
 *             skipped while other work can run (the Producer is asked once); the chain-breaker verify hold ends when its
 *             train runs and never lasts past STUDIO_LINE_HOLD_MAX_MIN
 *   engine    a queued or near engine land holds new verifies (not the running ones, not the land), steps the builder
 *             target down one at a time, is released at once when the land holds its slot, is bounded by
 *             STUDIO_ENGINE_HOLD_MAX_MIN and reports why when it runs out; nothing is held without a land; the land's
 *             floor is learned from the peaks of its green runs
 *   boost     MAX SPEED saying so when it expires; `--until <time>` and `--until off`
 * A temp copy of the studio per check; probe scripts run in it. Each check fails on 2.79.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2791B({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const UNSET = ['STUDIO_UNSCOPED_PARALLEL', 'STUDIO_SHARED_SIM', 'STUDIO_LINE_LANES', 'STUDIO_REQUIRE_LANE', 'STUDIO_MODEL_ROUTING', 'STUDIO_BUILDER_TOOL', 'STUDIO_WORKTREES', 'STUDIO_ENV_FROM_FILE', 'STUDIO_WAVES',
    'STUDIO_LINE_HOLD_MAX_MIN', 'STUDIO_LINE_CHAIN_HOLD_MIN', 'STUDIO_ENGINE_HOLD_MAX_MIN', 'STUDIO_ENGINE_RAM_RUNS', 'STUDIO_ENGINE_RAM_MARGIN_GB', 'STUDIO_ENGINE_RAM_MIN_GB', 'STUDIO_ENGINE_LAND_WAIT_MIN', 'STUDIO_UNITY_MIN_FREE_GB',
    'STUDIO_ENGINE_VERIFY_TYPICAL_MIN', 'STUDIO_ENGINE_WAIT_SOON_MIN', 'STUDIO_ENGINE_SCALE_STEP_MIN', 'STUDIO_ENGINE_NEAR_MIN'];
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TEST_MACHINE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_TRAIN_AUTO: 'off',
    STUDIO_LINE_PRODUCER: '', STUDIO_LINE_RIG: 'heavy', STUDIO_LINE_EXPANSION_SHARE: '0', STUDIO_LINE_CHAIN_MIN: '', STUDIO_LINE_PLAN_MAX_SEC: '', STUDIO_TIER_CHEAP_MODEL: '', STUDIO_TIER_MID_MODEL: '', STUDIO_TIER_TOP_MODEL: '',
    STUDIO_ENGINE_TRAIN_AUTO: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2791b-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let n = 0;
  const made = [];
  const studio = (name, { tasks = [], holds = {}, events = [], mode = 'extreme' } = {}) => {
    const S = path.join(tmpRoot, `2791b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json', 'studio/models.json', 'studio/approvals', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-2791b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 2 * 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    const line = (t) => `- [${t.ip ? '>' : ' '}] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`;
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n${tasks.filter((t) => t.ip).map(line).join('\n')}\n\n## BACKLOG\n${tasks.filter((t) => !t.ip).map(line).join('\n')}\n\n## DONE\n`);
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: holds }, null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'mode.json'), `${JSON.stringify({ mode, history: [] }, null, 2)}\n`);
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2791b-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: `${out(r)}`.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const added = (task, meta = {}) => ({ type: 'task.added', agent: 'producer', task, msg: `Queued ${task} [P1] (builder): t`, meta });
  /** One supervise() pass with fake sessions; the starts it made. */
  const superviseCode = (S, sessions) => `const sup = await import(${u(S, 'harness/supervisor.mjs')});
const starts = [];
const sess = ${JSON.stringify(sessions)};
const deps = { sessions: () => sess.map((s) => ({ ...s })), launchableRoles: (r) => r, nextAgentName: (role) => role + '-t' + starts.length, startAgent: (o) => { starts.push(o); return { ok: true }; } };
const r = await sup.supervise({ watcher: true, deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ starts: starts.map((o) => ({ task: o.task, lane: o.lane || null })), why: r.why }));`;
  const TAKE = `const take = (H, root, label, o = {}) => { try { const lk = H.acquireHeavy(root, label, { ...o, env: { ...process.env, STUDIO_HEAVY_HELD: '', ...(o.env || {}) } }); return { ok: true, lk }; } catch (e) { return { ok: false, code: e.code || 'ERR', msg: String(e.message || e).slice(0, 300) }; } };`;
  const scan = { STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: JSON.stringify({ at: new Date().toISOString(), os: { platform: 'linux' }, ram: { totalGb: 64, freeGb: 60 }, cores: { logical: 32 }, gpus: [] }) };

  // ---- 3.1: the plan never freezes the line ----
  {
    // Six builders' worth of work: six laned ready tasks, a parked chain-breaker with three waiting, one builder running.
    const lane = (id, l, p = 'P1') => ({ tasks: [{ id, title: `Laned work ${id}`, p }], ev: added(id, { scope: `web/example-sim/${l}/**` }) });
    const laned = ['a', 'b', 'c', 'd', 'e', 'f'].map((l, i) => lane(`T-03${i}`, l));
    const tasks = [
      { id: 'T-010', title: 'Rework the shared core' }, { id: 'T-011', title: 'Feature one on the core' }, { id: 'T-012', title: 'Feature two on the core' }, { id: 'T-013', title: 'Feature three on the core' },
      ...laned.flatMap((x) => x.tasks),
    ];
    const holds = { 'T-010': { parked: { by: 'harness', why: 'owner-only', at: iso(now) } }, 'T-011': { after: ['T-010'] }, 'T-012': { after: ['T-010'] }, 'T-013': { after: ['T-010'] } };
    const evs = [added('T-010'), added('T-011'), added('T-012'), added('T-013'), ...laned.map((x) => x.ev)];
    const { S, ev, env } = studio('freeze-cb', { tasks, holds, events: evs });
    const r = probe(S, env, 'cb', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
const a = await lp.lineProducerPass({});
const b = await lp.lineProducerPass({});
${superviseCode(S, [{ agent: 'builder-s1', role: 'builder', task: 'T-030', lane: 'web/example-sim/a', running: true }])}
`.replace("console.log(JSON.stringify({ starts:", "console.log(JSON.stringify({ target: a.builders.target, blocked: a.reasons, starts:"));
    const paged = events(ev).filter((e) => e.type === 'line.blocker_paged');
    await guard('2.79.1 (3.1): a parked chain-breaker (T-010, 3 wait on it) pages the orchestrator ONCE (line.blocker_paged, not again on the next pass) and the line keeps filling: with one builder running and 5 laned tasks ready, the supervisor starts the other laned tasks (fails on 2.79.0: nothing pages the orchestrator about the blocker)', () => [
      paged.length === 1 && paged[0].task === 'T-010' && /T-010/.test(paged[0].msg) && (r.starts || []).length >= 3 && (r.starts || []).every((s) => s.lane && s.task !== 'T-010'),
      JSON.stringify({ paged: paged.map((e) => ({ task: e.task, to: e.to })), starts: r.starts, target: r.target, why: r.why, err: r._err.slice(-400) })]);
  }
  {
    const tasks = [
      { id: 'T-040', title: 'Laneless job one', p: 'P0' }, { id: 'T-041', title: 'Laneless job two', p: 'P0' },
      { id: 'T-042', title: 'Laned work a' }, { id: 'T-043', title: 'Laned work b' }, { id: 'T-044', title: 'Laned work c' },
    ];
    const evs = [added('T-040'), added('T-041'), added('T-042', { scope: 'web/example-sim/a/**' }), added('T-043', { scope: 'web/example-sim/b/**' }), added('T-044', { scope: 'web/example-sim/c/**' })];
    const { S, ev, env } = studio('freeze-lane', { tasks, events: evs });
    const r = probe(S, env, 'lane', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
const a = await lp.lineProducerPass({});
const b = await lp.lineProducerPass({});
${superviseCode(S, [])}`);
    const asked = events(ev).filter((e) => e.type === 'line.scope_asked');
    await guard('2.79.1 (3.1): lane-less ready tasks (T-040, T-041, both P0) do not freeze the line: with laned work ready they are skipped (a lane-less builder would hold the whole game), the laned tasks start, and the Producer is asked ONCE to scope them (line.scope_asked) (fails on 2.79.0: the lane-less P0 task started first and alone, so nothing else could start)', () => [
      asked.length === 1 && asked[0].to === 'producer' && /T-040/.test(asked[0].msg) && /T-041/.test(asked[0].msg) && (r.starts || []).length === 3 && (r.starts || []).every((s) => s.lane) && !(r.starts || []).some((s) => /T-04[01]/.test(s.task)),
      JSON.stringify({ asked: asked.map((e) => e.msg), starts: r.starts, why: r.why, err: r._err.slice(-400) })]);
    const only = studio('freeze-only', { tasks: [{ id: 'T-050', title: 'Laneless job only' }], events: [added('T-050')] });
    const r2 = probe(only.S, only.env, 'only', `const lp = await import(${u(only.S, 'harness/line-producer.mjs')});
await lp.lineProducerPass({});
${superviseCode(only.S, [])}`);
    await guard('2.79.1 (3.1): a lane-less task that is the only work still runs (alone) instead of leaving the line empty (a guard: it passes on 2.79.0 too)', () => [(r2.starts || []).length === 1 && r2.starts[0].task === 'T-050', JSON.stringify({ starts: r2.starts, why: r2.why, err: r2._err.slice(-300) })]);
  }
  {
    const { S, env } = studio('freeze-hold');
    const p = probe(S, { ...env, ...scan, STUDIO_HEAVY_SLOTS: '3', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_POLL_MS: '200' }, 'hold', `import * as H from ${u(S, 'harness/heavy.mjs')};
import { chainBreakerPush } from ${u(S, 'harness/line-producer.mjs')};
${TAKE}
const root = process.cwd();
const now = Date.now();
const cbs = [{ task: 'T-173', n: 4, waiting: ['T-180', 'T-181', 'T-182', 'T-183'] }];
const q = (min) => [{ task: 'T-173', at: new Date(now - min * 60000).toISOString() }];
const run = (min, trainRunning) => chainBreakerPush({ chainBreakers: cbs, now, act: true, deps: { root, quiet: true, trainQueue: q(min), trainRunning } });
const r = {};
const waiting = await run(5, false);
r.waiting = waiting.holding; r.waitingTag = H.quietHolding(root)?.tag || null;
const b = take(H, root, 'builder verify', { kind: 'verify' }); r.builder = b.ok ? 'took it' : b.code; if (b.ok) b.lk.release();
const running = await run(5, true);
r.running = running.holding; r.runningWhy = running.why; r.afterRunning = Boolean(H.quietHolding(root));
const b2 = take(H, root, 'builder verify 2', { kind: 'verify' }); r.builder2 = b2.ok ? 'took it' : b2.code; if (b2.ok) b2.lk.release();
const mid = await run(15, false); r.at15 = mid.holding;
const late = await run(25, false); r.at25 = late.holding; r.at25Why = late.why; r.afterLate = Boolean(H.quietHolding(root));
console.log(JSON.stringify(r));`);
    await guard('2.79.1 (3.1): the chain-breaker verify hold waits for its train (5 min queued: held, a builder verify waits), ends at once when the train runs it (no hold, the builder verify goes), and never lasts past STUDIO_LINE_HOLD_MAX_MIN (20): held at 15 min, not at 25 (fails on 2.79.0: the hold stayed on while the chain-breaker\'s train ran, and for 60 min)', () => [
      p.waiting === true && p.waitingTag === 'chain-breaker' && p.builder === 'HEAVY_BUSY' && p.running === false && p.afterRunning === false && p.builder2 === 'took it' && p.at15 === true && p.at25 === false && p.afterLate === false && /STUDIO_LINE_HOLD_MAX_MIN/.test(p.at25Why || ''),
      JSON.stringify({ ...p, _err: p._err.slice(-400) })]);
  }

  // ---- 3.2: the Line Producer plans for engine lands ----
  {
    const { S, env } = studio('engine');
    const eenv = { ...env, ...scan, STUDIO_HEAVY_SLOTS: '3', STUDIO_ENGINE_SLOTS: '1', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_POLL_MS: '200' };
    const hold = probe(S, eenv, 'hold', `import * as H from ${u(S, 'harness/heavy.mjs')};
import { engineHoldPass } from ${u(S, 'harness/engine-ram.mjs')};
${TAKE}
const root = process.cwd();
const now = Date.now();
const emitted = [];
const targets = [{ name: 'unity', label: 'Unity' }];
const verifyHolder = (min) => ({ label: 'builder verify', at: now - min * 60000, claim: { kind: 'verify' } });
const pass = (o) => engineHoldPass({ now: o.now ?? now, act: true, builders: 5, deps: { root, targets, readQueue: () => o.queue ?? [{ task: 'T-215' }], near: () => false, freeGb: o.free, needGb: () => 12, holders: o.holders, emit: (e) => emitted.push(e) } });
const r = {};
// A verify is running (the real heavy slot), the land is queued, 5 GB free of the 12 it needs.
const running = take(H, root, 'builder verify (running)', { kind: 'verify' });
const p1 = await pass({ free: 5, holders: [verifyHolder(2)] });
r.hold = p1.hold; r.tag = H.quietHolding(root)?.tag || null; r.why = p1.why;
const nb = take(H, root, 'new builder verify', { kind: 'verify' }); r.newVerify = nb.ok ? 'took it' : nb.code; if (nb.ok) nb.lk.release();
r.runningStill = Boolean(H.heavyHolders(root).length);
const land = take(H, root, 'unity land', { kind: 'unity', engine: 'unity', waitMin: 0.03 }); r.land = land.ok ? 'took it' : land.code + ' ' + land.msg; if (land.ok) land.lk.release();
running.lk.release();
// The land holds its slot: the hold is released at once and a verify goes.
const p2 = await pass({ free: 14, holders: [{ label: 'unity land', at: now, claim: { kind: 'unity', engine: 'unity' } }] });
r.releasedHold = p2.hold; r.afterRelease = Boolean(H.quietHolding(root)); r.releasedEvent = emitted.some((e) => e.type === 'line.engine_hold_released');
const nb2 = take(H, root, 'builder verify after', { kind: 'verify' }); r.afterVerify = nb2.ok ? 'took it' : nb2.code; if (nb2.ok) nb2.lk.release();
console.log(JSON.stringify(r));`);
    await guard('2.79.1 (3.2): an engine land queued with 5 of its 12 GB free holds new heavy starts (a quiet hold tagged engine-land: a new builder verify waits, the running verify is not stopped), the land itself is not held by it, and when the land holds its slot the hold is released at once and a verify goes (fails on 2.79.0: no hold: builders kept starting verifies while the land waited 60 min for its RAM)', () => [
      hold.hold === true && hold.tag === 'engine-land' && hold.newVerify === 'HEAVY_BUSY' && hold.runningStill === true && hold.land === 'took it' && hold.releasedHold === false && hold.afterRelease === false && hold.releasedEvent === true && hold.afterVerify === 'took it',
      JSON.stringify({ ...hold, _err: hold._err.slice(-500) })]);

    const none = probe(S, eenv, 'none', `import * as H from ${u(S, 'harness/heavy.mjs')};
import fs from 'node:fs';
import { engineHoldPass, holdStateFile } from ${u(S, 'harness/engine-ram.mjs')};
const root = process.cwd();
const emitted = [];
const p = await engineHoldPass({ now: Date.now(), act: true, builders: 6, deps: { root, targets: [{ name: 'unity', label: 'Unity' }], readQueue: () => [], near: () => false, freeGb: 2, needGb: () => 12, holders: [], emit: (e) => emitted.push(e) } });
console.log(JSON.stringify({ hold: p.hold, cap: p.cap, quiet: Boolean(H.quietHolding(root)), state: fs.existsSync(holdStateFile(root)), events: emitted.length, why: p.why }));`);
    await guard('2.79.1 (3.2): no engine land queued or near: nothing is held back, no RAM reserved (no quiet hold, no state, no builder cap, no events) even with only 2 GB free (fails on 2.79.0: the module is new)', () => [none.hold === false && none.cap === null && none.quiet === false && none.state === false && none.events === 0, JSON.stringify({ ...none, _err: none._err.slice(-300) })]);

    const expiry = probe(S, eenv, 'expiry', `import * as H from ${u(S, 'harness/heavy.mjs')};
import { engineHoldPass } from ${u(S, 'harness/engine-ram.mjs')};
const root = process.cwd();
const t0 = Date.now();
const emitted = [];
const verifyHolder = (at) => ({ label: 'builder verify', at, claim: { kind: 'verify' } });
const pass = (now, free, holders) => engineHoldPass({ now, act: true, builders: 4, deps: { root, targets: [{ name: 'unity', label: 'Unity' }], readQueue: () => [{ task: 'T-215' }], near: () => false, freeGb: free, needGb: () => 12, holders, emit: (e) => emitted.push(e) } });
const r = {};
const a = await pass(t0, 5, [verifyHolder(t0 - 60000)]);
r.start = a.hold;
const b = await pass(t0 + 31 * 60000, 5, [verifyHolder(t0 + 30 * 60000)]);
r.expired = b.expired === true; r.holdAfter = b.hold; r.quiet = Boolean(H.quietHolding(root, { now: t0 + 31 * 60000 }));
const ev = emitted.filter((e) => e.type === 'line.engine_hold_expired');
r.events = ev.length; r.meta = ev[0]?.meta || null; r.msg = ev[0]?.msg || '';
const c = await pass(t0 + 33 * 60000, 5, [verifyHolder(t0 + 32 * 60000)]);
r.stillOff = c.hold === false; r.eventsAfterC = emitted.filter((e) => e.type === 'line.engine_hold_expired').length;
const d = await pass(t0 + 40 * 60000, 5, []);
r.rearmed = d.hold === true;
console.log(JSON.stringify(r));`);
    await guard('2.79.1 (3.2): the engine hold is bounded by STUDIO_ENGINE_HOLD_MAX_MIN (30): at 31 min it is released with the land left queued and ONE line.engine_hold_expired event carrying free RAM, the floor and the holders; it stays off while verifies still run, and comes back at the next natural gap (no verify running) (fails on 2.79.0: the land waited 60 min and refused, with no report)', () => [
      expiry.start === true && expiry.expired === true && expiry.holdAfter === false && expiry.quiet === false && expiry.events === 1 && expiry.meta?.freeGb === 5 && expiry.meta?.floorGb === 12 && (expiry.meta?.holders || []).length === 1 && /5 GB/.test(expiry.msg) && expiry.stillOff === true && expiry.eventsAfterC === 1 && expiry.rearmed === true,
      JSON.stringify({ ...expiry, _err: expiry._err.slice(-300) })]);

    const scale = probe(S, eenv, 'scale', `import { engineHoldPlan } from ${u(S, 'harness/engine-ram.mjs')};
const t0 = Date.now();
const land = { engine: 'unity', label: 'Unity', queued: true, near: false, holdsSlot: false, needGb: 12 };
const slow = (now) => [{ label: 'builder verify', at: now - 60000, claim: { kind: 'verify' } }];
const soon = (now) => [{ label: 'builder verify', at: now - 8 * 60000, claim: { kind: 'verify' } }];
const step = (now, prev, holders) => engineHoldPlan({ now, land, freeGb: 3, holders: holders(now), builders: 5, prev }, {});
const caps = [];
let prev = null; let now = t0;
for (let i = 0; i < 4; i++) { const p = step(now, prev, slow); caps.push(p.cap); prev = p.state; now += 3.2 * 60000; }
let prev2 = null; let now2 = t0; const capsSoon = [];
for (let i = 0; i < 4; i++) { const p = step(now2, prev2, soon); capsSoon.push(p.cap); prev2 = p.state; now2 += 3.2 * 60000 - 100; }
console.log(JSON.stringify({ caps, capsSoon }));`);
    await guard('2.79.1 (3.2): with the RAM short and the running verifies far from done, the builder cap steps down ONE at a time every STUDIO_ENGINE_SCALE_STEP_MIN (5 running: null, 4, 3, 2), not all at once; when the running verify is about to finish (8 of ~10 min) it waits for that gap instead (no step) (fails on 2.79.0: the module is new)', () => [
      JSON.stringify(scale.caps) === JSON.stringify([null, 4, 3, 2]) && (scale.capsSoon || []).every((c) => c === null),
      JSON.stringify({ ...scale, _err: scale._err.slice(-300) })]);

    const plan = probe(S, eenv, 'plan', `import { linePlan } from ${u(S, 'harness/line-producer.mjs')};
const tasks = ['T-1', 'T-2', 'T-3', 'T-4', 'T-5', 'T-6'].map((id) => ({ id, title: id, role: 'builder', priority: 'P1', state: 'ready', meta: {}, type: 'change' }));
const sessions = [1, 2, 3, 4, 5].map((i) => ({ role: 'builder', task: 'X-' + i, running: true }));
const f = { now: Date.now(), tasks, sessions, pace: { maxAgents: 8, perRole: { builder: 8 }, label: 'extreme' }, rig: { known: false } };
const free = linePlan(f); const capped = linePlan({ ...f, engineHold: { hold: true, cap: 3, why: 'x' } });
console.log(JSON.stringify({ free: free.builders.rigCap, target: free.builders.target, cappedRig: capped.builders.rigCap, cappedTarget: capped.builders.target, why: capped.builders.why }));`);
    await guard('2.79.1 (3.2): the engine hold\'s builder cap reaches the plan the supervisor follows (builders.rigCap 3 of a pace of 8, said in the why) and is absent without a hold (fails on 2.79.0: the plan knew nothing of an engine land)', () => [
      plan.free === null && plan.target === 8 && plan.cappedRig === 3 && plan.cappedTarget === 3 && /engine land/.test(plan.why || ''), JSON.stringify({ ...plan, _err: plan._err.slice(-300) })]);

    const near = probe(S, eenv, 'near', `import { engineRoomPass } from ${u(S, 'harness/line-producer.mjs')};
import * as H from ${u(S, 'harness/heavy.mjs')};
const root = process.cwd();
const now = Date.now();
const f = { tasks: [{ id: 'T-215', role: 'engine-porter', state: 'running', meta: { track: 'engine:unity' } }], sessions: [{ role: 'builder', running: true }], rig: { freeRamGb: 3 } };
const ds = { root, engineTargets: [{ name: 'unity', label: 'Unity' }], readQueue: () => [], needGb: () => 12, holders: [], emit: () => {}, freeGb: 3 };
const none = await engineRoomPass({ now, act: true, f, deps: { ...ds, events: [] } });
const stale = await engineRoomPass({ now, act: true, f, deps: { ...ds, events: [{ type: 'task.done_check', task: 'T-215', ts: new Date(now - 90 * 60000).toISOString() }] } });
const hit = await engineRoomPass({ now, act: true, f, deps: { ...ds, events: [{ type: 'task.done_check', task: 'T-215', ts: new Date(now - 5 * 60000).toISOString() }] } });
console.log(JSON.stringify({ none: none.hold, stale: stale.hold, hit: hit.hold, quiet: H.quietHolding(root)?.tag || null, land: hit.land?.near === true }));`);
    await guard('2.79.1 (3.2): an engine-porter task in progress whose porter ran `task done --check` in the last 30 min means a land is near and holds new verifies; with no check, or one 90 min old, nothing is held (fails on 2.79.0: the module is new)', () => [
      near.none === false && near.stale === false && near.hit === true && near.quiet === 'engine-land' && near.land === true, JSON.stringify({ ...near, _err: near._err.slice(-300) })]);
    const src = fs.readFileSync(path.join(S, 'harness', 'task.mjs'), 'utf8');
    await guard('2.79.1 (3.2): `task done --check` leaves the task.done_check event the Line Producer reads for "a land is near" (fails on 2.79.0: the check left no event)', () => [/type: 'task\.done_check'/.test(src), 'harness/task.mjs']);
  }
  {
    const { S, env } = studio('learn');
    const p = probe(S, env, 'learn', `import fs from 'node:fs';
import { recordLandPeak, learnedNeed, landWaitMin, holdStateFile, peakFromHistory } from ${u(S, 'harness/engine-ram.mjs')};
import { engineFloor } from ${u(S, 'harness/engine-tracks.mjs')};
const root = process.cwd();
const mk = (peak) => [{ at: 1000, used: 20 }, { at: 1000 + 5 * 60000, used: 20 + peak * 0.6 }, { at: 1000 + 10 * 60000, used: 20 + peak }, { at: 1000 + 12 * 60000, used: 21 }];
const r = {};
r.noSamples = recordLandPeak('unity', { root, startMs: 5000000, endMs: 6000000, status: 'pass', samples: [] });
r.floor0 = engineFloor('unity', { root, env: {} });
r.p1 = recordLandPeak('unity', { root, startMs: 2000, endMs: 11 * 60000, status: 'pass', samples: mk(6) });
r.p2 = recordLandPeak('unity', { root, startMs: 2000, endMs: 11 * 60000, status: 'pass', samples: mk(7.5) });
r.red = recordLandPeak('unity', { root, startMs: 2000, endMs: 11 * 60000, status: 'red', samples: mk(20) });
r.two = engineFloor('unity', { root, env: {} });
r.p3 = recordLandPeak('unity', { root, startMs: 2000, endMs: 11 * 60000, status: 'pass', samples: mk(7) });
r.three = engineFloor('unity', { root, env: {} });
r.owner = engineFloor('unity', { root, env: { STUDIO_UNITY_MIN_FREE_GB: '15' } });
r.off = engineFloor('unity', { root, env: { STUDIO_ENGINE_RAM_RUNS: '0' } });
r.small = (() => { const rr = JSON.parse(fs.readFileSync('.studio/engine-ram.json', 'utf8')); rr.unity.peaks = rr.unity.peaks.map((x) => ({ ...x, gb: 0.5 })); fs.writeFileSync('.studio/engine-ram.json', JSON.stringify(rr)); return learnedNeed('unity', { root, env: {} }).gb; })();
r.wait = landWaitMin(root, {}, Date.now());
fs.mkdirSync('.studio/line', { recursive: true });
fs.writeFileSync(holdStateFile(root), JSON.stringify({ active: true, seenAt: Date.now() }));
r.waitHold = landWaitMin(root, {}, Date.now());
fs.writeFileSync(holdStateFile(root), JSON.stringify({ active: true, seenAt: Date.now() - 20 * 60000 }));
r.waitStale = landWaitMin(root, {}, Date.now());
console.log(JSON.stringify(r));`);
    await guard('2.79.1 (3.2): the land\'s floor is learned from the peaks of its recent GREEN runs plus a margin (6, 7.5, 7 GB peaks +1.5 = 9 GB, a red run\'s 20 GB ignored), only once 3 green runs exist (2 runs: the table\'s 12 GB), the owner\'s environment floor still wins (15), never under STUDIO_ENGINE_RAM_MIN_GB (4), no sample means no record; and the land waits STUDIO_ENGINE_LAND_WAIT_MIN (20) alone, 35 with a Line hold in force (fails on 2.79.0: the floor was the table\'s 12 GB, never learned, and the land waited 60 min)', () => [
      p.noSamples === null && p.floor0?.gb === 12 && p.p1 === 6 && p.p2 === 7.5 && p.two?.gb === 12 && p.three?.gb === 9 && /measured/.test(p.three?.from || '') && p.owner?.gb === 15 && p.off?.gb === 12 && p.small === 4 && p.wait === 20 && p.waitHold === 35 && p.waitStale === 20,
      JSON.stringify({ ...p, _err: p._err.slice(-400) })]);
  }

  // ---- 3.10: the boost says when it ends ----
  {
    const { S, env } = studio('boost');
    const evf = env.AGENT_EVENTS_FILE;
    const modeFile = path.join(S, 'studio', 'mode.json');
    fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'extreme', history: [], boost: { on: true, by: 'opus-1', at: iso(now - 4 * 3600000), until: iso(now - 60000) } }, null, 2)}\n`);
    const r = probe(S, env, 'expire', `import fs from 'node:fs';
import { boostExpiryPass, effectiveMode } from ${u(S, 'harness/mode.mjs')};
const before = effectiveMode({ mode: 'extreme', boost: { on: true, by: 'x', until: new Date(Date.now() + 3600000).toISOString() } });
const a = boostExpiryPass({});
const b = boostExpiryPass({});
const notices = fs.existsSync('.studio/comm/notices.jsonl') ? fs.readFileSync('.studio/comm/notices.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
console.log(JSON.stringify({ a, b, boosted: before.maxAgents, after: effectiveMode().maxAgents, notices: notices.map((x) => x.text) }));`);
    const ex = events(evf).filter((e) => e.type === 'mode.boost_expired');
    await guard('2.79.1 (3.10): a MAX SPEED boost that ran out posts ONE Studio Status line (a Communicator notice) and a mode.boost_expired event naming the agent target it fell back to, and not again on the next look (fails on 2.79.0: it expired in silence)', () => [
      typeof r.a === 'string' && /expired/i.test(r.a) && r.b === null && (r.notices || []).length === 1 && /expired/i.test(r.notices[0]) && ex.length === 1 && new RegExp(`up to ${r.after} agents`).test(ex[0].msg) && r.boosted > r.after,
      JSON.stringify({ ...r, ex: ex.map((e) => e.msg) })]);
    const supSrc = fs.readFileSync(path.join(S, 'harness', 'supervisor.mjs'), 'utf8');
    await guard('2.79.1 (3.10): the supervisor\'s loop looks for an expired boost on every pass', () => [/boostExpiryPass/.test(supSrc), 'harness/supervisor.mjs']);

    const cli = (args) => spawnSync(process.execPath, ['harness/mode.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout: 60000 });
    const readBoost = () => JSON.parse(fs.readFileSync(modeFile, 'utf8')).boost;
    const future = iso(now + 3 * 3600000);
    const a = cli(['boost', 'on', '--by', 'opus-1', '--until', future]); const ba = readBoost();
    const b = cli(['boost', 'on', '--by', 'opus-1', '--hours', '2', '--until', 'off']); const bb = readBoost();
    const c = cli(['boost', 'on', '--by', 'opus-1', '--until', '23:59']); const bc = readBoost();
    const d = cli(['boost', 'on', '--by', 'opus-1', '--until', '2001-01-01T00:00:00Z']); const bd = readBoost();
    await guard('2.79.1 (3.10): `mode boost on --until <time>` ends at that time (ISO or HH:MM UTC), `--until off` is boost until turned off (it wins over --hours), and a time in the past is refused without changing the boost (fails on 2.79.0: --until was ignored)', () => [
      a.status === 0 && ba.until === future && b.status === 0 && bb.on === true && bb.until === null && c.status === 0 && /^\d{4}-\d\d-\d\dT23:59/.test(bc.until || '') && Date.parse(bc.until) > now && d.status !== 0 && bd.until === bc.until,
      JSON.stringify({ ba, bb, bc, bd, a: out(a).slice(-200), d: out(d).slice(-200) })]);
  }

  // ---- 4: engine push ----
  {
    const { S, env } = studio('push');
    const evf = env.AGENT_EVENTS_FILE;
    const modeFile = path.join(S, 'studio', 'mode.json');
    const cli = (args, extra = {}) => spawnSync(process.execPath, ['harness/mode.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ ...env, ...extra }), timeout: 60000 });
    const push = () => JSON.parse(fs.readFileSync(modeFile, 'utf8')).enginePush;
    const notices = () => { try { return fs.readFileSync(path.join(S, '.studio', 'comm', 'notices.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).text); } catch { return []; } };
    const future = iso(now + 3 * 3600000);
    const noEngine = cli(['engine-push', '--by', 'opus-1']);
    const worker = cli(['engine-push', '--engine', 'unity', '--by', 'builder-s1'], { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s1' });
    const stateBefore = push();
    const on = cli(['engine-push', '--engine', 'unity', '--until', future, '--by', 'opus-1']);
    const p1 = push();
    const prod = cli(['engine-push', '--engine', 'unity', '--by', 'producer-7'], { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-7' });
    const off = cli(['engine-push', 'off', '--by', 'opus-1']);
    const p2 = push();
    const evs = events(evf).filter((e) => e.type === 'mode.engine_push');
    await guard('2.79.1 (4): `mode engine-push --engine <name> [--until <time>|off] --by <who>` switches the engine push on (studio/mode.json enginePush, ONE mode.engine_push event and one Studio Status line each time, on and off), a Producer session may, a worker session is refused (state unchanged), and with no --engine and no single engine it asks which (fails on 2.79.0: no such mode)', () => [
      noEngine.status !== 0 && /which engine/i.test(out(noEngine)) && worker.status !== 0 && /worker/.test(out(worker)) && stateBefore === undefined && on.status === 0 && p1?.on === true && p1.engine === 'unity' && p1.until === future && prod.status === 0 && off.status === 0 && p2?.on === false
        && evs.length === 3 && evs[0].meta?.engine === 'unity' && evs[0].meta?.by === 'opus-1' && evs[0].meta?.until === future && evs[2].meta?.on === false && notices().filter((t) => /ENGINE PUSH/.test(t)).length === 3 && /ENGINE PUSH/.test(out(on)),
      JSON.stringify({ noEngine: out(noEngine).slice(-150), worker: out(worker).slice(-200), p1, p2, evs: evs.map((e) => e.msg), notices: notices(), on: out(on).slice(-200) })]);

    fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'extreme', history: [], enginePush: { on: true, engine: 'unity', by: 'opus-1', at: iso(now - 4 * 3600000), until: iso(now - 60000) } }, null, 2)}\n`);
    const ex = probe(S, env, 'pushexp', `import fs from 'node:fs';
import { enginePushExpiryPass, effectiveMode } from ${u(S, 'harness/mode.mjs')};
const before = effectiveMode().enginePush;
const a = enginePushExpiryPass({}); const b = enginePushExpiryPass({});
const notices = fs.readFileSync('.studio/comm/notices.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l).text).filter((t) => /expired/.test(t));
console.log(JSON.stringify({ a, b, before, notices }));`);
    const pe = events(evf).filter((e) => e.type === 'mode.engine_push' && e.meta?.expired);
    await guard('2.79.1 (4): an engine push that ran out stops applying and says so ONCE: a mode.engine_push event (expired, engine, until, by) and one Studio Status line (fails on 2.79.0: no engine push)', () => [
      typeof ex.a === 'string' && /expired/.test(ex.a) && ex.b === null && ex.before === null && ex.notices.length === 1 && pe.length === 1 && pe[0].meta.engine === 'unity' && pe[0].meta.by === 'opus-1', JSON.stringify({ ...ex, pe: pe.length })]);

    fs.writeFileSync(modeFile, `${JSON.stringify({ mode: 'extreme', history: [], enginePush: { on: true, engine: 'unity', by: 'opus-1', at: iso(now), until: null } }, null, 2)}\n`);
    const pl = probe(S, { ...env, STUDIO_ENGINE_PUSH_MIN_TOTAL_GB: '1' }, 'pushplan', `import { linePlan, summaryLine } from ${u(S, 'harness/line-producer.mjs')};
import { effectiveMode } from ${u(S, 'harness/mode.mjs')};
import { engineSlotsAt } from ${u(S, 'harness/heavy.mjs')};
import { engineHoldPlan } from ${u(S, 'harness/engine-ram.mjs')};
const t = (id, role, priority, track) => ({ id, title: id, role, priority, state: 'ready', meta: track ? { track } : {}, type: 'change' });
const tasks = [t('T-1', 'builder', 'P0'), t('T-2', 'builder', 'P1'), t('T-3', 'engine-porter', 'P3', 'engine:unity'), t('T-4', 'engine-porter', 'P3', 'engine:godot'), t('T-5', 'engine-porter', 'P3', 'engine:unity')];
const f = { now: Date.now(), tasks, sessions: [], pace: { maxAgents: 6, perRole: { builder: 6 }, label: 'extreme' }, rig: { known: false } };
const normal = linePlan(f).order; const pushed = linePlan({ ...f, enginePush: { engine: 'unity' } });
const m = effectiveMode();
const land = { engine: 'unity', label: 'Unity', queued: true, near: false, holdsSlot: false, needGb: 12 };
const t0 = Date.now();
const longHeld = engineHoldPlan({ now: t0 + 50 * 60000, land: { ...land, push: true }, freeGb: 4, holders: [{ label: 'v', at: t0, claim: { kind: 'verify' } }], builders: 3, prev: { engine: 'unity', active: true, since: t0, scaled: 0, scaleBase: 3, lastScaleAt: t0 } }, {});
const afterExpiryNormal = engineHoldPlan({ now: t0 + 50 * 60000, land, freeGb: 4, holders: [{ label: 'v', at: t0 + 49 * 60000, claim: { kind: 'verify' } }], builders: 3, prev: { engine: 'unity', active: false, expiredAt: t0 + 31 * 60000 } }, {});
const afterExpiryPush = engineHoldPlan({ now: t0 + 50 * 60000, land: { ...land, push: true }, freeGb: 4, holders: [{ label: 'v', at: t0 + 49 * 60000, claim: { kind: 'verify' } }], builders: 3, prev: { engine: 'unity', active: false, expiredAt: t0 + 31 * 60000 } }, {});
console.log(JSON.stringify({ normal, pushed: pushed.order.slice(0, 3), cap: m.perRole['engine-porter'], builders: m.perRole.builder, slots: engineSlotsAt(process.cwd(), { STUDIO_ENGINE_PUSH_MIN_TOTAL_GB: '1' }), slotsSmall: engineSlotsAt(process.cwd(), { STUDIO_ENGINE_PUSH_MIN_TOTAL_GB: '99999' }), longHeld: longHeld.hold && !longHeld.expired, afterExpiryNormal: afterExpiryNormal.hold, afterExpiryPush: afterExpiryPush.hold, line: summaryLine({ builders: { running: 0, target: 3 }, enginePush: { engine: 'unity' } }) }));`);
    await guard('2.79.1 (4): with the push on, the pushed engine\'s ready porters head the plan order (T-3, T-5 before the game\'s P0 T-1, which normally goes before T-5; another engine\'s porter is not pushed), engine-porter may use as many slots as builders, the engine hold has no time limit (still held at 50 min) and comes back after an expiry without waiting for a gap, the engine line gets 2 slots when the RAM allows (1 when it does not), and the Line\'s status line says so (fails on 2.79.0: no push)', () => [
      JSON.stringify(pl.pushed) === JSON.stringify(['T-3', 'T-5', 'T-1']) && (pl.normal || []).indexOf('T-1') < (pl.normal || []).indexOf('T-5') && pl.cap === pl.builders && pl.longHeld === true && pl.afterExpiryNormal === false && pl.afterExpiryPush === true && pl.slots === 2 && pl.slotsSmall === 1 && /ENGINE PUSH unity/.test(pl.line),
      JSON.stringify({ ...pl, _err: pl._err.slice(-400) })]);
    const supSrc2 = fs.readFileSync(path.join(S, 'harness', 'supervisor.mjs'), 'utf8');
    await guard('2.79.1 (4): the supervisor looks for an expired engine push every pass and studio:status shows a push that is on', () => [/enginePushExpiryPass/.test(supSrc2) && /ENGINE PUSH:/.test(supSrc2), 'harness/supervisor.mjs']);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}
