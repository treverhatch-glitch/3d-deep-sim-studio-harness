# Multi-Model Failover

## Priority order

1. **Vertex Gemini 2.5 Pro / Flash** — primary (deep reasoning, architecture)
2. **NVIDIA GLM 5.3 Flash / Nemotron** — free-tier failover
3. **Groq** — free-tier failover

## Usage

```bash
export VERTEX_API_KEY=...
export NVIDIA_API_KEY=...
export GROQ_API_KEY=...

./scripts/llm-dispatch.sh "Fix pathfinding heap in sim.ts"
./scripts/llm-dispatch.sh "Classify these 12 test failures" nvidia
```

Every dispatch writes to `/tmp/agent-events.jsonl` so the visual HUB shows which worker is active without any agent chat.

## Extending

Replace the TODOs in `scripts/llm-dispatch.sh` with real API calls (or call LiteLLM / a local proxy). Keep the event logging so the HUB stays accurate.
