/**
 * qa/selftest-2781b.mjs — 2.78.1 (b): agy stream mode on real agy (the crew's B-118 and the Gemini items).
 *   B-118      the stream input is {"event":"user","message":{…}} (agy refuses a line without "event"); stream mode is
 *              the default for agy builders; an agy that refuses the stream input is recorded once
 *              (.studio/agy-stream.json) and relaunched in the one-turn mode, and later launches skip stream mode until
 *              agy changes; a failover under the same name works on in its own lane copy.
 *   nudge      a stream session with no tool call and no file write for STUDIO_AGY_NUDGE_MIN gets the follow-up.
 *   review     the agy CLI reviewer runs a Gemini model by name, with the review on stdin.
 * A stand-in agy (and claude) on PATH (npm .cmd shims on Windows) speak these shapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781B({ dir, run, report, tmpRoot, root }) {
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
    STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_TOOL_AGY_CMD: '', STUDIO_LANE_INFER: 'off', STUDIO_GAME: '', STUDIO_OVERLAP: '', STUDIO_REACHABILITY: 'off', STUDIO_NIM_CHECK: 'off', STUDIO_AGY_CONTINUE_WAIT_SEC: '0',
    STUDIO_TAKEOVER: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2781b-${process.pid}.pem`), ...ident,
  };
  const UNSET = ['STUDIO_STALL_MIN', 'STUDIO_STALL_PLAN_MIN', 'STUDIO_SESSION_MAX_MIN', 'STUDIO_STALL', 'STUDIO_STALL_RATIO', 'STUDIO_AGY_MODE', 'STUDIO_AGY_PRINT_TIMEOUT', 'STUDIO_AGY_MODEL_FLAG', 'STUDIO_TOOL_AGY_MODEL', 'STUDIO_AGY_PROMPT', 'STUDIO_AGY_BYPASS', 'STUDIO_AGY_CONTINUE_MAX', 'STUDIO_AGY_STREAM_IDLE_SEC', 'STUDIO_AGY_STREAM_FIRST_SEC', 'STUDIO_AGY_STREAM', 'STUDIO_AGY_NUDGE_MIN', 'STUDIO_ENV_FROM_FILE', 'STUDIO_WORKTREES', 'STUDIO_BUILDER_MODEL', 'STUDIO_AGENT_MODEL', 'STUDIO_BUILDER_TOOL', 'STUDIO_REVIEWER_TOOL', 'STUDIO_REVIEWER_MODEL', 'STUDIO_REVIEW_TOOLS', 'STUDIO_LOCK_STRICT', 'STUDIO_KEEP_FAILED_LANE', 'STUDIO_REFRESH_RELAUNCH'];
  const bin = path.join(tmpRoot, `2781b-bin-${process.pid}`);
  const recDir = path.join(tmpRoot, `2781b-rec-${process.pid}`);
  const versionFile = path.join(recDir, 'agy-version.txt');
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
    const S = path.join(tmpRoot, `2781b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const ev = path.join(S, '.studio', 'events-2781b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, ev, env: { AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const probe = (S, env, code, timeout = 120000) => {
    const f = path.join(tmpRoot, `probe-2781b-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: out(r).slice(-1500) }; } catch { return { _err: out(r).slice(-2500) }; }
  };
  const startFg = (S, env, args, timeout = 150000) => spawnSync(process.execPath, ['harness/agent.mjs', 'start', '--attach', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(env), timeout });
  const rec = (agent, pre = '') => { try { return JSON.parse(fs.readFileSync(path.join(recDir, `${pre}${agent}.json`), 'utf8')); } catch { return null; } };
  const cfgFor = (agent, c) => fs.writeFileSync(path.join(recDir, `${agent}.cfg.json`), JSON.stringify(c));
  const logOf = (S, agent) => { try { return fs.readFileSync(path.join(S, '.studio', 'agents', `${agent}.log`), 'utf8'); } catch { return ''; } };
  const launcherLines = (log, k = 10) => log.split('\n').filter((l) => l.startsWith('[launcher]')).slice(-k);

  // The stand-in agy. `--version` prints <rec>/agy-version.txt. Otherwise it reads stdin: each NDJSON line is a turn
  // (stdin that isn't NDJSON is one text prompt at its end). Like real agy it refuses an NDJSON line with no "event"
  // ("stream input message is missing the "event" field", exit 1) unless its config (<rec>/<agent>.cfg.json) says
  // lenient; refuse: it refuses every NDJSON line (an agy that doesn't take the stream input). Turn 1 claims task:T-901
  // and ends with a result event (quiet: no result, it waits); a later turn releases it and ends. crash: it writes
  // marker-2781b.txt in its folder and exits 1. Records what it got in <rec>/<agent>.json.
  const fake = `// The stand-in agy (qa/selftest-2781b.mjs).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const OUT = ${JSON.stringify(recDir)};
if (process.argv.includes('--version')) { let v = 'agy-fake 1.0.0'; try { v = fs.readFileSync(${JSON.stringify(versionFile)}, 'utf8').trim() || v; } catch {} process.stdout.write(v + '\\n'); process.exit(0); }
const agent = process.env.STUDIO_LOCK_OWNER || 'nobody';
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(OUT, agent + '.cfg.json'), 'utf8')); } catch {}
const got = { argv: process.argv.slice(2), messages: [], raw: '', cwd: process.cwd() };
const save = () => { try { fs.writeFileSync(path.join(OUT, agent + '.json'), JSON.stringify(got)); } catch {} };
const lock = (cmd) => spawnSync(process.execPath, [path.join(process.cwd(), 'harness', 'lock.mjs'), cmd, 'task:T-901', '--owner', agent], { encoding: 'utf8', windowsHide: true });
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const refuse = () => { process.stderr.write('Error: stream input message is missing the "event" field\\n'); got.refused = true; save(); process.exit(1); };
let turns = 0;
const turn = (text) => {
  turns++;
  got.messages.push(text);
  save();
  if (cfg.crash) { try { fs.writeFileSync(path.join(process.cwd(), 'marker-2781b.txt'), 'work in progress\\n'); } catch {} process.exit(1); }
  emit({ type: 'system', subtype: 'init', model: 'gemini-x-high' });
  if (turns === 1) {
    lock('claim');
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'I have started the task in the background and am waiting for the process to complete.' }] } });
    if (cfg.quiet) return;
  } else {
    lock('release');
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Checked it in the foreground; done.' }] } });
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
    if (cfg.refuse || (o && typeof o.event !== 'string' && !cfg.lenient)) refuse();
    const c = o && o.message && o.message.content;
    turn(Array.isArray(c) ? c.map((x) => x.text || '').join('') : String(line));
  }
});
const end = () => { if (ndjson === false || ndjson === null) turn(got.raw); lock('release'); save(); process.exit(0); };
process.stdin.on('end', end);
process.stdin.on('error', end);
setTimeout(() => { got.timedOut = true; end(); }, cfg.maxMs || 40000);
`;
  // The stand-in claude (the failover's tool): records its folder, whether the agy session's marker is there and the
  // branch, then ends with a result line.
  const fakeClaude = `// The stand-in claude (qa/selftest-2781b.mjs).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const agent = process.env.STUDIO_LOCK_OWNER || 'nobody';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const br = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(${JSON.stringify(recDir)}, 'claude-' + agent + '.json'), JSON.stringify({ cwd: process.cwd(), marker: fs.existsSync(path.join(process.cwd(), 'marker-2781b.txt')), branch: (br.stdout || '').trim(), reusedNote: /is the one the last session under your name used/.test(raw) }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) + '\\n');
  process.exit(0);
});
`;
  const npmShim = (pkg) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${pkg}\\cli.js" %*\r\n`;
  const agyFile = WIN ? path.join(bin, 'node_modules', 'fake-agy', 'cli.js') : path.join(bin, 'agy');
  const install = (name, code) => {
    if (WIN) {
      fs.mkdirSync(path.join(bin, 'node_modules', `fake-${name}`), { recursive: true });
      fs.writeFileSync(path.join(bin, 'node_modules', `fake-${name}`, 'cli.js'), code);
      fs.writeFileSync(path.join(bin, `${name}.cmd`), npmShim(`fake-${name}`));
    } else {
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${code}`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  };
  install('agy', fake);
  install('claude', fakeClaude);
  const model = ['--model', 'gemini-x-high'];

  // ---- the pieces ----
  {
    const { S, env } = studio('unit');
    const r = probe(S, env, `const s = await import(${u(S, 'harness/agy-stream.mjs')});
const line = s.userLine('hi "there"');
const st = (o) => ({ turns: 0, sawJson: 0, ...o });
const ident = { program: '/x/agy', size: 10, mtimeMs: 5 };
const rec = { at: '2026-11-05T05:00:00Z', why: 'w', agy: { ...ident, version: 'agy 1.0' } };
console.log(JSON.stringify({
  line, parsed: JSON.parse(line),
  kinds: [{ event: 'turn_complete' }, { type: 'message', event: 'result' }, { event: 'agent_end' }, { event: 'assistant', message: { content: [{ type: 'tool_use' }] } }, { event: 'zzz_new' }].map((o) => { const c = s.classifyEvent(o); return c.kind + (c.toolPending === undefined ? '' : ':' + c.toolPending); }),
  tool: [s.classifyEvent({ type: 'tool_result' }).tool, s.classifyEvent({ type: 'assistant', message: { content: [{ type: 'text' }] } }).tool],
  wanted: [s.agyStreamWanted({ role: 'builder', env: {} }), s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_STREAM: '0' } }), s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_STREAM: 'off' } }), s.agyStreamWanted({ role: 'builder', env: { STUDIO_AGY_PROMPT: 'arg' } }), s.agyStreamWanted({ role: 'reviewer', env: {} })],
  nudgeDefault: s.agyContinueSettings({}).nudgeMin, nudge: [s.nudgeMinutes(10, 15), s.nudgeMinutes(10, 6), s.nudgeMinutes(0, 15), s.nudgeMinutes(10, 0), s.nudgeMinutes(3, 15)],
  fail: [
    s.streamFailure({ state: st({}), log: 'Error: stream input message is missing the "event" field' }).failed,
    s.streamFailure({ state: st({ sawJson: 1 }), log: '{"event":"error","message":"unknown flag: --input-format"}' }).failed,
    s.streamFailure({ state: st({}), log: '[launcher] agy stream session: --input-format stream-json' }).failed,
    s.streamFailure({ state: st({ sawJson: 3 }), log: '{"type":"assistant","message":{"content":[{"type":"text","text":"the input format is fine"}]}}' }).failed,
    s.streamFailure({ state: st({ turns: 1 }), log: 'stream input message is missing the "event" field' }).failed,
    s.streamFailure({ state: st({}), log: 'stream input message is missing the "event" field', ended: { kind: 'stall' } }).failed,
  ],
  holds: [
    s.streamRecordHolds(rec, { ident: () => ident, version: () => { throw new Error('no spawn for the same file'); } }).holds,
    s.streamRecordHolds(rec, { ident: () => ({ ...ident, size: 11 }), version: () => 'agy 1.0' }),
    s.streamRecordHolds(rec, { ident: () => ({ ...ident, size: 11 }), version: () => 'agy 1.1' }).holds,
    s.streamRecordHolds(null, {}).holds,
  ],
}));`);
    await guard('2.78.1 (B-118): the stream input line is exactly {"event":"user","message":{"role":"user","content":[{"type":"text","text":…}]}} (the crew\'s probe; no "type"); a turn end keyed on "event" (even beside a "type") is a turn end; stream mode is a builder\'s by default, not with STUDIO_AGY_STREAM=0/off, STUDIO_AGY_PROMPT=arg or for a reviewer; STUDIO_AGY_NUDGE_MIN 10, kept below two thirds of STUDIO_STALL_MIN; streamFailure: an input-format error in agy\'s own output or no stream-json before the first turn ended is a failure, a launcher line, an assistant\'s text, a session that ended a turn or one the launcher ended are not; the record holds for the same agy file (no spawn) or the same version, not for a new version (fails on 2.78.0: userLine sends "type":"user", stream mode is off by default, no streamFailure)', () => [
      r.line === '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"hi \\"there\\""}]}}\n' && !('type' in (r.parsed || {}))
        && JSON.stringify(r.kinds) === JSON.stringify(['turn-end', 'turn-end', 'turn-end', 'event:true', 'unknown']) && JSON.stringify(r.tool) === JSON.stringify([true, false])
        && JSON.stringify(r.wanted) === JSON.stringify([true, false, false, false, false]) && r.nudgeDefault === 10 && JSON.stringify(r.nudge) === JSON.stringify([10, 4, 0, 10, 3])
        && JSON.stringify(r.fail) === JSON.stringify([true, true, true, false, false, false])
        && r.holds?.[0] === true && r.holds?.[1]?.holds === true && r.holds?.[1]?.refreshed?.agy?.size === 11 && r.holds?.[2] === false && r.holds?.[3] === false,
      JSON.stringify(r).slice(0, 2500)]);
  }

  // ---- B-118 end to end: the stand-in refuses a line with no "event" ----
  {
    const { S, ev, env } = studio('e2e');
    const s1 = startFg(S, { ...env, STUDIO_AGY_STREAM: '1' }, ['--role', 'builder', '--agent', 'builder-agyb1', '--tool', 'agy', ...model]);
    const r1 = rec('builder-agyb1');
    const log1 = logOf(S, 'builder-agyb1');
    const kick1 = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'kickoff', 'builder-agyb1.md'), 'utf8'); } catch { return null; } })();
    const cont1 = events(ev).filter((e) => e.type === 'agent.agy_continue' && e.agent === 'builder-agyb1');
    await guard('2.78.1 (B-118): an agy builder in stream mode (STUDIO_AGY_STREAM=1) whose agy refuses a stream line with no "event" gets the kickoff and the follow-up in the shape agy takes: two turns, the follow-up sent, stdin closed once the task is let go (fails on 2.78.0: agy said "stream input message is missing the "event" field" and exited on the kickoff)', () => [
      r1 && !r1.refused && !r1.timedOut && r1.argv.includes('--input-format') && kick1 && r1.messages[0] === kick1 && r1.messages.length === 2 && /FOREGROUND/.test(r1.messages[1]) && cont1.length === 1 && /closing its input/.test(log1) && s1.status === 0,
      JSON.stringify({ status: s1.status, r1: r1 && { argv: r1.argv, n: r1.messages.length, refused: r1.refused, timedOut: r1.timedOut }, log: launcherLines(log1, 12), out: out(s1).slice(-600) }).slice(0, 3000)]);

    const s2 = startFg(S, env, ['--role', 'builder', '--agent', 'builder-agyb2', '--tool', 'agy', ...model]);
    const r2 = rec('builder-agyb2');
    const log2 = logOf(S, 'builder-agyb2');
    await guard('2.78.1 (B-118): with STUDIO_AGY_STREAM unset an agy builder starts in stream mode (the default now; the log says STUDIO_AGY_STREAM=0 gives the one-turn launch) and gets its follow-up (fails on 2.78.0: stream mode was off by default: one turn, prompt as plain text)', () => [
      r2 && !r2.refused && r2.argv.includes('--input-format') && r2.messages.length === 2 && /STUDIO_AGY_STREAM=0 starts the one-turn launch/.test(log2) && s2.status === 0,
      JSON.stringify({ status: s2.status, r2: r2 && { argv: r2.argv, n: r2.messages.length, refused: r2.refused }, log: launcherLines(log2, 8), out: out(s2).slice(-600) }).slice(0, 2500)]);

    // ---- the safety net: an agy that refuses the stream input ----
    fs.writeFileSync(versionFile, 'agy-fake 1.0.0');
    cfgFor('builder-agyb3', { refuse: true });
    const s3 = startFg(S, env, ['--role', 'builder', '--agent', 'builder-agyb3', '--tool', 'agy', ...model]);
    const r3 = rec('builder-agyb3');
    const log3 = logOf(S, 'builder-agyb3');
    const recFile = path.join(S, '.studio', 'agy-stream.json');
    const record = (() => { try { return JSON.parse(fs.readFileSync(recFile, 'utf8')); } catch { return null; } })();
    const off3 = events(ev).filter((e) => e.type === 'agent.agy_stream_off');
    const one3 = events(ev).filter((e) => e.type === 'agent.agy_one_turn' && e.agent === 'builder-agyb3');
    await guard('2.78.1 (B-118): an agy that refuses the stream input before its first turn ends is recorded once in .studio/agy-stream.json (its error line, the stream flags, agy\'s program and --version) and the session is relaunched at once in the one-turn mode (the kickoff as plain text) (fails on 2.78.0: the session ended on the refusal; nothing recorded or relaunched)', () => [
      record && /missing the "event" field/.test(record.line || '') && JSON.stringify(record.flags) === JSON.stringify(['--input-format', 'stream-json', '--output-format', 'stream-json']) && record.agy?.version === 'agy-fake 1.0.0' && record.agy?.program
        && off3.length === 1 && one3.length === 1 && r3 && !r3.argv.includes('--input-format') && r3.messages.length === 1 && !r3.raw.trimStart().startsWith('{') && /agy one-turn launch/.test(log3),
      JSON.stringify({ status: s3.status, record, off: off3.length, one: one3.length, r3: r3 && { argv: r3.argv, n: r3.messages.length }, log: launcherLines(log3, 10), out: out(s3).slice(-500) }).slice(0, 3000)]);

    const s4 = startFg(S, env, ['--role', 'builder', '--agent', 'builder-agyb4', '--tool', 'agy', ...model]);
    const r4 = rec('builder-agyb4');
    const log4 = logOf(S, 'builder-agyb4');
    const off4 = events(ev).filter((e) => e.type === 'agent.agy_stream_off');
    // agy is replaced by a new version: stream mode is tried again and the record cleared.
    fs.appendFileSync(agyFile, '\n// a new agy\n');
    fs.writeFileSync(versionFile, 'agy-fake 1.1.0');
    const s5 = startFg(S, env, ['--role', 'builder', '--agent', 'builder-agyb5', '--tool', 'agy', ...model]);
    const r5 = rec('builder-agyb5');
    const retry = events(ev).filter((e) => e.type === 'agent.agy_stream_retry');
    await guard('2.78.1 (B-118): while the record holds, the next agy builder starts in the one-turn mode with no second record or alert (the log names .studio/agy-stream.json); once agy changes (another file, another --version) stream mode is tried again and the record is cleared (fails on 2.78.0: no record: every launch tried stream mode again)', () => [
      r4 && !r4.argv.includes('--input-format') && r4.messages.length === 1 && /agy stream mode skipped: \.studio\/agy-stream\.json/.test(log4) && off4.length === 1 && s4.status === 0
        && r5 && r5.argv.includes('--input-format') && r5.messages.length === 2 && retry.length === 1 && !fs.existsSync(recFile),
      JSON.stringify({ s4: s4.status, r4: r4 && { argv: r4.argv, n: r4.messages.length }, off4: off4.length, log4: launcherLines(log4, 6), s5: s5.status, r5: r5 && { argv: r5.argv, n: r5.messages.length }, retry: retry.length, rec: fs.existsSync(recFile) }).slice(0, 3000)]);

    // ---- the progress nudge ----
    cfgFor('builder-agyb6', { quiet: true, lenient: true, maxMs: 25000 });
    const t6 = Date.now();
    const s6 = startFg(S, { ...env, STUDIO_AGY_STREAM: '1', STUDIO_AGY_NUDGE_MIN: '0.05' }, ['--role', 'builder', '--agent', 'builder-agyb6', '--tool', 'agy', ...model]);
    const r6 = rec('builder-agyb6');
    const log6 = logOf(S, 'builder-agyb6');
    const cont6 = events(ev).filter((e) => e.type === 'agent.agy_continue' && e.agent === 'builder-agyb6');
    await guard('2.78.1 (Gemini stream progress watch): a stream session that goes quiet mid-turn (no turn end, no tool call, no file write) while it holds its task gets the follow-up after STUDIO_AGY_NUDGE_MIN (3 s here), counted as follow-up 1 of STUDIO_AGY_CONTINUE_MAX, and carries on (fails on 2.78.0: no nudge: it sat idle until the stand-in gave up after 25 s)', () => [
      r6 && !r6.timedOut && r6.messages.length === 2 && /No tool call and no file write from you/.test(r6.messages[1]) && /follow-up 1 of at most 8/.test(r6.messages[1]) && cont6.length === 1 && cont6[0].meta?.nudge === true
        && /sent as a nudge/.test(log6) && Date.now() - t6 < 24000,
      JSON.stringify({ status: s6.status, ms: Date.now() - t6, r6: r6 && { n: r6.messages.length, timedOut: r6.timedOut, m2: String(r6.messages[1] || '').slice(0, 200) }, cont: cont6.map((e) => e.meta), log: launcherLines(log6, 8) }).slice(0, 3000)]);
  }

  // ---- B-118: a failover works on in its own lane copy ----
  {
    const { S, ev, env } = studio('failover');
    cfgFor('builder-agyf1', { crash: true });
    const s1 = startFg(S, { ...env, STUDIO_LANELESS: '', STUDIO_AGY_STREAM: '0' }, ['--role', 'builder', '--agent', 'builder-agyf1', '--tool', 'agy', ...model, '--fallback', 'claude:claude-fake-1']);
    const a = rec('builder-agyf1');
    const c = rec('builder-agyf1', 'claude-');
    const fo = events(ev).filter((e) => e.type === 'agent.failover' && e.agent === 'builder-agyf1');
    const reused = events(ev).filter((e) => e.type === 'lane.reused' && e.agent === 'builder-agyf1');
    const refused = events(ev).filter((e) => e.type === 'agent.start_refused' && e.agent === 'builder-agyf1');
    const norm = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
    await guard('2.78.1 (B-118): when an agy builder in its own lane copy crashes and fails over (--fallback claude:…), the next session under the same name starts in that same copy (same folder and branch, the crashed session\'s uncommitted file still there, its kickoff says so) instead of a new copy; nothing is refused (fails on 2.78.0: the copy was removed and a new one made, which on Windows was refused while the dead agy\'s copy stayed: "no lane copy could be made … still in use")', () => [
      a && c && fo.length === 1 && reused.length === 1 && !refused.length && norm(c.cwd) === norm(a.cwd) && /[\\/]\.lanes[\\/]builder-agyf1$/.test(c.cwd) && c.marker === true && c.reusedNote === true && /^lane\/builder-agyf1-/.test(c.branch)
        && !fs.existsSync(path.join(S, '.lanes', 'builder-agyf1')),
      JSON.stringify({ status: s1.status, a: a && { cwd: a.cwd }, c, fo: fo.length, reused: reused.length, refused: refused.map((e) => e.msg), out: out(s1).slice(-800) }).slice(0, 3000)]);
  }

  // ---- the agy CLI reviewer ----
  {
    const { S, env } = studio('review');
    const r = probe(S, env, `const rv = await import(${u(S, 'harness/review.mjs')});
const calls = [];
const runFake = (file, args, opts) => { calls.push({ file, args, input: opts.input ? String(opts.input).slice(0, 40) : null }); return { status: 0, stdout: 'VERDICT: approve', stderr: '' }; };
const fakeRun = (file, args, opts) => (file === 'which' || file === 'where' ? { status: 0, stdout: '/bin/' + args[0] } : runFake(file, args, opts));
const g = { builder: 'claude-opus-5-5' };
process.env.STUDIO_REVIEW_TOOLS = 'agy';
const res = await rv.cliReview(g, [{ role: 'system', content: 'Review it' }, { role: 'user', content: 'the diff' }], { run: fakeRun });
console.log(JSON.stringify({ res: { ok: res.ok, model: res.model, tool: res.tool }, call: calls[0], pickClaude: rv.reviewerTools('claude-opus-5-5', {}).map((t) => t.tool), pickGemini: rv.reviewerTools('gemini-4-argon-high', {}).map((t) => t.tool) }));`);
    await guard('2.78.1 (Gemini as the cross-family reviewer): the picker offers agy for a Claude implementer and claude for a Gemini one; the agy reviewer runs `agy --print-timeout 900s --model <a Gemini model>` with the review on stdin (no -p argument, no --mode) and its review is recorded under that Gemini model (fails on 2.78.0: `agy -p <review> --print-timeout 900s` with no model: agy ran its own default, a Claude model, recorded as "gemini")', () => [
      r.res?.ok === true && r.res.tool === 'agy' && r.res.model === 'gemini-4-argon-high' && r.call?.file === 'agy' && JSON.stringify(r.call.args) === JSON.stringify(['--print-timeout', '900s', '--model', 'gemini-4-argon-high']) && /Review it/.test(r.call.input || '')
        && r.pickClaude?.includes('agy') && !r.pickClaude.includes('claude') && r.pickGemini?.includes('claude') && !r.pickGemini.includes('agy'),
      JSON.stringify(r).slice(0, 2000)]);
  }

  for (const S of made) { try { g(S, 'worktree', 'prune'); fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  for (const d of [bin, recDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}
