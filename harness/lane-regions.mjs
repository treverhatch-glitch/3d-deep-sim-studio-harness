/**
 * harness/lane-regions.mjs — 2.78.2 (item 9): region lanes on big shared files, opted in per file.
 *
 * The crew's run: lane overlap was file-level, so two lanes that both touch one 29k-line shared sim file never ran side
 * by side, and builders sat at 0-2 of 6. Now a lane entry may name a region of a file: `path/sim.ts#symbolName` (a
 * function, method, class or top-level name, as `npm run map -- find` reads them) or `path/sim.ts#L120-L340` (lines;
 * `#120-340` too). Several regions are several entries (`a/sim.ts#tickFlights,a/sim.ts#tickGates`). Set them where a
 * lane is set: `npm run task -- lane <ID> <entries> --by <you>`, `task add --paths …`, or a task's --scope.
 *
 * Two entries on the same file run side by side only when the file is opted in AND both name a region AND the regions
 * don't overlap (both resolved on the main checkout's copy of the file; a symbol that can't be found overlaps
 * everything). Anything else is file-level as before: a file not opted in, a whole-file entry, a folder that holds
 * the file. The lanes still land through the train, which rebases each on main; a real conflict hands the later lane
 * back as usual. Regions only decide who may start beside whom.
 *
 * Which files: STUDIO_REGION_FILES (globs, comma separated; "off" = none), else the game manifest's "regionFiles"
 * (<game>/studio.gates.json, as "sharedSim"), else none: off by default. To turn it on for one file:
 * STUDIO_REGION_FILES=web/<game>/src/sim/sim.ts in .env, then give its tasks region lanes.
 *
 * The readers: harness/task-hold.mjs lanesClash (the supervisor's side-by-side check, handout's lock check),
 * harness/lane-plan.mjs (shared sim stacking: a region task on an opted-in file is stacked only when the regions
 * overlap), harness/task-overlap.mjs (the lane-vs-lane note) and the launcher's path claims (harness/agent.mjs: a
 * region entry on an opted-in file isn't held as a file lock when the agent works in its own lane copy). Everything
 * that treats a lane as paths (laneList: sparse checkouts, gates, the drift watch) sees the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, boardRoot } from './event.mjs';
import { matchAny } from './merge-lane.mjs';
import { activeGame, isTemplateCartridge } from './cartridge.mjs';
import { indexFile } from './codeindex.mjs';

const OFF = /^(off|0|false|no)$/i;
const norm = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

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
