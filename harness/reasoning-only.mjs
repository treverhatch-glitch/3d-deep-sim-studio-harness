/**
 * harness/reasoning-only.mjs — a reply that is all reasoning and no answer is a failed hand-off (2.30h, item 3).
 *
 * NIM's GLM spent whole replies on its reasoning and returned nothing usable (0 for 4 as a reviewer).
 * The router treats such a reply as a failure: the attempt is recorded (route.reasoning_only), every
 * other channel of the same model family is passed over for this call, and the next family in the chain
 * answers. A launched session whose final result is empty while it spent output tokens is handed back the
 * same way, with a note for the Director to route the task to another family.
 */
import { modelFamily } from './families.mjs';

const THINK = /<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/gi;
/** The answer once any inline reasoning block (<think>…</think>) is taken out. */
export const answerText = (content) => String(content ?? '').replace(THINK, '').trim();

/** True when the reply has reasoning (a field, or inline <think>) but no answer text. */
export function isReasoningOnly({ content = '', reasoning = '', tokensOut = 0 } = {}) {
  if (answerText(content)) return false;
  const inline = THINK.test(String(content || ''));
  THINK.lastIndex = 0;
  return Boolean(String(reasoning || '').trim()) || inline || Number(tokensOut) > 0;
}

/** Families to try next: the chain's order, without the family that just failed. */
export function otherFamilies(failedModel, chainModels) {
  const bad = modelFamily(failedModel);
  return chainModels.filter((m) => modelFamily(m) !== bad);
}

/**
 * A launched session's log (Claude stream-json or Codex JSON lines): did it end with an empty result
 * after spending output tokens? Then nothing usable came back.
 */
export function sessionReasoningOnly(log) {
  const lines = String(log || '').split(/\r?\n/).filter((l) => l.startsWith('{'));
  for (const l of lines.slice(-20).reverse()) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o.type !== 'result') continue;
    if (o.is_error) return false;
    const out = Number(o.usage?.output_tokens || 0);
    const turns = Number(o.num_turns || 0);
    return !String(o.result ?? '').trim() && out > 0 && turns <= 1;
  }
  return false;
}

/**
 * The Director's reroute for a task whose last hand-off was reasoning only: the family to leave, and the
 * model to start on. Candidates come from STUDIO_REROUTE_MODELS ("tool:model,tool:model", e.g.
 * "codex:gpt-5,claude:claude-sonnet-4-5"), first one of another family wins. With none set the reroute is
 * suggested in the event log (the Director and Producer see it), never forced.
 */
export function rerouteFor(task, events, env = process.env) {
  if (!task) return null;
  const last = events.filter((e) => e.task === task && /^(agent|route)\.reasoning_only$|^agent\.session\.start$/.test(e.type)).at(-1);
  if (!last || !/reasoning_only$/.test(last.type)) return null;
  const from = modelFamily(last.model);
  const cands = String(env.STUDIO_REROUTE_MODELS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.indexOf(':');
    return i > 0 ? { tool: x.slice(0, i), model: x.slice(i + 1) } : { tool: null, model: x };
  });
  const pick = cands.find((c) => modelFamily(c.model) !== from) || null;
  return { task, fromModel: last.model, fromFamily: from, applied: Boolean(pick), tool: pick?.tool || null, model: pick?.model || null };
}
