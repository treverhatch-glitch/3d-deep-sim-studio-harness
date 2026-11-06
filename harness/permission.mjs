/**
 * harness/permission.mjs — 2.59.1: an owner decision an agent records on a person's direct permission.
 *
 * The owner's rule (2026-11-01): agents may sign off when a person gives direct permission, and a high-level agent (a
 * Producer or Director session, or an agent outside the harness such as the crew's orchestrator) may change things
 * with a person's direct permission. So the owner-only commands (`npm run task -- type`, `npm run studio:resume`)
 * accept an agent caller when it says who gave permission (--by, a person's name) and where (--permission "<the
 * person's words, or a link to the message>", 10+ characters). The record keeps the permission and who recorded it,
 * and every output that shows the decision shows both. A builder or other worker session never qualifies, with or
 * without permission. Without --permission nothing changes: those commands still refuse agents.
 *
 * What this is not: proof. Until the studio has an owner key nothing an agent writes is proof; the permission line
 * is there so a person can check it. With an owner key, a decision that needs the key's signature still needs it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { proxyShell, mainCheckout } from './owner-proxy.mjs';
import { parseStudioEnv } from './dotenv.mjs';
import { betaActor } from './beta-mode.mjs';

// Launched sessions that may act on a person's permission.
export const DECIDER_ROLES = /^(producer|director)$/i;
// Worker agents: never, with or without permission (names as the launcher hands them out: builder-s3, qa-playtester-s2).
export const WORKER_NAME = /^(builder|rnd|qa|qa-playtester|playtester|reviewer|art|artist|art-director|designer|designer-calibrator|balancer|fun-tester|scout|reference-scout|engine-porter|dev-hacker|planner|liaison)(-|_|\d|$)/i;
// A coding agent's own shell (outside the harness).
export const AGENT_SHELL = ['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];

/**
 * 2.73.1 (B-67): in the owner proxy's own shell (harness/owner-proxy.mjs: STUDIO_LOCK_OWNER=<agent>, a signed proxy
 * grant on file, not a launched session or a lane copy) the standing grant stands in for --permission when none is given,
 * so every "a person's direct permission" command works for the proxy with --by <the owner>. Anywhere else: as before.
 */
export const permissionText = (p, env = process.env) => {
  const t = String(p || '').trim();
  if (t) return t;
  try { const s = proxyShell({ env }); if (s.ok) return s.words; } catch { /* not the proxy */ }
  // 2.76.0: in beta mode the owner's stand-ins (harness/beta-mode.mjs) need no per-step words either.
  try { const b = betaActor({ env }); return b.ok ? b.words : ''; } catch { return ''; }
};

/**
 * May this caller record a person's decision on their permission? { ok, recordedBy, via, why }.
 * via: 'producer' | 'director' (a launched session), 'outside agent' (a coding agent's shell or an agent's name in
 * STUDIO_LOCK_OWNER outside a launched session), or 'person' (no agent marker: a person's own terminal).
 */
export function agentOnPermission({ permission, env = process.env } = {}) {
  const text = permissionText(permission);
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (text.length < 10) return { ok: false, why: 'say where the person gave permission: --permission "<their words, or a link to the message>" (10+ characters)' };
  if (role && !DECIDER_ROLES.test(role)) return { ok: false, why: `a launched ${role} session can't act on permission; only a Producer or Director session, or an agent outside the harness, can` };
  if (owner && WORKER_NAME.test(owner)) return { ok: false, why: `${owner} is a worker agent; only a Producer or Director session, or an agent outside the harness, can act on permission` };
  const via = role ? role.toLowerCase() : (marker || owner) ? 'outside agent' : 'person';
  const recordedBy = owner || (role ? `a ${role.toLowerCase()} session` : marker ? `a coding agent (${marker})` : 'a person\'s terminal');
  return { ok: true, recordedBy, via, why: '' };
}

/** May an agent commit that set such a record count? (The commit-msg hook writes Studio-Agent: <name> for agents.) */
export const permittedSetter = (agent) => !WORKER_NAME.test(String(agent || '').trim());

// ---- 2.78.2 (h): who may make which beta decision (the owner's rule, 2026-11-05) ----
//
// "Every agent who isn't the outside agent has to keep the rules": board decisions (task type, visual off, lanes,
// parks and unparks, stacking, a lane release, a non-protected config change) stay with the owner, the outside
// orchestrator (an agent not launched by the harness) and a Producer/Director session; protected decisions (protected
// files, weakened tests, hooks, task done --force, a protected config change) are the owner's and the outside agents'
// only. STUDIO_PRODUCER_APPROVES=protected (the owner's switch, default off; docs/SECURITY.md) lets a Producer/Director
// session make protected decisions too. Workers make neither. One answer, mayDecide; the lists above are its only lists.

/** Decision kinds (approval kinds and the beta actions that decide one). Anything not listed is judged protected. */
export const BOARD_DECISIONS = Object.freeze(['board', 'type', 'visual', 'lane', 'lanes', 'park', 'unpark', 'stack', 'config', 'train-release', 'hold', 'yes']);
export const PROTECTED_DECISIONS = Object.freeze(['protected', 'tests', 'hooks', 'force', 'proposal', 'train-config']);
export const decisionClass = (kind) => (BOARD_DECISIONS.includes(String(kind || '').trim().toLowerCase()) ? 'board' : 'protected');
/**
 * The owner's switch, STUDIO_PRODUCER_APPROVES=protected: a Producer/Director session may also make protected decisions.
 * Default off. Read from the main checkout's .env only (the owner's file), wherever the decision is made or checked: a
 * session's own environment, or a lane copy's, never turns it on.
 */
export function producerApprovesProtected(root = process.cwd()) {
  let main = root;
  try { main = mainCheckout(root); } catch { /* root as given */ }
  try { return /^protected$/i.test(String(parseStudioEnv(fs.readFileSync(path.join(main, '.env'), 'utf8')).STUDIO_PRODUCER_APPROVES || '').trim()); } catch { return false; }
}

// ---- 2.79 (c): what stays the owner's own, and outside signers ----
export { OWNER_ONLY, OWNER_ONLY_ACTIONS, ownerOnlyAction, ownerOnlyTopic, ownerOnlyWhy } from './owner-acts.mjs';

/**
 * The outside agents the owner lets sign as themselves while beta mode is on (the owner's words, 2026-11-06: "Grokbot and
 * Patch can approve as me"): STUDIO_OUTSIDE_SIGNERS (comma-separated names) in the main checkout's .env only, the owner's
 * file, like STUDIO_PRODUCER_APPROVES: a session's own environment or a lane copy's .env never adds one. A worker-shaped
 * name is never one. beta-mode.mjs adds these to beta mode's named agents.
 */
export function outsideSigners(root = process.cwd()) {
  let main = root;
  try { main = mainCheckout(root); } catch { /* root as given */ }
  let raw = '';
  try { raw = String(parseStudioEnv(fs.readFileSync(path.join(main, '.env'), 'utf8')).STUDIO_OUTSIDE_SIGNERS || ''); } catch { return []; }
  return [...new Set(raw.split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^[\w.-]{1,60}$/.test(x) && !WORKER_NAME.test(x)))];
}

/**
 * May this shell name itself with --by? Only one the harness didn't launch (no STUDIO_ROLE: every launched session,
 * worker or not, has it) and that names nobody else (no STUDIO_LOCK_OWNER). actorOf already judges such a shell "outside
 * the harness"; 2.79 (c): an outside agent that runs commands there (grokbot on the owner's PC, the orchestrator's chat
 * shell) is then the beta agent its --by names, if beta mode names it, and nobody else.
 */
export const selfNamingShell = (env = process.env) => !String(env.STUDIO_ROLE || '').trim() && !String(env.STUDIO_LOCK_OWNER || '').trim();

const readJsonQuiet = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
/**
 * The role a launched session ran under ('' when the name isn't one): its session record (.studio/agents/<name>.json,
 * written by the launcher, here or in the main checkout), else the launcher's name shape (producer-s1, director-2), else
 * "a producer session" (what a launched session without STUDIO_LOCK_OWNER records).
 */
export function launchedRole(name, root = process.cwd()) {
  const n = String(name || '').trim();
  if (!n) return '';
  const said = n.match(/^a (\w[\w-]*) session$/i);
  if (said) return said[1].toLowerCase();
  let main = root;
  try { main = mainCheckout(root); } catch { /* root as given */ }
  for (const r of new Set([root, main])) {
    const s = readJsonQuiet(path.join(r, '.studio', 'agents', `${n.replace(/[^\w.-]/g, '_')}.json`));
    if (s && String(s.role || '').trim()) return String(s.role).trim().toLowerCase();
  }
  const shape = n.match(/^(producer|director)(?:-|_|\d|$)/i);
  return shape ? shape[1].toLowerCase() : '';
}
const RANK = { outside: 0, decider: 1, worker: 2 };
const worst = (tiers) => tiers.reduce((a, t) => (RANK[t] > RANK[a] ? t : a), 'outside');
/** 'worker' | 'decider' | 'outside' for a name (an agent name, a commit's Studio-Agent trailer, a record's recordedBy). */
export function nameTier(name, root) {
  const n = String(name || '').trim();
  if (!n) return 'outside';
  if (WORKER_NAME.test(n)) return 'worker';
  const role = launchedRole(n, root);
  if (!role) return 'outside';
  return DECIDER_ROLES.test(role) ? 'decider' : 'worker';
}
/**
 * Who this caller is, for a beta decision: { tier, name, role }. A launched session (STUDIO_ROLE, which the launcher
 * sets, or a name that is a launched session's) is a decider (Producer, Director) or a worker (any other role); anyone
 * else is outside the harness: the owner's own terminal or an outside agent (the orchestrator).
 */
export function actorOf({ env = process.env, root = process.cwd() } = {}) {
  const role = String(env.STUDIO_ROLE || '').trim().toLowerCase();
  const name = String(env.STUDIO_LOCK_OWNER || '').trim();
  const byRole = role ? (DECIDER_ROLES.test(role) ? 'decider' : 'worker') : 'outside';
  return { tier: worst([byRole, nameTier(name, root)]), name, role: role || launchedRole(name, root) };
}
/**
 * Who made a beta record: the worst of the role it says it was made under (approval.via "beta <role>"), who recorded it
 * and the Studio-Agent trailers of the commit that holds it.
 */
export function recordTier({ via = '', recordedBy = '', committers = [] } = {}, root = process.cwd()) {
  // "beta producer" / "beta director" (betaActor's launched session), "beta agent" or "beta mode" (an outside agent).
  const m = String(via || '').trim().match(/^beta (\w[\w-]*)$/i);
  const byVia = !m ? 'outside' : DECIDER_ROLES.test(m[1]) ? 'decider' : WORKER_NAME.test(m[1]) ? 'worker' : 'outside';
  return worst([byVia, nameTier(recordedBy, root), ...[].concat(committers).map((c) => nameTier(c, root))]);
}
const askWho = (agents = []) => {
  const names = [].concat(agents).map((a) => String(a).trim()).filter(Boolean);
  return `ask the orchestrator${names.length ? ` (${names.join(', ')})` : ''} or the owner`;
};
/**
 * May this actor ({ tier } from actorOf or recordTier) make this kind of beta decision? { ok, cls, why }. `root`: the
 * checkout whose main checkout's .env holds the owner's switch. `agents`: the outside agents beta mode names, for the
 * refusal's "ask …".
 */
export function mayDecide(kind, actor, { root = process.cwd(), agents = [] } = {}) {
  const cls = decisionClass(kind);
  const tier = actor?.tier || 'worker';
  const what = cls === 'protected' ? 'protected decisions (protected files, weakened tests, hooks, task done --force, a protected config change)' : 'board decisions';
  if (tier === 'outside') return { ok: true, cls, why: '' };
  if (tier === 'worker') return { ok: false, cls, why: `a worker session makes no beta decisions, ${what} included: hand the task back (npm run task -- pause <ID> --note "…") and ${askWho(agents)}` };
  if (cls === 'board') return { ok: true, cls, why: '' };
  if (producerApprovesProtected(root)) return { ok: true, cls, why: '' };
  return { ok: false, cls, why: `a launched Producer/Director session doesn't make ${what} in beta mode: ${askWho(agents)}. The owner's switch STUDIO_PRODUCER_APPROVES=protected in the main checkout's .env (off by default; docs/SECURITY.md) lets Producer/Director sessions make them` };
}
