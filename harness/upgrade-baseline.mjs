/**
 * harness/upgrade-baseline.mjs — 2.73.0 (f): the "before" snapshot of a harness update.
 *
 * `npm run upgrade -- --merge <ref>` (harness/upgrade-guard.mjs) writes .studio/upgrades/<from>-to-<to>.json just
 * before it merges: the studio's numbers over the STUDIO_UPGRADE_SNAPSHOT_DAYS (3) days before the update, computed from
 * the event log as it is at that moment. `npm run autonomy -- impact` (harness/impact.mjs) reads it when it is there, so
 * the "before" side is the clean starting point the studio had, not one recomputed later from a log that has rolled over
 * or picked up events written during the update (a 48-hour measured run starts from it).
 *
 * The numbers (each { value, n }):
 *   landedPerHour       tasks landed (task.done, lane.merged, the lanes of task.train.landed) per hour
 *   redVerifyPct        red train verifies (task.train.verify ok false) of all train verifies, %
 *   falseRedsPerTrain   red train verifies that were not the change's fault, per train: the same tree verified green
 *                       later, or the flake triage (test.flake_triage of that train and tree) labelled every failing
 *                       test something other than "real"
 *   verifyP50Min / verifyP90Min   train verify minutes
 *   tokensPerLanded     weighted session tokens (agent.session.end, cache reads at STUDIO_CACHE_READ_WEIGHT, 0.1) per landed
 *   tokensByTask        tokens per landed change by task, from the sessions that name their task: { tokensPerLandedNamed,
 *                       tasks, named, sessions, top: the five costliest [{ task, tokens, sessions }] }
 *   workaroundsPerDay   harness.workaround events per day
 *   handBacksPerLanded, noWorkPct   as the impact report has them
 *
 * No harness imports (only node's): an old studio runs the new upgrade guard straight from the ref (docs/RELEASE.md),
 * and the guard loads this file from beside itself, the studio, or the ref, so it must stand alone. A script over the
 * log: no model, no tokens, no network.
 */
import fs from 'node:fs';
import path from 'node:path';

export const UPGRADES_DIR = '.studio/upgrades';
const DAY = 86400000;
const ts = (e) => Date.parse(e?.ts) || 0;
const round = (x, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const pctl = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null; };
const landingsOf = (e) => (e.type === 'task.done' || e.type === 'lane.merged' ? (e.task ? [e.task] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [e.task] : []) : []);
export const snapshotDays = (env = process.env) => (Number(env.STUDIO_UPGRADE_SNAPSHOT_DAYS) > 0 ? Number(env.STUDIO_UPGRADE_SNAPSHOT_DAYS) : 3);
const cacheWeight = (env = process.env) => { const v = env.STUDIO_CACHE_READ_WEIGHT; return v === undefined || v === '' || !Number.isFinite(Number(v)) ? 0.1 : Math.max(0, Number(v)); };
const weighted = (e, w) => (Number(e.tokensIn) || 0) + (Number(e.tokensOut) || 0) + (Number(e.meta?.cacheRead ?? e.cacheRead) || 0) * w;
const trainOf = (e) => String(e.meta?.train || '').replace(/-\d+$/, '');

/** Red train verifies that were not the change's fault, and the trains, in a window of sorted events. */
export function falseReds(win) {
  const verifies = win.filter((e) => e.type === 'task.train.verify');
  const trains = new Set(verifies.map(trainOf).filter(Boolean));
  const triage = win.filter((e) => e.type === 'test.flake_triage' && Array.isArray(e.meta?.labels) && e.meta.labels.length);
  let n = 0;
  verifies.forEach((v, i) => {
    if (v.meta?.ok !== false && v.status !== 'blocked') return;
    const tree = v.meta?.tree;
    const greenLater = tree && verifies.slice(i + 1).some((x) => x.meta?.tree === tree && (x.meta?.ok === true || x.status === 'ok'));
    const flaky = triage.some((t) => ts(t) >= ts(v) && String(t.meta?.train || '') === String(v.meta?.train || '') && (!tree || !t.meta?.tree || t.meta.tree === tree) && t.meta.labels.every((l) => l.label && l.label !== 'real'));
    if (greenLater || flaky) n += 1;
  });
  return { falseReds: n, trains: trains.size, verifies: verifies.length };
}

/** Tokens per landed change by task, from sessions that name their task (agent.session.end's task or meta.task). */
export function tokensByTask(ends, landed, w) {
  const per = new Map();
  let named = 0;
  for (const e of ends) {
    const t = String(e.task || e.meta?.task || '');
    if (!t) continue;
    named += 1;
    if (!landed.has(t)) continue;
    const r = per.get(t) || { task: t, tokens: 0, sessions: 0 };
    r.tokens += weighted(e, w); r.sessions += 1; per.set(t, r);
  }
  const rows = [...per.values()].map((r) => ({ ...r, tokens: Math.round(r.tokens) })).sort((a, b) => b.tokens - a.tokens);
  return { sessions: ends.length, named, tasks: rows.length, tokensPerLandedNamed: rows.length ? Math.round(rows.reduce((s, r) => s + r.tokens, 0) / rows.length) : null, top: rows.slice(0, 5) };
}

/** The numbers over [from, to) of a list of events (any order). */
export function baselineMeasures(events, from, to, { env = process.env } = {}) {
  const win = (events || []).filter((e) => ts(e) >= from && ts(e) < to).sort((a, b) => ts(a) - ts(b));
  const landed = new Set();
  for (const e of win) for (const t of landingsOf(e)) landed.add(t);
  const hours = Math.max(1e-9, (to - from) / 3600000);
  const verifies = win.filter((e) => e.type === 'task.train.verify');
  const mins = verifies.map((e) => Number(e.meta?.ms)).filter((x) => Number.isFinite(x) && x >= 0).map((x) => x / 60000);
  const red = verifies.filter((e) => e.meta?.ok === false || e.status === 'blocked').length;
  const fr = falseReds(win);
  const ends = win.filter((e) => e.type === 'agent.session.end' && !e.meta?.outside);
  const w = cacheWeight(env);
  const tokens = ends.reduce((s, e) => s + weighted(e, w), 0);
  const work = win.filter((e) => e.type === 'harness.workaround').length;
  const handBacks = win.filter((e) => e.type === 'task.paused').length;
  const noWork = ends.filter((e) => e.meta?.outcome?.noWork).length;
  return {
    landedPerHour: { value: round(landed.size / hours, 3), n: landed.size, better: 'up' },
    redVerifyPct: { value: verifies.length ? round((100 * red) / verifies.length, 1) : null, n: verifies.length, better: 'down' },
    falseRedsPerTrain: { value: fr.trains ? round(fr.falseReds / fr.trains, 2) : null, n: fr.trains, falseReds: fr.falseReds, better: 'down' },
    verifyP50Min: { value: round(pctl(mins, 0.5), 1), n: mins.length, better: 'down' },
    verifyP90Min: { value: round(pctl(mins, 0.9), 1), n: mins.length, better: 'down' },
    tokensPerLanded: { value: landed.size ? Math.round(tokens / landed.size) : null, n: landed.size, better: 'down' },
    tokensByTask: tokensByTask(ends, landed, w),
    workaroundsPerDay: { value: round(work / Math.max(1e-9, (to - from) / DAY), 2), n: work, better: 'down' },
    handBacksPerLanded: { value: landed.size ? round(handBacks / landed.size, 2) : null, n: landed.size, better: 'down' },
    noWorkPct: { value: ends.length ? round((100 * noWork) / ends.length, 1) : null, n: ends.length, better: 'down' },
  };
}

const safeVer = (v) => String(v || '?').replace(/^v/, '').replace(/[^\w.-]+/g, '_').slice(0, 40) || '_';
export const snapshotRel = (from, to) => `${UPGRADES_DIR}/${safeVer(from)}-to-${safeVer(to)}.json`;

/**
 * Write the snapshot for an update from <from> to <to>: { file (relative), doc }. Kept when one is already there for the
 * same versions (a merge stopped on a conflict and finished with --continue keeps the moment before its first try).
 */
export function writeSnapshot({ root, from, to, ref = null, sha = null, events = [], now = Date.now(), env = process.env, by = null } = {}) {
  const rel = snapshotRel(from, to);
  const file = path.join(root, ...rel.split('/'));
  if (fs.existsSync(file)) { try { return { file: rel, doc: JSON.parse(fs.readFileSync(file, 'utf8')), kept: true }; } catch { /* rewritten below */ } }
  const days = snapshotDays(env);
  const fromMs = now - days * DAY;
  const doc = { kind: 'upgrade-baseline', from: String(from || '?'), to: String(to || '?'), ref, sha, by, takenAt: new Date(now).toISOString(), window: { from: new Date(fromMs).toISOString(), to: new Date(now).toISOString(), days }, events: (events || []).filter((e) => ts(e) >= fromMs && ts(e) < now).length, measures: baselineMeasures(events, fromMs, now, { env }) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return { file: rel, doc, kept: false };
}

/** The snapshot taken before the update to <version> ({ file, doc }), the newest when there are several; or null. */
export function readSnapshot(root, version) {
  const dir = path.join(root, ...UPGRADES_DIR.split('/'));
  const want = safeVer(version);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith(`-to-${want}.json`)); } catch { return null; }
  let best = null;
  for (const n of names) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (doc?.kind !== 'upgrade-baseline' || !doc.measures) continue;
      if (!best || (Date.parse(doc.takenAt) || 0) > (Date.parse(best.doc.takenAt) || 0)) best = { file: `${UPGRADES_DIR}/${n}`, doc };
    } catch { /* a torn file */ }
  }
  return best;
}

/** One line for the upgrade's output. */
export function snapshotLine(s) {
  const m = s.doc.measures;
  const v = (x) => (x?.value ?? '-');
  return `[upgrade] before snapshot ${s.file}${s.kept ? ' (kept from the first try)' : ''}: ${v(m.landedPerHour)} landed/h, ${v(m.falseRedsPerTrain)} false reds per train, ${v(m.redVerifyPct)}% red verifies, ${v(m.tokensPerLanded)} tokens per landed (${m.tokensByTask?.tokensPerLandedNamed ?? '-'} by task), ${v(m.workaroundsPerDay)} workarounds/day over ${s.doc.window.days} day(s).`;
}
