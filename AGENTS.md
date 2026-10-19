# AGENTS.md — Standing Instructions for All Agents

You are working on a video game project using this AI Game Studio harness. Follow these rules every session.

## Before Starting Work

1. Read `CURRENT_TASK.md` (checkpoint / handoff).
2. Read the relevant section of `NEXT.md` if needed.
3. Check `studio/llms.txt` and path-scoped rules in `studio/rules/` before editing core systems.
4. Search docs or code with QMD / ripgrep / symbol MCP instead of loading entire files.
5. Prefer `gh` CLI over full GitHub MCP when possible.

## During Work

- Keep chat context thin. Write important state, decisions, and next steps into files.
- Use RTK-wrapped commands for shell output (vitest, git, tsc, etc.).
- Append status events to the local event log when starting major steps (see `scripts/`).
- Route heavy reasoning to stronger models; bulk fixes and classification to free-tier workers.
- Respect lean roles in `studio/roles/` (Producer, Builder, QA-Playtester, Reviewer, Designer-Calibrator).

## After Finishing a Task

1. Update `CURRENT_TASK.md` with what was done, remaining work, and the exact next step.
2. Update `NEXT.md` if priorities changed.
3. Commit with a clear message.
4. Do not leave long status summaries in the chat — the files are the source of truth.

## Producer Role

- Read the task files.
- Decide which worker / model to use.
- Direct the work.
- Verify results and update the handoff files.
- Never accumulate multi-turn status history in one chat.

## Visual / Playtest Testing

Prefer programmatic playtesting via debug API (`?playtest=1` / `window.__hatch`) over pure screenshots. See `qa/README.md`. Playwright MCP is secondary.

## Porting Rule

Do not port core systems until they are feature-complete and playtested in the current stack. Keep the sim pure TypeScript (no Three.js/DOM imports). Transpilers help only after that point.
