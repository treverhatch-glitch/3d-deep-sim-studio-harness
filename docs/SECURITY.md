# Security Notes

## Hub
- Default bind is `127.0.0.1` (see `HUB_HOST` in `.env`). `npm run setup` writes a random `HUB_TOKEN` to `.env`.
- Writes need the token in `X-Hub-Token` or `Authorization: Bearer`; a cookie or query string never authorizes a write.
- The WebSocket needs the token (`/ws?token=`) and a same-origin page.
- Placeholder tokens (`change-me…`) and tokens shorter than 24 characters never authorize anything.
- On a loopback bind, requests whose Host header is not localhost are refused (DNS rebinding). Add names with `HUB_ALLOWED_HOSTS`.
- A non-loopback bind (`HUB_HOST=0.0.0.0`) refuses to start without a strong token, and then every read needs the token too.
  Prefer `127.0.0.1` plus Tailscale serve or SSH forwarding for phone access.
- `qa/hub-smoke.mjs` (a required gate) starts the real server and checks every rule above.
- Open CORS is disabled.

## Locks
- Use `node harness/lock.mjs claim <key> --owner <agent>` before editing shared files or starting a task.
- `node harness/task.mjs start <ID> --agent <unique>` refuses a task that is already claimed; `done` only works for its owner.
- Shared owner names (`cursor`, `claude`, `builder`, …) are refused. A folder lock covers every file under it.
- `npm run hooks:install` wires `scripts/hooks/pre-commit`: staged secrets and files locked by another owner block the commit.
- Release with `node harness/lock.mjs release <key> --owner <agent>` when done.

## Failures
- Closed-loop writes the cartridge, seed, the tick the cartridge failed on, and every action to `.studio/last-seed-failure.json`.
- Do not trust hardcoded demo seeds for real bugs.

## Secrets
- `node scripts/secret-scan.mjs` scans what git would publish (tracked + untracked, not ignored), so a real `.env` never trips it.
- Patterns cover OpenAI (incl. `sk-proj-`), Anthropic, OpenRouter, NVIDIA, Groq, xAI, Google, AWS, GitHub, Slack, Hugging Face, Replicate and private keys.
