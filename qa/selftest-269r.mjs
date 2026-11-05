/**
 * qa/selftest-269r.mjs — 2.69.0 (r): the train daemon and the flake triager (the crew orchestrator's duties 3 and 8).
 *   The orchestrator chose when to run trains, waited for a quiet PC, retried refusals and routed hand-backs by hand;
 *   it re-ran failing tests alone to decide "load or real" (game:test red in 81 of 200 runs). Now:
 *   (a) the supervisor's train daemon (harness/train-daemon.mjs) starts a train when lanes are ready by the existing
 *       STUDIO_TRAIN_MIN / WAIT_MIN rules AND the machine budget has room for a verify; never beside another train,
 *       never while halted or winding down; `train auto off|on --by` follows the decider rules;
 *   (b) after a daemon train, each handed-back lane with no running session is back on the board with the facts block
 *       (only what is missing is added), and ONE job.done (kind train, meta.auto) sums it;
 *   (c) a red verify or re-check runs each failing test file alone on the same tree (real run-gates focused runs in a
 *       made-up game) and labels it real / seed-flake / load-flake / intermittent in .studio/flakes.jsonl;
 *   (d) flaky 3 times in 7 days: studio/quarantine.json, STUDIO_TEST_QUARANTINE for the game's runner, ONE fix task;
 *       a real failure is never quarantined; the list is tier C; a game dev releases it, a worker can't; the digest
 *       shows the harness's additions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest269R({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const events = path.join(dir, '.studio', 'events-269r.jsonl');
  const ranLog = path.join(tmpRoot, `ran-269r-${process.pid}.log`);
  // A person's terminal: no agent markers (the runner itself may run inside an agent's shell).
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const env = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_GAME_GATE_RETRY: '', AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-269r-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ---- (a) the daemon's decision, on a real queue file and the existing batch rules ----
  const a = probe('decide', `import fs from 'node:fs'; import path from 'node:path';
import { trainDaemonPass } from ${u('harness/train-daemon.mjs')};
const root = path.resolve('.');
const q = path.join(root, '.studio', 'train', 'queue.json');
fs.mkdirSync(path.dirname(q), { recursive: true });
const now = Date.now();
const put = (list) => fs.writeFileSync(q, JSON.stringify(list));
const fresh = { task: 'T-1', agent: 'builder-a', dir: '/x', head: 'h1', at: new Date(now - 60000).toISOString() };
const base = { root, now, winddown: null, stopped: null, lock: null, running: null, room: { ok: true } };
let spawned = 0;
const spawnTrain = () => { spawned += 1; return { pid: 424242 }; };
const r = {};
put([fresh]);
r.go = await trainDaemonPass({ ...base, spawnTrain, env: { ...process.env, STUDIO_TRAIN_MIN: '1' } });
r.daemonFile = JSON.parse(fs.readFileSync(path.join(root, '.studio', 'train', 'daemon.json'), 'utf8'));
fs.rmSync(path.join(root, '.studio', 'train', 'daemon.json'), { force: true });
r.noRoom = await trainDaemonPass({ ...base, room: { ok: false, line: 'waiting for RAM: needs 4 GB, 1.2 free' }, spawnTrain });
r.lock = await trainDaemonPass({ ...base, lock: { id: 'x', by: 'someone', pid: process.pid }, spawnTrain });
r.running = await trainDaemonPass({ ...base, running: { pid: process.pid }, spawnTrain });
r.halted = await trainDaemonPass({ ...base, halted: { why: 'two sessions ended with exit 127' }, spawnTrain });
r.wind = await trainDaemonPass({ ...base, winddown: 'usage at 90%', spawnTrain });
r.min = await trainDaemonPass({ ...base, spawnTrain, env: { ...process.env, STUDIO_TRAIN_MIN: '2', STUDIO_TRAIN_WAIT_MIN: '10' } });
put([{ ...fresh, at: new Date(now - 11 * 60000).toISOString() }]);
r.waited = await trainDaemonPass({ ...base, spawnTrain, env: { ...process.env, STUDIO_TRAIN_MIN: '2', STUDIO_TRAIN_WAIT_MIN: '10' } });
fs.rmSync(path.join(root, '.studio', 'train', 'daemon.json'), { force: true });
put([{ ...fresh, held: { tier: 'C', why: 'protected' } }]);
r.held = await trainDaemonPass({ ...base, spawnTrain });
r.off = await trainDaemonPass({ ...base, spawnTrain, env: { ...process.env, STUDIO_TRAIN_AUTO: 'off' } });
r.spawned = spawned;
console.log(JSON.stringify(r));
`);
  const ev1 = evs();
  report('2.69.0 (r, a): the train daemon starts a train (detached, recorded in .studio/train/daemon.json, a task.train.auto_start event) when a lane is ready and the machine has room; it does not when the heavy budget has no room for a verify, another train holds the lock, its own train still runs, the supervisor is halted or winding down, or the lane is held for the owner (fails on 2.68.0: no daemon; a person or an orchestrator started every train)',
    a.go?.started === true && a.daemonFile?.pid === 424242 && ev1.some((e) => e.type === 'task.train.auto_start' && (e.meta?.lanes || []).includes('T-1'))
      && a.noRoom?.started === false && /no room on the machine for a verify: waiting for RAM/.test(a.noRoom.why)
      && a.lock?.started === false && /another train is running/.test(a.lock.why) && a.running?.started === false && /still running/.test(a.running.why)
      && a.halted?.started === false && /halted/.test(a.halted.why) && a.wind?.started === false && /winding down/.test(a.wind.why)
      && a.held?.started === false && a.off?.started === false && /STUDIO_TRAIN_AUTO/.test(a.off.why),
    JSON.stringify(a).slice(0, 2500));
  report('2.69.0 (r, a): the daemon reuses the existing batch rules: with STUDIO_TRAIN_MIN 2 one fresh lane waits ("1 of 2 lane(s) ready", STUDIO_TRAIN_WAIT_MIN); once it has waited past STUDIO_TRAIN_WAIT_MIN the train starts (fails on 2.68.0: no daemon)',
    a.min?.started === false && /1 of 2 lane\(s\) ready/.test(a.min.why) && a.waited?.started === true && /waited 11 min/.test(a.waited.why) && a.spawned === 2,
    JSON.stringify({ min: a.min, waited: a.waited, spawned: a.spawned }));

  // ---- (a) the switch: decider rules ----
  const sw = probe('switch', `import path from 'node:path';
import { setTrainAuto, trainDaemonPass } from ${u('harness/train-daemon.mjs')};
const root = path.resolve('.');
const r = {};
r.worker = await setTrainAuto(root, { on: false, by: 'builder-a' });
r.workerSession = await setTrainAuto(root, { on: false, by: 'Dana', env: { ...process.env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-b' } });
r.person = await setTrainAuto(root, { on: false, by: 'Dana', why: 'demo day' });
r.pass = await trainDaemonPass({ root, winddown: null, stopped: null, lock: null, running: null, room: { ok: true }, queue: [{ task: 'T-9', at: new Date().toISOString() }], spawnTrain: () => ({ pid: 1 }) });
r.on = await setTrainAuto(root, { on: true, by: 'Dana' });
r.pass2 = await trainDaemonPass({ root, winddown: null, stopped: null, lock: null, running: null, room: { ok: true }, queue: [{ task: 'T-9', at: new Date().toISOString() }], spawnTrain: () => ({ pid: 1 }) });
console.log(JSON.stringify(r));
`);
  report('2.69.0 (r, a): `train auto off|on --by` follows the decider rules: a worker\'s name or a launched builder session is refused; a person turns it off (the next pass says "train auto is off (by Dana …)" and starts nothing) and on again (fails on 2.68.0: no switch)',
    sw.worker?.ok === false && /worker/.test(sw.worker.message) && sw.workerSession?.ok === false && sw.person?.ok === true && sw.pass?.started === false && /train auto is off \(by Dana/.test(sw.pass.why) && sw.on?.ok === true && sw.pass2?.started === true
      && evs().some((e) => e.type === 'task.train.auto_off' && e.meta?.by === 'Dana'),
    JSON.stringify(sw).slice(0, 2000));
  try { fs.rmSync(path.join(dir, '.studio', 'train'), { recursive: true, force: true }); } catch {}

  // ---- (a) the supervisor's loop runs the daemon pass and records it; a halt keeps it from starting ----
  const sup = probe('sup', `import path from 'node:path';
import { trainDaemonTick } from ${u('harness/supervisor.mjs')};
const root = path.resolve('.');
const state = { halted: { why: 'two sessions in a row ended with exit 127' } };
const d = await trainDaemonTick(state, {}, { root, queue: [{ task: 'T-3', at: new Date(0).toISOString() }], lock: null, running: null, room: { ok: true }, stopped: null, winddown: null, spawnTrain: () => { throw new Error('must not start'); } });
const s2 = { halted: null };
const d2 = await trainDaemonTick(s2, { winddown: true, why: ['winding down: usage 91%'] }, { root, queue: [{ task: 'T-3', at: new Date(0).toISOString() }], lock: null, running: null, room: { ok: true }, stopped: null, spawnTrain: () => { throw new Error('must not start'); } });
console.log(JSON.stringify({ d, train: state.train, d2, train2: s2.train }));
`);
  report('2.69.0 (r, a): the supervisor pass runs the train daemon (trainDaemonTick) and records its decision in its status (state.train); a halted supervisor or a wind-down starts no train (fails on 2.68.0: the supervisor had no train daemon)',
    sup.d?.started === false && /halted/.test(sup.train?.why || '') && sup.d2?.started === false && /winding down/.test(sup.train2?.why || ''),
    JSON.stringify(sup).slice(0, 1500));

  // ---- (b) after a daemon train: only what is missing is added; ONE job.done ----
  const b = probe('after', `import path from 'node:path';
import { runDaemonTrain } from ${u('harness/train-daemon.mjs')};
const root = path.resolve('.');
const calls = { runTrain: [], handBack: [], addNote: [], finish: [] };
const runTrain = async (opts) => { calls.runTrain.push({ now: opts.now, quietJob: opts.quietJob, by: opts.by }); return { ok: false, id: 'tr-1', landed: ['T-5'], dropped: [{ task: 'T-1', why: 'red: game' }, { task: 'T-2', why: 'red: game' }, { task: 'T-3', why: 'conflict' }, { task: 'T-4', why: 'red' }], deferred: [], held: [] }; };
const where = { 'T-1': 'in-progress', 'T-2': 'backlog', 'T-3': 'backlog', 'T-4': 'in-progress' };
const board = {
  running: (t) => t === 'T-4',
  boardOf: (t) => where[t] || null,
  handBack: (lane, note) => calls.handBack.push({ task: lane.task, note }),
  handoffText: (t) => (t === 'T-3' ? 'Hand-back facts (written by the harness ...)\\nNot landed by merge train tr-1: conflict' : 'an old note'),
  addNote: (t, note) => calls.addNote.push({ task: t, note }),
};
const r = await runDaemonTrain({ root, runTrain, deps: {}, board, finish: (res, t0, more) => calls.finish.push({ id: res.id, more }) });
console.log(JSON.stringify({ calls, routed: r.routed }));
`);
  report('2.69.0 (r, b): after a daemon train each handed-back lane with no running session is back on the board with the facts block: a task still in progress is handed back (T-1), a waiting task without the facts gets them (T-2), one that has them is left (T-3), one whose session still runs is skipped (T-4); the train ran with --now and its own job.done left out, and ONE job.done carries meta.auto and what was re-queued (fails on 2.68.0: no daemon; hand-backs were routed by hand)',
    b.calls?.runTrain?.length === 1 && b.calls.runTrain[0].now === true && b.calls.runTrain[0].quietJob === true && b.calls.runTrain[0].by === 'train-daemon'
      && b.calls.handBack.length === 1 && b.calls.handBack[0].task === 'T-1' && /Not landed by merge train tr-1/.test(b.calls.handBack[0].note)
      && b.calls.addNote.length === 1 && b.calls.addNote[0].task === 'T-2' && b.calls.finish.length === 1 && b.calls.finish[0].more?.extra?.auto === true
      && JSON.stringify(b.calls.finish[0].more.extra.requeued) === '["T-1"]' && JSON.stringify(b.calls.finish[0].more.extra.noted) === '["T-2"]' && (b.routed?.skipped || []).some((s) => s.task === 'T-4'),
    JSON.stringify(b).slice(0, 2500));

  // ---- (c) the triager on a made-up game: real run-gates focused runs on the same tree ----
  write('studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false }] }, null, 2)}\n`);
  write('game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
  write('game/demo/run-tests.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const files = process.argv.slice(2);",
    "const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "const skip = JSON.parse(process.env.STUDIO_TEST_QUARANTINE || '[]');",
    "const notes = fs.existsSync('game/demo/notes') ? fs.readdirSync('game/demo/notes').map((f) => fs.readFileSync(path.join('game/demo/notes', f), 'utf8')).join('\\n') : '';",
    "let bad = 0; let n = 0;",
    "for (const f of list) {",
    "  if (skip.includes(f)) { console.log(` \\u2193 ${f} (quarantined)`); continue; }",
    "  n += 1;",
    "  if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${f}\\t${process.env.STUDIO_TEST_WORKERS || '-'}\\t${skip.join(',')}\\n`);",
    "  const breaks = notes.includes(`BREAKS ${path.basename(f)}`) || (notes.includes(`CROWD ${path.basename(f)}`) && list.length > 1);",
    "  if (breaks) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`);",
    "}",
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${n - bad} passed (${n})`);",
    "process.exit(bad ? 1 : 0);", ''].join('\n'));
  for (const n of ['a', 'b', 'c']) write(`game/demo/tests/${n}.test.mjs`, `// ${n}\n`);
  write('game/demo/notes/n.md', 'CROWD b.test.mjs\nBREAKS c.test.mjs\n');
  const g = (...x) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...x], { windowsHide: true, cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('config', 'core.autocrlf', 'false'); g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');
  // The "verify": the game's whole check, red on b (only beside the others) and c (always).
  const verify = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', env);
  const verifyText = out(verify);
  // Two earlier load-flake labels for b in the last week (other trains): this third one quarantines it.
  const old = (d) => JSON.stringify({ at: new Date(Date.now() - d * 86400000).toISOString(), test: 'game/demo/tests/b.test.mjs', check: 'game:unit', label: 'load-flake', train: `old-${d}`, tree: 'aaaa' });
  const realOld = (d) => JSON.stringify({ at: new Date(Date.now() - d * 86400000).toISOString(), test: 'game/demo/tests/c.test.mjs', check: 'game:unit', label: 'real', train: `old-${d}`, tree: 'aaaa' });
  write('.studio/flakes.jsonl', `${old(2)}\n${old(5)}\n${old(9)}\n${realOld(1)}\n${realOld(2)}\n`);
  const vlog = path.join(tmpRoot, `verify-269r-${process.pid}.log`);
  fs.writeFileSync(vlog, verifyText);
  try { fs.rmSync(ranLog, { force: true }); } catch {}
  // 2.78.2: per-file triage is now STUDIO_FLAKE_TOGETHER=off; the together path is checked in selftest-2782b
  const c2 = probe('triage', `import fs from 'node:fs'; import path from 'node:path';
import { flakeTriage } from ${u('harness/train.mjs')};
const root = path.resolve('.');
const text = fs.readFileSync(${JSON.stringify(vlog)}, 'utf8');
const lines = [];
const r = flakeTriage({ root, dir: root }, { id: 'tr-flake', tree: 'cafe1234', text, log: (m) => lines.push(m) });
const again = flakeTriage({ root, dir: root }, { id: 'tr-flake-1', tree: 'cafe1234', text, log: (m) => lines.push(m) });
console.log(JSON.stringify({ labels: r?.labels || null, quarantined: r?.quarantined || null, again: again ? again.labels.length : null, lines }));
`, { STUDIO_FLAKE_TOGETHER: 'off' });
  const ran = (() => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')); } catch { return []; } })();
  const lab = (t) => (c2.labels || []).find((x) => x.test.endsWith(t));
  const flakeRows = (() => { try { return fs.readFileSync(path.join(dir, '.studio', 'flakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  report('2.69.0 (r, c): a red verify\'s failing test files are each run ALONE on the same tree by focused runs (run-gates --only, STUDIO_GATE_FOCUS): c fails alone -> "real" (2.78.0, PU-56: confirmed by a second run at quiet low load), b passes alone and again under low load (STUDIO_TEST_WORKERS=1) -> "load-flake"; the a file that passed is never run; each label is a line in .studio/flakes.jsonl; a second red in the same train triages nothing again (fails on 2.68.0: nobody re-ran the failing tests alone; the orchestrator did it by hand)',
    verify.status !== 0 && lab('c.test.mjs')?.label === 'real' && lab('c.test.mjs').runs.length === 2 && lab('c.test.mjs').runs[1].lowLoad === true && /quiet low load/.test(lab('c.test.mjs').why || '') && lab('b.test.mjs')?.label === 'load-flake' && lab('b.test.mjs').runs.length === 2 && lab('b.test.mjs').runs[1].lowLoad === true
      && ran.length === 4 && ran.every((x) => x[0] !== 'game/demo/tests/a.test.mjs') && ran.filter((x) => x[0] === 'game/demo/tests/b.test.mjs').map((x) => x[1]).includes('1')
      && flakeRows.filter((r) => r.train === 'tr-flake').length === 2 && c2.again === 0,
    `${verifyText.slice(-800)}\n${JSON.stringify(c2).slice(0, 2000)}\nran=${JSON.stringify(ran)}`);
  const q = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'quarantine.json'), 'utf8')); } catch { return null; } })();
  report('2.69.0 (r, d): a test labelled flaky 3 times in 7 days goes on studio/quarantine.json as PROPOSED ({ test, label, since, why, status: "proposed" } with its evidence, by the harness; the label 9 days old doesn\'t count) and a test.quarantine_proposed event says so; c, labelled "real" 3 times, is never quarantined (fails on 2.68.0: no quarantine; fails on the first 2.69.0 (r) commit: the entry went active at once)',
    Array.isArray(q) && q.length === 1 && q[0].test === 'game/demo/tests/b.test.mjs' && q[0].label === 'load-flake' && q[0].status === 'proposed' && q[0].since && /flaky 3 times in 7 days/.test(q[0].why) && q[0].by === 'harness' && q[0].evidence?.length === 3
      && evs().some((e) => e.type === 'test.quarantine_proposed' && e.meta?.test === 'game/demo/tests/b.test.mjs') && !evs().some((e) => e.type === 'test.quarantined'),
    JSON.stringify(q));
  const ranNow = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')); } catch { return []; } };
  try { fs.rmSync(ranLog, { force: true }); } catch {}
  const before = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', env);
  const ran1 = ranNow();
  report('2.69.0 (r, d): the harness never silences a test on its own authority: a proposed entry is NOT in STUDIO_TEST_QUARANTINE, so the game\'s runner still runs it (fails on the first 2.69.0 (r) commit: the runner skipped it at once)',
    ran1.length === 3 && ran1.some((x) => x[0] === 'game/demo/tests/b.test.mjs') && ran1.every((x) => x[2] === '') && !/quarantined test file\(s\) skipped/.test(out(before)),
    `${out(before).slice(-1000)}\nran=${JSON.stringify(ran1)}`);

  // ---- (d) the fix task is filed for a proposed entry; the digest lists it; confirm (never a worker); tier C; release ----
  const d = probe('quar', `import path from 'node:path';
import fs from 'node:fs';
import { fileQuarantineTasks, confirmQuarantine, releaseQuarantine, readQuarantine, quarantineDigestLine, quarantineEnvValue, statusText } from ${u('harness/flakes.mjs')};
import { classifyLane } from ${u('harness/tiers.mjs')};
import { buildDigest } from ${u('harness/digest.mjs')};
const root = path.resolve('.');
const filed = [];
const fileTask = async ({ title, test }) => { filed.push(title); return { id: 'T-77' }; };
const r = {};
r.first = await fileQuarantineTasks(root, fileTask);
r.second = await fileQuarantineTasks(root, fileTask);
r.filed = filed;
r.taskOnEntry = readQuarantine(root)[0]?.task || null;
r.tier = classifyLane({ files: [{ path: 'studio/quarantine.json', status: 'M' }] });
const ev = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
r.line = quarantineDigestLine(ev(), { root });
try { r.digest = (await buildDigest({ root, events: ev() })).text; } catch (e) { r.digest = 'ERR ' + e.message; }
r.status = statusText(root);
r.envBefore = quarantineEnvValue(root);
r.workerConfirm = await confirmQuarantine(root, 'game/demo/tests/b.test.mjs', { by: 'builder-c' });
r.sessionConfirm = await confirmQuarantine(root, 'game/demo/tests/b.test.mjs', { by: 'Dana', env: { ...process.env, STUDIO_ROLE: 'qa', STUDIO_LOCK_OWNER: 'qa-a' } });
r.stillProposed = readQuarantine(root)[0]?.status;
r.confirm = await confirmQuarantine(root, 'game/demo/tests/b.test.mjs', { by: 'Dana', why: 'seen it flake' });
r.statusAfter = readQuarantine(root)[0]?.status;
r.envAfter = quarantineEnvValue(root);
console.log(JSON.stringify(r));
`);
  report('2.69.0 (r, d): ONE fix task per proposed entry (filed once, its id kept on the entry; a second pass files nothing); the daily digest and npm run flakes list the proposal with its evidence; a lane changing studio/quarantine.json is tier C (silencer); a worker (by name or a launched qa session) can\'t confirm it, a person can, and then it is active and in STUDIO_TEST_QUARANTINE (fails on 2.68.0: no quarantine, and the file was tier B; fails on the first 2.69.0 (r) commit: no proposals, no confirm)',
    d.filed?.length === 1 && /Fix flaky test game\/demo\/tests\/b\.test\.mjs/.test(d.filed[0]) && d.second?.length === 0 && d.taskOnEntry === 'T-77' && d.tier?.tier === 'C'
      && /Proposed for quarantine, still running until you confirm: game\/demo\/tests\/b\.test\.mjs \(load-flake, 3 labels\)/.test(d.line || '') && /Proposed for quarantine/.test(d.digest || '') && /Proposed by the harness, still running until confirmed/.test(d.status || '')
      && d.envBefore === '' && d.workerConfirm?.ok === false && d.sessionConfirm?.ok === false && d.stillProposed === 'proposed' && d.confirm?.ok === true && d.statusAfter === 'active'
      && d.envAfter === '["game/demo/tests/b.test.mjs"]' && evs().some((e) => e.type === 'test.quarantined' && e.meta?.confirmedBy === 'Dana'),
    JSON.stringify(d).slice(0, 3000));
  try { fs.rmSync(ranLog, { force: true }); } catch {}
  const after = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', env);
  const ran2 = ranNow();
  report('2.69.0 (r, d): once confirmed, the game\'s checks get it as STUDIO_TEST_QUARANTINE (a JSON list of test files) and the game\'s runner skips it; the real failure still fails the check (fails on 2.68.0: no such variable)',
    ran2.length === 2 && ran2.every((x) => x[0] !== 'game/demo/tests/b.test.mjs' && x[2] === 'game/demo/tests/b.test.mjs') && after.status !== 0 && /quarantined test file\(s\) skipped/.test(out(after)),
    `${out(after).slice(-1200)}\nran=${JSON.stringify(ran2)}`);

  // ---- (d) autoQuarantine: the owner's or a game dev's choice makes the harness's additions active at once ----
  const au = probe('auto', `import path from 'node:path';
import fs from 'node:fs';
import { maybeQuarantine, readQuarantine, quarantineEnvValue, releaseQuarantine } from ${u('harness/flakes.mjs')};
const root = path.resolve('.');
const qf = path.join(root, 'studio', 'quarantine.json');
const seed = (t) => { for (const d of [1, 2]) fs.appendFileSync(path.join(root, '.studio', 'flakes.jsonl'), JSON.stringify({ at: new Date(Date.now() - d * 86400000).toISOString(), test: t, check: 'game:unit', label: 'seed-flake' }) + '\\n'); };
const third = (t) => { const row = { at: new Date().toISOString(), test: t, check: 'game:unit', label: 'seed-flake' }; fs.appendFileSync(path.join(root, '.studio', 'flakes.jsonl'), JSON.stringify(row) + '\\n'); return row; };
const r = {};
fs.writeFileSync(qf, JSON.stringify({ autoQuarantine: true, tests: readQuarantine(root) }, null, 2));
seed('game/demo/tests/y.test.mjs');
r.y = maybeQuarantine(root, third('game/demo/tests/y.test.mjs'));
r.fileShape = Object.keys(JSON.parse(fs.readFileSync(qf, 'utf8'))).sort().join(',');
fs.writeFileSync(qf, JSON.stringify(readQuarantine(root), null, 2));
const mf = path.join(root, 'game', 'demo', 'studio.gates.json');
const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
fs.writeFileSync(mf, JSON.stringify({ ...m, autoQuarantine: true }, null, 2));
seed('game/demo/tests/z.test.mjs');
r.z = maybeQuarantine(root, third('game/demo/tests/z.test.mjs'));
fs.writeFileSync(mf, JSON.stringify(m, null, 2));
r.env = quarantineEnvValue(root);
r.release = await releaseQuarantine(root, 'game/demo/tests/y.test.mjs', { by: 'Dana' });
console.log(JSON.stringify(r));
`);
  report('2.69.0 (r, d): with "autoQuarantine": true in studio/quarantine.json (its { autoQuarantine, tests } shape kept) or in the game\'s studio.gates.json, the harness\'s entry is active at once, still with its evidence and a test.quarantined event, and in STUDIO_TEST_QUARANTINE; a game dev releases it (fails on the first 2.69.0 (r) commit: no autoQuarantine switch)',
    au.y?.status === 'active' && au.y.auto === 'studio/quarantine.json' && au.y.evidence?.length === 3 && au.fileShape === 'autoQuarantine,tests' && au.z?.status === 'active' && au.z.auto === 'game/demo/studio.gates.json'
      && JSON.parse(au.env || '[]').includes('game/demo/tests/y.test.mjs') && JSON.parse(au.env || '[]').includes('game/demo/tests/z.test.mjs') && au.release?.ok === true
      && evs().some((e) => e.type === 'test.quarantined' && e.agent === 'harness' && e.meta?.test === 'game/demo/tests/z.test.mjs'),
    JSON.stringify(au).slice(0, 2500));

  // ---- (c) the labels themselves: seed-flake and intermittent ----
  const l = probe('labels', `import { labelTest } from ${u('harness/flakes.mjs')};
const seq = (...oks) => { let i = 0; return () => ({ ok: oks[i++] }); };
const rng = { items: ['game/demo/tests/dice.test.mjs:4 unseeded-game'] };
const r = {
  seed: labelTest({ check: 'game:unit', file: 'game/demo/tests/dice.test.mjs', runAlone: seq(true), rng }),
  inter: labelTest({ check: 'game:unit', file: 'game/demo/tests/x.test.mjs', runAlone: seq(true, false), rng }),
};
console.log(JSON.stringify(r));
`);
  report('2.69.0 (r, c): a test that passes alone and uses randomness without a fixed seed (a test-rng finding for that file) is "seed-flake" after one run; one that passes alone and then fails alone under low load is "intermittent" (fails on 2.68.0: no labels)',
    l.seed?.label === 'seed-flake' && l.seed.runs.length === 1 && /without a fixed seed/.test(l.seed.why) && l.inter?.label === 'intermittent' && l.inter.runs.length === 2,
    JSON.stringify(l).slice(0, 1500));
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('.probe-269r-'))) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch {} }
}
