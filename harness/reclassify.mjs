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
const approvalName = (taskId) => `type-${String(taskId).replace(/[^\w.-]/g, '_')}.json`;
/** The newest signed reclassification of this task that verifies against the owner key. */
function signedApproval(taskId, pub) {
  const found = [];
  for (const { root, dir } of approvalDirs()) {
    const full = path.join(dir, approvalName(taskId));
    const doc = readJson(full);
    if (doc?.approval?.kind === 'type' && doc.approval.task === taskId && verifyApproval(doc, pub)) found.push({ ...doc, file: path.relative(root, full).split(path.sep).join('/') });
  }
  return found.sort((a, b) => String(b.approval.at).localeCompare(String(a.approval.at)))[0] || null;
}

const entryAt = (root, rev, taskId) => {
  const r = git(root, 'show', `${rev}:${TYPE_RECORD_REL}`);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout)?.tasks?.[taskId] || null; } catch { return null; }
};
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
/** The commit that set this task's committed entry, and whether it is an agent's: { sha, agent } or null. */
function setterOf(root, taskId, entry) {
  const log = git(root, 'log', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', '-n', '200', '--', TYPE_RECORD_REL);
  if (log.status !== 0) return null;
  for (const line of log.stdout.split('\n').filter(Boolean)) {
    const [sha, agent] = line.split('\t');
    if (!same(entryAt(root, sha, taskId), entry)) continue;
    if (!same(entryAt(root, `${sha}^`, taskId), entry)) return { sha, agent: String(agent || '').trim() || null };
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

const memo = new Map();
/**
 * The owner's type for this task: { type, from, by, why, at, source: 'owner-signed' | 'owner record', file, commit },
 * { ignored: why } when a record exists but doesn't count, or null (the title decides).
 */
export function ownerType(taskId) {
  if (!taskId) return null;
  const root = recordRoot();
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const key = `${taskId}|${stamp(path.join(root, TYPE_RECORD_REL))}|${approvalDirs().map(({ dir }) => stamp(path.join(dir, approvalName(taskId)))).join(',')}`;
  const hit = memo.get(taskId);
  if (hit && hit.key === key && Date.now() - hit.at < 5000) return hit.value;
  const value = resolveOwnerType(taskId, root);
  memo.set(taskId, { key, at: Date.now(), value });
  return value;
}
function resolveOwnerType(taskId, root) {
  const work = readRecord(root).tasks[taskId] || null;
  const hasApproval = approvalDirs().some(({ dir }) => fs.existsSync(path.join(dir, approvalName(taskId))));
  if (!work && !hasApproval) {
    // Cheap common case: nothing on disk names this task. A committed entry removed from the working tree only makes
    // the check stricter, so it is not looked up.
    return null;
  }
  const pub = ownerKey();
  if (pub) {
    const a = signedApproval(taskId, pub);
    if (a) return { type: a.approval.to, from: a.approval.from, by: a.approval.by, why: a.approval.why, at: a.approval.at, source: 'owner-signed', file: a.file };
    return { ignored: `${TYPE_RECORD_REL} or ${APPROVALS_REL}/ names ${taskId}, but this studio has an owner key, so a reclassification counts only when it is signed with it (the owner runs npm run task -- type ${taskId} <type> --by <name> --why "…" on the device that holds the key)` };
  }
  const isGit = git(root, 'rev-parse', '--verify', 'HEAD').status === 0;
  if (!isGit) {
    const bad = validEntry(work);
    return bad ? { ignored: `${TYPE_RECORD_REL} names ${taskId}, but ${bad}` } : { ...work, source: 'owner record', commit: null, note: 'not a git checkout: who wrote it can\'t be checked' };
  }
  const committed = entryAt(root, 'HEAD', taskId);
  if (!committed) return { ignored: `${TYPE_RECORD_REL} names ${taskId} but isn't committed yet${inLaneCopy() ? ' on the main checkout' : ''}: the owner commits it (the type command does, unless --no-commit), then it counts` };
  const bad = validEntry(committed);
  if (bad) return { ignored: `${TYPE_RECORD_REL} names ${taskId}, but ${bad}` };
  const setter = setterOf(root, taskId, committed);
  if (!setter) return { ignored: `${TYPE_RECORD_REL}: the commit that set ${taskId}'s entry wasn't found, so who wrote it can't be checked` };
  // 2.59.1: an agent's commit counts when the entry says it was recorded on a person's permission, by that agent, and
  // the agent isn't a worker (harness/permission.mjs).
  if (setter.agent && permissionText(committed.permission).length >= 10 && permittedSetter(setter.agent) && String(committed.recordedBy || '') === setter.agent) {
    return { ...committed, source: 'owner record', onPermission: true, commit: setter.sha.slice(0, 8), ...(same(work, committed) ? {} : { note: `the working copy of ${TYPE_RECORD_REL} differs from the committed one, which is what counts` }) };
  }
  if (setter.agent) return { ignored: `${TYPE_RECORD_REL}: ${taskId}'s entry was set by commit ${setter.sha.slice(0, 8)} of the agent ${setter.agent} (Studio-Agent trailer); only the owner reclassifies a task (npm run task -- type, from the owner's own terminal)` };
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

/** Every reclassification on record, honoured or not, for the verify output: [{ task, line, ok }]. */
export function typeRecordLines() {
  const root = recordRoot();
  const ids = new Set(Object.keys(readRecord(root).tasks));
  for (const { dir } of approvalDirs()) {
    try { for (const f of fs.readdirSync(dir)) { const m = f.match(/^type-(.+)\.json$/); if (m) ids.add(m[1]); } } catch { /* none */ }
  }
  return [...ids].sort().map((task) => {
    const o = ownerType(task);
    return o?.type ? { task, ok: true, line: `${task} is a "${o.type}" task, ${ownerTypeWords(o)}` } : { task, ok: false, line: `${task}: a reclassification is on file but doesn't count: ${o?.ignored || 'no entry'}` };
  });
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
export function reclassify({ task, from, to, by, why, permission = '', commit = true, env = process.env }) {
  const perm = permissionText(permission);
  let onPerm = null;
  if (perm) {
    onPerm = agentOnPermission({ permission: perm, env });
    if (!onPerm.ok) return { ok: false, message: `Refused: ${onPerm.why}. Nothing was recorded.` };
    const who = String(by || '').trim();
    if (!who || isAgentName(who)) return { ok: false, message: `--by names the person who gave permission${who ? `; "${who}" is an agent's name` : ''}. Nothing was recorded.` };
  } else {
    const refusal = personRefusal(by, env);
    if (refusal) return { ok: false, message: refusal.replace('An agent hands the task back and asks', 'With the owner\'s direct permission a Producer or Director session, or an agent outside the harness, may record it: --by <the person> --permission "<their words or a link>". Otherwise an agent hands the task back and asks') };
  }
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
  memo.delete(task.id);
  emitEvent({ type: 'task.retyped', agent: entry.by, task: task.id, msg: auto ? `${entry.by} put ${task.id} back to its title's type (${from}): ${entry.why}` : `${entry.by} reclassified ${task.id} from ${from} to ${target}${pub ? ' (signed)' : ' (recorded; no owner key yet)'}: ${entry.why}`.slice(0, 400), meta: { from, to: auto ? from : target, signed: Boolean(pub && !auto), at } });
  let committed = false;
  let commitNote = '';
  if (commit && git(REPO_ROOT, 'rev-parse', '--verify', 'HEAD').status === 0) {
    const present = files.filter((f) => fs.existsSync(path.join(REPO_ROOT, f)));
    git(REPO_ROOT, 'add', '--', ...present);
    const known = files.filter((f) => present.includes(f) || git(REPO_ROOT, 'ls-files', '--error-unmatch', '--', f).status === 0);
    const msg = auto ? `${task.id}: back to the title's type (${from}), by ${entry.by}` : `${task.id}: owner reclassified it from ${from} to ${target} (${entry.by})`;
    const r = git(REPO_ROOT, 'commit', '--only', '-m', msg, '-m', `Why: ${entry.why}`, '--', ...known);
    committed = r.status === 0;
    if (!committed) commitNote = ` Committing it failed (${String(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.status}`}): commit ${files.join(' and ')} yourself, from this terminal.`;
  }
  const counts = pub ? 'It counts once the approval file is on the studio\'s main branch.' : 'It counts once committed (from your terminal, not an agent\'s); until the studio has an owner key it is a record, not a signature.';
  return {
    ok: true,
    entry,
    files,
    committed,
    message: `${auto ? `${task.id} goes back to its title's type (${from}).` : `${task.id} is now a "${target}" task (the title says ${from}), ${pub ? 'signed with the owner key' : 'recorded'} by ${entry.by}: ${entry.why}`} ${committed ? `Committed ${files.join(' and ')}.` : commit ? '' : `Not committed (--no-commit): commit ${files.join(' and ')} yourself.`}${commitNote} ${auto ? '' : counts}`.replace(/\s+/g, ' ').trim(),
  };
}
