# CURRENT_TASK.md

**Active Handoff** — Read this at the start of every session. Update it before ending.

## Status

- **Current focus:** AI Game Studio Template is ready for general use
- **Owner:** Producer + human
- **Last updated:** 2026-10-19

## What Was Just Done

- Template generalized into a reusable AI video game development system.
- Hatchfield Airport Tycoon remains the first project and test case.
- Core harness (event logger, multi-model dispatch, passive HUB, governance files) is in place and runnable.

## Immediate Next Steps

1. Install RTK and QMD locally and verify.
2. Wire real API calls into `scripts/llm-dispatch.sh`.
3. Begin using the harness on Hatchfield (or clone for a new game).
4. (Optional) Expand the HUB into a React Flow node graph.

## Context Needed for Next Agent

- This is a general AI game development harness.
- Hatchfield is the first project being built with it.
- Priority is finishing deep systems and playability in the current stack before any engine port.
- Free-tier failover must stay available.
- Keep all durable logic in files, not chat.

## Blockers

None. The system is ready to use.
