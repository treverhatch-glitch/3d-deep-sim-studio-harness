/**
 * qa/selftest-294c.mjs — 2.94 (c): "landed" on the scorecards counts only work that went to main or an engine target.
 * A task that was only closed is shown on its own line (closed without a landing). A log with no landing anywhere
 * says "closed". A task that landed and was then closed counts once, as landed. The --json field is added, not renamed.
 */
import { guardCap3000Of, importInDirOf } from './kit.mjs';

const NOW = Date.parse('2026-03-10T12:00:00Z');
const at = (m) => new Date(NOW - 3600000 + m * 60000).toISOString();
const done = (m, task) => ({ ts: at(m), type: 'task.done', task, msg: `Completed ${task}` });
// Three tasks land through a train and are closed after; two tasks are only closed.
const TRAIN = [
  { ts: at(1), type: 'task.train.landed', meta: { lanes: ['T-1', 'T-2'] } }, done(2, 'T-1'), done(3, 'T-2'),
  { ts: at(4), type: 'lane.merged', task: 'T-3' }, done(5, 'T-3'), done(6, 'T-4'), done(7, 'T-5'),
];
const NO_TRAIN = [done(1, 'T-1'), done(2, 'T-2'), done(3, 'T-3')];

export async function selftest294C({ dir, report }) {
  const guard = guardCap3000Of(report);
  const imp = importInDirOf(dir);
  const L = await imp('harness/landings.mjs');
  const S = await imp('harness/score.mjs');
  const H = await imp('harness/health.mjs');
  const card = (events) => S.roundScore({ events, machine: [], now: NOW, days: 1, root: dir, progressTimeoutMs: 1000 });

  await guard('2.94 (c) 3 train landings and 2 closes of tasks that never landed: the score says landed 3 and closed without a landing 2 (2.93 counted the 5 closes)', async () => {
    const s = await card(TRAIN);
    const h = H.health(TRAIN, { since: 0, now: NOW });
    return [/\(landed: 3; closed without a landing: 2\)/.test(s.notes.landedPerDay) && /5 done/.test(s.notes.landedPerDay) && L.landedText(TRAIN) === 'landed: 3; closed without a landing: 2' && String(H.renderHealth(h)).includes('- Landed: 3; closed without a landing: 2; refusals') && h.landings === 3, JSON.stringify({ n: s.notes.landedPerDay, t: L.landedText(TRAIN), h: h.landedText })];
  });
  await guard('2.94 (c) a log with no landing at all says closed, not landed, and no second part', async () => {
    const s = await card(NO_TRAIN);
    return [/\(closed: 3\)/.test(s.notes.landedPerDay) && !/landed:/.test(s.notes.landedPerDay) && L.landedText(NO_TRAIN) === 'closed: 3', JSON.stringify({ n: s.notes.landedPerDay })];
  });
  await guard('2.94 (c) a task that landed and was then closed counts once, as landed; a window with only closes of landed tasks has no second part', () => {
    const one = [{ ts: at(1), type: 'lane.merged', task: 'T-1' }, done(2, 'T-1')];
    return [L.landedText(one) === 'landed: 1' && L.landedCounts(one).closedWithoutLanding === 0 && L.landedText(TRAIN.slice(1, 3), TRAIN) === 'landed: 0; closed without a landing: 2', JSON.stringify({ a: L.landedText(one), b: L.landedText(TRAIN.slice(1, 3), TRAIN) })];
  });
  await guard('2.94 (c) the --json field: the score carries landed { measure, count, closedWithoutLanding } and its other fields are still there', async () => {
    const s = await card(TRAIN);
    const h = H.health(TRAIN, { since: 0, now: NOW });
    return [s.landed.measure === 'landed' && s.landed.count === 3 && s.landed.closedWithoutLanding === 2 && s.values && s.notes && h.closedWithoutLanding === 2 && h.landings === 3, JSON.stringify({ l: s.landed, h: h.closedWithoutLanding })];
  });
}
