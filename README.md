# 3D Deep Simulation & AI Game Studio Harness (`hatchfield-ai-studio-template`)

A generalized, zero-vendor-lock-in **AI Game Studio Harness** built for scaling 100,000+ line **3D Deep Simulation** games on a **$0 out-of-pocket AI budget**.

Synthesized from a 17-repository architecture audit (`Claude-Code-Game-Studios`, `UltraGameStudio`, `OhMyGame`, `VibeGame`, `Recursive Game Creator`, `rtk-ai/rtk`, `tobi/qmd`, `oraios/serena`, `microsoft/playwright-mcp`, `mhjabreel/uisentinel`, `johnfn/ts2gd`, `nickna/SharpTS`), this template strips away heavy desktop wrappers and gives you executable Node.js + Bash infrastructure out of the box.

---

## Key Capabilities

1. **No Agent Caps & No Vendor Lock-In (`harness/agents.mjs`, `studio/roles/`)**
   - Ships with the **5 lean starter roles**: `producer`, `designer-calibrator`, `builder`, `qa-playtester`, and `reviewer`.
   - Add an **unlimited** number of custom agents, departments, or swarms in `studio/roles/**/*.md`.
   - Includes the **Grok Bot Executive Producer** optimization preset (`studio/presets/grok-producer.md`), while keeping the Head/Producer agent 100% swappable (`STUDIO_PRODUCER_PRESET=grok|gemini|claude|openai|ollama|auto`).
2. **External Context & Direction Memory System (`AGENTS.md`, `CLAUDE.md`, `studio/`)**
   - Universal root `AGENTS.md` + 3-line `CLAUDE.md` `@`-import.
   - `studio/VISION_LOCK.md` & `studio/decisions/` (ADR architecture records).
   - `studio/llms.txt` (compact engine & harness API sheet so agents don't read full source files).
   - `studio/CURRENT_TASK.md` + `scripts/pre-compact.sh` & `scripts/session-start.sh` lifecycle hooks.
   - `studio/NEXT.md` + `node harness/task.mjs` ("What's Next" Markdown queue manager).
   - `scripts/setup-token-savers.sh` wiring `rtk` (60–90% bash output compression), `tobi/qmd` (local Markdown RAG), `oraios/serena` (LSP symbol lookup), `jq`, and `duckdb`.
3. **Zero-Server Plug-and-Play Model Router (`harness/route.mjs` & `harness/models.config.mjs`)**
   - Implements the `freecc:auto` failover pattern across **Vertex Gemini**, **NVIDIA NIM** (GLM 5.3 Flash / Nemotron Ultra), **Groq**, **OpenRouter**, **xAI Grok**, **Anthropic Claude**, **OpenAI**, and **local Ollama**.
   - Instant failover on HTTP `429` / `5xx` / quota exhaustion with a persistent 30s+ cooldown ledger (`.studio/cooldowns.json`) and per-run ledger (`.studio/runs/<run-id>/ledger.json`).
4. **Zero-Token Passive Workflow UI HUB (`hub/server.mjs`, `hub/WarRoom.tsx`, `docs/WAR-ROOM.md`)**
   - Appends 1-line JSON events via `scripts/append-event.sh` and `harness/event.mjs` to `.studio/events.jsonl` (mirrored to `/tmp/agent-events.jsonl`).
   - Renders a **4-Quadrant React Flow Sci-Fi Mission Control War Room** (`reactflow` agent topology, **Live Agent View** with `noVNC` stream / latest QA screenshot / playtest preview switcher, and **Subscription Usage Panel** reading `.studio/usage.json`) plus a **Responsive Mobile Command Feed** at **0% LLM token cost**.
5. **Two-Stage Programmatic & Visual QA (`qa/playtest.mjs` & `qa/sim.adapter.mjs`)**
   - **Stage 1**: Drives simulation trajectories via `?playtest=1` (`window.__sim`) or headless Node adapter to catch frozen ticks, `NaN` drift, save/load entity loss, and determinism bugs.
   - **Stage 2**: Runs Playwright accessibility snapshots (`ariaSnapshot`), console error gates, UISentinel layout overflow checks, and targeted screenshots into `qa/reports/`.
6. **Generalized 3D Deep-Sim Rules, Blender Orchestrator & Porting Bridges (`docs/3D-DEEP-SIM.md`, `docs/BLENDER.md`, `docs/PORTING.md`)**
   - Enforces pure-TypeScript deterministic simulation (`node scripts/check-sim-purity.mjs` + `bash scripts/check-sim-isolation.sh` + `studio/rules/graphics-sim-boundary.md`), Three.js `InstancedMesh`/PBR budgets, headless Blender `bpy` `.glb` generation (`tools/blender/generate_glb.py`), and `mlolson/blender-orchestrator` MCP (`https://github.com/mlolson/blender-orchestrator`) for agent-driven Blender control and optional AI mesh generation.
   - Late-game porting guides for **Tauri v2**, **Godot 4** (`ts2gd` + `godot-mcp`), and **Unity** (`SharpTS`).

---

## Documentation Index (`docs/`)

- [`docs/SETUP.md`](docs/SETUP.md) — Quickstart & environment setup
- [`docs/BLENDER.md`](docs/BLENDER.md) — Headless Blender `bpy` procedural `.glb` generation (`CargoCrate.glb` example) + [`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator) MCP bridge
- [`docs/WAR-ROOM.md`](docs/WAR-ROOM.md) — React Flow War Room HUD, Live Agent View (`noVNC` / screenshot / preview), and Subscription Usage Panel (`.studio/usage.json`)
- [`docs/WORK-ORGANIZATION.md`](docs/WORK-ORGANIZATION.md) & [`docs/DAILY-SUMMARY.md`](docs/DAILY-SUMMARY.md) — Task lifecycle (`studio/NEXT.md` → `studio/CURRENT_TASK.md` → `studio/done/` → `studio/daily/`)
- [`docs/GROKBOT-LOCAL-AGENT.md`](docs/GROKBOT-LOCAL-AGENT.md) — Optional Grok Bot Local-Agent route (`https://github.com/robbin/grokbot-local-agent`)
- [`docs/ROUTING.md`](docs/ROUTING.md) — Multi-model failover matrix (`harness/route.mjs` + `harness/models.config.mjs`)
- [`docs/SERENA.md`](docs/SERENA.md) — Symbol-level TypeScript LSP workflows via `oraios/serena`
- [`docs/3D-DEEP-SIM.md`](docs/3D-DEEP-SIM.md) & [`docs/PORTING.md`](docs/PORTING.md) — Pure-TS simulation architecture & Tauri v2 / Godot 4 / Unity porting bridges
- [`docs/BLUEPRINT.md`](docs/BLUEPRINT.md), [`docs/COMPARISON.md`](docs/COMPARISON.md), [`docs/UPGRADES.md`](docs/UPGRADES.md), [`docs/VISUAL_HUB.md`](docs/VISUAL_HUB.md) — 17-repo architecture synthesis & upgrade roadmap

---

## Quickstart

```bash
# 1. Configure your API keys (optional — any subset of free/BYOK providers works)
cp .env.example .env

# 2. Wire token-saving MCP servers (qmd, serena, playwright, blender-orchestrator) & Claude hooks
bash scripts/setup-token-savers.sh --check

# 3. Inspect loaded studio roles & failover matrix (0 tokens)
node harness/agents.mjs list
node harness/route.mjs --status

# 4. Check the "What's Next" queue & studio status (0 tokens)
node harness/task.mjs next
node harness/status.mjs

# 5. Run Sim-Purity / Sim-Isolation checks & Two-Stage QA suite
node scripts/check-sim-purity.mjs
bash scripts/check-sim-isolation.sh
node qa/playtest.mjs

# 6. Append a passive telemetry event & launch the Zero-Token Workflow UI HUB
bash scripts/append-event.sh RUNNING_VITEST src/sim/clock.ts P0-01 nvidia-glm-flash
node hub/server.mjs
# -> Open http://127.0.0.1:4177 (or http://127.0.0.1:4177/?view=mobile)
```

