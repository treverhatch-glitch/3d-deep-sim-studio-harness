# Recommended Upgrades

These make the harness stronger once the basics are running.

## High priority

- **Symbol-level code access** — Serena (or similar LSP-based MCP) so agents edit by symbol instead of reading whole files of a large codebase.
- **Real model keys** — Set `VERTEX_API_KEY`, `NVIDIA_API_KEY`, and/or `GROQ_API_KEY` so `harness/route.mjs` can actually fail over.
- **RTK + QMD** — Run `scripts/setup-token-savers.sh`.

## Medium priority

- Fill `studio/llms.txt` with the real sim API once it stabilizes.
- Add more path-scoped rules under `studio/rules/` as patterns emerge.
- Playwright helper for visual QA (secondary to programmatic playtests).

## Skip for now

- Full desktop studios (OhMyGame, UltraGameStudio apps)
- Heavy gateways (LiteLLM) unless the team grows
- n8n / Langfuse (the local HUB already covers zero-token monitoring)
