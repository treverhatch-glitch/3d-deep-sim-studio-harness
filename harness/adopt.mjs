/**
 * harness/adopt.mjs — 2.43.0: bring a game that already exists under the studio, and send the studio's work back.
 *
 * Tested on a real half-built game (a 236k-line three.js airport tycoon): the read-only scan (npm run onboard)
 * wrote a good fact sheet, but afterwards nothing in the studio covered the game. Its checks never ran, lanes
 * didn't isolate its files, the whole-game and unwired-code checks didn't see it, and the scan had read a stale
 * branch (the repo's docs named another trunk). Adopting fixes that:
 *
 *   npm run onboard -- --path ../my-game --name "My Game" --adopt [--ref <branch>]
 *     copies the game's tracked files at <ref> (default: what is checked out) into game/<slug>/, makes it the
 *     studio's game (studio/game.json), declares its own checks from its scripts in game/<slug>/studio.gates.json
 *     (unless it has one), and records where it came from in studio/game/ORIGIN.json.
 *   npm run onboard -- --export
 *     the studio's committed changes to game/<slug>/ since it was adopted, as one patch for the game's own repo
 *     (studio/game/export-<time>.patch), with the commands to apply it on a branch there. The game's own review
 *     and CI stay in charge of its repo.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './event.mjs';

const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'Build', 'Builds', '.godot', '.import', 'Library', 'Temp', 'obj', 'bin', 'target', '.venv', 'venv', '__pycache__', 'coverage', '.next', '.turbo', '.cache']);
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

export const slugOf = (name) => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
export const originFile = (root = REPO_ROOT) => path.join(root, 'studio', 'game', 'ORIGIN.json');
export function readOrigin(root = REPO_ROOT) {
  try { return JSON.parse(fs.readFileSync(originFile(root), 'utf8')); } catch { return null; }
}

/** The branch a repo's own docs say work goes to ("trunk", "integration branch", "PRs target `x`"), or null. */
export function trunkHint(dir) {
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md', '.github/CONTRIBUTING.md']) {
    let t = '';
    try { t = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const m = t.match(/(?:trunk|integration)[^\n`]{0,60}`([^`\s]+)`/i) || t.match(/PRs?\s+(?:should\s+)?target\s+`([^`\s]+)`/i);
    if (m) return { branch: m[1], file: f };
  }
  return null;
}

/** Copy the game's tracked files at `ref` (a git repo) or its files without build output (a plain folder). */
export function copyGame(src, dest, { ref = null } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  if (fs.readdirSync(dest).length) return { error: `${dest} is not empty: adopt into a new folder (or remove it first)` };
  const isGit = git(src, 'rev-parse', '--is-inside-work-tree').stdout.trim() === 'true';
  if (isGit) {
    const r = ref || 'HEAD';
    const sha = git(src, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`).stdout.trim();
    if (!sha) return { error: `${r} is not a commit in ${src} (fetch it first: git -C "${src}" fetch origin ${r})` };
    const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
    const p = spawnSync(`git -C ${q(src)} archive --format=tar ${sha} | tar -x -C ${q(dest)}`, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (p.status !== 0) return { error: `copying ${r} failed: ${(p.stderr || '').trim().split('\n').pop()}` };
    const branch = ref || git(src, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
    return { git: true, ref: branch, sha, remote: git(src, 'remote', 'get-url', 'origin').stdout.trim() || null };
  }
  fs.cpSync(src, dest, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) });
  return { git: false, ref: null, sha: null, remote: null };
}

/** The game's own checks, from its scripts and config: a studio.gates.json manifest (run from the studio root). */
export function gatesFor(slug, gameDir) {
  const root = `game/${slug}`;
  const cd = `cd ${root} && `;
  const has = (f) => fs.existsSync(path.join(gameDir, f));
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(gameDir, 'package.json'), 'utf8')); } catch {}
  const s = pkg?.scripts || {};
  const run = (k) => `${cd}npm run ${k} --silent`;
  const gates = [];
  const add = (id, command, required = true) => gates.push({ id, command, paths: [`${root}/**`], ...(required ? {} : { required: false }) });
  if (s.typecheck) add('typecheck', run('typecheck'));
  else if (has('tsconfig.json')) add('typecheck', `${cd}npx tsc ${/"references"\s*:/.test(fs.readFileSync(path.join(gameDir, 'tsconfig.json'), 'utf8')) ? '-b' : '--noEmit'}`);
  if (s.test && !/no test specified/.test(s.test)) {
    add('test', run('test'));
    // 2.44.0: the tests related to a change, for a lane's verify (used when the whole suite runs after landing).
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    const t = gates[gates.length - 1];
    if (deps.vitest || /vitest/.test(s.test)) t.related = `${cd}npx vitest related --run --passWithNoTests {files}`;
    else if (deps.jest || /\bjest\b/.test(s.test)) t.related = `${cd}npx jest --passWithNoTests --findRelatedTests {files}`;
  }
  for (const k of ['e2e', 'test:e2e']) if (s[k]) add('e2e', run(k), false);
  if (s.lint) add('lint', run('lint'), false);
  if (s.build) add('build', run('build'), false);
  const shared = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json', 'vite.config.ts', 'vite.config.js', 'vite.config.mjs'].filter(has).map((f) => `${root}/${f}`);
  return { note: `${slug}'s own checks, run from the studio root (written by npm run onboard -- --adopt; edit freely).`, shared, gates };
}

/**
 * Adopt: copy, declare checks, make it the studio's game, record the origin. Returns
 * { ok, slug, dir, origin, gates: [ids], wroteGates, warnings } or { error }.
 */
export async function adoptGame({ src, name, ref = null, root = REPO_ROOT }) {
  const slug = slugOf(name);
  const rel = `game/${slug}`;
  const dest = path.join(root, rel);
  const warnings = [];
  const hint = trunkHint(src);
  const current = git(src, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim();
  if (hint && !ref && current && hint.branch !== current) warnings.push(`its ${hint.file} says work goes to \`${hint.branch}\`, but \`${current}\` is checked out: pass --ref ${hint.branch} to adopt that one`);
  const copied = copyGame(src, dest, { ref });
  if (copied.error) return { error: copied.error };
  let wroteGates = false;
  const man = path.join(dest, 'studio.gates.json');
  if (!fs.existsSync(man)) {
    fs.writeFileSync(man, `${JSON.stringify(gatesFor(slug, dest), null, 2)}\n`);
    wroteGates = true;
  }
  const gates = (JSON.parse(fs.readFileSync(man, 'utf8')).gates || []).map((g) => g.id);
  const origin = { name, slug, path: rel, source: path.resolve(src), remote: copied.remote, ref: copied.ref, sha: copied.sha, adoptedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(originFile(root)), { recursive: true });
  fs.writeFileSync(originFile(root), `${JSON.stringify(origin, null, 2)}\n`);
  const { setActiveGame } = await import('./cartridge.mjs');
  setActiveGame(slug);
  if (fs.existsSync(path.join(dest, 'package.json'))) warnings.push(`install its packages before the first verify: cd ${rel} && npm ci`);
  return { ok: true, slug, dir: rel, origin, gates, wroteGates, warnings };
}

/**
 * The studio's committed changes to the adopted game since it was adopted, as a patch for the game's own repo.
 * Returns { ok, file, files, commits, origin, apply } or { error }.
 */
export function exportPatch({ root = REPO_ROOT, now = new Date() } = {}) {
  const o = readOrigin(root);
  if (!o?.path) return { error: 'no adopted game (studio/game/ORIGIN.json): adopt one with npm run onboard -- --path <game> --name "<name>" --adopt' };
  // The base: the newest commit that changed ORIGIN.json (the adoption, or the last sync), found walking back
  // from HEAD and stopping there (a whole-history walk breaks in a shallow clone, which many people use).
  const first = git(root, 'log', '-n', '1', '--format=%H', '--', 'studio/game/ORIGIN.json').stdout.trim();
  if (!first) return { error: `${o.path} has no commits yet: commit the adopted game first (git add ${o.path})` };
  const spec = ['--', o.path, `:(exclude)${o.path}/studio.gates.json`];
  const names = git(root, 'diff', '--name-only', first, 'HEAD', `--relative=${o.path}`, ...spec).stdout.trim().split('\n').filter(Boolean);
  if (!names.length) return { ok: true, empty: true, files: [], origin: o };
  const diff = git(root, 'diff', '--binary', first, 'HEAD', `--relative=${o.path}`, ...spec);
  if (diff.status !== 0) return { error: `git diff failed: ${(diff.stderr || '').trim()}` };
  const commits = git(root, 'log', '--format=%h %s', `${first}..HEAD`, '--', o.path).stdout.trim().split('\n').filter(Boolean);
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const file = path.join(root, 'studio', 'game', `export-${stamp}.patch`);
  fs.writeFileSync(file, diff.stdout);
  const relFile = path.relative(root, file).split(path.sep).join('/');
  // 2.44.0: remember how far the studio's work was sent back, so a sync after an export isn't refused.
  const head = git(root, 'rev-parse', 'HEAD').stdout.trim();
  fs.writeFileSync(originFile(root), `${JSON.stringify({ ...o, exportedThrough: head, exportedAt: now.toISOString(), lastExport: relFile }, null, 2)}\n`);
  const where = o.source && fs.existsSync(o.source) ? o.source : o.remote || '<the game repo>';
  const apply = [`cd "${where}"`, `git fetch origin${o.ref ? ` ${o.ref}` : ''}`, `git switch -c studio/export-${stamp} ${o.sha || o.ref || 'HEAD'}`, `git apply --3way "${path.resolve(file)}"`, 'then run its own checks and open a PR the usual way'];
  return { ok: true, file: relFile, files: names, commits, origin: o, apply };
}

/**
 * 2.44.0: bring the game's own repo's newer commits into the studio's copy (game/<slug>/), as one commit, so
 * work can carry on in both places. Refuses while the studio has changes to the game it hasn't exported (send
 * them back first: npm run onboard -- --export), or uncommitted ones. Returns { ok, upToDate?, from, to,
 * commits, files, committed } or { error }.
 */
export function syncGame({ root = REPO_ROOT, ref = null, force = false, commit = true, now = new Date() } = {}) {
  const o = readOrigin(root);
  if (!o?.path) return { error: 'no adopted game (studio/game/ORIGIN.json): adopt one first with npm run onboard -- --adopt' };
  if (!o.source || !fs.existsSync(o.source)) return { error: `the game's own repo isn't at ${o.source || '(unknown)'} any more: clone it there, or fix "source" in studio/game/ORIGIN.json` };
  if (!o.sha) return { error: 'the game was adopted from a folder, not a git repo: there is nothing to sync from' };
  const base = git(root, 'log', '-n', '1', '--format=%H', '--', 'studio/game/ORIGIN.json').stdout.trim();
  if (!base) return { error: 'commit the adopted game first (studio/game/ORIGIN.json has no commit yet)' };
  // Studio work since the last sync that hasn't been exported (an export records how far it went).
  const since = o.exportedThrough && git(root, 'merge-base', '--is-ancestor', base, o.exportedThrough).status === 0 ? o.exportedThrough : base;
  const pending = git(root, 'log', '--format=%h %s', `${since}..HEAD`, '--', o.path, `:(exclude)${o.path}/studio.gates.json`).stdout.trim().split('\n').filter(Boolean);
  if (pending.length && !force) return { error: `${pending.length} commit(s) to ${o.path} since it was last synced haven't been sent back yet (${pending.slice(0, 3).join('; ')}): npm run onboard -- --export first, or --force to sync anyway`, pending };
  if (git(root, 'status', '--porcelain', '--', o.path).stdout.trim()) return { error: `${o.path} has uncommitted changes: commit or set them aside first` };
  const want = ref || o.ref || 'HEAD';
  if (git(o.source, 'remote').stdout.trim()) git(o.source, 'fetch', '-q', 'origin', want);
  // --verify --quiet: a plain rev-parse prints an unknown name back instead of nothing.
  const tip = git(o.source, 'rev-parse', '--verify', '--quiet', `origin/${want}^{commit}`).stdout.trim() || git(o.source, 'rev-parse', '--verify', '--quiet', `${want}^{commit}`).stdout.trim();
  if (!tip) return { error: `${want} isn't a branch or commit in ${o.source}` };
  if (tip === o.sha) return { ok: true, upToDate: true, from: o.sha, to: tip, commits: [], files: [] };
  const commits = git(o.source, 'log', '--format=%h %s', `${o.sha}..${tip}`).stdout.trim().split('\n').filter(Boolean);
  const files = git(o.source, 'diff', '--name-only', o.sha, tip).stdout.trim().split('\n').filter(Boolean);
  const diff = git(o.source, 'diff', '--binary', o.sha, tip, '--', '.', ':(exclude)studio.gates.json');
  if (diff.status !== 0) return { error: `git diff in ${o.source} failed: ${(diff.stderr || '').trim()}` };
  if (diff.stdout.trim()) {
    const ap = spawnSync('git', ['apply', '--3way', '--whitespace=nowarn', `--directory=${o.path}`], { cwd: root, input: diff.stdout, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (ap.status !== 0) return { error: `the game's changes didn't apply cleanly to ${o.path}: ${(ap.stderr || '').trim().split('\n').slice(-4).join(' | ')} (fix the conflicts, then commit)`, conflicts: true };
  }
  const next = { ...readOrigin(root), ref: want, sha: tip, previousSha: o.sha, syncedAt: now.toISOString() };
  fs.writeFileSync(originFile(root), `${JSON.stringify(next, null, 2)}\n`);
  let committed = false;
  if (commit) {
    git(root, 'add', '-A', '--', o.path, 'studio/game/ORIGIN.json');
    const c = spawnSync('git', ['commit', '-q', '-m', `Sync ${o.name || o.slug} from ${want} (${o.sha.slice(0, 8)}..${tip.slice(0, 8)}, ${commits.length} commit(s))`], { cwd: root, encoding: 'utf8', env: { ...process.env, STUDIO_MAIN_COMMIT: 'allow' } });
    committed = c.status === 0;
  }
  return { ok: true, from: o.sha, to: tip, commits, files, committed };
}
