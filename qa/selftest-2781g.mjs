/**
 * qa/selftest-2781g.mjs — 2.78.1 (g): the Planning Room, the Line Producer's own room on the War Room's Studio floor.
 *   planning-state  the HUD's state carries the Planning Room (wide, right after Production, beside the assignment rooms;
 *                   the Line Producer sits there) and its plan: running builders with lane or the whole game and their start,
 *                   the ready queue in the Line Producer's order with lanes, "unscoped", plan-waves' wave and the model
 *                   route, stacked tasks (on what, why: shared sim code) and blocked/unscoped ones, the last pass
 *   planning-empty  no plan on file: "No plan yet: the Line Producer hasn't run" (running builders still shown); an old
 *                   plan is shown with its age, not as live; STUDIO_PLANNING_ROOM=off: no room, the Line Producer back
 *                   in Production
 *   stack-why       a stack the Line Producer's pass made still says why (its shared sim files) after later passes: the
 *                   task.hold event carries { after, via }
 *   page            the War Room's page draws the room from the HUD's "planning" (rows, lanes, "unscoped", the empty
 *                   state), read-only (no buttons), and puts a room with "after" right after that room
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
  const hudCode = (S) => `const h = await import(${u(S, 'harness/hud.mjs')});
const s = h.buildHudState();
const ri = s.planning?.on ? s.planning.roomInfo : null;
console.log(JSON.stringify({ planning: s.planning || null, rooms: [...(ri ? [ri] : []), ...(s.assignmentRooms || [])].map((r) => ({ id: r.id, after: r.after || null, wide: Boolean(r.wide) })), lp: s.agents.filter((a) => a.name === 'line-producer').map((a) => ({ room: a.room, kind: a.kind })) }));`;
  const added = (task, meta = {}) => ({ type: 'task.added', agent: 'producer', task, msg: `Queued ${task} [P1] (builder): t`, meta: { role: 'builder', ...meta } });
  const board = [
    { id: 'T-101', title: 'Stalls restock between days', ip: true },
    { id: 'T-102', title: 'Price board shows takings' },
    { id: 'T-103', title: 'Tidy the placement grid' },
    { id: 'T-104', title: 'Shared tick order' },
    { id: 'T-105', title: 'Lanterns light the paths' },
  ];
  const planStatus = (atMs) => ({
    at: iso(atMs), mode: 'on', dryRun: false,
    builders: { running: 1, target: 3, paceCap: 3, rigCap: null, ready: 2, why: 'pace fast allows 3 builders; 1 running; 2 ready' },
    blocked: [
      { task: 'T-103', role: 'builder', kind: 'unscoped', why: 'T-103 names no folder, file or --scope and has no overlap history: unscoped', fix: 'npm run task -- lane T-103 <folders> --by <you>', runsAlone: true },
      { task: 'T-104', role: 'builder', kind: 'chain', why: 'waits for T-101', fix: 'starts when T-101 lands' },
      { task: 'T-105', role: 'builder', kind: 'park', why: 'parked by prod-1: after the art pass', fix: 'npm run task -- unpark T-105 --by <name>' },
    ],
    chainBreakers: [], order: ['T-102', 'T-103'],
    routes: { 'T-102': { tier: 'cheap', model: 'model-small' }, 'T-103': { tier: 'mid', model: null } },
    reasons: ['1 ready builder task has no lane the Line Producer could work out (T-103)'],
    fixed: [],
    lanes: { mode: 'on', set: [{ task: 'T-102', lane: 'src/board', from: ['scope'] }], unscoped: [{ task: 'T-103' }], running: [], stacked: [{ task: 'T-104', after: 'T-101', via: ['cartridges/example-sim/sim.js'] }], shared: { from: 'the default', n: 11 } },
    text: 'Line: 1/3 builders; 3 blocked (1 unscoped, 1 chain, 1 park)',
  });
  const holds = { 'T-101': { lane: 'cartridges/example-sim' }, 'T-102': { lane: 'src/board' }, 'T-104': { lane: 'cartridges/example-sim/sim.js', after: ['T-101'] }, 'T-105': { parked: { by: 'prod-1', why: 'after the art pass' } } };
  const events = [
    ...board.map((t) => added(t.id)),
    { type: 'task.start', agent: 'builder-x1', model: 'model-mid', task: 'T-101', msg: 'Started T-101' },
    { type: 'waves.shadow', agent: 'watch', msg: 'Waves (shadow)', meta: { waves: [['T-103'], ['T-102']] } },
  ];

  // ---- planning-state ----
  await guard('2.78.1 (g) planning-state: the HUD carries the Planning Room (wide, after Production, the Line Producer seated there) and the plan: now (lane, start), next up in order (lane, unscoped, wave, model), stacked (on what, why) and blocked, the last pass (fails on 2.78.0: no Planning Room, no "planning" in the HUD, the Line Producer sat in Production)', async () => {
    const { S, env } = studio('state', { tasks: board, events, holds, status: planStatus(now - 60000) });
    const r = probe(S, env, 'state', hudCode(S));
    const p = r.planning || {};
    const room = (r.rooms || []).find((x) => x.id === 'planning');
    const nowRow = (p.now || [])[0] || {};
    const next = (p.next || []).map((x) => x.task);
    const n102 = (p.next || []).find((x) => x.task === 'T-102') || {};
    const n103 = (p.next || []).find((x) => x.task === 'T-103') || {};
    const st = (p.waiting?.stacked || []).find((x) => x.task === 'T-104') || {};
    const bl = (p.waiting?.blocked || []).map((x) => `${x.task}:${x.kind}`);
    const lp = p.lastPass || {};
    const ok = room && room.wide && room.after === 'production' && (r.lp || []).some((a) => a.room === 'planning')
      && p.hasPlan === true && p.live === false && p.builders?.target === 3 && p.builders?.running === 1
      && nowRow.task === 'T-101' && nowRow.lane === 'cartridges/example-sim' && nowRow.agent === 'builder-x1' && nowRow.startedAt && nowRow.model === 'model-mid'
      && next.join(',') === 'T-102,T-103' && n102.lane === 'src/board' && n102.model === 'model-small' && n102.wave === 2 && !n102.unscoped && n103.unscoped === true && n103.wave === 1
      && st.after?.[0]?.task === 'T-101' && st.after[0].state === 'running' && /shared sim code: cartridges\/example-sim\/sim\.js/.test(st.why || '')
      && bl.includes('T-103:unscoped') && bl.includes('T-105:park') && !bl.includes('T-104:chain')
      && lp.lanesSet?.[0]?.task === 'T-102' && lp.stacked?.[0]?.after === 'T-101' && /^Line: 1\/3/.test(lp.text || '') && lp.reasons?.length === 1 && Number.isFinite(lp.ageMin);
    return [ok, `room ${JSON.stringify(room)} lp ${JSON.stringify(r.lp)} planning ${JSON.stringify(p).slice(0, 2500)} ${r._err || ''}`];
  });

  // ---- planning-empty ----
  await guard('2.78.1 (g) planning-empty: with no plan on file the room says "No plan yet: the Line Producer hasn\'t run" (running builders still listed); STUDIO_PLANNING_ROOM=off: no Planning Room and the Line Producer sits in Production (fails on 2.78.0: no "planning" in the HUD)', async () => {
    const { S, env } = studio('empty', { tasks: board, events, holds });
    const r = probe(S, env, 'empty', hudCode(S));
    const p = r.planning || {};
    const a = p.hasPlan === false && p.why === "No plan yet: the Line Producer hasn't run" && (p.now || []).some((x) => x.task === 'T-101') && !p.next && (r.rooms || []).some((x) => x.id === 'planning');
    // A plan on file but the line producer's desk with the room switched off.
    const { S: S2, env: env2 } = studio('off', { tasks: board, events, holds, status: planStatus(now - 3 * 3600000) });
    const r2 = probe(S2, { ...env2, STUDIO_PLANNING_ROOM: 'off' }, 'off', hudCode(S2));
    const b = !(r2.rooms || []).some((x) => x.id === 'planning') && (r2.lp || []).some((x) => x.room === 'production');
    const r3 = probe(S2, env2, 'old', hudCode(S2));
    const c = r3.planning?.hasPlan === true && r3.planning.live === false && r3.planning.lastPass?.ageMin >= 179 && /supervisor isn't running/.test(r3.planning.stale || '');
    return [a && b && c, `empty ${a}: ${JSON.stringify(p).slice(0, 600)} | off ${b}: ${JSON.stringify({ rooms: r2.rooms, lp: r2.lp })} | old ${c}: ${JSON.stringify(r3.planning?.lastPass || null).slice(0, 300)} ${r.planning?.stale || ''} ${(r._err || '') + (r2._err || '')}`.slice(0, 3000)];
  });

  // ---- stack-why ----
  await guard('2.78.1 (g) stack-why: a stack made by the Line Producer\'s pass still says why in the Planning Room on a later pass (its task.hold event carries { after, via }) (fails on 2.78.0: no Planning Room; the stack\'s event carried no files)', async () => {
    const { S, env } = studio('why', { tasks: board, events: board.map((t) => added(t.id)), holds: { 'T-101': { lane: 'cartridges/example-sim' }, 'T-104': { lane: 'cartridges/example-sim/sim.js' } } });
    const code = `const lp = await import(${u(S, 'harness/lane-plan.mjs')});
const th = await import(${u(S, 'harness/task-hold.mjs')});
const ev = await import(${u(S, 'harness/event.mjs')});
const pr = await import(${u(S, 'harness/planning-room.mjs')});
const tk = await import(${u(S, 'harness/task.mjs')});
const tasks = [{ id: 'T-101', title: 'Stalls restock', role: 'builder', meta: {}, state: 'running' }, { id: 'T-104', title: 'Shared tick order', role: 'builder', meta: {}, state: 'ready' }];
const r = await lp.lanePass({ tasks, order: ['T-104'], holds: th.readHolds(), events: ev.readRecentEvents(2000), act: true, files: ['cartridges/example-sim/sim.js', 'cartridges/example-sim/ui.js'], env: { ...process.env, STUDIO_LINE_LANES: 'on' } });
const events = ev.readRecentEvents(2000);
const hold = events.filter((e) => e.type === 'task.hold' && e.task === 'T-104').pop() || null;
const room = pr.planningRoom({ status: { at: new Date().toISOString(), mode: 'on', order: [], blocked: [], lanes: { stacked: [] } }, queue: tk.parseNextQueue(), holds: th.readHolds(), events });
console.log(JSON.stringify({ stacked: r.stacked, after: th.readHolds()['T-104']?.after || null, meta: hold?.meta || null, room: room.waiting?.stacked || null }));`;
    const r = probe(S, env, 'why', code);
    const row = (r.room || []).find((x) => x.task === 'T-104') || {};
    const ok = (r.after || []).includes('T-101') && r.meta?.after === 'T-101' && (r.meta?.via || []).includes('cartridges/example-sim/sim.js') && /shared sim code: cartridges\/example-sim\/sim\.js/.test(row.why || '') && row.byLine === true;
    return [ok, `${JSON.stringify({ stacked: r.stacked, after: r.after, meta: r.meta, row })} ${r._err || ''}`.slice(0, 2500)];
  });

  // ---- page ----
  await guard('2.78.1 (g) page: the War Room page draws the Planning Room from the HUD\'s "planning" (rows, lanes, "unscoped", stacked why, the empty state), read-only, full width right after Production (fails on 2.78.0: the page has no Planning Room)', async () => {
    const html = fs.readFileSync(path.join(dir, 'hub', 'v3', 'index.html'), 'utf8');
    const a = html.indexOf('  const planAgo = ');
    const b = html.indexOf('\n  function renderPlanningRoom(s)');
    if (a < 0 || b < 0) return [false, 'no planningHtml in hub/v3/index.html'];
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const hhmm = (ts) => (ts ? new Date(ts).toISOString().slice(11, 16) : '');
    // eslint-disable-next-line no-new-func
    const planHtml = new Function('esc', 'hhmm', `${html.slice(a, b)}\nreturn planningHtml;`)(esc, hhmm);
    const plan = {
      hasPlan: true, live: true, builders: { running: 1, target: 3 },
      now: [{ task: 'T-101', title: 'Stalls restock', lane: 'cartridges/example-sim', startedAt: iso(now - 600000), agent: 'builder-x1' }],
      next: [{ task: 'T-102', rank: 1, title: 'Price board', role: 'builder', lane: 'src/board', wave: 2, model: 'model-small' }, { task: 'T-103', rank: 2, title: 'Tidy grid', role: 'builder', lane: null, unscoped: true }],
      waiting: { stacked: [{ task: 'T-104', title: 'Shared tick', after: [{ task: 'T-101', state: 'running' }], why: 'shared sim code: cartridges/example-sim/sim.js' }], blocked: [{ task: 'T-105', kind: 'park', why: 'parked by prod-1', fix: 'npm run task -- unpark T-105 --by <name>' }] },
      lastPass: { at: iso(now - 60000), mode: 'on', text: 'Line: 1/3 builders', lanesSet: [{ task: 'T-102', lane: 'src/board', from: ['scope'] }], stacked: [], fixed: [], reasons: [], recent: [] },
    };
    const full = planHtml(plan);
    const empty = planHtml({ hasPlan: false, why: "No plan yet: the Line Producer hasn't run", now: [] });
    const css = /\.room\.r-planning \{ grid-column: 1 \/ -1; grid-row: 2;/.test(html) && /@media \(max-width: 599px\)[\s\S]{0,200}\.room\.r-planning/.test(html);
    const placed = /if \(r\.after\) out\.forEach/.test(html) && /data-dyn="plan"/.test(html);
    // The Game plan view's own renderPlan() must stay the only one (a second declaration in the same scope replaces it).
    const one = (html.match(/\bfunction renderPlan\(/g) || []).length === 1 && (html.match(/\bfunction planningHtml\(/g) || []).length === 1;
    const ok = css && placed && one && /Live/.test(full) && /T-101/.test(full) && /lane cartridges\/example-sim/.test(full) && /unscoped/.test(full) && /wave 2/.test(full) && /model-small/.test(full)
      && /after T-101 \(running\)/.test(full) && /shared sim code: cartridges\/example-sim\/sim\.js/.test(full) && /T-105/.test(full) && /1 <small>builders running \/ target|1 \/ 3/.test(full)
      && !/<button/i.test(full + empty) && /No plan yet: the Line Producer hasn&#39;t run|No plan yet: the Line Producer hasn't run/.test(empty);
    return [ok, `css ${css} placed ${placed} one ${one} | ${full.slice(0, 900)} | ${empty.slice(0, 300)}`];
  });
}
