# AGENTS.md — Standing Instructions for All Agents

You are working on Hatchfield (or a project using this harness). Follow these rules every session.

## Before Starting Work

1. Read `CURRENT_TASK.md` (this is your handoff).
2. Read the relevant section of `NEXT.md` if needed.
3. Search docs or code with QMD / ripgrep / symbol MCP instead of loading entire files.
4. Prefer `gh` CLI over full GitHub MCP when possible.

## During Work

- Keep chat context thin. Write important state, decisions, and next steps into files.
- Use RTK-wrapped commands for shell output (vitest, git, tsc, etc.).
- Append status events to the local event log when starting major steps (see `scripts/`).
- Route heavy reasoning to stronger models; bulk fixes and classification to free-tier workers (NVIDIA GLM Flash, Groq, Gemini Flash).

## After Finishing a Task

1. Update `CURRENT_TASK.md` with what was done, remaining work, and the exact next step.
2. Update `NEXT.md` if priorities changed.
3. Commit with a clear message.
4. Do not leave long status summaries in the chat — the files are the source of truth.

## Producer (Grok Bot) Role

- Read the task files.
- Decide which worker / model to use.
- Direct the work.
- Verify results and update the handoff files.
- Never accumulate multi-turn status history in one chat.

## Visual Testing

Dedicated QA sub-agents may use Playwright MCP + screenshot / accessibility tree tools. Prefer Gemini Flash or free tiers for visual checks.

## Porting Rule

Do not port core systems until they are feature-complete and playtested in the TypeScript stack. Transpilers help only after that point.
