#!/usr/bin/env node
/**
 * harness/contracts.mjs — 2.62.0 (H): per-task acceptance contracts ("what done means", agreed before coding).
 *
 * A task's title is one line; a builder can make every check green and still deliver less than was meant. A contract
 * is a small JSON per task (studio/contracts/<ID>.json, committed) listing checkable criteria, agreed before the work
 * starts, after which the builder may only flip `passes` (Anthropic's long-running-harness pattern: a feature list
 * where agents only flip `passes`; "sprint contracts" agreed before coding):
 *
 *   { "task": "T-012", "criteria": [{ "id": "C1", "text": "…", "check": { "kind": "command", "command": "…" }, "passes": false },
 *                                   { "id": "C2", "text": "…", "check": { "kind": "file", "path": "…", "contains": "…" }, "passes": false },
 *                                   { "id": "C3", "text": "…", "check": { "kind": "manual" }, "passes": false }],
 *     "agreedBy": "<name>", "agreedAt": "<ISO time>" }
 *
 *   npm run task -- contract <ID> [show]
 *   npm run task -- contract <ID> add "<text>" [--check "<command>" | --file <path> [--contains "<text>"] | --manual]
 *   npm run task -- contract <ID> agree --by <name> [--permission "<the person's words or a link>"] [--why "…"]
 *   npm run task -- contract <ID> check                          runs every command and file check, sets `passes`
 *   npm run task -- contract <ID> sign <CID> pass|fail --by <name> [--permission "…"]     a manual criterion
 *   npm run task -- contract <ID> remove <CID> [--by <name> --why "…"]
 *
 * Who:
 *   - Agrees: a Producer or Director session, a person in their own terminal (the owner), or an agent outside the
 *     harness with a person's direct permission (harness/permission.mjs: --by <the person> --permission "…").
 *     A worker (builder, reviewer, …) never agrees, not even its own task's contract.
 *   - Adds: anyone. A worker's criterion lands as "proposed" and is not in force until someone above agrees the
 *     contract again (`agree --why "…"`). On an agreed contract the agreeing roles add criteria in force directly.
 *   - Sets `passes`: the harness, for command and file criteria (`contract check`; done-check also re-reads the
 *     evidence, so a `passes` typed by hand counts for nothing). A manual criterion is signed by a reviewer, a
 *     person, or the agreeing roles (`sign`), never by a builder.
 *   - Changes an agreed criterion's text or check, or removes it: only by agreeing again (an amendment with a reason,
 *     recorded in `amendments`), by the same roles.
 *
 * Enforced by:
 *   - The weakened-tests gate (harness/test-weakening.mjs, at verify and at every task done): the diff of
 *     studio/contracts/*.json since the base may change only `passes` (and a manual criterion's signature) on an
 *     agreed contract; new criteria in force, an agreement, an amendment and a manual pass must come from the right
 *     role (judged by the commit's Studio-Agent trailer, which the commit-msg hook writes for every agent). Findings
 *     are enforced with or without an owner key; the owner can approve one by content (npm run approve -- tests).
 *   - done-check (harness/done-check.mjs): a task with an agreed contract closes only when every criterion in force
 *     passes; a task without one is unaffected. studio/game.json "contracts": { "required": ["change", "bug"] }
 *     (protected: owner-approved) makes an agreed contract mandatory for those task types.
 *   - The reviewer (harness/review.mjs) gets the contract in its brief and grades the work against each criterion.
 *
 * Limits: a commit with no Studio-Agent trailer counts as a person's (an agent shell without STUDIO_LOCK_OWNER set
 * writes none; the hooks gate catches commits that skipped the hooks, not a missing name). Until the studio has an
 * owner key nothing an agent writes is proof; this is a speed bump that makes redefining done visible, like the
 * type reclassification record.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { agentOnPermission, permissionText, permittedSetter, WORKER_NAME, AGENT_SHELL } from './permission.mjs';

export const CONTRACTS_REL = 'studio/contracts';
export const contractRel = (id) => `${CONTRACTS_REL}/${id}.json`;
const EVIDENCE_REL = '.studio/contracts';
// The fields of a criterion that may change after agreement: the result, never what is asked.
export const PASS_FIELDS = ['passes', 'checkedAt', 'signed'];
const TASK_ID = /^[A-Z]+-\d+$/;
const DECIDER_AGENT = /^(prod|producer|director)(-|_|\d|$)/i;
const REVIEWER_AGENT = /^reviewer(-|_|\d|$)/i;
// The agent-name shapes a person's name must not have (as harness/reclassify.mjs isAgentName, without its file probe).
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|art-director|liaison|scout|reference-scout|designer|designer-calibrator|balancer|fun-tester|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|nim|dev-hacker|sound|composer|writer|engine|ui-)\b|(^|[-_])bot(\b|$)/i;
const timeoutMs = () => (Number(process.env.STUDIO_CONTRACT_TIMEOUT_S) > 0 ? Number(process.env.STUDIO_CONTRACT_TIMEOUT_S) : 600) * 1000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v ?? null));

export const CONTRACT_USAGE = 'Usage: npm run task -- contract <TASK_ID> [show | add "<text>" [--check "<command>" | --file <path> [--contains "<text>"] | --manual] | agree --by <name> [--permission "<the person\'s words or a link>"] [--why "…"] | check | sign <CID> pass|fail --by <name> | remove <CID> [--by <name> --why "…"]] [--no-commit]';

// ---------------------------------------------------------------------------------------------------------------
// The file

const parse = (text) => {
  if (text == null) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || !Array.isArray(j.criteria)) return { invalid: 'it has no "criteria" list' };
    return j;
  } catch (e) {
    return { invalid: `not valid JSON (${e.message})` };
  }
};
export function readContract(id, root = REPO_ROOT) {
  if (!TASK_ID.test(String(id || ''))) return null;
  const f = path.join(root, CONTRACTS_REL, `${id}.json`);
  return fs.existsSync(f) ? parse(fs.readFileSync(f, 'utf8')) : null;
}
function writeContract(id, c, root = REPO_ROOT) {
  const f = path.join(root, CONTRACTS_REL, `${id}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`);
  fs.renameSync(tmp, f);
}
export const isAgreed = (c) => Boolean(c && !c.invalid && String(c.agreedBy || '').trim() && c.agreedAt);
export const inForce = (c) => (isAgreed(c) ? c.criteria.filter((x) => x && x.status !== 'proposed') : []);
const frozenPart = (x) => canon(Object.fromEntries(Object.entries(x || {}).filter(([k]) => !PASS_FIELDS.includes(k))));
const agreeKey = (d) => canon([d?.agreedBy || null, d?.agreedAt || null, d?.recordedBy || null, d?.permission || null, (d?.amendments || []).length]);
const nextId = (c) => `C${Math.max(0, ...c.criteria.map((x) => Number(String(x.id || '').replace(/^C/, '')) || 0)) + 1}`;
const checkWords = (k) => (k?.kind === 'command' ? `command: ${k.command}` : k?.kind === 'file' ? `file: ${k.path}${k.contains ? ` contains "${k.contains}"` : ''}` : 'manual: a reviewer or a person signs it');

/** The studio's task types that need an agreed contract (studio/game.json "contracts": { "required": [...] }). */
export function requiredTypes(root = REPO_ROOT) {
  const roots = [root];
  try { const main = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim(); if (main && path.basename(main) === '.git') roots.push(path.dirname(main)); } catch { /* not git */ }
  const out = new Set();
  for (const r of roots) {
    try { const req = JSON.parse(fs.readFileSync(path.join(r, 'studio', 'game.json'), 'utf8'))?.contracts?.required; if (Array.isArray(req)) for (const t of req) out.add(String(t).toLowerCase()); } catch { /* no manifest */ }
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------------------------
// Who is calling

/** { kind: 'decider'|'reviewer'|'worker'|'outside'|'person', name }. */
export function callerOf(env = process.env) {
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (/^(producer|director)$/i.test(role)) return { kind: 'decider', name: owner || `a ${role.toLowerCase()} session` };
  if (/^reviewer$/i.test(role) || (!role && REVIEWER_AGENT.test(owner))) return { kind: 'reviewer', name: owner || 'a reviewer session' };
  if (role || (owner && WORKER_NAME.test(owner))) return { kind: 'worker', name: owner || `a ${role} session` };
  if (marker || owner) return { kind: 'outside', name: owner || `a coding agent (${marker})` };
  return { kind: 'person', name: '' };
}

/** May this caller act for the agreeing roles (agree, amend, add in force)? { ok, by, recordedBy, permission, why }. */
function authority(caller, flags, env, { reviewerToo = false } = {}) {
  const by = typeof flags.by === 'string' ? flags.by.trim() : '';
  const perm = typeof flags.permission === 'string' ? flags.permission : '';
  if (caller.kind === 'worker' || (caller.kind === 'reviewer' && !reviewerToo)) {
    return { ok: false, why: `${caller.name} is a worker: a worker may propose criteria (contract add) but never agrees a contract, its own task's least of all; the Producer, the Director or the owner agrees it` };
  }
  if (caller.kind === 'decider' || caller.kind === 'reviewer') return { ok: true, by: by || caller.name, ...(by && by !== caller.name ? { recordedBy: caller.name } : {}) };
  if (!by) return { ok: false, why: 'say who decides: --by <your name>' };
  if (AGENTISH.test(by)) return { ok: false, why: `--by "${by}" is an agent's name; --by names the person who decides` };
  if (caller.kind === 'person') return { ok: true, by };
  const p = agentOnPermission({ permission: perm, env });
  if (!p.ok) return { ok: false, why: `${caller.name} is an agent: it acts here only on a person's direct permission. ${p.why}` };
  return { ok: true, by, recordedBy: p.recordedBy, permission: permissionText(perm) };
}

// ---------------------------------------------------------------------------------------------------------------
// Checks and evidence

/** A file criterion, judged now: { ok, why }. */
export function fileCheck(check, root = REPO_ROOT) {
  const rel = String(check?.path || '');
  const full = path.resolve(root, rel);
  if (!rel || path.isAbsolute(rel) || path.relative(root, full).startsWith('..')) return { ok: false, why: `"${rel}" is not a path inside the studio` };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, why: `${rel} doesn't exist` };
  if (check.contains && !fs.readFileSync(full, 'utf8').includes(String(check.contains))) return { ok: false, why: `${rel} doesn't contain "${check.contains}"` };
  return { ok: true, why: '' };
}

/**
 * The work as it is now, contracts aside: the tree git would commit from the working files (tracked and untracked,
 * ignored files left out), without studio/contracts/ (so writing `passes` doesn't make the evidence stale). Uses a
 * copy of the index (its stat cache keeps this fast); null outside a git checkout.
 */
export function workState(root = REPO_ROOT) {
  const g = (args, env) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: env || process.env, maxBuffer: 64 * 1024 * 1024 });
  if (g(['rev-parse', '--verify', '-q', 'HEAD']).status !== 0) return null;
  const idx = path.join(os.tmpdir(), `studio-contract-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.idx`);
  try {
    const real = g(['rev-parse', '--git-path', 'index']).stdout.trim();
    let copied = false;
    try { fs.copyFileSync(path.resolve(root, real), idx); copied = true; } catch { /* no index yet */ }
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    if (!copied) g(['read-tree', 'HEAD'], env);
    g(['add', '-A', '--', '.', `:(exclude)${CONTRACTS_REL}`, ':(exclude).studio'], env);
    g(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', CONTRACTS_REL, '.studio'], env);
    const t = g(['write-tree'], env);
    return t.status === 0 ? t.stdout.trim() : null;
  } finally {
    try { fs.rmSync(idx, { force: true }); } catch { /* gone */ }
  }
}
const evidenceFile = (id, root) => path.join(root, EVIDENCE_REL, `${id}.json`);
export function readEvidence(id, root = REPO_ROOT) { try { return JSON.parse(fs.readFileSync(evidenceFile(id, root), 'utf8')) || {}; } catch { return {}; } }

/** A manual criterion's signature counts when it names someone who isn't a builder (a reviewer, a person, a lead). */
const signerOk = (s) => Boolean(s && String(s.by || '').trim() && s.verdict === 'pass' && (!WORKER_NAME.test(String(s.by)) || REVIEWER_AGENT.test(String(s.by))));

/** Run every criterion in force (command and file checks) and record the results. */
export function runChecks(id, { root = REPO_ROOT, env = process.env, log = () => {} } = {}) {
  const c = readContract(id, root);
  if (!c) return { ok: false, message: `${id} has no contract (${contractRel(id)}).` };
  if (c.invalid) return { ok: false, message: `${contractRel(id)}: ${c.invalid}.` };
  if (!isAgreed(c)) return { ok: false, message: `${id}'s contract isn't agreed yet, so nothing in it is in force: the Producer, the Director or the owner agrees it first (npm run task -- contract ${id} agree --by <name>).` };
  const evidence = readEvidence(id, root);
  const rows = [];
  let changed = false;
  for (const x of inForce(c)) {
    let r;
    if (x.check?.kind === 'command') {
      log(`[contract] ${x.id}: ${x.check.command}`);
      const p = spawnSync(String(x.check.command), { cwd: root, shell: true, encoding: 'utf8', env, timeout: timeoutMs(), maxBuffer: 32 * 1024 * 1024 });
      const tail = `${p.stdout || ''}${p.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
      r = { ok: p.status === 0, why: p.status === 0 ? '' : p.error?.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs() / 1000} s (STUDIO_CONTRACT_TIMEOUT_S)` : `exit ${p.status}${tail ? `: ${tail.slice(-400)}` : ''}` };
    } else if (x.check?.kind === 'file') {
      r = fileCheck(x.check, root);
    } else {
      r = { ok: x.passes === true && signerOk(x.signed), why: x.signed?.verdict === 'fail' ? `signed fail by ${x.signed.by}` : 'not signed yet (a reviewer or a person: npm run task -- contract ' + id + ' sign ' + x.id + ' pass --by <name>)', manual: true };
    }
    if (!r.manual) {
      if (x.passes !== r.ok) { x.passes = r.ok; changed = true; }
      evidence[x.id] = { ok: r.ok, check: sha(canon(x.check)), at: new Date().toISOString(), why: r.why.slice(0, 600) };
    }
    rows.push({ x, ...r });
  }
  const state = workState(root);
  for (const x of inForce(c)) if (evidence[x.id] && x.check?.kind !== 'manual') evidence[x.id].state = state;
  if (changed) writeContract(id, c, root);
  fs.mkdirSync(path.dirname(evidenceFile(id, root)), { recursive: true });
  fs.writeFileSync(evidenceFile(id, root), `${JSON.stringify(evidence, null, 2)}\n`);
  const failing = rows.filter((r) => !r.ok);
  emitEvent({ type: 'contract.checked', agent: callerOf(env).name || 'person', task: id, status: failing.length ? 'blocked' : 'ok', msg: `${id} contract: ${rows.length - failing.length}/${rows.length} criteria pass` });
  const lines = rows.map((r) => `  [${r.ok ? 'x' : ' '}] ${r.x.id}  ${r.x.text}  (${checkWords(r.x.check)})${r.ok ? '' : `\n        ${r.why}`}`);
  return { ok: !failing.length, changed, rows, message: `${id} contract: ${rows.length - failing.length} of ${rows.length} criteria pass.\n${lines.join('\n')}${changed ? `\n${contractRel(id)} updated (passes): commit it with your work.` : ''}` };
}

/**
 * done-check's contract section: { checks: [{ label, ok, why }], notes: [] }. A task with no contract (and whose
 * type the studio doesn't require one for) gets nothing. Command criteria count from the last `contract check`
 * only when it ran on the work as it is now (workState) with the agreed command; file criteria are read now;
 * manual criteria need a reviewer's or a person's signature.
 */
export function contractChecks(task, type, { root = REPO_ROOT } = {}) {
  const checks = [];
  const notes = [];
  const id = task.id;
  const rel = contractRel(id);
  const c = readContract(id, root);
  // Read only when it matters (done-check also runs for the HUD's every agent): no contract, or one not agreed.
  const required = (!c || c.invalid || !isAgreed(c)) && requiredTypes(root).includes(String(type || '').toLowerCase());
  const howAgree = `the Producer writes it (npm run task -- contract ${id} add "<what done means>" --check "<command>") and agrees it (npm run task -- contract ${id} agree --by <name>)`;
  if (!c) {
    if (required) checks.push({ label: `An agreed acceptance contract (studio/game.json requires one for "${type}" tasks)`, ok: false, why: `no ${rel}: ${howAgree}` });
    return { checks, notes };
  }
  if (c.invalid) { checks.push({ label: `Acceptance contract ${rel} is readable`, ok: false, why: `${rel}: ${c.invalid}` }); return { checks, notes }; }
  const proposed = c.criteria.filter((x) => x?.status === 'proposed');
  if (!isAgreed(c)) {
    if (required) checks.push({ label: `An agreed acceptance contract (studio/game.json requires one for "${type}" tasks)`, ok: false, why: `${rel} isn't agreed yet: ${howAgree.split(' and ')[1]}` });
    else notes.push(`${rel} has ${c.criteria.length} criteria nobody has agreed yet, so none is in force (npm run task -- contract ${id} agree --by <name>)`);
    return { checks, notes };
  }
  const evidence = readEvidence(id, root);
  let state;
  const now = () => (state === undefined ? (state = workState(root)) : state);
  for (const x of inForce(c)) {
    let ok = false;
    let why = '';
    if (x.check?.kind === 'command') {
      const e = evidence[x.id];
      ok = Boolean(e && e.ok && e.check === sha(canon(x.check)) && e.state === now());
      why = !e ? 'never checked' : e.check !== sha(canon(x.check)) ? 'checked with another command than the agreed one' : !e.ok ? `failed when last checked (${String(e.why || '').split('\n')[0].slice(0, 200)})` : 'the files changed since it was checked';
      why = `${why}${x.passes === true && !ok ? ' (the file says passes: true, but passes is set by the check, not by hand)' : ''}: npm run task -- contract ${id} check`;
    } else if (x.check?.kind === 'file') {
      const r = fileCheck(x.check, root);
      ok = r.ok;
      why = r.why;
    } else {
      ok = x.passes === true && signerOk(x.signed);
      why = x.signed?.verdict === 'fail' ? `signed fail by ${x.signed.by}${x.signed.note ? `: ${x.signed.note}` : ''}` : x.passes === true ? `passes: true without a reviewer's or a person's signature (${x.signed?.by ? `${x.signed.by} is a builder` : 'none'})` : `a reviewer or a person signs it: npm run task -- contract ${id} sign ${x.id} pass --by <name>`;
    }
    checks.push({ label: `Contract ${x.id}: ${String(x.text).slice(0, 120)} (${x.check?.kind || 'manual'})`, ok, why });
  }
  if (proposed.length) notes.push(`${rel}: ${proposed.map((x) => x.id).join(', ')} proposed by ${[...new Set(proposed.map((x) => x.proposedBy || 'a worker'))].join(', ')}, not in force until the contract is agreed again (npm run task -- contract ${id} agree --by <name> --why "…")`);
  return { checks, notes };
}

/** The contract for the reviewer's brief (harness/review.mjs): text, or '' when the task has none in force. */
export function contractForReview(id, root = REPO_ROOT) {
  const c = readContract(id, root);
  if (!isAgreed(c) || !inForce(c).length) return '';
  return [`Acceptance contract (${contractRel(id)}, agreed by ${c.agreedBy} on ${String(c.agreedAt).slice(0, 10)}). Grade the work against each criterion; one not met means CHANGES:`,
    ...inForce(c).map((x) => `- ${x.id}: ${x.text} [${checkWords(x.check)}; recorded passes: ${x.passes === true ? 'yes' : 'no'}]`)].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// The gate: what may change in studio/contracts/*.json since the base (called by harness/test-weakening.mjs)

const finding = (kind, file, text, detail) => ({ id: sha(`${kind}\n${file}\n${String(text).trim().replace(/\s+/g, ' ')}`).slice(0, 16), kind, file, line: 1, text: String(text).trim().replace(/\s+/g, ' ').slice(0, 160), detail });
const who = (s) => (!s ? 'a change whose commit was not found' : s.uncommitted ? 'an uncommitted change' : `commit ${s.sha.slice(0, 8)}${s.agent ? ` of ${s.agent}` : ''}`);

/** Did the agreeing roles make this change? rec carries recordedBy/permission when an agent acted on permission. */
function deciderMade(s, rec, env) {
  if (!s) return false;
  if (s.uncommitted) { const c = callerOf(env); return c.kind === 'decider' || c.kind === 'person' || (c.kind === 'outside' && permissionText(rec?.permission).length >= 10); }
  if (!s.agent) return true; // no Studio-Agent trailer: a person's commit
  if (DECIDER_AGENT.test(s.agent)) return true;
  return permittedSetter(s.agent) && permissionText(rec?.permission).length >= 10 && String(rec?.recordedBy || '') === s.agent;
}
const signerMade = (s, rec, env) => deciderMade(s, rec, env) || Boolean(s?.agent && REVIEWER_AGENT.test(s.agent)) || Boolean(s?.uncommitted && callerOf(env).kind === 'reviewer');

/**
 * The contract findings since `base`: [{ id, kind, file, line, text, detail }]. git(args) runs git in the checkout.
 * Kinds: contract-agreed-by-worker, contract-deleted, contract-changed, contract-criterion-removed,
 * contract-criterion-changed, contract-criterion-added-by-worker, contract-manual-unsigned, contract-invalid.
 */
export function contractFindings({ base, root = REPO_ROOT, git, env = process.env }) {
  if (!base) return [];
  const run = git || ((args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const isContract = (f) => new RegExp(`^${CONTRACTS_REL}/[^/]+\\.json$`).test(f);
  const changed = run(['diff', '--name-only', '-z', '--no-renames', base, '--', CONTRACTS_REL]).stdout.split('\0');
  const untracked = run(['ls-files', '-o', '--exclude-standard', '-z', '--', CONTRACTS_REL]).stdout.split('\0');
  const files = [...new Set([...changed, ...untracked].filter(isContract))];
  const out = [];
  for (const rel of files) {
    const at = (rev) => { const r = run(['show', `${rev}:${rel}`]); return r.status === 0 ? parse(r.stdout) : null; };
    const full = path.join(root, rel);
    const C = fs.existsSync(full) ? parse(fs.readFileSync(full, 'utf8')) : null;
    let commits = null;
    const setter = (pred) => {
      if (!pred(C)) return null;
      if (!commits) commits = run(['log', '--reverse', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', `${base}..HEAD`, '--', rel]).stdout.split('\n').filter(Boolean).map((l) => { const [h, a] = l.split('\t'); return { sha: h, agent: String(a || '').trim() || null, doc: at(h) }; });
      let prev = pred(at(base));
      let found = null;
      for (const k of commits) { const cur = pred(k.doc); if (cur && !prev) found = k; if (!cur) found = null; prev = cur; }
      return prev ? found : { uncommitted: true };
    };
    out.push(...judgeContract(rel, at(base), C, setter, env));
  }
  return out;
}

/** The rules for one contract file: B at the base, C now, setter(pred) finds who made pred true. Pure but for setter. */
export function judgeContract(rel, B0, C, setter, env = process.env) {
  const out = [];
  const f = (kind, text, detail) => out.push(finding(kind, rel, text, detail));
  const B = B0?.invalid ? null : B0;
  const task = C?.task || B?.task || path.basename(rel, '.json');
  if (C?.invalid) { if (isAgreed(B)) f('contract-invalid', `${task}: ${C.invalid}`, 'an agreed contract must stay readable'); return out; }
  // The agreement in force now: who set it, and the contract as it was then (later changes are judged against it).
  let ref = isAgreed(B) ? B : null;
  if (isAgreed(C) && (!isAgreed(B) || agreeKey(B) !== agreeKey(C))) {
    const s = setter((d) => isAgreed(d) && agreeKey(d) === agreeKey(C));
    if (!deciderMade(s, C, env) || WORKER_NAME.test(String(C.agreedBy || '').trim())) {
      f('contract-agreed-by-worker', `${task}: agreed as ${C.agreedBy} at ${C.agreedAt}`, `${who(s)} set the agreement; only the Producer, the Director, the owner, or an agent on a person's permission agrees a contract (npm run task -- contract ${task} agree)`);
    } else {
      ref = s?.uncommitted ? C : (s?.doc || C);
    }
  }
  if (!ref) return out.concat(manualFindings(rel, task, B, C, setter, env));
  if (!C) { f('contract-deleted', `${task}: contract deleted`, 'an agreed contract stays; the agreeing roles change it by agreeing it again'); return out; }
  if (!isAgreed(C)) f('contract-changed', `${task}: agreement removed (was ${ref.agreedBy})`, 'only the agreeing roles change an agreement');
  if (String(C.task || '') !== String(ref.task || '')) f('contract-changed', `${task}: task ${ref.task} → ${C.task}`, 'a contract belongs to its task');
  const now = new Map(C.criteria.map((x) => [x?.id, x]));
  for (const b of ref.criteria) {
    const c = now.get(b?.id);
    if (b?.status === 'proposed') {
      if (c && c.status !== 'proposed') f('contract-criterion-changed', `${task} ${b.id}: proposal put in force without an agreement`, 'a proposal is in force only once the agreeing roles agree the contract again');
      continue;
    }
    if (!c) { f('contract-criterion-removed', `${task} ${b.id}: ${b.text}`, 'an agreed criterion was removed; only passes may change'); continue; }
    if (frozenPart(b) !== frozenPart(c)) {
      const what = [...new Set([...Object.keys(b), ...Object.keys(c)])].filter((k) => !PASS_FIELDS.includes(k) && canon(b[k]) !== canon(c[k]));
      f('contract-criterion-changed', `${task} ${b.id}: ${b.text}${c.text !== b.text ? ` → ${c.text}` : ''}`, `changed ${what.join(', ')}; after agreement only passes may change`);
    }
  }
  for (const c of C.criteria) {
    if (!c || c.status === 'proposed' || ref.criteria.some((b) => b?.id === c.id)) continue;
    const s = setter((d) => isAgreed(d) && (d.criteria || []).some((x) => x?.id === c.id && x.status !== 'proposed' && frozenPart(x) === frozenPart(c)));
    if (!deciderMade(s, c, env)) f('contract-criterion-added-by-worker', `${task} ${c.id}: ${c.text}`, `${who(s)} added it in force; a worker's criterion lands as proposed (npm run task -- contract ${task} add) until the contract is agreed again`);
  }
  return out.concat(manualFindings(rel, task, B, C, setter, env));
}

function manualFindings(rel, task, B, C, setter, env) {
  const out = [];
  if (!isAgreed(C)) return out;
  for (const c of inForce(C)) {
    if (c.check?.kind !== 'manual' || c.passes !== true) continue;
    const b = (B?.criteria || []).find((x) => x?.id === c.id);
    if (b && b.passes === true && canon(b.signed) === canon(c.signed)) continue;
    const s = setter((d) => (d?.criteria || []).some((x) => x?.id === c.id && x.passes === true && canon(x.signed) === canon(c.signed)));
    if (!signerOk(c.signed) || !signerMade(s, c.signed, env)) {
      out.push(finding('contract-manual-unsigned', rel, `${task} ${c.id}: ${c.text} (passes: true${c.signed?.by ? `, signed ${c.signed.by}` : ''})`, `${who(s)} set it; a manual criterion passes only when a reviewer or a person signs it (npm run task -- contract ${task} sign ${c.id} pass --by <name>)`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The command (npm run task -- contract …)

function commitOne(id, message, root = REPO_ROOT) {
  const rel = contractRel(id);
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  if (g('rev-parse', '--verify', '-q', 'HEAD').status !== 0) return 'not committed (not a git checkout)';
  g('add', '--', rel);
  const r = g('commit', '-q', '-m', message, '--', rel);
  return r.status === 0 ? `committed (${g('rev-parse', '--short', 'HEAD').stdout.trim()})` : `not committed: ${`${r.stderr || ''}${r.stdout || ''}`.trim().split('\n').pop()}; commit ${rel} yourself`;
}

export function showContract(id, root = REPO_ROOT) {
  const c = readContract(id, root);
  if (!c) return `${id} has no acceptance contract (${contractRel(id)}). The Producer writes one: npm run task -- contract ${id} add "<what done means>" --check "<command>", then agree.`;
  if (c.invalid) return `${contractRel(id)}: ${c.invalid}.`;
  const head = isAgreed(c)
    ? `agreed by ${c.agreedBy} on ${String(c.agreedAt).slice(0, 10)}${c.permission ? ` (recorded by ${c.recordedBy || 'an agent'} on ${c.agreedBy}'s permission: "${String(c.permission).slice(0, 160)}")` : c.recordedBy ? ` (recorded by ${c.recordedBy})` : ''}${(c.amendments || []).length ? `; amended ${c.amendments.length}x, last: ${c.amendments.at(-1).why}` : ''}`
    : 'NOT agreed yet: nothing in it is in force (the Producer, the Director or the owner agrees it)';
  const lines = c.criteria.map((x) => `  [${x.status === 'proposed' ? '?' : x.passes === true ? 'x' : ' '}] ${x.id}  ${x.text}  (${checkWords(x.check)})${x.status === 'proposed' ? `  proposed by ${x.proposedBy || 'a worker'}, waits for agreement` : ''}${x.signed ? `  signed ${x.signed.verdict} by ${x.signed.by}` : ''}`);
  return `${id} acceptance contract (${contractRel(id)}): ${head}\n${lines.join('\n') || '  (no criteria)'}`;
}

/**
 * One contract subcommand: { ok, message }. task: the board's task; done: it is closed already.
 * sub: show|add|agree|check|sign|remove; args: the positional words after sub; flags: parsed --flags.
 */
export function contractCommand({ task, done = false, sub = 'show', args = [], flags = {}, env = process.env, root = REPO_ROOT, log = (m) => console.error(m) }) {
  const id = task?.id;
  if (!TASK_ID.test(String(id || ''))) return { ok: false, message: CONTRACT_USAGE };
  const caller = callerOf(env);
  const at = new Date().toISOString();
  const commit = !flags['no-commit'];
  if (!sub || sub === 'show') return { ok: true, message: showContract(id, root) };
  if (done) return { ok: false, message: `${id} is done; its contract doesn't change any more (reopen the task first).` };
  if (sub === 'check') return runChecks(id, { root, env, log });
  const c = readContract(id, root) || { task: id, criteria: [], agreedBy: null, agreedAt: null };
  if (c.invalid) return { ok: false, message: `${contractRel(id)}: ${c.invalid}. Fix the file first.` };
  const agreed = isAgreed(c);

  if (sub === 'add') {
    const text = args.join(' ').trim();
    if (text.length < 5) return { ok: false, message: `Say what done means, in words someone can check: npm run task -- contract ${id} add "<text>" [--check "<command>" | --file <path> [--contains "<text>"] | --manual]` };
    const check = typeof flags.check === 'string' && flags.check.trim() ? { kind: 'command', command: flags.check.trim() }
      : typeof flags.file === 'string' && flags.file.trim() ? { kind: 'file', path: flags.file.trim().replace(/\\/g, '/'), ...(typeof flags.contains === 'string' ? { contains: flags.contains } : {}) }
      : { kind: 'manual' };
    if (check.kind === 'file' && !fileCheck({ path: check.path }, root).ok && /not a path inside/.test(fileCheck({ path: check.path }, root).why)) return { ok: false, message: `--file must be a path inside the studio (got "${check.path}").` };
    const x = { id: nextId(c), text, check, passes: false };
    // A worker's criterion is always a proposal. Others draft freely before agreement; on an agreed contract a criterion
    // in force is an agreeing act (authority), and without it the criterion waits as a proposal too.
    const worker = caller.kind === 'worker' || caller.kind === 'reviewer';
    const auth = !worker && agreed ? authority(caller, flags, env) : null;
    const proposal = worker || (agreed && !auth.ok);
    if (proposal) Object.assign(x, { status: 'proposed', proposedBy: caller.name || (typeof flags.by === 'string' ? flags.by : 'a person'), proposedAt: at });
    else Object.assign(x, { addedBy: auth?.ok ? auth.by : (typeof flags.by === 'string' && flags.by.trim()) || caller.name || 'a person', addedAt: at, ...(auth?.recordedBy ? { recordedBy: auth.recordedBy } : {}), ...(auth?.permission ? { permission: auth.permission } : {}) });
    c.criteria.push(x);
    writeContract(id, c, root);
    emitEvent({ type: proposal ? 'contract.proposed' : 'contract.added', agent: caller.name || x.addedBy || 'person', task: id, msg: `${id} ${x.id}${proposal ? ' proposed' : ''}: ${text.slice(0, 120)}` });
    const tail = proposal
      ? `It is a proposal: not in force until the Producer, the Director or the owner agrees the contract${agreed ? ' again' : ''} (npm run task -- contract ${id} agree --by <name>${agreed ? ' --why "…"' : ''}).${auth && !auth.ok ? ` (${auth.why})` : ''}`
      : agreed ? `In force now (the contract is agreed). ${commit ? commitOne(id, `${id}: contract ${x.id} added by ${x.addedBy}`, root) : `Commit ${contractRel(id)}.`}` : `Agree the contract when it is complete: npm run task -- contract ${id} agree --by <name>.`;
    return { ok: true, message: `${id} ${x.id} ${proposal ? 'proposed' : 'added'}: ${text} (${checkWords(check)}). ${tail}` };
  }

  if (sub === 'agree') {
    if (!c.criteria.length) return { ok: false, message: `${id} has no criteria to agree: npm run task -- contract ${id} add "<what done means>" first.` };
    const auth = authority(caller, flags, env);
    if (!auth.ok) return { ok: false, message: `Not agreed. ${auth.why}.` };
    const why = typeof flags.why === 'string' ? flags.why.trim() : '';
    if (agreed && why.length < 10) return { ok: false, message: `${id}'s contract is already agreed (by ${c.agreedBy} on ${String(c.agreedAt).slice(0, 10)}). Agreeing it again (to accept proposals or after a change) is an amendment: say why, --why "<reason, 10+ characters>".` };
    const accepted = [];
    for (const x of c.criteria) if (x.status === 'proposed') { delete x.status; x.acceptedBy = auth.by; accepted.push(x.id); }
    if (agreed) c.amendments = [...(c.amendments || []), { at, by: auth.by, why, ...(auth.recordedBy ? { recordedBy: auth.recordedBy } : {}), ...(accepted.length ? { accepted } : {}) }];
    c.agreedBy = auth.by;
    c.agreedAt = at;
    if (auth.recordedBy) c.recordedBy = auth.recordedBy; else delete c.recordedBy;
    if (auth.permission) c.permission = auth.permission; else delete c.permission;
    writeContract(id, c, root);
    emitEvent({ type: 'contract.agreed', agent: caller.name || auth.by, task: id, msg: `${id} contract ${agreed ? 'agreed again' : 'agreed'} by ${auth.by}${auth.permission ? ` (recorded by ${auth.recordedBy} on ${auth.by}'s permission)` : ''}: ${inForce(c).length} criteria${accepted.length ? `, accepted ${accepted.join(', ')}` : ''}` });
    return { ok: true, message: `${id} contract ${agreed ? 'agreed again' : 'agreed'} by ${auth.by}: ${inForce(c).length} criteria in force${accepted.length ? ` (accepted the proposals ${accepted.join(', ')})` : ''}. From now on only passes changes. ${commit ? commitOne(id, `${id}: contract ${agreed ? 'amended' : 'agreed'} by ${auth.by}`, root) : `Commit ${contractRel(id)}.`}` };
  }

  if (sub === 'sign') {
    const [cid, verdict] = args;
    const x = c.criteria.find((y) => y.id === cid);
    if (!x || !['pass', 'fail'].includes(verdict)) return { ok: false, message: `Usage: npm run task -- contract ${id} sign <CID> pass|fail --by <name> [--note "…"]` };
    if (x.check?.kind !== 'manual') return { ok: false, message: `${cid} has a ${x.check?.kind} check: its passes is set by npm run task -- contract ${id} check, not by hand.` };
    if (!agreed || x.status === 'proposed') return { ok: false, message: `${cid} isn't in force yet (the contract or the criterion isn't agreed).` };
    const auth = authority(caller, flags, env, { reviewerToo: true });
    if (!auth.ok) return { ok: false, message: `Not signed. ${auth.why.replace('never agrees a contract, its own task\'s least of all; the Producer, the Director or the owner agrees it', 'never signs a manual criterion; a reviewer or a person does')}.` };
    x.passes = verdict === 'pass';
    x.signed = { by: auth.by, verdict, at, ...(auth.recordedBy ? { recordedBy: auth.recordedBy } : {}), ...(auth.permission ? { permission: auth.permission } : {}), ...(typeof flags.note === 'string' ? { note: flags.note } : {}) };
    writeContract(id, c, root);
    emitEvent({ type: 'contract.signed', agent: caller.name || auth.by, task: id, msg: `${id} ${cid} signed ${verdict} by ${auth.by}` });
    return { ok: true, message: `${id} ${cid} signed ${verdict} by ${auth.by}. Commit ${contractRel(id)}.` };
  }

  if (sub === 'remove') {
    const [cid] = args;
    const i = c.criteria.findIndex((y) => y.id === cid);
    if (i < 0) return { ok: false, message: `Usage: npm run task -- contract ${id} remove <CID> [--by <name> --why "…"]` };
    const x = c.criteria[i];
    if (x.status === 'proposed' || !agreed) {
      if ((caller.kind === 'worker' || caller.kind === 'reviewer') && x.status !== 'proposed') return { ok: false, message: `${cid} was written by the agreeing roles; a worker removes only proposals.` };
      c.criteria.splice(i, 1);
      writeContract(id, c, root);
      return { ok: true, message: `${id} ${cid} removed (it wasn't in force).` };
    }
    const auth = authority(caller, flags, env);
    if (!auth.ok) return { ok: false, message: `Not removed. ${auth.why}.` };
    const why = typeof flags.why === 'string' ? flags.why.trim() : '';
    if (why.length < 10) return { ok: false, message: `${cid} is in force: removing it changes what done means, so it is an amendment. Say why: --why "<reason, 10+ characters>".` };
    c.criteria.splice(i, 1);
    c.amendments = [...(c.amendments || []), { at, by: auth.by, why, removed: cid, ...(auth.recordedBy ? { recordedBy: auth.recordedBy } : {}) }];
    c.agreedBy = auth.by;
    c.agreedAt = at;
    if (auth.recordedBy) c.recordedBy = auth.recordedBy; else delete c.recordedBy;
    if (auth.permission) c.permission = auth.permission; else delete c.permission;
    writeContract(id, c, root);
    emitEvent({ type: 'contract.amended', agent: caller.name || auth.by, task: id, msg: `${id} ${cid} removed by ${auth.by}: ${why}` });
    return { ok: true, message: `${id} ${cid} removed by ${auth.by} (an amendment: ${why}). ${commit ? commitOne(id, `${id}: contract ${cid} removed by ${auth.by}`, root) : `Commit ${contractRel(id)}.`}` };
  }
  return { ok: false, message: CONTRACT_USAGE };
}
