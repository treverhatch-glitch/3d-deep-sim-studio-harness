# .studio

Default location for runtime event data.

- `events.jsonl` — append-only log written by `scripts/append-event.sh` and read by the HUB.
- Survives reboots (unlike `/tmp`).

The visual HUB (`hub/`) watches this file with zero LLM tokens.
