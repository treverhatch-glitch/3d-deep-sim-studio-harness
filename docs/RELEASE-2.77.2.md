# 2.77.2: a hotfix from the first hours on 2.77.1 (`docs/RELEASE-2.77.2.md`)

The crew's notes of 2026-11-04 20:03–20:35 UTC (B-104 to B-107, and B-99 again).

| Item | Status | |
|---|---|---|
| B-102 (2.77.1): the supervisor | Confirmed FIXED live | It ran on its own, saved every pass and started a builder; both workaround loops are gone. |
| B-104: 2.77.1's own commits fail the hooks gate | FIXED (2.77.2) | Cause: 2.77.1 was merged by 2.77.0's upgrade guard, which has no grandfather step. Merging 2.77.2 runs 2.77.1's guard, which lists 2.77.2's and 2.77.1's commits by itself. For an update an older guard merged: `node harness/hook-stamp.mjs grandfather --ref <remote ref>`. |
| B-105: the train (and builders) can't refresh a lane after an upgrade | → 2.78 | The refresh merges main into a lane whose `studio/` is a link to main's: it needs to merge with `studio/` left out, as lane creation does. Workaround (as Patch did): rebuild the lane off main with its task's commits (`npm run lane -- create <T-ID> --from <branch>`). |
| B-99 again: agy idle-exit while a tool task runs in the background | → 2.78 | 2.77.1 counts that exit as a failed run (so `--fallback` starts the next model) and GEMINI.md asks for the foreground; agy still backgrounds some tools. The real fix needs agy's own options: please send the output of `agy --help` and `agy -p --help` so the adapter can pass the right flag. |
| B-106: a speculative train called "died silently" | FIXED (2.77.2) | A train with a fresh heartbeat (or `train-next.lock`) is alive. |
| B-107: an agent with no commits blocks all launches | FIXED (2.77.2) | An empty lane gets no launcher verify; an exited or ending session no longer holds the whole game. |

## Upgrade note for Patch

1. `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.77.2"`. It says how many commits it
   listed for the hooks gate; then `node harness/hook-stamp.mjs check` on main should be green. If it still lists
   2.77.1's commits: `node harness/hook-stamp.mjs grandfather --ref origin/main`.
2. `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once (`npm run studio:stop`, `npm run studio:start`).
3. Send the `agy --help` output (B-99).
