# Multi-Model Failover & "Prepare Then Escalate" Routing (`docs/ROUTING.md`)

[`harness/route.mjs`](../harness/route.mjs) and [`harness/models.config.mjs`](../harness/models.config.mjs) implement a zero-server, vendor-neutral model router with automatic HTTP `429` / `5xx` failover.

---

## 1. Preferred Cost Order: Local → Free Tiers → Paid

1. **Local Model (`ollama-local` — `qwen2.5-coder:14b` / `32b`)**: use first for preparation and routine edits.
2. **Free Cloud Tiers**: NVIDIA NIM, Groq, OpenRouter `:free`, Vertex flash.
3. **Paid / High-Reasoning**: Claude, Grok, Gemini Pro, OpenAI — for hard changes only.

---

## 2. Cheap Model Prepares, Strong Model Executes

**Default for long history or escalated bugs:**

```bash
node harness/prepare-brief.mjs
node harness/route.mjs --role producer --prompt "$(cat .studio/briefs/latest.md)"
```

Rules:
- Use this path when context is long, logs are noisy, or a bug has escalated.
- Skip it for already-short, clear tasks (the extra step costs more than it saves).
- The strong model should receive the brief, not the raw logs.
- Closed-loop does **not** auto-fix. It records the failure and escalates after N attempts.

---

## 3. How to Add a New Model Endpoint in ~5 Lines

Open [`harness/models.config.mjs`](../harness/models.config.mjs) and add:

```js
  'my-custom-provider': {
    id: 'my-custom-provider',
    label: 'My OpenAI-Compatible Endpoint',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'my-model-id',
    envKeys: ['MY_CUSTOM_API_KEY'],
  },
```
