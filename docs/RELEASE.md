# Shipping a release (`npm run release -- <version>`)

One command does what used to be done by hand for every release:

```bash
npm run release -- 2.30.0-c --notes notes.md --title "short output, breakers, the Producer on events" --shots ./hud-shots
```

1. Checks you are on `main`, in step with `origin/main` (fetched), and that the version is new.
2. Bumps `package.json` and `package-lock.json`, and writes the CHANGELOG entry from `--notes` (unless one is already there).
3. Makes **one** squashed commit of the working tree on top of `origin/main`. No branches.
4. Clones that commit fresh, installs, and runs `verify --deep` there (every required gate, including the self-test and the War Room smoke test), then the War Room browser check (`qa/hud-check.mjs`, screenshots with `--shots`).
5. Bundles `origin/main` as it was (before this release) into the backup folder (`--backup-dir`, `STUDIO_RELEASE_BACKUP_DIR`, default `../backups`) and verifies the bundle.
6. Pushes to `main`. Never forced: if main moved, it stops and you rebase.
7. Waits for CI on that commit. A failed job is re-run once (known flaky timing checks); both results are reported.
8. Reports failing steps first, "not run" apart from "pass". Saved to `.studio/release-last.json`; the clone's verify log is `.studio/release-verify.log`.

**The War Room browser check** (`node qa/hud-check.mjs`, also CI's `war-room-browser` job) waits for each state it
checks (up to 15 s, 30 s on Windows; `HUD_WAIT_MS` changes it) and, on a time-out, prints what the page showed;
Stop and Pause must show an empty list that holds through a page refresh. To test a timing fix, run the agent checks
alone many times: `node qa/hud-check.mjs --only stop-pause --repeat 30` (pass count and seconds per round at the end;
`HUD_TRACE=1` prints each press and wait).

Any red step before the push undoes the commit and leaves the work uncommitted; nothing is pushed. `--dry-run` stops before the push. Without the `gh` CLI, CI is reported as "not checked", never as green.

`npm run release` with no version is the read-only check CI runs (syntax, required gates, closed loop, changelog).

**Batching (owner's rule, 2026-11-01):** approved upgrades can and should ship together in one release and one PR,
each with its own commit and its own selftest file. Still required: a backup branch of `main` first, the full
selftest, and green online checks before the merge.

## Taking a harness update into a studio

A studio (a private copy with a game in it) takes a new harness version by merging it, never by stashing its board.
On a crew's PC the 2.58.2 update stashed the dirty main checkout and the board went with it: finished tasks' DONE.md
rows and that morning's NEXT.md tasks, uncommitted. A finished task reopened and seven sessions were spent on it.

1. `npm run task -- drain on --by <you>`, then `npm run task -- drain wait` (no landing mid-update).
2. **Commit the board first.** `npm run upgrade -- --check` refuses (exit 1) while `studio/NEXT.md`, `studio/DONE.md`,
   `studio/task-holds.json`, `studio/pending-review.json` or `studio/handoffs/` has uncommitted changes, and prints the
   `git add` / `git commit` to run. `--snapshot` also copies them to `.studio/board-snapshots/<time>/`.
3. Other uncommitted work: commit it on a branch, or set it aside with a named stash
   (`git stash push -u -m "<unique-tag>" -- <paths>`) that leaves `studio/` out. Never `git stash` the whole checkout.
4. Back up `main` (`git branch backup/pre-<version> main`), then `git pull upstream main` (a merge: the board keeps
   both sides). A conflict in a board file: keep the rows from both sides.
5. A stash that did take board changes: `npm run upgrade -- --check` names it. Restore by merge: with the board
   committed, `git stash apply <sha>` (three-way), keep both sides' rows, commit; drop the entry only after.
6. `npm run verify`, then `npm run task -- drain off --by <you>`.

### Taking 2.59.0 with live lanes (migration note)

2.59.0 changes how lanes land (the merge train), what a hook stamp records (`Studio-Patch-U0`) and refuses a lane's
gates while its harness is behind main. Do it once, in this order:

1. Drain: `npm run task -- drain on --by <you>`, then `npm run task -- drain wait`.
2. One-shot board snapshot, then commit the board: `npm run upgrade -- --snapshot` (copies the board files to
   `.studio/board-snapshots/<time>/` and checks), commit what it names, and run `npm run upgrade -- --check` until it
   passes. Never stash the board.
3. Back up main (`git branch backup/pre-2.59.0 main`), merge the harness's main. A studio that patched a harness file
   locally (for example its own fix for the hooks gate) takes upstream's version of that file: 2.58.5 and 2.59.0
   replace such patches.
4. `npm run verify -- --all` on main must be green before any lane lands.
5. Each live lane copy (`.lanes/<agent>`): bring main in (`git merge main`, or `git rebase main`), then re-stamp:
   `npm run hooks -- restamp` in the lane. It re-commits the lane's commits through the real hooks, keeps
   `backup/<lane>-pre-restamp-<time>`, and refuses with uncommitted changes. Until a lane has main's harness,
   `npm run verify` and the hooks check in it refuse and say so (`STUDIO_LANE_HARNESS=own` runs the lane's own copy).
6. `npm run task -- drain off --by <you>`. Lanes then land through trains: `task done <ID>` in a lane is a one-lane
   train; `task done <ID> --train` queues it and `npm run task -- train` lands every queued lane on one full verify.
   `STUDIO_TRAIN=off` keeps the old one-at-a-time path.

New settings to know: `STUDIO_HEAVY_SLOTS` (1: full verifies, Unity landings and wrapped playtests run one at a
time), `STUDIO_RAM_FLOOR_GB` (3: no new agent below it), `STUDIO_RESUME_BY` (who may run `npm run studio:resume`),
`STUDIO_KEYMAP_<ROLE>` / `STUDIO_KEYMAP_AGENT_<NAME>` (a key per role or agent), `studio/game.json`
`engines.unity.land` (the Unity landing command), a game manifest's `"visual": { "capture": ... }` (render tasks on
non-Godot games). A task's type is the owner's decision: `npm run task -- type <ID> <type> --by <name> --why "..."`.
2.59.1: with the owner's direct permission a Producer or Director session, or an agent outside the harness, may run it
(and `npm run studio:resume`) for them by adding `--permission "<the owner's words, or a link to the message>"`; the
record keeps the permission and who recorded it. Builders and other worker agents never can.

## What 2.30c changed for agents

- **Short output.** `task start` prints the brief's path and a 10-line summary; its JSON carries `carryForward` (the newest hand-off notes, at most 3k characters) instead of the whole history (`studio/handoffs/<ID>.md` keeps it). `npm run handoff` prints at most 3k characters; `npm run handoff -- --full` prints all of it (always saved to `.studio/briefs/producer.md`).
- **Circuit breakers.** A second hand-back for the same reason parks the task with that reason and a War Room card. Refreshes and stops never count. Other tasks keep starting. `npm run task -- unblock <ID> --by <name>` (or Unblock on the card) clears it. `STUDIO_BREAKER=off` turns it off.
- **The Producer on events.** The supervisor and the watcher start a Producer session only after a task is done, forced or tripped, or a card or ask appears; at most once per 15 min (`STUDIO_PRODUCER_MIN_MIN`) unless urgent; the wait doubles while nothing changes (up to 4 h). A person starting it from the War Room is never held back. `STUDIO_PRODUCER_WAKE=always` turns this off.
- **Dependency-aware handout.** The supervisor skips a task whose `--after` prerequisite is done but still on an unmerged lane branch, or whose folder another agent holds, tries the next one, and marks it "waiting on X" in the queue.
- **DONE.md.** Finished tasks move to `studio/DONE.md`; `studio/NEXT.md` keeps only open work. An older NEXT.md's DONE section still counts and moves on the next write.
- **The allowlist in the kickoff.** Every kickoff lists exactly what the agent may run without asking (the same list the launcher passes to Claude Code).
- **Gates in plain words.** `npm run verify`, the run report and the release report list failing gates first with one plain sentence each; "not run" is listed apart and never counted as a pass.
- **Overnight summary.** At `--until`, the supervisor writes `studio/daily/overnight-<date>.md`: tasks done, tokens per finished task (model named), sessions that finished nothing, forced closes, reviews, the top 5 sessions by tokens, open cards. `npm run overnight -- --since 8h` writes one by hand.
