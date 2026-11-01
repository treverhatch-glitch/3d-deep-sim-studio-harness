/**
 * harness/config-proposal.mjs — 2.65.0 (B-40 full): a lane carries studio config changes through a sanctioned route.
 *
 * studio/ in a lane copy is the main checkout's (a link, 2.60.1), so a lane's commits can never carry studio config and
 * an edit there lands in main's checkout, uncommitted (the edit guard refuses it). Instead the lane commits a proposal:
 *
 *   studio-proposals/<TASK-ID>.json
 *   { "changes": [ { "file": "studio/game.json", "set": { "engines.unity.land": "tools/land", "/gates/0/id": "x" } } ],
 *     "why": "what the change is for" }
 *
 *   - file: a top-level studio/*.json file (not the board's own records); a file that doesn't exist yet is created.
 *   - set: keys to set, each a dotted key (a.b.c) or a JSON pointer (/a/b/0, ~1 for "/", ~0 for "~"), to any JSON value
 *     (null included). Nothing is deleted: no whole file, no key. The root itself can't be set.
 *
 * When the lane lands (the merge train, or the old one-lane task done path), the harness applies it to main in the
 * commit right after the landing, with a `Config-From: <task>` trailer, and removes the proposal file. Rules:
 *   - a key whose value on main changed since the lane's base (and isn't already the proposed value) is a conflict:
 *     the lane is handed back with a note before it lands (checkProposal); found only at landing (a race), that part is
 *     held, never applied over main's newer value;
 *   - a protected file (studio/protected.json "globs" as main's tip has it, plus the shipped list) applies only with the
 *     owner's decision: with an owner key (studio/keys/owner-ed25519.pub.pem at main's tip), a signed approval of exactly
 *     its protected changes (npm run approve -- proposal <ID>); without a key, a person's release of the lane (a lane
 *     with such a proposal is tier C, harness/tiers.mjs, held until a person releases it). Otherwise the protected part
 *     is held: it stays on main in studio-proposals/<ID>.json (with "held" saying why), an event asks a person, and
 *     npm run task -- train config <ID> applies it once that is settled. Nothing is dropped silently.
 * The applying commit is the harness's own (commit-tree on main, landed by compare-and-swap like a lane), carries
 * `Studio-Harness: config-from` and changes only studio/*.json and studio-proposals/ (harness/hook-stamp.mjs exempts
 * exactly that). The train's verify can't see it first: a train copy's studio/ is main's live folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalBytes } from './hash.mjs';
import { matchAny } from './merge-lane.mjs';
import { SHIPPED_PROTECTED } from './tiers.mjs';
import { emitEvent } from './event.mjs';

export const PROPOSALS_DIR = 'studio-proposals';
export const OWNER_PUB_REL = 'studio/keys/owner-ed25519.pub.pem';
export const CONFIG_TRAILER = 'Config-From';
export const proposalRel = (task) => `${PROPOSALS_DIR}/${task}.json`;
const norm = (p) => String(p || '').replace(/\\/g, '/');
export const isProposalPath = (rel) => /^studio-proposals\/[^/]+\.json$/i.test(norm(rel));
/** The board's own records (written by the board commands): never a proposal's target. */
const RECORDS = new Set(['studio/task-holds.json', 'studio/pending-review.json', 'studio/task-types.json']);
const TARGET_RX = /^studio\/[^/]+\.json$/;
const BAD_SEG = new Set(['__proto__', 'constructor', 'prototype']);
const OWN_KEYS = new Set(['changes', 'why', 'task', 'base', 'held']);

const git = (cwd, args, opts = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
const out = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');

/** A key's path: a JSON pointer ("/a/b", "~1" is "/", "~0" is "~") or a dotted key ("a.b"). null when invalid. */
export function keySegments(key) {
  const k = String(key ?? '');
  if (!k || k === '/') return null;
  const segs = k.startsWith('/') ? k.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')) : k.split('.');
  if (segs.some((s) => s === '' || BAD_SEG.has(s))) return null;
  return segs;
}

/**
 * Read a proposal's text: { ok, changes: [{ file, set: { key: value } }], targets: [file], why, errors: [] }.
 * Entries for one file are merged; the same key twice (after normalising) is an error.
 */
export function parseProposal(text) {
  const errors = [];
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) { return { ok: false, changes: [], targets: [], errors: [`it isn't JSON (${e.message})`] }; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, changes: [], targets: [], errors: ['it must be a JSON object: { "changes": [...], "why": "..." }'] };
  for (const k of Object.keys(doc)) if (!OWN_KEYS.has(k)) errors.push(`unknown field "${k}" (only "changes" and "why")`);
  if (typeof doc.why !== 'string' || !doc.why.trim()) errors.push('"why" must say what the change is for');
  if (!Array.isArray(doc.changes) || !doc.changes.length) errors.push('"changes" must be a non-empty list of { "file": "studio/<name>.json", "set": { "<key>": <value> } }');
  const byFile = new Map();
  for (const [i, c] of (Array.isArray(doc.changes) ? doc.changes : []).entries()) {
    const file = norm(c?.file);
    if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`changes[${i}] must be an object`); continue; }
    for (const k of Object.keys(c)) if (k !== 'file' && k !== 'set') errors.push(`changes[${i}]: unknown field "${k}" (only "file" and "set": nothing is deleted)`);
    if (!TARGET_RX.test(file)) { errors.push(`changes[${i}]: "${c.file}" is not a top-level studio/*.json file`); continue; }
    if (RECORDS.has(file)) { errors.push(`changes[${i}]: ${file} is a record the board commands write, not config`); continue; }
    if (!c.set || typeof c.set !== 'object' || Array.isArray(c.set) || !Object.keys(c.set).length) { errors.push(`changes[${i}] (${file}): "set" must be an object of keys to set`); continue; }
    const m = byFile.get(file) || new Map();
    for (const [key, value] of Object.entries(c.set)) {
      const segs = keySegments(key);
      if (!segs) { errors.push(`${file}: "${key}" is not a key (a.b.c or /a/b/c; not the root, no empty or __proto__ parts)`); continue; }
      const id = JSON.stringify(segs);
      if (m.has(id)) { errors.push(`${file}: "${key}" is set twice`); continue; }
      m.set(id, { key, segs, value });
    }
    byFile.set(file, m);
  }
  const changes = [...byFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, m]) => ({ file, set: Object.fromEntries([...m.values()].map((x) => [x.key, x.value])), keys: [...m.values()] }));
  return { ok: errors.length === 0, changes, targets: changes.map((c) => c.file), why: typeof doc.why === 'string' ? doc.why.trim() : '', errors, doc };
}

/** The files a proposal names, or null when it can't be read (callers treat that as the strictest case). */
export function proposalTargets(text) {
  const p = parseProposal(text);
  return p.changes.length ? p.targets : null;
}

/** The protected globs at a revision: studio/protected.json "globs" there, always with the shipped list. */
export function protectedGlobsAt(root, rev) {
  let globs = [];
  try { const j = JSON.parse(out(git(root, ['show', `${rev}:studio/protected.json`]))); if (Array.isArray(j.globs)) globs = j.globs.map(String); } catch {}
  return [...new Set([...SHIPPED_PROTECTED, ...globs])];
}

/** The changes to protected files, normalised (what an owner's approval signs), and their hash. */
export function protectedPart(changes, globs) {
  const prot = changes.filter((c) => matchAny(c.file, globs)).map((c) => ({ file: c.file, set: c.set }));
  return { changes: prot, hash: prot.length ? crypto.createHash('sha256').update(canonicalBytes(prot)).digest('hex') : null };
}

const show = (root, rev, rel) => { const r = git(root, ['show', `${rev}:${rel}`]); return r.status === 0 ? r.stdout : null; };
function getAt(obj, segs) {
  let cur = obj;
  for (const s of segs) {
    if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, Array.isArray(cur) ? Number(s) : s)) return { found: false };
    cur = Array.isArray(cur) ? cur[Number(s)] : cur[s];
  }
  return { found: true, value: cur };
}
const same = (a, b) => a.found === b.found && (!a.found || Buffer.compare(Buffer.from(canonicalBytes(a.value)), Buffer.from(canonicalBytes(b.value))) === 0);
/** Set a key in a parsed JSON object (missing objects on the way are made). Returns '' or why it can't. */
function setAt(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i];
    const last = i === segs.length - 1;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(s) || Number(s) > cur.length) return `${segs.slice(0, i).join('.') || '(top)'} is a list and "${s}" isn't an index in it`;
      if (last) { cur[Number(s)] = value; return ''; }
      if (cur[Number(s)] === undefined) cur[Number(s)] = {};
      cur = cur[Number(s)];
    } else if (cur && typeof cur === 'object') {
      if (last) { cur[s] = value; return ''; }
      if (!Object.prototype.hasOwnProperty.call(cur, s)) cur[s] = {};
      cur = cur[s];
    } else return `${segs.slice(0, i).join('.')} is not an object on main`;
    if (cur === null || typeof cur !== 'object') { if (!last) return `${segs.slice(0, i + 1).join('.')} is not an object on main`; }
  }
  return '';
}
const parseJson = (text) => { if (text === null) return { ok: true, value: {}, missing: true }; try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v } : { ok: false }; } catch { return { ok: false }; } };
const show1 = (v) => { const s = JSON.stringify(v); return s === undefined ? '(not set)' : s.length > 60 ? `${s.slice(0, 57)}...` : s; };

/**
 * Judge a proposal against main: { ok, invalid, errors, conflicts: [{ file, key, base, main, proposed }], changes,
 * targets, protectedFiles, why }. A conflict: the key's value at main's `tip` differs from its value at the lane's
 * `base` and from the proposed value (main changed it since the lane started).
 */
export function checkProposal(root, { text, base, tip, globs = null }) {
  const p = parseProposal(text);
  if (!p.ok) return { ok: false, invalid: true, errors: p.errors, conflicts: [], changes: p.changes, targets: p.targets, protectedFiles: [], why: `its config proposal can't be applied: ${p.errors.slice(0, 4).join('; ')}` };
  const g = globs || protectedGlobsAt(root, tip);
  const conflicts = [];
  const errors = [];
  for (const c of p.changes) {
    const atBase = parseJson(base ? show(root, base, c.file) : null);
    const atTip = parseJson(show(root, tip, c.file));
    if (!atTip.ok) { errors.push(`${c.file} on main isn't a JSON object`); continue; }
    for (const k of c.keys) {
      const was = atBase.ok ? getAt(atBase.value, k.segs) : { found: false };
      const now = getAt(atTip.value, k.segs);
      const want = { found: true, value: k.value };
      if (!same(was, now) && !same(now, want)) conflicts.push({ file: c.file, key: k.key, base: was.found ? was.value : undefined, main: now.found ? now.value : undefined, proposed: k.value });
    }
  }
  const protectedFiles = p.targets.filter((f) => matchAny(f, g));
  const why = errors.length ? `its config proposal can't be applied: ${errors.join('; ')}`
    : conflicts.length ? `its config proposal conflicts with main: ${conflicts.slice(0, 4).map((x) => `${x.file} ${x.key} is ${show1(x.main)} on main now (it was ${show1(x.base)} when the lane started; the proposal sets ${show1(x.proposed)})`).join('; ')}. Merge main into the lane, decide the value again in ${PROPOSALS_DIR}/<ID>.json, commit, then task done again`
      : '';
  return { ok: !errors.length && !conflicts.length, invalid: errors.length > 0, errors, conflicts, changes: p.changes, targets: p.targets, protectedFiles, why, parsed: p };
}

/** A lane's proposal for `task` at `head`, judged against main's `tip` from the lane's base. null when it has none. */
export function laneProposal(root, { task, head, tip }) {
  const text = show(root, head, proposalRel(task));
  const others = out(git(root, ['diff', '--name-only', `${out(git(root, ['merge-base', tip, head])) || tip}..${head}`, '--', PROPOSALS_DIR])).split('\n').filter(Boolean).filter((f) => f !== proposalRel(task));
  if (text === null && !others.length) return null;
  if (others.length) return { ok: false, invalid: true, errors: [`it adds ${others.join(', ')}: a lane proposes config only for its own task, in ${proposalRel(task)}`], conflicts: [], targets: [], protectedFiles: [], why: `its config proposal can't be applied: it changes ${others.join(', ')}; a lane proposes config only for its own task, in ${proposalRel(task)}` };
  const base = out(git(root, ['merge-base', tip, head])) || tip;
  return { ...checkProposal(root, { text, base, tip }), base, rel: proposalRel(task) };
}

/** The owner's public key at a revision, or null. */
export const ownerKeyAt = (root, rev) => { const pem = show(root, rev, OWNER_PUB_REL); return /BEGIN PUBLIC KEY/.test(pem || '') ? pem : null; };

/** The owner's signed approval for these protected changes of `task` (studio/approvals/*.json, kind "proposal"), or null. */
export function signedProposal(root, { task, hash, pub }) {
  if (!pub || !hash) return null;
  const dir = path.join(root, 'studio', 'approvals');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  for (const f of names) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const a = doc?.approval;
    if (a?.kind !== 'proposal' || a.task !== task || a.change !== hash) continue;
    let ok = false;
    try { ok = crypto.verify(null, Buffer.from(canonicalBytes(a)), crypto.createPublicKey(pub), Buffer.from(String(doc.signature), 'base64')); } catch { ok = false; }
    if (ok) return { file: `studio/approvals/${f}`, by: a.by, note: a.note };
  }
  return null;
}

/** New text for a JSON file with these keys set (the file's own indent kept; 2 spaces for a new file). */
function rewrite(text, keys) {
  const j = parseJson(text);
  if (!j.ok) return { error: 'it isn\'t a JSON object on main' };
  const obj = JSON.parse(JSON.stringify(j.value));
  for (const k of keys) { const e = setAt(obj, k.segs, k.value); if (e) return { error: `${k.key}: ${e}` }; }
  const ind = (String(text || '').match(/^([ \t]+)"/m) || [null, '  '])[1];
  return { text: `${JSON.stringify(obj, null, ind)}${text === null || /\n$/.test(text) ? '\n' : ''}` };
}

/** A commit on top of `tip` with these files (rel -> text, or null to remove), made without touching any checkout. */
function commitFiles(root, tip, files, message) {
  const idx = path.join(os.tmpdir(), `studio-config-${process.pid}-${Date.now()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE']) delete env[k];
  const g2 = (args, input) => git(root, args, { env, ...(input !== undefined ? { input } : {}) });
  try {
    if (g2(['read-tree', tip]).status !== 0) return { error: 'git read-tree failed' };
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) { g2(['update-index', '--force-remove', '--', rel]); continue; }
      const blob = out(g2(['hash-object', '-w', '--stdin'], text));
      if (!blob) return { error: `git hash-object failed for ${rel}` };
      const mode = (out(git(root, ['ls-tree', tip, '--', rel])).split(/\s+/)[0]) || '100644';
      if (g2(['update-index', '--add', '--cacheinfo', `${mode},${blob},${rel}`]).status !== 0) return { error: `git update-index failed for ${rel}` };
    }
    const tree = out(g2(['write-tree']));
    if (!tree) return { error: 'git write-tree failed' };
    const c = git(root, ['-c', 'user.name=launcher', '-c', 'user.email=launcher@studio.local', 'commit-tree', tree, '-p', tip, '-F', '-'], { input: message, env: { ...process.env, GIT_AUTHOR_NAME: 'launcher', GIT_AUTHOR_EMAIL: 'launcher@studio.local', GIT_COMMITTER_NAME: 'launcher', GIT_COMMITTER_EMAIL: 'launcher@studio.local' } });
    const sha = out(c);
    return sha ? { sha, tree } : { error: `git commit-tree failed: ${String(c.stderr || '').trim().split('\n').pop()}` };
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch {}
  }
}

/**
 * Apply the proposal of `task` that main's tip now holds (after its lane landed; call under the land lock).
 *   base      the lane's base (merge-base of main and the lane before it landed), for conflicts; a held proposal keeps it
 *   released  a person's release of this lane ({ by, ... }) or null: without an owner key, what lets a protected part apply
 *   ff(root, main, sha)  moves main to the new commit (worktree.mjs landFastForward)
 * Returns null (no proposal) or { ok, applied: [file], held: [{ file, why }], commit, why }.
 */
export function landConfig(root, { task, main, base = null, released = null, ff, by = 'harness' }) {
  const tip = out(git(root, ['rev-parse', `refs/heads/${main}`]));
  const rel = proposalRel(task);
  const text = show(root, tip, rel);
  if (text === null) return null;
  const p = parseProposal(text);
  const baseRev = base || (p.doc && typeof p.doc.base === 'string' && /^[0-9a-f]{40}$/.test(p.doc.base) ? p.doc.base : null) || tip;
  const held = [];
  const files = {};
  const applied = [];
  if (!p.ok) {
    held.push({ file: rel, why: `it can't be applied: ${p.errors.slice(0, 3).join('; ')}` });
  } else {
    const globs = protectedGlobsAt(root, tip);
    const chk = checkProposal(root, { text, base: baseRev, tip, globs });
    const pub = ownerKeyAt(root, tip);
    const part = protectedPart(p.changes, globs);
    const signed = pub ? signedProposal(root, { task, hash: part.hash, pub }) : null;
    const protOk = !part.changes.length || (pub ? Boolean(signed) : Boolean(released?.by));
    const protWhy = pub ? `this studio has an owner key: a protected file changes only with the owner's signed approval of exactly this change (on the owner's device: npm run approve -- proposal ${task} --note "…", commit the approval to main), then npm run task -- train config ${task}`
      : `a protected file changes only with a person's decision: a person releases the lane (npm run task -- train release ${task} --by <name>) or applies it (npm run task -- train config ${task} --by <name>)`;
    for (const c of p.changes) {
      const bad = chk.conflicts.filter((x) => x.file === c.file);
      if (bad.length) { held.push({ file: c.file, why: `main changed ${bad.map((x) => x.key).join(', ')} since the lane started (now ${bad.map((x) => show1(x.main)).join(', ')})`, change: c }); continue; }
      if (matchAny(c.file, globs) && !protOk) { held.push({ file: c.file, why: protWhy, change: c, protected: true }); continue; }
      const r = rewrite(show(root, tip, c.file), c.keys);
      if (r.error) { held.push({ file: c.file, why: r.error, change: c }); continue; }
      files[c.file] = r.text;
      applied.push(c.file);
    }
    if (applied.length && part.changes.length && protOk) applied.decision = signed ? `the owner's signed approval (${signed.file})` : released?.by ? `${released.by}'s release of the lane${released.recordedBy ? ` (recorded by ${released.recordedBy})` : ''}` : '';
  }
  const heldChanges = held.filter((h) => h.change).map((h) => ({ file: h.change.file, set: h.change.set }));
  if (held.length && heldChanges.length) {
    files[rel] = `${JSON.stringify({ changes: heldChanges, why: p.why || '', task, base: baseRev, held: held.map((h) => `${h.file}: ${h.why}`).join('; ') }, null, 2)}\n`;
  } else if (!held.length) files[rel] = null; // applied in full: the proposal goes
  else files[rel] = text === null ? null : text; // unreadable: kept as it is, for a person
  if (files[rel] === text) delete files[rel];
  if (!Object.keys(files).length) return { ok: false, applied: [], held, commit: null, why: held.map((h) => `${h.file}: ${h.why}`).join('; ') };
  const subject = applied.length ? `config from ${task}: ${applied.join(', ')}` : `config from ${task}: held for a person`;
  const body = [subject, '', ...(p.why ? [`Why (the lane's proposal): ${p.why.slice(0, 400)}`] : []), ...(applied.length ? [`Applied: ${p.changes.filter((c) => applied.includes(c.file)).map((c) => `${c.file} ${Object.keys(c.set).join(', ')}`).join('; ').slice(0, 600)}`] : []), ...(applied.decision ? [`Protected part decided by: ${applied.decision}`] : []), ...(held.length ? [`Held (stays in ${rel}): ${held.map((h) => `${h.file}: ${h.why}`).join('; ').slice(0, 600)}`] : []), '', `${CONFIG_TRAILER}: ${task}`, 'Studio-Harness: config-from', ''].join('\n');
  const c = commitFiles(root, tip, files, body);
  if (c.error) return { ok: false, applied: [], held: [...held, { file: rel, why: c.error }], commit: null, why: c.error };
  const f = ff(root, main, c.sha, { taskId: `config from ${task}` });
  if (!f.ok) return { ok: false, applied: [], held: [{ file: rel, why: `main didn't move to the config commit: ${f.message}` }], commit: null, why: f.message };
  return { ok: !held.length, applied, held, commit: c.sha, decision: applied.decision || '', why: held.map((h) => `${h.file}: ${h.why}`).join('; ') };
}

/** One line for logs and events. */
export function configLine(task, r) {
  if (!r) return '';
  const a = r.applied?.length ? `applied ${r.applied.join(', ')}${r.commit ? ` (${r.commit.slice(0, 8)}, ${CONFIG_TRAILER}: ${task})` : ''}${r.decision ? `; protected part decided by ${r.decision}` : ''}` : 'applied nothing';
  return `${task}'s config proposal: ${a}${r.held?.length ? `; HELD for a person: ${r.held.map((h) => `${h.file} (${h.why})`).join('; ')}` : ''}`.slice(0, 900);
}

/**
 * Apply the config proposals of lanes that just landed (under the land lock, main at their landing). Each lane:
 * { task, base (its merge-base with main before it landed), released (a person's release or null) }; ff moves main
 * (worktree.mjs landFastForward). Logs, config.applied / config.held events, and res.config. Never throws.
 */
export function applyLandedConfig(root, main, lanes, { ff, log = () => {}, by = 'train', res = null, id = '' } = {}) {
  const outs = [];
  for (const l of lanes) {
    let r = null;
    try { r = landConfig(root, { task: l.task, main, base: l.base || null, released: l.released || null, ff, by }); } catch (e) { r = { ok: false, applied: [], held: [{ file: proposalRel(l.task), why: `could not apply it: ${e.message}` }], why: e.message }; }
    if (!r) continue;
    const line = configLine(l.task, r);
    log(`[${id ? `train ${id}` : 'land'}] ${line}`);
    try {
      if (r.applied.length) emitEvent({ type: 'config.applied', agent: by, task: l.task, status: 'ok', msg: line, meta: { files: r.applied, commit: r.commit, decision: r.decision || null } });
      if (r.held.length) emitEvent({ type: 'config.held', agent: by, task: l.task, to: 'human', status: 'blocked', msg: `${line}. It stays in ${proposalRel(l.task)} on main; npm run task -- train config ${l.task} applies it once settled`.slice(0, 900), meta: { held: r.held.map((h) => ({ file: h.file, why: h.why })), commit: r.commit } });
    } catch { /* the commit and the log stand */ }
    outs.push({ task: l.task, applied: r.applied, held: r.held.map((h) => ({ file: h.file, why: h.why })), commit: r.commit, decision: r.decision || '' });
  }
  if (res && outs.length) res.config = [...(res.config || []), ...outs];
  return outs;
}

/**
 * The one-lane task done path (no train): judge the lane's proposal before it lands. { has, refuse, apply() }; apply
 * (call in deliver's onLanded, under the land lock) applies it to main right after the landing.
 */
export function laneConfigBefore(root, { task, laneDir, main, ff, log = (m) => console.log(m), by = 'task-done' }) {
  const head = out(git(laneDir, ['rev-parse', 'HEAD']));
  const tip = out(git(root, ['rev-parse', `refs/heads/${main}`]));
  if (!head || !tip) return { has: false };
  const cp = laneProposal(root, { task, head, tip });
  if (!cp) return { has: false };
  if (!cp.ok) return { has: true, refuse: `${cp.why}.` };
  const base = cp.base;
  return { has: true, apply: () => applyLandedConfig(root, main, [{ task, base, released: null }], { ff, log, by }) };
}
