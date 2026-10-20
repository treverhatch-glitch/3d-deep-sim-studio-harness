# Skill: balance

**When.** Tuning numbers: costs, rates, spawn timings, win thresholds.

**Steps.**
1. Say what feels wrong and which `TUNING` values might cause it.
2. Run the sweep: `npm run balance` (writes `studio/balance/latest.md` and `sweep.json`).
3. Write two or three options with their trade-offs at the top of `latest.md`.
4. Hand it to a person. They pick the number; a builder task applies it.

**Done means.** A sweep report written after the task started.

**Never.** Change a tuning value on your own. A tuning change moves the goldens, and that is a
person's call.
