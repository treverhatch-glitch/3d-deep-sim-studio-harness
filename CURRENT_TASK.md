# CURRENT_TASK.md

**Active Handoff** — Read this at the start of every session. Update it before ending.

## Status

- **Current focus:** Claude's prioritized plan has been applied to the template
- **Owner:** Producer + human
- **Last updated:** 2026-10-19

## What Was Just Done

- Applied Claude's Borrow/Adapt recommendations:
  - Lean roles in `studio/roles/`
  - Path-scoped rules (`studio/rules/sim-isolation.md`)
  - Compact `studio/llms.txt` stub
  - Failover client (`harness/route.mjs` + `models.config.mjs`) based on freecc:auto rules
  - Structured bug template
  - QA playtest guidance (programmatic API preferred)
- Existing core harness (event log, HUB, AGENTS.md, NEXT.md) remains in place.

## Immediate Next Steps

1. Install RTK and QMD locally and verify.
2. Wire real API calls into `harness/route.mjs` (or keep using the shell stub).
3. Fill in `studio/llms.txt` with actual Hatchfield sim surfaces as they stabilize.
4. Begin using the harness on Hatchfield.

## Context Needed for Next Agent

- This is a general AI game development harness.
- Hatchfield is the first project.
- Priority is finishing deep systems and playability before any engine port.
- Keep the sim pure TypeScript.
- Free-tier failover must stay available.
- Durable logic stays in files, not chat.

## Blockers

None. The system is ready to use.
