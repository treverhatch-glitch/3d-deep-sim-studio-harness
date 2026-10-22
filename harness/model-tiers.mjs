/**
 * harness/model-tiers.mjs — per-role model defaults, as a strong suggestion (2.29.2). Nothing is enforced.
 *
 * Test #4's overnight run put the top tier on every role: 104 of 104 sessions. The suggestion:
 * builders and the Producer on a mid tier, the planner, the Director and hard ports on the top tier,
 * summaries and check-ins on a cheap tier, and the reviewer from another model family.
 * If the game dev sets the top tier on every role anyway, the War Room shows a warning they accept
 * with one click (and `npm run models:check` prints it); the studio runs either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents } from './event.mjs';
import { modelFamily } from './families.mjs';

export const ROLES_CHECKED = ['producer', 'director', 'planner', 'builder', 'reviewer', 'qa-playtester'];
export const SUGGESTED = {
  producer: 'mid', builder: 'mid', director: 'top', planner: 'top', 'engine-porter': 'top', reviewer: 'mid (another family)', 'qa-playtester': 'cheap', watch: 'cheap', summary: 'cheap',
};
export const TIER_EXAMPLES = { top: 'claude-opus-*, gpt-5*, gemini-*-pro, grok-4', mid: 'claude-sonnet-*, grok-*-fast, gpt-*-mini', cheap: 'claude-haiku-*, gemini-*-flash, glm-*, deepseek-*-flash' };
export const WARNING_TEXT = 'Overpowered models on every task may not be efficient and can weaken cross-family checks.';
const ACCEPT_FILE = path.join(STUDIO_STATE_DIR, 'model-warning.json');

/** top | mid | cheap | unknown, from the model's name. */
export function tierOf(model) {
  const m = String(model || '').toLowerCase();
  if (!m || m === 'unknown') return 'unknown';
  if (/haiku|flash|nano|lite|\bglm|small|\b\d+b\b|-\d+b\b|qwen2\.5-coder|llama/.test(m)) return 'cheap';
  if (/[-_]mini\b|sonnet|fast/.test(m)) return 'mid';
  if (/opus|gemini-[\d.]+-pro|-pro\b|grok-4|gpt-5|\bo3\b|o3-/.test(m)) return 'top';
  return 'mid';
}

const roleKey = (role) => String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** The model each role would start on (its STUDIO_<ROLE>_MODEL, else STUDIO_AGENT_MODEL), and models seen in the last day. */
export function roleModels(env = process.env, events = readRecentEvents(20000), now = Date.now()) {
  const configured = ROLES_CHECKED.map((role) => ({ role, model: env[`STUDIO_${roleKey(role)}_MODEL`] || env.STUDIO_AGENT_MODEL || null })).filter((r) => r.model);
  const seen = {};
  for (const e of events) if (e.type === 'agent.session.start' && Date.parse(e.ts) > now - 86400000 && e.model && e.model !== 'unknown') seen[e.meta?.role || 'agent'] = e.model;
  return { configured, seen: Object.entries(seen).map(([role, model]) => ({ role, model })) };
}

/**
 * The warning: shown when every role the studio is set to (or ran in the last day) is on the top tier,
 * and the game dev hasn't accepted this exact set of models.
 */
export function modelWarning(env = process.env, events = readRecentEvents(20000), now = Date.now()) {
  const { configured, seen } = roleModels(env, events, now);
  const rows = configured.length ? configured : seen;
  const roles = rows.map((r) => ({ ...r, tier: tierOf(r.model), family: modelFamily(r.model), suggested: SUGGESTED[r.role] || 'mid' }));
  const allTop = roles.length >= 2 && roles.every((r) => r.tier === 'top');
  const oneFamily = roles.length >= 2 && new Set(roles.map((r) => r.family)).size === 1;
  const signature = [...new Set(roles.map((r) => r.model))].sort().join(',');
  const accepted = readAccepted();
  const isAccepted = Boolean(accepted && accepted.signature === signature);
  return { show: allTop && !isAccepted, allTop, oneFamily, accepted: isAccepted ? accepted : null, signature, roles, text: WARNING_TEXT, source: configured.length ? 'config' : 'sessions' };
}

export function readAccepted() {
  try {
    return JSON.parse(fs.readFileSync(ACCEPT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** The game dev clicked "I accept": recorded with who, when and for which models; a different set asks again. */
export function acceptModelWarning(by = 'war-room-human', env = process.env) {
  const w = modelWarning(env);
  const rec = { signature: w.signature, by: String(by).slice(0, 60), at: new Date().toISOString(), text: WARNING_TEXT };
  fs.mkdirSync(path.dirname(ACCEPT_FILE), { recursive: true });
  fs.writeFileSync(ACCEPT_FILE, `${JSON.stringify(rec, null, 2)}\n`);
  emitEvent({ type: 'models.warning.accepted', agent: rec.by, to: 'producer', msg: `${rec.by} accepted top-tier models on every role (${w.signature || 'none set'}): ${WARNING_TEXT}` });
  return { ok: true, accepted: rec };
}
