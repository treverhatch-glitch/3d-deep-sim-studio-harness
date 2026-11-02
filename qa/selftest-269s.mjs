/**
 * qa/selftest-269s.mjs — 2.69.0 (helper s): overlap checks when work starts, a queue-depth target, the upgrade watch.
 *   overlap   `task add` and `task start` name the lanes in flight that already change the task's files (file and
 *             lines), open tasks working in the same folder, and near-duplicate titles; at start, the task's own lane
 *             diff line by line; each is one task.overlap event; advisory, except STUDIO_OVERLAP=block refuses.
 *   depth     fewer startable builder tasks than STUDIO_QUEUE_DEPTH (default: the session cap) asks the Producer once
 *             (queue.depth event and an inbox line naming the areas chains and holds block); no task is added.
 *   upgrade   `npm run upgrade -- watch` fetches the harness remote (a fake origin here), compares versions, reads CI (a
 *             fake status here), and upgrades only with the switch on, CI green, inside STUDIO_UPGRADE_WINDOW and with
 *             no session running; then refreshes the lanes and files one task per conflicted lane; the switch records
 *             who and refuses workers; the supervisor runs the check.
 * Made-up studios in temp folders; no network (the fake origin is a local bare repo, CI is passed in).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest269S({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
  const g = (cwd, args, extra = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(extra) });
  const head = (cwd, ref = 'HEAD') => g(cwd, ['rev-parse', ref]).stdout.trim();
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const lastJson = (r) => { try { return JSON.parse(String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return null; } };
  const u = (base, rel) => JSON.stringify(pathToFileURL(path.join(base, rel)).href);
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_TASK_BASE: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_EXPERIMENT: '', STUDIO_AGENT_MODEL: '', STUDIO_HARNESS_REF: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-269s-${process.pid}.pem`), STUDIO_MAIN_COMMIT: '',
    STUDIO_UPGRADE_REFRESH: '', STUDIO_REACHABILITY: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_GATE_RELATED: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_AGENT: '', STUDIO_LANE_INFER: 'off',
    STUDIO_OVERLAP: '', STUDIO_QUEUE_DEPTH: '', STUDIO_QUEUE_DEPTH_ASK_MIN: '', STUDIO_UPGRADE_WINDOW: '', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_UPGRADE_FETCH_MS: '',
    STUDIO_QUOTA_PROBE: 'off', STUDIO_CREW_WATCH: 'off', STUDIO_FUTILITY: '', STUDIO_USAGE_WINDDOWN_PCT: '', STUDIO_DAILY_TOKEN_CAP: 'off', STUDIO_AGENT_TOOL: 'claude', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_LAUNCH_LOCK_SEC: '1',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', AGENT_EVENTS_MIRROR: '', ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  const copy = (name) => {
    const d = path.join(tmpRoot, `269s-${name}-${process.pid}`);
    fs.cpSync(dir, d, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(d, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/train', '.studio/locks']) fs.rmSync(path.join(d, x), { recursive: true, force: true });
    for (const x of ['studio/task-holds.json', 'studio/upgrade.json', '.studio/upgrade-watch.json', '.studio/queue-depth.json']) fs.rmSync(path.join(d, x), { force: true });
    return d;
  };
  const events = (S, file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  let pn = 0;
  const probe = (S, code, env) => {
    const f = path.join(S, `.probe-269s-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node ${path.basename(f)}`, env);
    fs.rmSync(f, { force: true });
    const j = lastJson(r);
    return j ? { ...j, _out: out(r).slice(-2500) } : { _out: out(r).slice(-2500) };
  };
  const studio = (S, ev, extra = {}) => {
    const env = { ...base, STUDIO_GAME: 'demo', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', AGENT_EVENTS_FILE: ev, ...extra };
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    write(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs', paths: ['game/demo/**'] }] }, null, 2)}\n`);
    write(S, 'game/demo/check.mjs', "console.log('demo ok');\n");
    write(S, 'game/demo/main.txt', 'alpha\nbeta\n');
    write(S, 'game/demo/src/sim.ts', 'export const a = 1;\nexport const b = 2;\nexport const fee = 3;\nexport const tax = 4;\nexport const c = 5;\nexport const d = 6;\n');
    write(S, 'game/demo/src/other.ts', 'export const other = 1;\n');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    g(S, ['config', 'core.hooksPath', 'scripts/hooks']);
    return env;
  };
  const addTask = (S, env, args) => { const r = run(S, `node harness/task.mjs add ${args}`, env); return { r, id: (out(r).match(/"id": "(T-\d+)"/) || [])[1] }; };
  const laneProbeFile = path.join(tmpRoot, `lane-269s-${process.pid}.mjs`);
  const mkLane = (S, env, agent, id, rel, text) => {
    fs.writeFileSync(laneProbeFile, `import { createLaneCopy } from ${u(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    run(S, `node "${laneProbeFile}" ${agent} ${id}`, env);
    const ld = path.join(S, '.lanes', agent);
    write(ld, rel, text);
    g(ld, ['add', rel]);
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${rel}`], { cwd: ld, encoding: 'utf8', env: gEnv({ ...env, STUDIO_MAIN_ROOT: S }) });
    return { agent, id, dir: ld, ok: c.status === 0, log: out(c), head: head(ld) };
  };
  const board = (S) => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');

  // ================= overlap at add and start =================
  {
    const S = copy('overlap');
    const ev = path.join(S, '.studio', 'events-269s.jsonl');
    const env = studio(S, ev);
    const A = addTask(S, env, '"Tune the fee curve" --role builder --priority P1 --paths game/demo/src/sim.ts').id;
    const C = addTask(S, env, '"Add the docking tutorial" --role builder --priority P1 --paths game/demo/src/other.ts').id;
    const P = addTask(S, env, '"Fix fee panel overflow" --role builder --priority P1 --paths game/demo/ui/panel.ts').id;
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const LA = mkLane(S, env, 'bld-a', A, 'game/demo/src/sim.ts', 'export const a = 1;\nexport const b = 2;\nexport const fee = 30;\nexport const tax = 40;\nexport const c = 5;\nexport const d = 6;\n');
    const LC = mkLane(S, env, 'bld-c', C, 'game/demo/src/sim.ts', 'export const a = 1;\nexport const b = 2;\nexport const fee = 3;\nexport const tax = 44;\nexport const c = 5;\nexport const d = 6;\n');

    await guard('2.69.0 (s) overlap: task add for a task declaring game/demo/src/sim.ts prints "<T-A> already changes game/demo/src/sim.ts:3-4; consider stacking (--after <T-A>) or splitting the scope" (the lane in flight, its lines), queues the task anyway (advisory) and records one task.overlap event with the file and lines (fails on 2.68.0: nothing said)', () => {
      const r = addTask(S, env, '"Rebalance shop prices" --role builder --priority P1 --paths game/demo/src/sim.ts');
      const o = out(r.r);
      const e = events(S, ev).filter((x) => x.type === 'task.overlap').pop();
      const ok = LA.ok && LC.ok && r.r.status === 0 && Boolean(r.id) && new RegExp(`${A} already changes game/demo/src/sim\\.ts:3-4; consider stacking \\(--after ${A}\\) or splitting the scope`).test(o)
        && new RegExp(`${C} already changes game/demo/src/sim\\.ts:4`).test(o) && board(S).includes('Rebalance shop prices')
        && e?.meta?.phase === 'add' && e.meta.block === false && e.meta.items.some((i) => i.with === A && i.file === 'game/demo/src/sim.ts' && i.lines === '3-4');
      return [ok, `${LA.log}${LC.log}\n${o.slice(-1500)}\n${JSON.stringify(e)}`];
    });

    await guard('2.69.0 (s) overlap: a near-duplicate title ("Fix the fee panel overflow on resize" while "Fix fee panel overflow" is open: 80% of the words) is named with the advice to stack or split; an unrelated title is not (fails on 2.68.0)', () => {
      const r = addTask(S, env, '"Fix the fee panel overflow on resize" --role builder --priority P1');
      const q = addTask(S, env, '"Draw the lighthouse at night" --role builder --priority P1');
      const ok = r.r.status === 0 && new RegExp(`${P} "Fix fee panel overflow" \\(waiting\\) looks like the same work \\(80% of the title's words\\); consider stacking \\(--after ${P}\\)`).test(out(r.r))
        && q.r.status === 0 && !/\[overlap\]/.test(out(q.r));
      return [ok, `${out(r.r).slice(-1200)}\n---\n${out(q.r).slice(-600)}`];
    });

    await guard('2.69.0 (s) overlap: task start of a task whose own lane already changes a line another lane changes says so line by line ("<T-A> already changes game/demo/src/sim.ts:3, and so does this task\'s lane"), with the block-until advice, and still starts (fails on 2.68.0)', () => {
      const r = run(S, `node harness/task.mjs start ${C} --agent bld-q`, env);
      const ok = r.status === 0 && new RegExp(`\\[overlap\\] ${A} already changes game/demo/src/sim\\.ts:3, and so does this task's lane; consider stacking \\(--after ${A}: npm run task -- block ${C} --until ${A} --by <you>\\)`).test(out(r))
        && events(S, ev).some((x) => x.type === 'task.overlap' && x.task === C && x.meta?.phase === 'start');
      return [ok, out(r).slice(-1500)];
    });

    await guard('2.69.0 (s) overlap: STUDIO_OVERLAP=block refuses: task add exits 1 ("Not queued", "STUDIO_OVERLAP=block") and the task is not on the board; task start of an overlapping task exits 1 unclaimed; STUDIO_OVERLAP=off says nothing (fails on 2.68.0: the add is queued)', () => {
      const blockEnv = { ...env, STUDIO_OVERLAP: 'block' };
      const a = addTask(S, blockEnv, '"Raise the harbour fee" --role builder --priority P1 --paths game/demo/src/sim.ts');
      const s = run(S, `node harness/task.mjs start ${P} --agent bld-r`, blockEnv);
      const offR = addTask(S, { ...env, STUDIO_OVERLAP: 'off' }, '"Lower the harbour tax" --role builder --priority P1 --paths game/demo/src/sim.ts');
      const nb = board(S);
      const ok = a.r.status === 1 && /Not queued/.test(out(a.r)) && /STUDIO_OVERLAP=block: not queued/.test(out(a.r)) && !nb.includes('Raise the harbour fee')
        && s.status === 1 && /STUDIO_OVERLAP=block: not started/.test(out(s)) && !fs.readdirSync(path.join(S, '.studio', 'locks')).some((f) => f.includes(P))
        && offR.r.status === 0 && !/\[overlap\]/.test(out(offR.r)) && nb.includes('Lower the harbour tax');
      return [ok, `${out(a.r).slice(-800)}\n---\n${out(s).slice(-800)}\n---\n${out(offR.r).slice(-400)}`];
    });
    try { fs.rmSync(S, { recursive: true, force: true }); } catch {}
  }

  // ================= queue-depth target =================
  {
    const S = copy('depth');
    const ev = path.join(S, '.studio', 'events-269s.jsonl');
    // Only this test's builder tasks on the board.
    write(S, 'studio/NEXT.md', board(S).split('\n').filter((l) => !/\(`builder`\)/.test(l)).join('\n'));
    const env = studio(S, ev);
    const R1 = addTask(S, env, '"Make the crate stack" --role builder --priority P1 --paths game/demo/src/crates.ts').id;
    const B1 = addTask(S, env, '"Wire the fee display" --role builder --priority P1 --paths game/demo/src/sim.ts').id;
    const B2 = addTask(S, env, `"Fee display polish" --role builder --priority P1 --paths game/demo/src/sim.ts --after ${B1}`).id;
    const H1 = addTask(S, env, '"Harbour lights" --role builder --priority P1 --paths game/demo/src/lights.ts').id;
    run(S, `node harness/task.mjs park ${H1} --by pat --why "waits for the art pass"`, env);
    // B1 is in progress elsewhere: claimed by another agent.
    run(S, `node harness/task.mjs start ${B1} --agent bld-b`, env);
    const pass = (extra = {}) => probe(S, `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const started = [];
const deps = { sessions: () => [{ agent: 'bld-b', role: 'builder', task: ${JSON.stringify(B1)}, running: true }], startAgent: (o) => { started.push(o.role + ':' + o.task); return { ok: true }; }, launchableRoles: (r) => r.filter((x) => x === 'builder'), nextAgentName: (role) => role + '-z' + Math.random().toString(36).slice(2, 6), pauseAgent: () => ({ ok: true }) };
const r = await supervise({ deps, dryRun: false }, { startedAt: Date.now() - 1000, names: [] });
console.log(JSON.stringify({ started, why: r.why || [] }));`, { ...env, ...extra });

    await guard('2.69.0 (s) depth: with STUDIO_QUEUE_DEPTH=3 and one startable builder task, a supervisor pass emits one queue.depth event to the Producer naming the blocked areas (game/demo/src/sim.ts: the --after chain; game/demo/src/lights.ts: parked) and writes the inbox line; it adds no task; a second pass doesn\'t ask again (fails on 2.68.0: no queue.depth)', () => {
      const before = board(S);
      const p1 = pass({ STUDIO_QUEUE_DEPTH: '3' });
      const p2 = pass({ STUDIO_QUEUE_DEPTH: '3' });
      const asks = events(S, ev).filter((x) => x.type === 'queue.depth');
      const inbox = (() => { try { return fs.readFileSync(path.join(S, 'studio', 'producer', 'INBOX.md'), 'utf8'); } catch { return ''; } })();
      const after = board(S);
      const m = asks[0]?.msg || '';
      const ok = asks.length === 1 && asks[0].to === 'producer' && /1 builder task\(s\) ready to start, target 3/.test(m)
        && new RegExp(`game/demo/src/sim\\.ts \\(${B2} waits for ${B1}`).test(m) && new RegExp(`game/demo/src/lights\\.ts \\(${H1} parked by pat`).test(m)
        && /The harness adds no task itself/.test(m) && asks[0].meta?.readyTasks?.includes(R1) && /Queue below target/.test(inbox)
        && before.split('\n').filter((l) => /T-\d+/.test(l)).length === after.split('\n').filter((l) => /T-\d+/.test(l)).length
        && (p1.why || []).some((w) => /queue below its depth target \(1 ready, target 3\)/.test(w)) && !(p2.why || []).some((w) => /queue below/.test(w));
      return [ok, `${JSON.stringify(asks)}\n${JSON.stringify(p1).slice(0, 1200)}\n${JSON.stringify(p2).slice(0, 600)}`];
    });

    await guard('2.69.0 (s) depth: the default target is the session cap given (cap 1 with one ready task: no ask; cap 4: an ask, short 3); STUDIO_QUEUE_DEPTH=off: never (fails on 2.68.0: no harness/queue-depth.mjs)', () => {
      const p = probe(S, `import { queueDepthPass } from ${u(S, 'harness/queue-depth.mjs')};
import { parseNextQueue } from ${u(S, 'harness/task.mjs')};
import fs from 'node:fs';
fs.rmSync('.studio/queue-depth.json', { force: true });
const q = parseNextQueue();
const locked = (id) => id === ${JSON.stringify(B1)};
const a = await queueDepthPass({ q, cap: 1, deps: { locked } });
const b = await queueDepthPass({ q, cap: 4, deps: { locked } });
const c = await queueDepthPass({ q, cap: 4, env: { ...process.env, STUDIO_QUEUE_DEPTH: 'off' }, deps: { locked } });
console.log(JSON.stringify({ a: [a.target, a.asked, a.ready.length], b: [b.target, b.asked, b.short], c: [c.target, c.asked] }));`, env);
      const ok = JSON.stringify(p.a) === '[1,false,1]' && JSON.stringify(p.b) === '[4,true,3]' && JSON.stringify(p.c) === '[null,false]';
      return [ok, JSON.stringify(p).slice(0, 1500)];
    });
    try { fs.rmSync(S, { recursive: true, force: true }); } catch {}
  }

  // ================= upgrade watch =================
  {
    const S = copy('upgrade');
    const ev = path.join(S, '.studio', 'events-269s.jsonl');
    const env = studio(S, ev);
    const person = { ...env };
    const ids = { x: addTask(S, env, '"Lane x note" --role builder --priority P1').id, y: addTask(S, env, '"Lane y main line" --role builder --priority P1').id, z: addTask(S, env, '"Lane z busy" --role builder --priority P1').id };
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const X = mkLane(S, env, 'bld-x', ids.x, 'game/demo/x.txt', 'x\n');
    const Y = mkLane(S, env, 'bld-y', ids.y, 'game/demo/main.txt', 'alpha\nBETA-Y\n');
    const Z = mkLane(S, env, 'bld-z', ids.z, 'game/demo/z.txt', 'z\n');
    // The fake origin: a bare repo with a newer harness version and a change on lane y's line.
    const origin = path.join(tmpRoot, `origin-269s-${process.pid}.git`);
    const work = path.join(tmpRoot, `origin-work-269s-${process.pid}`);
    g(tmpRoot, ['clone', '-q', '--bare', S, origin]);
    g(tmpRoot, ['clone', '-q', origin, work]);
    const pj = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8'));
    pj.version = '9.9.0';
    write(work, 'package.json', `${JSON.stringify(pj, null, 2)}\n`);
    write(work, 'scripts/zz-269s.txt', 'update\n');
    write(work, 'game/demo/main.txt', 'alpha\nBETA-UPDATE\n');
    g(work, ['add', '-A']); g(work, ['commit', '-qm', 'harness 9.9.0', '--no-verify']); g(work, ['push', '-q', 'origin', 'HEAD:main']);
    g(S, ['remote', 'add', 'upstream', origin]);
    const originSha = head(work);
    write(S, '.studio/agents/bld-z.json', JSON.stringify({ agent: 'bld-z', role: 'builder', task: Z.id, status: 'running', pid: process.pid, startedAt: new Date().toISOString() }));
    const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const now = Date.now();
    const inWin = `${hhmm(now - 5 * 60000)}-${hhmm(now + 60 * 60000)}`;
    const outWin = `${hhmm(now + 120 * 60000)}-${hhmm(now + 180 * 60000)}`;
    const watch = (ci, extra = {}) => probe(S, `import { upgradeWatch } from ${u(S, 'harness/upgrade-watch.mjs')};
const r = await upgradeWatch({ root: process.cwd(), deps: { ci: async () => (${JSON.stringify(ci)}) } });
console.log(JSON.stringify({ status: r.status, lines: r.lines, filed: r.filed || [], theirs: r.theirs, ours: r.ours }));`, { ...person, ...extra });
    const mainBefore = head(S, 'main');

    await guard('2.69.0 (s) upgrade: the supervisor runs the watch (STUDIO_UPGRADE_WATCH_MIN=1): it fetches the fake origin\'s main, sees harness 9.9.0, reads no CI it can trust (not a GitHub remote) and, with auto-upgrade off, only reports (an upgrade.watch event "available"; main unchanged); `npm run upgrade -- watch --json` says the same (fails on 2.68.0: no watch)', () => {
      const p = probe(S, `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const deps = { sessions: () => [], startAgent: () => ({ ok: true }), launchableRoles: () => [], nextAgentName: (r) => r + '-w', pauseAgent: () => ({ ok: true }) };
const r = await supervise({ deps }, { startedAt: Date.now() - 1000, names: [] });
console.log(JSON.stringify({ why: r.why || [] }));`, { ...person, STUDIO_UPGRADE_WATCH_MIN: '1', STUDIO_QUEUE_DEPTH: 'off' });
      const e = events(S, ev).filter((x) => x.type === 'upgrade.watch').pop();
      const cli = run(S, 'node harness/upgrade-guard.mjs watch --json', person);
      const j = lastJson(cli);
      const ok = X.ok && Y.ok && Z.ok && (p.why || []).some((w) => /^upgrade watch: harness 9\.9\.0 on upstream\/main/.test(w))
        && e?.meta?.status === 'available' && e.meta.to === '9.9.0' && e.meta.sha === originSha && e.meta.ci === 'unknown' && /Report only: .*auto-upgrade is off/.test(e.msg)
        && j?.status === 'available' && j.ci?.state === 'unknown' && /not on GitHub/.test(j.ci.why) && head(S, 'main') === mainBefore;
      return [ok, `${JSON.stringify(p).slice(0, 1500)}\n${JSON.stringify(e)}\n${out(cli).slice(-1200)}`];
    });

    await guard('2.69.0 (s) upgrade: the switch records who: `watch auto on --by builder-3` and a launched builder session are refused; a coding agent without the person\'s words is refused; `--by pat` in a person\'s terminal is committed to studio/upgrade.json { auto: true, by: "pat" } with an upgrade.auto event; the owner\'s delegation for upgrade-auto lets opus-bot switch it, recorded as by pat, set by opus-bot (fails on 2.68.0)', () => {
      const w1 = run(S, 'node harness/upgrade-guard.mjs watch auto on --by builder-3', person);
      const w2 = run(S, 'node harness/upgrade-guard.mjs watch auto on --by pat', { ...person, STUDIO_ROLE: 'builder' });
      const w3 = run(S, 'node harness/upgrade-guard.mjs watch auto on --by pat', { ...person, CLAUDECODE: '1' });
      const okR = run(S, 'node harness/upgrade-guard.mjs watch auto on --by pat', person);
      const committed = (() => { try { return JSON.parse(g(S, ['show', 'HEAD:studio/upgrade.json']).stdout); } catch { return null; } })();
      const e = events(S, ev).filter((x) => x.type === 'upgrade.auto').pop();
      // The owner's delegation can cover the switch for one outside agent (recorded for the owner).
      const gr = run(S, 'node harness/delegation.mjs grant opus-bot --actions upgrade-auto --hours 2 --by pat --why "auto-upgrade switch"', person);
      const dl = run(S, 'node harness/upgrade-guard.mjs watch auto on --by opus-bot', { ...person, CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'opus-bot' });
      const viaDel = (() => { try { return JSON.parse(g(S, ['show', 'HEAD:studio/upgrade.json']).stdout); } catch { return null; } })();
      const delOk = gr.status === 0 && dl.status === 0 && viaDel?.by === 'pat' && viaDel.setBy === 'opus-bot' && viaDel.via === 'delegation';
      const ok = delOk && w1.status === 1 && /Not changed/.test(out(w1)) && w2.status === 1 && /launched builder session/.test(out(w2)) && w3.status === 1 && /permission/.test(out(w3))
        && okR.status === 0 && /Auto-upgrade on for pat/.test(out(okR)) && committed?.auto === true && committed.by === 'pat' && committed.via === 'person' && e?.meta?.by === 'pat';
      return [ok, `${out(w1).slice(-300)}\n${out(w2).slice(-300)}\n${out(w3).slice(-300)}\n${out(okR).slice(-400)}\n${JSON.stringify(committed)}\n${out(gr).slice(-400)}\n${out(dl).slice(-400)}\n${JSON.stringify(viaDel)}`];
    });

    await guard('2.69.0 (s) upgrade: with the switch on it still never upgrades on red or unknown CI ("refused"), with no window (report only), outside the window ("waiting"), or with an agent session running inside it ("waiting: … lanes are mid-session"); main never moves (fails on 2.68.0)', () => {
      const mainNow = head(S, 'main');
      const red = watch({ state: 'red', why: 'failed: test (failure)' }, { STUDIO_UPGRADE_WINDOW: inWin });
      const unk = watch({ state: 'unknown', why: 'the GitHub API wasn\'t reachable' }, { STUDIO_UPGRADE_WINDOW: inWin });
      const noWin = watch({ state: 'green', why: '3 check run(s) passed' });
      const outside = watch({ state: 'green', why: '3 check run(s) passed' }, { STUDIO_UPGRADE_WINDOW: outWin });
      const busy = watch({ state: 'green', why: '3 check run(s) passed' }, { STUDIO_UPGRADE_WINDOW: inWin });
      const ok = red.status === 'refused' && /CI must be green/.test(red.lines.join('\n')) && unk.status === 'refused'
        && noWin.status === 'available' && /STUDIO_UPGRADE_WINDOW is unset/.test(noWin.lines.join('\n'))
        && outside.status === 'waiting' && new RegExp(`Waiting for the upgrade window ${outWin}`).test(outside.lines.join('\n'))
        && busy.status === 'waiting' && /bld-z on .*lanes are mid-session/.test(busy.lines.join('\n')) && head(S, 'main') === mainNow;
      return [ok, [red, unk, noWin, outside, busy].map((x) => `${x.status}: ${(x.lines || []).join(' / ')}${x._out && !x.status ? x._out : ''}`).join('\n').slice(0, 3000)];
    });

    await guard('2.69.0 (s) upgrade: switch on, CI green, inside the window, nothing running: it merges the fake origin (upgrade.merged for pat, 9.9.0), refreshes the lanes (x refreshed, y conflicted) and files one builder task for lane y; an upgrade.watch "merged" event; the next check says nothing newer (fails on 2.68.0)', () => {
      fs.rmSync(path.join(S, '.studio/agents/bld-z.json'), { force: true });
      const r = watch({ state: 'green', why: '3 check run(s) passed' }, { STUDIO_UPGRADE_WINDOW: inWin });
      const merged = events(S, ev).filter((x) => x.type === 'upgrade.merged').pop();
      const we = events(S, ev).filter((x) => x.type === 'upgrade.watch').pop();
      const nb = board(S);
      const again = watch({ state: 'green', why: 'x' }, { STUDIO_UPGRADE_WINDOW: inWin });
      const ok = r.status === 'merged' && g(S, ['merge-base', '--is-ancestor', originSha, 'main']).status === 0 && merged?.meta?.to === '9.9.0' && merged.meta.by === 'pat'
        && /permission/.test(JSON.stringify(merged.meta)) && r.filed.length === 1 && new RegExp(`${r.filed[0]}.*Resolve the harness 9\\.9\\.0 upgrade conflict in lane ${ids.y}`).test(nb)
        && !new RegExp(`conflict in lane ${ids.x}`).test(nb) && we?.meta?.status === 'merged' && /Restart the supervisor/.test(we.msg)
        && g(X.dir, ['merge-base', '--is-ancestor', originSha, 'HEAD']).status === 0 && head(Y.dir) === Y.head && again.status === 'current';
      return [ok, `${(r.lines || []).join('\n').slice(-2500)}${r._out || ''}\n${JSON.stringify(merged?.meta)}\n${again.status} ${(again.lines || []).join(' ')}`];
    });
    await guard('2.69.0 (s) upgrade: CI from the GitHub API (a fake fetch here): all check runs and statuses passed = green, one failed = red, one still running = pending, none = unknown, an error answer = unknown; a remote not on GitHub is never asked (fails on 2.68.0)', () => {
      const p = probe(S, `import { ciStatus } from ${u(S, 'harness/upgrade-watch.mjs')};
const asked = [];
const fake = (status, checks, code = 200) => async (url) => { asked.push(url); return { ok: code === 200, status: code, json: async () => (url.includes('/check-runs') ? checks : status) }; };
const url = 'git@github.com:acme/harness.git';
const sha = 'a'.repeat(40);
const r = {
  green: await ciStatus({ url, sha, fetchImpl: fake({ statuses: [{ context: 'ci/x', state: 'success' }] }, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] }) }),
  red: await ciStatus({ url, sha, fetchImpl: fake({ statuses: [] }, { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }] }) }),
  pending: await ciStatus({ url, sha, fetchImpl: fake({ statuses: [] }, { check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] }) }),
  none: await ciStatus({ url, sha, fetchImpl: fake({ statuses: [] }, { check_runs: [] }) }),
  err: await ciStatus({ url, sha, fetchImpl: fake({}, {}, 403) }),
};
const n = asked.length;
const local = await ciStatus({ url: '/tmp/x.git', sha, fetchImpl: fake({}, {}) });
console.log(JSON.stringify({ states: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.state])), apiUrl: asked[0], askedAfterLocal: asked.length === n, local: local.state }));`, person);
      const ok = JSON.stringify(p.states) === JSON.stringify({ green: 'green', red: 'red', pending: 'pending', none: 'unknown', err: 'unknown' })
        && /^https:\/\/api\.github\.com\/repos\/acme\/harness\/commits\/a{40}\//.test(p.apiUrl || '') && p.askedAfterLocal === true && p.local === 'unknown';
      return [ok, JSON.stringify(p).slice(0, 1500)];
    });
    try { fs.rmSync(S, { recursive: true, force: true }); fs.rmSync(origin, { recursive: true, force: true }); fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(laneProbeFile, { force: true }); } catch {}
}
