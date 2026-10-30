/**
 * qa/selftest-231.mjs — the 2.31.0 checks, run by qa/selftest.mjs on a copy of the repo.
 * Task budgets (sessions, claimed minutes, tokens across every session on a task), gate slots (Gap 3),
 * verify scoped to a lane's changes (web and Godot lanes check in parallel), done-check accepting a scoped
 * verify only when it covers the task, and landings no longer blocked by engine cache files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest231({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel, base = dir) => JSON.stringify(pathToFileURL(path.join(base, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (code, env = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p231-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const ts = (min) => new Date(Date.UTC(2026, 9, 31, 0, 0) + min * 60000).toISOString();

  // ---- task budgets: the arithmetic ----
  const evs = [
    { type: 'task.added', task: 'T-9', ts: ts(0) },
    { type: 'agent.session.start', agent: 'builder-a', task: 'T-9', ts: ts(1) },
    { type: 'task.start', agent: 'builder-a', task: 'T-9', ts: ts(2) },
    { type: 'agent.session.end', agent: 'builder-a', tokensIn: 400000, tokensOut: 20000, meta: { cacheRead: 2000000 }, ts: ts(30) },
    { type: 'task.paused', agent: 'builder-a', task: 'T-9', ts: ts(32) },
    // a launched session that started with no task and claimed it later counts once
    { type: 'agent.session.start', agent: 'builder-b', task: null, ts: ts(40) },
    { type: 'task.start', agent: 'builder-b', task: 'T-9', ts: ts(41) },
    { type: 'agent.session.end', agent: 'builder-b', tokensIn: 100000, tokensOut: 10000, ts: ts(70) },
    { type: 'task.paused', agent: 'builder-b', task: 'T-9', ts: ts(71) },
    // an outside builder (never launched) reports its own usage
    { type: 'task.start', agent: 'grokbot-3', task: 'T-9', ts: ts(80) },
    { type: 'usage.reported', agent: 'grokbot-3', task: 'T-9', tokensIn: 50000, tokensOut: 5000, ts: ts(90) },
    // someone else's session on another task doesn't count
    { type: 'agent.session.start', agent: 'builder-c', task: 'T-8', ts: ts(91) },
    { type: 'agent.session.end', agent: 'builder-c', tokensIn: 9e6, tokensOut: 1e6, ts: ts(95) },
  ];
  const sp = probe(`import { taskSpend, overBudget } from ${u('harness/task-budget.mjs')};
const evs = ${JSON.stringify(evs)};
const now = Date.parse(${JSON.stringify(ts(100))});
const s = taskSpend('T-9', evs, now);
const under = overBudget('T-9', { events: evs, now, env: {} });
const sess = overBudget('T-9', { events: evs, now, env: { STUDIO_TASK_MAX_SESSIONS: '3' } });
const mins = overBudget('T-9', { events: evs, now, env: { STUDIO_TASK_MAX_MIN: '80', STUDIO_TASK_MAX_SESSIONS: '0' } });
const toks = overBudget('T-9', { events: evs, now, env: { STUDIO_TASK_MAX_TOKENS: '700000', STUDIO_TASK_MAX_SESSIONS: '0' } });
const off = overBudget('T-9', { events: evs, now, env: { STUDIO_TASK_MAX_SESSIONS: '1', STUDIO_TASK_BUDGET: 'off' } });
const reset = taskSpend('T-9', [...evs, { type: 'task.hold', task: 'T-9', msg: 'trever unparked T-9', ts: ${JSON.stringify(ts(101))} }], now);
console.log(JSON.stringify({ s, under: under.over, sess: sess.over, sessWhy: sess.why, mins: mins.over, toks: toks.over, off: off.over, reset }));`, { STUDIO_CACHE_READ_WEIGHT: '0.1' });
  // tokens: a = 400k + 20k + 0.1 * 2M = 620k; b = 110k; grokbot report = 55k → 785k. minutes: 30 + 30 + 20 (open claim to now) = 80.
  report('2.31.0: a task\'s spend adds every session on it (launched, claimed later, outside builders) and nothing from other tasks', sp.s?.sessions === 3 && sp.s?.minutes === 80 && sp.s?.tokens === 785000, JSON.stringify(sp));
  report('2.31.0: each limit (sessions, claimed minutes, tokens) stops a task on its own; STUDIO_TASK_BUDGET=off turns it off; an unpark starts the count again', sp.under === false && sp.sess === true && /3 sessions/.test(sp.sessWhy || '') && sp.mins === true && sp.toks === true && sp.off === false && sp.reset?.sessions === 0 && sp.reset?.tokens === 0, JSON.stringify(sp));

  // ---- task budgets: task start refuses and parks, unpark lets it run again ----
  {
    const env = { STUDIO_TASK_MAX_SESSIONS: '2', STUDIO_BREAKER: 'off', STUDIO_REFILL_WAKE: 'off' };
    const add = run(dir, 'node harness/task.mjs add "Budget probe: wire the gate to the board" --role builder', env);
    const id = (out(add).match(/T-\d+/) || [])[0];
    const s1 = run(dir, `node harness/task.mjs start ${id} --agent outside-a`, env);
    run(dir, `node harness/task.mjs pause ${id} --agent outside-a --note "stopping for the night"`, env);
    const s2 = run(dir, `node harness/task.mjs start ${id} --agent outside-b`, env);
    run(dir, `node harness/task.mjs pause ${id} --agent outside-b --note "stopping again"`, env);
    const s3 = run(dir, `node harness/task.mjs start ${id} --agent outside-c`, env);
    const holds = run(dir, 'node harness/task.mjs holds', env);
    run(dir, `node harness/task.mjs unpark ${id} --by trever`, env);
    const s4 = run(dir, `node harness/task.mjs start ${id} --agent outside-d`, env);
    report('2.31.0: task start refuses a task over its budget and parks it with the numbers; an unpark lets it start again', Boolean(id) && s1.status === 0 && s2.status === 0 && s3.status !== 0 && /used its budget: 2 sessions/.test(out(s3)) && /parked \(budget/.test(out(holds)) && s4.status === 0, [out(add), out(s1), out(s2), out(s3), out(holds), out(s4)].join('\n---\n').slice(0, 2000));
  }

  // ---- gate slots ----
  {
    const root = path.join(tmpRoot, `slots-${process.pid}`);
    fs.mkdirSync(root, { recursive: true });
    const worker = path.join(tmpRoot, `slot-worker-${process.pid}.mjs`);
    fs.writeFileSync(worker, `import { withGateSlot } from ${u('harness/merge-lane.mjs')};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const r = withGateSlot(${JSON.stringify(root)}, process.argv[2], () => { const a = Date.now(); sleep(700); return { a, b: Date.now() }; }, { log: (m) => console.error(m) });
console.log(JSON.stringify(r));`);
    const pair = (slots) => Promise.all(['w1', 'w2'].map((name) => new Promise((resolve) => {
      const c = spawn(process.execPath, [worker, name], { env: { ...process.env, STUDIO_GATE_SLOTS: String(slots), STUDIO_GATE_SLOT_POLL_MS: '50' } });
      let so = '';
      let se = '';
      c.stdout.on('data', (d) => (so += d));
      c.stderr.on('data', (d) => (se += d));
      c.on('exit', () => { try { resolve({ ...JSON.parse(so.trim().split('\n').pop()), se }); } catch { resolve({ error: so + se }); } });
    })));
    const one = await pair(1);
    const two = await pair(2);
    const overlap = ([x, y]) => x.a < y.b && y.a < x.b;
    report('2.31.0 (Gap 3): with one gate slot two heavy checks run one after the other, and the wait is logged; with two slots they run together', one.every((r) => r.a) && !overlap(one) && one.some((r) => /waiting for one of 1 gate slot/.test(r.se)) && two.every((r) => r.a) && overlap(two), JSON.stringify({ one, two }));
    fs.mkdirSync(path.join(root, '.studio', 'locks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.studio', 'locks', 'gate-slot-1.lock'), JSON.stringify({ pid: 2147480000, at: Date.now(), label: 'dead' }));
    const t0 = Date.now();
    const dead = probe(`import { withGateSlot } from ${u('harness/merge-lane.mjs')};
console.log(JSON.stringify({ v: withGateSlot(${JSON.stringify(root)}, 'x', () => 7) }));`, { STUDIO_GATE_SLOTS: '1', STUDIO_GATE_SLOT_POLL_MS: '50' });
    report('2.31.0: a gate slot held by a dead process is taken over at once', dead.v === 7 && Date.now() - t0 < 5000, JSON.stringify(dead));
  }

  // ---- verify scoped to the lane, done-check coverage, landing past engine cache files ----
  {
    const sh = (cwd, cmd) => run(cwd, cmd, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
    const repo = path.join(tmpRoot, `p231-git-${process.pid}`);
    fs.mkdirSync(repo, { recursive: true });
    for (const d of ['harness', 'scripts', 'studio']) fs.cpSync(path.join(dir, d), path.join(repo, d), { recursive: true });
    fs.cpSync(path.join(dir, 'package.json'), path.join(repo, 'package.json'));
    if (fs.existsSync(path.join(dir, 'node_modules'))) fs.symlinkSync(path.join(dir, 'node_modules'), path.join(repo, 'node_modules'), 'junction');
    const probeGate = "import fs from 'node:fs'; fs.appendFileSync(process.env.ZZ_GATE_LOG, JSON.stringify({ changed: process.env.STUDIO_GATE_CHANGED || null, paths: process.env.STUDIO_GATE_PATHS || null }) + '\\n');\n";
    fs.writeFileSync(path.join(repo, 'probe-gate.mjs'), probeGate);
    fs.writeFileSync(path.join(repo, 'studio', 'gates.json'), JSON.stringify({ gates: [{ id: 'probe', command: 'node probe-gate.mjs', required: true, lite: true }] }));
    for (const [rel, t] of [['web/g/a.js', 'a\n'], ['godot/g/w.gd', 'extends Node\n'], ['godot/g/.godot/uid_cache.bin', 'cache 1\n'], ['.gitignore', '.lanes/\n.studio/\nnode_modules\n']]) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), t); }
    const gateLog = path.join(tmpRoot, `p231-gatelog-${process.pid}.txt`);
    fs.writeFileSync(gateLog, '');
    sh(repo, 'git init -q -b main && git add -A && git commit -qm init');
    const lane = path.join(repo, '.lanes', 'builder-g1');
    sh(repo, `git worktree add -q -b lane/builder-g1 "${lane}" main`);
    fs.writeFileSync(path.join(lane, 'godot', 'g', 'w.gd'), 'extends Node\n# docks\n');
    sh(lane, 'git commit -qam "T-1 docks"');
    fs.writeFileSync(path.join(lane, 'godot', 'g', 'hud.gd'), 'extends Node\n'); // uncommitted, still in scope
    const genv = { STUDIO_MAIN_ROOT: repo, ZZ_GATE_LOG: gateLog, STUDIO_LOCK_OWNER: 'builder-g1', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '' };
    const v = run(lane, 'node scripts/run-gates.mjs', genv);
    const seen = fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const recFile = path.join(lane, '.studio', 'gates', 'builder-g1-full.json');
    const rec = fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, 'utf8')) : {};
    const ch = (seen[0]?.changed || '').split(',');
    report('2.31.0: npm run verify in a lane copy scopes the game checks to the lane\'s changes (committed and not) and passes them as engine paths too, so a Godot lane runs the Godot gate and skips web checks', v.status === 0 && /scoped to the 2 file\(s\)/.test(out(v)) && ch.includes('godot/g/w.gd') && ch.includes('godot/g/hud.gd') && !ch.some((f) => f.startsWith('web/')) && seen[0]?.paths === seen[0]?.changed && rec.scoped === true && rec.changed?.length === 2, `${out(v).slice(-1500)}\n${JSON.stringify({ seen, rec })}`);
    const all = run(lane, 'node scripts/run-gates.mjs --all', genv);
    const seen2 = fs.readFileSync(gateLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    fs.writeFileSync(path.join(repo, 'studio', 'gates.json'), JSON.stringify({ gates: [{ id: 'probe', command: 'node probe-gate.mjs', required: true }] }));
    const none = run(repo, 'node scripts/run-gates.mjs', { ...genv, STUDIO_MAIN_ROOT: '' });
    fs.writeFileSync(path.join(repo, 'studio', 'gates.json'), JSON.stringify({ gates: [{ id: 'probe', command: 'node probe-gate.mjs', required: true, lite: true }] }));
    report('2.31.0: a verify where no gate ran fails (it used to print "0/0 passed, all required gates green")', none.status !== 0 && /no gate ran/.test(out(none)), out(none).slice(-600));
    report('2.31.0: verify --all runs every game check unscoped', all.status === 0 && seen2.at(-1)?.changed === null && !/scoped to/.test(out(all)), out(all).slice(-800));

    // done-check: a scoped verify counts when it holds every file the task changed, and is refused when it doesn't.
    const gc = probe(`import fs from 'node:fs'; import path from 'node:path';
import { gatesAfter } from ${u('harness/done-check.mjs')};
const f = path.join(${JSON.stringify(dir)}, '.studio', 'gates-last-full.json');
fs.mkdirSync(path.dirname(f), { recursive: true });
fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), partial: false, scoped: true, changed: ['godot/g/w.gd', 'godot/g/hud.gd'], rows: [{ id: 'game', ok: true, required: true }] }));
const covered = gatesAfter(Date.now() - 60000, ['godot/g/w.gd']);
const missed = gatesAfter(Date.now() - 60000, ['godot/g/w.gd', 'web/g/a.js']);
console.log(JSON.stringify({ covered, missed }));`, { STUDIO_LOCK_OWNER: '' });
    report('2.31.0: done-check accepts a scoped verify that covers the task\'s files and refuses one that missed a file', gc.covered === null && /missed web\/g\/a\.js/.test(gc.missed || ''), JSON.stringify(gc));

    // Landing: a tracked Godot cache file rewritten by the gate no longer blocks deliver; it is stashed, not lost.
    fs.rmSync(path.join(lane, 'godot', 'g', 'hud.gd'));
    fs.writeFileSync(path.join(lane, 'godot', 'g', '.godot', 'uid_cache.bin'), 'cache 2 (rewritten by a headless run)\n');
    fs.writeFileSync(path.join(repo, 'web', 'g', 'a.js'), 'a2\n');
    sh(repo, 'git commit -qam "web landing meanwhile"');
    const dl = probe(`import { deliver } from ${u('harness/worktree.mjs', lane)}; console.log(JSON.stringify(deliver('T-1', { runChecks: false })));`, { ...genv, STUDIO_LOCK_OWNER: 'builder-g1' }, lane);
    const mainW = fs.readFileSync(path.join(repo, 'godot', 'g', 'w.gd'), 'utf8');
    const stash = sh(lane, 'git stash list').stdout || '';
    report('2.31.0: an engine cache file the gates rewrote doesn\'t block a landing; it is set aside in a named stash and the lane lands', dl.ok === true && /# docks/.test(mainW) && /engine cache set aside/.test(stash), JSON.stringify({ dl, stash }));

    // The refusal message no longer eats the first letter of the first path ("odot/...").
    fs.writeFileSync(path.join(lane, 'godot', 'g', 'w.gd'), 'extends Node\n# docks\n# uncommitted\n');
    const dl2 = probe(`import { deliver } from ${u('harness/worktree.mjs', lane)}; console.log(JSON.stringify(deliver('T-2', { runChecks: false })));`, { ...genv, STUDIO_LOCK_OWNER: 'builder-g1' }, lane);
    report('2.31.0: "commit your work first" names the full path (no "odot/...")', dl2.ok === false && /\(godot\/g\/w\.gd\)/.test(dl2.message || ''), JSON.stringify(dl2));
  }
}
