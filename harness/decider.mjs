/**
 * harness/decider.mjs — 2.68.0: who may take a decision the harness leaves to a person (resume a paused role, delete a
 * stale lane copy, end a wind-down by hand), with the same people as `task hold`, made exact:
 *   - a person in their own terminal (no agent marker, and --by isn't an agent's name);
 *   - an agent under the owner's standing delegation for `hold` (harness/delegation.mjs; --by is that agent);
 *   - a Producer or Director session, or an agent outside the harness, on a person's direct permission
 *     (--by <the person> --permission "<their words or a link>", harness/permission.mjs);
 *   - never a worker (a launched builder, qa, … session, or a worker's name in --by or STUDIO_LOCK_OWNER).
 * deciderCheck() returns { ok, via, by, recordedBy, permission, delegation, why }. Every import is dynamic, so this
 * module can be loaded from anywhere without a cycle.
 */

export async function deciderCheck({ by, permission = '', action = 'hold', env = process.env, what = 'do this' } = {}) {
  const who = String(by || '').trim();
  if (!who) return { ok: false, why: `Say who decides: --by <name>.` };
  const { DECIDER_ROLES, WORKER_NAME, AGENT_SHELL, agentOnPermission, permissionText } = await import('./permission.mjs');
  const role = String(env.STUDIO_ROLE || '').trim();
  const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
  const marker = AGENT_SHELL.find((k) => String(env[k] || '').trim());
  if (role && !DECIDER_ROLES.test(role)) return { ok: false, why: `Refused: a launched ${role} session can't ${what}; a person, an agent under the owner's delegation, or a Producer or Director session or an outside agent on a person's direct permission can.` };
  const worker = [owner, who].find((n) => n && WORKER_NAME.test(n));
  if (worker) return { ok: false, why: `Refused: ${worker} is a worker agent; workers never ${what}.` };
  try {
    const dl = await import('./delegation.mjs');
    const dg = dl.delegationFor({ action, by: who, env });
    if (dg.ok) return { ok: true, via: 'delegation', by: who, recordedBy: who, permission: dg.permission, delegation: { at: dg.at, owner: dg.owner } };
  } catch { /* no delegation module or file: the other rules apply */ }
  const { agentLikeName } = await import('./agent-env.mjs');
  const agent = Boolean(role || marker || owner);
  if (agent) {
    const perm = permissionText(permission);
    if (!perm) return { ok: false, why: `Refused: an agent may ${what} only on a person's direct permission (--by <the person> --permission "<their words or a link>") or under the owner's delegation for ${action}.` };
    const p = agentOnPermission({ permission: perm, env });
    if (!p.ok) return { ok: false, why: `Refused: ${p.why}.` };
    if (agentLikeName(who)) return { ok: false, why: `Refused: "${who}" is an agent's name; --by names the person whose permission this is.` };
    return { ok: true, via: p.via, by: who, recordedBy: p.recordedBy, permission: perm.slice(0, 300) };
  }
  if (agentLikeName(who)) return { ok: false, why: `Refused: "${who}" is an agent's name; --by names the person deciding.` };
  return { ok: true, via: 'person', by: who, recordedBy: who, permission: '' };
}
