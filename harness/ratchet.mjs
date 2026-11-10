/**
 * harness/ratchet.mjs — 2.72.0 (b): the purity ratchet. Standing hits are recorded once; only new ones fail.
 *
 * Turning the sim purity check on for a real game gave 611 reds on day one, so it stayed off; an outside replay that
 * only hid the old hits saw the standing count grow from 143 to 543, because nothing blocked new ones. The ratchet:
 *
 *   - A committed baseline per game, `<game>/purity-baseline.json` (a cartridge's: cartridges/<name>/purity-baseline.json),
 *     records the standing hits of the sim purity check ("purity": scripts/check-sim-purity.mjs, its static rules and
 *     required deterministic math) and of any game check that declares "ratchet": true in its studio.gates.json (the
 *     section is the check's id, e.g. "game:lint"). A hit's key is its file, its rule and its source line with the
 *     spaces normalised, never the line number, so a hit that only moves keeps its key. Same key twice: a count.
 *   - A check run sees only the hits the baseline doesn't cover (the hits a lane's diff added): ANY new hit fails, and
 *     only the new ones are printed. Standing hits are counted in one line.
 *   - The baseline never grows from a lane: in a lane copy a key counts as standing only up to its count in the
 *     baseline as the studio's branch has it (the merge base), and the merge train holds a lane whose baseline grew as
 *     tier C (harness/tiers.mjs "ratchet-grow"). A person grows it on the studio's branch:
 *       npm run purity -- baseline --write --by <person>      (an agent: --permission "<their words>", or a delegation
 *                                                              for "purity-baseline"; a worker never)
 *   - A fixed hit shrinks it: task done rewrites the baseline smaller and commits that in the task's own copy
 *     (shrinkAtDone), and `npm run purity -- baseline --shrink` does it by hand. Shrinking needs nobody.
 *   - No baseline file: today's behaviour (every hit fails; a ratchet check's own exit code decides).
 *
 * A hit is a line of the check's output in one of these shapes (file paths relative to the repo root):
 *   <file>:<line>[:<col>] [<RULE>] <message>              (the purity check's own lines, prefixed "x " or "! ")
 *   <file>:<line>:<col>: <message> [<rule>]                (ESLint's unix formatter and similar)
 *
 *   npm run purity [-- list [--json]]                      the standing, new and fixed hits per baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, emitEvent } from './event.mjs';
import { readJson } from './fsafe.mjs';

export const BASELINE_NAME = 'purity-baseline.json';
export const PURITY_SECTION = 'purity';
export const isBaselinePath = (p) => new RegExp(`(^|/)${BASELINE_NAME.replace(/\./g, '\\.')}$`).test(String(p || '').replace(/\\/g, '/'));
const slash = (p) => String(p || '').replace(/\\/g, '/');
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });

const OWN = /^\s*(?:[x!*-]\s+)?((?:[A-Za-z]:)?[^\s:[\]]+?\.[A-Za-z0-9]+):(\d+)(?::\d+)?:?\s+\[([^\]\s]+)\]\s*(.*)$/;
const UNIX = /^\s*((?:[A-Za-z]:)?[^\s:[\]]+?\.[A-Za-z0-9]+):(\d+):\d+:\s+(.*?)\s+\[([^\]\s]+)\]\s*$/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A source line as the key holds it: spaces collapsed, trimmed, at most 240 characters. */
export const normSnippet = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 240);
export const hitKey = (h) => `${h.file}|${h.rule}|${h.snippet}`;

/** The file as the key holds it: relative to the root, forward slashes. */
function relFile(file, root) {
  const f = slash(file);
  if (/^([A-Za-z]:)?\//.test(f)) { const r = slash(path.relative(root, file)); return r.startsWith('..') ? f : r; }
  return f.replace(/^\.\//, '');
}

/** The hits in a check's output: [{ file, line, rule, message, snippet, key, text }], in output order. */
export function parseHits(text, { root = REPO_ROOT } = {}) {
  const cache = new Map();
  const lineOf = (file, n) => {
    if (!cache.has(file)) { try { cache.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n')); } catch { cache.set(file, null); } }
    const lines = cache.get(file);
    return lines && lines[n - 1] !== undefined ? lines[n - 1] : null;
  };
  const out = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const l = raw.replace(ANSI, '');
    let m = l.match(OWN);
    let h = null;
    if (m) h = { file: relFile(m[1], root), line: Number(m[2]), rule: m[3], message: m[4].trim() };
    else if ((m = l.match(UNIX))) h = { file: relFile(m[1], root), line: Number(m[2]), rule: m[4], message: m[3].trim() };
    if (!h) continue;
    const src = lineOf(h.file, h.line);
    h.snippet = normSnippet(src === null ? h.message : src);
    h.key = hitKey(h);
    h.text = l.trim().replace(/^[x!*-]\s+/, '');
    out.push(h);
  }
  return out;
}

/** Hits counted by key: Map key -> { file, rule, snippet, count }. */
export function countHits(hits) {
  const m = new Map();
  for (const h of hits) {
    const e = m.get(h.key) || { file: h.file, rule: h.rule, snippet: h.snippet, count: 0 };
    e.count += 1;
    m.set(h.key, e);
  }
  return m;
}

/** A baseline document's section as Map key -> entry (count >= 1). */
export function sectionMap(doc, section) {
  const m = new Map();
  for (const e of Array.isArray(doc?.hits?.[section]) ? doc.hits[section] : []) {
    if (!e || !e.file || !e.rule) continue;
    const entry = { file: slash(e.file), rule: String(e.rule), snippet: normSnippet(e.snippet), count: Math.max(1, Math.floor(Number(e.count) || 1)) };
    const k = hitKey(entry);
    const had = m.get(k);
    m.set(k, had ? { ...had, count: had.count + entry.count } : entry);
  }
  return m;
}
const sortEntries = (m) => [...m.values()].sort((a, b) => (a.file + a.rule + a.snippet).localeCompare(b.file + b.rule + b.snippet));

/** Write a baseline document (stable order, one entry per line group), keeping its other sections. */
export function writeBaseline(root, rel, sections, meta = {}) {
  const file = path.join(root, rel);
  const doc = readJson(file) || {};
  const hits = { ...(doc.hits || {}) };
  for (const [sec, m] of Object.entries(sections)) {
    if (m.size) hits[sec] = sortEntries(m);
    else delete hits[sec];
  }
  const out = {
    about: 'The standing hits of this game\'s purity and ratchet checks (harness/ratchet.mjs). Only hits not listed here fail. It shrinks on its own when hits are fixed; only a person grows it: npm run purity -- baseline --write --by <person>.',
    version: 1,
    ...(meta.by ? { by: meta.by } : doc.by ? { by: doc.by } : {}),
    ...(meta.at ? { at: meta.at } : doc.at ? { at: doc.at } : {}),
    ...(meta.permission ? { permission: meta.permission } : {}),
    hits: Object.fromEntries(Object.entries(hits).sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

/** The baseline a purity hit belongs to: cartridges/<name>/, else the studio game's folder; null outside both. */
export function baselineRelFor(file, { gameRoot = null } = {}) {
  const f = slash(file);
  const c = f.match(/^cartridges\/([^/]+)\//);
  if (c) return `cartridges/${c[1]}/${BASELINE_NAME}`;
  const g = slash(gameRoot || '').replace(/\/+$/, '');
  if (g && f.startsWith(`${g}/`)) return `${g}/${BASELINE_NAME}`;
  const w = f.match(/^(game|web)\/([^/]+)\//);
  if (w) return `${w[1]}/${w[2]}/${BASELINE_NAME}`;
  return null;
}

/**
 * The merge base with the studio's branch when this checkout is a lane copy (worktree.mjs laneDiff), else null.
 * In a lane a baseline counts only as far as the studio's branch has it.
 */
export async function laneBase() {
  try {
    const wt = await import('./worktree.mjs');
    if (!wt.inLaneCopy()) return null;
    return wt.laneDiff()?.base || null;
  } catch { return null; }
}

/** A baseline as it is at a commit (null: no such file there). */
export function baselineAt(root, rev, rel) {
  const r = git(root, 'show', `${rev}:${rel}`);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/**
 * The baseline that counts for one file and section: Map key -> entry, or null (no baseline file: today's behaviour).
 * With `base` (a lane), each count is capped at the base's (a key the base doesn't have counts 0), and `grown` names
 * the keys the lane's file has beyond it.
 */
export function effectiveBaseline(root, rel, section, { base = null } = {}) {
  const doc = readJson(path.join(root, rel));
  if (!doc) return null;
  const work = sectionMap(doc, section);
  if (!base) return { map: work, grown: [] };
  const atBase = baselineAt(root, base, rel);
  const bm = sectionMap(atBase, section);
  const map = new Map();
  const grown = [];
  for (const [k, e] of work) {
    const b = bm.get(k)?.count || 0;
    if (e.count > b) grown.push(k);
    if (Math.min(e.count, b) > 0) map.set(k, { ...e, count: Math.min(e.count, b) });
  }
  return { map, grown };
}

/**
 * Judge hits against their baselines. `relOf(hit)` names a hit's baseline (null: none). Returns { fresh: [hits],
 * standing, fixed: [{ rel, key, from, to }], grown: [{ rel, key }], ratcheted: [rels], counts: { rel: Map } }.
 * A hit whose baseline file doesn't exist is fresh (today's behaviour).
 */
export function judgeHits(hits, { root = REPO_ROOT, section = PURITY_SECTION, relOf, base = null } = {}) {
  const groups = new Map();
  for (const h of hits) {
    const rel = relOf(h);
    if (!groups.has(rel)) groups.set(rel, []);
    groups.get(rel).push(h);
  }
  // Baselines with no current hit at all still count, so their fixed hits show.
  for (const rel of knownBaselines(root, section)) if (!groups.has(rel)) groups.set(rel, []);
  const fresh = [];
  const fixed = [];
  const grown = [];
  const ratcheted = [];
  const counts = {};
  let standing = 0;
  for (const [rel, list] of groups) {
    const eff = rel ? effectiveBaseline(root, rel, section, { base }) : null;
    if (!eff) { fresh.push(...list); continue; }
    ratcheted.push(rel);
    for (const k of eff.grown) grown.push({ rel, key: k });
    const cur = countHits(list);
    counts[rel] = cur;
    const seen = new Map();
    for (const h of list) {
      const n = (seen.get(h.key) || 0) + 1;
      seen.set(h.key, n);
      if (n > (eff.map.get(h.key)?.count || 0)) fresh.push(h);
      else standing += 1;
    }
    const own = sectionMap(readJson(path.join(root, rel)), section);
    for (const [k, e] of own) {
      const now = cur.get(k)?.count || 0;
      if (now < e.count) fixed.push({ rel, key: k, from: e.count, to: now });
    }
  }
  return { fresh, standing, fixed, grown, ratcheted, counts };
}

/** Baseline files in this checkout that have a section (cartridges and game/web folders, one level deep). */
export function knownBaselines(root = REPO_ROOT, section = null) {
  const out = [];
  for (const top of ['cartridges', 'game', 'web']) {
    let dirs = [];
    try { dirs = fs.readdirSync(path.join(root, top), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
    for (const d of dirs) {
      const rel = `${top}/${d.name}/${BASELINE_NAME}`;
      const doc = readJson(path.join(root, rel));
      if (doc && (!section || Array.isArray(doc.hits?.[section]))) out.push(rel);
    }
  }
  return out;
}

/** The lines a check prints for a judged run (only the new hits, then one line for the rest). */
export function ratchetLines(j, { label = '[ratchet]', list = true } = {}) {
  const L = [];
  if (j.fresh.length) {
    L.push(`${label} NEW ${j.fresh.length} hit(s) the baseline doesn't list (only these fail; ${j.standing} standing hit(s) in ${j.ratcheted.join(', ') || 'no baseline'} are not shown)${list ? ':' : ''}`);
    if (list) for (const h of j.fresh.slice(0, 200)) L.push(`  x ${h.text}`);
    if (list && j.fresh.length > 200) L.push(`  … and ${j.fresh.length - 200} more`);
  } else if (j.ratcheted.length) L.push(`${label} no new hit; ${j.standing} standing hit(s) in ${j.ratcheted.join(', ')} (npm run purity -- list shows them)`);
  if (j.grown.length) L.push(`${label} note: this lane's baseline lists ${j.grown.length} hit(s) the studio's branch doesn't; they don't count here (a baseline never grows from a lane: a person runs npm run purity -- baseline --write --by <person> on the studio's branch)`);
  if (j.fixed.length) L.push(`${label} ${j.fixed.reduce((n, f) => n + f.from - f.to, 0)} standing hit(s) fixed: task done shrinks the baseline (npm run purity -- baseline --shrink does it now)`);
  return L;
}

/** The purity check's hits from scripts/check-sim-purity.mjs --hits-json (static rules and required det math), or null. */
export function purityHits(root = REPO_ROOT, env = process.env) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-sim-purity.mjs'), '--hits-json'], { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()).lines.map(String); } catch { return null; }
}

/** The studio game's checks that declare "ratchet": true ({ id, command, ... }), with the game's root. */
export async function ratchetChecks() {
  try {
    const gg = await import('./game-gates.mjs');
    const game = await gg.studioGame();
    return { root: game?.root || null, gates: game?.root ? gg.declaredGates(game).filter((g) => g.ratchet) : [] };
  } catch { return { root: null, gates: [] }; }
}

// ---- a game check with "ratchet": true (harness/game-gates.mjs) -------------------------------------------------

const RECORD_DIR = () => path.join(STUDIO_STATE_DIR, 'ratchet');
const cleanTree = (root) => {
  const st = git(root, 'status', '--porcelain', '--untracked-files=no');
  if (st.status !== 0 || String(st.stdout || '').trim()) return null;
  return (git(root, 'rev-parse', 'HEAD^{tree}').stdout || '').trim() || null;
};

/**
 * Judge one ratchet check's run: r = spawnSync's result. Returns null when the game has no baseline for it (today's
 * behaviour), else { status, why, lines, judged }. A run that exits non-zero with no hit line the ratchet can read is
 * still red (a crash isn't a standing hit). The run's counts are kept by tree for task done's shrink.
 */
export function judgeCheck(gate, r, { root = REPO_ROOT, gameRoot, base = null } = {}) {
  if (!gameRoot) return null;
  const rel = `${slash(gameRoot).replace(/\/+$/, '')}/${BASELINE_NAME}`;
  const doc = readJson(path.join(root, rel));
  if (!doc || !Array.isArray(doc.hits?.[gate.id])) return null;
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  const hits = parseHits(text, { root });
  if (r.status !== 0 && !hits.length) return { status: r.status ?? 1, why: `exit ${r.status ?? r.signal ?? '?'} with no hit line the ratchet can read (a crash or a failure that isn't a hit; ${rel} doesn't cover it)`, lines: [], judged: null };
  const j = judgeHits(hits, { root, section: gate.id, relOf: () => rel, base });
  try {
    const tree = cleanTree(root);
    if (tree) {
      fs.mkdirSync(RECORD_DIR(), { recursive: true });
      const f = path.join(RECORD_DIR(), `${tree}.json`);
      const prev = readJson(f) || { tree, sections: {} };
      prev.sections[`${rel}#${gate.id}`] = Object.fromEntries([...(j.counts[rel] || new Map())].map(([k, e]) => [k, e.count]));
      prev.at = new Date().toISOString();
      fs.writeFileSync(f, JSON.stringify(prev));
    }
  } catch { /* a help for the shrink, never a failure */ }
  const lines = ratchetLines(j, { label: `[ratchet] ${gate.id}:` });
  return { status: j.fresh.length ? 1 : 0, why: j.fresh.length ? `${j.fresh.length} new hit(s) the baseline doesn't list: ${j.fresh.slice(0, 3).map((h) => h.text).join(' | ').slice(0, 300)}` : '', lines, judged: j };
}

// ---- shrinking --------------------------------------------------------------------------------------------------

/**
 * The smaller baselines for this checkout as it is now: [{ rel, sections: { section: Map }, removed }]. The purity
 * section from a fresh scan; a ratchet check's section only from a run recorded on this exact (clean) tree.
 */
export function shrinkPlan(root = REPO_ROOT, { env = process.env } = {}) {
  const plan = [];
  const lines = knownBaselines(root, PURITY_SECTION).length ? purityHits(root, env) : [];
  const pur = lines ? countByRel(parseHits(lines.join('\n'), { root }), (h) => baselineRelFor(h.file)) : null;
  const tree = cleanTree(root);
  const rec = tree ? readJson(path.join(RECORD_DIR(), `${tree}.json`)) : null;
  for (const rel of knownBaselines(root)) {
    const doc = readJson(path.join(root, rel));
    const sections = {};
    let removed = 0;
    for (const sec of Object.keys(doc?.hits || {})) {
      let cur = null;
      if (sec === PURITY_SECTION) cur = pur ? pur.get(rel) || new Map() : null;
      else if (rec?.sections?.[`${rel}#${sec}`]) cur = new Map(Object.entries(rec.sections[`${rel}#${sec}`]).map(([k, n]) => [k, { count: n }]));
      if (!cur) continue;
      const own = sectionMap(doc, sec);
      const next = new Map();
      for (const [k, e] of own) {
        const n = Math.min(e.count, cur.get(k)?.count || 0);
        removed += e.count - n;
        if (n > 0) next.set(k, { ...e, count: n });
      }
      if (next.size !== own.size || [...own].some(([k, e]) => next.get(k)?.count !== e.count)) sections[sec] = next;
    }
    if (removed) plan.push({ rel, sections, removed });
  }
  return plan;
}

function countByRel(hits, relOf) {
  const out = new Map();
  for (const h of hits) {
    const rel = relOf(h);
    if (!rel) continue;
    if (!out.has(rel)) out.set(rel, []);
    out.get(rel).push(h);
  }
  return new Map([...out].map(([rel, list]) => [rel, countHits(list)]));
}

/** Rewrite the baselines smaller (never larger) and, unless commit is false, commit only those files. */
export function shrinkBaselines({ root = REPO_ROOT, commit = true, task = null, agent = null, env = process.env } = {}) {
  const plan = shrinkPlan(root, { env });
  if (!plan.length) return { shrunk: [], removed: 0 };
  for (const p of plan) writeBaseline(root, p.rel, p.sections);
  const files = plan.map((p) => p.rel);
  const removed = plan.reduce((n, p) => n + p.removed, 0);
  let sha = null;
  if (commit) {
    git(root, 'add', '--', ...files);
    const c = git(root, 'commit', '-q', '--only', '-m', `${task ? `${task}: ` : ''}purity baseline smaller (${removed} fixed hit(s))`, '-m', 'The ratchet (harness/ratchet.mjs): fixed hits leave the baseline, so they can\'t come back as standing ones.', '--', ...files);
    if (c.status === 0) sha = (git(root, 'rev-parse', 'HEAD').stdout || '').trim().slice(0, 8);
    else {
      // Not committed (a hook refused it): put the files back, so the shrink never leaves the checkout dirty.
      git(root, 'reset', '-q', '--', ...files);
      git(root, 'checkout', '--', ...files);
      return { shrunk: [], removed: 0, error: `${c.stderr || c.stdout}`.trim().slice(0, 300) };
    }
  }
  try { emitEvent({ type: 'purity.baseline_shrunk', agent: agent || 'ratchet', task: task || undefined, msg: `purity baseline smaller by ${removed} fixed hit(s): ${files.join(', ')}${sha ? ` (commit ${sha})` : ''}`.slice(0, 400), meta: { files, removed, commit: sha } }); } catch {}
  return { shrunk: files, removed, commit: sha };
}

/** task done's step (harness/task.mjs): shrink and commit in the task's copy. Never throws, never refuses. */
export function shrinkAtDone({ root = REPO_ROOT, task = null, agent = null } = {}) {
  try {
    if (!knownBaselines(root).length) return null;
    const r = shrinkBaselines({ root, task, agent });
    if (r.shrunk.length) console.log(`[task done] purity baseline: ${r.removed} fixed hit(s) removed from ${r.shrunk.join(', ')}${r.commit ? ` (commit ${r.commit})` : ''}`);
    else if (r.error) console.warn(`[task done] note: the purity baseline wasn't shrunk (its commit was refused: ${r.error}); npm run purity -- baseline --shrink does it later`);
    return r;
  } catch (err) {
    console.warn(`[task done] note: the purity baseline couldn't be shrunk (${String(err.message || err).slice(0, 200)})`);
    return null;
  }
}

// ---- growth (the merge train's tier C) ---------------------------------------------------------------------------

/** Did a baseline grow from base to head (any key's count up, or a new file)? */
export function baselineGrew(root, base, head, rel) {
  const before = baselineAt(root, base, rel);
  const after = baselineAt(root, head, rel);
  if (!after) return false;
  for (const sec of Object.keys(after.hits || {})) {
    const b = sectionMap(before, sec);
    for (const [k, e] of sectionMap(after, sec)) if (e.count > (b.get(k)?.count || 0)) return true;
  }
  return false;
}

/** The train's lane files with ratchetGrew set on a baseline that grew (harness/train.mjs laneTier). */
export function markGrowth(root, base, head, files = []) {
  return files.map((f) => (isBaselinePath(f.path) && !String(f.status || '').startsWith('D') && baselineGrew(root, base, head, f.path) ? { ...f, ratchetGrew: true } : f));
}
