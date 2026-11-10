/**
 * harness/lane-sparse.mjs — 2.70.0 (w): sparse lanes. A lane copy leaves out the paths its task can't need.
 *
 * The evidence: 90-100 GB of lane copies on one 1 TB drive, and in a real game repo about 75% of the tracked bytes are
 * docs/ and media a code lane never touches. Lanes already use a non-cone sparse checkout to leave studio/ and .studio/
 * out (they are links to the main checkout's); this adds the game's own exclusions to those patterns.
 *
 *   What is left out   the game manifest's "laneExclude": ["<glob>", ...] (<game>/studio.gates.json, read as committed
 *                      in the main checkout: the manifest is protected) plus STUDIO_LANE_EXCLUDE (comma-separated
 *                      globs; =off turns lane exclusions off). Globs are repo-relative (** any depth, * one segment).
 *                      Off unless one of them names a glob. The harness's own folders (harness/, scripts/, qa/,
 *                      tools/), package files and the manifest itself are never left out.
 *   What a task keeps  every path of its declared scope (its lane: task add --paths/--lane, `task lane`, the studio
 *                      paths it names), re-included after the exclusions; a task on the asset track (or an art task)
 *                      keeps every file (media included).
 *   Widening           `npm run lanes -- widen <path|glob> [...] [--lane <agent>] [--why "..."]` adds paths to a lane
 *                      (git sparse-checkout add); every widening is a lane.widened event and is kept in
 *                      .studio/lanes/<agent>.sparse.json. Files an agent wrote into a left-out path (git hides an edit
 *                      to a left-out tracked file, and refuses to add a new one) are found at task done and before the
 *                      lane's checks, and the lane is widened over them so they show as changes.
 *   The checks         never see a partial tree: before the lane's own verify (scripts/run-gates.mjs) and the game's
 *                      checks (harness/game-gates.mjs, also run by task done and lanes refresh), every left-out file a
 *                      check that is about to run reads is put back (widenForChecks), and the run says so. What a
 *                      check reads: its "needs" globs (studio/gates.json gate or manifest gate), else a game check's
 *                      "paths", else the game's whole folder; harness checks have a built-in list (CHECK_NEEDS). A
 *                      verify in a lane that still leaves files out never writes the shared gate cache. Train builds
 *                      and the whole-game check use their own scratch copies with only studio/ and .studio/ left out
 *                      (full trees); they don't read laneExclude.
 *
 * Imports only leaf modules (no worktree.mjs: it imports this one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent, readRecentEvents } from './event.mjs';
import { globRe } from './merge-lane.mjs';

/** The patterns every lane copy has had since 2.29: everything but the shared studio/ and .studio/ links. */
export const BASE_SPARSE = ['/*', '!/studio/', '!/.studio/'];
/** Never left out of a lane: the harness that runs its checks, the package files, the shared links. */
const NEVER_EXCLUDED = ['harness/x.mjs', 'scripts/x.mjs', 'qa/x.mjs', 'tools/x.mjs', 'package.json', 'package-lock.json', 'node_modules/x', 'studio/x', '.studio/x'];
/** What the harness's own folders are, for checks with no list of their own. */
export const HARNESS_CODE = ['harness/**', 'scripts/**', 'qa/**', 'tools/**', 'engine/**', 'cartridges/**', 'skills/**', 'web/**', '*'];
/**
 * What each harness check reads beyond its own folders (studio/gates.json ids). A check not named here reads
 * HARNESS_CODE; "**" means the whole tree. secrets: the lane's commits are read from git, and a left-out file can't
 * change in the lane (edits there are found and widened first), so the files it doesn't see are the base's.
 */
export const CHECK_NEEDS = {
  docs: ['**/*.md', 'docs/**'],
  assets: ['assets/**', 'public/**', 'src/**', 'web/**', 'cartridges/**'],
  'content-schema': ['cartridges/**', 'content/**'],
  selftest: ['**'],
  secrets: [],
};

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
const off = (v) => /^(off|0|false|no)$/i.test(String(v || '').trim());
const norm = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
const hasWild = (g) => /[*?[]/.test(g);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const uniq = (a) => [...new Set(a)];

/** The main checkout (a lane copy at <main>/.lanes/<x> names it), without importing worktree.mjs. */
export function studioMain(env = process.env, here = REPO_ROOT) {
  if (env.STUDIO_MAIN_ROOT) return path.resolve(env.STUDIO_MAIN_ROOT);
  const m = String(here).replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+$/);
  return m ? path.resolve(m[1]) : here;
}

/** The studio game's folder (game/<name> or web/<name>), from STUDIO_GAME or studio/game.json "game"; null if none. */
export function gameRootOf(root, env = process.env) {
  let name = String(env.STUDIO_GAME || '').trim();
  if (!name) name = String(readJson(path.join(root, 'studio', 'game.json'), {})?.game || '').trim();
  if (!name || !/^[\w.-]+$/.test(name)) return null;
  return [`game/${name}`, `web/${name}`].find((d) => fs.existsSync(path.join(root, d))) || null;
}

/** The game manifest as committed in the main checkout (else the file): { rel, json } or null. */
export function readGameManifest(root, env = process.env) {
  const gr = gameRootOf(root, env);
  if (!gr) return null;
  const rel = `${gr}/studio.gates.json`;
  let text = '';
  const r = git(root, 'show', `HEAD:${rel}`);
  if (r.status === 0) text = r.stdout;
  else { try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } }
  try { return { rel, gameRoot: gr, json: JSON.parse(text) }; } catch { return { rel, gameRoot: gr, json: null }; }
}

/** Why this glob may not be left out of a lane, or ''. */
export function excludeRefusal(glob, manifestRel = '') {
  const g = norm(glob);
  if (!g || g.startsWith('!') || g.split('/').includes('..') || /^[A-Za-z]:/.test(g)) return 'not a repo-relative glob';
  if (/^\*+$/.test(g) || g === '**/*') return 'it would leave out everything';
  const re = globRe(g);
  const hit = [...NEVER_EXCLUDED, ...(manifestRel ? [manifestRel] : [])].find((p) => re.test(p) || re.test(p.replace(/\/x(\.mjs)?$/, '')));
  return hit ? `it covers ${hit.replace(/\/x(\.mjs)?$/, '/')}, which every lane needs` : '';
}

/**
 * What lanes leave out: { globs, from: [...], manifest, notes }. Off (globs []) unless the manifest declares
 * "laneExclude" or STUDIO_LANE_EXCLUDE names globs; STUDIO_LANE_EXCLUDE=off turns it off.
 */
export function laneExcludeConfig({ root = studioMain(), env = process.env } = {}) {
  if (off(env.STUDIO_LANE_EXCLUDE)) return { globs: [], from: ['STUDIO_LANE_EXCLUDE=off'], manifest: null, notes: [] };
  const man = readGameManifest(root, env);
  const fromMan = Array.isArray(man?.json?.laneExclude) ? man.json.laneExclude.filter((x) => typeof x === 'string').map(norm).filter(Boolean) : [];
  const fromEnv = String(env.STUDIO_LANE_EXCLUDE || '').split(',').map(norm).filter(Boolean);
  const notes = [];
  const globs = [];
  for (const g of uniq([...fromMan, ...fromEnv])) {
    const why = excludeRefusal(g, man?.rel || '');
    if (why) notes.push(`laneExclude "${g}" ignored: ${why}`);
    else globs.push(g);
  }
  const from = [...(fromMan.length ? [man.rel] : []), ...(fromEnv.length ? ['STUDIO_LANE_EXCLUDE'] : [])];
  return { globs, from, manifest: man?.rel || null, notes };
}

/** A glob as sparse-checkout lines: "docs/**" → "/docs/**"; a plain path also as itself (a file) and its folder. */
export function sparseLines(glob, { neg = false } = {}) {
  const g = norm(glob);
  if (!g) return [];
  const p = (s) => `${neg ? '!' : ''}/${s}`;
  return hasWild(g) ? [p(g)] : [p(g), p(`${g}/**`)];
}

/** A task's declared scope from its task.added event: { keep: [paths], asset, track, role }. */
export function taskScope(task, { lane = null, events = null } = {}) {
  const ev = events || (task ? readRecentEvents(20000) : []);
  const added = task ? ev.filter((e) => e.type === 'task.added' && e.task === task).pop() : null;
  const meta = added?.meta || {};
  const role = meta.role || (String(added?.msg || '').match(/^Queued [A-Z]+-\d+ \[[^\]]*\] \(([a-z-]+)\)/) || [])[1] || null;
  // 2.78.2 (item 9): a region entry (path/sim.ts#symbol) keeps its whole file.
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => norm(String(x).split('#')[0])).filter(Boolean);
  const keep = uniq([...list(lane), ...list(meta.paths), ...list(meta.lane)]).filter((p) => !/^(studio|\.studio)(\/|$)/.test(p));
  const track = meta.track || null;
  return { keep, track, role, asset: track === 'asset' || role === 'art' || meta.type === 'asset' };
}

/**
 * The sparse patterns for a new lane copy: { on, patterns, exclude, keep, why }. on=false: the 2.29 patterns (only
 * studio/ and .studio/ left out).
 */
export function lanePlan({ root = studioMain(), env = process.env, task = null, lane = null, events = null } = {}) {
  const cfg = laneExcludeConfig({ root, env });
  if (!cfg.globs.length) return { on: false, patterns: [...BASE_SPARSE], exclude: [], keep: [], notes: cfg.notes, why: 'no laneExclude' };
  const scope = taskScope(task, { lane, events });
  if (scope.asset) return { on: false, patterns: [...BASE_SPARSE], exclude: [], keep: [], notes: cfg.notes, why: `${task || 'the task'} is an asset task: it keeps every file` };
  const patterns = [...BASE_SPARSE, ...cfg.globs.flatMap((g) => sparseLines(g, { neg: true })), ...scope.keep.flatMap((p) => sparseLines(p))];
  return { on: true, patterns, exclude: cfg.globs, keep: scope.keep, from: cfg.from, notes: cfg.notes, why: `left out: ${cfg.globs.join(', ')}${scope.keep.length ? `; kept for ${task || 'its scope'}: ${scope.keep.join(', ')}` : ''}` };
}

// ---- the record and the lane's own state -----------------------------------------------------------------------

export const recordFile = (root, agent) => path.join(root, '.studio', 'lanes', `${agent}.sparse.json`);
export const readRecord = (root, agent) => readJson(recordFile(root, agent), null);
export function writeRecord(root, agent, rec) {
  try {
    const f = recordFile(root, agent);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.${process.pid}.tmp`, `${JSON.stringify(rec, null, 2)}\n`);
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
  } catch {}
}
export const removeRecord = (root, agent) => { try { fs.rmSync(recordFile(root, agent), { force: true }); } catch {} };

/** The lane copy's sparse patterns now: { sparse, patterns, extra (exclusions beyond the 2.29 ones), on }. */
export function laneSparseState(dir = REPO_ROOT) {
  const cfg = git(dir, 'config', '--get', 'core.sparseCheckout');
  if (String(cfg.stdout || '').trim() !== 'true') return { sparse: false, on: false, patterns: [], extra: [] };
  const f = String(git(dir, 'rev-parse', '--git-path', 'info/sparse-checkout').stdout || '').trim();
  let patterns = [];
  try { patterns = fs.readFileSync(path.resolve(dir, f), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')); } catch {}
  const extra = patterns.filter((p) => p.startsWith('!') && !BASE_SPARSE.includes(p));
  return { sparse: true, on: extra.length > 0, patterns, extra };
}

/**
 * 2.78.0 (B-105): a lane copy's studio/ and .studio/ are links (a symlink, or a junction on Windows) to the main
 * checkout's. createLaneCopy leaves them out with a sparse checkout, so git never writes through them. When that
 * state is lost (the entries lose skip-worktree), a merge of main sees main's live board files through the link as
 * local changes ("commit your changes or stash") and, were it to go on, would write main's files. Before any merge
 * or rebase in the lane: mark every tracked path under a linked folder skip-worktree again (the state the copy was
 * made in), and say whether the copy's sparse patterns still leave the folders out, so files main adds there are not
 * written either. Touches only this lane's index; the link and main's files are never opened. A folder that is a real
 * folder (not a link) is left alone. Returns { links: [names], marked, sparseOk, why? }.
 */
export function protectSharedLinks(dir = REPO_ROOT) {
  const links = ['studio', '.studio'].filter((d) => { try { return fs.lstatSync(path.join(dir, d)).isSymbolicLink(); } catch { return false; } });
  if (!links.length) return { links: [], marked: 0, sparseOk: true };
  const ls = git(dir, 'ls-files', '-t', '-z', '--', ...links.map((l) => `${l}/`));
  const open = String(ls.stdout || '').split('\0').filter((l) => l && !l.startsWith('S ')).map((l) => l.slice(2));
  if (open.length) {
    const r = spawnSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], { cwd: dir, input: `${open.join('\0')}\0`, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return { links, marked: 0, sparseOk: false, why: `could not mark ${links.join(', ')} left out of the lane: ${String(r.stderr || '').trim().split('\n').pop()}` };
  }
  const st = laneSparseState(dir);
  const sparseOk = st.sparse && links.every((l) => st.patterns.includes(`!/${l}/`));
  return { links, marked: open.length, sparseOk };
}

/** Tracked files this copy leaves out (skip-worktree), studio/ and .studio/ apart. */
export function leftOutFiles(dir = REPO_ROOT) {
  const r = git(dir, 'ls-files', '-t', '-z');
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\0').filter((l) => l.startsWith('S ')).map((l) => l.slice(2)).filter((f) => !/^(studio|\.studio)\//.test(f));
}

/**
 * Files an agent wrote into a left-out path: a left-out tracked file that exists on disk (git ignores its edits) and
 * an untracked file under an exclusion glob that no kept path covers (git refuses to add it). [paths].
 */
export function sparseStrays(dir = REPO_ROOT, { root = studioMain(), agent = path.basename(dir) } = {}) {
  const st = laneSparseState(dir);
  if (!st.on) return [];
  const present = leftOutFiles(dir).filter((f) => { try { fs.lstatSync(path.join(dir, f)); return true; } catch { return false; } });
  const rec = readRecord(root, agent) || {};
  const ex = (rec.exclude || st.extra.map((p) => p.slice(2))).map((g) => globRe(g));
  const kept = [...(rec.keep || []), ...(rec.widened || []).flatMap((w) => w.paths || [])].map((g) => globRe(g));
  const untracked = String(git(dir, 'ls-files', '--others', '--exclude-standard', '-z').stdout || '').split('\0').filter(Boolean)
    .filter((f) => ex.some((re) => re.test(f)) && !kept.some((re) => re.test(f)));
  return uniq([...present, ...untracked]);
}

/**
 * Put paths back into a lane copy (git sparse-checkout add). Logged: a lane.widened event and the copy's record.
 * Returns { ok, added: [lines], why? }.
 */
export function widenLane({ dir = REPO_ROOT, paths = [], why = '', by = process.env.STUDIO_LOCK_OWNER || null, root = studioMain(), agent = path.basename(dir), emit = emitEvent } = {}) {
  const want = uniq(paths.map(norm).filter(Boolean));
  if (!want.length) return { ok: false, added: [], why: 'name a path or glob to widen the lane to' };
  const bad = want.find((p) => p.split('/').includes('..') || /^[A-Za-z]:/.test(p));
  if (bad) return { ok: false, added: [], why: `${bad} is not a repo-relative path` };
  const st = laneSparseState(dir);
  if (!st.sparse) return { ok: true, added: [], why: 'this copy has no sparse checkout: it has every file' };
  const have = new Set(st.patterns);
  const lines = want.flatMap((p) => sparseLines(p)).filter((l) => !have.has(l));
  if (!lines.length) return { ok: true, added: [], why: 'already in the lane' };
  const r = git(dir, 'sparse-checkout', 'add', ...lines);
  if (r.status !== 0) return { ok: false, added: [], why: `git sparse-checkout add failed: ${String(r.stderr || '').trim().split('\n').pop()}` };
  const rec = readRecord(root, agent) || { agent };
  rec.widened = [...(rec.widened || []), { paths: want, why: String(why || '').slice(0, 300), by, at: new Date().toISOString() }].slice(-50);
  writeRecord(root, agent, rec);
  try { emit({ type: 'lane.widened', agent: String(by || agent).slice(0, 60), task: rec.task || undefined, msg: `${agent}'s lane copy widened to ${want.join(', ')}${why ? ` (${why})` : ''}`.slice(0, 400), meta: { lane: agent, paths: want, lines, why: why || null } }); } catch {}
  return { ok: true, added: lines };
}

/** Widen over files written into left-out paths. { files, ok }. */
export function widenStrays({ dir = REPO_ROOT, root = studioMain(), agent = path.basename(dir), log = () => {}, by } = {}) {
  const files = sparseStrays(dir, { root, agent });
  if (!files.length) return { files: [], ok: true };
  const w = widenLane({ dir, paths: files, why: 'files were written there', root, agent, by });
  if (w.ok) log(`[lanes] ${agent}: ${files.length} file(s) written into paths this lane left out (${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}); the lane was widened so they show as changes`);
  return { files, ok: w.ok, why: w.why };
}

/** What a studio/gates.json check reads: its "needs", else CHECK_NEEDS, else the harness's folders. */
export function harnessCheckNeeds(gate) {
  if (Array.isArray(gate?.needs)) return gate.needs.map(norm).filter(Boolean);
  if (gate?.id && CHECK_NEEDS[gate.id]) return CHECK_NEEDS[gate.id];
  return HARNESS_CODE;
}

/**
 * What the game's checks read (the ones about to run): each manifest gate's "needs", else its "paths", else the
 * game's whole folder; plus engine projects and layout inputs. [{ id, globs }].
 */
export function gameCheckNeeds({ root = REPO_ROOT, gameRoot, ids = null, engineProjects = [], layoutPaths = null, layout = false, env = process.env } = {}) {
  if (!gameRoot) return [];
  let man = null;
  try { man = JSON.parse(fs.readFileSync(path.join(root, gameRoot, 'studio.gates.json'), 'utf8')); } catch {}
  const out = [];
  for (const g of Array.isArray(man?.gates) ? man.gates : []) {
    if (!g?.id || (ids && !ids.includes(`game:${g.id}`))) continue;
    const globs = Array.isArray(g.needs) ? g.needs : Array.isArray(g.paths) && g.paths.length ? g.paths : [`${gameRoot}/**`];
    out.push({ id: `game:${g.id}`, globs: globs.map(norm).filter(Boolean) });
  }
  if (!man && (!ids || ids.length)) out.push({ id: 'game', globs: [`${gameRoot}/**`] });
  for (const p of engineProjects) out.push({ id: `engine:${p}`, globs: [`${norm(p)}/**`] });
  if (layout) out.push({ id: 'game:layout', globs: layoutPaths?.length ? layoutPaths.map(norm) : [`${gameRoot}/**`] });
  void env;
  return out;
}

/**
 * Before checks run in a lane copy: widen over written strays, then over every left-out file a check about to run
 * reads. needs: [{ id, globs }]. Returns null outside a lane with exclusions, else { widened: [globs], checks: [ids],
 * files, partial } (partial: files are still left out, so the run must not write the shared gate cache).
 */
export function widenForChecks({ dir = REPO_ROOT, needs = [], log = () => {}, root = studioMain(), agent = path.basename(dir), label = '[gates]' } = {}) {
  const st = laneSparseState(dir);
  if (!st.on) return null;
  widenStrays({ dir, root, agent, log });
  const left = leftOutFiles(dir);
  if (!left.length) return { widened: [], checks: [], files: 0, partial: false };
  const add = []; const ids = []; let files = 0;
  for (const n of needs) {
    const res = (n.globs || []).map((g) => ({ g, re: globRe(g) }));
    let hit = 0;
    for (const { g, re } of res) {
      const k = left.filter((f) => re.test(f)).length;
      if (k) { add.push(g); hit += k; }
    }
    if (hit) { ids.push(n.id); files += hit; }
  }
  const globs = uniq(add);
  if (!globs.length) return { widened: [], checks: [], files: 0, partial: true };
  const w = widenLane({ dir, paths: globs, why: `the checks ${ids.join(', ')} read files there`, root, agent });
  if (w.ok) log(`${label} this lane left out ${files} file(s) that ${ids.join(', ')} read: widened to ${globs.join(', ')} before running, so the checks see every file they read`);
  else log(`${label} WARN could not widen the lane for ${ids.join(', ')}: ${w.why}`);
  return { widened: w.ok ? globs : [], checks: ids, files, partial: leftOutFiles(dir).length > 0, ok: w.ok };
}
