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

**Which ref.** Take the harness's merged `main` (`upstream/main`, or `origin/main` when origin is the harness). An
unmerged branch (`upstream/claude/<x>`) only on the owner's say-so; then the owner sets
`STUDIO_HARNESS_REF=<remote>/<branch>` in `.env` so the hooks gate treats that branch's own commits like main's (they
carry no stamp until the branch merges; see docs/SECURITY.md). Remove it once the branch is on main.

**A studio older than the upgrade commands** (no `npm run upgrade -- --merge` yet): run the new guard straight from the
ref, without checking anything out. After `git fetch <remote>`, in the studio's main checkout (cmd, PowerShell or bash):

```bash
node -e "require('fs').mkdirSync('.studio',{recursive:true});require('fs').writeFileSync('.studio/upgrade-guard.mjs',require('child_process').execFileSync('git',['show',process.argv[1]+':harness/upgrade-guard.mjs']))" <ref>
node .studio/upgrade-guard.mjs --check
```

then use `node .studio/upgrade-guard.mjs` wherever the steps below say `npm run upgrade --`. (In bash,
`git show <ref>:harness/upgrade-guard.mjs > .studio/upgrade-guard.mjs` does the same; PowerShell 5's `>` writes UTF-16,
which node can't run, so use the line above there.) The guard finds the studio by git from the folder it runs in.

1. `npm run task -- drain on --by <you>`, then `npm run task -- drain wait` (no landing mid-update).
2. **Commit the board first.** `npm run upgrade -- --check` refuses (exit 1) while `studio/NEXT.md`, `studio/DONE.md`,
   `studio/task-holds.json`, `studio/pending-review.json` or `studio/handoffs/` has uncommitted changes, and prints the
   `git add` / `git commit` to run. `--snapshot` also copies them to `.studio/board-snapshots/<time>/`.
3. Other uncommitted work: commit it on a branch, or set it aside with a named stash
   (`git stash push -u -m "<unique-tag>" -- <paths>`) that leaves `studio/` out. Never `git stash` the whole checkout.
4. **Merge:** `npm run upgrade -- --merge <ref> --by <you>`. It refuses unless step 2's check passes, backs the branch
   up as `backup/pre-<version>`, and merges `<ref>` through the hooks. The main-checkout guard ("only studio notes and
   the board are committed here") opens for exactly that merge commit, so nobody needs `STUDIO_MAIN_COMMIT=allow`.
   The merge commit records `Upgrade-By`, `Upgrade-Recorded-By`, `Upgrade-Ref`, `Upgrade-Versions` and
   `Upgrade-Backup`; an `upgrade.merged` event too. An agent (a Producer or Director session, or an agent outside the
   harness such as the crew's orchestrator) adds `--permission "<the owner's words, or a link to the message>"`, kept
   as `Upgrade-Permission`; a worker agent can't run it at all. A conflict stops with the files listed: nothing is
   resolved for you. `git merge --abort` undoes it; resolving an update's conflicts is the owner's call, and a person who
   resolves them by hand finishes with `npm run upgrade -- --merge <ref> --by <you> --continue`.
   **Goldens:** a commit that changes `qa/golden/` needs a `Golden-Reason:` trailer (the commit-msg hook). `--merge`
   adds `Golden-Reason: from <ref> (upgrade): <files>` for the golden files that arrive exactly as `<ref>` has them.
   A golden the merge combined with the studio's own change isn't the upstream's answer: `--merge` stops and asks for
   `--golden-reason "<why>"`. A bundle merged by hand (`git merge` of a bundle's branch) needs the trailer in its merge
   commit's message the same way. The weakened-tests gate judges each of the merged branch's own commits (never the
   merge): a bundle commit that changes or deletes a golden needs its own `Golden-Reason`; one that only adds goldens
   doesn't. Golden changes made in the studio still need their own reason, as always.
5. A stash that did take board changes: `npm run upgrade -- --check` names it. Restore by merge:
   `npm run upgrade -- --restore-stash <sha> --by <you>` (board committed first) three-way merges the stash's board
   files into the board, keeping both sides' rows (conflicting task rows of `studio/NEXT.md` and `studio/DONE.md` are
   all kept), and commits. Any other conflict refuses and lists the files, writing nothing. It never drops the stash:
   it prints the `git stash drop stash@{n}` to run once the board has every row.
6. `npm run verify`, then `npm run task -- drain off --by <you>`.

### Taking 2.59.0 with live lanes (migration note)

2.59.0 changes how lanes land (the merge train), what a hook stamp records (`Studio-Patch-U0`) and refuses a lane's
gates while its harness is behind main. Do it once, in this order:

1. Drain: `npm run task -- drain on --by <you>`, then `npm run task -- drain wait`.
2. One-shot board snapshot, then commit the board: `npm run upgrade -- --snapshot` (copies the board files to
   `.studio/board-snapshots/<time>/` and checks), commit what it names, and run `npm run upgrade -- --check` until it
   passes. Never stash the board.
3. Back up main and merge the harness's main: `npm run upgrade -- --merge <ref> --by <you>` (2.60.0; above). A studio that patched a harness file
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

### 2.60 to 2.64 (migration note)

2.64.0 carries 2.60.1 to 2.64 in one release. Take it the same way as above (drain, snapshot and commit the board,
`npm run upgrade -- --merge <ref> --by <you>`, verify), then:

1. **Live lanes:** bring main into each lane copy (`git merge main`) and re-stamp (`npm run hooks -- restamp`; check and
   restamp now print the same `base <ref> <sha>`). Goldens that arrive unchanged from main need no Golden-Reason in that
   merge. Lanes parked on purpose: `npm run task -- hold <ID> --by <you> --why "…"` (no claim clock, no rescue).
2. **Tiers:** a lane that changes harness/, hub/, scripts/, qa/*.mjs, a protected file, deletes a test/golden/regression
   or carries an upgrade merge is tier C: it waits in the train queue until a person runs
   `npm run task -- train release <ID> --by <person>`. `STUDIO_TRAIN=off` and `--force` no longer skip that.
3. **Render tasks:** set `"visualPaths"` (globs of the game's render/scene code) in studio/game.json so the changed files
   decide whether a task needs a visual result (owner's signed change: the file is protected).
4. **Unity:** set `engines.unity.folder` (and optionally `engines.unity.exits`) in studio/game.json; Unity tasks name
   their branch (`task add --branch <b>` or `node harness/unity-gate.mjs branch <ID> <b>`). Unity builds and tests now
   take machine:heavy.
5. **NIM:** put aider in `.studio/aider-venv` or set `STUDIO_AIDER_CMD`; set `STUDIO_NIM_MODELS` (the models the key may
   use, in order).
6. **Lessons:** lessons reach planning prompts only once accepted (`npm run lessons`, then
   `npm run lessons -- accept <id> --by <name> --why "…"`; a Producer session may accept on its own review).
7. **New protected files:** studio/autonomy.json (the autonomy level and L3 bar) and studio/triggers.json (which sources
   may route work; `"mode": "shadow"` by default). `npm run autonomy` shows the scorecard; `npm run thread -- shadow-report`
   what threads would have routed.

## What 2.30c changed for agents

- **Short output.** `task start` prints the brief's path and a 10-line summary; its JSON carries `carryForward` (the newest hand-off notes, at most 3k characters) instead of the whole history (`studio/handoffs/<ID>.md` keeps it). `npm run handoff` prints at most 3k characters; `npm run handoff -- --full` prints all of it (always saved to `.studio/briefs/producer.md`).
- **Circuit breakers.** A second hand-back for the same reason parks the task with that reason and a War Room card. Refreshes and stops never count. Other tasks keep starting. `npm run task -- unblock <ID> --by <name>` (or Unblock on the card) clears it. `STUDIO_BREAKER=off` turns it off.
- **The Producer on events.** The supervisor and the watcher start a Producer session only after a task is done, forced or tripped, or a card or ask appears; at most once per 15 min (`STUDIO_PRODUCER_MIN_MIN`) unless urgent; the wait doubles while nothing changes (up to 4 h). A person starting it from the War Room is never held back. `STUDIO_PRODUCER_WAKE=always` turns this off.
- **Dependency-aware handout.** The supervisor skips a task whose `--after` prerequisite is done but still on an unmerged lane branch, or whose folder another agent holds, tries the next one, and marks it "waiting on X" in the queue.
- **DONE.md.** Finished tasks move to `studio/DONE.md`; `studio/NEXT.md` keeps only open work. An older NEXT.md's DONE section still counts and moves on the next write.
- **The allowlist in the kickoff.** Every kickoff lists exactly what the agent may run without asking (the same list the launcher passes to Claude Code).
- **Gates in plain words.** `npm run verify`, the run report and the release report list failing gates first with one plain sentence each; "not run" is listed apart and never counted as a pass.
- **Overnight summary.** At `--until`, the supervisor writes `studio/daily/overnight-<date>.md`: tasks done, tokens per finished task (model named), sessions that finished nothing, forced closes, reviews, the top 5 sessions by tokens, open cards. `npm run overnight -- --since 8h` writes one by hand.
