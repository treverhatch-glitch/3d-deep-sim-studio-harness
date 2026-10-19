# Multi-Model Failover & "Prepare Then Escalate" Routing (`docs/ROUTING.md`)

[`harness/route.mjs`](../harness/route.mjs) and [`harness/models.config.mjs`](../harness/models.config.mjs) implement a zero-server, vendor-neutral model router with automatic HTTP `429` / `5xx` failover (`30s` cooldown ledger in `.studio/cooldowns.json`).

---

## 1. Preferred Cost Order: Local → Free Tiers → Paid

To scale a 100k+ line 3D simulation without exhausting budgets, always route tasks in this order:
1. **Local Model (`ollama-local` — `qwen2.5-coder:14b` / `32b`)**: `$0` cost, offline capable, zero rate limits. Ideal for context compression (`harness/prepare-brief.mjs`), boilerplate, and headless `bpy` scripts.
2. **Free Cloud Tiers & Credits (`nvidia-nim-glm`, `groq-llama-70b`, `openrouter-free`, `vertex-gemini-flash`)**: High-speed throughput for `builder`, `playtester`, and `designer-calibrator` tasks.
3. **Paid / High-Reasoning Escalation (`anthropic-claude`, `xai-grok`, `vertex-gemini-pro`, `openai-gpt4o`)**: Reserved for complex architecture, ADR gating, or bugs that fail closed-loop retries.

---

## 2. "Cheap Model Prepares, Strong Model Executes" (`harness/prepare-brief.mjs`)

Never feed raw `.studio/events.jsonl` logs or long chat histories directly into an expensive model (Opus, Grok, Gemini Pro). Instead, use the **Prepare Then Escalate** pipeline (skip for already-short tasks; use whenever history is long or a bug escalates):

```bash
# 1. Cheap/local model reads .studio/events.jsonl + studio/memory/failures.md
#    + studio/CURRENT_TASK.md + studio/NEXT.md + recent qa/reports/
#    and writes a constrained <= 300-word brief to .studio/briefs/latest.md:
node harness/prepare-brief.mjs

# 2. Strong model (or Producer) receives ONLY the <= 300-word brief:
node harness/route.mjs --role producer --prompt "$(cat .studio/briefs/latest.md)"
```

The prepared brief is also exposed at `GET /api/brief` so the Producer and Mission Control War Room can inspect it before escalation.

---

## 3. How to Add a New Model Endpoint in ~5 Lines

Open [`harness/models.config.mjs`](../harness/models.config.mjs) and add a 5-line entry inside `PROVIDERS`:

```js
  'my-custom-provider': {
    id: 'my-custom-provider',
    label: 'My OpenAI-Compatible Endpoint',
    protocol: 'openai', // 'openai' | 'anthropic' | 'ollama'
    baseUrl: 'https://api.example.com/v1',
    model: 'my-model-id',
    envKeys: ['MY_CUSTOM_API_KEY'],
  },
```

Then reference `'my-custom-provider'` in any role's `preferredChain` inside `studio/roles/<role>.md` or `ROLE_CHAINS` in `harness/models.config.mjs`.
