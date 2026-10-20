# Skill: builder (edit, test, stop)

**When.** Any code or content change: sim rules, renderer, harness, assets.

**Steps.**
1. Claim first: `node harness/task.mjs start <ID> --agent <you>`.
2. Make the smallest edit that could work.
3. Run the narrowest check that covers it (`npm run golden`, `npm run playtest:stage1`, one gate
   with `node scripts/run-gates.mjs --only <id>`).
4. Red: read the failure, edit, rerun. Stop after 3 tries and escalate with the seed, tick and what
   you tried (`node harness/closed-loop.mjs` does this for playtest failures).
5. Green: run the full `npm run verify`.

**Done means.** A full `npm run verify` passed after the task started. If a hash changed, the
golden was regenerated in the same commit.

**Never.** Change a hash without its golden. Edit files someone else has claimed. Loop past three
failed tries.
