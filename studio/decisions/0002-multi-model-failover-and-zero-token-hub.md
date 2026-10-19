# ADR-0002: Zero-Server Multi-Model Failover (`freecc:auto`) & Zero-Token Passive HUB

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: Executive Producer (`producer`)

## 1. Question
How do we prevent vendor lock-in, API rate-limit stalls (HTTP 429), and the 30k–80k+ token "Full-Context Re-Read Tax" when checking on running agents?

## 2. Options Considered
1. **Heavy external gateways & chat polling**: Run standalone proxy servers (LiteLLM / n8n / Langfuse) and ask the agent in chat *"What are you doing?"*.
2. **Zero-server `harness/route.mjs` (`freecc:auto`) + passive `.studio/events.jsonl` HUB**: Route per-role chains across Vertex Gemini, free NVIDIA NIM, Groq, OpenRouter, xAI Grok, Anthropic, OpenAI, and Ollama, and log 1-line JSON events tailed by `hub/server.mjs`.

## 3. Decision
Choose **Option 2**.

## 4. Consequences
- Zero external proxy servers required; `node harness/route.mjs` handles 429/5xx failover with 30s+ cooldowns.
- Watching the 4-Quadrant War Room (`hub/WarRoom.tsx`) on desktop or Mobile Command Feed over Tailscale/Cloudflare Tunnel uses **0% LLM tokens**.
