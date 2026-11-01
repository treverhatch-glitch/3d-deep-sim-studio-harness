#!/usr/bin/env node
/**
 * harness/upgrade-guard.mjs — 2.58.5 (H-4): the board is committed before a harness upgrade, never stashed.
 *
 * On a crew's PC the 2.58.2 upgrade stashed the dirty main checkout ("pre-2.58.2-upgrade") and the board went with it:
 * DONE.md rows for four finished tasks and five NEXT.md tasks added that morning, never committed. A finished task
 * reopened and seven crew sessions were spent on it. The board files are plain studio state that other agents write
 * all day; a stash hides them, a merge keeps both sides.
 *
 *   npm run upgrade -- --check      exit 1 while a board file is uncommitted (names them and the command to commit
 *                                   them); also names stash entries that hold board changes (restore by merge, below)
 *   npm run upgrade -- --snapshot   copy the board files to .studio/board-snapshots/<time>/ (gitignored), then check
 *
 * 2.60.0 (#3), the upgrade path for an orchestrator:
 *   npm run upgrade -- --merge <ref> --by <person> [--permission "<their words or a link>"] [--golden-reason "<why>"]
 *       takes the update: refuses unless --check passes, backs the branch up as backup/pre-<version>, merges <ref> in the
 *       main checkout through the hooks, with the main-checkout guard opened for exactly this merge (STUDIO_UPGRADE_MERGE
 *       = the merged commit, in the merge's own environment; scripts/hooks/pre-commit lets only a commit whose
 *       MERGE_HEAD is that commit through). The merge commit records Upgrade-By / Upgrade-Permission /
 *       Upgrade-Recorded-By / Upgrade-Ref / Upgrade-Versions / Upgrade-Backup, and an upgrade.merged event. A person in
 *       their own terminal needs no --permission; an agent needs it (harness/permission.mjs: a Producer or Director
 *       session, or an agent outside the harness); a worker is refused. A conflict stops with the files listed and
 *       `git merge --abort` advice: nothing is resolved for anyone. `--continue` commits a merge a person resolved.
 *       Goldens: the merge adds `Golden-Reason: from <ref> (upgrade)` naming the qa/golden files that come exactly as
 *       they are on <ref>; a golden the merge combined with the studio's own change needs --golden-reason (a person's).
 *   npm run upgrade -- --restore-stash <sha> --by <person>
 *       with the board committed, three-way merges a stash's board files into the board, keeping both sides' rows
 *       (studio/NEXT.md and studio/DONE.md: conflicting list or table rows are all kept); any other conflict refuses
 *       and lists, writing nothing. Commits, then prints the `git stash drop` to run. It never drops anything.
 *
 * Bootstrap (2.60.0): an old studio has no --merge, so docs/RELEASE.md runs the new guard straight from the ref
 * (`git show <ref>:harness/upgrade-guard.mjs` into .studio/). So this file finds the studio by git from the current
 * folder, never by its own location, and loads harness/permission.mjs from beside it, the studio, or the ref.
 *
 * Board files: studio/NEXT.md, studio/DONE.md, studio/task-holds.json, studio/pending-review.json, studio/handoffs/.
 * --check and --snapshot never stash, commit or change a tracked file. docs/RELEASE.md "Taking a harness update" has
 * the steps.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
export const BOARD_FILES = ['studio/NEXT.md', 'studio/DONE.md', 'studio/task-holds.json', 'studio/pending-review.json', 'studio/handoffs'];
// Board files whose conflicting rows are all kept (one task per line: list items and table rows).
export const ROW_FILES = ['studio/NEXT.md', 'studio/DONE.md'];
const git = (args, cwd, opts = {}) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const out1 = (r) => (r.status === 0 ? r.stdout.trim() : '');

/** The checkout to work on: git's top level for the folder it runs in (never this file's folder: a copy runs anywhere). */
export function repoRoot(cwd = process.cwd()) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}
const ROOT = repoRoot() || process.cwd();

/** Board files with uncommitted changes (modified, staged, new or deleted): [{ file, state }], or null when not a git checkout. */
export function dirtyBoard(root = ROOT) {
  if (!root) return null;
  const r = git(['status', '--porcelain', '--untracked-files=all', '--', ...BOARD_FILES], root);
  if (r.status !== 0) return null;
  return r.stdout.split('\n').filter((l) => l.length > 3).map((l) => ({ state: l.slice(0, 2), file: l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '') }));
}

/** Board files a stash changed: tracked changes against the commit it was made on, plus its untracked files (third parent). */
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

/** Copy the board files as they are now to .studio/board-snapshots/<time>/; returns that folder (repo-relative). */
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

// ---- 2.60.0 (#3): who may take an update, the merge, a stash's board rows ----

const AGENT_SHELL = ['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
// The same names harness/agent-env.mjs AGENTISH lists, for a studio too old to have it.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|liaison|scout|designer|balancer|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|nim|dev-hacker|sound|composer|writer)\b/i;

const importFile = (f) => import(pathToFileURL(f).href);
/** harness/permission.mjs: beside this file, in the studio, or (a studio older than 2.59.1) from the ref being merged. */
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
async function agentLike(root, who) {
  const f = path.join(root, 'harness', 'agent-env.mjs');
  if (fs.existsSync(f)) { try { const m = await importFile(f); if (m.agentLikeName) return m.agentLikeName(who, { stateDir: path.join(root, '.studio') }); } catch {} }
  return !who || AGENTISH.test(who);
}

/**
 * May this caller take an update (or restore board rows) for <by>? { ok, why, via, recordedBy, permission }.
 * Workers never. An agent (a launched session, a coding agent's shell, an agent's name in STUDIO_LOCK_OWNER) needs a
 * person's direct permission when needPermission (harness/permission.mjs); a person in their own terminal doesn't.
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
const isMainCheckout = (root) => {
  const d = out1(git(['rev-parse', '--absolute-git-dir'], root));
  const c = out1(git(['rev-parse', '--git-common-dir'], root));
  return Boolean(d) && path.resolve(root, d) === path.resolve(root, c);
};
const unmergedFiles = (root) => git(['diff', '--name-only', '--diff-filter=U'], root).stdout.split('\n').filter(Boolean);

/**
 * The qa/golden files a merge in progress changes, split by whether each comes exactly as it is on the merged commit
 * (fromRef) or not (combined with the studio's own change). Compares the index with HEAD and with <sha>.
 */
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

/**
 * `npm run upgrade -- --merge <ref> --by <person> [--permission "…"] [--golden-reason "…"] [--continue]`.
 * Returns { ok, code, lines, commit?, backup?, conflicts? }.
 */
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

  // A backup of the branch as it was (reused when it already points there).
  let backup = `backup/pre-${to}`;
  const head = out1(git(['rev-parse', 'HEAD'], root));
  const existing = out1(git(['rev-parse', '--verify', '--quiet', `refs/heads/${backup}`], root));
  if (existing && existing !== head) backup = `${backup}-${now.toISOString().replace(/[:.]/g, '-')}`;
  if (existing !== head) {
    const b = git(['branch', backup, head], root);
    if (b.status !== 0) return stop(`could not make the backup branch ${backup}: ${b.stderr.trim()}`);
  }
  lines.push(`[upgrade] ${branch} backed up as ${backup} (${head.slice(0, 10)}).`);

  if (!cont) {
    const m = git(['merge', '--no-ff', '--no-commit', sha], root, { env: { ...env, GIT_MERGE_AUTOEDIT: 'no' } });
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

  // Goldens: the ones that come exactly as the ref has them carry the upgrade's reason; a combined one needs a person's.
  const g = mergeGoldens(root, sha);
  const reason = String(goldenReason || '').trim();
  if (g.combined.length && reason.length < 10) {
    if (!cont) git(['merge', '--abort'], root);
    return stop(`${g.combined.length} golden file(s) differ from ${ref}'s (the merge combined the studio's change with the update's): ${short(g.combined)}. ${cont ? 'The merge is still in progress. ' : 'The merge was undone. '}Say why the recorded answers changed: --golden-reason "<why, 10+ characters>" (it is added as a Golden-Reason trailer).`, { backup, combinedGoldens: g.combined });
  }

  const trailers = [`Upgrade-By: ${String(by).trim()}`];
  if (who.permission) trailers.push(`Upgrade-Permission: ${who.permission}`);
  trailers.push(`Upgrade-Recorded-By: ${who.recordedBy}`, `Upgrade-Ref: ${ref} ${sha}`, `Upgrade-Versions: ${from} -> ${to}`, `Upgrade-Backup: ${backup}`);
  if (g.fromRef.length) trailers.push(`Golden-Reason: from ${ref} (upgrade): ${short(g.fromRef, 20)}`);
  if (g.combined.length) trailers.push(`Golden-Reason: ${reason.replace(/\s+/g, ' ').slice(0, 300)} (${String(by).trim()}, for ${short(g.combined, 20)})`);
  const msg = [`upgrade: merge harness ${to} from ${ref} into ${branch} (${from} -> ${to})`, '', ...trailers, ''].join('\n');
  const msgFile = gitPath(root, 'STUDIO_UPGRADE_MSG');
  fs.writeFileSync(msgFile, msg);
  // The main-checkout guard lets exactly this merge through: STUDIO_UPGRADE_MERGE is this commit, in this commit's own
  // environment, and pre-commit checks MERGE_HEAD is it. Every other hook runs as for any commit.
  const c = git(['commit', '-F', msgFile], root, { env: { ...env, STUDIO_UPGRADE_MERGE: sha } });
  try { fs.rmSync(msgFile, { force: true }); } catch {}
  if (c.status !== 0) {
    return stop(`the hooks refused the merge commit (the merge is still in progress; fix what they say and run --continue, or undo it with git merge --abort):\n${`${c.stdout}${c.stderr}`.trim().split('\n').slice(-15).map((l) => `  ${l}`).join('\n')}`, { backup });
  }
  const commit = out1(git(['rev-parse', 'HEAD'], root));
  await emit(root, {
    type: 'upgrade.merged', agent: String(by).trim().slice(0, 60),
    msg: `harness update ${ref} (${from} -> ${to}) merged into ${branch} as ${commit.slice(0, 10)} for ${String(by).trim()}${who.permission ? ` (recorded by ${who.recordedBy} on their permission: "${who.permission.slice(0, 120)}")` : ''}; backup ${backup}`.slice(0, 600),
    meta: { ref, sha, from, to, branch, backup, commit, by: String(by).trim().slice(0, 60), recordedBy: who.recordedBy, permission: who.permission || null, goldens: g.fromRef.length + g.combined.length },
  });
  return {
    ok: true, code: 0, commit, backup,
    lines: [...lines, `[upgrade] PASS merged ${ref} (${sha.slice(0, 10)}, harness ${from} -> ${to}) into ${branch}: ${commit.slice(0, 10)}, recorded for ${String(by).trim()}${who.permission ? ` on their permission (recorded by ${who.recordedBy})` : ''}.`,
      ...(g.fromRef.length ? [`[upgrade] ${g.fromRef.length} golden file(s) came unchanged from ${ref}: Golden-Reason added for them only.`] : []),
      '[upgrade] Next: npm run verify -- --all, then npm run task -- drain off --by <you>. Undo: git reset --hard ' + backup + ' (only before anything else lands).'],
  };
}

/** Is every line of a conflict side a task row (a list item or a table row) or blank? */
const rowLine = (l) => { const t = l.replace(/\r$/, ''); return !t.trim() || /^\s*([-*+]|\d+[.)])\s/.test(t) || /^\s*\|/.test(t); };

/**
 * Resolve git merge-file's conflict blocks by keeping both sides' rows (ours first, then theirs not already there).
 * Returns { text } or { refused: '<first line of a block that isn't only rows>' }.
 */
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
      const r = spawnSync('git', ['merge-file', '-p', '-L', 'board', '-L', 'stash base', '-L', 'stash', p('ours', ours), p('base', base ?? ''), p('theirs', theirs)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
      'docs/RELEASE.md "Taking a harness update into a studio" has the steps, and the one-liner for a studio too old to have these.',
    ].join('\n'));
    process.exit(0);
  }
  if (a.includes('--merge')) {
    show(await upgradeMerge({ ref: flag('--merge'), by: flag('--by'), permission: flag('--permission') || '', goldenReason: flag('--golden-reason') || '', cont: a.includes('--continue') }));
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
