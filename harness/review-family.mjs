/**
 * harness/review-family.mjs — 2.83: a review in a crew that has only one model family.
 *
 * A review must come from another model family than the implementer's. A crew whose configured tools are all one
 * family could never satisfy that: two sessions started on such a review, each read the rule and handed back. Now:
 *   - a review is launched on a model of another family when one is configured and not out of quota (as before);
 *   - when NO other family is configured, it is launched on a different MODEL of the same family if one exists (else
 *     the same one), with one line in its brief saying so, and the reviewer writes `same-family: no other family
 *     available` in the review header;
 *   - the checks of a review (harness/done-check.mjs, `npm run review -- record`) accept that header only while no other
 *     family is configured. When one is configured, the header changes nothing and a same-family review is refused.
 * Pure functions over the environment; they read no files.
 */
import { modelFamily } from './families.mjs';
import { budgetStopFor } from './budget.mjs';

export const SAME_FAMILY_HEADER = 'same-family: no other family available';
export const SAME_FAMILY_RE = /^[ \t>*_#-]*same-family[ \t*_]*:[ \t*_]*no other family available\b/im;
const TOOLS = new Set(['claude', 'codex', 'agy', 'gemini', 'grok', 'custom', 'nim', 'vertex', 'aider', 'cursor', 'hermes']);
const TOOL_FAMILY = { claude: 'anthropic', codex: 'openai', agy: 'google', gemini: 'google', grok: 'xai' };

/** Every model the studio's settings name, in order: the *_MODEL / *_MODELS settings, "tool:model" entries, review tools. */
export function configuredModels(env = process.env) {
  const out = [];
  const add = (v) => {
    for (const raw of String(v || '').split(',')) {
      let m = raw.trim();
      if (!m) continue;
      const i = m.indexOf(':');
      if (i > 0 && TOOLS.has(m.slice(0, i).toLowerCase())) {
        const tool = m.slice(0, i).toLowerCase();
        m = m.slice(i + 1).trim();
        if (!m && TOOL_FAMILY[tool]) m = tool;
      }
      if (!m || /^(unknown|off|none|default|0|false|no)$/i.test(m)) continue;
      if (!out.includes(m)) out.push(m);
    }
  };
  for (const k of Object.keys(env).sort()) if (/^STUDIO_(?:[A-Z0-9]+_)*MODELS?$/.test(k) || /^STUDIO_TOOL_[A-Z0-9]+_MODEL$/.test(k)) add(env[k]);
  add(env.STUDIO_REVIEW_TOOLS);
  if (env.STUDIO_REVIEWER_TOOL && !env.STUDIO_REVIEWER_MODEL) add(env.STUDIO_REVIEWER_TOOL);
  return out;
}

/** Another family than the implementer's is configured (out of quota or not)? Unknown implementer: no (nothing to compare). */
export function otherFamilyConfigured(implementer, env = process.env) {
  const impl = modelFamily(implementer);
  if (impl === 'unknown') return false;
  return configuredModels(env).some((m) => modelFamily(m) !== impl && modelFamily(m) !== 'unknown');
}

/**
 * Which model a review of `implementer`'s work runs on. { model, tool, kind, note }:
 *   kind 'other'  a configured model of another family that isn't out of quota
 *   kind 'kept'   another family is configured but out of quota now: the review stays as it is and waits (no note)
 *   kind 'same'   no other family configured: a different model of the implementer's family, else the same; `note` is the
 *                 line for the task's brief
 *   kind 'none'   the implementer's family is unknown: nothing to decide
 */
export function reviewerPlan({ implementer, current = null, env = process.env, now = Date.now() } = {}) {
  const impl = modelFamily(implementer);
  if (impl === 'unknown') return { model: current, kind: 'none', note: null };
  const models = configuredModels(env);
  const live = (m) => !budgetStopFor({ tool: 'custom', model: m }, now, env).stopped;
  const other = models.filter((m) => modelFamily(m) !== impl && modelFamily(m) !== 'unknown');
  if (other.length) {
    if (current && modelFamily(current) !== impl && modelFamily(current) !== 'unknown' && live(current)) return { model: current, kind: 'other', note: null };
    const pick = other.find(live);
    return pick ? { model: pick, kind: 'other', note: null } : { model: current, kind: 'kept', note: null };
  }
  const same = models.filter((m) => modelFamily(m) === impl);
  const diff = (current && current !== implementer && modelFamily(current) === impl && live(current) ? current : null) || same.find((m) => m !== implementer && live(m)) || same.find((m) => m !== implementer);
  const model = diff || implementer;
  return { model, kind: 'same', note: `No model from another family is configured: this review may be done by ${model}; write \`${SAME_FAMILY_HEADER}\` in the review header.` };
}

/** A review text that carries the same-family line while the studio truly has no other family configured. */
export function sameFamilyAccepted(text, implementer, env = process.env) {
  return SAME_FAMILY_RE.test(String(text || '').replace(/\r\n/g, '\n')) && !otherFamilyConfigured(implementer, env);
}

/**
 * The launch decision for a review task: which task it reviews (the other T-<n> in its title), who built that (the model
 * of its last task.start in `events`), and reviewerPlan for it. null when the title names no task or no model is on record.
 * { reviewed, implementer, model, kind, note }.
 */
export function reviewLaunch({ taskId, title, events = [], current = null, env = process.env, now = Date.now() } = {}) {
  const reviewed = (String(title || '').match(/\bT-\d+\b/g) || []).find((x) => x !== taskId);
  if (!reviewed) return null;
  const implementer = events.filter((e) => e.type === 'task.start' && e.task === reviewed && e.model && e.model !== 'unknown').pop()?.model;
  if (!implementer) return null;
  return { reviewed, implementer, ...reviewerPlan({ implementer, current, env, now }) };
}
