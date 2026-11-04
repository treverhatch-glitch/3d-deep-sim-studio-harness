/**
 * harness/known-red.mjs — 2.77.0 (P9.3 + P9.6): tests that are red on main itself.
 *
 * The crew's soak tests were red on main (one fails alone, one times out), so every train verify failed them, and the
 * one-full-green-verify rule cost ~23 minutes a round. Now a test the train found red on main ALONE (the prefix
 * bisection's "main itself is red", or a verify of main alone) is listed once in .studio/train/known-red.json with its
 * evidence { test (a sub-id naming a file: <gate>:<check>:<file>), gate, since, train, tree (main's), log, seen }.
 *
 * A later train verify still runs in full on the exact tree. When its ONLY red parts are listed tests, none of them in
 * a file the train's lanes change, the train re-runs just those test files on main's tip alone: red there too (they
 * still fail on main) -> the train lands, the reds reported (task.train.known_red), not blocking; green on main -> the
 * entries clear (main is green on them) and the red is the lanes', as before. A train that lands on a fully green
 * verify clears every entry (main is green on all of them now). `npm run task -- train status` and the War Room's train
 * card show the count. Never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { emitEvent } from './event.mjs';

const file = (root) => path.join(root, '.studio', 'train', 'known-red.json');
const read = (root) => { try { const j = JSON.parse(fs.readFileSync(file(root), 'utf8')); return Array.isArray(j?.tests) ? j.tests : []; } catch { return []; } };
const write = (root, tests) => { try { const f = file(root); fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, `${JSON.stringify({ note: 'Tests red on main itself (harness/known-red.mjs). A train whose only reds are these, on files its lanes do not change, lands when they still fail on main alone.', tests }, null, 2)}\n`); fs.renameSync(t, f); } catch {} };

export const readKnownRed = (root) => read(root);
/** A sub-id that names a test file (<gate>:<check>:<file>, or <gate>:<file>): only those are ever excused. */
export const fileSub = (sub) => { const parts = String(sub || '').split(':'); return parts.length >= 2 && /[\\/.]/.test(parts[parts.length - 1]) ? parts.slice(parts.length >= 3 ? 2 : 1).join(':').replace(/\\/g, '/') : null; };

/** List these sub-ids as red on main (once each; a repeat bumps `seen`). Returns the ids newly listed. */
export function addKnownRed(root, subs, { train = null, tree = null, log = null, gates = [] } = {}) {
  const list = read(root);
  const added = [];
  const now = new Date().toISOString();
  for (const sub of [...new Set(subs || [])].filter(fileSub)) {
    const e = list.find((x) => x.test === sub);
    if (e) { e.seen = (e.seen || 1) + 1; e.lastAt = now; e.lastTrain = train; continue; }
    list.push({ test: sub, gate: String(sub).split(':')[0], since: now, train, tree, log, gates, seen: 1, lastAt: now });
    added.push(sub);
  }
  write(root, list);
  if (added.length) { try { emitEvent({ type: 'task.train.known_red', agent: 'train', to: 'producer', status: 'warn', msg: `${added.length} test(s) are red on main itself (listed as known red: a train whose only reds are these lands while they still fail on main): ${added.slice(0, 4).join(', ')}${added.length > 4 ? ', …' : ''}`.slice(0, 600), meta: { action: 'listed', tests: added, train, tree, log } }); } catch {} }
  return added;
}

/** Clear entries (all when `subs` is null) with a reason. Returns the ids cleared. */
export function clearKnownRed(root, subs = null, why = '') {
  const list = read(root);
  if (!list.length) return [];
  const gone = list.filter((x) => !subs || subs.includes(x.test)).map((x) => x.test);
  if (!gone.length) return [];
  write(root, list.filter((x) => !gone.includes(x.test)));
  try { emitEvent({ type: 'task.train.known_red', agent: 'train', status: 'ok', msg: `known red cleared (${why || 'main is green on them'}): ${gone.slice(0, 4).join(', ')}${gone.length > 4 ? ', …' : ''}`.slice(0, 600), meta: { action: 'cleared', tests: gone, why } }); } catch {}
  return gone;
}

/**
 * Could these red parts be excused as known red? { ok, subs, why }: every red sub-id is listed, names a test file, and
 * no lane changes that file (`changed`: the train's changed files, repo-relative). Also red gates with no listed part:
 * never. `redGates`: the failing gate ids; `subs`: the failing sub-ids.
 */
export function knownRedCandidate(root, { redGates = [], subs = [], changed = [] } = {}) {
  const listed = new Set(read(root).map((x) => x.test));
  if (!listed.size || !subs.length) return { ok: false, why: listed.size ? 'no failing test named' : 'nothing listed' };
  const unlisted = subs.filter((s) => !listed.has(s) || !fileSub(s));
  if (unlisted.length) return { ok: false, why: `${unlisted.slice(0, 3).join(', ')} not known red` };
  const covered = new Set(subs.map((s) => String(s).split(':')[0]));
  const bare = redGates.filter((g) => !covered.has(String(g).split(':')[0]));
  if (bare.length) return { ok: false, why: `${bare.join(', ')} failed with no known-red part` };
  const ch = new Set((changed || []).map((f) => String(f).replace(/\\/g, '/')));
  const touched = subs.filter((s) => { const f = fileSub(s); return [...ch].some((c) => c === f || c.endsWith(`/${f}`) || f.endsWith(`/${c}`)); });
  if (touched.length) return { ok: false, why: `the train changes ${touched.map(fileSub).join(', ')}: a test a lane changed is never excused` };
  return { ok: true, subs, why: '' };
}

/** One line for train status: '' when nothing is listed. */
export function knownRedLine(root) {
  const list = read(root);
  if (!list.length) return '';
  return `Known red on main: ${list.length} test(s) (${list.slice(0, 3).map((x) => x.test).join(', ')}${list.length > 3 ? ', …' : ''}); a train whose only reds are these lands while they still fail on main (.studio/train/known-red.json)`;
}
