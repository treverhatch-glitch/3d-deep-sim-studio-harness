/**
 * harness/play-gaps.mjs — the paths no play.focus.map entry takes. Each land run whose Play Mode stage ran in full for
 * that reason leaves its unmatched paths in .studio/engine/<x>-play-gaps.jsonl (noteUnmatched). The digest counts those
 * runs of the last 24 hours (gapsDigestLine). `npm run engine -- play-plan --propose` groups the paths by folder and
 * proposes an entry for each: skip when the rules tests already judge the folder, else a map entry to fill in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { focusFilters, playFocusConfig, rulesConfig } from './engine-rules.mjs';
import { filterMinutes, playFixtures, timesConfig } from './rules-times.mjs';

const DAY = 86400000;
const KEEP_LINES = 200;
const gapsFile = (root, engine) => path.join(root, '.studio', 'engine', `${engine}-play-gaps.jsonl`);
const norm = (p) => String(p || '').replace(/\\/g, '/');
const folderOf = (p) => { const d = path.posix.dirname(norm(p)); return d === '.' ? '(top folder)' : `${d}/`; };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Keep the unmatched paths of one train's play stage. Never throws. */
export function noteUnmatched(root, engine, { train = '', paths = [], now = Date.now() } = {}) {
  try {
    const list = [...new Set((paths || []).map(norm).filter(Boolean))].slice(0, 500);
    if (!list.length) return;
    const f = gapsFile(root, engine);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    fs.writeFileSync(f, `${[...old, JSON.stringify({ at: new Date(now).toISOString(), train: String(train), paths: list })].slice(-KEEP_LINES).join('\n')}\n`);
  } catch { /* a note that cannot be kept is not worth a failed train */ }
}

/** [{ at, train, paths }] of one engine, newest last. since: ms. */
export function readUnmatched(root, engine, { since = 0 } = {}) {
  let lines = [];
  try { lines = fs.readFileSync(gapsFile(root, engine), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const out = [];
  for (const l of lines) { try { const r = JSON.parse(l); if (Array.isArray(r.paths) && (Date.parse(r.at) || 0) >= since) out.push(r); } catch { /* skipped */ } }
  return out;
}

/** The digest line for the last 24 hours, or ''. */
export function gapsDigestLine(root, { now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(path.join(root, '.studio', 'engine')).map((n) => /^([a-z][a-z0-9-]*)-play-gaps\.jsonl$/.exec(n)?.[1]).filter(Boolean); } catch { return ''; }
  let runs = 0;
  const byFolder = new Map();
  for (const e of names) for (const r of readUnmatched(root, e, { since: now - DAY })) { runs += 1; for (const p of r.paths) byFolder.set(folderOf(p), (byFolder.get(folderOf(p)) || 0) + 1); }
  if (!runs) return '';
  const top = [...byFolder].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([f]) => f);
  return `Play Mode ran in full ${runs} time${runs === 1 ? '' : 's'} in 24 h for unmapped paths: ${top.join(', ')}; npm run engine -- play-plan --propose`;
}

/** The start of every path a rules.focus.auto description names (lower case). */
function autoStarts(auto) {
  return (Array.isArray(auto) ? auto : auto ? [auto] : []).flatMap((a) => [a.root ? `${a.root}/` : '', a.from ? a.from.split('{name}')[0] : '', ...(a.paths || []).map((t) => t.split('{name}')[0])]).filter(Boolean).map((x) => x.toLowerCase());
}

/** What the kept fixture times say about one proposed entry (fixtures: null when play.times is not set). */
function costOf(kind, folder, fixtures) {
  if (kind === 'skip') return 'no Play Mode time: it is skipped';
  if (!fixtures) return 'cost unknown: engines.<x>.play.times is not set';
  if (!fixtures.length) return 'cost unknown: no Play Mode times are kept yet';
  const seg = folder.replace(/\/$/, '').split('/').pop();
  const hit = fixtures.filter((f) => f.name.toLowerCase().includes(seg.toLowerCase()));
  return hit.length ? `fixtures with "${seg}" in the name take ${Math.round(hit.reduce((n, f) => n + f.minutes, 0) * 10) / 10} min (${hit.length})` : `no kept fixture has "${seg}" in its name`;
}

/**
 * Groups by folder with a proposed entry each: [{ folder, count, paths, kind: 'skip' | 'map', entry, why }]. skip: every path
 * is judged by the rules tests (a rules.focus map entry or auto folder).
 */
export function proposeGroups(paths, { rules = null, fixtures = null } = {}) {
  const groups = new Map();
  for (const p of new Set((paths || []).map(norm).filter(Boolean))) groups.set(folderOf(p), [...(groups.get(folderOf(p)) || []), p]);
  const starts = autoStarts(rules?.focus?.auto);
  const judged = (p) => (rules?.focus?.map?.length && focusFilters({ changed: [p], map: rules.focus.map }).ok) || starts.some((s) => p.toLowerCase().startsWith(s));
  return [...groups].map(([folder, list]) => {
    const rule = list.every(judged);
    const match = folder === '(top folder)' ? `^[^/]+$` : `^${esc(folder)}`;
    const kind = rule ? 'skip' : 'map';
    const why = rule ? 'the rules tests already judge these paths' : 'no rules test or Play Mode filter covers these paths yet';
    return { folder, count: list.length, paths: list.slice(0, 5), kind, entry: kind === 'skip' ? match : { match, filter: '<the Play Mode tests for this folder>' }, why, cost: costOf(kind, folder, fixtures) };
  }).sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

export function proposeText(engine, groups, from) {
  if (!groups.length) return `No unmatched paths for ${engine} ${from}: every path is taken by a play.focus.map entry.`;
  const L = [`Play Mode map gaps for ${engine} (${from}): ${groups.reduce((n, g) => n + g.count, 0)} path(s) in ${groups.length} folder(s).`];
  for (const g of groups.slice(0, 30)) {
    L.push(`${g.folder} (${g.count} path${g.count === 1 ? '' : 's'}; ${g.why}; ${g.cost})`);
    L.push(g.kind === 'skip' ? `  add to engines.${engine}.play.focus.skip: ${JSON.stringify(g.entry)}` : `  add to engines.${engine}.play.focus.map: ${JSON.stringify(g.entry)}   (fill in the filter)`);
  }
  if (groups.length > 30) L.push(`and ${groups.length - 30} more folder(s)`);
  return L.join('\n');
}

/** `play-plan --propose`: { text, code, groups }. plan: playPlan's result for --branch or --paths, else the recorded paths of the last 7 days. */
export function proposeGaps(root, { engine = 'unity', plan = null, json = false } = {}) {
  if (plan?.error) return { text: plan.message, code: 1, groups: [] };
  const rules = rulesConfig(engine, { root });
  const from = plan ? plan.source : 'the Play Mode stages of the last 7 days';
  const paths = plan ? (plan.selection?.unmatchedAll || []) : readUnmatched(root, engine, { since: Date.now() - 7 * DAY }).flatMap((r) => r.paths);
  const groups = proposeGroups(paths, { rules, fixtures: timesConfig(root, engine, 'play') ? playFixtures(root, engine) : null });
  return { text: json ? JSON.stringify(groups) : proposeText(engine, groups, from), code: 0, groups };
}

/** Lines for `play-plan` about Play Mode time: the plan's expected minutes, the 10 slowest fixtures and the total, the minutes of each map entry's filter ("?": not a plain name). */
export function playCostLines(root, { engine = 'unity', cfg = {}, plan = null } = {}) {
  if (!timesConfig(root, engine, 'play')) return [];
  const fx = playFixtures(root, engine);
  if (!fx.length) return [`  Play Mode time: none kept yet (engines.${engine}.play.times is set; a land run that runs the play stage keeps it).`];
  const total = Math.round(fx.reduce((n, f) => n + f.minutes, 0) * 10) / 10;
  const sel = plan?.selection;
  const exp = sel?.mode === 'focus' ? filterMinutes(sel.filter, fx) : null;
  const L = exp == null ? [] : [`  expected Play Mode time for this plan: about ${exp} min`];
  L.push(`  Play Mode time per fixture: ${fx.length} fixtures, ${total} min in all. Slowest:`, ...fx.slice(0, 10).map((f) => `    ${f.minutes} min  ${f.name}`));
  const map = playFocusConfig(cfg)?.map || [];
  if (map.length) L.push('  Minutes by play.focus.map entry:', ...map.map((m) => { const c = filterMinutes(m.filter, fx); return `    ${c == null ? '?' : `${c} min`}  ${m.match} -> ${m.filter}`; }));
  return L;
}
