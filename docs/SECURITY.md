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
  `--staged` scans only staged files (the pre-commit hook); the `secrets` gate runs it in verify.
- A hit prints the file, the line and the kind (for example `discord-bot-token` or `named-secret (JWT_SECRET)`), never the value.
- Provider key shapes (`harness/secrets.mjs`): OpenAI (incl. `sk-proj-`), Anthropic, OpenRouter, Stripe, NVIDIA, Groq, xAI, Google,
  AWS access key ids, GitHub, GitLab, Slack, Hugging Face, Replicate and private keys.
- Chat-bot and cloud tokens (PU-18): Discord bot tokens (three dot-separated base64url parts) and Discord webhook URLs
  (discord.com, discordapp.com, canary and ptb), Slack webhook URLs and app-level and refresh tokens, Telegram bot tokens
  (digits, a colon, then `AA` and 33 characters; on their own or in the Bot API address), and AWS secret access keys and
  session tokens written next to their names (`aws_secret_access_key`, `AWS_SECRET_ACCESS_KEY`, `SecretAccessKey`,
  `aws_session_token`).
- Named secrets: a value of 24 or more characters that looks random (a digit and a letter, enough entropy, not built from words,
  not a repeated unit or a counting run), given to a name ending in TOKEN, SECRET, SECRET_KEY, API_KEY, APIKEY, PRIVATE_KEY,
  PASSWORD or WEBHOOK(_URL), in env, JSON, YAML, TOML, INI, Dockerfiles or code. An unquoted value counts only on a line that
  starts with the name (env, YAML, TOML, also commented out or after `export`/`ENV`) or after a `--flag=`, and never in source
  code (`.py`, `.js`, `.ts`, `.go`, … where a bare value is an identifier); a webhook address counts when its path holds a
  random-looking part.
- Placeholders never count: empty, `<...>`, `${...}`, `$VAR`, `process.env.X`, `{{ ... }}`, `your-token-here`, `changeme`,
  `xxxx…`, `***`, `REDACTED`, anything with example, sample, dummy, fake or test in it, and one character repeated. The same goes
  for a provider's docs sample of a Discord, Slack, Telegram or AWS token (filler such as `XXXX…` or `EXAMPLE` in it).
- Base64-wrapped tokens: a whole quoted or assigned value of 40 to 400 base64 characters is decoded and scanned again for the
  token shapes above. Longer runs (images, fonts, data packs) and `data:` URIs are not decoded, and a key-shaped piece glued
  inside a longer base64 run is data, not a key.
- Not covered: a secret split across lines or built by string concatenation, a named value under 24 characters (most
  hand-typed passwords), an unquoted value glued to other text (an `.npmrc` auth line), provider tokens with no shape here
  (npm, PyPI, Twilio and the like, unless under a secret-sounding name), tokens in hex or other encodings, named secrets inside
  base64, and secrets in binary files. Exported data (`scrub` in `harness/secrets.mjs`, used by trajectory export and
  reviews) still removes only the provider key shapes.
