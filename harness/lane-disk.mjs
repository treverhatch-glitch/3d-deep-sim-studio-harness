#!/usr/bin/env node
/**
 * harness/lane-disk.mjs — the lane disk report, stale-lane proposals, the lane copies' size, the short-disk pass.
 *   npm run lanes -- disk [--top N] [--json]   each lane copy's size (.lanes/<x>, train scratch included), the top N (10),
 *       the total, and what the lane exclusions would save. Over STUDIO_LANES_MAX_GB (25% of the disk) a lanes.disk_over warning.
 * lanesPass (STUDIO_JANITOR_LANES_MIN, 360): the janitor's proposals as a dry run, then the disk report; never deletes.
 * shortPass: with studio/game.json disk.pruneUnderGb set and free disk under it, janitor.mjs pruneWhenShort removes
 *   landed, clean, idle copies, oldest first (off unless that setting is set).
 * laneCopiesSize: measured when shown (a walk capped at 2 s), never a number without its age.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { laneExcludeConfig, laneSparseState, studioMain } from './lane-sparse.mjs';
import { globRe } from './merge-lane.mjs';
import { readJson } from './fsafe.mjs';
import { freeDiskGb, numTrimDefault as num } from './helpers.mjs';

const GB = 1024 ** 3;
const r2 = (x) => Math.round(x * 100) / 100;
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
export const human = (b) => (b >= GB ? `${r2(b / GB)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.round(b / 1024)} KB`);
export const DISK_FILE = (root) => path.join(root, '.studio', 'lanes', 'disk.json');
export const PROPOSALS_FILE = (root) => path.join(root, '.studio', 'lanes', 'proposals.json');
const PASS_FILE = (root) => path.join(root, '.studio', 'lanes', 'pass.json');
function writeJson(f, j) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(`${f}.${process.pid}.tmp`, `${JSON.stringify(j, null, 2)}\n`);
    fs.renameSync(`${f}.${process.pid}.tmp`, f);
  } catch {}
}

/** Bytes under p (links not followed), walking until the clock `until` (ms): { bytes, atLeast } (atLeast: the walk was cut short). */
export function measureTree(p, until = Date.now() + 20000) {
  let bytes = 0; let n = 0; let atLeast = false;
  const stack = [p];
  while (stack.length) {
    if (++n % 500 === 0 && Date.now() > until) { atLeast = true; break; }
    const q = stack.pop();
    let st; try { st = fs.lstatSync(q); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) { bytes += st.size || 0; continue; }
    try { for (const x of fs.readdirSync(q)) stack.push(path.join(q, x)); } catch {}
  }
  return { bytes, atLeast };
}
export const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? `${Math.round(ms / 60000)} min ago` : `${Math.round(ms / 3600000)} h ago`);
/** "133 GB (at least), measured 2 min ago": a size never shows without its age. */
export const sizeWithAge = (bytes, atLeast, at, now = Date.now()) => `${atLeast ? 'at least ' : ''}${human(bytes)}, measured ${ago(Math.max(0, now - at))}`;

/**
 * The lane copies' size now: the last measure when it is under maxAgeMs old (default 5 min), else a new bounded walk
 * (capMs, default 2 s) written to disk.json (write: false for a caller that must write nothing: the machine scan).
 * { bytes, gb, atLeast, at, text }, null with no .lanes folder (engine worktrees are not lane copies).
 */
export function laneCopiesSize({ root = studioMain(), now = Date.now(), maxAgeMs = 300000, capMs = 2000, write = true } = {}) {
  if (!fs.existsSync(path.join(root, '.lanes'))) return null;
  const c = readJson(DISK_FILE(root), {}) || {};
  const at = Date.parse(c.sizedAt || '');
  if (Number.isFinite(c.sizedBytes) && Number.isFinite(at) && now >= at && now - at < maxAgeMs) return { bytes: c.sizedBytes, gb: r2(c.sizedBytes / GB), atLeast: Boolean(c.sizedAtLeast), at, text: sizeWithAge(c.sizedBytes, c.sizedAtLeast, at, now) };
  const m = lanesTotal(root, Date.now() + capMs);
  if (write) writeJson(DISK_FILE(root), { ...c, sizedBytes: m.bytes, sizedAtLeast: m.atLeast, sizedAt: new Date(now).toISOString() });
  return { bytes: m.bytes, gb: r2(m.bytes / GB), atLeast: m.atLeast, at: now, text: sizeWithAge(m.bytes, m.atLeast, now, now) };
}

/** Walk every lane copy (not .lanes/engine) until the clock `until`: { bytes, atLeast }. */
function lanesTotal(root, until) {
  let bytes = 0; let atLeast = false;
  let names = []; try { names = fs.readdirSync(path.join(root, '.lanes'), { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'engine').map((e) => e.name); } catch {}
  for (const n of names) { const m = measureTree(path.join(root, '.lanes', n), until); bytes += m.bytes; atLeast = atLeast || m.atLeast; if (atLeast) break; }
  return { bytes, atLeast };
}

/** The lanes' limit: STUDIO_LANES_MAX_GB, else 25% of the studio's disk (null when the disk can't be read). */
export function lanesMaxGb({ root, env = process.env, statfs = (p) => fs.statfsSync(p) } = {}) {
  const set = num(env.STUDIO_LANES_MAX_GB, null);
  if (set !== null) return set;
  try { const s = statfs(root); return r2(((Number(s.blocks) * Number(s.bsize)) / GB) * 0.25); } catch { return null; }
}

/** Tracked bytes on the main checkout's HEAD: [{ path, bytes }]. */
function trackedSizes(root) {
  const r = git(root, 'ls-tree', '-r', '-l', '-z', 'HEAD');
  if (r.status !== 0) return [];
  return String(r.stdout || '').split('\0').filter(Boolean).map((l) => { const tab = l.indexOf('\t'); const meta = l.slice(0, tab).split(/\s+/); return { path: l.slice(tab + 1), bytes: Number(meta[3]) || 0 }; });
}

/**
 * The report: { at, lanes: [{ name, bytes, sparse, kind }], top, totalBytes, totalGb, maxGb, over, exclude, excludeBytes,
 * saveBytes, savePct, biggest, line }.
 */
export function laneDiskReport({ root = studioMain(), env = process.env, top = 10, now = Date.now(), statfs, capMs = 60000 } = {}) {
  const dir = path.join(root, '.lanes');
  let names = [];
  // 2.86 (f): .lanes/engine holds the engine worktrees (a crew's: 140 GB); walking them every pass is what the estimate in
  // harness/engine-clean.mjs diskUsers avoids, and they are not lane copies.
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== 'engine').map((e) => e.name); } catch {}
  const until = Date.now() + capMs; let atLeast = false;
  const lanes = names.map((n) => {
    const d = path.join(dir, n);
    let sparse = false;
    try { sparse = laneSparseState(d).on; } catch {}
    const m = measureTree(d, until);
    atLeast = atLeast || m.atLeast;
    return { name: n, kind: n.startsWith('_train-') ? 'train scratch' : 'lane', bytes: m.bytes, sparse };
  }).sort((a, b) => b.bytes - a.bytes);
  const totalBytes = lanes.reduce((s, l) => s + l.bytes, 0);
  const cfg = laneExcludeConfig({ root, env });
  const tracked = trackedSizes(root);
  let excludeBytes = 0;
  if (cfg.globs.length) { const res = cfg.globs.map((g) => globRe(g)); excludeBytes = tracked.filter((t) => res.some((re) => re.test(t.path))).reduce((s, t) => s + t.bytes, 0); }
  const full = lanes.filter((l) => l.kind === 'lane' && !l.sparse).length;
  const saveBytes = cfg.globs.length ? Math.min(totalBytes, excludeBytes * full) : 0;
  const folders = {};
  for (const t of tracked) { const parts = t.path.split('/'); const k = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts.length === 2 ? parts[0] : '(root files)'; folders[k] = (folders[k] || 0) + t.bytes; }
  const trackedTotal = tracked.reduce((s, t) => s + t.bytes, 0);
  const biggest = Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, b]) => ({ path: p, bytes: b, pct: trackedTotal ? Math.round((b / trackedTotal) * 100) : 0 }));
  const maxGb = lanesMaxGb({ root, env, ...(statfs ? { statfs } : {}) });
  const totalGb = r2(totalBytes / GB);
  const over = maxGb !== null && maxGb > 0 && totalGb > maxGb;
  const savePct = totalBytes ? Math.round((saveBytes / totalBytes) * 100) : 0;
  const line = `Lane copies: ${lanes.length}, ${atLeast ? 'at least ' : ''}${human(totalBytes)}, measured just now${maxGb !== null ? ` (limit ${maxGb} GB, STUDIO_LANES_MAX_GB)` : ''}${cfg.globs.length ? (saveBytes ? `; laneExclude (${cfg.globs.join(', ')}) would save ${human(saveBytes)} (${savePct}%) in the ${full} lane(s) that still carry it` : `; laneExclude (${cfg.globs.join(', ')}) is in force`) : ''}`;
  return { at: new Date(now).toISOString(), atLeast, lanes, top: lanes.slice(0, Math.max(1, top)), totalBytes, totalGb, maxGb, over, exclude: cfg.globs, excludeBytes, saveBytes, savePct, biggest, line };
}

/** Write the report, and warn (lanes.disk_over, at most every 6 h) when over the limit. */
export function recordLaneDisk({ root = studioMain(), env = process.env, now = Date.now(), emit = emitEvent, statfs } = {}) {
  const r = laneDiskReport({ root, env, now, ...(statfs ? { statfs } : {}) });
  const prev = readJson(DISK_FILE(root), {}) || {};
  let warnedAt = prev.warnedAt || null;
  if (r.over && !(now - (Date.parse(warnedAt || '') || 0) < 6 * 3600000)) {
    try { emit({ type: 'lanes.disk_over', agent: 'supervisor', to: 'producer', status: 'warn', msg: `Lane copies use ${r.totalGb} GB, over ${r.maxGb} GB (STUDIO_LANES_MAX_GB)${r.saveBytes ? `; laneExclude would save ${human(r.saveBytes)}` : r.exclude.length ? '' : '; a laneExclude in the game manifest (docs, media) leaves what code lanes never touch out of new lanes'}. npm run lanes -- disk; npm run janitor -- --lanes`, meta: { totalGb: r.totalGb, maxGb: r.maxGb, lanes: r.lanes.length, saveBytes: r.saveBytes } }); } catch {}
    warnedAt = new Date(now).toISOString();
  }
  writeJson(DISK_FILE(root), { at: r.at, sizedAt: r.at, sizedBytes: r.totalBytes, sizedAtLeast: r.atLeast, totalBytes: r.totalBytes, totalGb: r.totalGb, maxGb: r.maxGb, over: r.over, lanes: r.lanes.length, top: r.top, saveBytes: r.saveBytes, exclude: r.exclude, warnedAt });
  return r;
}

/** Record the janitor's lane proposals (dry run) and emit janitor.lanes_proposed when there are stale ones. */
export async function recordProposals({ root = studioMain(), env = process.env, now = Date.now(), emit = emitEvent, props = null } = {}) {
  const list = props || await (await import('./janitor.mjs')).laneProposals({ root, env, now });
  const stale = list.filter((l) => l.stale).map((l) => ({ agent: l.agent, path: l.path, task: l.task || null, bytes: l.bytes || 0, landed: Boolean(l.landed), why: l.why }));
  const bytes = stale.reduce((s, l) => s + l.bytes, 0);
  const rec = { at: new Date(now).toISOString(), stale, bytes, kept: list.length - stale.length };
  writeJson(PROPOSALS_FILE(root), rec);
  if (stale.length && emit) {
    try { emit({ type: 'janitor.lanes_proposed', agent: 'janitor', to: 'producer', msg: staleLine(rec), meta: { stale: stale.map((l) => l.agent), bytes, dryRun: true } }); } catch {}
  }
  return rec;
}

/** "N stale lane copies (X GB) proposed: npm run janitor -- --lanes --yes --by <name>" ('' when none). */
export function staleLine(rec) {
  const n = rec?.stale?.length || 0;
  if (!n) return '';
  return `${n} stale lane cop${n === 1 ? 'y' : 'ies'} (${human(rec.bytes || 0)}) proposed: npm run janitor -- --lanes --yes --by <name>`;
}
/** The line from the last recorded proposals ('' when none or the record is older than 2 days). */
export function staleLanesLine({ root = studioMain(), now = Date.now() } = {}) {
  const rec = readJson(PROPOSALS_FILE(root));
  if (!rec || now - (Date.parse(rec.at) || 0) > 2 * 86400000) return '';
  return staleLine(rec);
}

/** The whole pass (the detached child runs this): proposals, then the disk report. */
export async function runLanesPass({ root = studioMain(), env = process.env, now = Date.now(), emit = emitEvent } = {}) {
  const proposals = await recordProposals({ root, env, now, emit });
  const disk = recordLaneDisk({ root, env, now, emit });
  return { proposals, disk };
}

/**
 * The supervisor's call, every pass: at most every STUDIO_JANITOR_LANES_MIN (360) minutes (0 or off: never), the lane
 * pass in a detached child (inline: here, awaited; for tests). Never deletes. Returns { ran, detached?, why? }.
 */
export async function lanesPass({ root = studioMain(), env = process.env, now = Date.now(), inline = false, emit = emitEvent } = {}) {
  const raw = String(env.STUDIO_JANITOR_LANES_MIN || '').trim();
  if (/^(off|no|false)$/i.test(raw)) return { ran: false, why: 'STUDIO_JANITOR_LANES_MIN=off' };
  const min = num(raw, 360);
  if (!(min > 0)) return { ran: false, why: 'STUDIO_JANITOR_LANES_MIN=0' };
  const last = Date.parse(readJson(PASS_FILE(root), {})?.at || '') || 0;
  if (now - last < min * 60000 && now >= last) return { ran: false, why: 'ran recently' };
  if (!fs.existsSync(path.join(root, '.lanes'))) { writeJson(PASS_FILE(root), { at: new Date(now).toISOString() }); return { ran: false, why: 'no lane copies' }; }
  writeJson(PASS_FILE(root), { at: new Date(now).toISOString() });
  if (inline) return { ran: true, ...(await runLanesPass({ root, env, now, emit })) };
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'pass'], { cwd: root, env: { ...env, STUDIO_MAIN_ROOT: root }, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ran: true, detached: true };
  } catch (err) { return { ran: false, why: err.message }; }
}

/**
 * The supervisor's call, every pass: when studio/game.json disk.pruneUnderGb is set and free disk is under it, at most
 * every 10 minutes, the janitor's short-disk prune (janitor.mjs pruneWhenShort) in a detached child (inline: awaited, for
 * tests; freeGb: injected reading). { ran, why? }.
 */
export async function shortPass({ root = studioMain(), env = process.env, now = Date.now(), inline = false, freeGb = null, emit = emitEvent } = {}) {
  const jn = await import('./janitor.mjs');
  const cfg = jn.diskPruneConfig(root);
  if (!cfg) return { ran: false, why: 'disk.pruneUnderGb is not set' };
  const free = freeGb ? freeGb() : freeDiskGb(root);
  if (!Number.isFinite(free) || free >= cfg.underGb) return { ran: false, why: 'free disk is over the line' };
  const f = path.join(root, '.studio', 'lanes', 'short-pass.json');
  const last = Date.parse(readJson(f, {})?.at || '') || 0;
  if (now - last < 600000 && now >= last) return { ran: false, why: 'ran recently' };
  writeJson(f, { at: new Date(now).toISOString() });
  if (inline) return { ran: true, ...(await jn.pruneWhenShort({ root, env, now, freeGb: freeGb || undefined, emit })) };
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'short'], { cwd: root, env: { ...env, STUDIO_MAIN_ROOT: root }, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ran: true, detached: true };
  } catch (err) { return { ran: false, why: err.message }; }
}

export function diskText(r) {
  const L = [r.line];
  for (const l of r.top) L.push(`  ${human(l.bytes).padStart(9)}  .lanes/${l.name}${l.kind !== 'lane' ? ` (${l.kind})` : ''}${l.sparse ? ' (sparse)' : ''}`);
  if (r.lanes.length > r.top.length) L.push(`  … ${r.lanes.length - r.top.length} more`);
  if (!r.exclude.length && r.biggest.length) L.push(`No laneExclude declared. Biggest tracked folders: ${r.biggest.map((b) => `${b.path} ${human(b.bytes)} (${b.pct}%)`).join(', ')}. A "laneExclude" list in the game manifest leaves paths code lanes never touch out of new lanes (docs/CONDUCTOR.md).`);
  if (r.over) L.push(`Over the limit (${r.maxGb} GB): npm run janitor -- --lanes lists stale lane copies.`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'pass') {
    try { await runLanesPass({}); } catch {}
    process.exit(0);
  }
  if (argv[0] === 'short') {
    try { await (await import('./janitor.mjs')).pruneWhenShort({}); } catch {}
    process.exit(0);
  }
  console.log('Usage: npm run lanes -- disk [--top N] [--json]   (node harness/lane-disk.mjs pass: the supervisor\'s lane pass)');
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}
void REPO_ROOT;
