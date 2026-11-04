/**
 * harness/lane-approvals.mjs — 2.77.0 (B-96): a new lane copy gets the commit the task's owner approval was signed for.
 *
 * T-181 was handed back three times with "an approval exists, but for different contents": each new lane copy merged the
 * task's previous builder lane (harness/worktree.mjs carryTaskBranch, .studio/lane-branches.json), while the owner's
 * re-signed approval matched the protected files as another lane branch held them (the owner's delegate re-signed from
 * a checkout of that branch). Merging that branch by hand fixed it.
 *
 * Now, when a lane copy is made for a task, approvedBranchFor() looks at the studio's protected-file approvals
 * (studio/approvals/*.json, kind "protected": each file's path and content hash) and the local lane branches carrying
 * this task's commits (Studio-Task trailer, not yet on main). A branch whose blobs match EVERY file of one approval, and
 * that changes at least one of them against main, holds the approved contents; the newest such branch not already in
 * the copy is merged in (carryTaskBranch does it, after the previous lane). A hash is matched against the blob and the
 * blob with CRLF line endings (an approval signed on a Windows working tree, B-93). The newest STUDIO_LANE_APPROVAL_SCAN
 * (200) local branches are looked at. Signatures are not checked here (the
 * protected gate does that); this only picks which commits the copy starts from. Never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const git = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const gitBuf = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, maxBuffer: 256 * 1024 * 1024 });
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The protected approvals in the main checkout: [{ file, files: [{ path, sha256 }] }]. */
function approvals(root) {
  const dir = path.join(root, 'studio', 'approvals');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      const files = j?.approval?.kind === 'protected' && Array.isArray(j.approval.files) ? j.approval.files.filter((f) => f?.path && f?.sha256) : [];
      if (files.length) out.push({ file: `studio/approvals/${n}`, at: j.approval.at || null, files });
    } catch {}
  }
  return out;
}

/** The hashes a branch's version of a file can match: the blob, and the blob with CRLF endings; 'deleted' when absent. */
function hashesAt(root, rev, file) {
  const r = gitBuf(root, 'show', `${rev}:${file}`);
  if (r.status !== 0) return new Set(['deleted']);
  const b = r.stdout;
  const crlf = Buffer.from(b.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
  return new Set([sha(b), sha(crlf)]);
}

/**
 * The newest local branch carrying `task`'s commits whose protected files match one of the studio's approvals, and
 * that isn't in `dir`'s HEAD yet: { branch, approval, head } or null.
 */
export function approvedBranchFor(root, task, { dir = null, main = null } = {}) {
  try {
    const list = approvals(root);
    if (!list.length || !task) return null;
    const mainRef = main || String(git(root, 'symbolic-ref', '--short', 'HEAD').stdout || '').trim();
    if (!mainRef) return null;
    const refs = String(git(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)', 'refs/heads/').stdout || '').split('\n').filter(Boolean).map((l) => l.split('\t'));
    for (const [branch, head] of refs.slice(0, Number(process.env.STUDIO_LANE_APPROVAL_SCAN || 200) || 200)) {
      if (branch === mainRef || branch.startsWith('train/')) continue;
      const tags = String(git(root, 'log', '--no-merges', '--format=%(trailers:key=Studio-Task,valueonly,separator=%x2C)', `${mainRef}..${branch}`).stdout || '');
      if (!tags.split(/[,\s]+/).includes(task)) continue;
      if (dir && git(dir, 'merge-base', '--is-ancestor', head, 'HEAD').status === 0) continue; // already in the copy
      const changed = new Set(String(git(root, 'diff', '--name-only', '--no-renames', `${mainRef}...${branch}`).stdout || '').split('\n').filter(Boolean));
      const a = list.find((ap) => ap.files.some((f) => changed.has(f.path)) && ap.files.every((f) => hashesAt(root, head, f.path).has(f.sha256)));
      if (a) return { branch, head, approval: a.file };
    }
  } catch {}
  return null;
}
