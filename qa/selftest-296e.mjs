/**
 * qa/selftest-296e.mjs — 2.96 (e): `agent smoke` proves a start end to end with stand-in programs (never a real tool or
 * key); the spending order for engine porters; an upgrade that waits for a running train; the not-main line.
 * The studio copy, engine repo and stand-in claude are qa/selftest-295c.mjs's, with a stand-in that commits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { eventsOf as eventsFileOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, napSync, npmShim, out, writeIn as write } from './kit.mjs';

export async function selftest296E({ dir, report, tmpRoot }) {
  const WIN = process.platform === 'win32';
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s296e-${process.pid}`);
  const clean = {};
  // Windows: the launcher and git need Windows' own system variables, which any real shell has; passed through as they are, as in 294a.
  if (WIN) for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const SECRET = 'sk-test-296e-never-shown-0000';
  const home = path.join(T, 'home');
  fs.mkdirSync(home, { recursive: true });
  const bin = path.join(T, 'bin');
  const recDir = path.join(T, 'rec');
  fs.mkdirSync(recDir, { recursive: true });
  const base = {
    ...clean, ...ident, HOME: home, USERPROFILE: home, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_POST_BROWSER_PLAY: 'off', STUDIO_QUOTA_PROBE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_IDLE_EXIT_MIN: '0',
    STUDIO_HEARTBEAT_SEC: '1', STUDIO_LANE_LIVE_MIN: '0', STUDIO_UPGRADE_WATCH_MIN: 'off', STUDIO_DRIFT: 'off', STUDIO_LANE_INFER: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_ENGINE_LANE_REQUIRED: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
    STUDIO_API_POOL: 'builder-api2', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', ANTHROPIC_API_KEY_LANE: SECRET,
  };

  // ---- a studio copy with a made-up engine repo ----
  const S = path.join(T, 'studio');
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/budget.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch { /* not needed here */ } }
  const R = path.join(T, 'engine');
  fs.mkdirSync(R, { recursive: true });
  g(R, 'init', '-q', '-b', 'port/main'); g(R, 'config', 'core.autocrlf', 'false');
  write(R, 'Rules/a.txt', 'a\n'); g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: 'echo {branch}', target: 'port/main', cwd: R.split(path.sep).join('/') } } }, null, 2)}\n`);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296e.jsonl');
  write(S, '.studio/events-296e.jsonl', '');
  const events = eventsFileOf(evFile);

  // ---- the stand-in claude: dies at once if <rec>/die-all exists; else makes the one commit a smoke task names, in its
  // engine lane (an --add-dir folder) or its own lane copy (its cwd), then drains stdin and exits ----
  const fake = `// The stand-in claude (qa/selftest-296e.mjs).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const REC = ${JSON.stringify(recDir)};
const who = process.env.STUDIO_LOCK_OWNER || 'nobody';
const argv = process.argv.slice(2);
const given = argv.flatMap((a, k) => (argv[k - 1] === '--add-dir' ? [a] : []));
const lane = given.find((d) => /[\\\\/]\\.lanes[\\\\/]engine[\\\\/]/.test(d)) || (/[\\\\/]\\.lanes[\\\\/]/.test(process.cwd()) ? process.cwd() : null);
const dead = fs.existsSync(path.join(REC, 'die-all'));
if (dead) process.stderr.write('Invalid API key - Please run /login\\n');
else if (lane) {
  fs.mkdirSync(path.join(lane, 'docs', 'smoke'), { recursive: true });
  fs.writeFileSync(path.join(lane, 'docs', 'smoke', who + '.md'), 'smoke line by the stand-in\\n');
  spawnSync('git', ['-C', lane, 'add', '-A'], { windowsHide: true });
  spawnSync('git', ['-C', lane, 'commit', '-qm', 'smoke ' + who, '--no-verify'], { windowsHide: true });
}
fs.appendFileSync(path.join(REC, 'claude-' + who + '.jsonl'), JSON.stringify({ argv, cwd: process.cwd(), lane, dead }) + '\\n');
process.stdin.on('data', () => {});
process.stdin.on('error', () => {});
process.stdin.on('end', () => process.exit(dead ? 1 : 0));
process.stdin.resume();
`;
  if (WIN) {
    fs.mkdirSync(path.join(bin, 'node_modules', 'fake-claude'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'node_modules', 'fake-claude', 'cli.js'), fake);
    fs.writeFileSync(path.join(bin, 'claude.cmd'), npmShim('fake-claude'));
  } else {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\n${fake}`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
  const standIns = () => fs.readdirSync(recDir).filter((f) => f.startsWith('claude-')).length;
  const childEnv = (extra = {}) => {
    const e = { ...process.env, ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: '', ...extra };
    const keys = Object.keys(e).filter((k) => k.toUpperCase() === 'PATH');
    const was = keys.map((k) => e[k]).find(Boolean) || '';
    for (const k of keys) delete e[k];
    e.PATH = `${bin}${path.delimiter}${was}`;
    return e;
  };
  const outputs = [];
  const smoke = (args, extra = {}) => { const r = spawnSync(process.execPath, ['harness/agent.mjs', 'smoke', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv(extra), timeout: 240000 }); outputs.push(out(r)); return r; };
  const board = () => ['NEXT.md', 'DONE.md'].map((f) => { try { return fs.readFileSync(path.join(S, 'studio', f), 'utf8'); } catch { return ''; } }).join('\n');
  const branches = (repo) => g(repo, 'branch', '--format=%(refname:short)').stdout.split('\n').filter(Boolean).sort().join(',');
  const idOf = (text) => /Smoke test (\S+):/.exec(text)?.[1] || '';
  const trainQueued = () => { const d = path.join(S, '.studio', 'train'); try { return fs.readdirSync(d).filter((f) => /queue/.test(f)).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('\n'); } catch { return ''; } };
  const worktrees = (repo) => g(repo, 'worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
  const engineBranches0 = branches(R);

  // ================= (e1) an engine porter from the API pool: the commit exists, and it all goes away =================
  const s1 = smoke(['--role', 'engine-porter', '--pool', 'api', '--engine', 'unity', '--minutes', '3']);
  {
    const o = out(s1);
    const added = events().find((e) => e.type === 'task.added' && /Smoke test builder-api2/.test(e.msg || ''));
    const id = added?.task || '';
    await guard('2.96 (e1) smoke: `agent smoke --role engine-porter --pool api --engine unity` with a stand-in claude says its first line spends real tokens, reports lane made yes (engine worktree), first tool call allowed yes with the commit, the session end, exits 0, and cleans up (task off the board and the train queue, engine worktree and branch removed, no key shown) (fails before this fix: there was no smoke command)', () => [
      s1.status === 0 && /spends real tokens/.test(String(s1.stdout).split('\n')[0]) && /lane made: yes, .*\.lanes\/engine\//.test(o) && /first tool call allowed: yes, commit [0-9a-f]{7,}/.test(o) && /session ended/.test(o)
        && /cleaned up: T-\d+ dropped, lane removed/.test(o) && Boolean(id) && !board().includes(id) && !trainQueued().includes(id) && !events().some((e) => e.task === id && /^task\.train\./.test(e.type))
        && !fs.existsSync(path.join(S, '.lanes', 'engine', id)) && branches(R) === engineBranches0 && worktrees(R) === 1 && !o.includes(SECRET),
      JSON.stringify({ status: s1.status, out: o.slice(-700), id, branches: branches(R), worktrees: worktrees(R) })]);
  }

  // ================= (e2) a builder on a tool, in its own lane copy of the studio =================
  const s2 = smoke(['--role', 'builder', '--tool', 'claude', '--minutes', '3']);
  {
    const o = out(s2);
    await guard('2.96 (e2) smoke: `agent smoke --role builder --tool claude` makes the lane copy under .lanes, sees the stand-in\'s commit on its branch, exits 0 and leaves no lane copy, no extra branch and no task on the board (fails before this fix: there was no smoke command)', () => [
      s2.status === 0 && /lane made: yes, .*\.lanes\/smoke-/.test(o) && /first tool call allowed: yes/.test(o) && /cleaned up: T-\d+ dropped, lane removed/.test(o)
        && branches(S) === 'main' && !/Smoke test/.test(board()) && worktrees(S) === 1,
      JSON.stringify({ status: s2.status, out: o.slice(-600), branches: branches(S), worktrees: worktrees(S) })]);
  }

  // ================= (e3) a session that dies at once, and a launcher that refuses =================
  fs.writeFileSync(path.join(recDir, 'die-all'), '');
  const s3 = smoke(['--role', 'builder', '--tool', 'claude', '--minutes', '3']);
  fs.rmSync(path.join(recDir, 'die-all'), { force: true });
  const s4 = smoke(['--role', 'builder', '--tool', 'aider', '--minutes', '3'], { STUDIO_AIDER_CMD: path.join(T, 'no-such-aider') });
  {
    const o3 = out(s3);
    const o4 = out(s4);
    await guard('2.96 (e3) smoke: a stand-in that dies at once reports first tool call allowed no and the session\'s own reason, exits non-zero, and still cleans up; a launcher that refuses (aider not installed) reports the refusal in words, exits non-zero and cleans up (fails before this fix: there was no smoke command)', () => [
      s3.status !== 0 && /first tool call allowed: no/.test(o3) && /session ended .*: \S+/.test(o3) && /cleaned up: T-\d+ dropped/.test(o3)
        && s4.status !== 0 && /first tool call allowed: no/.test(o4) && /not started: .*aider/i.test(o4) && /cleaned up: T-\d+ dropped/.test(o4)
        && !/Smoke test/.test(board()) && branches(S) === 'main' && worktrees(S) === 1,
      JSON.stringify({ s3: [s3.status, o3.slice(-500)], s4: [s4.status, o4.slice(-500)], branches: branches(S) })]);
  }

  // ================= (e4) --dry-run starts nothing =================
  const before = { board: board(), n: standIns(), events: events().length };
  const s5 = smoke(['--role', 'engine-porter', '--pool', 'api', '--engine', 'unity', '--dry-run']);
  {
    const o = out(s5);
    await guard('2.96 (e4) smoke: --dry-run says it spends real tokens when run for real, prints the task and the start it would make, exits 0, and adds no task, runs no program and makes no lane (fails before this fix: there was no smoke command)', () => [
      s5.status === 0 && /spends real tokens/.test(o) && /would add a smoke task "Smoke test builder-api2: add one line to docs\/smoke\/builder-api2\.md/.test(o) && /start --attach --role engine-porter --pool api --task/.test(o)
        && board() === before.board && standIns() === before.n && events().length === before.events && branches(R) === engineBranches0,
      JSON.stringify({ status: s5.status, out: o.slice(-500) })]);
  }

  // ================= (e5) the spending order for engine porters: api pool, then agy, then the plan =================
  // STUDIO_BUILDER_ORDER=api,plan + STUDIO_ENGINE_PORTER_TOOL=agy + `npm run budget -- order agy,claude`: a supervisor pass
  // with a stand-in start function says which tool and name each start gets.
  fs.writeFileSync(path.join(S, 'studio', 'budget.json'), `${JSON.stringify({ order: ['agy', 'claude'], tools: {} })}\n`);
  const task = (args) => spawnSync(process.execPath, ['harness/task.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv() });
  // The studio copy's own waiting tasks would start too: leave only the engine porter's.
  const nf = path.join(S, 'studio', 'NEXT.md');
  fs.writeFileSync(nf, fs.readFileSync(nf, 'utf8').split('\n').filter((l) => !/^- \[ \] \*\*T-/.test(l)).join('\n'));
  const added = task(['add', 'Port rule one', '--role', 'engine-porter', '--track', 'engine:unity', '--agent', 'producer']);
  const url = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const pass = (live, extra = {}, mark = '') => {
    // A pass claims a launch lock per task (two minutes): the next pass starts from none.
    const ld = path.join(S, '.studio', 'locks');
    for (const x of fs.existsSync(ld) ? fs.readdirSync(ld) : []) if (/launch/.test(x)) fs.rmSync(path.join(ld, x), { recursive: true, force: true });
    const f = path.join(S, `.probe-296e-${++pn}.mjs`);
    fs.writeFileSync(f, `import { supervise } from ${url('harness/supervisor.mjs')};
${mark ? `import { markExhausted } from ${url('harness/budget.mjs')};\nmarkExhausted(${JSON.stringify(mark)}, 'probe');` : ''}
const starts = [];
const deps = { sessions: () => ${JSON.stringify(live)}, startAgent: (o) => { starts.push({ agent: o.agent, tool: o.tool, role: o.role }); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'o-', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ starts, why: r.why }));`);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: childEnv({ STUDIO_ENGINE_PORTER_TOOL: 'agy', ...extra }), timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    try { return JSON.parse(String(r.stdout).split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return { raw: out(r).slice(-1500) }; }
  };
  const ordered = { STUDIO_BUILDER_ORDER: 'api,plan' };
  const firstP = pass([], ordered);
  const busyP = pass([{ agent: 'builder-api2', role: 'builder', running: true, task: 'T-0', lane: 'game/other' }], ordered);
  const unsetP = pass([], {});
  const outP = pass([{ agent: 'builder-api2', role: 'builder', running: true, task: 'T-0', lane: 'game/other' }], ordered, 'agy');
  await guard('2.96 (e5) order: with STUDIO_BUILDER_ORDER=api,plan, STUDIO_ENGINE_PORTER_TOOL=agy and the budget order agy,claude an engine porter starts first under the API-pool name on claude (never agy), then on agy when the pool name is busy, then on claude when agy is out of quota; with no order set it never takes the pool name (fails before this fix: the order only filled builder slots, so an engine porter never used the API pool)', () => [
    added.status === 0 && firstP.starts?.length === 1 && firstP.starts[0].agent === 'builder-api2' && firstP.starts[0].tool === 'claude' && firstP.starts[0].role === 'engine-porter'
      && busyP.starts?.length === 1 && busyP.starts[0].agent !== 'builder-api2' && busyP.starts[0].tool === 'agy'
      && outP.starts?.length === 1 && outP.starts[0].agent !== 'builder-api2' && outP.starts[0].tool === 'claude'
      && unsetP.starts?.length === 1 && unsetP.starts[0].agent !== 'builder-api2' && unsetP.starts[0].tool === 'agy',
    JSON.stringify({ add: out(added).slice(-300), firstP, busyP, outP, unsetP }).slice(0, 2500)]);

  // ================= (e6) no flags: one smoke per path in the owner's order, one line each =================
  fs.writeFileSync(path.join(S, 'studio', 'budget.json'), `${JSON.stringify({ order: ['claude'], tools: {} })}\n`);
  const s6 = smoke(['--role', 'engine-porter', '--engine', 'unity', '--minutes', '3'], { STUDIO_BUILDER_ORDER: 'api,plan', STUDIO_ENGINE_PORTER_TOOL: 'claude' });
  {
    const o = out(s6);
    const lines = String(s6.stdout).split('\n').filter((l) => /^(PASS|FAIL)/.test(l));
    await guard('2.96 (e6) smoke: with no --pool or --tool and STUDIO_BUILDER_ORDER=api,plan it runs one smoke for the API pool, then one for the plan\'s tool, prints one PASS line each in that order and exits 0 (fails before this fix: there was no smoke command)', () => [
      s6.status === 0 && lines.length === 2 && /^PASS .*engine-porter on the api pool/.test(lines[0]) && /^PASS .*engine-porter on the plan \(claude\)/.test(lines[1]) && !board().includes('Smoke test') && branches(R) === engineBranches0 && !o.includes(SECRET),
      JSON.stringify({ status: s6.status, out: o.slice(-900) })]);
  }

  // ================= (e7, e8) an upgrade waits for a running train; a ref that is not main is said once =================
  const holders = [];
  const holder = () => { const k = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { windowsHide: true, stdio: 'ignore' }); holders.push(k); return k.pid; };
  let un = 0;
  const upStudio = (name) => {
    const U = path.join(T, `up-${name}-${++un}`);
    fs.cpSync(dir, U, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(U, '.studio'), { recursive: true, force: true });
    fs.writeFileSync(path.join(U, '.env'), '');
    write(U, '.studio/events-296e.jsonl', '');
    g(U, 'init', '-q', '-b', 'main'); g(U, 'config', 'core.autocrlf', 'false'); g(U, 'add', '-A'); g(U, 'commit', '-qm', 'studio', '--no-verify');
    g(U, 'checkout', '-q', '-b', 'release');
    fs.writeFileSync(path.join(U, 'harness', 'zz-296e-update.mjs'), 'export const updated = true;\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(U, 'package.json'), 'utf8'));
    fs.writeFileSync(path.join(U, 'package.json'), `${JSON.stringify({ ...pkg, version: '9.9.9' }, null, 2)}\n`);
    g(U, 'add', '-A'); g(U, 'commit', '-qm', 'release 9.9.9', '--no-verify');
    const bare = path.join(T, `up-remote-${un}`);
    g(T, 'init', '-q', '--bare', '-b', 'main', bare);
    g(U, 'remote', 'add', 'origin', bare); g(U, 'push', '-q', 'origin', 'release:main');
    g(U, 'checkout', '-q', 'main');
    return U;
  };
  const upgrade = (U, args) => spawnSync(process.execPath, ['harness/upgrade-guard.mjs', ...args], { windowsHide: true, cwd: U, encoding: 'utf8', env: { ...childEnv(), AGENT_EVENTS_FILE: path.join(U, '.studio', 'events-296e.jsonl'), STUDIO_UPGRADE_REFRESH: 'off', STUDIO_MAIN_ROOT: '' }, timeout: 240000 });
  const lock = (U, file, rec) => write(U, `.studio/locks/${file}`, JSON.stringify({ at: Date.now(), by: 'train-daemon', ...rec }));
  const head = (U) => g(U, 'rev-parse', 'HEAD').stdout.trim();
  {
    const U = upStudio('train');
    const h0 = head(U);
    lock(U, 'train.lock', { id: '20260101-120000-4242', pid: holder() });
    const web = upgrade(U, ['--merge', 'origin/main', '--by', 'Dana']);
    fs.rmSync(path.join(U, '.studio', 'locks', 'train.lock'), { force: true });
    lock(U, 'unity-train.lock', { id: '20260101-130000-77', pid: holder() });
    const eng = upgrade(U, ['--merge', 'origin/main', '--by', 'Dana']);
    const untouched = head(U) === h0 && !fs.existsSync(path.join(U, 'harness', 'zz-296e-update.mjs'));
    const over = upgrade(U, ['--merge', 'origin/main', '--by', 'Dana', '--during-train']);
    fs.rmSync(path.join(U, '.studio', 'locks', 'unity-train.lock'), { force: true });
    await guard('2.96 (e7) upgrade: `--merge` refuses (exit 1, nothing merged) while a web train or an engine train runs, saying which train, its pid and since when, and that --during-train takes the update anyway; with --during-train it merges (exit 0) (fails before this fix: it merged under a running train, which then ran half of each version)', () => [
      web.status === 1 && /a web train is running \(train 20260101-120000-4242, pid \d+, since \d{4}-\d\d-\d\d \d\d:\d\d UTC\)/.test(out(web)) && /Nothing was merged/.test(out(web)) && /--during-train/.test(out(web))
        && eng.status === 1 && /a unity train is running \(train 20260101-130000-77, pid \d+/.test(out(eng)) && untouched
        && over.status === 0 && /PASS merged origin\/main/.test(out(over)) && fs.existsSync(path.join(U, 'harness', 'zz-296e-update.mjs')),
      JSON.stringify({ web: [web.status, out(web).slice(-400)], eng: [eng.status, out(eng).slice(-300)], untouched, over: [over.status, out(over).slice(-500)] })]);
  }
  {
    const A = upStudio('notmain');
    const B = upStudio('main');
    const odd = upgrade(A, ['--merge', 'release', '--by', 'Dana']);
    const norm = upgrade(B, ['--merge', 'origin/main', '--by', 'Dana']);
    const said = (r) => out(r).split('\n').filter((l) => /this is not main: a branch can still change and its online checks may not have finished/.test(l)).length;
    await guard('2.96 (e8) upgrade: merging a ref that is not the release branch (a local branch, not origin/main) says once, before it merges, "this is not main: a branch can still change and its online checks may not have finished", and still merges; origin/main says nothing of the kind (fails before this fix: no word of it)', () => [
      odd.status === 0 && said(odd) === 1 && /PASS merged release/.test(out(odd)) && out(odd).indexOf('this is not main') < out(odd).indexOf('PASS merged') && norm.status === 0 && said(norm) === 0 && /PASS merged origin\/main/.test(out(norm)),
      JSON.stringify({ odd: [odd.status, out(odd).slice(-500)], norm: [norm.status, out(norm).slice(-300)] })]);
  }
  for (const k of holders) { try { if (WIN) spawnSync('taskkill', ['/pid', String(k.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else k.kill('SIGKILL'); } catch { /* gone */ } }
  void idOf; void napSync;

  for (const p of [S, T]) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ } }
}
