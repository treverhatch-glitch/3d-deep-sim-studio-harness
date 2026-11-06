/**
 * qa/selftest-2791d.mjs — 2.79.1 (d): a small trim of the event volume (the crew's 2.79.0 run wrote 3,349 events in 7.75 h).
 *   1. futility.shadow after a session end: one hourly summary (the record file keeps every one).
 *   2. skill.follow per session: counted per model (.studio/skill-follow.json, what the scorecard reads) + an hourly summary.
 *   3. lock.kept and director.flow "kept T-x (busy ...)": written on change only.
 *   4. task.overlap: once per task and set of overlaps.
 *   5. agent.agy_continue: counted in the session end (followUps), not one event each.
 *   6. a game tester run (qa/reports/tester/<run>/summary.json) satisfies the "playtest of the current build" row.
 *   7. STUDIO_VISUAL_GATE unset: off when the game has no capture command.
 *   8. agent.heartbeat: one event per STUDIO_HEARTBEAT_EVENT_MIN (10) minutes per session; metrics' stall gap follows it.
 *   9. the replay: a representative event mix through the old and the new emit paths.
 * A temp copy of the studio per check; probe scripts run in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2791D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HEALTH_CI: 'off', STUDIO_RAM_FLOOR_GB: '0',
    STUDIO_TEST_FREEMEM_MB: '32000', STUDIO_LINE_PRODUCER: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2791d-${process.pid}.pem`),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const studio = (name, { git = false } = {}) => {
    const S = path.join(tmpRoot, `2791d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });
    const ev = path.join(S, '.studio', 'events-2791d.jsonl');
    writeIn(S, '.studio/events-2791d.jsonl', '');
    if (git) {
      g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
      g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    }
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: '' } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 });
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2791d-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const count = (ev, type) => events(ev).filter((e) => e.type === type).length;

  // ---- 1: futility.shadow ----
  {
    const { S, ev, env } = studio('futility');
    const run = (extra) => probe(S, `import fs from 'node:fs';
import { futilityPass } from ${u(S, 'harness/futility.mjs')};
const t0 = Date.parse('2026-11-05T10:00:00Z');
const flagged = {}; const evs = [];
for (let i = 0; i < 5; i++) {
  flagged['builder-s' + i] = { at: new Date(t0 + i * 60000).toISOString(), task: 'T-90' + i, type: 'change', kind: 'tokens', mode: 'shadow', tokensAt: 1000 };
  evs.push({ ts: new Date(t0 + i * 60000 + 30000).toISOString(), type: 'agent.session.end', agent: 'builder-s' + i, tokensIn: 5000, tokensOut: 100, meta: { role: 'builder', outcome: { task: 'T-90' + i, done: false } } });
}
fs.mkdirSync('.studio', { recursive: true });
fs.writeFileSync('.studio/futility.json', JSON.stringify({ flagged }));
const sent = [];
const r = futilityPass({ sessions: [], events: evs, now: t0 + 20 * 60000, emit: (e) => sent.push(e.type), env: { STUDIO_FUTILITY: 'shadow', ...${JSON.stringify(extra || {})} } });
let counter = null; try { counter = JSON.parse(fs.readFileSync('.studio/telemetry/futility.shadow.json', 'utf8')).count; } catch {}
let log = 0; try { log = fs.readFileSync('.studio/futility-log.jsonl', 'utf8').split('\\n').filter(Boolean).length; } catch {}
console.log(JSON.stringify({ logged: r.logged.length, sent, counter, log }));
`, env);
    const r = run();
    await guard('2.79.1 (d): five futility.shadow reports (five flagged sessions that ended) write no event, are counted for the hour (counter file: 5) and all five stay in .studio/futility-log.jsonl (fails on 2.79.0: five futility.shadow events)', () => [
      r.j && r.j.logged === 5 && !r.j.sent.includes('futility.shadow') && r.j.counter === 5 && r.j.log === 5, JSON.stringify({ j: r.j, out: out(r).slice(-400) })]);
    const { S: S2, env: env2 } = studio('futility-full');
    const f = probe(S2, fs.readFileSync(path.join(S, fs.readdirSync(S).find((x) => x.startsWith('.probe-2791d-') && fs.readFileSync(path.join(S, x), 'utf8').includes('futilityPass'))), 'utf8').replace(/\.\.\.\{\}/, "...{ STUDIO_TELEMETRY: 'full' }").split(u(S, 'harness/futility.mjs')).join(u(S2, 'harness/futility.mjs')), env2);
    await guard('2.79.1 (d): STUDIO_TELEMETRY=full writes each futility.shadow as an event again', () => [f.j && f.j.sent.filter((t) => t === 'futility.shadow').length === 5, JSON.stringify({ j: f.j, out: out(f).slice(-300) })]);
    void ev;
  }

  // ---- 2: skill.follow ----
  {
    const { S, ev, env } = studio('skill');
    writeIn(S, 'studio/skills/zz-plain.md', '# Skill: zz-plain\n\n**Steps.**\n1. Do it.\n');
    writeIn(S, 'studio/skills/zz-proof.md', '---\nevidence:\n  - /npm run verify\\b/\n---\n# Skill: zz-proof\n\n**Steps.**\n1. Prove it.\n');
    for (const a of ['sf-1', 'sf-2', 'sf-3']) writeIn(S, `.studio/kickoff/${a}.md`, `You are a builder agent.\nRead \`studio/skills/${a === 'sf-3' ? 'zz-plain' : 'zz-proof'}.md\`.\n`);
    const code = (X) => `import { recordFollow, followRates } from ${u(X, 'harness/scorecard.mjs')};
import { readRecentEvents } from ${u(X, 'harness/event.mjs')};
import fs from 'node:fs';
recordFollow({ agent: 'sf-1', model: 'model-a', log: 'Read studio/skills/zz-proof.md\\nnpm run verify passed' });
recordFollow({ agent: 'sf-2', model: 'model-a', log: 'edited a file and stopped' });
recordFollow({ agent: 'sf-3', model: 'model-b', log: 'cat studio/skills/zz-plain.md' });
const rows = followRates(readRecentEvents(0));
const evs = readRecentEvents(0).filter((e) => e.type === 'skill.follow');
let counter = null; try { counter = JSON.parse(fs.readFileSync('.studio/skill-follow.json', 'utf8')); } catch {}
console.log(JSON.stringify({ rows, events: evs.length, counted: counter && Object.keys(counter.models) }));`;
    const r = probe(S, code(S), env);
    const a = r.j?.rows?.find((x) => x.model === 'model-a') || {};
    const b = r.j?.rows?.find((x) => x.model === 'model-b') || {};
    await guard('2.79.1 (d): three sessions\' skill follow-ups write no skill.follow event, yet the scorecard\'s per-model rows are right (model-a: 2 sessions, 2 skills given, 1 loaded, 1 followed; model-b: 1 given, 1 loaded, unknown) from the counter (fails on 2.79.0: three skill.follow events)', () => [
      r.j && r.j.events === 0 && a.sessions === 2 && a.given === 2 && a.loaded === 1 && a.followed === 1 && a.loadedRate === 0.5 && b.sessions === 1 && b.given === 1 && b.loadedRate === 1 && b.unknown === 1,
      JSON.stringify({ j: r.j, out: out(r).slice(-400) })]);
    const { S: S2, env: env2 } = studio('skill-full');
    for (const x of ['zz-plain', 'zz-proof']) fs.copyFileSync(path.join(S, 'studio/skills', `${x}.md`), (writeIn(S2, `studio/skills/${x}.md`, ''), path.join(S2, 'studio/skills', `${x}.md`)));
    for (const a2 of ['sf-1', 'sf-2', 'sf-3']) fs.copyFileSync(path.join(S, `.studio/kickoff/${a2}.md`), (writeIn(S2, `.studio/kickoff/${a2}.md`, ''), path.join(S2, `.studio/kickoff/${a2}.md`)));
    const f = probe(S2, code(S2), { ...env2, STUDIO_TELEMETRY: 'full' });
    const fa = f.j?.rows?.find((x) => x.model === 'model-a') || {};
    await guard('2.79.1 (d): STUDIO_TELEMETRY=full writes each skill.follow as an event again, and the scorecard counts each session once (not twice)', () => [
      f.j && f.j.events === 3 && fa.sessions === 2 && fa.given === 2, JSON.stringify({ j: f.j, out: out(f).slice(-300) })]);
    void ev;
  }

  // ---- 3: lock.kept and director.flow ----
  {
    const { S, ev, env } = studio('kept', { git: true });
    const t = node(S, ['harness/task.mjs', 'add', 'Tune the fee curve', '--role', 'builder', '--priority', 'P1'], env);
    const id = (out(t).match(/"id":\s*"(T-\d+)"/) || [])[1];
    const s = node(S, ['harness/task.mjs', 'start', id, '--agent', 'builder-k1'], { ...env, STUDIO_LOCK_OWNER: 'builder-k1' });
    const r = probe(S, `import { flowPass } from ${u(S, 'harness/director-flow.mjs')};
import { release } from ${u(S, 'harness/lock.mjs')};
import { emitEvent, readRecentEvents } from ${u(S, 'harness/event.mjs')};
const id = ${JSON.stringify(id)};
const t0 = Date.now();
const kinds = () => { const e = readRecentEvents(0); return { kept: e.filter((x) => x.type === 'lock.kept').length, flow: e.filter((x) => x.type === 'director.flow' && /kept/.test(x.msg)).length }; };
// the owner is working outside the launcher: an event of its own on the task, its claim ran out (released here)
emitEvent({ type: 'agent.note', agent: 'builder-k1', task: id, msg: 'working' });
release('task:' + id, 'builder-k1');
await flowPass({ fill: false, now: t0 });
const first = kinds();
const msgs = [];
for (const min of [31, 62, 93]) {
  emitEvent({ type: 'agent.note', agent: 'builder-k1', task: id, msg: 'still working' });
  release('task:' + id, 'builder-k1');
  await flowPass({ fill: false, now: t0 + min * 60000 });
}
console.log(JSON.stringify({ first, after: kinds() }));
`, { ...env, STUDIO_CLAIM_ACTIVE_MIN: '600' });
    await guard('2.79.1 (d): a task kept for its working owner over four flow passes an hour apart (the claim made again each time) writes ONE lock.kept and ONE director.flow "kept ..." line (fails on 2.79.0: a director.flow line every 30 minutes and a lock.kept for each made claim)', () => [
      Boolean(id) && s.status === 0 && r.j && r.j.first.kept === 1 && r.j.first.flow === 1 && r.j.after.kept === 1 && r.j.after.flow === 1,
      JSON.stringify({ id, start: out(s).slice(-200), j: r.j, out: out(r).slice(-500) })]);
    void ev;
  }

  // ---- 4: task.overlap ----
  {
    const { S, ev, env } = studio('overlap');
    const code = (other, n) => `import { overlapCheck } from ${u(S, 'harness/task-overlap.mjs')};
const board = (title) => ({ inProgress: [], backlog: [{ id: ${JSON.stringify(other)}, title, role: 'builder' }] });
const ask = (id, phase, title) => overlapCheck({ id, title: 'Fix the fee panel overflow on resize', phase, agent: 'b1', board: board(title), inFlight: [], root: process.cwd() });
const a = ask('T-9', 'add', 'Fix fee panel overflow');
for (let i = 1; i < ${n}; i++) ask('T-9', 'start', 'Fix fee panel overflow');
console.log(JSON.stringify({ found: a.found.length }));`;
    const r = probe(S, code('T-8', 4), env);
    const mid = count(ev, 'task.overlap');
    // a new task it overlaps is a change and is written
    const r2 = probe(S, code('T-7', 1), env);
    const all = events(ev).filter((e) => e.type === 'task.overlap');
    await guard('2.79.1 (d): four overlap checks of one task (an add and three starts) naming the same task write ONE task.overlap (with its items); another task or file it overlaps is written too (fails on 2.79.0: four events)', () => [
      r.j && r.j.found > 0 && mid === 1 && all.length === 2 && all[0].meta?.items?.[0]?.with === 'T-8', JSON.stringify({ r: r.j, mid, n: all.length, out: out(r).slice(-300) + out(r2).slice(-300) })]);
    const rf = probe(S, code('T-8', 4), { ...env, STUDIO_TELEMETRY: 'full' });
    await guard('2.79.1 (d): STUDIO_TELEMETRY=full writes every task.overlap again', () => [rf.j && count(ev, 'task.overlap') === all.length + 4, JSON.stringify({ n: count(ev, 'task.overlap'), out: out(rf).slice(-300) })]);
  }

  // ---- 5: agent.agy_continue ----
  {
    const { S, ev, env } = studio('agy');
    const r = probe(S, `import { agyContinueEvent, cleanUp, AGENTS_DIR } from ${u(S, 'harness/agent.mjs')};
import { readRecentEvents } from ${u(S, 'harness/event.mjs')};
import fs from 'node:fs';
const sent = [];
for (let n = 1; n <= 3; n++) agyContinueEvent('builder-g1', 'T-5', { n, task: 'T-5', why: 'a background command' }, {}, (e) => sent.push(e.type));
const full = [];
agyContinueEvent('builder-g1', 'T-5', { n: 1, task: 'T-5', why: 'quiet', nudge: true }, { STUDIO_TELEMETRY: 'full' }, (e) => full.push(e));
fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.writeFileSync(AGENTS_DIR + '/builder-g1.json', JSON.stringify({ agent: 'builder-g1', role: 'builder', tool: 'agy', model: 'm', status: 'running', startedAt: new Date().toISOString() }));
cleanUp('builder-g1', { code: 0, log: 'done', role: 'builder', tool: 'agy', model: 'm', followUps: 3, nudges: 1 });
const end = readRecentEvents(0).filter((e) => e.type === 'agent.session.end' && e.agent === 'builder-g1').pop();
console.log(JSON.stringify({ sent, full: full.length, nudge: full[0]?.meta?.nudge, followUps: end?.meta?.followUps, nudges: end?.meta?.nudges }));
`, env);
    await guard('2.79.1 (d): an agy session\'s follow-ups write no agent.agy_continue event by default and are counted in its session end (meta.followUps 3, nudges 1); STUDIO_TELEMETRY=full keeps the event (fails on 2.79.0: no followUps in the end, an event each)', () => [
      r.j && r.j.sent.length === 0 && r.j.full === 1 && r.j.nudge === true && r.j.followUps === 3 && r.j.nudges === 1, JSON.stringify({ j: r.j, out: out(r).slice(-500) })]);
    void ev;
  }

  // ---- 6: the playtest row ----
  {
    const { S, env } = studio('playtest', { git: true });
    const run = (withTester) => {
      if (withTester) {
        writeIn(S, 'qa/reports/tester/run-1/summary.json', `${JSON.stringify({ verdicts: { 'first minutes': 'ok' }, bible: {}, bugs: [] })}\n`);
        const later = new Date(Date.now() + 5000);
        fs.utimesSync(path.join(S, 'qa/reports/tester/run-1/summary.json'), later, later);
      }
      return probe(S, `import { checkDone } from ${u(S, 'harness/done-check.mjs')};
const r = checkDone({ id: 'T-77', title: 'Playtest the build', role: 'qa', type: 'playtest' }, 0);
console.log(JSON.stringify({ type: r.type, rows: r.checks.filter((c) => /playtest/i.test(c.label)).map((c) => ({ label: c.label.slice(0, 90), ok: c.ok })) }));
`, env);
    };
    const without = run(false);
    const withT = run(true);
    await guard('2.79.1 (d): the "playtest of the current build" rows are not met by nothing, and a game tester run (its summary.json) newer than the task start and the last game change meets them where stage 1 would have been asked (fails on 2.79.0: "Playtest report since the task started")', () => [
      without.j?.type === 'playtest' && without.j.rows.some((r) => !r.ok) && withT.j?.type === 'playtest' && withT.j.rows.length > 0 && withT.j.rows.every((r) => r.ok) && withT.j.rows.some((r) => /tester/i.test(r.label)),
      JSON.stringify({ without: without.j, withT: withT.j, out: out(withT).slice(-400) })]);
  }

  // ---- 7: the visual gate ----
  {
    const { S, env } = studio('visual');
    writeIn(S, 'game/zzgame/index.html', '<html></html>\n');
    const code = `import { summarize } from ${u(S, 'harness/verdict-split.mjs')};
const t = { id: 'T-61', title: 'Fix scene lighting and the water shader render', role: 'builder' };
const s = summarize('T-61', t);
let gate = null; try { gate = (await import(${u(S, 'harness/visual-capture.mjs')})).visualGate(t); } catch {}
console.log(JSON.stringify({ render: s.render, ok: s.ok, why: s.why.slice(0, 120), gate }));`;
    const noCmd = probe(S, code, { ...env, STUDIO_GAME: 'zzgame' });
    const forced = probe(S, code, { ...env, STUDIO_GAME: 'zzgame', STUDIO_VISUAL_GATE: 'on' });
    writeIn(S, 'game/zzgame/studio.gates.json', `${JSON.stringify({ visual: { capture: 'node capture.mjs {out}' } })}\n`);
    const withCmd = probe(S, code, { ...env, STUDIO_GAME: 'zzgame' });
    await guard('2.79.1 (d): STUDIO_VISUAL_GATE unset and the game has no capture command: a render task is not blocked and the gate says why (a note naming studio.gates.json); with a capture command, or STUDIO_VISUAL_GATE=on, it is blocked as before (fails on 2.79.0: "a render task needs a visual result")', () => [
      noCmd.j?.render === true && noCmd.j.ok === true && noCmd.j.gate?.on === false && /no capture command/.test(noCmd.j.gate.note || '') && /studio\.gates\.json/.test(noCmd.j.gate.note || '')
        && forced.j?.ok === false && withCmd.j?.ok === false && withCmd.j.gate?.on === true,
      JSON.stringify({ noCmd: noCmd.j, forced: forced.j, withCmd: withCmd.j, out: out(noCmd).slice(-300) })]);
  }

  // ---- 8: heartbeat ----
  {
    const { S, env } = studio('beat');
    const r = probe(S, `import { heartbeatEventMs, heartbeatDue } from ${u(S, 'harness/agent.mjs')};
import { attemptRows } from ${u(S, 'harness/metrics.mjs')};
const env = {};
const t0 = Date.parse('2026-11-05T10:00:00Z');
// a session's 2-minute beats for 40 minutes: how many are written
let last = 0; let written = 0; let beats = 0;
for (let m = 2; m <= 40; m += 2) { beats++; if (heartbeatDue(last, t0 + m * 60000, env)) { last = t0 + m * 60000; written++; } }
let lastF = 0; let writtenF = 0;
for (let m = 2; m <= 40; m += 2) if (heartbeatDue(lastF, t0 + m * 60000, { STUDIO_TELEMETRY: 'full' })) { lastF = t0 + m * 60000; writtenF++; }
const set = heartbeatEventMs({ STUDIO_HEARTBEAT_EVENT_MIN: '3' });
const iso = (m) => new Date(t0 + m * 60000).toISOString();
const evs = [{ ts: iso(0), type: 'task.start', agent: 'b1', task: 'T-1', msg: 's' }];
for (let m = 2; m <= 60; m += 10) evs.push({ ts: iso(m), type: 'agent.heartbeat', agent: 'b1', msg: 'alive', meta: { everyMin: 10 } });
evs.push({ ts: iso(62), type: 'task.done', agent: 'b1', task: 'T-1', msg: 'd' });
const row = attemptRows(evs, { now: t0 + 90 * 60000 }).find((x) => x.task === 'T-1');
const gap = [{ ts: iso(0), type: 'task.start', agent: 'b1', task: 'T-2', msg: 's' }, { ts: iso(2), type: 'agent.heartbeat', agent: 'b1', msg: 'alive', meta: { everyMin: 10 } }, { ts: iso(50), type: 'agent.heartbeat', agent: 'b1', msg: 'alive', meta: { everyMin: 10 } }, { ts: iso(52), type: 'task.done', agent: 'b1', task: 'T-2', msg: 'd' }];
const row2 = attemptRows(gap, { now: t0 + 90 * 60000 }).find((x) => x.task === 'T-2');
console.log(JSON.stringify({ beats, written, writtenF, ms: heartbeatEventMs({}), msFull: heartbeatEventMs({ STUDIO_TELEMETRY: 'full' }), set, zero: heartbeatEventMs({ STUDIO_HEARTBEAT_EVENT_MIN: '0' }), stalled: row?.stalledMin, stalledGap: row2?.stalledMin }));
`, env);
    await guard('2.79.1 (d): a session\'s 2-minute beats write an agent.heartbeat every STUDIO_HEARTBEAT_EVENT_MIN (10) minutes (20 beats in 40 minutes: 4 events; =3 gives 3 min, 0 and STUDIO_TELEMETRY=full every beat), and the metrics\' stall gap follows the event interval: 10-minute heartbeats are no stall, a 48-minute silence still is (fails on 2.79.0: no heartbeatDue; every 10-minute gap read as a stall)', () => [
      r.j && r.j.beats === 20 && r.j.written === 4 && r.j.writtenF === 20 && r.j.ms === 600000 && r.j.set === 180000 && r.j.zero === 0 && r.j.msFull === 0 && r.j.stalled === 0 && r.j.stalledGap > 30,
      JSON.stringify({ j: r.j, out: out(r).slice(-500) })]);
  }

  // ---- 9: the replay ----
  {
    const { S, env } = studio('replay');
    // The crew's 2.79.0 run: 7.75 h, 97 sessions. Types and counts from its event log; the per-task and per-episode shapes
    // (3 overlap checks per task, 6 busy episodes) are assumptions, said in the CHANGELOG.
    const code = `import fs from 'node:fs';
import { emitSampled, emitOnChange } from ${u(S, 'harness/telemetry.mjs')};
import { heartbeatDue } from ${u(S, 'harness/agent.mjs')};
const HOURS = 7.75; const MIN = HOURS * 60;
const t0 = Date.parse('2026-11-05T08:00:00Z');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const at = (i, n) => t0 + Math.round((i + 0.5) * (MIN / n) * 60000);
function replay(env) {
  rm('.studio/telemetry'); rm('.studio/emit-seen.json');
  const sent = {};
  const emit = (e) => { sent[e.type] = (sent[e.type] || 0) + 1; };
  // agent.heartbeat: 882 beats over 97 sessions (2 min apart, ~9 each); the event per beat, or per 10 minutes
  let beats = 0;
  for (let s = 0; s < 97; s++) {
    const k = s < 9 ? 10 : 9; let last = 0;
    for (let b = 1; b <= k; b++) { const now = t0 + s * 4.8 * 60000 + b * 2 * 60000; beats++; if (heartbeatDue(last, now, env)) { last = now; emit({ type: 'agent.heartbeat' }); } }
  }
  for (let i = 0; i < 97; i++) emitSampled({ type: 'skill.follow', agent: 'a', msg: 's', meta: {} }, i % 2 ? 'model-a' : 'model-b', { now: at(i, 97), env, emit });
  for (let i = 0; i < 8; i++) emitSampled({ type: 'futility.shadow', agent: 'supervisor', msg: 'f', meta: {} }, 'x', { now: at(i, 8), env, emit });
  // task.overlap: 109 checks over 36 tasks (an add, and the starts), the same overlaps each time (3 each, 1 extra)
  for (let i = 0; i < 109; i++) { const task = 'T-' + (i % 36); emitOnChange({ type: 'task.overlap' }, 'task.overlap|' + task, 'diff:T-1:game/sim.ts', { env, now: at(i, 109), emit }); }
  // agent.agy_continue: 19 follow-ups, counted in the session end instead
  if (env.STUDIO_TELEMETRY === 'full') for (let i = 0; i < 19; i++) emit({ type: 'agent.agy_continue' });
  return { sent, beats };
}
const before = replay({ STUDIO_TELEMETRY: 'full' });
const after = replay({});
// lock.kept and director.flow: the 2.79.0 counts are the log's (18, 30); the new path is the claim made again at each of 6
// busy episodes' starts and each change: the on-change writer with the 6 h repeat, over 18 claim-makings in 6 episodes
rm('.studio/emit-seen.json');
const kept = { before: 18, after: 0 }; const flow = { before: 30, after: 0 };
for (let i = 0; i < 18; i++) emitOnChange({ type: 'lock.kept' }, 'lock.kept|T-' + (i % 6), 'builder-1|director|owner is working', { repeatMin: 360, now: at(i, 18), emit: () => { kept.after++; } });
let prevSig = null;
for (let i = 0; i < 30; i++) { const sig = 'kept T-' + (Math.floor(i / 5) % 6); if (sig !== prevSig) flow.after++; prevSig = sig; }
console.log(JSON.stringify({ before: before.sent, after: after.sent, beats: before.beats, kept, flow }));
`;
    const r = probe(S, code, env);
    const j = r.j;
    const tot = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
    const sumB = j ? tot(j.before) + j.kept.before + j.flow.before : 0;
    const sumA = j ? tot(j.after) + j.kept.after + j.flow.after : 0;
    const rows = j ? [...new Set([...Object.keys(j.before), ...Object.keys(j.after)])].map((t) => `${t} ${j.before[t] || 0} -> ${j.after[t] || 0}`).concat([`lock.kept ${j.kept.before} -> ${j.kept.after}`, `director.flow ${j.flow.before} -> ${j.flow.after}`]) : [];
    await guard('2.79.1 (d): replaying the crew\'s 7.75 h mix of the trimmed types (882 heartbeats, 109 task.overlap, 97 skill.follow, 30 director.flow, 19 agy_continue, 18 lock.kept, 8 futility.shadow) writes at least 60% fewer events than the per-event paths (fails on 2.79.0: no heartbeatDue, no emitOnChange)', () => [
      j && j.beats === 882 && j.before['agent.heartbeat'] === 882 && j.before['skill.follow'] === 97 && j.before['task.overlap'] === 109 && sumB > 0 && (sumB - sumA) / sumB >= 0.6 && !j.after['agent.agy_continue'],
      `before ${sumB} -> after ${sumA} (${sumB ? Math.round(((sumB - sumA) / sumB) * 100) : 0}% fewer): ${rows.join('; ')} ${j ? '' : out(r).slice(-400)}`]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}
