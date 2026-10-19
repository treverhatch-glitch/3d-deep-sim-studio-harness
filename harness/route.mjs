// Lightweight OpenAI-compatible failover client.
// Rules from UltraGameStudio freecc:auto:
// - Ordered providers
// - Skip on 429 / 5xx
// - Cool down 30s+
// - Return failure log when all fail

import { getAvailableModels } from "./models.config.mjs";

const cooldowns = new Map();
const COOLDOWN_MS = 30_000;

async function callModel(model, messages) {
  const url = `${model.baseURL.replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      temperature: 0.2,
    }),
  });

  if (res.status === 429 || res.status >= 500) {
    throw new Error(`retryable_${res.status}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`http_${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function route(prompt, options = {}) {
  const available = getAvailableModels();
  if (available.length === 0) {
    return { error: "no_keys", message: "Set VERTEX_API_KEY, NVIDIA_API_KEY, or GROQ_API_KEY" };
  }

  const messages = options.messages || [{ role: "user", content: prompt }];
  const failures = [];

  for (const model of available) {
    if (cooldowns.has(model.id) && Date.now() < cooldowns.get(model.id)) {
      failures.push({ model: model.id, reason: "cooldown" });
      continue;
    }

    try {
      console.error(`[route] Trying ${model.id}`);
      const content = await callModel(model, messages);
      return { model: model.id, content };
    } catch (err) {
      failures.push({ model: model.id, reason: err.message });
      if (err.message.startsWith("retryable_")) {
        cooldowns.set(model.id, Date.now() + COOLDOWN_MS);
      }
    }
  }

  return { error: "all_failed", failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const prompt = process.argv.slice(2).join(" ") || "Say hello in one sentence.";
  const result = await route(prompt);
  console.log(JSON.stringify(result, null, 2));
}
