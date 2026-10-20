# Skill: review

**When.** Checking someone else's merge, ideally from a different model family.

**Steps.**
1. Read the diff and the task it closes, not the whole repo.
2. Run `npm run verify` and `bash scripts/check-sim-isolation.sh`.
3. Write `studio/reviews/<date>-<task>.md`: approve or request changes, with file and line for
   each point.

**Done means.** A review note in `studio/reviews/` written after the task started.

**Never.** Approve your own work. Fix the code yourself instead of saying what is wrong.
