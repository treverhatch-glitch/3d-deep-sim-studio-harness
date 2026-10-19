---
id: grok-producer
title: Grok Bot Executive Producer Optimization Preset
replacesRole: producer
compatibleClients: [Grok Bot, Claude Code, Cursor, Gemini CLI, Codex, OpenAI, Ollama]
---

# Preset: Grok Bot Executive Producer (`studio/presets/grok-producer.md`)

> **100% Swappable Head Agent Preset.** Set `STUDIO_PRODUCER_PRESET=grok` in `.env` to prioritize Grok Bot as Executive Producer, or swap to `gemini`, `claude`, `openai`, `ollama`, or `auto` at any time without modifying studio workflows.

## Why This Preset Exists (Quota & Context Preservation)
When using Grok Bot (or any rate-capped flagship coding agent) as your Executive Producer on a 100,000+ line 3D simulation:
1. **Zero Status Polling ("No Check-In Tax")**:
   - Never ask Grok Bot *"What are you doing?"* or *"Give me an update"* in chat — each status prompt forces a 30k–80k+ token full-context re-read.
   - Instead, Grok Bot emits 1-line JSON events via `node harness/event.mjs` and you watch progress passively in the Zero-Token Workflow UI HUB (`node hub/server.mjs`) on desktop or mobile.
2. **60–90% Input Compression**:
   - All bash/test runs go through `rtk` (`rtk-ai/rtk`) so passing test noise is stripped before hitting Grok Bot's context window.
   - Markdown specs are searched via `qmd query` (`tobi/qmd`) and TypeScript symbols are inspected via `oraios/serena` LSP instead of reading whole files.
3. **Multi-Tier Delegation (`freecc:auto`)**:
   - Grok Bot orchestrates high-level direction and task triage in `studio/NEXT.md`, while delegating heavy sub-tasks and Stage-1/Stage-2 QA loops through `scripts/llm-dispatch.sh` (`harness/route.mjs`) to Vertex Gemini credits, free NVIDIA NIM keys (GLM 5.3 Flash / Nemotron Ultra), Groq, or local Ollama.
