# Multi-Model Failover (`docs/ROUTING.md`)

Implemented in [`harness/route.mjs`](../harness/route.mjs) and [`harness/models.config.mjs`](../harness/models.config.mjs) using the `freecc:auto` pattern.

## Default Failover Priority Order

1. **Vertex Gemini 2.5 Pro / Flash** (`GEMINI_API_KEY` / `VERTEX_ACCESS_TOKEN`) — primary deep reasoning, architecture, and fast visual QA
2. **NVIDIA NIM (GLM 5.3 Flash / Nemotron Ultra 253B)** (`NVIDIA_API_KEY`) — free-tier failover #1
3. **Groq (Llama 3.3 70B Versatile)** (`GROQ_API_KEY`) — free-tier failover #2
4. **OpenRouter (`:free` channel)** (`OPENROUTER_API_KEY`) — free-tier failover #3
5. **xAI Grok / Anthropic Claude / OpenAI** (`XAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) — optional BYOK channels
6. **Local Ollama** (`OLLAMA_BASE_URL`) — offline $0 fallback

## Usage

```bash
# Inspect live channel matrix and cooldowns (0 tokens)
node harness/route.mjs --status

# Dispatch a prompt with automatic 429/5xx failover and 30s+ cooldown
node harness/route.mjs --role builder --prompt "Optimize InstancedMesh matrix updates"

# Or via the bash wrapper:
./scripts/llm-dispatch.sh --role qa-playtester --prompt "Classify playtest report"
```

Every attempt and failover appends a line to `.studio/events.jsonl` so the War Room HUB (`hub/WarRoom.tsx`) shows which worker is active without polling chat.
