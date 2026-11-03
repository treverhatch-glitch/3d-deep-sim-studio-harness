/**
 * harness/gate-trust.mjs — 2.71.1 (A): what the safety gates may trust about the checkout they judge.
 *
 * 1. Env overrides in a lane copy (A09, A16, A01b, G12, S01). STUDIO_PROTECT_BASE, GITHUB_BASE_REF, STUDIO_PROTECT_ROOT
 *    and STUDIO_WEAKENED_TESTS=off change what the protected and weakened-tests gates compare, or switch one off. They
 *    are for the owner's own checkout and CI (which runs the base branch's checker against the PR's checkout). A lane
 *    copy (a git worktree of a studio that uses lane copies: <main>/.lanes/<agent>, or any linked worktree once the main
 *    checkout has a .lanes/ folder) is judged against the studio's branch only, so there they are ignored and the gate
 *    says so. Nothing here reads CI=true or GITHUB_ACTIONS: anyone can set them (S01). STUDIO_MAIN_ROOT counts only
 *    when it names the main worktree `git worktree list` gives for this checkout's repository, never the checkout
 *    itself (G12).
 * 2. Verify records (D01/T04, G15/T02). A record stands in for task done's game checks or a train's verify only when
 *    scripts/run-gates.mjs wrote it: each full verify gets a run id and a run log (.studio/gates/runs/<id>.json) holding
 *    the digest of what it recorded, and a record whose digest doesn't match its run log (hand-written, or edited) is
 *    not reused. 2.73.0 (g): the run log is also signed (HMAC-SHA256) with the studio's verify key, kept outside every
 *    checkout (harness/verify-key.mjs); an unsigned or badly signed one is not reused (a record AND a matching run log
 *    written by hand used to pass). "Clean" also counts untracked files, and ignored files outside build and dependency output, under the
 *    game and the paths the checks read (hiddenInputs): a config left untracked or ignored changes what the checks do.
 *
 * Node built-ins only: approve.mjs, hook-stamp.mjs and test-weakening.mjs import this while their own top level runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { signPayload, checkSignature } from './verify-key.mjs';

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM)$/.test(k)));
const git = (cwd, args) => {
  try {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', env: gitEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout) : null;
  } catch { return null; }
};
const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
export const realPath = (p) => { try { return norm(fs.realpathSync.native(p)); } catch { return norm(path.resolve(p)); } };
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

// ---- 1. which checkout is this, and which overrides it may use ----

const kinds = new Map();
/**
 * { kind: 'main' | 'lane' | 'worktree' | 'none', top, main, worktrees }. 'lane': a linked worktree at <main>/.lanes/<x>,
 * or any linked worktree of a main checkout that has a .lanes/ folder (a studio using lane copies; the train's scratch
 * copies count too). 'worktree': a linked worktree of a repository without lane copies (CI's base copy).
 */
export function checkoutKind(dir) {
  const key = realPath(dir);
  if (kinds.has(key)) return kinds.get(key);
  let res = { kind: 'none', top: null, main: null, worktrees: [] };
  const gd = (git(dir, ['rev-parse', '--absolute-git-dir']) || '').trim();
  const cd = (git(dir, ['rev-parse', '--git-common-dir']) || '').trim();
  const top = (git(dir, ['rev-parse', '--show-toplevel']) || '').trim();
  if (gd && cd && top) {
    const worktrees = (git(dir, ['worktree', 'list', '--porcelain']) || '').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9).trim()));
    if (realPath(gd) === realPath(path.resolve(dir, cd))) res = { kind: 'main', top: path.resolve(top), main: path.resolve(top), worktrees };
    else {
      const main = worktrees[0] || null;
      const lanes = main ? path.join(main, '.lanes') : null;
      const lane = Boolean(lanes) && (under(realPath(top), realPath(lanes)) || fs.existsSync(lanes));
      res = { kind: lane ? 'lane' : 'worktree', top: path.resolve(top), main, worktrees };
    }
  }
  kinds.set(key, res);
  return res;
}

export const isLaneCheckout = (dir) => checkoutKind(dir).kind === 'lane';

/**
 * Does STUDIO_MAIN_ROOT (value) name this checkout's main worktree? { ok, why }. It must be the first worktree
 * `git worktree list` gives for this repository and not this checkout itself (G12: a lane naming itself was judged
 * against its own branch, so nothing it changed counted).
 */
export function mainRootTrust(dir, value) {
  if (!String(value || '').trim()) return { ok: false, why: 'not set' };
  const k = checkoutKind(dir);
  const v = realPath(value);
  if (v === realPath(k.top || dir)) return { ok: false, why: `STUDIO_MAIN_ROOT names this checkout itself (${value}), not the studio's main checkout` };
  if (k.kind === 'none') return { ok: false, why: 'this folder is not a git checkout' };
  if (!k.main || v !== realPath(k.main)) return { ok: false, why: `STUDIO_MAIN_ROOT (${value}) is not the main worktree of this repository (git worktree list: ${k.main || 'none'})` };
  return { ok: true, why: 'the main worktree of this repository' };
}

const OFF = /^(off|0|false|no)$/i;
/** The overrides a lane copy can't use: name -> test of the value that weakens the gate. */
export const LANE_REFUSED = {
  STUDIO_PROTECT_BASE: () => true,
  GITHUB_BASE_REF: () => true,
  STUDIO_PROTECT_ROOT: () => true,
  STUDIO_WEAKENED_TESTS: (v) => OFF.test(String(v)),
};
const REFUSED_WHY = {
  STUDIO_PROTECT_BASE: 'a lane is judged against the studio\'s branch, never a base it names itself',
  GITHUB_BASE_REF: 'CI\'s base branch counts only in CI\'s own checkout, not in a lane copy (CI=true proves nothing)',
  STUDIO_PROTECT_ROOT: 'the checker judges this lane copy, never another folder it names',
  STUDIO_WEAKENED_TESTS: 'the weakened-tests gate can\'t be switched off from a lane (studio/gates.json, a protected file, is where the owner turns a gate off)',
};

/**
 * The overrides refused in this checkout: [{ name, value, why }] (empty outside a lane copy). With `dir` a lane copy,
 * STUDIO_MAIN_ROOT that isn't the main worktree is refused too (anywhere else the callers check mainRootTrust).
 */
export function refusedOverrides(dir, env = process.env) {
  const set = Object.entries(LANE_REFUSED).filter(([k, weak]) => String(env[k] || '').trim() && weak(env[k]));
  const mr = String(env.STUDIO_MAIN_ROOT || '').trim();
  if (!set.length && !mr) return [];
  if (!isLaneCheckout(dir)) return [];
  const out = set.map(([name]) => ({ name, value: String(env[name]).slice(0, 120), why: REFUSED_WHY[name] }));
  if (mr) { const t = mainRootTrust(dir, mr); if (!t.ok) out.push({ name: 'STUDIO_MAIN_ROOT', value: mr.slice(0, 160), why: t.why }); }
  return out;
}

/** The env with the refused overrides taken out, and a note naming them (null when none). */
export function trustedEnv(dir, env = process.env) {
  const refused = refusedOverrides(dir, env);
  if (!refused.length) return { env, refused, note: null };
  const clean = { ...env };
  for (const r of refused) delete clean[r.name];
  return { env: clean, refused, note: `ignored in a lane copy: ${refused.map((r) => `${r.name}=${r.value} (${r.why})`).join('; ')}` };
}

/** STUDIO_PROTECT_ROOT as a checker should use it from the checkout its code is in (`codeRoot`): null when unset or refused. */
export function protectRoot(codeRoot, env = process.env) {
  const v = String(env.STUDIO_PROTECT_ROOT || '').trim();
  if (!v) return null;
  return isLaneCheckout(codeRoot) ? null : path.resolve(v);
}

// ---- 2. verify records: the run log, and files the checks read that git status doesn't show ----

export const RUNS_DIR = path.join('gates', 'runs'); // under .studio/
const RUN_ID = /^[0-9a-f]{16,40}$|^[\w.-]{6,80}$/;
/** What a run log vouches for in a record: run id, time, commit, tree, dirty, partial and every row. */
export function recordDigest(rec) {
  const rows = Array.isArray(rec?.rows) ? rec.rows.map((r) => [String(r.id), Boolean(r.ok), r.required !== false, Boolean(r.cached)]) : [];
  return crypto.createHash('sha256').update(JSON.stringify([rec?.runId ?? null, rec?.at ?? null, rec?.head ?? null, rec?.tree ?? null, rec?.dirty ?? null, Boolean(rec?.partial), rec?.tier ?? null, Boolean(rec?.scoped), rec?.changed ?? null, rows])).digest('hex');
}
export const newRunId = () => crypto.randomBytes(8).toString('hex');

/**
 * 2.73.0 (g): what the run log's signature covers: the record's digest and the run log's own fields (a digest of them).
 * The checkout whose key signs is the folder that holds the .studio/ (harness/verify-key.mjs: one key per studio).
 */
export function runLogPayload(log) {
  const logDigest = crypto.createHash('sha256').update(JSON.stringify([log?.runId ?? null, log?.at ?? null, log?.head ?? null, log?.tree ?? null, log?.dirty ?? null, log?.writtenAt ?? null, log?.by ?? null, log?.root ?? null, log?.owner ?? null])).digest('hex');
  return `run-log\n${log?.runId ?? ''}\n${log?.digest ?? ''}\n${logDigest}`;
}

/**
 * Write the run log for a record run-gates just wrote (studioDir = the checkout's .studio/). Keeps the newest 256.
 * 2.73.0 (g): signed with the studio's verify key (made on first use, outside every checkout). Returns
 * { file, signed, why } (why: the reason it couldn't be signed: such a record is never reused), or null.
 */
export function writeRunLog(studioDir, rec, extra = {}) {
  if (!rec?.runId || !RUN_ID.test(rec.runId)) return null;
  const dir = path.join(studioDir, RUNS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${rec.runId}.json`);
  const log = { runId: rec.runId, at: rec.at, head: rec.head ?? null, tree: rec.tree ?? null, dirty: rec.dirty ?? null, digest: recordDigest(rec), pid: process.pid, writtenAt: new Date().toISOString(), by: 'scripts/run-gates.mjs', ...extra };
  delete log.sig;
  const sig = signPayload(path.dirname(path.resolve(studioDir)), runLogPayload(log), { create: true });
  if (!sig.error) log.sig = sig;
  fs.writeFileSync(f, JSON.stringify(log, null, 2));
  try {
    const old = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t).slice(256);
    for (const o of old) fs.rmSync(path.join(dir, o.n), { force: true });
  } catch {}
  return { file: f, signed: !sig.error, why: sig.error || '' };
}

/**
 * May this verify record be reused at all (before the reuse rules: same tree, clean, as wide…)? { ok, why } in plain
 * words. It must carry a run id whose run log run-gates wrote, with the same digest (a hand-written or edited record
 * doesn't match), and it must not have run beside untracked or ignored files the checks read (hidden).
 */
export function recordTrust(rec, studioDirs = []) {
  if (!rec) return { ok: false, why: 'no verify record' };
  if (!rec.runId || !RUN_ID.test(String(rec.runId))) return { ok: false, why: 'the verify record has no run id, so nothing shows the harness\'s own run-gates wrote it (a record from before 2.71.1, or written by hand): it isn\'t reused; run npm run verify again' };
  if (Array.isArray(rec.hidden) && rec.hidden.length) return { ok: false, why: `the verify ran beside untracked or ignored files the checks read (${rec.hidden.slice(0, 3).join(', ')}): it isn't reused` };
  for (const d of [...new Set(studioDirs.filter(Boolean))]) {
    let log = null;
    try { log = JSON.parse(fs.readFileSync(path.join(d, RUNS_DIR, `${rec.runId}.json`), 'utf8')); } catch { continue; }
    if (log?.runId !== rec.runId) continue;
    if (log.digest !== recordDigest(rec)) return { ok: false, why: `the verify record doesn't match the run log run-gates wrote for run ${rec.runId} (it was edited after the run): it isn't reused` };
    // 2.73.0 (g): and the harness signed the run log with this studio's verify key (harness/verify-key.mjs).
    const s = checkSignature(path.dirname(path.resolve(d)), runLogPayload(log), log.sig);
    if (!s.ok && s.why === 'unsigned') return { ok: false, why: `not reused: unsigned record (hand-written or from an older harness): run ${rec.runId}'s log carries no signature from this studio's verify key; the verify runs` };
    if (!s.ok) return { ok: false, why: `not reused: run ${rec.runId}'s record is not signed by this studio's harness (${s.text}); the verify runs` };
    return { ok: true, why: `run ${rec.runId}'s log matches and is signed` };
  }
  return { ok: false, why: `no run log for run ${String(rec.runId).slice(0, 40)} (.studio/${RUNS_DIR.split(path.sep).join('/')}/): the record wasn't written by the harness's run-gates, so it isn't reused` };
}

/** Folder names under the read paths whose ignored contents are build or dependency output, never read as input. */
const OUTPUT_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.vite', '.cache', '.turbo', '.parcel-cache', '.nyc_output', 'test-results', 'playwright-report', 'blob-report', '.godot', 'captures', 'export', 'exports', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.next', '.nuxt', '.svelte-kit', 'reports', 'Library', 'Temp', 'obj', 'Logs']);
const HARMLESS_FILE = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(log|tsbuildinfo|pyc|blend1)$|(^|\/)\.[^/]+\.tmp$/i;
/** Root-level files a test runner or npm reads (an untracked or ignored one there counts too). */
const ROOT_INPUT = /^((vitest|vite|jest|playwright|babel|karma|cypress|webpack|rollup)\.config\.[^/]+|vitest\.workspace\.[^/]+|\.npmrc|\.yarnrc(\.yml)?|\.babelrc(\.[^/]+)?|tsconfig[^/]*\.json|package\.json|\.mocharc(\.[^/]+)?|pytest\.ini|conftest\.py|sitecustomize\.py|setup\.(c|m)?[jt]s)$/i;

/**
 * Untracked files, and ignored files outside build and dependency output, under `paths` (the game's folder, cartridges/,
 * qa/, harness/, scripts/…) and at the root when a runner reads them: the files a verify ran beside that no commit holds.
 * `skip` drops more (engine cache churn). Returns repo-relative paths ('/'-separated; a folder ends with '/'), or null
 * without git.
 */
export function hiddenInputs(root, paths = [], { skip = () => false, max = 50 } = {}) {
  const dirs = [...new Set(paths.map((p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '')).filter((p) => p && !p.startsWith('..') && fs.existsSync(path.join(root, p))))];
  const list = (args) => { const o = git(root, ['ls-files', '-z', '--others', '--exclude-standard', ...args]); return o === null ? null : o.split('\0').filter(Boolean); };
  const spec = [...dirs.map((d) => `:(literal)${d}`)];
  const untracked = spec.length ? list(['--', ...spec]) : [];
  const ignored = spec.length ? list(['--ignored', '--directory', '--', ...spec]) : [];
  const rootU = list(['--', ':(glob)*']);
  const rootI = list(['--ignored', '--directory', '--', ':(glob)*']);
  if (untracked === null || ignored === null || rootU === null || rootI === null) return null;
  const outputish = (f) => f.replace(/\/$/, '').split('/').some((seg) => OUTPUT_DIRS.has(seg));
  const studio = (f) => /^(studio|\.studio|\.lanes|node_modules)(\/|$)/.test(f);
  const hidden = new Set();
  for (const f of untracked) if (!studio(f) && !skip(f)) hidden.add(f);
  for (const f of ignored) if (!studio(f) && !outputish(f) && !HARMLESS_FILE.test(f.replace(/\/$/, '')) && !skip(f)) hidden.add(f);
  for (const f of [...rootU, ...rootI]) if (!f.includes('/') && ROOT_INPUT.test(f)) hidden.add(f);
  return [...hidden].sort().slice(0, max);
}
