/**
 * harness/lane-at-claim.mjs — 2.76.0 (B-84): a builder gets its lane copy when it claims a task, not only at launch.
 *
 * The crew's evidence: builder-s141, builder-s144 and builder-api3 were started with `agent start --role builder` and no
 * --task. The launcher made no copy (a copy was made only for a task or a lane), so each ran in the main checkout,
 * claimed T-158 with `task start`, staged a game file in MAIN's index and was refused by the pre-commit hook ("this
 * session has no lane copy"). The launcher now gives such a session a copy at launch (worktree.mjs lanelessWantsCopy);
 * this covers a code-writing session that still claims from the main checkout (one its launcher started before an
 * update, or one whose copy couldn't be made at launch): `task start` makes its copy (.lanes/<agent>, the task's earlier
 * unlanded work merged in), records it on the session (so its launcher's clean-up keeps or removes it as usual) and
 * tells it to work there. If the copy can't be made the claim is handed back: a builder session never works in the main
 * checkout.
 *
 * Who it is for: a launched session (STUDIO_ROLE) of a role that writes code (not the Producer, the Director, a
 * planner or a person: worktree.mjs MAIN_CHECKOUT_ROLES). Not in a lane copy already, not the rehearsal
 * agent, and not when copies are off (STUDIO_WORKTREES=off; STUDIO_LANELESS=shared for a task with no lane).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { inLaneCopy, mainRoot, MAIN_CHECKOUT_ROLES, laneWantsCopy, lanelessWantsCopy, worktreeSupport, createLaneCopy, carryTaskBranchEx, LANES_DIR } from './worktree.mjs';
import { laneOf } from './task-hold.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isWorktree = (dir) => { try { return fs.existsSync(path.join(dir, '.git')) && spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim() === 'true'; } catch { return false; } };

/**
 * Does this `task start` need a lane copy made for it? { want, why, role, lane }. Pure apart from reading the task's lane.
 */
export function claimWantsCopy({ agent, task, env = process.env, lane: given } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim().toLowerCase();
  if (!agent || !task) return { want: false, why: 'no agent or task' };
  if (!role) return { want: false, why: 'not a launched session' };
  if (MAIN_CHECKOUT_ROLES.has(role)) return { want: false, why: `a ${role} works in the main checkout` };
  if (env.STUDIO_REHEARSAL === '1') return { want: false, why: 'the rehearsal agent' };
  if (inLaneCopy()) return { want: false, why: 'already in a lane copy' };
  let lane = given;
  if (lane === undefined) { try { lane = laneOf(task, readRecentEvents(20000)); } catch { lane = null; } }
  if (/^(off|0|false|no)$/i.test(env.STUDIO_WORKTREES || '')) return { want: false, why: 'STUDIO_WORKTREES=off' };
  if (!(laneWantsCopy(lane) || lanelessWantsCopy({ role, lane, task, env }))) return { want: false, why: lane ? `lane ${lane} is the board's` : 'STUDIO_LANELESS=shared' };
  return { want: true, why: '', role, lane: lane || null };
}

/**
 * Give the claiming session its lane copy. Returns null when none is needed, else { dir, rel, branch, made, carried }
 * or { error } (the caller hands the claim back). Records { copy: { dir, branch }, copyAtClaim } on the session.
 */
export function laneAtClaim({ agent, task, env = process.env, lane } = {}) {
  const w = claimWantsCopy({ agent, task, env, lane });
  if (!w.want) return null;
  const root = mainRoot();
  const sup = worktreeSupport(root);
  if (!sup.ok) {
    emitEvent({ type: 'lane.shared', agent, task, status: 'warn', msg: `${agent} claimed ${task} in the main checkout: no lane copy is possible here (${sup.why})` });
    return null;
  }
  const recFile = path.join(STUDIO_STATE_DIR, 'agents', `${agent}.json`);
  const rec = readJson(recFile);
  const dir = path.join(root, LANES_DIR, agent);
  const rel = `${LANES_DIR}/${agent}`;
  let made = false; let branch = null; let carried = null; let mixed = null;
  if (isWorktree(dir)) {
    branch = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim() || null;
    try { const cx = carryTaskBranchEx(task, dir); carried = cx.carried; mixed = cx.mixed; } catch { carried = null; }
  } else {
    const c = createLaneCopy(agent, { task, lane: w.lane });
    if (c.error) return { error: `no lane copy could be made for ${agent} (${c.error})` };
    made = true; branch = c.branch; carried = c.carried || null; mixed = c.mixed || null;
  }
  if (rec && rec.status === 'running') {
    try { fs.writeFileSync(recFile, JSON.stringify({ ...rec, copy: { dir: rel, branch }, copyAtClaim: { task, at: new Date().toISOString() } }, null, 2)); } catch {}
  }
  emitEvent({ type: 'lane.at_claim', agent, task, msg: `${agent} claimed ${task} from the main checkout: it works in ${rel} (branch ${branch || '?'})${made ? '' : ', its existing copy'}${carried ? `, with ${carried} merged in` : ''}`, meta: { dir: rel, branch, made } });
  return { dir, rel, branch, made, carried, mixed };
}

/** The lines `task start` prints for it. */
export function laneAtClaimLines(r) {
  if (!r || r.error) return [];
  return [
    ...(r.mixed ? [`MIXED LANE NOT MERGED: ${r.mixed.line}`] : []),
    `Your lane copy: ${r.rel} (${r.dir}), branch ${r.branch || '?'}${r.carried ? `, with the earlier agent's commits on ${r.carried} merged in` : ''}.`,
    `Work ONLY there from now on: cd ${JSON.stringify(r.dir.replace(/\\/g, '/'))} and edit, test and commit inside it. The main checkout refuses game commits; studio/ and .studio/ in the copy are the shared board and state. Then run task done from the copy.`,
  ];
}
