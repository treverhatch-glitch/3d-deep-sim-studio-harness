# Harness notes (`studio/harness-notes/NOTES.md`)

> About the harness, not the game: what worked, what didn't, workarounds in use, and upgrade ideas.
> The Producer adds to it (`npm run notes -- add --kind … "…"`); `npm run studio:reset` keeps it, so
> each project starts with what the last one learned. `npm run notes -- export` turns it into
> something to bring back to the public harness.

## Worked well

- [2026-10-20 · producer] Done-checks by task type caught unfinished balance and review work in every test run; agents fixed what the refusal named instead of arguing.
- [2026-10-20 · producer] Scripts for watching (watcher, retro, scorecard, briefing) cost no tokens and caught an abandoned task within one watcher pass.
- [2026-10-20 · producer] Handing a task back with a note let a different model pick it up with no chat history.
- [2026-10-20 · producer] Fresh-clone runs found real problems (stale starter queue, invented savings, locked folders after a hand-back) that tests in the working copy missed.

## Didn't work

- [2026-10-20 · producer] Done-checks compared file times, so touching a file could pass a check. Mostly fixed in 2.6.0 (content checks); a balance sweep can still pass when the game hasn't changed.
- [2026-10-20 · producer] Closed-loop failures can only be blamed on models as "suspected". Bug tasks now trace to a commit and model through trailers (2.6.0), but a failure with no bug task still can't.
- [2026-10-20 · producer] Playwright's bundled video recorder needed an ffmpeg build that wasn't installed; screen recordings had to use Chromium's screencast instead.

## Workarounds in use

- [2026-10-20 · producer] On a suspicious "done", the Producer reruns `node harness/done-check.mjs <ID>` and reads the diff before accepting.
- [2026-10-20 · producer] File bugs with `--caused-by <task>` whenever the cause is known, so the scorecard has confirmed bugs, not just suspects.
- [2026-10-20 · producer] Record HUD videos from Chromium's screencast frames and encode with the system ffmpeg.

## Upgrade ideas

- [2026-10-20 · producer] Done-check: prove a regression fails on the commit before the fix (needs a checkout of that commit).
- [2026-10-20 · producer] Shared studio state for git worktrees, so agents can work in separate worktrees and still see one queue and one set of locks.
- [2026-10-20 · producer] Route tasks by scorecard automatically once enough runs exist, with the Producer approving.
