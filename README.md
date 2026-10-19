# AI Game Studio Template

Lightweight, open-source AI agent harness for building deep, playable 3D games with heavy simulation on a low or zero budget.

**Purpose:** A reusable, agent-agnostic system for finishing game logic, systems, gameplay loops, playtesting, and calibration in a flexible web stack (TypeScript + Three.js + React or similar) before porting to native engines. Durable logic lives in the repo. Any agent can act as Producer or worker — it reads task files, does the work, and writes results back.

**First project / test case:** Hatchfield Airport Tycoon (~105k lines TypeScript + Three.js).

## Agent-Agnostic by Design

You can use any agent at any level:

- Cursor, Claude Code, Codex, Pi, Aider, local models, Gemini CLI, etc.
- One documented route is optimized for **Grok Bot** as a thin Producer (see `docs/GROKBOT-LOCAL-AGENT.md`).

The file-based core works the same regardless of which agent is reading and writing.

## Core Principles

- **Thin context** — Durable state in Markdown files (`NEXT.md`, `CURRENT_TASK.md`, skills), not in chat.
- **Token efficiency** — RTK for shell output, QMD for Markdown search, optional symbol-level code MCPs and Headroom.
- **Multi-model failover** — Vertex Gemini primary → free NVIDIA GLM / Groq (and others) with zero out-of-pocket when credits run low.
- **Passive status** — Local event log (`/tmp/agent-events.jsonl`) + visual HUB. Zero LLM tokens for monitoring.
- **Build playable first** — Lock core systems and gameplay loop before any engine port.
- **Any agent** — No vendor lock-in. Grok Bot is a supported route, not a requirement.

## Quick Start

1. Clone this template for a new game project.
2. Read `AGENTS.md` and `docs/SETUP.md`.
3. Set up RTK, QMD, and the event logger (see `scripts/`).
4. Point your chosen Producer (any agent) at `CURRENT_TASK.md` and `NEXT.md`.
5. Run the passive visual HUB if desired.

## Structure

- `AGENTS.md` — Standing instructions for any agent.
- `NEXT.md` — Prioritized backlog.
- `CURRENT_TASK.md` — Active handoff (read and update).
- `docs/` — Setup, routing, visual HUB, porting, work organization, Grok Bot route.
- `scripts/` — Event logger, dispatch, helpers.
- `skills/` — Reusable agent skills.
- `hub/` — Passive Mission Control dashboard (zero LLM tokens).
- `studio/` — Roles, rules, templates, done summaries, daily rollups.

## License

MIT — Use, fork, and adapt freely for any game project.
