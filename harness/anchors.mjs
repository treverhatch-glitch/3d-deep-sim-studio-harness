#!/usr/bin/env node
/**
 * harness/anchors.mjs — 2.81 (b2): the per-game anchor spec: reference games and the concrete features, behaviours,
 * numbers and screens the studio cross-checks its own design against for direction, with where that evidence comes
 * from and how a task proves it (docs/ANCHORS.md). An anchor records what an outside game DOES as a yardstick; it never
 * holds that game's code, art, text or names for use in ours.
 *
 * Game-agnostic: the harness never names a game; the owner (or the Director with the owner's references) fills
 * studio/references/anchors.json for THEIR game. One anchor:
 *
 *   { "id": "A1", "game": "<reference game>", "feature": "<what to match>",
 *     "behaviours": ["<what the player sees or can do>"], "numbers": { "<name>": "<value seen in the reference>" },
 *     "screens": ["<screen or flow>"],
 *     "evidence": { "kind": "video|screenshot|manual|wiki|owner|none", "path": "<file or url>", "provenance": "<who/when>",
 *                   "status": "verified|unknown|needs-reference" },
 *     "acceptance": ["<a checkable line the deliverable must show>"] }
 *
 * A task cites anchors (`task add … --anchors A1,A2`); the brief prints their acceptance lines under "Done means";
 * `task done` records, per anchor, met | unmet | unknown from the DELIVERABLE (files committed for the task, regression
 * records, test names, proof records that name the anchor id), never from the builder's note. An anchor whose evidence
 * is `unknown` or `needs-reference` is reported as unknown: it is never green, and it is never a refusal by itself
 * (STUDIO_ANCHORS=fail makes an unmet anchor with verified evidence a failing done check).
 *
 *   node harness/anchors.mjs list | show A1 | check <T-ID> | add --game "…" --feature "…" [--behaviour "…"]… [--acceptance "…"]… [--evidence <path|url> --kind video --provenance "…" --status verified|unknown|needs-reference]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, readRecentEvents, emitEvent } from './event.mjs';

export const ANCHORS_FILE = path.join(REPO_ROOT, 'studio', 'references', 'anchors.json');
export const EVIDENCE_STATUS = ['verified', 'unknown', 'needs-reference'];
export const EVIDENCE_KINDS = ['video', 'screenshot', 'manual', 'wiki', 'owner', 'none'];
const ID_RE = /^A\d+(?:\.F\d+)?$/;

export function readAnchors(file = ANCHORS_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j?.anchors) ? j.anchors : [];
  } catch {
    return [];
  }
}
function writeAnchors(list, file = ANCHORS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ anchors: list }, null, 2)}\n`);
}

/** Schema check of one anchor; returns the problems (none = valid). */
export function anchorProblems(a) {
  const p = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  if (!ID_RE.test(String(a.id || ''))) p.push(`id "${a.id}" is not A<n> or A<n>.F<n>`);
  if (!String(a.game || '').trim()) p.push(`${a.id}: no game`);
  if (!String(a.feature || '').trim()) p.push(`${a.id}: no feature`);
  if (!Array.isArray(a.acceptance) || !a.acceptance.some((x) => String(x || '').trim())) p.push(`${a.id}: no acceptance line`);
  const ev = a.evidence || {};
  if (!EVIDENCE_STATUS.includes(ev.status)) p.push(`${a.id}: evidence.status must be one of ${EVIDENCE_STATUS.join('|')}`);
  if (ev.kind && !EVIDENCE_KINDS.includes(ev.kind)) p.push(`${a.id}: evidence.kind "${ev.kind}" is not one of ${EVIDENCE_KINDS.join('|')}`);
  if (ev.status === 'verified' && !String(ev.path || '').trim()) p.push(`${a.id}: verified evidence needs a path or url`);
  if (ev.status === 'verified' && !String(ev.provenance || '').trim()) p.push(`${a.id}: verified evidence needs its provenance (who saw it, when)`);
  for (const k of ['behaviours', 'screens']) if (a[k] !== undefined && !Array.isArray(a[k])) p.push(`${a.id}: ${k} must be a list`);
  if (a.numbers !== undefined && (typeof a.numbers !== 'object' || Array.isArray(a.numbers))) p.push(`${a.id}: numbers must be an object`);
  return p;
}

/** Validate a comma list of cited ids against the library: { ok, ids, unknown, problems }. */
export function validateAnchorIds(list, anchors = readAnchors()) {
  const ids = (Array.isArray(list) ? list : String(list || '').split(/[,\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const known = new Map(anchors.map((a) => [a.id, a]));
  const unknown = ids.filter((id) => !known.has(id));
  const problems = ids.filter((id) => known.has(id)).flatMap((id) => anchorProblems(known.get(id)));
  return { ok: !unknown.length && !problems.length, ids: [...new Set(ids)], unknown, problems };
}

/** The anchors a task cites (task add --anchors, in the task.added event's meta). */
export function taskAnchorIds(taskId, events = null) {
  const ev = events || readRecentEvents(20000);
  const added = ev.find((e) => e.type === 'task.added' && e.task === taskId);
  const ids = added?.meta?.anchors;
  return Array.isArray(ids) ? ids.map(String) : typeof ids === 'string' ? ids.split(/[,\s]+/).filter(Boolean) : [];
}

/** Brief lines for the cited anchors: what the reference does and what the deliverable must show. */
export function anchorBriefLines(ids, anchors = readAnchors()) {
  const L = [];
  for (const id of ids) {
    const a = anchors.find((x) => x.id === id);
    if (!a) { L.push(`- ${id}: not in studio/references/anchors.json (ask the Producer to add it, or drop the citation)`); continue; }
    const st = a.evidence?.status || 'unknown';
    L.push(`- ${a.id} ${a.game}: ${a.feature} (evidence ${st}${st === 'verified' ? `: ${a.evidence.path}` : st === 'needs-reference' ? ': nobody has checked the reference yet, say what you assumed' : ''})`);
    for (const b of a.behaviours || []) L.push(`  - behaviour: ${b}`);
    for (const [k, v] of Object.entries(a.numbers || {})) L.push(`  - number: ${k} = ${v}`);
    for (const s of a.screens || []) L.push(`  - screen: ${s}`);
    for (const c of a.acceptance || []) L.push(`  - accept when: ${c}`);
    L.push(`  - prove it: name ${a.id} in a test name, a regression record (qa/regressions/), a proof record or a committed file for this task; the brief's prose is not proof.`);
  }
  return L;
}

const git = (args, cwd = REPO_ROOT) => {
  const r = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
};

/**
 * What the deliverable says about each anchor. Proof = something the harness can read, not the builder's note:
 *   - a committed file for this task (git log --name-only with Studio-Task: <id>, plus the lane's uncommitted edits)
 *     whose content or name carries the anchor id;
 *   - a regression record (qa/regressions/*.json) or a proof record (.studio/proof/<task>*.json) naming it;
 *   - a task-start-or-later test file naming it.
 * Verdicts: met (verified evidence + proof), unmet (verified evidence, no proof), unknown (evidence unknown or needs a
 * reference: the proof may exist but nobody checked the reference, so it is never green).
 */
export function judgeAnchors(taskId, { ids = null, anchors = readAnchors(), cwd = REPO_ROOT, since = 0 } = {}) {
  const cited = ids || taskAnchorIds(taskId);
  if (!cited.length) return { ids: [], rows: [], summary: {} };
  const files = new Set();
  const log = git(['log', '--format=%H', `--grep=Studio-Task: ${taskId}`, '-n', '50'], cwd).split('\n').filter(Boolean);
  for (const sha of log) for (const f of git(['show', '--name-only', '--format=', sha], cwd).split('\n')) if (f.trim()) files.add(f.trim());
  for (const l of git(['status', '--porcelain'], cwd).split('\n')) if (l.length > 3) files.add(l.slice(3).trim());
  const text = (rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const under = (rel, re) => { try { return fs.readdirSync(path.join(cwd, rel)).filter((f) => re.test(f)).map((f) => `${rel}/${f}`); } catch { return []; } };
  const records = [...under('qa/regressions', /\.json$/), ...under('.studio/proof', /\.json$/)].filter((f) => { try { return fs.statSync(path.join(cwd, f)).mtimeMs >= since; } catch { return false; } });
  const rows = [];
  for (const id of cited) {
    const a = anchors.find((x) => x.id === id);
    const idRe = new RegExp(`(^|[^\\w.])${id.replace('.', '\\.')}(?![\\w])`);
    const proof = [];
    for (const f of files) if (idRe.test(f) || (/\.(mjs|js|ts|py|gd|json|md)$/.test(f) && idRe.test(text(f)))) proof.push(f);
    for (const f of records) if (!proof.includes(f) && idRe.test(text(f))) proof.push(f);
    if (!a) { rows.push({ id, verdict: 'unknown', why: 'not in studio/references/anchors.json', proof }); continue; }
    const st = a.evidence?.status || 'unknown';
    if (st !== 'verified') rows.push({ id, verdict: 'unknown', why: `evidence ${st}${proof.length ? `; the deliverable names it in ${proof.slice(0, 3).join(', ')}, but the reference itself was never checked` : ''}`, proof });
    else if (proof.length) rows.push({ id, verdict: 'met', why: `named in ${proof.slice(0, 3).join(', ')}${proof.length > 3 ? ` and ${proof.length - 3} more` : ''}`, proof });
    else rows.push({ id, verdict: 'unmet', why: `nothing committed for ${taskId}, no regression and no proof record names ${id}`, proof });
  }
  const summary = Object.fromEntries(rows.map((r) => [r.id, r.verdict]));
  return { ids: cited, rows, summary };
}

/** Done-check rows: unmet is a check (failing only under STUDIO_ANCHORS=fail), unknown is a warning, met is a passed row. */
export function anchorCheckRows(taskId, { since = 0, env = process.env } = {}) {
  const j = judgeAnchors(taskId, { since });
  const strict = /^(fail|strict)$/i.test(String(env.STUDIO_ANCHORS || ''));
  const checks = [];
  const warnings = [];
  for (const r of j.rows) {
    if (r.verdict === 'met') checks.push({ label: `Anchor ${r.id} matched by the deliverable (${r.why})`, ok: true, why: null });
    else if (r.verdict === 'unmet') checks.push({ label: `Anchor ${r.id} matched by the deliverable`, ok: !strict, why: strict ? r.why : null, note: strict ? null : `anchor ${r.id} unmet: ${r.why}` });
    else warnings.push(`anchor ${r.id} unknown: ${r.why} (not green; needs a checked reference)`);
  }
  for (const c of checks) if (c.note) warnings.push(c.note);
  return { checks: checks.map(({ note: _n, ...c }) => c), warnings, summary: j.summary, rows: j.rows };
}

export function addAnchor({ game, feature, behaviours = [], numbers = {}, screens = [], acceptance = [], evidence = {}, by = 'producer' }) {
  const list = readAnchors();
  const n = list.reduce((m, a) => Math.max(m, Number(String(a.id).match(/^A(\d+)/)?.[1] || 0)), 0) + 1;
  const a = { id: `A${n}`, game, feature, behaviours, numbers, screens, evidence: { kind: evidence.kind || 'none', path: evidence.path || '', provenance: evidence.provenance || '', status: evidence.status || (evidence.path ? 'unknown' : 'needs-reference') }, acceptance, by, addedAt: new Date().toISOString() };
  const problems = anchorProblems(a);
  if (problems.length) return { ok: false, message: problems.join('; ') };
  list.push(a);
  writeAnchors(list);
  emitEvent({ type: 'anchor.added', agent: by, msg: `${a.id} ${game}: ${feature} (evidence ${a.evidence.status})` });
  return { ok: true, anchor: a };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const many = (k) => argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
  const one = (k) => many(k)[0] || null;
  const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const [cmd = 'list', a1] = pos;
  const fail = (m) => { console.error(m); process.exit(1); };
  if (cmd === 'add') {
    const r = addAnchor({ game: one('game') || '', feature: one('feature') || '', behaviours: many('behaviour'), screens: many('screen'), acceptance: many('acceptance'), numbers: Object.fromEntries(many('number').map((x) => x.split('=').map((s) => s.trim())).filter((p) => p[0])), evidence: { kind: one('kind') || (one('evidence') ? 'manual' : 'none'), path: one('evidence') || '', provenance: one('provenance') || '', status: one('status') || undefined }, by: one('by') || process.env.STUDIO_LOCK_OWNER || 'producer' });
    if (!r.ok) fail(r.message);
    console.log(`${r.anchor.id} added (evidence ${r.anchor.evidence.status}). Cite it: npm run task -- add "…" --anchors ${r.anchor.id}`);
  } else if (cmd === 'show') {
    const a = readAnchors().find((x) => x.id === a1);
    if (!a) fail(`No anchor ${a1}`);
    console.log(JSON.stringify(a, null, 2));
  } else if (cmd === 'check') {
    if (!a1) fail('Usage: node harness/anchors.mjs check <T-ID>');
    const j = judgeAnchors(a1);
    if (!j.ids.length) console.log(`${a1} cites no anchors.`);
    for (const r of j.rows) console.log(`${r.id}: ${r.verdict} (${r.why})`);
  } else if (cmd === 'validate') {
    const bad = readAnchors().flatMap(anchorProblems);
    console.log(bad.length ? bad.join('\n') : `anchors: ${readAnchors().length} valid`);
    process.exit(bad.length ? 1 : 0);
  } else {
    const list = readAnchors();
    console.log(list.length ? list.map((a) => `${a.id} ${a.game}: ${a.feature} [evidence ${a.evidence?.status || 'unknown'}] ${(a.acceptance || []).length} acceptance line(s)`).join('\n') : 'No anchors yet: node harness/anchors.mjs add --game "…" --feature "…" --acceptance "…" [--evidence <path|url> --provenance "…" --status verified]');
  }
}
