# Security Notes

## Hub
- Default bind is `127.0.0.1` (see `HUB_HOST` in `.env`).
- Write endpoints require `HUB_TOKEN` via `X-Hub-Token` or `Authorization: Bearer`.
- Do not set `HUB_HOST=0.0.0.0` unless you understand the exposure.
- Open CORS is disabled.

## Locks
- Use `node harness/lock.mjs claim <key> --owner <agent>` before editing shared files or starting a task.
- `node harness/task.mjs start <ID>` refuses a task that is already claimed.
- Release with `node harness/lock.mjs release <key> --owner <agent>` when done.

## Failures
- Closed-loop writes the real seed/tick from playtest output to `.studio/last-seed-failure.json`.
- Do not trust hardcoded demo seeds for real bugs.
