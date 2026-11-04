/**
 * qa/selftest-276k.mjs — 2.76.0 (helper k): the Line Producer (harness/line-producer.mjs, studio/roles/line-producer.md).
 *   blocked    `npm run line -- plan --json` says why each waiting task can't start (chain, park, yes, held, cooldown,
 *              lock) with a fix, and lists the ready ones; `line -- why <T-ID>` explains one task
 *   chain      a task 3+ open tasks wait on (one of them down a chain) is a chain-breaker: first in the order, on the top
 *              tier's model; size 1 routes cheap, size 3 mid, a red round one tier up, a started task keeps its model
 *   fixes      a pass frees a lock whose holder's session is over and clears a cooldown past due, logs both
 *              (.studio/line/actions.jsonl, line.fixed events) and writes .studio/line/status.json in lineStatus's shape
 *   lane       a lane queued for the train whose copy is gone is recreated from its branch (studio/ linked)
 *   rig        the builder target comes from the rig: CPU at STUDIO_LINE_CPU_BUSY_PCT holds new builders, RAM room
 *              caps them under the pace; no scan: the pace
 *   expansion  round(N x share) builders on research/expansion, the least-covered phase first; ONE "Director: next ranked
 *              slice" task when that queue is low, never a second one while it is open
 *   note       a plan that can't run writes one Producer note and one line.plan_blocked event (not again for the same reasons)
 *   supervise  the supervisor follows the plan: the chain-breaker starts first with its routed model; a full rig holds
 *              builders with the Line Producer's reason; STUDIO_LINE_PRODUCER=report/off change nothing
 *   roles      the role is in the planning roles, the Producer's division, the role cards and package.json
 * Each check fails on 2.75.0 (harness/line-producer.mjs and npm run line don't exist there).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest276K({ dir, run, report, tmpRoot, root }) {
  void run; void root;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', STUDIO_MACHINE_SCAN: 'off', STUDIO_TEST_MACHINE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_SLOTS: '0',
    STUDIO_LINE_PRODUCER: '', STUDIO_LINE_EXPANSION_SHARE: '', STUDIO_LINE_EXPANSION_MIN: '', STUDIO_LINE_CHAIN_MIN: '', STUDIO_LINE_BUILDER_GB: '', STUDIO_LINE_CPU_BUSY_PCT: '', STUDIO_LINE_RIG: 'heavy', STUDIO_LINE_PLAN_MAX_SEC: '',
    STUDIO_TIER_CHEAP_MODEL: 'cheap-model-x', STUDIO_TIER_MID_MODEL: 'mid-model-x', STUDIO_TIER_TOP_MODEL: 'top-model-x', STUDIO_AGENT_MODEL: '', STUDIO_BUILDER_MODEL: '', STUDIO_AGENT_TOOL: 'claude', STUDIO_BUILDER_TOOL: '',
    STUDIO_TRAIN_AUTO: 'off', STUDIO_REPORT_WEBHOOK: '', ...ident,
  };
  const made = [];
  let n = 0;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const studio = (name, { tasks = [], holds = {}, events = [], mode = 'extreme' } = {}) => {
    const S = path.join(tmpRoot, `276k-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/line', '.studio/supervisor.json', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-276k.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n\n## BACKLOG\n${tasks.map((t) => `- [ ] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`).join('\n')}\n\n## DONE\n`);
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: holds }, null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'mode.json'), `${JSON.stringify({ mode, history: [] }, null, 2)}\n`);
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']); g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const added = (id, meta = {}) => ({ type: 'task.added', agent: 'producer', task: id, msg: `Queued ${id}`, meta });
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const node = (S, env, args) => spawnSync(process.execPath, args, { cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 120000 });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.slice(-3000);
  const json = (r) => { const t = String(r.stdout || '').trim(); try { return JSON.parse(t); } catch { return null; } };
  // A probe script inside the studio copy (its imports resolve there): prints one JSON line.
  const probe = (S, env, body) => {
    const f = path.join(S, 'qa', `_probe-276k-${++n}.mjs`);
    fs.writeFileSync(f, `${body}\n`);
    const r = node(S, env, [f]);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { r, j: JSON.parse(line) }; } catch { return { r, j: null }; }
  };
  const lp = "import * as lp from '../harness/line-producer.mjs';";

  // A board with every kind of wait, and a chain-breaker.
  const board = {
    tasks: [
      { id: 'T-010', title: 'Rework the shared core the others build on', p: 'P2' },
      { id: 'T-011', title: 'Feature one on the core' },
      { id: 'T-012', title: 'Feature two on the core' },
      { id: 'T-013', title: 'Feature three after feature one' },
      { id: 'T-020', title: 'Parked work' },
      { id: 'T-021', title: 'Proposed work waiting on a yes' },
      { id: 'T-022', title: 'Held work' },
      { id: 'T-023', title: 'Stopped work cooling down' },
      { id: 'T-030', title: 'Small tidy job', p: 'P0' },
      { id: 'T-031', title: 'Normal job', p: 'P1' },
      { id: 'T-032', title: 'Small job that failed once', p: 'P1' },
    ],
    holds: {
      'T-011': { after: ['T-010'] }, 'T-012': { after: ['T-010'] }, 'T-013': { after: ['T-011'] },
      'T-020': { parked: { by: 'producer-1', why: 'not now', at: iso(now) } },
      'T-021': { needsYes: { by: 'builder-a1', at: iso(now) } },
      'T-022': { held: { by: 'producer-1', why: 'landing order', at: iso(now) } },
      'T-023': { cooldownUntil: iso(now + 3600000), cooldownBy: 'someone' },
    },
    events: [
      added('T-010', { size: 2 }), added('T-011'), added('T-012'), added('T-013'), added('T-030', { size: 1 }), added('T-031', { size: 3 }), added('T-032', { size: 1 }),
      { type: 'task.start', agent: 'builder-q1', task: 'T-032', msg: 'start', model: 'cheap-model-x' },
      { type: 'task.paused', agent: 'builder-q1', task: 'T-032', msg: 'handed back: tests still red' },
    ],
  };

  await guard('276k blocked: npm run line -- plan says why each waiting task waits (chain, park, yes, held, cooldown) with a fix, and why <T-ID> explains one', async () => {
    const { S, env } = studio('blocked', board);
    const r = node(S, env, ['harness/line-producer.mjs', 'plan', '--json']);
    const s = json(r);
    if (!s) return [false, out(r)];
    const kind = (id) => s.blocked.find((b) => b.task === id)?.kind;
    const want = { 'T-011': 'chain', 'T-012': 'chain', 'T-013': 'chain', 'T-020': 'park', 'T-021': 'yes', 'T-022': 'held', 'T-023': 'cooldown' };
    const bad = Object.entries(want).filter(([id, k]) => kind(id) !== k);
    const fixes = s.blocked.every((b) => b.fix);
    const ready = ['T-010', 'T-030', 'T-031', 'T-032'].every((id) => s.order.includes(id));
    const w = node(S, env, ['harness/line-producer.mjs', 'why', 'T-021']);
    const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')).scripts?.line;
    return [!bad.length && fixes && ready && /yes T-021/.test(w.stdout) && pkg === 'node harness/line-producer.mjs' && !fs.existsSync(path.join(S, '.studio', 'line', 'status.json')), `${JSON.stringify(bad)} ${JSON.stringify(s.blocked)} order ${s.order} why: ${out(w)} pkg ${pkg}`];
  });

  await guard('276k chain: a task 3 open tasks wait on is first in the order on the top model; size 1 cheap, size 3 mid, a red round one tier up', async () => {
    const { S, env } = studio('chain', board);
    const s = json(node(S, env, ['harness/line-producer.mjs', 'plan', '--json']));
    if (!s) return [false, 'no plan'];
    const cb = s.chainBreakers.find((c) => c.task === 'T-010');
    const ok = cb && cb.n === 3 && cb.waiting.includes('T-013') && s.order[0] === 'T-010' && s.routes['T-010']?.model === 'top-model-x'
      && s.routes['T-030']?.model === 'cheap-model-x' && s.routes['T-031']?.model === 'mid-model-x' && s.routes['T-032']?.model === 'mid-model-x' && s.order.indexOf('T-030') < s.order.indexOf('T-031');
    return [ok, JSON.stringify({ cbs: s.chainBreakers, order: s.order, routes: s.routes })];
  });

  await guard('276k fixes: a pass frees a dead holder\'s lock, clears a cooldown past due, logs both and writes .studio/line/status.json', async () => {
    const { S, ev, env } = studio('fixes', { tasks: [{ id: 'T-040', title: 'Locked by a dead session' }, { id: 'T-041', title: 'Cooldown passed' }], holds: { 'T-041': { cooldownUntil: iso(now - 60000), cooldownBy: 'someone' } }, events: [added('T-040'), added('T-041')] });
    const { j, r } = probe(S, env, `import * as lock from '../harness/lock.mjs'; import fs from 'node:fs';
fs.mkdirSync('.studio/agents', { recursive: true });
fs.writeFileSync('.studio/agents/builder-dead1.json', JSON.stringify({ agent: 'builder-dead1', role: 'builder', status: 'ended', pid: 999999 }));
const c = lock.claim('task:T-040', 'builder-dead1');
${lp}
const s = await lp.lineProducerPass({});
const holds = JSON.parse(fs.readFileSync('studio/task-holds.json', 'utf8')).tasks;
console.log(JSON.stringify({ claimed: c.ok, locked: lock.status('task:T-040').locked, holds, s, file: fs.existsSync('.studio/line/status.json'), actions: fs.readFileSync('.studio/line/actions.jsonl', 'utf8') }));`);
    if (!j) return [false, out(r)];
    const evs = events(ev).filter((e) => e.type === 'line.fixed');
    // The Communicator (helper l) reads { at (ISO), builders: { running, target }, blocked, text } from this file.
    const file = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'line', 'status.json'), 'utf8'));
    const comm = Number.isFinite(Date.parse(file.at)) && Number.isFinite(file.builders?.running) && Number.isFinite(file.builders?.target) && Array.isArray(file.blocked) && /^Line: \d+\/\d+ builders/.test(file.text || '') && !/\n/.test(file.text);
    const shape = comm && ['builders', 'blocked', 'chainBreakers', 'expansion', 'rig', 'actions'].every((k) => k in j.s) && ['running', 'target', 'why'].every((k) => k in j.s.builders) && 'share' in j.s.expansion && 'byPhase' in j.s.expansion;
    return [j.claimed && !j.locked && !j.holds['T-041'] && j.file && shape && /T-040/.test(j.actions) && /cooldown/.test(j.actions) && evs.length >= 2 && j.s.order.includes('T-040'), JSON.stringify({ ...j, s: undefined, order: j.s.order, evs: evs.map((e) => e.msg) })];
  });

  await guard('276k lane: a lane queued for the train whose copy is gone is recreated from its branch, with studio/ linked', async () => {
    const { S, env } = studio('lane', { tasks: [{ id: 'T-050', title: 'Lane work' }], events: [added('T-050')] });
    g(S, ['branch', 'lane/bob-1']);
    const wt = path.join(S, '.lanes', 'bob-1');
    g(S, ['worktree', 'add', '-q', wt, 'lane/bob-1']);
    fs.writeFileSync(path.join(wt, 'lane-work-276k.txt'), 'work\n');
    g(wt, ['add', '-A']); g(wt, ['commit', '-qm', 'lane work', '--no-verify']);
    fs.rmSync(wt, { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'queue.json'), JSON.stringify([{ task: 'T-050', agent: 'bob-1', dir: wt, branch: 'lane/bob-1', head: null, at: iso(now) }]));
    const { j, r } = probe(S, env, `${lp} const s = await lp.lineProducerPass({}); console.log(JSON.stringify({ fixed: s.fixed }));`);
    const back = fs.existsSync(path.join(wt, 'lane-work-276k.txt'));
    let linked = false;
    try { linked = fs.lstatSync(path.join(wt, 'studio')).isSymbolicLink() || fs.realpathSync(path.join(wt, 'studio')) === fs.realpathSync(path.join(S, 'studio')); } catch {}
    return [back && linked && j && j.fixed.some((a) => a.kind === 'lane' && a.task === 'T-050'), `${out(r)} back=${back} linked=${linked}`];
  });

  await guard('276k rig: CPU at STUDIO_LINE_CPU_BUSY_PCT holds new builders, RAM room caps them under the pace, no scan leaves the pace', async () => {
    const t = { tasks: [{ id: 'T-060', title: 'Job a' }, { id: 'T-061', title: 'Job b' }], events: [added('T-060'), added('T-061')] };
    const prof = (busy, totalGb) => JSON.stringify({ at: iso(Date.now()), os: 'linux', cores: { logical: 16 }, cpu: { busy }, ram: { totalGb, freeGb: totalGb - 1 } });
    const { S, env } = studio('rig', t);
    const busy = json(node(S, { ...env, STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: prof(0.95, 64) }, ['harness/line-producer.mjs', 'plan', '--json']));
    const ram = json(node(S, { ...env, STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: prof(0.2, 7) }, ['harness/line-producer.mjs', 'plan', '--json']));
    const none = json(node(S, env, ['harness/line-producer.mjs', 'plan', '--json']));
    const ok = busy?.builders.target === 0 && /CPU 95%/.test(busy.builders.why) && ram?.builders.target === 3 && ram.builders.rigCap === 3 && none?.builders.target === 5 && none.builders.rigCap === null;
    return [ok, JSON.stringify({ busy: busy?.builders, ram: ram?.builders, none: none?.builders })];
  });

  await guard('276k expansion: a research task of the least-covered phase is ranked into the share; ONE Director slice is filed when the queue is low, never a second', async () => {
    const t = {
      tasks: [{ id: 'T-070', title: 'Plain build job', p: 'P0' }, { id: 'T-071', title: 'Research: late game finance systems', p: 'P2' }, { id: 'T-072', title: 'Another build job', p: 'P1' }],
      events: [added('T-070'), added('T-071', { phase: 3 }), added('T-072')],
    };
    const { S, ev, env } = studio('exp', t);
    const { j, r } = probe(S, env, `${lp} const a = await lp.lineProducerPass({}); const b = await lp.lineProducerPass({}); const { parseNextQueue } = await import('../harness/task.mjs'); const q = parseNextQueue(); console.log(JSON.stringify({ a: { order: a.order, exp: a.expansion }, b: { exp: b.expansion }, slices: q.backlog.filter((x) => /^Director: next ranked slice/.test(x.title)).map((x) => ({ id: x.id, role: x.role, title: x.title })) }));`);
    if (!j) return [false, out(r)];
    const asked = events(ev).filter((e) => e.type === 'line.slice_asked');
    const ok = j.a.exp.slots === 1 && j.a.order[0] === 'T-071' && j.a.exp.byPhase['3'].open === 1 && j.slices.length === 1 && j.slices[0].role === 'director' && /phase 1 \(early game\)/.test(j.slices[0].title) && j.b.exp.sliceOpen === j.slices[0].id && asked.length === 1;
    return [ok, JSON.stringify({ ...j, asked: asked.length })];
  });

  await guard('276k note: a plan that can\'t run writes one Producer note and one line.plan_blocked event, not again for the same reasons', async () => {
    const t = { tasks: [{ id: 'T-080', title: 'Waits on a yes' }, { id: 'T-081', title: 'Parked' }], holds: { 'T-080': { needsYes: { by: 'builder-a1', at: iso(now) } }, 'T-081': { parked: { by: 'producer-1', why: 'later' } } }, events: [added('T-080'), added('T-081')] };
    const { S, ev, env } = studio('note', t);
    const { j, r } = probe(S, env, `${lp} import fs from 'node:fs'; const a = await lp.lineProducerPass({}); const b = await lp.lineProducerPass({}); console.log(JSON.stringify({ reasons: a.reasons, note: fs.existsSync('.studio/line/producer-note.md') ? fs.readFileSync('.studio/line/producer-note.md', 'utf8') : null }));`);
    if (!j) return [false, out(r)];
    const blocked = events(ev).filter((e) => e.type === 'line.plan_blocked');
    return [j.note && /can't run because/.test(j.note) && /every open builder task is blocked/.test(j.note) && blocked.length === 1 && blocked[0].to === 'producer', JSON.stringify({ ...j, n: blocked.length })];
  });

  await guard('276k supervise: the chain-breaker starts first on its routed model; a full rig holds builders with the Line Producer\'s reason; report/off change nothing', async () => {
    // The chain-breaker last on the board: only the Line Producer's order puts it first.
    const { S, env } = studio('sup', { ...board, tasks: [...board.tasks.filter((t) => t.id !== 'T-010'), board.tasks[0]] });
    const body = (lineEnv) => `${lp}
const sup = await import('../harness/supervisor.mjs');
await lp.lineProducerPass({ env: { ...process.env, ...${JSON.stringify(lineEnv)} } });
process.env.STUDIO_LINE_PRODUCER = ${JSON.stringify(lineEnv.STUDIO_LINE_PRODUCER || '')};
const starts = [];
const deps = { sessions: () => [], launchableRoles: (r) => r, nextAgentName: (role) => role + '-t' + starts.length, startAgent: (o) => { starts.push(o); return { ok: true }; } };
const r = await sup.supervise({ watcher: true, deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ starts: starts.map((o) => ({ task: o.task, model: o.model || null })), why: r.why }));`;
    const on = probe(S, env, body({}));
    const full = probe(S, { ...env, STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: JSON.stringify({ at: iso(Date.now()), os: 'linux', cores: { logical: 16 }, cpu: { busy: 0.97 }, ram: { totalGb: 64, freeGb: 60 } }) }, body({}));
    const rep = probe(S, env, body({ STUDIO_LINE_PRODUCER: 'report' }));
    const first = on.j?.starts?.[0];
    const ok = first?.task === 'T-010' && first.model === 'top-model-x' && full.j && !full.j.starts.some((s) => /^T-0[1-3]/.test(s.task)) && full.j.why.some((w) => /Line Producer holds new builders/.test(w))
      && rep.j && rep.j.starts[0]?.task !== 'T-010' && !rep.j.starts.some((s) => s.model);
    return [ok, JSON.stringify({ on: on.j || out(on.r), full: full.j || out(full.r), rep: rep.j || out(rep.r) })];
  });

  await guard('276k off: STUDIO_LINE_PRODUCER=off does nothing; report writes status but frees nothing', async () => {
    const { S, env } = studio('off', { tasks: [{ id: 'T-090', title: 'Locked by a dead session' }], events: [added('T-090')] });
    const { j, r } = probe(S, env, `import * as lock from '../harness/lock.mjs'; import fs from 'node:fs';
fs.mkdirSync('.studio/agents', { recursive: true });
fs.writeFileSync('.studio/agents/builder-dead2.json', JSON.stringify({ agent: 'builder-dead2', role: 'builder', status: 'ended', pid: 999999 }));
lock.claim('task:T-090', 'builder-dead2');
${lp}
const off = await lp.lineProducerPass({ env: { ...process.env, STUDIO_LINE_PRODUCER: 'off' } });
const offFile = fs.existsSync('.studio/line/status.json');
const rep = await lp.lineProducerPass({ env: { ...process.env, STUDIO_LINE_PRODUCER: 'report' } });
console.log(JSON.stringify({ off: Boolean(off.off), offFile, repFile: fs.existsSync('.studio/line/status.json'), locked: lock.status('task:T-090').locked, plan: lp.supervisorPlan({ env: { ...process.env, STUDIO_LINE_PRODUCER: 'report' } }), kind: rep.blocked.find((b) => b.task === 'T-090')?.kind }));`);
    return [j && j.off && !j.offFile && j.repFile && j.locked && j.plan === null && j.kind === 'lock', j ? JSON.stringify(j) : out(r)];
  });

  await guard('276k roles: the Line Producer is a planning role, sits in the Producer\'s division, and has a role card', async () => {
    const { S, env } = studio('roles');
    const { j, r } = probe(S, env, `import { PLANNING_ROLES } from '../harness/planning-roles.mjs'; import { DEFAULT_DIVISIONS } from '../harness/divisions.mjs'; import fs from 'node:fs';
console.log(JSON.stringify({ plan: PLANNING_ROLES.has('line-producer'), div: DEFAULT_DIVISIONS.find((d) => d.id === 'production').roles.includes('line-producer'), card: fs.existsSync('studio/roles/line-producer.md') && /Director[\\s\\S]*Producer[\\s\\S]*Line Producer/.test(fs.readFileSync('studio/roles/line-producer.md', 'utf8')), readme: /line-producer\\.md/.test(fs.readFileSync('studio/roles/README.md', 'utf8')) }));`);
    return [j && j.plan && j.div && j.card && j.readme, j ? JSON.stringify(j) : out(r)];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {} }
  void fileURLToPath;
}
