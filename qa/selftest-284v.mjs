/**
 * qa/selftest-284v.mjs — 2.84 (v): five small fixes a studio's overseer reported after a day on 2.83.
 *
 *   1  the supervisor's "refused Nx for the same reason" line (and its event, and `task show`) says the reason
 *   2  the crew breaker: a lane queued for a train, a hand-back "ready for the train" and sessions started by hand are
 *      not "0 landed" / not the crew's sessions
 *   3  a planning session on a top-tier (slow-thinking) model may go 20 minutes without a write, not 8; the stall event says why
 *   4  `task start <ID> --dry-run` changes nothing; the board commands work from a lane copy made by hand
 *   5  `npm run studio:reload-env` names the settings the harness no longer reads, with the closest current name
 *
 * Each check imports a module from a copy of the repo, or runs the command in one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest284V({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_DRIFT: 'off', STUDIO_WORKTREES: 'off', STUDIO_LANELESS: 'shared', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-284v-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const nm = path.join(harnessRoot, 'node_modules');
  const studio = (name, { git = true } = {}) => {
    const S = path.join(tmpRoot, `284v-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-284v.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify'); }
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-284v-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
  const M = 60000;

  // ================= 1. the supervisor says why a task is skipped =================
  {
    const { S, env } = studio('why');
    const LONG = `Not started: T-9 can't start yet: parked by producer: ${'the art pipeline needs the sprite sheet first, '.repeat(8)}end`;
    const r = probe(S, env, `import * as sup from ${u(S, 'harness/supervisor.mjs')};
const t0 = 1_800_000_000_000; const state = { startedAt: t0 - 1000 };
const e1 = sup.noteStartRefusal(state, 'T-9', 'start_agent ' + ${JSON.stringify(LONG)}, 'sig', t0, process.env, ${JSON.stringify(LONG)});
const e2 = sup.noteStartRefusal(state, 'T-9', 'start_agent ' + ${JSON.stringify(LONG)}, 'sig', t0, process.env, ${JSON.stringify(LONG)});
const words = typeof sup.backoffWords === 'function' ? sup.backoffWords('T-9', e2, t0) : null;
const st2 = { startedAt: t0 - 1000 };
sup.ingestRefusals(st2, [{ type: 'task.start_refused', task: 'T-4', ts: new Date(t0 - 500).toISOString(), msg: 'overlap (STUDIO_OVERLAP=block): T-2' }], () => 's', t0);
console.log(JSON.stringify({ text: e2.text || null, count: e2.count, words, ingested: st2.startBackoff?.['T-4']?.text || null }));
`);
    await guard('2.84 (v1): the supervisor\'s skipped-task line says why: "T-x (refused 2x for the same reason: \\"<first 160 characters of the refusal>\\"; skipped for N min)", for a refusal of its own start and for one folded in from the log (fails before this fix: the line had no reason and the entry kept none)', () => [
      r.count === 2 && r.text === LONG.replace(/\s+/g, ' ').slice(0, 160) && typeof r.words === 'string' && r.words.includes(`"${r.text}"`) && /^T-9 \(refused 2x for the same reason: ".*"; skipped for \d+ min\)$/.test(r.words)
        && /overlap \(STUDIO_OVERLAP=block\): T-2/.test(r.ingested || ''),
      JSON.stringify(r)]);

    // `task show` is what a person looks at for "why isn't this starting".
    fs.writeFileSync(path.join(S, '.studio', 'start-backoff.json'), `${JSON.stringify({ seen: 1, tasks: { 'T-003': { reason: 'start_agent #', text: 'Not started: 3 agents already running; the mode allows 3', sig: 's', count: 4, until: Date.now() + 10 * M, said: true } } })}\n`);
    const sh = node(S, ['harness/task.mjs', 'show', 'T-003'], env);
    let j = null; try { j = JSON.parse(sh.stdout); } catch { j = null; }
    await guard('2.84 (v1): `task show <ID>` names why the supervisor skips the task (startBackoff: the refusal, how many times, minutes left) and says nothing once the wait is over (fails before this fix: no such field)', () => {
      fs.writeFileSync(path.join(S, '.studio', 'start-backoff.json'), `${JSON.stringify({ seen: 1, tasks: { 'T-003': { reason: 'x', text: 'old', sig: 's', count: 2, until: Date.now() - M, said: true } } })}\n`);
      const sh2 = node(S, ['harness/task.mjs', 'show', 'T-003'], env);
      let j2 = null; try { j2 = JSON.parse(sh2.stdout); } catch { j2 = null; }
      return [j && /3 agents already running/.test(j.startBackoff?.why || '') && j.startBackoff.refused === 4 && j.startBackoff.minutesLeft >= 9 && j2 && !('startBackoff' in j2), `${out(sh).slice(-600)} | ${out(sh2).slice(-300)}`];
    });
  }

  // ================= 2. the crew breaker =================
  {
    const { S, env } = studio('crew', { git: false });
    const r = probe(S, env, `import { crewHealth } from ${u(S, 'harness/crew-watch.mjs')};
const now = Date.now(); const M = 60000; const iso = (t) => new Date(t).toISOString();
let id = 0;
// k sessions of role builder, each on its own task with commits but no done: (agent, task) pairs.
const sessions = (prefix, k, { hand = false, at = 50 } = {}) => {
  const ev = [];
  for (let i = 1; i <= k; i++) {
    const agent = prefix + i; const task = 'T-' + prefix.toUpperCase().replace(/[^A-Z]/g, '') + i;
    ev.push({ id: 'e' + (++id), ts: iso(now - (at - i) * M), type: 'agent.session.start', agent, task, meta: { role: 'builder', ...(hand ? { byHand: true } : {}) } });
    ev.push({ id: 'e' + (++id), ts: iso(now - (at - i - 0.5) * M), type: 'agent.session.end', agent, task, meta: { role: 'builder', outcome: { task, claimed: true, commits: 2, done: false, noWork: false, stuck: false, counts: true } } });
  }
  return ev;
};
const h = (events) => crewHealth(events, { now, env: {} }).builder || {};
const out = {};
const nothing = sessions('b', 8);
out.control = { unhealthy: h(nothing).unhealthy, sessions: h(nothing).sessions };
// (a) one of them checked its lane and queued it for the game's merge train (the queue entry was gone by the session's end)
out.queued = h([...nothing, { id: 'q1', ts: iso(now - 45 * M), type: 'task.train.queued', agent: 'b3', task: 'T-B3', meta: {} }]).unhealthy;
out.doneQueued = h([...nothing, { id: 'q2', ts: iso(now - 45 * M), type: 'task.done.queued', agent: 'b4', task: 'T-B4', meta: {} }]).unhealthy;
out.queuedOtherTask = h([...nothing, { id: 'q3', ts: iso(now - 45 * M), type: 'task.train.queued', agent: 'zz', task: 'T-ELSEWHERE', meta: {} }]).unhealthy;
// (b) a hand-back whose note says the work is ready for the train
const paused = (msg) => ({ id: 'p' + (++id), ts: iso(now - 44 * M), type: 'task.paused', agent: 'b5', task: 'T-B5', msg: 'Handed back T-B5: ' + msg });
out.ready = h([...nothing, paused('all checks green; READY for the train, lane lane/b5 at abc1234')]).unhealthy;
out.notReady = h([...nothing, paused('not ready for the train: the golden moved')]).unhealthy;
out.failure = h([...nothing, paused('verify failed: golden mismatch')]).unhealthy;
// (c) sessions started by hand are not the crew's
const mixed = [...sessions('b', 5), ...sessions('hand', 5, { hand: true })];
out.mixed = { unhealthy: h(mixed).unhealthy, sessions: h(mixed).sessions };
out.allHand = { unhealthy: h(sessions('hand', 9, { hand: true })).unhealthy, row: !!crewHealth(sessions('hand', 9, { hand: true }), { now, env: {} }).builder };
out.crewOf8Hand0 = h([...sessions('b', 7), ...sessions('hand', 3, { hand: true })]).unhealthy;
console.log(JSON.stringify(out));
`);
    await guard('2.84 (v2a): a session whose lane was checked and queued for the merge train (task.train.queued / task.done.queued for a task it held) is progress, not "0 landed", even when the queue entry is gone by the session\'s end; a queue event for a task no session of the role held is not; 8 sessions with nothing still trip it (fails before this fix: tripped)', () => [
      r.control?.unhealthy === true && r.control.sessions === 8 && r.queued === false && r.doneQueued === false && r.queuedOtherTask === true, JSON.stringify(r)]);
    await guard('2.84 (v2b): a hand-back whose note says the work is ready for the train counts as progress; "not ready for the train" and a plain failure note do not (fails before this fix: tripped)', () => [
      r.ready === false && r.notReady === true && r.failure === true, JSON.stringify(r)]);
    await guard('2.84 (v2c): sessions a person or the overseer started by hand (meta.byHand on agent.session.start) are not counted among the crew\'s sessions or ends: 5 crew + 5 by hand is 5 sessions, 9 by hand are no row, 7 crew + 3 by hand still trips (fails before this fix: 10 sessions, tripped)', () => [
      r.mixed?.unhealthy === false && r.mixed.sessions === 5 && !r.allHand?.unhealthy && r.allHand.row === false && r.crewOf8Hand0 === true, JSON.stringify(r)]);

    // The launch records it: typed `agent start` is by hand, the supervisor's own launcher is not.
    const { S: L, ev: lev, env: lenv } = studio('launch', { git: true });
    fs.writeFileSync(path.join(L, 'zz-ok.mjs'), 'process.exit(0);\n');
    const lbase = { ...lenv, STUDIO_AGENT_CMD: 'node zz-ok.mjs', STUDIO_HEARTBEAT_SEC: '1', STUDIO_REHEARSAL: '1' };
    const sA = node(L, ['harness/agent.mjs', 'start', '--foreground', '--role', 'builder', '--agent', 'builder-hand1', '--tool', 'custom', '--model', 'm'], lbase);
    const sB = node(L, ['harness/agent.mjs', 'start', '--attach', '--role', 'builder', '--agent', 'builder-crew1', '--tool', 'custom', '--model', 'm'], lbase);
    const sC = node(L, ['harness/agent.mjs', 'start', '--attach', '--by-hand', '--role', 'builder', '--agent', 'builder-hand2', '--tool', 'custom', '--model', 'm'], lbase);
    const startOf = (a) => events(lev).find((e) => e.type === 'agent.session.start' && e.agent === a);
    await guard('2.84 (v2c): a launch records who started it: `agent start` typed by a person puts byHand on agent.session.start, a launcher the supervisor spawned (--attach alone) does not, and a detached launcher a person started is told with --by-hand (fails before this fix: nothing recorded who started it)', () => [
      startOf('builder-hand1')?.meta?.byHand === true && startOf('builder-crew1') && !startOf('builder-crew1').meta.byHand && startOf('builder-hand2')?.meta?.byHand === true,
      `${out(sA).slice(-300)} | ${out(sB).slice(-300)} | ${out(sC).slice(-300)} | ${JSON.stringify(events(lev).filter((e) => e.type === 'agent.session.start').map((e) => [e.agent, e.meta]))}`]);
  }

  // ================= 3. the planning stall limit follows the model =================
  {
    const { S, env } = studio('stall', { git: true });
    const penv = { ...env, STUDIO_STALL_PLAN_MIN: '', STUDIO_STALL_MIN: '', STUDIO_SESSION_PLAN_MAX_MIN: '', STUDIO_SESSION_MAX_MIN: '', STUDIO_STALL: '', STUDIO_DRIFT: 'off' };
    const r = probe(S, penv, `import fs from 'node:fs'; import path from 'node:path';
import { stallLimits, observe } from ${u(S, 'harness/stall.mjs')};
const root = path.resolve('.'); const now = Date.now(); const M = 60000; const iso = (t) => new Date(t).toISOString();
const o = {};
o.opus = stallLimits('director', {}, 'claude-opus-5-5'); o.sonnet = stallLimits('director', {}, 'claude-sonnet-5-5'); o.none = stallLimits('director', {});
o.builderOpus = stallLimits('builder', {}, 'claude-opus-5-5').stallMin;
o.explicit = stallLimits('director', { STUDIO_STALL_PLAN_MIN: '8' }, 'claude-opus-5-5').stallMin;
// The session record carries the model; the verdict at 9 minutes of silence follows it.
const sess = (agent, model) => ({ agent, role: 'director', model, startedAt: iso(now - 9 * M), task: null });
observe(sess('director-a', 'claude-opus-5-5'), { now: now - 9 * M, cwd: root });
o.opus9 = observe(sess('director-a', 'claude-opus-5-5'), { now, cwd: root });
observe(sess('director-b', 'claude-sonnet-5-5'), { now: now - 9 * M, cwd: root });
o.sonnet9 = observe(sess('director-b', 'claude-sonnet-5-5'), { now, cwd: root });
const late = (agent, model) => ({ agent, role: 'director', model, startedAt: iso(now - 21 * M), task: null });
observe(late('director-c', 'claude-opus-5-5'), { now: now - 21 * M, cwd: root });
o.opus21 = observe(late('director-c', 'claude-opus-5-5'), { now, cwd: root });
// studio/models.json: a pool's own stallMin wins over the tier's.
fs.writeFileSync(path.join(root, 'studio', 'models.json'), JSON.stringify({ pools: { slow: { tool: 'claude', model: 'claude-sonnet-5-5', match: 'sonnet', stallMin: 30 }, quick: { tool: 'claude', model: 'claude-opus-5-5', stallMin: 12 } } }));
o.poolSonnet = stallLimits('producer', {}, 'claude-sonnet-5-5'); o.poolOpus = stallLimits('producer', {}, 'claude-opus-5-5'); o.poolOpusSet = stallLimits('producer', { STUDIO_STALL_PLAN_MIN: '5' }, 'claude-opus-5-5').stallMin;
console.log(JSON.stringify(o));
`);
    await guard('2.84 (v3a): the planning stall limit follows the model: 20 minutes for a top-tier model (Opus), 8 for another or an unknown one, builders 15 as before; an explicit STUDIO_STALL_PLAN_MIN wins; a session on Opus is not ended after 9 quiet minutes but is after 21, one on Sonnet is after 9 (fails before this fix: 8 for every model)', () => [
      r.opus?.stallMin === 20 && r.sonnet?.stallMin === 8 && r.none?.stallMin === 8 && r.builderOpus === 15 && r.explicit === 8
        && r.opus9?.stalled === false && r.sonnet9?.stalled === true && r.opus21?.stalled === true,
      JSON.stringify(r)]);
    await guard('2.84 (v3b): studio/models.json may set "stallMin" on a pool (matched by its model or "match"), which wins over the tier default but not over STUDIO_STALL_PLAN_MIN; the stall verdict and the limit say which limit applied and why (fails before this fix: no such setting, no reason)', () => [
      r.poolSonnet?.stallMin === 30 && /models\.json pool "slow"/.test(r.poolSonnet.stallWhy || '') && r.poolOpus?.stallMin === 12 && r.poolOpusSet === 5
        && /top-tier/.test(r.opus?.stallWhy || '') && /limit 8: /.test(r.sonnet9?.why || '') && /limit 20: .*top-tier/.test(r.opus21?.why || '') && r.opus21?.limitMin === 20,
      JSON.stringify(r)]);
    // The event carries it.
    const ev = probe(S, penv, `import { logStall, stallVerdict } from ${u(S, 'harness/stall.mjs')};
const now = Date.now(); const iso = (t) => new Date(t).toISOString();
fs.rmSync && 0;
const s = { agent: 'director-e', role: 'director', model: 'claude-opus-5-5', startedAt: iso(now - 22 * 60000), lastProgressAt: iso(now - 22 * 60000) };
const v = stallVerdict(s, now);
logStall({ agent: 'director-e', role: 'director', startedAt: s.startedAt }, v, { by: 'test', now });
console.log(JSON.stringify({ kind: v.kind }));
`.replace("fs.rmSync && 0;\n", ''));
    const stallEv = events(path.join(S, '.studio', 'events-284v.jsonl')).find((e) => e.type === 'session.stall' && e.meta?.target === 'director-e');
    await guard('2.84 (v3b): the session.stall event\'s meta names the limit that applied and why (limitMin, limitWhy) (fails before this fix: not there)', () => [
      stallEv && Number(stallEv.meta.limitMin) > 0 && typeof stallEv.meta.limitWhy === 'string' && stallEv.meta.limitWhy.length > 0, JSON.stringify({ ev, stallEv })]);
  }

  // ================= 4. task start --dry-run, and the board from a lane copy =================
  {
    const { S, ev, env } = studio('dry');
    const boardBefore = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const dry = node(S, ['harness/task.mjs', 'start', 'T-003', '--agent', 'claude-v', '--dry-run'], env);
    const afterBoard = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const lk = probe(S, env, `import { status } from ${u(S, 'harness/lock.mjs')}; console.log(JSON.stringify({ locked: status('task:T-003').locked }));`);
    const evsDry = events(ev).filter((e) => /^task\./.test(e.type));
    await guard('2.84 (v4a): `task start <ID> --dry-run` prints what would happen ("would start", its role and lane) and changes nothing: the board is byte for byte the same, no task lock, no task.* event, no lane copy (fails before this fix: it really started the task)', () => [
      dry.status === 0 && /DRY RUN: T-003 would start for claude-v/.test(dry.stdout) && afterBoard === boardBefore && lk.locked === false && evsDry.length === 0 && !fs.existsSync(path.join(S, '.lanes')),
      `${out(dry).slice(-500)} | locked=${lk.locked} | ${JSON.stringify(evsDry.map((e) => e.type))} | board same: ${afterBoard === boardBefore}`]);

    // A refusal is printed, exit 1, and nothing is logged or parked.
    fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: { 'T-003': { parked: { by: 'producer', why: 'waits for the art pass', at: new Date().toISOString() } } } }, null, 2)}\n`);
    const dryNo = node(S, ['harness/task.mjs', 'start', 'T-003', '--agent', 'claude-v', '--dry-run'], env);
    const missing = node(S, ['harness/task.mjs', 'start', 'T-404', '--agent', 'claude-v', '--dry-run'], env);
    const evsNo = events(ev).filter((e) => /^task\./.test(e.type));
    await guard('2.84 (v4a): a dry run of a start that would be refused prints "would be refused" with the reason (parked, unknown task), exits 1 and logs nothing (fails before this fix: the refused start was logged as task.start_refused)', () => [
      dryNo.status === 1 && /DRY RUN: T-003 would be refused \(held\): .*waits for the art pass/.test(dryNo.stdout) && missing.status === 1 && /DRY RUN: T-404 would be refused/.test(missing.stdout) && evsNo.length === 0,
      `${out(dryNo).slice(-400)} | ${out(missing).slice(-300)} | ${JSON.stringify(evsNo.map((e) => e.type))}`]);
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });

    // A lane copy made by hand has no link to main's studio/, so it read its own snapshot of the board.
    const next = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const lane = path.join(S, '.lanes', 'builder-x');
    const wt = gitIn(S, 'worktree', 'add', '-q', '-b', 'lane/builder-x', lane);
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), next.replace('## BACKLOG\n', '## BACKLOG\n- [ ] **T-777** [P1] (`builder`) — Added after the lane was cut\n'));
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(lane, 'node_modules'), 'junction'); } catch { /* none needed */ } }
    const laneEnv = { ...env, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '' };
    const sh = node(lane, ['harness/task.mjs', 'show', 'T-777'], laneEnv);
    const ls = node(lane, ['harness/task.mjs', 'list'], laneEnv);
    const dl = node(lane, ['harness/task.mjs', 'start', 'T-777', '--dry-run'], laneEnv);
    await guard('2.84 (v4b): from a lane copy made by hand, `task show`, `task list` and `task start --dry-run` read the main checkout\'s board (a task added after the lane was cut is found; it said "No task"/"Task not found") (fails before this fix)', () => [
      wt.status === 0 && sh.status === 0 && /"id": "T-777"/.test(sh.stdout) && /T-777/.test(ls.stdout) && dl.status === 0 && /DRY RUN: T-777 would start for builder-x/.test(dl.stdout),
      `${out(wt).slice(-200)} | ${out(sh).slice(-300)} | ${out(dl).slice(-300)}`]);
  }

  // ================= 5. studio:reload-env names the names =================
  {
    const { S, env } = studio('env', { git: false });
    const MISSPELT = 'STUDIO' + '_HEAVY_SLOTZ';
    const GONE = 'STUDIO' + '_QQQ_NEVER_EXISTED_SETTING';
    fs.writeFileSync(path.join(S, '.env'), ['STUDIO_HEAVY_SLOTS=3', `${MISSPELT}=2`, `${GONE}=hunter2-secret-value`, ''].join('\r\n'));
    const r = node(S, ['harness/env-reload.mjs', '--by', 'test'], env);
    const text = out(r);
    const tail = text.split(/no longer reads?:?/).slice(1).join('\n');
    await guard('2.84 (v5): `studio:reload-env` names the settings the harness no longer reads in its summary line (not only marks them in the list), each with the closest current name when the settings map has one and "no current name is close" when it does not; no value is printed (fails before this fix: "2 names the harness no longer reads" and nothing more)', () => [
      r.status === 0 && new RegExp(`${MISSPELT}\\s+closest current name: STUDIO_HEAVY_SLOTS\\b`).test(tail) && new RegExp(`${GONE}\\s+no current name is close`).test(tail) && !/hunter2/.test(text),
      text.slice(-900)]);
  }
  // ================= 6. a refusal about the crew is not counted against the task =================
  {
    const { crewWideRefusal } = await import('../harness/supervisor.mjs');
    const crew = ['Not started: 6 agents already running; the Standard mode allows 6.', 'Not started: 2 builder agent(s) already running; the mode allows 2.', 'Not started: budget stop (the daily cap is reached).'];
    const task = ['Not started: T-1 is parked: three failed tries', 'no lane copy could be made for builder-a (still in use)', 'task.start_refused T is held by the owner'];
    await guard('2.84 (v6): a start refused because every seat is taken or the budget stopped is a refusal about the crew, so the supervisor does not back the task off for it; a refusal about the task still counts', () => [
      crew.every((m) => crewWideRefusal(m)) && task.every((m) => !crewWideRefusal(m)),
      JSON.stringify({ crew: crew.map((m) => crewWideRefusal(m)), task: task.map((m) => crewWideRefusal(m)) })]);
  }

}
