/**
 * qa/selftest-2781g.mjs — 2.78.1 (g): the Line Producer's stacks keep their why.
 *   stack-why       a stack the Line Producer's pass made still says why (its shared sim files) after later passes: the
 *                   task.hold event carries { after, via }
 * 2.80: the Planning Room (the War Room's room for the plan) and its checks are gone.
 * Each check fails on 2.78.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781G({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const UNSET = ['STUDIO_PLANNING_ROOM', 'STUDIO_SHARED_SIM', 'STUDIO_LINE_LANES', 'STUDIO_LINE_PLAN_MAX_SEC', 'STUDIO_PRODUCER_NAME', 'STUDIO_WORKTREES', 'STUDIO_ENV_FROM_FILE'];
  const base = {
    STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_CARTRIDGE: '', CLAUDECODE: '', AI_AGENT: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781g-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let n = 0;
  /** A studio copy with its own git, an events file, a board ({ id, title, ip?, role? }), holds and events. */
  const studio = (name, { tasks = [], events = [], holds = {}, status = null } = {}) => {
    const S = path.join(tmpRoot, `2781g-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json', 'studio/handoffs']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-2781g.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 2 * 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    const line = (t) => `- [${t.ip ? '>' : ' '}] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`;
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n${tasks.filter((t) => t.ip).map(line).join('\n')}\n\n## BACKLOG\n${tasks.filter((t) => !t.ip).map(line).join('\n')}\n\n## DONE\n`);
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: holds }, null, 2)}\n`);
    if (status) { fs.mkdirSync(path.join(S, '.studio', 'line'), { recursive: true }); fs.writeFileSync(path.join(S, '.studio', 'line', 'status.json'), `${JSON.stringify(status, null, 2)}\n`); }
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2781g-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: `${out(r)}`.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const added = (task, meta = {}) => ({ type: 'task.added', agent: 'producer', task, msg: `Queued ${task} [P1] (builder): t`, meta: { role: 'builder', ...meta } });
  const board = [
    { id: 'T-101', title: 'Stalls restock between days', ip: true },
    { id: 'T-102', title: 'Price board shows takings' },
    { id: 'T-103', title: 'Tidy the placement grid' },
    { id: 'T-104', title: 'Shared tick order' },
    { id: 'T-105', title: 'Lanterns light the paths' },
  ];
  const holds = { 'T-101': { lane: 'cartridges/example-sim' }, 'T-102': { lane: 'src/board' }, 'T-104': { lane: 'cartridges/example-sim/sim.js', after: ['T-101'] }, 'T-105': { parked: { by: 'prod-1', why: 'after the art pass' } } };
  const events = [
    ...board.map((t) => added(t.id)),
    { type: 'task.start', agent: 'builder-x1', model: 'model-mid', task: 'T-101', msg: 'Started T-101' },
    { type: 'waves.shadow', agent: 'watch', msg: 'Waves (shadow)', meta: { waves: [['T-103'], ['T-102']] } },
  ];

  // ---- stack-why ----
  await guard('2.78.1 (g) stack-why: a stack made by the Line Producer\'s pass keeps why: its hold names the task it waits for and its task.hold event carries { after, via } (fails on 2.78.0: the stack\'s event carried no files; 2.80: the Planning Room that showed it is gone)', async () => {
    const { S, env } = studio('why', { tasks: board, events: board.map((t) => added(t.id)), holds: { 'T-101': { lane: 'cartridges/example-sim' }, 'T-104': { lane: 'cartridges/example-sim/sim.js' } } });
    const code = `const lp = await import(${u(S, 'harness/lane-plan.mjs')});
const th = await import(${u(S, 'harness/task-hold.mjs')});
const ev = await import(${u(S, 'harness/event.mjs')});
const tasks = [{ id: 'T-101', title: 'Stalls restock', role: 'builder', meta: {}, state: 'running' }, { id: 'T-104', title: 'Shared tick order', role: 'builder', meta: {}, state: 'ready' }];
const r = await lp.lanePass({ tasks, order: ['T-104'], holds: th.readHolds(), events: ev.readRecentEvents(2000), act: true, files: ['cartridges/example-sim/sim.js', 'cartridges/example-sim/ui.js'], env: { ...process.env, STUDIO_LINE_LANES: 'on' } });
const events = ev.readRecentEvents(2000);
const hold = events.filter((e) => e.type === 'task.hold' && e.task === 'T-104').pop() || null;
console.log(JSON.stringify({ stacked: r.stacked, after: th.readHolds()['T-104']?.after || null, meta: hold?.meta || null }));`;
    const r = probe(S, env, 'why', code);
    const ok = (r.after || []).includes('T-101') && r.meta?.after === 'T-101' && (r.meta?.via || []).includes('cartridges/example-sim/sim.js');
    return [ok, `${JSON.stringify({ stacked: r.stacked, after: r.after, meta: r.meta })} ${r._err || ''}`.slice(0, 2500)];
  });
}
