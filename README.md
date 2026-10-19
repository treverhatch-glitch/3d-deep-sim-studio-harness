# Hatchfield AI Studio Template

Lightweight, open-source AI agent harness for building deep, playable games (starting with Hatchfield Airport Tycoon) on a low or zero budget.

**Goal:** Finish deep gameplay systems, a solid loop, full playability, playtesting, and calibration in TypeScript + Three.js + React first. Only after the simulation is stable and feature-complete do we port or raise the graphics ceiling in other engines (Tauri v2 for Steam, or Godot 4).

Durable logic lives in this repo. Grok Bot (or any Producer) stays thin — it reads the current task, directs workers, and writes results back. No long chat histories required.

## Core Principles

- **Thin context** — Durable state in Markdown files (`NEXT.md`, `CURRENT_TASK.md`, skills), not in chat.
- **Token efficiency** — RTK for shell output, QMD for Markdown search, optional symbol-level code MCPs and Headroom.
- **Multi-model failover** — Vertex Gemini primary → free NVIDIA GLM / Groq (and others) with zero out-of-pocket when credits run low.
- **Passive status** — Local event log (`/tmp/agent-events.jsonl`) + visual HUB. Zero LLM tokens for monitoring.
- **Build playable first** — Lock simulation, economy, pathfinding, and UI before any engine port.

## Quick Start

1. Clone this template.
2. Read `AGENTS.md` and `docs/SETUP.md`.
3. Set up RTK, QMD, and the event logger (see `scripts/`).
4. Point your Producer (Grok Bot) at `CURRENT_TASK.md` and `NEXT.md`.
5. Run the passive visual HUB if desired.

## Structure

- `AGENTS.md` — Standing instructions for any agent.
- `NEXT.md` — Prioritized backlog.
- `CURRENT_TASK.md` — Active handoff (read and update).
- `docs/` — Setup, routing, visual HUB, porting notes.
- `scripts/` — Event logger, dispatch stubs, helpers.
- `skills/` — Reusable agent skills.

## License

MIT — Use, fork, and adapt freely. Built for Hatchfield and the community building games with AI agents.
