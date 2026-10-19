// Lightweight OpenAI-compatible failover client.
// Rules borrowed from UltraGameStudio freecc:auto:
// - Ordered providers
// - Skip on 429 / 5xx
// - Cool down 30s+
// - Return failure log when all fail

import { getAvailableModels } from "./models.config.mjs";

const cooldowns = new Map();

export async function route(prompt, options = {}) {
  const available = getAvailableModels();
  const failures = [];

  for (const model of available) {
    if (cooldowns.has(model.id) && Date.now() < cooldowns.get(model.id)) {
      failures.push({ model: model.id, reason: "cooldown" });
      continue;
    }

    try {
      // TODO: replace with actual fetch to model.baseURL + "/chat/completions"
      console.log(`[route] Trying ${model.id}`);
      // const res = await fetch(...)
      // if (res.status === 429 || res.status >= 500) throw new Error("retryable");

      // On success:
      return { model: model.id, content: "(stub response)" };
    } catch (err) {
      failures.push({ model: model.id, reason: err.message });
      cooldowns.set(model.id, Date.now() + 30_000);
    }
  }

  return { error: "all_failed", failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await route(process.argv[2] || "test");
  console.log(JSON.stringify(result, null, 2));
}
