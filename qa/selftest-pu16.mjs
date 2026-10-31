/**
 * qa/selftest-pu16.mjs — 2.57.0 (PU-16): crash-safe studio state (P-037, P-038, P-041).
 *   P-037: an empty lock file (an agent killed between creating and writing it) made every claim recurse until the
 *          stack overflowed. Now: young → "claimed (lock being written)"; past the grace → set aside, claim once more.
 *   P-038: ten `task start` at once: 6-7 held locks, the board showed 4-5. Now the board is changed under a lock.
 *   P-041: ten parks at once kept one hold; a torn STOP.json read as "not stopped"; a torn events line swallowed
 *          the next event. Plus: lock renewals and state files are replaced whole (harness/fsafe.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftestPU16({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_LANE_INFER: 'off' };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-pu16-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  // A board of N builder tasks T-101.., nothing claimed, no holds.
  const seed = `const seed = (n = 10) => {
  let s = '# Studio Task Queue (\`studio/NEXT.md\`)\\n\\n## IN_PROGRESS\\n\\n## BACKLOG\\n';
  for (let i = 1; i <= n; i++) s += '- [ ] **T-' + (100 + i) + '** [P1] (\`builder\`) — Docs: write note ' + i + '\\n';
  fs.writeFileSync('studio/NEXT.md', s + '\\n## DONE\\n');
  fs.writeFileSync('studio/DONE.md', '# Finished tasks\\n\\n## DONE\\n');
  fs.rmSync('.studio/locks', { recursive: true, force: true });
  fs.rmSync('studio/task-holds.json', { force: true });
  fs.rmSync('.studio/STOP.json', { force: true });
};
const board = () => { let sec = null; const inP = [], back = []; for (const l of fs.readFileSync('studio/NEXT.md', 'utf8').split('\\n')) { if (/^## IN_PROGRESS/.test(l)) sec = inP; else if (/^## BACKLOG/.test(l)) sec = back; else if (/^## DONE/.test(l)) sec = null; const m = l.match(/\\*\\*(T-\\d+)\\*\\*/); if (m && sec) sec.push(m[1]); } return { inP, back }; };
const held = () => (fs.existsSync('.studio/locks') ? fs.readdirSync('.studio/locks').filter((f) => f.endsWith('.lock')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join('.studio/locks', f), 'utf8')); } catch { return {}; } }).filter((l) => String(l.key || '').startsWith('task:')).map((l) => l.key.slice(5)).sort() : []);
const cli = (args) => new Promise((res) => { const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d)); c.on('close', (code) => res({ code, out: o })); });
`;
  const head = `import fs from 'node:fs';\nimport path from 'node:path';\nimport { spawn } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\n${seed}`;

  // P-037: an empty lock file. Fresh: "claimed (lock being written)", no crash. Past the grace: set aside, claimed.
  const empty = probe('empty', `${head}
import { claim } from ${u('harness/lock.mjs')};
seed(3);
fs.mkdirSync('.studio/locks', { recursive: true });
// Make the lock file for task:T-101 exist but empty, as a killed claimer left it.
const first = claim('task:T-101', 'claude-p1');
const lf = fs.readdirSync('.studio/locks').find((f) => f.includes('T-101'));
fs.writeFileSync(path.join('.studio/locks', lf), '');
const fresh = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'claude-p2']);
const freshClaim = await cli(['harness/lock.mjs', 'claim', 'task:T-101', '--owner', 'claude-p2']);
const old = new Date(Date.now() - 60000); fs.utimesSync(path.join('.studio/locks', lf), old, old);
process.env.STUDIO_BROKEN_LOCK_GRACE_SEC = '0';
const later = await new Promise((res) => { const c = spawn(process.execPath, ['harness/task.mjs', 'start', 'T-101', '--agent', 'claude-p2'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, STUDIO_BROKEN_LOCK_GRACE_SEC: '0' } }); let o = ''; c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d)); c.on('close', (code) => res({ code, out: o })); });
const broken = fs.existsSync('.studio/locks/broken') ? fs.readdirSync('.studio/locks/broken') : [];
const now = JSON.parse(fs.readFileSync(path.join('.studio/locks', lf), 'utf8'));
console.log(JSON.stringify({ first: first.ok, fresh: { code: fresh.code, writing: /claimed \\(lock being written\\)/.test(fresh.out), overflow: /Maximum call stack|RangeError/.test(fresh.out + freshClaim.out) }, freshClaim: { code: freshClaim.code, writing: /lock being written/.test(freshClaim.out) }, later: { code: later.code, out: later.out.slice(-300) }, broken, brokenEmpty: broken.length ? fs.readFileSync(path.join('.studio/locks/broken', broken[0]), 'utf8') === '' : null, owner: now.owner, board: board().inP }));`);
  report('2.57.0 (PU-16, P-037): a fresh empty lock file is reported as "claimed (lock being written)" by task start and lock claim (no stack overflow)',
    empty.first === true && empty.fresh?.code === 1 && empty.fresh?.writing && !empty.fresh?.overflow && empty.freshClaim?.code === 1 && empty.freshClaim?.writing, JSON.stringify(empty).slice(0, 1500));
  report('2.57.0 (PU-16, P-037): an empty lock file past the grace is moved to .studio/locks/broken/ (kept, not deleted) and the next claim succeeds',
    empty.later?.code === 0 && empty.broken?.length === 1 && /^task_T-101\..+\.lock\.\d{8}T\d+Z$/.test(empty.broken[0]) && empty.brokenEmpty === true && empty.owner === 'claude-p2' && empty.board?.includes('T-101'), JSON.stringify(empty).slice(0, 1500));

  // The watcher's sweep: unreadable lock files go aside, claims and the land lock's own file stay.
  const sweep = probe('sweep', `${head}
import { claim, listLocks, sweepBrokenLocks } from ${u('harness/lock.mjs')};
seed(3);
claim('task:T-102', 'claude-s1');
fs.writeFileSync('.studio/locks/land.lock', JSON.stringify({ pid: process.pid, at: Date.now() }));
fs.writeFileSync('.studio/locks/task_T-9.0123456789.lock', '{"key":"task:T-9","own');
fs.writeFileSync('.studio/locks/task_T-8.0123456789.lock', '');
const young = sweepBrokenLocks({ graceMs: 60000 });
const moved = sweepBrokenLocks({ graceMs: 0 });
// A path claim while the land lock's file is there (it has no key): 2.56 threw a TypeError here.
const pathClaim = claim('path:cartridges/example-sim/src', 'claude-s2');
console.log(JSON.stringify({ young, moved, left: fs.readdirSync('.studio/locks').filter((f) => f.endsWith('.lock')).sort(), broken: fs.readdirSync('.studio/locks/broken').length, listed: listLocks().map((l) => l.key).sort(), pathClaim: pathClaim.ok }));`);
  report('2.57.0 (PU-16): the watcher\'s sweep sets aside unreadable lock files past the grace (none younger), leaves claims and the land lock alone; listLocks ignores the land lock\'s file, so a path claim beside it works',
    sweep.young?.length === 0 && sweep.moved?.length === 2 && sweep.broken === 2 && sweep.left?.includes('land.lock') && sweep.left?.some((f) => f.includes('T-102')) && !sweep.left?.some((f) => /T-[89]\./.test(f)) && JSON.stringify(sweep.listed) === JSON.stringify(['path:cartridges/example-sim/src', 'task:T-102']) && sweep.pathClaim === true,
    JSON.stringify(sweep).slice(0, 1500));
  const watchSrc = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8');
  report('2.57.0 (PU-16): every watch pass runs the broken-lock sweep', /sweepBrokenLocks\(\{ dryRun \}\)/.test(watchSrc), '');

  // P-038: ten task starts at once, five rounds: started == locks held == board in progress, no "not found".
  const race = probe('race', `${head}
const rounds = [];
for (let r = 0; r < 5; r++) {
  seed(10);
  const res = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(['harness/task.mjs', 'start', 'T-' + (101 + i), '--agent', 'racer-' + r + '-' + i])));
  const b = board();
  rounds.push({ started: res.filter((x) => x.code === 0).length, notFound: res.filter((x) => /not found/i.test(x.out)).length, held: held().length, inProgress: b.inP.length, backlog: b.back.length, errs: res.filter((x) => x.code !== 0).map((x) => x.out.slice(-200)) });
}
console.log(JSON.stringify({ rounds }));`);
  report('2.57.0 (PU-16, P-038): 10 task starts on 10 tasks at the same moment, 5 rounds: every round 10 started, 10 locks held, 10 in progress on the board, none "not found"',
    race.rounds?.length === 5 && race.rounds.every((r) => r.started === 10 && r.held === 10 && r.inProgress === 10 && r.backlog === 0 && r.notFound === 0), JSON.stringify(race).slice(0, 2000));

  // P-041: ten parks at once keep ten holds.
  const parks = probe('parks', `${head}
seed(10);
const res = await Promise.all(Array.from({ length: 10 }, (_, i) => cli(['harness/task.mjs', 'park', 'T-' + (101 + i), '--by', 'parker-' + i, '--why', 'test park ' + i])));
const h = JSON.parse(fs.readFileSync('studio/task-holds.json', 'utf8')).tasks;
console.log(JSON.stringify({ ok: res.filter((x) => x.code === 0).length, parked: Object.values(h).filter((x) => x.parked).length }));`);
  report('2.57.0 (PU-16, P-041): 10 parks at the same moment keep all 10 holds (studio/task-holds.json is changed under a lock)', parks.ok === 10 && parks.parked === 10, JSON.stringify(parks).slice(0, 1200));

  // P-041: a torn STOP.json keeps the studio stopped.
  const stop = probe('stop', `${head}
import { readStop } from ${u('harness/task.mjs')};
seed(3);
fs.mkdirSync('.studio', { recursive: true });
fs.writeFileSync('.studio/STOP.json', '{"by":"war-room-hu');
const st = readStop();
const blocked = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'claude-t1']);
const resumed = await cli(['harness/task.mjs', 'resume', '--by', 'tester']);
const after = await cli(['harness/task.mjs', 'start', 'T-101', '--agent', 'claude-t1']);
console.log(JSON.stringify({ st, blocked: { code: blocked.code, stopped: /studio is stopped/.test(blocked.out) && /unreadable/.test(blocked.out) }, resumed: resumed.code, after: after.code, stopFile: fs.existsSync('.studio/STOP.json') }));`);
  report('2.57.0 (PU-16, P-041): a half-written STOP.json counts as stopped (fail closed): task start is refused and says the stop file is unreadable; resume clears it',
    stop.st?.unreadable === true && stop.blocked?.code === 1 && stop.blocked?.stopped && stop.resumed === 0 && stop.after === 0 && stop.stopFile === false, JSON.stringify(stop).slice(0, 1200));

  // P-041: a torn last line in events.jsonl doesn't swallow the next event.
  const ev = probe('events', `${head}
import { readRecentEvents } from ${u('harness/event.mjs')};
seed(3);
fs.mkdirSync('.studio', { recursive: true });
fs.appendFileSync('.studio/events.jsonl', '{"id":"evt_torn","type":"task.st');
const r = await cli(['harness/task.mjs', 'start', 'T-102', '--agent', 'claude-e1']);
const lines = fs.readFileSync('.studio/events.jsonl', 'utf8').split('\\n');
const tornAt = lines.findIndex((l) => l.includes('evt_torn'));
const starts = readRecentEvents(0).filter((e) => e.type === 'task.start' && e.task === 'T-102' && e.agent === 'claude-e1').length;
console.log(JSON.stringify({ code: r.code, tornAlone: lines[tornAt] === '{"id":"evt_torn","type":"task.st', nextParses: (() => { try { return JSON.parse(lines[tornAt + 1]).type || null; } catch { return null; } })(), starts }));`);
  report('2.57.0 (PU-16, P-041): an events.jsonl whose last line was torn (no newline) keeps the next event whole: the torn line stays on its own line, the task.start is read back',
    ev.code === 0 && ev.tornAlone === true && Boolean(ev.nextParses) && ev.starts === 1, JSON.stringify(ev).slice(0, 1200));

  // writeAtomic: readers never see half a file, no temp files left; a lock renewal never reads as "unlocked".
  const atomic = probe('atomic', `${head}
import { fork } from 'node:child_process';
import { writeAtomic, createExclusive, withFileLock, isTempName } from ${u('harness/fsafe.mjs')};
import { claim, renewOwner, status } from ${u('harness/lock.mjs')};
if (process.argv[2] === 'reader') {
  const A = 'A'.repeat(200000), B = 'B'.repeat(150000);
  let reads = 0, bad = 0, unlocked = 0; const t0 = Date.now();
  while (Date.now() - t0 < 1500) { reads++; let s = ''; try { s = fs.readFileSync('studio/atomic-probe.txt', 'utf8'); } catch {} if (s !== A && s !== B) bad++; if (!status('task:T-109').locked) unlocked++; }
  process.send({ reads, bad, unlocked }); process.exit(0);
}
seed(10);
const A = 'A'.repeat(200000), B = 'B'.repeat(150000);
writeAtomic('studio/atomic-probe.txt', A);
claim('task:T-109', 'renewer-1', 3600);
const child = fork(fileURLToPath(import.meta.url), ['reader']);
const got = new Promise((res) => child.on('message', res));
let writes = 0, renews = 0; const t0 = Date.now();
while (Date.now() - t0 < 1600) { writeAtomic('studio/atomic-probe.txt', writes++ % 2 ? A : B, { fsync: false }); renews += renewOwner('renewer-1', 3600 + 120 + renews * 120); }
const r = await got;
for (let i = 0; i < 30; i++) { createExclusive('.studio/locks/x' + i + '.probe', 'x'); withFileLock('probe', () => writeAtomic('studio/atomic-probe.json', JSON.stringify({ i })), { dir: '.studio/locks' }); }
const temps = [...fs.readdirSync('studio'), ...fs.readdirSync('.studio/locks')].filter((n) => isTempName(n) || n.endsWith('.tmp') || n.endsWith('.mutex'));
console.log(JSON.stringify({ writes, renews, ...r, temps }));`);
  // At least 20 replacements: Windows CI managed 49 in the 1.6 s window (renames are slower there) with 6,728 reads and
  // none torn; the point is contention, not speed.
  report('2.57.0 (PU-16): writeAtomic: a reader polling while a file is replaced dozens of times never sees half of it, and no temp file is left behind',
    atomic.writes > 20 && atomic.reads > 100 && atomic.bad === 0 && Array.isArray(atomic.temps) && atomic.temps.length === 0, JSON.stringify(atomic).slice(0, 1200));
  report('2.57.0 (PU-16): a reader polling a task lock while its owner renews it never sees it unlocked (was about 29% of reads)',
    atomic.renews > 10 && atomic.reads > 100 && atomic.unlocked === 0, JSON.stringify(atomic).slice(0, 1200));

  // withFileLock: no lost update across processes; a dead holder's lock is broken; a live holder's times out cleanly.
  const fl = probe('filelock', `${head}
import { withFileLock } from ${u('harness/fsafe.mjs')};
if (process.argv[2] === 'worker') {
  for (let i = 0; i < 25; i++) withFileLock('probe-count', () => { const v = Number(fs.readFileSync('.studio/probe-count', 'utf8')); fs.writeFileSync('.studio/probe-count', String(v + 1)); }, { dir: '.studio/locks' });
  process.exit(0);
}
if (process.argv[2] === 'holder') { withFileLock('probe-held', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); }, { dir: '.studio/locks' }); process.exit(0); }
fs.mkdirSync('.studio/locks', { recursive: true });
fs.writeFileSync('.studio/probe-count', '0');
const me = fileURLToPath(import.meta.url);
await Promise.all([1, 2, 3, 4].map(() => cli([me, 'worker'])));
const total = Number(fs.readFileSync('.studio/probe-count', 'utf8'));
fs.writeFileSync('.studio/locks/probe-dead.mutex', JSON.stringify({ pid: 999999, host: (await import('node:os')).hostname(), at: Date.now() }));
let t = Date.now(); const dead = withFileLock('probe-dead', () => 'ran', { dir: '.studio/locks', timeoutMs: 3000 }); const deadMs = Date.now() - t;
const holder = cli([me, 'holder']);
for (const t0 = Date.now(); !fs.existsSync('.studio/locks/probe-held.mutex') && Date.now() - t0 < 8000;) await new Promise((r) => setTimeout(r, 20));
t = Date.now(); let busy = null; try { withFileLock('probe-held', () => 'ran', { dir: '.studio/locks', timeoutMs: 400 }); } catch (err) { busy = { code: err.code, msg: err.message }; } const busyMs = Date.now() - t;
await holder;
console.log(JSON.stringify({ total, dead, deadMs, busy, busyMs, left: fs.readdirSync('.studio/locks').filter((f) => f.endsWith('.mutex')) }));`);
  report('2.57.0 (PU-16): withFileLock: 4 processes x 25 read-modify-writes lose no update; a dead holder\'s lock is broken at once; a live holder\'s makes the waiter stop after its timeout with a clear error (ELOCKBUSY), never loop',
    fl.total === 100 && fl.dead === 'ran' && fl.deadMs < 1500 && fl.busy?.code === 'ELOCKBUSY' && /being changed by another agent/.test(fl.busy?.msg || '') && fl.busyMs < 2000 && Array.isArray(fl.left) && fl.left.length === 0, JSON.stringify(fl).slice(0, 1200));

  // The Windows path (rename refused while another program holds the file): the retry logic, with a stand-in rename.
  const win = probe('winrename', `${head}
import { renameWithRetry, writeAtomic } from ${u('harness/fsafe.mjs')};
fs.mkdirSync('studio', { recursive: true });
fs.writeFileSync('studio/win-probe.txt', 'old');
let calls = 0;
const flaky = (a, b) => { if (++calls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' }); fs.renameSync(a, b); };
const anyCode = () => true;
const retried = writeAtomic('studio/win-probe.txt', 'new-1', { rename: flaky, retryable: anyCode, delays: [1, 1, 1] });
const v1 = fs.readFileSync('studio/win-probe.txt', 'utf8');
const warned = [];
const never = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
const fell = writeAtomic('studio/win-probe.txt', 'new-2', { rename: never, retryable: anyCode, delays: [1, 1], warn: (m) => warned.push(m) });
const v2 = fs.readFileSync('studio/win-probe.txt', 'utf8');
let other = null; try { renameWithRetry('studio/none-a', 'studio/none-b', { retryable: (c) => c === 'EPERM', delays: [1] }); } catch (err) { other = err.code; }
const temps = fs.readdirSync('studio').filter((n) => n.endsWith('.tmp'));
console.log(JSON.stringify({ retried, calls, v1, fell, v2, warned: warned.length, other, temps }));`);
  report('2.57.0 (PU-16): writeAtomic retries a refused rename (EPERM/EBUSY, as on Windows) and succeeds; if it stays refused it writes in place with a warning; other errors are not retried (stand-in rename: real Windows untested here)',
    win.retried === 'renamed' && win.calls === 3 && win.v1 === 'new-1' && win.fell === 'direct' && win.v2 === 'new-2' && win.warned === 1 && win.other === 'ENOENT' && win.temps?.length === 0, JSON.stringify(win).slice(0, 1200));

  const hubSrc = fs.readFileSync(path.join(dir, 'hub', 'server.mjs'), 'utf8');
  report('2.57.0 (PU-16): the hub re-watches a state file after it is replaced whole (a watch ends with the old file)', /function watchState\(/.test(hubSrc) && /ev !== 'rename'/.test(hubSrc), '');

  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('.probe-pu16-'))) fs.rmSync(path.join(dir, f), { force: true });
}
