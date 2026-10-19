# AGENTS.md — Standing Instructions for All Agents

You are working on a 3D game with deep simulation using this AI Game Studio harness. Follow these rules every session.

## Before Starting Work

1. Read `CURRENT_TASK.md` (checkpoint / handoff).
2. If it is empty or done, pull the next task from `NEXT.md` (see `docs/WORK-ORGANIZATION.md`).
3. Check `studio/llms.txt` and path-scoped rules in `studio/rules/` (especially sim-isolation and graphics-sim-boundary) before editing core systems.
4. For workflow context see `docs/3D-DEEP-SIM.md`.
5. Search docs or code with QMD / ripgrep / symbol MCP instead of loading entire files.
6. Prefer `gh` CLI over full GitHub MCP when possible.

## During Work

- Keep chat context thin. Write important state, decisions, and next steps into files.
- Use RTK-wrapped commands for shell output (vitest, git, tsc, etc.).
- Append status events to the local event log when starting major steps (see `scripts/`).
- Route heavy reasoning to stronger models; bulk fixes and classification to free-tier workers.
- Respect lean roles in `studio/roles/` (Producer, Builder, QA-Playtester, Reviewer, Designer-Calibrator).
- Keep simulation pure; keep Three.js in the presentation layer only.

## After Finishing a Task

1. Write a short summary in `studio/done/YYYY-MM-DD-short-title.md`.
2. Update `CURRENT_TASK.md` with what was done and the exact next step (or clear it).
3. Update `NEXT.md` (check off or remove the completed item).
4. Optionally run `./scripts/check-sim-isolation.sh`.
5. Commit with a clear message.
6. Do not leave long status summaries in the chat — the files are the source of truth.

See `docs/WORK-ORGANIZATION.md` for the full flow.

## Producer Role

- Read the task files.
- Decide which worker / model to use.
- Direct the work.
- Verify results and update the handoff files.
- Never accumulate multi-turn status history in one chat.

## Visual / Playtest Testing

Prefer programmatic playtesting via debug API (`?playtest=1` / `window.__hatch`) over pure screenshots. See `qa/README.md`. Playwright MCP is secondary.

## Porting Rule

Do not port core systems until they are feature-complete and playtested in the current stack. Keep the sim pure TypeScript (no Three.js/DOM imports). See `docs/PORTING.md` for engine targets (Tauri v2, Unity, Godot via ts2gd, SharpTS). Refuse early porting requests.
