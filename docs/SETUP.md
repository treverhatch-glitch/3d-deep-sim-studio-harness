# Studio Setup Guide (`docs/SETUP.md`)

## 1. Token Savers & MCP Bridges (Run First)

```bash
chmod +x scripts/*.sh
./scripts/setup-token-savers.sh --check
```
This audits `rtk`, `qmd`, `uvx` (`serena`), `jq`, and `duckdb`, and writes `.mcp.json` (`qmd`, `serena`, `playwright`, `blender-orchestrator`) plus `.claude/settings.json` hooks (`SessionStart`, `PreCompact`).

## 2. Passive Event Log (`.studio/events.jsonl`)

Agents append 1-line JSON events to `.studio/events.jsonl` via `./scripts/append-event.sh` or `node harness/event.mjs`:

```bash
./scripts/append-event.sh RUNNING_VITEST src/sim/clock.ts P0-12 nvidia-glm-flash
```

## 3. Multi-Model Failover Router (`harness/route.mjs`)

Copy `.env.example` to `.env` and add any subset of keys (`GEMINI_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, etc.):

```bash
node harness/route.mjs --status
node harness/route.mjs --role builder --dry-run
```

## 4. Zero-Token War Room HUB (`hub/server.mjs`)

```bash
node hub/server.mjs
# Open http://localhost:3847 (or http://localhost:4177)
```
Reads `.studio/events.jsonl` and `.studio/usage.json` with **0% LLM token usage**.
