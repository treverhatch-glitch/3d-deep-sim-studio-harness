# `.studio/` — Runtime Telemetry & Subscription Usage State

Default location for persistent zero-token runtime data read by the Workflow UI HUB (`hub/WarRoom.tsx` & `hub/server.mjs`):

- **`events.jsonl`** — Append-only event log written by `node scripts/append-event.mjs`, `harness/event.mjs`, `harness/route.mjs`, and `qa/playtest.mjs`. Survives reboots (unlike `/tmp`).
- **`usage.json`** — Subscription & free-tier quota tracker rendered by the **Subscription Usage Panel** inside `hub/WarRoom.tsx`.
- **`cooldowns.json`** — Per-channel `freecc:auto` 30s+ cooldown state managed by `harness/route.mjs`.
- **`runs/<run-id>/ledger.json`** — Per-dispatch routing ledger (UltraGameStudio pattern).

Watching `.studio/events.jsonl` and `.studio/usage.json` in the HUB uses **0% LLM tokens**.
