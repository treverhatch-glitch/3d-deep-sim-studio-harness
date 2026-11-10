# Skill: Bug Triage (`skills/bug-triage.md`)

Use this workflow when processing playtest reports (`qa/reports/`) or failing tests.

## Steps

1. Query the relevant section of the playtest report or `studio/NEXT.md` via `qmd query` (the report's failing section is what you need; open more of the log when it doesn't explain the failure).
2. Classify severity (`P0` = crash/frozen-tick/NaN/save-corruption, `P1` = broken mechanic/console error, `P2` = visual/layout alignment).
3. Locate the target symbol with `oraios/serena` LSP or `rg -n`.
4. Update `studio/CURRENT_TASK.md` and queue the fix via `node harness/task.mjs add "<summary>" --role builder --priority P0`.
5. Log a zero-token passive event:
   ```bash
   node scripts/append-event.mjs TRIAGE src/sim/state.ts P0-01 nvidia-glm-flash
   ```
6. Dispatch the fix to the `builder` failover chain (`node harness/route.mjs --role builder ...`) and verify with `node scripts/check-sim-isolation.mjs` and `node qa/playtest.mjs`.
