# Studio Setup Guide (`docs/SETUP.md`)

## 1. Token Savers & MCP Bridges (Run First)

```bash
node scripts/setup-token-savers.mjs --check
```
This audits `rtk`, `qmd`, `uvx` (`serena`), `jq`, and `duckdb`, and writes `.mcp.json` and the `.claude/settings.json` hooks (`SessionStart`, `PreCompact`) only if they are missing (both ship with the repo). Plain Node: it runs in PowerShell too.

## 2. Passive Event Log (`.studio/events.jsonl`)

Agents append 1-line JSON events to `.studio/events.jsonl` via `node scripts/append-event.mjs` or `node harness/event.mjs`:

```bash
node scripts/append-event.mjs RUNNING_VITEST src/sim/clock.ts P0-12 nvidia-glm-flash
```

## 3. Multi-Model Failover Router (`harness/route.mjs`)

Copy `.env.example` to `.env` and add any subset of keys (`GEMINI_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, etc.):

```bash
node harness/route.mjs --status
node harness/route.mjs --role builder --dry-run
```

## 4. Bring the studio up and see it

```bash
npm run studio:boot     # the supervisor + a status card in one go (docs/RUN-UNATTENDED.md); npm.cmd on Windows
npm run studio:status   # is it running, the last pass, what needs you
```
Reads `.studio/events.jsonl` and the board with **0% LLM token usage**.
