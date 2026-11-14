/**
 * qa/selftest-286e.mjs — 2.86 (e): five small fixes from a crew's first day on 2.85.
 *
 *   e1  a branch handed back for a merge conflict with the target is queued again once it holds the target's tip (B-142); every
 *       "nothing changed since" refusal names --again
 *   e2  `task done --force --train` accepts a force approval a beta stand-in recorded, in a studio that does not enforce an owner key
 *   e3  setEngineTask's file write retries a rename that fails for a moment (Windows EPERM)
 *   e4  a hold that names a proposal follows it to the task it becomes
 *   e5  a model pool the owner configured carries its own anyModel flag
 *
 * Scaffolding: a studio copy and a made-up engine repo, as in qa/selftest-285a.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest286E({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const T = path.join(tmpRoot, `s286e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  void root;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_REACHABILITY: 'off', STUDIO_DONE_GAME_GATES: 'skip',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-286e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file) ----
  const S = path.join(tmpRoot, `286e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/proposed.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', 'studio/models.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-286e.jsonl');
  fs.writeFileSync(evFile, '');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-286e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ================= e1. a conflict hand-back is fixed by merging the target =================
  {
    const R = path.join(T, 'repo-e1');
    const GW = path.join(T, 'gate-e1');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'base.txt', 'base\n'); write(R, 'conflict.txt', 'one\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const tip0 = g(R, 'rev-parse', 'port/main').stdout.trim();
    const heads = {};
    for (const br of ['feat/a', 'feat/b', 'feat/c']) {
      g(R, 'checkout', '-q', '-B', br, 'port/main'); write(R, `${br.replace('/', '-')}.txt`, `${br}\n`);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    setEngines({ unity: { land: 'node -e 0 {branch}', target: 'port/main', cwd: fwd(R), gateWorktree: fwd(GW), timeoutMin: 5, rules: false } });
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    const rec = (branch, reason) => ({ train: 'tr-1', branch, head: heads[branch], reason, cause: 'red', files: ['conflict.txt'], tests: [], targetAt: tip0, at: new Date().toISOString() });
    fs.writeFileSync(path.join(S, '.studio', 'train', 'unity-handbacks.json'), JSON.stringify({
      'T-801': rec('feat/a', 'it conflicts with the target in conflict.txt: bring the target into it'),
      'T-802': rec('feat/b', 'edit: Game.Tests.LoadTests failed'),
      'T-803': rec('feat/c', 'it conflicts with the target in conflict.txt: bring the target into it'),
    }));
    // The target moves in a file the conflict does not name; feat/a, feat/b and feat/c bring it in.
    write(GW, 'other.txt', 'other\n'); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target moves');
    const mergeTarget = (br) => { g(R, 'checkout', '-q', br); g(R, 'merge', '-q', '--no-ff', '-m', 'bring the target in', 'port/main'); g(R, 'checkout', '-q', 'dev'); };
    for (const br of ['feat/a', 'feat/b', 'feat/c']) mergeTarget(br);
    // The target moves again; feat/c does not bring that in.
    write(GW, 'later.txt', 'later\n'); g(GW, 'add', '-A'); g(GW, 'commit', '-qm', 'target moves again');
    mergeTarget('feat/a'); mergeTarget('feat/b');
    const Q = (task, branch, extra = '') => probe(`import { queueUnityTask, dequeueUnity } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: ${JSON.stringify(task)}, agent: 'porter-0', branch: ${JSON.stringify(branch)}${extra} });
if (r.ok) dequeueUnity(process.cwd(), ${JSON.stringify(task)}, 'unity');
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message }));`);
    const a = Q('T-801', 'feat/a');
    const b = Q('T-802', 'feat/b');
    const c = Q('T-803', 'feat/c');
    await guard('2.86 (e1) a hand-back for a merge conflict with the target: the branch that merged the target in (its head holds the target\'s current tip) is queued without --again, while a red hand-back (feat/b) is still refused as unchanged and a conflict branch that lacks the target\'s newest tip (feat/c) too (fails before this fix: the conflict fix was refused "nothing changed since")', () => [
      a.ok === true && b.ok === false && b.error === 'unchanged' && c.ok === false && c.error === 'unchanged',
      JSON.stringify({ a, b, c }).slice(0, 2500)]);
    await guard('2.86 (e1) every "nothing changed since" refusal names the flag: "add --again if a person wants it run again as it is" (fails before this fix: it said the overseer or a planner may queue it with --again)', () => [
      /nothing changed since/.test(b.message || '') && (b.message || '').includes('add --again if a person wants it run again as it is') && (c.message || '').includes('add --again if a person wants it run again as it is'),
      JSON.stringify({ b: b.message, c: c.message }).slice(0, 2500)]);
  }

  // ================= e2. --force --train accepts a force approval a beta stand-in recorded (no owner key enforced) =================
  {
    const BETA_ON = { on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] };
    write(S, 'studio/beta.json', `${JSON.stringify(BETA_ON, null, 2)}\n`);
    write(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
    g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'beta on, no owner key', '--no-verify');
    fs.mkdirSync(path.join(T, 'hooks'), { recursive: true });
    fs.copyFileSync(path.join(S, 'scripts', 'hooks', 'commit-msg'), path.join(T, 'hooks', 'commit-msg'));
    try { fs.chmodSync(path.join(T, 'hooks', 'commit-msg'), 0o755); } catch { /* Windows: git runs it with its own bash */ }
    g(S, 'config', 'core.hooksPath', fwd(path.join(T, 'hooks')));
    const cli = (actor, args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, env: { ...envOf(), ...actor } });
    const OWNER = {};
    const OVER = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'overseer-1' };
    const addTask = (title) => (out(cli(OWNER, ['harness/task.mjs', 'add', title, '--role', 'builder', '--priority', 'P1'])).match(/\b(T-\d+)\b/) || [])[1];
    const commitAs = (who, msg, ...files) => { g(S, 'add', '--', ...files); return spawnSync('git', ['commit', '-qm', msg, '--', ...files], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...gEnv(), ...envOf(), STUDIO_LOCK_OWNER: who }, stdio: ['ignore', 'pipe', 'pipe'] }); };
    const id = addTask('Force-train with a beta approval');
    const ap = cli(OVER, ['harness/approve.mjs', 'force', id, '--reason', 'it lands through the train without the review', '--by', 'overseer-1']);
    const f = `studio/approvals/force-${id}.json`;
    const made = fs.existsSync(path.join(S, f));
    if (made) commitAs('overseer-1', `approve force ${id}`, f);
    const ft = cli(OVER, ['harness/task.mjs', 'done', id, '--force', '--train', '--reason', 'it lands through the train without the review', '--agent', 'overseer-1']);
    const id2 = addTask('Force-train with no approval at all');
    const ft2 = cli(OVER, ['harness/task.mjs', 'done', id2, '--force', '--train', '--reason', 'no approval for this one at all', '--agent', 'overseer-1']);
    await guard('2.86 (e2) `task done --force --train` after `approve -- force` under beta mode in a studio with no enforced owner key: the recorded approval is accepted (not "--train and --force don\'t go together without a force approval"), while a task with none is still refused with that text (fails before this fix: the train path read the approval only where an owner key is enforced, so a valid beta approval was "not on file")', () => [
      made && !/don't go together without a force approval/.test(out(ft)) && /don't go together without a force approval/.test(out(ft2)),
      JSON.stringify({ made, ap: out(ap).slice(-300), ft: out(ft).slice(-500), ft2: out(ft2).slice(-300) })]);
  }

  void events;
}
