# Harness notes (`studio/harness-notes/NOTES.md`)

> About the harness, not the game: what worked, what didn't, workarounds in use, and upgrade ideas.
> The Producer adds to it (`npm run notes -- add --kind … "…"`); `npm run studio:reset` keeps it, so
> each project starts with what the last one learned. `npm run notes -- export` turns it into
> something to bring back to the public harness.

## Worked well

- [2026-10-20 · producer] Experiments as tagged commits, not branches: dropping one adds undo commits, so it is safe in the shared checkout. Testing found that a later --only drop has to be remembered, or a full drop tries to undo the same lines twice.
- [2026-10-20 · producer] Walking a fresh studio through intake, sign-off, the Director and an idea end to end found four rough edges before release: too many explore studies, prototypes flagged as drift, a repeated briefing line, and intake able to change locked pillars after signing.
- [2026-10-20 · producer] Cheap prepare, strong act is real code now: a bounded window, a cheap draft and a script check that throws bad drafts away (`npm run brief -- <ID> --model`).
- [2026-10-20 · producer] Done-checks by task type caught unfinished balance and review work in every test run; agents fixed what the refusal named instead of arguing.
- [2026-10-20 · producer] Scripts for watching (watcher, retro, scorecard, briefing) cost no tokens and caught an abandoned task within one watcher pass.
- [2026-10-20 · producer] Handing a task back with a note let a different model pick it up with no chat history.
- [2026-10-20 · producer] Fresh-clone runs found real problems (stale starter queue, invented savings, locked folders after a hand-back) that tests in the working copy missed.
- [2026-10-20 · producer] An outside read-only review on Windows confirmed the core holds: locks, done-checks by content, 64-bit goldens matching in Node and Python, the purity probe, HUB security and a clean secret scan.

## Didn't work

- [2026-10-20 · producer] The 64-bit display hash was two correlated 32-bit FNV lanes, weaker than its width and forgeable. Fixed in 2.10.0: SHA-256 verifies goldens and regressions; the display hash is a true FNV-1a 64.
- [2026-10-20 · producer] Done-checks compared file times, so touching a file could pass a check. Mostly fixed in 2.6.0 (content checks); a balance sweep can still pass when the game hasn't changed.
- [2026-10-20 · producer] Closed-loop failures can only be blamed on models as "suspected". Bug tasks now trace to a commit and model through trailers (2.6.0), but a failure with no bug task still can't.
- [2026-10-20 · producer] Playwright's bundled video recorder needed an ffmpeg build that wasn't installed; screen recordings had to use Chromium's screencast instead.
- [2026-10-20 · producer] Art, audio and narrative are folders and notes, not tools an agent can drive and a gate can check (Grok review). Plan: docs/ROADMAP.md C2.
- [2026-10-20 · producer] No deep skill for "build this system, prove it, hand it off" (Grok review). Plan: ROADMAP S2.
- [2026-10-20 · producer] Renderer budget greps for lights instead of measuring the renderer (Grok review). Plan: ROADMAP S4.
- [2026-10-20 · producer] No content pipeline for a large game (levels, tech tree, economy) beyond a template (Grok review). Plan: ROADMAP C1.
- [2026-10-20 · producer] secret-scan.sh needs /dev/fd for its `< <(…)` loop, which some Git Bash setups lack (Grok review). Fixed in 2.7.0 (Node port).
- [2026-10-20 · producer] The bug skill is a short note, not the whole loop (Grok review). Plan: ROADMAP S1.
- [2026-10-20 · producer] The reviewer gate is optional and passes with no reviews, so a slice can be called done unreviewed (Grok review). Plan: ROADMAP S3.
- [2026-10-20 · producer] On a clean Windows machine 4 required gates fail: `bash` isn't on the PATH and `python3` is the Microsoft Store stub (Windows review). Fixed in 2.7.0.
- [2026-10-20 · producer] focus.mjs prints the brief path with backslashes on Windows, failing one self-test check (Windows review). Fixed in 2.7.0.
- [2026-10-20 · producer] Purity can be dodged with `({}).constructor.constructor`; neither the static check nor the runtime probe catches it (Windows review). Fixed in 2.7.0.
- [2026-10-20 · producer] Claiming a folder and a file inside it at the same moment can both succeed: the overlap check runs before the atomic write (Windows review; there is no shared locks.json, each lock is its own file). Fixed in 2.7.0 with a short mutex.
- [2026-10-20 · producer] Docs disagree: AGENTS.md vs READ-FIRST.md read order; WAR-ROOM, CLONE-AND-CUSTOMIZE and MEMORY docs still say hub/server.js; `npm run setup` only installed packages with `--install` (Windows review). Fixed in 2.7.0, plus a docs gate.

## Workarounds in use

- [2026-10-20 · producer] Commits made with --no-verify skip the commit-msg hook, so they carry no Studio-Task or Studio-Experiment trailer. Don't use --no-verify on game work.
- [2026-10-20 · producer] On a suspicious "done", the Producer reruns `node harness/done-check.mjs <ID>` and reads the diff before accepting.
- [2026-10-20 · producer] File bugs with `--caused-by <task>` whenever the cause is known, so the scorecard has confirmed bugs, not just suspects.
- [2026-10-20 · producer] Record HUD videos from Chromium's screencast frames and encode with the system ffmpeg.

## Upgrade ideas

- [2026-10-20 · producer] Layer keyword matching is a heuristic (it caught "levels" meaning maps and "weather" meaning rain in testing). Watch for false refusals in the stress test; the Director's drift report is the backstop.
- [2026-10-20 · producer] Make each phase's scenario (phase-1-early, …) a required check before the phase opens, on top of the Director's verdict.
- [2026-10-20 · producer] An intake form in the War Room on POST /api/intake: the first piece of a friendlier front end.
- [2026-10-20 · producer] Done-check: prove a regression fails on the commit before the fix (needs a checkout of that commit). Planned with the full bug skill, ROADMAP S1.
- [2026-10-20 · producer] Make the HUB the single home for tasks, locks and events, so agents in cloud sandboxes or separate worktrees share one studio. ROADMAP H5.
- [2026-10-20 · producer] War Room: a Dungeon RPG tab where tasks are rooms, phone access over Tailscale with a cookie login, push alerts when a person is needed, and a link to play the latest build. ROADMAP H2-H6.
- [2026-10-20 · producer] Route tasks by scorecard automatically once enough runs exist, with the Producer approving.
