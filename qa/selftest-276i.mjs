/**
 * qa/selftest-276i.mjs — 2.76.0 (helper i): the launcher and the agents.
 *   B-83 a  a relaunch under the same name (an appended log holding the last session's 900k tokens, its stall record)
 *           is never stall-killed for the old session's tokens; the session records where its part of the log starts
 *   B-83 b  logTokens counts the newest Claude session only; readLogFrom reads a session's part; a count that starts
 *           over (fewer tokens than last time) restarts the stall window instead of hiding a burn behind the old base
 *   B-82    a session the launcher ends (stall) records its own usage from the stream and an estimated cost
 *           (studio/prices.json, meta.costEstimated), never the previous session's result line
 *   W-0072/73, B-80  agy runs with --print-timeout 5400s (STUDIO_AGY_PRINT_TIMEOUT), --mode accept-edits
 *           (STUDIO_AGY_MODE=off drops it), --model; `--tool agy` with no --model starts on the Gemini default
 *   B-80 a  `allow agy` writes the write_file rule beside the command rules
 *   B-80 b  an agy builder in its lane copy: GEMINI.md with the shell rules (kept out of git status), the rules in its
 *           kickoff, and agy's jetski line in its hand-back and session end
 *   B-84 a  a builder started with no task works in its own lane copy, not the main checkout
 *   B-84 b  a launched builder claiming a task from the main checkout gets its lane copy at task start
 *   B-90    another task's event, or one the train wrote in the owner's name, is not the owner at work; a lane copy that
 *           is another agent's (the new builder's) is not the old owner's built work; an orchestrator's own copy still is
 *   B-81 a  the upgrade's lane refresh runs in the background and the upgrade waits at most STUDIO_UPGRADE_REFRESH_WAIT_S
 *   B-81 b  `lanes refresh` stops a lane's targeted tests at STUDIO_LANES_REFRESH_TEST_S (the merge kept)
 *   B-81 c  the train refreshes a lane whose harness is behind main (main merged in) instead of handing it back
 * Each check fails on 2.75.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest276I({ dir, run, report, tmpRoot, root }) {
  void run;
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const UNSET = ['STUDIO_STALL_MIN', 'STUDIO_STALL_PLAN_MIN', 'STUDIO_SESSION_MAX_MIN', 'STUDIO_STALL', 'STUDIO_STALL_RATIO', 'STUDIO_STALL_RATIO_WINDOW_TOKENS', 'STUDIO_AGY_MODE', 'STUDIO_AGY_PRINT_TIMEOUT', 'STUDIO_AGY_MODEL_FLAG', 'STUDIO_TOOL_AGY_MODEL', 'STUDIO_TOOL_AGY_CMD', 'STUDIO_AGY_PROMPT', 'STUDIO_AGY_BYPASS', 'STUDIO_ON_BEHALF', 'STUDIO_CLAIM_ACTIVE_MIN', 'STUDIO_CLAIM_LANE_MAX_H', 'STUDIO_UPGRADE_REFRESH', 'STUDIO_UPGRADE_REFRESH_WAIT_S', 'STUDIO_LANES_REFRESH_TEST_S', 'STUDIO_TRAIN_REFRESH', 'STUDIO_LANE_HARNESS', 'STUDIO_ENV_FROM_FILE', 'STUDIO_WORKTREES', 'STUDIO_BUILDER_MODEL', 'STUDIO_AGENT_MODEL', 'STUDIO_BUILDER_TOOL'];
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-276i-${process.pid}.pem`), ...ident,
  };
  const childEnv = (extra = {}) => { const e = { ...process.env, ...base, ...extra }; for (const k of UNSET) if (!(k in extra)) delete e[k]; return e; };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `276i-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-276i.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, name, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-276i-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: `${out(r)}`.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  const readRec = (S, agent) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.json`), 'utf8')); } catch { return null; } };
  const startFg = (S, env, args, timeout = 120000) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
  const addTask = (S, env, title) => (out(spawnSync(process.execPath, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env) })).match(/"id": "(T-\d+)"/) || [])[1];
  const fwd = (p) => p.replace(/\\/g, '/');
  // A stand-in agent: prints the stream-json lines given in a file, records its cwd, then sleeps `secs` seconds.
  const fake = path.join(tmpRoot, `fake-agent-276i-${process.pid}.mjs`);
  fs.writeFileSync(fake, `import fs from 'node:fs';
const [linesFile, secs, recFile] = process.argv.slice(2);
if (recFile) fs.writeFileSync(recFile, JSON.stringify({ cwd: process.cwd(), mainRoot: process.env.STUDIO_MAIN_ROOT || null, model: process.argv[5] || null }));
try { process.stdout.write(fs.readFileSync(linesFile, 'utf8')); } catch {}
setTimeout(() => process.exit(0), Number(secs || 0) * 1000);
`);
  const lineFile = (name, lines) => { const f = path.join(tmpRoot, `lines-276i-${name}-${process.pid}.jsonl`); fs.writeFileSync(f, lines.map((l) => `${JSON.stringify(l)}\n`).join('')); return f; };
  const cmdLine = (...args) => `node ${args.map((a) => JSON.stringify(fwd(String(a)))).join(' ')}`;
  const asst = (session, id, usage) => ({ type: 'assistant', session_id: session, message: { id, usage } });

  // ---- B-83 a: a relaunch under the same name ----
  await guard('2.76.0 (B-83, W-0070): a session relaunched under the same name, whose agent log already holds the last session\'s 900k read tokens (and whose stall record is the last session\'s), runs to its own end: no stall, exitCause exit, the record\'s logFrom marks where its part of the log starts and its stall record is its own (fails on 2.75.0: "read 900000 tokens and wrote 15 … with no progress" ended it within seconds)', async () => {
    const { S, ev, env } = studio('relaunch');
    const agent = 'builder-r83';
    const old = [asst('old-83', 'o1', { input_tokens: 300000, output_tokens: 5 }), asst('old-83', 'o2', { input_tokens: 300000, output_tokens: 5 }), asst('old-83', 'o3', { input_tokens: 300000, output_tokens: 5 })];
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'agents', `${agent}.log`), old.map((l) => `${JSON.stringify(l)}\n`).join(''));
    fs.mkdirSync(path.join(S, '.studio', 'stall'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'stall', `${agent}.json`), JSON.stringify({ agent, role: 'builder', startedAt: '2026-11-01T00:00:00.000Z', baseIn: 0, baseOut: 0, tokensIn: 900000, tokensOut: 15, ended: { at: '2026-11-01T00:10:00.000Z', by: 'launcher', kind: 'read-burn' } }));
    const lf = lineFile('r83', [asst('new-83', 'n1', { input_tokens: 1000, output_tokens: 50 })]);
    const r = startFg(S, { ...env, STUDIO_BUILDER_CMD: cmdLine(fake, lf, 7) }, ['--role', 'builder', '--agent', agent, '--model', 'fake-1']);
    const all = events(ev);
    const stalls = all.filter((e) => e.type === 'session.stall' && e.meta?.target === agent);
    const end = all.find((e) => e.type === 'agent.session.end' && e.agent === agent);
    const rec = readRec(S, agent);
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'stall', `${agent}.json`), 'utf8')); } catch {}
    const ok = !stalls.length && end?.meta?.exitCause?.kind === 'exit' && Number(rec?.logFrom) > 0 && st?.startedAt === rec?.startedAt && !st?.ended;
    return [ok, `stalls ${JSON.stringify(stalls.map((e) => e.msg))}; end ${end?.msg} ${JSON.stringify(end?.meta?.exitCause || null)}; logFrom ${rec?.logFrom}; stall record ${JSON.stringify(st)}\n${out(r).slice(-800)}`];
  });

  // ---- B-83 b: the stall arithmetic ----
  await guard('2.76.0 (B-83): logTokens counts only the newest Claude session in a log; readLogFrom reads one session\'s part; when the count starts over (fewer tokens than the last observation) the stall window restarts from there, so a real read-burn after it is still caught (fails on 2.75.0: both sessions summed, no readLogFrom, and the old base hid the burn: window negative)', async () => {
    const { S, env } = studio('arith');
    // 2.77.3: these check the ratio itself; the grace period is checked in selftest-2773e
    const r = probe(S, { ...env, STUDIO_STALL_MIN: '60', STUDIO_STALL_GRACE_MIN: '0' }, 'arith', `import fs from 'node:fs';
const st = await import(${u(S, 'harness/stall.mjs')});
const two = [${JSON.stringify(JSON.stringify(asst('a', 'a1', { input_tokens: 500000, output_tokens: 10 })))}, ${JSON.stringify(JSON.stringify(asst('b', 'b1', { input_tokens: 1000, output_tokens: 20 })))}].join('\\n');
const lt = st.logTokens(two);
const f = 'zz-276i.log'; fs.writeFileSync(f, 'OLD-PART\\n'); const from = fs.statSync(f).size; fs.appendFileSync(f, 'NEW-PART\\n');
const part = st.readLogFrom ? st.readLogFrom(f, from) : null;
const now = Date.now();
const session = { agent: 'builder-x83', role: 'builder', startedAt: new Date(now - 10 * 60000).toISOString() };
const fp = st.progressFingerprint(session.agent, process.cwd(), []);
fs.mkdirSync('.studio/stall', { recursive: true });
fs.writeFileSync('.studio/stall/builder-x83.json', JSON.stringify({ agent: 'builder-x83', role: 'builder', startedAt: session.startedAt, fp, lastProgressAt: new Date(now - 60000).toISOString(), baseIn: 900000, baseOut: 100, tokensIn: 950000, tokensOut: 110 }));
const v1 = st.observe(session, { tokens: { in: 400000, out: 10 }, cwd: process.cwd(), now, events: [] });
const v2 = st.observe(session, { tokens: { in: 750000, out: 20 }, cwd: process.cwd(), now: now + 1000, events: [] });
console.log(JSON.stringify({ lt, part, v1, v2 }));`);
    const ok = r.lt?.in === 1000 && r.part === 'NEW-PART\n' && r.v1?.stalled === false && r.v2?.stalled === true && r.v2?.kind === 'read-burn';
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  // ---- B-82: a launcher-ended session's cost ----
  await guard('2.76.0 (B-82): a session the launcher ends (stall) records its own usage from the stream (each message once) and its cost estimated at studio/prices.json (meta.costEstimated, usageFrom stream), never the previous session\'s result line still in the log (fails on 2.75.0: the old session\'s costUsd 0.4389 was reported again, the same row twice)', async () => {
    const { S, ev, env } = studio('cost');
    const agent = 'builder-c82';
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'agents', `${agent}.log`), `${JSON.stringify({ type: 'result', subtype: 'success', session_id: 'old-82', usage: { input_tokens: 10, output_tokens: 10 }, total_cost_usd: 0.4389, num_turns: 3 })}\n`);
    const m1 = asst('new-82', 'm1', { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 5000, output_tokens: 300 });
    const lf = lineFile('c82', [m1, m1, asst('new-82', 'm2', { input_tokens: 500, output_tokens: 200 })]);
    const r = startFg(S, { ...env, STUDIO_STALL_MIN: '0.03', STUDIO_BUILDER_CMD: cmdLine(fake, lf, 40) }, ['--role', 'builder', '--agent', agent, '--model', 'claude-sonnet-test']);
    const end = events(ev).find((e) => e.type === 'agent.session.end' && e.agent === agent);
    const m = end?.meta || {};
    // (1000+500) plain in x $3 + 2000 5-minute writes x $3.75 + 500 out x $15 + 5000 cache reads x $0.30, per million.
    const ok = m.exitCause?.kind === 'stall' && end.tokensIn === 3500 && end.tokensOut === 500 && m.cacheRead === 5000 && Math.abs(Number(m.costUsd) - 0.021) < 0.0005 && m.costEstimated === true && m.usageFrom === 'stream';
    return [ok, `end ${JSON.stringify(end && { msg: end.msg, tokensIn: end.tokensIn, tokensOut: end.tokensOut, meta: { costUsd: m.costUsd, costEstimated: m.costEstimated, usageFrom: m.usageFrom, cacheRead: m.cacheRead, exitCause: m.exitCause } })}\n${out(r).slice(-600)}`];
  });

  // ---- W-0072 / W-0073 / agy model ----
  await guard('2.76.0 (W-0072, W-0073, B-80): agy starts with --print-timeout 5400s, --mode accept-edits and --model <model>; STUDIO_AGY_PRINT_TIMEOUT=600 gives 600s, STUDIO_AGY_MODE=off drops --mode, STUDIO_AGY_MODEL_FLAG=off drops --model; `agent start --tool agy` with no --model starts on the Gemini default, STUDIO_TOOL_AGY_MODEL overrides it (fails on 2.75.0: --print-timeout 900s only, and the model stayed "unknown": agy ran its own default, a Claude model)', async () => {
    const { S, env } = studio('agyargs');
    const r = probe(S, env, 'agyargs', `const a = await import(${u(S, 'harness/agent.mjs')});
const def = a.toolCommand('agy', { model: 'gemini-x-high', prompt: 'p' }).argv;
process.env.STUDIO_AGY_PRINT_TIMEOUT = '600'; process.env.STUDIO_AGY_MODE = 'off'; process.env.STUDIO_AGY_MODEL_FLAG = 'off';
const off = a.toolCommand('agy', { model: 'gemini-x-high', prompt: 'p' }).argv;
console.log(JSON.stringify({ def, off }));`);
    const rf1 = path.join(tmpRoot, `agy-model-1-${process.pid}.json`); const rf2 = path.join(tmpRoot, `agy-model-2-${process.pid}.json`);
    const lf = lineFile('agym', []);
    const s1 = startFg(S, { ...env, STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, lf, 0, rf1)} {model}` }, ['--role', 'builder', '--agent', 'agy-m1', '--tool', 'agy']);
    const s2 = startFg(S, { ...env, STUDIO_TOOL_AGY_MODEL: 'gemini-flash-low', STUDIO_TOOL_AGY_CMD: `${cmdLine(fake, lf, 0, rf2)} {model}` }, ['--role', 'builder', '--agent', 'agy-m2', '--tool', 'agy']);
    const m = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).model; } catch { return null; } };
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const ok = same(r.def, ['agy', '--print-timeout', '5400s', '--mode', 'accept-edits', '--model', 'gemini-x-high']) && same(r.off, ['agy', '--print-timeout', '600s']) && m(rf1) === 'gemini-4-argon-high' && m(rf2) === 'gemini-flash-low';
    return [ok, `${JSON.stringify(r).slice(0, 600)}; models ${m(rf1)} / ${m(rf2)}\n${out(s1).slice(-300)}\n${out(s2).slice(-300)}`];
  });

  // ---- B-80 a: allow agy writes the file-write rule ----
  await guard('2.76.0 (B-80 root cause): `npm run agent -- allow agy --by <owner>` writes the bare "write_file" rule agy needs for file writes beside its command rules, and --dry-run lists it (fails on 2.75.0: command(...) rules only, so a builder read, then quit on its first write)', async () => {
    const { S, env } = studio('allow');
    const dry = spawnSync(process.execPath, ['harness/agent.mjs', 'allow', 'agy', '--dry-run'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env) });
    const real = spawnSync(process.execPath, ['harness/agent.mjs', 'allow', 'agy', '--by', 'pat'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env) });
    let allow = []; try { allow = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'agy-settings.json'), 'utf8')).permissions.allow; } catch {}
    const ok = /^\s+write_file$/m.test(out(dry)) && real.status === 0 && allow.includes('write_file') && allow.some((x) => /^command\(regex:\^node/.test(x));
    return [ok, `${out(dry).slice(-500)}\n${out(real).slice(-400)}\n${JSON.stringify(allow).slice(0, 400)}`];
  });

  // ---- B-80 b: an agy builder in its lane copy ----
  await guard('2.76.0 (B-80 parts 2-3, adapter item 3): an agy builder in its lane copy finds GEMINI.md there with the shell rules (one plain command per call), kept out of the copy\'s git status; its kickoff carries the rules; when agy stops on a permission ("jetski: … write_file permission … auto-denied") that line is in its hand-back note and its session end (fails on 2.75.0: no GEMINI.md, no rules, and the hand-back said only "ended without task done")', async () => {
    const { S, ev, env } = studio('agylane');
    const lanes = { ...env, STUDIO_LANELESS: '' };
    const task = addTask(S, lanes, 'Agy lane work');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const bin = path.join(tmpRoot, `bin-276i-${process.pid}`); fs.mkdirSync(bin, { recursive: true });
    const rec = path.join(tmpRoot, `agy-rec-276i-${process.pid}.json`);
    const stub = path.join(tmpRoot, `agy-stub-276i-${process.pid}.cjs`);
    fs.writeFileSync(stub, `const fs = require('fs'); const { spawnSync } = require('child_process');
const gm = fs.existsSync('GEMINI.md') ? fs.readFileSync('GEMINI.md', 'utf8') : null;
const st = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true }).stdout;
const s = spawnSync(process.execPath, ['harness/task.mjs', 'start', ${JSON.stringify(task)}, '--agent', process.env.STUDIO_LOCK_OWNER], { encoding: 'utf8', windowsHide: true });
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), gemini: gm, status: st, start: s.status }));
console.log('jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for, so it was auto-denied.');
process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); setTimeout(() => process.exit(0), 20000);
`);
    if (process.platform === 'win32') fs.writeFileSync(path.join(bin, 'agy.cmd'), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
    else { fs.writeFileSync(path.join(bin, 'agy'), `#!${process.execPath}\nrequire(${JSON.stringify(stub)});\n`); fs.chmodSync(path.join(bin, 'agy'), 0o755); }
    const r = startFg(S, { ...lanes, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }, ['--role', 'builder', '--agent', 'agy-b80', '--tool', 'agy', '--task', task]);
    let x = null; try { x = JSON.parse(fs.readFileSync(rec, 'utf8')); } catch {}
    let kick = ''; try { kick = fs.readFileSync(path.join(S, '.studio', 'kickoff', 'agy-b80.md'), 'utf8'); } catch {}
    const all = events(ev);
    const end = all.find((e) => e.type === 'agent.session.end' && e.agent === 'agy-b80');
    const paused = all.filter((e) => e.type === 'task.paused' && e.task === task).pop();
    const ok = x && /[\\/]\.lanes[\\/]agy-b80$/.test(x.cwd) && /one plain command per shell call/.test(x.gemini || '') && !/GEMINI\.md/.test(x.status || '') && /one plain command per shell call/.test(kick)
      && x.argv.includes('accept-edits') && /agy said: jetski: .*write_file/.test(end?.msg || '') && /agy said: "jetski: .*write_file/.test(paused?.msg || JSON.stringify(paused?.meta || {}));
    return [ok, `${JSON.stringify(x && { ...x, gemini: (x.gemini || '').slice(0, 80) })}\nend: ${end?.msg}\npaused: ${(paused?.msg || '').slice(0, 400)}\n${out(r).slice(-500)}`];
  });

  // ---- B-84 a: no task, still a copy ----
  await guard('2.76.0 (B-84): a builder started with no --task works in its own lane copy (.lanes/<agent>, STUDIO_MAIN_ROOT set), not the main checkout (fails on 2.75.0: it ran in the main checkout, claimed a task there and staged game files in main\'s index)', async () => {
    const { S, env } = studio('notask');
    const rf = path.join(tmpRoot, `notask-276i-${process.pid}.json`);
    const lf = lineFile('nt', []);
    const r = startFg(S, { ...env, STUDIO_LANELESS: '', STUDIO_BUILDER_CMD: cmdLine(fake, lf, 0, rf) }, ['--role', 'builder', '--agent', 'builder-n84', '--model', 'fake-1']);
    let x = null; try { x = JSON.parse(fs.readFileSync(rf, 'utf8')); } catch {}
    const ok = x && /[\\/]\.lanes[\\/]builder-n84$/.test(x.cwd) && Boolean(x.mainRoot);
    return [ok, `${JSON.stringify(x)}\n${out(r).slice(-500)}`];
  });

  // ---- B-84 b: a copy at claim time ----
  await guard('2.76.0 (B-84): a launched builder that claims a task from the main checkout gets its lane copy at task start (.lanes/<agent>, a git worktree, recorded on its session; the output says to work there); STUDIO_LANELESS=shared keeps the shared checkout for a laneless task (fails on 2.75.0: no copy, it worked in the main checkout)', async () => {
    const { S, env } = studio('claim');
    const t1 = addTask(S, env, 'Claim copy one'); const t2 = addTask(S, env, 'Claim copy two');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    for (const a of ['builder-c84', 'builder-s84']) fs.writeFileSync(path.join(S, '.studio', 'agents', `${a}.json`), JSON.stringify({ agent: a, role: 'builder', tool: 'custom', status: 'running', pid: process.pid, startedAt: new Date().toISOString() }));
    const st = (agent, id, extra) => spawnSync(process.execPath, ['harness/task.mjs', 'start', id, '--agent', agent], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: agent, ...extra }) });
    const a = st('builder-c84', t1, { STUDIO_LANELESS: '' });
    const b = st('builder-s84', t2, { STUDIO_LANELESS: 'shared' });
    const lane = path.join(S, '.lanes', 'builder-c84');
    const rec = readRec(S, 'builder-c84');
    const isWt = fs.existsSync(path.join(lane, '.git')) && g(lane, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
    const ok = a.status === 0 && isWt && rec?.copy?.dir === '.lanes/builder-c84' && /Work ONLY there/.test(out(a)) && /"laneCopy": "\.lanes\/builder-c84"/.test(out(a))
      && b.status === 0 && !fs.existsSync(path.join(S, '.lanes', 'builder-s84')) && !/laneCopy/.test(out(b));
    return [ok, `a ${a.status}: ${out(a).slice(-700)}\nrec ${JSON.stringify(rec?.copy || null)}\nb ${b.status}: ${out(b).slice(-300)}`];
  });

  // ---- B-90 ----
  await guard('2.76.0 (B-90, W-0084): a task whose claim ran out is not kept "busy" for its old owner by that owner\'s event on another task or by an event the train wrote in its name (meta.onBehalf, set from STUDIO_ON_BEHALF), nor by the new builder\'s lane copy that merged the task\'s branch; the owner\'s own task-less event and an orchestrator\'s hand-made copy still count (fails on 2.75.0: busy for the other task\'s event, the train\'s event and the new builder\'s copy; no onBehalf mark)', async () => {
    const { S, env } = studio('busy');
    const r = probe(S, { ...env, STUDIO_LANELESS: '' }, 'busy', `import fs from 'node:fs'; import { spawnSync } from 'node:child_process';
const b = await import(${u(S, 'harness/busy.mjs')});
const w = await import(${u(S, 'harness/worktree.mjs')});
const now = Date.now(); const ts = (m) => new Date(now - m * 60000).toISOString();
const start = { type: 'task.start', agent: 'opus-bot', task: 'T-901', ts: ts(90) };
const other = { type: 'task.unwired', agent: 'opus-bot', task: 'T-905', ts: ts(4) };
const train = { type: 'task.unwired', agent: 'opus-bot', task: 'T-901', ts: ts(3), meta: { onBehalf: 'train' } };
const own = { type: 'agent.now', agent: 'opus-bot', task: null, ts: ts(2) };
const evA = b.claimActive('T-901', { root: process.cwd(), now, events: [start, other, train] }).busy;
const evB = b.claimActive('T-901', { root: process.cwd(), now, events: [start, other, train, own] }).busy;
process.env.STUDIO_ON_BEHALF = 'train';
const ev = await import(${u(S, 'harness/event.mjs')});
const e = ev.emitEvent({ type: 'probe.x', agent: 'opus-bot', task: 'T-901' });
delete process.env.STUDIO_ON_BEHALF;
const commitIn = (dir, msg) => { fs.writeFileSync(dir + '/zz-' + Math.random().toString(36).slice(2) + '.txt', 'x\\n'); spawnSync('git', ['add', '-A'], { cwd: dir, windowsHide: true }); return spawnSync('git', ['commit', '-qm', msg, '--no-verify'], { cwd: dir, encoding: 'utf8', windowsHide: true }).status; };
const c1 = w.createLaneCopy('builder-n90', {});
fs.mkdirSync('.studio/agents', { recursive: true }); fs.writeFileSync('.studio/agents/builder-n90.json', JSON.stringify({ agent: 'builder-n90', role: 'builder', status: 'running', pid: process.pid, startedAt: ts(5), copy: { dir: '.lanes/builder-n90' } }));
const k1 = commitIn(c1.dir, 'T-901: carried work');
const laneNew = b.claimActive('T-901', { root: process.cwd(), now, events: [start], asker: 'builder-n90' });
const laneNew2 = b.claimActive('T-901', { root: process.cwd(), now, events: [start] });
const c2 = w.createLaneCopy('opus-14', {});
const k2 = commitIn(c2.dir, 'T-901: orchestrator work');
const laneOrch = b.claimActive('T-901', { root: process.cwd(), now, events: [start], asker: 'builder-n90' });
console.log(JSON.stringify({ evA, evB, onBehalf: e.meta?.onBehalf || null, k1, k2, c1: c1.error || 'ok', c2: c2.error || 'ok', laneNew: laneNew.busy, laneNew2: laneNew2.busy, laneOrch: laneOrch.busy, why: laneOrch.why || '' }));`);
    const ok = r.evA === false && r.evB === true && r.onBehalf === 'train' && r.k1 === 0 && r.k2 === 0 && r.laneNew === false && r.laneNew2 === false && r.laneOrch === true;
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  // ---- B-81 a: the upgrade's refresh doesn't block it ----
  await guard('2.76.0 (B-81): the upgrade\'s lane refresh runs in its own background process and the upgrade waits at most STUDIO_UPGRADE_REFRESH_WAIT_S: a refresh still running is reported as such (pid, log) and goes on to write its result; a quick one is reported as before (fails on 2.75.0: the upgrade waited for the whole refresh)', async () => {
    const { S, env } = studio('upg');
    const fakeRoot = path.join(tmpRoot, `upg-root-276i-${process.pid}`);
    fs.mkdirSync(path.join(fakeRoot, 'harness'), { recursive: true });
    const flag = path.join(tmpRoot, `upg-slow-${process.pid}`);
    fs.writeFileSync(path.join(fakeRoot, 'harness', 'lanes.mjs'), `import fs from 'node:fs';
const slow = fs.existsSync(${JSON.stringify(fwd(flag))});
setTimeout(() => { console.error('[lanes] working'); console.log(JSON.stringify({ ok: true, results: [{ lane: 'T-1', status: 'ok', why: 'merged main' }] })); }, slow ? 12000 : 200);
`);
    fs.writeFileSync(flag, '1');
    const r = probe(S, env, 'upg', `const ug = await import(${u(S, 'harness/upgrade-guard.mjs')});
const t0 = Date.now(); const a = ug.refreshLanesAfterUpgrade({ root: ${JSON.stringify(fakeRoot)}, by: 'pat', env: { ...process.env, STUDIO_UPGRADE_REFRESH_WAIT_S: '2' } }); const ta = Date.now() - t0;
const fs = await import('node:fs'); fs.rmSync(${JSON.stringify(flag)}, { force: true });
const t1 = Date.now(); const q = ug.refreshLanesAfterUpgrade({ root: ${JSON.stringify(fakeRoot)}, by: 'pat', env: { ...process.env, STUDIO_UPGRADE_REFRESH_WAIT_S: '60' } }); const tq = Date.now() - t1;
console.log(JSON.stringify({ ta, ran: a.ran, line: a.lines[0], tq, qline: q.lines.join(' | ') }));`);
    // the slow one finishes by itself afterwards and leaves its result in its log
    const logRel = (String(r.line || '').match(/log (\.studio\/upgrades\/lanes-refresh-[^;]+\.log)/) || [])[1];
    let later = '';
    for (let i = 0; i < 60 && logRel; i++) { try { later = fs.readFileSync(path.join(fakeRoot, logRel), 'utf8'); } catch {} if (/"results"/.test(later)) break; spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},500)'], { windowsHide: true }); }
    const ok = r.ta < 9000 && r.ran === 'background' && /still running in the background/.test(r.line || '') && /1 refreshed/.test(r.qline || '') && /"results"/.test(later);
    return [ok, `${JSON.stringify(r).slice(0, 900)}\nlater: ${later.slice(-200)}`];
  });

  // ---- B-81 b + c: per-lane test timeout; the train refreshes a stale lane ----
  {
    const { S, env } = studio('refresh');
    fs.mkdirSync(path.join(S, 'game', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(S, 'game', 'demo', 'studio.gates.json'), `${JSON.stringify({ gates: [{ id: 'slow', command: 'node game/demo/slow.mjs', paths: ['game/demo/**'] }] }, null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'game', 'demo', 'slow.mjs'), "setTimeout(() => console.log('slow ok'), Number(process.env.SLOW_276I_S || 0) * 1000);\n");
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'demo game', '--no-verify']);
    const genv = { ...env, STUDIO_GAME: 'demo', STUDIO_LANELESS: '' };
    const mk = probe(S, genv, 'mk', `const w = await import(${u(S, 'harness/worktree.mjs')}); const a = w.createLaneCopy('bld-r81', {}); const b = w.createLaneCopy('bld-t81', {}); console.log(JSON.stringify({ a, b }));`);
    const laneCommit = (agent, rel) => { const d = path.join(S, '.lanes', agent); fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), `${agent}\n`); g(d, ['add', rel]); return g(d, ['commit', '-qm', `T-981: ${rel}`, '--no-verify']).status; };
    const k1 = laneCommit('bld-r81', 'game/demo/r.txt'); const k2 = laneCommit('bld-t81', 'game/demo/t.txt');
    // main moves on: a harness file and a game file
    fs.writeFileSync(path.join(S, 'harness', 'zz-276i-new.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(S, 'game', 'demo', 'main.txt'), 'main\n');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'main moves', '--no-verify']);
    const tip = g(S, ['rev-parse', 'HEAD']).stdout.trim();

    await guard('2.76.0 (B-81): `lanes refresh` stops a lane\'s targeted tests at STUDIO_LANES_REFRESH_TEST_S: main is merged in and kept, the lane is reported refreshed with its tests "not finished … left to the next train\'s full verify", well before the slow test would end (fails on 2.75.0: the refresh waited for the slow test)', async () => {
      const r = probe(S, { ...genv, SLOW_276I_S: '45' }, 'r81', `const l = await import(${u(S, 'harness/lanes.mjs')});
const lane = { task: 'T-981', agent: 'bld-r81', dir: ${JSON.stringify(path.join(S, '.lanes', 'bld-r81'))}, branch: null };
const t0 = Date.now(); const r = await l.refreshLane(process.cwd(), lane, { by: 'pat', tests: true, env: { ...process.env, STUDIO_LANES_REFRESH_TEST_S: '3' } });
console.log(JSON.stringify({ ms: Date.now() - t0, status: r.status, why: r.why, timedOut: r.tests?.timedOut || false }));`, 180000);
      const has = g(path.join(S, '.lanes', 'bld-r81'), ['merge-base', '--is-ancestor', tip, 'HEAD']).status === 0;
      const ok = mk.a?.dir && k1 === 0 && r.status === 'ok' && r.timedOut === true && r.ms < 30000 && has && /left to the next train/.test(r.why || '');
      return [ok, `${JSON.stringify(r)}; main merged in: ${has}; ${mk._err?.slice(-300) || ''}`];
    });

    await guard('2.76.0 (B-81): before a lane\'s checks the train refreshes a lane copy whose harness is behind main (main merged in, never a rebase), so it isn\'t handed back by the hooks check as "runs its own harness"; a current lane is left as it is (fails on 2.75.0: no such step; the lane was handed back)', async () => {
      const dirT = path.join(S, '.lanes', 'bld-t81');
      const r = probe(S, genv, 't81', `const t = await import(${u(S, 'harness/train-refresh.mjs')});
const lane = { task: 'T-981', agent: 'bld-t81', dir: ${JSON.stringify(dirT)} };
const before = t.laneHarnessBehind(process.cwd(), lane.dir);
const a = await t.refreshStaleLane(process.cwd(), lane, {});
const after = t.laneHarnessBehind(process.cwd(), lane.dir);
const b = await t.refreshStaleLane(process.cwd(), lane, {});
console.log(JSON.stringify({ before, a, after, b }));`, 180000);
      const has = g(dirT, ['merge-base', '--is-ancestor', tip, 'HEAD']).status === 0;
      const own = g(dirT, ['log', '--format=%s', '-5']).stdout;
      const ok = k2 === 0 && r.before > 0 && r.a?.refreshed === true && r.after === 0 && r.b?.refreshed === false && !r.b?.handBack && has && /T-981: game\/demo\/t\.txt/.test(own);
      return [ok, `${JSON.stringify(r).slice(0, 900)}; merged ${has}; log ${own}`];
    });
  }

  for (const S of made) { try { g(S, ['worktree', 'prune']); } catch {} }
}
