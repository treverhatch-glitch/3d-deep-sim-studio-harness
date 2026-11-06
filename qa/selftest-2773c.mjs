/**
 * qa/selftest-2773c.mjs — 2.77.3 (c): the crew's 48 h run on 2.77.1.
 *   C1 / B-99  an agy builder's session stays open across turns (agy --input-format stream-json): when a turn ends with
 *              the task still in progress the launcher sends a follow-up (check the background command in the
 *              foreground, continue), at most STUDIO_AGY_CONTINUE_MAX, then closes stdin; STUDIO_AGY_STREAM=0 and the
 *              reviewer keep the one-turn launch. A stand-in agy on PATH (an npm .cmd shim on Windows) speaks the shape.
 *   M4         a reviewer can't run verify or the gates; a note folder (studio/reviews) can't be claimed whole by hand,
 *              and another owner's lock on a file in it doesn't refuse a commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2773C({ dir, run, report, tmpRoot, root }) {
  void run;
  const WIN = process.platform === 'win32';
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = fs.existsSync(path.join(dir, 'node_modules')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DRIFT: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: 'off', STUDIO_DIGEST: '', STUDIO_LANELESS: 'shared', STUDIO_REHEARSAL: '', STUDIO_IDLE_EXIT_MIN: '0', STUDIO_AUTO_FINISH: 'off',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_AGENT_TOOL: '', STUDIO_AGENT_CMD: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_QUOTA_PROBE: 'off', STUDIO_POST_BROWSER_PLAY: 'off',
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_TOOL_AGY_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_AGY_CONTINUE_WAIT_SEC: '0', STUDIO_AGY_STREAM: '1',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2773c-${process.pid}.pem`), ...ident,
  };
  const UNSET = ['STUDIO_STALL_MIN', 'STUDIO_STALL_PLAN_MIN', 'STUDIO_SESSION_MAX_MIN', 'STUDIO_STALL', 'STUDIO_STALL_RATIO', 'STUDIO_AGY_MODE', 'STUDIO_AGY_PRINT_TIMEOUT', 'STUDIO_AGY_MODEL_FLAG', 'STUDIO_TOOL_AGY_MODEL', 'STUDIO_AGY_PROMPT', 'STUDIO_AGY_BYPASS', 'STUDIO_AGY_CONTINUE_MAX', 'STUDIO_AGY_STREAM_IDLE_SEC', 'STUDIO_AGY_STREAM_FIRST_SEC', 'STUDIO_LOCK_NOTE_DIRS', 'STUDIO_ENV_FROM_FILE', 'STUDIO_WORKTREES', 'STUDIO_BUILDER_MODEL', 'STUDIO_AGENT_MODEL', 'STUDIO_BUILDER_TOOL', 'STUDIO_REVIEWER_TOOL', 'STUDIO_REVIEWER_MODEL', 'STUDIO_LOCK_STRICT'];
  // The stand-in agy and its bin folder (first on PATH).
  const bin = path.join(tmpRoot, `2773c-bin-${process.pid}`);
  const recDir = path.join(tmpRoot, `2773c-rec-${process.pid}`);
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(recDir, { recursive: true });
  const childEnv = (extra = {}) => {
    const e = { ...process.env, ...base, ...extra };
    for (const k of UNSET) if (!(k in extra)) delete e[k];
    const old = Object.keys(e).filter((k) => k.toUpperCase() === 'PATH');
    const was = old.map((k) => e[k]).find(Boolean) || '';
    for (const k of old) delete e[k];
    e.PATH = `${bin}${path.delimiter}${was}`;
    return e;
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2773c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-2773c.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2773c-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: out(r).slice(-1500) }; } catch { return { _err: out(r).slice(-2500) }; }
  };
  const startFg = (S, env, args, timeout = 150000) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
  const rec = (agent) => { try { return JSON.parse(fs.readFileSync(path.join(recDir, `${agent}.json`), 'utf8')); } catch { return null; } };
  const logOf = (S, agent) => { try { return fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.log`), 'utf8'); } catch { return ''; } };

  // A stand-in agy: reads stdin; each NDJSON line is a turn (stdin that isn't NDJSON is one text prompt at its end).
  // Turn 1 claims task:T-901 for its agent and says it waits for a background command; a later turn releases it
  // (the task is "done") unless its config file (<rec>/<agent>.cfg.json) says keep; with plain it prints text, not JSON. It prints stream-json (an event type the launcher doesn't know too),
  // records what it got, and exits at the end of its input (releasing the claim) or after 60 s.
  const fake = `// The stand-in agy (qa/selftest-2773c.mjs).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const agent = process.env.STUDIO_LOCK_OWNER || 'nobody';
const OUT = ${JSON.stringify(recDir)};
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(OUT, agent + '.cfg.json'), 'utf8')); } catch {}
const got = { argv: process.argv.slice(2), messages: [], raw: '' };
const save = () => { try { fs.writeFileSync(path.join(OUT, agent + '.json'), JSON.stringify(got)); } catch {} };
const lock = (cmd) => spawnSync(process.execPath, [path.join(process.cwd(), 'harness', 'lock.mjs'), cmd, 'task:T-901', '--owner', agent], { encoding: 'utf8', windowsHide: true });
const emit = (o) => process.stdout.write((cfg.plain ? 'plain text: ' + (o.type || '') : JSON.stringify(o)) + '\\n');
let turns = 0;
const turn = (text) => {
  turns++;
  got.messages.push(text);
  save();
  emit({ type: 'system', subtype: 'init', model: 'gemini-x-high' });
  if (turns === 1) {
    lock('claim');
    emit({ type: 'agy_debug_frame', note: 'not a type the launcher knows' });
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I have started the task in the background and am waiting for the process to complete.' }] } });
  } else {
    if (!cfg.keep) lock('release');
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Checked it in the foreground; continuing.' }] } });
  }
  emit({ type: 'result', subtype: 'success', is_error: false, result: 'turn ' + turns + ' over' });
};
let buf = '';
let ndjson = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  got.raw += d;
  buf += d;
  if (ndjson === null) ndjson = buf.trimStart().startsWith('{');
  if (!ndjson) return;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o = null; try { o = JSON.parse(line); } catch {}
    // 2.78.1 (B-118): real agy keys its stream input on "event" and refuses a line without it.
    if (o && typeof o.event !== 'string') { process.stderr.write('Error: stream input message is missing the "event" field\\n'); save(); process.exit(1); }
    const c = o && o.message && o.message.content;
    turn(Array.isArray(c) ? c.map((x) => x.text || '').join('') : String(line));
  }
});
const end = () => { if (ndjson === false || ndjson === null) turn(got.raw); lock('release'); save(); process.exit(0); };
process.stdin.on('end', end);
process.stdin.on('error', end);
setTimeout(() => { got.timedOut = true; end(); }, 60000);
`;
  const npmShim = (pkg) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkg}\\cli.js" %*\r\n`;
  if (WIN) {
    fs.mkdirSync(path.join(bin, 'node_modules', 'fake-agy'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'node_modules', 'fake-agy', 'cli.js'), fake);
    fs.writeFileSync(path.join(bin, 'agy.cmd'), npmShim('fake-agy'));
  } else {
    fs.writeFileSync(path.join(bin, 'agy'), `#!/usr/bin/env node\n${fake}`);
    fs.chmodSync(path.join(bin, 'agy'), 0o755);
  }
  const model = ['--model', 'gemini-x-high'];

  // ---- C1 / B-99: the pieces ----
  {
    const { S, env } = studio('c1-unit');
    const r = probe(S, env, `const s = await import(${u(S, 'harness/agy-stream.mjs')});
const a = await import(${u(S, 'harness/agent.mjs')});
const t0 = new Date(Date.now() - 60000).toISOString();
const lk = (owner, id) => ({ key: 'task:' + id, owner });
const open = (o) => s.taskStillOpen({ agent: 'builder-g1', role: 'builder', startedAt: t0, ...o });
const line = JSON.parse(s.userLine('hi "there"'));
console.log(JSON.stringify({
  holds: open({ locks: [lk('builder-g1', 'T-1')] }).open,
  pinnedUnclaimed: open({ task: 'T-2' }).open,
  pinnedLetGo: open({ task: 'T-2', events: [{ type: 'task.start', task: 'T-2', agent: 'builder-g1', ts: new Date().toISOString() }] }).open,
  pinnedDone: open({ task: 'T-2', doneIds: ['T-2'] }).open,
  pinnedOther: open({ task: 'T-2', locks: [lk('builder-g2', 'T-2')] }).open,
  studioStop: open({ locks: [lk('builder-g1', 'T-1')], studioStop: { by: 'hatch' } }).open,
  agentStop: open({ locks: [lk('builder-g1', 'T-1')], agentStop: { by: 'opus-1', kind: 'stop' } }).open,
  reviewer: s.taskStillOpen({ agent: 'reviewer-g1', role: 'reviewer', task: 'T-2', locks: [lk('reviewer-g1', 'T-2')] }).open,
  none: open({}).open,
  kinds: [{ type: 'result', subtype: 'success' }, { type: 'turn_complete' }, { type: 'system', subtype: 'turn_end' }, { type: 'assistant', message: { content: [{ type: 'tool_use' }] } }, { type: 'user' }, { type: 'zzz_new' }, 'x', null].map((o) => { const c = s.classifyEvent(o); return c.kind + (c.toolPending === undefined ? '' : ':' + c.toolPending); }),
  line: line.event === 'user' && line.message.role === 'user' && line.message.content[0].text === 'hi "there"',
  wanted: [s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_STREAM: '1' } }), s.agyStreamWanted({ role: 'reviewer', env: { STUDIO_AGY_STREAM: '1' } }), s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_STREAM: '0' } }), s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_STREAM: '1', STUDIO_AGY_PROMPT: 'arg' } }), s.agyStreamWanted({ role: 'builder', env: {} })],
  cfg: s.agyContinueSettings({}), cfg2: s.agyContinueSettings({ STUDIO_AGY_CONTINUE_MAX: '3', STUDIO_AGY_CONTINUE_WAIT_SEC: '2', STUDIO_AGY_STREAM_IDLE_SEC: '0' }),
  cmd: a.toolCommand('agy', { model: 'gemini-x-high', prompt: 'P', stream: true }),
  oneTurn: a.toolCommand('agy', { model: 'gemini-x-high', prompt: 'P' }),
}));`);
    await guard('2.77.3 (C1 / B-99): taskStillOpen says a session is mid-task while it holds its claim or its pinned task is not claimed yet, and not once it let go, the task is done or someone else\'s, the studio or the agent was stopped, or it is a reviewer; events: result/turn_complete/system turn_end end a turn, a tool_use is pending, an unknown type is unknown; the kickoff is one stream-json user line; the stream launch is a builder\'s with STUDIO_AGY_STREAM=1 and (2.78.1) by default (unset), not with 0 or with STUDIO_AGY_PROMPT=arg; defaults 8 follow-ups, 15 s wait, 1800 s idle, 180 s for a first stream-json event (fails on 2.77.2: no harness/agy-stream.mjs)', () => [
      r.holds === true && r.pinnedUnclaimed === true && r.pinnedLetGo === false && r.pinnedDone === false && r.pinnedOther === false && r.studioStop === false && r.agentStop === false && r.reviewer === false && r.none === false
        && JSON.stringify(r.kinds) === JSON.stringify(['turn-end', 'turn-end', 'turn-end', 'event:true', 'event:false', 'unknown', 'unknown', 'unknown']) && r.line === true
        && JSON.stringify(r.wanted) === JSON.stringify([true, false, false, false, true]) && r.cfg?.max === 8 && r.cfg?.waitSec === 15 && r.cfg?.idleSec === 1800 && r.cfg?.firstSec === 180 && r.cfg2?.max === 3 && r.cfg2?.waitSec === 2 && r.cfg2?.idleSec === 0,
      JSON.stringify(r).slice(0, 2500)]);
    await guard('2.77.3 (C1 / B-99): a stream agy command is `agy --input-format stream-json --output-format stream-json --print-timeout 5400s --mode accept-edits --model <m>` with the kickoff as a stream-json line on stdin; without stream the one-turn command is unchanged (fails on 2.77.2: toolCommand has no stream launch)', () => [
      r.cmd?.stream === 'agy' && JSON.stringify(r.cmd.argv) === JSON.stringify(['agy', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '5400s', '--mode', 'accept-edits', '--model', 'gemini-x-high']) && JSON.parse(r.cmd.stdin).message.content[0].text === 'P'
        && !r.oneTurn?.stream && JSON.stringify(r.oneTurn?.argv) === JSON.stringify(['agy', '--print-timeout', '5400s', '--mode', 'accept-edits', '--model', 'gemini-x-high']) && r.oneTurn.stdin === 'P',
      JSON.stringify({ cmd: r.cmd, oneTurn: r.oneTurn, err: r._err }).slice(0, 2000)]);
  }

  // ---- C1 / B-99: end to end with the stand-in agy on PATH ----
  {
    const { S, ev, env } = studio('c1-e2e');
    const s1 = startFg(S, { ...env, STUDIO_TELEMETRY: 'full' /* 2.79.1 (d): agy follow-ups are counted in the session end by default; this check reads each event */ }, ['--role', 'builder', '--agent', 'builder-agyc1', '--tool', 'agy', ...model]);
    const r1 = rec('builder-agyc1');
    const log1 = logOf(S, 'builder-agyc1');
    const cont = events(ev).filter((e) => e.type === 'agent.agy_continue' && e.agent === 'builder-agyc1');
    const kick1 = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'kickoff', 'builder-agyc1.md'), 'utf8'); } catch { return null; } })();
    await guard('2.77.3 (C1 / B-99): an agy builder whose turn ends while it holds its task (it said it waits for a background command) gets the whole kickoff as its first stream-json message (no argument with a space) and a follow-up on the same session (check it in the foreground, continue); when the task is let go the launcher closes stdin and agy exits; an unknown event type is noted, not fatal (fails on 2.77.2: agy got the prompt as plain text with stdin closed at once: one turn, the session ended mid-task)', () => [
      r1 && !r1.timedOut && r1.argv.includes('--input-format') && !r1.argv.some((a) => /\s/.test(a)) && kick1 && r1.messages[0] === kick1 && r1.messages.length === 2 && /FOREGROUND/.test(r1.messages[1]) && /T-901/.test(r1.messages[1]) && cont.length === 1
        && /agy stream: follow-up 1\/8 sent/.test(log1) && /closing its input/.test(log1) && /agy_debug_frame/.test(log1) && s1.status === 0,
      JSON.stringify({ status: s1.status, r1, cont: cont.length, log: log1.split('\n').filter((l) => l.startsWith('[launcher]')).slice(-12), out: out(s1).slice(-800) }).slice(0, 3500)]);

    fs.writeFileSync(path.join(recDir, 'builder-agyc2.cfg.json'), JSON.stringify({ keep: true }));
    const s2 = startFg(S, { ...env, STUDIO_AGY_CONTINUE_MAX: '2' }, ['--role', 'builder', '--agent', 'builder-agyc2', '--tool', 'agy', ...model]);
    const r2 = rec('builder-agyc2');
    const log2 = logOf(S, 'builder-agyc2');
    await guard('2.77.3 (C1 / B-99): a session that stays mid-task gets at most STUDIO_AGY_CONTINUE_MAX follow-ups (2 here), then its stdin is closed and agy exits (fails on 2.77.2: no follow-ups at all)', () => [
      r2 && !r2.timedOut && r2.messages.length === 3 && /STUDIO_AGY_CONTINUE_MAX=2/.test(log2) && /follow-up 2\/2 sent/.test(log2),
      JSON.stringify({ status: s2.status, r2: r2 && { n: r2.messages.length, timedOut: r2.timedOut }, log: log2.split('\n').filter((l) => l.startsWith('[launcher]')).slice(-8), out: out(s2).slice(-600) }).slice(0, 3000)]);

    const t5 = Date.now();
    fs.writeFileSync(path.join(recDir, 'builder-agyc5.cfg.json'), JSON.stringify({ plain: true }));
    const s5 = startFg(S, { ...env, STUDIO_AGY_STREAM_FIRST_SEC: '3' }, ['--role', 'builder', '--agent', 'builder-agyc5', '--tool', 'agy', ...model]);
    const r5 = rec('builder-agyc5');
    const log5 = logOf(S, 'builder-agyc5');
    await guard('2.77.3 (C1 / B-99): an agy that prints no stream-json event (it may not take the stream flags) gets its stdin closed after STUDIO_AGY_STREAM_FIRST_SEC (3 s here) and runs as one turn, never waiting for input (fails on 2.77.2: no stream launch, no such guard)', () => [
      r5 && !r5.timedOut && r5.messages.length === 1 && /printed no stream-json event in 3s/.test(log5) && Date.now() - t5 < 45000,
      JSON.stringify({ status: s5.status, r5: r5 && { n: r5.messages.length, timedOut: r5.timedOut }, ms: Date.now() - t5, log: log5.split('\n').filter((l) => l.startsWith('[launcher]')).slice(-6) }).slice(0, 2000)]);

    const s3 = startFg(S, { ...env, STUDIO_AGY_STREAM: '0' }, ['--role', 'builder', '--agent', 'builder-agyc3', '--tool', 'agy', ...model]);
    const r3 = rec('builder-agyc3');
    const s4 = startFg(S, env, ['--role', 'reviewer', '--agent', 'reviewer-agyc4', '--tool', 'agy', ...model]);
    const r4 = rec('reviewer-agyc4');
    await guard('2.77.3 (C1 / B-99): STUDIO_AGY_STREAM=0 switches an agy builder from the stream launch back to the one-turn launch (prompt as text on stdin, closed at once), and an agy reviewer stays on the one-turn launch (it still works: one turn, no follow-up) (fails on 2.77.2: there is no stream launch to switch from: the builder above got one turn too)', () => [
      r3 && !r3.argv.includes('--input-format') && r3.messages.length === 1 && !r3.raw.trimStart().startsWith('{') && r4 && !r4.argv.includes('--input-format') && r4.messages.length === 1 && !r4.timedOut
        && r1 && r1.argv.includes('--input-format') && r1.messages.length === 2,
      JSON.stringify({ s3: s3.status, r3: r3 && { argv: r3.argv, n: r3.messages.length }, s4: s4.status, r4: r4 && { argv: r4.argv, n: r4.messages.length }, out4: out(s4).slice(-600) }).slice(0, 2500)]);
  }

  // ---- M4 ----
  {
    const { S, env } = studio('m4');
    const gates = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--no-detach', '--only', 'no-such-gate-2773c'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ ...env, STUDIO_ROLE: 'reviewer', STUDIO_LOCK_OWNER: 'reviewer-agyr2' }), timeout: 120000 });
    const byName = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--no-detach', '--only', 'no-such-gate-2773c'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ ...env, STUDIO_LOCK_OWNER: 'reviewer-agyr3' }), timeout: 120000 });
    const builder = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--no-detach', '--only', 'no-such-gate-2773c'], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-x1' }), timeout: 120000 });
    await guard('2.77.3 (M4): a reviewer session (STUDIO_ROLE=reviewer, or an agent named reviewer-…) can\'t run the gates: refused with "a reviewer … writes its review file only", nothing run; a builder\'s run is not refused for it (fails on 2.77.2: the reviewer queued a full verify)', () => [
      gates.status === 1 && /refused: reviewer-agyr2 is a reviewer/.test(out(gates)) && /review file only/.test(out(gates)) && byName.status === 1 && /reviewer-agyr3 is a reviewer/.test(out(byName)) && !/is a reviewer/.test(out(builder)),
      JSON.stringify({ g: [gates.status, out(gates).slice(-400)], n: [byName.status, out(byName).slice(-300)], b: [builder.status, out(builder).slice(-300)] })]);

    const r = probe(S, env, `import fs from 'node:fs'; import path from 'node:path';
const l = await import(${u(S, 'harness/lock.mjs')});
const folder = l.claim('path:studio/reviews', 'reviewer-agyr2', 3600, { byHand: true });
const file = l.claim('path:studio/reviews/2026-11-05-T-173-reviewer-agyr2.md', 'reviewer-agyr2', 3600, { byHand: true });
const other = l.claim('path:studio/reviews/2026-11-05-T-174-reviewer-agyr5.md', 'reviewer-agyr5', 3600, { byHand: true });
// A lock on another studio/ folder, and a main commit that carries a review file someone else holds.
const old = l.claim('path:studio/notes-2773c', 'reviewer-agyr2', 3600, {});
const staged = l.checkStaged('producer-1', { files: ['studio/reviews/2026-11-05-T-173-reviewer-agyr2.md', 'studio/NEXT.md'], lane: null, env: {} });
const elsewhere = l.checkStaged('producer-1', { files: ['studio/notes-2773c/x.md'], lane: null, env: {} });
const offDirs = l.checkStaged('producer-1', { files: ['studio/reviews/2026-11-05-T-173-reviewer-agyr2.md'], lane: null, env: { STUDIO_LOCK_NOTE_DIRS: 'off' } });
console.log(JSON.stringify({ folder: [folder.ok, folder.message || ''], file: file.ok, other: other.ok, old: old.ok, staged: { ok: staged.ok, w: staged.warnings, p: staged.problems }, elsewhere: elsewhere.ok, offDirs: offDirs.ok }));`);
    await guard('2.77.3 (M4): a by-hand claim of the whole studio/reviews folder is refused (claim the one review file); two reviewers each claim their own file; another owner\'s lock on a review file is a note at commit, not a refusal, while a lock elsewhere (and with STUDIO_LOCK_NOTE_DIRS=off) still refuses (fails on 2.77.2: the folder claim was granted, so every commit carrying a review file was refused)', () => [
      r.folder?.[0] === false && /one file per note/.test(r.folder?.[1] || '') && r.file === true && r.other === true && r.staged?.ok === true && (r.staged.w || []).some((w) => /note folder/.test(w)) && r.old === true && r.elsewhere === false && r.offDirs === false,
      JSON.stringify(r).slice(0, 2000)]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  for (const d of [bin, recDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
