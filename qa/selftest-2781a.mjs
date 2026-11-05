/**
 * qa/selftest-2781a.mjs — 2.78.1 (a): B-123, unscoped ready tasks ran one at a time, and the Line Producer's lanes and
 * phase awareness.
 *   lane-running  `task lane` on a task already in progress reaches the supervisor: its builder works in that lane now
 *   lane-who      `task lane … --by` works for a Producer session and the orchestrator; a launched builder is refused
 *   line-lanes    the Line Producer's pass sets a lane on an unscoped ready builder task (from its --scope), logs it as the
 *                 Producer's decision, and reports a task it can't scope as "unscoped" (status, blockers, note)
 *   predicted     two builders with no lane run side by side when their predicted files don't overlap; an overlap, a
 *                 task with no prediction, or STUDIO_UNSCOPED_PARALLEL=off keeps the old rule
 *   shared-sim    a ready task on shared sim code waits (--after) for the open task on the same shared files; reported
 *                 in the plan; STUDIO_SHARED_SIM=off turns it off
 * Each check fails on 2.78.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781A({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const UNSET = ['STUDIO_UNSCOPED_PARALLEL', 'STUDIO_SHARED_SIM', 'STUDIO_LINE_LANES', 'STUDIO_REQUIRE_LANE', 'STUDIO_MODEL_ROUTING', 'STUDIO_BUILDER_TOOL', 'STUDIO_WORKTREES', 'STUDIO_ENV_FROM_FILE', 'STUDIO_WAVES'];
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TEST_MACHINE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_TRAIN_AUTO: 'off',
    STUDIO_LINE_PRODUCER: '', STUDIO_LINE_RIG: 'heavy', STUDIO_LINE_EXPANSION_SHARE: '0', STUDIO_LINE_CHAIN_MIN: '', STUDIO_LINE_PLAN_MAX_SEC: '', STUDIO_TIER_CHEAP_MODEL: '', STUDIO_TIER_MID_MODEL: '', STUDIO_TIER_TOP_MODEL: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781a-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let n = 0;
  const made = [];
  /** A studio copy with its own git, an events file, a board ({ id, title, ip? }) and events. */
  const studio = (name, { tasks = [], events = [] } = {}) => {
    const S = path.join(tmpRoot, `2781a-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json', 'studio/models.json', 'studio/approvals', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-2781a.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 2 * 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    const line = (t) => `- [${t.ip ? '>' : ' '}] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`;
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n${tasks.filter((t) => t.ip).map(line).join('\n')}\n\n## BACKLOG\n${tasks.filter((t) => !t.ip).map(line).join('\n')}\n\n## DONE\n`);
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: {} }, null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'mode.json'), `${JSON.stringify({ mode: 'extreme', history: [] }, null, 2)}\n`);
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2781a-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: `${out(r)}`.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const cli = (S, env, args) => spawnSync(process.execPath, ['harness/task.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout: 120000 });
  const holdsOf = (S) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } };
  const added = (task, meta = {}) => ({ type: 'task.added', agent: 'producer', task, msg: `Queued ${task} [P1] (builder): t`, meta });
  /** One supervise() pass with fake sessions; the starts it made. */
  const superviseCode = (S, sessions) => `const sup = await import(${u(S, 'harness/supervisor.mjs')});
const starts = [];
const sess = ${JSON.stringify(sessions)};
const deps = { sessions: () => sess.map((s) => ({ ...s })), launchableRoles: (r) => r, nextAgentName: (role) => role + '-t' + starts.length, startAgent: (o) => { starts.push(o); return { ok: true }; } };
const r = await sup.supervise({ watcher: true, deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ starts: starts.map((o) => ({ task: o.task, lane: o.lane || null })), why: r.why }));`;

  // ---- lane-running: task lane on a task in progress reaches the supervisor ----
  await guard('2.78.1 (B-123): `task lane <ID> <folders> --by <Producer>` on a task already in progress reaches the supervisor: its running builder (launched with no lane) now works in that lane, so a waiting task scoped to another folder starts beside it; the lane is in studio/task-holds.json and in the decision log (fails on 2.78.0: the session kept its launch lane, "builder-s1 is working on the whole game (no lane)", nothing started)', async () => {
    const { S, env } = studio('running', { tasks: [{ id: 'T-001', title: 'Rework the harbour pier', ip: true }, { id: 'T-002', title: 'Tune the tide table' }], events: [added('T-001'), added('T-002')] });
    const pe = { ...env, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-7' };
    const a = cli(S, pe, ['lane', 'T-001', 'web/example-sim/pier', '--by', 'producer-7']);
    const b = cli(S, pe, ['lane', 'T-002', 'web/example-sim/tide', '--by', 'producer-7']);
    const r = probe(S, env, 'running', superviseCode(S, [{ agent: 'builder-s1', role: 'builder', task: 'T-001', lane: null, running: true }]));
    const h = holdsOf(S);
    let dec = [];
    try { dec = fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const ok = a.status === 0 && b.status === 0 && /in progress/.test(out(a)) && h['T-001']?.lane === 'web/example-sim/pier' && h['T-002']?.lane === 'web/example-sim/tide'
      && (r.starts || []).length === 1 && r.starts[0].task === 'T-002' && r.starts[0].lane === 'web/example-sim/tide' && dec.some((d) => d.action === 'task-lane' && d.subject === 'T-002');
    return [ok, JSON.stringify({ a: out(a).slice(-300), b: out(b).slice(-200), starts: r.starts, why: r.why, holds: h, dec: dec.map((d) => d.action), err: ok ? '' : r._err })];
  });

  // ---- lane-who ----
  await guard('2.78.1 (B-123): `task lane … --by` works for a Producer session and the orchestrator (an outside agent) and is refused for a launched builder session or a worker name, which leaves the lane as it was (fails on 2.78.0: the builder\'s lane change was accepted)', async () => {
    const { S, env } = studio('who', { tasks: [{ id: 'T-001', title: 'Tune the tide table' }], events: [added('T-001')] });
    const prod = cli(S, { ...env, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-7' }, ['lane', 'T-001', 'web/example-sim/a', '--by', 'producer-7']);
    const orch = cli(S, { ...env, STUDIO_LOCK_OWNER: 'opus-2' }, ['lane', 'T-001', 'web/example-sim/b', '--by', 'opus-2']);
    const bld = cli(S, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s9' }, ['lane', 'T-001', 'all', '--by', 'builder-s9']);
    const wname = cli(S, env, ['lane', 'T-001', 'all', '--by', 'builder-s9']);
    const h = holdsOf(S);
    const ok = prod.status === 0 && orch.status === 0 && bld.status !== 0 && /Refused/.test(out(bld)) && wname.status !== 0 && /worker/.test(out(wname)) && h['T-001']?.lane === 'web/example-sim/b';
    return [ok, JSON.stringify({ prod: out(prod).slice(-200), orch: out(orch).slice(-200), bld: out(bld).slice(-300), wname: out(wname).slice(-300), h })];
  });

  // ---- line-lanes ----
  await guard('2.78.1 (B-123): the Line Producer\'s pass sets a lane on an unscoped ready builder task from its --scope globs (web/example-sim/**) in studio/task-holds.json, logs it as the Producer\'s decision (a task.lane event, .studio/decisions.jsonl), and reports a task it can\'t scope as "unscoped" (its status blockers, the plan text and the Producer note); a dry pass (line -- plan) sets nothing (fails on 2.78.0: no lane was set and nothing said "unscoped")', async () => {
    const { S, ev, env } = studio('line', { tasks: [{ id: 'T-001', title: 'Polish the pier lights' }, { id: 'T-002', title: 'Make it more fun' }], events: [added('T-001', { scope: 'web/example-sim/**' }), added('T-002')] });
    const dry = probe(S, env, 'dry', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
const s = await lp.lineProducerPass({ dryRun: true });
console.log(JSON.stringify({ lanes: s.lanes }));`);
    const holdsAfterDry = holdsOf(S);
    const r = probe(S, env, 'line', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
const s = await lp.lineProducerPass({});
console.log(JSON.stringify({ lanes: s.lanes, blocked: s.blocked, reasons: s.reasons, text: lp.statusText(s) }));`);
    const h = holdsOf(S);
    const evs = fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let dec = [];
    try { dec = fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const ok = !holdsAfterDry['T-001']?.lane && dry.lanes?.set?.some((x) => x.task === 'T-001' && x.dry)
      && h['T-001']?.lane === 'web/example-sim' && !('lane' in (h['T-002'] || {}))
      && evs.some((e) => e.type === 'task.lane' && e.task === 'T-001' && e.agent === 'line-producer' && /for the Producer/.test(e.msg))
      && dec.some((d) => d.action === 'task-lane' && d.subject === 'T-001' && /Producer/.test(d.why))
      && (r.blocked || []).some((b) => b.task === 'T-002' && b.kind === 'unscoped') && /Unscoped .*T-002/.test(r.text || '') && /Lanes set .*T-001 -> web\/example-sim/.test(r.text || '')
      && (r.reasons || []).some((x) => /T-002/.test(x) && /no lane/.test(x));
    return [ok, JSON.stringify({ dryLanes: dry.lanes, lanes: r.lanes, blocked: r.blocked, reasons: r.reasons, h, dec: dec.map((d) => d.action), err: ok ? '' : `${dry._err} ${r._err}` }).slice(0, 3500)];
  });

  // ---- predicted ----
  {
    const tasks = [{ id: 'T-001', title: 'Rework the tide sim', ip: true }, { id: 'T-002', title: 'Tune the shop prices' }, { id: 'T-003', title: 'Tune the tide waves' }, { id: 'T-004', title: 'Make it more fun' }];
    const events = [added('T-001', { scope: 'src/tide/**' }), added('T-002', { scope: 'src/shop/**' }), added('T-003', { scope: 'src/tide/waves/**' }), added('T-004')];
    const sess = [{ agent: 'builder-s1', role: 'builder', task: 'T-001', lane: null, running: true }];
    await guard('2.78.1 (B-123): two builders with no lane run side by side when both have a prediction (plan-waves: their --scope) and the predictions don\'t overlap: with builder-s1 on T-001 (src/tide/**) the supervisor starts T-002 (src/shop/**), not T-003 (src/tide/waves/**, overlaps) nor T-004 (no prediction); STUDIO_UNSCOPED_PARALLEL=off starts nothing (fails on 2.78.0: "builder-s1 is working on the whole game (no lane)", nothing started)', async () => {
      const { S, env } = studio('pred', { tasks, events });
      const r = probe(S, { ...env, STUDIO_LINE_PRODUCER: 'off' }, 'pred', superviseCode(S, sess));
      const { S: S2, env: env2 } = studio('pred-off', { tasks, events });
      const off = probe(S2, { ...env2, STUDIO_LINE_PRODUCER: 'off', STUDIO_UNSCOPED_PARALLEL: 'off' }, 'pred-off', superviseCode(S2, sess));
      const ok = (r.starts || []).map((x) => x.task).join(',') === 'T-002' && Array.isArray(off.starts) && off.starts.length === 0;
      return [ok, JSON.stringify({ starts: r.starts, why: r.why, off: off.starts, offWhy: off.why, err: ok ? '' : `${r._err} ${off._err}` }).slice(0, 3000)];
    });
  }

  // ---- shared-sim ----
  {
    const tasks = [{ id: 'T-001', title: 'Early game: the starting economy', ip: true }, { id: 'T-002', title: 'Early game: starting cash rule' }, { id: 'T-003', title: 'Polish the page header' }];
    const events = [added('T-001', { scope: 'cartridges/example-sim/**' }), added('T-002', { scope: 'cartridges/example-sim/index.mjs' }), added('T-003', { scope: 'web/example-sim/index.html' })];
    await guard('2.78.1 (phase awareness): a ready builder task whose predicted files touch shared sim code (the cartridge\'s core file, cartridges/*/index.* by default) is stacked --after the open task on the same shared file (T-002 after T-001 in studio/task-holds.json, blocked "chain"), a task elsewhere is not (T-003), and the plan says so ("Stacked on shared sim code"); STUDIO_SHARED_SIM=off stacks nothing (fails on 2.78.0: T-002 had no --after and ran beside T-001)', async () => {
      const { S, env } = studio('shared', { tasks, events });
      const code = (S0) => `const lp = await import(${u(S0, 'harness/line-producer.mjs')});
const s = await lp.lineProducerPass({});
console.log(JSON.stringify({ lanes: s.lanes, blocked: s.blocked, order: s.order, text: lp.statusText(s) }));`;
      const r = probe(S, env, 'shared', code(S));
      const h = holdsOf(S);
      const { S: S2, env: env2 } = studio('shared-off', { tasks, events });
      const off = probe(S2, { ...env2, STUDIO_SHARED_SIM: 'off' }, 'shared-off', code(S2));
      const h2 = holdsOf(S2);
      const ok = (h['T-002']?.after || []).includes('T-001') && !(h['T-003']?.after || []).length
        && (r.blocked || []).some((b) => b.task === 'T-002' && b.kind === 'chain' && /shared sim code/.test(b.why)) && /Stacked on shared sim code.*T-002 after T-001.*cartridges\/example-sim\/index\.mjs/.test(r.text || '')
        && !(h2['T-002']?.after || []).length && !(off.lanes?.stacked || []).length && (off.order || []).includes('T-002');
      return [ok, JSON.stringify({ stacked: r.lanes?.stacked, blocked: r.blocked, h, offStacked: off.lanes?.stacked, h2, err: ok ? '' : `${r._err} ${off._err}` }).slice(0, 3500)];
    });
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
}
