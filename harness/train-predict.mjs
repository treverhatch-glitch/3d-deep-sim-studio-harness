/**
 * harness/train-predict.mjs — 2.65.0 (B-34): conflict prediction when a lane is queued for the merge train.
 *
 * Crew report: T-099 was deferred only after a full verify of its train had started; a 2-second merge-tree at queue
 * time would have said "conflicts with T-092". `task done <ID> --train` now asks git, with no index and no files
 * touched (git merge-tree --write-tree --name-only, git >= 2.38):
 *
 *   - the lane against main: a textual conflict refuses the queue, naming the files (and file:line where cheap,
 *     hotspots.mjs conflictPlaces). The lane merges main first (git merge <main>, or npm run lanes -- refresh <lane>);
 *   - the lane against every lane already queued (main + that lane, then this one, as the train would merge them): a
 *     conflict only with a queued lane queues it marked `after: <that task>` (the queue entry's `after` field), so the
 *     train leaves it for a later train instead of finding the conflict after its verify started (train.mjs).
 *
 * Files listed in the game's manifest as "unionFiles" (2.60.0) merge with git's union driver in the train, so a
 * conflict only there counts as none. Older git: no prediction; the queue keeps 2.60's line-overlap warning
 * (hotspots.mjs) and says why. Events: task.train.predicted_conflict. Code only (git), no model.
 */
import { spawnSync } from 'node:child_process';
import * as mt from './merge-tree.mjs';

const { gitVersion, mergeTree } = mt;
const isSha = (s) => /^[0-9a-f]{40}$/.test(String(s || ''));

// 2.65.1: git's version, the merge-tree call, its parsing, the union-file exemption and the file:line places are
// harness/merge-tree.mjs's, shared with npm run lanes (harness/lanes.mjs); the names stay exported here.
export { gitVersion, mergeTree };
/** Does this git have `merge-tree --write-tree` (2.38+)? { ok, version, why }; STUDIO_TRAIN_PREDICT=off: no prediction. */
export function mergeTreeSupport(cwd = process.cwd(), text = null, env = process.env) {
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_PREDICT || ''))) return { ok: false, version: null, why: 'STUDIO_TRAIN_PREDICT=off' };
  return mt.mergeTreeSupport(cwd, text, env);
}

/**
 * main + a queued lane as a commit (objects only: no ref, no index, no files): { commit } | { conflict: true } (it
 * doesn't merge onto main: the train hands it back, so it isn't judged against) | { union: true } (only union files:
 * judged pairwise).
 */
function mainPlus(root, tip, head, unionFiles) {
  const m = mergeTree(root, tip, head, { unionFiles });
  if (m.error || !m.clean) return { conflict: true };
  if (m.union.length || !isSha(m.tree)) return { union: true };
  const c = spawnSync('git', ['-c', 'user.name=train-predict', '-c', 'user.email=train-predict@studio.local', 'commit-tree', m.tree, '-p', tip, '-p', head, '-m', 'train-predict (not a ref)'], { cwd: root, encoding: 'utf8' });
  return c.status === 0 && isSha(c.stdout.trim()) ? { commit: c.stdout.trim() } : { union: true };
}

const placesOf = mt.placesFor;
export const placeText = mt.placeText;

/**
 * Predict this lane's merge in the next train. lane: { task, head }; queue: the train queue's entries; tip: main's
 * head. Returns { mode: 'merge-tree' | 'off', why, main: null | { files, places }, lanes: [{ task, files, places }] }.
 * A queued lane already marked after this task (it waits for this one) is skipped: no lane ever waits on its waiter.
 */
export function predictLane(root, { lane, queue = [], tip, unionFiles = [], env = process.env } = {}) {
  const sup = mergeTreeSupport(root, null, env);
  if (!sup.ok) return { mode: 'off', why: sup.why, main: null, lanes: [] };
  if (!isSha(tip) || !isSha(lane?.head)) return { mode: 'off', why: 'main or the lane head could not be read', main: null, lanes: [] };
  const vsMain = mergeTree(root, tip, lane.head, { unionFiles });
  if (vsMain.error) return { mode: 'off', why: `git merge-tree failed: ${vsMain.error}`, main: null, lanes: [] };
  const res = { mode: 'merge-tree', why: '', main: null, lanes: [], union: vsMain.union };
  if (!vsMain.clean) { res.main = { files: vsMain.files, places: placesOf(root, tip, lane.head, vsMain.files) }; return res; }
  for (const e of queue) {
    if (!e || e.task === lane.task || !isSha(e.head) || e.head === lane.head) continue;
    if (e.after?.task === lane.task) continue;
    // A queued lane that doesn't merge onto main is the train's to hand back: nothing to wait for.
    const base = mainPlus(root, tip, e.head, unionFiles);
    if (base.conflict) continue;
    const ours = base.commit || e.head;
    const m = mergeTree(root, ours, lane.head, { unionFiles });
    if (m.union.length) res.union = [...new Set([...res.union, ...m.union])];
    if (m.error || m.clean) continue;
    res.lanes.push({ task: e.task, files: m.files, places: placesOf(root, ours, lane.head, m.files) });
  }
  return res;
}

/**
 * What `task done --train` does with a prediction: { refuse: message } (a conflict with main), or { after: { task,
 * files, places, at } | null, lines: [what to print] }. Emits task.train.predicted_conflict for each conflict found.
 */
export function queueVerdict(p, { task, agent = null, head = '', main = 'main', lane = '', emit = () => {} } = {}) {
  const lines = [];
  if (p.mode !== 'merge-tree') {
    lines.push(`${task}: note: no conflict prediction (${p.why}); the line-overlap warning below is all there is, and the train finds conflicts when it merges.`);
    return { after: null, lines };
  }
  if (p.union?.length) lines.push(`${task}: ${p.union.join(', ')} conflict only as union files (one entry per line): the train merges them with git's union driver.`);
  if (p.main) {
    const where = placeText(p.main);
    emit({ type: 'task.train.predicted_conflict', agent: agent || 'train', task, to: agent || undefined, status: 'blocked', msg: `${task} was not queued: it conflicts with ${main} (${where})`.slice(0, 600), meta: { with: main, files: p.main.files, places: p.main.places, head, refused: true } });
    return { refuse: `${task} was not queued: it conflicts with ${main} in ${p.main.files.length} file(s): ${where}. Merge ${main} into the lane first (git merge ${main}, resolve, commit; or npm run lanes -- refresh ${lane || '<lane>'}), then task done ${task} --train again. Nothing was queued.` };
  }
  if (!p.lanes.length) return { after: null, lines };
  const first = p.lanes[0];
  for (const c of p.lanes) {
    emit({ type: 'task.train.predicted_conflict', agent: agent || 'train', task, to: 'producer', status: 'warn', msg: `${task} conflicts with queued ${c.task} (${placeText(c)}): queued after it, for a later train`.slice(0, 600), meta: { with: c.task, files: c.files, places: c.places, head, after: first.task } });
    lines.push(`${task}: predicted conflict with queued ${c.task}: ${placeText(c)}.`);
  }
  lines.push(`${task} is queued after ${first.task}: the train leaves it for a train after ${first.task} lands (or leaves the queue); then merge ${main} into the lane if it conflicts there.`);
  return { after: { task: first.task, files: first.files.slice(0, 20), places: first.places.slice(0, 12), also: p.lanes.slice(1).map((c) => c.task), at: new Date().toISOString() }, lines };
}
