/**
 * harness/workaround-stats.mjs — 2.71.0 (z): the pure part of the self-repair loop (harness/workaround.mjs): how a
 * workaround is grouped (its signature) and how workarounds are counted (per day, top signatures, before and after
 * each harness upgrade). No imports and no I/O, so harness/impact.mjs and the digest can use it without a cycle.
 *
 * Signature: the harness command involved (`task done`, `supervisor stop`; an npm script is read through package.json
 * to the harness/ file it runs, so `npm run studio:stop` is `supervisor stop`) plus the normalised "what" (lower case; task and finding ids, hashes and numbers
 * replaced; small words dropped; the first 12 words). Repeats of the same trouble on different tasks group together.
 */

export const DAY = 86400000;
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'by', 'and', 'or', 'in', 'on', 'at', 'for', 'it', 'its', 'is', 'was', 'had', 'i', 'me', 'my', 'we', 'so', 'then', 'with', 'from', 'that', 'this']);
const ts = (e) => Date.parse(e?.ts) || 0;

/** The normalised "what": the words that say what was done, without ids, hashes or numbers. */
export function normWhat(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b[a-z]{1,4}-\d+\b/g, ' id ') // T-12, H-003, B-40, P-188
    .replace(/\b[0-9a-f]{7,40}\b/g, ' sha ')
    .replace(/\d+(?:[.:]\d+)*/g, ' n ')
    .replace(/[^a-z\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 12)
    .join(' ');
}

/**
 * The harness command a command line runs, as "<script> <subcommand>": `npm run task -- done T-1 --agent a` and
 * `node harness/task.mjs done T-9` are both "task done". scripts: package.json's scripts, so `npm run studio:stop`
 * reads as "supervisor stop". '' when nothing is recognisable.
 */
export function cmdKey(cmd, scripts = {}) {
  let toks = String(cmd || '').trim().split(/\s+/).map((t) => t.replace(/^["']+|["']+$/g, '')).filter(Boolean);
  while (toks.length && (/^[A-Z_][A-Z0-9_]*=/.test(toks[0]) || /^(env|npx|-u|NODE_PATH)$/i.test(toks[0]))) toks.shift();
  if (/^(npm|npm\.cmd|pnpm|yarn)$/i.test(toks[0] || '')) {
    toks.shift();
    if (toks[0] === 'run' || toks[0] === 'run-script') toks.shift();
    const script = toks.shift();
    if (!script) return '';
    const body = scripts && typeof scripts[script] === 'string' ? scripts[script] : '';
    // Only a harness/ file names the command better than the script does (`studio:stop` is `supervisor stop`; `verify`
    // stays `verify`, not run-gates).
    const m = body.match(/^node\s+(?:\.\/)?(harness\/[\w./-]+\.m?js)((?:\s+[\w:.-]+)*)\s*$/);
    toks = m ? [m[1], ...m[2].trim().split(/\s+/).filter(Boolean), ...toks] : [script, ...toks];
  } else if (/^node(\.exe)?$/i.test(toks[0] || '')) toks.shift();
  const first = toks.shift();
  if (!first) return '';
  const script = first.replace(/\\/g, '/').replace(/^.*\//, '').replace(/\.m?js$/, '');
  const rest = toks.filter((t) => t !== '--');
  const sub = rest[0] && !rest[0].startsWith('-') && /^[a-z][a-z:_-]*$/.test(rest[0]) && !/^[a-z]{1,4}-\d+$/i.test(rest[0]) ? rest[0] : '';
  return `${script}${sub ? ` ${sub}` : ''}`.toLowerCase();
}

/** A tiny stable hash (FNV-1a, 32 bit) as 8 hex characters: the signature's short id. */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

/** { signature, sig, cmd }: what groups repeats, and its short id. */
export function signatureOf({ what = '', cmd = '' } = {}, scripts = {}) {
  const key = cmdKey(cmd, scripts);
  const signature = `${key || '-'}: ${normWhat(what) || 'unnamed'}`;
  return { signature, sig: `S${shortHash(signature)}`, cmd: key };
}

const isWorkaround = (e) => e && e.type === 'harness.workaround';

/**
 * Counts over the log's harness.workaround events: { last24h, n (in `days`), perDay, days, top: [{ signature, sig, n }] }.
 */
export function workaroundStats(events = [], { now = Date.now(), days = 7, topN = 5 } = {}) {
  const from = now - days * DAY;
  const win = events.filter((e) => isWorkaround(e) && ts(e) >= from && ts(e) <= now);
  const by = new Map();
  for (const e of win) {
    const s = e.meta?.signature || 'unknown';
    const cur = by.get(s) || { signature: s, sig: e.meta?.sig || null, n: 0 };
    cur.n += 1;
    by.set(s, cur);
  }
  const top = [...by.values()].sort((a, b) => b.n - a.n || a.signature.localeCompare(b.signature)).slice(0, topN);
  return { last24h: win.filter((e) => ts(e) >= now - DAY).length, n: win.length, perDay: Math.round((win.length / days) * 100) / 100, days, top };
}

/** Workarounds per day in [from, to): { n, perDay }. */
export function perDayIn(events, from, to) {
  const n = events.filter((e) => isWorkaround(e) && ts(e) >= from && ts(e) < to).length;
  const d = Math.max(1 / 24, (to - from) / DAY);
  return { n, perDay: Math.round((n / d) * 100) / 100 };
}

/**
 * The trend around each upgrade (points: [{ version, at }], oldest first): workarounds per day over `days` before and
 * after it, each side kept inside its own release. verdict: fewer (the upgrade worked), more, same (within 10% or
 * under one a day both sides), or "too early" (under a day after it).
 */
export function workaroundTrend(events = [], points = [], { now = Date.now(), days = 7 } = {}) {
  const span = days * DAY;
  const pts = [...points].filter((p) => Number.isFinite(p?.at)).sort((a, b) => a.at - b.at);
  return pts.map((p, i) => {
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const before = perDayIn(events, Math.max(p.at - span, prev ? prev.at : -Infinity), p.at);
    const aTo = Math.min(p.at + span, next ? next.at : Infinity, now);
    const after = perDayIn(events, p.at, Math.max(aTo, p.at));
    let verdict;
    if (aTo - p.at < DAY) verdict = 'too early';
    else if (!before.n && !after.n) verdict = 'none either side';
    else {
      const change = (after.perDay - before.perDay) / Math.max(before.perDay, 1e-9);
      verdict = Math.abs(after.perDay - before.perDay) < 0.15 || Math.abs(change) <= 0.1 ? 'same' : change < 0 ? 'fewer' : 'more';
    }
    return { version: p.version, at: new Date(p.at).toISOString(), before, after, verdict };
  });
}
