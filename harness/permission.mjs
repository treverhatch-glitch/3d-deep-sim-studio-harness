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

// Launched sessions that may act on a person's permission.
export const DECIDER_ROLES = /^(producer|director)$/i;
// Worker agents: never, with or without permission (names as the launcher hands them out: builder-s3, qa-playtester-s2).
export const WORKER_NAME = /^(builder|rnd|qa|qa-playtester|playtester|reviewer|art|artist|art-director|designer|designer-calibrator|balancer|fun-tester|scout|reference-scout|engine-porter|dev-hacker|planner|liaison)(-|_|\d|$)/i;
// A coding agent's own shell (outside the harness).
export const AGENT_SHELL = ['CLAUDECODE', 'AI_AGENT', 'CODEX_SANDBOX', 'GEMINI_CLI'];

export const permissionText = (p) => String(p || '').trim();

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
