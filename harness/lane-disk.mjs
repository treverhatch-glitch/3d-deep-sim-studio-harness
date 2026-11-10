#!/usr/bin/env node
/**
 * harness/lane-disk.mjs — 2.70.0 (w): the lane disk report, and stale-lane proposals someone actually sees.
 *
 *   npm run lanes -- disk [--top N] [--json]
 *       Each lane copy's size on disk (.lanes/<x>, train scratch copies included; links such as node_modules, studio/
 *       and .studio/ count as themselves), the top N (10), the total, and the share the lane exclusions would save
 *       (harness/lane-sparse.mjs: the tracked bytes under the laneExclude globs, for each lane that still has them; with
 *       no laneExclude declared, the biggest tracked folders, to choose globs from). Kept in .studio/lanes/disk.json;
 *       the machine scan's disk line names the lanes' total from it. Over STUDIO_LANES_MAX_GB (default 25% of the
 *       disk) a lanes.disk_over warning (at most every 6 h).
 *
 *   The supervisor's lane pass (lanesPass), at most every STUDIO_JANITOR_LANES_MIN (360) minutes, in a detached child
 *   (`node harness/lane-disk.mjs pass`): the janitor's lane proposals as a dry run (harness/janitor.mjs laneProposals;
 *   it never deletes) into .studio/lanes/proposals.json and one janitor.lanes_proposed event, then the disk report.
 *   The daily digest, `status --brief` and the War Room snapshot show "N stale lane copies (X GB) proposed: npm run
 *   janitor -- --lanes --yes --by <name>". Deleting stays a decider's action (a person, or an agent under the owner's
 *   delegation for janitor-lanes, or on a person's direct permission).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { laneExcludeConfig, laneSparseState, studioMain } from './lane-sparse.mjs';
import { globRe } from './merge-lane.mjs';
import { readJson } from './fsafe.mjs';

const GB = 1024 ** 3;
const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
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

/** Bytes under p, not following links. */
export function sizeOf(p, maxEntries = 2000000) {
  let n = 0; let seen = 0;
  const walk = (q) => {
    if (seen++ > maxEntries) return;
    let st; try { st = fs.lstatSync(q); } catch { return; }
    if (st.isSymbolicLink() || !st.isDirectory()) { n += st.size || 0; return; }
    let names = []; try { names = fs.readdirSync(q); } catch { return; }
    for (const x of names) walk(path.join(q, x));
  };
  walk(p);
  return n;
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
export function laneDiskReport({ root = studioMain(), env = process.env, top = 10, now = Date.now(), statfs } = {}) {
  const dir = path.join(root, '.lanes');
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch {}
  const lanes = names.map((n) => {
    const d = path.join(dir, n);
    let sparse = false;
    try { sparse = laneSparseState(d).on; } catch {}
    return { name: n, kind: n.startsWith('_train-') ? 'train scratch' : 'lane', bytes: sizeOf(d), sparse };
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
  const line = `Lane copies: ${lanes.length}, ${human(totalBytes)}${maxGb !== null ? ` (limit ${maxGb} GB, STUDIO_LANES_MAX_GB)` : ''}${cfg.globs.length ? (saveBytes ? `; laneExclude (${cfg.globs.join(', ')}) would save ${human(saveBytes)} (${savePct}%) in the ${full} lane(s) that still carry it` : `; laneExclude (${cfg.globs.join(', ')}) is in force`) : ''}`;
  return { at: new Date(now).toISOString(), lanes, top: lanes.slice(0, Math.max(1, top)), totalBytes, totalGb, maxGb, over, exclude: cfg.globs, excludeBytes, saveBytes, savePct, biggest, line };
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
  writeJson(DISK_FILE(root), { at: r.at, totalBytes: r.totalBytes, totalGb: r.totalGb, maxGb: r.maxGb, over: r.over, lanes: r.lanes.length, top: r.top, saveBytes: r.saveBytes, exclude: r.exclude, warnedAt });
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
/** For the War Room snapshot: { stale, bytes, at, line } or null. */
export function staleLanesCard(root = studioMain()) {
  const rec = readJson(PROPOSALS_FILE(root));
  if (!rec) return null;
  return { at: rec.at, stale: (rec.stale || []).length, bytes: rec.bytes || 0, lanes: (rec.stale || []).map((l) => l.agent), line: staleLine(rec), disk: readJson(DISK_FILE(root)) };
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
  console.log('Usage: npm run lanes -- disk [--top N] [--json]   (node harness/lane-disk.mjs pass: the supervisor\'s lane pass)');
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}
void REPO_ROOT;
