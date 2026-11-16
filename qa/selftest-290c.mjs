/**
 * qa/selftest-290c.mjs — 2.90 (s1 .. s6): six things a live studio's overseer lost time to.
 *   s1  "builders busy" while the ready work waits for an engine train says so, and builders-low stays quiet
 *   s2  the status line shows the engine trains beside the web train (the engine's name from studio/game.json)
 *   s3  "Waiting on yes" counts only asks that still wait for a person
 *   s4  a session that holds a machine budget slot, or whose task rides a running engine train, is working
 *   s5  idle turns count from the first commit or file edit; a refresh is never a hand-back
 *   s6  a branch that tracks the harness's remote gets a preflight WARN and an end-of-merge note
 *   s7  the pre-commit refusal for a new file under scripts/ or tools/ says where a game's own script goes
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlIn as u, gEnvOf, gitCrlfUserOf, guardCap3000Of, importInDirOf, out } from './kit.mjs';

const NOW = Date.parse('2026-03-03T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

export async function selftest290C({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const imp = importInDirOf(dir);
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitCrlfUserOf(gEnvOf(ident));
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|VERTEX)/i.test(k)) clean[k] = '';
  const base = { ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_UPGRADE_REFRESH: 'off', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-290c-${process.pid}.pem`), CI: '', NODE_OPTIONS: '' };
  let n = 0;
  const tmp = (name) => { const d = path.join(tmpRoot, `290c-${name}-${process.pid}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const studio = (name, { git = true } = {}) => {
    const S = path.join(tmpRoot, `290c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.writeFileSync(path.join(S, '.env'), '');
    const ev = path.join(S, '.studio', 'events-290c.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    if (git) { g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify'); }
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-290c-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ================= s1, s2: the line and the status text =================
  const C = await imp('harness/communicator.mjs');
  const eng = (tasks, extra = {}) => ({ engine: 'forge', label: 'Forge', running: false, batch: 0, queued: tasks.length, tasks, ...extra });
  const twelve = Array.from({ length: 12 }, (_, i) => `T-${String(i + 1).padStart(3, '0')}`);
  const facts = (o = {}) => ({
    now: NOW, t0: NOW - 3600000, supRunning: true, workers: [], landed: [], perHour: 0, blockers: [], stopFiles: [], held: [], needs: [], asks: [], events: [], train: null, trainLock: null,
    diskFreeGb: 500, crewPaused: [], queue: [], sup: null, unendedTrains: [], inProgress: [], rigLine: '', beta: { on: false }, engines: [],
    line: { running: 0, target: 5, ready: 0, text: '', lead: '', blocked: [], fresh: true, at: NOW }, ...o,
  });
  const state = { lowSince: iso(NOW - 3 * 3600000) };
  const lowKeys = (f) => C.alertsNow(f, { env: {}, state }).map((a) => a.key);

  await guard('2.90 (s1) builders-low: with 0 of 5 builders busy and nothing ready, a builders-low alert fires; with the 12 queued tasks on an engine train it does not (the line says so instead), and it still fires when 3 tasks are ready or the engine queue is empty', () => {
    const plain = lowKeys(facts()).includes('builders-low');
    const waiting = lowKeys(facts({ engines: [eng(twelve)] })).includes('builders-low');
    const ready = lowKeys(facts({ engines: [eng(twelve)], line: { running: 0, target: 5, ready: 3, text: '', lead: '', blocked: [], fresh: true, at: NOW } })).includes('builders-low');
    const empty = lowKeys(facts({ engines: [eng([])] })).includes('builders-low');
    return [plain && !waiting && ready && empty, JSON.stringify({ plain, waiting, ready, empty })];
  });
  await guard('2.90 (s1) line: the status line reads "0 of 5 builders busy: 12 tasks wait on the Forge train" (the engine\'s name from the config), "1 task waits" for one, and says nothing extra when nothing waits or the ready work is not waiting', () => {
    const line = (f) => (C.statusText(f).split('\n').find((l) => l.startsWith('Line Producer:')) || '');
    const a = line(facts({ engines: [eng(twelve)] }));
    const b = line(facts({ engines: [eng(['T-001'], { running: true, batch: 1, queued: 0 })] }));
    const c = line(facts());
    const d = line(facts({ engines: [eng(twelve)], line: { running: 0, target: 5, ready: 2, text: '', lead: '', blocked: [], fresh: true, at: NOW } }));
    return [a === 'Line Producer: 0 of 5 builders busy: 12 tasks wait on the Forge train' && /: 1 task waits on the Forge train$/.test(b) && c === 'Line Producer: 0 of 5 builders busy' && d === c, JSON.stringify({ a, b, c, d })];
  });
  await guard('2.90 (s2) status: "Train: idle" is followed by each engine train that runs or has branches queued ("Forge train: running, 3 branches, 2 queued"), named from the config; with no engine work the line is as before', () => {
    const train = (f) => (C.statusText(f).split('\n').find((l) => l.startsWith('Train')) || '');
    const a = train(facts({ engines: [eng(['T-1', 'T-2', 'T-3', 'T-4', 'T-5'], { running: true, batch: 3, queued: 2 })] }));
    const b = train(facts({ engines: [eng(['T-1', 'T-2'])] }));
    const c = train(facts({ engines: [eng([])] }));
    const d = train(facts());
    return [a === 'Train: idle; Forge train: running, 3 branches, 2 queued' && b === 'Train: idle; Forge train: not running, 2 queued' && c === 'Train: idle' && d === 'Train: idle', JSON.stringify({ a, b, c, d })];
  });
  await guard('2.90 (s2) facts: engineTrains reads each engine\'s queue and live lock files and takes its label from studio/game.json engines.<name>.label (not a fixed word); an engine with no land command is left out; a dead lock is not running', async () => {
    const R = tmp('engines');
    const put = (rel, v) => { fs.mkdirSync(path.dirname(path.join(R, rel)), { recursive: true }); fs.writeFileSync(path.join(R, rel), JSON.stringify(v)); };
    put('studio/game.json', { engines: { forge: { label: 'Forge', land: 'node land.mjs' }, quiet: { label: 'Quiet' } } });
    put('.studio/train/forge-queue.json', [{ task: 'T-001' }, { task: 'T-002' }, { task: 'T-003' }]);
    put('.studio/locks/forge-train.lock', { pid: process.pid, id: 'f-1', at: Date.now(), lanes: ['T-001'] });
    const live = await C.engineTrains(R);
    put('.studio/locks/forge-train.lock', { pid: 2147483000, id: 'f-1', at: Date.now(), lanes: ['T-001'] });
    const dead = await C.engineTrains(R);
    const f = live[0] || {};
    return [live.length === 1 && f.label === 'Forge' && f.running === true && f.batch === 1 && f.queued === 2 && f.tasks.join() === 'T-001,T-002,T-003' && dead[0]?.running === false && dead[0].queued === 3, JSON.stringify({ live, dead })];
  });

  // ================= s3: "Waiting on yes" =================
  await guard('2.90 (s3) asks: "open questions for you" counts only the asks that still wait for a person: not answered, not past the time the default applies, and not for a task that is done (fails on 2.89: it counted the expired one and the done task\'s, 4 instead of 2)', () => {
    const { S, env } = studio('asks', { git: false });
    const dirA = path.join(S, 'studio', 'asks');
    fs.mkdirSync(dirA, { recursive: true });
    const ask = (id, o) => fs.writeFileSync(path.join(dirA, `${id}.json`), JSON.stringify({ id, question: `Which colour for panel ${id}?`, options: [], default: null, why: '', by: 'builder-a', at: iso(Date.now() - 2 * 3600000), deadline: null, protected: false, status: 'open', ...o }));
    ask('A-901', { options: ['a', 'b'], default: 'a', deadline: iso(Date.now() - 3600000) });
    ask('A-902', { options: ['a', 'b'], default: 'a', deadline: iso(Date.now() + 3600000) });
    ask('A-903', { status: 'answered', answer: 'a', answeredBy: 'Dana' });
    ask('A-904', {});
    ask('A-905', { task: 'T-000' });
    const r = probe(S, env, `import * as d from ${u(S, 'harness/digest.mjs')}; import * as a from ${u(S, 'harness/ask.mjs')};
const lines = (await d.needsPerson({ now: Date.now() })).map((x) => x.line);
console.log(JSON.stringify({ lines, waiting: a.waitingAsks ? a.waitingAsks().map((x) => x.id) : null, open: a.openAsks().map((x) => x.id) }));`);
    const line = (r.lines || []).find((l) => /open question/.test(l)) || '';
    return [/^2 open questions for you/.test(line) && JSON.stringify(r.waiting) === '["A-902","A-904"]', JSON.stringify(r).slice(0, 1500)];
  });

  // ================= s4: a session running a check is working =================
  const P = await imp('harness/proc-identity.mjs');
  const S4 = await imp('harness/stall.mjs');
  const T4 = Date.now(); // heavy holders are judged against the real clock
  const st = tmp('stall');
  const lockDir = path.join(st, '.studio', 'locks');
  fs.mkdirSync(lockDir, { recursive: true });
  const wl = (name, v) => fs.writeFileSync(path.join(lockDir, name), JSON.stringify(v));
  const busy = (session) => S4.busyWait(session, { dir: path.join(st, '.studio'), now: T4, env: {} });
  const me = { pid: process.pid, identity: P.selfIdentity() };
  await guard('2.90 (s4) stall: a session that holds a machine:heavy slot is waiting on its own check (kind "check", its pid), another agent is not, a holder older than STUDIO_STALL_VERIFY_MAX_MIN (60) is not, and a dead holder is not (fails on 2.89: busyWait knew only the verify record and task done)', () => {
    wl('machine-heavy-1.lock', { ...me, at: T4 - 20 * 60000, label: 'npm test', owner: 'builder-7' });
    const mine = busy({ agent: 'builder-7', task: 'T-001' });
    const other = busy({ agent: 'builder-8', task: 'T-002' });
    wl('machine-heavy-1.lock', { ...me, at: T4 - 90 * 60000, label: 'npm test', owner: 'builder-7' });
    const old = busy({ agent: 'builder-7', task: 'T-001' });
    wl('machine-heavy-1.lock', { pid: 2147483000, at: T4 - 5 * 60000, label: 'npm test', owner: 'builder-7' });
    const dead = busy({ agent: 'builder-7', task: 'T-001' });
    fs.rmSync(path.join(lockDir, 'machine-heavy-1.lock'), { force: true });
    return [mine?.kind === 'check' && mine.pid === process.pid && other === null && old === null && dead === null, JSON.stringify({ mine, other, old, dead })];
  });
  await guard('2.90 (s4) stall: a session whose task is in the batch of a running engine train (<engine>-train.lock, live pid) is waiting on that train; another task, or a dead train, is not', () => {
    wl('forge-train.lock', { ...me, id: 'f-1', at: T4 - 10 * 60000, lanes: ['T-001', 'T-002'] });
    const mine = busy({ agent: 'porter-1', task: 'T-002' });
    const other = busy({ agent: 'porter-2', task: 'T-009' });
    wl('forge-train.lock', { pid: 2147483000, id: 'f-1', at: T4 - 10 * 60000, lanes: ['T-001', 'T-002'] });
    const dead = busy({ agent: 'porter-1', task: 'T-002' });
    return [mine?.kind === 'forge train' && other === null && dead === null, JSON.stringify({ mine, other, dead })];
  });

  // ================= s5: idle turns, hand-backs =================
  const SC = await imp('harness/session-cap.mjs');
  const turn = (i, tool) => JSON.stringify({ type: 'assistant', message: { id: `m${i}`, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, content: tool ? [{ type: 'tool_use', name: tool.name, input: tool.input || {} }] : [] } });
  const read = { name: 'Read', input: { file_path: 'a.cs' } };
  const edit = { name: 'Edit', input: { file_path: 'a.cs' } };
  const commit = { name: 'Bash', input: { command: 'git commit -qm "T-1: port"' } };
  const logOf = (steps) => steps.map((t, i) => turn(i, t)).join('\n');
  const reads = (k) => Array.from({ length: k }, () => read);
  await guard('2.90 (s5) idle turns: 90 turns of reading with no edit and no commit count 0 idle turns and the rule continues; with the first edit at turn 91 and 10 more reads it is 10 idle turns (fails on 2.89: 90 idle turns and a hand-off)', () => {
    const a = SC.sessionProgress(logOf(reads(90)));
    const b = SC.sessionProgress(logOf([...reads(90), edit, ...reads(10)]));
    const dec = SC.refreshRuleDecision({ turns: a.turns, context: 50000, idleTurns: a.idleTurns, worked: a.worked, start: 0, env: {} });
    return [a.worked === false && a.idleTurns === 0 && b.worked === true && b.idleTurns === 10 && dec.decision === 'continue', JSON.stringify({ a, b, dec: dec.decision })];
  });
  await guard('2.90 (s5) idle turns: after the first edit, 45 turns with no commit or verify still hand off at STUDIO_REFRESH_IDLE_TURNS (40), and a commit restarts the count; a session that has not worked never hands off by idle turns even when told 80', () => {
    const idle = SC.sessionProgress(logOf([...reads(30), edit, ...reads(45)]));
    const again = SC.sessionProgress(logOf([...reads(30), edit, ...reads(45), commit, ...reads(5)]));
    const hand = SC.refreshRuleDecision({ turns: idle.turns, context: 50000, idleTurns: idle.idleTurns, worked: idle.worked, start: 0, env: {} });
    const cont = SC.refreshRuleDecision({ turns: again.turns, context: 50000, idleTurns: again.idleTurns, worked: again.worked, start: 0, env: {} });
    const none = SC.refreshRuleDecision({ turns: 80, context: 50000, idleTurns: 80, worked: false, start: 0, env: {} });
    return [idle.idleTurns === 45 && hand.decision === 'handoff' && again.idleTurns === 5 && cont.decision === 'continue' && none.decision === 'continue', JSON.stringify({ idle: idle.idleTurns, hand: hand.decision, again: again.idleTurns, cont: cont.decision, none: none.decision })];
  });
  await guard('2.90 (s5) hand-backs: a refresh hand-off (its note says "A fresh session continues from this hand-back") is a harness kind, not "real": three of them in 2 h count 0 for the watchdog\'s park (loopHandBacks), and a refreshed session end is a harness kind for the crew breaker (already so on 2.89)', async () => {
    const B = await imp('harness/busy.mjs');
    const K = await imp('harness/handback-kind.mjs');
    const ev = (i, msg) => ({ ts: iso(NOW + i * 60000), type: 'task.paused', task: 'T-001', agent: `porter-${i}`, msg });
    const refresh = [1, 2, 3].map((i) => ev(i, 'Handed back T-001: read the sources, notes recorded. A fresh session continues from this hand-back'));
    const real = [4, 5, 6].map((i) => ev(i, 'Handed back T-001: could not get the build to start'));
    const kinds = refresh.map((e) => K.handBackKind(e, refresh));
    const end = { type: 'agent.session.end', agent: 'porter-1', meta: { refreshed: true, refreshNoWork: true, outcome: { task: 'T-001', done: false } } };
    return [kinds.every((k) => K.harnessKind(k)) && B.loopHandBacks('T-001', refresh, { since: 0 }).length === 0 && B.loopHandBacks('T-001', [...refresh, ...real], { since: 0 }).length === 3 && K.harnessKind(K.sessionEndKind(end)), JSON.stringify({ kinds })];
  });

  // ================= s6: the pull trap =================
  const PF = await imp('harness/upgrade-preflight.mjs');
  const bare = tmp('harness-remote');
  g(bare, 'init', '-q', '--bare', '-b', 'main');
  const work = tmp('harness-work');
  g(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"h","version":"1.0.0"}\n');
  g(work, 'add', '-A'); g(work, 'commit', '-qm', 'one', '--no-verify'); g(work, 'remote', 'add', 'origin', bare); g(work, 'push', '-q', 'origin', 'main');
  const clone = path.join(tmp('studio-clone'), 'c');
  g(path.dirname(clone), 'clone', '-q', bare, 'c');
  g(clone, 'remote', 'add', 'upstream', bare); g(clone, 'fetch', '-q', 'upstream');
  await guard('2.90 (s6) preflight: a studio branch whose upstream is on the same remote as the release ref gets a WARN "pull-trap" that says a plain git pull would merge the harness into the studio, with the one command `git branch --unset-upstream`; a ref on another remote, no ref, and a branch with no upstream get none (fails on 2.89: no such item)', async () => {
    const a = PF.pullTrap(clone, 'origin/main');
    const viaItem = (await PF.preflight({ root: clone, ref: 'origin/main', env: { ...base, STUDIO_DISK_MIN_FREE_GB: '0' } })).items.find((i) => i.id === 'pull-trap');
    const other = PF.pullTrap(clone, 'upstream/main');
    const none = PF.pullTrap(clone, '');
    g(clone, 'branch', '--unset-upstream');
    const after = PF.pullTrap(clone, 'origin/main');
    g(clone, 'branch', '--set-upstream-to', 'origin/main');
    return [a?.fix === 'git branch --unset-upstream' && /plain git pull would merge the harness into the studio/.test(a.detail) && viaItem?.status === 'WARN' && viaItem.fix === 'git branch --unset-upstream' && other === null && none === null && after === null, JSON.stringify({ a, viaItem, other, none, after })];
  });
  await guard('2.90 (s6) upgrade --merge: when it succeeds with the branch still tracking the release\'s remote, the end of the report has one "Note:" line with the same warning and `git branch --unset-upstream`, and the studio\'s git config is not changed by it; with the upstream removed there is no such line', () => {
    const { S, env } = studio('merge');
    const bare2 = tmp('merge-remote');
    g(bare2, 'init', '-q', '--bare', '-b', 'main');
    g(S, 'checkout', '-q', '-b', 'release');
    fs.writeFileSync(path.join(S, 'harness', 'zz-290c-update.mjs'), 'export const updated = true;\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(S, 'package.json'), `${JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'release 9.9.9', '--no-verify');
    g(S, 'remote', 'add', 'origin', bare2); g(S, 'push', '-q', 'origin', 'release:main');
    g(S, 'checkout', '-q', 'main');
    g(S, 'config', 'branch.main.remote', 'origin'); g(S, 'config', 'branch.main.merge', 'refs/heads/main');
    const before = g(S, 'config', '--get', 'branch.main.remote').stdout.trim();
    const r = probe(S, env, `import { upgradeMerge } from ${u(S, 'harness/upgrade-guard.mjs')};
const res = await upgradeMerge({ ref: 'origin/main', by: 'Dana', root: process.cwd() });
console.log(JSON.stringify({ ok: res.ok, lines: res.lines }));`);
    const notes = (r.lines || []).filter((l) => /^\[upgrade\] Note: /.test(l));
    const kept = g(S, 'config', '--get', 'branch.main.remote').stdout.trim();
    return [r.ok === true && notes.length === 1 && /plain git pull would merge the harness into the studio/.test(notes[0]) && /git branch --unset-upstream/.test(notes[0]) && before === 'origin' && kept === 'origin', JSON.stringify({ ok: r.ok, notes, tail: (r.lines || []).slice(-4), raw: r._raw || r._out })];
  });
  await guard('2.90 (s6) upgrade --merge: with the upstream unset the merge report has no pull-trap note', () => {
    const { S, env } = studio('merge2');
    const bare2 = tmp('merge-remote2');
    g(bare2, 'init', '-q', '--bare', '-b', 'main');
    g(S, 'checkout', '-q', '-b', 'release');
    fs.writeFileSync(path.join(S, 'harness', 'zz-290c-update.mjs'), 'export const updated = true;\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'release', '--no-verify');
    g(S, 'remote', 'add', 'origin', bare2); g(S, 'push', '-q', 'origin', 'release:main');
    g(S, 'checkout', '-q', 'main');
    const r = probe(S, env, `import { upgradeMerge } from ${u(S, 'harness/upgrade-guard.mjs')};
const res = await upgradeMerge({ ref: 'origin/main', by: 'Dana', root: process.cwd() });
console.log(JSON.stringify({ ok: res.ok, lines: res.lines }));`);
    return [r.ok === true && !(r.lines || []).some((l) => /Note: .*git pull/.test(l)), JSON.stringify({ ok: r.ok, tail: (r.lines || []).slice(-4), raw: r._raw || r._out })];
  });

  // ================= s7: where a game's own script goes =================
  await guard('2.90 (s7) pre-commit: the refusal of a NEW file under scripts/ (frozen harness, and a commit on the main checkout of a studio that works in lanes) adds the line "A game\'s own script goes in game/<name>/tools/" and the studio/game.json command note; the refusal of an edit of an existing harness file does not carry it, and both are still refused', () => {
    const { S, env } = studio('hook');
    g(S, 'config', 'core.hooksPath', 'scripts/hooks');
    g(S, 'worktree', 'add', '-q', '-b', 'lane-290c', path.join(S, '.lanes', 'a'));
    const hookEnv = { ...process.env, ...env };
    const commit = () => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'x'], { cwd: S, encoding: 'utf8', env: hookEnv, windowsHide: true });
    const reset = () => { g(S, 'reset', '-q', '--hard'); g(S, 'clean', '-fdq', '--', 'scripts', 'harness'); };
    const LINE = /A game's own script goes in game\/<name>\/tools\//;
    const res = {};
    for (const mode of ['lanes', 'frozen']) {
      fs.rmSync(path.join(S, '.studio', 'harness-frozen'), { force: true });
      if (mode === 'frozen') { g(S, 'worktree', 'remove', '--force', path.join(S, '.lanes', 'a')); fs.writeFileSync(path.join(S, '.studio', 'harness-frozen'), 'frozen\n'); }
      fs.writeFileSync(path.join(S, 'scripts', 'zz-290c-progress.mjs'), 'export const x = 1;\n');
      g(S, 'add', '-A', '--', 'scripts'); res[`${mode}New`] = commit(); reset();
      fs.appendFileSync(path.join(S, 'harness', 'event.mjs'), '// edit\n');
      g(S, 'add', '-A', '--', 'harness'); res[`${mode}Edit`] = commit(); reset();
    }
    const t = (r) => out(r);
    const ok = ['lanesNew', 'frozenNew'].every((k) => res[k].status !== 0 && LINE.test(t(res[k])) && /game\.json command/.test(t(res[k])))
      && ['lanesEdit', 'frozenEdit'].every((k) => res[k].status !== 0 && /FAIL/.test(t(res[k])) && !LINE.test(t(res[k])));
    return [ok, JSON.stringify(Object.fromEntries(Object.entries(res).map(([k, r]) => [k, [r.status, t(r).slice(-400)]])))];
  });
}
