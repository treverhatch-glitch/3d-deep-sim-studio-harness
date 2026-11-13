/**
 * qa/selftest-285d.mjs — 2.85 (d): finished work waiting for a train, and hand-backs that are not the session's.
 *
 *   1  a task queued for a train whose claim ran out is released quietly by the Director's flow pass (no hand-back); an
 *      ended session's bookkeeping events never make it "still working"; a task in no queue is still handed back
 *   2  one rule for which hand-backs count (handback-kind.mjs): the watchdog's park, the crew breaker, the scorecard
 *   3  the same task done refusal twice (no new commit) holds the task for the overseer and the Producer; the hold lifts
 *      when task done --check no longer gives that reason
 *   4  finished engine work handed back as ready is queued by the harness once; failing checks queue nothing
 *   5  (B-138) the trailer check from the main checkout judges only the task's own commits; the commit-msg hook's fixer
 *   6  `node harness/unity-gate.mjs` with no task or branch runs no land and writes no engine.land error
 *
 * Each check imports a module from a copy of the repo, or runs the command in one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest285D({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_DRIFT: 'off', STUDIO_WORKTREES: 'off', STUDIO_LANELESS: 'shared', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_LINE_PRODUCER: 'off', STUDIO_TELEMETRY: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const nm = path.join(harnessRoot, 'node_modules');
  const studio = (name, { git = true } = {}) => {
    const S = path.join(tmpRoot, `285d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(nm, path.join(S, 'node_modules'), 'junction'); } catch { /* the checks need no package */ } }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-285d.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { gitIn(S, 'init', '-q', '-b', 'main'); gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify'); }
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code) => {
    const f = path.join(S, `.probe-285d-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept with the copy */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });

  // The T-724 sequence as events: three sessions refused by task done for the same harness check, the first after a commit.
  const REFUSAL = 'A commit has a "Golden-Reason:" line that git does not read as a trailer (b484f172 "Board review 06:39"), so the merge train would not see it.';
  const seqCode = `const M = 60000; const t0 = Date.parse('2026-11-13T09:15:00Z'); const iso = (t) => new Date(t).toISOString();
let k = 0;
const session = (agent, at, { commits = 0, why = 'task done was refused: ${REFUSAL.replace(/"/g, '\\"')}', note = 'Done: nothing new | Not done: task done --train refused again' } = {}) => [
  { id: 'e' + (++k), ts: iso(t0 + at * M), type: 'agent.session.start', agent, task: 'T-9', meta: { role: 'builder' } },
  { id: 'e' + (++k), ts: iso(t0 + (at + 0.5) * M), type: 'task.paused', agent, task: 'T-9', msg: 'Handed back T-9: ' + note },
  { id: 'e' + (++k), ts: iso(t0 + (at + 0.6) * M), type: 'agent.session.end', agent, task: 'T-9', meta: { role: 'builder', outcome: { task: 'T-9', claimed: true, commits, done: false, noWork: !commits, stuck: true, counts: true, why, engine: 'unity', engineCommits: commits } } },
];`;

  try {
    // ================= 1. the flow pass and a task waiting for a train =================
    {
      const { S, ev, env } = studio('flow');
      const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import * as task from ${u(S, 'harness/task.mjs')};
import { listLocks, release } from ${u(S, 'harness/lock.mjs')};
import { emitEvent } from ${u(S, 'harness/event.mjs')};
import { flowPass } from ${u(S, 'harness/director-flow.mjs')};
const a = task.addTask({ title: 'Bug: the fee line stays on screen', role: 'engine-porter', priority: 'P1', agent: 'producer-1' });
const b = task.addTask({ title: 'Bug: the gate light blinks', role: 'engine-porter', priority: 'P1', agent: 'producer-1' });
const sa = task.startTask(a.id, 'engine-porter-s1'); const sb = task.startTask(b.id, 'engine-porter-s2');
fs.mkdirSync(path.join('.studio', 'train'), { recursive: true });
fs.writeFileSync(path.join('.studio', 'train', 'unity-queue.json'), JSON.stringify([{ task: a.id, agent: 'engine-porter-s1', branch: 'unity/t-a', head: 'abc', at: new Date().toISOString() }]));
// engine-porter-s1 queued its branch and ended; the launcher then writes its job.done and "kept its lane copy" in its name.
emitEvent({ type: 'task.train.unity.queued', agent: 'engine-porter-s1', task: a.id, msg: 'Unity train queue: ' + a.id + ': unity/t-a at abc waits for the next Unity train' });
emitEvent({ type: 'agent.session.end', agent: 'engine-porter-s1', task: a.id, msg: 'engine-porter-s1 ended (finished)', meta: { role: 'engine-porter', outcome: { task: a.id, claimed: true, commits: 1, done: true, counts: true, queuedForTrain: true } } });
emitEvent({ type: 'job.done', agent: 'engine-porter-s1', task: a.id, msg: 'session engine-porter-s1: pass' });
emitEvent({ type: 'lane.kept', agent: 'engine-porter-s1', task: a.id, msg: 'Kept engine-porter-s1 lane copy: ' + a.id + ' waits in the unity train queue' });
// engine-porter-s2 ended with its task in no queue.
emitEvent({ type: 'agent.session.end', agent: 'engine-porter-s2', task: b.id, msg: 'engine-porter-s2 ended (finished)', meta: { role: 'engine-porter', outcome: { task: b.id, claimed: true, commits: 0, done: false, counts: true } } });
emitEvent({ type: 'job.done', agent: 'engine-porter-s2', task: b.id, msg: 'session engine-porter-s2: pass' });
for (const l of listLocks()) if (l.key.startsWith('task:')) release(l.key, l.owner);
const p1 = await flowPass({ fill: false });
const p2 = await flowPass({ fill: false, now: Date.now() + 61000 });
const q = task.parseNextQueue();
console.log(JSON.stringify({ a: a.id, b: b.id, started: [Boolean(sa?.id || sa?.started || !sa?.error), Boolean(sb?.id || !sb?.error)], inProgress: q.inProgress.map((t) => t.id), backlog: q.backlog.map((t) => t.id), p1: p1.actions, waiting: p1.waiting || null }));
`);
      const evs = events(ev);
      const of = (id, type) => evs.filter((e) => e.task === id && e.type === type);
      await guard('2.85 (d1): a task queued for an engine train whose claim ran out and whose session ended is released quietly by the Director\'s flow pass: no task.paused, no "still working" lock.kept, it stays in progress, and one task.claim.released (status ok, "waits for the unity train") over two passes (fails before this fix: lock.kept "its owner is still working on it", then a hand-back an hour later)', () => [
        r.a && of(r.a, 'task.paused').length === 0 && of(r.a, 'lock.kept').length === 0 && of(r.a, 'task.claim.released').length === 1
          && of(r.a, 'task.claim.released')[0].status === 'ok' && /waits for the unity train/.test(of(r.a, 'task.claim.released')[0].meta?.why || '') && r.inProgress.includes(r.a),
        JSON.stringify({ r, evs: evs.filter((e) => e.task === r.a).map((e) => [e.type, e.agent, (e.msg || '').slice(0, 120)]) })]);
      await guard('2.85 (d1): a task in no train queue whose claim ran out with no running session is still handed back by the flow pass, as before (this also failed before this fix: the launcher\'s job.done after the session ended kept it "busy")', () => [
        r.b && of(r.b, 'task.paused').length === 1 && /claim ran out/.test(of(r.b, 'task.paused')[0].msg || '') && r.backlog.includes(r.b),
        JSON.stringify({ r, evs: evs.filter((e) => e.task === r.b).map((e) => [e.type, e.agent, (e.msg || '').slice(0, 120)]) })]);

      const c = probe(S, env, `import { claimActive } from ${u(S, 'harness/busy.mjs')};
const now = Date.now(); const iso = (m) => new Date(now - m * 60000).toISOString();
const evs = [
  { ts: iso(10), type: 'task.start', agent: 'engine-porter-s7', task: 'T-7' },
  { ts: iso(3), type: 'task.train.unity.queued', agent: 'engine-porter-s7', task: 'T-7' },
  { ts: iso(2.5), type: 'agent.session.end', agent: 'engine-porter-s7', task: 'T-7' },
  { ts: iso(2.4), type: 'job.done', agent: 'engine-porter-s7', task: 'T-7' },
  { ts: iso(2.3), type: 'lane.kept', agent: 'engine-porter-s7', task: 'T-7' },
];
const after = claimActive('T-7', { events: evs, now, env: {} });
const working = claimActive('T-7', { events: evs.slice(0, 2), now, env: {} });
console.log(JSON.stringify({ after, working }));`);
      await guard('2.85 (d1): the launcher\'s job.done and lane.kept written after a session ended are not that session working: claimActive is not busy; a session whose last event is its own work still is (fails before this fix: busy, "still working on it")', () => [
        c.after && c.after.busy === false && c.working?.busy === true, JSON.stringify(c)]);
    }

    // ================= 2. one rule for which hand-backs count =================
    {
      const { S, env } = studio('kind', { git: false });
      const r = probe(S, env, `import { loopHandBacks } from ${u(S, 'harness/busy.mjs')};
import { handBackKind, handBackTally } from ${u(S, 'harness/handback-kind.mjs')};
import { crewHealth } from ${u(S, 'harness/crew-watch.mjs')};
${seqCode}
const evs = [...session('builder-s80', 0, { commits: 1, why: 'task done was refused after 1 commit(s): ${REFUSAL.replace(/"/g, '\\"')}', note: 'Done: the compile error fixed (commit 274800c) | Not done: task done --train refused' }), ...session('builder-s81', 2), ...session('builder-s82', 4)];
const flow = { id: 'f1', ts: iso(t0 + 1 * M), type: 'task.paused', agent: 'director', task: 'T-9', msg: "Handed back T-9: The claim ran out with no running session on it: handed back by the Director's flow pass so a free builder can take it." };
const ready = { id: 'r1', ts: iso(t0 + 1.5 * M), type: 'task.paused', agent: 'builder-s79', task: 'T-9', msg: 'Handed back T-9: all checks green; ready for the unity train, branch unity/t-9' };
const all = [...evs, flow, ready, { id: 'c1', ts: iso(t0 + 6 * M), type: 'task.claim.released', agent: 'director', task: 'T-8', meta: { why: 'waits for the unity train' } }].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
const kinds = all.filter((e) => e.type === 'task.paused').map((e) => [e.agent, handBackKind(e, all)]);
const loop = loopHandBacks('T-9', all).map((e) => e.agent);
const tally = handBackTally(all, { from: 0, to: Date.parse('2030-01-01') });
// The crew breaker: 7 sessions, none landed; 2 of them are the same refusal again (not the crew burning sessions).
const crew = [];
for (let i = 1; i <= 7; i++) crew.push(...session('builder-c' + i, 10 + i * 2, { commits: 0, why: i <= 5 ? 'it claimed T-9 but committed nothing and did not call task done' : 'task done was refused: ${REFUSAL.replace(/"/g, '\\"')}' }));
const lastTwoSame = crewHealth(crew, { now: t0 + 40 * M, env: {} }).builder;
console.log(JSON.stringify({ kinds, loop, tally, crew: { noCommit: lastTwoSame?.noCommit, sessions: lastTwoSame?.sessions } }));`);
      await guard('2.85 (d2): the watchdog\'s park counts only real hand-backs (busy.mjs loopHandBacks through handback-kind.mjs): of three sessions refused by task done for the same harness check, a flow-pass claim release and a "ready for the train" note, only the first refusal counts, so the T-724 sequence is never "handed back 3 times" (fails before this fix: 4 counted)', () => [
        JSON.stringify(r.loop) === JSON.stringify(['builder-s80'])
          && JSON.stringify(r.kinds) === JSON.stringify([['builder-s80', 'real'], ['director', 'harness'], ['builder-s79', 'ready'], ['builder-s81', 'refused'], ['builder-s82', 'refused']]),
        JSON.stringify(r)]);
      await guard('2.85 (d2): the scorecard\'s tally prints real hand-backs and, apart, claims released while waiting for a train (1 real, 1 released here); the crew breaker does not count a session refused for the same reason as the one before it as "no work" (6 of 7 here, not 7) (fails before this fix: no tally; 7 counted)', () => [
        r.tally?.real === 1 && r.tally.released === 1 && r.tally.byKind?.refused === 2 && r.crew?.noCommit === 6 && r.crew.sessions === 7,
        JSON.stringify(r)]);
    }

    // ================= 3. the same refusal twice holds the task =================
    {
      const { S, ev, env } = studio('hold', { git: false });
      const r = probe(S, env, `import { holdIfSameRefusal } from ${u(S, 'harness/session-outcome.mjs')};
import { parkOnce } from ${u(S, 'harness/busy.mjs')};
import { readHolds, unparkRefusal, holdReason } from ${u(S, 'harness/task-hold.mjs')};
import { liftSameRefusalHolds } from ${u(S, 'harness/director-flow.mjs')};
${seqCode}
const first = session('builder-s80', 0, { commits: 1, why: 'task done was refused after 1 commit(s): ${REFUSAL.replace(/"/g, '\\"')}' });
const once = holdIfSameRefusal('builder-s80', first, { park: parkOnce });
const twice = [...first, ...session('builder-s81', 2)];
// numbers and ids differ, the reason does not
const twiceN = twice.map((e) => (e.agent === 'builder-s81' && e.meta?.outcome ? { ...e, meta: { ...e.meta, outcome: { ...e.meta.outcome, why: e.meta.outcome.why.replace('b484f172', 'c595e283').replace('06:39', '07:41') } } } : e));
const held = holdIfSameRefusal('builder-s81', twiceN, { park: parkOnce, now: t0 + 3 * M });
const h = readHolds()['T-9']?.parked || null;
const worker = unparkRefusal('T-9', { by: 'builder-s90', env: { STUDIO_ROLE: 'builder' } });
const planner = unparkRefusal('T-9', { by: 'producer-3', env: { STUDIO_ROLE: 'producer' } });
const why = holdReason('T-9', { inProgress: [], backlog: [{ id: 'T-9', role: 'builder', title: 'x' }], done: [] }, t0 + 4 * M);
// A different reason, or a new commit, holds nothing.
const other = [...first, ...session('builder-s83', 2, { why: 'task done was refused: the hooks check failed' })];
const diff = holdIfSameRefusal('builder-s83', other, { park: () => true });
const withCommit = [...first, ...session('builder-s84', 2, { commits: 1, why: 'task done was refused after 1 commit(s): ${REFUSAL.replace(/"/g, '\\"')}' })];
const commit = holdIfSameRefusal('builder-s84', withCommit, { park: () => true });
// The lift: the check still gives the reason (kept, checked again only after 10 min), then it passes (lifted).
const calls = [];
const keep = await liftSameRefusalHolds({ now: t0 + 20 * M, check: async (id) => { calls.push(id); return 'T-9 is not done: ' + ${JSON.stringify(REFUSAL)}.replace('b484f172', 'd606f394') + ' Fix it with git commit --amend.'; } });
const soon = await liftSameRefusalHolds({ now: t0 + 25 * M, check: async (id) => { calls.push('soon:' + id); return ''; } });
const lift = await liftSameRefusalHolds({ now: t0 + 31 * M, check: async (id) => { calls.push(id); return ''; } });
console.log(JSON.stringify({ once, held, h, worker: Boolean(worker), planner, why, diff, commit, keep, soon, lift, calls, after: readHolds()['T-9']?.parked || null }));`);
      const evs = events(ev);
      const holdEv = evs.filter((e) => e.type === 'task.hold' && e.task === 'T-9');
      await guard('2.85 (d3): a session refused by task done for the same reason as the session before it (numbers and ids normalised), with no new commit, holds the task at once: one task.hold by harness to the Producer, addressed to the overseer and the Producer, liftable by a planner and not by a worker; the first refusal holds nothing (fails before this fix: a third session was started)', () => [
        r.once === null && r.held?.task === 'T-9' && /same reason twice/.test(r.held.why) && r.h?.reason === 'same-refusal' && r.h.rank === 2 && r.worker === true && r.planner === null
          && /same reason twice/.test(r.why || '') && holdEv.length >= 1 && holdEv[0].agent === 'harness' && holdEv[0].to === 'producer' && JSON.stringify(holdEv[0].meta?.addressedTo) === '["overseer","producer"]',
        JSON.stringify({ r, holdEv })]);
      await guard('2.85 (d3): a different refusal, or a refusal after a new commit, holds nothing', () => [r.diff === null && r.commit === null, JSON.stringify(r)]);
      await guard('2.85 (d3): the hold lifts by itself once task done --check no longer gives that reason: kept while the check still gives it, not checked again within 10 minutes, then lifted with a task.hold "unparked" (fails before this fix: no lift)', () => [
        JSON.stringify(r.keep) === '[]' && JSON.stringify(r.soon) === '[]' && JSON.stringify(r.lift) === '["T-9"]' && JSON.stringify(r.calls) === '["T-9","T-9"]' && r.after === null
          && holdEv.some((e) => /unparked T-9/.test(e.msg || '')),
        JSON.stringify({ r, holdEv })]);
    }

    // ================= 4. finished engine work is queued by the harness =================
    {
      const { S, ev, env } = studio('auto');
      const E = path.join(tmpRoot, `285d-eng-${process.pid}-${++n}`);
      fs.mkdirSync(E, { recursive: true });
      gitIn(E, 'init', '-q', '-b', 'unity/main');
      fs.mkdirSync(path.join(E, 'Rules'), { recursive: true });
      fs.writeFileSync(path.join(E, 'Rules', 'a.txt'), 'one\n');
      gitIn(E, 'add', '-A'); gitIn(E, 'commit', '-qm', 'engine base', '--no-verify');
      made.push(E);
      for (const b of ['unity/t-ok', 'unity/t-bad']) { gitIn(E, 'checkout', '-q', '-b', b, 'unity/main'); fs.writeFileSync(path.join(E, 'Rules', `${b.slice(8)}.txt`), 'x\n'); gitIn(E, 'add', '-A'); gitIn(E, 'commit', '-qm', b, '--no-verify'); }
      gitIn(E, 'checkout', '-q', 'unity/main');
      const gjF = path.join(S, 'studio', 'game.json');
      let gj = {};
      try { gj = JSON.parse(fs.readFileSync(gjF, 'utf8')); } catch { gj = {}; }
      gj.engines = { unity: { land: 'node -e 0 {branch}', target: 'unity/main', folder: E, gateWorktree: E } };
      fs.writeFileSync(gjF, `${JSON.stringify(gj, null, 2)}\n`);
      gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'engines', '--no-verify');
      const add = (title, br) => {
        const a = node(S, ['harness/task.mjs', 'add', title, '--role', 'engine-porter', '--priority', 'P1', '--track', 'engine:unity', '--branch', br, '--agent', 'producer-1'], env);
        return (out(a).match(/"id":\s*"(T-\d+)"/) || out(a).match(/\b(T-\d+)\b/) || [])[1];
      };
      const ok = add('Port: the gate light', 'unity/t-ok');
      const bad = add('Port: the fee line', 'unity/t-bad');
      // The bad task's own commit on main has a Golden-Reason line git doesn't read as a trailer: its checks fail. Its
      // session started it, made that commit and handed it back as done.
      const s6 = { ...env, STUDIO_LOCK_OWNER: 'engine-porter-s6' };
      node(S, ['harness/task.mjs', 'start', bad, '--agent', 'engine-porter-s6'], s6);
      fs.writeFileSync(path.join(S, 'note-bad.md'), 'x\n');
      gitIn(S, 'add', '-A');
      fs.writeFileSync(path.join(S, '.msg'), `${bad}: port the fee line\nGolden-Reason: the fee moved on purpose\n`);
      gitIn(S, 'commit', '-q', '--no-verify', '-F', path.join(S, '.msg'));
      const paused = node(S, ['harness/task.mjs', 'pause', bad, '--agent', 'engine-porter-s6', '--note', 'Done: the fee line ported | Not done: task done --train not run'], s6);
      const r = probe(S, env, `import { autoQueuePass, autoQueueReady, readyHandBacks } from ${u(S, 'harness/line-producer.mjs')};
import { emitEvent, readRecentEvents } from ${u(S, 'harness/event.mjs')};
import { readUnityQueue } from ${u(S, 'harness/unity-train.mjs')};
const ok = ${JSON.stringify(ok)}; const bad = ${JSON.stringify(bad)};
emitEvent({ type: 'task.paused', agent: 'engine-porter-s5', task: ok, msg: 'Handed back ' + ok + ': READY, not queued: the task said queue only when the queue is short' });
emitEvent({ type: 'task.paused', agent: 'engine-porter-s7', task: 'T-777', msg: 'Handed back T-777: Not done: the gate shader still flickers' });
const cands = (await readyHandBacks(readRecentEvents(2000))).map((c) => c.task);
const calls = [];
const root = process.cwd();
const results = {};
const autoQueue = async (c) => { calls.push(c.task); results[c.task] = await autoQueueReady(root, { ...c }); return results[c.task]; };
const p1 = await autoQueuePass({ root, deps: { autoQueue, engineTask: (t) => (t === 'T-777' ? null : { engine: 'unity' }) } });
const p2 = await autoQueuePass({ root, deps: { autoQueue, engineTask: () => ({ engine: 'unity' }) } });
const off = await autoQueuePass({ root, env: { ...process.env, STUDIO_ENGINE_AUTO_QUEUE: 'off' }, deps: { autoQueue } });
console.log(JSON.stringify({ results, cands, calls, p1: p1.map((x) => x.task), p2: p2.map((x) => x.task), off, queue: readUnityQueue(root, 'unity').map((e) => e.task) }));`);
      const evs = events(ev);
      const queued = evs.filter((e) => e.type === 'task.train.unity.queued');
      const notQueued = evs.filter((e) => e.type === 'task.train.unity.not_queued');
      await guard('2.85 (d4): an engine task handed back as READY, with its branch ahead of the target and passing checks, is queued by the harness once (task.train.unity.queued with meta.auto "ready hand-back"); a second pass does nothing; STUDIO_ENGINE_AUTO_QUEUE=off does nothing (fails before this fix: it waited for a session to queue it)', () => [
        ok && JSON.stringify([...(r.calls || [])].sort()) === JSON.stringify([ok, bad].sort()) && r.queue?.includes(ok) && queued.filter((e) => e.task === ok).length === 1
          && queued.find((e) => e.task === ok)?.meta?.auto === 'ready hand-back' && JSON.stringify(r.p2) === '[]' && JSON.stringify(r.off) === '[]',
        JSON.stringify({ r, queued, notQueued: notQueued.map((e) => e.msg) })]);
      await guard('2.85 (d4): a ready hand-back whose checks fail is not queued, and the reason is put on the task once (task.train.unity.not_queued); a hand-back that does not say ready is left alone', () => [
        bad && !r.queue?.includes(bad) && notQueued.filter((e) => e.task === bad).length === 1 && /Golden-Reason/.test(notQueued[0]?.msg || '') && !r.cands?.includes('T-777'),
        JSON.stringify({ r, paused: out(paused).slice(-300), notQueued: notQueued.map((e) => e.msg) })]);
    }

    // ================= 5. the trailer check from the main checkout (B-138) =================
    {
      const { S, env } = studio('trailer');
      const add = node(S, ['harness/task.mjs', 'add', 'Docs: a note', '--role', 'builder', '--priority', 'P1', '--agent', 'producer-1'], env);
      const id = (out(add).match(/"id":\s*"(T-\d+)"/) || out(add).match(/\b(T-\d+)\b/) || [])[1];
      const as = { ...env, STUDIO_LOCK_OWNER: 'tr-1' };
      node(S, ['harness/task.mjs', 'start', id, '--agent', 'tr-1'], as);
      // Another role's board commit lands on main with a Golden-Reason above a blank line.
      fs.writeFileSync(path.join(S, 'board.md'), 'review\n');
      gitIn(S, 'add', '-A');
      fs.writeFileSync(path.join(S, '.msg1'), 'Board review 06:39: drifting\n\nSome findings.\nGolden-Reason: none, board only\n\nStudio-Agent: director-s9\nStudio-Task: T-500\n');
      gitIn(S, 'commit', '-q', '--no-verify', '-F', path.join(S, '.msg1'));
      fs.writeFileSync(path.join(S, 'note.md'), 'mine\n');
      gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-q', '--no-verify', '-m', `${id}: the note`);
      const fromMain = node(S, ['harness/task.mjs', 'done', id, '--agent', 'tr-1', '--check'], as);
      // Its own commit with the same mistake still blocks.
      fs.writeFileSync(path.join(S, 'note.md'), 'mine 2\n');
      gitIn(S, 'add', '-A');
      fs.writeFileSync(path.join(S, '.msg2'), `${id}: the note again\nGolden-Reason: moved on purpose\n`);
      gitIn(S, 'commit', '-q', '--no-verify', '-F', path.join(S, '.msg2'));
      const own = node(S, ['harness/task.mjs', 'done', id, '--agent', 'tr-1', '--check'], as);
      await guard('2.85 (d5, B-138): from the main checkout, another role\'s board commit with a misplaced Golden-Reason does not block a task\'s done --check; the task\'s own misplaced trailer still does, with the fix in one sentence (fails before this fix: the board commit blocked every task)', () => [
        id && !/Golden-Reason/.test(out(fromMain)) && own.status === 1 && /Golden-Reason/.test(out(own)) && !/Board review/.test(out(own))
          && /git commit --amend/.test(out(own)) && /a blank line, then Golden-Reason: .* as the last paragraph of the commit message/.test(out(own)),
        JSON.stringify({ id, fromMain: [fromMain.status, out(fromMain).slice(-600)], own: [own.status, out(own).slice(-600)] })]);

      const L = path.join(tmpRoot, `285d-lane-${process.pid}-${++n}`);
      fs.mkdirSync(L, { recursive: true });
      made.push(L);
      gitIn(L, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(L, 'a.txt'), 'a\n');
      gitIn(L, 'add', '-A'); gitIn(L, 'commit', '-qm', 'base', '--no-verify');
      const fx = probe(L, env, `import { fixTrailerBlock, misplacedTrailers } from ${u(dir, 'harness/trailers.mjs')};
const wrapped = 'Board review: drifting\\n\\nFindings.\\nGolden-Reason: none, board only,\\nno golden moved\\n\\nCo-Authored-By: C <c@example.invalid>\\n';
const fixed = fixTrailerBlock(wrapped);
const good = 'T-1: x\\n\\nGolden-Reason: ok\\n';
console.log(JSON.stringify({ fixed, same: fixTrailerBlock(good) === good }));`);
      // The hook path: a commit whose Golden-Reason sits in the body gets it moved into the trailer block.
      fs.writeFileSync(path.join(L, 'b.txt'), 'b\n');
      gitIn(L, 'add', '-A');
      fs.writeFileSync(path.join(L, '.m'), 'Board review: drifting\n\nFindings.\nGolden-Reason: none, board only\n\nStudio-Agent: director-s9\n');
      const fixRun = node(L, [path.join(dir, 'harness', 'trailers.mjs'), 'fix', path.join(L, '.m')], env);
      gitIn(L, 'commit', '-q', '--no-verify', '-F', path.join(L, '.m'));
      const after = probe(L, env, `import { misplacedTrailers } from ${u(dir, 'harness/trailers.mjs')};
console.log(JSON.stringify({ found: misplacedTrailers(process.cwd(), 'HEAD~1', 'HEAD', 'Golden-Reason').length }));`);
      await guard('2.85 (d5, B-138): the commit-msg hook\'s fixer (node harness/trailers.mjs fix <file>) moves a Golden-Reason line from the body (joining a wrapped second line) into the last paragraph, before the trailers there, so git reads it; a message already right is left alone (fails before this fix: no fixer, the hook\'s trailers left it above a blank line)', () => [
        fx.fixed === 'Board review: drifting\n\nFindings.\n\nGolden-Reason: none, board only, no golden moved\nCo-Authored-By: C <c@example.invalid>\n' && fx.same === true && fixRun.status === 0 && after.found === 0,
        JSON.stringify({ fx, fixRun: out(fixRun), after })]);
    }

    // ================= 6. the gate CLI with no branch =================
    {
      const { S, ev, env } = studio('gate', { git: true });
      const gjF = path.join(S, 'studio', 'game.json');
      let gj = {};
      try { gj = JSON.parse(fs.readFileSync(gjF, 'utf8')); } catch { gj = {}; }
      gj.engines = { unity: { land: 'node -e 0 {branch}', target: 'unity/main' } };
      fs.writeFileSync(gjF, `${JSON.stringify(gj, null, 2)}\n`);
      const r = node(S, ['harness/unity-gate.mjs', '--engine', 'unity'], env);
      const help = node(S, ['harness/unity-gate.mjs', '--help'], env);
      const evs = events(ev);
      await guard('2.85 (d6): `node harness/unity-gate.mjs --engine unity` with no --task and no --branch (an agent\'s probe) runs no land: it prints how to call it, exits 2, and writes no engine.land error or job.done; --help exits 0 (fails before this fix: "Unity land: error (the land command needs {branch} ...)" and a failed job)', () => [
        r.status === 2 && /Usage: node harness\/unity-gate\.mjs --task <ID>/.test(out(r)) && /Nothing was run/.test(out(r)) && help.status === 0
          && !evs.some((e) => e.type === 'engine.land' || (e.type === 'job.done' && /gate/.test(e.meta?.kind || ''))),
        JSON.stringify({ r: [r.status, out(r).slice(-500)], evs: evs.map((e) => [e.type, e.msg]).slice(0, 10) })]);
    }
  } finally {
    for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* swept later */ } }
  }
}
