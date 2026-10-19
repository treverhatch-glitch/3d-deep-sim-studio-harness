# Setup

## Token Savers (Recommended First)

One command:

```bash
chmod +x scripts/setup-token-savers.sh
./scripts/setup-token-savers.sh
```

This installs RTK and QMD (if bun is present) and indexes the docs.

### RTK (Rust Token Killer)

Filters shell output (vitest, git, tsc, etc.) before the agent sees it. 60–90% reduction on common commands.

```bash
rtk gain   # verify after a few commands
```

### QMD (Query Markup Documents)

Local search over markdown. Agents fetch relevant sections instead of loading whole files.

```bash
qmd query "current task"
```

## Event Log

Agents append one JSON line to `/tmp/agent-events.jsonl`. The visual HUB reads this file with zero LLM tokens.

```bash
./scripts/append-event.sh RUNNING_VITEST src/game/sim.ts P0-12 nvidia-glm
```

## Multi-Model Router

Primary: `harness/route.mjs` (real OpenAI-compatible failover).

```bash
export VERTEX_API_KEY=...
export NVIDIA_API_KEY=...
export GROQ_API_KEY=...
node harness/route.mjs "Summarize the current task"
```

Shell wrapper still available at `scripts/llm-dispatch.sh`.

## Visual HUB

```bash
node hub/server.js
# open http://localhost:3847
```

Zero LLM tokens. Can be closed; work continues.
