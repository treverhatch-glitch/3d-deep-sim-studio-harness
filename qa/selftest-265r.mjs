/**
 * qa/selftest-265r.mjs — 2.65.0 (helper r): the merge train's queue and order, drift additions, trigger senders.
 *   1. B-34: `task done <ID> --train` predicts conflicts (git merge-tree): with a queued lane it queues the lane
 *      "after" that one and the train leaves it for a later train before any check or verify (the deferral event
 *      once); with main it refuses, naming file:line; a conflict only in the manifest's unionFiles is no conflict.
 *   2. Feedback 3.3: the train reads --after (task block --until): dependencies merge first within a train, a lane
 *      whose dependency hasn't landed waits, one depending on a dropped task or one not on the board is handed back.
 *   3. Drift: a session listed running with no heartbeat ever; a lane holding another open task's unlanded commits.
 *   4. Triggers: studio/triggers.json "senders": a discord/github post responds only for an owner or trusted author
 *      id; anyone else's (or no id) is at most a candidate, in shadow mode too; the shipped lists are empty.
 * Made-up studio ("demo"), made-up ids. Each check fails on 2.64.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest265R({ dir, run, report, tmpRoot, root }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const readJ = (rel, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return d; } };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const events = path.join(dir, '.studio', 'events-265r.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_PREDICT: '', STUDIO_TRAIN_MIN: '', STUDIO_TRAIN_MAX: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_HOTSPOT_ASK: '', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_THREADS: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-265r-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }

  // ---- the studio ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }], unionFiles: ['game/demo/notes/barrel.md'] }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', "console.log('notes ok');\n");
  write(dir, 'game/demo/notes/reg.md', '# Registry\n\nentries: a\n\nend\n');
  write(dir, 'game/demo/notes/m.md', '# Main\n\nvalue: 1\n\nend\n');
  write(dir, 'game/demo/notes/barrel.md', '# Barrel\nentry a\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-265r-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u('harness/worktree.mjs')};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  /** A task in its own lane copy with one committed change (from: an older main, as a lane started earlier is). */
  const lane = (agent, title, rel, text, { from = null, block = null } = {}) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    if (block) run(dir, `node harness/task.mjs block ${id} --until ${block} --by tester`, env);
    if (from) g(ld, 'reset', '-q', '--hard', from);
    write(ld, rel, typeof text === 'function' ? text(fs.readFileSync(path.join(ld, rel), 'utf8')) : text);
    g(ld, 'add', rel);
    const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}`.slice(-1500), head: g(ld, 'rev-parse', 'HEAD').stdout.trim() };
  };
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = () => { const r = run(dir, 'node harness/task.mjs train --by tester', env); let j = null; try { j = JSON.parse(String(r.stdout).slice(String(r.stdout).indexOf('{'))); } catch {} return { r, j: j || {} }; };
  const queue = () => readJ('.studio/train/queue.json', []);
  const reg = (who) => `# Registry\n\nentries: a, ${who}\n\nend\n`;
  const REL = 'game/demo/notes/reg.md';

  // ---- 1. B-34: prediction at queue time ----
  const oldMain = g(dir, 'rev-parse', 'main').stdout.trim();
  const p = lane('pr-p', 'Docs: register p', REL, reg('p'));
  const q = lane('pr-q', 'Docs: register q', REL, reg('q'));
  const qp = queueIt(p);
  const qq = queueIt(q);
  const qe = queue().find((e) => e.task === q.id);
  const pe = queue().find((e) => e.task === p.id);
  const pc = evs().filter((e) => e.type === 'task.train.predicted_conflict' && e.task === q.id);
  report('2.65.0 (B-34): task done --train predicts a conflict with a lane already queued (git merge-tree): the lane is queued marked after that task (file:line named, event task.train.predicted_conflict), the first lane isn\'t (fails on 2.64.0: queued with no prediction)',
    p.ok && q.ok && qp.status === 0 && qq.status === 0 && qe?.after?.task === p.id && !pe?.after
      && new RegExp(`predicted conflict with queued ${p.id}: game/demo/notes/reg\\.md:3`).test(out(qq)) && new RegExp(`queued after ${p.id}`).test(out(qq))
      && pc.length === 1 && pc[0].meta?.with === p.id && pc[0].meta?.files?.includes(REL),
    `${p.log}\n${q.log}\n--- queue q:\n${out(qq).slice(-1500)}\nqueue: ${JSON.stringify(queue()).slice(0, 800)}\nevents: ${JSON.stringify(pc)}`);

  // A lane that conflicts with main is refused, with the file and line.
  write(dir, 'game/demo/notes/m.md', '# Main\n\nvalue: 2\n\nend\n');
  g(dir, 'add', 'game/demo/notes/m.md'); g(dir, 'commit', '-qm', 'main moves m.md', '--no-verify');
  const z = lane('pr-z', 'Docs: change m', 'game/demo/notes/m.md', '# Main\n\nvalue: 3\n\nend\n', { from: oldMain });
  const qz = queueIt(z);
  const zr = evs().find((e) => e.type === 'task.train.predicted_conflict' && e.task === z.id);
  report('2.65.0 (B-34): a lane that conflicts with main is not queued: the refusal names game/demo/notes/m.md:3 and says to merge main (or npm run lanes -- refresh); event with refused (fails on 2.64.0: queued, found only by the train)',
    z.ok && qz.status === 1 && /conflicts with main in 1 file\(s\): game\/demo\/notes\/m\.md:3/.test(out(qz)) && /git merge main/.test(out(qz)) && /npm run lanes -- refresh/.test(out(qz)) && /Nothing was queued/.test(out(qz))
      && !queue().some((e) => e.task === z.id) && zr?.meta?.refused === true,
    `${z.log}\n${out(qz).slice(-1500)}`);

  // The train: p can't go (uncommitted work in its copy), so q, queued after p, waits without a check or a verify,
  // and its deferral is logged once over two trains. Then p lands, and q meets the real conflict (with main now).
  write(p.dir, 'game/demo/notes/p-wip.md', 'wip\n');
  g(p.dir, 'add', 'game/demo/notes/p-wip.md');
  const t1 = train();
  const t2 = train();
  const startLanes = evs().filter((e) => e.type === 'task.train.start').map((e) => e.meta?.lanes || []);
  const qDefer = evs().filter((e) => e.type === 'task.train.deferred' && e.task === q.id);
  g(p.dir, 'reset', '-q', '--hard', 'HEAD');
  const t3 = train();
  const t3b = train();
  report('2.65.0 (B-34): the train leaves a lane queued after another queued lane for a later train before checking or verifying it (not among the train\'s lanes, 0 verifies), logs that deferral once over two trains, and takes it in the train after the other lane landed (fails on 2.64.0: it was checked, verified and landed first)',
    (t1.j.deferred || []).some((d) => d.task === q.id && /queued after/.test(d.why)) && (t2.j.deferred || []).some((d) => d.task === q.id) && t1.j.verifies === 0 && t2.j.verifies === 0
      && !(t1.j.landed || []).includes(q.id) && startLanes.length >= 2 && startLanes.slice(0, 2).every((l) => !l.includes(q.id))
      && qDefer.filter((e) => e.meta?.wait === 'after').length === 1
      && (t3.j.landed || []).includes(p.id) && (t3.j.deferred || []).some((d) => d.task === q.id) && (t3b.j.dropped || []).some((d) => d.task === q.id && /main changed files this lane changed too/.test(d.why)),
    `t1 ${JSON.stringify(t1.j)}\nt2 ${JSON.stringify(t2.j)}\nt3 ${JSON.stringify(t3.j)}\nt3b ${JSON.stringify(t3b.j)}\n${out(t3b.r).slice(-1200)}\nstart ${JSON.stringify(startLanes)}\nq deferred ${JSON.stringify(qDefer.map((e) => e.meta))}`);

  // Union files: both lanes add a line at the end of the barrel; no "after", and the train lands both.
  const u1 = lane('un-1', 'Docs: barrel one', 'game/demo/notes/barrel.md', (t) => `${t}entry one\n`);
  const u2 = lane('un-2', 'Docs: barrel two', 'game/demo/notes/barrel.md', (t) => `${t}entry two\n`);
  const qu1 = queueIt(u1);
  const qu2 = queueIt(u2);
  const u2e = queue().find((e) => e.task === u2.id);
  const t4 = train();
  report('2.65.0 (B-34): a conflict only inside the manifest\'s unionFiles is no conflict: the second lane is queued with no "after" (the queue says the union driver merges it) and the train lands both (fails on 2.64.0: no such note)',
    u1.ok && u2.ok && qu1.status === 0 && qu2.status === 0 && u2e && !u2e.after && /conflict only as union files/.test(out(qu2))
      && [u1.id, u2.id].every((x) => (t4.j.landed || []).includes(x)),
    `${out(qu2).slice(-1200)}\n${JSON.stringify(t4.j)}`);

  // ---- 2. --after in the train ----
  const d1 = lane('dp-1', 'Docs: dependency base', 'game/demo/notes/d1.md', 'one\n');
  const d2 = lane('dp-2', 'Docs: dependency top', 'game/demo/notes/d2.md', 'two\n', { block: d1.id });
  queueIt(d2);
  queueIt(d1);
  const t5 = train();
  const fp = g(dir, 'rev-list', '--first-parent', 'main').stdout.trim().split('\n');
  const parents = (c) => g(dir, 'rev-list', '--parents', '-n1', c).stdout.trim().split(' ').slice(1);
  // Where a lane joined main's first-parent line: its own head (a fast-forward) or a merge whose second parent it is.
  const at = (h) => fp.findIndex((c) => c === h || parents(c).slice(1).includes(h));
  report('2.65.0 (3.3): within one train a lane merges after the lane it depends on (--after / task block --until), though it was queued first (fails on 2.64.0: queue order)',
    d1.ok && d2.ok && [d1.id, d2.id].every((x) => (t5.j.landed || []).includes(x)) && at(d1.head) > at(d2.head) && at(d2.head) >= 0,
    `${JSON.stringify(t5.j)}\n${out(t5.r).slice(-800)}\nidx d1 ${at(d1.head)} d2 ${at(d2.head)}`);

  const d4 = addTask('Docs: a dependency not started');
  const d7 = addTask('Docs: a dependency that gets dropped');
  const d3 = lane('dp-3', 'Docs: waits for an open task', 'game/demo/notes/d3.md', 'three\n', { block: d4 });
  const d5 = lane('dp-5', 'Docs: waits for a task not on the board', 'game/demo/notes/d5.md', 'five\n', { block: 'T-999' });
  const d6 = lane('dp-6', 'Docs: waits for a dropped task', 'game/demo/notes/d6.md', 'six\n', { block: d7 });
  const dr = run(dir, `node harness/task.mjs drop ${d7} --why "not needed after all" --by tester`, env);
  for (const l of [d3, d5, d6]) queueIt(l);
  const t6 = train();
  const why = (id) => (t6.j.dropped || []).find((d) => d.task === id)?.why || '';
  report('2.65.0 (3.3): a lane whose dependency is open and not landed waits for a later train (says which, 0 verifies); one depending on a task not on the board, or on a dropped task, is handed back saying so and how to clear it, never left waiting (fails on 2.64.0: all three landed)',
    dr.status === 0 && (t6.j.deferred || []).some((d) => d.task === d3.id && new RegExp(`waits for ${d4}`).test(d.why)) && !(t6.j.landed || []).length && t6.j.verifies === 0
      && /T-999 is not on the board/.test(why(d5.id)) && new RegExp(`${d7} was dropped`).test(why(d6.id)) && /unblock/.test(why(d6.id))
      && queue().some((e) => e.task === d3.id) && !queue().some((e) => [d5.id, d6.id].includes(e.task)),
    `${JSON.stringify(t6.j)}\n${out(t6.r).slice(-1000)}\ndrop: ${out(dr)}`);

  // ---- 3. drift additions ----
  const bc = path.join(tmpRoot, `borrow-265r-${process.pid}`);
  fs.mkdirSync(bc, { recursive: true });
  write(bc, 'a.txt', 'a\n'); write(bc, 'b.txt', 'b\n');
  g(bc, 'init', '-q', '-b', 'main'); g(bc, 'add', '-A'); g(bc, 'commit', '-qm', 'base');
  const tA = addTask('Docs: borrowed from');
  const tB = addTask('Docs: borrows');
  const tG = addTask('Docs: picks one');
  g(bc, 'branch', 'lane/a'); g(bc, 'worktree', 'add', '-q', path.join(bc, '.wa'), 'lane/a');
  write(path.join(bc, '.wa'), 'a.txt', 'a2\n'); g(path.join(bc, '.wa'), 'commit', '-qam', `a's work\n\nStudio-Task: ${tA}`);
  g(bc, 'branch', 'lane/b'); g(bc, 'worktree', 'add', '-q', path.join(bc, '.wb'), 'lane/b');
  write(path.join(bc, '.wb'), 'b.txt', 'b2\n'); g(path.join(bc, '.wb'), 'commit', '-qam', `b's work\n\nStudio-Task: ${tB}`);
  g(path.join(bc, '.wb'), 'merge', '-q', '--no-ff', '--no-edit', 'lane/a');
  g(bc, 'branch', 'lane/g'); g(bc, 'worktree', 'add', '-q', path.join(bc, '.wg'), 'lane/g');
  g(path.join(bc, '.wg'), 'cherry-pick', 'lane/a');
  const lbFile = path.join(dir, '.studio', 'lane-branches.json');
  const lbWas = fs.existsSync(lbFile) ? fs.readFileSync(lbFile, 'utf8') : null;
  fs.writeFileSync(lbFile, JSON.stringify({ ...(lbWas ? JSON.parse(lbWas) : {}), [tA]: 'lane/a', [tB]: 'lane/b' }));
  const probeF = path.join(dir, '.probe-265r-drift.mjs');
  fs.writeFileSync(probeF, `import { driftCheck } from ${u('harness/stall.mjs')};
const now = Date.now();
const ago = (m) => new Date(now - m * 60000).toISOString();
const s = (agent, extra) => ({ agent, role: 'builder', startedAt: ago(10), ...extra });
const raised = {};
const go = (sess, cwd) => { raised[sess.agent] = [...(raised[sess.agent] || []), ...driftCheck(sess, { cwd, now, events: [], locks: [] }).map((x) => x.signal)]; };
for (let i = 0; i < 2; i++) {
  go(s('builder-nb1', { running: true }), ${JSON.stringify(bc)});
  go(s('builder-nb2', { running: true, lastBeat: ago(1) }), ${JSON.stringify(bc)});
  go(s('builder-nb3', { running: true, startedAt: ago(2) }), ${JSON.stringify(bc)});
  go(s('builder-bb', { task: ${JSON.stringify(tB)}, lastBeat: ago(1) }), ${JSON.stringify(path.join(bc, '.wb'))});
  go(s('builder-ba', { task: ${JSON.stringify(tA)}, lastBeat: ago(1) }), ${JSON.stringify(path.join(bc, '.wa'))});
  go(s('builder-bg', { task: ${JSON.stringify(tG)}, lastBeat: ago(1) }), ${JSON.stringify(path.join(bc, '.wg'))});
}
console.log(JSON.stringify({ raised }));
`);
  const drr = run(dir, `node ${path.basename(probeF)}`, env);
  let dj = {}; try { dj = JSON.parse(String(drr.stdout).trim().split('\n').pop()); } catch {}
  if (lbWas === null) fs.rmSync(lbFile, { force: true }); else fs.writeFileSync(lbFile, lbWas);
  const checks = evs().filter((e) => e.type === 'drift.check');
  const sig = (a) => (dj.raised?.[a] || []).join(',');
  report('2.65.0 (drift): a session listed running that never sent a heartbeat 10 min after it started gets one "no-heartbeat" Check; one with a heartbeat, or started 2 min ago, gets none; nothing is stopped (fails on 2.64.0: no such Check)',
    sig('builder-nb1') === 'no-heartbeat' && sig('builder-nb2') === '' && sig('builder-nb3') === '' && checks.some((e) => e.meta?.signal === 'no-heartbeat' && e.meta?.target === 'builder-nb1' && e.to === 'producer')
      && !evs().some((e) => /session\.stall|agent\.stopped|task\.paused/.test(e.type) && /builder-n/.test(JSON.stringify(e))),
    `${out(drr).slice(-1500)}\n${JSON.stringify(checks.map((e) => e.meta)).slice(0, 1500)}`);
  const bb = checks.find((e) => e.meta?.target === 'builder-bb' && e.meta?.signal === 'borrowed-commits');
  const bg = checks.find((e) => e.meta?.target === 'builder-bg' && e.meta?.signal === 'borrowed-commits');
  report(`2.65.0 (drift): a lane that merged another open task's unlanded lane wholesale gets one "borrowed commits" Check naming that task (${tA}); a cherry-picked commit tagged with it too; the lane it borrowed from gets none (fails on 2.64.0: no such Check)`,
    sig('builder-bb') === 'borrowed-commits' && bb && new RegExp(`${tA}'s unlanded lane`).test(bb.msg) && bb.meta?.borrowed?.[0]?.task === tA && bb.meta.borrowed[0].via === 'branch'
      && sig('builder-bg') === 'borrowed-commits' && bg?.meta?.borrowed?.[0]?.via === 'trailer' && sig('builder-ba') === '',
    `${JSON.stringify(dj)}\n${JSON.stringify(checks.filter((e) => /builder-b/.test(e.meta?.target)).map((e) => ({ m: e.msg, meta: e.meta }))).slice(0, 2000)}`);

  // ---- 4. trigger senders ----
  const trigFile = path.join(dir, 'studio', 'triggers.json');
  const shipped = JSON.parse(fs.readFileSync(trigFile, 'utf8'));
  const tT = addTask('Docs: a task with a chat thread');
  const thread = (args, extra = {}) => run(dir, `node harness/threads.mjs ${args}`, { ...env, ...extra });
  const link = thread(`link discord:123456789012 ${tT} --by opus-bot`);
  const t = { ...shipped, mode: 'on', live: ['ci', 'train', 'discord', 'github'], senders: { discord: { owner: ['111111111111'], trusted: ['222222222222'] }, github: { owner: ['dana-owner'] } } };
  fs.writeFileSync(trigFile, JSON.stringify(t, null, 2));
  const post = (tag, author, source = 'discord', extra = {}) => {
    const before = evs().length;
    const r = thread(`post discord:123456789012 "note ${tag}" --source ${source} --by relay-bot${author ? ` --author ${author}` : ''}`, extra);
    const e = evs().slice(before).find((x) => (x.type === 'thread.routed' || x.type === 'thread.would_route') && x.meta?.type === 'inbound.message');
    return { r, e, meta: e?.meta || {} };
  };
  const own = post('owner', '111111111111');
  const tru = post('trusted', '222222222222');
  const other = post('other', '333333333333');
  const none = post('none', null);
  const gh = post('gh', 'Dana-Owner', 'github');
  const sh = post('shadow', '333333333333', 'discord', { STUDIO_THREADS: 'shadow' });
  fs.writeFileSync(trigFile, JSON.stringify(shipped, null, 2));
  const dflt = post('default', '111111111111', 'discord', { STUDIO_THREADS: 'on' });
  report('2.65.0 (triggers): with "senders" in studio/triggers.json a discord post responds only for an owner or trusted author id (a GitHub login without case); another id or none is at most a candidate and says so; in shadow mode the would-route is logged as a candidate (fails on 2.64.0: no sender policy)',
    link.status === 0 && own.meta.policy === 'respond' && own.meta.sender === 'owner' && tru.meta.policy === 'respond' && tru.meta.sender === 'trusted'
      && other.meta.policy === 'candidate' && other.meta.capped === true && other.meta.sender === 'untrusted' && /at most a candidate/.test(out(other.r))
      && none.meta.policy === 'candidate' && none.meta.sender === 'unknown' && gh.meta.policy === 'respond' && gh.meta.sender === 'owner'
      && sh.e?.type === 'thread.would_route' && sh.meta.policy === 'candidate' && /at most a candidate/.test(sh.e?.msg || ''),
    `${out(link)}\n${JSON.stringify([own, tru, other, none, gh, sh].map((x) => ({ m: x.meta, msg: x.e?.msg, o: out(x.r).slice(-200) })), null, 1).slice(0, 3000)}`);
  report('2.65.0 (triggers): the shipped table lists "senders" with empty owner and trusted lists, so every discord and github post is a candidate until the owner adds ids (fails on 2.64.0: no senders)',
    Array.isArray(shipped.senders?.discord?.owner) && !shipped.senders.discord.owner.length && Array.isArray(shipped.senders?.discord?.trusted) && Array.isArray(shipped.senders?.github?.owner) && !shipped.senders.github.owner.length
      && dflt.meta.policy === 'candidate' && dflt.meta.sender === 'untrusted',
    `${JSON.stringify(shipped.senders)}\n${JSON.stringify(dflt.meta)}`);

  for (const f of [laneProbe, probeF]) fs.rmSync(f, { force: true });
}
