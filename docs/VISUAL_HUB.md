# Passive Visual HUB (Mission Control)

Zero-token local dashboard that watches `/tmp/agent-events.jsonl`.

## Run it

```bash
# From the repo root
node hub/server.js
# Open http://localhost:3847
```

The HUB can be closed at any time. Agents keep writing events. You can view it on a second monitor or via Tailscale / Cloudflare Tunnel on your phone.

## How agents log events

```bash
./scripts/append-event.sh RUNNING_VITEST src/game/sim.ts P0-12 nvidia-glm
# or
AGENT=grok-producer WORKER=vertex-gemini ./scripts/append-event.sh ARCHITECTURE_REVIEW
```

## Extending to React Flow / n8n

The current HUB is a simple feed. For the full sci-fi node-graph War Room described in the design doc:

- Use `@xyflow/react` to render worker nodes from the same JSONL.
- Or import an n8n workflow that watches the file and visualizes parallel agents.

Both consume zero LLM tokens.
