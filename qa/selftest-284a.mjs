/**
 * qa/selftest-284a.mjs — 2.84 (a): a planning wake needs something that changed.
 *
 * In one crew's 26 hours the Director's regular cycle and the Producer's "queue is below its depth target" wake started
 * 83 sessions that left almost nothing on the board. harness/wake-gate.mjs fingerprints each of the two kinds of wake
 * and skips one whose situation did not change after a session that changed nothing, up to a ceiling; a cycle's brief
 * opens with what changed; a planning session's end records its board events; the scorecard counts both; and the
 * launcher no longer starts a session for a task whose `task start` would be refused.
 *
 *   pure       fingerprint, digest, verdict, outcome (inputs in, verdict out)
 *   queue      the real queueDepthPass with a stand-in wake: first, same, change, ceiling, off
 *   cycle      the real cyclePass with a stand-in wake: first, quiet, news (in the brief), ceiling, off
 *   score      the two planning lines
 *   launcher   a parked task: no session, task start's words, agent.start.refused
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284A({ dir, root, report, tmpRoot }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  // ---- a studio copy: its own .studio (state files, the event log) ----
  const S = path.join(tmpRoot, `284a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  for (const x of ['studio/task-holds.json']) fs.rmSync(path.join(S, x), { force: true });
  const evFile = path.join(S, '.studio', 'events-284a.jsonl');
  const env = { ...clean, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', CI: '', NODE_OPTIONS: '' };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-284a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...env, ...extra }, encoding: 'utf8', timeout: 180000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['line', 'queue-depth.json', 'dev-cycle.json', 'briefs']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  const WG = u('harness/wake-gate.mjs');

  // ================= pure =================
  await guard('2.84 pure: the queue-depth fingerprint is the same for the same situation whatever the order or the times in the reasons ("since 10:26", "until 14:00"), and differs when the count ready, the target, a blocked area\'s reason kind or the open task ids change (fails before this fix: no harness/wake-gate.mjs)', () => {
    const r = probe(`
import { queueFingerprint, reasonKind } from ${WG};
const b1 = [{ area: 'game/a', tasks: [{ id: 'T-1', why: 'queued for the unity train (branch u/t-1) since 2026-11-10T10:26' }, { id: 'T-2', why: 'waits for T-1' }] }, { area: 'game/b', tasks: [{ id: 'T-3', why: 'parked by watchdog: handed back 3 times in 2 h' }] }];
const b2 = [{ area: 'game/b', tasks: [{ id: 'T-3', why: 'parked by watchdog: handed back 4 times in 1 h' }] }, { area: 'game/a', tasks: [{ id: 'T-2', why: 'waits for T-1' }, { id: 'T-1', why: 'in the unity train 20261110-151612, which is landing it now' }] }];
const a = queueFingerprint({ ready: [], target: 4, blocked: b1, open: ['T-1', 'T-2', 'T-3'] });
const same = queueFingerprint({ ready: [], target: 4, blocked: b2, open: ['T-3', 'T-2', 'T-1'] });
const more = queueFingerprint({ ready: ['T-9'], target: 4, blocked: b1, open: ['T-1', 'T-2', 'T-3'] });
const tgt = queueFingerprint({ ready: [], target: 8, blocked: b1, open: ['T-1', 'T-2', 'T-3'] });
const kind = queueFingerprint({ ready: [], target: 4, blocked: [b1[0], { area: 'game/b', tasks: [{ id: 'T-3', why: 'blocked until 14:00' }] }], open: ['T-1', 'T-2', 'T-3'] });
const added = queueFingerprint({ ready: [], target: 4, blocked: b1, open: ['T-1', 'T-2', 'T-3', 'T-4'] });
console.log(JSON.stringify({ a: a.key, same: same.key, more: more.key, tgt: tgt.key, kind: kind.key, added: added.key, summary: a.summary, kinds: [reasonKind('the game\\'s trunk is red (x)'), reasonKind('waits for T-1, T-2'), reasonKind('held for landing by p: x')] }));`);
    const keys = [r.a, r.more, r.tgt, r.kind, r.added];
    return [r.a && r.a === r.same && new Set(keys).size === 5 && r.summary === '0 ready, 2 areas blocked' && r.kinds?.join() === 'red trunk,waits,held', JSON.stringify(r)];
  });

  await guard('2.84 pure: the verdict skips a queue-depth wake only for the same fingerprint after an ENDED session with no board event, inside the ceiling; it wakes for a first wake, a changed situation, a session that changed the board, a session not ended, an unknown session, the ceiling, and maxH 0 (off); a cycle skips only on an empty digest', () => {
    const r = probe(`
import { wakeVerdict } from ${WG};
const T = Date.parse('2026-03-03T14:00:00Z'); const H = 3600000;
const fp = { key: 'k1', summary: '0 ready, 4 areas blocked' };
const last = { key: 'k1', summary: fp.summary, at: T, agent: 'producer-405' };
const ended = { ended: true, endedAt: T + 120000, boardEvents: 0 };
const v = (o) => wakeVerdict({ kind: 'queue-depth', fp, last, outcome: ended, now: T + H, maxH: 6, ...o });
const c = (o) => wakeVerdict({ kind: 'cycle', fp: { empty: true, count: 0, lines: [] }, last, outcome: ended, now: T + H, maxH: 12, ...o });
const res = {
  skip: v({}), first: v({ last: null }).skip, changed: v({ fp: { key: 'k2' } }).skip, board: v({ outcome: { ...ended, boardEvents: 2 } }).skip,
  running: v({ outcome: { ended: false } }).skip, unknown: v({ last: { ...last, agent: null } }).skip, ceiling: v({ now: T + 6 * H }).skip, off: v({ maxH: 0 }).skip,
  cycleQuiet: c({}).skip, cycleNews: c({ fp: { empty: false, count: 3 } }).skip, cycleCeiling: c({ now: T + 12 * H }).skip,
};
console.log(JSON.stringify(res));`);
    return [r.skip?.skip === true && /^nothing changed since producer-405's session at 14:02 UTC, which planned nothing: 0 ready, 4 areas blocked$/.test(r.skip.why)
      && [r.first, r.changed, r.board, r.running, r.unknown, r.ceiling, r.off, r.cycleNews, r.cycleCeiling].every((x) => x === false) && r.cycleQuiet === true, JSON.stringify(r)];
  });

  await guard('2.84 pure: the digest lists what changed in (since, until] by kind, one line per kind and ten at most, ignores the planning sessions\' own notes and decisions and events outside the window; a session\'s outcome counts only its own agent\'s board events (BOARD_EVENT_TYPES) and prefers meta.outcome.boardEvents', () => {
    const r = probe(`
import { cycleDigest, sessionOutcomeOf, BOARD_EVENT_TYPES, digestHeader } from ${WG};
const T = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T + m * 60000).toISOString();
const ev = [
  { ts: at(1), type: 'task.done', task: 'T-1', agent: 'b1' },
  { ts: at(70), type: 'task.done', task: 'T-2', agent: 'b1' },
  { ts: at(71), type: 'task.paused', task: 'T-3', agent: 'b2' },
  { ts: at(72), type: 'notes.add', agent: 'producer-7', msg: 'nothing can be planned' },
  { ts: at(73), type: 'decision', agent: 'producer-7', msg: 'decided task-lane' },
  { ts: at(74), type: 'task.train.unity.dropped', task: 'T-4', agent: 'unity-train' },
  { ts: at(75), type: 'ask.answered', agent: 'owner', msg: 'A-1 answered by owner: yes' },
  { ts: at(200), type: 'task.done', task: 'T-5', agent: 'b1' },
];
const d = cycleDigest(ev, { since: T + 60 * 60000, until: T + 120 * 60000 });
const empty = cycleDigest(ev, { since: T + 80 * 60000, until: T + 120 * 60000 });
const sess = [
  { ts: at(0), type: 'agent.session.start', agent: 'producer-8' },
  { ts: at(1), type: 'task.added', agent: 'producer-8', task: 'T-9' },
  { ts: at(2), type: 'task.added', agent: 'someone-else', task: 'T-10' },
  { ts: at(3), type: 'notes.add', agent: 'producer-8' },
  { ts: at(4), type: 'agent.session.end', agent: 'producer-8', meta: { role: 'producer' } },
  { ts: at(5), type: 'agent.session.end', agent: 'producer-9', meta: { role: 'producer', outcome: { boardEvents: 0 } } },
];
console.log(JSON.stringify({ lines: d.lines, count: d.count, empty: empty.empty, o8: sessionOutcomeOf('producer-8', T, sess), o9: sessionOutcomeOf('producer-9', T, sess), list: BOARD_EVENT_TYPES.length, head: digestHeader('director', d, T + 60 * 60000).split('\\n')[0] }));`);
    return [r.count === 4 && r.lines?.length === 4 && /^- landed or done \(1\): T-2$/.test(r.lines[0]) && r.lines.some((l) => /^- red train or trunk \(1\): T-4/.test(l)) && !r.lines.some((l) => /nothing can be planned|task-lane/.test(l)) && r.empty === true
      && r.o8?.ended === true && r.o8.boardEvents === 1 && r.o9?.boardEvents === 0 && r.list === 13 && /^# What changed since your last cycle \(Director, since 2026-03-03 11:00 UTC\)$/.test(r.head || ''), JSON.stringify(r)];
  });

  // ================= queue-depth through the real pass =================
  await guard('2.84 queue: through queueDepthPass with a stand-in wake: the first wake happens; the same situation after a session that changed nothing is skipped with agent.wake.skipped (kind queue-depth, a plain reason); a new open task wakes again; a session that changed the board wakes again; the ceiling (STUDIO_WAKE_SAME_MAX_H) wakes again; the state survives a new process; and STUDIO_WAKE_SAME_MAX_H=off (or 0) wakes every time as before 2.84 (fails before this fix: every pass woke the Producer)', () => {
    resetState();
    const r = probe(`
import { queueDepthPass } from ${u('harness/queue-depth.mjs')};
import fs from 'node:fs';
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
const q = { inProgress: [], backlog: [], done: [] };
const q2 = { inProgress: [], backlog: [{ id: 'T-50', title: 'Docs: a page', role: 'reviewer' }], done: [] };
let n = 404; const woken = [];
const evs = [];
const session = (agent, startM, endM, board = 0) => { evs.push({ ts: at(startM), type: 'agent.session.start', agent }); for (let i = 0; i < board; i++) evs.push({ ts: at(startM + 1), type: 'task.added', agent, task: 'T-' + (60 + i) }); evs.push({ ts: at(endM), type: 'agent.session.end', agent, meta: { role: 'producer' } }); };
const pass = async (m, qq = q, extra = {}) => { const r = await queueDepthPass({ q: qq, cap: 3, now: T0 + m * 60000, env: { STUDIO_REFILL_WAKE: 'on', STUDIO_QUEUE_DEPTH_ASK_MIN: '1', ...extra }, deps: { holds: {}, events: [], lineStatus: null, wakeEvents: evs, wake: async () => { n++; woken.push('producer-' + n); return { started: true, agent: 'producer-' + n }; } } }); return r.woke?.skipped ? 'skip' : r.woke?.started ? 'wake' : 'none:' + JSON.stringify(r.woke); };
const seq = [];
seq.push(await pass(0));                       // first: wakes producer-405
session('producer-405', 0, 2);
seq.push(await pass(30));                      // same, nothing changed: skip
seq.push(await pass(60, q2));                  // a new open task: wake producer-406
session('producer-406', 60, 63, 1);            // it added a task
seq.push(await pass(90, q2));                  // same situation, but the session changed the board: wake producer-407
session('producer-407', 90, 92);
seq.push(await pass(120, q2));                 // skip
seq.push(await pass(90 + 6 * 60, q2));         // 6 h after the last wake that ran: wake (ceiling)
const lines = fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.wake.skipped');
const st = JSON.parse(fs.readFileSync('.studio/line/wake-gate.json', 'utf8'));
console.log(JSON.stringify({ seq, woken, skipped: lines.map((e) => [e.meta?.kind, e.to, e.msg]), slot: st['queue-depth:producer'] }));`);
    const queueOk = r.seq?.join() === 'wake,skip,wake,wake,skip,wake' && r.skipped?.length === 2 && r.skipped.every((s) => s[0] === 'queue-depth' && s[1] === 'producer')
      && /nothing changed since producer-405's session at 10:02 UTC, which planned nothing: 0 ready, 0 areas blocked/.test(r.skipped[0][2]) && r.slot?.agent === 'producer-408';
    // STUDIO_WAKE_SAME_MAX_H=off (or 0): as before 2.84, every pass past the ask interval wakes, nothing is skipped.
    resetState();
    const o = probe(`
import { queueDepthPass } from ${u('harness/queue-depth.mjs')};
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
const q = { inProgress: [], backlog: [], done: [] };
let n = 0; const evs = [];
const res = [];
for (const [i, v] of [['off', 0], ['0', 1]].entries()) {
  for (const m of [0, 30, 60]) {
    const k = i * 1000 + m;
    const r = await queueDepthPass({ q, cap: 3, now: T0 + k * 60000, env: { STUDIO_REFILL_WAKE: 'on', STUDIO_QUEUE_DEPTH_ASK_MIN: '1', STUDIO_WAKE_SAME_MAX_H: v[0] }, deps: { holds: {}, events: [], lineStatus: null, wakeEvents: evs, wake: async () => { n++; return { started: true, agent: 'producer-' + n }; } } });
    evs.push({ ts: at(k + 1), type: 'agent.session.end', agent: 'producer-' + n, meta: { role: 'producer', outcome: { boardEvents: 0 } } });
    res.push(r.woke?.skipped ? 'skip' : 'wake');
  }
}
console.log(JSON.stringify({ res }));`);
    return [queueOk && o.res?.join() === 'wake,wake,wake,wake,wake,wake', JSON.stringify({ r, o })];
  });

  // ================= the regular cycle through the real pass =================
  await guard('2.84 cycle: through cyclePass with a stand-in wake: the first regular cycle wakes both roles and each role\'s brief (.studio/briefs/dev-cycle-<role>.md) opens with what changed; after both sessions ended, a cycle with nothing new is skipped for both (agent.wake.skipped, kind cycle); a task landed since then wakes both again and is the first line under the heading; 13 h later (STUDIO_CYCLE_QUIET_MAX_H 12) it wakes with nothing new (fails before this fix: every regular cycle woke both)', () => {
    resetState();
    const r = probe(`
import { cyclePass } from ${u('harness/dev-cycle.mjs')};
import fs from 'node:fs';
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
let n = 0; const calls = [];
const wakeFn = (role, o) => { n++; calls.push([role, o.why, o.note || '']); return { started: true, agent: role + '-' + n }; };
const evs = [];
const ended = (m) => { for (const c of calls.slice(-2)) evs.push({ ts: at(m), type: 'agent.session.end', agent: c[0] + '-' + (calls.indexOf(c) + 1), meta: { role: c[0] } }); };
const step = async (m) => { const r = await cyclePass({ now: T0 + m * 60000, events: evs, wakeFn }); return [r.ran, (r.woke || []).length, (r.skipped || []).join('+')]; };
const out = {};
out.a = await step(0); ended(3);
out.b = await step(60);
evs.push({ ts: at(70), type: 'task.done', task: 'T-77', agent: 'builder-1', msg: 'T-77 done' });
out.c = await step(120);
out.brief = fs.readFileSync('.studio/briefs/dev-cycle-director.md', 'utf8').split('\\n').slice(0, 3);
out.note = calls.at(-1);
ended(123);
out.d = await step(180);
out.e = await step(120 + 13 * 60);
const sk = fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.wake.skipped');
out.skipped = sk.map((e) => [e.meta?.kind, e.to]);
console.log(JSON.stringify(out));`, { STUDIO_REFILL_MIN: '0', STUDIO_DEV_CYCLE_MIN: '30' });
    return [JSON.stringify(r.a) === '[true,2,""]' && JSON.stringify(r.b) === '[true,0,"director+producer"]' && JSON.stringify(r.c) === '[true,2,""]'
      && /^# What changed since your last cycle \(Director, since 2026-03-03 10:03 UTC\)$/.test(r.brief?.[0] || '') && /^- landed or done \(1\): T-77$/.test(r.brief?.[1] || '')
      && /dev-cycle-producer\.md first/.test(r.note?.[2] || '') && /read \.studio\/briefs\/dev-cycle-producer\.md/.test(r.note?.[1] || '')
      && JSON.stringify(r.d) === '[true,0,"director+producer"]' && JSON.stringify(r.e) === '[true,2,""]'
      && r.skipped?.length === 4 && r.skipped.every((s) => s[0] === 'cycle'), JSON.stringify(r)];
  });

  await guard('2.84 cycle: STUDIO_CYCLE_QUIET_MAX_H=off wakes every regular cycle as before 2.84, and a cycle that is not the regular one (a milestone closed, the queue low) is never gated', () => {
    resetState();
    const r = probe(`
import { cyclePass } from ${u('harness/dev-cycle.mjs')};
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
let n = 0; const calls = [];
const wakeFn = (role) => { n++; calls.push(role); return { started: true, agent: role + '-' + n }; };
const evs = [];
const res = [];
for (const m of [0, 60, 120]) { const r = await cyclePass({ now: T0 + m * 60000, events: evs, wakeFn }); res.push((r.woke || []).length); evs.push({ ts: at(m + 2), type: 'agent.session.end', agent: 'director-' + (n - 1), meta: { role: 'director' } }, { ts: at(m + 2), type: 'agent.session.end', agent: 'producer-' + n, meta: { role: 'producer' } }); }
console.log(JSON.stringify({ res }));`, { STUDIO_REFILL_MIN: '0', STUDIO_DEV_CYCLE_MIN: '30', STUDIO_CYCLE_QUIET_MAX_H: 'off' });
    resetState();
    const m = probe(`
import { cyclePass } from ${u('harness/dev-cycle.mjs')};
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (x) => new Date(T0 + x * 60000).toISOString();
let n = 0;
const wakeFn = (role) => { n++; return { started: true, agent: role + '-' + n }; };
const evs = [];
const a = await cyclePass({ now: T0, events: evs, wakeFn });
evs.push({ ts: at(2), type: 'agent.session.end', agent: 'director-1', meta: { role: 'director' } }, { ts: at(2), type: 'agent.session.end', agent: 'producer-2', meta: { role: 'producer' } });
evs.push({ ts: at(20), type: 'milestone.closed', agent: 'harness', msg: 'M2 closed' });
const b = await cyclePass({ now: T0 + 60 * 60000, events: evs.filter((e) => e.type !== 'milestone.closed').concat([{ ts: at(59), type: 'milestone.closed', agent: 'harness' }]), wakeFn });
console.log(JSON.stringify({ why: b.why, woke: (b.woke || []).length }));`, { STUDIO_REFILL_MIN: '0', STUDIO_DEV_CYCLE_MIN: '30' });
    return [r.res?.join() === '2,2,2' && m.why === 'a milestone closed' && m.woke === 2, JSON.stringify({ r, m })];
  });

  // ================= the scorecard =================
  await guard('2.84 score: the scorecard prints "Planning sessions that changed nothing: N of M ($X of $Y)" and "Planning wakes skipped: K" under the fifteen measures (meta.outcome.boardEvents first, else the agent\'s board events since its start), keeps them in the record, and leaves the fifteen measures as they were (fails before this fix: no such lines)', () => {
    const r = probe(`
import { planningFlow, planningText, MEASURES } from ${u('harness/score.mjs')};
const T = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T + m * 60000).toISOString();
const ev = [
  { ts: at(0), type: 'agent.session.start', agent: 'producer-1' },
  { ts: at(1), type: 'notes.add', agent: 'producer-1' },
  { ts: at(2), type: 'agent.session.end', agent: 'producer-1', meta: { role: 'producer', costUsd: 0.5 } },
  { ts: at(3), type: 'agent.session.start', agent: 'director-1' },
  { ts: at(4), type: 'task.hold', agent: 'director-1', task: 'T-1' },
  { ts: at(5), type: 'agent.session.end', agent: 'director-1', meta: { role: 'director', costUsd: 1.25 } },
  { ts: at(6), type: 'agent.session.end', agent: 'producer-2', meta: { role: 'producer', costUsd: 0.25, outcome: { boardEvents: 0 } } },
  { ts: at(7), type: 'agent.session.end', agent: 'builder-1', meta: { role: 'builder', costUsd: 9 } },
  { ts: at(8), type: 'agent.wake.skipped', agent: 'supervisor', meta: { kind: 'cycle' } },
];
const p = await planningFlow(ev);
console.log(JSON.stringify({ p, text: planningText(p), n: MEASURES.length }));`);
    const src = fs.readFileSync(path.join(S, 'harness', 'score.mjs'), 'utf8');
    return [r.p?.sessions === 3 && r.p.nothing === 2 && r.text?.[0] === 'Planning sessions that changed nothing: 2 of 3 ($0.75 of $2.00)' && r.text?.[1] === 'Planning wakes skipped: 1' && r.n === 15
      && /planning: await planningFlow\(inWin\)/.test(src) && /\.\.\.score \}/.test(src), JSON.stringify(r)];
  });

  // ================= the launcher =================
  await guard('2.84 launcher: a session for a parked task is not started: startAgent refuses before any lane copy or tool, in the same words task start prints ("T-x can\'t start yet: parked by …"), and emits agent.start.refused with the task and the reason (fails before this fix: the session started, and its first step, task start, was refused)', () => {
    resetState();
    const r = probe(`
import { addTask, startTask } from ${u('harness/task.mjs')};
import { setHold } from ${u('harness/task-hold.mjs')};
import { startAgent } from ${u('harness/agent.mjs')};
import fs from 'node:fs';
const t = addTask({ title: 'Change: a parked thing in game/demo/a.ts', role: 'builder', priority: 'P2' });
setHold(t.id, { parked: { by: 'watchdog', why: 'handed back 3 times in 2 h', at: new Date().toISOString() } }, { by: 'watchdog', msg: 'parked' });
const s = startAgent({ role: 'builder', agent: 'builder-284a', tool: 'custom', task: t.id }, { detach: false });
const ts = startTask(t.id, 'builder-284b');
const ev = fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const ref = ev.filter((e) => e.type === 'agent.start.refused');
const started = ev.filter((e) => e.type === 'agent.session.start' || e.type === 'lane.copy').length;
console.log(JSON.stringify({ id: t.id, s: { ok: s.ok, message: s.message }, ts: ts.message, ref: ref.map((e) => [e.task, e.meta?.kind, e.meta?.reason]), started }));`, { STUDIO_AGENT_CMD: `"${process.execPath}" -e ""` });
    const words = String(r.ts || '');
    return [r.s?.ok === false && /can't start yet: parked by watchdog: handed back 3 times in 2 h/.test(words) && r.s.message === `Not started: ${words}` && r.ref?.length === 1 && r.ref[0][0] === r.id && r.ref[0][1] === 'held' && /parked by watchdog/.test(r.ref[0][2] || '') && r.started === 0, JSON.stringify(r)];
  });

  // ================= 2.84 (a2): the back-off by outcome =================
  await guard('2.84 (a2) pure: the back-off doubles from the base with each quiet session (x2, x4, x8 ...) and stops at the ceiling; no quiet session, news that cuts it short, or a ceiling of 0 (off) never holds a wake back (fails before this fix: no backoffVerdict)', () => {
    const r = probe(`
import { backoffVerdict } from ${WG};
const M = 60000; const T = Date.parse('2026-03-03T10:00:00Z');
const waits = [1, 2, 3, 4, 5].map((q) => backoffVerdict({ quiet: q, lastAt: T, now: T, baseMs: 45 * M, maxH: 12 }).wait / M);
const zero = backoffVerdict({ quiet: 0, lastAt: T, now: T + M, baseMs: 45 * M, maxH: 12 }).skip;
const held = backoffVerdict({ quiet: 2, lastAt: T, now: T + 179 * M, baseMs: 45 * M, maxH: 12 }).skip;
const due = backoffVerdict({ quiet: 2, lastAt: T, now: T + 180 * M, baseMs: 45 * M, maxH: 12 }).skip;
const cut = backoffVerdict({ quiet: 3, lastAt: T, now: T + M, baseMs: 45 * M, maxH: 12, cutShort: true }).skip;
const off = backoffVerdict({ quiet: 3, lastAt: T, now: T + M, baseMs: 45 * M, maxH: 0 }).skip;
console.log(JSON.stringify({ waits, zero, held, due, cut, off }));`);
    return [r.waits?.join() === '90,180,360,720,720' && r.zero === false && r.held === true && r.due === false && r.cut === false && r.off === false, JSON.stringify(r)];
  });

  await guard('2.84 (a2) pure: strong news is an answer by a person or the owner\'s stand-in, a person\'s or the stand-in\'s decision, a person\'s message, a playtest verdict, a dev yes, a phase change (Bible signed, phase override, milestone closed); an agent\'s own answer or decision, a hand-back, a park, a red train and a red trunk are not', () => {
    const r = probe(`
import { isStrongNews, STRONG_NEWS_TYPES } from ${WG};
const yes = [
  { type: 'ask.answered', agent: 'dana', meta: { by: 'dana' } },
  { type: 'ask.answered', agent: 'opus-1', meta: { by: 'dana', recordedBy: 'opus-1', via: 'owner proxy' } },
  { type: 'decision', agent: 'dana', meta: { as: 'person' } },
  { type: 'decision', agent: 'opus-1', meta: { as: 'outside agent' } },
  { type: 'inbound.message', agent: 'dana' }, { type: 'playtest.verdict', agent: 'dana' }, { type: 'task.dev_yes', agent: 'dana' },
  { type: 'bible.signed', agent: 'dana' }, { type: 'bible.phase_override', agent: 'dana' }, { type: 'milestone.closed', agent: 'harness' },
];
const no = [
  { type: 'ask.answered', agent: 'producer-3', meta: { by: 'producer-3' } },
  { type: 'decision', agent: 'producer-362', meta: { as: 'agent' } },
  { type: 'decision', agent: 'director-1', meta: { as: 'autonomous' } },
  { type: 'task.paused', agent: 'builder-s1' }, { type: 'task.hold', agent: 'watchdog' }, { type: 'task.train.unity.dropped', agent: 'unity-train' }, { type: 'trunk.red', agent: 'dana' },
];
console.log(JSON.stringify({ yes: yes.map((e) => isStrongNews(e)), no: no.map((e) => isStrongNews(e)), n: STRONG_NEWS_TYPES.length }));`);
    return [r.yes?.every(Boolean) && r.no?.every((x) => x === false) && r.n === 8, JSON.stringify(r)];
  });

  await guard('2.84 (a2) cycle: through cyclePass: after a cycle that changed nothing the next one waits twice the base, then four times (a hand-back in the digest does not end the wait); the skip says "backing off: N cycles in a row changed nothing; next regular cycle at HH:MM UTC"; a session that changed the board resets that role to the base; after a restart (a new process) the count is still there; strong news (an answer by a person) makes the cycle due at once, ahead of its own timer, and keeps the count; the mode line shows the wait (fails before this fix: every cycle with a hand-back in its digest woke both roles)', () => {
    resetState();
    const SETUP = `
import { cyclePass } from ${u('harness/dev-cycle.mjs')};
import { readWakeGate, backoffClause } from ${WG};
import fs from 'node:fs';
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
const store = '.studio/probe-284a-evs.json';
const evs = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : [];
let n = evs.filter((e) => e.type === 'agent.session.end').length;
const woke = [];
const wakeFn = (role) => { n++; woke.push(role + '-' + n); return { started: true, agent: role + '-' + n }; };
const endAll = (m, board = {}) => { for (const a of woke.splice(0)) { if (board[a.split('-')[0]]) evs.push({ ts: at(m - 1), type: 'task.added', agent: a, task: 'T-9' + n }); evs.push({ ts: at(m), type: 'agent.session.end', agent: a, meta: { role: a.split('-')[0] } }); } };
const step = async (m) => { const r = await cyclePass({ now: T0 + m * 60000, events: evs, wakeFn }); return (r.woke || []).length + ':' + (r.skipped || []).join('+'); };
const save = () => fs.writeFileSync(store, JSON.stringify(evs));
const skips = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.wake.skipped').map((e) => e.msg);
`;
    const env1 = { STUDIO_REFILL_MIN: '0', STUDIO_DEV_CYCLE_MIN: '30' };
    const a = probe(`${SETUP}
const seq = [];
seq.push(await step(0)); endAll(2);
evs.push({ ts: at(20), type: 'task.paused', task: 'T-5', agent: 'builder-s1', msg: 'handed back' });
seq.push(await step(30));            // quiet 1: wait 60, due 11:00: skipped although a hand-back is in the digest
seq.push(await step(60)); endAll(62); // due: wakes; nothing changed again: quiet 2
evs.push({ ts: at(80), type: 'task.paused', task: 'T-6', agent: 'builder-s2', msg: 'handed back' });
seq.push(await step(90)); seq.push(await step(150)); // wait 120 from 60: due 12:00
seq.push(await step(180)); endAll(182, { director: true }); // the Director's session added a task, the Producer's did not
save();
const st = readWakeGate();
console.log(JSON.stringify({ seq, msgs: skips().slice(0, 2), q: [st['cycle:director']?.quiet, st['cycle:producer']?.quiet] }));`, env1);
    // a new process: the state is read back from disk
    const b = probe(`${SETUP}
const seq = [];
evs.push({ ts: at(200), type: 'task.paused', task: 'T-7', agent: 'builder-s3', msg: 'handed back' });
seq.push(await step(210));           // Director reset to the base: due, wakes; Producer quiet 3: wait 240 from 180: skipped
endAll(212);
evs.push({ ts: at(220), type: 'ask.answered', agent: 'dana', meta: { by: 'dana' }, msg: 'A-1 answered by dana: yes' });
seq.push(await step(225));           // 15 min after the last cycle: due at once on the answer, both wake
endAll(227);
seq.push(await step(270));
const st = readWakeGate();
const all = skips();
console.log(JSON.stringify({ seq, q: [st['cycle:director']?.quiet, st['cycle:producer']?.quiet], last: all.slice(-2), clause: backoffClause(T0 + 270 * 60000) }));`, env1);
    const ok = a.seq?.join() === '2:,0:director+producer,2:,0:director+producer,0:director+producer,2:' && a.q?.join() === '2,2'
      && /^Director wake skipped \(regular cycle\): backing off: 1 cycle in a row changed nothing; next regular cycle at 11:00 UTC \(or sooner on an answer, an owner order or a phase change\)$/.test(a.msgs?.[0] || '')
      && b.seq?.join() === '1:producer,2:,0:director+producer' && b.q?.join() === '2,4'
      && /Director wake skipped \(regular cycle\): backing off: 2 cycles in a row changed nothing; next regular cycle at 15:45 UTC/.test(b.last?.[0] || '')
      && /Producer wake skipped \(regular cycle\): backing off: 4 cycles in a row changed nothing; next regular cycle at 21:45 UTC/.test(b.last?.[1] || '')
      && /^backed off: the Director's next regular cycle at 15:45 UTC \(2 quiet in a row\); the Producer's next regular cycle at 21:45 UTC \(4 quiet in a row\)$/.test(b.clause || '');
    return [ok, JSON.stringify({ a, b })];
  });

  await guard('2.84 (a2) queue: through queueDepthPass: after a queue-depth session that added no task the next wake waits twice the base, then four times; new open task ids alone do NOT end the wait; a blocked area that frees up ends it at once; a session that added a task resets it; the queue reaching its target and falling short again ends it; STUDIO_WAKE_SAME_MAX_H=off wakes as 2.83 did (fails before this fix: any new task id woke the Producer again)', () => {
    resetState();
    const r = probe(`
import { queueDepthPass } from ${u('harness/queue-depth.mjs')};
const T0 = Date.parse('2026-03-03T10:00:00Z'); const at = (m) => new Date(T0 + m * 60000).toISOString();
const park = { by: 'watchdog', why: 'handed back 3 times in 2 h', at: at(0) };
const b = (id) => ({ id, title: 'Change: ' + id, role: 'builder' });
const rv = (id) => ({ id, title: 'Docs: ' + id, role: 'reviewer' });
const holdsAB = { 'T-1': { lane: 'game/a', parked: park }, 'T-2': { lane: 'game/b', parked: park } };
const holdsA = { 'T-1': { lane: 'game/a', parked: park }, 'T-2': { lane: 'game/b' } };
const q = (extra = []) => ({ inProgress: [], backlog: [b('T-1'), b('T-2'), ...extra], done: [] });
let n = 0; const evs = []; const live = [];
const run = async (m, qq, holds, env = {}) => { const r = await queueDepthPass({ q: qq, cap: 3, now: T0 + m * 60000, env: { STUDIO_REFILL_WAKE: 'on', STUDIO_QUEUE_DEPTH_ASK_MIN: '10', ...env }, deps: { holds, events: [], lineStatus: null, wakeEvents: evs, wake: async () => { n++; live.push('producer-' + n); return { started: true, agent: 'producer-' + n }; } } }); return r.woke?.skipped ? (r.woke.why.startsWith('backing off') ? 'back' : 'skip') : r.woke?.started ? 'wake' : (r.asked ? 'asked' : 'none'); };
const end = (m, added = 0) => { for (const a of live.splice(0)) { for (let i = 0; i < added; i++) evs.push({ ts: at(m - 1), type: 'task.added', agent: a, task: 'T-' + (80 + i) }); evs.push({ ts: at(m), type: 'agent.session.end', agent: a, meta: { role: 'producer' } }); } };
const seq = [];
seq.push(await run(0, q(), holdsAB)); end(2);                    // wake; added nothing: quiet 1 (wait 20)
seq.push(await run(10, q([rv('T-50')]), holdsAB));              // new ids only: held back
seq.push(await run(20, q([rv('T-50')]), holdsAB)); end(22);     // due: wake; quiet 2 (wait 40, due 11:00)
seq.push(await run(30, q([rv('T-51')]), holdsAB));              // new ids only: held back
seq.push(await run(40, q([rv('T-51')]), holdsA)); end(42, 1);   // area game/b freed: wake at once; it added a task: reset
seq.push(await run(50, q([rv('T-51'), rv('T-52')]), holdsA)); end(52); // base wait only: wake; added nothing: quiet 1 (due 11:10)
seq.push(await run(55, { inProgress: [], backlog: [b('T-3'), b('T-4'), b('T-5')], done: [] }, {})); // the queue reached its target
seq.push(await run(57, q([rv('T-53')]), holdsA));               // short again: the wait ended
end(59);
seq.push(await run(70, q([rv('T-54')]), holdsA));               // quiet 1 again: held back
seq.push(await run(80, q([rv('T-55')]), holdsA, { STUDIO_WAKE_SAME_MAX_H: 'off' })); // off: as 2.83
console.log(JSON.stringify({ seq }));`);
    return [r.seq?.join() === 'wake,back,wake,back,wake,wake,none,wake,back,wake', JSON.stringify(r)];
  });

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* the OS cleans its temp folder */ }
}
