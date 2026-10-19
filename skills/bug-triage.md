# Skill: Bug Triage

Use this when processing playtest notes or failing tests.

## Steps

1. Read the relevant section of the playtest doc or `NEXT.md` via QMD (do not load the whole file).
2. Classify severity (P0 / P1 / P2).
3. Identify the likely file(s) with ripgrep or a symbol MCP.
4. Write a one-line summary into `CURRENT_TASK.md`.
5. Log an event: `./scripts/append-event.sh TRIAGE src/game/sim.ts P0-XX`
6. Hand off to a free-tier worker (NVIDIA GLM Flash or Groq) for the actual fix when possible.

## Output format

Update `CURRENT_TASK.md` with:
- Bug ID and severity
- Suspected file
- Exact next action for the next agent
