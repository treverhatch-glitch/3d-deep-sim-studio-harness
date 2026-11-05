/**
 * harness/upgrade-preflight.mjs — 2.73.0 (f): `npm run upgrade -- --preflight [--ref <ref>] [--json]`, before taking a
 * harness update. Read-only: it changes no file, commit, branch or lock (the machine scan is read, never written).
 *
 * One line per item, PASS / WARN / FAIL / INFO, with a Fix line under each WARN and FAIL; exit 1 on any FAIL:
 *   node          this node against the engines of the ref's package.json (--ref), else the studio's
 *   git           git --version against STUDIO_PREFLIGHT_MIN_GIT (2.34)
 *   checkout      the studio's main checkout, on a branch, no merge/revert in progress; --ref names a commit here
 *   board         the board committed (upgrade --check); stash entries holding board rows are named (WARN)
 *   owner-key     studio/keys/owner-ed25519.pub.pem committed (FAIL without: protected files aren't enforced); WARN when
 *                 the private key is on this machine (STUDIO_OWNER_KEY or ~/.studio-owner/), where agents run
 *   signatures    the studio's protected check (qa/protected-check.mjs): every protected change carries a valid signature
 *   disk / ram    from the machine scan (harness/machine.mjs scanMachine, never written); disk under
 *                 STUDIO_DISK_MIN_FREE_GB (default max(20 GB, 5% of the disk)) FAILs; memory headroom under
 *                 STUDIO_PREFLIGHT_MIN_RAM_GB (4) WARNs. A studio without machine.mjs: node's own numbers.
 *   tools         STUDIO_UNITY and GODOT_BIN, when set (environment or .env), must resolve (FAIL otherwise); Unity,
 *                 Blender and ffmpeg on the PATH are reported (INFO)
 *   webhook       STUDIO_REPORT_WEBHOOK set (never printed): an http(s) URL PASSes, anything else FAILs, unset WARNs;
 *                 FAIL when .env is tracked by git (the webhook is a secret)
 *   policy        studio/policy.json, studio/delegation.json, studio/autonomy.json, studio/overseer.json: each one there
 *                 must parse (FAIL otherwise); missing: INFO (defaults)
 *   dotenv-identity 2.73.1 (B-60): a .env line setting STUDIO_LOCK_OWNER, STUDIO_ROLE, STUDIO_AGENT or STUDIO_MAIN_ROOT
 *                 (WARN, the line numbers): identity settings belong to a session; the harness ignores them in .env
 *   lanes         lane copies (.lanes/<name>) with uncommitted work or commits not on the studio's branch (WARN, listed):
 *                 the update's lane refresh skips a lane with uncommitted work. 2.73.1 (B-51): a lane is a registered
 *                 worktree of this repo (git worktree list) with its own .git; any other folder there is a "leftover
 *                 folder (not a lane)" (INFO), never asked for git status (git would answer for the main checkout)
 *   long-run/…    2.78.1, "before a long run" (WARN only): .env workarounds a later release made unnecessary (the list is
 *                 harness/upgrade-leftovers.json: version, key, value, why), ready builder tasks with no lane (the
 *                 studio's own harness/task.mjs and task-hold.mjs read the board, when it has them), uncommitted changes
 *                 in harness/ or scripts/ (a local patch), and trains (.studio/train/<id>/life.json) or gate runs
 *                 (.studio/verify-running) still running from before the harness last changed
 *   game-tests/…  2.78.2 (f): the studio game's test checks (the studio's own harness/test-config-check.mjs, when it has
 *                 one): FAIL a test check with neither a "focus" command nor a vitest/jest runner the harness can run
 *                 single files with (every train re-check re-runs the whole suite); FAIL a test config whose list mode
 *                 still lists a file named in STUDIO_TEST_QUARANTINE (or, with perf / slow-tier tests declared,
 *                 STUDIO_TEST_EXCLUDE); WARN when that can't be told. Runs the runner's list mode; writes nothing.
 *
 * No harness imports (only node's): an old studio runs this from the ref through the upgrade guard (docs/RELEASE.md).
 * The guard passes its own checkUpgrade / isMainCheckout in. UNTESTED on Windows: `where` for the PATH lookups.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const git = (args, cwd, opts = {}) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts });
const out1 = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return undefined; } };
const num = (v, d) => (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

/** KEY=VALUE lines of the studio's .env (quotes stripped); {} when there is none. Values are never printed. */
export function readDotEnv(root) {
  const o = {};
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return o; }
  for (const l of text.split(/\r?\n/)) {
    const m = l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !IDENTITY.includes(m[1].toUpperCase())) o[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return o;
}

// 2.73.1 (B-60): the session identity the launcher sets (harness/dotenv.mjs SESSION_IDENTITY_KEYS; repeated here, as this
// file imports nothing of the harness). The harness ignores these in .env.
const IDENTITY = ['STUDIO_LOCK_OWNER', 'STUDIO_ROLE', 'STUDIO_AGENT', 'STUDIO_MAIN_ROOT'];
/** [{ line, key }] of the .env lines setting a session identity to a non-empty value. */
export function dotEnvIdentityLines(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return []; }
  const out = [];
  text.split('\n').forEach((l, i) => {
    const m = l.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && IDENTITY.includes(m[1].toUpperCase()) && m[2].trim().replace(/^['"]|['"]$/g, '') !== '') out.push({ line: i + 1, key: m[1].toUpperCase() });
  });
  return out;
}
function checkDotEnvIdentity(root) {
  const hits = dotEnvIdentityLines(root);
  if (!hits.length) return [];
  const lines = hits.map((h) => h.line).join(', ');
  return [item('dotenv-identity', 'WARN', `.env sets ${[...new Set(hits.map((h) => h.key))].join(', ')} (line${hits.length === 1 ? '' : 's'} ${lines}): identity settings belong to a session, not the studio's .env (ignored there; while an older harness read it, every shell, the owner's own included, was labelled that agent)`, `remove line${hits.length === 1 ? '' : 's'} ${lines} from the studio's .env (the owner edits it; the launcher sets these for each agent session)`)];
}

/**
 * 2.73.1 (B-51): the registered worktrees of this repo (git worktree list --porcelain), as resolved paths. A folder in
 * .lanes/ is a lane only when it is one of them AND has its own .git file: an old, emptied lane folder has neither, and
 * git run inside it answers for the main checkout (its dirty board counted once per leftover folder).
 */
export function registeredWorktrees(root) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(r); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
  const list = String(git(['worktree', 'list', '--porcelain'], root).stdout || '').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => norm(l.slice(9).trim()));
  return { has: (dir) => fs.existsSync(path.join(dir, '.git')) && list.includes(norm(dir)), list };
}

/** "1.2.3" against ">=1.2.0" (only >= / plain versions; anything else: null). */
export function versionAtLeast(have, want) {
  const p = (v) => String(v || '').replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const m = String(want || '').match(/^\s*(>=)?\s*v?(\d+(?:\.\d+){0,2})\s*$/);
  if (!m) return null;
  const a = p(have); const b = p(m[2]);
  for (let i = 0; i < 3; i++) { if (a[i] > b[i]) return true; if (a[i] < b[i]) return false; }
  return true;
}

export function which(cmd, env = process.env) {
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', env, windowsHide: true, timeout: 10000 });
  return r.status === 0 ? String(r.stdout || '').split(/\r?\n/).find(Boolean) || cmd : null;
}

const item = (id, status, detail, fix = '') => ({ id, status, detail, ...(fix ? { fix } : {}) });

function checkNode(root, ref) {
  let engines = null; let from = 'the studio\'s package.json';
  if (ref) { try { engines = JSON.parse(git(['show', `${ref}:package.json`], root).stdout).engines?.node || null; from = `${ref}'s package.json`; } catch { engines = null; } }
  if (!engines) { engines = readJson(path.join(root, 'package.json'))?.engines?.node || null; from = 'the studio\'s package.json'; }
  if (!engines) return item('node', 'INFO', `node ${process.versions.node} (no engines.node in ${from})`);
  const ok = versionAtLeast(process.versions.node, engines);
  if (ok === null) return item('node', 'INFO', `node ${process.versions.node}; ${from} asks ${engines} (not checked)`);
  return ok ? item('node', 'PASS', `node ${process.versions.node} (${from} asks ${engines})`) : item('node', 'FAIL', `node ${process.versions.node}, but ${from} asks ${engines}`, `install node ${engines.replace(/^>=\s*/, '')} or newer (nodejs.org; on Windows the LTS installer), then run this again in a new terminal`);
}

function checkGit(env) {
  const want = String(env.STUDIO_PREFLIGHT_MIN_GIT || '').trim() || '2.34';
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const v = (String(r.stdout || '').match(/(\d+\.\d+(?:\.\d+)?)/) || [])[1];
  if (r.status !== 0 || !v) return item('git', 'FAIL', 'git was not found on the PATH', 'install git (git-scm.com) and open a new terminal');
  return versionAtLeast(v, `>=${want}`) ? item('git', 'PASS', `git ${v} (needs ${want}+, STUDIO_PREFLIGHT_MIN_GIT)`) : item('git', 'FAIL', `git ${v}, older than ${want}`, `update git to ${want} or newer (git-scm.com; git update-git-for-windows on Windows)`);
}

function checkCheckout(root, ref, deps) {
  if (deps.isMainCheckout && !deps.isMainCheckout(root)) return item('checkout', 'FAIL', 'this is a lane copy', 'run the preflight in the studio\'s main checkout (where the board and main live)');
  const branch = out1(git(['symbolic-ref', '-q', '--short', 'HEAD'], root));
  if (!branch) return item('checkout', 'FAIL', 'HEAD is not on a branch', 'check out the studio\'s branch (main) first');
  for (const h of ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD']) if (out1(git(['rev-parse', '-q', '--verify', h], root))) return item('checkout', 'FAIL', `a ${h.split('_')[0].toLowerCase()} is in progress`, `finish it or undo it (git ${h === 'MERGE_HEAD' ? 'merge' : h === 'REVERT_HEAD' ? 'revert' : 'cherry-pick'} --abort)`);
  if (ref) {
    const sha = out1(git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root));
    if (!sha) return item('checkout', 'FAIL', `on ${branch}, but "${ref}" doesn't name a commit here`, 'git fetch <remote>, then give the ref as <remote>/<branch>');
    let to = '?'; try { to = JSON.parse(git(['show', `${sha}:package.json`], root).stdout).version || '?'; } catch {}
    const from = readJson(path.join(root, 'package.json'))?.version || '?';
    return item('checkout', 'PASS', `main checkout on ${branch}; ${ref} is ${sha.slice(0, 10)} (harness ${from} -> ${to})`);
  }
  return item('checkout', 'PASS', `main checkout on ${branch}`);
}

function checkBoard(root, deps) {
  if (!deps.checkUpgrade) return [item('board', 'INFO', 'not checked (no upgrade guard)')];
  const c = deps.checkUpgrade(root);
  const outL = [];
  if (!c.ok) outL.push(item('board', 'FAIL', c.dirty?.length ? `${c.dirty.length} board file(s) not committed: ${c.dirty.map((d) => d.file).slice(0, 6).join(', ')}` : c.lines[0] || 'not a git checkout', 'git add -- studio/NEXT.md studio/DONE.md studio/task-holds.json studio/pending-review.json studio/handoffs, then git commit -m "board: snapshot before harness upgrade" (never stash the board)'));
  else outL.push(item('board', 'PASS', 'every board file is committed'));
  if (c.stashes?.length) outL.push(item('stash', 'WARN', `${c.stashes.length} stash entr${c.stashes.length === 1 ? 'y holds' : 'ies hold'} board rows: ${c.stashes.map((s) => `${s.ref} ${s.sha.slice(0, 10)}`).slice(0, 4).join(', ')}`, 'npm run upgrade -- --restore-stash <sha> --by <you> (keeps both sides\' rows; never drops the stash)'));
  return outL;
}

const PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
function checkOwnerKey(root, env) {
  const outL = [];
  const committed = git(['cat-file', '-e', `HEAD:${PUB_REL}`], root).status === 0;
  const onDisk = fs.existsSync(path.join(root, PUB_REL));
  if (committed) outL.push(item('owner-key', 'PASS', `${PUB_REL} is committed: protected files change only with the owner's signature`));
  else if (onDisk) outL.push(item('owner-key', 'FAIL', `${PUB_REL} is there but not committed: nothing is enforced until it is`, `git add ${PUB_REL} and commit it (the public key only)`));
  else outL.push(item('owner-key', 'FAIL', `no owner key (${PUB_REL}): protected files, gates and the policy are not enforced`, 'on the owner\'s own device (not the PC agents run on): npm run approve -- keygen, then commit studio/keys/owner-ed25519.pub.pem'));
  const priv = String(env.STUDIO_OWNER_KEY || '').trim() || path.join(os.homedir(), '.studio-owner', 'owner-ed25519.pem');
  if (fs.existsSync(priv)) outL.push(item('owner-private-key', 'WARN', 'the owner\'s private key is on this machine, where agents run', 'keep it on a device no agent runs on (docs/SECURITY.md); move it there and set STUDIO_OWNER_KEY on that device'));
  return outL;
}

function checkSignatures(root, env) {
  const f = path.join(root, 'qa', 'protected-check.mjs');
  if (!fs.existsSync(f)) return item('signatures', 'INFO', 'no qa/protected-check.mjs in this studio: not checked');
  const r = spawnSync(process.execPath, [f], { cwd: root, encoding: 'utf8', env, timeout: 120000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').filter(Boolean);
  const line = text.find((l) => /^\[protected\] (PASS|note)/.test(l)) || '';
  if (r.status === 0 && /^\[protected\] PASS/.test(line)) return item('signatures', 'PASS', line.replace(/^\[protected\]\s*PASS:?\s*/, '').slice(0, 300) || 'protected check green');
  if (r.status === 0) return item('signatures', 'INFO', `not enforced yet: ${line.replace(/^\[protected\]\s*note:?\s*/, '').slice(0, 200) || 'no owner key'}`);
  return item('signatures', 'FAIL', `protected check red: ${text.filter((l) => !/^\s*$/.test(l)).slice(0, 4).join(' / ').slice(0, 400)}`, 'only the owner signs: on the owner\'s machine npm run approve -- protected --note "why" and commit the approval, or undo the unapproved change');
}

async function scanFor(root, env) {
  const f = path.join(root, 'harness', 'machine.mjs');
  if (fs.existsSync(f)) {
    try {
      const m = await import(pathToFileURL(f).href);
      const p = m.scanMachine({ root, env });
      const disk = m.diskBudget ? m.diskBudget({ root, env, profile: p }) : null;
      return { from: 'machine scan', freeGb: disk?.freeGb ?? p?.disk?.freeGb ?? null, minGb: disk?.minGb ?? null, headroomGb: m.memHeadroomGb ? m.memHeadroomGb(p) : p?.ram?.freeGb ?? null, totalGb: p?.ram?.totalGb ?? null, line: m.machineLine ? m.machineLine(p) : '' };
    } catch { /* node's numbers below */ }
  }
  let freeGb = null; let totalDisk = null;
  try { const s = fs.statfsSync(root); freeGb = Math.round((Number(s.bavail) * Number(s.bsize)) / 1e8) / 10; totalDisk = (Number(s.blocks) * Number(s.bsize)) / 1e9; } catch {}
  return { from: 'node (no harness/machine.mjs)', freeGb, minGb: null, totalDisk, headroomGb: Math.round(os.freemem() / 1e8) / 10, totalGb: Math.round(os.totalmem() / 1e8) / 10, line: '' };
}

async function checkMachine(root, env) {
  const s = await scanFor(root, env);
  const minDisk = s.minGb ?? num(env.STUDIO_DISK_MIN_FREE_GB, Math.max(20, Number.isFinite(s.totalDisk) ? Math.round(s.totalDisk * 0.05) : 20));
  const minRam = num(env.STUDIO_PREFLIGHT_MIN_RAM_GB, 4);
  const outL = [];
  if (!Number.isFinite(s.freeGb)) outL.push(item('disk', 'WARN', `free disk space couldn't be read (${s.from})`, 'check the studio\'s disk by hand: an update and the lane refresh need room'));
  else if (minDisk > 0 && s.freeGb < minDisk) outL.push(item('disk', 'FAIL', `${s.freeGb} GB free on the studio's disk, under ${minDisk} GB (STUDIO_DISK_MIN_FREE_GB; ${s.from})`, 'free space first: npm run janitor (lane copies, old logs and builds), or empty the recycle bin; then run this again'));
  else outL.push(item('disk', 'PASS', `${s.freeGb} GB free (needs ${minDisk} GB; ${s.from})`));
  if (!Number.isFinite(s.headroomGb)) outL.push(item('ram', 'WARN', `memory headroom couldn't be read (${s.from})`, 'close what you don\'t need before the measured run'));
  else if (s.headroomGb < minRam) outL.push(item('ram', 'WARN', `${s.headroomGb} GB of memory headroom${Number.isFinite(s.totalGb) ? ` of ${s.totalGb} GB` : ''}, under ${minRam} GB (STUDIO_PREFLIGHT_MIN_RAM_GB; ${s.from})`, 'close editors, browsers or sessions you don\'t need; the heavy budget admits fewer verifies while memory is short'));
  else outL.push(item('ram', 'PASS', `${s.headroomGb} GB of memory headroom${Number.isFinite(s.totalGb) ? ` of ${s.totalGb} GB` : ''} (${s.from})`));
  return outL;
}

function checkTools(env) {
  const outL = [];
  for (const [k, what] of [['STUDIO_UNITY', 'the Unity editor'], ['GODOT_BIN', 'the Godot binary']]) {
    const v = String(env[k] || '').trim();
    if (!v) continue;
    const found = which(v, env);
    outL.push(found ? item(k, 'PASS', `${k} resolves (${what})`) : item(k, 'FAIL', `${k} is set but ${what} isn't there (${v})`, `set ${k} to ${what}'s full path (in .env or the environment), or unset it`));
  }
  const onPath = ['unity', 'blender', 'ffmpeg'].filter((t) => !(t === 'unity' && String(env.STUDIO_UNITY || '').trim())).map((t) => `${t} ${which(t, env) ? 'yes' : 'no'}`);
  if (onPath.length) outL.push(item('tools-path', 'INFO', `on the PATH: ${onPath.join(', ')}`));
  return outL;
}

function checkWebhook(root, env) {
  const outL = [];
  const tracked = git(['ls-files', '--error-unmatch', '--', '.env'], root).status === 0;
  if (tracked) outL.push(item('dotenv', 'FAIL', '.env is tracked by git: the secrets in it (the webhook, tokens) would be committed and pushed', 'git rm --cached .env, add .env to .gitignore, commit, and rotate anything that was in it'));
  const url = String(env.STUDIO_REPORT_WEBHOOK || '').trim();
  if (!url) outL.push(item('webhook', 'WARN', 'STUDIO_REPORT_WEBHOOK is not set: no reports are posted during the run', 'put STUDIO_REPORT_WEBHOOK=<the channel\'s webhook> in the studio\'s .env (never commit it), then npm run report -- post --dry-run'));
  else if (!/^https?:\/\/[^\s]+$/i.test(url)) outL.push(item('webhook', 'FAIL', 'STUDIO_REPORT_WEBHOOK is set but is not an http(s) URL (not shown)', 'copy the webhook URL again into .env as STUDIO_REPORT_WEBHOOK=https://…'));
  else outL.push(item('webhook', 'PASS', `STUDIO_REPORT_WEBHOOK is set (an ${url.toLowerCase().startsWith('https') ? 'https' : 'http'} URL; not shown)`));
  return outL;
}

function checkPolicy(root) {
  const outL = [];
  for (const rel of ['studio/policy.json', 'studio/delegation.json', 'studio/autonomy.json', 'studio/overseer.json']) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) { outL.push(item(rel, 'INFO', 'none (the defaults hold)')); continue; }
    let ok = true; let why = '';
    try { fs.accessSync(f, fs.constants.R_OK); JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { ok = false; why = String(e.message || e).slice(0, 160); }
    const committed = git(['diff', '--quiet', 'HEAD', '--', rel], root).status === 0 && git(['cat-file', '-e', `HEAD:${rel}`], root).status === 0;
    outL.push(ok ? item(rel, 'PASS', `reads${committed ? '' : ' (not committed as it is now: the committed copy is the one that counts)'}`) : item(rel, 'FAIL', `can't be read: ${why}`, `fix the JSON in ${rel} (the owner's file; git diff ${rel} shows what changed), or git checkout -- ${rel}`));
  }
  return outL;
}

function checkLanes(root) {
  const dir = path.join(root, '.lanes');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name); } catch { return [item('lanes', 'PASS', 'no lane copies')]; }
  const branch = out1(git(['symbolic-ref', '-q', '--short', 'HEAD'], root)) || 'main';
  const busy = [];
  const wt = registeredWorktrees(root);
  const leftover = names.filter((n) => !wt.has(path.join(dir, n)));
  names = names.filter((n) => !leftover.includes(n));
  const left = leftover.length ? [item('lanes-leftover', 'INFO', `${leftover.length} leftover folder${leftover.length === 1 ? '' : 's'} (not a lane: no git worktree): ${leftover.slice(0, 8).join(', ')}${leftover.length > 8 ? ` and ${leftover.length - 8} more` : ''}`)] : [];
  for (const n of names) {
    const ld = path.join(dir, n);
    const dirty = String(git(['status', '--porcelain', '--untracked-files=normal'], ld).stdout || '').split('\n').filter((l) => l.length > 3 && !/\snode_modules\/?$/.test(l)).length;
    const ahead = Number(out1(git(['rev-list', '--count', `${branch}..HEAD`], ld))) || 0;
    if (dirty || ahead) busy.push(`${n} (${[ahead ? `${ahead} commit(s) not on ${branch}` : '', dirty ? `${dirty} uncommitted file(s)` : ''].filter(Boolean).join(', ')})`);
  }
  if (!busy.length) return [item('lanes', 'PASS', `${names.length} lane cop${names.length === 1 ? 'y' : 'ies'}, none with unlanded work`), ...left];
  return [...left, item('lanes', 'WARN', `${busy.length} lane(s) hold unlanded work: ${busy.slice(0, 8).join('; ')}${busy.length > 8 ? ` and ${busy.length - 8} more` : ''}`, 'land them first (npm run task -- train --by <you>), or let their agents commit: the update\'s lane refresh skips a lane with uncommitted work, and its agent merges main in later')];
}

// ---- 2.78.1: before a long run (leftovers from earlier workarounds) -------------------------------------------------

/** harness/upgrade-leftovers.json: the studio's own, else the one beside this file. [{ version, key, value?, why }]. */
export function readLeftovers(root) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of [path.join(root, 'harness', 'upgrade-leftovers.json'), path.join(here, 'upgrade-leftovers.json')]) {
    const j = readJson(f);
    if (j && Array.isArray(j.leftovers)) return j.leftovers.filter((x) => x && /^[A-Z][A-Z0-9_]*$/.test(String(x.key || '')) && x.version);
  }
  return [];
}
const pidLive = (pid) => { const n = Number(pid); if (!Number.isInteger(n) || n <= 0) return false; try { process.kill(n, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** .env keys a later release made unnecessary (WARN), from harness/upgrade-leftovers.json. Values are never printed. */
function checkLeftoverEnv(root) {
  const version = readJson(path.join(root, 'package.json'))?.version || '0.0.0';
  const dot = readDotEnv(root);
  const hits = readLeftovers(root).filter((x) => versionAtLeast(version, `>=${x.version}`) && String(dot[x.key] ?? '').trim() !== '' && (x.value === undefined || x.value === null || String(dot[x.key]).trim() === String(x.value)));
  if (!hits.length) return [item('long-run/env', 'PASS', 'no .env workaround a release since made unnecessary (harness/upgrade-leftovers.json)')];
  return hits.map((x) => item('long-run/env', 'WARN', `${x.key}${x.value !== undefined && x.value !== null ? `=${x.value}` : ' is set'} in .env, a workaround ${x.version} made unnecessary: ${x.why}`, `remove the ${x.key} line from the studio's .env (the owner edits it), then npm run studio:reload-env`));
}

/** Ready builder tasks with no lane (each would hold the whole game, so no other builder runs beside it). */
async function checkUnscoped(root) {
  const t = path.join(root, 'harness', 'task.mjs');
  const h = path.join(root, 'harness', 'task-hold.mjs');
  if (!fs.existsSync(t) || !fs.existsSync(h)) return [];
  try {
    const tm = await import(pathToFileURL(t).href);
    const hm = await import(pathToFileURL(h).href);
    let events = [];
    try { events = (await import(pathToFileURL(path.join(root, 'harness', 'event.mjs')).href)).readRecentEvents(20000); } catch {}
    const q = tm.parseNextQueue();
    const holds = hm.readHolds ? hm.readHolds() : {};
    const now = Date.now();
    const ready = (q.backlog || []).filter((x) => x.role === 'builder' && !(hm.holdReason && hm.holdReason(x.id, q, now, holds, x.role)));
    const onPurpose = (id) => (holds[id] && 'lane' in holds[id]) || events.some((e) => e.type === 'task.added' && e.task === id && e.meta?.wholeGame);
    const none = ready.filter((x) => !hm.laneOf(x.id, events, holds) && !onPurpose(x.id));
    if (!none.length) return [item('long-run/lanes', 'PASS', `${ready.length} ready builder task(s), each with a lane`)];
    return [item('long-run/lanes', 'WARN', `${none.length} ready builder task(s) have no lane: ${none.map((x) => x.id).slice(0, 10).join(', ')}${none.length > 10 ? ` and ${none.length - 10} more` : ''}; a builder on one works on the whole game, so no other builder starts beside it`, 'set each one\'s folders: npm run task -- lane <ID> <folder>[,<folder>…] (or "all" when it really needs the whole game)')];
  } catch (e) { return [item('long-run/lanes', 'INFO', `ready tasks not read (${String(e.message || e).slice(0, 120)})`)]; }
}

/** Uncommitted changes in harness/ or scripts/: a local patch runs instead of the release's code. */
function checkHarnessDirty(root) {
  const r = git(['status', '--porcelain=v1', '--untracked-files=normal', '--', 'harness', 'scripts'], root);
  const files = r.status === 0 ? String(r.stdout || '').split(/\r?\n/).filter((l) => l.length > 3).map((l) => l.slice(3).trim()) : [];
  if (!files.length) return [item('long-run/harness', 'PASS', 'no uncommitted change in harness/ or scripts/')];
  return [item('long-run/harness', 'WARN', `${files.length} uncommitted change(s) in the harness: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ` and ${files.length - 8} more` : ''} (a local patch runs instead of the release's code)`, 'if the release fixed what the patch worked around, undo it (git diff <file>, then git checkout -- <file>); if not, keep it and report it to the harness')];
}

/** Trains and gate runs still running from before the harness last changed (they run the old code). */
function checkOldRuns(root) {
  const since = Number(out1(git(['log', '-1', '--format=%ct', 'HEAD', '--', 'harness', 'scripts', 'package.json'], root))) * 1000 || 0;
  const tree = ['harness', 'scripts'].map((d) => out1(git(['rev-parse', '-q', '--verify', `HEAD:${d}`], root))).join('+');
  const old = [];
  const tdir = path.join(root, '.studio', 'train');
  let names = [];
  try { names = fs.readdirSync(tdir); } catch {}
  for (const n of names) {
    const life = readJson(path.join(tdir, n, 'life.json'));
    if (!life || life.ended || !pidLive(life.pid)) continue;
    const before = life.harness?.tree ? life.harness.tree !== tree : since && Date.parse(life.at || 0) < since;
    if (before) old.push(`train ${life.id || n} (pid ${life.pid}${life.harness?.version ? `, harness ${life.harness.version}` : ''})`);
  }
  const vdir = path.join(root, '.studio', 'verify-running');
  let runs = [];
  try { runs = fs.readdirSync(vdir).filter((f) => f.endsWith('.json') && !f.endsWith('.result.json')); } catch {}
  for (const f of runs) {
    const st = readJson(path.join(vdir, f));
    const pid = st?.hostPid || st?.pid;
    if (!st || st.state === 'done' || !pidLive(pid)) continue;
    if (since && Date.parse(st.startedAt || 0) < since) old.push(`gate run ${st.owner || f.replace(/\.json$/, '')} (pid ${pid}, since ${String(st.startedAt || '').slice(0, 16)})`);
  }
  if (!old.length) return [item('long-run/runs', 'PASS', 'no train or gate run from before the harness last changed is still running')];
  return [item('long-run/runs', 'WARN', `${old.length} still running from before the harness last changed (they run the old code): ${old.slice(0, 6).join('; ')}${old.length > 6 ? ` and ${old.length - 6} more` : ''}`, 'let them finish, or stop them (npm run task -- train cancel, npm run studio:stop); the supervisor and train daemon start fresh ones on the new harness')];
}

/** 2.78.2 (f): the studio game's test checks (focus command, quarantine / exclude honoured), via the studio's own module. */
async function checkGameTests(root, env) {
  const f = path.join(root, 'harness', 'test-config-check.mjs');
  if (!fs.existsSync(f)) return [];
  try {
    const m = await import(pathToFileURL(f).href);
    return m.testCheckItems ? await m.testCheckItems({ root, env, write: false }) : [];
  } catch (e) { return [item('game-tests', 'INFO', `the game's test checks were not read (${String(e.message || e).slice(0, 160)})`)]; }
}

/** 2.78.1: "before a long run": leftovers from earlier workarounds. WARN only, never a FAIL. */
export async function longRunItems(root) {
  return [...checkLeftoverEnv(root), ...(await checkUnscoped(root)), ...checkHarnessDirty(root), ...checkOldRuns(root)];
}

/** The preflight: { ok, items, lines }. deps: { checkUpgrade, isMainCheckout } (the guard's). */
export async function preflight({ root, ref = null, env = process.env, deps = {} } = {}) {
  // The environment wins over .env, except where it is empty (an empty value is no value).
  const e = { ...readDotEnv(root) };
  for (const [k, v] of Object.entries(env)) if (String(v ?? '').trim() !== '' || !(k in e)) e[k] = v;
  const items = [checkNode(root, ref), checkGit(e), checkCheckout(root, ref, deps), ...checkBoard(root, deps), ...checkOwnerKey(root, e), checkSignatures(root, env), ...(await checkMachine(root, e)), ...checkTools(e), ...checkWebhook(root, e), ...checkDotEnvIdentity(root), ...checkPolicy(root), ...checkLanes(root), ...(await checkGameTests(root, e)), ...(await longRunItems(root))];
  return { ok: !items.some((i) => i.status === 'FAIL'), items, lines: itemLines('preflight', items) };
}

/** PASS/WARN/FAIL/INFO lines with a Fix line under each WARN and FAIL, and a summary line. */
export function itemLines(what, items) {
  const L = [];
  for (const i of items) {
    L.push(`[upgrade ${what}] ${i.status.padEnd(4)} ${i.id}: ${i.detail}`);
    if (i.fix && (i.status === 'FAIL' || i.status === 'WARN')) L.push(`  Fix: ${i.fix}`);
  }
  const n = (s) => items.filter((i) => i.status === s).length;
  L.push(`[upgrade ${what}] ${n('FAIL') ? 'FAIL' : 'PASS'}: ${n('PASS')} pass, ${n('WARN')} warn, ${n('FAIL')} fail${n('INFO') ? `, ${n('INFO')} info` : ''}.`);
  return L;
}
