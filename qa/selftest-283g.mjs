/**
 * qa/selftest-283g.mjs — 2.83 (g): five false alarms and loops a crew hit in a 26-hour run.
 *
 *   train     a builder whose task is queued for a merge train (game or engine) or in a running train is not "stalled"
 *             (harness/watch.mjs); a silent one with no train still is
 *   review    the game review for the same set of unchanged shots is tried once a day, not every cycle (the board
 *             refused it 37 times in 26 h); one quiet telemetry line (harness/gamedev-loop.mjs)
 *   family    a review in a crew with one model family: launched on a different model of that family with one brief line,
 *             the same-family header is accepted only while no other family is configured (harness/review-family.mjs)
 *   idle      the watchdog's "no task finished in N h" clock starts no earlier than the supervisor's own start
 *             (harness/watchdog.mjs)
 *   dead      a claim whose owner's process is gone for STUDIO_DEAD_CLAIM_MIN is handed back, not kept, and a task's
 *             claimed minutes skip the time no supervisor ran, so no rescue for age alone (harness/busy.mjs, task-budget.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283G({ dir, run, report, tmpRoot }) {
  void run;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-283g-${process.pid}.pem`), STUDIO_TELEMETRY: 'full', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  // A studio copy with its own state (the checks write boards, events and state files).
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `283g-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/task-holds.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-283g.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, '');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const cli = (S, env, cmd) => spawnSync(process.execPath, cmd, { windowsHide: true, cwd: S, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120000 });
  const probe = (S, env, code) => {
    const f = path.join(tmpRoot, `probe-283g-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180000 });
    try { fs.rmSync(f, { force: true }); } catch { /* the sweep removes it */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _err: out(r).slice(-2500) }; }
  };
  const M = 60000;
  const iso = (t) => new Date(t).toISOString();

  // ---------------- 1. a lane waiting in a train is not "stalled" ----------------
  await guard('train: a builder silent 45 min whose task is queued for the merge train, queued for an engine train, or in a running train is not called stalled; with no train it still is (fails before this fix: "holds T-n but has been silent" for a finished builder waiting in the train, and a "Watch: 1 stalled" task for the Producer)', () => {
    const { S, ev, env } = studio('train');
    const add = cli(S, env, ['harness/task.mjs', 'add', 'Train wait probe', '--role', 'builder']);
    const id = (out(add).match(/"id":\s*"(T-\d+)"/) || [])[1];
    if (!id) return [false, out(add)];
    const st = cli(S, { ...env, STUDIO_LOCK_OWNER: 'builder-g1' }, ['harness/task.mjs', 'start', id, '--agent', 'builder-g1']);
    const now = Date.now();
    fs.writeFileSync(ev, `${[{ ts: iso(now - 70 * M), type: 'task.start', agent: 'builder-g1', task: id }, { ts: iso(now - 45 * M), type: 'agent.now', agent: 'builder-g1', msg: 'queued for the train' }].map((l) => JSON.stringify(l)).join('\n')}\n`);
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
import { watchPass } from ${u(S, 'harness/watch.mjs')};
const id = ${JSON.stringify(id)};
const td = path.join(process.cwd(), '.studio', 'train'); const ld = path.join(process.cwd(), '.studio', 'locks');
fs.mkdirSync(td, { recursive: true }); fs.mkdirSync(ld, { recursive: true });
const stalled = () => watchPass({ dryRun: true }).findings.filter((f) => f.kind === 'stalled' && f.task === id).length;
const o = { none: stalled() };
fs.writeFileSync(path.join(td, 'queue.json'), JSON.stringify([{ task: id, agent: 'builder-g1', branch: 'lane/a', at: new Date().toISOString() }]));
o.game = stalled();
fs.rmSync(path.join(td, 'queue.json'));
fs.writeFileSync(path.join(td, 'unity-queue.json'), JSON.stringify([{ task: id, agent: 'builder-g1', branch: 'lane/a', at: new Date().toISOString() }]));
o.engine = stalled();
fs.rmSync(path.join(td, 'unity-queue.json'));
fs.writeFileSync(path.join(ld, 'train.lock'), JSON.stringify({ pid: process.pid, id: 'train-1', by: 'train', at: Date.now(), lanes: [id] }));
o.running = stalled();
fs.rmSync(path.join(ld, 'train.lock'));
o.after = stalled();
console.log(JSON.stringify(o));`);
    return [r.none === 1 && r.game === 0 && r.engine === 0 && r.running === 0 && r.after === 1, JSON.stringify({ r, start: out(st).slice(-300) })];
  });

  // ---------------- 2. the unchanged-shots review is tried once a day for the same set ----------------
  await guard('review: three review cycles over the same unchanged shots try to file the task once, record the set in gamedev.json and write one telemetry line when the board refuses it (fails before this fix: one refused attempt per cycle, "Not queued" 37 times in 26 h)', () => {
    const { S, ev, env } = studio('review');
    // A signed-off-less Bible: the board refuses a build task that names no phase or what it serves.
    fs.mkdirSync(path.join(S, 'studio', 'bible'), { recursive: true });
    fs.writeFileSync(path.join(S, 'studio', 'bible', 'bible.json'), JSON.stringify({ version: 1, answers: {}, pillars: [], phases: { 1: {}, 2: {}, 3: {} }, layers: {}, signed: null, phase: { open: 0, history: [], floors: [] } }));
    const e2 = { ...env, STUDIO_GAMEDEV_SKIP: 'stall,milestones,landing,refill,cycle,tiers,launch', STUDIO_REVIEW_FILE_MIN: '0', STUDIO_REVIEW_MIN: '1', STUDIO_REVIEWER_TOOL: '' };
    const r = probe(S, e2, `import fs from 'node:fs'; import path from 'node:path';
import { encodePng } from ${u(S, 'harness/png.mjs')};
import { gamedevPass } from ${u(S, 'harness/gamedev-loop.mjs')};
const W = 64; const H = 64; const rgba = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const v = ((x * 4) ^ (y * 3)) & 255; rgba[i] = v; rgba[i + 1] = (v * 2) & 255; rgba[i + 2] = 255 - v; rgba[i + 3] = 255; }
const d = path.join(process.cwd(), '.studio', 'proof', 'T-001', 'visual', 'after'); fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'main.png'), encodePng({ width: W, height: H, rgba }));
const t0 = Date.now();
const acts = [];
for (let i = 0; i < 4; i++) acts.push(...await gamedevPass(t0 + i * 61 * 60000));
const st = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.studio', 'gamedev.json'), 'utf8'));
console.log(JSON.stringify({ filed: acts.filter((a) => a.kind === 'review').length, sets: Object.keys(st.reviewSets || {}).length }));`);
    const evs = events(ev);
    const refused = evs.filter((e) => e.type === 'task.refused' && /Game-dev review/.test(e.msg || '')).length;
    const lines = evs.filter((e) => e.type === 'gamedev.review_refused').length;
    return [r.sets === 1 && refused === 1 && lines === 1, JSON.stringify({ r, refused, lines })];
  });

  // ---------------- 3. a review in a one-family crew ----------------
  await guard('family: with only Claude models configured, a review of work built on opus launches on a different model of that family with the one-line brief note, and its same-family header is accepted; with a GPT model configured the review goes to it, no note, and the header is refused (fails before this fix: the reviewer read the rule and handed back, twice)', () => {
    const r = probe(dir, { ...base, STUDIO_AGENT_MODEL: 'claude-opus-5-5', STUDIO_REVIEWER_MODEL: 'claude-sonnet-5-5' }, `import { reviewLaunch, sameFamilyAccepted, SAME_FAMILY_HEADER } from ${u(dir, 'harness/review-family.mjs')};
const events = [{ type: 'task.start', agent: 'b1', task: 'T-539', model: 'claude-opus-5-5' }];
const ask = (env) => reviewLaunch({ taskId: 'T-540', title: 'Review T-539 (rates)', events, current: 'claude-opus-5-5', env });
const header = 'model-family: anthropic\\nimplementer-family: anthropic\\n' + SAME_FAMILY_HEADER + '\\nVerdict: approve\\n';
const one = { ...process.env, STUDIO_AGENT_MODEL: 'claude-opus-5-5', STUDIO_REVIEWER_MODEL: 'claude-sonnet-5-5' };
const two = { ...one, STUDIO_RESCUE_MODELS: 'gpt-5-codex' };
const a = ask(one); const b = ask(two);
console.log(JSON.stringify({ a, b, acceptOne: sameFamilyAccepted(header, 'claude-opus-5-5', one), acceptTwo: sameFamilyAccepted(header, 'claude-opus-5-5', two), plain: sameFamilyAccepted('model-family: anthropic\\nVerdict: approve\\n', 'claude-opus-5-5', one), none: reviewLaunch({ taskId: 'T-540', title: 'Review T-539', events: [], env: one }) }));`);
    const noteOk = r.a?.note === 'No model from another family is configured: this review may be done by claude-sonnet-5-5; write `same-family: no other family available` in the review header.';
    return [r.a?.kind === 'same' && r.a.model === 'claude-sonnet-5-5' && noteOk && r.b?.kind === 'other' && r.b.model === 'gpt-5-codex' && !r.b.note && r.acceptOne === true && r.acceptTwo === false && r.plain === false && r.none === null, JSON.stringify(r)];
  });

  // ---------------- 4. the idle stop does not count the studio's own downtime ----------------
  await guard('idle: a studio restarted 3 min ago whose last task finished 5 h before is not stopped for "no task finished in 4 h"; without the restart on record it still is (fails before this fix: stopped 3 min after a restart)', () => {
    const r = probe(dir, base, `import { idleStopReason } from ${u(dir, 'harness/watchdog.mjs')};
const now = Date.now(); const H = 3600000; const ts = (ms) => new Date(now - ms).toISOString();
const ev = [
  { ts: ts(30 * H), type: 'task.start', agent: 'b1', task: 'T-1' }, { ts: ts(5 * H), type: 'task.done', agent: 'b1', task: 'T-1' },
  { ts: ts(3.5 * H), type: 'agent.session.end', agent: 'b2', task: 'T-2' }, { ts: ts(3.4 * H), type: 'agent.session.end', agent: 'b3', task: 'T-3' },
  { ts: ts(3.3 * H), type: 'supervisor.stop', agent: 'supervisor' },
];
const lim = { idleHours: 4 };
const without = idleStopReason(now, { events: ev, lim, auto: true });
const withStart = idleStopReason(now, { events: [...ev, { ts: ts(3 * 60000), type: 'supervisor.start', agent: 'supervisor' }], lim, auto: true });
const viaStatus = idleStopReason(now, { events: ev, lim, auto: true, supervisorStartedAt: now - 3 * 60000 });
const later = idleStopReason(now, { events: [...ev, { ts: ts(3 * 60000), type: 'supervisor.start', agent: 'supervisor' }], lim, auto: true, supervisorStartedAt: 0 });
console.log(JSON.stringify({ without, withStart, viaStatus, later }));`);
    return [r.without && r.without.hours === 4 && r.withStart === null && r.viaStatus === null && r.later === null, JSON.stringify(r)];
  });

  // ---------------- 5. a dead claim is handed back; downtime is not claimed minutes ----------------
  await guard('dead: a claim whose owner session has no process and no heartbeat for 30 min is not kept (claimActive busy false) while a live-looking owner still is, STUDIO_DEAD_CLAIM_MIN=off restores the old rule, and a 42 h outage adds no claimed minutes so there is no budget stop or rescue for age alone (fails before this fix: lock.kept for a gone process, a rescue for a 2,543 min claim)', () => {
    const { S, env } = studio('dead');
    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { claimActive, deadClaimOwner } from ${u(S, 'harness/busy.mjs')};
import { overBudget, offPeriods } from ${u(S, 'harness/task-budget.mjs')};
const root = process.cwd(); const now = Date.now(); const M = 60000; const iso = (t) => new Date(t).toISOString();
const gone = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
fs.mkdirSync(path.join(root, '.studio', 'agents'), { recursive: true });
const rec = (name, pid, beat) => fs.writeFileSync(path.join(root, '.studio', 'agents', name + '.json'), JSON.stringify({ agent: name, role: 'builder', tool: 'custom', pid, status: 'running', startedAt: iso(now - 600 * M), lastBeat: iso(beat) }));
rec('dead-g1', gone, now - 200 * M); rec('fresh-g1', gone, now - 5 * M); rec('live-g1', process.pid, now - 5 * M);
const evs = (o) => [{ ts: iso(now - 300 * M), type: 'task.start', agent: o, task: 'T-9' }, { ts: iso(now - 10 * M), type: 'agent.now', agent: o, task: 'T-9', msg: 'working' }];
const act = (o, env) => claimActive('T-9', { root, now, events: evs(o), env: { ...process.env, ...env } });
const offEnv = { STUDIO_DEAD_CLAIM_MIN: 'off' };
const out = { dead: act('dead-g1', {}).busy, deadOff: act('dead-g1', offEnv).busy, fresh: act('fresh-g1', {}).busy, live: act('live-g1', {}).busy, why: deadClaimOwner('dead-g1', { dir: path.join(root, '.studio'), now, env: process.env })?.why || null };
// a 42 h outage inside a claim: stop at +1 h, restart at +43 h, now at +44 h
const t0 = now - 44 * 3600000; const H = 3600000;
const long = [{ ts: iso(t0), type: 'task.start', agent: 'dead-g1', task: 'T-8' }, { ts: iso(t0 + H), type: 'supervisor.stop', agent: 'supervisor' }, { ts: iso(t0 + 43 * H), type: 'supervisor.start', agent: 'supervisor' }];
const lim = { STUDIO_TASK_BUDGET: 'on', STUDIO_TASK_MAX_MIN: '240' };
const b = overBudget('T-8', { events: long, now, env: { ...process.env, ...lim } });
const crash = offPeriods([{ ts: iso(t0), type: 'supervisor.start' }, { ts: iso(t0 + H), type: 'task.start', task: 'T-8' }, { ts: iso(t0 + 40 * H), type: 'supervisor.start' }]);
console.log(JSON.stringify({ ...out, over: b.over, minutes: b.spend?.minutes, crash: crash.length }));`);
    return [r.dead === false && r.deadOff === true && r.fresh === true && r.live === true && /process is gone/.test(r.why || '') && r.over === false && r.minutes < 240 && r.crash === 1, JSON.stringify(r)];
  });
}
