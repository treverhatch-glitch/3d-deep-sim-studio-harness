/**
 * qa/selftest-290a.mjs — 2.90: costs a live studio's overseer wrote down while running 2.86.
 *   a  a task that names a proposal (its title or --after) waits while it is one, then for the task it became
 *   b  `task promote` takes --phase, --serves and --type, so a porter's "Port …" proposal can be promoted
 *   c  `task unblock` ends a time block (task block <ID> --until <time>)
 *   d  the crew breaker counts a session that committed to its task as progress
 *   e  the focus brief lists the line ranges a task names first, and says to read only those
 *   f  a hand-back after commits is progress for every counter, and `task done --train --slice` lands a unit per slice
 *   g  parallel port units declare no shared state: the porter's rule and the port-plan template's first chore
 *   h  an answered ask stays on the asker's and the Director's brief until `ask -- followed` records its follow-up
 * Scaffolding: a studio copy with its own git and events file, as in qa/selftest-286e.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest290A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const S = path.join(tmpRoot, `290a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/proposed.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { repo: '../engine-repo' } } }, null, 2)}\n`);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-290a.jsonl');
  fs.writeFileSync(evFile, '');
  const env = {
    ...clean, ...ident, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_DISK_MIN_FREE_GB: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-290a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '',
  };
  const node = (args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env, encoding: 'utf8', timeout: 180000 });
  const task = (...a) => node(['harness/task.mjs', ...a]);
  const u = fileUrlOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-290a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = node([f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const board = () => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
  const idOf = (title) => (board().match(new RegExp(`\\*\\*(T-\\d+)\\*\\*[^\\n]*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) || [])[1] || null;

  // ================= a. a task that names a proposal waits for it =================
  {
    const r = probe(`import fs from 'node:fs';
const th = await import(${u('harness/task-hold.mjs')});
const write = (items) => fs.writeFileSync('studio/proposed.json', JSON.stringify({ items, next: 3 }));
const q = (done) => ({ done: done.map((id) => ({ id })), inProgress: [], backlog: [{ id: 'T-001', role: 'engine-porter', title: 'Wire batch 1 to the engine (web half: P-01)' }, { id: 'T-002', role: 'producer', title: 'Look at P-01 and decide' }, { id: 'T-003', role: 'builder', title: 'Another task' }] });
write([{ id: 'P-01', title: 'Web half of batch 1', role: 'builder', agent: 'builder-1', meta: {} }]);
th.setHold('T-003', { after: ['P-01'] });
const open = th.holdReason('T-001', q([]), Date.now(), th.readHolds());
const owner = th.holdOwner('T-001', q([]), Date.now(), th.readHolds());
const producer = th.holdReason('T-002', q([]), Date.now(), th.readHolds());
const viaAfter = th.holdReason('T-003', q([]), Date.now(), th.readHolds());
write([{ id: 'P-01', title: 'Web half of batch 1', role: 'builder', agent: 'builder-1', meta: {}, promoted: 'T-009' }]);
const became = th.holdReason('T-001', q([]), Date.now(), th.readHolds());
const doneNow = th.holdReason('T-001', q(['T-009']), Date.now(), th.readHolds());
console.log(JSON.stringify({ open, owner: owner && owner.owner, producer, viaAfter, became, doneNow }));`);
    await guard('2.90 (a) a backlog task whose title names an open proposal (P-01) waits for it, the reason names `task promote P-01` and the owner is the Producer; a --after P-01 hold says the same; once P-01 became T-009 the task waits for T-009 and starts when T-009 is done; a Producer\'s task that names P-01 is not held (fails on 2.89: holdReason was null, so the task launched while its other half was still a proposal)', () => [
      /still a proposal/.test(String(r.open)) && /promote P-01/.test(String(r.open)) && r.owner === 'the Producer' && r.producer === null && /still a proposal/.test(String(r.viaAfter))
        && /T-009 \(was P-01\)/.test(String(r.became)) && r.doneNow === null,
      JSON.stringify(r)]);
  }
  {
    write(S, 'studio/proposed.json', JSON.stringify({ items: [{ id: 'P-02', title: 'Web half of batch 2', role: 'builder', agent: 'builder-1', meta: {} }], next: 3 }));
    const add = task('add', 'Docs: wire notes for batch 2', '--agent', 'prod-1', '--after', 'P-02');
    const bad = task('add', 'Docs: wire notes for batch 3', '--agent', 'prod-1', '--after', 'P-77');
    await guard('2.90 (a) `task add --after P-02` with P-02 an open proposal is queued and its hold names P-02, while an id that is neither a task nor an open proposal is still refused (fails on 2.89: "P-02 is not a task id on the board")', () => {
      const id = idOf('wire notes for batch 2');
      const holds = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {};
      return [add.status === 0 && Boolean(id) && (holds[id]?.after || []).includes('P-02') && bad.status !== 0 && /P-77 is not a task id/.test(out(bad)), JSON.stringify({ add: out(add).slice(-400), bad: out(bad).slice(-300), id, hold: id && holds[id] })];
    });
  }

  // ================= b. promote takes what the gate asks =================
  {
    fs.rmSync(path.join(S, 'studio', 'proposed.json'), { force: true });
    node(['harness/intake.mjs', '--answers', 'studio/templates/intake-example.json']);
    const sign = node(['harness/bible.mjs', 'sign', '--by', 'hatch']);
    const p1 = task('add', 'Engine batch 1: the rules of the store', '--role', 'engine-porter', '--agent', 'engine-porter-1', '--why', 'the next batch of the port plan');
    const p2 = task('add', 'Engine batch 2: the rules of the market', '--role', 'engine-porter', '--agent', 'engine-porter-1', '--why', 'the batch after it');
    const p3 = task('add', 'Port (engine, batch 3): the rules of the yard', '--role', 'engine-porter', '--agent', 'engine-porter-1', '--why', 'a batch whose title says it is a port');
    const plain = task('promote', 'P-1', '--by', 'prod-1');
    const flagged = task('promote', 'P-1', '--by', 'prod-1', '--phase', '1', '--serves', 'pillar:Calm');
    const chore = task('promote', 'P-2', '--by', 'prod-1', '--type', 'chore');
    const badType = task('promote', 'P-2', '--by', 'prod-1', '--type', 'nonsense');
    const port = task('promote', 'P-3', '--by', 'prod-1');
    await guard('2.90 (b) a porter\'s proposal that is a build task: plain `task promote` refuses it and says to promote with --phase and --serves (or --type chore); `promote P-1 --phase 1 --serves pillar:Calm` queues it, and `promote P-2 --type chore` queues it as "Chore: …"; an unknown --type is refused (fails on 2.89: promote took no flags, so both stayed refused and were re-added by hand)', () => [
      sign.status === 0 && /Proposed P-1/.test(out(p1)) && /Proposed P-2/.test(out(p2))
        && /Refused: P-1/.test(out(plain)) && /promote P-1 --by prod-1 --phase/.test(out(plain)) && /--type chore/.test(out(plain))
        && /Queued P-1→T-\d+/.test(out(flagged)) && /Queued P-2→T-\d+/.test(out(chore)) && Boolean(idOf('Chore: Engine batch 2')) && Boolean(idOf('Engine batch 1: the rules of the store'))
        && badType.status !== 0 && /Unknown --type/.test(out(badType)),
      JSON.stringify({ sign: out(sign).slice(-200), p1: out(p1).slice(-200), plain: out(plain).slice(-600), flagged: out(flagged).slice(-300), chore: out(chore).slice(-300), badType: out(badType).slice(-200) })]);
    const portShow = (() => { try { return JSON.parse(task('show', idOf('Port (engine, batch 3): the rules of the yard') || 'T-0', '--json').stdout || '{}'); } catch { return {}; } })();
    await guard('2.90 (b) an engine porter\'s proposal titled "Port …" names no phase and no pillar (the web game is its spec): plain `task promote` queues it, and it stays a build task (type change, the port card in its brief)', () => [
      /Proposed P-3/.test(out(p3)) && /Queued P-3→T-\d+/.test(out(port)) && Boolean(idOf('Port (engine, batch 3): the rules of the yard')) && portShow.type === 'change' && portShow.vision?.kind === 'port',
      JSON.stringify({ p3: out(p3).slice(-200), port: out(port).slice(-500), type: portShow.type, vision: portShow.vision })]);
  }

  // ================= c. unblock ends a time block =================
  {
    const add = task('add', 'Docs: notes for the time block', '--agent', 'prod-1');
    const id = idOf('notes for the time block');
    const later = new Date(Date.now() + 3 * 3600000).toISOString();
    const block = task('block', String(id), '--until', later, '--by', 'prod-1');
    const holds = () => (JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {})[id] || {};
    const before = holds().until || null;
    const un = task('unblock', String(id), '--by', 'prod-1');
    const after = holds().until || null;
    const again = task('unblock', String(id), '--by', 'prod-1');
    await guard('2.90 (c) `task block <ID> --until <a later time>` then `task unblock <ID>`: the time block is cleared, unblock exits 0 and says so, and block\'s own line names unblock; a second unblock says there is nothing to unblock (fails on 2.89: unblock answered "isn\'t parked or tripped; nothing to unblock" and the block stayed)', () => [
      add.status === 0 && Boolean(id) && Boolean(before) && /task -- unblock/.test(out(block)) && un.status === 0 && /time block .* is cleared/.test(out(un)) && after === null && again.status !== 0 && /nothing to unblock/.test(out(again)),
      JSON.stringify({ id, before, after, block: out(block).slice(-300), un: out(un).slice(-300), again: out(again).slice(-300) })]);
  }

  // ================= d. a committed slice is progress =================
  {
    const r = probe(`const cw = await import(${u('harness/crew-watch.mjs')});
const now = Date.parse('2026-11-11T05:00:00Z');
const mk = (commitsOf) => { const evs = []; for (let i = 0; i < 8; i += 1) { const a = 'engine-porter-s' + i; const t0 = now - (50 - i * 5) * 60000;
  evs.push({ ts: new Date(t0).toISOString(), type: 'agent.session.start', agent: a, task: 'T-010', meta: { role: 'engine-porter' } });
  evs.push({ ts: new Date(t0 + 240000).toISOString(), type: 'agent.session.end', agent: a, task: 'T-010', tokensIn: 1000, tokensOut: 100, meta: { role: 'engine-porter', outcome: { task: 'T-010', done: false, commits: commitsOf(i), noWork: commitsOf(i) === 0, stuck: false, counts: true, why: commitsOf(i) ? 'it made 1 commit(s) but did not call task done' : 'no commit' } } }); }
  return evs; };
const h = (evs) => { const x = cw.crewHealth(evs, { now, env: { STUDIO_CREW_MAX_SESSIONS: '6' } })['engine-porter']; return { sessions: x.sessions, committed: x.committed, unhealthy: x.unhealthy, why: x.why }; };
console.log(JSON.stringify({ slices: h(mk(() => 1)), nothing: h(mk(() => 0)), one: h(mk((i) => (i === 0 ? 1 : 0))) }));`);
    await guard('2.90 (d) crew breaker: eight porter sessions in the hour on one big unit, each committing a slice and none landed, do not trip it; eight with no commit still trip it, and so do eight where only one committed (seven with nothing is over 6), whose reason counts the sessions with no commit (fails on 2.89: the eight committing sessions tripped it)', () => [
      r.slices?.sessions === 8 && r.slices.committed === 8 && r.slices.unhealthy === false && r.nothing?.unhealthy === true && r.one?.unhealthy === true && /7 of them with no commit/.test(String(r.one.why)),
      JSON.stringify(r)]);
  }

  // ================= e. the brief lists the ranges a task names =================
  {
    const lines = Array.from({ length: 400 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    write(S, 'cartridges/demo290/sim.ts', `${lines}\n`);
    const add = task('add', 'Port unit M1: cartridges/demo290/sim.ts:120-180,300-340 and missing/nowhere.ts:1-9', '--role', 'engine-porter', '--agent', 'prod-1', '--phase', '1', '--serves', 'pillar:Calm');
    const id = idOf('Port unit M1');
    const f = node(['harness/focus.mjs', String(id)]);
    const md = out(f);
    const sec = (md.split('## Read only these lines')[1] || '').split('\n## ')[0];
    await guard('2.90 (e) a task whose title names cartridges/demo290/sim.ts:120-180,300-340: its focus brief has "Read only these lines" before what the task is, listing both ranges with their offset and limit, and leaves out a file that does not exist (fails on 2.89: the brief had no such section, so a porter read the whole file)', () => [
      add.status === 0 && Boolean(id) && f.status === 0 && md.indexOf('## Read only these lines') > 0 && md.indexOf('## Read only these lines') < md.indexOf('## What this task is')
        && /`cartridges\/demo290\/sim\.ts` lines 120-180: offset 120, limit 61/.test(sec) && /lines 300-340: offset 300, limit 41/.test(sec) && !/nowhere/.test(sec),
      JSON.stringify({ add: out(add).slice(-300), id, sec, head: md.slice(0, 800) })]);
  }
  // ================= f. big units land per slice; a committed slice is progress =================
  {
    const r = probe(`import { spawnSync } from 'node:child_process';
const hk = await import(${u('harness/handback-kind.mjs')});
const busy = await import(${u('harness/busy.mjs')});
const tb = await import(${u('harness/task-budget.mjs')});
const br = await import(${u('harness/breaker.mjs')});
const { emitEvent } = await import(${u('harness/event.mjs')});
const now = Date.now(); const iso = (m) => new Date(now - m * 60000).toISOString();
const paused = (task, m, commits, note = 'ported 10 of 53 methods; the rest next session') => ({ ts: iso(m), type: 'task.paused', agent: 'engine-porter-' + m, task, msg: 'Handed back ' + task + ': ' + note, meta: commits ? { commits } : {} });
const ends = (task, m, commits) => [{ ts: iso(m + 1), type: 'agent.session.start', agent: 'p' + m, task, meta: { role: 'engine-porter' } }, { ts: iso(m - 0.5), type: 'agent.session.end', agent: 'p' + m, task, meta: { role: 'engine-porter', outcome: { task, commits, done: false, counts: true } } }];
const slices = [paused('T-020', 30, 1), paused('T-020', 20, 2), paused('T-020', 10, 1)];
const viaEnd = [...ends('T-021', 30, 1), { ...paused('T-021', 30, 0), agent: 'p30', ts: iso(30.6) }];
const plain = [paused('T-022', 30, 0), paused('T-022', 20, 0), paused('T-022', 10, 0)];
const sess = (task, k, commits) => { const out = []; for (let i = 0; i < k; i += 1) out.push(...ends(task, 60 - i * 8, commits)); return out; };
const note = 'verify failed: golden mismatch in the store rules';
for (const t of ['T-023', 'T-024']) for (let i = 0; i < 2; i += 1) emitEvent({ type: 'task.paused', agent: 'engine-porter-' + i, task: t, msg: 'Handed back ' + t + ': ' + note, meta: { reasonKey: br.reasonKey(note), ...(t === 'T-023' ? { commits: 1 } : {}) } });
console.log(JSON.stringify({ kind: hk.handBackKind(slices[0], slices), kindEnd: hk.handBackKind(viaEnd[2], viaEnd), loopSlices: busy.loopHandBacks('T-020', slices).length, loopPlain: busy.loopHandBacks('T-022', plain).length,
  budgetSlices: tb.taskSpend('T-025', sess('T-025', 6, 1), now).sessions, budgetPlain: tb.taskSpend('T-026', sess('T-026', 6, 0), now).sessions,
  breakerSlices: br.checkBreaker('T-023', note), breakerPlain: br.checkBreaker('T-024', note) }));`);
    await guard('2.90 (f) a hand-back that left commits on its task is progress: its kind is "progress" (from the hand-back\'s own commits or its session end\'s), three such hand-backs are 0 for the watchdog\'s park (three plain ones are 3), six committing sessions are 0 sessions of the task budget (six with no commit are 6), and two failure hand-backs with commits do not trip the circuit breaker (two without do) (fails on 2.89: "real", 3, 6 and parked)', () => [
      r.kind === 'progress' && r.kindEnd === 'progress' && r.loopSlices === 0 && r.loopPlain === 3 && r.budgetSlices === 0 && r.budgetPlain === 6 && r.breakerSlices === null && /circuit breaker/.test(String(r.breakerPlain)),
      JSON.stringify(r)]);
  }
  {
    const r = probe(`import { spawnSync } from 'node:child_process';
const tm = await import(${u('harness/task.mjs')});
const th = await import(${u('harness/task-hold.mjs')});
const hk = await import(${u('harness/handback-kind.mjs')});
const { readRecentEvents } = await import(${u('harness/event.mjs')});
const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const t = tm.addTask({ title: 'Docs: a big unit landed in slices', role: 'builder', priority: 'P2', agent: 'prod-1', meta: { promoted: true } });
const id = t.id;
const begin = () => tm.withBoard(() => { const q = tm.parseNextQueue(); const x = q.backlog.find((y) => y.id === id); if (x) { q.backlog = q.backlog.filter((y) => y.id !== id); q.inProgress.push({ ...x, status: 'in_progress' }); tm.writeNextQueue(q); } });
const where = () => { const q = tm.parseNextQueue(); return q.inProgress.some((x) => x.id === id) ? 'in-progress' : q.backlog.some((x) => x.id === id) ? 'backlog' : q.done.some((x) => x.id === id) ? 'done' : 'gone'; };
const slice = () => th.setHold(id, { slice: { by: 'engine-porter-1', at: new Date().toISOString() } });
const out = {};
begin(); slice(); out.r1 = tm.closeTrainTask(id, 'engine-porter-1', { train: 'tr-1', head, laneHead: head }); out.after1 = where(); out.mark1 = Boolean(th.readHolds()[id]?.slice);
begin(); slice(); out.r2 = tm.closeTrainTask(id, 'engine-porter-2', { train: 'tr-2', head, laneHead: head }); out.after2 = where();
begin(); slice(); tm.pauseTask(id, 'train', 'train tr-3: verify failed: the same member declared twice', { force: true }); out.red = where(); out.redMark = Boolean(th.readHolds()[id]?.slice);
const evs = readRecentEvents(20000); const redEv = evs.filter((e) => e.type === 'task.paused' && e.task === id).pop(); out.redKind = hk.handBackKind(redEv, evs); out.redMsg = redEv && redEv.msg;
th.setHold(id, { slice: null });
begin(); out.r3 = tm.closeTrainTask(id, 'engine-porter-3', { train: 'tr-4', head, laneHead: head }); out.after3 = where();
out.sliceEvents = readRecentEvents(20000).filter((e) => e.type === 'task.slice_landed' && e.task === id).length;
out.doneEvents = readRecentEvents(20000).filter((e) => e.type === 'task.done' && e.task === id).length;
out.parked = Boolean(th.readHolds()[id]?.parked);
console.log(JSON.stringify({ id, ...out, r1: out.r1 && out.r1.sliceLanded, r2: out.r2 && out.r2.sliceLanded, r3: out.r3 && out.r3.id }));`);
    const lone = task('done', String(r.id || 'T-999'), '--slice', '--agent', 'engine-porter-1');
    await guard('2.90 (f) a unit task lands two slices (each a train close with the slice mark): after each it is back in the backlog with no slice mark and a task.slice_landed event, not done; a red slice comes back as a hand-back with its reason, keeps its mark and counts as a real hand-back; the last landing without a slice mark closes it (one task.done); nothing parks it; `task done --slice` without --train is refused (fails on 2.89: the first landing closed the task)', () => [
      r.r1 === true && r.after1 === 'backlog' && r.mark1 === false && r.r2 === true && r.after2 === 'backlog' && r.red === 'backlog' && r.redMark === true && r.redKind === 'real' && /verify failed: the same member declared twice/.test(String(r.redMsg))
        && r.r3 === r.id && r.after3 === 'done' && r.sliceEvents === 2 && r.doneEvents === 1 && r.parked === false && lone.status !== 0 && /--slice goes with --train/.test(out(lone)),
      JSON.stringify({ r, lone: out(lone).slice(-300) })]);
  }
  // ================= g. parallel units declare no shared state =================
  {
    const role = fs.readFileSync(path.join(S, 'studio', 'roles', 'engine-porter.md'), 'utf8');
    const plan = (() => { try { return fs.readFileSync(path.join(S, 'studio', 'templates', 'port-plan.md'), 'utf8'); } catch { return ''; } })();
    const steps = plan.split(/^## /m).slice(1).map((x) => x.split('\n')[0]);
    await guard('2.90 (g) the engine porter\'s role says a unit never declares a member of a type other units extend (it adds it in the shared-state chore it was given, or stops and names it), and studio/templates/port-plan.md exists with the shared-state chore as its first step and every unit after it (fails on 2.89: no such rule, no plan template)', () => [
      /Shared state is declared once/.test(role) && /don't declare it in your unit's files/.test(role) && /stop and name\s+the member/.test(role) && /port-plan\.md/.test(role)
        && /^1\. Shared state \(one chore, first\)/.test(steps[0] || '') && /--after/.test(plan) && /A unit declares nothing in a shared type/.test(plan),
      JSON.stringify({ steps, role: role.slice(-900) })]);
  }

  // ================= h. an answered ask stays a must-do until its follow-up is recorded =================
  {
    const add = task('add', 'Docs: notes on the store port', '--role', 'engine-porter', '--agent', 'prod-1', '--track', 'engine:unity', '--phase', '1', '--serves', 'pillar:Calm');
    const id = idOf('notes on the store port');
    const made = node(['harness/ask.mjs', 'Do parallel units declare the shared fields?', '--options', 'slices-and-field-chore-first,each-unit', '--by', 'engine-porter-7', '--task', String(id)]);
    const aid = (out(made).match(/\bA-\d+\b/) || [])[0] || 'A-000';
    const ans = node(['harness/ask.mjs', 'answer', aid, 'slices-and-field-chore-first', '--by', 'hatch']);
    const focus1 = out(node(['harness/focus.mjs', String(id)]));
    node(['harness/director.mjs', 'brief']);
    const dir1 = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'briefs', 'director.md'), 'utf8'); } catch { return ''; } })();
    const bad = node(['harness/ask.mjs', 'followed', aid, '--by', 'engine-porter-7']);
    const fol = node(['harness/ask.mjs', 'followed', aid, '--task', 'T-077', '--by', 'engine-porter-7']);
    const focus2 = out(node(['harness/focus.mjs', String(id)]));
    node(['harness/director.mjs', 'brief']);
    const dir2 = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'briefs', 'director.md'), 'utf8'); } catch { return ''; } })();
    const must = (t) => new RegExp(`## Must do first: answered asks[\\s\\S]*${aid} was answered[\\s\\S]*ask -- followed ${aid} --task`).test(t);
    await guard('2.90 (h) an answered ask is on the asking role\'s next focus brief and the Director\'s brief as a must-do (file the work, then `ask -- followed <id> --task <ID>` or `--none "why"`), with the answer quoted in the marked block; `followed` with neither is refused; once followed, neither brief lists it (fails on 2.89: no brief listed an answered ask, and there was no followed verb)', () => [
      add.status === 0 && Boolean(id) && /A-\d+/.test(aid) && ans.status === 0 && must(focus1) && must(dir1) && /slices-and-field-chore-first/.test(focus1) && bad.status !== 0 && /--task <the task you filed> or --none/.test(out(bad))
        && fol.status === 0 && /filed T-077/.test(out(fol)) && !new RegExp(`${aid} was answered`).test(focus2) && !new RegExp(`${aid} was answered`).test(dir2),
      JSON.stringify({ add: out(add).slice(-200), aid, made: out(made).slice(-200), ans: out(ans).slice(-300), focus1: focus1.slice(0, 1200), dir1: dir1.slice(0, 900), bad: out(bad).slice(-200), fol: out(fol).slice(-200) })]);
  }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep removes it */ }
}
