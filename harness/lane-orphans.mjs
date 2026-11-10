/**
 * harness/lane-orphans.mjs — 2.78.1 (e): finished work left on lane branches, and carrying a task's own commits.
 *
 * A task's implementation sat on an unmerged lane branch for days (its lane also carried other tasks' commits, so no
 * new copy merged it in); builders kept finding it but could not cherry-pick it.
 *
 *   npm run lanes -- orphans [<ID>] [--all] [--json]
 *       Task commits on lane branches (refs/heads/lane/*) that main doesn't have (by patch: a commit already landed by
 *       cherry-pick or rebase is not listed), grouped by the task id their message names (ids on the board). One row
 *       per commit: task, lane branch, sha, subject, age; "next copy" says whether the task's next lane copy merges
 *       that branch in (.studio/lane-branches.json). A branch checked out in a live lane copy is left out (--all shows it).
 *
 *   npm run lanes -- carry <ID> [--from <lane branch>] [--by <name>] [--json]
 *       Carries only the commits whose message names <ID> (cherry-picked oldest first; every other commit on the branch
 *       is left out and listed). Without --from: the one lane branch that holds the task's orphaned commits (several:
 *       refused, pass --from). A conflict stops it: the cherry-pick is aborted, the copy is put back as it was, and the
 *       commit and its files are named. Nothing is resolved, nothing lands: the task's own checks and the train still judge
 *       the work.
 *       A builder (a launched worker session) carries into its own lane copy, and only for the task it holds.
 *       The Producer or Director, a person, or an agent outside the harness carries from the main checkout: a fresh lane
 *       copy off main (.lanes/carry-<id>, branch lane/carry-<id>-<time>), remembered as the task's branch, so the next
 *       session's copy on the task merges exactly those commits in; the copy folder is removed, the branch kept.
 *
 * Exit: 0 carried (or nothing to carry); 1 a conflict; 2 refused or bad usage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { mainRoot, mainBranch, boardIds, createLaneCopy, removeLaneCopy, rememberTaskBranch, laneLive, inLaneCopy, LANES_DIR } from './worktree.mjs';
import { listLocks } from './lock.mjs';
import { DECIDER_ROLES, WORKER_NAME } from './permission.mjs';
import { readJson } from './fsafe.mjs';

const cleanEnv = (extra = {}) => { const e = { ...process.env, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) delete e[k]; return e; };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does a commit message name this task id (as a word: T-10 is not T-105)? */
export const namesTask = (msg, id) => new RegExp(`(^|[^A-Za-z0-9-])${esc(id)}(?![0-9])`).test(String(msg || ''));
const TASK_ID = /(?:^|[^A-Za-z0-9-])([A-Z]{1,5}-\d+)(?![0-9])/g;

/** A branch's commits main (or `onto`) lacks, by patch (git log --cherry-pick), oldest first: [{ sha, at, subject, body }]. */
export function branchOnly(root, branch, onto) {
  const r = git(root, 'log', '--cherry-pick', '--right-only', '--no-merges', '--format=%H%x1f%ct%x1f%s%x1f%b%x1e', `${onto}...${branch}`);
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\x1e').map((x) => x.replace(/^\n/, '')).filter((x) => x.includes('\x1f')).map((x) => {
    const [sha, ct, subject, body = ''] = x.split('\x1f');
    return { sha, at: Number(ct) * 1000 || 0, subject, body: body.trim() };
  }).reverse();
}

/** The lane branches checked out in a live lane copy (someone is working there). */
function liveBranches(root) {
  const live = new Set();
  const r = git(root, 'worktree', 'list', '--porcelain');
  let dir = null;
  for (const l of String(r.stdout || '').split(/\r?\n/)) {
    if (l.startsWith('worktree ')) dir = l.slice(9).trim();
    else if (l.startsWith('branch refs/heads/') && dir) {
      const b = l.slice(18).trim();
      const rel = path.relative(path.join(root, LANES_DIR), dir);
      if (b.startsWith('lane/') && rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        try { if (laneLive(rel.split(path.sep)[0], root).live) live.add(b); } catch {}
      }
    }
  }
  return live;
}

/**
 * Task commits on lane branches that main doesn't have. { main, rows: [{ task, branch, sha, subject, at, ageH, live,
 * nextCopy }], skippedLive }. `task` narrows to one id; `all` keeps branches checked out in a live lane copy.
 */
export function findOrphans({ root = mainRoot(), task = null, all = false, now = Date.now() } = {}) {
  const main = mainBranch(root);
  const ids = boardIds(root);
  const known = (id) => (ids?.size ? ids.has(id) : /^[A-Z]+-\d+$/.test(id));
  const branches = out(git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/lane/')).split('\n').filter(Boolean);
  const live = liveBranches(root);
  const remembered = readJson(path.join(root, '.studio', 'lane-branches.json')) || {};
  const rows = [];
  const seen = new Set();
  let skippedLive = 0;
  for (const b of branches) {
    if (live.has(b) && !all) { skippedLive += 1; continue; }
    for (const c of branchOnly(root, b, main)) {
      if (seen.has(c.sha)) continue;
      const msg = `${c.subject}\n${c.body}`;
      const named = [...new Set([...msg.matchAll(TASK_ID)].map((m) => m[1]))].filter(known);
      const mine = task ? (namesTask(msg, task) ? [task] : []) : named;
      if (!mine.length) continue;
      seen.add(c.sha);
      for (const id of mine) rows.push({ task: id, branch: b, sha: c.sha, subject: c.subject, at: c.at, ageH: Math.max(0, Math.round((now - c.at) / 3600000)), live: live.has(b), nextCopy: remembered[id] === b });
    }
  }
  rows.sort((a, b) => a.task.localeCompare(b.task, 'en', { numeric: true }) || a.at - b.at);
  return { main, rows, skippedLive };
}

const age = (h) => (h >= 48 ? `${Math.round(h / 24)}d` : `${h}h`);
export function orphansText(r) {
  if (!r.rows.length) return `No task commits on lane branches that ${r.main} lacks.${r.skippedLive ? ` (${r.skippedLive} branch(es) in a live lane copy not looked at: --all)` : ''}`;
  const L = [`Task commits on lane branches not on ${r.main} (${r.rows.length}):`, `${'task'.padEnd(9)} ${'lane branch'.padEnd(36)} ${'sha'.padEnd(8)} ${'age'.padStart(4)}  next copy  subject`];
  for (const x of r.rows) L.push(`${x.task.padEnd(9)} ${x.branch.slice(0, 36).padEnd(36)} ${x.sha.slice(0, 8)} ${age(x.ageH).padStart(4)}  ${(x.nextCopy ? 'merges it' : 'no').padEnd(9)}  ${x.subject.slice(0, 90)}${x.live ? ' [live copy]' : ''}`);
  const tasks = [...new Set(r.rows.map((x) => x.task))];
  L.push(`Carry a task's own commits onto a fresh lane: npm run lanes -- carry ${tasks[0]} [--from <lane branch>] --by <you>`);
  if (r.skippedLive) L.push(`(${r.skippedLive} branch(es) checked out in a live lane copy not looked at: --all)`);
  return L.join('\n');
}

/** Who carries: { mode: 'copy' | 'main' } or { refused }. A worker only into its own copy, for the task it holds. */
export function carryCaller({ id, by = null, env = process.env } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const worker = (role && !DECIDER_ROLES.test(role)) || (owner && WORKER_NAME.test(owner)) || (!role && !owner && by && WORKER_NAME.test(by));
  if (!worker) return { mode: 'main' };
  if (!owner) return { refused: 'Refused: run it from your launched session (STUDIO_LOCK_OWNER set), in your own lane copy.' };
  if (!inLaneCopy()) return { refused: `Refused: ${owner} works in the main checkout; a worker carries commits only into its own lane copy (the Producer can carry from the main checkout).` };
  const held = listLocks().find((l) => l.key === `task:${id}`);
  if (!held || held.owner !== owner) return { refused: `Refused: ${owner} doesn't hold ${id}${held ? ` (${held.owner} does)` : ''}: start it first (node harness/task.mjs start ${id} --agent ${owner}), or ask the Producer to carry it.` };
  return { mode: 'copy', agent: owner };
}

/**
 * Carry the commits naming `id` from a lane branch. Returns { ok, status: carried|nothing|conflict|refused, why,
 * carried: [{ sha, new, subject }], left: [{ sha, subject }], branch, dir, conflict? }.
 */
export async function carryTask({ id, from = null, by = null, root = mainRoot(), env = process.env } = {}) {
  const t0 = Date.now();
  const res = (status, why, extra = {}) => {
    try { emitEvent({ type: `lanes.carry.${status}`, agent: String(by || env.STUDIO_LOCK_OWNER || 'unknown').slice(0, 60), task: id || null, to: status === 'carried' || status === 'nothing' ? null : 'producer', status: status === 'carried' || status === 'nothing' ? 'ok' : status === 'refused' ? 'warn' : 'blocked', durationMs: Date.now() - t0, msg: `carry ${id}: ${why}`.slice(0, 600), meta: { from: extra.from || from || null, branch: extra.branch || null, carried: (extra.carried || []).map((c) => c.sha.slice(0, 12)) } }); } catch {}
    return { ok: status === 'carried' || status === 'nothing', status, why, carried: [], left: [], skipped: [], ...extra };
  };
  if (!/^[A-Z]+-\d+$/.test(String(id || ''))) return res('refused', 'Usage: npm run lanes -- carry <ID> [--from <lane branch>] --by <you>');
  const who = carryCaller({ id, by, env });
  if (who.refused) return res('refused', who.refused);
  if (who.mode === 'main' && !String(by || env.STUDIO_LOCK_OWNER || '').trim()) return res('refused', 'Say who carries: --by <name>.');
  const main = mainBranch(root);
  // Which branch: given, or the one that holds the task's orphaned commits.
  let src = from;
  if (!src) {
    const o = findOrphans({ root, task: id, all: true });
    const bs = [...new Set(o.rows.map((x) => x.branch))];
    if (!bs.length) return res('nothing', `no commit naming ${id} on a lane branch that ${main} lacks`);
    if (bs.length > 1) return res('refused', `${id}'s commits are on ${bs.length} lane branches (${bs.join(', ')}): pass --from <lane branch>`);
    src = bs[0];
  }
  if (git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${src}`).status !== 0) return res('refused', `no branch ${src} (npm run lanes -- orphans lists them)`);
  // The target: the worker's own copy, or a fresh lane copy off main.
  let dir = REPO_ROOT;
  let copyAgent = null;
  if (who.mode === 'main') {
    copyAgent = `carry-${id.toLowerCase()}`;
    const c = createLaneCopy(copyAgent, { task: id, carry: false });
    if (c.error) return res('refused', `no fresh lane copy for ${id}: ${c.error}`);
    dir = c.dir;
  }
  const drop = () => { if (copyAgent) removeLaneCopy(copyAgent, { keepBranch: false }); };
  const gd = out(git(dir, 'rev-parse', '--absolute-git-dir'));
  for (const f of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) if (gd && fs.existsSync(path.join(gd, f))) { drop(); return res('refused', `a ${f.replace(/_HEAD$|-\w+$/, '').toLowerCase()} is in progress in ${dir === REPO_ROOT ? 'your copy' : 'the copy'}`); }
  const dirty = String(git(dir, 'status', '--porcelain', '--untracked-files=no').stdout || '').split('\n').filter((l) => l.length > 3 && !/^.. (studio|\.studio)(\/|$)/.test(l));
  if (dirty.length) { drop(); return res('refused', `uncommitted work in your copy (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}): commit it first`); }
  const branch = out(git(dir, 'symbolic-ref', '--short', 'HEAD'));
  const start = out(git(dir, 'rev-parse', 'HEAD'));
  const cands = branchOnly(dir, src, 'HEAD');
  const mine = cands.filter((c) => namesTask(`${c.subject}\n${c.body}`, id));
  const left = cands.filter((c) => !mine.includes(c)).map((c) => ({ sha: c.sha, subject: c.subject }));
  if (!mine.length) { drop(); return res('nothing', `no commit on ${src} names ${id} that ${branch || 'this copy'} lacks${left.length ? ` (${left.length} other commit(s) left out)` : ''}`, { left, from: src }); }
  const ident = out(git(dir, 'config', 'user.email')) ? [] : ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local'];
  const carried = [];
  const skipped = []; // 2.78.2 (c): commits whose patch is already on the target (git cherry '-'): listed, not an error
  const already = (sha) => /^-\s/m.test(String(git(dir, 'cherry', 'HEAD', sha, `${sha}^`).stdout || ''));
  for (const c of mine) {
    if (!/^(off|0|false|no)$/i.test(String(env.STUDIO_CARRY_SKIP_APPLIED ?? '').trim()) && already(c.sha)) { skipped.push({ sha: c.sha, subject: c.subject }); continue; }
    const p = spawnSync('git', [...ident, 'cherry-pick', '--allow-empty', c.sha], { cwd: dir, encoding: 'utf8', env: cleanEnv({ STUDIO_MAIN_ROOT: root }), maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (p.status === 0) { carried.push({ sha: c.sha, new: out(git(dir, 'rev-parse', 'HEAD')), subject: c.subject }); continue; }
    const files = out(git(dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    // 2.78.2 (c): a pick that changes nothing (the same change is on the target some other way) is skipped, not a conflict.
    if (!files.length && gd && fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD')) && git(dir, 'diff', '--cached', '--quiet').status === 0 && !/^(off|0|false|no)$/i.test(String(env.STUDIO_CARRY_SKIP_APPLIED ?? '').trim())) {
      git(dir, 'cherry-pick', '--abort');
      skipped.push({ sha: c.sha, subject: c.subject });
      continue;
    }
    if (gd && fs.existsSync(path.join(gd, 'CHERRY_PICK_HEAD'))) git(dir, 'cherry-pick', '--abort');
    git(dir, 'reset', '-q', '--hard', start);
    drop();
    const why = `stopped at ${c.sha.slice(0, 8)} "${c.subject.slice(0, 80)}": ${files.length ? `conflict in ${files.join(', ')}` : String(`${p.stderr || ''}${p.stdout || ''}`).trim().split('\n').pop()}; cherry-pick aborted, nothing carried (${carried.length} of ${mine.length} had applied before it and were taken back): resolve it by hand, or carry from a branch that applies`;
    return res('conflict', why, { from: src, left, conflict: { sha: c.sha, subject: c.subject, files } });
  }
  const skipNote = skipped.length ? `; skipped ${skipped.length} commit(s) already on ${branch || 'the target'} (same patch): ${skipped.map((c) => `${c.sha.slice(0, 8)} ${c.subject.slice(0, 50)}`).join('; ')}` : '';
  if (!carried.length) { drop(); return res('nothing', `every commit of ${id} on ${src} is already on ${branch || 'this copy'}${skipNote}`, { left, from: src, skipped }); }
  // The hooks gate judges a cherry-pick by patch-id; a stamp that no longer matches is re-stamped through the real hooks.
  let stampNote = '';
  try {
    const hs = await import('./hook-stamp.mjs');
    const head = out(git(dir, 'rev-parse', 'HEAD'));
    const c = await hs.checkHookStamps({ env: cleanEnv({ STUDIO_MAIN_ROOT: root, STUDIO_HARNESS_REF_TIMEOUT_MS: env.STUDIO_HARNESS_REF_TIMEOUT_MS || '3000' }), range: { base: start, head } });
    // A worker never re-stamps (as `lanes refresh`, a decider's job): it is told, and its own commits go through the hooks.
    if (c.open?.length && c.enforced !== false && who.mode === 'copy') stampNote = `; ${c.open.length} carried commit(s) don't match their hooks stamp: ask the Producer (npm run lanes -- refresh ${id} --by <producer>) before task done`;
    else if (c.open?.length && c.enforced !== false) {
      const r = await hs.restamp({ cwd: dir, base: start, env: cleanEnv({ STUDIO_MAIN_ROOT: root }) });
      stampNote = r.ok ? `; re-stamped ${r.replayed || 0} commit(s) through the hooks` : `; ${c.open.length} commit(s) need a re-stamp before they land (${r.why})`;
    }
  } catch (e) { stampNote = `; stamps not checked (${String(e.message || e).slice(0, 120)})`; }
  const list = carried.map((c) => `${c.sha.slice(0, 8)} ${c.subject.slice(0, 60)}`).join('; ');
  if (copyAgent) {
    rememberTaskBranch(id, branch);
    removeLaneCopy(copyAgent, { keepBranch: true });
    return res('carried', `carried ${carried.length} commit(s) of ${id} from ${src} onto ${branch} (off ${main})${left.length ? `; left out ${left.length} commit(s) that don't name ${id}` : ''}${skipNote}${stampNote}. The next session on ${id} gets them merged into its copy. Carried: ${list}`, { carried, left, skipped, branch, from: src });
  }
  return res('carried', `carried ${carried.length} commit(s) of ${id} from ${src} into your copy (${branch})${left.length ? `; left out ${left.length} commit(s) that don't name ${id}` : ''}${skipNote}${stampNote}. Carried: ${list}`, { carried, left, skipped, branch, from: src, dir });
}
