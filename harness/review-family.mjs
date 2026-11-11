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
 * 2.84: "which families are configured" is no longer the calling session's environment alone (a session controls its
 * own environment, so unsetting the variables made "no other family" true). It is the UNION of the main checkout's .env
 * (only the model/tool settings), studio/models.json there, and the environment: the environment can add a family, never
 * remove one. The main checkout is found by git (owner-proxy.mjs mainCheckout), never from STUDIO_MAIN_ROOT.
 * 2.84 (g): the studio's switch (studio/review.json in the main checkout, `npm run review -- same-family on|off|auto`), the
 * owner's decision: "Patch should be allowed to choose to turn off and on the same-family review ... we are still in beta
 * and with limited resources". auto: the rules above. on: a same-family review counts whether or not another family is
 * configured (header still required, so every one is visible); a review may be planned on the implementer's own family when
 * no other-family model is live. off: a same-family review never counts. The file is read from the main checkout only and no
 * environment variable can turn it on; who may change it is the harness's board-decision verdict (harness/review.mjs).
 */
import { modelFamily } from './families.mjs';
import { budgetStopFor } from './budget.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';
import { mainCheckout } from './owner-proxy.mjs';
import { parseStudioEnv } from './dotenv.mjs';

export const SAME_FAMILY_HEADER = 'same-family: no other family available';
// 2.84 (g): the second header, written when the studio allows same-family reviews (switch "on").
export const SAME_FAMILY_ALLOWED_HEADER = 'same-family: allowed by the studio';
// Either wording (the check for "this review says it is same-family"); the old one alone is the auto setting's header.
export const SAME_FAMILY_RE = /^[ \t>*_#-]*same-family[ \t*_]*:[ \t*_]*(?:no other family available|allowed by the studio)\b/im;
export const SAME_FAMILY_NONE_RE = /^[ \t>*_#-]*same-family[ \t*_]*:[ \t*_]*no other family available\b/im;
export const SAME_FAMILY_FILE_REL = 'studio/review.json';
export const SAME_FAMILY_COMMAND = 'npm run review -- same-family on|off|auto --by <who> [--why "..."]';
export const SAME_FAMILY_WHO = 'the owner, the overseer (the owner\'s proxy, a beta-mode agent the owner named, or an outside signer); never a worker session';
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

const MODEL_SETTING = (k) => /^STUDIO_(?:[A-Z0-9]+_)*MODELS?$/.test(k) || /^STUDIO_TOOL_[A-Z0-9]+_MODEL$/.test(k) || k === 'STUDIO_REVIEW_TOOLS' || k === 'STUDIO_REVIEWER_TOOL';

/**
 * 2.84: the studio's main checkout, for reading its files. Found by git (never from an environment variable a session
 * could set); a lane copy that is not a git worktree of it is found from its path (<main>/.lanes/<name>).
 */
export function studioRoot(from = REPO_ROOT) {
  const m = mainCheckout(from);
  if (path.resolve(m) !== path.resolve(from)) return m;
  const p = String(from).replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+$/);
  return p && fs.existsSync(path.join(p[1], '.git')) ? path.resolve(p[1]) : m;
}

/** The model/tool settings of root's .env: only those names are kept, nothing else leaves this function. */
function envFileModels(root) {
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); } catch { return []; }
  const all = parseStudioEnv(text);
  const keep = {};
  for (const k of Object.keys(all)) if (MODEL_SETTING(k)) keep[k] = all[k];
  return configuredModels(keep);
}

/** The model names studio/models.json itself holds (its own pools; the built-in defaults are not read). */
function modelsFileModels(root) {
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'models.json'), 'utf8')); } catch { return []; }
  const names = [];
  for (const v of Object.values(j?.pools && typeof j.pools === 'object' ? j.pools : {})) {
    if (!v || typeof v !== 'object') continue;
    const n = String(v.model || '').trim();
    if (n && !/[,]/.test(n)) names.push(n);
  }
  return configuredModels({ STUDIO_RESCUE_MODELS: names.join(',') });
}

/**
 * Every configured model with where it came from: [{ model, source }], source '.env' | 'studio/models.json' |
 * 'environment'. The union of the three; the environment never removes one the files name.
 */
export function configuredSources({ root, env = process.env } = {}) {
  const r = root || studioRoot();
  const out = [];
  const add = (list, source) => { for (const model of list) if (!out.some((o) => o.model === model && o.source === source)) out.push({ model, source }); };
  add(configuredModels(env), 'environment');
  add(envFileModels(r), '.env');
  add(modelsFileModels(r), 'studio/models.json');
  return out;
}

/** { families: sorted list, sources: { family: [where, ...] }, models: [distinct model names, in order] } */
export function configuredFamilies({ root, env = process.env } = {}) {
  const rows = configuredSources({ root, env });
  const sources = {};
  for (const { model, source } of rows) {
    const f = modelFamily(model);
    if (f === 'unknown') continue;
    const list = (sources[f] ||= []);
    if (!list.includes(source)) list.push(source);
  }
  return { families: Object.keys(sources).sort(), sources, models: [...new Set(rows.map((r) => r.model))] };
}

/**
 * 2.84 (g): the switch as the main checkout holds it: { value: 'auto' | 'on' | 'off', by, at, why, set }. No file, an
 * unreadable one, or a value that is not one of the three words is `auto` (set false). Never reads the environment.
 */
export function readSameFamily({ root } = {}) {
  const r = root || studioRoot();
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(r, 'studio', 'review.json'), 'utf8')); } catch { /* auto */ }
  const v = String(j?.sameFamily ?? '').trim();
  if (!j || typeof j !== 'object' || !['on', 'off', 'auto'].includes(v)) return { value: 'auto', by: null, at: null, why: '', set: false };
  const clip = (x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return { value: v, by: clip(j.by) || 'someone', at: clip(j.at) || null, why: clip(j.why), set: true };
}
const setBy = (s) => `set by ${s.by}${s.at ? ` on ${String(s.at).slice(0, 10)}` : ''}`;

/** Another family than the implementer's is configured (out of quota or not)? Unknown implementer: no (nothing to compare). */
export function otherFamilyConfigured(implementer, env = process.env, { root } = {}) {
  const impl = modelFamily(implementer);
  if (impl === 'unknown') return false;
  return configuredFamilies({ root, env }).families.some((f) => f !== impl);
}

/** Which other family is configured and where it was found (file name or "environment"), or null. */
export function otherFamilyFound(implementer, env = process.env, { root } = {}) {
  const impl = modelFamily(implementer);
  if (impl === 'unknown') return null;
  const c = configuredFamilies({ root, env });
  const f = c.families.find((x) => x !== impl);
  return f ? { family: f, where: c.sources[f][0], all: c.sources[f] } : null;
}

/**
 * The words for a refused same-family review: which setting applied (off, or auto with the other family and where it was
 * found), and the command that changes it with who may run it. `text` (the review's text, when the caller has it) adds
 * the header the reviewer should write when there is none. '' when the review needs no words (nothing refused).
 */
export function sameFamilyRefusal(implementer, env = process.env, { root, text = null } = {}) {
  const sw = readSameFamily({ root });
  const hasHeader = text === null ? true : SAME_FAMILY_RE.test(String(text).replace(/\r\n/g, '\n'));
  const change = `change it with: ${SAME_FAMILY_COMMAND}; ${SAME_FAMILY_WHO}`;
  if (sw.value === 'off') return `same-family reviews are switched off in ${SAME_FAMILY_FILE_REL} (${setBy(sw)}), so this one does not count with or without a header; ${change}`;
  if (sw.value === 'on') return hasHeader ? '' : `the studio allows same-family reviews (${setBy(sw)}); write \`${SAME_FAMILY_ALLOWED_HEADER}\` in the review header`;
  const o = otherFamilyFound(implementer, env, { root });
  if (o) return `the same-family header does not apply: ${o.family} is configured (found in ${o.where}); the setting is auto (${SAME_FAMILY_FILE_REL}); ${change}`;
  return hasHeader ? '' : `write \`${SAME_FAMILY_HEADER}\` in the review header (no other family is configured)`;
}

/**
 * Which model a review of `implementer`'s work runs on. { model, tool, kind, note }:
 *   kind 'other'  a configured model of another family that isn't out of quota
 *   kind 'kept'   another family is configured but out of quota now: the review stays as it is and waits (no note)
 *   kind 'same'   no other family configured: a different model of the implementer's family, else the same; `note` is the
 *                 line for the task's brief
 *   kind 'none'   the implementer's family is unknown: nothing to decide
 */
export function reviewerPlan({ implementer, current = null, env = process.env, now = Date.now(), root } = {}) {
  const impl = modelFamily(implementer);
  if (impl === 'unknown') return { model: current, kind: 'none', note: null };
  const models = configuredFamilies({ root, env }).models;
  const live = (m) => !budgetStopFor({ tool: 'custom', model: m }, now, env).stopped;
  const sw = readSameFamily({ root });
  const other = models.filter((m) => modelFamily(m) !== impl && modelFamily(m) !== 'unknown');
  if (other.length) {
    if (current && modelFamily(current) !== impl && modelFamily(current) !== 'unknown' && live(current)) return { model: current, kind: 'other', note: null };
    const pick = other.find(live);
    // 2.84 (g): cross-family stays the first choice; "on" only removes the dead end when every other-family model is out of quota.
    if (pick) return { model: pick, kind: 'other', note: null };
    if (sw.value !== 'on') return { model: current, kind: 'kept', note: null };
  }
  // 2.84 (g): "off": a same-family review would never count, so none is planned; the review waits for another family.
  if (sw.value === 'off') return { model: current, kind: 'kept', note: null };
  const same = models.filter((m) => modelFamily(m) === impl);
  const diff = (current && current !== implementer && modelFamily(current) === impl && live(current) ? current : null) || same.find((m) => m !== implementer && live(m)) || same.find((m) => m !== implementer);
  const model = diff || implementer;
  if (sw.value === 'on') return { model, kind: 'same', note: `${other.length ? 'Every model of another family is out of quota' : 'No model from another family is configured'}, and the studio allows same-family reviews (${setBy(sw)}): this review may be done by ${model}; write \`${SAME_FAMILY_ALLOWED_HEADER}\` in the review header.` };
  return { model, kind: 'same', note: `No model from another family is configured: this review may be done by ${model}; write \`${SAME_FAMILY_HEADER}\` in the review header.` };
}

/**
 * Does this same-family review count? { ok, setting: 'auto'|'on'|'off', header, note }. off: never. on: either header (the
 * studio allows it; `note` says who set it). auto: the old header and no other family configured (2.83, 2.84 b).
 */
export function sameFamilyDecision(text, implementer, env = process.env, { root } = {}) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const sw = readSameFamily({ root });
  if (sw.value === 'off') return { ok: false, setting: 'off', header: null, note: '' };
  if (sw.value === 'on') {
    const ok = SAME_FAMILY_RE.test(t);
    return { ok, setting: 'on', header: SAME_FAMILY_NONE_RE.test(t) ? SAME_FAMILY_HEADER : SAME_FAMILY_ALLOWED_HEADER, note: ok ? `counted because the studio allows same-family reviews (${setBy(sw)})` : '' };
  }
  const ok = SAME_FAMILY_NONE_RE.test(t) && !otherFamilyConfigured(implementer, env, { root });
  return { ok, setting: 'auto', header: SAME_FAMILY_HEADER, note: '' };
}
export const sameFamilyAccepted = (text, implementer, env = process.env, { root } = {}) => sameFamilyDecision(text, implementer, env, { root }).ok;

/**
 * The launch decision for a review task: which task it reviews (the other T-<n> in its title), who built that (the model
 * of its last task.start in `events`), and reviewerPlan for it. null when the title names no task or no model is on record.
 * { reviewed, implementer, model, kind, note }.
 */
export function reviewLaunch({ taskId, title, events = [], current = null, env = process.env, now = Date.now(), root } = {}) {
  const reviewed = (String(title || '').match(/\bT-\d+\b/g) || []).find((x) => x !== taskId);
  if (!reviewed) return null;
  const implementer = events.filter((e) => e.type === 'task.start' && e.task === reviewed && e.model && e.model !== 'unknown').pop()?.model;
  if (!implementer) return null;
  return { reviewed, implementer, ...reviewerPlan({ implementer, current, env, now, root }) };
}
