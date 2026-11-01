/**
 * harness/profile-guard.mjs — 2.30o: check the account profile before a session starts.
 *
 * In the Marina run the Director's planning pass was put on the builders' shared profile (all dedicated
 * ones were busy) and used that profile's allowance with no cap. Now, before any launch:
 *   - the session's profile is read from STUDIO_<ROLE>_PROFILE, or from the launch command
 *     (`-p <name>` / `--profile <name>` / `--profile=<name>`; for claude, agy, cursor's agent, grok, gemini and codex only
 *     --profile, since their -p is --print), else "default";
 *   - a Producer, Director or planner never starts on a profile listed in STUDIO_SHARED_PROFILES or
 *     STUDIO_BUILDER_PROFILES, nor on one a running builder is using (only once profiles are set up: with none,
 *     every session shares the one account and that rule would only starve planning);
 *   - a profile never runs more than STUDIO_PROFILE_MAX_SESSIONS (default: no limit) sessions at once,
 *     and STUDIO_PROFILE_<NAME>_MAX overrides it per profile.
 * A refusal is a plain message and a profile.refused event; nothing starts.
 */
import { emitEvent } from './event.mjs';
import { PLANNING_ROLES } from './stall.mjs';

const key = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const list = (v) => String(v || '').split(/[\s,]+/).filter(Boolean);

// 2.58.3 (P-069): these agent CLIs use -p for --print (a prompt), never for a profile: `claude -p --permission-mode …`
// read as profile "--permission-mode" refused every Producer and Director while one builder ran (62 refusals in a run).
const PRINT_P = new Set(['claude', 'agy', 'agent', 'grok', 'gemini', 'codex', 'cursor-agent']);
const progName = (cmd) => (String(cmd || '').trim().split(/\s+/)[0] || '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop().replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();

export function profileOf(role, cmd = '', env = process.env) {
  const own = env[`STUDIO_${key(role)}_PROFILE`];
  if (own) return own;
  const flags = PRINT_P.has(progName(cmd)) ? '--profile' : '(?:-p|--profile)';
  const m = String(cmd || '').match(new RegExp(`(?:^|\\s)${flags}(?:\\s+|=)("?)([^\\s"]+)\\1`));
  // A flag is never a profile name (`-p --model x`).
  return m && !m[2].startsWith('-') ? m[2] : 'default';
}

/** Has this studio set up account profiles at all? Without any, every session shares one account ("default"). */
export function profilesConfigured(env = process.env) {
  return Object.keys(env).some((k) => /^STUDIO_[A-Z0-9_]+_PROFILE$/.test(k) && env[k]) || Boolean(String(env.STUDIO_SHARED_PROFILES || '').trim() || String(env.STUDIO_BUILDER_PROFILES || '').trim());
}

/** Pure: may this role start on this profile, given the running sessions ({ role, profile }) */
export function profileGuard({ role, profile, running = [], env = process.env }) {
  const r = String(role || '').toLowerCase();
  const on = running.filter((s) => (s.profile || 'default') === profile);
  if (PLANNING_ROLES.has(r)) {
    const shared = new Set([...list(env.STUDIO_SHARED_PROFILES), ...list(env.STUDIO_BUILDER_PROFILES)]);
    if (shared.has(profile)) return { ok: false, why: `the ${r} never runs on the shared builder profile "${profile}"; give it its own (STUDIO_${key(r)}_PROFILE)` };
    // 2.58.3 (P-069): with no profiles set up there is only the one account, so "a builder is on it" can't be avoided;
    // refusing would only starve planning (the Producer and Director were refused 62 times in one run).
    const b = profilesConfigured(env) ? on.find((s) => !PLANNING_ROLES.has(String(s.role || '').toLowerCase())) : null;
    if (b) return { ok: false, why: `profile "${profile}" is in use by ${b.agent || 'a builder'} (${b.role}); the ${r} needs its own profile (STUDIO_${key(r)}_PROFILE)` };
  }
  const max = Number(env[`STUDIO_PROFILE_${key(profile)}_MAX`] ?? env.STUDIO_PROFILE_MAX_SESSIONS ?? 0);
  if (max > 0 && on.length >= max) return { ok: false, why: `profile "${profile}" already runs ${on.length} session${on.length === 1 ? '' : 's'} (limit ${max})` };
  return { ok: true, why: '' };
}

export function refuse(role, profile, why) {
  emitEvent({ type: 'profile.refused', agent: 'launcher', to: 'producer', status: 'blocked', msg: `Not started (${role} on ${profile}): ${why}` });
}
