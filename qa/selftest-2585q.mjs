/**
 * qa/selftest-2585q.mjs — 2.58.5 (H-5, H-10, H-6), from a crew orchestrator's report (harness 2.58.3, Windows):
 *   H-5  crew builders took built-but-unlanded tasks when a claim ran out: the breaker parked tasks for "claim ran out"
 *        hand-backs, an owner whose work sat built in a lane copy lost the task after 30 quiet minutes, a kept task
 *        stayed with no claim so a crew builder's own `task start` took it, and the supervisor started a builder in
 *        the seconds between `task add` and `task start`;
 *   H-10 whole-folder claims (a game's src) refused unrelated commits in other lane copies for an hour;
 *   H-6  `git merge main` in a lane was refused for files main brought in, locked by someone else.
 * Each check fails on 2.58.4.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2585Q({ dir, run, report, tmpRoot }) {
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_WATCHDOG_LAUNCH: 'off', STUDIO_AUTO_TRICKS: '0', STUDIO_LANE_INFER: 'off', STUDIO_FLOW_IDLE_MIN: '999', STUDIO_LOCK_OWNER: '', STUDIO_LANE_LOCKS: '' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const minAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  let n = 0;
  const probeIn = (root, code, env = {}) => {
    const u = (rel) => JSON.stringify(pathToFileURL(path.join(root, rel)).href);
    const f = path.join(tmpRoot, `p2585q-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code(u));
    const r = run(root, `node "${f}"`, { ...base, ...env });
    try { return JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return { error: out(r) }; }
  };
  const addIn = (root, title, env = {}) => (run(root, `node harness/task.mjs add "${title}" --role builder`, { ...base, ...env }).stdout.match(/"id":\s*"(T-\d+)"/) || [])[1];
  const readEvents = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // Make a task's claim look an hour and more old and run out, and its start event `startMin` minutes ago.
  const expire = (root, ids, evFile, startMin) => {
    const lockDir = path.join(root, '.studio', 'locks');
    for (const f of fs.readdirSync(lockDir).filter((x) => x.endsWith('.lock'))) {
      const l = readJson(path.join(lockDir, f));
      if (l && ids.map((x) => `task:${x}`).includes(l.key)) fs.writeFileSync(path.join(lockDir, f), JSON.stringify({ ...l, claimedAt: minAgo(startMin), expiresAt: minAgo(startMin - 60) }));
    }
    const lines = readEvents(evFile).map((e) => (e.type === 'task.start' && ids.includes(e.task) ? { ...e, ts: minAgo(startMin) } : e));
    fs.writeFileSync(evFile, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  };
  const appendEvents = (evFile, evs) => fs.appendFileSync(evFile, evs.map((e) => `${JSON.stringify(e)}\n`).join(''));

  // ---------- H-5a: the breaker doesn't count hand-backs the harness caused ----------
  {
    const evFile = path.join(dir, '.studio', 'events-2585q-a.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile };
    const ta = addIn(dir, 'H5a claim ran out twice', env);
    const tb = addIn(dir, 'H5a real failure twice', env);
    const r = probeIn(dir, (u) => `import { startTask, pauseTask } from ${u('harness/task.mjs')};
import { readHolds } from ${u('harness/task-hold.mjs')};
import { failingTasks } from ${u('harness/breaker.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const ta = ${JSON.stringify(ta)}, tb = ${JSON.stringify(tb)};
const flow = "The claim ran out with no running session on it: handed back by the Director's flow pass so a free builder can take it.";
const watch = 'The claim ran out. Last heard from opus-a5 12 min ago (gates.run).';
for (const note of [flow, flow, watch]) { startTask(ta, 'opus-a5'); pauseTask(ta, 'director', note, { force: true }); }
for (let i = 0; i < 2; i++) { startTask(tb, 'b-a5'); pauseTask(tb, 'b-a5', 'verify failed: golden hashes changed in the sim'); }
const evs = readRecentEvents(5000).filter((e) => e.type === 'task.paused' && e.task === ta);
const holds = readHolds();
console.log(JSON.stringify({ parkedA: Boolean(holds[ta]?.parked), parkedB: Boolean(holds[tb]?.parked?.breaker), keys: evs.map((e) => e.meta?.reasonKey || null), failing: [...failingTasks()] }));`, env);
    guard('H-5: three "claim ran out" hand-backs by the harness (flow pass, watcher) neither trip the breaker nor mark the task failing (no reason key); two real failures still park it (evidence: the breaker parked T-060, T-061, T-064 after "The claim ran out with no running session on it")', () => [
      r.parkedA === false && Array.isArray(r.keys) && r.keys.length === 3 && r.keys.every((k) => k === null) && !(r.failing || []).includes(ta) && r.parkedB === true,
      JSON.stringify(r)]);
  }

  // ---------- H-5c: task start refuses a live owner's task whose claim ran out ----------
  {
    const evFile = path.join(dir, '.studio', 'events-2585q-c.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile };
    const tc = addIn(dir, 'H5c lapsed claim, owner active', env);
    run(dir, `node harness/task.mjs start ${tc} --agent opus-c5`, { ...base, ...env });
    expire(dir, [tc], evFile, 70);
    appendEvents(evFile, [{ ts: minAgo(5), type: 'gates.run', agent: 'opus-c5', msg: 'verify: 7/7 passed' }]);
    const crew = run(dir, `node harness/task.mjs start ${tc} --agent builder-c5`, { ...base, ...env });
    const lockAfterCrew = probeIn(dir, (u) => `import { status } from ${u('harness/lock.mjs')}; console.log(JSON.stringify(status('task:${tc}')));`, env);
    const next = run(dir, 'node harness/task.mjs next --role builder --agent builder-c6', { ...base, ...env });
    const own = run(dir, `node harness/task.mjs start ${tc} --agent opus-c5`, { ...base, ...env });
    guard('H-5: a crew builder\'s `task start` on an in-progress task whose claim ran out while its owner is still active is refused and names the owner; the owner itself can start it again (evidence: T-067 built by opus-bot, taken by builder-s30 and builder-s44)', () => [
      crew.status !== 0 && /opus-c5/.test(out(crew)) && lockAfterCrew.locked !== true && own.status === 0,
      JSON.stringify({ crew: out(crew).slice(-500), lockAfterCrew, own: out(own).slice(-300), next: out(next).slice(-200) })]);
  }

  // ---------- H-5d: task add --start claims before the task is on the board ----------
  {
    const evFile = path.join(dir, '.studio', 'events-2585q-d.jsonl');
    const log = path.join(tmpRoot, `boardwrites-${process.pid}.jsonl`);
    fs.writeFileSync(path.join(tmpRoot, 'p2585q-board.mjs'), String.raw`import fs from 'node:fs';
import path from 'node:path';
const orig = fs.renameSync;
fs.renameSync = function (from, to, ...rest) {
  if (/[\\/]NEXT\.md$/.test(String(to))) {
    let text = '';
    try { text = fs.readFileSync(from, 'utf8'); } catch {}
    const lockDir = path.join(path.dirname(String(to)), '..', '.studio', 'locks');
    let locks = [];
    try { locks = fs.readdirSync(lockDir).filter((f) => f.startsWith('task_')); } catch {}
    fs.appendFileSync(process.env.BOARD_LOG, JSON.stringify({ ids: [...new Set(text.match(/T-\d+/g) || [])], locks }) + '\n');
  }
  return orig.call(this, from, to, ...rest);
};
`);
    const env = { AGENT_EVENTS_FILE: evFile, BOARD_LOG: log };
    const r = run(dir, `node --import ${JSON.stringify(pathToFileURL(path.join(tmpRoot, 'p2585q-board.mjs')).href)} harness/task.mjs add "H5d queued and started at once" --role builder --start --agent opus-d5`, { ...base, ...env });
    const id = (out(r).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const writes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const first = writes.find((w) => id && w.ids.includes(id));
    const q = probeIn(dir, (u) => `import { parseNextQueue } from ${u('harness/task.mjs')}; import { status } from ${u('harness/lock.mjs')};
const q = parseNextQueue(); const id = ${JSON.stringify(id || '')};
console.log(JSON.stringify({ inProgress: q.inProgress.some((t) => t.id === id), owner: status('task:' + id).lock?.owner || null }));`, { AGENT_EVENTS_FILE: evFile });
    const bad = run(dir, 'node harness/task.mjs add "H5d no agent" --role builder --start', { ...base, AGENT_EVENTS_FILE: evFile });
    guard('H-5: `task add --start --agent X` queues and starts the task for X, and its claim already exists at the first board write that shows it (no window for the supervisor); --start without an agent is refused (evidence: builder-s32 started on T-074 between opus-bot\'s task add and task start)', () => [
      r.status === 0 && Boolean(id) && Boolean(first) && first.locks.some((f) => f.startsWith(`task_${id}.`)) && q.inProgress === true && q.owner === 'opus-d5' && bad.status !== 0 && /--start needs --agent/.test(out(bad)),
      JSON.stringify({ r: out(r).slice(-600), id, first, q, bad: out(bad).slice(-200) })]);
  }

  // A git copy for the lane checks: the main checkout on branch main, lane copies in .lanes/.
  const g = path.join(tmpRoot, `q-git-${process.pid}`);
  fs.cpSync(dir, g, { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)$/.test(s) && !s.includes(`${path.sep}.studio${path.sep}`) && !s.endsWith(`${path.sep}.studio`) });
  try { fs.symlinkSync(path.join(dir, 'node_modules'), path.join(g, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
  const git = (cwd, args, env = {}) => run(cwd, `git -c user.name=t -c user.email=t@t.local ${args}`, env);
  git(g, 'init -q -b main');
  fs.writeFileSync(path.join(g, '.gitignore'), `${fs.existsSync(path.join(g, '.gitignore')) ? fs.readFileSync(path.join(g, '.gitignore'), 'utf8') : ''}\nnode_modules\n/.studio\n/.lanes\n`);
  fs.mkdirSync(path.join(g, 'game', 'qten'), { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(g, 'game', 'qten', `f${i}.txt`), `v${i}\n`);
  fs.mkdirSync(path.join(g, 'game', 'qten', 'big', 'sub'), { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(g, 'game', 'qten', 'big', `m${i}.txt`), `${i}\n`);
  fs.writeFileSync(path.join(g, 'game', 'qten', 'big', 'sub', 'one.txt'), '1\n');
  fs.mkdirSync(path.join(g, 'game', 'q6'), { recursive: true });
  for (const f of ['locked.txt', 'both.txt', 'only.txt']) fs.writeFileSync(path.join(g, 'game', 'q6', f), 'base\n');
  git(g, 'add -A');
  git(g, 'commit -qm base');
  const lane = (name, branch) => {
    git(g, `worktree add -q -b ${branch} .lanes/${name} HEAD`);
    const d = path.join(g, '.lanes', name);
    try { fs.symlinkSync(path.join(g, '.studio'), path.join(d, '.studio'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
    try { fs.symlinkSync(path.join(dir, 'node_modules'), path.join(d, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
    return d;
  };
  fs.mkdirSync(path.join(g, '.studio'), { recursive: true });

  // ---------- H-5b: built but not landed: the flow pass keeps it and renews the claim for its owner ----------
  {
    const evFile = path.join(g, '.studio', 'events-2585q-b.jsonl');
    const env = { AGENT_EVENTS_FILE: evFile };
    const tb = addIn(g, 'H5b built in a lane, owner quiet', env);
    const tg = addIn(g, 'H5b built, owner gone', env);
    run(g, `node harness/task.mjs start ${tb} --agent opus-b5`, { ...base, ...env });
    run(g, `node harness/task.mjs start ${tg} --agent gone-b5`, { ...base, ...env });
    // opus-b5's work: lane copy .lanes/opus-b14 (named for the orchestrator, not the agent), one commit naming the task, 2 h old.
    const old = new Date(Date.now() - 2 * 3600000);
    const commitIn = (d, id) => {
      fs.writeFileSync(path.join(d, 'game', 'qten', 'f0.txt'), `built ${id}\n`);
      git(d, 'add game/qten/f0.txt');
      git(d, `commit -qm "${id}: built, waiting to land"`, { GIT_AUTHOR_DATE: old.toISOString(), GIT_COMMITTER_DATE: old.toISOString() });
      const idx = run(d, 'git rev-parse --git-path index').stdout.trim();
      for (const p of [path.resolve(d, idx), d]) try { fs.utimesSync(p, old, old); } catch {}
    };
    commitIn(lane('opus-b14', 'lane/opus-b14-x'), tb);
    commitIn(lane('gone-b5', 'lane/gone-b5-x'), tg);
    expire(g, [tb, tg], evFile, 180);
    appendEvents(evFile, [
      { ts: minAgo(45), type: 'agent.now', agent: 'opus-b5', msg: 'waiting for a quiet machine to land' },
      { ts: minAgo(40), type: 'agent.session.end', agent: 'gone-b5', msg: 'gone-b5 ended (finished)' },
    ]);
    const r = probeIn(g, (u) => `import { flowPass } from ${u('harness/director-flow.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
import { status } from ${u('harness/lock.mjs')};
import { claimOwner } from ${u('harness/busy.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const tb = ${JSON.stringify(tb)}, tg = ${JSON.stringify(tg)};
const f = await flowPass({ fill: false });
// Hours later the task.start is older than the events read: the kept claim still names the owner.
const carried = claimOwner(tb, readRecentEvents(20000).filter((e) => e.type !== 'task.start'))?.owner || null;
const q = parseNextQueue();
const where = (id) => q.inProgress.some((t) => t.id === id) ? 'in_progress' : q.backlog.some((t) => t.id === id) ? 'backlog' : 'other';
console.log(JSON.stringify({ tb: where(tb), tg: where(tg), owner: status('task:' + tb).lock?.owner || null, carried, busy: f.busy || [], actions: f.actions }));`, env);
    guard('H-5: an owner quiet for 45 min whose lane copy (named opus-b14, not after the owner) holds a 2-hour-old commit naming the task is kept by the flow pass, and the claim is made again in the owner\'s name (its lock.kept event names the owner after the task.start is out of reach); an owner whose session ended is handed back as before (evidence: T-060/T-061/T-064 handed back by the flow pass while built and waiting to land)', () => [
      r.tb === 'in_progress' && r.owner === 'opus-b5' && r.carried === 'opus-b5' && (r.busy || []).some((b) => b.id === tb && /opus-b14/.test(b.why) && /not landed/.test(b.why)) && r.tg === 'backlog',
      JSON.stringify(r)]);
  }

  // ---------- H-10: another agent's folder lock doesn't refuse a lane copy's commit; broad by-hand claims need --wide ----------
  {
    const env = { AGENT_EVENTS_FILE: path.join(g, '.studio', 'events-2585q-10.jsonl') };
    const claimed = run(g, 'node harness/lock.mjs claim path:game/qten --owner builder-q45 --wide "a lane test"', { ...base, ...env });
    const ln = lane('lane-q10', 'lane/lane-q10-x');
    fs.writeFileSync(path.join(ln, 'game', 'qten', 'f1.txt'), 'lane edit\n');
    git(ln, 'add game/qten/f1.txt');
    const inLane = run(ln, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env });
    const blockEnv = run(ln, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env, STUDIO_LANE_LOCKS: 'block' });
    fs.writeFileSync(path.join(g, 'game', 'qten', 'f2.txt'), 'main edit\n');
    git(g, 'add game/qten/f2.txt');
    const inMain = run(g, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env });
    git(g, 'reset -q');
    git(g, 'checkout -q -- game/qten/f2.txt');
    run(g, 'node harness/lock.mjs release path:game/qten --owner builder-q45', { ...base, ...env });
    run(g, 'node harness/lock.mjs claim path:game/qten/f1.txt --owner lane-q10', { ...base, ...env });
    const ownLane = run(ln, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env });
    git(ln, 'reset -q');
    guard('H-10: in a lane copy another agent\'s folder lock is a note, not a refusal ("checked when the lane lands"); the main checkout still refuses, a lock in the lane\'s own name still refuses, and STUDIO_LANE_LOCKS=block restores the refusal (evidence: builder-s45 held path:<game>/src/game and lane commits touching the sim were refused)', () => [
      JSON.parse(claimed.stdout || '{}').ok === true && inLane.status === 0 && /checked when the lane lands/.test(out(inLane)) && inMain.status !== 0 && /builder-q45/.test(out(inMain)) && blockEnv.status !== 0 && ownLane.status !== 0 && /lane-q10/.test(out(ownLane)),
      JSON.stringify({ inLane: out(inLane).slice(-400), inMain: out(inMain).slice(-300), blockEnv: out(blockEnv).slice(-200), ownLane: out(ownLane).slice(-300) })]);
    const big = run(g, 'node harness/lock.mjs claim path:game/qten/big --owner builder-q51', { ...base, ...env });
    const root = run(g, 'node harness/lock.mjs claim path:game/qten --owner builder-q52', { ...base, ...env });
    const src = run(g, 'node harness/lock.mjs claim path:game/qten/src --owner builder-q53', { ...base, ...env });
    const wide = run(g, 'node harness/lock.mjs claim path:game/qten/big --owner builder-q54 --wide "moving every file"', { ...base, ...env });
    run(g, 'node harness/lock.mjs release path:game/qten/big --owner builder-q54', { ...base, ...env });
    const narrow = run(g, 'node harness/lock.mjs claim path:game/qten/big/sub --owner builder-q55', { ...base, ...env });
    const ok = (r) => JSON.parse(r.stdout || '{}').ok === true;
    guard('H-10: a by-hand claim on a folder of more than STUDIO_LOCK_MAX_FILES (50) tracked files, or on a game\'s folder or source root, is refused (too-wide, says to claim files); --wide and a narrow folder are allowed (evidence: builder-s51 held path:<game>/src for an hour)', () => [
      !ok(big) && /too-wide/.test(big.stdout) && /61 tracked files/.test(big.stdout) && !ok(root) && /game's folder/.test(root.stdout) && !ok(src) && /source root/.test(src.stdout) && ok(wide) && ok(narrow),
      JSON.stringify({ big: big.stdout.slice(-400), root: root.stdout.slice(-300), src: src.stdout.slice(-300), wide: wide.stdout.slice(-200), narrow: narrow.stdout.slice(-200) })]);
    run(g, 'node harness/lock.mjs release path:game/qten/big/sub --owner builder-q55', { ...base, ...env });
    run(g, 'node harness/lock.mjs release path:game/qten/f1.txt --owner lane-q10', { ...base, ...env });
  }

  // ---------- H-6: a merge commit is judged on its own diff, not on the files the merged branch brings ----------
  {
    const env = { AGENT_EVENTS_FILE: path.join(g, '.studio', 'events-2585q-6.jsonl') };
    git(g, 'checkout -q -b side6');
    fs.writeFileSync(path.join(g, 'game', 'q6', 'locked.txt'), 'from side\n');
    fs.writeFileSync(path.join(g, 'game', 'q6', 'both.txt'), 'side version\n');
    git(g, 'commit -qam side');
    git(g, 'checkout -q -b side6b main');
    fs.writeFileSync(path.join(g, 'game', 'q6', 'only.txt'), 'from side b\n');
    git(g, 'commit -qam sideb');
    git(g, 'checkout -q main');
    fs.writeFileSync(path.join(g, 'game', 'q6', 'both.txt'), 'main version\n');
    git(g, 'commit -qam main-change');
    run(g, 'node harness/lock.mjs claim path:game/q6 --owner director-q32 --wide "a merge test"', { ...base, ...env });
    git(g, 'merge --no-ff --no-commit side6');
    fs.writeFileSync(path.join(g, 'game', 'q6', 'both.txt'), 'main and side, resolved\n');
    git(g, 'add game/q6/both.txt');
    const conflicted = run(g, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env });
    git(g, 'merge --abort');
    git(g, 'merge --no-ff --no-commit side6b');
    const clean = run(g, 'node harness/lock.mjs check-staged --owner opus-q', { ...base, ...env });
    git(g, 'merge --abort');
    guard('H-6: during a merge commit the lock gate judges only files the merge doesn\'t take as they are from the merged branch: a locked file that came in unchanged passes, a conflict resolved in a locked file still fails (evidence: git merge main in lanes opus-8 and opus-14: "[locks] FAIL studio/bible/BIBLE.md is locked by director-s32")', () => [
      conflicted.status !== 0 && /both\.txt/.test(out(conflicted)) && !/locked\.txt/.test(out(conflicted)) && clean.status === 0 && /a merge/.test(out(clean)),
      JSON.stringify({ conflicted: out(conflicted).slice(-500), clean: out(clean).slice(-300) })]);
  }
  try { fs.rmSync(g, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
}
