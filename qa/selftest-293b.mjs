/**
 * qa/selftest-293b.mjs — 2.93 (b): what a session may reach, and why one could not start.
 *   pool   `agent start --pool api --role engine-porter` records that role, gets the engine worktree and its add-dirs,
 *          bills the pool name's key; two starts take two names; all names busy is a plain refusal.
 *   record a detached start that cannot launch (a refusal, a crash) leaves its reason in the job record.
 *   agy    an engine porter on agy gets its own settings file with allow-rules for exactly its folders; a builder's
 *          launch is unchanged; agy's "auto-denied" ending is a hand-back reason that names the folders.
 * Stand-in claude and agy on PATH record what they were given. No key value appears in any output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { eventsOf as eventsFileOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, napSync, npmShim, out, readAgentRec, writeIn as write } from './kit.mjs';

export async function selftest293B({ dir, report, tmpRoot }) {
  const WIN = process.platform === 'win32';
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s293b-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const SECRET = 'sk-test-293b-never-shown-0000';
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const home = path.join(T, 'home');
  const userAgy = path.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  write(home, '.gemini/antigravity-cli/settings.json', `${JSON.stringify({ permissions: { allow: ['command(node)'] } })}\n`);
  const userAgyBefore = fs.readFileSync(userAgy, 'utf8');
  const bin = path.join(T, 'bin');
  const recDir = path.join(T, 'rec');
  fs.mkdirSync(recDir, { recursive: true });
  const base = {
    ...clean, ...ident, HOME: home, USERPROFILE: home, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_AUTO_FINISH: 'off', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_QUOTA_PROBE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_IDLE_EXIT_MIN: '0',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_AGY_STREAM: '0', STUDIO_LANE_LIVE_MIN: '0', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_DRIFT: 'off', STUDIO_LANE_INFER: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_ENGINE_LANE_REQUIRED: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-293b-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_API_POOL: 'builder-api2,builder-api3', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_BUILDER_API3: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', ANTHROPIC_API_KEY_LANE: SECRET,
  };

  // ---- a studio copy with an engine repo and three engine-porter tasks ----
  const S = path.join(T, 'studio');
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch { /* not needed here */ } }
  const R = path.join(T, 'repo');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main'); g(R, 'config', 'core.autocrlf', 'false');
  write(R, 'Rules/a.txt', 'a\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: R.split(path.sep).join('/') } } }, null, 2)}\n`);
  const board = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').replace('## BACKLOG\n', `## BACKLOG\n${[11, 12, 13, 14, 15].map((n) => `- [ ] **T-${n}** [P2] (\`engine-porter\`) — Port rule ${n}\n`).join('')}`);
  fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), board);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-293b.jsonl');
  write(S, '.studio/events-293b.jsonl', '');
  const events = eventsFileOf(evFile);

  // ---- stand-in claude and agy: each run appends { argv, settings } to <rec>/<tool>-<agent>.jsonl; agy prints
  // <rec>/<agent>.say when it exists; both stay up while <rec>/hold exists (at most 30 s) ----
  const fake = (name) => `// The stand-in ${name} (qa/selftest-293b.mjs).
const fs = require('fs');
const path = require('path');
const REC = ${JSON.stringify(recDir)};
const who = process.env.STUDIO_LOCK_OWNER || 'nobody';
const argv = process.argv.slice(2);
const i = argv.indexOf('--settings');
let settings = null;
if (i >= 0) { try { settings = JSON.parse(fs.readFileSync(path.resolve(argv[i + 1]), 'utf8')); } catch (e) { settings = { error: String(e.message) }; } }
fs.appendFileSync(path.join(REC, '${name}-' + who + '.jsonl'), JSON.stringify({ argv, settings }) + '\\n');
try { process.stdout.write(fs.readFileSync(path.join(REC, who + '.say'), 'utf8') + '\\n'); } catch {}
const t0 = Date.now();
const wait = () => (fs.existsSync(path.join(REC, 'hold')) && Date.now() - t0 < 30000 ? setTimeout(wait, 100) : process.exit(0));
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.on('end', wait);
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
  const runs = (tool, agent) => { try { return fs.readFileSync(path.join(recDir, `${tool}-${agent}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
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
  const fwdp = (p) => p.split(path.sep).join('/');
  const real = (p) => { try { return fwdp(fs.realpathSync.native(p)); } catch { return fwdp(p); } };
  const engineDir = (t) => fwdp(path.join(S, '.lanes', 'engine', t));
  const jobs = (a) => events().filter((e) => e.type === 'job.done' && e.agent === a);
  const claudeOpus = ['--tool', 'claude', '--model', 'claude-opus-5-5'];

  // ================= pool: an engine-porter on the API key =================
  const p1 = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-11', ...claudeOpus]);
  ended('builder-api2');
  {
    const r = rec('builder-api2');
    const argv = runs('claude', 'builder-api2').pop()?.argv || [];
    const added = argv.flatMap((a, i) => (argv[i - 1] === '--add-dir' ? [fwdp(a)] : []));
    const lane = events().find((e) => e.type === 'engine.lane' && e.agent === 'builder-api2');
    await guard('2.93 (b) pool: `agent start --pool api --role engine-porter --task T-11` starts builder-api2 recorded as engine-porter (billed to its mapped key, ANTHROPIC_API_KEY_LANE), makes the engine worktree .lanes/engine/T-11 and passes it and the main checkout\'s studio/ and .studio/ with --add-dir, as a plain engine-porter start does (fails before this fix: --pool api forced role builder, so no engine worktree and no engine add-dir)', () => [
      p1.status === 0 && r?.role === 'engine-porter' && (r.keys || []).includes('ANTHROPIC_API_KEY_LANE') && Boolean(lane) && fs.existsSync(path.join(S, '.lanes', 'engine', 'T-11'))
        && added.includes(engineDir('T-11')) && added.some((d) => d.endsWith('/studio')) && added.some((d) => d.endsWith('/.studio')) && (r.reach || []).includes(engineDir('T-11')),
      JSON.stringify({ status: p1.status, out: out(p1).slice(-400), role: r?.role, keys: r?.keys, reason: r?.reason, lane: Boolean(lane), added, reach: r?.reach })]);
  }

  // ================= pool: two starts take two names; all busy is refused =================
  {
    fs.writeFileSync(path.join(recDir, 'hold'), '');
    const a = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-12', ...claudeOpus]);
    // Watch builder-api2's record until its agent runs: it must never vanish or stop saying "running" on the way.
    const seen = [];
    until(() => { const x = rec('builder-api2'); const st = !x ? 'none' : x.status !== 'running' ? x.status : x.pid ? 'agent' : 'starting'; if (seen[seen.length - 1] !== st) seen.push(st); return st === 'agent'; }, 60000);
    const b = agent(['start', '--pool', 'api', ...claudeOpus]);
    until(() => Boolean(rec('builder-api3')?.pid), 60000);
    const c = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-14', ...claudeOpus]);
    const r2 = rec('builder-api2');
    const r3 = rec('builder-api3');
    fs.rmSync(path.join(recDir, 'hold'), { force: true });
    ended('builder-api2'); ended('builder-api3');
    await guard('2.93 (b) pool: while builder-api2 starts its record never vanishes (placeholder to agent), a second `--pool api` start takes builder-api3 (role builder by default), and with both running a third is refused in one plain line naming each busy name (fails before this fix: the launcher deleted its placeholder at once, so the name looked free until the agent started, and a second start in that gap took builder-api2 again)', () => [
      a.status === 0 && b.status === 0 && /builder-api3 started/.test(out(b)) && r2?.task === 'T-12' && r3?.role === 'builder' && seen[0] !== 'none' && !seen.includes('none') && seen[seen.length - 1] === 'agent'
        && c.status === 1 && /No API-pool builder to start: every API-pool name is busy \(builder-api2: running, builder-api3: running\)/.test(out(c)),
      JSON.stringify({ seen, a: out(a).slice(-300), b: out(b).slice(-300), c: out(c).slice(-300), r2: r2 && { task: r2.task, role: r2.role }, r3: r3 && { role: r3.role } })]);
  }

  // ================= record: a start that cannot launch says why =================
  {
    // A refusal inside the detached launcher: aider is not installed.
    const a = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-13', '--tool', 'aider', '--model', 'qwen'], { STUDIO_AIDER_CMD: path.join(T, 'no-such-aider') });
    ended('builder-api2');
    const r = rec('builder-api2');
    const j = jobs('builder-api2').pop();
    // A crash inside the detached launcher before its agent starts: the kickoff folder is a file, so writing the kickoff throws.
    fs.rmSync(path.join(S, '.studio', 'kickoff'), { recursive: true, force: true });
    fs.writeFileSync(path.join(S, '.studio', 'kickoff'), 'not a folder\n');
    const b = agent(['start', '--pool', 'api', '--role', 'engine-porter', '--task', 'T-13', ...claudeOpus]);
    ended('builder-api2');
    const gone = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'agent.mjs')).href)}).then((m) => console.log(JSON.stringify(m.markGone())))`], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(), timeout: 60000 });
    const rc = rec('builder-api2');
    const jc = jobs('builder-api2').pop();
    fs.rmSync(path.join(S, '.studio', 'kickoff'), { force: true });
    await guard('2.93 (b) record: a detached start that is refused inside its launcher (aider not installed) ends its record with the reason and one job.done "refused" carrying it; one whose launcher crashes before the agent starts does the same ("the launcher crashed: …"), and the watcher\'s markGone then finds nothing "gone" (fails before this fix: the refusal went to an ignored stderr and the record was deleted, and the crash left a "running" record that markGone reported as "its process is gone (last heartbeat never)" with log null)', () => [
      a.status === 0 && r?.status === 'ended' && /^not started: .*aider/.test(r.refusal || '') && j?.meta?.result === 'refused' && /aider/.test(j.meta.tail || '')
        && b.status === 0 && rc?.status === 'ended' && /^not started: the launcher crashed: /.test(rc.refusal || '') && jc?.meta?.result === 'refused' && /launcher crashed/.test(jc.meta.tail || '')
        && gone.status === 0 && !String(gone.stdout).includes('builder-api2') && !jobs('builder-api2').some((e) => e.meta?.result === 'gone'),
      JSON.stringify({ r: r && { status: r.status, refusal: r.refusal }, j: j?.meta && { result: j.meta.result, tail: String(j.meta.tail).slice(0, 160) }, rc: rc && { status: rc.status, refusal: String(rc.refusal).slice(0, 160) }, jc: jc?.meta && { result: jc.meta.result, tail: String(jc.meta.tail).slice(0, 160) }, gone: out(gone).slice(-300), outs: [out(a), out(b)].map((x) => x.slice(-200)) })]);
  }

  // ================= agy: an engine porter gets allow-rules for exactly its folders =================
  write(S, '.studio/agy-settings.json', `${JSON.stringify({ permissions: { allow: ['command(node)', 'write_file'] }, ui: { theme: 'plain' } }, null, 2)}\n`);
  const gem = ['--tool', 'agy', '--model', 'gemini-x-high'];
  {
    const a = agent(['start', '--attach', '--role', 'engine-porter', '--agent', 'porter-agy1', '--task', 'T-14', ...gem]);
    const run = runs('agy', 'porter-agy1').find((x) => x.argv.includes('--print-timeout'));
    const i = run ? run.argv.indexOf('--settings') : -1;
    const file = i >= 0 ? fwdp(path.resolve(path.join(S, '.lanes', 'porter-agy1'), run.argv[i + 1])) : '';
    const allow = run?.settings?.permissions?.allow || [];
    const r = rec('porter-agy1');
    const reach = (r?.reach || []).map(fwdp);
    const eng = engineDir('T-14');
    const extra = allow.filter((x) => !['command(node)', 'write_file'].includes(x));
    // Every added rule names one of the session's folders, and none is wider (the whole .lanes, the studio, the disk).
    const scoped = extra.length > 0 && extra.every((x) => reach.some((d) => x.includes(d) || x.includes(d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
    const wide = extra.filter((x) => /\((?:read_file|command)?\)$/.test(x) || x.includes(`${fwdp(path.join(S, '.lanes'))})`) || x.includes(`(${fwdp(S)})`) || /^command\(git\)$|push|reset|checkout/.test(x));
    const tpl = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'agy-allow.mjs')).href)}).then((m) => console.log(JSON.stringify({ custom: m.agyReachRules({ dirs: ['/s/studio', '/s/.lanes/engine/T-1'], engineDir: '/s/.lanes/engine/T-1', env: { STUDIO_AGY_REACH_RULES: '["read({dir})","run({engine} {verb})","everything"]' } }), off: m.agyReachRules({ dirs: ['/s/studio'], env: { STUDIO_AGY_REACH_RULES: 'off' } }), bad: m.agyReachRules({ dirs: ['/s/studio'], env: { STUDIO_AGY_REACH_RULES: 'not json' } }) })))`], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
    let t = null; try { t = JSON.parse(String(tpl.stdout).trim().split('\n').pop()); } catch { t = null; }
    await guard('2.93 (b) agy: an engine porter on agy is launched with its own settings file (.studio/agy-settings/<agent>.json): the studio\'s rules and settings kept, plus read_file rules for exactly its folders (the main checkout\'s studio/ and .studio/, its engine worktree) and git -C <worktree> status/diff/log/add/commit, nothing wider (no whole .lanes, no bare rule, no push); agy\'s user-level settings are not written; STUDIO_AGY_REACH_RULES swaps the templates (one with no folder is dropped) or turns them off (fails before this fix: agy got only the studio\'s file, with no rule for the engine worktree, and was denied it)', () => [
      a.status === 0 && file.endsWith('.studio/agy-settings/porter-agy1.json') && allow.includes('command(node)') && allow.includes('write_file') && run.settings.ui?.theme === 'plain'
        && reach.includes(eng) && reach.length === 3 && reach.every((d) => allow.includes(`read_file(${d})`)) && ['status', 'diff', 'log', 'add', 'commit'].every((v) => allow.includes(`command(git -C ${eng} ${v})`))
        && scoped && wide.length === 0 && fs.readFileSync(userAgy, 'utf8') === userAgyBefore
        && JSON.stringify(t?.custom?.rules) === JSON.stringify(['read(/s/studio)', 'read(/s/.lanes/engine/T-1)', ...['status', 'diff', 'log', 'add', 'commit'].map((v) => `run(/s/.lanes/engine/T-1 ${v})`)]) && t.custom.from === 'STUDIO_AGY_REACH_RULES'
        && t.off.rules.length === 0 && t.bad.from === 'default' && /not a JSON list/.test(t.bad.bad || ''),
      JSON.stringify({ status: a.status, out: out(a).slice(-300), file, allow, reach, wide, t, real: real(S) }).slice(0, 3000)]);
  }

  // ================= agy: a plain builder's launch is unchanged =================
  {
    const a = agent(['start', '--attach', '--role', 'builder', '--agent', 'builder-agy2', ...gem]);
    const run = runs('agy', 'builder-agy2').find((x) => x.argv.includes('--print-timeout'));
    const i = run ? run.argv.indexOf('--settings') : -1;
    const cmd = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'agent.mjs')).href)}).then((m) => console.log(JSON.stringify(m.toolCommand('agy', { model: 'gemini-x-high', prompt: 'P', addDirs: ['/x/studio'] }).argv)))`], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(), timeout: 60000 });
    let argv = null; try { argv = JSON.parse(String(cmd.stdout).trim().split('\n').pop()); } catch { argv = null; }
    await guard('2.93 (b) agy: a builder on agy (no engine worktree) is launched as before: --settings is the studio\'s own .studio/agy-settings.json, no session settings file is written for it, and toolCommand gives no --add-dir to agy (guards the plain launch: it must not change with this fix)', () => [
      a.status === 0 && i >= 0 && fwdp(run.argv[i + 1]).endsWith('.studio/agy-settings.json') && !fs.existsSync(path.join(S, '.studio', 'agy-settings', 'builder-agy2.json'))
        && Array.isArray(argv) && argv[0] === 'agy' && !argv.includes('--add-dir') && fwdp(argv[argv.indexOf('--settings') + 1] || '').endsWith('.studio/agy-settings.json'),
      JSON.stringify({ status: a.status, out: out(a).slice(-300), argv: run?.argv, cmd: argv || out(cmd).slice(-300) })]);
  }

  // ================= agy: the "auto-denied" ending is a reason =================
  {
    fs.writeFileSync(path.join(recDir, 'porter-agy3.say'), 'no output produced — one or more tools required the "read_file", "command" permissions that headless mode cannot prompt for, so they were auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. read_file(<target>), command(<target>))');
    const a = agent(['start', '--attach', '--role', 'engine-porter', '--agent', 'porter-agy3', '--task', 'T-15', ...gem]);
    const r = rec('porter-agy3');
    const j = jobs('porter-agy3').pop();
    const end = events().filter((e) => e.type === 'agent.session.end' && e.agent === 'porter-agy3').pop();
    const eng = engineDir('T-15');
    await guard('2.93 (b) agy: a session agy ended with "… required the "read_file", "command" permissions that headless mode cannot prompt for, so they were auto-denied" ends with the reason "agy could not use its tools: headless mode denied the read_file, command permission(s) for lack of an allow-rule (this session\'s folders: …)" naming its engine worktree, in its record, its session end and its job record (fails before this fix: the reason was "finished" and the job said only "fail (exit 0)")', () => [
      /agy could not use its tools: headless mode denied the read_file, command permission\(s\) for lack of an allow-rule \(this session's folders: .*/.test(r?.reason || '') && (r.reason || '').includes(eng)
        && /agy could not use its tools/.test(j?.meta?.tail || '') && j?.meta?.result === 'fail' && /agy could not use its tools/.test(end?.msg || ''),
      JSON.stringify({ status: a.status, out: out(a).slice(-300), reason: r?.reason, job: j?.meta, end: end?.msg })]);
  }

  // ================= no key anywhere =================
  {
    const hits = [];
    const scan = (d) => { let list = []; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of list) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else { try { if (fs.readFileSync(p, 'utf8').includes(SECRET)) hits.push(fwdp(path.relative(T, p))); } catch { /* unreadable */ } } } };
    scan(path.join(S, '.studio'));
    scan(recDir);
    outputs.forEach((o, i) => { if (o.includes(SECRET)) hits.push(`output ${i}`); });
    await guard('2.93 (b): no key value appears in any output of these checks: the launcher\'s output, the agents\' records, logs and settings files, the event log, or what the stand-in tools were given (fails before this fix: guards it)', () => [outputs.length >= 8 && hits.length === 0, JSON.stringify({ n: outputs.length, hits })]);
  }

  for (const p of [S, T]) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ } }
}
