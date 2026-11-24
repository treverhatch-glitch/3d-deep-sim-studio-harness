/**
 * qa/selftest-298f.mjs — 2.98 (d): a quota mark needs evidence (a session that reached the model, or a second stop
 * within 15 minutes), its window is never more than the text says, and the status lines name what is out and what is
 * only suspected. agy on an engine worktree gets write rules for its two folders and read-only git verbs there, and
 * nothing wider. `--pool api --task <engine task>` starts an engine porter; `--role` still wins.
 * Stand-in claude and agy record what they were given; a real agy was not run (its rule match is modelled here).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fileUrlOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, npmShim, out, readAgentRec, writeIn as write } from './kit.mjs';

export async function selftest298F({ dir, report, tmpRoot }) {
  const WIN = process.platform === 'win32';
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298f-${process.pid}`);
  const clean = {};
  // Windows: the launcher and git need Windows' own system variables, which any real shell has; passed through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const home = path.join(T, 'home');
  const bin = path.join(T, 'bin');
  const recDir = path.join(T, 'rec');
  fs.mkdirSync(recDir, { recursive: true });
  const base = {
    ...clean, ...ident, HOME: home, USERPROFILE: home, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_QUOTA_PROBE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_IDLE_EXIT_MIN: '0',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_AGY_STREAM: '0', STUDIO_LANE_LIVE_MIN: '0', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_DRIFT: 'off', STUDIO_LANE_INFER: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_ENGINE_LANE_REQUIRED: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', TZ: 'UTC',
    STUDIO_API_POOL: 'builder-api2,builder-api3', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_BUILDER_API3: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', ANTHROPIC_API_KEY_LANE: 'sk-test-298f-not-a-key',
  };

  // ---- a studio copy with a made-up engine repo and engine-porter tasks on the board ----
  const S = path.join(T, 'studio');
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch { /* not needed here */ } }
  const R = path.join(T, 'engine repo');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main'); g(R, 'config', 'core.autocrlf', 'false');
  write(R, 'Rules/a.txt', 'a\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: R.split(path.sep).join('/') } } }, null, 2)}\n`);
  const board = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').replace('## BACKLOG\n', `## BACKLOG\n${[31, 32, 33].map((n) => `- [ ] **T-${n}** [P2] (\`engine-porter\`) — Port rule ${n}\n`).join('')}`);
  fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), board);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298f.jsonl');
  write(S, '.studio/events-298f.jsonl', '');
  write(S, '.studio/agy-settings.json', `${JSON.stringify({ permissions: { allow: ['command(node)'] } }, null, 2)}\n`);

  // ---- stand-in claude and agy: record argv, the settings file and cwd, drain stdin, exit 0 ----
  const fake = (name) => `const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const i = argv.indexOf('--settings');
let settings = null;
if (i >= 0) { try { settings = JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), 'utf8')); } catch (e) { settings = { error: String(e.message) }; } }
fs.appendFileSync(path.join(${JSON.stringify(recDir)}, '${name}-' + (process.env.STUDIO_LOCK_OWNER || 'nobody') + '.jsonl'), JSON.stringify({ argv, settings, cwd: process.cwd() }) + '\\n');
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
  const node = (args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(extra), timeout: 180000 });
  const u = fileUrlOf(S);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-298f-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = node([f], extra);
    try { fs.rmSync(f, { force: true }); } catch { /* swept with the folder */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const fwdp = (p) => String(p).split(path.sep).join('/');
  const quotaFile = path.join(S, '.studio', 'tool-quota.json');
  const H = 3600000;

  try {
    // ================= (f1) a limit line from a session that never reached the model =================
    const epoch = Math.floor((Date.now() + 4 * 86400000) / 1000);
    const zero = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, duration_ms: 140, duration_api_ms: 0, num_turns: 1, result: `Claude AI usage limit reached|${epoch}`, stop_reason: 'stop_sequence', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    const real = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, duration_ms: 90000, duration_api_ms: 61000, num_turns: 9, result: `usage limit reached|${epoch}`, usage: { input_tokens: 1200, output_tokens: 800 } });
    const f1 = probe(`import fs from 'node:fs';
import { cleanUp } from ${u('harness/agent.mjs')};
import * as B from ${u('harness/budget.mjs')};
const { exhaustedUntil, budgetStopFor, markExhausted } = B;
const reachedModel = (l) => (B.reachedModel ? B.reachedModel(l) : 'none');
fs.mkdirSync('.studio/agents', { recursive: true });
const q = () => { try { return JSON.parse(fs.readFileSync('.studio/tool-quota.json', 'utf8')); } catch { return {}; } };
fs.rmSync('.studio/tool-quota.json', { force: true });
cleanUp('builder-z1', { code: 1, log: ${JSON.stringify(zero)}, role: 'builder', tool: 'claude', model: 'model-z' });
const first = { mark: q().claude || null, out: exhaustedUntil('claude'), stop: budgetStopFor({ tool: 'claude' }).stopped };
cleanUp('builder-z2', { code: 1, log: ${JSON.stringify(zero)}, role: 'builder', tool: 'claude', model: 'model-z' });
const second = { mark: q().claude || null, out: exhaustedUntil('claude'), stop: budgetStopFor({ tool: 'claude' }).stopped };
// A suspicion older than 15 minutes is not confirmed by a new one: suspected again.
const old = q(); old.codex = { suspected: true, at: new Date(Date.now() - 16 * 60000).toISOString(), line: 'usage limit reached', version: 'x' }; fs.writeFileSync('.studio/tool-quota.json', JSON.stringify(old));
markExhausted('codex', 'usage limit reached', Date.now(), { reached: false });
const late = { mark: q().codex, out: exhaustedUntil('codex') };
// A session that reached the model is believed at once.
cleanUp('builder-z3', { code: 1, log: ${JSON.stringify(real)}, role: 'builder', tool: 'grok', model: 'model-g' });
const ev = fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.session.end' && e.agent === 'builder-z1').pop();
console.log(JSON.stringify({ first, second, late, grok: exhaustedUntil('grok'), reached: [reachedModel(${JSON.stringify(zero)}), reachedModel(${JSON.stringify(real)}), reachedModel('5-hour limit reached')], end: ev ? { msg: ev.msg, usageLimit: ev.meta?.usageLimit } : null }));
`);
    await guard('2.98 (f1) quota: a limit line from a session whose usage was all zero (duration_api_ms 0, stop_sequence) is kept as suspected, not obeyed: the tool is not out and a launch on it is not stopped, and the session end says so; a second such stop on the same tool within 15 minutes marks it out (until the text\'s own reset time); one 16 minutes later is suspected again; a session that reached the model is believed at once (fails before this fix: the first zero-usage line marked the tool out at once, for four days)', () => [
      f1.first?.mark?.suspected === true && !f1.first.out && f1.first.stop === false && /suspected/.test(f1.end?.msg || '') && f1.end?.usageLimit?.suspected === true
        && !f1.second?.mark?.suspected && f1.second.out === new Date(epoch * 1000).toISOString() && f1.second.stop === true && /second start failed the same way within 15 minutes/.test(f1.second.mark?.confirmed || '')
        && f1.late?.mark?.suspected === true && !f1.late.out && Boolean(f1.grok)
        && JSON.stringify(f1.reached) === JSON.stringify([false, true, null]),
      JSON.stringify(f1).slice(0, 3000)]);

    // ================= (f2) the window: the text's reset, else 5 hours, weekly only when the text says so =================
    const f2 = probe(`import { markExhausted } from ${u('harness/budget.mjs')};
const now = Date.now();
const h = (m) => (Date.parse(m.until) - now) / ${H};
console.log(JSON.stringify({ plain: h(markExhausted('t1', 'usage limit reached', now)), weekly: h(markExhausted('t2', 'Weekly limit reached', now)), dated: h(markExhausted('t3', 'usage limit reached until Dec 3rd (no time)', now)), own: h(markExhausted('t4', '5-hour limit reached ∙ resets in 2h', now)), w1: markExhausted('t5', 'usage limit reached', now).window }));
`);
    await guard('2.98 (f2) quota: a limit line with no reset time holds for the 5-hour window, one that says "weekly" or names a date for the weekly one, and one with its own reset time for exactly that (fails before this fix: 1 h for any line without a reset time)', () => [
      Math.abs(f2.plain - 5) < 0.01 && Math.abs(f2.weekly - 168) < 0.01 && Math.abs(f2.dated - 168) < 0.01 && Math.abs(f2.own - 2) < 0.01 && /5-hour/.test(f2.w1 || ''),
      JSON.stringify(f2)]);

    // ================= (f3) the status lines =================
    const f3 = probe(`import fs from 'node:fs';
import * as B from ${u('harness/budget.mjs')};
const { markExhausted } = B;
const quotaLine = () => (B.quotaLine ? B.quotaLine() : null);
import { briefFacts, briefText } from ${u('harness/brief-status.mjs')};
fs.writeFileSync('.studio/tool-quota.json', '{}');
markExhausted('claude', 'Weekly limit reached ∙ resets Mon 9am');
markExhausted('agy', 'usage limit reached', Date.now(), { reached: false });
const f = await briefFacts({ now: Date.now() });
console.log(JSON.stringify({ line: quotaLine(), brief: briefText(f) }));
`);
    const cli = node(['harness/budget.mjs']);
    await guard('2.98 (f3) quota: `npm run budget` names the tool marked out, until when and the line it came from, and the tool only suspected; the brief status line (Studio Status) lists both under Blockers (fails before this fix: neither said what was suspected, and the brief named no quota mark)', () => [
      /Quota: claude out until \d\d-\d\d \d\d:\d\d UTC from "Weekly limit reached ∙ resets Mon 9am"; agy suspected, not obeyed from "usage limit reached"/.test(out(cli))
        && /Blockers: .*Quota: claude out until \d\d-\d\d \d\d:\d\d UTC; agy suspected, not obeyed/.test(f3.brief || '') && f3.line === (out(cli).match(/Quota: .*/) || [])[0],
      JSON.stringify({ f3, cli: out(cli).slice(-800) })]);
    fs.rmSync(quotaFile, { force: true });

    // ================= (f4) agy on an engine worktree: write in its folders, read with git, nothing wider =================
    // A model of agy's match: action(glob) for files (** any depth, * one folder, / and \ alike, drive letter in any case);
    // command(words) a word prefix; command(regex:...) the whole command.
    const norm = (p) => String(p).replace(/\\/g, '/').replace(/^([a-z]):/i, (m, d) => `${d.toLowerCase()}:`);
    const globRe = (glob) => new RegExp(`^${norm(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
    const allows = (rules, action, target) => rules.some((r) => {
      const m = /^(\w+)\(([\s\S]+)\)$/.exec(r);
      if (r === action) return true;
      if (!m || m[1] !== action) return false;
      if (action !== 'command') return globRe(m[2]).test(norm(target));
      return m[2].startsWith('regex:') ? new RegExp(m[2].slice(6)).test(target) : target === m[2] || target.startsWith(`${m[2]} `);
    });
    const a4 = node(['harness/agent.mjs', 'start', '--attach', '--role', 'engine-porter', '--agent', 'porter-agy1', '--task', 'T-31', '--tool', 'agy', '--model', 'gemini-x-high']);
    const r4 = readAgentRec(S, 'porter-agy1');
    const run4 = runs('agy', 'porter-agy1').find((x) => x.settings);
    const allow = run4?.settings?.permissions?.allow || [];
    const eng = fwdp(path.join(S, '.lanes', 'engine', 'T-31'));
    const lane = r4?.copy?.dir ? fwdp(path.join(S, r4.copy.dir)) : '';
    const writes = allow.filter((x) => /^write_file\(/.test(x));
    const wantW = [eng, `${eng}/**`, lane, `${lane}/**`].map((d) => `write_file(${d})`).sort();
    const git = (rest) => `git -C ${eng} ${rest}`;
    const yes = ['show HEAD:Rules/a.txt', 'rev-parse HEAD', 'merge-base HEAD port/main', 'ls-files Rules', 'grep -n Fees -- Rules', 'status', 'log --oneline -5'].map(git);
    const no = [...['push', 'push origin HEAD', 'reset --hard', 'checkout other', 'switch other', 'clean -fdx', 'rebase main', 'grep -O vim x', 'grep -nOvim x', 'grep --open-files-in-pager=vim x', 'grep --op=vim x', 'show --output=/tmp/x HEAD', 'grep --no-index x /', 'grep x *', 'grep "-Ovim" x', 'grep \\-Ovim x', 'show HEAD > /tmp/x', 'show a,-Ovim', 'show $(id)'].map(git), `git -C ${fwdp(path.join(S, '.lanes', 'engine', 'T-99'))} show HEAD`, `git -C ${fwdp(S)} show HEAD`];
    const wrongYes = yes.filter((c) => !allows(allow, 'command', c));
    const wrongNo = no.filter((c) => allows(allow, 'command', c));
    const outside = [fwdp(path.join(S, 'studio', 'NEXT.md')), fwdp(path.join(S, '.studio', 'agy-settings.json')), fwdp(path.join(S, '.lanes', 'engine', 'T-99', 'a.txt')), fwdp(path.join(S, 'harness', 'x.mjs'))].filter((p) => allows(writes, 'write_file', p));
    // Templates that name a path of their own, or write outside {own}, give no rule.
    const t4 = probe(`import { agyReachRules } from ${u('harness/agy-allow.mjs')};
const w = 'C:\\\\Users\\\\Dev Name\\\\st\\\\.lanes\\\\engine\\\\T-22';
const d = agyReachRules({ dirs: ['C:/Users/Dev Name/st/studio', 'C:/Users/Dev Name/st/.studio', w], engineDir: w, laneDir: 'C:/Users/Dev Name/st/.lanes/porter-b', env: {} });
const bad = agyReachRules({ dirs: ['/s/studio', '/s/e'], engineDir: '/s/e', laneDir: '/s/l', env: { STUDIO_AGY_REACH_RULES: JSON.stringify(['write_file({dir}/**)', 'write_file({engine})', 'write_file(C:/x/{own})', 'read_file({own}/../..)', 'read_file(/etc/{dir})', 'write_file({own})']) } });
const paren = agyReachRules({ dirs: ['/s/a(b)'], engineDir: '/s/a(b)', laneDir: '/s/l(1)', env: {} });
console.log(JSON.stringify({ win: d.rules.filter((r) => r.startsWith('write_file')), bad: bad.rules, paren: paren.rules }));
`);
    await guard('2.98 (f4) agy: an engine porter on agy gets write_file rules for exactly its lane copy and its engine worktree (folder and **), none for studio/, .studio/, another lane or the studio; git show, rev-parse, merge-base, ls-files and grep are allowed on its engine worktree while push, reset, checkout, switch, clean, rebase, grep -O / --open-files-in-pager / --no-index, show --output, a glob, a quote, a redirect, a comma or $( ) are not, nor any verb on another folder; templates that name their own path or write outside {own} give no rule, and a folder with a parenthesis gets none (fails before this fix: no write rule, and git show on the worktree was refused)', () => [
      a4.status === 0 && Boolean(lane) && JSON.stringify(writes.slice().sort()) === JSON.stringify(wantW) && !wrongYes.length && !wrongNo.length && !outside.length
        && JSON.stringify(t4.win) === JSON.stringify(['write_file(C:/Users/Dev Name/st/.lanes/porter-b)', 'write_file(C:/Users/Dev Name/st/.lanes/engine/T-22)', 'write_file(C:/Users/Dev Name/st/.lanes/porter-b/**)', 'write_file(C:/Users/Dev Name/st/.lanes/engine/T-22/**)'])
        && JSON.stringify(t4.bad) === JSON.stringify(['write_file(/s/l)', 'write_file(/s/e)']) && Array.isArray(t4.paren) && t4.paren.length === 0,
      JSON.stringify({ status: a4.status, out: out(a4).slice(-400), lane, writes, wrongYes, wrongNo, outside, t4 }).slice(0, 3000)]);

    // ================= (f5) --pool api --task <engine task>, no --role =================
    const a5 = node(['harness/agent.mjs', 'start', '--attach', '--pool', 'api', '--task', 'T-32', '--tool', 'claude', '--model', 'claude-opus-5-5']);
    const n5 = (out(a5).match(/API pool: (builder-api\d)/) || [])[1] || '';
    const r5 = readAgentRec(S, n5);
    const add5 = (runs('claude', n5).pop()?.argv || []).flatMap((a, i, all) => (all[i - 1] === '--add-dir' ? [fwdp(a)] : []));
    const eng5 = fwdp(path.join(S, '.lanes', 'engine', 'T-32'));
    await guard('2.98 (f5) pool: `agent start --pool api --task T-32` (an engine-porter task) with no --role starts an engine porter, says so in its start line, and the session gets its engine worktree (made in the engine repo, passed with --add-dir) (fails before this fix: it started as a builder, with no engine worktree)', () => [
      a5.status === 0 && r5?.role === 'engine-porter' && /API pool: builder-api\d starts as engine-porter on T-32 \(T-32 is an engine-porter task on the board\): it works in its engine worktree/.test(out(a5))
        && fs.existsSync(path.join(S, '.lanes', 'engine', 'T-32', 'Rules', 'a.txt')) && add5.includes(eng5),
      JSON.stringify({ status: a5.status, out: out(a5).slice(-600), role: r5?.role, add5 }).slice(0, 3000)]);

    // ================= (f6) --role still wins =================
    const a6 = node(['harness/agent.mjs', 'start', '--attach', '--pool', 'api', '--role', 'builder', '--task', 'T-33', '--tool', 'claude', '--model', 'claude-opus-5-5']);
    const n6 = (out(a6).match(/API pool: (builder-api\d)/) || [])[1] || '';
    const r6 = readAgentRec(S, n6);
    await guard('2.98 (f6) pool: `--pool api --role builder --task T-33` starts a builder as asked, on an engine-porter task, with no engine worktree made (fails before this fix: not shown; the role picked from the task must not override --role)', () => [
      a6.status === 0 && r6?.role === 'builder' && /starts as builder on T-33 \(--role given\)/.test(out(a6)) && !fs.existsSync(path.join(S, '.lanes', 'engine', 'T-33')),
      JSON.stringify({ status: a6.status, out: out(a6).slice(-600), role: r6?.role })]);
  } finally {
    for (const p of [S, T]) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ } }
  }
}
