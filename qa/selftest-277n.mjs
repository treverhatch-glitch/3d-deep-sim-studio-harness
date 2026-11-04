/**
 * qa/selftest-277n.mjs — 2.77.0 (helper n): Gemini as a first-class builder, with quota-aware routing that prefers it
 * (the owner's Priority 8).
 *   gemini     `agent start --tool agy --model <a Claude model>` is refused (agy ran Claude Sonnet inside agy);
 *              --force-model runs it; no --model still starts on the Gemini default
 *   pin        a session started with --task (any tool) is pinned: its kickoff says so, `task start` of another task
 *              and `task done --train` of another task are refused with a clear message, its own task starts (B-92)
 *   usage      an agy session with no usage line records usage "not reported" with an estimate marked estimated, never
 *              0; with Gemini usage objects in its output it records those tokens and the model agy names
 *   pools      model-pools routing: small -> Gemini Flash, normal -> Gemini Argon, hard and chain-breakers -> Claude Opus,
 *              after a Gemini failure -> Claude; a pool near its limit, marked out, or dropped for a size class falls to
 *              the next; a protected-heavy task never goes to a pool that just handed one back
 *   line       the Line Producer routes by pool with the tool (STUDIO_MODEL_ROUTING=on), writes
 *              .studio/routing/outcomes.json (landed vs handed back per pool and size), and the supervisor starts the
 *              routed tool and model
 *   protected  in beta mode a handed-back protected step is routed to the beta agent (a line.protected_routed event) and
 *              the task is held from new builders until an approval names it; without beta mode or a proxy: reported only
 *   status     `npm run models -- status` shows pools, use, success rates, and what routing would pick now and why;
 *              routing is on by itself once agy is enrolled (.studio/agy-settings.json)
 * Each check fails on 2.76.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest277N({ dir, run, report, tmpRoot, root }) {
  void run;
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const UNSET = ['STUDIO_AGY_MODE', 'STUDIO_AGY_PRINT_TIMEOUT', 'STUDIO_AGY_MODEL_FLAG', 'STUDIO_TOOL_AGY_MODEL', 'STUDIO_TOOL_AGY_CMD', 'STUDIO_AGY_PROMPT', 'STUDIO_AGY_BYPASS', 'STUDIO_AGY_ANY_MODEL', 'STUDIO_TASK_PIN', 'STUDIO_MODEL_ROUTING', 'STUDIO_AGY_QUOTA_CMD', 'STUDIO_AGY_QUOTA_SEC', 'STUDIO_LINE_PROTECTED_HOLD_MIN', 'STUDIO_BUILDER_MODEL', 'STUDIO_AGENT_MODEL', 'STUDIO_BUILDER_TOOL', 'STUDIO_WORKTREES', 'STUDIO_ENV_FROM_FILE'];
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_TEST_MACHINE: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_TRAIN_AUTO: 'off',
    STUDIO_LINE_PRODUCER: '', STUDIO_LINE_RIG: 'heavy', STUDIO_LINE_EXPANSION_SHARE: '0', STUDIO_LINE_CHAIN_MIN: '', STUDIO_LINE_PLAN_MAX_SEC: '', STUDIO_TIER_CHEAP_MODEL: '', STUDIO_TIER_MID_MODEL: '', STUDIO_TIER_TOP_MODEL: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-277n-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  let n = 0;
  const made = [];
  /** A studio copy with its own git, an events file, and optionally a board and events (ts spaced 1 s from 2 h ago). */
  const studio = (name, { tasks = null, events = [], mode = 'extreme' } = {}) => {
    const S = path.join(tmpRoot, `277n-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/divisions.json', 'studio/policy.json', 'studio/delegation.json', 'studio/beta.json', 'studio/models.json', 'studio/approvals']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-277n.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true });
    fs.writeFileSync(ev, events.map((e, i) => JSON.stringify({ id: `evt_${i}`, status: 'ok', ts: iso(now - 2 * 3600000 + i * 1000), ...e })).join('\n') + (events.length ? '\n' : ''));
    if (tasks) {
      fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Studio Task Queue (\`studio/NEXT.md\`)\n\n## IN_PROGRESS\n\n## BACKLOG\n${tasks.map((t) => `- [ ] **${t.id}** [${t.p || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`).join('\n')}\n\n## DONE\n`);
      fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), `${JSON.stringify({ tasks: {} }, null, 2)}\n`);
      fs.writeFileSync(path.join(S, 'studio', 'mode.json'), `${JSON.stringify({ mode, history: [] }, null, 2)}\n`);
    }
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const appendEvents = (ev, list, from = now - 600000) => fs.appendFileSync(ev, list.map((e, i) => `${JSON.stringify({ id: `evx_${from}_${i}`, status: 'ok', ts: iso(from + i * 1000), ...e })}\n`).join(''));
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-277n-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: `${out(r)}`.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const node = (S, env, args, timeout = 120000) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
  const json = (r) => { try { return JSON.parse(String(r.stdout || '').trim()); } catch { return null; } };
  const readRec = (S, agent) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.json`), 'utf8')); } catch { return null; } };
  const startFg = (S, env, args, timeout = 120000) => node(S, env, ['harness/agent.mjs', 'start', ...args], timeout);
  const addTask = (S, env, title) => (out(node(S, env, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1'])).match(/"id": "(T-\d+)"/) || [])[1];
  const fwd = (p) => p.replace(/\\/g, '/');
  const cmdLine = (...args) => `node ${args.map((a) => JSON.stringify(fwd(String(a)))).join(' ')}`;
  // A stand-in agent: prints a file's lines, records its model argument, its env pin and its cwd, then exits.
  const fake = path.join(tmpRoot, `fake-agent-277n-${process.pid}.mjs`);
  fs.writeFileSync(fake, `import fs from 'node:fs';
const [linesFile, recFile, model] = process.argv.slice(2);
if (recFile && recFile !== '-') fs.writeFileSync(recFile, JSON.stringify({ model: model || null, pin: process.env.STUDIO_TASK_PIN ?? null, cwd: process.cwd() }));
try { process.stdout.write(fs.readFileSync(linesFile, 'utf8')); } catch {}
`);
  const lineFile = (name, text) => { const f = path.join(tmpRoot, `lines-277n-${name}-${process.pid}.txt`); fs.writeFileSync(f, text); return f; };
  const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

  // ---- 1. Gemini only on agy ----
  await guard('2.77.0 (n, Priority 8): `agent start --tool agy --model claude-sonnet-5-5` is refused with a clear message (agy ran Claude Sonnet inside agy); --force-model starts it on that model; `--tool agy` with no --model still starts on the Gemini default (fails on 2.76.0: the Claude model started inside agy)', async () => {
    const { S, env } = studio('gemini');
    const lf = lineFile('g', 'done\n');
    const r1f = path.join(tmpRoot, `g1-277n-${process.pid}.json`); const r2f = path.join(tmpRoot, `g2-277n-${process.pid}.json`); const r3f = path.join(tmpRoot, `g3-277n-${process.pid}.json`);
    const refused = startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, lf, r1f)} {model}` }, ['--role', 'builder', '--agent', 'agy-g1', '--tool', 'agy', '--model', 'claude-sonnet-5-5']);
    const forced = startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, lf, r2f)} {model}` }, ['--role', 'builder', '--agent', 'agy-g2', '--tool', 'agy', '--model', 'claude-sonnet-5-5', '--force-model']);
    const dflt = startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, lf, r3f)} {model}` }, ['--role', 'builder', '--agent', 'agy-g3', '--tool', 'agy']);
    const ok = refused.status !== 0 && /isn't one/.test(out(refused)) && /--force-model/.test(out(refused)) && !fs.existsSync(r1f)
      && forced.status === 0 && readJsonFile(r2f)?.model === 'claude-sonnet-5-5' && readJsonFile(r3f)?.model === 'gemini-4-argon-high';
    return [ok, `refused ${refused.status} ${out(refused).slice(-400)}\nforced ${forced.status} ${JSON.stringify(readJsonFile(r2f))} ${out(forced).slice(-300)}\ndefault ${JSON.stringify(readJsonFile(r3f))}`];
  });

  // ---- 2. The pinned task (B-92) ----
  await guard('2.77.0 (n, B-92 launcher side): a session started with --task gets STUDIO_TASK_PIN and a kickoff that says it is pinned; from it `task start <another>` is refused ("works only that task"), `task done <another> --train` is refused, and its own task starts (fails on 2.76.0: the other task started, as builder-agy10 took a P0 rescue)', async () => {
    const { S, ev, env } = studio('pin');
    const t1 = addTask(S, env, 'Pinned work');
    const t2 = addTask(S, env, 'Another task');
    const t3 = addTask(S, env, 'A third task');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const rec = path.join(tmpRoot, `pin-277n-${process.pid}.json`);
    const agentScript = path.join(tmpRoot, `pin-agent-277n-${process.pid}.cjs`);
    fs.writeFileSync(agentScript, `const fs = require('fs'); const { spawnSync } = require('child_process');
const t = (args) => { const r = spawnSync(process.execPath, ['harness/task.mjs', ...args, '--agent', process.env.STUDIO_LOCK_OWNER], { encoding: 'utf8', windowsHide: true }); return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const other = t(['start', ${JSON.stringify(t2)}]);
const train = t(['done', ${JSON.stringify(t3)}, '--train']);
const own = t(['start', ${JSON.stringify(t1)}]);
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ pin: process.env.STUDIO_TASK_PIN || null, other, train, own }));
`);
    const r = startFg(S, { ...env, STUDIO_BUILDER_CMD: cmdLine(agentScript) }, ['--role', 'builder', '--agent', 'builder-p92', '--task', t1, '--model', 'fake-1']);
    const x = readJsonFile(rec);
    let kick = ''; try { kick = fs.readFileSync(path.join(S, '.studio', 'kickoff', 'builder-p92.md'), 'utf8'); } catch {}
    const refusedEv = events(ev).filter((e) => (e.type === 'task.start_refused' && e.task === t2) || (e.type === 'task.done_refused' && e.task === t3));
    const ok = x && x.pin === t1 && x.other.status !== 0 && new RegExp(`started on ${t1} and works only that task`).test(x.other.out) && x.train.status !== 0 && /works only that task/.test(x.train.out) && x.own.status === 0
      && new RegExp(`pinned to ${t1}`).test(kick) && refusedEv.length === 2 && readRec(S, 'builder-p92')?.pinned === t1;
    return [ok, `${JSON.stringify(x)}\nkick pinned: ${/pinned to/.test(kick)}; refused events ${refusedEv.length}; rec ${JSON.stringify(readRec(S, 'builder-p92')?.pinned)}\n${out(r).slice(-400)}`];
  });

  // ---- 3. agy usage and model ----
  await guard('2.77.0 (n, Priority 8 telemetry): an agy session whose output has no usage records usage "not reported" with tokens estimated from text length (meta.tokensEstimated), not 0; one whose output has Gemini usage objects records those tokens, usage "reported", and the model agy names (fails on 2.76.0: tokens 0 and the passed model)', async () => {
    const { S, ev, env } = studio('usage');
    const plain = lineFile('u1', `${'I changed the files and ran the tests. '.repeat(40)}\n`);
    const gem = lineFile('u2', `${JSON.stringify({ responseId: 'r1', modelVersion: 'gemini-4-argon-low', usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 300, cachedContentTokenCount: 500 } })}\n${JSON.stringify({ responseId: 'r2', modelVersion: 'gemini-4-argon-low', usageMetadata: { promptTokenCount: 2500, candidatesTokenCount: 200, cachedContentTokenCount: 1000 } })}\nDone.\n`);
    startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, plain, '-')} {model}` }, ['--role', 'builder', '--agent', 'agy-u1', '--tool', 'agy']);
    startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, gem, '-')} {model}` }, ['--role', 'builder', '--agent', 'agy-u2', '--tool', 'agy']);
    const ends = events(ev).filter((e) => e.type === 'agent.session.end');
    const e1 = ends.find((e) => e.agent === 'agy-u1');
    const e2 = ends.find((e) => e.agent === 'agy-u2');
    const ok = e1 && e1.meta?.usage === 'not reported' && e1.meta?.tokensEstimated === true && e1.tokensIn > 100 && e1.tokensOut > 100
      && e2 && e2.meta?.usage === 'reported' && !e2.meta?.tokensEstimated && e2.tokensIn === 2500 && e2.tokensOut === 500 && e2.meta?.cacheRead === 1500 && e2.model === 'gemini-4-argon-low' && e2.meta?.modelReported === 'gemini-4-argon-low';
    return [ok, JSON.stringify({ e1: e1 && { tokensIn: e1.tokensIn, tokensOut: e1.tokensOut, model: e1.model, usage: e1.meta?.usage, est: e1.meta?.tokensEstimated }, e2: e2 && { tokensIn: e2.tokensIn, tokensOut: e2.tokensOut, model: e2.model, meta: { usage: e2.meta?.usage, cacheRead: e2.meta?.cacheRead, modelReported: e2.meta?.modelReported } } })];
  });

  // ---- 4. Pool routing (pure) ----
  await guard('2.77.0 (n, Priority 8): pool routing: small -> gemini-flash, normal -> gemini-argon, hard and a chain-breaker -> claude-opus, after a Gemini failure -> claude-sonnet; flash near its 5-hour limit -> argon; agy marked out of quota -> Claude; flash dropped for small tasks (1 of its last 5 landed) -> argon; a protected-heavy task skips a pool that just handed one back (fails on 2.76.0: harness/model-pools.mjs doesn\'t exist)', async () => {
    const { S, env } = studio('pure');
    const r = probe(S, env, 'pure', `const mp = await import(${u(S, 'harness/model-pools.mjs')});
const cfg = mp.readModels();
const now = Date.now();
const ev = (i, x) => ({ ts: new Date(now - 3600000 + i * 1000).toISOString(), ...x });
const pick = (ctx, events = [], marks = () => null) => { const outcomes = mp.buildOutcomes(events, { cfg, sizeOf: () => 'small' }); const st = mp.poolState(cfg, { use: mp.poolUse(cfg, events, now), marks }); return mp.pickPool(ctx, { cfg, state: st, rates: mp.successRates(outcomes, cfg), recentProt: mp.recentProtected(outcomes, cfg, now) }); };
const busy = Array.from({ length: 52 }, (_, i) => ev(i, { type: 'agent.session.start', agent: 'b' + i, model: 'gemini-3.8-flash-high' }));
const failing = [];
for (let i = 0; i < 4; i++) { const a = 'f' + i, t = 'T-9' + i; failing.push(ev(i * 10, { type: 'agent.session.start', agent: a, task: t, model: 'gemini-3.8-flash-high' }), ev(i * 10 + 1, { type: 'task.paused', agent: a, task: t, msg: 'Handed back ' + t + ': tests still red' }), ev(i * 10 + 2, { type: 'agent.session.end', agent: a, task: t, model: 'gemini-3.8-flash-high', meta: {} })); }
failing.push(ev(50, { type: 'agent.session.start', agent: 'f9', task: 'T-99', model: 'gemini-3.8-flash-high' }), ev(51, { type: 'agent.session.end', agent: 'f9', task: 'T-99', model: 'gemini-3.8-flash-high', meta: {} }), ev(52, { type: 'task.done', agent: 'f9', task: 'T-99' }));
const prot = [ev(1, { type: 'agent.session.start', agent: 'p1', task: 'T-80', model: 'gemini-4-argon-high' }), ev(2, { type: 'task.paused', agent: 'p1', task: 'T-80', msg: 'Handed back T-80: it needs a protected file changed (studio/gates.json); only the owner approves it' }), ev(3, { type: 'agent.session.end', agent: 'p1', task: 'T-80', model: 'gemini-4-argon-high', meta: {} })];
const res = {
  small: pick({ size: 'small' }).pool, normal: pick({ size: 'normal' }).pool, hard: pick({ size: 'hard' }).pool, cb: pick({ size: 'small', chainBreaker: true }).pool,
  gemFail: pick({ size: 'normal', failed: 1, lastFailedPool: 'gemini-argon' }).pool, twice: pick({ size: 'normal', failed: 2, lastFailedPool: 'claude-sonnet' }).pool,
  near: pick({ size: 'small' }, busy), nearWhy: pick({ size: 'small' }, busy).why,
  outAgy: pick({ size: 'normal' }, [], (k) => (k === 'agy' ? '2099-01-01T00:00:00Z' : null)).pool,
  dropped: pick({ size: 'small' }, failing), protHeavy: pick({ size: 'normal', protectedHeavy: true }, prot).pool, protLight: pick({ size: 'normal' }, prot).pool,
  sticky: pick({ size: 'hard', startedOn: { model: 'gemini-4-argon-high', tool: 'agy' } }).model,
};
console.log(JSON.stringify({ ...res, near: res.near.pool, dropped: res.dropped.pool, droppedWhy: res.dropped.why }));`);
    const ok = r.small === 'gemini-flash' && r.normal === 'gemini-argon' && r.hard === 'claude-opus' && r.cb === 'claude-opus' && r.gemFail === 'claude-sonnet' && r.twice === 'claude-opus'
      && r.near === 'gemini-argon' && /near its limit/.test(r.nearWhy || '') && r.outAgy === 'claude-sonnet' && r.dropped === 'gemini-argon' && /landed 1 of its last 5/.test(r.droppedWhy || '')
      && r.protHeavy === 'claude-sonnet' && r.protLight === 'gemini-argon' && r.sticky === 'gemini-4-argon-high';
    return [ok, JSON.stringify(r).slice(0, 2500)];
  });

  // ---- 5. The Line Producer routes by pool; outcomes; the supervisor starts the routed tool ----
  const board = [
    { id: 'T-001', title: 'Small tidy job', p: 'P0' },
    { id: 'T-002', title: 'Normal feature' },
    { id: 'T-003', title: 'Hard rework' },
    { id: 'T-004', title: 'Normal feature that failed on Gemini once' },
  ];
  const boardEvents = [
    { type: 'task.added', agent: 'producer', task: 'T-001', msg: 'q', meta: { size: 1 } },
    { type: 'task.added', agent: 'producer', task: 'T-002', msg: 'q', meta: { size: 3 } },
    { type: 'task.added', agent: 'producer', task: 'T-003', msg: 'q', meta: { size: 5 } },
    { type: 'task.added', agent: 'producer', task: 'T-004', msg: 'q', meta: { size: 3 } },
    { type: 'agent.session.start', agent: 'builder-a4', task: 'T-004', model: 'gemini-4-argon-high', msg: 's', meta: { role: 'builder', tool: 'agy' } },
    { type: 'task.start', agent: 'builder-a4', task: 'T-004', model: 'gemini-4-argon-high', msg: 'start' },
    { type: 'task.paused', agent: 'builder-a4', task: 'T-004', msg: 'Handed back T-004: the tests stay red after two tries' },
    { type: 'agent.session.end', agent: 'builder-a4', task: 'T-004', model: 'gemini-4-argon-high', msg: 'e', meta: { role: 'builder', tool: 'agy', reason: 'finished without task done', handed: [{ task: 'T-004' }] } },
  ];
  await guard('2.77.0 (n, Priority 8): with STUDIO_MODEL_ROUTING=on the Line Producer routes size 1 to gemini-3.8-flash-high on agy, size 3 to gemini-4-argon-high, size 5 to claude-opus-5-5 on claude, and a size-3 task Gemini handed back to claude-sonnet-5-5; its pass writes .studio/routing/outcomes.json (that session: handed, pool gemini-argon, size normal); the supervisor starts T-001 on agy with the Flash model (fails on 2.76.0: tier routes with no tool, and no outcomes file)', async () => {
    const { S, env } = studio('line', { tasks: board, events: boardEvents });
    const e2 = { ...env, STUDIO_MODEL_ROUTING: 'on' };
    const r = probe(S, e2, 'line', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
import fs from 'node:fs';
const s = await lp.lineProducerPass({});
const sup = await import(${u(S, 'harness/supervisor.mjs')});
const starts = [];
const deps = { sessions: () => [], launchableRoles: (r) => r, nextAgentName: (role) => role + '-t' + starts.length, startAgent: (o) => { starts.push(o); return { ok: true }; } };
await sup.supervise({ watcher: true, deps }, { startedAt: Date.now(), names: [] });
let oc = null; try { oc = JSON.parse(fs.readFileSync('.studio/routing/outcomes.json', 'utf8')); } catch {}
console.log(JSON.stringify({ routes: s.routes, models: s.models, starts: starts.map((o) => ({ task: o.task, tool: o.tool, model: o.model || null })), oc: oc && oc.outcomes }));`);
    const rt = r.routes || {};
    const row = (r.oc || []).find((o) => o.task === 'T-004');
    const first = (r.starts || [])[0];
    const ok = rt['T-001']?.model === 'gemini-3.8-flash-high' && rt['T-001']?.tool === 'agy' && rt['T-002']?.model === 'gemini-4-argon-high' && rt['T-003']?.model === 'claude-opus-5-5' && rt['T-003']?.tool === 'claude'
      && rt['T-004']?.model === 'claude-sonnet-5-5' && /Gemini failure/.test(rt['T-004']?.why || '') && row?.result === 'handed' && row?.pool === 'gemini-argon' && row?.size === 'normal' && r.models?.on === true
      && first?.task === 'T-001' && first?.tool === 'agy' && first?.model === 'gemini-3.8-flash-high';
    return [ok, JSON.stringify({ routes: rt, row, starts: r.starts, models: r.models, err: ok ? '' : r._err }).slice(0, 3000)];
  });

  // ---- 6. Protected steps go to an approver in beta mode ----
  const protEvents = [
    { type: 'task.added', agent: 'producer', task: 'T-005', msg: 'q', meta: { size: 3 } },
    { type: 'agent.session.start', agent: 'builder-agy5', task: 'T-005', model: 'gemini-4-argon-high', msg: 's', meta: { role: 'builder', tool: 'agy' } },
    { type: 'task.start', agent: 'builder-agy5', task: 'T-005', model: 'gemini-4-argon-high', msg: 'start' },
    { type: 'task.paused', agent: 'builder-agy5', task: 'T-005', msg: 'Handed back T-005: all gates green except the protected step: it changes a protected file (studio/gates.json); only the owner approves it' },
    { type: 'agent.session.end', agent: 'builder-agy5', task: 'T-005', model: 'gemini-4-argon-high', msg: 'e', meta: { role: 'builder', tool: 'agy', reason: 'finished without task done' } },
  ];
  await guard('2.77.0 (n, Priority 8): in beta mode a protected step a Gemini builder handed back is routed to the beta agent (one line.protected_routed event to it, not repeated on the next pass), the task is held from new builders (blocked "protected", supervisorPlan().hold) until an approval names it; without beta mode or a proxy it is reported only (no event, no hold) (fails on 2.76.0: the task was left handed back)', async () => {
    const { S, ev, env } = studio('prot', { tasks: [{ id: 'T-005', title: 'Feature that needs a protected change' }], events: protEvents });
    fs.writeFileSync(path.join(S, 'studio', 'beta.json'), `${JSON.stringify({ on: true, by: 'pat', at: iso(now - 86400000), agents: ['patch-1'], why: 'beta' }, null, 2)}\n`);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'beta: on', '--no-verify']);
    const pass = (e) => probe(S, e, 'prot', `const lp = await import(${u(S, 'harness/line-producer.mjs')});
const s = await lp.lineProducerPass({});
const plan = lp.supervisorPlan({});
console.log(JSON.stringify({ steps: s.protectedSteps, blocked: (s.blocked || []).find((b) => b.task === 'T-005') || null, hold: plan && plan.hold ? [...plan.hold.keys()] : null, err: s.error || null }));`);
    const a = pass(env);
    const b = pass(env);
    const routed = events(ev).filter((e) => e.type === 'line.protected_routed' && e.task === 'T-005');
    appendEvents(ev, [{ type: 'approval.protected', agent: 'patch-1', msg: 'patch-1 approved 1 protected change(s): T-005: the gate list for the new step' }], now - 60000);
    const c = pass(env);
    const { S: S2, ev: ev2, env: env2 } = studio('prot2', { tasks: [{ id: 'T-005', title: 'Feature that needs a protected change' }], events: protEvents });
    const d = probe(S2, env2, 'prot2', `const lp = await import(${u(S2, 'harness/line-producer.mjs')});
const s = await lp.lineProducerPass({});
console.log(JSON.stringify({ steps: s.protectedSteps }));`);
    const ok = a.steps?.[0]?.actor === 'patch-1' && a.steps[0].hold === true && a.blocked?.kind === 'protected' && (a.hold || []).includes('T-005') && routed.length === 1 && routed[0].to === 'patch-1' && /approve -- protected/.test(routed[0].msg)
      && b.steps?.[0]?.hold === true && !(c.steps || []).length && !(c.hold || []).includes('T-005')
      && d.steps?.[0]?.actor === null && d.steps[0].hold === false && !events(ev2).some((e) => e.type === 'line.protected_routed');
    return [ok, JSON.stringify({ a, b: b.steps, routed: routed.map((e) => ({ to: e.to, msg: e.msg })), c, d: d.steps || d._err }).slice(0, 3000)];
  });

  // ---- 7. models status ----
  await guard('2.77.0 (n, Priority 8): `npm run models -- status` lists the pools (use against the limits), agy\'s quota source, success rates, and what routing would pick for small/normal/hard now and why; --json carries the same; routing is on by itself once agy is enrolled (.studio/agy-settings.json), off without it; STUDIO_AGY_QUOTA_CMD output marks a pool near its limit (fails on 2.76.0: no models command)', async () => {
    const { S, env } = studio('status');
    const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')).scripts?.models;
    const off = json(node(S, env, ['harness/model-pools.mjs', 'status', '--json']));
    fs.writeFileSync(path.join(S, '.studio', 'agy-settings.json'), '{"permissions":{"allow":[]}}\n');
    const text = node(S, env, ['harness/model-pools.mjs', 'status']);
    const on = json(node(S, env, ['harness/model-pools.mjs', 'status', '--json']));
    const qscript = path.join(tmpRoot, `quota-277n-${process.pid}.mjs`);
    fs.writeFileSync(qscript, "console.log(JSON.stringify({ models: [{ model: 'gemini-3.8-flash-high', used: 95, limit: 100 }, { model: 'gemini-4-argon-high', remainingPct: 80 }] }));\n");
    const q = json(node(S, { ...env, STUDIO_AGY_QUOTA_CMD: `${process.execPath.replace(/\\/g, '/')} ${fwd(qscript)}` }, ['harness/model-pools.mjs', 'status', '--json']));
    const ok = pkg === 'node harness/model-pools.mjs' && off?.on === false && on?.on === true && /agy is enrolled/.test(on.why) && on.preview?.small?.model === 'gemini-3.8-flash-high' && on.preview?.hard?.model === 'claude-opus-5-5'
      && /What routing would pick now/.test(text.stdout) && /gemini-flash: gemini-3\.8-flash-high on agy/.test(text.stdout) && /agy's own quota/.test(text.stdout)
      && q?.state?.['gemini-flash']?.near === true && q?.state?.['gemini-argon']?.quotaPct === 20 && q?.preview?.small?.model === 'gemini-4-argon-high';
    return [ok, JSON.stringify({ pkg, off: off && { on: off.on, why: off.why }, on: on && { on: on.on, why: on.why, preview: on.preview && Object.fromEntries(Object.entries(on.preview).map(([k, v]) => [k, v.model])) }, q: q && { flash: q.state?.['gemini-flash'], argon: q.state?.['gemini-argon']?.quotaPct, small: q.preview?.small?.model, quota: q.quota } }).slice(0, 2500) + `\n${out(text).slice(0, 600)}`];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {} }
}
