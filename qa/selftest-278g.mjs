/**
 * qa/selftest-278g.mjs — 2.78.0 (PU-62, PU-63): switch on what was measured in shadow, and stop retry storms.
 *   PU-62  STUDIO_FUTILITY=auto (the default): a task type's futility cap is enforced only with enough good runs and a
 *          shadow record where at most STUDIO_FUTILITY_AUTO_MAX_LATE (0.10) of the stopped-in-theory sessions succeeded
 *          anyway; otherwise it stays shadow. The routing holdout stays 0 unless set (the owner deferred it); a set share is used.
 *   PU-63  a refused start backs off 2, 4, 8 ... min (reset on a new reason or state); the supervisor's loop is jittered
 *          +-10%; nextAgentName skips a name whose .lanes/<name> folder is left over.
 * Unit-level: each check imports the module from a copy of the repo and calls its exported functions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278G({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', STUDIO_WORKTREES: '',
    STUDIO_FUTILITY: '', STUDIO_FUTILITY_MIN_N: '', STUDIO_FUTILITY_AUTO_MAX_LATE: '', STUDIO_FUTILITY_AUTO_MIN_SHADOW: '', STUDIO_START_BACKOFF_MAX_MIN: '', STUDIO_SUPERVISOR_JITTER: '',
    CLAUDECODE: '', AI_AGENT: '', NODE_OPTIONS: '', ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `278g-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-278g.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-278g-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-2000) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const want = (k) => !process.env.ONLY_278G || process.env.ONLY_278G.split(',').includes(k);

  // ---- PU-62: futility auto ----
  if (want('fut')) await guard('2.78.0 (PU-62): STUDIO_FUTILITY=auto (the default) enforces a type only with >= 20 good runs and <= 10% of its shadow-flagged sessions succeeding anyway, else stays shadow; futility.auto_on once per type; a flagged session that ends logs taskDone (fails on 2.77.1: the default is shadow, no auto mode, no taskDone)', async () => {
    const { S, env } = studio('fut');
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import { futilityMode, autoDecision, futilityPass, FUTILITY_LOG } from ${u(S, 'harness/futility.mjs')};
const res = {};
res.defaultMode = futilityMode({}); res.shadowMode = futilityMode({ STUDIO_FUTILITY: 'shadow' }); res.onMode = futilityMode({ STUDIO_FUTILITY: 'on' }); res.offMode = futilityMode({ STUDIO_FUTILITY: 'off' });
const rows = (k, late, mode = 'shadow', type = 'builder') => Array.from({ length: k }, (_, i) => ({ type, mode, cutGoodRun: i < late, taskDone: false }));
const norms = (nn) => ({ builder: { n: nn, p90Tokens: 1000, p90Ms: null } });
res.d = {
  enough: autoDecision('builder', norms(25), rows(10, 1), {}).enforce,          // 10% late: on
  tooLate: autoDecision('builder', norms(25), rows(10, 2), {}).enforce,         // 20%: shadow
  fewGood: autoDecision('builder', norms(19), rows(10, 0), {}).enforce,         // 19 good runs: shadow
  noLog: autoDecision('builder', norms(25), [], {}).enforce,                    // no data: shadow
  fewShadow: autoDecision('builder', norms(25), rows(2, 0), {}).enforce,        // 2 records: shadow
  onlyOn: autoDecision('builder', norms(25), rows(10, 0, 'on'), {}).enforce,    // records made while enforcing don't count
  otherType: autoDecision('builder', norms(25), rows(10, 0, 'shadow', 'docs'), {}).enforce,
  taskDoneCounts: autoDecision('builder', norms(25), rows(10, 0).map((x, i) => ({ ...x, taskDone: i < 3 })), {}).enforce,
};
// A pass: 20 good builder runs, one live session past the p90.
const t0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (m) => new Date(t0 + m * 60000).toISOString();
const events = [];
for (let i = 0; i < 20; i++) {
  events.push({ type: 'agent.session.start', agent: 'g' + i, task: 'T-' + i, ts: iso(i * 10), meta: { role: 'builder' } });
  events.push({ type: 'agent.session.end', agent: 'g' + i, task: 'T-' + i, ts: iso(i * 10 + 5), tokensIn: 1000, tokensOut: 0, meta: { role: 'builder', outcome: { done: true, task: 'T-' + i } } });
}
const live = [{ agent: 'slow', role: 'builder', task: 'T-99', running: true, startedAt: iso(300) }];
const mk = () => { const paused = []; const emitted = []; return { paused, emitted, pause: (a) => { paused.push(a); return { ok: true }; }, emit: (e) => emitted.push(e) }; };
// 1. no shadow data: stays shadow.
const a = mk();
const p1 = futilityPass({ sessions: live, events, now: t0 + 301 * 60000, env: {}, readTokens: () => 5000, pause: a.pause, emit: a.emit });
res.noData = { paused: a.paused.length, autoOn: a.emitted.filter((e) => e.type === 'futility.auto_on').length, checkMode: p1.checks[0]?.meta?.mode, text: p1.checks[0]?.msg?.slice(0, 80) };
// 2. a shadow record with 6 flagged sessions, none succeeded: enforces; auto_on once even over two passes.
fs.rmSync(path.join(process.cwd(), '.studio', 'futility.json'), { force: true });
fs.mkdirSync(path.dirname(FUTILITY_LOG()), { recursive: true });
fs.writeFileSync(FUTILITY_LOG(), rows(6, 0).map((x) => JSON.stringify(x)).join('\\n') + '\\n');
const b = mk();
const p2 = futilityPass({ sessions: live, events, now: t0 + 301 * 60000, env: {}, readTokens: () => 5000, pause: b.pause, emit: b.emit });
futilityPass({ sessions: [{ ...live[0], agent: 'slow2' }], events, now: t0 + 302 * 60000, env: {}, readTokens: () => 5000, pause: b.pause, emit: b.emit });
res.enforced = { paused: b.paused, autoOn: b.emitted.filter((e) => e.type === 'futility.auto_on').length, checkMode: p2.checks[0]?.meta?.mode };
// 3. the same data with STUDIO_FUTILITY=shadow: no pause. =on with no data: pause.
fs.rmSync(path.join(process.cwd(), '.studio', 'futility.json'), { force: true });
const c = mk(); futilityPass({ sessions: live, events, now: t0 + 301 * 60000, env: { STUDIO_FUTILITY: 'shadow' }, readTokens: () => 5000, pause: c.pause, emit: c.emit });
res.shadowPaused = c.paused.length;
fs.rmSync(path.join(process.cwd(), '.studio', 'futility.json'), { force: true }); fs.rmSync(FUTILITY_LOG(), { force: true });
const d = mk(); futilityPass({ sessions: live, events, now: t0 + 301 * 60000, env: { STUDIO_FUTILITY: 'on' }, readTokens: () => 5000, pause: d.pause, emit: d.emit });
res.onPaused = d.paused.length;
// 4. a flagged session (shadow) that ends with its task done is logged with taskDone.
fs.rmSync(path.join(process.cwd(), '.studio', 'futility.json'), { force: true });
const e1 = mk(); futilityPass({ sessions: live, events, now: t0 + 301 * 60000, env: { STUDIO_FUTILITY: 'shadow' }, readTokens: () => 5000, pause: e1.pause, emit: e1.emit });
const ended = [...events, { type: 'task.done', agent: 'someone-else', task: 'T-99', ts: iso(320) }, { type: 'agent.session.end', agent: 'slow', task: 'T-99', ts: iso(321), tokensIn: 9000, tokensOut: 0, meta: { role: 'builder' } }];
const e2 = mk(); const p4 = futilityPass({ sessions: [], events: ended, now: t0 + 330 * 60000, env: { STUDIO_FUTILITY: 'shadow' }, pause: e2.pause, emit: e2.emit });
res.logged = { taskDone: p4.logged[0]?.taskDone, cutGoodRun: p4.logged[0]?.cutGoodRun, inFile: fs.readFileSync(FUTILITY_LOG(), 'utf8').includes('"taskDone":true') };
console.log(JSON.stringify(res));
`);
    const d = r.d || {};
    const ok = r.defaultMode === 'auto' && r.shadowMode === 'shadow' && r.onMode === 'on' && r.offMode === 'off'
      && d.enough === true && d.tooLate === false && d.fewGood === false && d.noLog === false && d.fewShadow === false && d.onlyOn === false && d.otherType === false && d.taskDoneCounts === false
      && r.noData?.paused === 0 && r.noData?.autoOn === 0 && r.noData?.checkMode === 'shadow' && /^Check slow on T-99/.test(r.noData?.text || '')
      && r.enforced?.paused?.length === 2 && r.enforced.paused[0] === 'slow' && r.enforced.autoOn === 1 && r.enforced.checkMode === 'on'
      && r.shadowPaused === 0 && r.onPaused === 1
      && r.logged?.taskDone === true && r.logged?.cutGoodRun === false && r.logged?.inFile === true;
    return [ok, JSON.stringify(r).slice(0, 2500)];
  });

  // ---- PU-62: routing holdout ----
  if (want('hold')) await guard('2.78.0 (PU-62): an unset routing holdout stays 0 (the owner deferred it until API credit is available), a set one (0.1, 0.25) is used, unchanged (0, no routing) when routing is off; a seeded share of tasks goes to the default tier (fails on 2.77.1: holdout 0)', async () => {
    const { S, env } = studio('hold');
    const r = probe(S, env, `import { routingPolicy, routeFor, holdoutDraw, DEFAULT_HOLDOUT } from ${u(S, 'harness/routing.mjs')};
import { effectivePolicy } from ${u(S, 'harness/policy-rules.mjs')};
const pol = (routing) => { const doc = routing === undefined ? {} : { routing }; return { counts: true, doc, effective: effectivePolicy(doc) }; };
const models = { cheap: 'm-cheap', top: 'm-top' };
const unset = routingPolicy(pol({ cheapFirst: ['docs'], tiers: models }));
const zero = routingPolicy(pol({ cheapFirst: ['docs'], tiers: models, holdout: 0 }));
const set = routingPolicy(pol({ cheapFirst: ['docs'], tiers: models, holdout: 0.25 }));
const offNoList = routingPolicy(pol({ cheapFirst: [], tiers: models }));
const offNoBlock = routingPolicy(pol(undefined));
const offNoPolicy = routingPolicy({ counts: false, why: 'x' });
// A seeded task id in the holdout share, and one outside it.
let inId = null; let outId = null;
for (let i = 1; i < 2000 && (!inId || !outId); i++) { const id = 'T-' + i; if (holdoutDraw(id) < 0.1) inId ??= id; else outId ??= id; }
const p = pol({ cheapFirst: ['docs'], tiers: models, models: [], holdout: 0.1 });
const rIn = routeFor({ id: inId, type: 'docs' }, { policy: p, events: [], env: {} });
const rOut = routeFor({ id: outId, type: 'docs' }, { policy: p, events: [], env: {} });
const share = Array.from({ length: 2000 }, (_, i) => holdoutDraw('T-' + (i + 1))).filter((x) => x < 0.1).length / 2000;
console.log(JSON.stringify({ def: DEFAULT_HOLDOUT, unset: unset.holdout, zero: zero.holdout, set: set.holdout, offNoList: [offNoList.on, offNoList.holdout], offNoBlock: [offNoBlock.on, offNoBlock.holdout], offNoPolicy: [offNoPolicy.on, offNoPolicy.holdout], rIn: [rIn?.arm, rIn?.model], rOut: [rOut?.arm, rOut?.model], share }));
`);
    const ok = r.def === 0 && r.unset === 0 && r.zero === 0 && r.set === 0.25
      && r.offNoList?.[0] === false && r.offNoList?.[1] === 0 && r.offNoBlock?.[0] === false && r.offNoBlock?.[1] === 0 && r.offNoPolicy?.[0] === false && r.offNoPolicy?.[1] === 0
      && r.rIn?.[0] === 'holdout' && r.rIn?.[1] === null && r.rOut?.[0] === 'cheap-first' && r.rOut?.[1] === 'm-cheap' && r.share > 0.06 && r.share < 0.14;
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  // ---- PU-63: start backoff ----
  if (want('backoff')) await guard('2.78.0 (PU-63): a start refused for the same reason again is skipped for 2, 4, 8 ... min (capped at STUDIO_START_BACKOFF_MAX_MIN, 30); a new reason or a changed task state resets it (fails on 2.77.1: no backoff)', async () => {
    const { S, env } = studio('backoff');
    const r = probe(S, env, `import * as sup from ${u(S, 'harness/supervisor.mjs')};
const MIN = 60000; const t0 = 1_800_000_000_000;
const state = { startedAt: t0 - 1000 };
const sig = 'task.start@a|free';
const waits = [];
for (let i = 0; i < 8; i++) { const e = sup.noteStartRefusal(state, 'T-7', 'T-7 held: can\\'t start yet (cooldown 5 min)', sig, t0); waits.push(Math.round((e.until - t0) / MIN)); }
const skipNow = !!sup.startBackedOff(state, 'T-7', sig, t0 + MIN);          // inside the last (30 min) wait
const afterWait = sup.startBackedOff(state, 'T-7', sig, t0 + 31 * MIN);      // past it
// A new reason: back to a first refusal (no wait), count 1.
const reason = sup.noteStartRefusal(state, 'T-7', 'lock_denied: already claimed by builder-s9', sig, t0);
const afterReason = { count: reason.count, wait: reason.until - t0 };
// Same reason twice, then the task's state changes: the backoff is dropped.
sup.noteStartRefusal(state, 'T-7', 'lock_denied: already claimed by builder-s9', sig, t0);
const heldBefore = !!sup.startBackedOff(state, 'T-7', sig, t0 + 1000);
const heldAfterState = sup.startBackedOff(state, 'T-7', 'task.unheld@b|free', t0 + 1000);
// The signature follows the task's latest state event and its lock.
const evs = [{ type: 'task.held', task: 'T-7', ts: 'A' }, { type: 'task.start_refused', task: 'T-7', ts: 'B' }, { type: 'task.start', task: 'T-8', ts: 'C' }];
const s1 = sup.taskStateSig(evs, 'T-7', false); const s2 = sup.taskStateSig([...evs, { type: 'task.unheld', task: 'T-7', ts: 'D' }], 'T-7', false); const s3 = sup.taskStateSig(evs, 'T-7', true);
// The log's refusals fold in once.
const st2 = { startedAt: t0 - 1000 };
const log = [{ type: 'task.start_refused', task: 'T-3', ts: new Date(t0 - 500).toISOString(), msg: 'T-3 can\\'t start yet: parked' }, { type: 'task.start_refused', task: 'T-3', ts: new Date(t0 - 400).toISOString(), msg: 'T-3 can\\'t start yet: parked' }, { type: 'task.lock_denied', task: 'T-3', ts: new Date(t0 - 300).toISOString(), msg: 'x' }];
const k1 = sup.ingestRefusals(st2, log, () => 's', t0); const k2 = sup.ingestRefusals(st2, log, () => 's', t0);
console.log(JSON.stringify({ waits, skipNow, afterWait, afterReason, heldBefore, heldAfterState, sigs: [s1 === s2, s1 === s3], ingest: [k1, k2, st2.startBackoff['T-3'].count], envCap: [sup.startBackoffMs(3, { STUDIO_START_BACKOFF_MAX_MIN: '5' }) / MIN, sup.startBackoffMs(1, {}) / MIN, sup.startBackoffMs(0, {})] }));
`);
    const ok = JSON.stringify(r.waits) === JSON.stringify([0, 2, 4, 8, 16, 30, 30, 30]) && r.skipNow === true && r.afterWait === null
      && r.afterReason?.count === 1 && r.afterReason?.wait === 0 && r.heldBefore === true && r.heldAfterState === null
      && r.sigs?.[0] === false && r.sigs?.[1] === false && JSON.stringify(r.ingest) === JSON.stringify([3, 0, 1]) && JSON.stringify(r.envCap) === JSON.stringify([5, 2, 0]);
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  // ---- PU-63: jitter ----
  if (want('jitter')) await guard('2.78.0 (PU-63): the supervisor loop delay is within +-10% of STUDIO_SUPERVISOR_SEC (0 turns jitter off) and the loop is a self-rescheduling timeout set before the first pass (fails on 2.77.1: a fixed setInterval)', async () => {
    const { S, env } = studio('jitter');
    const r = probe(S, env, `import * as sup from ${u(S, 'harness/supervisor.mjs')}; import fs from 'node:fs';
const base = 60000;
const lo = sup.jitteredDelay(base, 0.1, () => 0); const hi = sup.jitteredDelay(base, 0.1, () => 0.999999); const mid = sup.jitteredDelay(base, 0.1, () => 0.5);
let min = Infinity; let max = -Infinity; for (let i = 0; i < 2000; i++) { const d = sup.jitteredDelay(base); min = Math.min(min, d); max = Math.max(max, d); }
const src = fs.readFileSync(new URL(${u(S, 'harness/supervisor.mjs')}).pathname.replace(/^\\/([A-Za-z]:)/, '$1'), 'utf8');
console.log(JSON.stringify({ lo, hi, mid, min, max, off: sup.jitteredDelay(base, 0), envDefault: sup.supervisorJitter({}), envOff: sup.supervisorJitter({ STUDIO_SUPERVISOR_JITTER: '0' }), envSet: sup.supervisorJitter({ STUDIO_SUPERVISOR_JITTER: '0.2' }), interval: /setInterval\\(loop/.test(src), scheduled: /schedule\\(\\);\\s*\\n\\s*await loop\\(\\)/.test(src) }));
`);
    const ok = r.lo === 54000 && r.hi >= 65999 && r.hi <= 66000 && r.mid === 60000 && r.min >= 54000 && r.max <= 66000 && r.max - r.min > 6000
      && r.off === 60000 && r.envDefault === 0.1 && r.envOff === 0 && r.envSet === 0.2 && r.interval === false && r.scheduled === true;
    return [ok, JSON.stringify(r)];
  });

  // ---- PU-63: unique agent names ----
  if (want('names')) await guard('2.78.0 (PU-63): nextAgentName skips a name whose .lanes/<name> folder is left over, and never gives one name twice, even after the counter file is lost (fails on 2.77.1: it reuses the leftover name)', async () => {
    const { S, env } = studio('names');
    fs.mkdirSync(path.join(S, '.lanes', 'builder-s1'), { recursive: true });
    fs.mkdirSync(path.join(S, '.lanes', 'builder-s3'), { recursive: true });
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import { nextAgentName } from ${u(S, 'harness/agent.mjs')};
const a = nextAgentName('builder', 's');   // s1 is left over: s2
const b = nextAgentName('builder', 's');   // s3 is left over: s4
fs.rmSync(path.join(process.cwd(), '.studio', 'agent-names.json'), { force: true }); // a lost counter file
const c = nextAgentName('builder', 's');   // s2 and s4 were taken: s5 (2.77.1: s1 again, a leftover)
const d = nextAgentName('builder', 's');
console.log(JSON.stringify({ names: [a, b, c, d], other: nextAgentName('tester', 's') }));
`);
    const ok = JSON.stringify(r.names) === JSON.stringify(['builder-s2', 'builder-s4', 'builder-s5', 'builder-s6']) && r.other === 'tester-s1';
    return [ok, JSON.stringify(r)];
  });
}
