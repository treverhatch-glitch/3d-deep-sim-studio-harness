/**
 * harness/profile-guard.mjs — 2.30o: check the account profile before a session starts.
 *
 * In the Marina run the Director's planning pass was put on the builders' shared profile (all dedicated
 * ones were busy) and used that profile's allowance with no cap. Now, before any launch:
 *   - the session's profile is read from STUDIO_<ROLE>_PROFILE, or from the launch command
 *     (`-p <name>` / `--profile <name>` / `--profile=<name>`), else "default";
 *   - a Producer, Director or planner never starts on a profile listed in STUDIO_SHARED_PROFILES or
 *     STUDIO_BUILDER_PROFILES, nor on one a running builder is using;
 *   - a profile never runs more than STUDIO_PROFILE_MAX_SESSIONS (default: no limit) sessions at once,
 *     and STUDIO_PROFILE_<NAME>_MAX overrides it per profile.
 * A refusal is a plain message and a profile.refused event; nothing starts.
 */
import { emitEvent } from './event.mjs';
import { PLANNING_ROLES } from './stall.mjs';

const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const list = (v) => String(v || '').split(/[\s,]+/).filter(Boolean);

export function profileOf(role, cmd = '', env = process.env) {
  const own = env[`STUDIO_${key(role)}_PROFILE`];
  if (own) return own;
  const m = String(cmd || '').match(/(?:^|\s)(?:-p|--profile)(?:\s+|=)("?)([^\s"]+)\1/);
  return m ? m[2] : 'default';
}

/** Pure: may this role start on this profile, given the running sessions ({ role, profile }) */
export function profileGuard({ role, profile, running = [], env = process.env }) {
  const r = String(role || '').toLowerCase();
  const on = running.filter((s) => (s.profile || 'default') === profile);
  if (PLANNING_ROLES.has(r)) {
    const shared = new Set([...list(env.STUDIO_SHARED_PROFILES), ...list(env.STUDIO_BUILDER_PROFILES)]);
    if (shared.has(profile)) return { ok: false, why: `the ${r} never runs on the shared builder profile "${profile}"; give it its own (STUDIO_${key(r)}_PROFILE)` };
    const b = on.find((s) => !PLANNING_ROLES.has(String(s.role || '').toLowerCase()));
    if (b) return { ok: false, why: `profile "${profile}" is in use by ${b.agent || 'a builder'} (${b.role}); the ${r} needs its own profile (STUDIO_${key(r)}_PROFILE)` };
  }
  const max = Number(env[`STUDIO_PROFILE_${key(profile)}_MAX`] ?? env.STUDIO_PROFILE_MAX_SESSIONS ?? 0);
  if (max > 0 && on.length >= max) return { ok: false, why: `profile "${profile}" already runs ${on.length} session${on.length === 1 ? '' : 's'} (limit ${max})` };
  return { ok: true, why: '' };
}

export function refuse(role, profile, why) {
  emitEvent({ type: 'profile.refused', agent: 'launcher', to: 'producer', status: 'blocked', msg: `Not started (${role} on ${profile}): ${why}` });
}
