/**
 * harness/families.mjs — which company's model family a model name belongs to.
 * Used for cross-family reviews (a reviewer from another family) and for data exports (whose terms
 * apply to the work in a record).
 */
const FAMILIES = [
  [/claude|anthropic|opus|sonnet|haiku/i, 'anthropic'],
  [/gpt|openai|codex|\bo[134]\b|o[134]-/i, 'openai'],
  [/gemini|vertex|gemma|antigravity|\bagy\b/i, 'google'],
  [/grok|xai/i, 'xai'],
  [/qwen/i, 'qwen'],
  [/deepseek/i, 'deepseek'],
  [/llama|meta-/i, 'meta'],
  [/nemotron|nvidia/i, 'nvidia'],
  [/mistral|mixtral|codestral/i, 'mistral'],
  [/glm|zhipu/i, 'zhipu'],
  [/kimi|moonshot/i, 'moonshot'],
];

export function modelFamily(model) {
  const m = String(model || '');
  if (!m || m === 'unknown') return 'unknown';
  for (const [re, fam] of FAMILIES) if (re.test(m)) return fam;
  return m.split(/[-/:@]/)[0].toLowerCase() || 'unknown';
}

/** 2.30i: NVIDIA NIM sessions (free tier rate-limits parallel sessions). */
export function isNim(model, tool) {
  return /\bnim\b|nvidia|nemotron|integrate\.api\.nvidia/i.test(`${model} ${tool}`);
}

export function providerConcurrency(model, tool, env = process.env) {
  return isNim(model, tool) ? Math.max(1, Number(env.STUDIO_NIM_MAX_SESSIONS) || 1) : Infinity;
}
