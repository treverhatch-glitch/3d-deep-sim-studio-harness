# Multi-Model Failover & "Prepare Then Escalate" Routing (`docs/ROUTING.md`)

[`harness/route.mjs`](../harness/route.mjs) and [`harness/models.config.mjs`](../harness/models.config.mjs) implement a zero-server, vendor-neutral model router with automatic HTTP `429` / `5xx` failover.

---

## 1. Preferred Cost Order: Local → Free Tiers → Paid

1. **Local Model (`ollama-local` — `qwen2.5-coder:14b` / `32b`)**: use first for preparation and routine edits.
2. **Free Cloud Tiers**: NVIDIA NIM, Groq, OpenRouter `:free`, Vertex flash.
3. **Paid / High-Reasoning**: Claude, Grok, Gemini Pro, OpenAI — for hard changes only.

---

## 2. Cheap Model Prepares, Strong Model Executes

The same shape as draft-then-verify decoding and bounded replay: a cheap model drafts, a script
checks, and the strong model never re-reads the full history.

```bash
npm run brief -- T-012 --model       # cheap or local model drafts, the script checks
npm run brief -- T-012               # script only (the default unless STUDIO_PREPARE=model)
```

What `harness/prepare-brief.mjs` does:

1. **Bounded window.** It reads only this task's last 25 events, its hand-off notes, the three
   lessons in `studio/memory/failures.md` that match its title, the newest QA result and the files
   the task touched. Never the whole log.
2. **Skip when short.** Under `STUDIO_PREPARE_MIN_WORDS` (default 500) words of history, no model
   is called; the strong agent reads the window as is. `--force` overrides.
3. **Cheap draft.** With `--model` (or `STUDIO_PREPARE=model`) it asks only local and free providers,
   local first (`STUDIO_PREPARE_CHAIN` to choose), for at most 300 words in five sections: Goal,
   Relevant history, Known pitfalls, Files to touch, Verify. The daily spend cap applies.
4. **Check.** The script rejects a draft that misses a section, runs over 300 words, doesn't name
   the task, or names files or task IDs that don't exist, and writes its own version instead,
   saying why.
5. **Hand over.** The brief goes to `.studio/briefs/<ID>.prepared.md` (and `latest.md`). The
   task's focus brief points to it, and a `brief.prepared` event tells the Producer who wrote it and
   how many words went in and out. Token savings are not claimed; the words are counted.

When to use it: long or handed-back tasks, escalated bugs, and before giving work to an expensive
model. Skip it for short, clear tasks; the focus brief from `task start` is already enough.
The closed loop still does not auto-fix: it records the failure and escalates after N attempts.

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
