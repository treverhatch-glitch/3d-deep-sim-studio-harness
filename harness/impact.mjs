/**
 * harness/impact.mjs — 2.68.0: did a harness upgrade help? `npm run autonomy -- impact [--release <version>] [--days 3]
 * [--json]`.
 *
 * Upgrade points: when each harness version reached the studio's branch. From the event log (upgrade.merged, meta.to)
 * and from git history (a commit with an Upgrade-Ref / Upgrade-Versions trailer, harness/upgrade-guard.mjs; or a
 * package.json "version" bump on the first-parent line), earliest time per version.
 *
 * For one upgrade (the latest, or --release), the same measures over the --days (3) before and after it:
 *   landed per hour, train verify minutes p50 / p90, red verify % (train verifies), hand-backs per landed, tokens per
 *   kept change (the scorecard's tokenWork), owner round-trips per landed (the scorecard's), no-work sessions (per
 *   session).
 * A measure with under STUDIO_IMPACT_MIN_N (30) items on either side reads "not enough data (n=…)" and has no verdict.
 * The verdict: better / worse / same (within 10%) per measure; overall "better" when more measures improved than got
 * worse, "worse" the other way, "mixed" otherwise, "not enough data" with no measure judged. The digest names the
 * latest upgrade's verdict once one measure has enough data. A script over the log and git: no model, no tokens.
 */
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, readRecentEvents } from './event.mjs';
import { weightedTokens } from './token-weight.mjs';

const DAY = 86400000;
const ts = (e) => Date.parse(e?.ts) || 0;
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
export const impactMinN = (env = process.env) => (Number(env.STUDIO_IMPACT_MIN_N) >= 1 ? Math.round(Number(env.STUDIO_IMPACT_MIN_N)) : 30);
const verOf = (text) => { try { return JSON.parse(text).version || null; } catch { return null; } };

/** Upgrade points, oldest first: [{ version, at (ms), from, source, commit }]. */
export function upgradePoints({ root = REPO_ROOT, events = [], maxCommits = 400 } = {}) {
  const pts = new Map();
  const add = (version, at, extra) => { if (!version || !Number.isFinite(at)) return; const v = String(version).replace(/^v/, ''); const p = pts.get(v); if (!p || at < p.at) pts.set(v, { version: v, at, ...extra }); };
  for (const e of events) if (e.type === 'upgrade.merged' && e.meta?.to) add(e.meta.to, ts(e), { from: e.meta.from || null, source: 'event', commit: e.meta.commit || null });
  const head = git(root, 'rev-parse', '--verify', '-q', 'HEAD');
  if (head.status === 0) {
    // Upgrade merges: their trailers name the versions.
    const t = git(root, 'log', '--first-parent', `-${maxCommits}`, '--format=%H%x1f%ct%x1f%(trailers:key=Upgrade-Versions,valueonly,separator=%x3B)%x1f%(trailers:key=Upgrade-Ref,valueonly,separator=%x3B)%x1e');
    for (const rec of String(t.stdout || '').split('\x1e')) {
      const [h, ct, vers, ref] = rec.trim().split('\x1f');
      if (!h || !(vers || ref)) continue;
      const m = String(vers || '').match(/([\w.-]+)\s*->\s*([\w.-]+)/);
      if (m) add(m[2], Number(ct) * 1000, { from: m[1], source: 'Upgrade-Versions', commit: h });
    }
    // Version bumps in package.json on the first-parent line.
    const b = git(root, 'log', '--first-parent', `-${maxCommits}`, '--format=%H%x1f%ct', '--', 'package.json');
    for (const line of String(b.stdout || '').split('\n').filter(Boolean)) {
      const [h, ct] = line.split('\x1f');
      const now = verOf(git(root, 'show', `${h}:package.json`).stdout);
      const before = verOf(git(root, 'show', `${h}~1:package.json`).stdout);
      // A root commit (no parent) introduces the version; it isn't an upgrade.
      if (now && before && now !== before) add(now, Number(ct) * 1000, { from: before, source: 'version bump', commit: h });
    }
  }
  return [...pts.values()].sort((a, b) => a.at - b.at);
}

const pctl = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)] : null; };
const round = (x, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const landingsOf = (e) => (e.type === 'task.done' || e.type === 'lane.merged' ? (e.task ? [e.task] : []) : e.type === 'task.train.landed' ? (Array.isArray(e.meta?.lanes) ? e.meta.lanes.map(String) : e.task ? [e.task] : []) : []);

/**
 * The measures over [from, to): { landedPerHour, verifyP50Min, verifyP90Min, redVerifyPct, handBacksPerLanded,
 * tokensPerKept, roundTripsPerLanded, noWorkPct }, each { value, n }. card(from, to) (optional) gives the scorecard's
 * { tokensPerKept, keptN, roundTripsPerLanded, landed } for that window.
 */
export function measures(sorted, from, to, { card = null } = {}) {
  const win = sorted.filter((e) => ts(e) >= from && ts(e) < to);
  const landed = new Set();
  for (const e of win) for (const t of landingsOf(e)) landed.add(t);
  const hours = Math.max(1e-9, (to - from) / 3600000);
  const verifies = win.filter((e) => e.type === 'task.train.verify');
  const mins = verifies.map((e) => Number(e.meta?.ms)).filter((x) => Number.isFinite(x) && x >= 0).map((x) => x / 60000);
  const red = verifies.filter((e) => e.meta?.ok === false || e.status === 'blocked').length;
  const handBacks = win.filter((e) => e.type === 'task.paused').length;
  const ends = win.filter((e) => e.type === 'agent.session.end' && !e.meta?.outside);
  const noWork = ends.filter((e) => e.meta?.outcome?.noWork).length;
  const c = card ? card(from, to) : null;
  const tokens = ends.reduce((s, e) => s + weightedTokens(e), 0);
  return {
    landedPerHour: { value: round(landed.size / hours, 3), n: landed.size, better: 'up' },
    verifyP50Min: { value: round(pctl(mins, 0.5), 1), n: mins.length, better: 'down' },
    verifyP90Min: { value: round(pctl(mins, 0.9), 1), n: mins.length, better: 'down' },
    redVerifyPct: { value: verifies.length ? round((100 * red) / verifies.length, 1) : null, n: verifies.length, better: 'down' },
    handBacksPerLanded: { value: landed.size ? round(handBacks / landed.size, 2) : null, n: landed.size, better: 'down' },
    tokensPerKept: c ? { value: c.tokensPerKept, n: c.keptN || 0, better: 'down' } : { value: landed.size ? Math.round(tokens / landed.size) : null, n: landed.size, better: 'down', note: 'per landed (no scorecard)' },
    roundTripsPerLanded: { value: c ? c.roundTripsPerLanded : null, n: c ? c.landed : 0, better: 'down' },
    noWorkPct: { value: ends.length ? round((100 * noWork) / ends.length, 1) : null, n: ends.length, better: 'down' },
  };
}

export const MEASURE_NAMES = { landedPerHour: 'landed per hour', verifyP50Min: 'train verify p50 (min)', verifyP90Min: 'train verify p90 (min)', redVerifyPct: 'red verify %', handBacksPerLanded: 'hand-backs per landed', tokensPerKept: 'tokens per kept change', roundTripsPerLanded: 'owner round-trips per landed', noWorkPct: 'no-work sessions %' };

/** Compare before/after: { rows: [{ key, name, before, after, verdict }], verdict, judged }. */
export function compare(before, after, { minN = 30 } = {}) {
  const rows = [];
  let up = 0; let down = 0;
  for (const k of Object.keys(MEASURE_NAMES)) {
    const b = before[k]; const a = after[k];
    let verdict;
    if (!b || !a || b.n < minN || a.n < minN || b.value === null || a.value === null) verdict = `not enough data (n=${b?.n ?? 0} before, ${a?.n ?? 0} after; needs ${minN})`;
    else {
      const base = Math.abs(b.value) || 1e-9;
      const change = (a.value - b.value) / base;
      if (Math.abs(change) <= 0.1) verdict = 'same';
      else { const good = b.better === 'up' ? change > 0 : change < 0; verdict = good ? 'better' : 'worse'; if (good) up += 1; else down += 1; }
    }
    rows.push({ key: k, name: MEASURE_NAMES[k], before: b?.value ?? null, after: a?.value ?? null, nBefore: b?.n ?? 0, nAfter: a?.n ?? 0, verdict });
  }
  const judged = rows.filter((r) => !r.verdict.startsWith('not enough')).length;
  const verdict = !judged ? 'not enough data' : up > down ? 'better' : down > up ? 'worse' : 'mixed';
  return { rows, verdict, judged, better: up, worse: down };
}

/**
 * The report for one upgrade. events: the log; release: a version (default: the latest point); days: each side.
 * card(from, to): optional scorecard figures. Returns { ok, release, at, from, rows, verdict, ... } or { ok: false, why }.
 */
export function impactReport({ events = [], root = REPO_ROOT, release = null, days = 3, now = Date.now(), env = process.env, card = null, points = null } = {}) {
  const pts = points || upgradePoints({ root, events });
  if (!pts.length) return { ok: false, why: 'no harness upgrade found (no upgrade.merged event, Upgrade-Versions trailer or package.json version bump)' };
  const want = release ? String(release).replace(/^v/, '') : null;
  const p = want ? pts.find((x) => x.version === want) : pts[pts.length - 1];
  if (!p) return { ok: false, why: `no upgrade to ${want} found; known: ${pts.map((x) => x.version).slice(-8).join(', ')}` };
  const span = Math.max(0.01, Number(days) || 3) * DAY;
  const next = pts.find((x) => x.at > p.at);
  const prev = [...pts].reverse().find((x) => x.at < p.at);
  // Each side stays within this release: before starts no earlier than the previous upgrade, after ends at the next.
  const bFrom = Math.max(p.at - span, prev ? prev.at : -Infinity); const aTo = Math.min(p.at + span, next ? next.at : Infinity, now);
  const sorted = [...events].sort((a, b) => ts(a) - ts(b));
  const before = measures(sorted, bFrom, p.at, { card });
  const after = measures(sorted, p.at, aTo, { card });
  const cmp = compare(before, after, { minN: impactMinN(env) });
  return { ok: true, release: p.version, from: p.from || null, source: p.source, commit: p.commit || null, at: new Date(p.at).toISOString(), before: { from: new Date(bFrom).toISOString(), to: new Date(p.at).toISOString() }, after: { from: new Date(p.at).toISOString(), to: new Date(aTo).toISOString() }, days: Number(days) || 3, ...cmp };
}

export function impactText(r) {
  if (!r.ok) return `Impact: ${r.why}.`;
  const L = [`Harness ${r.release}${r.from ? ` (from ${r.from})` : ''} reached the studio ${r.at} (${r.source}${r.commit ? ` ${String(r.commit).slice(0, 10)}` : ''}). ${r.days} day(s) before vs after:`];
  for (const x of r.rows) L.push(`  ${x.name}: ${x.before ?? '-'} -> ${x.after ?? '-'} (n ${x.nBefore}/${x.nAfter}): ${x.verdict}`);
  L.push(`Verdict: ${r.verdict}${r.judged ? ` (${r.better} better, ${r.worse} worse of ${r.judged} judged)` : ''}.`);
  return L.join('\n');
}

/** The digest's line: the latest upgrade's verdict, once a measure has enough data on both sides; '' otherwise. */
export function impactDigestLine({ events = null, root = REPO_ROOT, now = Date.now(), env = process.env } = {}) {
  const r = impactReport({ events: events || readRecentEvents(50000), root, now, env });
  if (!r.ok || !r.judged) return '';
  return `Upgrade ${r.release} (${r.at.slice(0, 10)}): ${r.verdict} (${r.better} better, ${r.worse} worse of ${r.judged} judged; npm run autonomy -- impact).`;
}

/**
 * A scorecard window function for impactReport (tokens per kept change, round-trips per landed). autonomy: autonomy.mjs's
 * { buildAutonomy, personClassifier }, passed in by its CLI (importing autonomy.mjs from its own top-level await would
 * never settle); imported here otherwise.
 */
export async function scorecardWindows({ events, autonomy = null }) {
  const a = autonomy || (await import('./autonomy.mjs'));
  const isPersonName = await a.personClassifier();
  return (from, to) => {
    try {
      const c = a.buildAutonomy(events, { now: to, days: Math.max(0.001, (to - from) / DAY), isPersonName, weigh: (e) => weightedTokens(e) });
      return { tokensPerKept: c.tokenWork?.costPerKept?.tokens ?? null, keptN: c.tokenWork?.kept ?? 0, roundTripsPerLanded: c.roundTripsPerLanded, landed: c.landed };
    } catch { return null; }
  };
}

export async function impactCli(argv, { root = REPO_ROOT, autonomy = null } = {}) {
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const events = readRecentEvents(200000);
  const days = flag('days') ? Number(flag('days')) : 3;
  if (flag('days') && !(days > 0)) return { code: 2, text: 'Usage: npm run autonomy -- impact [--release <version>] [--days 3] [--json]' };
  let card = null;
  try { card = await scorecardWindows({ events, autonomy }); } catch {}
  const r = impactReport({ events, root, release: flag('release'), days, card });
  return { code: r.ok ? 0 : 1, text: argv.includes('--json') ? JSON.stringify(r, null, 2) : impactText(r), report: r };
}

