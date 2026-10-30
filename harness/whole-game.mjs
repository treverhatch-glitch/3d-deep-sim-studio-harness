/**
 * harness/whole-game.mjs — 2.37.0: after work lands, every required check runs on the whole game.
 *
 * Why: per-task checks are scoped to what the task touched (2.31.0), which keeps verify fast but misses a
 * change that breaks something elsewhere. In the research pack's Marina experiment the standard checks caught
 * 1 of 7 planted drift edits; running every check on the whole project after each landing caught 7 of 7,
 * for about 36% more time. A path-scoped run also missed a UI bug made in another file.
 *
 * Opt-in: STUDIO_WHOLE_GAME=on. Then the watchdog (every pass) starts a run in the background whenever the
 * studio's branch has a commit the check hasn't seen; `npm run whole-game` runs it by hand.
 *
 * Each run:
 *   - checks out that exact commit in its own clean copy (.studio/whole-wt), never the main checkout, with
 *     the shared studio/ and .studio/ linked in like a lane copy;
 *   - runs `node scripts/run-gates.mjs --all --full --required-only` (every gate a Full studio runs, whatever the studio's scope) (STUDIO_WHOLE_CMD overrides) in a gate slot;
 *   - re-runs anything that failed once, alone: a check that passes alone is logged as "environment" (a
 *     flaky or overloaded box), not as a break;
 *   - when still red: a P0 task "Whole-game check red at <commit> ..." naming the checks and the tasks that
 *     landed since the last green run. One such task at a time. It closes only with a full, unscoped verify.
 * State: .studio/whole-game.json { lastGreen, last, running }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { mainRoot, linkDir, nodeModuleDirs } from './worktree.mjs';

export const WHOLE_TITLE = 'Whole-game check red';
export const WHOLE_RE = /^Whole-game check red\b/i;
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const stateFile = (root = mainRoot()) => path.join(root, '.studio', 'whole-game.json');
const short = (sha) => String(sha || '').slice(0, 8);

export const wholeOn = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env.STUDIO_WHOLE_GAME || ''));

export function readWhole(root = mainRoot()) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return {}; }
}
function writeWhole(patch, root = mainRoot()) {
  const s = { ...readWhole(root), ...patch };
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), `${JSON.stringify(s, null, 2)}\n`);
  return s;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** The studio branch's commit, when the check hasn't seen it and no run is going: { sha } or null. */
export function wholeDue({ root = mainRoot(), env = process.env } = {}) {
  if (!wholeOn(env)) return null;
  const sha = git(root, 'rev-parse', 'HEAD').stdout.trim();
  if (!sha) return null;
  const s = readWhole(root);
  if (s.running && alive(s.running.pid)) return null;
  if (s.last?.sha === sha) return null;
  return { sha };
}

/** The clean copy at `sha` (made once, then moved): { dir } or { error }. */
export function wholeCopy(sha, root = mainRoot()) {
  const dir = path.join(root, '.studio', 'whole-wt');
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(root, 'worktree', 'prune');
    const add = git(root, 'worktree', 'add', '--no-checkout', '--detach', dir, sha);
    if (add.status !== 0) return { error: `git worktree add failed: ${(add.stderr || '').trim().split('\n').pop()}` };
    for (const s of [['config', 'extensions.worktreeConfig', 'true'], ['config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true'], ['sparse-checkout', 'set', '--no-cone', '/*', '!/studio/', '!/.studio/']]) {
      const r = git(dir, ...s);
      if (r.status !== 0) return { error: `git ${s.slice(0, 2).join(' ')} failed: ${(r.stderr || '').trim().split('\n').pop()}` };
    }
    const exclude = path.join(root, '.studio', 'lanes', 'whole-game.exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.writeFileSync(exclude, ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
    git(dir, 'config', '--worktree', 'core.excludesFile', exclude);
  }
  // Exactly that commit, nothing left over from the last run (the links are ignored, so clean keeps them).
  for (const s of [['checkout', '-q', '--detach', '-f', sha], ['reset', '-q', '--hard', sha], ['clean', '-fdq']]) {
    const r = git(dir, ...s);
    if (r.status !== 0) return { error: `git ${s[0]} failed: ${(r.stderr || '').trim().split('\n').pop()}` };
  }
  if (!fs.existsSync(path.join(dir, 'studio'))) linkDir(path.join(root, 'studio'), path.join(dir, 'studio'));
  if (!fs.existsSync(path.join(dir, '.studio'))) linkDir(path.join(root, '.studio'), path.join(dir, '.studio'));
  for (const rel of nodeModuleDirs(root)) if (!fs.existsSync(path.join(dir, rel))) linkDir(path.join(root, rel), path.join(dir, rel));
  try { if (fs.existsSync(path.join(root, '.env'))) fs.copyFileSync(path.join(root, '.env'), path.join(dir, '.env')); } catch {}
  return { dir };
}

const failedIn = (text) => [...new Set([...String(text || '').matchAll(/^\[gates\] FAIL (\S+)/gm)].map((m) => m[1]))];

/** Tasks that landed after `since` (lane.merged events), oldest first. */
function landedSince(since) {
  const t = Date.parse(since || '') || 0;
  return [...new Set(readRecentEvents(20000).filter((e) => e.type === 'lane.merged' && e.task && Date.parse(e.ts) > t).map((e) => e.task))];
}

/**
 * Run the whole-game check on `sha` (default: the studio branch's HEAD). Returns
 * { ok, sha, result: 'green'|'environment'|'red'|'error', failed, task }.
 */
export async function runWhole({ sha = null, root = mainRoot(), env = process.env, now = Date.now() } = {}) {
  sha = sha || git(root, 'rev-parse', 'HEAD').stdout.trim();
  writeWhole({ running: { pid: process.pid, sha, at: new Date(now).toISOString() } }, root);
  const finish = (rec) => {
    const s = writeWhole({ running: null, last: rec, ...(rec.result === 'green' || rec.result === 'environment' ? { lastGreen: { sha: rec.sha, at: rec.at } } : {}) }, root);
    return { ...rec, lastGreen: s.lastGreen || null };
  };
  const copy = wholeCopy(sha, root);
  if (copy.error) {
    emitEvent({ type: 'whole.error', agent: 'whole-game', to: 'producer', msg: `Whole-game check could not start at ${short(sha)}: ${copy.error}` });
    return finish({ sha, at: new Date(now).toISOString(), ok: false, result: 'error', failed: [], why: copy.error });
  }
  const cmd = env.STUDIO_WHOLE_CMD || 'node scripts/run-gates.mjs --all --full --required-only';
  const runEnv = { ...env, STUDIO_MAIN_ROOT: root, STUDIO_LOCK_OWNER: 'whole-game', STUDIO_COMPACT_OUTPUT: 'on', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '' };
  const { withGateSlot } = await import('./merge-lane.mjs');
  const exec = (c) => withGateSlot(root, 'whole-game', () => spawnSync(c, { cwd: copy.dir, shell: true, encoding: 'utf8', env: runEnv, maxBuffer: 256 * 1024 * 1024, timeout: Number(env.STUDIO_WHOLE_TIMEOUT_MS || 3600000) }), { env });
  const started = Date.now();
  const first = exec(cmd);
  const out1 = `${first.stdout || ''}${first.stderr || ''}`;
  let failed = first.status === 0 ? [] : failedIn(out1);
  const at = new Date(now).toISOString();
  const ms = () => Date.now() - started;
  if (first.status === 0) {
    emitEvent({ type: 'whole.green', agent: 'whole-game', msg: `Whole-game check green at ${short(sha)} (${Math.round(ms() / 1000)} s)`, meta: { sha, ms: ms() } });
    return finish({ sha, at, ok: true, result: 'green', failed: [], ms: ms() });
  }
  if (!failed.length) failed = ['(unnamed)'];
  // A failure is re-run once, alone, before it counts (a busy or flaky box is not a break).
  const named = failed.filter((f) => f !== '(unnamed)');
  const again = named.length ? exec(`${cmd} --only ${named.join(',')}`) : exec(cmd);
  if (again.status === 0) {
    emitEvent({ type: 'whole.environment', agent: 'whole-game', to: 'producer', status: 'warn', msg: `Whole-game check at ${short(sha)}: ${failed.join(', ')} failed, then passed alone (logged as environment, not a break)`, meta: { sha, failed } });
    return finish({ sha, at, ok: true, result: 'environment', failed, ms: ms() });
  }
  const still = named.length ? failedIn(`${again.stdout || ''}${again.stderr || ''}`).filter((f) => named.includes(f)) : failed;
  failed = still.length ? still : failed;
  const prev = readWhole(root).lastGreen;
  const tasks = landedSince(prev?.at);
  const range = prev?.sha ? `${short(prev.sha)}..${short(sha)}` : short(sha);
  const tail = `${again.stdout || ''}${again.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
  emitEvent({ type: 'whole.red', agent: 'whole-game', to: 'producer', status: 'warn', msg: `Whole-game check red at ${short(sha)}: ${failed.join(', ')}${tasks.length ? ` (landed since the last green run: ${tasks.join(', ')})` : ''}`, meta: { sha, failed, tasks, range } });
  // One fix task at a time: while one is open, a later red run only adds to the log.
  let task = null;
  try {
    const { parseNextQueue, addTask } = await import('./task.mjs');
    const q = parseNextQueue();
    const open = [...q.inProgress, ...q.backlog].find((t) => WHOLE_RE.test(t.title));
    if (open) task = open.id;
    else {
      const title = `${WHOLE_TITLE} at ${short(sha)}: ${failed.join(', ')}${tasks.length ? ` after ${tasks.slice(-4).join(', ')}` : ''} (commits ${range})`;
      const res = addTask({ title, role: 'builder', priority: 'P0', agent: 'whole-game', meta: { promoted: true, origin: 'harness', whole: { sha, failed, tasks, range } } });
      task = res?.id || null;
      const brief = path.join(root, 'studio', 'handoffs', `${task}.md`);
      if (task) {
        fs.mkdirSync(path.dirname(brief), { recursive: true });
        fs.appendFileSync(brief, `# ${task}: the whole-game check is red\n\nCommit ${sha}; last green ${prev?.sha || '(none yet)'}.\nFailing: ${failed.join(', ')}.\nLanded since the last green run: ${tasks.join(', ') || '(none recorded)'}.\nFind which landing broke it (\`git log ${range}\`), fix it without undoing the other work, and close with a full \`npm run verify -- --all\`.\n\nLast output:\n\n\`\`\`\n${tail}\n\`\`\`\n`);
      }
    }
  } catch (e) {
    emitEvent({ type: 'whole.error', agent: 'whole-game', msg: `Whole-game check couldn't queue its fix task: ${e.message}` });
  }
  return finish({ sha, at, ok: false, result: 'red', failed, tasks, range, task, ms: ms() });
}

/** The watchdog's step: start a background run when one is due. Returns an action or null. */
export function wholeKick({ root = mainRoot(), env = process.env } = {}) {
  const due = wholeDue({ root, env });
  if (!due) return null;
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'harness', 'whole-game.mjs'), '--run', '--sha', due.sha], { cwd: root, detached: true, stdio: 'ignore', env: { ...env, STUDIO_MAIN_ROOT: root } });
  child.unref();
  writeWhole({ running: { pid: child.pid, sha: due.sha, at: new Date().toISOString() } }, root);
  return { kind: 'whole', msg: `started the whole-game check on ${short(due.sha)}` };
}

/** One line for the morning report, or null. */
export function wholeLine(root = mainRoot()) {
  const s = readWhole(root);
  if (!s.last) return null;
  if (s.last.result === 'red') return `The whole-game check is red at ${short(s.last.sha)} (${(s.last.failed || []).join(', ')})${s.last.task ? `; ${s.last.task} is queued to fix it` : ''}.`;
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--status')) {
    const s = readWhole();
    console.log(JSON.stringify({ on: wholeOn(), ...s }, null, 2));
    process.exit(0);
  }
  const r = await runWhole({ sha: flag('--sha') });
  console.log(`[whole-game] ${r.result.toUpperCase()} at ${short(r.sha)}${r.failed?.length ? `: ${r.failed.join(', ')}` : ''}${r.task ? ` (fix task ${r.task})` : ''}${r.why ? `: ${r.why}` : ''}`);
  process.exit(r.ok ? 0 : 1);
}
