# Setup

## Token Savers (Recommended First)

### RTK (Rust Token Killer)

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
# or: brew install rtk-ai/tap/rtk
rtk gain   # verify after a few commands
```

RTK intercepts shell output (vitest, git, tsc, etc.) and strips noise before the agent sees it. 60–90% reduction on common commands.

### QMD (Query Markup Documents)

```bash
bun install -g https://github.com/tobi/qmd
qmd collection add ./docs --name docs
qmd embed
```

Use for searching NEXT.md, PLAYTEST notes, aircraft specs, etc., instead of loading whole files.

## Event Log

Agents (or wrapper scripts) append one JSON line to `/tmp/agent-events.jsonl` on major steps. The visual HUB reads this file with zero LLM tokens.

Example line:
```json
{"ts":"2026-10-19T12:00:00Z","agent":"grok-producer","worker":"nvidia-glm-5.3-flash","status":"RUNNING_VITEST","file":"src/game/sim.ts","bugId":"P0-12"}
```

## Multi-Model Router

See `scripts/llm-dispatch.sh` (stub). Primary: Vertex Gemini. Failover: NVIDIA GLM Flash / Groq when credits or rate limits hit.

## Visual HUB

Optional. Local React Flow or n8n canvas that watches the event log. Can be closed; work continues. Accessible via Tailscale or Cloudflare Tunnel on phone.
