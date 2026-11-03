/**
 * harness/policy-rules.mjs — 2.71.0 (x): the studio policy file and autonomous mode (the overseer's duties 19 and 20).
 *
 * studio/policy.json is the owner's plain rules, read by agents (npm run policy) and enforced by the harness:
 *   {
 *     "autonomous": { "allowed": false, "agent": null, "actions": ["train-release", "type", ...], "reviewWithinH": 72,
 *                     "by": "<the owner who set it>", "at": "<ISO time>" },
 *     "never": ["delete-lanes", "money", "protected-files", "gates"],
 *     "notes": ["free text rules the owner wants every agent to read"]
 *   }
 * A missing file means today's behaviour (no autonomous mode, the harness's own rules). The file is protected (the
 * shipped list: studio/protected.json, approve.mjs, tiers.mjs), so a lane that writes it is tier C, and it counts the
 * way the owner's delegation does (harness/delegation.mjs): as committed in the main checkout (HEAD); with an owner key
 * only with a valid signature by it; without one only when the commit that set it is not an agent's (no Studio-Agent
 * trailer). Anything else reads as the defaults, with the reason shown by `npm run policy`.
 *
 * Autonomous mode: while the policy counts and says `autonomous.allowed: true`, the named overseer agent may take the
 * listed game-dev decisions (default: train-release, type, yes, hold, visual, asset-review, quarantine) with
 * `--by <agent>` and no per-decision permission. Each is recorded with `as: "autonomous"` in the decision log
 * (harness/decisions.mjs) and goes on a review list that never blocks work. Never in autonomous mode, whatever the
 * file says (NEVER_AUTONOMOUS): protected files, gates (harness code, silencers, deleted tests) and this file, money,
 * deletes (janitor-lanes, any rm), visibility, keys. A train release in autonomous mode is refused for a lane held for
 * any of those (autonomousReleaseRefusal).
 *
 * Who turns it on: the owner, in their own terminal (`npm run policy -- autonomous on --agent <name> --by <owner>`), or
 * a game dev proposes it (`npm run autonomy -- mode autonomous on --agent <name> --by <game dev>`, a proposal in
 * .studio/policy-proposal.json) and the owner confirms it (`npm run policy -- confirm --by <owner>`). An agent never
 * turns it on: confirm and `autonomous on` refuse agents' shells, lanes and launched sessions, and a policy.json an
 * agent commits doesn't count. Anyone but a worker may pause it at once (`npm run autonomy -- mode autonomous off`):
 * it only takes power away (.studio/autonomy-paused.json; the owner's next confirm or `autonomous on` clears it).
 * The rules live here; harness/policy.mjs is the CLI (npm run policy). Modules import this one, never the CLI: a module
 * that the CLI's own imports load back would wait on its top-level await (a load deadlock).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';
import { canonicalBytes } from './hash.mjs';
import { mainRoot, inLaneCopy } from './worktree.mjs';
import { OWNER_PUB_REL, ownerKeyPath, verifyApproval, OWNER_KEY_HOWTO } from './approve.mjs';
import { WORKER_NAME } from './permission.mjs';
import { agentLikeName } from './agent-env.mjs';
import { DEFAULT_TIER_RULES } from './tiers.mjs';

export const POLICY_REL = 'studio/policy.json';
export const PROPOSAL_REL = '.studio/policy-proposal.json';
export const PAUSE_REL = '.studio/autonomy-paused.json';
/** The game-dev decisions autonomous mode can ever cover (a policy naming anything else is ignored for it). */
export const AUTONOMOUS_ELIGIBLE = ['train-release', 'type', 'yes', 'hold', 'visual', 'asset-review', 'quarantine'];
export const DEFAULT_AUTONOMOUS_ACTIONS = [...AUTONOMOUS_ELIGIBLE];
/** Never in autonomous mode, whatever the file says (the owner's direction: safety stays owner-only). */
export const NEVER_AUTONOMOUS = ['protected-files', 'gates', 'policy', 'money', 'deletes', 'visibility', 'keys'];
export const NEVER_WORDS = 'protected files, gates and the policy file, money, deletes (janitor-lanes, any rm), visibility and keys';
export const DEFAULT_REVIEW_H = 72;
export const DEFAULT_POLICY = Object.freeze({ autonomous: Object.freeze({ allowed: false, agent: null, actions: DEFAULT_AUTONOMOUS_ACTIONS, reviewWithinH: DEFAULT_REVIEW_H }), never: [], notes: [] });
/** A policy "never" word and the decision actions it rules out (for any agent: delegation and autonomous mode). */
export const NEVER_ACTIONS = { 'delete-lanes': ['janitor-lanes'], deletes: ['janitor-lanes'], 'janitor-lanes': ['janitor-lanes'], 'upgrade-auto': ['upgrade-auto'], upgrades: ['upgrade-auto'] };
/**
 * Tier rules (harness/tiers.mjs) whose holds autonomous mode never releases: every shipped tier-C rule (protected files,
 * harness code, deleted tests/goldens/regressions, irreversible formats, upgrade merges, protected config proposals,
 * check silencers). A lane held only by a game's own rule, or after too many hand-backs (tier B), may be released.
 */
export const NEVER_RELEASE_RULES = ['protected', 'harness', 'test-deleted', 'golden-deleted', 'regression-deleted', 'irreversible', 'upgrade', 'config-proposal-protected', 'silencer', 'config-proposal-silencer'];

const git = (root, ...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const short = (iso) => String(iso || '').slice(0, 16).replace('T', ' ');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const strs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : []);
export const policyBody = (d) => { const { signature, ...rest } = d || {}; return rest; };

function ownerPub(root) {
  const r = git(root, 'show', `HEAD:${OWNER_PUB_REL}`);
  const pem = r.status === 0 ? r.stdout : (fs.existsSync(path.join(root, OWNER_PUB_REL)) ? fs.readFileSync(path.join(root, OWNER_PUB_REL), 'utf8') : '');
  return /BEGIN PUBLIC KEY/.test(pem || '') ? pem : null;
}

function shapeError(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'it isn\'t a JSON object';
  const a = d.autonomous;
  if (a !== undefined && (typeof a !== 'object' || a === null || Array.isArray(a))) return '"autonomous" must be an object';
  if (a?.agent !== undefined && a.agent !== null && !/^[\w.-]{1,60}$/.test(String(a.agent))) return '"autonomous.agent" must be an agent\'s name';
  if (a?.actions !== undefined && !Array.isArray(a.actions)) return '"autonomous.actions" must be a list';
  if (a?.reviewWithinH !== undefined && !(Number(a.reviewWithinH) > 0)) return '"autonomous.reviewWithinH" must be a number of hours';
  if (d.never !== undefined && !Array.isArray(d.never)) return '"never" must be a list';
  if (d.notes !== undefined && !Array.isArray(d.notes)) return '"notes" must be a list';
  if (a?.allowed && WORKER_NAME.test(String(a.agent || ''))) return `${a.agent} is a worker agent's name; autonomous mode never covers workers`;
  return auditRoutingShapeError(d);
}

/**
 * 2.73.0 (e): the policy's "audit" and "routing" blocks.
 *   "audit": { "rate": 0.1 }   the share of hands-free landings and autonomous decisions picked for an after-the-fact
 *                              audit (harness/audit.mjs); default 0.1 while autonomous mode is on, else 0.
 *   "routing": { "cheapFirst": ["chore", "docs", "test"], "tiers": { "cheap": "<model>", "mid": "<model>", "top":
 *                "<model>" }, "models": ["<model>", …], "holdout": 0 }   cheap-first routing (harness/routing.mjs): the
 *                listed task types/tracks start on the cheapest listed tier; the router never picks a model the policy
 *                doesn't list (tiers' values and "models"). "holdout" (default 0, OFF: deferred by the owner until API
 *                credit is available) sends that share of matching tasks to the default tier to measure the difference.
 */
function auditRoutingShapeError(d) {
  const au = d.audit;
  if (au !== undefined && (typeof au !== 'object' || au === null || Array.isArray(au))) return '"audit" must be an object';
  if (au?.rate !== undefined && !(Number.isFinite(Number(au.rate)) && Number(au.rate) >= 0 && Number(au.rate) <= 1)) return '"audit.rate" must be a share from 0 to 1';
  const r = d.routing;
  if (r === undefined) return '';
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return '"routing" must be an object';
  if (r.cheapFirst !== undefined && !Array.isArray(r.cheapFirst)) return '"routing.cheapFirst" must be a list of task types or tracks';
  if (r.models !== undefined && !Array.isArray(r.models)) return '"routing.models" must be a list of models';
  if (r.tiers !== undefined && (typeof r.tiers !== 'object' || r.tiers === null || Array.isArray(r.tiers) || Object.keys(r.tiers).some((k) => !['cheap', 'mid', 'top'].includes(k)))) return '"routing.tiers" must be { "cheap": …, "mid": …, "top": … }';
  if (r.holdout !== undefined && !(Number.isFinite(Number(r.holdout)) && Number(r.holdout) >= 0 && Number(r.holdout) <= 0.5)) return '"routing.holdout" must be a share from 0 to 0.5';
  return '';
}

/** The rules in force from a doc that counts (or the defaults): { autonomous, never, notes, ignoredActions }. */
export function effectivePolicy(doc) {
  const a = doc?.autonomous && typeof doc.autonomous === 'object' ? doc.autonomous : {};
  const listed = Array.isArray(a.actions) ? strs(a.actions).map((x) => x.toLowerCase()) : DEFAULT_AUTONOMOUS_ACTIONS;
  const actions = listed.filter((x) => AUTONOMOUS_ELIGIBLE.includes(x));
  const never = [...new Set([...NEVER_AUTONOMOUS, ...strs(doc?.never).map((x) => x.toLowerCase())])];
  return {
    autonomous: { allowed: a.allowed === true && Boolean(a.agent), agent: a.agent ? String(a.agent) : null, actions: actions.filter((x) => !never.includes(x)), reviewWithinH: Number(a.reviewWithinH) > 0 ? Math.min(Number(a.reviewWithinH), 24 * 30) : DEFAULT_REVIEW_H, by: a.by || null, at: a.at || null },
    never,
    notes: strs(doc?.notes).map((x) => x.slice(0, 500)),
    audit: { rate: doc?.audit && doc.audit.rate !== undefined && Number.isFinite(Number(doc.audit.rate)) ? Math.min(1, Math.max(0, Number(doc.audit.rate))) : null },
    routing: routingOf(doc?.routing),
    ignoredActions: listed.filter((x) => !AUTONOMOUS_ELIGIBLE.includes(x) || never.includes(x)),
  };
}

/** 2.73.0 (e): the routing block in force: { cheapFirst, tiers, models (every model it lists), holdout }. */
export function routingOf(r) {
  const o = r && typeof r === 'object' && !Array.isArray(r) ? r : {};
  const tiers = {};
  for (const t of ['cheap', 'mid', 'top']) if (o.tiers && typeof o.tiers === 'object' && String(o.tiers[t] || '').trim()) tiers[t] = String(o.tiers[t]).trim().slice(0, 120);
  const models = [...new Set([...Object.values(tiers), ...strs(o.models).map((x) => x.slice(0, 120))])];
  const h = Number(o.holdout);
  return { cheapFirst: strs(o.cheapFirst).map((x) => x.toLowerCase().slice(0, 60)), tiers, models, holdout: Number.isFinite(h) && h > 0 ? Math.min(0.5, h) : 0 };
}

/**
 * The policy on file and whether it counts: { doc, counts, why, signed, commit, effective, paused }. Never throws.
 * A missing file: { doc: null, counts: false, effective: the defaults } (today's behaviour).
 */
export function readPolicy({ root = mainRoot() } = {}) {
  const paused = readJson(path.join(root, PAUSE_REL));
  const base = { doc: null, counts: false, signed: false, commit: null, effective: effectivePolicy(null), paused: paused || null };
  const isGit = git(root, 'rev-parse', '--verify', 'HEAD').status === 0;
  const work = fs.existsSync(path.join(root, POLICY_REL)) ? fs.readFileSync(path.join(root, POLICY_REL), 'utf8') : null;
  const shown = isGit ? git(root, 'show', `HEAD:${POLICY_REL}`) : null;
  const text = isGit ? (shown.status === 0 ? shown.stdout : null) : work;
  if (text == null) return { ...base, why: work != null ? `${POLICY_REL} isn't committed: it counts once the owner commits it (npm run policy -- confirm / autonomous on do)` : `no ${POLICY_REL}: today's behaviour (no autonomous mode)` };
  let doc;
  try { doc = JSON.parse(text); } catch { return { ...base, why: `${POLICY_REL} isn't valid JSON: the defaults apply` }; }
  const bad = shapeError(doc);
  if (bad) return { ...base, doc, why: `${POLICY_REL} doesn't count: ${bad}` };
  const note = isGit && work != null && work !== text ? `the working copy of ${POLICY_REL} differs from the committed one, which is what counts` : '';
  const pub = ownerPub(root);
  let signed = false;
  let commit = null;
  if (pub) {
    if (!doc.signature || !verifyApproval({ approval: policyBody(doc), signature: doc.signature }, pub)) return { ...base, doc, note, why: `${POLICY_REL} doesn't count: this studio has an owner key and the file has no valid signature by it (unsigned, or changed after it was signed)` };
    signed = true;
  } else {
    if (!isGit) return { ...base, doc, why: `${POLICY_REL} doesn't count: not a git checkout, so who wrote it can't be checked` };
    const log = git(root, 'log', '-1', '--format=%H%x09%(trailers:key=Studio-Agent,valueonly,separator=%x2C)', 'HEAD', '--', POLICY_REL);
    const [sha = '', agent = ''] = String(log.stdout || '').trim().split('\t');
    if (!sha) return { ...base, doc, why: `${POLICY_REL}: the commit that set it wasn't found` };
    commit = sha.slice(0, 8);
    if (agent.trim()) return { ...base, doc, commit, why: `${POLICY_REL} doesn't count: commit ${commit} that set it is the agent ${agent.trim()}'s (Studio-Agent trailer); only the owner changes the policy, from their own terminal` };
  }
  return { ...base, doc, counts: true, signed, commit, note, why: '', effective: effectivePolicy(doc) };
}

/** The decision actions the policy's "never" rules out for every agent (delegation included). */
export function neverActions(effective) {
  const out = new Set();
  for (const w of effective?.never || []) {
    for (const a of NEVER_ACTIONS[w] || []) out.add(a);
    if (/^[a-z-]+$/.test(w) && !NEVER_AUTONOMOUS.includes(w)) out.add(w);
  }
  return out;
}

/** Why the counted policy rules this action out for an agent (delegated or autonomous), or ''. */
export function policyNeverWhy(action, { root = mainRoot() } = {}) {
  try {
    const p = readPolicy({ root });
    if (!p.counts) return '';
    return neverActions(p.effective).has(String(action)) ? `${POLICY_REL} says never: ${action} is not an agent's decision in this studio` : '';
  } catch { return ''; }
}

const autonomyWords = (eff) => `autonomous mode (${POLICY_REL}${eff.autonomous.by ? `, set by ${eff.autonomous.by}` : ''}${eff.autonomous.at ? ` at ${short(eff.autonomous.at)}` : ''}); on the review list (npm run decisions -- review)`;

/**
 * May this caller take this decision in autonomous mode as `by`? { ok: true, autonomous: true, owner (the person who
 * turned autonomous mode on), agent, at, until: null, signed, permission, doc, reviewWithinH, setBy } or { ok: false, why }
 * (why is '' when `by` isn't the policy's agent or autonomous mode is off: nothing about it needs saying).
 */
export function autonomousFor({ action, by, env = process.env, root = mainRoot(), lane = inLaneCopy() } = {}) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: '' };
  const p = readPolicy({ root });
  const a = p.doc?.autonomous;
  if (!a || a.allowed !== true || !a.agent) return { ok: false, why: '' };
  if (who.toLowerCase() !== String(a.agent).toLowerCase()) return { ok: false, why: '' };
  const no = (m) => ({ ok: false, why: `no autonomous mode: ${m}` });
  if (!p.counts) return no(p.why);
  const eff = p.effective;
  if (!AUTONOMOUS_ELIGIBLE.includes(action)) return no(`${action} is never decided in autonomous mode (never: ${NEVER_WORDS})`);
  if (!eff.autonomous.actions.includes(action)) return no(`the policy lets ${a.agent} take ${eff.autonomous.actions.join(', ') || 'no action'}, not ${action}`);
  if (neverActions(eff).has(action)) return no(`${POLICY_REL} says never: ${action}`);
  if (p.paused) return no(`it is paused (${p.paused.by || 'someone'} at ${short(p.paused.at)}${p.paused.why ? `: ${p.paused.why}` : ''}; the owner turns it on again: npm run policy -- confirm | autonomous on)`);
  const role = String(env.STUDIO_ROLE || '').trim();
  if (role) return no(`a launched ${role} session is never covered`);
  if (lane) return no('a lane copy is never covered');
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const worker = [who, owner].find((n) => n && WORKER_NAME.test(n));
  if (worker) return no(`${worker} is a worker agent`);
  if (owner && owner.toLowerCase() !== who.toLowerCase()) return no(`this shell works as ${owner}, not ${a.agent}`);
  // owner: the person who turned autonomous mode on (records that must name a person, like a delegation's, name them);
  // the decision log names the agent (harness/decisions-log.mjs).
  return { ok: true, autonomous: true, owner: String(eff.autonomous.by || 'the owner').slice(0, 60), agent: String(a.agent), at: eff.autonomous.at || (p.commit ? `commit ${p.commit}` : ''), until: null, signed: p.signed, permission: autonomyWords(eff).slice(0, 500), doc: p.doc, reviewWithinH: eff.autonomous.reviewWithinH, setBy: eff.autonomous.by, why: '' };
}

/** A train release in autonomous mode: '' when the lane's hold is one autonomous mode may release, else why not. */
export function autonomousReleaseRefusal(heldWhy) {
  const text = String(heldWhy || '');
  const hit = DEFAULT_TIER_RULES.filter((r) => NEVER_RELEASE_RULES.includes(r.id) && text.includes(r.why));
  if (hit.length) return `autonomous mode never releases a lane held for ${hit.map((r) => r.id).join(', ')} (${hit[0].why}); never: ${NEVER_WORDS}. A person releases it (npm run task -- train release <ID> --by <you>)`;
  return '';
}

/** A signed policy copied into a record (a type/visual entry made in autonomous mode): it verifies and covers it. */
export function embeddedAutonomyOk(doc, pub, { action, agent, at } = {}) {
  if (!doc?.autonomous || shapeError(doc) || !doc.signature || !pub) return false;
  if (!verifyApproval({ approval: policyBody(doc), signature: doc.signature }, pub)) return false;
  const eff = effectivePolicy(doc);
  if (!eff.autonomous.allowed || String(agent || '').toLowerCase() !== String(eff.autonomous.agent).toLowerCase() || !eff.autonomous.actions.includes(action)) return false;
  const t = Date.parse(at);
  return !eff.autonomous.at || (Number.isFinite(t) && t >= Date.parse(eff.autonomous.at) - 5 * 60000);
}

// ---- changing it -----------------------------------------------------------------------------------------------

function commitPolicy(root, msg, why) {
  if (git(root, 'rev-parse', '--verify', 'HEAD').status !== 0) return { committed: false, note: ' Not a git checkout: nothing committed.' };
  git(root, 'add', '--', POLICY_REL);
  const r = git(root, 'commit', '--only', '-m', msg, '-m', `Why: ${why}`, '--', POLICY_REL);
  return r.status === 0 ? { committed: true, note: '' } : { committed: false, note: ` Committing it failed (${String(r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.status}`}): commit ${POLICY_REL} yourself, from this terminal.` };
}

/** Write the policy from the owner's terminal: signs it with the owner key when the studio has one. { ok, message, doc } */
function writeOwnerPolicy(root, doc, { env, commit, msg, why }) {
  const pub = ownerPub(root);
  const out = policyBody(doc);
  if (pub) {
    const keyFile = ownerKeyPath(env);
    if (!fs.existsSync(keyFile)) return { ok: false, message: `this studio has an owner key, so the policy is signed with it, and there is no owner private key on this machine (${keyFile}). Run it on the device that holds the key. ${OWNER_KEY_HOWTO}` };
    try { out.signature = crypto.sign(null, Buffer.from(canonicalBytes(policyBody(out))), crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'))).toString('base64'); } catch (e) { return { ok: false, message: `signing failed (${e.message})` }; }
    if (!verifyApproval({ approval: policyBody(out), signature: out.signature }, pub)) return { ok: false, message: `the private key at ${keyFile} doesn't match the studio's owner key (${OWNER_PUB_REL})` };
  }
  fs.mkdirSync(path.join(root, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(root, POLICY_REL), `${JSON.stringify(out, null, 2)}\n`);
  const c = commit ? commitPolicy(root, msg, why) : { committed: false, note: ` Not committed (--no-commit): it counts once you commit ${POLICY_REL} from this terminal.` };
  try { fs.rmSync(path.join(root, PAUSE_REL), { force: true }); } catch {}
  return { ok: true, doc: out, signed: Boolean(pub), ...c };
}

async function ownerRefusal({ by, env, root, lane }) {
  const { ownerShellRefusal } = await import('./delegation.mjs');
  const shell = ownerShellRefusal({ env, lane });
  if (shell) return shell;
  const owner = String(by || '').trim();
  if (!owner) return 'say who you are: --by <your name>';
  if (agentLikeName(owner, { stateDir: path.join(root, '.studio') })) return `"${owner}" is an agent's name; --by names the owner`;
  return '';
}

const parseActions = (s) => (s === null || s === undefined || s === '' ? null : [...new Set(String(s).split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))]);

async function logIt(rec) { try { (await import('./decisions-log.mjs')).logDecision(rec); } catch { /* the policy itself is the record */ } }

/**
 * `npm run policy -- autonomous on|off --agent <name> [--actions …] [--review-h N] --by <owner>`: the owner, in their
 * own terminal, sets autonomous mode directly. Returns { ok, message }.
 */
export async function setAutonomous({ on, agent = '', actions = null, reviewH = null, by, why = '', commit = true, env = process.env, root = mainRoot(), lane = inLaneCopy(), now = Date.now(), proposal = null } = {}) {
  const refuse = (m) => ({ ok: false, message: `Not changed: ${m}. Only the owner changes ${POLICY_REL}, in their own terminal; an agent never turns autonomous mode on for itself.` });
  const r = await ownerRefusal({ by, env, root, lane });
  if (r) return refuse(r);
  const cur = readJson(path.join(root, POLICY_REL)) || {};
  const doc = { ...policyBody(cur) };
  const prev = doc.autonomous && typeof doc.autonomous === 'object' ? doc.autonomous : {};
  if (on) {
    const name = String(agent || prev.agent || '').trim();
    if (!/^[\w.-]{1,60}$/.test(name)) return refuse('name the overseer agent: --agent <name>');
    if (WORKER_NAME.test(name)) return refuse(`${name} is a worker agent's name; autonomous mode is for the overseer outside the harness`);
    const list = parseActions(actions) || (Array.isArray(prev.actions) ? prev.actions : DEFAULT_AUTONOMOUS_ACTIONS);
    const bad = list.filter((x) => !AUTONOMOUS_ELIGIBLE.includes(x));
    if (bad.length) return refuse(`${bad.join(', ')} can't be autonomous (it can be: ${AUTONOMOUS_ELIGIBLE.join(', ')}; never: ${NEVER_WORDS})`);
    const h = reviewH === null || reviewH === undefined || reviewH === '' ? (Number(prev.reviewWithinH) > 0 ? Number(prev.reviewWithinH) : DEFAULT_REVIEW_H) : Number(reviewH);
    if (!(h > 0 && h <= 720)) return refuse('--review-h takes the hours a decision may wait for review (1-720)');
    doc.autonomous = { allowed: true, agent: name, actions: list, reviewWithinH: h, by: String(by).trim().slice(0, 60), at: new Date(now).toISOString(), ...(proposal ? { proposedBy: proposal.by, proposedAt: proposal.at } : {}), ...(why ? { why: String(why).slice(0, 300) } : {}) };
  } else doc.autonomous = { ...prev, allowed: false, by: String(by).trim().slice(0, 60), at: new Date(now).toISOString() };
  if (!Array.isArray(doc.never)) doc.never = ['delete-lanes', 'money', 'protected-files', 'gates'];
  if (!Array.isArray(doc.notes)) doc.notes = [];
  const a = doc.autonomous;
  const w = writeOwnerPolicy(root, doc, { env, commit, msg: `policy: autonomous mode ${on ? `on for ${a.agent} (${a.actions.join(', ')})` : 'off'} by ${a.by}`, why: why || (proposal ? `confirmed the proposal by ${proposal.by}` : 'the owner\'s policy') });
  if (!w.ok) return refuse(w.message);
  emitEvent({ type: on ? 'policy.autonomous_on' : 'policy.autonomous_off', agent: a.by, to: on ? a.agent : 'producer', msg: `${a.by} turned autonomous mode ${on ? `on for ${a.agent} (${a.actions.join(', ')}; review within ${a.reviewWithinH} h)` : 'off'}${w.signed ? ' (signed)' : ''}${proposal ? ` (proposed by ${proposal.by})` : ''}`.slice(0, 400), meta: { autonomous: a, signed: w.signed, committed: w.committed } });
  await logIt({ action: 'autonomy-mode', subject: POLICY_REL, by: a.by, as: 'person', why: why || (on ? `autonomous mode on for ${a.agent}` : 'autonomous mode off'), evidence: on ? `${a.actions.join(', ')}; review within ${a.reviewWithinH} h${proposal ? `; proposed by ${proposal.by}` : ''}` : 'off', undo: on ? { kind: 'text', text: `npm run policy -- autonomous off --by <owner> (or anyone: npm run autonomy -- mode autonomous off --by <name>)` } : null });
  return { ok: true, doc: w.doc, message: `Autonomous mode is ${on ? `on: ${a.agent} may take ${a.actions.join(', ')} with --by ${a.agent}; each goes on the review list (npm run decisions -- review), due within ${a.reviewWithinH} h` : 'off'}. ${w.signed ? 'Signed with the owner key. ' : ''}${w.committed ? `Committed ${POLICY_REL}.` : ''}${w.note || ''} Never in autonomous mode: ${NEVER_WORDS}.`.replace(/\s+/g, ' ').trim() };
}

/**
 * `npm run autonomy -- mode autonomous on|off --by <game dev> [--agent <name>] [--actions …] [--permission "…"]`.
 * on: a proposal the owner confirms (never turns anything on); a person, or an agent on a person's permission; never a
 * worker; --by is never an agent. off: anyone but a worker pauses autonomous mode at once (it only takes power away).
 */
export async function proposeMode({ on, agent = '', actions = null, reviewH = null, by, why = '', permission = '', env = process.env, root = mainRoot(), now = Date.now() } = {}) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, message: 'Say who decides: --by <name>.' };
  if (!on) {
    const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
    const worker = [owner, who].find((n) => n && WORKER_NAME.test(n));
    if (worker) return { ok: false, message: `Refused: ${worker} is a worker agent; workers don't change autonomous mode.` };
    const rec = { by: who.slice(0, 60), at: new Date(now).toISOString(), why: String(why || '').slice(0, 300) || null, ...(owner && owner !== who ? { recordedBy: owner } : {}) };
    fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(root, PAUSE_REL), `${JSON.stringify(rec, null, 2)}\n`);
    try { fs.rmSync(path.join(root, PROPOSAL_REL), { force: true }); } catch {}
    emitEvent({ type: 'policy.autonomous_paused', agent: rec.recordedBy || rec.by, to: 'producer', msg: `${rec.by} paused autonomous mode${rec.why ? `: ${rec.why}` : ''} (the owner turns it on again: npm run policy -- confirm | autonomous on)`.slice(0, 400), meta: rec });
    await logIt({ action: 'autonomy-mode', subject: POLICY_REL, by: rec.by, as: rec.recordedBy ? `permission "${String(permission || '').slice(0, 200)}"` : 'person', why: rec.why || 'autonomous mode paused', evidence: 'paused', undo: { kind: 'text', text: 'the owner turns it on again: npm run policy -- confirm | autonomous on --by <owner>' } });
    return { ok: true, message: `Autonomous mode is paused (${PAUSE_REL}): no autonomous decision is taken until the owner turns it on again (npm run policy -- autonomous on --by <owner>). Decisions already taken stay on the review list.` };
  }
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by: who, permission, env, action: 'policy-propose', what: 'propose autonomous mode' });
  if (!d.ok) return { ok: false, message: `${d.why} A proposal never turns autonomous mode on: the owner confirms it (npm run policy -- confirm --by <owner>).` };
  const name = String(agent || '').trim();
  if (!/^[\w.-]{1,60}$/.test(name)) return { ok: false, message: 'Name the overseer agent: --agent <name>.' };
  if (WORKER_NAME.test(name)) return { ok: false, message: `Refused: ${name} is a worker agent's name; autonomous mode is for the overseer outside the harness.` };
  const list = parseActions(actions) || DEFAULT_AUTONOMOUS_ACTIONS;
  const bad = list.filter((x) => !AUTONOMOUS_ELIGIBLE.includes(x));
  if (bad.length) return { ok: false, message: `Refused: ${bad.join(', ')} can't be autonomous (it can be: ${AUTONOMOUS_ELIGIBLE.join(', ')}; never: ${NEVER_WORDS}).` };
  const h = reviewH === null || reviewH === undefined || reviewH === '' ? DEFAULT_REVIEW_H : Number(reviewH);
  if (!(h > 0 && h <= 720)) return { ok: false, message: '--review-h takes 1-720 hours.' };
  const prop = { autonomous: { allowed: true, agent: name, actions: list, reviewWithinH: h }, by: d.by, at: new Date(now).toISOString(), via: d.via, ...(d.via !== 'person' ? { recordedBy: d.recordedBy, permission: d.permission || null } : {}), why: String(why || '').slice(0, 300) || null };
  fs.mkdirSync(path.join(root, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(root, PROPOSAL_REL), `${JSON.stringify(prop, null, 2)}\n`);
  emitEvent({ type: 'policy.proposed', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'human', status: 'warn', msg: `${d.by} proposes autonomous mode for ${name} (${list.join(', ')}; review within ${h} h)${d.via !== 'person' ? ` (recorded by ${d.recordedBy} on ${d.by}'s permission)` : ''}: the owner confirms with npm run policy -- confirm --by <owner>`.slice(0, 500), meta: prop });
  await logIt({ action: 'autonomy-mode', subject: POLICY_REL, by: d.by, as: d.via === 'person' ? 'person' : `permission "${String(d.permission || '').slice(0, 200)}"`, why: prop.why || `proposed autonomous mode for ${name}`, evidence: `proposal: ${list.join(', ')}; review within ${h} h`, undo: { kind: 'text', text: 'npm run policy -- decline --by <name>' } });
  return { ok: true, message: `Proposed: autonomous mode for ${name} (${list.join(', ')}; review within ${h} h), in ${PROPOSAL_REL}. Nothing changes until the owner confirms it in their own terminal: npm run policy -- confirm --by <owner> (or declines: npm run policy -- decline --by <name>).` };
}

/** `npm run policy -- confirm --by <owner>`: the owner turns on the proposed autonomous mode. */
export async function confirmProposal({ by, commit = true, env = process.env, root = mainRoot(), lane = inLaneCopy(), now = Date.now() } = {}) {
  const prop = readJson(path.join(root, PROPOSAL_REL));
  if (!prop?.autonomous?.agent) return { ok: false, message: `No proposal on file (${PROPOSAL_REL}): npm run autonomy -- mode autonomous on --agent <name> --by <game dev> writes one, or the owner runs npm run policy -- autonomous on --agent <name> --by <owner>.` };
  const r = await setAutonomous({ on: true, agent: prop.autonomous.agent, actions: prop.autonomous.actions.join(','), reviewH: prop.autonomous.reviewWithinH, by, why: prop.why || '', commit, env, root, lane, now, proposal: prop });
  if (r.ok) try { fs.rmSync(path.join(root, PROPOSAL_REL), { force: true }); } catch {}
  return r;
}

/** `npm run policy -- decline --by <name>`: drop the proposal (anyone but a worker). */
export function declineProposal({ by, env = process.env, root = mainRoot() } = {}) {
  const who = String(by || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  if (!who) return { ok: false, message: 'Say who declines it: --by <name>.' };
  const worker = [owner, who].find((n) => n && WORKER_NAME.test(n));
  if (worker) return { ok: false, message: `Refused: ${worker} is a worker agent.` };
  const f = path.join(root, PROPOSAL_REL);
  if (!fs.existsSync(f)) return { ok: true, message: 'No proposal on file.' };
  const prop = readJson(f);
  fs.rmSync(f, { force: true });
  emitEvent({ type: 'policy.declined', agent: who.slice(0, 60), to: 'producer', msg: `${who} declined the proposal of autonomous mode${prop?.autonomous?.agent ? ` for ${prop.autonomous.agent}` : ''}`, meta: { proposal: prop } });
  return { ok: true, message: `Declined the proposal${prop?.autonomous?.agent ? ` of autonomous mode for ${prop.autonomous.agent}` : ''}.` };
}

/** What `npm run policy` prints: the rules in force, whether the file counts, a pending proposal. */
export function policyText({ root = mainRoot() } = {}) {
  const p = readPolicy({ root });
  const e = p.effective;
  const a = e.autonomous;
  const L = [];
  L.push(p.doc ? `${POLICY_REL}: ${p.counts ? `counts${p.signed ? ' (signed with the owner key)' : p.commit ? ` (commit ${p.commit})` : ''}` : `doesn't count (${p.why}); the defaults apply`}.` : `${p.why}.`);
  if (p.note) L.push(`note: ${p.note}`);
  L.push(`Autonomous mode: ${a.allowed && p.counts ? `on for ${a.agent}: ${a.actions.join(', ') || 'no action'} with --by ${a.agent}, recorded "autonomous" and put on the review list (npm run decisions -- review), due within ${a.reviewWithinH} h${a.by ? `; set by ${a.by}${a.at ? ` at ${short(a.at)}` : ''}` : ''}${p.paused ? `; PAUSED by ${p.paused.by} at ${short(p.paused.at)}` : ''}` : 'off'}.`);
  if (e.ignoredActions.length && p.counts) L.push(`Ignored in the file's actions (never autonomous): ${e.ignoredActions.join(', ')}.`);
  L.push(`Never (any agent, whatever the file says, in autonomous mode): ${NEVER_WORDS}.${e.never.filter((x) => !NEVER_AUTONOMOUS.includes(x)).length ? ` The file adds: ${e.never.filter((x) => !NEVER_AUTONOMOUS.includes(x)).join(', ')}.` : ''}`);
  if (e.notes.length) { L.push('The owner\'s notes for every agent:'); for (const n of e.notes) L.push(`  - ${n}`); }
  // 2.73.0 (e): audits and cheap-first routing.
  const on = p.counts && a.allowed && !p.paused;
  const ar = p.counts && e.audit.rate !== null ? e.audit.rate : on ? 0.1 : 0;
  L.push(`Audits: ${ar ? `${Math.round(ar * 1000) / 10}% of hands-free landings and autonomous decisions${p.counts && e.audit.rate !== null ? ' ("audit.rate")' : ' (the default while autonomous mode is on)'}, picked by a draw seeded with the task or decision id, reviewed after the fact by someone who didn't do the work (npm run decisions -- review); never blocks work` : 'off (0: no "audit.rate" and autonomous mode is off)'}.`);
  const r = e.routing;
  if (p.counts && r.cheapFirst.length) L.push(`Cheap-first routing: ${r.cheapFirst.join(', ')} start on the cheapest listed tier (${['cheap', 'mid', 'top'].filter((t) => r.tiers[t]).map((t) => `${t} ${r.tiers[t]}`).join(', ') || 'no tier listed: nothing is routed'}), one tier up after a red round; only models the policy lists. Holdout: ${r.holdout ? `${Math.round(r.holdout * 100)}% to the default tier` : 'off (0; deferred by the owner until API credit is available)'}. Stats: npm run autonomy -- routing.`);
  else L.push('Cheap-first routing: off (no "routing.cheapFirst").');
  const prop = readJson(path.join(root, PROPOSAL_REL));
  if (prop?.autonomous?.agent) L.push(`Proposed by ${prop.by} at ${short(prop.at)}: autonomous mode for ${prop.autonomous.agent} (${(prop.autonomous.actions || []).join(', ')}). The owner confirms: npm run policy -- confirm --by <owner>.`);
  return L.join('\n');
}
