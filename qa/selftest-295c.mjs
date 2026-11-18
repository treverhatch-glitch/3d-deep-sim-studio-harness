/**
 * qa/selftest-295c.mjs — 2.95 (c): an engine porter started from the API pool, and one on agy, each reach their engine
 * lane and make a first file there (stand-in claude and agy on PATH); `agent list` says why a start died.
 * The studio sits under a folder with a space in its name. The agy rule check is a small model of agy's allow-rule
 * match (action or action(target), * and ** globs, / and \ alike, drive letters in any case); a real agy was not run.
 * Stand-ins record what they were given; no key value is ever shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { eventsOf as eventsFileOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, napSync, npmShim, out, readAgentRec, writeIn as write } from './kit.mjs';

export async function selftest295C({ dir, report, tmpRoot }) {
  const WIN = process.platform === 'win32';
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s295c-${process.pid}`);
  const SECRET = 'sk-test-295c-never-shown-0000';
  const clean = {};
  // Windows: the launcher and git need Windows' own system variables, which any real shell has; passed through as they are, as in 294a.
  if (WIN) for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const home = path.join(T, 'home dir');
  write(home, '.gemini/antigravity-cli/settings.json', `${JSON.stringify({ permissions: { allow: ['command(node)'] } })}\n`);
  const bin = path.join(T, 'bin');
  const recDir = path.join(T, 'rec');
  fs.mkdirSync(recDir, { recursive: true });
  const base = {
    ...clean, ...ident, HOME: home, USERPROFILE: home, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_QUOTA_PROBE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_IDLE_EXIT_MIN: '0',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_AGY_STREAM: '0', STUDIO_LANE_LIVE_MIN: '0', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_DRIFT: 'off', STUDIO_LANE_INFER: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_ENGINE_LANE_REQUIRED: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-295c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_API_POOL: 'builder-api2,builder-api3', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_BUILDER_API3: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', ANTHROPIC_API_KEY_LANE: SECRET,
  };

  // ---- a studio copy (under a folder with a space) with an engine repo and engine-porter tasks ----
  const S = path.join(T, 'my studio');
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch { /* not needed here */ } }
  const R = path.join(T, 'engine repo');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main'); g(R, 'config', 'core.autocrlf', 'false');
  write(R, 'Rules/a.txt', 'a\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: R.split(path.sep).join('/') } } }, null, 2)}\n`);
  const board = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').replace('## BACKLOG\n', `## BACKLOG\n${[21, 22, 23, 24].map((n) => `- [ ] **T-${n}** [P2] (\`engine-porter\`) — Port rule ${n}\n`).join('')}`);
  fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), board);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-295c.jsonl');
  write(S, '.studio/events-295c.jsonl', '');
  const events = eventsFileOf(evFile);
  const imp = (rel) => import(pathToFileURL(path.join(S, rel)).href);
  // The studio's agy settings, as `agent allow agy` writes them (the approved commands and the file-write rule).
  const { agyRules, agyReachRules } = await imp('harness/agy-allow.mjs');
  write(S, '.studio/agy-settings.json', `${JSON.stringify({ permissions: { allow: agyRules() } }, null, 2)}\n`);

  // ---- the stand-in claude and agy: record argv, settings and cwd; if <rec>/<agent>.say exists print it and stop;
  // else make the first tool call a real porter makes: write a file in the engine lane it was given (an --add-dir
  // folder, or a read_file(<folder>) rule), then drain stdin and exit ----
  const fake = (name) => `// The stand-in ${name} (qa/selftest-295c.mjs).
const fs = require('fs');
const path = require('path');
const REC = ${JSON.stringify(recDir)};
const who = process.env.STUDIO_LOCK_OWNER || 'nobody';
const argv = process.argv.slice(2);
const i = argv.indexOf('--settings');
let settings = null;
if (i >= 0) { try { settings = JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), 'utf8')); } catch (e) { settings = { error: String(e.message) }; } }
const given = argv.flatMap((a, k) => (argv[k - 1] === '--add-dir' ? [a] : []));
for (const r of (settings && settings.permissions && settings.permissions.allow) || []) { const m = /^read_file\\((.+)\\)$/.exec(r); if (m && !m[1].endsWith('/**')) given.push(m[1]); }
const lane = given.find((d) => /[\\\\/]\\.lanes[\\\\/]engine[\\\\/]/.test(d)) || null;
const say = path.join(REC, who + '.say');
let wrote = null;
if (fs.existsSync(say)) process.stdout.write(fs.readFileSync(say, 'utf8') + '\\n');
else if (lane) { fs.writeFileSync(path.join(lane, 'first-call-${name}.txt'), 'made by the stand-in ${name}\\n'); wrote = path.join(lane, 'first-call-${name}.txt'); }
fs.appendFileSync(path.join(REC, '${name}-' + who + '.jsonl'), JSON.stringify({ argv, settings, cwd: process.cwd(), lane, wrote }) + '\\n');
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;
  for (const name of ['claude', 'agy']) {
    if (WIN) {
      fs.mkdirSync(path.join(bin, 'node_modules', `fake-${name}`), { recursive: true });
      fs.writeFileSync(path.join(bin, 'node_modules', `fake-${name}`, 'cli.js'), fake(name));
      fs.writeFileSync(path.join(bin, `${name}.cmd`), npmShim(`fake-${name}`));
    } else {
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${fake(name)}`);
      fs.chmodSync(path.join(bin, name), 0o755);
    }
  }
  const runs = (tool, who) => { try { return fs.readFileSync(path.join(recDir, `${tool}-${who}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const childEnv = (extra = {}) => {
    const e = { ...process.env, ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: '', ...extra };
    const keys = Object.keys(e).filter((k) => k.toUpperCase() === 'PATH');
    const was = keys.map((k) => e[k]).find(Boolean) || '';
    for (const k of keys) delete e[k];
    e.PATH = `${bin}${path.delimiter}${was}`;
    return e;
  };
  const outputs = [];
  const agent = (args, extra = {}) => { const r = spawnSync(process.execPath, ['harness/agent.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(extra), timeout: 180000 }); outputs.push(out(r)); return r; };
  const rec = (a) => readAgentRec(S, a);
  const until = (fn, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; napSync(100); } return false; };
  const ended = (a) => until(() => rec(a)?.status === 'ended');
  const fwdp = (p) => String(p).split(path.sep).join('/');
  const engineDir = (t) => fwdp(path.join(S, '.lanes', 'engine', t));
  const sameDir = (a, b) => { try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; } };
  // The lane is a worktree of the engine repo: its common git folder is the engine repo's own.
  const inEngineRepo = (lane) => { const r = spawnSync('git', ['-C', lane, 'rev-parse', '--git-common-dir'], { windowsHide: true, encoding: 'utf8' }); return r.status === 0 && sameDir(path.resolve(lane, String(r.stdout).trim()), path.join(R, '.git')); };
  const claudeOpus = ['--tool', 'claude', '--model', 'claude-opus-5-5'];
  const gem = ['--tool', 'agy', '--model', 'gemini-x-high'];

  // A small model of agy's allow-rule match: `action` allows any target; `action(glob)` allows a target the glob
  // matches (** any depth, * inside one folder); / and \ alike; a drive letter in any case. Regex rules are skipped.
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/^([a-z]):/i, (m, d) => `${d.toLowerCase()}:`);
  const globRe = (glob) => new RegExp(`^${norm(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
  const agyAllows = (allow, action, target) => allow.some((r) => { if (r === action) return true; const m = /^(\w+)\(([\s\S]+)\)$/.exec(r); return Boolean(m) && m[1] === action && !m[2].startsWith('regex:') && globRe(m[2]).test(norm(target)); });

  // ================= (a) the API pool: --pool api --role engine-porter =================
  const a1 = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-21', ...claudeOpus]);
  ended('builder-api2');
  {
    const r = rec('builder-api2');
    const run = runs('claude', 'builder-api2').pop();
    const argv = run?.argv || [];
    const eng = engineDir('T-21');
    const added = argv.flatMap((a, i) => (argv[i - 1] === '--add-dir' ? [fwdp(a)] : []));
    const file = path.join(S, '.lanes', 'engine', 'T-21', 'first-call-claude.txt');
    await guard('2.95 (c1) pool: `--pool api --role engine-porter --task T-21` on an engine lane (studio path with a space) makes the lane in the engine repo, records role engine-porter, tool claude and the key NAME ANTHROPIC_API_KEY_LANE (never its value), launches claude with the lane as --add-dir, acceptEdits and git -C <lane> add/commit allowed, and the stand-in\'s first file is in the lane (fails before this fix: nothing proved this start on an engine lane end to end)', () => [
      a1.status === 0 && r?.role === 'engine-porter' && r.tool === 'claude' && (r.keys || []).includes('ANTHROPIC_API_KEY_LANE') && !JSON.stringify(r).includes(SECRET)
        && inEngineRepo(path.join(S, '.lanes', 'engine', 'T-21')) && events().some((e) => e.type === 'engine.lane' && e.agent === 'builder-api2' && sameDir(e.meta?.repo, R))
        && added.includes(eng) && (r.reach || []).includes(eng) && argv.includes('acceptEdits') && ['add', 'commit'].every((v) => argv.includes(`Bash(git -C ${eng} ${v})`))
        && fs.existsSync(file) && fwdp(run.wrote) === fwdp(file),
      JSON.stringify({ status: a1.status, out: out(a1).slice(-300), rec: r && { role: r.role, tool: r.tool, keys: r.keys, reason: r.reason, reach: r.reach }, added, wrote: run?.wrote, file: fs.existsSync(file) })]);
  }

  // ================= (b) agy: --tool agy --role engine-porter =================
  const b1 = agent(['start', '--attach', '--role', 'engine-porter', '--agent', 'porter-agy1', '--task', 'T-22', ...gem]);
  {
    const r = rec('porter-agy1');
    const run = runs('agy', 'porter-agy1').find((x) => x.argv.includes('--settings'));
    const allow = run?.settings?.permissions?.allow || [];
    const eng = engineDir('T-22');
    const file = path.join(S, '.lanes', 'engine', 'T-22', 'first-call-agy.txt');
    const target = `${eng}/first-call-agy.txt`;
    const sub = `${eng}/Rules/a.txt`;
    const outside = fwdp(path.join(S, '.lanes', 'engine', 'T-99', 'x.txt'));
    await guard('2.95 (c2) agy: `--tool agy --role engine-porter --task T-22` on an engine lane (studio path with a space) makes the lane in the engine repo, records role engine-porter and tool agy, launches agy with a session settings file whose allow-rules let it write and read a file in the lane (not another lane), and the stand-in\'s first file is in the lane (fails before this fix: nothing proved this start on an engine lane end to end)', () => [
      b1.status === 0 && r?.role === 'engine-porter' && r.tool === 'agy' && inEngineRepo(path.join(S, '.lanes', 'engine', 'T-22'))
        && agyAllows(allow, 'write_file', target) && agyAllows(allow, 'read_file', target) && agyAllows(allow, 'read_file', sub) && !agyAllows(allow, 'read_file', outside)
        && fs.existsSync(file) && fwdp(run.wrote) === fwdp(file),
      JSON.stringify({ status: b1.status, out: out(b1).slice(-300), rec: r && { role: r.role, tool: r.tool, reason: r.reason, reach: r.reach }, allow: allow.filter((x) => /read_file|write_file/.test(x)), wrote: run?.wrote, file: fs.existsSync(file) })]);
  }

  // ================= agy rules on Windows paths (a made-up Windows studio, checked on every OS) =================
  {
    const wl = 'C:\\Users\\Dev Name\\my studio\\.lanes\\engine\\T-22';
    const wd = ['C:\\Users\\Dev Name\\my studio\\studio', 'C:\\Users\\Dev Name\\my studio\\.studio', wl];
    const allow = [...agyRules(), ...agyReachRules({ dirs: wd, engineDir: wl, env: {} }).rules];
    const ok = [`${wl}\\Rules\\a.txt`, `${wl}/Rules/a.txt`, `c:\\Users\\Dev Name\\my studio\\.lanes\\engine\\T-22\\new.txt`].every((p) => agyAllows(allow, 'write_file', p) && agyAllows(allow, 'read_file', p));
    const no = ['C:\\Users\\Dev Name\\my studio\\.lanes\\engine\\T-99\\a.txt', 'D:\\other\\a.txt'].every((p) => !agyAllows(allow, 'read_file', p));
    await guard('2.95 (c3) agy: for a Windows studio path with a space (C:\\Users\\Dev Name\\my studio) the allow-rules the launch builds let agy write and read a file in the engine lane with \\ or / and any drive-letter case, and read nothing in another lane or drive (fails before this fix: Windows paths were not checked)', () => [
      ok && no && allow.includes('read_file(C:/Users/Dev Name/my studio/.lanes/engine/T-22/**)'), JSON.stringify({ ok, no, rules: allow.filter((x) => /read_file/.test(x)) })]);
  }

  // ================= agent list: a normal ended session =================
  const normalRec = rec('porter-agy1');
  // A start that dies: agy refuses at once with a permission line (an ended record with a reason), and a launcher that refuses (a refusal).
  fs.writeFileSync(path.join(recDir, 'porter-agy2.say'), 'no output produced — one or more tools required the "read_file", "command" permissions that headless mode cannot prompt for, so they were auto-denied. Add an allow-rule under permissions.allow in settings.json');
  agent(['start', '--attach', '--role', 'engine-porter', '--agent', 'porter-agy2', '--task', 'T-23', ...gem]);
  const deniedRec = rec('porter-agy2');
  napSync(1100);
  const refused = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-24', '--tool', 'aider', '--model', 'qwen'], { STUDIO_AIDER_CMD: path.join(T, 'no-such-aider') });
  ended('builder-api2');
  const refusedRec = rec('builder-api2');
  const list = agent(['list']);
  const listJson = agent(['list', '--json']);
  {
    const lines = String(list.stdout).split('\n');
    const lineOf = (name) => lines.findIndex((l) => l.startsWith('ended  ') && l.slice(9).startsWith(name));
    const iRef = lineOf('builder-api2');
    const iDen = lineOf('porter-agy2');
    const iOk = lineOf('porter-agy1');
    const cut = (s) => String(s).replace(/\s+/g, ' ').slice(0, 160);
    const old = (s) => `ended    ${s.agent.padEnd(18)} ${String(s.role).padEnd(14)} ${s.tool}/${s.model}${s.task ? `  ${s.task}` : ''}  ${s.reason || ''}`;
    let j = [];
    try { j = JSON.parse(listJson.stdout); } catch { j = []; }
    const jRef = j.find((x) => x.agent === 'builder-api2');
    const jDen = j.find((x) => x.agent === 'porter-agy2');
    await guard('2.95 (c4) agent list: a start that died shows why on its line, cut to 160 characters, latest end first (the launcher\'s refusal "not started: …aider…" for builder-api2, then agy\'s denial reason for porter-agy2, then the normal porter-agy1 whose line is exactly as before), and --json carries both reason and refusal in full (fails before this fix: the line held the whole reason, any length, in file-name order, and there was no --json)', () => [
      refused.status === 0 && /^not started: .*aider/.test(refusedRec?.refusal || '') && /agy could not use its tools/.test(deniedRec?.reason || '') && !deniedRec.refusal
        && iRef >= 0 && iDen > iRef && iOk > iDen
        && lines[iRef].endsWith(`  ${cut(refusedRec.refusal)}`) && /not started: .*aider/.test(lines[iRef])
        && lines[iDen].endsWith(`  ${cut(deniedRec.reason)}`) && /agy could not use its tools/.test(lines[iDen]) && deniedRec.reason.length > 160 && lines[iDen].length < old(deniedRec).length
        && lines[iOk] === old(normalRec) && normalRec.reason.length <= 160
        && listJson.status === 0 && jRef?.refusal === refusedRec.refusal && jRef.reason === refusedRec.reason && jDen?.reason === deniedRec.reason && jDen.refusal === null,
      JSON.stringify({ iRef, iDen, iOk, st: [refused.status, listJson.status], lines: lines.slice(0, 6).map((l) => l.slice(0, 90)), refusal: String(refusedRec?.refusal).slice(0, 60), denied: String(deniedRec?.reason).slice(0, 60), normal: normalRec?.reason, json: j.map((x) => [x.agent, x.refusal && x.refusal.slice(0, 40)]) }).slice(0, 2500)]);
  }

  // ================= no key anywhere =================
  {
    const hits = [];
    const scan = (d) => { let items = []; try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of items) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else { try { if (fs.readFileSync(p, 'utf8').includes(SECRET)) hits.push(fwdp(path.relative(T, p))); } catch { /* unreadable */ } } } };
    scan(path.join(S, '.studio'));
    scan(recDir);
    outputs.forEach((o, i) => { if (o.includes(SECRET)) hits.push(`output ${i}`); });
    await guard('2.95 (c5): no key value appears in any output, record, log, settings file or event of these checks (fails before this fix: guards it)', () => [outputs.length >= 6 && hits.length === 0, JSON.stringify({ n: outputs.length, hits })]);
  }

  for (const p of [S, T]) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ } }
}
