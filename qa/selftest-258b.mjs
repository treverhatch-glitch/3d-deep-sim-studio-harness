/**
 * qa/selftest-258b.mjs — 2.58.0 part B (PU-37, PU-38, PU-42, PU-43): the board and the locks, from break tests round 2.
 *   P-052: `task done` killed between its two board writes made the task vanish. The file that gains a task is
 *          written first; a task in both files reads once (the move that was cut off counts as made).
 *   P-053: `task done` killed after the board write kept the claim forever. The watcher frees claims on tasks that
 *          are done, waiting or gone (after a grace); `task reopen` frees one left on the task it reopens.
 *   P-054: the watcher's requeue released a claim made a moment earlier. It re-checks the claim under the board lock.
 *   P-055: any error in `task start`'s board step leaked the claim. Released on every error; on Windows,
 *          EPERM/EACCES while creating a lock file are retried as "busy", and one failure no longer turns hard links off.
 *   P-056: a live but slow lock holder lost the lock after 10 s and its update was lost. Never broken on age while
 *          its process lives on this machine; a holder that lost it anyway throws ELOCKLOST before writing.
 *   P-057: board lines the parser couldn't read were dropped on the next write. Two common drifts are read as tasks;
 *          anything else is kept under "## UNREADABLE" with a warning.
 *   P-060: temp files from killed writes piled up in studio/ and .studio/. The watcher removes old ones.
 *   PU-43: path claims compared without regard to case; hook scripts kept LF; an in-place write logs an event.
 *   P-043: the land lock crashed on Windows with EPERM when land.lock was being deleted by another process at that
 *          instant (about 2 Windows CI runs in 5). EPERM/EACCES/EBUSY there count as busy and are retried.
 * Kill points use a preload that SIGKILLs the process at a chosen fs call (real kills, not mocks).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest258B({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_LANE_INFER: 'off', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_DONE_GAME_GATES: 'skip', STUDIO_VISUAL_GATE: 'off', STUDIO_AUTO_TRICKS: '0' };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-258b-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  // Preloads (node --import): SIGKILL at a chosen fs call; an fs call that fails with a chosen code; a slow `git status`.
  fs.writeFileSync(path.join(dir, '.probe-258b-killat.mjs'), String.raw`import fs from 'node:fs';
const re = new RegExp(process.env.KILLAT_RE); const op = process.env.KILLAT_OP; let n = Number(process.env.KILLAT_N || 1);
const orig = fs[op];
fs[op] = function (p, ...rest) { if (re.test(String(p)) && --n === 0) { try { fs.writeSync(2, '[killat] ' + op + ' ' + String(p) + '\n'); } catch {} process.kill(process.pid, 'SIGKILL'); } return orig.call(this, p, ...rest); };
`);
  fs.writeFileSync(path.join(dir, '.probe-258b-fail.mjs'), String.raw`import fs from 'node:fs';
const re = new RegExp(process.env.FAIL_RE); let n = Number(process.env.FAIL_N || 1); const op = process.env.FAIL_OP || 'renameSync'; const code = process.env.FAIL_CODE || 'EIO';
const orig = fs[op];
fs[op] = function (a, ...r) { if (re.test(String(a)) && n-- > 0) throw Object.assign(new Error(code + ': injected for the test, ' + op + ' ' + String(a)), { code }); return orig.call(this, a, ...r); };
`);
  fs.writeFileSync(path.join(dir, '.probe-258b-slowgit.mjs'), String.raw`import cp from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const orig = cp.spawnSync;
cp.spawnSync = function (cmd, args, ...rest) {
  if (cmd === 'git' && Array.isArray(args) && args[0] === 'status' && process.env.SLOW_MARK) {
    try { fs.writeFileSync(process.env.SLOW_MARK, String(process.pid)); } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.SLOW_MS || 4000));
  }
  return orig.call(this, cmd, args, ...rest);
};
syncBuiltinESMExports();
`);
  const pre = (name) => JSON.stringify(pathToFileURL(path.join(dir, `.probe-258b-${name}.mjs`)).href);

  // A board of N tasks T-101.. (builders, or the roles given), nothing claimed, no holds, no move note.
  const head = String.raw`import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const BT = String.fromCharCode(96);
const seed = (n = 3, roles = {}) => {
  let s = '# Studio Task Queue (' + BT + 'studio/NEXT.md' + BT + ')\n\n## IN_PROGRESS\n\n## BACKLOG\n';
  for (let i = 1; i <= n; i++) { const id = 100 + i; const role = roles[id] || 'builder'; s += '- [ ] **T-' + id + '** [P1] (' + BT + role + BT + ') — ' + (role === 'builder' ? 'Docs: write note ' : 'Plan: note ') + i + '\n'; }
  fs.writeFileSync('studio/NEXT.md', s + '\n## DONE\n');
  fs.writeFileSync('studio/DONE.md', '# Finished tasks\n\n## DONE\n');
  for (const d of ['.studio/locks', '.studio/done-running', '.studio/agents']) fs.rmSync(d, { recursive: true, force: true });
  for (const f of ['studio/task-holds.json', '.studio/STOP.json', '.studio/board-move.json']) fs.rmSync(f, { force: true });
};
const lines = (f, id) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('**' + id + '**')).length; } catch { return 0; } };
const claims = () => (fs.existsSync('.studio/locks') ? fs.readdirSync('.studio/locks').filter((f) => f.endsWith('.lock')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join('.studio/locks', f), 'utf8')); } catch { return {}; } }).filter((l) => typeof l.key === 'string') : []);
const holder = (id) => claims().find((l) => l.key === 'task:' + id)?.owner || null;
const events = () => { try { return fs.readFileSync('.studio/events.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }); } catch { return []; } };
const cli = (args, extra = {}) => new Promise((res) => { const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extra } }); let o = '', e = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (e += d)); c.on('close', (code) => res({ code, out: o, err: e })); });
const json = (s) => { try { return JSON.parse(s.slice(s.indexOf('{'))); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
`;

  // P-052 / P-053: `task done` killed at each step of its write path. The task stays findable (done, or still in
  // progress with its claim so the agent can run done again); after one watcher pass no claim is left on a done task
  // and the task is in exactly one board file.
  const kill = probe('killdone', String.raw`${head}
const points = [
  ['renameSync', '\\.board-move\\.json\\.', 'writing the move note'],
  ['linkSync', '\\.board\\.mutex\\.', 'taking the board lock'],
  ['renameSync', '\\.DONE\\.md\\.', 'replacing DONE.md'],
  ['renameSync', '\\.NEXT\\.md\\.', 'replacing NEXT.md'],
  ['rmSync', 'board-move\\.json$', 'removing the move note'],
  ['rmSync', 'board\\.mutex$', 'letting go of the board lock'],
  ['rmSync', 'task_T-102\\.[0-9a-f]+\\.lock$', 'releasing the claim'],
  ['renameSync', '\\.CURRENT_TASK\\.md\\.', 'replacing CURRENT_TASK.md'],
];
const rows = [];
for (const [op, re, at] of points) {
  seed(3, { 102: 'producer' });
  await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'a1']);
  const d = await cli(['--import', ${pre('killat')}, 'harness/task.mjs', 'done', 'T-102', '--agent', 'a1'], { KILLAT_OP: op, KILLAT_RE: re });
  const killed = /\[killat\]/.test(d.err);
  const show = await cli(['harness/task.mjs', 'show', 'T-102']);
  const lane = show.code === 0 ? json(show.out)?.lane || null : null;
  const listed = json((await cli(['harness/task.mjs', 'list', '--all'])).out);
  const shown = listed ? [...listed.inProgress, ...listed.backlog, ...listed.done].filter((t) => t.id === 'T-102').length : -1;
  await cli(['harness/watch.mjs'], { STUDIO_CLAIM_LEAK_GRACE_SEC: '0' });
  const after = { next: lines('studio/NEXT.md', 'T-102'), done: lines('studio/DONE.md', 'T-102'), claim: holder('T-102') };
  let redo = null;
  if (after.next) {
    const r = await cli(['harness/task.mjs', 'done', 'T-102', '--agent', 'a1']);
    redo = { code: r.code, next: lines('studio/NEXT.md', 'T-102'), done: lines('studio/DONE.md', 'T-102'), claim: holder('T-102') };
  }
  rows.push({ at, killed, lane, shown, after, redo });
}
console.log(JSON.stringify({ rows }));`);
  const rows = kill.rows || [];
  report('2.58.0 (P-052): `task done` killed at each of 8 steps (move note, board lock, DONE.md, NEXT.md, ..., CURRENT_TASK.md): the task is always findable, listed once, never in neither board file',
    rows.length === 8 && rows.filter((r) => r.killed).length >= 6 && rows.every((r) => ['done', 'in progress'].includes(r.lane) && r.shown === 1 && r.after.next + r.after.done === 1), JSON.stringify(kill).slice(0, 3000));
  report('2.58.0 (P-053): after each of those kills and one watcher pass, no claim is left on the done task (the watcher frees it); a task still in progress keeps its claim and a second `task done` closes it cleanly',
    rows.length === 8 && rows.every((r) => (r.after.done === 1 ? r.after.claim === null : r.after.claim === 'a1' && r.redo?.code === 0 && r.redo.done === 1 && r.redo.next === 0 && r.redo.claim === null)), JSON.stringify(kill).slice(0, 3000));

  // P-052, the other way: a reopen killed between its two writes; and a task in both files with no move note.
  const reopen = probe('reopen', String.raw`${head}
seed(3, { 102: 'producer' });
await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'a1']);
const closed = await cli(['harness/task.mjs', 'done', 'T-102', '--agent', 'a1']);
const k = await cli(['--import', ${pre('killat')}, 'harness/task.mjs', 'reopen', 'T-102', '--reason', 'the plan missed a step'], { KILLAT_OP: 'renameSync', KILLAT_RE: '\\.DONE\\.md\\.' });
const mid = { next: lines('studio/NEXT.md', 'T-102'), done: lines('studio/DONE.md', 'T-102'), lane: json((await cli(['harness/task.mjs', 'show', 'T-102'])).out)?.lane || null };
const started = await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'a2']);
const end = { code: started.code, next: lines('studio/NEXT.md', 'T-102'), done: lines('studio/DONE.md', 'T-102'), claim: holder('T-102') };
// A task in both files with no move note (a hand edit): read once, as done.
seed(3);
fs.appendFileSync('studio/DONE.md', '- [x] **T-103** [P1] (' + BT + 'builder' + BT + ') — Docs: write note 3\n');
const q = json((await cli(['harness/task.mjs', 'list', '--all'])).out);
const where = q ? { inProgress: q.inProgress.filter((t) => t.id === 'T-103').length, backlog: q.backlog.filter((t) => t.id === 'T-103').length, done: q.done.filter((t) => t.id === 'T-103').length } : null;
console.log(JSON.stringify({ closed: closed.code, killed: /\[killat\]/.test(k.err), mid, end, where }));`);
  report('2.58.0 (P-052): a reopen killed between its two writes leaves the task in both files, read as waiting (the move counts as made); the next start takes it and the board keeps one copy',
    reopen.closed === 0 && reopen.killed && reopen.mid?.next === 1 && reopen.mid?.done === 1 && reopen.mid?.lane === 'waiting' && reopen.end?.code === 0 && reopen.end.next === 1 && reopen.end.done === 0 && reopen.end.claim === 'a2', JSON.stringify(reopen).slice(0, 1500));
  report('2.58.0 (P-052): a task in both NEXT.md and DONE.md with no move note (a hand edit) is listed once, as done',
    reopen.where?.done === 1 && reopen.where.backlog === 0 && reopen.where.inProgress === 0, JSON.stringify(reopen.where));

  // P-053: the watcher's grace. A claim on a done task isn't freed while the board changed within the grace, while a
  // `task done` for it is running, or when the claim itself is fresh; it is freed (and logged) after; a claim on a
  // task in progress never is. --dry-run only reports. `task reopen` frees an old claim left on the task it reopens.
  const leak = probe('leak', String.raw`${head}
import { claim } from ${u('harness/lock.mjs')};
seed(4, { 102: 'producer', 103: 'producer' });
claim('task:T-101', 'w1'); claim('task:T-102', 'w2'); claim('task:T-104', 'w4');
// T-101 in progress; T-102 done; T-104 waiting (a start killed after its claim).
let s = fs.readFileSync('studio/NEXT.md', 'utf8').replace(/- \[ \] (\*\*T-101\*\*.*)\n/, '').replace(/- \[ \] \*\*T-102\*\*.*\n/, '').replace('## IN_PROGRESS\n', '## IN_PROGRESS\n- [>] **T-101** [P1] (' + BT + 'builder' + BT + ') — Docs: write note 1\n');
fs.writeFileSync('studio/NEXT.md', s);
fs.appendFileSync('studio/DONE.md', '- [x] **T-102** [P1] (' + BT + 'producer' + BT + ') — Plan: note 2\n');
const age = (min) => { for (const f of fs.readdirSync('.studio/locks').filter((x) => x.endsWith('.lock'))) { const p = path.join('.studio/locks', f); const l = JSON.parse(fs.readFileSync(p, 'utf8')); l.claimedAt = new Date(Date.now() - min * 60000).toISOString(); fs.writeFileSync(p, JSON.stringify(l)); } };
const board = (min) => { const t = new Date(Date.now() - min * 60000); for (const f of ['studio/NEXT.md', 'studio/DONE.md']) fs.utimesSync(f, t, t); };
age(30); // claims made 30 min ago
const fresh = await cli(['harness/watch.mjs']); // the board was just written: inside the 60 s grace
const r1 = claims().map((l) => l.key).sort();
board(5);
const dry = await cli(['harness/watch.mjs', '--dry-run']);
const r2 = claims().map((l) => l.key).sort();
fs.mkdirSync('.studio/done-running', { recursive: true });
fs.writeFileSync('.studio/done-running/T-102.json', JSON.stringify({ task: 'T-102', agent: 'w2', pid: process.pid, at: new Date().toISOString() }));
board(5);
const running = await cli(['harness/watch.mjs']);
const r3 = claims().map((l) => l.key).sort();
fs.rmSync('.studio/done-running', { recursive: true, force: true });
board(5);
const pass = await cli(['harness/watch.mjs']);
const r4 = claims().map((l) => l.key).sort();
const ev = events().filter((e) => e.type === 'lock.released' && ['w1', 'w2', 'w4'].includes(e.meta?.owner)).map((e) => e.task).sort();
// reopen frees an old claim left on the done task; a fresh one (a start in flight) stays.
seed(3, { 102: 'producer' });
await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'w5']);
const closed = await cli(['--import', ${pre('killat')}, 'harness/task.mjs', 'done', 'T-102', '--agent', 'w5'], { KILLAT_OP: 'rmSync', KILLAT_RE: 'task_T-102\\.[0-9a-f]+\\.lock$' });
const leaked = holder('T-102');
age(30);
const reo = await cli(['harness/task.mjs', 'reopen', 'T-102', '--reason', 'try again with the new plan']);
const next = await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'w6']);
console.log(JSON.stringify({ r1, dryOut: /Would release task:T-102/.test(dry.out) && /Would release task:T-104/.test(dry.out), r2, r3, r4, ev, leaked, reopened: reo.code, after: holder('T-102'), nextCode: next.code, note: /claim, left from when it was done, was released/.test(fs.readFileSync('studio/handoffs/T-102.md', 'utf8')) }));`);
  const all = ['task:T-101', 'task:T-102', 'task:T-104'];
  report('2.58.0 (P-053): the watcher frees a claim left on a done or waiting task (logged as lock.released), but not while the board changed within the grace, not while a `task done` for it runs, never on a task in progress; --dry-run only reports',
    JSON.stringify(leak.r1) === JSON.stringify(all) && leak.dryOut && JSON.stringify(leak.r2) === JSON.stringify(all) && JSON.stringify(leak.r3) === JSON.stringify(['task:T-101', 'task:T-102']) && JSON.stringify(leak.r4) === JSON.stringify(['task:T-101']) && JSON.stringify(leak.ev) === JSON.stringify(['T-102', 'T-104']), JSON.stringify(leak).slice(0, 1500));
  report('2.58.0 (P-053): `task reopen` frees the claim a killed `task done` left on the task (noted in its hand-off), so another agent can start it',
    leak.leaked === 'w5' && leak.reopened === 0 && leak.nextCode === 0 && leak.after === 'w6' && leak.note === true, JSON.stringify(leak).slice(0, 1500));

  // P-054: the watcher decides to requeue T-101 (its claim expired), then spends seconds in `git status`; meanwhile
  // b1 claims it again. The watcher must not release b1's fresh claim, so b3 can't start the same task.
  const race = probe('race', String.raw`${head}
seed(3);
await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'b1']);
const lf = fs.readdirSync('.studio/locks').find((f) => f.includes('T-101'));
const l = JSON.parse(fs.readFileSync(path.join('.studio/locks', lf), 'utf8')); l.expiresAt = new Date(Date.now() - 60000).toISOString(); fs.writeFileSync(path.join('.studio/locks', lf), JSON.stringify(l));
const mark = path.join(os.tmpdir(), 'slowgit-258b-' + process.pid);
fs.rmSync(mark, { force: true });
const w = cli(['--import', ${pre('slowgit')}, 'harness/watch.mjs'], { SLOW_MARK: mark, SLOW_MS: '5000' });
for (const t0 = Date.now(); !fs.existsSync(mark) && Date.now() - t0 < 30000;) await sleep(25);
const sawSlow = fs.existsSync(mark);
const b1 = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'b1']);
const wr = await w;
const b3 = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'b3']);
const b = fs.readFileSync('studio/NEXT.md', 'utf8');
fs.rmSync(mark, { force: true });
console.log(JSON.stringify({ sawSlow, b1: b1.code, watch: wr.out.split('\n').filter((x) => /T-101/.test(x)).join(' | ').slice(0, 300), b3: b3.code, b3says: (b3.err || '').slice(0, 200), owner: holder('T-101'), inProgress: /\[>\] \*\*T-101\*\*/.test(b) }));`);
  report('2.58.0 (P-054): a watcher requeue decided before a slow `git status` doesn\'t release the claim an agent made meanwhile: b1 keeps T-101, b3 is refused (was: b3 started it too)',
    race.sawSlow === true && race.b1 === 0 && race.b3 === 1 && race.owner === 'b1' && race.inProgress === true && /not requeued/.test(race.watch || ''), JSON.stringify(race).slice(0, 1500));

  // P-055: an error in task start's board step (an injected EIO on replacing NEXT.md) releases the claim.
  const startErr = probe('starterr', String.raw`${head}
seed(3);
const r = await cli(['--import', ${pre('fail')}, 'harness/task.mjs', 'start', 'T-101', '--agent', 'c1'], { FAIL_OP: 'renameSync', FAIL_RE: '\\.NEXT\\.md\\.', FAIL_CODE: 'EIO', FAIL_N: '100' });
const after = { claim: holder('T-101'), waiting: /- \[ \] \*\*T-101\*\*/.test(fs.readFileSync('studio/NEXT.md', 'utf8')) };
const next = json((await cli(['harness/task.mjs', 'next', '--role', 'builder'])).out)?.id || null;
const again = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'c2']);
console.log(JSON.stringify({ code: r.code, says: r.err.slice(0, 300), stack: /at .*task\.mjs/.test(r.err), after, next, again: again.code, owner: holder('T-101') }));`);
  report('2.58.0 (P-055): an error in `task start`\'s board step (injected EIO on NEXT.md) releases the claim, says so in one line, leaves the task waiting; `next` offers it and another agent starts it',
    startErr.code === 1 && /claim was released/.test(startErr.says || '') && !startErr.stack && startErr.after?.claim === null && startErr.after?.waiting === true && startErr.next === 'T-101' && startErr.again === 0 && startErr.owner === 'c2', JSON.stringify(startErr).slice(0, 1500));

  // P-055 (Windows path, with stand-ins: real Windows untested here): createExclusive retries EPERM/EACCES as busy,
  // falls back for one call only (links stay on), and reports a persistently busy name as taken, not an error.
  const cx = probe('createx', String.raw`${head}
import { createExclusive } from ${u('harness/fsafe.mjs')};
fs.mkdirSync('.studio/cx', { recursive: true });
const perm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
let calls = 0;
const flaky = (a, b) => { calls++; if (calls <= 3) throw perm(); fs.linkSync(a, b); };
const winBusy = (c) => c === 'EPERM' || c === 'EACCES' || c === 'EBUSY';
const a = createExclusive('.studio/cx/a.lock', 'A', { link: flaky, busy: winBusy, delays: [1, 1, 1, 1, 1] });
const aText = fs.readFileSync('.studio/cx/a.lock', 'utf8');
// Linux-like: EPERM from link isn't "busy": this call falls back to an exclusive create...
let l2 = 0; const never = () => { l2++; throw perm(); };
const b = createExclusive('.studio/cx/b.lock', 'B', { link: never, busy: () => false, delays: [] });
// ...and the next call in the same folder still tries a hard link first.
let l3 = 0; const counted = (x, y) => { l3++; fs.linkSync(x, y); };
const c = createExclusive('.studio/cx/c.lock', 'C', { link: counted, busy: () => false, delays: [] });
// A name held "delete pending" (link and create both refused) after the retries: taken (false), no throw.
let threw = null, d = null;
try { d = createExclusive('.studio/cx/d.lock', 'D', { link: never, open: () => { throw perm(); }, busy: winBusy, delays: [1, 1] }); } catch (err) { threw = err.code; }
const exists = createExclusive('.studio/cx/a.lock', 'again');
const temps = fs.readdirSync('.studio/cx').filter((n) => n.endsWith('.tmp'));
console.log(JSON.stringify({ a, calls, aText, b, bText: fs.readFileSync('.studio/cx/b.lock', 'utf8'), c, l3, d, threw, exists, temps }));`);
  report('2.58.0 (P-055): createExclusive retries EPERM as busy (Windows), falls back to an exclusive create for one call without turning hard links off, and reports a name still refused after the retries as taken (no throw) (stand-in link: real Windows untested here)',
    cx.a === true && cx.calls === 4 && cx.aText === 'A' && cx.b === true && cx.bText === 'B' && cx.c === true && cx.l3 === 1 && cx.d === false && cx.threw === null && cx.exists === false && cx.temps?.length === 0, JSON.stringify(cx).slice(0, 1200));

  // P-056: a holder that works 2.5 s inside the lock (staleness set to 0.8 s) and 5 increments meanwhile: 6, not 1.
  const slow = probe('slowlock', String.raw`${head}
import { withFileLock, sleepMs } from ${u('harness/fsafe.mjs')};
const me = fileURLToPath(import.meta.url);
const ctr = '.studio/probe-ctr';
if (process.argv[2] === 'slow') { withFileLock('ctr', () => { const v = Number(fs.readFileSync(ctr, 'utf8')); fs.writeFileSync('.studio/probe-holding', '1'); sleepMs(2500); fs.writeFileSync(ctr, String(v + 1)); }, { dir: '.studio/locks' }); process.exit(0); }
if (process.argv[2] === 'inc') { let busy = 0; for (let i = 0; i < 5; i++) { try { withFileLock('ctr', () => { const v = Number(fs.readFileSync(ctr, 'utf8')); fs.writeFileSync(ctr, String(v + 1)); }, { dir: '.studio/locks' }); } catch (err) { busy++; } } console.log(JSON.stringify({ busy })); process.exit(0); }
fs.mkdirSync('.studio/locks', { recursive: true });
fs.writeFileSync(ctr, '0'); fs.rmSync('.studio/probe-holding', { force: true });
const s = cli([me, 'slow'], { STUDIO_STATE_LOCK_STALE_MS: '800' });
for (const t0 = Date.now(); !fs.existsSync('.studio/probe-holding') && Date.now() - t0 < 15000;) await sleep(20);
const inc = await cli([me, 'inc'], { STUDIO_STATE_LOCK_STALE_MS: '800' });
await s;
console.log(JSON.stringify({ counter: Number(fs.readFileSync(ctr, 'utf8')), inc: json(inc.out) }));`);
  report('2.58.0 (P-056): a live lock holder on this machine is never broken on age: a holder working 2.5 s (lock "stale" after 0.8 s) plus 5 increments meanwhile ends at 6 (was 1: an update lost)',
    slow.counter === 6 && slow.inc?.busy === 0, JSON.stringify(slow).slice(0, 1200));

  const brk = probe('lockbreak', String.raw`${head}
import { withFileLock, writeAtomic } from ${u('harness/fsafe.mjs')};
import { spawnSync } from 'node:child_process';
const L = '.studio/locks';
fs.mkdirSync(L, { recursive: true });
const tok = (o) => JSON.stringify({ n: 0, ...o });
const tryLock = (name, timeoutMs, extra = {}) => { const t = Date.now(); try { return { ran: withFileLock(name, () => 'ran', { dir: L, timeoutMs, ...extra }), ms: Date.now() - t }; } catch (err) { return { code: err.code, ms: Date.now() - t }; } };
const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
fs.writeFileSync(L + '/dead.mutex', tok({ pid: deadPid, host: os.hostname(), at: Date.now() }));
const dead = tryLock('dead', 3000);
fs.writeFileSync(L + '/live.mutex', tok({ pid: process.ppid, host: os.hostname(), at: Date.now() - 60000 }));
const live = tryLock('live', 500);
fs.writeFileSync(L + '/livemax.mutex', tok({ pid: process.ppid, host: os.hostname(), at: Date.now() - 11 * 60000 }));
const liveMax = tryLock('livemax', 2000);
fs.writeFileSync(L + '/far.mutex', tok({ pid: 4242, host: 'another-pc-258b', at: Date.now() - 60000 }));
const farStale = tryLock('far', 2000);
fs.writeFileSync(L + '/near.mutex', tok({ pid: 4242, host: 'another-pc-258b', at: Date.now() }));
const farFresh = tryLock('near', 400);
// A holder whose lock is taken over while it works: its write is refused (ELOCKLOST), the file keeps the other's text.
fs.writeFileSync('studio/lost-probe.txt', 'theirs');
let inner = null, outer = null;
try { withFileLock('lost', () => { fs.writeFileSync(L + '/lost.mutex', tok({ pid: process.ppid, host: os.hostname(), at: Date.now() })); try { writeAtomic('studio/lost-probe.txt', 'mine'); } catch (err) { inner = err.code; } }, { dir: L }); } catch (err) { outer = { code: err.code, msg: err.message.slice(0, 160) }; }
console.log(JSON.stringify({ dead, live, liveMax, farStale, farFresh, inner, outer, kept: fs.readFileSync('studio/lost-probe.txt', 'utf8') }));`);
  report('2.58.0 (P-056): lock breaking: a dead holder\'s lock at once; a live one on this machine never on age (only past 10 min, a reused pid); another machine\'s when stale; a holder that lost its lock gets ELOCKLOST before writing and when it lets go',
    brk.dead?.ran === 'ran' && brk.dead.ms < 1500 && brk.live?.code === 'ELOCKBUSY' && brk.liveMax?.ran === 'ran' && brk.farStale?.ran === 'ran' && brk.farFresh?.code === 'ELOCKBUSY' && brk.inner === 'ELOCKLOST' && brk.outer?.code === 'ELOCKLOST' && brk.kept === 'theirs', JSON.stringify(brk).slice(0, 1500));

  // P-057: hand-added lines in a slightly different format, a free note, a broken line and a duplicate id survive a
  // task start: the two common drifts become tasks, the rest is kept under UNREADABLE with one warning.
  const hand = probe('handlines', String.raw`${head}
seed(3);
const add = '- [ ] **T-110** [P1] (' + BT + 'builder' + BT + ') - Docs: added with an ASCII hyphen\n' + '- [ ] **T-111** [P2] (builder) — Docs: added without backticks\n' + '- [ ] T-112 builder: not the task format\n' + 'Remember: ask about the art budget\n' + '- [ ] **T-101** [P1] (' + BT + 'builder' + BT + ') — Docs: the same id again\n';
fs.writeFileSync('studio/NEXT.md', fs.readFileSync('studio/NEXT.md', 'utf8').replace('## DONE', add + '\n## DONE'));
fs.appendFileSync('studio/DONE.md', '- [x] **T-090** [P1] (' + BT + 'builder' + BT + ') — Old work\na stray note in the done list\n');
const s1 = await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 's1']);
const n1 = fs.readFileSync('studio/NEXT.md', 'utf8'); const d1 = fs.readFileSync('studio/DONE.md', 'utf8');
const sec = (t) => (t.includes('## UNREADABLE') ? t.slice(t.indexOf('## UNREADABLE')) : '');
const s2 = await cli(['harness/task.mjs', 'start', 'T-103', '--agent', 's2']);
const n2 = fs.readFileSync('studio/NEXT.md', 'utf8');
const s3 = await cli(['harness/task.mjs', 'start', 'T-111', '--agent', 's3']);
const n3 = fs.readFileSync('studio/NEXT.md', 'utf8');
const warn = events().filter((e) => e.type === 'board.unreadable');
console.log(JSON.stringify({
  s1: s1.code, warned: /4 lines on the board/.test(s1.err) && /T-112 builder: not the task format/.test(s1.err) && /ask about the art budget/.test(s1.err),
  normal110: n1.includes('- [ ] **T-110** [P1] (' + BT + 'builder' + BT + ') — Docs: added with an ASCII hyphen'), normal111: n1.includes('- [ ] **T-111** [P2] (' + BT + 'builder' + BT + ') — Docs: added without backticks'),
  keptNext: ['- [ ] T-112 builder: not the task format', 'Remember: ask about the art budget', 'Docs: the same id again'].every((x) => sec(n1).includes(x)), keptDone: sec(d1).includes('a stray note in the done list') && d1.includes('**T-090**'),
  heading: n1.includes('## UNREADABLE (kept by the harness: fix the format)'),
  s2: s2.code, s2warned: /on the board/.test(s2.err), once: sec(n2).split('Remember: ask about the art budget').length === 2, s3: s3.code, t111: /\[>\] \*\*T-111\*\*/.test(n3), events: warn.length }));`);
  report('2.58.0 (P-057): hand-added board lines survive a task start: an ASCII hyphen or a role without backticks is read as a task and rewritten in the board\'s format; a broken line, a note and a duplicate id are kept under "## UNREADABLE" (NEXT.md and DONE.md) with one warning naming them',
    hand.s1 === 0 && hand.warned && hand.normal110 && hand.normal111 && hand.keptNext && hand.keptDone && hand.heading && hand.events === 1, JSON.stringify(hand).slice(0, 1500));
  report('2.58.0 (P-057): kept lines stay once through later writes with no new warning, and a normalised hand-added task can be started',
    hand.s2 === 0 && hand.s2warned === false && hand.once === true && hand.s3 === 0 && hand.t111 === true && hand.events === 1, JSON.stringify(hand).slice(0, 1500));

  // P-060: the watcher removes old temp files killed writers left in studio/ and .studio/ (not fresh ones, not others).
  const tmp = probe('temps', String.raw`${head}
seed(3);
fs.mkdirSync('.studio/agents', { recursive: true });
const old = new Date(Date.now() - 10 * 60000);
const mk = (f, t) => { fs.writeFileSync(f, 'x'.repeat(100)); if (t) fs.utimesSync(f, t, t); };
mk('studio/.NEXT.md.4242-mvx1-2.tmp', old); mk('.studio/agents/.a1.json.4242-mvx1-3.tmp', old); mk('studio/.DONE.md.4242-mvx1-4.tmp', null); mk('studio/notes.tmp', old); mk('studio/handoffs-x.md.4242-mvx1-5.tmp', old);
const w = await cli(['harness/watch.mjs']);
const left = (f) => fs.existsSync(f);
console.log(JSON.stringify({ said: /temps\s+Removed 2 temp file/.test(w.out), oldNext: left('studio/.NEXT.md.4242-mvx1-2.tmp'), oldAgent: left('.studio/agents/.a1.json.4242-mvx1-3.tmp'), fresh: left('studio/.DONE.md.4242-mvx1-4.tmp'), other: left('studio/notes.tmp'), noDot: left('studio/handoffs-x.md.4242-mvx1-5.tmp'), out: w.out.slice(0, 300) }));`);
  report('2.58.0 (P-060): the watcher removes temp files from killed writes older than 5 min in studio/ and .studio/ (any depth), keeps fresh ones and files that aren\'t fsafe\'s temp files, and says so',
    tmp.said && tmp.oldNext === false && tmp.oldAgent === false && tmp.fresh === true && tmp.other === true && tmp.noDot === true, JSON.stringify(tmp).slice(0, 1200));

  // P-043: the land lock (harness/merge-lane.mjs) on Windows: creating land.lock while another process deletes it
  // fails with EPERM/EACCES/EBUSY. Injected at writeFileSync on land.lock: busy, retried; other errors still throw.
  const land = probe('landlock', String.raw`${head}
import { withLandLock } from ${u('harness/merge-lane.mjs')};
const me = fileURLToPath(import.meta.url);
const ctr = '.studio/land-ctr';
const winBusy = (c) => c === 'EPERM' || c === 'EACCES' || c === 'EBUSY';
if (process.argv[2] === 'worker') { for (let i = 0; i < 5; i++) withLandLock(process.cwd(), () => { const v = Number(fs.readFileSync(ctr, 'utf8')); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); fs.writeFileSync(ctr, String(v + 1)); }); process.exit(0); }
if (process.argv[2] === 'one') { const t = Date.now(); try { console.log(JSON.stringify({ v: withLandLock(process.cwd(), () => 'ran', { waitMs: 5000, ...(process.argv[3] === 'win' ? { busy: winBusy } : {}) }), ms: Date.now() - t })); } catch (err) { console.log(JSON.stringify({ code: err.code })); } process.exit(0); }
fs.mkdirSync('.studio/locks', { recursive: true });
fs.rmSync('.studio/locks/land.lock', { force: true });
fs.writeFileSync(ctr, '0');
const inject = (code, n) => ({ FAIL_OP: 'writeFileSync', FAIL_RE: 'land\\.lock$', FAIL_CODE: code, FAIL_N: String(n) });
const ws = await Promise.all([1, 2, 3, 4].map(() => cli(['--import', ${pre('fail')}, me, 'worker'], inject('EBUSY', 3))));
const total = Number(fs.readFileSync(ctr, 'utf8'));
const one = async (mode, code) => json((await cli(['--import', ${pre('fail')}, me, 'one', mode], inject(code, 3))).out);
const winEperm = await one('win', 'EPERM');
const winEacces = await one('win', 'EACCES');
const posixEperm = await one('posix', 'EPERM');
const eio = await one('win', 'EIO');
fs.writeFileSync('.studio/locks/land.lock', JSON.stringify({ pid: 999999, at: Date.now() }));
const dead = json((await cli([me, 'one', 'posix'])).out);
console.log(JSON.stringify({ total, codes: ws.map((w) => w.code), errs: ws.map((w) => w.err.slice(0, 200)).filter(Boolean), winEperm, winEacces, posixEperm, eio, dead, left: fs.existsSync('.studio/locks/land.lock') }));`);
  report('2.58.0 (P-043): the land lock treats EPERM/EACCES/EBUSY while creating land.lock as busy and retries (Windows "delete pending"): 4 processes x 5 read-modify-writes with injected failures lose no update and none crashes; other errors still throw; a dead holder is still broken at once (stand-in errors: real Windows untested here)',
    land.total === 20 && land.codes?.every((c) => c === 0) && land.winEperm?.v === 'ran' && land.winEacces?.v === 'ran' && (process.platform === 'win32' ? land.posixEperm?.v === 'ran' : land.posixEperm?.code === 'EPERM') && land.eio?.code === 'EIO' && land.dead?.v === 'ran' && land.dead.ms < 2000 && land.left === false, JSON.stringify(land).slice(0, 1500));

  // PU-43: case-blind path claims; LF hooks; an in-place write leaves a warning event.
  const ci = probe('case', String.raw`${head}
import { claim, release, coveringLock, checkStaged, listLocks } from ${u('harness/lock.mjs')};
import { writeAtomic } from ${u('harness/fsafe.mjs')};
seed(1);
const a = claim('path:game/Branding', 'd1');
const b = claim('path:game/branding', 'd2');
const inner = claim('path:GAME/BRANDING/logo.png', 'd3');
const cover = coveringLock('game/branding/Logo.PNG')?.owner || null;
const staged = checkStaged('d2', { files: ['game/BRANDING/logo.png'] });
const rel = release('path:GAME/branding', 'd1');
const after = listLocks().map((l) => l.key);
const d2 = claim('path:game/branding', 'd2');
fs.writeFileSync('studio/inplace-probe.txt', 'old');
const mode = writeAtomic('studio/inplace-probe.txt', 'new', { rename: () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); }, retryable: () => true, delays: [1] });
const ev = events().filter((e) => e.type === 'fsafe.warning');
console.log(JSON.stringify({ a: a.ok, b: b.ok, bBy: b.lock?.owner || null, inner: inner.ok, cover, staged: staged.ok, problem: staged.problems[0] || '', released: rel.released, after, d2: d2.ok, mode, text: fs.readFileSync('studio/inplace-probe.txt', 'utf8'), ev: ev.length, evTarget: ev[0]?.target || null, evStatus: ev[0]?.status || null }));`);
  report('2.58.0 (PU-43): path claims are compared without regard to case: path:game/branding (or a file under GAME/BRANDING) clashes with path:game/Branding, coveringLock and check-staged see it, and its owner can release it in either case',
    ci.a === true && ci.b === false && ci.bBy === 'd1' && ci.inner === false && ci.cover === 'd1' && ci.staged === false && /locked by d1/.test(ci.problem) && ci.released === true && Array.isArray(ci.after) && ci.after.length === 0 && ci.d2 === true, JSON.stringify(ci).slice(0, 1200));
  report('2.58.0 (PU-43): a state file written in place (the rename kept being refused, as on Windows) leaves a fsafe.warning event naming it, not only a console line',
    ci.mode === 'direct' && ci.text === 'new' && ci.ev === 1 && ci.evTarget === 'studio/inplace-probe.txt' && ci.evStatus === 'warn', JSON.stringify(ci).slice(0, 1200));
  const attrs = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
  report('2.58.0 (PU-43): .gitattributes keeps the git hook scripts (scripts/hooks/*) on LF line endings (with CRLF, "bash\\r" isn\'t found on Windows)', /^scripts\/hooks\/\* text eol=lf$/m.test(attrs), attrs);

  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('.probe-258b-'))) fs.rmSync(path.join(dir, f), { force: true });
}
