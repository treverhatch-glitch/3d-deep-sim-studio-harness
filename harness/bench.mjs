#!/usr/bin/env node
/**
 * harness/bench.mjs — 2.62.0: the sealed replay bench, and the component-removal review.
 *
 * Selftests prove the harness's plumbing, not that agents do better with it. The bench measures that: 20-30 past
 * tasks, each pinned to the commit it started from, run k times by real agents in clean copies, graded by code, and
 * scored pass@1 (the mean success rate) and pass^k (every one of the k tries succeeded). Run it before and after a
 * harness change and compare the two runs case by case; switch one guardrail off (--without) to see whether it still
 * pays for itself. The agent that is measured never grades: graders are code the owner wrote, read from a protected
 * folder the bench copies never contain.
 *
 *   npm run bench -- add --from <T-ID> --by <person> [--id <name>] [--commit <sha>] [--brief-file <file>]
 *                    [--pass "<cmd>"]... [--fail "<cmd>"]... [--must-change <glob,..>] [--must-not-change <glob,..>]
 *                    [--hidden <path,..>] [--token-cap N] [--timeout-min N] [--replace]
 *   npm run bench -- list                        the cases, and whether each is complete
 *   npm run bench -- components                  the guardrails --without can switch off, and their switches
 *   npm run bench -- run --by <person> [--cases a,b] [--k 3] [--harness <ref>] [--label x] [--without <component>]
 *                    [--parallel N] [--keep] [--model-grader] [--yes]
 *   npm run bench -- compare <runA> <runB>       paired per-case comparison, a sign test, and a verdict
 *   npm run bench -- show <run>                  one run's scores
 *
 * Where things are:
 *   studio/bench/cases/<id>.json      a case: { id, from: { task, title }, commit, brief, grader, tokenCap, timeoutMin }
 *   studio/bench/cases/<id>/files/    hidden files (tests from the task's solution) laid over the copy before grading
 *   studio/bench/bench.json           optional settings: { parallel: 1, k: 3 }
 *   .studio/bench/<run-id>/results.json   a run's results (with logs/ beside it)
 * STUDIO_BENCH_DIR=<folder> keeps the cases elsewhere (outside the studio, out of the crew's reach); STUDIO_BENCH_COPIES
 * puts the clean copies elsewhere than the system's temp folder.
 *
 * The grader (code first): grader.pass = commands that must exit 0, grader.fail = commands that must not,
 * grader.mustChange = globs at least one changed file must match (each), grader.mustNotChange = globs no changed file
 * may match (the studio's protected files are added unless grader.allowProtected). grader.model = { command, note }
 * is an optional extra, clearly advisory: run only with --model-grader, recorded beside the result, never deciding it.
 *
 * A try: a fresh git repo at the case's commit with the harness files of --harness <ref> laid over it (default: this
 * checkout's HEAD) and studio/bench/ left out, one parentless start commit (no history, so no later commit that
 * solved the task), the task on its board and its brief as the task's hand-off note. Then the agent the normal way:
 * `node harness/agent.mjs start --role builder --task <ID> --one-task` with the studio's configured tool and model
 * (STUDIO_BENCH_AGENT_CMD replaces it, for tests: a custom command with {case} {try} {task} {copy} filled in). The
 * case's tokenCap goes in as the task budget (STUDIO_TASK_MAX_TOKENS) and the daily cap of that copy, its timeoutMin as
 * STUDIO_TASK_MAX_MIN and as a hard stop for the whole session; a try that went over either fails. Then the grader.
 *
 * Who may run it: a real run costs tokens. It refuses without --by <person> (harness/permission.mjs: a person, or a
 * Producer/Director session or an agent outside the harness with --permission "<the person's words or a link>";
 * worker sessions never), prints the token ceiling (cases x k x tokenCap) and needs --yes to start. A bench copy's
 * own sessions are refused (no bench inside a bench). A run holds machine:heavy (harness/heavy.mjs) for its whole
 * length when that lock exists, and runs at most bench.json's parallel tries at once.
 *
 * Never changes the studio's config: --without sets one existing off-switch in the measured agent's environment only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { mainRoot, nodeModuleDirs, linkDir } from './worktree.mjs';
import { matchAny } from './merge-lane.mjs';
import { DEFAULT_PROTECTED } from './approve.mjs';
import { agentOnPermission, permissionText, AGENT_SHELL } from './permission.mjs';
import { agentLikeName, launchedSession } from './agent-env.mjs';
import { weightedTokens } from './budget.mjs';
import { fillCommand } from './launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BENCH_REL = 'studio/bench';
export const DEFAULTS = { k: 3, parallel: 1, tokenCap: 2_000_000, timeoutMin: 60, graderTimeoutMin: 15 };
/** The fewest paired cases (all differing one way) that can reach p < 0.05 in a two-sided sign test: 2/2^6 = 0.031. */
export const MIN_CASES = 6;
const MARKER = 'studio-bench.json'; // in a bench copy's .git: a bench never runs inside a bench

/**
 * Guardrails --without can switch off: only switches the harness already has (the env var and value its own code
 * reads). `where` is the file that reads it; `bench components` and --without check the switch is still there.
 * Not here: the task budget (STUDIO_TASK_BUDGET), which is how the bench enforces its own token cap.
 */
export const COMPONENTS = {
  'weakened-tests': { env: { STUDIO_WEAKENED_TESTS: 'off' }, where: 'harness/test-weakening.mjs', what: 'the weakened-tests gate: a removed assert, a .skip or a wider tolerance fails task done until the owner signs it' },
  'hooks-check': { env: { STUDIO_HOOKS_CHECK: 'off' }, where: 'harness/hook-stamp.mjs', what: 'the hooks gate: commits that skipped the git hooks are listed and fail' },
  breaker: { env: { STUDIO_BREAKER: 'off' }, where: 'harness/breaker.mjs', what: 'the breaker: a task handed back twice for the same reason is parked for a person' },
  stall: { env: { STUDIO_STALL: 'off' }, where: 'harness/stall.mjs', what: 'the stall check: a session with no progress (or past its time) is ended' },
  'session-refresh': { env: { STUDIO_SESSION_TURNS: '0', STUDIO_SESSION_CONTEXT: '0' }, where: 'harness/session-cap.mjs', what: 'the session refresh: hand off and start fresh at 40 turns or 120k tokens of context' },
  'auto-finish': { env: { STUDIO_AUTO_FINISH: 'off' }, where: 'harness/agent.mjs', what: 'the launcher\'s finish: a session that committed but never ran task done gets the foreground verify and done' },
  'loop-handbacks': { env: { STUDIO_LOOP_HANDBACKS: '0' }, where: 'harness/agent.mjs', what: 'the loop stop: a task handed back three times in two hours is parked with its last note' },
  'visual-gate': { env: { STUDIO_VISUAL_GATE: 'off' }, where: 'harness/task.mjs', what: 'the visual gate: a render task needs a visual result before done' },
  'silent-green': { env: { STUDIO_SILENT_GREEN: 'off' }, where: 'harness/silent-green.mjs', what: 'the silent-green check: a passing test run that ran nothing is flagged' },
  'lane-copies': { env: { STUDIO_WORKTREES: 'off' }, where: 'harness/worktree.mjs', what: 'lane copies: each agent works in its own git worktree and lands through task done' },
  'merge-train': { env: { STUDIO_TRAIN: 'off' }, where: 'harness/train.mjs', what: 'the merge train: finished lanes land together after one verify of the combined tree' },
};

/** Is a component's off-switch still read by the harness at `root`? { ok, why }. */
export function componentPresent(name, root = REPO_ROOT) {
  const c = COMPONENTS[name];
  if (!c) return { ok: false, why: `no component "${name}" (npm run bench -- components lists them)` };
  let text = '';
  try { text = fs.readFileSync(path.join(root, c.where), 'utf8'); } catch { return { ok: false, why: `${c.where} is missing, so ${Object.keys(c.env).join(', ')} switches nothing` }; }
  const missing = Object.keys(c.env).filter((k) => !text.includes(k));
  return missing.length ? { ok: false, why: `${c.where} no longer reads ${missing.join(', ')}` } : { ok: true, why: '' };
}

// ---- small helpers ----
const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
const posix = (p) => String(p).split(path.sep).join('/');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const round = (x, d = 3) => Math.round(Number(x || 0) * 10 ** d) / 10 ** d;

export const benchDir = (root = mainRoot(), env = process.env) => (env.STUDIO_BENCH_DIR ? path.resolve(env.STUDIO_BENCH_DIR) : path.join(root, BENCH_REL));
export const casesDir = (root, env) => path.join(benchDir(root, env), 'cases');
export const runsDir = (root = mainRoot()) => path.join(root, '.studio', 'bench');
export const benchSettings = (root, env = process.env) => ({ ...DEFAULTS, ...(readJson(path.join(benchDir(root, env), 'bench.json')) || {}) });

/** Is this checkout a bench copy? (A bench never runs inside one, and its agent can't reach the cases from there.) */
export const insideBenchCopy = (root = REPO_ROOT) => fs.existsSync(path.join(root, '.git', MARKER));

/** Cases: [{ ...case, file, problems: [] }], sorted by id. */
export function readCases(root = mainRoot(), env = process.env) {
  const dir = casesDir(root, env);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
  return names.map((n) => {
    const file = path.join(dir, n);
    const c = readJson(file);
    if (!c || typeof c !== 'object') return { id: n.replace(/\.json$/, ''), file, problems: ['not readable JSON'] };
    return { ...c, id: c.id || n.replace(/\.json$/, ''), file, problems: caseProblems(c) };
  });
}

/** What makes a case unusable (empty when it is fine). */
export function caseProblems(c) {
  const p = [];
  if (!c.id || slug(c.id) !== c.id) p.push('id must be lower-case letters, digits, . _ -');
  if (!/^[0-9a-f]{7,40}$/i.test(String(c.commit || ''))) p.push('commit must be a commit sha');
  if (!String(c.brief || '').trim()) p.push('no brief');
  const g = c.grader || {};
  if (![...list(g.pass), ...list(g.fail)].length && !list(g.mustChange).length) p.push('no code grader: give grader.pass / grader.fail commands or grader.mustChange');
  if (!(Number(c.tokenCap) > 0)) p.push('tokenCap must be a positive number');
  if (!(Number(c.timeoutMin) > 0)) p.push('timeoutMin must be a positive number');
  return p;
}

/** A hash of what a case is (its JSON and hidden files), so compare only pairs a case with itself. */
export function caseHash(root, c, env = process.env) {
  const h = crypto.createHash('sha256');
  const { file, problems, ...rest } = c;
  h.update(JSON.stringify(rest));
  const hid = path.join(casesDir(root, env), c.id, 'files');
  for (const f of walkFiles(hid)) h.update(`\0${posix(path.relative(hid, f))}\0`).update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}
function walkFiles(dir) {
  const out = [];
  const go = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) go(f); else if (e.isFile()) out.push(f); } };
  go(dir);
  return out.sort();
}

// ---- who may spend tokens ----
/**
 * May this caller run the bench (or add a case)? { ok, why, by, permission, recordedBy }. harness/permission.mjs's rules:
 * a person (--by <their name>, no agent marker), or a Producer/Director session or an agent outside the harness with
 * --permission "<the person's words or a link>". A worker session never; a bench copy's sessions never.
 */
export function mayRun({ by, permission, env = process.env, root = REPO_ROOT, what = 'run the bench' } = {}) {
  if (insideBenchCopy(root)) return { ok: false, why: `this is a bench copy: the agent being measured can't ${what}` };
  const who = String(by || '').trim();
  const perm = permissionText(permission);
  if (!who) return { ok: false, why: `who is asking? A real run costs tokens: --by <your name> (a person). An agent needs the person's name and their permission: --by <them> --permission "<their words or a link>"` };
  if (agentLikeName(who, { stateDir: path.join(mainRoot(), '.studio') })) return { ok: false, why: `"${who}" is an agent's name; --by names the person who decided to ${what}` };
  if (perm) {
    const p = agentOnPermission({ permission: perm, env });
    if (!p.ok) return { ok: false, why: p.why };
    return { ok: true, by: who, ...(p.via !== 'person' ? { permission: perm.slice(0, 300), recordedBy: p.recordedBy } : {}) };
  }
  const agent = launchedSession(env) || (AGENT_SHELL.find((k) => String(env[k] || '').trim()) ? `this runs in a coding agent's shell (${AGENT_SHELL.find((k) => String(env[k] || '').trim())})` : null);
  if (agent) return { ok: false, why: `${agent}. An agent may ${what} only on a person's direct permission: --by <them> --permission "<their words or a link>" (a Producer or Director session, or an agent outside the harness; never a worker)` };
  return { ok: true, by: who };
}

// ---- the clean copy ----
/** Files that make up "the harness" a run measures (taken from --harness <ref>). */
export const isHarnessPath = (p) => /^(harness|scripts|hub|tools|skills|studio\/roles|studio\/rules|studio\/skills)\//.test(p) || /^qa\/[^/]+\.mjs$/.test(p) || p === 'AGENTS.md' || p === 'AGENTS.lite.md';

/**
 * A parentless commit in the studio's object store: the case commit's tree, with the harness files of `harnessSha`
 * laid over it and the bench folder left out. Returns { ref, sha } (a temporary ref; dropRef removes it).
 */
export function startCommit(root, { commit, harnessSha, sealed = [BENCH_REL], caseId, runId }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bench-idx-'));
  const idx = path.join(tmp, 'index');
  const ident = { GIT_AUTHOR_NAME: 'studio-bench', GIT_AUTHOR_EMAIL: 'bench@studio.local', GIT_COMMITTER_NAME: 'studio-bench', GIT_COMMITTER_EMAIL: 'bench@studio.local' };
  const env = { ...process.env, GIT_INDEX_FILE: idx, ...ident };
  try {
    const rt = git(root, ['read-tree', commit], { env });
    if (rt.status !== 0) throw new Error(`git read-tree ${commit} failed: ${(rt.stderr || '').trim()}`);
    const inIndex = git(root, ['ls-files', '-z'], { env }).stdout.split('\0').filter(Boolean);
    const sealedHit = (p) => sealed.some((s) => p === s || p.startsWith(`${s}/`));
    const lines = [];
    const drop = (p) => lines.push(`0 ${'0'.repeat(40)}\t${p}`);
    for (const p of inIndex) if (sealedHit(p) || (harnessSha && isHarnessPath(p))) drop(p);
    if (harnessSha) {
      for (const rec of git(root, ['ls-tree', '-r', '-z', harnessSha]).stdout.split('\0').filter(Boolean)) {
        const p = rec.slice(rec.indexOf('\t') + 1);
        if (isHarnessPath(p) && !sealedHit(p)) lines.push(rec);
      }
    }
    if (lines.length) {
      const ui = git(root, ['update-index', '-z', '--index-info'], { env, input: lines.map((l) => `${l}\0`).join('') });
      if (ui.status !== 0) throw new Error(`git update-index failed: ${(ui.stderr || '').trim()}`);
    }
    const tree = git(root, ['write-tree'], { env }).stdout.trim();
    const sha = git(root, ['commit-tree', tree, '-m', `bench start: ${caseId} at ${commit.slice(0, 12)}${harnessSha ? `, harness ${harnessSha.slice(0, 12)}` : ''}`], { env }).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('git commit-tree failed');
    const ref = `refs/studio-bench/${slug(runId)}/${slug(caseId)}`;
    git(root, ['update-ref', ref, sha]);
    return { ref, sha };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
export const dropRef = (root, ref) => git(root, ['update-ref', '-d', ref]);

/**
 * A clean copy at `ref`: its own git repo (no history, its own board and .studio), node_modules linked, .env
 * copied, the hooks path as the studio has it, and the task on its board with the brief as its hand-off note.
 * Returns { dir, start, taskId }.
 */
export function makeCopy(root, { ref, dir, c, taskId, runId, tryNo }) {
  fs.mkdirSync(dir, { recursive: true });
  const steps = [['init', '-q'], ['fetch', '-q', '--no-tags', root, ref], ['checkout', '-q', '-b', 'bench', 'FETCH_HEAD']];
  for (const s of steps) {
    const r = git(dir, s);
    if (r.status !== 0) throw new Error(`git ${s[0]} in the bench copy failed: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  fs.writeFileSync(path.join(dir, '.git', MARKER), `${JSON.stringify({ run: runId, case: c.id, try: tryNo })}\n`);
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '\n/.env\nnode_modules\n/.studio/\n/.lanes/\n');
  for (const rel of nodeModuleDirs(root)) if (!fs.existsSync(path.join(dir, rel)) && fs.existsSync(path.dirname(path.join(dir, rel)))) linkDir(path.join(root, rel), path.join(dir, rel));
  try { if (fs.existsSync(path.join(root, '.env'))) fs.copyFileSync(path.join(root, '.env'), path.join(dir, '.env')); } catch {}
  const hooks = git(root, ['config', '--get', 'core.hooksPath']).stdout.trim();
  if (hooks && !path.isAbsolute(hooks)) git(dir, ['config', 'core.hooksPath', hooks]);
  // The task: on the board (any line for that id taken out first) with the case's brief as its hand-off note.
  const board = (rel, fn) => { const f = path.join(dir, rel); if (fs.existsSync(f)) fs.writeFileSync(f, fn(fs.readFileSync(f, 'utf8'))); };
  const notMine = (t) => t.split(/\r?\n/).filter((l) => !l.includes(`**${taskId}**`)).join('\n');
  board('studio/DONE.md', notMine);
  const line = `- [ ] **${taskId}** [P1] (\`${c.role || 'builder'}\`) — ${String(c.from?.title || c.brief).split(/\r?\n/)[0].slice(0, 160)}`;
  const next = path.join(dir, 'studio', 'NEXT.md');
  let text = fs.existsSync(next) ? notMine(fs.readFileSync(next, 'utf8')) : '# Studio Task Queue (`studio/NEXT.md`)\n\n## IN_PROGRESS\n\n## BACKLOG\n\n## DONE\n';
  text = /^##\s+BACKLOG.*$/m.test(text) ? text.replace(/^##\s+BACKLOG.*$/m, (h) => `${h}\n${line}`) : `${text.trimEnd()}\n\n## BACKLOG\n${line}\n`;
  fs.mkdirSync(path.dirname(next), { recursive: true });
  fs.writeFileSync(next, text);
  fs.mkdirSync(path.join(dir, 'studio', 'handoffs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio', 'handoffs', `${taskId}.md`), `# ${taskId}\n\n${String(c.brief).trim()}\n`);
  const id = ['-c', 'user.name=studio-bench', '-c', 'user.email=bench@studio.local', '-c', 'core.hooksPath=.git/no-hooks'];
  git(dir, ['add', '-A', '--', 'studio']);
  git(dir, [...id, 'commit', '-q', '--no-verify', '--allow-empty', '-m', `bench: ${taskId} on the board`]);
  return { dir, start: git(dir, ['rev-parse', 'HEAD']).stdout.trim(), taskId };
}

/** Files changed in a copy since `start`: committed, staged, unstaged and untracked. */
export function changedFiles(dir, start) {
  const a = git(dir, ['diff', '--name-only', '--no-renames', start]).stdout.split('\n');
  const b = git(dir, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n');
  return [...new Set([...a, ...b].map((x) => x.trim()).filter(Boolean))].sort();
}

// ---- running things ----
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); return; }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}
/** Run a command (a shell line when args is null) without blocking; { code, out, timedOut, ms }. */
export function runCmd(cmd, args, { cwd, env, timeoutMs = 0, logFile = null } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args || [], { cwd, env, shell: args === null, detached: process.platform !== 'win32', windowsHide: true });
    } catch (err) {
      resolve({ code: 127, out: String(err.message), timedOut: false, ms: 0 });
      return;
    }
    const add = (b) => { const s = String(b); out += s; if (out.length > 4e6) out = out.slice(-2e6); if (logFile) { try { fs.appendFileSync(logFile, s); } catch {} } };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs) : null;
    child.on('error', (err) => add(`\n${err.message}\n`));
    child.on('close', (code, signal) => { if (timer) clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), out, timedOut, ms: Date.now() - t0 }); });
  });
}

/** What a session used: from the copy's own events (agent.mjs writes agent.session.end), else the tool's own report. */
export async function usageOf(copy, out) {
  let tokens = 0;
  let turns = 0;
  let seen = false;
  const f = path.join(copy, '.studio', 'events.jsonl');
  if (fs.existsSync(f)) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l.includes('agent.session.end')) continue;
      try { const e = JSON.parse(l); if (e.type === 'agent.session.end') { seen = true; tokens += weightedTokens(e); turns += Number(e.meta?.turns) || 0; } } catch {}
    }
  }
  if (!seen) {
    const { tokensFrom } = await import('./agent.mjs');
    const t = tokensFrom(out);
    tokens = weightedTokens({ tokensIn: t.tokensIn, tokensOut: t.tokensOut, cacheRead: t.cacheRead });
    turns = Number(t.turns) || 0;
  }
  return { tokens: Math.round(tokens), turns };
}

/** The environment the measured agent gets: the person's, minus whatever ties it to the studio or to this run. */
export function agentEnvFor({ copy, start, c, without = null, env = process.env }) {
  const e = { ...env };
  for (const k of ['STUDIO_MAIN_ROOT', 'STUDIO_ROLE', 'STUDIO_LOCK_OWNER', 'STUDIO_AGENT', 'AGENT_EVENTS_FILE', 'AGENT_EVENTS_MIRROR', 'STUDIO_BENCH_DIR', 'STUDIO_BENCH_COPIES', 'STUDIO_BENCH_AGENT_CMD', 'STUDIO_PROTECT_ROOT', 'STUDIO_HEAVY_HELD', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k];
  Object.assign(e, {
    STUDIO_MAIN_ROOT: copy,
    STUDIO_PROTECT_BASE: start,
    STUDIO_TASK_BUDGET: 'on',
    STUDIO_TASK_MAX_TOKENS: String(c.tokenCap),
    STUDIO_TASK_MAX_MIN: String(c.timeoutMin),
    STUDIO_DAILY_TOKEN_CAP: String(c.tokenCap),
  });
  if (without) Object.assign(e, COMPONENTS[without].env);
  return e;
}

// ---- grading ----
/** Grade a finished try by code. { pass, why, checks, changed, extra }. */
export async function grade(root, { copy, start, c, env, modelGrader = false, logFile = null }) {
  const g = c.grader || {};
  const changed = changedFiles(copy, start);
  const checks = [];
  const fails = [];
  const protectedList = g.allowProtected ? [] : (readJson(path.join(copy, 'studio', 'protected.json'))?.globs || DEFAULT_PROTECTED);
  const notTouch = [...list(g.mustNotChange), ...protectedList];
  const bad = changed.filter((f) => matchAny(f, notTouch));
  if (bad.length) fails.push(`changed files it must not: ${bad.slice(0, 5).join(', ')}`);
  checks.push({ kind: 'must-not-change', ok: !bad.length, files: bad.slice(0, 20) });
  for (const glob of list(g.mustChange)) {
    const hit = changed.some((f) => matchAny(f, [glob]));
    checks.push({ kind: 'must-change', glob, ok: hit });
    if (!hit) fails.push(`nothing changed under ${glob}`);
  }
  // Hidden files (the task's own tests from its solution) go in only now, after the agent is gone.
  const hid = path.join(casesDir(root, env), c.id, 'files');
  for (const f of walkFiles(hid)) {
    const to = path.join(copy, path.relative(hid, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  const genv = { ...env };
  for (const k of ['STUDIO_ROLE', 'STUDIO_LOCK_OWNER', 'STUDIO_AGENT', 'STUDIO_BENCH_AGENT_CMD', 'STUDIO_HEAVY_HELD']) delete genv[k];
  genv.STUDIO_MAIN_ROOT = copy;
  const limit = (Number(g.timeoutMin) || DEFAULTS.graderTimeoutMin) * 60000;
  for (const [want, cmds] of [['pass', list(g.pass)], ['fail', list(g.fail)]]) {
    for (const cmd of cmds) {
      if (logFile) fs.appendFileSync(logFile, `\n[bench] grader (${want}): ${cmd}\n`);
      const r = await runCmd(cmd, null, { cwd: copy, env: genv, timeoutMs: limit, logFile });
      const ok = !r.timedOut && (want === 'pass' ? r.code === 0 : r.code !== 0);
      checks.push({ kind: want, cmd, code: r.code, timedOut: r.timedOut || undefined, ok });
      if (!ok) fails.push(r.timedOut ? `grader timed out: ${cmd}` : want === 'pass' ? `must pass, exited ${r.code}: ${cmd}` : `must fail, passed: ${cmd}`);
    }
  }
  // The optional model grader: advisory only, never part of pass/fail.
  const extra = [];
  if (g.model) {
    if (modelGrader && g.model.command) {
      const r = await runCmd(String(g.model.command), null, { cwd: copy, env: genv, timeoutMs: limit, logFile });
      extra.push({ kind: 'model (advisory, not counted)', cmd: g.model.command, code: r.code, said: r.out.trim().split('\n').slice(-3).join(' ').slice(0, 300) });
    } else extra.push({ kind: 'model (advisory, not counted)', skipped: 'not run (--model-grader runs it)' });
  }
  return { pass: !fails.length, why: fails.join('; ') || 'every check passed', checks, changed: changed.slice(0, 100), extra };
}

// ---- scores ----
/** Per-case and overall scores from tries: pass@1 = mean success rate over cases; pass^k = share of cases where every try passed. */
export function score(tries) {
  const by = new Map();
  for (const t of tries) { if (!by.has(t.case)) by.set(t.case, []); by.get(t.case).push(t); }
  const perCase = {};
  for (const [id, ts] of by) {
    const passes = ts.filter((t) => t.pass).length;
    const mean = (k) => ts.reduce((n, t) => n + (Number(t[k]) || 0), 0) / ts.length;
    perCase[id] = { tries: ts.length, passes, rate: round(passes / ts.length, 4), allPass: passes === ts.length, tokens: Math.round(mean('tokens')), turns: round(mean('turns'), 1), minutes: round(mean('minutes'), 2) };
  }
  const cs = Object.values(perCase);
  return { perCase, pass1: cs.length ? round(cs.reduce((n, c) => n + c.rate, 0) / cs.length, 4) : 0, passK: cs.length ? round(cs.filter((c) => c.allPass).length / cs.length, 4) : 0, cases: cs.length };
}

/** Two-sided exact sign test: p for n+ cases better and n- worse (ties left out). */
export function signTest(plus, minus) {
  const n = plus + minus;
  if (!n) return 1;
  const k = Math.min(plus, minus);
  let c = 1;
  let sum = 0;
  for (let i = 0; i <= k; i += 1) { if (i > 0) c = (c * (n - i + 1)) / i; sum += c; }
  return Math.min(1, (2 * sum) / 2 ** n);
}

/** Paired comparison of two runs' results. B is the one being judged against A. */
export function compareRuns(A, B, { alpha = 0.05 } = {}) {
  const pa = A.score?.perCase || {};
  const pb = B.score?.perCase || {};
  const ha = A.caseHashes || {};
  const hb = B.caseHashes || {};
  const paired = [];
  const left = [];
  for (const id of Object.keys(pa)) {
    if (!pb[id]) continue;
    if (ha[id] && hb[id] && ha[id] !== hb[id]) { left.push(`${id} (the case changed between the runs)`); continue; }
    paired.push({ id, a: pa[id], b: pb[id], d: pb[id].rate - pa[id].rate });
  }
  const plus = paired.filter((p) => p.d > 0).length;
  const minus = paired.filter((p) => p.d < 0).length;
  const p = signTest(plus, minus);
  const mean = (k, side) => (paired.length ? paired.reduce((n, x) => n + (Number(x[side][k]) || 0), 0) / paired.length : 0);
  const delta = Object.fromEntries(['tokens', 'turns', 'minutes'].map((k) => [k, { a: round(mean(k, 'a'), 2), b: round(mean(k, 'b'), 2), d: round(mean(k, 'b') - mean(k, 'a'), 2) }]));
  const s = (r, set) => { const ids = new Set(set.map((x) => x.id)); const cs = Object.entries(r).filter(([id]) => ids.has(id)).map(([, c]) => c); return { pass1: cs.length ? round(cs.reduce((n, c) => n + c.rate, 0) / cs.length, 4) : 0, passK: cs.length ? round(cs.filter((c) => c.allPass).length / cs.length, 4) : 0 }; };
  const enough = paired.length >= MIN_CASES;
  const verdict = !enough ? 'no difference' : p < alpha ? (plus > minus ? 'better' : 'worse') : 'no difference';
  return { paired: paired.length, plus, minus, ties: paired.length - plus - minus, p: round(p, 4), alpha, enough, verdict, a: s(pa, paired), b: s(pb, paired), delta, left, cases: paired.map((x) => ({ id: x.id, a: x.a.rate, b: x.b.rate })) };
}

/** The component line for a --without run against a baseline (or null when it isn't one). */
export function componentLine(A, B, cmp) {
  const wa = A.without || null;
  const wb = B.without || null;
  if (wa === wb || (wa && wb)) return null;
  const name = wb || wa;
  // Read every verdict as "the run without the component, against the run with it".
  const v = wb ? cmp.verdict : cmp.verdict === 'better' ? 'worse' : cmp.verdict === 'worse' ? 'better' : cmp.verdict;
  const tok = wb ? cmp.delta.tokens.d : -cmp.delta.tokens.d;
  if (!cmp.enough) return `component ${name}: not enough cases to say whether it still pays for itself (${cmp.paired} paired, ${MIN_CASES} needed)`;
  if (v === 'worse') return `component ${name}: still pays for itself (without it the bench did worse, p = ${cmp.p})`;
  if (v === 'better') return `component ${name}: the bench did better without it (p = ${cmp.p}); the owner decides whether to retire it (nothing was changed)`;
  return `component ${name}: no measurable difference without it (p = ${cmp.p})${tok < 0 ? `, and ${fmt(Math.round(-tok))} fewer tokens per try` : ''}; it may no longer pay for itself. The owner decides (nothing was changed)`;
}

// ---- the run ----
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Resolve which cases a run takes, and refuse unusable ones. { cases, error }. */
export function pickCases(root, wanted = [], env = process.env) {
  const all = readCases(root, env);
  if (!all.length) return { error: `no bench cases in ${posix(path.relative(root, casesDir(root, env))) || casesDir(root, env)} (npm run bench -- add --from <task> --by <you>)` };
  const ids = list(wanted);
  const unknown = ids.filter((id) => !all.some((c) => c.id === id));
  if (unknown.length) return { error: `no such case: ${unknown.join(', ')}` };
  const cases = ids.length ? all.filter((c) => ids.includes(c.id)) : all;
  const broken = cases.filter((c) => c.problems.length);
  if (broken.length) return { error: `case(s) not usable: ${broken.map((c) => `${c.id} (${c.problems.join('; ')})`).join('; ')}` };
  return { cases };
}

/** Estimated ceiling: sum over cases of k x tokenCap. */
export const tokenCeiling = (cases, k) => cases.reduce((n, c) => n + Number(c.tokenCap) * k, 0);

export async function runBench(opts = {}, { log = console.log, env = process.env } = {}) {
  const root = mainRoot();
  const settings = benchSettings(root, env);
  const k = Math.max(1, Math.floor(Number(opts.k) || Number(settings.k) || DEFAULTS.k));
  const who = mayRun({ by: opts.by, permission: opts.permission, env, root: REPO_ROOT });
  if (!who.ok) return { code: 1, text: `Not run: ${who.why}.` };
  const without = opts.without ? String(opts.without) : null;
  if (without) {
    const pres = componentPresent(without, root);
    if (!pres.ok) return { code: 1, text: `Not run: ${pres.why}. --without only uses an off-switch the harness already has.` };
  }
  const pick = pickCases(root, opts.cases, env);
  if (pick.error) return { code: 1, text: `Not run: ${pick.error}.` };
  const { cases } = pick;
  const harnessRef = opts.harness || 'HEAD';
  const harnessSha = git(root, ['rev-parse', '--verify', `${harnessRef}^{commit}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(harnessSha)) return { code: 1, text: `Not run: --harness ${harnessRef} is not a commit in this studio.` };
  for (const c of cases) if (git(root, ['cat-file', '-e', `${c.commit}^{commit}`]).status !== 0) return { code: 1, text: `Not run: case ${c.id}'s commit ${c.commit} isn't in this studio's git history (fetch it first).` };
  const ceiling = tokenCeiling(cases, k);
  // A switch already off in this shell would make a "baseline" a run without that component: say so, and record it.
  const offInEnv = Object.entries(COMPONENTS).filter(([n, c]) => n !== without && Object.entries(c.env).every(([key, v]) => String(env[key] ?? '') === v)).map(([n]) => n);
  if (offInEnv.length) log(`[bench] note: this shell already switches off ${offInEnv.join(', ')} (its STUDIO_* settings); the agents run without ${offInEnv.length === 1 ? 'it' : 'them'} too, and the results say so.`);
  log(`[bench] ${cases.length} case(s) x ${k} tries = ${cases.length * k} agent sessions; token ceiling ${fmt(ceiling)} weighted tokens (cases x k x tokenCap).`);
  log('[bench] Each try is stopped at its own tokenCap and timeoutMin; tokens are counted when a session reports them (at its end), so one session can go somewhat past its cap before it is stopped.');
  if (!opts.yes) return { code: 2, text: '[bench] Nothing started. Add --yes to spend up to that many tokens.' };
  const parallel = Math.max(1, Math.min(Number(opts.parallel) || Number(settings.parallel) || 1, Number(settings.parallel) || 1));
  const runId = `${stamp()}-${slug(opts.label || (without ? `without-${without}` : harnessRef)) || 'run'}`;
  const out = path.join(runsDir(root), runId);
  fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
  const copiesRoot = path.join(env.STUDIO_BENCH_COPIES ? path.resolve(env.STUDIO_BENCH_COPIES) : path.join(os.tmpdir(), 'studio-bench'), runId);
  const res = {
    id: runId, label: opts.label || null, by: who.by, ...(who.permission ? { permission: who.permission, recordedBy: who.recordedBy } : {}),
    at: new Date().toISOString(), harness: { ref: harnessRef, sha: harnessSha }, without, withoutEnv: without ? COMPONENTS[without].env : null, offInEnv,
    k, parallel, agent: env.STUDIO_BENCH_AGENT_CMD ? 'STUDIO_BENCH_AGENT_CMD (a stand-in)' : 'harness/agent.mjs start (the studio\'s configured tool and model)',
    cases: cases.map((c) => c.id), caseHashes: Object.fromEntries(cases.map((c) => [c.id, caseHash(root, c, env)])), tokenCeiling: ceiling, tries: [], done: false,
  };
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(res, null, 2)}\n`);
  save();
  emitEvent({ type: 'bench.run', agent: who.by, status: 'info', msg: `Bench run ${runId} started by ${who.by}${who.recordedBy ? ` (recorded by ${who.recordedBy} on their permission)` : ''}: ${cases.length} case(s) x ${k}${without ? `, without ${without}` : ''}, harness ${harnessSha.slice(0, 8)}, ceiling ${fmt(ceiling)} tokens`, meta: { run: runId, without, ceiling } });

  // machine:heavy for the whole run, when this harness has the lock (another release may change heavy.mjs).
  let heavy = null;
  try {
    const h = await import(pathToFileURL(path.join(HERE, 'heavy.mjs')).href);
    if (typeof h.acquireHeavy === 'function') heavy = h.acquireHeavy(root, `bench run ${runId}`, { log: (m) => log(m), owner: who.by });
  } catch (err) {
    if (err?.code === 'HEAVY_BUSY') { res.error = err.message; save(); return { code: 3, text: err.message }; }
  }
  const starts = new Map();
  try {
    for (const c of cases) starts.set(c.id, startCommit(root, { commit: c.commit, harnessSha, caseId: c.id, runId }));
    const jobs = cases.flatMap((c) => Array.from({ length: k }, (_, i) => ({ c, tryNo: i + 1 })));
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const t = await runTry(root, { ...job, runId, start: starts.get(job.c.id), copiesRoot, out, without, env, keep: opts.keep, modelGrader: opts.modelGrader, log });
        res.tries.push(t);
        save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  } finally {
    for (const s of starts.values()) dropRef(root, s.ref);
    heavy?.release?.();
    if (!opts.keep) try { fs.rmSync(copiesRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {}
  }
  res.tries.sort((a, b) => a.case.localeCompare(b.case) || a.try - b.try);
  res.score = score(res.tries);
  res.done = true;
  res.finishedAt = new Date().toISOString();
  save();
  emitEvent({ type: 'bench.run', agent: who.by, status: 'ok', msg: `Bench run ${runId}: pass@1 ${pct(res.score.pass1)}, pass^${k} ${pct(res.score.passK)} over ${res.score.cases} case(s)`, meta: { run: runId, pass1: res.score.pass1, passK: res.score.passK } });
  return { code: 0, text: summary(res, path.join(out, 'results.json')), results: res };
}

async function runTry(root, { c, tryNo, runId, start, copiesRoot, out, without, env, keep, modelGrader, log }) {
  const name = `${c.id}-${tryNo}`;
  const logFile = path.join(out, 'logs', `${name}.log`);
  const copy = path.join(copiesRoot, name);
  const taskId = /^[A-Z]+-\d+$/.test(String(c.from?.task || '')) ? c.from.task : 'T-900';
  const t = { case: c.id, try: tryNo, pass: false, why: '', tokens: 0, turns: 0, minutes: 0, exit: null, timedOut: false, overCap: false };
  try {
    const made = makeCopy(root, { ref: start.ref, dir: copy, c, taskId, runId, tryNo });
    const aenv = agentEnvFor({ copy, start: made.start, c, without, env });
    const limitMs = Number(c.timeoutMin) * 60000;
    let r;
    if (env.STUDIO_BENCH_AGENT_CMD) {
      const line = fillCommand(env.STUDIO_BENCH_AGENT_CMD, { case: c.id, try: String(tryNo), task: taskId, copy });
      r = await runCmd(line, null, { cwd: copy, env: aenv, timeoutMs: limitMs, logFile });
    } else {
      r = await runCmd(process.execPath, [path.join('harness', 'agent.mjs'), 'start', '--role', c.role || 'builder', '--agent', `builder-bench${tryNo}`, '--task', taskId, '--one-task'], { cwd: copy, env: aenv, timeoutMs: limitMs, logFile });
    }
    const use = await usageOf(copy, r.out);
    Object.assign(t, { exit: r.code, timedOut: r.timedOut, minutes: round(r.ms / 60000, 2), tokens: use.tokens, turns: use.turns, overCap: use.tokens > Number(c.tokenCap) });
    // A session stopped at its timeout may never have reported what it used: say so instead of counting 0 as known.
    if (r.timedOut && !use.tokens) t.tokensUnknown = true;
    const g = await grade(root, { copy, start: made.start, c, env, modelGrader, logFile });
    Object.assign(t, { checks: g.checks, changed: g.changed, ...(g.extra.length ? { extra: g.extra } : {}) });
    const why = [];
    if (r.timedOut) why.push(`stopped at its timeout (${c.timeoutMin} min)`);
    if (t.overCap) why.push(`over its token cap (${fmt(t.tokens)} > ${fmt(c.tokenCap)})`);
    if (!g.pass) why.push(g.why);
    t.pass = !why.length;
    t.why = why.join('; ') || g.why;
    if (keep) t.copy = copy;
  } catch (err) {
    t.why = `the try could not run: ${err.message}`;
  } finally {
    if (!keep) try { fs.rmSync(copy, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {}
  }
  log(`[bench] ${name}: ${t.pass ? 'PASS' : 'FAIL'} (${fmt(t.tokens)} tokens, ${t.turns} turns, ${t.minutes} min)${t.pass ? '' : ` ${t.why}`}`);
  return t;
}

export function summary(res, file = null) {
  const s = res.score;
  const lines = [`Bench run ${res.id}${res.without ? ` without ${res.without}` : ''} (harness ${res.harness.sha.slice(0, 8)}, k=${res.k}, by ${res.by}):`];
  for (const [id, c] of Object.entries(s.perCase)) lines.push(`  ${id}: ${c.passes}/${c.tries} passed, ${fmt(c.tokens)} tokens, ${c.turns} turns, ${c.minutes} min per try`);
  lines.push(`pass@1 ${pct(s.pass1)}   pass^${res.k} ${pct(s.passK)}   over ${s.cases} case(s)`);
  if (file) lines.push(`Results: ${posix(path.relative(process.cwd(), file)) || file}`);
  return lines.join('\n');
}

/** A run by id (in .studio/bench/) or by path to its results.json. */
export function loadRun(ref, root = mainRoot()) {
  const tries = [ref, path.join(ref, 'results.json'), path.join(runsDir(root), ref, 'results.json')];
  for (const f of tries) { const r = fs.existsSync(f) && fs.statSync(f).isFile() ? readJson(f) : null; if (r?.score) return r; }
  return null;
}

export function compareText(A, B, cmp) {
  const L = [`Compare ${A.id} (A) with ${B.id} (B): ${cmp.paired} paired case(s)${cmp.left.length ? `; left out: ${cmp.left.join(', ')}` : ''}`];
  if (A.harness?.sha !== B.harness?.sha) L.push(`  harness: A ${A.harness?.sha?.slice(0, 8)}  B ${B.harness?.sha?.slice(0, 8)}`);
  if (A.without || B.without) L.push(`  without: A ${A.without || '-'}  B ${B.without || '-'}`);
  if (String(A.offInEnv || []) !== String(B.offInEnv || [])) L.push(`  note: the runs had different switches off in their shells (A: ${(A.offInEnv || []).join(', ') || 'none'}; B: ${(B.offInEnv || []).join(', ') || 'none'}), so they don't measure only what differs on purpose`);
  for (const c of cmp.cases) L.push(`  ${c.id}: ${pct(c.a)} -> ${pct(c.b)}${c.b > c.a ? '  (B better)' : c.b < c.a ? '  (B worse)' : ''}`);
  L.push(`pass@1: ${pct(cmp.a.pass1)} -> ${pct(cmp.b.pass1)}   pass^k: ${pct(cmp.a.passK)} -> ${pct(cmp.b.passK)}`);
  L.push(`tokens per try: ${fmt(cmp.delta.tokens.a)} -> ${fmt(cmp.delta.tokens.b)} (${cmp.delta.tokens.d >= 0 ? '+' : ''}${fmt(cmp.delta.tokens.d)})   turns: ${cmp.delta.turns.a} -> ${cmp.delta.turns.b} (${cmp.delta.turns.d >= 0 ? '+' : ''}${cmp.delta.turns.d})   minutes: ${cmp.delta.minutes.a} -> ${cmp.delta.minutes.b}`);
  L.push(`sign test: ${cmp.plus} case(s) better, ${cmp.minus} worse, ${cmp.ties} tied; p = ${cmp.p} (two-sided, alpha ${cmp.alpha})`);
  L.push(cmp.enough ? `verdict: ${cmp.verdict}` : `verdict: ${cmp.verdict} (not enough cases: ${cmp.paired} paired; the sign test needs at least ${MIN_CASES} to show a difference)`);
  const comp = componentLine(A, B, cmp);
  if (comp) L.push(comp);
  return L.join('\n');
}

// ---- adding a case from a past task ----
function taskTitle(root, id) {
  for (const rel of ['studio/NEXT.md', 'studio/DONE.md']) {
    let t = '';
    try { t = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    const line = t.split(/\r?\n/).find((l) => l.includes(`**${id}**`));
    if (line) return line.replace(/^.*?\)\s*[—-]\s*/, '').trim() || line.trim();
  }
  return null;
}
/** The task's commits (trailer Studio-Task: <id>, or the id in the subject), oldest first. */
export function taskCommits(root, id) {
  // A fixed-string grep (the same on every git build), then the exact id in JS: T-6 must not match T-67.
  const re = new RegExp(`(^|[^A-Za-z0-9-])${id.replace(/[-]/g, '\\-')}(?![0-9])`);
  return git(root, ['log', '--format=%H%x1f%B%x1e', '--reverse', '-F', `--grep=${id}`, 'HEAD']).stdout.split('\x1e')
    .map((s) => s.trim()).filter((s) => s.includes('\x1f'))
    .map((s) => { const [sha, msg] = s.split('\x1f'); return { sha: sha.trim(), msg }; })
    .filter((c) => c.msg.split('\n').some((l) => /^Studio-Task:/i.test(l) ? re.test(l) : false) || re.test(c.msg.split('\n')[0]))
    .map((c) => c.sha);
}

export function addCase(o, { env = process.env } = {}) {
  const root = mainRoot();
  const who = mayRun({ by: o.by, permission: o.permission, env, root: REPO_ROOT, what: 'add a bench case' });
  if (!who.ok) return { code: 1, text: `Not added: ${who.why}.` };
  const from = String(o.from || '').trim();
  if (!/^[A-Z]+-\d+$/.test(from)) return { code: 1, text: 'Not added: --from <task id> (e.g. T-067).' };
  const id = slug(o.id || from);
  const file = path.join(casesDir(root, env), `${id}.json`);
  if (fs.existsSync(file) && !o.replace) return { code: 1, text: `Not added: case ${id} exists (--replace to write it again).` };
  const commits = taskCommits(root, from);
  let commit = o.commit ? git(root, ['rev-parse', '--verify', `${o.commit}^{commit}`]).stdout.trim() : '';
  if (o.commit && !commit) return { code: 1, text: `Not added: --commit ${o.commit} is not a commit here.` };
  if (!commit && commits.length) commit = git(root, ['rev-parse', '--verify', `${commits[0]}^`]).stdout.trim();
  if (!commit) return { code: 1, text: `Not added: no commit names ${from} (Studio-Task trailer or subject); give the commit it started from: --commit <sha>.` };
  const solution = commits.length ? commits[commits.length - 1] : null;
  let brief = '';
  if (o.briefFile) { try { brief = fs.readFileSync(path.resolve(o.briefFile), 'utf8'); } catch { return { code: 1, text: `Not added: can't read ${o.briefFile}.` }; } }
  if (!brief) { for (const f of [path.join(root, '.studio', 'briefs', `${from}.md`)]) { try { brief = fs.readFileSync(f, 'utf8'); break; } catch {} } }
  const title = taskTitle(root, from);
  if (!brief && title) brief = title;
  if (!brief.trim()) return { code: 1, text: `Not added: no brief for ${from}; write it to a file and pass --brief-file <file>.` };
  const hidden = list(o.hidden);
  const grader = { pass: list(o.pass), fail: list(o.fail), mustChange: list(o.mustChange), mustNotChange: list(o.mustNotChange) };
  for (const k of Object.keys(grader)) if (!grader[k].length) delete grader[k];
  const c = { id, from: { task: from, title: title || null, solution }, commit, brief: brief.trim(), grader, tokenCap: Number(o.tokenCap) || DEFAULTS.tokenCap, timeoutMin: Number(o.timeoutMin) || DEFAULTS.timeoutMin, addedBy: who.by, ...(who.recordedBy ? { permission: who.permission, recordedBy: who.recordedBy } : {}), addedAt: new Date().toISOString() };
  const problems = caseProblems(c);
  const changedByTask = solution ? git(root, ['diff', '--name-only', commit, solution]).stdout.split('\n').filter(Boolean) : [];
  if (problems.length) {
    const tests = changedByTask.filter((f) => /(^|\/)(tests?|__tests__|regressions)\/|\.(test|spec)\.[mc]?[jt]sx?$/.test(f));
    return { code: 1, text: `Not added: ${problems.join('; ')}.${tests.length ? ` The task's own tests (from ${solution.slice(0, 8)}) could be the grader: --hidden ${tests.slice(0, 5).join(',')} --pass "<the command that runs them>"` : ''}` };
  }
  // Hidden files: their content at the task's solution (the tests the agent must make pass, never shown to it).
  const hidDir = path.join(casesDir(root, env), id, 'files');
  if (hidden.length) {
    if (!solution) return { code: 1, text: `Not added: --hidden takes files from the task's last commit, and no commit names ${from}.` };
    fs.rmSync(hidDir, { recursive: true, force: true });
    for (const rel of hidden) {
      const blob = git(root, ['show', `${solution}:${rel}`], { encoding: 'buffer' });
      if (blob.status !== 0) return { code: 1, text: `Not added: ${rel} isn't in ${solution.slice(0, 8)}.` };
      fs.mkdirSync(path.dirname(path.join(hidDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(hidDir, rel), blob.stdout);
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  const rel = posix(path.relative(root, file));
  const inRepo = !rel.startsWith('..');
  return { code: 0, text: `Added bench case ${id} (${from}, from ${commit.slice(0, 8)}; grader: ${[...list(grader.pass).map((x) => `pass "${x}"`), ...list(grader.fail).map((x) => `fail "${x}"`), ...list(grader.mustChange).map((x) => `change ${x}`)].join(', ')}${hidden.length ? `; ${hidden.length} hidden file(s)` : ''}) in ${rel}.${inRepo ? ` ${BENCH_REL}/ is a protected folder: commit it with the owner's signed approval (npm run approve -- protected --note "bench case ${id}").` : ''}` };
}

// ---- CLI ----
function parseArgs(argv) {
  const o = { _: [] };
  const multi = new Set(['pass', 'fail', 'hidden', 'must-change', 'must-not-change', 'cases']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const key = a.slice(2);
    const val = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    const camel = key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (multi.has(key)) (o[camel] ||= []).push(val); else o[camel] = val;
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  const root = mainRoot();
  let r = { code: 0, text: '' };
  if (cmd === 'add') r = addCase(o);
  else if (cmd === 'run') r = await runBench({ ...o, k: o.k, modelGrader: Boolean(o.modelGrader), yes: o.yes === true, keep: o.keep === true });
  else if (cmd === 'list') {
    const cs = readCases(root);
    r.text = cs.length ? cs.map((c) => `${c.id}  ${c.from?.task || '?'}  ${String(c.commit || '').slice(0, 8)}  cap ${fmt(c.tokenCap)}  ${c.timeoutMin} min${c.problems.length ? `  NOT USABLE: ${c.problems.join('; ')}` : ''}`).join('\n') : `No bench cases yet (${posix(path.relative(root, casesDir(root, process.env)))}).`;
  } else if (cmd === 'components') {
    r.text = Object.entries(COMPONENTS).map(([n, c]) => { const p = componentPresent(n, root); return `${n.padEnd(16)} ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')}  ${c.what}${p.ok ? '' : `  (UNAVAILABLE: ${p.why})`}`; }).join('\n');
  } else if (cmd === 'compare') {
    const [a, b] = [loadRun(o._[1] || '', root), loadRun(o._[2] || '', root)];
    if (!a || !b) r = { code: 1, text: `Usage: npm run bench -- compare <runA> <runB> (a run id in .studio/bench/ or a results.json); not found: ${[!a && o._[1], !b && o._[2]].filter((x) => x !== false).join(', ') || 'two runs needed'}` };
    else { const cmp = compareRuns(a, b, { alpha: Number(o.alpha) || 0.05 }); r.text = o.json ? JSON.stringify(cmp, null, 2) : compareText(a, b, cmp); }
  } else if (cmd === 'show') {
    const res = loadRun(o._[1] || '', root);
    r = res ? { code: 0, text: o.json ? JSON.stringify(res, null, 2) : summary(res) } : { code: 1, text: `No finished run ${o._[1] || ''} in .studio/bench/.` };
  } else {
    r = { code: cmd ? 1 : 0, text: 'npm run bench -- add | list | components | run | compare <A> <B> | show <run>   (docs/BENCH.md)' };
  }
  if (r.text) (r.code === 1 ? console.error : console.log)(r.text);
  process.exit(r.code);
}
