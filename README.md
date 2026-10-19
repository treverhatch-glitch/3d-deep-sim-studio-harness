# AI Game Studio Template

Lightweight, open-source AI agent harness for building deep, playable video games on a low or zero budget.

**Purpose:** A reusable system for finishing game logic, systems, gameplay loops, playtesting, and calibration in a flexible web stack (TypeScript + Three.js + React or similar) before porting to native engines. Durable logic lives in the repo. The Producer (Grok Bot or any agent) stays thin — it reads task files, directs workers, and writes results back.

**First project / test case:** Hatchfield Airport Tycoon (~105k lines TypeScript + Three.js).

## Core Principles

- **Thin context** — Durable state in Markdown files (`NEXT.md`, `CURRENT_TASK.md`, skills), not in chat.
- **Token efficiency** — RTK for shell output, QMD for Markdown search, optional symbol-level code MCPs and Headroom.
- **Multi-model failover** — Vertex Gemini primary → free NVIDIA GLM / Groq (and others) with zero out-of-pocket when credits run low.
- **Passive status** — Local event log (`/tmp/agent-events.jsonl`) + visual HUB. Zero LLM tokens for monitoring.
- **Build playable first** — Lock core systems and gameplay loop before any engine port.

## Quick Start

1. Clone this template for a new game project.
2. Read `AGENTS.md` and `docs/SETUP.md`.
3. Set up RTK, QMD, and the event logger (see `scripts/`).
4. Point your Producer at `CURRENT_TASK.md` and `NEXT.md`.
5. Run the passive visual HUB if desired.

## Structure

- `AGENTS.md` — Standing instructions for any agent.
- `NEXT.md` — Prioritized backlog.
- `CURRENT_TASK.md` — Active handoff (read and update).
- `docs/` — Setup, routing, visual HUB, porting notes.
- `scripts/` — Event logger, dispatch, helpers.
- `skills/` — Reusable agent skills.
- `hub/` — Passive Mission Control dashboard (zero LLM tokens).

## License

MIT — Use, fork, and adapt freely for any game project.
