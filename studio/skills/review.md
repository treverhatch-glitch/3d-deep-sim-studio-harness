# Skill: review

**When.** Checking someone else's merge, ideally from a different model family.

**Steps.**
1. Read the diff and the task it closes, not the whole repo.
2. Run `npm run verify` and `node scripts/check-sim-isolation.mjs`.
3. Write `studio/reviews/<date>-<task>.md`: approve or request changes, with file and line for
   each point. Start it with two lines, `model-family: <yours, e.g. anthropic>` and
   `implementer-family: <the builder's>`. They must differ; the reviewer gate checks every note.

**Done means.** A review note in `studio/reviews/`, written after the task started, that names the
task ID or commit it reviews and gives a verdict (approve, LGTM, request changes, reject, blocking).

**Never.** Approve your own work. Fix the code yourself instead of saying what is wrong.
