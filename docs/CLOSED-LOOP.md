# Closed Loop

`node harness/closed-loop.mjs` does **not** auto-fix code.

It:
1. Runs the playtest
2. On failure, writes the real seed/tick/actions to `.studio/last-seed-failure.json`
3. Opens a bug report
4. After `MAX_FIX_ATTEMPTS` (default 3), escalates to a stronger model or a human

Auto-fix is intentionally out of scope. A wrong automatic edit is worse than a recorded failure.
