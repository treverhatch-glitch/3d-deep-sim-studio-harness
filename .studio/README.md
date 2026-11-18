# `.studio/` — Runtime Telemetry & Subscription Usage State

Default location for persistent zero-token runtime data read by the harness's CLIs (`npm run studio:status`, `npm run status -- --brief`, the digest):

- **`events.jsonl`** — Append-only event log written by `node scripts/append-event.mjs`, `harness/event.mjs`, `harness/route.mjs`, and `qa/playtest.mjs`. Survives reboots (unlike `/tmp`).
- **`usage.json`** — Subscription & free-tier quota tracker (a record to fill in; no command reads it now).
- **`cooldowns.json`** — Per-channel `freecc:auto` 30s+ cooldown state managed by `harness/route.mjs`.
- **`runs/<run-id>/ledger.json`** — Per-dispatch routing ledger (UltraGameStudio pattern).

Reading `.studio/events.jsonl` uses **0% LLM tokens**.
