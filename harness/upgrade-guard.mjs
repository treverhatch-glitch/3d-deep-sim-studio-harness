#!/usr/bin/env node
/**
 * harness/upgrade-guard.mjs — the board is committed before a harness upgrade, never stashed (a stash hides the board
 * files other agents write all day; a merge keeps both sides).
 *
 *   npm run upgrade -- --check      exit 1 while a board file is uncommitted (names them and the commit command); also
 *                                   names stash entries that hold board changes
 *   npm run upgrade -- --snapshot   copy the board files to .studio/board-snapshots/<time>/ (gitignored), then check
 *   npm run upgrade -- --merge <ref> --by <person> [--permission "<their words or a link>"] [--golden-reason "<why>"]
 *       refuses unless --check passes, backs the branch up as backup/pre-<version>, merges <ref> in the main checkout
 *       through the hooks, with the main-checkout guard opened for exactly this merge (STUDIO_UPGRADE_MERGE = the merged
 *       commit; scripts/hooks/pre-commit checks MERGE_HEAD). The merge commit records Upgrade-By / -Permission /
 *       -Recorded-By / -Ref / -Versions / -Backup trailers and an upgrade.merged event. A person in their own terminal
 *       needs no --permission; an agent needs it (harness/permission.mjs); a worker is refused. A conflict stops with
 *       the files listed and `git merge --abort` advice; nothing is resolved for anyone. `--continue` commits a merge a
 *       person resolved. Goldens: `Golden-Reason: from <ref> (upgrade)` is added for qa/golden files exactly as on
 *       <ref>; a golden combined with the studio's own change needs --golden-reason (a person's).
 *   npm run upgrade -- --restore-stash <sha> --by <person>
 *       three-way merges a stash's board files into the committed board, keeping both sides' rows (studio/NEXT.md,
 *       studio/DONE.md); any other conflict refuses, writing nothing. Commits; never drops the stash.
 *   npm run upgrade -- --rollback --by <person> [--permission "…"]   revert the last update's merge commit, never a reset
 *   npm run upgrade -- --preflight [--ref <ref>]   before an update (harness/upgrade-preflight.mjs, read-only)
 *   npm run upgrade -- --smoke [--keep]            right after one (harness/upgrade-smoke.mjs)
 *   `--merge` also writes the "before" snapshot .studio/upgrades/<from>-to-<to>.json (harness/upgrade-baseline.mjs)
 *   that `npm run autonomy -- impact` compares against.
 *
 * A merged update ends with `npm run lanes -- refresh --all`, reported per lane: refreshed / conflicted / red / skipped.
 * STUDIO_UPGRADE_REFRESH=off skips it; =no-tests skips the targeted tests.
 *
 * Bootstrap: an old studio has no --merge, so docs/RELEASE.md runs this guard from the ref (`git show
 * <ref>:harness/upgrade-guard.mjs` into .studio/). So it finds the studio by git from the current folder, never by
 * its own location, and loads harness/permission.mjs from beside it, the studio, or the ref.
 *
 * Board files: studio/NEXT.md, studio/DONE.md, studio/task-holds.json, studio/pending-review.json, studio/handoffs/.
 * --check and --snapshot never stash, commit or change a tracked file. docs/RELEASE.md "Taking a harness update" has the steps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const BOARD_FILES = ['studio/NEXT.md', 'studio/DONE.md', 'studio/task-holds.json', 'studio/pending-review.json', 'studio/handoffs'];
// Board files whose conflicting rows are all kept (one task per line).
export const ROW_FILES = ['studio/NEXT.md', 'studio/DONE.md'];
const git = (args, cwd, opts = {}) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const out1 = (r) => (r.status === 0 ? r.stdout.trim() : '');

/** The checkout to work on: git's top level for the current folder, never this file's folder (a copy runs anywhere). */
export function repoRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}
const ROOT = repoRoot() || process.cwd();

/** Board files with uncommitted changes: [{ file, state }], or null when not a git checkout. */
export function dirtyBoard(root = ROOT) {
  if (!root) return null;
  const r = git(['status', '--porcelain', '--untracked-files=all', '--', ...BOARD_FILES], root);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.length > 3).map((l) => ({ state: l.slice(0, 2), file: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }));
}

/** Board files a stash changed, including its untracked files (third parent). */
function stashBoardFiles(sha, root) {
  const files = new Set(git(['diff', '--name-only', '--no-renames', `${sha}^1`, sha, '--', ...BOARD_FILES], root).stdout.split('\n').filter(Boolean));
  const untracked = new Set();
  if (git(['rev-parse', '--verify', '--quiet', `${sha}^3`], root).status === 0) {
    for (const f of git(['ls-tree', '-r', '--name-only', `${sha}^3`, '--', ...BOARD_FILES], root).stdout.split('\n').filter(Boolean)) { files.add(f); untracked.add(f); }
  }
  return { files: [...files], untracked };
}

/** Stash entries that hold changes to board files: [{ ref, sha, message, files }]. */
export function stashesWithBoard(root = ROOT) {
  const list = git(['stash', 'list', '--format=%gd%x1f%H%x1f%gs'], root);
  if (list.status !== 0) return [];
  const out = [];
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const [ref, sha, message] = line.split('\x1f');
    const { files } = stashBoardFiles(sha, root);
    if (files.length) out.push({ ref, sha, message, files });
  }
  return out;
}

/** Copy the board files to .studio/board-snapshots/<time>/; returns that folder (repo-relative). */
export function snapshotBoard(root = ROOT, now = new Date()) {
  const rel = path.posix.join('.studio', 'board-snapshots', now.toISOString().replace(/[:.]/g, '-'));
  const dest = path.join(root, rel);
  for (const f of BOARD_FILES) {
    const src = path.join(root, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.cpSync(src, path.join(dest, f), { recursive: true });
  }
  return rel;
}

export function checkUpgrade(root = ROOT) {
  const dirty = dirtyBoard(root);
  const stashes = dirty === null ? [] : stashesWithBoard(root);
  const lines = [];
  if (dirty === null) return { ok: false, dirty: [], stashes, lines: ['[upgrade] not a git checkout: nothing to check (run it inside the studio\'s main checkout)'] };
  if (dirty.length) {
    lines.push(`[upgrade] STOP: ${dirty.length} board file(s) are not committed, and an upgrade must never stash them:`);
    for (const d of dirty) lines.push(`  ${d.state} ${d.file}`);
    lines.push('[upgrade] Commit the board first (it is studio state; other agents keep writing it):');
    lines.push(`  git add -- ${BOARD_FILES.join(' ')}`);
    lines.push('  git commit -m "board: snapshot before harness upgrade"');
    lines.push('[upgrade] Then run npm run upgrade -- --check again. (--snapshot also copies them to .studio/board-snapshots/.)');
  } else lines.push('[upgrade] OK: every board file is committed.');
  if (stashes.length) {
    lines.push(`[upgrade] note: ${stashes.length} stash entr${stashes.length === 1 ? 'y holds' : 'ies hold'} board changes that may not be on the board now:`);
    for (const s of stashes) lines.push(`  ${s.ref} ${s.sha.slice(0, 10)} "${s.message}": ${s.files.join(', ')}`);
    lines.push('[upgrade] Restore by merge, never by dropping or checking out a side: commit the board as it is now, then');
    lines.push('  npm run upgrade -- --restore-stash <sha> --by <your name>   (keeps both sides\' rows, commits, never drops)');
    lines.push('  or by hand: git stash apply <sha>   (a three-way merge; resolve each board conflict by keeping the rows from both sides)');
    lines.push('  and commit. Drop the entry only after the board has every row (git stash list shows it until then).');
  }
  return { ok: dirty.length === 0, dirty, stashes, lines };
}

// ---- who may take an update, the merge, a stash's board rows ----

const AGENT_SHELL = ['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
// The names harness/agent-env.mjs AGENTISH lists, for a studio too old to have it.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|scout|designer|balancer|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|nim|sound|composer|writer)\b/i;

const importFile = (f) => import(pathToFileURL(f).href);
/** harness/permission.mjs: beside this file, in the studio, or from the ref being merged. */
async function loadPermission(root, ref = null) {
  for (const f of [path.join(path.dirname(SELF), 'permission.mjs'), path.join(root, 'harness', 'permission.mjs')]) {
    if (fs.existsSync(f)) { try { return await importFile(f); } catch {} }
  }
  if (ref) {
    const r = git(['show', `${ref}:harness/permission.mjs`], root);
    if (r.status === 0 && r.stdout) {
      const f = path.join(root, '.studio', 'upgrade-permission.mjs');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, r.stdout);
      try { return await importFile(f); } catch {}
    }
  }
  return null;
}
/** A helper with no harness imports (upgrade-baseline.mjs, upgrade-preflight.mjs): beside this file, in the studio, or from the ref (copied to .studio/). */
export async function loadHelper(name, root, ref = null) {
  const beside = path.join(path.dirname(SELF), name);
  // Beside this file only when it is a harness's own (a copy in .studio/ may sit beside an older one).
  const first = path.basename(path.dirname(SELF)) === 'harness' ? [beside] : [];
  for (const f of [...first, path.join(root, 'harness', name)]) {
    if (fs.existsSync(f)) { try { return await importFile(f); } catch {} }
  }
  if (ref) {
    const r = git(['show', `${ref}:harness/${name}`], root);
    if (r.status === 0 && r.stdout) {
      const f = path.join(root, '.studio', name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, r.stdout);
      try { return await importFile(`${f}`); } catch {}
    }
  }
  if (!first.length && fs.existsSync(beside)) { try { return await importFile(beside); } catch {} }
  return null;
}

/** The studio's event log, or [] when unreadable. */
async function studioEvents(root, limit = 200000) {
  const f = path.join(root, 'harness', 'event.mjs');
  if (!fs.existsSync(f)) return [];
  try { const m = await importFile(f); return m.readRecentEvents ? m.readRecentEvents(limit) : []; } catch { return []; }
}

/** The "before" snapshot (harness/upgrade-baseline.mjs) just before a merge. A failure is one line, never a stop. */
export async function beforeSnapshot({ root, from, to, ref, sha, by, env = process.env, now = new Date() }) {
  try {
    const b = await loadHelper('upgrade-baseline.mjs', root, ref);
    if (!b?.writeSnapshot) return { lines: ['[upgrade] before snapshot: not taken (harness/upgrade-baseline.mjs was not found beside the guard, in the studio or on the ref)'] };
    const s = b.writeSnapshot({ root, from, to, ref, sha, by: String(by || '').trim().slice(0, 60) || null, events: await studioEvents(root), now: now.getTime(), env });
    return { file: s.file, lines: [b.snapshotLine(s)] };
  } catch (e) { return { lines: [`[upgrade] before snapshot: not taken (${String(e.message || e).slice(0, 200)})`] }; }
}

async function agentLike(root, who) {
  const f = path.join(root, 'harness', 'agent-env.mjs');
  if (fs.existsSync(f)) { try { const m = await importFile(f); if (m.agentLikeName) return m.agentLikeName(who, { stateDir: path.join(root, '.studio') }); } catch {} }
  return !who || AGENTISH.test(who);
}

/**
 * May this caller take an update (or restore board rows) for <by>? { ok, why, via, recordedBy, permission }. Workers
 * never; an agent (launched session, coding agent's shell, agent name in STUDIO_LOCK_OWNER) needs a person's direct
 * permission when needPermission (harness/permission.mjs); a person in their own terminal doesn't.
 */
export async function whoActs({ by, permission, env = process.env, root = ROOT, ref = null, needPermission = true }) {
  const who = String(by || '').trim();
  const perm = await loadPermission(root, ref);
  if (!perm) return { ok: false, why: 'harness/permission.mjs was not found (beside this file, in the studio or on the ref), so who may do this can\'t be checked' };
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (role && !perm.DECIDER_ROLES.test(role)) return { ok: false, why: `a launched ${role} session can't do this; only a person, or with a person's direct permission a Producer or Director session or an agent outside the harness, can` };
  if (owner && perm.WORKER_NAME.test(owner)) return { ok: false, why: `${owner} is a worker agent; only a person, or with a person's direct permission a Producer or Director session or an agent outside the harness, can` };
  if (!who) return { ok: false, why: '--by <name> is required: the person taking the update (or who asked for it)' };
  if (await agentLike(root, who)) return { ok: false, why: `--by names the person; "${who}" is an agent's name` };
  const text = perm.permissionText(permission);
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  const agent = Boolean(role || marker || (owner && AGENTISH.test(owner)));
  if (!text) {
    if (agent && needPermission) return { ok: false, why: `an agent needs the person's direct permission: --by ${who} --permission "<their words, or a link to the message>"` };
    return { ok: true, via: agent ? 'agent' : 'person', recordedBy: agent ? (owner || (role ? `a ${role.toLowerCase()} session` : `a coding agent (${marker})`)) : 'a person\'s terminal', permission: '' };
  }
  const r = perm.agentOnPermission({ permission: text, env });
  if (!r.ok) return { ok: false, why: r.why };
  return { ok: true, via: r.via, recordedBy: r.recordedBy, permission: text.replace(/\s+/g, ' ').slice(0, 500) };
}

async function emit(root, event) {
  const f = path.join(root, 'harness', 'event.mjs');
  if (!fs.existsSync(f)) return;
  try { const m = await importFile(f); m.emitEvent?.(event); } catch {}
}
const versionAt = (root, rev) => { try { return JSON.parse(git(['show', `${rev}:package.json`], root).stdout).version || '?'; } catch { return '?'; } };
const gitPath = (root, name) => path.resolve(root, out1(git(['rev-parse', '--git-path', name], root)));
// Compared as real paths: a root reached through a link or a Windows 8.3 short name (RUNNER~1) would look like a lane copy.
const realOf = (p) => { let r = p; try { r = fs.realpathSync.native(p); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
export const isMainCheckout = (root) => {
  const d = out1(git(['rev-parse', '--absolute-git-dir'], root));
  const c = out1(git(['rev-parse', '--git-common-dir'], root));
  return Boolean(d) && realOf(path.resolve(root, d)) === realOf(path.resolve(root, c));
};
const unmergedFiles = (root) => git(['diff', '--name-only', '--diff-filter=U'], root).stdout.split('\n').filter(Boolean);

/** The qa/golden files a merge changes: fromRef (exactly as on <sha>) or combined (with the studio's change). */
export function mergeGoldens(root, sha) {
  const names = git(['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--', 'qa/golden'], root).stdout.split('\n').filter(Boolean);
  const fromRef = [];
  const combined = [];
  for (const f of names) {
    const staged = out1(git(['rev-parse', '--verify', '--quiet', `:${f}`], root));
    const onRef = out1(git(['rev-parse', '--verify', '--quiet', `${sha}:${f}`], root));
    (staged === onRef ? fromRef : combined).push(f);
  }
  return { fromRef, combined };
}

const short = (files, n = 8) => `${files.slice(0, n).join(', ')}${files.length > n ? ` and ${files.length - n} more` : ''}`;

/** `--merge` (see the header; `cont` = --continue). Returns { ok, code, lines, commit?, backup?, conflicts? }. */
export async function upgradeMerge({ ref, by, permission = '', goldenReason = '', cont = false, root = ROOT, env = process.env, now = new Date() } = {}) {
  const lines = [];
  const stop = (why, extra = {}) => ({ ok: false, code: 1, lines: [...lines, `[upgrade] Not merged: ${why}`], ...extra });
  if (!root || !repoRoot(root)) return stop('this isn\'t a git checkout; run it in the studio\'s main checkout');
  if (!ref) return stop('which ref? npm run upgrade -- --merge <ref> --by <your name> (for example upstream/main, after git fetch upstream)');
  if (!isMainCheckout(root)) return stop('this is a lane copy; take the update in the studio\'s main checkout (the board and main live there)');
  const branch = out1(git(['symbolic-ref', '-q', '--short', 'HEAD'], root));
  if (!branch) return stop('HEAD is not on a branch; check out the studio\'s branch (main) first');
  const sha = out1(git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root));
  if (!sha) return stop(`"${ref}" doesn't name a commit here. Fetch it first (git fetch <remote>), then give it as <remote>/<branch>`);
  const who = await whoActs({ by, permission, env, root, ref });
  if (!who.ok) return stop(who.why);
  const mergeHead = out1(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root));
  if (cont) {
    if (mergeHead !== sha) return stop(mergeHead ? `the merge in progress is of ${mergeHead.slice(0, 10)}, not ${ref}` : 'no merge in progress to continue');
    const left = unmergedFiles(root);
    if (left.length) return stop(`these files still have conflicts: ${short(left)}`, { conflicts: left });
  } else {
    if (mergeHead) return stop('a merge is already in progress here: finish it (a person resolves the files, then --continue) or undo it with git merge --abort');
    const check = checkUpgrade(root);
    if (!check.ok) return { ok: false, code: 1, lines: [...check.lines, '[upgrade] Not merged: commit the board first (above).'] };
    if (git(['diff', '--cached', '--quiet'], root).status !== 0) return stop('there are staged changes; they would go into the merge commit. Commit them or unstage them (git restore --staged <files>) first');
  }
  const from = versionAt(root, 'HEAD');
  const to = versionAt(root, sha);
  if (!cont && git(['merge-base', '--is-ancestor', sha, 'HEAD'], root).status === 0) return { ok: true, code: 0, lines: [...lines, `[upgrade] ${branch} already has ${ref} (${sha.slice(0, 10)}): nothing to merge.`] };

  // The scorecard just before the update (.studio/upgrades/<from>-to-<to>.json; kept on --continue).
  const snap = await beforeSnapshot({ root, from, to, ref, sha, by, env, now });
  lines.push(...snap.lines);
  // Backup of the branch (reused when it already points there).
  let backup = `backup/pre-${to}`;
  const head = out1(git(['rev-parse', 'HEAD'], root));
  const existing = out1(git(['rev-parse', '--verify', '--quiet', `refs/heads/${backup}`], root));
  if (existing && existing !== head) backup = `${backup}-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (existing !== head) {
    const b = git(['branch', backup, head], root);
    if (b.status !== 0) return stop(`could not make the backup branch ${backup}: ${b.stderr.trim()}`);
  }
  lines.push(`[upgrade] ${branch} backed up as ${backup} (${head.slice(0, 10)}).`);

  const betaBefore = betaAt(root, 'HEAD');
  if (!cont) {
    const m = git(['merge', '--no-ff', '--no-commit', sha], root, { env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
    // Beta mode is the owner's switch: studio/beta.json stays as the studio had it.
    keepStudioBeta(root, betaBefore);
    const conflicts = unmergedFiles(root);
    if (conflicts.length) {
      await emit(root, { type: 'upgrade.merge_conflict', agent: String(by).trim().slice(0, 60), msg: `harness update ${ref} (${from} -> ${to}) stopped on ${conflicts.length} conflicting file(s): ${short(conflicts, 5)}`.slice(0, 600), meta: { ref, sha, from, to, backup, files: conflicts.slice(0, 50), recordedBy: who.recordedBy } });
      return {
        ok: false, code: 1, conflicts, backup,
        lines: [...lines, `[upgrade] STOP: merging ${ref} into ${branch} conflicts in ${conflicts.length} file(s). Nothing was committed and nothing was resolved:`,
          ...conflicts.map((f) => `  ${f}`),
          '[upgrade] Undo it (the branch goes back to where it was): git merge --abort',
          `[upgrade] How to resolve an update's conflicts is the owner's call. A person who resolves them by hand (git add each file) finishes with: npm run upgrade -- --merge ${ref} --by <name> --continue`],
      };
    }
    if (m.status !== 0 || !out1(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root))) return stop(`git merge refused: ${(m.stderr || m.stdout).trim().split('\n').slice(0, 6).join(' / ')}`, { backup });
  }

  // Goldens exactly as on the ref carry the upgrade's reason; a combined one needs a person's.
  const g = mergeGoldens(root, sha);
  const reason = String(goldenReason || '').trim();
  if (g.combined.length && reason.length < 10) {
    if (!cont) git(['merge', '--abort'], root);
    return stop(`${g.combined.length} golden file(s) differ from ${ref}'s (the merge combined the studio's change with the update's): ${short(g.combined)}. ${cont ? 'The merge is still in progress. ' : 'The merge was undone. '}Say why the recorded answers changed: --golden-reason "<why, 10+ characters>" (it is added as a Golden-Reason trailer).`, { backup, combinedGoldens: g.combined });
  }

  if (cont) keepStudioBeta(root, betaBefore);
  const trailers = [`Upgrade-By: ${String(by).trim()}`];
  if (who.permission) trailers.push(`Upgrade-Permission: ${who.permission}`);
  trailers.push(`Upgrade-Recorded-By: ${who.recordedBy}`, `Upgrade-Ref: ${ref} ${sha}`, `Upgrade-Versions: ${from} -> ${to}`, `Upgrade-Backup: ${backup}`);
  if (g.fromRef.length) trailers.push(`Golden-Reason: from ${ref} (upgrade): ${short(g.fromRef, 20)}`);
  if (g.combined.length) trailers.push(`Golden-Reason: ${reason.replace(/\s+/g, ' ').slice(0, 300)} (${String(by).trim()}, for ${short(g.combined, 20)})`);
  const msg = [`upgrade: merge harness ${to} from ${ref} into ${branch} (${from} -> ${to})`, '', ...trailers, ''].join('\n');
  const msgFile = gitPath(root, 'STUDIO_UPGRADE_MSG');
  fs.writeFileSync(msgFile, msg);
  // STUDIO_UPGRADE_MERGE opens the main-checkout guard for this commit only; other hooks run as usual.
  const c = git(['commit', '-F', msgFile], root, { env: { ...env, STUDIO_UPGRADE_MERGE: sha } });
  try { fs.rmSync(msgFile, { force: true }); } catch {}
  if (c.status !== 0) {
    return stop(`the hooks refused the merge commit (the merge is still in progress; fix what they say and run --continue, or undo it with git merge --abort):\n${`${c.stdout}${c.stderr}`.trim().split('\n').slice(-15).map((l) => `  ${l}`).join('\n')}`, { backup });
  }
  const commit = out1(git(['rev-parse', 'HEAD'], root));
  lines.push(betaAcrossLine(betaBefore, betaAt(root, 'HEAD')));
  // List the update's commits (made without this studio's hooks) as exempt; a failure is said, never fatal.
  try {
    const hs = await import(pathToFileURL(path.join(root, 'harness', 'hook-stamp.mjs')).href);
    // From the hooks gate's own base, so an earlier unlisted update is covered too.
    const b = hs.changeBase ? await hs.changeBase(env).catch(() => null) : null;
    const gf = hs.grandfatherRange ? await hs.grandfatherRange(`${b?.base || head}..${sha}`, root) : null;
    if (gf?.ok && gf.added) lines.push(`[upgrade] ${gf.added} commit(s) of the update listed as made without this studio's hooks (exempt from the hooks gate)${gf.merges ? `, ${gf.merges} of them its own merge commits (2.78.1)` : ''}.`);
    else if (gf && !gf.ok) lines.push(`[upgrade] WARN couldn't list the update's commits for the hooks gate (${gf.why}): node harness/hook-stamp.mjs grandfather adds them by hand.`);
  } catch (e) { lines.push(`[upgrade] WARN couldn't list the update's commits for the hooks gate (${String(e?.message || e).slice(0, 160)}).`); }
  // Open engine-porter tasks get their track (the studio's only engine; with several they are listed for a person);
  // "unity" reads as engine:unity. A missing helper or failure is said, never fatal.
  try {
    const etf = path.join(root, 'harness', 'engine-tracks.mjs');
    const et = fs.existsSync(etf) ? await import(pathToFileURL(etf).href) : null;
    if (et?.backfillEngineTracks) {
      const bf = await et.backfillEngineTracks({ root, by: String(by).trim().slice(0, 60), env });
      lines.push(...bf.lines);
    }
  } catch (e) { lines.push(`[upgrade] WARN couldn't backfill the engine tracks of open engine-porter tasks (${String(e?.message || e).slice(0, 160)}): node harness/engine-tracks.mjs backfill --by <you> does it.`); }
  await emit(root, {
    type: 'upgrade.merged', agent: String(by).trim().slice(0, 60),
    msg: `harness update ${ref} (${from} -> ${to}) merged into ${branch} as ${commit.slice(0, 10)} for ${String(by).trim()}${who.permission ? ` (recorded by ${who.recordedBy} on their permission: "${who.permission.slice(0, 120)}")` : ''}; backup ${backup}`.slice(0, 600),
    meta: { ref, sha, from, to, branch, backup, commit, by: String(by).trim().slice(0, 60), recordedBy: who.recordedBy, permission: who.permission || null, goldens: g.fromRef.length + g.combined.length, ...(snap.file ? { baseline: snap.file } : {}) },
  });
  // Lane copies take the update now, so the next train doesn't hand them back as stale.
  const lanes = refreshLanesAfterUpgrade({ root, by: String(by).trim(), env });
  return {
    ok: true, code: 0, commit, backup, lanes,
    lines: [...lines, `[upgrade] PASS merged ${ref} (${sha.slice(0, 10)}, harness ${from} -> ${to}) into ${branch}: ${commit.slice(0, 10)}, recorded for ${String(by).trim()}${who.permission ? ` on their permission (recorded by ${who.recordedBy})` : ''}.`,
      ...(g.fromRef.length ? [`[upgrade] ${g.fromRef.length} golden file(s) came unchanged from ${ref}: Golden-Reason added for them only.`] : []),
      ...lanes.lines,
      '[upgrade] Next: npm run verify -- --all, then npm run task -- drain off --by <you>. Undo: git reset --hard ' + backup + ' (only before anything else lands).'],
  };
}

/** studio/beta.json as committed at `rev`: { present, on, text }. Read from git (this file also runs from a ref). */
export const BETA_FILE = 'studio/beta.json';
export function betaAt(root, rev = 'HEAD') {
  const r = git(['show', `${rev}:${BETA_FILE}`], root);
  if (r.status !== 0) return { present: false, on: false, text: null };
  let on = false;
  try { on = JSON.parse(r.stdout)?.on === true; } catch { /* unreadable: off */ }
  return { present: true, on, text: r.stdout };
}
/** Put studio/beta.json back (staged) as the studio had it before the merge. */
export function keepStudioBeta(root, before) {
  const now = git(['show', `:${BETA_FILE}`], root);
  const unmerged = git(['ls-files', '-u', '--', BETA_FILE], root).stdout.trim() !== '';
  if (before.present) {
    if (!unmerged && now.status === 0 && now.stdout === before.text) return false;
    git(['checkout', 'HEAD', '--', BETA_FILE], root);
    return true;
  }
  if (now.status !== 0 && !unmerged) return false;
  git(['rm', '-q', '-f', '--cached', '--', BETA_FILE], root);
  try { fs.rmSync(path.join(root, BETA_FILE), { force: true }); } catch { /* gone */ }
  return true;
}
/** Beta mode before and after the update, one line. */
export function betaAcrossLine(before, after) {
  if (before.on && after.on) return '[upgrade] Beta mode was on before the upgrade and is on after (studio/beta.json kept as the studio had it).';
  if (!before.on && !after.on) return `[upgrade] Beta mode was off before the upgrade and is off after${before.present ? '' : ' (no studio/beta.json)'}.`;
  if (before.on) return `[upgrade] WARN beta mode was on before the upgrade and is OFF after: studio/beta.json ${after.present ? 'says on: false' : 'is gone'} in the merge commit. The owner turns it on again (npm run beta -- on --by <owner>).`;
  return '[upgrade] WARN beta mode was off before the upgrade and is ON after: the update brought a studio/beta.json; the owner turns it off (npm run beta -- off --by <owner>).';
}

/**
 * 2.85 (e): after an update, the hooks gate as it will judge the next `task done`: when its unstamped commits all came
 * in with a harness release merged by a plain `git merge`, one line "hooks check: N upstream commits are unstamped; run:
 * <command>" (harness/hooks-upgrade-hint.mjs; it exempts nothing). '' when there are none, or the helper isn't there.
 * deps.check (tests): () -> { open, baseSha } instead of running `node harness/hook-stamp.mjs check --json`.
 */
export async function hooksAfterUpgrade(root = ROOT, { env = process.env, deps = {} } = {}) {
  try {
    const helper = path.join(root, 'harness', 'hooks-upgrade-hint.mjs');
    if (!fs.existsSync(helper)) return '';
    let r = deps.check ? await deps.check() : null;
    if (!r) {
      const c = spawnSync(process.execPath, [path.join(root, 'harness', 'hook-stamp.mjs'), 'check', '--json'], { windowsHide: true, cwd: root, encoding: 'utf8', env, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
      const l = String(c.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
      r = l ? JSON.parse(l) : null;
    }
    if (!r || r.ok || !(r.open || []).length) return '';
    const hint = await (await importFile(helper)).upgradeMergeHint(r.open, { cwd: root, base: r.baseSha || null, env });
    if (!hint) return '';
    return `[upgrade smoke] hooks check: ${hint.count} upstream commit(s) are unstamped (the release ${hint.from || '?'} -> ${hint.to} came in by a plain git merge); run: ${hint.command} (${hint.who})`;
  } catch { return ''; }
}

/** `--preflight` or `--smoke` (see the header). Returns { ok, items, lines, scratch? }. */
export async function prePost({ root = ROOT, smokeRun = false, ref = null, keep = false, env = process.env } = {}) {
  if (smokeRun) {
    const f = path.join(root, 'harness', 'upgrade-smoke.mjs');
    if (!fs.existsSync(f)) return { ok: false, items: [], lines: ['[upgrade smoke] FAIL: this studio has no harness/upgrade-smoke.mjs (2.73.0+): take the update first (npm run upgrade -- --merge <ref> --by <you>)'] };
    const sm = await importFile(f);
    const pf = await loadHelper('upgrade-preflight.mjs', root);
    const r = await sm.smoke({ root, env, keep });
    const lines = pf?.itemLines ? pf.itemLines('smoke', r.items) : r.items.map((i) => `[upgrade smoke] ${i.status} ${i.id}: ${i.detail}${i.fix && i.status === 'FAIL' ? `\n  Fix: ${i.fix}` : ''}`);
    if (r.scratch) lines.push(`[upgrade smoke] the scratch copy is kept at ${r.scratch} (remove it when done)`);
    { const h = await hooksAfterUpgrade(root, { env }); if (h) lines.push(h); }
    return { ...r, lines };
  }
  const pf = await loadHelper('upgrade-preflight.mjs', root, ref);
  if (!pf?.preflight) return { ok: false, items: [], lines: ['[upgrade preflight] FAIL: harness/upgrade-preflight.mjs was not found (beside this guard, in the studio or on --ref <ref>)'] };
  return pf.preflight({ root, ref, env, deps: { checkUpgrade, isMainCheckout } });
}

/** The last update merge (first-parent commit with an Upgrade-Backup trailer) no Upgrade-Rollback-Of undid: { sha, backup, ref, versions } or null. */
export function lastUpgradeMerge(root = ROOT, { depth = 2000 } = {}) {
  const r = git(['log', '--first-parent', `-n${depth}`, '--format=%H%x1f%P%x1f%B%x1e', 'HEAD'], root);
  if (r.status !== 0) return null;
  const undone = new Set();
  for (const rec of r.stdout.split('\x1e')) {
    const [sha, parents, body] = rec.replace(/^\s+/, '').split('\x1f');
    if (!sha || !body) continue;
    const trailer = (k) => (body.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi')) || [])[1]?.trim() || null;
    const of = trailer('Upgrade-Rollback-Of');
    if (of) { undone.add(of.split(/\s+/)[0]); continue; }
    const backup = trailer('Upgrade-Backup');
    if (!backup || String(parents).trim().split(/\s+/).length < 2) continue;
    if ([...undone].some((u) => sha.startsWith(u))) continue;
    return { sha, backup, ref: trailer('Upgrade-Ref'), versions: trailer('Upgrade-Versions'), first: String(parents).trim().split(/\s+/)[0] };
  }
  return null;
}

/**
 * `--rollback`: git revert -m 1 of the last update's merge (the studio's own work stays), through the hooks with the
 * guard opened for it (STUDIO_UPGRADE_REVERT = the merge, checked against REVERT_HEAD); then refreshes the lanes and
 * records an upgrade.rolled_back event and a decision-log entry. Refuses with uncommitted tracked changes, in a lane
 * copy, mid-merge or mid-revert, and on a conflict (undone, files named). Who may: as --merge.
 * Returns { ok, code, lines, commit?, merge?, backup? }.
 */
export async function upgradeRollback({ by, permission = '', root = ROOT, env = process.env } = {}) {
  const lines = [];
  const stop = (why, extra = {}) => ({ ok: false, code: 1, lines: [...lines, `[upgrade] Not rolled back: ${why}`], ...extra });
  if (!root || !repoRoot(root)) return stop('this isn\'t a git checkout; run it in the studio\'s main checkout');
  if (!isMainCheckout(root)) return stop('this is a lane copy; roll back in the studio\'s main checkout (the board and main live there)');
  const branch = out1(git(['symbolic-ref', '-q', '--short', 'HEAD'], root));
  if (!branch) return stop('HEAD is not on a branch; check out the studio\'s branch (main) first');
  const who = await whoActs({ by, permission, env, root });
  if (!who.ok) return stop(who.why);
  for (const h of ['MERGE_HEAD', 'REVERT_HEAD', 'CHERRY_PICK_HEAD']) {
    if (out1(git(['rev-parse', '-q', '--verify', h], root))) return stop(`a ${h === 'MERGE_HEAD' ? 'merge' : h === 'REVERT_HEAD' ? 'revert' : 'cherry-pick'} is in progress here: finish it or undo it (git ${h === 'MERGE_HEAD' ? 'merge' : h === 'REVERT_HEAD' ? 'revert' : 'cherry-pick'} --abort) first`);
  }
  const check = checkUpgrade(root);
  if (!check.ok) return { ok: false, code: 1, lines: [...check.lines, '[upgrade] Not rolled back: commit the board first (above).'] };
  const dirty = git(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no'], root).stdout.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3));
  if (dirty.length) return stop(`uncommitted changes to tracked files (${short(dirty, 5)}): commit them or put them aside first; a rollback never stashes or discards anything`);
  const m = lastUpgradeMerge(root);
  if (!m) return stop(`no harness update merged into ${branch} to roll back (no merge commit with an Upgrade-Backup trailer that a rollback hasn't undone)`);
  const backupSha = out1(git(['rev-parse', '--verify', '--quiet', `refs/heads/${m.backup}`], root));
  const [toV, fromV] = String(m.versions || '').split(/\s*->\s*/).reverse();
  const after = out1(git(['rev-list', '--first-parent', '--count', `${m.sha}..HEAD`], root));
  lines.push(`[upgrade] rolling back ${m.sha.slice(0, 10)} (harness ${m.versions || '?'}${m.ref ? `, from ${m.ref.split(' ')[0]}` : ''}); the studio returns to ${m.backup}${backupSha ? '' : ' (that branch is gone; its commit is the merge\'s first parent)'}${Number(after) ? `, keeping the ${after} commit(s) that landed since` : ''}.`);
  const rv = git(['revert', '--no-commit', '-m', '1', m.sha], root, { env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
  const conflicts = unmergedFiles(root);
  if (conflicts.length || rv.status !== 0) {
    git(['revert', '--abort'], root);
    if (conflicts.length) {
      await emit(root, { type: 'upgrade.rollback_conflict', agent: String(by).trim().slice(0, 60), msg: `rolling back harness update ${m.sha.slice(0, 10)} conflicts in ${conflicts.length} file(s): ${short(conflicts, 5)}`.slice(0, 600), meta: { merge: m.sha, backup: m.backup, files: conflicts.slice(0, 50), recordedBy: who.recordedBy } });
      return stop(`reverting the update conflicts with work that landed since in ${conflicts.length} file(s): ${short(conflicts)}. The revert was undone; nothing changed. How to resolve that is the owner's call (git revert -m 1 ${m.sha.slice(0, 10)} by hand).`, { conflicts, merge: m.sha, backup: m.backup });
    }
    return stop(`git revert refused: ${(rv.stderr || rv.stdout).trim().split('\n').slice(0, 6).join(' / ')}`, { merge: m.sha, backup: m.backup });
  }
  // Goldens back exactly as before the update carry the rollback's reason.
  const goldens = git(['diff', '--cached', '--name-only', '--no-renames', 'HEAD', '--', 'qa/golden'], root).stdout.split('\n').filter(Boolean);
  const trailers = [`Upgrade-Rollback-Of: ${m.sha}`, `Upgrade-Rollback-By: ${String(by).trim()}`];
  if (who.permission) trailers.push(`Upgrade-Permission: ${who.permission}`);
  trailers.push(`Upgrade-Recorded-By: ${who.recordedBy}`, `Upgrade-Backup: ${m.backup}`);
  if (goldens.length) trailers.push(`Golden-Reason: rollback of the harness update ${m.sha.slice(0, 10)} (upgrade rollback): ${short(goldens, 20)}`);
  const msg = [`upgrade: roll back harness ${toV || '?'} -> ${fromV || '?'} (revert ${m.sha.slice(0, 10)}) on ${branch}`, '', ...trailers, ''].join('\n');
  const msgFile = gitPath(root, 'STUDIO_UPGRADE_MSG');
  fs.writeFileSync(msgFile, msg);
  const c = git(['commit', '-F', msgFile], root, { env: { ...env, STUDIO_UPGRADE_REVERT: m.sha } });
  try { fs.rmSync(msgFile, { force: true }); } catch {}
  if (c.status !== 0) {
    git(['revert', '--abort'], root);
    return stop(`the hooks refused the rollback commit; the revert was undone, nothing changed:\n${`${c.stdout}${c.stderr}`.trim().split('\n').slice(-15).map((l) => `  ${l}`).join('\n')}`, { merge: m.sha, backup: m.backup });
  }
  const commit = out1(git(['rev-parse', 'HEAD'], root));
  const sameAsBackup = backupSha && out1(git(['rev-parse', `${commit}^{tree}`], root)) === out1(git(['rev-parse', `${backupSha}^{tree}`], root));
  await emit(root, {
    type: 'upgrade.rolled_back', agent: String(by).trim().slice(0, 60),
    msg: `harness update ${m.sha.slice(0, 10)} (${m.versions || '?'}) rolled back on ${branch} as ${commit.slice(0, 10)} for ${String(by).trim()}${who.permission ? ` (recorded by ${who.recordedBy} on their permission)` : ''}; backup ${m.backup}`.slice(0, 600),
    meta: { merge: m.sha, commit, branch, backup: m.backup, versions: m.versions || null, by: String(by).trim().slice(0, 60), recordedBy: who.recordedBy, permission: who.permission || null, sameTreeAsBackup: Boolean(sameAsBackup) },
  });
  // The decision log (harness/decisions-log.mjs); an older harness without it gets none.
  let logged = false;
  for (const f of [path.join(root, 'harness', 'decisions-log.mjs'), path.join(path.dirname(SELF), 'decisions-log.mjs')]) {
    if (logged || !fs.existsSync(f)) continue;
    try {
      const dm = await importFile(f);
      if (dm.logDecision) { dm.logDecision({ action: 'upgrade-rollback', subject: m.sha, by: String(by).trim(), as: who.permission ? `permission "${who.permission.slice(0, 200)}"` : who.via === 'person' ? 'person' : 'agent', why: `roll back harness ${m.versions || ''}`.trim(), evidence: `revert ${commit.slice(0, 10)} of ${m.sha.slice(0, 10)}; backup ${m.backup}`, undo: { kind: 'text', text: `git revert ${commit.slice(0, 10)} (takes the update again), or npm run upgrade -- --merge ${m.ref ? m.ref.split(' ')[0] : '<ref>'} --by <name>` }, root }); logged = true; }
    } catch {}
  }
  const lanes = refreshLanesAfterUpgrade({ root, by: String(by).trim(), env });
  return {
    ok: true, code: 0, commit, merge: m.sha, backup: m.backup, lanes, logged,
    lines: [...lines, `[upgrade] PASS rolled back: ${commit.slice(0, 10)} reverts ${m.sha.slice(0, 10)} on ${branch}${sameAsBackup ? `; the tree is ${m.backup}'s again` : ''}. Recorded for ${String(by).trim()}${who.permission ? ` on their permission (recorded by ${who.recordedBy})` : ''}${logged ? ' (decision log too)' : ''}. No branch was deleted.`,
      ...lanes.lines,
      '[upgrade] Next: npm run verify -- --all. To take the update again: npm run upgrade -- --merge <ref> --by <you> (or git revert the rollback commit).'],
  };
}

/**
 * After a merged update, `lanes refresh --all` (harness/lanes.mjs) from the updated harness. A lane with a running
 * session, uncommitted work or a merge in progress is skipped; a conflict is aborted and named. Honours
 * STUDIO_UPGRADE_REFRESH. Returns { ran, refreshed, conflicted, red, skipped, results, lines }; never throws.
 */
export function refreshLanesAfterUpgrade({ root = ROOT, by, env = process.env } = {}) {
  const mode = String(env.STUDIO_UPGRADE_REFRESH || '').trim().toLowerCase();
  const empty = (why) => ({ ran: false, why, refreshed: [], conflicted: [], red: [], skipped: [], results: [], lines: [`[upgrade] lanes: not refreshed (${why})`] });
  if (/^(off|0|false|no)$/.test(mode)) return empty('STUDIO_UPGRADE_REFRESH=off; run npm run lanes -- refresh --all --by <you> when ready');
  const script = path.join(root, 'harness', 'lanes.mjs');
  if (!fs.existsSync(script)) return empty('this studio has no harness/lanes.mjs');
  const args = [script, 'refresh', '--all', '--by', String(by || ''), '--json', ...(mode === 'no-tests' ? ['--no-tests'] : [])];
  // Detached (it outlives a caller's shell time limit); waits at most STUDIO_UPGRADE_REFRESH_WAIT_S (120) seconds. The
  // train refreshes a lagging lane first (harness/train-refresh.mjs).
  const r = runRefreshBackground(root, args, env);
  let j = null;
  try { j = JSON.parse(String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { j = null; }
  if (!j && r.running) {
    return { ran: 'background', why: 'still running', pid: r.pid, log: r.log, refreshed: [], conflicted: [], red: [], skipped: [], results: [], lines: [`[upgrade] lanes: refresh still running in the background (pid ${r.pid}, log ${r.log}; waited ${r.waitedS} s, STUDIO_UPGRADE_REFRESH_WAIT_S). It goes on by itself; a lane it hasn't reached yet is refreshed by the next train before its checks. npm run lanes shows each lane.`] };
  }
  if (!j) {
    const tail = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-3).join(' / ');
    return empty(`lanes refresh gave no result (exit ${r.status}${tail ? `: ${tail.slice(0, 300)}` : ''}); run npm run lanes -- refresh --all --by <you>`);
  }
  if (j.refused) return empty(`lanes refresh refused: ${j.why}`);
  const results = Array.isArray(j.results) ? j.results : [];
  const pick = (s) => results.filter((x) => x.status === s);
  const out = { ran: true, refreshed: pick('ok'), conflicted: pick('conflict'), red: pick('red'), skipped: pick('refused').concat(pick('skipped')), results };
  const word = { ok: 'refreshed', conflict: 'conflicted', red: 'red', refused: 'skipped', skipped: 'skipped' };
  out.lines = [
    results.length
      ? `[upgrade] lanes: ${out.refreshed.length} refreshed, ${out.conflicted.length} conflicted, ${out.red.length} red, ${out.skipped.length} skipped (npm run lanes -- refresh --all${mode === 'no-tests' ? ' --no-tests' : ''})`
      : '[upgrade] lanes: no lane copy to refresh',
    ...results.map((x) => `  ${word[x.status] || x.status} ${x.lane}: ${String(x.why || '').slice(0, 300)}`),
  ];
  return out;
}

/** Run `lanes refresh` detached (log .studio/upgrades/lanes-refresh-<time>.log), waiting at most STUDIO_UPGRADE_REFRESH_WAIT_S. { stdout, status, running, pid, log, waitedS }. */
export function runRefreshBackground(root, args, env = process.env) {
  const dir = path.join(root, '.studio', 'upgrades');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(dir, `lanes-refresh-${stamp}.log`);
  const exitFile = `${logFile}.exit`;
  const rel = path.relative(root, logFile).split(path.sep).join('/');
  // A wrapper records the exit code next to the log.
  const wrapper = `const { spawnSync } = require('node:child_process'); const fs = require('node:fs');
const r = spawnSync(process.execPath, ${JSON.stringify(args)}, { cwd: ${JSON.stringify(root)}, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
fs.writeFileSync(${JSON.stringify(exitFile)}, String(r.status === null ? 'signal ' + (r.signal || '') : r.status));`;
  const fd = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(process.execPath, ['-e', wrapper], { cwd: root, env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
  } finally { fs.closeSync(fd); }
  const waitS = Number(env.STUDIO_UPGRADE_REFRESH_WAIT_S ?? 120);
  const limit = Number.isFinite(waitS) && waitS >= 0 ? waitS * 1000 : 120000;
  const t0 = Date.now();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(exitFile) && Date.now() - t0 < limit) Atomics.wait(nap, 0, 0, 200);
  const done = fs.existsSync(exitFile);
  let stdout = '';
  try { stdout = fs.readFileSync(logFile, 'utf8'); } catch {}
  let status = null;
  try { const t = fs.readFileSync(exitFile, 'utf8').trim(); status = /^\d+$/.test(t) ? Number(t) : t; } catch {}
  return { stdout, status, running: !done, pid: child?.pid ?? null, log: rel, waitedS: Math.round((Date.now() - t0) / 1000) };
}

/** Is every line of a conflict side a task row (a list item or a table row) or blank? */
const rowLine = (l) => { const t = l.replace(/\r$/, ''); return !t.trim() || /^\s*([-*+]|\d+[.)])\s/.test(t) || /^\s*\|/.test(t); };

/** Resolve git merge-file's conflict blocks by keeping both sides' rows. Returns { text } or { refused: '<first line of a block that isn't only rows>' }. */
export function unionRows(merged) {
  const src = merged.split('\n');
  const outL = [];
  for (let i = 0; i < src.length; i++) {
    if (!src[i].startsWith('<<<<<<< ')) { outL.push(src[i]); continue; }
    const ours = [];
    const theirs = [];
    let side = ours;
    let j = i + 1;
    for (; j < src.length && !src[j].startsWith('>>>>>>> '); j++) {
      if (src[j].replace(/\r$/, '') === '=======') { side = theirs; continue; }
      side.push(src[j]);
    }
    if (j >= src.length) return { refused: 'an unfinished conflict block' };
    const bad = [...ours, ...theirs].find((l) => !rowLine(l));
    if (bad !== undefined) return { refused: bad.replace(/\r$/, '').slice(0, 120) };
    const seen = new Set(ours.map((l) => l.replace(/\r$/, '').trim()).filter(Boolean));
    outL.push(...ours, ...theirs.filter((l) => !seen.has(l.replace(/\r$/, '').trim()) || !l.trim()));
    i = j;
  }
  return { text: outL.join('\n') };
}

/** `npm run upgrade -- --restore-stash <sha> --by <person>`. Returns { ok, code, lines, commit?, restored? }. */
export async function restoreStash({ stash, by, permission = '', root = ROOT, env = process.env } = {}) {
  const stop = (why, extra = {}) => ({ ok: false, code: 1, lines: [`[upgrade] Not restored: ${why}`], ...extra });
  if (!root || !repoRoot(root)) return stop('this isn\'t a git checkout');
  if (!stash) return stop('which stash? npm run upgrade -- --restore-stash <sha> --by <your name> (npm run upgrade -- --check lists the ones with board rows)');
  const who = await whoActs({ by, permission, env, root, needPermission: false });
  if (!who.ok) return stop(who.why);
  const dirty = dirtyBoard(root);
  if (dirty === null) return stop('this isn\'t a git checkout');
  if (dirty.length) return { ok: false, code: 1, lines: [...checkUpgrade(root).lines, '[upgrade] Not restored: commit the board as it is now first (above); the restore merges into the committed board.'] };
  const sha = out1(git(['rev-parse', '--verify', '--quiet', `${stash}^{commit}`], root));
  const entries = git(['stash', 'list', '--format=%gd%x1f%H%x1f%gs'], root).stdout.split('\n').filter(Boolean).map((l) => l.split('\x1f'));
  const entry = entries.find((e) => e[1] === sha);
  if (!sha || !entry) return stop(`"${stash}" is not an entry of git stash list`);
  const { files, untracked } = stashBoardFiles(sha, root);
  if (!files.length) return stop(`${entry[0]} holds no board changes; nothing to restore`);
  const show = (rev, f) => { const r = git(['show', `${rev}:${f}`], root); return r.status === 0 ? r.stdout : null; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-restore-'));
  const results = [];
  const refused = [];
  try {
    for (const f of files) {
      const theirs = show(untracked.has(f) ? `${sha}^3` : sha, f);
      const base = untracked.has(f) ? null : show(`${sha}^1`, f);
      const abs = path.join(root, f);
      const ours = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      if (theirs === null) { refused.push(`${f}: the stash deletes it`); continue; }
      if (ours === theirs) continue;
      if (ours === null && base !== null) { refused.push(`${f}: the board no longer has it, the stash changes it`); continue; }
      if (ours === null) { results.push({ f, text: theirs }); continue; }
      const p = (n, t) => { const x = path.join(tmp, n); fs.writeFileSync(x, t); return x; };
      const r = spawnSync('git', ['merge-file', '-p', '-L', 'board', '-L', 'stash base', '-L', 'stash', p('ours', ours), p('base', base ?? ''), p('theirs', theirs)], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0) { results.push({ f, text: r.stdout }); continue; }
      if (r.status === null || r.status < 0 || r.status > 127) { refused.push(`${f}: git merge-file failed (${(r.stderr || '').trim().slice(0, 120)})`); continue; }
      if (!ROW_FILES.includes(f)) { refused.push(`${f}: both sides changed the same lines (only rows of ${ROW_FILES.join(' and ')} are merged by keeping both)`); continue; }
      const u = unionRows(r.stdout);
      if (u.refused !== undefined) { refused.push(`${f}: both sides changed a line that isn't a task row: "${u.refused}"`); continue; }
      results.push({ f, text: u.text, union: true });
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  if (refused.length) {
    return stop(`nothing was written; restore these by hand (git stash show -p ${sha.slice(0, 10)} -- <file>), keeping both sides:\n${refused.map((x) => `  ${x}`).join('\n')}`, { refused });
  }
  const others = git(['diff', '--name-only', `${sha}^1`, sha], root).stdout.split('\n').filter((f) => f && !files.includes(f));
  const dropLine = (ref) => `[upgrade] The stash is kept. When the board has every row you need: git stash drop ${ref}   (check git stash list first: the numbers shift as entries come and go)`;
  if (!results.length) return { ok: true, code: 0, lines: [`[upgrade] the board already has every row of ${entry[0]} (${sha.slice(0, 10)}); nothing to restore.`, ...(others.length ? [] : [dropLine(entry[0])])] };
  for (const r of results) { fs.mkdirSync(path.dirname(path.join(root, r.f)), { recursive: true }); fs.writeFileSync(path.join(root, r.f), r.text); }
  const add = git(['add', '--', ...results.map((r) => r.f)], root);
  if (add.status !== 0) return stop(`git add failed: ${add.stderr.trim()}`);
  const msg = [`board: restore rows from stash ${sha.slice(0, 10)} ("${entry[2]}")`, '', `Upgrade-By: ${String(by).trim()}`, ...(who.permission ? [`Upgrade-Permission: ${who.permission}`] : []), `Upgrade-Recorded-By: ${who.recordedBy}`, `Upgrade-Restored-Stash: ${sha}`, ''].join('\n');
  const c = git(['commit', '-m', msg], root, { env });
  if (c.status !== 0) return stop(`the merged board is written and staged, but the commit was refused:\n${`${c.stdout}${c.stderr}`.trim().split('\n').slice(-10).map((l) => `  ${l}`).join('\n')}`);
  const commit = out1(git(['rev-parse', 'HEAD'], root));
  const now = git(['stash', 'list', '--format=%gd%x1f%H'], root).stdout.split('\n').map((l) => l.split('\x1f')).find((e) => e[1] === sha);
  await emit(root, { type: 'upgrade.stash_restored', agent: String(by).trim().slice(0, 60), msg: `board rows from stash ${sha.slice(0, 10)} restored by merge (${results.map((r) => r.f).join(', ')}) for ${String(by).trim()}; the stash is kept`.slice(0, 600), meta: { stash: sha, commit, files: results.map((r) => r.f), recordedBy: who.recordedBy } });
  return {
    ok: true, code: 0, commit, restored: results.map((r) => r.f),
    lines: [`[upgrade] PASS restored the board rows of ${entry[0]} (${sha.slice(0, 10)}) by merge, both sides' rows kept: ${results.map((r) => `${r.f}${r.union ? ' (conflicting rows: both kept)' : ''}`).join(', ')}. Committed ${commit.slice(0, 10)}.`,
      ...(others.length ? [`[upgrade] note: the stash also holds ${others.length} file(s) outside the board (${short(others, 5)}); they were not restored, so keep the stash until they are.`] : []),
      dropLine(now ? now[0] : entry[0])],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  const a = process.argv.slice(2);
  const flag = (n) => { const i = a.indexOf(n); return i >= 0 && a[i + 1] !== undefined && !a[i + 1].startsWith('--') ? a[i + 1] : null; };
  const show = (r) => { for (const l of r.lines) (r.ok ? console.log : console.error)(l); process.exit(r.code ?? (r.ok ? 0 : 1)); };
  if (a.includes('--help') || a.includes('-h')) {
    console.log([
      'Usage: npm run upgrade -- --check | --snapshot   (before taking a harness update: the board must be committed, never stashed)',
      '       npm run upgrade -- --merge <ref> --by <person> [--permission "<their words or a link>"] [--golden-reason "<why>"] [--continue]',
      '       npm run upgrade -- --restore-stash <sha> --by <person>',
      '       npm run upgrade -- --rollback --by <person> [--permission "<their words or a link>"]   (2.71.1: reverts the last update\'s merge; never resets or deletes)',
      '       npm run upgrade -- --preflight [--ref <ref>] [--json]   (2.73.0: before an update, read-only: PASS/WARN/FAIL per item, exit 1 on a FAIL)',
      '       npm run upgrade -- --smoke [--keep] [--json]            (2.73.0: right after one: a tiny verify and train in a scratch copy, the machine scan, a dry supervisor pass)',
      '       npm run upgrade -- watch [--json] | watch status | watch auto on --by <person> [--permission "…"] [--ref <remote>/<branch>] | watch auto off',
      '         (2.69.0, harness/upgrade-watch.mjs: a newer harness on the harness remote, its CI, and STUDIO_UPGRADE_WINDOW)',
      'docs/RELEASE.md "Taking a harness update into a studio" has the steps, and the one-liner for a studio too old to have these.',
    ].join('\n'));
    process.exit(0);
  }
  if (a.includes('--preflight') || a.includes('--smoke')) {
    const root = repoRoot();
    if (!root) { console.error('[upgrade] not a git checkout: run it in the studio\'s main checkout'); process.exit(1); }
    const r = await prePost({ root, smokeRun: a.includes('--smoke'), ref: flag('--ref'), keep: a.includes('--keep') });
    if (a.includes('--json')) console.log(JSON.stringify({ ok: r.ok, items: r.items, ...(r.scratch ? { scratch: r.scratch } : {}) }, null, 2));
    else for (const l of r.lines) (r.ok ? console.log : console.error)(l);
    process.exit(r.ok ? 0 : 1);
  }
  if (a[0] === 'watch') {
    const uw = await import(pathToFileURL(path.join(path.dirname(SELF), 'upgrade-watch.mjs')).href);
    const root = repoRoot();
    if (!root) { console.error('[upgrade watch] not a git checkout'); process.exit(1); }
    const self = { repoRoot, isMainCheckout, whoActs, upgradeMerge };
    if (a[1] === 'auto') {
      if (!['on', 'off'].includes(a[2])) { console.error('Usage: npm run upgrade -- watch auto on --by <person> [--permission "<their words or a link>"] [--ref <remote>/<branch>] | watch auto off [--by <name>]'); process.exit(1); }
      const r = await uw.setAuto({ on: a[2] === 'on', by: flag('--by') || '', permission: flag('--permission') || '', ref: flag('--ref') || '', root, commit: !a.includes('--no-commit'), guard: self });
      (r.ok ? console.log : console.error)(r.message);
      process.exit(r.ok ? 0 : 1);
    }
    if (a[1] === 'status') {
      const auto = await uw.readAuto(root);
      const st = uw.readWatchState(root);
      console.log(`[upgrade watch] auto-upgrade ${auto.on ? `on for ${auto.by}${auto.setBy !== auto.by ? ` (set by ${auto.setBy})` : ''}` : `off (${auto.why})`}; window ${process.env.STUDIO_UPGRADE_WINDOW || 'unset (report only)'}`);
      console.log(st.lastPoll ? `[upgrade watch] last check ${st.lastPoll}: ${st.line}` : '[upgrade watch] no check yet');
      process.exit(0);
    }
    const r = await uw.upgradeWatch({ root, guard: self });
    if (a.includes('--json')) console.log(JSON.stringify({ status: r.status, ref: r.ref || null, sha: r.sha || null, ours: r.ours || null, theirs: r.theirs || null, ci: r.ci || null, filed: r.filed || [], lines: r.lines }));
    else for (const l of r.lines) console.log(l);
    process.exit(r.status === 'failed' ? 1 : 0);
  }
  if (a.includes('--merge')) {
    show(await upgradeMerge({ ref: flag('--merge'), by: flag('--by'), permission: flag('--permission') || '', goldenReason: flag('--golden-reason') || '', cont: a.includes('--continue') }));
  }
  if (a.includes('--rollback')) {
    show(await upgradeRollback({ by: flag('--by'), permission: flag('--permission') || '' }));
  }
  if (a.includes('--restore-stash')) {
    show(await restoreStash({ stash: flag('--restore-stash'), by: flag('--by'), permission: flag('--permission') || '' }));
  }
  if (a.includes('--snapshot')) {
    try { console.log(`[upgrade] board copied to ${snapshotBoard()}`); } catch (e) { console.error(`[upgrade] could not copy the board: ${e.message}`); process.exit(1); }
  }
  const r = checkUpgrade(repoRoot());
  for (const l of r.lines) (r.ok ? console.log : console.error)(l);
  process.exit(r.ok ? 0 : 1);
}
