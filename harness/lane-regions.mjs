/**
 * harness/lane-regions.mjs — region lanes on big shared files, opted in per file.
 * A lane entry may name a region: `path/sim.ts#symbolName` (as `npm run map -- find` reads them) or
 * `path/sim.ts#L120-L340` (`#120-340` too). Several regions are several entries. Set them with `npm run task -- lane
 * <ID> <entries> --by <you>`, `task add --paths …`, or a task's --scope. Two entries on one file run side by side only
 * when the file is opted in AND both name a region AND the regions don't overlap (resolved on the main checkout's copy;
 * a symbol that can't be found overlaps everything). Else it is file-level. Lanes still land through the train, which
 * rebases each on main. Regions only decide who may start beside whom. Opt in: STUDIO_REGION_FILES (globs, comma
 * separated; "off" = none), else the manifest's "regionFiles" (<game>/studio.gates.json); off by default. Readers:
 * harness/task-hold.mjs lanesClash, harness/lane-plan.mjs, harness/task-overlap.mjs and the path claims in
 * harness/agent.mjs. laneList (sparse checkouts, gates, the drift watch) sees the whole file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, boardRoot } from './event.mjs';
import { matchAny } from './merge-lane.mjs';
import { activeGame, isTemplateCartridge } from './cartridge.mjs';
import { indexFile } from './codeindex.mjs';
import { normRel as norm } from './helpers.mjs';

const OFF = /^(off|0|false|no)$/i;

/** One lane entry: { path, region: null | { lines: [start, end] } | { symbol }, raw }. */
export function splitEntry(entry) {
  const raw = norm(entry);
  const i = raw.indexOf('#');
  if (i < 0) return { path: raw, region: null, raw };
  const p = norm(raw.slice(0, i));
  const r = raw.slice(i + 1).trim();
  const m = r.match(/^L?(\d+)(?:\s*-\s*L?(\d+))?$/i);
  if (m) {
    const a = Number(m[1]); const b = Number(m[2] || m[1]);
    return { path: p, region: { lines: [Math.min(a, b), Math.max(a, b)] }, raw };
  }
  if (/^[A-Za-z_$][\w$.]{0,120}$/.test(r)) return { path: p, region: { symbol: r }, raw };
  return { path: p, region: null, raw: p }; // not a region we read: the whole file
}
/** An entry without its region (the file). */
export const entryPath = (entry) => splitEntry(entry).path;

/** The files that allow region lanes: { globs, from }. [] (off) unless STUDIO_REGION_FILES or the manifest names some. */
export function regionFiles({ env = process.env, root = REPO_ROOT } = {}) {
  const v = String(env.STUDIO_REGION_FILES ?? '').trim();
  if (OFF.test(v)) return { globs: [], from: 'STUDIO_REGION_FILES=off' };
  if (v) return { globs: v.split(',').map(norm).filter(Boolean), from: 'STUDIO_REGION_FILES' };
  try {
    const name = activeGame().name;
    if (name && !isTemplateCartridge(name)) {
      for (const dir of [`game/${name}`, `web/${name}`, `cartridges/${name}`]) {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(root, dir, 'studio.gates.json'), 'utf8')); } catch { continue; }
        if (Array.isArray(j?.regionFiles) && j.regionFiles.length) return { globs: j.regionFiles.map(norm).filter(Boolean), from: `${dir}/studio.gates.json "regionFiles"` };
      }
    }
  } catch { /* no game: none */ }
  return { globs: [], from: 'none (off: STUDIO_REGION_FILES or the manifest\'s "regionFiles" opts a file in)' };
}

const symCache = new Map();
/** Line ranges of a symbol in a file, read on the main checkout: [[start, end]] or null (not found, unreadable). */
export function symbolRanges(file, symbol, { root = boardRoot() } = {}) {
  const abs = path.join(root, file);
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  const key = `${abs}\n${st.mtimeMs}\n${st.size}`;
  let idx = symCache.get(abs);
  if (!idx || idx.key !== key) {
    try { idx = { key, ...indexFile(abs, fs.readFileSync(abs, 'utf8')) }; } catch { idx = { key, functions: [], names: [] }; }
    symCache.set(abs, idx);
  }
  const want = String(symbol);
  const leaf = want.includes('.') ? want.split('.').pop() : want;
  const hits = [...idx.functions, ...idx.names].filter((f) => f.name === want || f.name === leaf).map((f) => [f.start, f.end || f.start]);
  return hits.length ? hits : null;
}

/** A region as line ranges, or null (unknown: overlaps everything). */
function rangesOf(e, root) {
  if (!e.region) return null;
  if (e.region.lines) return [e.region.lines];
  return symbolRanges(e.path, e.region.symbol, { root });
}
const meet = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a === '' || b === '';

/**
 * Do two lane entries clash? File-level (the same path, or one holds the other), except two regions of one opted-in
 * file whose line ranges don't overlap. opts: { globs (regionFiles), root }.
 */
export function entriesClash(a, b, { globs = null, root = boardRoot(), env = process.env } = {}) {
  const A = splitEntry(a); const B = splitEntry(b);
  if (!meet(A.path, B.path)) return false;
  if (A.path !== B.path || !A.region || !B.region) return true;
  const g = globs || regionFiles({ env, root: REPO_ROOT }).globs;
  if (!g.length || !matchAny(A.path, g)) return true;
  if (A.region.symbol && B.region.symbol && A.region.symbol === B.region.symbol) return true;
  const ra = rangesOf(A, root); const rb = rangesOf(B, root);
  if (!ra || !rb) return true;
  return ra.some(([s1, e1]) => rb.some(([s2, e2]) => s1 <= e2 && s2 <= e1));
}

/** Any clash between two lists of entries (the whole game, an empty list, clashes with everything). */
export function listsClash(A = [], B = [], opts = {}) {
  if (!A.length || !B.length) return true;
  const g = opts.globs || regionFiles({ env: opts.env || process.env, root: REPO_ROOT }).globs;
  return A.some((x) => B.some((y) => entriesClash(x, y, { ...opts, globs: g })));
}

/** Does a lane hold a region entry at all? (A cheap test before the region-aware checks.) */
export const hasRegion = (entries = []) => entries.some((e) => String(e).includes('#'));

/** The region entries of a lane on opted-in files: Set of files whose every entry in the lane is a region. */
export function regionOnlyFiles(entries = [], { globs = null, env = process.env } = {}) {
  const g = globs || regionFiles({ env, root: REPO_ROOT }).globs;
  if (!g.length) return new Set();
  const byFile = new Map();
  for (const e of entries.map(splitEntry)) {
    const list = byFile.get(e.path) || [];
    list.push(e);
    byFile.set(e.path, list);
  }
  return new Set([...byFile].filter(([f, l]) => matchAny(f, g) && l.every((e) => e.region)).map(([f]) => f));
}
