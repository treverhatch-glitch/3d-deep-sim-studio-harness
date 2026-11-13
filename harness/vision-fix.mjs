/**
 * harness/vision-fix.mjs — 2.85 (f): a "vision fix" lands first.
 *
 * A crew's fix for a broken pillar waited ten hours in the train queue behind routine ports. A vision fix is a task
 * added with `task add --vision-fix` (a pillar or a "never" line is visibly broken in a build; not for polish), or one
 * whose causedBy/fixOf parent is one. It starts before the same role's other waiting work (never pre-empting running
 * work), and goes to the front of the next web and engine train batch.
 *
 * Who may file one: the Director, the Producer, a playtester role and anyone outside the harness (the owner, the
 * overseer, the owner's stand-ins), by the board-decision verdict (harness/permission.mjs mayDecide('board')) plus the
 * playtester roles; never another worker session.
 */
// permission.mjs is imported when asked (mayFileVisionFix): the train modules import this file for the order only.

/** The playtester roles that may file a vision fix (what they play is where a broken pillar shows). */
export const PLAYTESTER_ROLES = /^(qa-playtester|playtester)$/i;
const PLAYTESTER_NAME = /^(qa-playtester|playtester)(-|_|\d|$)/i;
const parentOf = (m) => m?.causedBy || m?.fixOf || null;

/** May this caller set --vision-fix? Promise of { ok, why }. agent: the --agent given (a worker's name refuses, a playtester's is allowed). */
export async function mayFileVisionFix({ agent = '', env = process.env, root = process.cwd() } = {}) {
  const { WORKER_NAME, mayDecide, actorOf } = await import('./permission.mjs');
  const a = String(agent || '').trim();
  const actor = actorOf({ env, root });
  // A playtester session (its role), or a shell the harness didn't launch acting as one (--agent playtester-…).
  const launched = String(env.STUDIO_ROLE || '').trim();
  const playtester = PLAYTESTER_ROLES.test(String(actor.role || '')) || (!launched && PLAYTESTER_NAME.test(a));
  if (playtester) return { ok: true, why: '' };
  if (a && WORKER_NAME.test(a)) return { ok: false, why: `${a.slice(0, 40)} is a worker's name: only the Director, the Producer, a playtester or the overseer files a vision fix. Hand it back with a note (npm run task -- pause <ID> --note "vision: …")` };
  const d = mayDecide('board', actor, { root });
  return d.ok ? { ok: true, why: '' } : { ok: false, why: `only the Director, the Producer, a playtester or the overseer files a vision fix: ${d.why}` };
}

/** The ids of the vision fixes in an event list: marked at add, or a causedBy/fixOf child of one (4 levels). */
export function visionFixIds(events = []) {
  const meta = new Map();
  for (const e of events) if (e?.type === 'task.added' && e.task) meta.set(e.task, e.meta || {});
  const memo = new Map();
  const is = (id, depth = 0) => {
    if (memo.has(id)) return memo.get(id);
    const m = meta.get(id);
    let v = Boolean(m?.visionFix);
    const p = parentOf(m);
    if (!v && p && depth < 4 && p !== id) v = is(String(p), depth + 1);
    memo.set(id, v);
    return v;
  };
  const out = new Set();
  for (const id of meta.keys()) if (is(id)) out.add(id);
  return out;
}

/** Is a task's parent (meta.causedBy or meta.fixOf) a vision fix? */
export const parentIsVisionFix = (meta, events) => { const p = parentOf(meta); return Boolean(p && visionFixIds(events).has(String(p))); };

/** A stable reorder: the vision fixes first, everything else after in its own order. */
export function visionFirst(items, isVision) {
  const a = [];
  const b = [];
  for (const x of items || []) (isVision(x) ? a : b).push(x);
  return [...a, ...b];
}

/** 2.85 (f): the scorecard's vision-fix line from the log: { filed, landed, medianH } (filed in the window). */
export function visionFixFlow(events = [], { from = 0 } = {}) {
  const at = (e) => Date.parse(e?.ts) || 0;
  const ids = visionFixIds(events);
  const filed = events.filter((e) => e.type === 'task.added' && ids.has(e.task) && at(e) >= from);
  const hours = [];
  for (const f of filed) {
    const d = events.find((e) => e.type === 'task.done' && e.task === f.task && at(e) >= at(f));
    if (d) hours.push((at(d) - at(f)) / 3600000);
  }
  hours.sort((x, y) => x - y);
  const med = hours.length ? (hours.length % 2 ? hours[(hours.length - 1) / 2] : (hours[hours.length / 2 - 1] + hours[hours.length / 2]) / 2) : null;
  return { filed: filed.length, landed: hours.length, medianH: med === null ? null : Math.round(med * 10) / 10 };
}
