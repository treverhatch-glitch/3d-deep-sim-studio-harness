/**
 * harness/release-predict.mjs — 2.73.0 (f): a release says what it expects to move, and the impact report scores it.
 *
 *   npm run release -- predict --metric <name> --expect "-30%" [--release <version>] [--why "<what should move it>"] [--by <name>]
 *   npm run release -- predict --list [--release <version>]
 *
 * The prediction goes in the release file docs/releases/<version>.json (the version: --release, else package.json's), one
 * entry per metric (a second predict for the same metric replaces it): { metric, expect, by, at, why }. It ships with the
 * harness, so a studio that takes the update has it, and `npm run autonomy -- impact` (harness/impact.mjs) scores each
 * prediction of the release it reports on: hit / miss with the measured change, or "not scored" while either side has
 * too little data (STUDIO_IMPACT_MIN_N). The CHANGELOG is not edited by this.
 *
 * Metrics: the impact report's measures (landedPerHour, verifyP50Min, verifyP90Min, redVerifyPct, handBacksPerLanded,
 * tokensPerKept, roundTripsPerLanded, noWorkPct) and the before snapshot's (falseRedsPerTrain, tokensPerLanded,
 * workaroundsPerDay), or the short names below. Expect: a signed percent change after vs before:
 *   "-30%"   hit when the change is -30% or lower (at least the drop predicted); "+10%": +10% or higher
 *   "<=-30%" / "<-30%" / ">=+10%" / ">+10%"   the bound as written
 *   "~0%" (or "0%")   hit when the change is within 10 points of it (the impact report's "same" band)
 * Paperwork: no model, no network.
 */
import fs from 'node:fs';
import path from 'node:path';

export const PREDICT_DIR = 'docs/releases';
export const METRICS = ['landedPerHour', 'verifyP50Min', 'verifyP90Min', 'redVerifyPct', 'handBacksPerLanded', 'tokensPerKept', 'roundTripsPerLanded', 'noWorkPct', 'falseRedsPerTrain', 'tokensPerLanded', 'workaroundsPerDay'];
export const ALIASES = {
  'landed/h': 'landedPerHour', 'landed-per-hour': 'landedPerHour', landed: 'landedPerHour',
  'red-verify': 'redVerifyPct', 'red-verify%': 'redVerifyPct', 'red-verify-pct': 'redVerifyPct',
  'false-reds': 'falseRedsPerTrain', 'false-reds-per-train': 'falseRedsPerTrain',
  'tokens-per-kept': 'tokensPerKept', 'tokens-per-landed': 'tokensPerLanded',
  'workarounds/day': 'workaroundsPerDay', workarounds: 'workaroundsPerDay', 'workarounds-per-day': 'workaroundsPerDay',
  'verify-p50': 'verifyP50Min', 'verify-p90': 'verifyP90Min', 'hand-backs': 'handBacksPerLanded', 'round-trips': 'roundTripsPerLanded', 'no-work': 'noWorkPct',
};
export const SAME_BAND = 10;

export function metricKey(name) {
  const n = String(name || '').trim();
  if (METRICS.includes(n)) return n;
  const lower = n.toLowerCase();
  return METRICS.find((m) => m.toLowerCase() === lower) || ALIASES[lower] || null;
}

/** "-30%" -> { op: '<=', value: -30 }; "~0%" -> { op: '~', value: 0 }; null when it isn't a signed percent. */
export function parseExpect(text) {
  const m = String(text || '').trim().match(/^(<=|>=|<|>|~)?\s*([+-]?\d+(?:\.\d+)?)\s*%$/);
  if (!m) return null;
  const value = Number(m[2]);
  const op = m[1] || (value < 0 ? '<=' : value > 0 ? '>=' : '~');
  return { op, value };
}

/** Did a measured change (in %) meet the expectation? */
export function meets(exp, delta) {
  if (!exp || !Number.isFinite(delta)) return null;
  switch (exp.op) {
    case '<=': return delta <= exp.value;
    case '<': return delta < exp.value;
    case '>=': return delta >= exp.value;
    case '>': return delta > exp.value;
    default: return Math.abs(delta - exp.value) <= SAME_BAND;
  }
}

const safeVer = (v) => String(v || '').replace(/^v/, '').replace(/[^\w.-]+/g, '_').slice(0, 40);
export const predictRel = (version) => `${PREDICT_DIR}/${safeVer(version)}.json`;

export function readPredictions(root, version) {
  if (!version) return [];
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, ...predictRel(version).split('/')), 'utf8'));
    return Array.isArray(doc?.predictions) ? doc.predictions.filter((p) => metricKey(p?.metric) && parseExpect(p?.expect)) : [];
  } catch { return []; }
}

/** Record (or replace) one prediction. Returns { ok, file, prediction } or { ok: false, why }. */
export function recordPrediction({ root, version, metric, expect, by = '', why = '', now = Date.now() } = {}) {
  const key = metricKey(metric);
  if (!key) return { ok: false, why: `unknown metric "${metric || ''}"; use one of ${METRICS.join(', ')}` };
  const exp = parseExpect(expect);
  if (!exp) return { ok: false, why: `--expect "${expect || ''}" isn't a signed percent change: use "-30%", "+10%", "~0%", "<=-30%" or ">=+10%"` };
  if (!/^\d+\.\d+\.\d+/.test(String(version || ''))) return { ok: false, why: `no release version (got "${version || ''}"): give --release <x.y.z>` };
  const rel = predictRel(version);
  const file = path.join(root, ...rel.split('/'));
  let doc = { version: safeVer(version), predictions: [] };
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(d?.predictions)) doc = { ...d, version: safeVer(version) }; } catch { /* a new file */ }
  const prediction = { metric: key, expect: String(expect).trim(), by: String(by || '').trim().slice(0, 60) || null, at: new Date(now).toISOString(), ...(String(why || '').trim() ? { why: String(why).replace(/\s+/g, ' ').trim().slice(0, 300) } : {}) };
  doc.predictions = [...doc.predictions.filter((p) => metricKey(p.metric) !== key), prediction];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { ok: true, file: rel, prediction };
}

/**
 * Score predictions against measured rows: [{ key, before, after, verdict }] (the impact report's rows and extra rows).
 * Returns [{ metric, expect, result: 'hit' | 'miss' | 'not scored', delta (%, rounded), before, after, why? }].
 */
export function scorePredictions(predictions, rows) {
  return predictions.map((p) => {
    const key = metricKey(p.metric);
    const exp = parseExpect(p.expect);
    const r = rows.find((x) => x.key === key);
    const base = { metric: key, expect: p.expect, by: p.by || null };
    if (!r) return { ...base, result: 'not scored', why: 'not measured in this report' };
    if (String(r.verdict || '').startsWith('not enough') || r.before === null || r.after === null) return { ...base, result: 'not scored', before: r.before, after: r.after, why: r.verdict || 'no value on one side' };
    const delta = r.before === 0 ? (r.after === 0 ? 0 : (r.after > 0 ? Infinity : -Infinity)) : (100 * (r.after - r.before)) / Math.abs(r.before);
    const hit = meets(exp, delta);
    return { ...base, result: hit ? 'hit' : 'miss', delta: Number.isFinite(delta) ? Math.round(delta * 10) / 10 : delta, before: r.before, after: r.after };
  });
}

export function predictCli(argv, { root, version }) {
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && (!String(argv[i + 1]).startsWith('--') || /^[+-]?\d/.test(String(argv[i + 1]).slice(2))) ? argv[i + 1] : null; };
  const v = flag('release') || version;
  const usage = 'Usage: npm run release -- predict --metric <name> --expect "-30%" [--release <version>] [--why "…"] [--by <name>]\n       npm run release -- predict --list [--release <version>]';
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, text: usage };
  if (argv.includes('--list')) {
    const ps = readPredictions(root, v);
    return { code: 0, text: ps.length ? [`Predictions for ${v} (${predictRel(v)}):`, ...ps.map((p) => `  ${p.metric}: ${p.expect}${p.why ? ` (${p.why})` : ''}${p.by ? `, by ${p.by}` : ''}`)].join('\n') : `No predictions for ${v} (${predictRel(v)}).` };
  }
  const r = recordPrediction({ root, version: v, metric: flag('metric'), expect: flag('expect'), by: flag('by') || '', why: flag('why') || '' });
  if (!r.ok) return { code: 2, text: `${r.why}\n${usage}` };
  return { code: 0, text: `Recorded in ${r.file}: ${r.prediction.metric} ${r.prediction.expect} for ${v}. Commit it with the release; npm run autonomy -- impact --release ${v} scores it once the studio has data after the update.` };
}
