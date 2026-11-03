#!/usr/bin/env node
/**
 * harness/delegation.mjs — 2.67.0: the owner's standing delegation to one outside agent (the crew's orchestrator).
 *
 * The owner's direction: "an outside agent should do what a game dev can do". Recording the owner's words for every
 * tier-C release (--permission "…", harness/permission.mjs) costs an owner round-trip each time. Instead the owner, in
 * their own terminal, grants one named outside agent a short list of owner actions for a few hours:
 *
 *   npm run delegate -- grant <agent> --actions train-release,type,yes,hold --hours 12 --by <owner> [--why "…"] [--no-commit]
 *   npm run delegate -- list                       the delegation on file, whether it counts, and why
 *   npm run delegate -- revoke [--by <name>]       remove it (anyone may: it only takes power away)
 *   npm run delegate -- claude-settings [--write] [--remove] [--actions …]
 *                                                  the narrow Claude Code allow rules for exactly those commands
 *
 * studio/delegation.json holds { agent, actions, until, by, at, why } (and, with an owner key, the owner's signature).
 * It is on the shipped protected list (approve.mjs DEFAULT_PROTECTED, so tiers.mjs SHIPPED_PROTECTED), so a lane that
 * writes it is tier C and an agent can't grant itself one.
 *
 * When it counts (readDelegation): it is read as committed in the main checkout (HEAD), never from a lane copy.
 *   - The studio has an owner key (studio/keys/owner-ed25519.pub.pem): only with a valid signature by that key
 *     (signed where the private key is, STUDIO_OWNER_KEY / ~/.studio-owner/); a changed or unsigned file is ignored.
 *   - No owner key yet: only when the commit that set it is not an agent's (no Studio-Agent trailer), like the owner's
 *     type record (harness/reclassify.mjs). A speed bump, not a lock, until the owner key exists.
 *
 * What it covers (delegationFor): while it is valid, the named agent runs exactly the listed actions with
 * `--by <agent>` and no per-action permission words. Each use is recorded as before (who, why) with the words
 * "under delegation <at> by <owner>", plus one delegation.used event that the daily digest counts. Never covered:
 * signing protected-file approvals (npm run approve), gates or the protected list, money; workers, launched sessions
 * (STUDIO_ROLE) and lane copies.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitEvent, readRecentEvents } from './event.mjs';
import { canonicalBytes } from './hash.mjs';
import { mainRoot, inLaneCopy } from './worktree.mjs';
import { OWNER_PUB_REL, ownerKeyPath, verifyApproval, OWNER_KEY_HOWTO } from './approve.mjs';
import { WORKER_NAME, AGENT_SHELL } from './permission.mjs';
import { agentLikeName, launchedSession } from './agent-env.mjs';
import { autonomousFor, policyNeverWhy, embeddedAutonomyOk } from './policy-rules.mjs';
import { logDecision } from './decisions-log.mjs';

export const DELEGATION_REL = 'studio/delegation.json';
/**
 * The owner actions a delegation can cover. `hold` covers hold and unhold; `upgrade-auto` (2.69.0) the auto-upgrade
 * switch; `asset-review` (2.70.0) answering an asset's preview review (npm run asset -- review, harness/asset-review.mjs);
 * `janitor-lanes` (2.70.0) deleting the stale lane copies the janitor proposes (npm run janitor -- --lanes --yes).
 */
export const DELEGABLE = ['train-release', 'type', 'visual', 'yes', 'hold', 'upgrade-auto', 'asset-review', 'janitor-lanes'];
export const NEVER_DELEGATED = 'signing protected-file approvals (npm run approve), changing gates or the protected list, and money';
export const MAX_HOURS = 72;
const FIELDS = ['agent', 'actions', 'until', 'by', 'at', 'why'];
const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const body = (d) => Object.fromEntries(FIELDS.map((k) => [k, d[k]]));
const short = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');

/** The commands each action names (npm and node forms), for the Claude Code allow rules. */
export const ACTION_COMMANDS = {
  'train-release': ['train release'],
  type: ['type'],
  visual: ['visual'],
  yes: ['yes'],
  hold: ['hold', 'unhold'],
  // 2.69.0 (s): `npm run upgrade -- watch auto on` (harness/upgrade-watch.mjs); not a task command, so no allow rule.
  'upgrade-auto': [],
  // 2.70.0 (v): `npm run asset -- review` (harness/asset-review.mjs); not a task command, so no allow rule.
  'asset-review': [],
  // 2.70.0 (w): `npm run janitor -- --lanes --yes --by <agent>` (harness/janitor.mjs); not a task command, so no allow rule.
  'janitor-lanes': [],
};

/**
 * Why this shell may not act as the owner (grant, claude-settings --write), or ''. The checks permission.mjs and the
 * release rule use for agents: a launched session, a lane copy, a coding agent's shell, an agent's name in
 * STUDIO_LOCK_OWNER or STUDIO_AGENT, a worker's name.
 */
export function ownerShellRefusal({ env = process.env, lane = inLaneCopy() } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role) return `this runs inside a launched ${role} session (STUDIO_ROLE is set)`;
  if (lane) return 'this runs in a lane copy, not the studio\'s main checkout';
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (marker) return `this shell is run by a coding agent (${marker} is set)`;
  const asAgent = String(env.STUDIO_AGENT || '').trim();
  if (asAgent) return `this shell works as an agent (STUDIO_AGENT=${asAgent.slice(0, 40)})`;
  const lockOwner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (lockOwner && (WORKER_NAME.test(lockOwner) || agentLikeName(lockOwner, { stateDir: path.join(mainRoot(), '.studio') }))) return `this shell works as an agent (STUDIO_LOCK_OWNER=${lockOwner.slice(0, 40)})`;
  return launchedSession(env) || '';
}

function ownerPub(root) {
  const r = git(root, 'show', `HEAD:${OWNER_PUB_REL}`);
  const pem = r.status === 0 ? r.stdout : (fs.existsSync(path.join(root, OWNER_PUB_REL)) ? fs.readFileSync(path.join(root, OWNER_PUB_REL), 'utf8') : '');
  return /BEGIN PUBLIC KEY/.test(pem || '') ? pem : null;
}

function shapeError(d) {
  if (!d || typeof d !== 'object') return 'it isn\'t a JSON object';
  if (!/^[\w.-]{1,60}$/.test(String(d.agent || ''))) return 'it names no agent';
  if (!Array.isArray(d.actions) || !d.actions.length || d.actions.some((a) => !DELEGABLE.includes(a))) return `its actions must be some of ${DELEGABLE.join(', ')}`;
  if (!Number.isFinite(Date.parse(d.until)) || !Number.isFinite(Date.parse(d.at))) return 'it has no valid at/until times';
  if (!String(d.by || '').trim()) return 'it doesn\'t say which person granted it';
  if (WORKER_NAME.test(d.agent)) return `${d.agent} is a worker agent's name; workers are never covered`;
  return '';
}

/**
 * The delegation on file and whether it counts: { doc, ok, why, signed, commit, note }. `ok` also needs the time window
 * (now between at and until). Never throws.
 */
export function readDelegation({ root = mainRoot(), now = Date.now() } = {}) {
  const isGit = git(root, 'rev-parse', '--verify', 'HEAD').status === 0;
  const work = fs.existsSync(path.join(root, DELEGATION_REL)) ? fs.readFileSync(path.join(root, DELEGATION_REL), 'utf8') : null;
  const shown = isGit ? git(root, 'show', `HEAD:${DELEGATION_REL}`) : null;
  const text = isGit ? (shown.status === 0 ? shown.stdout : null) : work;
  if (text == null) return { doc: null, ok: false, why: work != null ? `${DELEGATION_REL} isn't committed: it counts once the owner commits it (npm run delegate -- grant does)` : 'no delegation on file' };
  let doc;
  try { doc = JSON.parse(text); } catch { return { doc: null, ok: false, why: `${DELEGATION_REL} isn't valid JSON` }; }
  const bad = shapeError(doc);
  if (bad) return { doc, ok: false, why: `${DELEGATION_REL} doesn't count: ${bad}` };
  const note = isGit && work != null && work !== text ? `the working copy of ${DELEGATION_REL} differs from the committed one, which is what counts` : '';
  const pub = ownerPub(root);
  let signed = false;
  let commit = null;
  if (pub) {
    if (!doc.signature || !verifyApproval({ approval: body(doc), signature: doc.signature }, pub)) return { doc, ok: false, why: `${DELEGATION_REL} doesn't count: this studio has an owner key and the file has no valid signature by it (unsigned, or changed after it was signed)` };
    signed = true;
  } else {
    if (!isGit) return { doc, ok: false, why: `${DELEGATION_REL} doesn't count: not a git checkout, so who wrote it can't be checked` };
    const log = git(root, 'log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', 'HEAD', '--', DELEGATION_REL);
    const [sha = '', agent = ''] = String(log.stdout || '').trim().split('\t');
    if (!sha) return { doc, ok: false, why: `${DELEGATION_REL}: the commit that set it wasn't found` };
    commit = sha.slice(0, 8);
    if (agent.trim()) return { doc, ok: false, commit, why: `${DELEGATION_REL} doesn't count: commit ${commit} that set it is the agent ${agent.trim()}'s (Studio-Agent trailer); only the owner grants a delegation, from their own terminal` };
  }
  const t = Number(now);
  if (t > Date.parse(doc.until)) return { doc, ok: false, signed, commit, note, why: `the delegation to ${doc.agent} by ${doc.by} ended at ${short(doc.until)}` };
  if (t < Date.parse(doc.at) - 5 * 60000) return { doc, ok: false, signed, commit, note, why: `the delegation to ${doc.agent} starts at ${short(doc.at)}` };
  return { doc, ok: true, signed, commit, note, why: '' };
}

/** The words every record made under it carries. */
export const delegationWords = (doc) => `under delegation ${doc.at} by ${doc.by}${doc.why ? `: ${String(doc.why).slice(0, 200)}` : ''}`;

/**
 * Does a valid delegation let this caller run this action as `by`? { ok: true, owner, agent, at, until, signed,
 * permission } or { ok: false, why } (why is '' when `by` isn't the delegated agent at all: the caller's normal rules
 * apply and nothing about a delegation needs saying).
 */
export function delegationFor({ action, by, env = process.env, root = mainRoot(), now = Date.now(), lane = inLaneCopy(), autonomy = true } = {}) {
  const d = delegationOnly({ action, by, env, root, now, lane });
  // 2.71.0 (x): the studio policy's "never" rules an action out for every agent, a delegated one included.
  const never = d.ok ? policyNeverWhy(action, { root }) : '';
  if (never) return { ok: false, why: `no delegation applies: ${never}` };
  if (d.ok || !autonomy) return d;
  // 2.71.0 (x): autonomous mode (studio/policy.json, harness/policy.mjs): the overseer takes the listed game-dev
  // decisions itself; each is logged "autonomous" and put on the review list. Same shape as a delegation, autonomous: true.
  const a = autonomousFor({ action, by, env, root, lane });
  if (a.ok) return a;
  return { ok: false, why: d.why || a.why };
}
function delegationOnly({ action, by, env, root, now, lane }) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: '' };
  const d = readDelegation({ root, now });
  if (!d.doc) return { ok: false, why: '' };
  if (who.toLowerCase() !== String(d.doc.agent).toLowerCase()) return { ok: false, why: '' };
  if (!d.ok) return { ok: false, why: `no delegation applies: ${d.why}` };
  if (!d.doc.actions.includes(action)) return { ok: false, why: `no delegation applies: the delegation to ${d.doc.agent} covers ${d.doc.actions.join(', ')}, not ${action}` };
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role) return { ok: false, why: `no delegation applies: a launched ${role} session is never covered` };
  if (lane) return { ok: false, why: 'no delegation applies: a lane copy is never covered' };
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const worker = [who, owner].find((n) => n && WORKER_NAME.test(n));
  if (worker) return { ok: false, why: `no delegation applies: ${worker} is a worker agent` };
  if (owner && owner.toLowerCase() !== who.toLowerCase()) return { ok: false, why: `no delegation applies: this shell works as ${owner}, not ${d.doc.agent}` };
  return { ok: true, owner: String(d.doc.by), agent: String(d.doc.agent), at: d.doc.at, until: d.doc.until, signed: d.signed, permission: delegationWords(d.doc).slice(0, 500), why: '', doc: d.doc };
}

/**
 * A signed delegation copied into a record (harness/reclassify.mjs keeps it with an entry made under it, so the entry
 * still verifies after the delegation ends): the owner's signature verifies, it covers this action and agent, and the
 * entry's time is inside its window.
 */
export function embeddedDelegationOk(doc, pub, { action, agent, at } = {}) {
  if (doc?.autonomous) return embeddedAutonomyOk(doc, pub, { action, agent, at }); // 2.71.0 (x): a signed policy
  if (!doc || shapeError(doc) || !doc.signature || !pub) return false;
  if (!verifyApproval({ approval: body(doc), signature: doc.signature }, pub)) return false;
  const t = Date.parse(at);
  return doc.actions.includes(action) && String(agent || '').toLowerCase() === String(doc.agent).toLowerCase() && t >= Date.parse(doc.at) - 5 * 60000 && t <= Date.parse(doc.until);
}

/** One delegation.used event per use (the daily digest counts them). */
export function recordUse(d, { action, task = null, detail = '' } = {}) {
  if (d?.autonomous) return; // 2.71.0 (x): an autonomous decision's record is the decision log's (harness/decisions.mjs)
  try {
    emitEvent({ type: 'delegation.used', agent: d.agent, task, to: d.owner, msg: `${d.agent} ran ${action}${task ? ` ${task}` : ''} ${delegationWords({ at: d.at, by: d.owner })}${detail ? ` (${detail})` : ''}`.slice(0, 400), meta: { action, owner: d.owner, at: d.at, until: d.until, signed: Boolean(d.signed) } });
  } catch { /* the record of the action itself is written by the action */ }
}

/** The digest's line: delegated actions used in the last 24 h, and whether a delegation counts now. '' when none. */
export function delegationDigestLine({ events = null, now = Date.now(), root = mainRoot() } = {}) {
  const ev = (events || readRecentEvents(20000)).filter((e) => e.type === 'delegation.used' && (Date.parse(e.ts) || 0) >= now - 86400000);
  const d = readDelegation({ root, now });
  if (!ev.length && !d.doc) return '';
  const by = {};
  for (const e of ev) { const k = e.meta?.action || 'action'; by[k] = (by[k] || 0) + 1; }
  const used = ev.length ? `${ev.length} owner action${ev.length === 1 ? '' : 's'} run under delegation in 24 h (${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ')}).` : 'No owner action run under delegation in 24 h.';
  const state = d.ok ? ` Delegation to ${d.doc.agent} by ${d.doc.by} counts until ${short(d.doc.until)} (npm run delegate -- revoke ends it).` : d.doc ? ` The delegation on file doesn't count: ${d.why}.` : '';
  return `${used}${state}`;
}

function commitFile(root, msg, why) {
  if (git(root, 'rev-parse', '--verify', 'HEAD').status !== 0) return { committed: false, note: ' Not a git checkout: nothing committed.' };
  const present = fs.existsSync(path.join(root, DELEGATION_REL));
  if (present) git(root, 'add', '--', DELEGATION_REL);
  else if (git(root, 'ls-files', '--error-unmatch', '--', DELEGATION_REL).status !== 0) return { committed: false, note: '' };
  else git(root, 'rm', '-q', '--cached', '--', DELEGATION_REL);
  const r = git(root, 'commit', '--only', '-m', msg, '-m', `Why: ${why}`, '--', DELEGATION_REL);
  return r.status === 0 ? { committed: true, note: '' } : { committed: false, note: ` Committing it failed (${String(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.status}`}): commit ${DELEGATION_REL} yourself, from this terminal.` };
}

/** `delegate grant`: the owner, in their own terminal. Returns { ok, message, doc? }. */
export function grantDelegation({ agent, actions, hours, by, why = '', commit = true, env = process.env, root = mainRoot(), lane = inLaneCopy(), now = Date.now() } = {}) {
  const refuse = (m) => ({ ok: false, message: `Not granted: ${m}. Only the owner grants a delegation, in their own terminal (npm run delegate -- grant <agent> --actions … --hours N --by <owner>); an agent never grants itself one.` });
  const shell = ownerShellRefusal({ env, lane });
  if (shell) return refuse(shell);
  const owner = String(by || '').trim();
  if (!owner) return refuse('say who grants it: --by <your name>');
  if (agentLikeName(owner, { stateDir: path.join(root, '.studio') })) return refuse(`"${owner}" is an agent's name; --by names the person who grants it`);
  const name = String(agent || '').trim();
  if (!/^[\w.-]{1,60}$/.test(name)) return refuse('name the outside agent: grant <agent-name>');
  if (WORKER_NAME.test(name)) return refuse(`${name} is a worker agent's name; workers and launched sessions are never covered`);
  const list = [...new Set(String(actions || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const unknown = list.filter((a) => !DELEGABLE.includes(a));
  if (!list.length || unknown.length) return refuse(`${unknown.length ? `${unknown.join(', ')} can't be delegated` : 'say which actions'}: --actions takes some of ${DELEGABLE.join(', ')} (never ${NEVER_DELEGATED})`);
  const h = Number(hours);
  if (!(h > 0 && h <= MAX_HOURS)) return refuse(`--hours takes how long it lasts, more than 0 and at most ${MAX_HOURS}`);
  const at = new Date(now).toISOString();
  const doc = { agent: name, actions: list, until: new Date(now + h * 3600000).toISOString(), by: owner.slice(0, 60), at, why: String(why || '').trim().slice(0, 300) || 'the owner\'s standing delegation (npm run delegate)' };
  const pub = ownerPub(root);
  if (pub) {
    const keyFile = ownerKeyPath(env);
    if (!fs.existsSync(keyFile)) return refuse(`this studio has an owner key, so a delegation is signed with it, and there is no owner private key on this machine (${keyFile}). Run the grant on the device that holds the key and commit ${DELEGATION_REL}. ${OWNER_KEY_HOWTO}`);
    try {
      doc.signature = crypto.sign(null, Buffer.from(canonicalBytes(body(doc))), crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))).toString('base64');
    } catch (e) { return refuse(`signing failed (${e.message})`); }
    if (!verifyApproval({ approval: body(doc), signature: doc.signature }, pub)) return refuse(`the private key at ${keyFile} doesn't match the studio's owner key (${OWNER_PUB_REL})`);
  }
  fs.mkdirSync(path.join(root, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(root, DELEGATION_REL), `${JSON.stringify(doc, null, 2)}\n`);
  const c = commit ? commitFile(root, `delegate: ${doc.by} lets ${name} run ${list.join(', ')} until ${doc.until}`, doc.why) : { committed: false, note: ` Not committed (--no-commit): it counts once you commit ${DELEGATION_REL} from this terminal.` };
  emitEvent({ type: 'delegation.granted', agent: doc.by, to: name, msg: `${doc.by} lets ${name} run ${list.join(', ')} until ${short(doc.until)}${pub ? ' (signed)' : ''}: ${doc.why}`.slice(0, 400), meta: { agent: name, actions: list, at, until: doc.until, signed: Boolean(pub) } });
  logDecision({ action: 'delegate', subject: DELEGATION_REL, by: doc.by, as: 'person', why: doc.why, evidence: `${name}: ${list.join(', ')} until ${short(doc.until)}`, undo: { kind: 'text', text: 'npm run delegate -- revoke --by <name>' }, root });
  return { ok: true, doc, committed: c.committed, message: `${name} may run ${list.join(', ')} with --by ${name} until ${short(doc.until)} (${h} h), ${pub ? 'signed with the owner key' : 'recorded (no owner key yet: a record, not a signature)'}. ${c.committed ? `Committed ${DELEGATION_REL}.` : ''}${c.note} Every use is recorded "${delegationWords(doc).slice(0, 80)}…" and shows in the digest. Never covered: ${NEVER_DELEGATED}. Claude Code rules for these commands: npm run delegate -- claude-settings.`.replace(/\s+/g, ' ').trim() };
}

/** `delegate revoke`: anyone (it only takes power away); never from a lane copy. */
export function revokeDelegation({ by = '', commit = true, env = process.env, root = mainRoot(), lane = inLaneCopy() } = {}) {
  if (lane) return { ok: false, message: 'Run revoke in the studio\'s main checkout, not a lane copy.' };
  const f = path.join(root, DELEGATION_REL);
  const tracked = git(root, 'ls-files', '--error-unmatch', '--', DELEGATION_REL).status === 0;
  if (!fs.existsSync(f) && !tracked) return { ok: true, message: 'No delegation on file.' };
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* gone or unreadable */ }
  try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  const who = String(by || env.STUDIO_LOCK_OWNER || env.USER || env.USERNAME || 'someone').trim().slice(0, 60);
  const c = commit ? commitFile(root, `delegate: revoked${doc?.agent ? ` (${doc.agent})` : ''} by ${who}`, 'revoked') : { committed: false, note: ` Not committed (--no-commit): commit the removal of ${DELEGATION_REL}.` };
  emitEvent({ type: 'delegation.revoked', agent: who, to: doc?.agent || null, msg: `${who} revoked the delegation${doc?.agent ? ` to ${doc.agent}` : ''}`, meta: { agent: doc?.agent || null, at: doc?.at || null } });
  logDecision({ action: 'delegate', subject: DELEGATION_REL, by: who, as: 'person', why: `revoked${doc?.agent ? ` the delegation to ${doc.agent}` : ''}`, evidence: 'revoke', undo: null, root });
  return { ok: true, message: `Revoked${doc?.agent ? ` the delegation to ${doc.agent}` : ''}. ${c.committed ? `Committed the removal of ${DELEGATION_REL}.` : ''}${c.note} The Claude Code allow rules stay until removed: npm run delegate -- claude-settings --remove --write.`.replace(/\s+/g, ' ').trim() };
}

/** The narrow Claude Code allow rules for these actions: npm and node forms, prefix rules only. */
export function claudeRules(actions) {
  const out = [];
  for (const a of actions) for (const c of ACTION_COMMANDS[a] || []) out.push(`Bash(npm run task -- ${c}:*)`, `Bash(node harness/task.mjs ${c}:*)`);
  return [...new Set(out)];
}
/** A rule this command would ever write: exactly a delegated command's prefix (no other wildcard, no shell tricks). */
export const narrowRule = (r) => /^Bash\((npm run task --|node harness\/task\.mjs) (train release|type|visual|yes|hold|unhold):\*\)$/.test(r);

/**
 * Merge (or with remove, take out) the rules in <root>/.claude/settings.json permissions.allow. Every other key, and
 * permissions.deny / ask, are kept as they are. Returns { ok, added, removed, file, message }.
 */
export function writeClaudeRules(rules, { root = mainRoot(), remove = false } = {}) {
  if (!rules.every(narrowRule)) return { ok: false, message: 'Refused: a rule isn\'t one of the narrow delegated-command rules.' };
  const file = path.join(root, '.claude', 'settings.json');
  let s = {};
  if (fs.existsSync(file)) { try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { ok: false, message: `${path.relative(root, file)} isn't valid JSON: fix it first; nothing was written.` }; } }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  s.permissions = s.permissions && typeof s.permissions === 'object' && !Array.isArray(s.permissions) ? s.permissions : {};
  const allow = Array.isArray(s.permissions.allow) ? s.permissions.allow : [];
  const added = remove ? [] : rules.filter((r) => !allow.includes(r));
  const removed = remove ? allow.filter((r) => rules.includes(r)) : [];
  s.permissions.allow = remove ? allow.filter((r) => !rules.includes(r)) : [...allow, ...added];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
  return { ok: true, added, removed, file: path.relative(root, file).split(path.sep).join('/') };
}

export const USAGE = `Usage: npm run delegate -- grant <agent> --actions ${DELEGABLE.join(',')} --hours <1-${MAX_HOURS}> --by <owner> [--why "…"] [--no-commit]
       npm run delegate -- list
       npm run delegate -- revoke [--by <name>] [--no-commit]
       npm run delegate -- claude-settings [--actions …] [--write] [--remove]
The owner runs grant and claude-settings --write in their own terminal. Never delegated: ${NEVER_DELEGATED}.`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  // B-47: --help / -h prints usage and never acts.
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0] || 'list';
  if (cmd === 'grant') {
    const r = grantDelegation({ agent: argv[1] && !argv[1].startsWith('--') ? argv[1] : '', actions: opt('--actions'), hours: opt('--hours'), by: opt('--by'), why: opt('--why') || '', commit: !argv.includes('--no-commit') });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'list') {
    const d = readDelegation();
    if (!d.doc) { console.log(d.why === 'no delegation on file' ? 'No delegation on file (npm run delegate -- grant …).' : d.why); process.exit(0); }
    console.log(`${d.doc.agent} may run ${d.doc.actions.join(', ')} with --by ${d.doc.agent}, granted by ${d.doc.by} at ${short(d.doc.at)}, until ${short(d.doc.until)}${d.signed ? ' (signed)' : d.commit ? ` (commit ${d.commit})` : ''}: ${d.doc.why}`);
    console.log(d.ok ? 'It counts now.' : `It doesn't count: ${d.why}.`);
    if (d.note) console.log(`note: ${d.note}`);
    process.exit(0);
  }
  if (cmd === 'revoke') {
    const r = revokeDelegation({ by: opt('--by') || '', commit: !argv.includes('--no-commit') });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'claude-settings') {
    const d = readDelegation();
    const list = opt('--actions') ? String(opt('--actions')).split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean) : (d.doc?.actions || []);
    const unknown = list.filter((a) => !DELEGABLE.includes(a));
    if (!list.length || unknown.length) { console.error(`${unknown.length ? `${unknown.join(', ')} can't be delegated. ` : 'No delegation on file: grant one first, or pass --actions. '}Actions: ${DELEGABLE.join(', ')}.`); process.exit(1); }
    const rules = claudeRules(list);
    if (!argv.includes('--write')) {
      console.log(`Claude Code allow rules for the delegated commands (${list.join(', ')}); the owner adds them once with --write (merged into .claude/settings.json permissions.allow; deny rules are never touched):`);
      for (const r of rules) console.log(`  ${r}`);
      console.log('The harness still checks every use: only the delegated agent, only while the delegation counts. Remove them with --remove --write.');
      process.exit(0);
    }
    const shell = ownerShellRefusal();
    if (shell && !argv.includes('--remove')) { console.error(`Not written: ${shell}. The owner runs this once, in their own terminal.`); process.exit(1); }
    const r = writeClaudeRules(rules, { remove: argv.includes('--remove') });
    if (!r.ok) { console.error(r.message); process.exit(1); }
    console.log(argv.includes('--remove') ? `Removed ${r.removed.length} rule(s) from ${r.file}.` : `Added ${r.added.length} rule(s) to ${r.file} permissions.allow${r.added.length < rules.length ? ` (${rules.length - r.added.length} were already there)` : ''}. Deny rules untouched.`);
    process.exit(0);
  }
  console.error(USAGE);
  process.exit(1);
}
