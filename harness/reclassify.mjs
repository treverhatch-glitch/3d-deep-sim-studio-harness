/**
 * harness/reclassify.mjs — 2.59.0: the owner's reclassification of a task's type.
 *
 * A task's type comes from its title (harness/done-check.mjs: "Fix: …" is a bug, and a bug closes only with a
 * regression that fails before the fix). When the title rule is wrong for a task, retitling it to dodge the rule is
 * not an agent's call; the owner decides, and the decision is kept where every check can read it:
 *
 *   npm run task -- type <ID>                                       the type, and where it comes from
 *   npm run task -- type <ID> <change|chore|bug|docs|…> --by <owner> --why "<reason, 10+ chars>"
 *   npm run task -- type <ID> auto --by <owner> --why "…"           back to the title's type
 *
 * Who: a person, in their own terminal. Refused inside a launched agent session (STUDIO_ROLE), in a shell that works
 * as an agent (STUDIO_LOCK_OWNER set to an agent's name, or to a name other than --by), in a coding agent's own shell
 * (CLAUDECODE, AI_AGENT, CODEX_SANDBOX, GEMINI_CLI set), and for agent names (and launched sessions' names).
 *
 * How it is kept:
 *   - The studio has an owner key (studio/keys/owner-ed25519.pub.pem, harness/approve.mjs): the reclassification is
 *     signed with the owner's private key (studio/approvals/type-<ID>.json, the same signed-approval format the
 *     protected check verifies) on the owner's device; an unsigned record is then ignored.
 *   - No owner key yet: it is RECORDED in studio/task-types.json (who, why, when, from → to) and committed from the
 *     owner's terminal (the command commits that one file; --no-commit leaves it to you). It counts only once
 *     committed, and only when the commit that set it is not an agent's (no Studio-Agent trailer, which the
 *     commit-msg hook adds for every agent commit). That is a speed bump, not a lock: until the owner key exists,
 *     nothing an agent can write is proof. Every record in force is shown in verify and done output.
 * In a lane copy the record is read from the main checkout, so the owner's decision counts without a rebase.
 * "none" and "rescue" can't be set here: closing a task without its check is `npm run approve -- force`.
 *
 * 2.59.1 (the owner's rule): with a person's direct permission a Producer or Director session, or an agent outside the
 * harness, may record it for them: `--by <the person> --permission "<their words, or a link to the message>"`
 * (harness/permission.mjs). The entry keeps `permission` and `recordedBy`, an agent commit that set it counts when it
 * is that same agent and not a worker, and every output shows it. Builders never can. With an owner key the
 * reclassification still has to be signed with it.
 *
 * 2.60.1 (B-38): the owner's visual-proof decision for a task, recorded the same way and under the same rules (a person,
 * or a Producer/Director/outside agent on a person's permission; workers never; signed once there is an owner key):
 *
 *   npm run task -- visual <ID> off|on --by <owner> --why "…" [--permission "…"]     auto: back to the detection
 *
 * It is kept in the same file, under "visual" (studio/task-types.json), and an approval is studio/approvals/visual-<ID>.json.
 * ownerVisual() applies exactly the validity rules ownerType() applies (one resolver serves both); harness/verdict-split.mjs
 * honours a valid one before anything else, and a valid owner type that isn't render work outranks the title's words.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { canonicalBytes } from './hash.mjs';
import { mainRoot, inLaneCopy } from './worktree.mjs';
import { resolveBase, ownerPublicKey, ownerKeyPath, verifyApproval, OWNER_KEY_HOWTO, APPROVALS_REL } from './approve.mjs';
import { agentOnPermission, permissionText, permittedSetter } from './permission.mjs';

export const TYPE_RECORD_REL = 'studio/task-types.json';
export const RETYPABLE = ['change', 'chore', 'bug', 'docs', 'system', 'balance', 'fun', 'playtest', 'study', 'review', 'direction', 'idea', 'art', 'trick', 'whole'];
const NOTE = 'Owner reclassifications of task types (npm run task -- type <ID> <type> --by <owner> --why "…"; harness/reclassify.mjs). Written by that command from the owner\'s terminal; an entry set by an agent\'s commit (Studio-Agent trailer) is ignored, and once the studio has an owner key only signed reclassifications (studio/approvals/type-<ID>.json) count.';

// The agent-name shapes the launcher, fun verdicts and the agy allow-list use, and a "-bot" suffix.
const AGENTISH = /^(prod|producer|director|builder|rnd|qa|qa-playtester|playtester|reviewer|planner|art|artist|art-director|liaison|scout|reference-scout|designer|designer-calibrator|balancer|fun-tester|agent|watch|supervisor|launcher|unknown|codex|claude|gemini|agy|gpt|grok|opus|sonnet|haiku|cursor|aider|hermes|nim|dev-hacker|sound|composer|writer|engine|ui-)\b|(^|[-_])bot(\b|$)/i;
const AGENT_SHELL = ['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The checkout whose record counts: the main checkout (a lane copy reads the owner's record there). */
const recordRoot = () => { try { return mainRoot(); } catch { return REPO_ROOT; } };

/** An agent's name: the agent shapes, or the name of a launched session (.studio/agents/<name>.json). */
export function isAgentName(by) {
  const name = String(by || '').trim();
  if (!name) return false;
  if (AGENTISH.test(name)) return true;
  const file = `${name.replace(/[^\w.-]/g, '_')}.json`;
  return [REPO_ROOT, recordRoot()].some((r) => fs.existsSync(path.join(r, '.studio', 'agents', file)));
}

/** Why this caller may not reclassify (null: a person in their own terminal). */
export function personRefusal(by, env = process.env) {
  const tail = 'Reclassifying a task is the owner\'s decision: the owner runs it in their own terminal, as themselves. An agent hands the task back and asks (npm run task -- pause <ID> --note "…").';
  const who = String(by || '').trim();
  if (!who) return `Say who decides: --by <your name>. ${tail}`;
  if (env.STUDIO_ROLE) return `Refused: this runs inside a launched ${env.STUDIO_ROLE} session (STUDIO_ROLE). ${tail}`;
  // A coding agent's own shell (Claude Code sets CLAUDECODE and AI_AGENT, Codex CODEX_SANDBOX, Gemini CLI GEMINI_CLI):
  // a chat bot relaying "the owner said yes" is still an agent typing it.
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (marker) return `Refused: this shell is run by a coding agent (${marker} is set). ${tail}`;
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (owner && (isAgentName(owner) || owner !== who)) return `Refused: this shell works as ${owner} (STUDIO_LOCK_OWNER)${owner !== who ? `, not as ${who}` : ', an agent'}. ${tail}`;
  if (isAgentName(who)) return `Refused: "${who}" is an agent's name. ${tail}`;
  return null;
}

let keyMemo = null;
/** The owner's public key as the checks read it (the base branch's), or null: no owner key, records are unsigned. */
export function ownerKey() {
  if (keyMemo && Date.now() - keyMemo.at < 30000) return keyMemo.pub;
  let pub = null;
  try { pub = ownerPublicKey(resolveBase()?.base || null); } catch { pub = null; }
  keyMemo = { at: Date.now(), pub };
  return pub;
}

function readRecord(root = REPO_ROOT) {
  const j = readJson(path.join(root, TYPE_RECORD_REL));
  return j && typeof j === 'object' && j.tasks && typeof j.tasks === 'object' ? j : { note: NOTE, tasks: {} };
}
const approvalDirs = () => [...new Set([REPO_ROOT, recordRoot()])].map((root) => ({ root, dir: path.join(root, APPROVALS_REL) }));
const approvalName = (taskId, prefix = 'type') => `${prefix}-${String(taskId).replace(/[^\w.-]/g, '_')}.json`;
/** The newest signed reclassification of this task that verifies against the owner key. */
function signedApproval(taskId, pub, kind = 'type') {
  const found = [];
  for (const { root, dir } of approvalDirs()) {
    const full = path.join(dir, approvalName(taskId, kind));
    const doc = readJson(full);
    if (doc?.approval?.kind === kind && doc.approval.task === taskId && verifyApproval(doc, pub)) found.push({ ...doc, file: path.relative(root, full).split(path.sep).join('/') });
  }
  return found.sort((a, b) => String(b.approval.at).localeCompare(String(a.approval.at)))[0] || null;
}

const entryAt = (root, rev, taskId, section = 'tasks') => {
  const r = git(root, 'show', `${rev}:${TYPE_RECORD_REL}`);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout)?.[section]?.[taskId] || null; } catch { return null; }
};
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
/** The commit that set this task's committed entry, and whether it is an agent's: { sha, agent } or null. */
function setterOf(root, taskId, entry, section = 'tasks') {
  const log = git(root, 'log', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', '-n', '200', '--', TYPE_RECORD_REL);
  if (log.status !== 0) return null;
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [sha, agent] = line.split('\t');
    if (!same(entryAt(root, sha, taskId, section), entry)) continue;
    if (!same(entryAt(root, `${sha}^`, taskId, section), entry)) return { sha, agent: String(agent || '').trim() || null };
  }
  return null;
}
const validEntry = (e) => {
  if (!e || typeof e !== 'object') return 'the entry is not an object';
  if (!RETYPABLE.includes(e.type)) return `"${e.type}" is not a type a reclassification can set`;
  if (isAgentName(e.by) || !String(e.by || '').trim()) return `"${e.by || ''}" is not a person`;
  if (String(e.why || '').trim().length < 10) return 'it gives no reason (why, 10+ characters)';
  return null;
};
const validVisual = (e) => {
  if (!e || typeof e !== 'object') return 'the entry is not an object';
  if (!['off', 'on'].includes(e.visual)) return `"${e.visual}" is not off or on`;
  if (isAgentName(e.by) || !String(e.by || '').trim()) return `"${e.by || ''}" is not a person`;
  if (String(e.why || '').trim().length < 10) return 'it gives no reason (why, 10+ characters)';
  return null;
};

// 2.60.1 (B-38): the owner decisions kept in studio/task-types.json. One resolver applies the same validity rules to each.
const KINDS = {
  type: { section: 'tasks', validate: validEntry, what: 'a reclassification', set: (id) => `npm run task -- type ${id} <type> --by <name> --why "…"`, fromApproval: (a) => ({ type: a.to, from: a.from }), only: 'only the owner reclassifies a task (npm run task -- type, from the owner\'s own terminal)' },
  visual: { section: 'visual', validate: validVisual, what: 'a visual-proof decision', set: (id) => `npm run task -- visual ${id} off|on --by <name> --why "…"`, fromApproval: (a) => ({ visual: a.to }), only: 'only the owner decides a task\'s visual proof (npm run task -- visual, from the owner\'s own terminal, or on their permission)' },
};

const memo = new Map();
/**
 * The owner's type for this task: { type, from, by, why, at, source: 'owner-signed' | 'owner record', file, commit },
 * { ignored: why } when a record exists but doesn't count, or null (the title decides).
 */
export function ownerType(taskId) { return ownerDecision(taskId, 'type'); }
/** 2.60.1 (B-38): the owner's visual-proof decision: { visual: 'off'|'on', by, why, at, source, ... }, { ignored }, or null. */
export function ownerVisual(taskId) { return ownerDecision(taskId, 'visual'); }

function ownerDecision(taskId, kind) {
  if (!taskId) return null;
  const root = recordRoot();
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = `${taskId}|${stamp(path.join(root, TYPE_RECORD_REL))}|${approvalDirs().map(({ dir }) => stamp(path.join(dir, approvalName(taskId, kind)))).join(',')}`;
  const hit = memo.get(`${kind}|${taskId}`);
  if (hit && hit.key === key && Date.now() - hit.at < 5000) return hit.value;
  const value = resolveOwnerDecision(taskId, root, kind);
  memo.set(`${kind}|${taskId}`, { key, at: Date.now(), value });
  return value;
}
function resolveOwnerDecision(taskId, root, kind) {
  const K = KINDS[kind];
  const work = (readRecord(root)[K.section] || {})[taskId] || null;
  const hasApproval = approvalDirs().some(({ dir }) => fs.existsSync(path.join(dir, approvalName(taskId, kind))));
  if (!work && !hasApproval) {
    // Cheap common case: nothing on disk names this task. A committed entry removed from the working tree only makes
    // the check stricter, so it is not looked up.
    return null;
  }
  const pub = ownerKey();
  if (pub) {
    const a = signedApproval(taskId, pub, kind);
    if (a) return { ...K.fromApproval(a.approval), by: a.approval.by, why: a.approval.why, at: a.approval.at, source: 'owner-signed', file: a.file };
    return { ignored: `${TYPE_RECORD_REL} or ${APPROVALS_REL}/ names ${taskId}, but this studio has an owner key, so ${K.what} counts only when it is signed with it (the owner runs ${K.set(taskId)} on the device that holds the key)` };
  }
  const isGit = git(root, 'rev-parse', '--verify', 'HEAD').status === 0;
  if (!isGit) {
    const bad = K.validate(work);
    return bad ? { ignored: `${TYPE_RECORD_REL} names ${taskId}, but ${bad}` } : { ...work, source: 'owner record', commit: null, note: 'not a git checkout: who wrote it can\'t be checked' };
  }
  const committed = entryAt(root, 'HEAD', taskId, K.section);
  if (!committed) return { ignored: `${TYPE_RECORD_REL} names ${taskId} but isn't committed yet${inLaneCopy() ? ' on the main checkout' : ''}: the owner commits it (the ${kind} command does, unless --no-commit), then it counts` };
  const bad = K.validate(committed);
  if (bad) return { ignored: `${TYPE_RECORD_REL} names ${taskId}, but ${bad}` };
  const setter = setterOf(root, taskId, committed, K.section);
  if (!setter) return { ignored: `${TYPE_RECORD_REL}: the commit that set ${taskId}'s entry wasn't found, so who wrote it can't be checked` };
  // 2.59.1: an agent's commit counts when the entry says it was recorded on a person's permission, by that agent, and
  // the agent isn't a worker (harness/permission.mjs).
  if (setter.agent && permissionText(committed.permission).length >= 10 && permittedSetter(setter.agent) && String(committed.recordedBy || '') === setter.agent) {
    return { ...committed, source: 'owner record', onPermission: true, commit: setter.sha.slice(0, 8), ...(same(work, committed) ? {} : { note: `the working copy of ${TYPE_RECORD_REL} differs from the committed one, which is what counts` }) };
  }
  if (setter.agent) return { ignored: `${TYPE_RECORD_REL}: ${taskId}'s entry was set by commit ${setter.sha.slice(0, 8)} of the agent ${setter.agent} (Studio-Agent trailer); ${K.only}` };
  return { ...committed, source: 'owner record', commit: setter.sha.slice(0, 8), ...(same(work, committed) ? {} : { note: `the working copy of ${TYPE_RECORD_REL} differs from the committed one, which is what counts` }) };
}

/** Words for where an owner type came from, for done and verify output. */
export function ownerTypeWords(o) {
  if (!o?.type) return '';
  const when = String(o.at || '').slice(0, 10);
  const how = o.source === 'owner-signed'
    ? `owner-signed, ${o.file}`
    : `owner record in ${TYPE_RECORD_REL}${o.commit ? `, commit ${o.commit}` : ''}${o.permission ? `; recorded by ${o.recordedBy || 'an agent'} on ${o.by}'s permission: "${String(o.permission).slice(0, 160)}"` : ''}; not signed: the studio has no owner key yet`;
  return `set by ${o.by}${when ? ` on ${when}` : ''}${o.from ? ` (the title says ${o.from})` : ''} [${how}]: ${o.why}`;
}

/**
 * 2.60.1 (B-38): words for the owner's visual-proof decision, for done-check and verify output:
 * 'visual proof: off, set by opus-bot on hatch's permission ("…") [commit 1a2b3c4d]: why'.
 */
export function ownerVisualWords(o) {
  if (!o?.visual) return '';
  const when = String(o.at || '').slice(0, 10);
  const who = o.permission ? `set by ${o.recordedBy || 'an agent'} on ${o.by}'s permission ("${String(o.permission).slice(0, 160)}")` : `set by ${o.by}${when ? ` on ${when}` : ''}`;
  const how = o.source === 'owner-signed' ? `owner-signed, ${o.file}` : `owner record in ${TYPE_RECORD_REL}${o.commit ? `, commit ${o.commit}` : ''}; not signed: the studio has no owner key yet`;
  return `visual proof: ${o.visual}, ${who} [${how}]: ${o.why}`;
}

/** Every reclassification (and, 2.60.1, visual-proof decision) on record, honoured or not, for the verify output: [{ task, line, ok }]. */
export function typeRecordLines() {
  const root = recordRoot();
  const rec = readRecord(root);
  const ids = new Set(Object.keys(rec.tasks));
  const vids = new Set(Object.keys(rec.visual || {}));
  for (const { dir } of approvalDirs()) {
    try { for (const f of fs.readdirSync(dir)) { const m = f.match(/^type-(.+)\.json$/); if (m) ids.add(m[1]); const v = f.match(/^visual-(.+)\.json$/); if (v) vids.add(v[1]); } } catch { /* none */ }
  }
  const types = [...ids].sort().map((task) => {
    const o = ownerType(task);
    return o?.type ? { task, ok: true, line: `${task} is a "${o.type}" task, ${ownerTypeWords(o)}` } : { task, ok: false, line: `${task}: a reclassification is on file but doesn't count: ${o?.ignored || 'no entry'}` };
  });
  const visuals = [...vids].sort().map((task) => {
    const o = ownerVisual(task);
    return o?.visual ? { task, ok: true, line: `${task}: ${ownerVisualWords(o)}` } : { task, ok: false, line: `${task}: a visual-proof decision is on file but doesn't count: ${o?.ignored || 'no entry'}` };
  });
  return [...types, ...visuals];
}

function sign(approval, pub) {
  const keyFile = ownerKeyPath();
  if (!fs.existsSync(keyFile)) throw new Error(`This studio has an owner key, so a reclassification must be signed, and there is no owner private key on this machine (${keyFile}). Nothing was written. ${OWNER_KEY_HOWTO}.`);
  const signature = crypto.sign(null, Buffer.from(canonicalBytes(approval)), crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))).toString('base64');
  if (!verifyApproval({ approval, signature }, pub)) throw new Error(`The private key at ${keyFile} doesn't match the studio's owner key (${'studio/keys/owner-ed25519.pub.pem'} on the base branch). Nothing was written.`);
  return signature;
}

/**
 * Record (or sign) the owner's reclassification. task: the board's task; from: its type by the title now.
 * Returns { ok, message, entry?, files? }.
 */
/** Who may record an owner decision: a person, or a Producer/Director/outside agent on a person's permission. */
function callerCheck(by, permission, env) {
  const perm = permissionText(permission);
  if (perm) {
    const onPerm = agentOnPermission({ permission: perm, env });
    if (!onPerm.ok) return { ok: false, message: `Refused: ${onPerm.why}. Nothing was recorded.` };
    const who = String(by || '').trim();
    if (!who || isAgentName(who)) return { ok: false, message: `--by names the person who gave permission${who ? `; "${who}" is an agent's name` : ''}. Nothing was recorded.` };
    return { ok: true, perm, onPerm };
  }
  const refusal = personRefusal(by, env);
  if (refusal) return { ok: false, message: refusal.replace('An agent hands the task back and asks', 'With the owner\'s direct permission a Producer or Director session, or an agent outside the harness, may record it: --by <the person> --permission "<their words or a link>". Otherwise an agent hands the task back and asks') };
  return { ok: true, perm, onPerm: null };
}

/** Commit the record files from this checkout: { committed, commitNote }. */
function commitRecord(files, msg, why) {
  if (git(REPO_ROOT, 'rev-parse', '--verify', 'HEAD').status !== 0) return { committed: false, commitNote: '' };
  const present = files.filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
  git(REPO_ROOT, 'add', '--', ...present);
  const known = files.filter((f) => present.includes(f) || git(REPO_ROOT, 'ls-files', '--error-unmatch', '--', f).status === 0);
  const r = git(REPO_ROOT, 'commit', '--only', '-m', msg, '-m', `Why: ${why}`, '--', ...known);
  const committed = r.status === 0;
  return { committed, commitNote: committed ? '' : ` Committing it failed (${String(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.status}`}): commit ${files.join(' and ')} yourself, from this terminal.` };
}

export function reclassify({ task, from, to, by, why, permission = '', commit = true, env = process.env }) {
  const who = callerCheck(by, permission, env);
  if (!who.ok) return { ok: false, message: who.message };
  const { perm, onPerm } = who;
  if (!task?.id) return { ok: false, message: 'No such task on the board.' };
  const target = String(to || '').toLowerCase();
  const auto = target === 'auto' || target === 'title';
  if (!auto && !RETYPABLE.includes(target)) return { ok: false, message: `"${to}" is not a type a reclassification can set. Types: ${RETYPABLE.join(', ')}, or auto (back to the title's type). To close a task without its check, the owner signs a force approval instead (npm run approve -- force ${task.id} --reason "…").` };
  if (String(why || '').trim().length < 10) return { ok: false, message: 'Say why, in 10+ characters: --why "<reason>" (it is shown in every done and verify output for this task).' };
  const at = new Date().toISOString();
  const entry = { type: target, from, title: task.title, by: String(by).trim(), why: String(why).trim(), at, ...(onPerm ? { permission: perm.slice(0, 500), recordedBy: onPerm.recordedBy } : {}) };
  const files = [TYPE_RECORD_REL];
  const pub = ownerKey();
  if (pub && onPerm && onPerm.via !== 'person') return { ok: false, message: `This studio has an owner key, so a reclassification is signed with it on the owner's device; a permission line isn't a signature. Nothing was recorded. The owner runs: npm run task -- type ${task.id} ${target} --by <name> --why "…"` };
  const approvalRel = `${APPROVALS_REL}/${approvalName(task.id)}`;
  if (pub && !auto) {
    const approval = { kind: 'type', task: task.id, from, to: target, title: task.title, by: entry.by, why: entry.why, at };
    let signature;
    try { signature = sign(approval, pub); } catch (e) { return { ok: false, message: e.message }; }
    fs.mkdirSync(path.join(REPO_ROOT, APPROVALS_REL), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, approvalRel), `${JSON.stringify({ approval, signature }, null, 2)}\n`);
    entry.approval = approvalRel;
    files.push(approvalRel);
  }
  const rec = readRecord(REPO_ROOT);
  rec.note = NOTE;
  if (auto) {
    delete rec.tasks[task.id];
    if (fs.existsSync(path.join(REPO_ROOT, approvalRel))) { fs.rmSync(path.join(REPO_ROOT, approvalRel)); files.push(approvalRel); }
  } else rec.tasks[task.id] = entry;
  fs.mkdirSync(path.join(REPO_ROOT, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, TYPE_RECORD_REL), `${JSON.stringify(rec, null, 2)}\n`);
  memo.delete(`type|${task.id}`);
  emitEvent({ type: 'task.retyped', agent: entry.by, task: task.id, msg: auto ? `${entry.by} put ${task.id} back to its title's type (${from}): ${entry.why}` : `${entry.by} reclassified ${task.id} from ${from} to ${target}${pub ? ' (signed)' : ' (recorded; no owner key yet)'}: ${entry.why}`.slice(0, 400), meta: { from, to: auto ? from : target, signed: Boolean(pub && !auto), at } });
  const msg = auto ? `${task.id}: back to the title's type (${from}), by ${entry.by}` : `${task.id}: owner reclassified it from ${from} to ${target} (${entry.by})`;
  const { committed, commitNote } = commit ? commitRecord(files, msg, entry.why) : { committed: false, commitNote: '' };
  const counts = pub ? 'It counts once the approval file is on the studio\'s main branch.' : 'It counts once committed (from your terminal, not an agent\'s); until the studio has an owner key it is a record, not a signature.';
  return {
    ok: true,
    entry,
    files,
    committed,
    message: `${auto ? `${task.id} goes back to its title's type (${from}).` : `${task.id} is now a "${target}" task (the title says ${from}), ${pub ? 'signed with the owner key' : 'recorded'} by ${entry.by}: ${entry.why}`} ${committed ? `Committed ${files.join(' and ')}.` : commit ? '' : `Not committed (--no-commit): commit ${files.join(' and ')} yourself.`}${commitNote} ${auto ? '' : counts}`.replace(/\s+/g, ' ').trim(),
  };
}

/**
 * 2.60.1 (B-38): record (or sign) the owner's visual-proof decision for a task: to = off | on | auto (remove it).
 * The same callers as a reclassification (callerCheck), the same file, the same commit, the same signing with an owner key.
 */
export function setVisual({ task, to, by, why, permission = '', commit = true, env = process.env }) {
  const who = callerCheck(by, permission, env);
  if (!who.ok) return { ok: false, message: who.message };
  const { perm, onPerm } = who;
  if (!task?.id) return { ok: false, message: 'No such task on the board.' };
  const target = String(to || '').toLowerCase();
  const auto = target === 'auto';
  if (!['off', 'on', 'auto'].includes(target)) return { ok: false, message: `"${to}" is not off, on or auto. off: this task needs no visual result; on: it needs one whatever its title says; auto: back to the detection.` };
  if (String(why || '').trim().length < 10) return { ok: false, message: 'Say why, in 10+ characters: --why "<reason>" (it is shown in every done-check and verify output for this task).' };
  const at = new Date().toISOString();
  const entry = { visual: target, title: task.title, by: String(by).trim(), why: String(why).trim(), at, ...(onPerm ? { permission: perm.slice(0, 500), recordedBy: onPerm.recordedBy } : {}) };
  const files = [TYPE_RECORD_REL];
  const pub = ownerKey();
  if (pub && onPerm && onPerm.via !== 'person') return { ok: false, message: `This studio has an owner key, so a visual-proof decision is signed with it on the owner's device; a permission line isn't a signature. Nothing was recorded. The owner runs: npm run task -- visual ${task.id} ${target} --by <name> --why "…"` };
  const approvalRel = `${APPROVALS_REL}/${approvalName(task.id, 'visual')}`;
  if (pub && !auto) {
    const approval = { kind: 'visual', task: task.id, to: target, title: task.title, by: entry.by, why: entry.why, at };
    let signature;
    try { signature = sign(approval, pub); } catch (e) { return { ok: false, message: e.message }; }
    fs.mkdirSync(path.join(REPO_ROOT, APPROVALS_REL), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, approvalRel), `${JSON.stringify({ approval, signature }, null, 2)}\n`);
    entry.approval = approvalRel;
    files.push(approvalRel);
  }
  const rec = readRecord(REPO_ROOT);
  rec.note = NOTE;
  rec.visual = rec.visual && typeof rec.visual === 'object' ? rec.visual : {};
  if (auto) {
    delete rec.visual[task.id];
    if (fs.existsSync(path.join(REPO_ROOT, approvalRel))) { fs.rmSync(path.join(REPO_ROOT, approvalRel)); files.push(approvalRel); }
  } else rec.visual[task.id] = entry;
  if (!Object.keys(rec.visual).length) delete rec.visual;
  fs.mkdirSync(path.join(REPO_ROOT, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(REPO_ROOT, TYPE_RECORD_REL), `${JSON.stringify(rec, null, 2)}\n`);
  memo.delete(`visual|${task.id}`);
  const words = auto ? `${entry.by} put ${task.id}'s visual proof back to the detection: ${entry.why}` : `${onPerm ? `${onPerm.recordedBy} on ${entry.by}'s permission` : entry.by} set ${task.id}'s visual proof ${target}${pub ? ' (signed)' : ' (recorded; no owner key yet)'}: ${entry.why}`;
  emitEvent({ type: 'task.visual_set', agent: onPerm ? onPerm.recordedBy : entry.by, task: task.id, msg: words.slice(0, 400), meta: { to: target, by: entry.by, signed: Boolean(pub && !auto), at, ...(onPerm ? { permission: entry.permission, recordedBy: entry.recordedBy } : {}) } });
  const msg = auto ? `${task.id}: visual proof back to the detection, by ${entry.by}` : `${task.id}: owner set visual proof ${target} (${entry.by})`;
  const { committed, commitNote } = commit ? commitRecord(files, msg, entry.why) : { committed: false, commitNote: '' };
  const counts = pub ? 'It counts once the approval file is on the studio\'s main branch.' : 'It counts once committed (by a person, or by the Producer/Director/outside agent that recorded it on permission; never a worker\'s commit); until the studio has an owner key it is a record, not a signature.';
  return {
    ok: true,
    entry,
    files,
    committed,
    message: `${words}. ${committed ? `Committed ${files.join(' and ')}.` : commit ? '' : `Not committed (--no-commit): commit ${files.join(' and ')} yourself.`}${commitNote} ${auto ? '' : counts}`.replace(/\s+/g, ' ').trim(),
  };
}
