# CURRENT_TASK.md

**Active Handoff** — Read this at the start of every session. Update it before ending.

## Status

- **Current focus:** Core harness is in place and runnable
- **Owner:** Producer (Grok Bot) + human
- **Last updated:** 2026-10-19

## What Was Just Done

- Public template repo created and populated.
- Event logger (`scripts/append-event.sh`) with proper JSON.
- Multi-model dispatch stub (`scripts/llm-dispatch.sh`) with failover order.
- Passive visual HUB (`hub/index.html` + `hub/server.js`) — zero-token dashboard.
- Docs: SETUP.md, VISUAL_HUB.md, ROUTING.md.
- Example skill: `skills/bug-triage.md`.

## Immediate Next Steps

1. Install RTK and QMD locally and verify `rtk gain`.
2. Wire real API calls into `scripts/llm-dispatch.sh` (Vertex / NVIDIA / Groq).
3. (Optional) Expand the HUB into a React Flow node graph for YouTube B-roll.
4. Start using the harness on the actual Hatchfield codebase (point agents at this repo's AGENTS.md).

## Context Needed for Next Agent

- Project is Hatchfield Airport Tycoon (~105k lines TypeScript + Three.js).
- Priority remains finishing deep systems and playability in the web stack before any engine port.
- Free-tier failover must stay available.
- Keep all durable logic in files, not chat.

## Blockers

None. The harness is ready to use.
