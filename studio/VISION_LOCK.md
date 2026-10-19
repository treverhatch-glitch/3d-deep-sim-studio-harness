# Studio Vision Lock (`studio/VISION_LOCK.md`)

> **Immutable Architectural Contract.** No agent may violate these pillars without an approved Architecture Decision Record in `studio/decisions/`.

## 1. Core Philosophy: "Build Playable First in TypeScript, Port Later"
1. **Pure-TypeScript Deterministic Simulation (`src/sim/`)**:
   - The entire simulation state, economy, pathfinding, scheduling, and agent choreography live in pure TypeScript with **zero** DOM or Three.js dependencies.
   - Time advances strictly in fixed integer ticks (`step(state, action)`), never by variable render frame rates (`dt`).
   - All randomness flows through a seeded RNG stored inside `SimState`.
   - `SimState` is 100% JSON-serializable (`JSON.stringify` / `JSON.parse`) so saves never lose active entities and replays are deterministic.
2. **Thin-Context & Zero-Token Observability**:
   - Never rely on long chat histories as memory. All durable state lives in `studio/CURRENT_TASK.md`, `studio/NEXT.md`, `studio/llms.txt`, and `studio/decisions/`.
   - All live status updates flow passively through `.studio/events.jsonl` (and `/tmp/agent-events.jsonl`) into the Zero-Token Workflow UI HUB (`hub/server.mjs`).
3. **Two-Stage Programmatic + Visual QA**:
   - Bugs are caught first by driving the game's programmatic API (`?playtest=1` / `window.__sim` / `qa/sim.adapter.mjs`), then verified visually with Playwright MCP accessibility trees, screenshots, and UISentinel layout checks.
4. **Open-Ended Multi-Model Sovereignty**:
   - Zero vendor lock-in and zero hard caps on studio roles. Any role can fail over across Vertex Gemini, NVIDIA NIM, Groq, OpenRouter, xAI Grok, Anthropic, OpenAI, or local Ollama via `harness/route.mjs`.
