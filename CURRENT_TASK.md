# CURRENT_TASK.md

**Active Handoff** — Read this at the start of every session. Update it before ending.

## Status

- **Current focus:** Harness upgraded with real failover client and setup script
- **Owner:** Producer + human
- **Last updated:** 2026-10-19

## What Was Just Done

- Upgraded `harness/route.mjs` to a real OpenAI-compatible failover client (skip 429/5xx, 30s cooldown, failure log).
- Added `scripts/setup-token-savers.sh` (one-command RTK + QMD).
- Added Reviewer role.
- Updated `docs/SETUP.md` and added `docs/UPGRADES.md`.
- Claude-plan structure (roles, rules, llms.txt, QA guidance) already in place.

## Immediate Next Steps

1. Run `./scripts/setup-token-savers.sh` on a machine that will use the harness.
2. Set API keys and test `node harness/route.mjs "hello"`.
3. Clone/use this template on the Hatchfield repo (or a fresh game repo).
4. Fill `studio/llms.txt` as the sim API stabilizes.

## Context Needed for Next Agent

- General AI game development harness.
- Hatchfield is the first project.
- Build playable first, keep sim pure TypeScript, free-tier failover available.
- Durable logic stays in files.

## Blockers

None. Ready to copy into a game repository and use.
