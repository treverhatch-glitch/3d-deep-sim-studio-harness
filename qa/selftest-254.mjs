/**
 * qa/selftest-254.mjs — 2.54.0: fixes from the first crew run (P-022 to P-027).
 *   P-022/P-023: the watchdog's idle stop never fires on a studio (or a resume) younger than its window, and only
 *                sessions that held a task count; a stopping pass launches nothing after the stop.
 *   P-024: two wake-ups in one pass start one Director, never two under one name.
 *   P-025: a docs task works in the studio path it names; a guessed lane never enters a folder the game's own
 *          AGENTS.md says not to touch.
 *   P-026: engine tools on the cheat sheet only for a game that uses that engine.
 *   P-027: a refill that adds nothing and wakes nobody is logged once an hour.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest254({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-254-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: `${r.stdout}${r.stderr}`.slice(-1500) }; }
  };

  // P-022 / P-023: the idle stop's window and what counts.
  const idle = probe('idle', `import { idleStopReason } from ${u('harness/watchdog.mjs')};
const now = Date.parse('2026-10-31T12:00:00Z');
const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
const lim = { idleHours: 2 };
const taskEnds = (n, minAgo) => Array.from({ length: n }, (_, i) => ({ type: 'agent.session.end', agent: 'b-' + i, task: 'T-' + i, ts: at(minAgo) }));
const planEnds = (n, minAgo) => Array.from({ length: n }, (_, i) => ({ type: 'agent.session.end', agent: 'producer-' + i, task: null, meta: { role: 'producer', handed: [] }, ts: at(minAgo) }));
const young = [{ type: 'setup.init', ts: at(44) }, ...taskEnds(5, 20)];
const old = [{ type: 'setup.init', ts: at(300) }, ...taskEnds(3, 30)];
const planning = [{ type: 'setup.init', ts: at(300) }, ...planEnds(4, 30), { type: 'task.start', agent: 'opus-1', task: 'T-6', ts: at(60) }, { type: 'agent.session.end', agent: 'opus-1', task: null, ts: at(30) }];
const resumed = [...old, { type: 'studio.resumed', agent: 'hatch', ts: at(10) }];
const done = [...old, { type: 'task.done', agent: 'b-0', task: 'T-0', ts: at(5) }];
const off = idleStopReason(now, { events: old, lim: { idleHours: 0 }, auto: true });
console.log(JSON.stringify({ young: idleStopReason(now, { events: young, lim, auto: true }), old: idleStopReason(now, { events: old, lim, auto: true }), planning: idleStopReason(now, { events: planning, lim, auto: true }), resumed: idleStopReason(now, { events: resumed, lim, auto: true }), done: idleStopReason(now, { events: done, lim, auto: true }), off }));`);
  report('2.54.0 (P-022, P-023): the idle stop waits for a whole window after the studio starts or is resumed, counts only sessions that held a task (not Producer/Director planning), and 0 turns it off',
    idle.young === null && idle.old?.ran === 3 && idle.planning === null && idle.resumed === null && idle.done === null && idle.off === null, JSON.stringify(idle).slice(0, 900));

  // P-027 (watchdog): a pass that stops the studio returns at once, so nothing launches after the stop.
  const order = probe('order', `import { setWatchdog, watchdogPass } from ${u('harness/watchdog.mjs')};
import { readStop, clearStop } from ${u('harness/task.mjs')};
const now = Date.now();
const at = (minAgo) => new Date(now - minAgo * 60000).toISOString();
setWatchdog(true, 'trever');
// Switched on 5 hours ago (a fresh switch-on waits a whole window, by design).
import fs from 'node:fs';
const wf = '.studio/watchdog.json';
fs.writeFileSync(wf, JSON.stringify({ ...JSON.parse(fs.readFileSync(wf, 'utf8')), at: at(300) }));
const events = [{ type: 'setup.init', ts: at(300) }, ...[1, 2, 3].map((i) => ({ type: 'agent.session.end', agent: 'b-' + i, task: 'T-' + i, ts: at(30) }))];
const r = await watchdogPass(now, { events, lim: { checkMin: 15, handBacks: 3, idleHours: 2 } });
const stopped = Boolean(readStop());
clearStop('selftest');
setWatchdog(false, 'trever');
console.log(JSON.stringify({ kinds: r.actions.map((a) => a.kind), stopped }));`, { STUDIO_WATCHDOG: '' });
  report('2.54.0 (P-027): a watchdog pass that stops the studio does nothing else in that pass (no launch after the stop)', JSON.stringify(order.kinds) === '["stop"]' && order.stopped === true, JSON.stringify(order).slice(0, 900));

  // P-024: two wake-ups in one pass start one Director (the launch registers at once).
  const agentCmd = 'node -e "setTimeout(() => {}, 4000)"';
  const wake = probe('wake', `import { wake, sessions } from ${u('harness/agent.mjs')};
const a = wake('director', { why: 'director ping' });
const b = wake('director', { why: 'development cycle' });
const live = sessions().filter((s) => s.role === 'director' && s.running).map((s) => s.agent);
console.log(JSON.stringify({ a: a.started, b: b.started, live, next: b.next }));`, { STUDIO_DIRECTOR_TOOL: 'custom', STUDIO_DIRECTOR_CMD: agentCmd, STUDIO_AGENT_CMD: agentCmd, STUDIO_DIRECTOR_MODEL: 'test-model' });
  // Stop the stand-in agents it launched (Windows keeps a folder while a process runs in it).
  try {
    const agentsDir = path.join(dir, '.studio', 'agents');
    for (const f of fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir).filter((x) => x.endsWith('.json')) : []) {
      const rec = JSON.parse(fs.readFileSync(path.join(agentsDir, f), 'utf8'));
      for (const pid of [rec.pid, rec.supervisor]) if (pid) { try { process.kill(pid); } catch {} }
    }
  } catch {}
  report('2.54.0 (P-024): a Director ping and the development cycle waking in the same pass start one Director; the second sees it running at once',
    wake.a === true && wake.b === false && wake.live?.length === 1 && /is running/.test(wake.next || ''), JSON.stringify(wake).slice(0, 900));

  // P-025: a docs task's lane is the studio path it names; a guessed lane skips the game's "do not touch" folders.
  const g = path.join(dir, 'game', 'portland');
  for (const f of ['src/diplomacy/core.ts', 'src/ui/core.ts', 'src/ui/hud.ts']) { fs.mkdirSync(path.dirname(path.join(g, f)), { recursive: true }); fs.writeFileSync(path.join(g, f), 'export {}\n'); }
  fs.writeFileSync(path.join(g, 'AGENTS.md'), '# Rules\n- **Do not touch `src/diplomacy`** (draft owned by another workstream).\n');
  const lane = probe('lane', `import { laneOf, noTouchPaths } from ${u('harness/task-hold.mjs')};
const events = [
  { type: 'task.added', task: 'T-023', msg: 'Queued T-023 [P0] (director): Write the core loop doc in studio/bible from the reference game\\'s mechanics', meta: {} },
  { type: 'task.added', task: 'T-030', msg: 'Queued T-030 [P1] (builder): Fix the core counter on the HUD', meta: {} },
];
console.log(JSON.stringify({ doc: laneOf('T-023', events, {}), build: laneOf('T-030', events, {}), banned: noTouchPaths('game/portland') }));`, { STUDIO_GAME: 'portland' });
  report('2.54.0 (P-025): a docs task that names studio/bible works there; a builder lane guessed from "core" never picks a file in a folder the game\'s AGENTS.md says not to touch',
    lane.doc === 'studio/bible' && !String(lane.build || '').includes('diplomacy') && /src\/ui\/core\.ts/.test(lane.build || '') && lane.banned?.[0] === 'game/portland/src/diplomacy', JSON.stringify(lane).slice(0, 900));

  // P-026: engine tools only for a game that uses the engine.
  fs.mkdirSync(path.join(dir, 'engine', 'portland'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engine', 'portland', 'engine.json'), JSON.stringify({ engine: 'unity' }));
  const cs = probe('cheat', `import { matchTricks, gameEngines } from ${u('harness/cheatsheet.mjs')};
const text = 'godot api docs library version run debug scene engine';
console.log(JSON.stringify({ engines: [...(gameEngines() || [])], unity: matchTricks(text, { tags: [] }).map((t) => t.id), none: matchTricks(text, { tags: [], engines: null }).map((t) => t.id) }));`, { STUDIO_GAME: 'portland' });
  report('2.54.0 (P-026): a game with a Unity track gets no Godot tools from the cheat sheet; with no game yet nothing is filtered',
    cs.engines?.includes('unity') && !cs.unity?.some((id) => ['C-22', 'C-24', 'C-25', 'C-26', 'C-27'].includes(id)) && cs.none?.some((id) => ['C-22', 'C-24', 'C-27'].includes(id)), JSON.stringify(cs).slice(0, 900));

  // P-027: an empty refill is logged once an hour.
  const rf = probe('refill', `import { refillPass } from ${u('harness/producer-refill.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const deps = { queue: { inProgress: [], backlog: [], done: [] }, add: () => ({ id: 'x' }), wake: async () => ({ started: false }) };
const start = Date.now() - 1;
for (let i = 0; i < 3; i++) await refillPass({ deps, min: 4 });
console.log(JSON.stringify({ logged: readRecentEvents(500).filter((e) => e.type === 'producer.refill' && Date.parse(e.ts) >= start).length }));`, { STUDIO_REFILL_WAKE: 'off' });
  report('2.54.0 (P-027): three empty queue refills in a row log one "Queue low … added 0" line, not three', rf.logged === 1, JSON.stringify(rf).slice(0, 900));

  // PU-06: what was red at claim doesn't count against the task; new failures do; a red trunk starts only fixes.
  const base = probe('baseline', `import fs from 'node:fs';
import { failingTests, recordBaseline, judgeRed, setTrunk, trunkState } from ${u('harness/baseline.mjs')};
import { gatesAfter } from ${u('harness/done-check.mjs')};
import { holdReason } from ${u('harness/task-hold.mjs')};
const out = ' ✓ src/a.test.ts (3 tests) 20ms\\n FAIL  src/ui/hud.e2e.test.ts > HUD > keeps panels apart\\n \\u001b[31m×\\u001b[39m src/neg/panel.e2e.test.ts > panel > opens 1200ms\\n Test Files  2 failed | 5 passed';
const parsed = failingTests(out);
const rec = (failures, extraRed = false) => ({ at: new Date(Date.now() + 1000).toISOString(), partial: false, rows: [{ id: 'test', ok: false, required: true, failures }, { id: 'typecheck', ok: !extraRed, required: true }] });
fs.mkdirSync('.studio', { recursive: true });
fs.writeFileSync('.studio/gates-last.json', JSON.stringify(rec(['a > one', 'b > two'])));
const b = recordBaseline('T-901');
const write = (r) => fs.writeFileSync('.studio/gates-last.json', JSON.stringify(r));
write(rec(['a > one', 'b > two']));
const same = gatesAfter(0, null, 'T-901');
write(rec(['a > one', 'b > two', 'c > three']));
const added = gatesAfter(0, null, 'T-901');
write(rec(['a > one', 'b > two'], true));
const other = gatesAfter(0, null, 'T-901');
const noBase = gatesAfter(0, null, 'T-999');
const q = { backlog: [{ id: 'T-910', title: 'Add the noise panel', role: 'builder' }, { id: 'T-911', title: 'Fix: the HUD layout test times out', role: 'builder' }, { id: 'T-912', title: 'Plan the next milestone', role: 'producer' }], inProgress: [{ id: 'T-913', title: 'Add fees', role: 'builder' }], done: [] };
setTrunk('red', { by: 'trever', why: 'main red on GitHub since Oct 17' });
const red = { feature: holdReason('T-910', q, Date.now(), {}), fix: holdReason('T-911', q, Date.now(), {}), plan: holdReason('T-912', q, Date.now(), {}), running: holdReason('T-913', q, Date.now(), {}) };
setTrunk('green', { by: 'trever' });
const green = holdReason('T-910', q, Date.now(), {});
console.log(JSON.stringify({ parsed, baseRed: b?.red?.map((r) => r.id), same, added, other, noBase, red, green, state: trunkState().red }));`);
  report('2.54.0 (PU-06): the failing test names are read from a check\'s output; a task isn\'t blamed for tests already failing when it was claimed, but a new failing test or a newly red check fails it',
    base.parsed?.length === 2 && /hud\.e2e/.test(base.parsed[0]) && !/ms$/.test(base.parsed[1]) && base.baseRed?.[0] === 'test' && base.same === null && /c > three/.test(base.added || '') && !/a > one/.test(base.added || '') && /typecheck/.test(base.other || '') && /the last verify failed: test, typecheck|the last verify failed: test/.test(base.noBase || ''), JSON.stringify(base).slice(0, 1500));
  report('2.54.0 (PU-06): with the trunk marked red only fix tasks start (planning and work in progress carry on); marked green, everything starts again',
    /trunk is red \(main red on GitHub/.test(base.red?.feature || '') && base.red?.fix === null && base.red?.plan === null && base.red?.running === null && base.green === null && base.state === false, JSON.stringify(base.red));
  const cli = run(dir, 'node harness/task.mjs trunk red --by trever --why "CI red"');
  const st = run(dir, 'node harness/task.mjs trunk status');
  run(dir, 'node harness/task.mjs trunk green --by trever');
  report('2.54.0 (PU-06): npm run task -- trunk red|green|status', cli.status === 0 && /Trunk red \(manual, trever\): CI red/.test(st.stdout || ''), `${cli.stdout}${cli.stderr}${st.stdout}`);

  // PU-02 / PU-03: one row per attempt, time split into segments, a failure label for every attempt that failed.
  const met = probe('metrics', `import { attemptRows, summarize, writeMetrics } from ${u('harness/metrics.mjs')};
import fs from 'node:fs';
const t0 = Date.parse('2026-10-31T10:00:00Z');
const at = (m) => new Date(t0 + m * 60000).toISOString();
const ev = [];
const e = (m, type, agent, task, extra = {}) => ev.push({ ts: at(m), type, agent, task, ...extra });
// T-1 done in 20 min: one 1-minute verify, heartbeats every 2 min.
e(0, 'agent.session.start', 'b-1', null, { model: 'claude-sonnet-5-5' }); e(0, 'task.start', 'b-1', 'T-1');
for (let m = 2; m < 20; m += 2) e(m, 'agent.heartbeat', 'b-1', null);
e(15, 'gates.run', 'b-1', null, { meta: { ms: 60000 } }); e(20, 'task.done', 'b-1', 'T-1'); e(21, 'agent.session.end', 'b-1', null, { model: 'claude-sonnet-5-5', tokensIn: 1000, tokensOut: 500, meta: { costUsd: 0.4 } });
// T-2 waits 10 min on the game dev, then is handed back.
e(30, 'task.start', 'b-2', 'T-2'); e(35, 'ask.open', 'b-2', null, { msg: 'A-1 for the game dev: which colour?' }); e(45, 'ask.answered', 'hatch', null, { msg: 'A-1 answered by hatch: blue' }); e(50, 'task.paused', 'b-2', 'T-2', { msg: 'Handed back T-2: needs art' });
// T-3 forced done; T-4 a burn stall; T-5 a usage limit.
e(60, 'task.start', 'b-3', 'T-3'); e(70, 'task.forced', 'b-3', 'T-3', { msg: 'T-3 forced' });
e(80, 'task.start', 'b-4', 'T-4'); e(90, 'session.stall', 'watchdog', 'T-4', { msg: 'Ended b-4 (builder, T-4): burning tokens in a loop', meta: { kind: 'burn', target: 'b-4' } }); e(90, 'task.paused', 'watch', 'T-4', { msg: 'Handed back T-4' });
e(100, 'task.start', 'b-5', 'T-5'); e(105, 'agent.session.end', 'b-5', null, { msg: 'b-5 ended: Claude usage limit reached' }); e(105, 'task.paused', 'watch', 'T-5', { msg: 'Handed back T-5' });
// T-1 again later (a retry), still open.
e(110, 'task.start', 'b-1', 'T-1');
const rows = attemptRows(ev, { now: t0 + 120 * 60000 });
const f = writeMetrics(rows, '.studio/metrics');
const by = Object.fromEntries(rows.map((r) => [r.task + '#' + r.attempt, r]));
console.log(JSON.stringify({ n: rows.length, t1: by['T-1#1'], t2: by['T-2#1'], labels: rows.map((r) => r.failure), retry: by['T-1#2']?.retries, csv: fs.readFileSync(f.csv, 'utf8').split('\\n')[0], s: summarize(rows).failures }));`);
  const t1 = met.t1 || {};
  report('2.54.0 (PU-02): one metrics row per task attempt: 20 min split into agent 19 and checks 1, tokens and reported cost from its session, a later claim counts as a retry; written as JSONL and CSV',
    met.n === 6 && t1.outcome === 'done' && t1.minutes === 20 && t1.checksMin === 1 && t1.agentMin === 19 && t1.tokensIn === 1000 && t1.tokensOut === 500 && t1.costUsdReported === 0.4 && t1.model === 'claude-sonnet-5-5' && met.retry === 1 && /^task,attempt,retries,agent,model/.test(met.csv || '') && met.t2?.personMin === 10, JSON.stringify(met).slice(0, 1500));
  report('2.54.0 (PU-03): each failed attempt gets one label (MAST-based list): forced done = verify-missing, a burn stall = repetition, a usage limit = quota; a done attempt has none',
    JSON.stringify(met.labels) === JSON.stringify([null, 'unknown', 'verify-missing', 'repetition', 'quota', null]), JSON.stringify(met.labels));
}

