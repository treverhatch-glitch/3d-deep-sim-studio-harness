# CURRENT_TASK.md

**Active Handoff** — Read this at the start of every session. Update it before ending.

## Status

- **Current focus:** Initial setup of the AI Studio Template
- **Owner:** Producer (Grok Bot) + human
- **Last updated:** 2026-10-19

## What Was Just Done

- Created the public template repository.
- Added core governance files.

## Immediate Next Steps

1. Flesh out `docs/SETUP.md` with RTK + QMD install steps.
2. Add a minimal event-logger script stub.
3. Add a multi-model dispatch example (`scripts/llm-dispatch.sh`).
4. Document the passive visual HUB (React Flow or n8n).

## Context Needed for Next Agent

- Project is Hatchfield Airport Tycoon (~105k lines TypeScript + Three.js).
- Priority is finishing deep systems and playability in the web stack before any engine port.
- Free-tier failover (NVIDIA GLM / Groq) must stay available.
- Keep all durable logic in files, not chat.

## Blockers

None.
