/**
 * qa/selftest-296e.mjs — 2.96 (e): `agent smoke` proves a start end to end with stand-in programs (never a real tool or
 * key); the spending order for engine porters; an upgrade that waits for a running train; the not-main line.
 * The studio copy, engine repo and stand-in claude are qa/selftest-295c.mjs's, with a stand-in that commits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  void idOf; void napSync; void pathToFileURL;

  for (const p of [S, T]) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* swept later */ } }
}
