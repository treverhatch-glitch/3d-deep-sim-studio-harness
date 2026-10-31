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
}
