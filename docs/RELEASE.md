# Shipping a release (`npm run release -- <version>`)

One command does what used to be done by hand for every release:

```bash
npm run release -- 2.30.0-c --notes notes.md --title "short output, breakers, the Producer on events"
```

1. Checks you are on `main`, in step with `origin/main` (fetched), and that the version is new.
2. Bumps `package.json` and `package-lock.json`, and writes the CHANGELOG entry from `--notes` (unless one is already there).
3. Makes **one** squashed commit of the working tree on top of `origin/main`. No branches.
4. Clones that commit fresh, installs, and runs `verify --deep` there (every required gate, including the self-test).
5. Bundles `origin/main` as it was (before this release) into the backup folder (`--backup-dir`, `STUDIO_RELEASE_BACKUP_DIR`, default `../backups`) and verifies the bundle.
6. Pushes to `main`. Never forced: if main moved, it stops and you rebase.
7. Waits for CI on that commit. A failed job is re-run once (known flaky timing checks); both results are reported.
8. Reports failing steps first, "not run" apart from "pass". Saved to `.studio/release-last.json`; the clone's verify log is `.studio/release-verify.log`.

Any red step before the push undoes the commit and leaves the work uncommitted; nothing is pushed. `--dry-run` stops before the push. Without the `gh` CLI, CI is reported as "not checked", never as green.

`npm run release` with no version is the read-only check CI runs (syntax, required gates, closed loop, changelog).

**CI shards (2.72.0).** CI runs `node scripts/release.mjs --except selftest` (Linux, Node 22 and 24) and
`node scripts/run-gates.mjs --required-only --deep --except selftest` (Windows); the self-test runs beside them in 4
parallel jobs per platform (`release-gate-selftest`, `windows-selftest`: `node qa/selftest.mjs --shard i/4`), and
`release-gate-summary` is red unless every one of them passed. `--shard i/N` runs every Nth unit of qa/selftest.mjs in
file order (a unit is a top-level block or one gate's sabotage; units with the same group name, such as 267g and
270v's `owner-key`, share a shard), so the shards together are the whole self-test; an empty shard fails.
`node qa/selftest.mjs --list-shards 4` prints the split as JSON and fails when a check runs outside a unit: a new
block starts with `if (inShard()) {` (or `if (inShard('<label>', '<group>')) {` for checks that must stay together).
A one-unit shard (`--list-shards <units>` gives its number) runs one block alone. `--except` runs are partial: they
never write a verify record. Locally, `npm run release` still runs the whole self-test in one process.

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

0. **Preflight (2.73.0):** `npm run upgrade -- --preflight [--ref <ref>] [--json]` (or `node .studio/upgrade-guard.mjs
   --preflight --ref <ref>` on an older studio: the guard takes its helper from the ref). Read-only. One line per item,
   PASS / WARN / FAIL / INFO, a `Fix:` line under each WARN and FAIL, exit 1 on any FAIL: node against the ref's
   `engines`, git (`STUDIO_PREFLIGHT_MIN_GIT`, default 2.34), the main checkout (on a branch, nothing in progress, the ref
   resolves), the board committed (stash entries with board rows: WARN), the owner key committed
   (`studio/keys/owner-ed25519.pub.pem`; FAIL without it; WARN when the private key is on this machine), the protected
   check's signatures, disk from the machine scan (FAIL under `STUDIO_DISK_MIN_FREE_GB`) and memory headroom (WARN under
   `STUDIO_PREFLIGHT_MIN_RAM_GB`, default 4), `STUDIO_UNITY` / `GODOT_BIN` resolving when set (Unity, Blender and ffmpeg on
   the PATH as INFO), `STUDIO_REPORT_WEBHOOK` set (never printed; FAIL when `.env` is tracked by git), `studio/policy.json`,
   `delegation.json`, `autonomy.json` and `overseer.json` readable, and each lane copy with unlanded work (WARN, listed).
   2.73.1: `dotenv-identity` WARNs when `.env` sets `STUDIO_LOCK_OWNER`, `STUDIO_ROLE`, `STUDIO_AGENT` or `STUDIO_MAIN_ROOT`
   (B-60: identity settings belong to a session; every loader ignores them there and warns, naming the line). A lane is
   a registered worktree (`git worktree list`) with its own `.git`; any other folder in `.lanes/` is listed as a
   `lanes-leftover` INFO, "leftover folder (not a lane)", and git is never run in it (B-51: git there answered for the
   main checkout, so main's dirty board read as "unlanded work" once per old folder). `lanes refresh` refuses such a
   folder the same way.
   2.78.1, "before a long run" (`long-run/…`, WARN only, so the exit code stays the other items'): `.env` lines a later
   release made unnecessary (`harness/upgrade-leftovers.json`: version, key, value, why; e.g. `STUDIO_STALL_RATIO=0`,
   `STUDIO_HEAVY_SLOTS`; flagged once the studio's harness is at that version; values never printed), ready builder
   tasks with no lane (each would hold the whole game), uncommitted changes in `harness/` or `scripts/` (a local patch),
   and trains or verify runs still running from before the harness last changed. Run it again after the update, before
   starting a long run.
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
   **Lanes (2.67.0, B-49):** a merged update ends with `npm run lanes -- refresh --all` (the updated harness's), so the
   next train doesn't hand every lane back as "runs its own harness". The output lists each lane as refreshed (main
   merged in, targeted tests green), conflicted (merge aborted, files named: its agent merges and resolves), red
   (targeted tests fail) or skipped (a running session, uncommitted work, a merge in progress: never touched). The
   upgrade passes either way. `STUDIO_UPGRADE_REFRESH=off` skips the refresh (run it yourself later);
   `STUDIO_UPGRADE_REFRESH=no-tests` merges without running the lanes' targeted tests.
   **2.76.0 (B-81):** the refresh runs in its own background process (log `.studio/upgrades/lanes-refresh-<time>.log`)
   and the upgrade waits for it at most `STUDIO_UPGRADE_REFRESH_WAIT_S` (120) seconds: on the crew's PC the refresh ran
   past its caller's limit ("lanes refresh gave no result (exit 143)") and the next train bounced every lane. Still
   running, the upgrade says so and the refresh goes on by itself. Each lane's targeted tests stop at
   `STUDIO_LANES_REFRESH_TEST_S` (600; 0 = no limit): main stays merged in and the lane is left to the train's full
   verify. And the train refreshes a lane whose harness is behind main itself, before its checks (main merged in,
   commits re-stamped, no tests; `harness/train-refresh.mjs`); only a real conflict hands it back.
   `STUDIO_TRAIN_REFRESH=off` turns that off.
   **2.78.0 (B-105):** a lane copy's `studio/` is a link to the main checkout's (a junction on Windows), and a refresh
   used to merge main through it ("git merge failed: studio/task-holds.json"). Every refresh (the train's, `npm run
   lanes -- refresh`, the upgrade's) now marks the lane's `studio/` paths left out of its index first, so main's live
   board files are never touched; a real conflict elsewhere still stops it with the files named. A builder's verify in a
   lane behind main on harness files refreshes the lane itself (as `harness`, same merge and re-stamp) and runs again on
   the new code (`STUDIO_LANE_REFRESHED=1` marks that second run so it never loops); if the refresh can't run it says to
   hand the task back (`npm run task -- pause`), not to rebase or restamp.
   **Before snapshot (2.73.0):** just before it merges, `--merge` writes `.studio/upgrades/<from>-to-<to>.json`: the
   studio's numbers over the `STUDIO_UPGRADE_SNAPSHOT_DAYS` (3) days before the update (landed per hour, false reds per
   train, tokens per landed change and by task, red verify %, workarounds per day, verify minutes, hand-backs, no-work
   sessions; harness/upgrade-baseline.mjs). A merge stopped on a conflict keeps the first one for `--continue`.
   `npm run autonomy -- impact` uses it as the before side (docs/AUTONOMY.md "Release impact").
5. A stash that did take board changes: `npm run upgrade -- --check` names it. Restore by merge:
   `npm run upgrade -- --restore-stash <sha> --by <you>` (board committed first) three-way merges the stash's board
   files into the board, keeping both sides' rows (conflicting task rows of `studio/NEXT.md` and `studio/DONE.md` are
   all kept), and commits. Any other conflict refuses and lists the files, writing nothing. It never drops the stash:
   it prints the `git stash drop stash@{n}` to run once the board has every row.
6. **Smoke (2.73.0):** `npm run upgrade -- --smoke [--keep] [--json]` right after the merge: a tiny verify and a tiny
   train on a throwaway made-up task in a scratch copy of the studio's harness (the OS temp folder, a fresh empty board,
   never the real one), the machine scan, and one supervisor pass in dry run (no agent starts). PASS / FAIL per item with
   `Fix:` lines, exit 1 on a FAIL, an `upgrade.smoke` event. `--keep` keeps the copy to look into. A FAIL: read its Fix
   line, or `npm run upgrade -- --rollback --by <you>`.
7. `npm run verify`, then `npm run task -- drain off --by <you>`.
8. **Roll back (2.71.1):** `npm run upgrade -- --rollback --by <you> [--permission "…"]` returns the studio to the
   harness it had before the last update (`backup/pre-<version>`) in one step: it reverts that update's merge commit
   (`git revert -m 1`, never a reset), so work that landed since stays. It goes through the hooks (the main-checkout
   guard opens for exactly that revert: `STUDIO_UPGRADE_REVERT=<the merge>`, checked against `REVERT_HEAD`), adds
   `Upgrade-Rollback-Of` and a `Golden-Reason` for goldens that come back as they were, refreshes the lanes, and records
   an `upgrade.rolled_back` event and an `upgrade-rollback` decision (`npm run decisions`). It refuses with an
   uncommitted board change (or any uncommitted tracked change), mid-merge or mid-revert, in a lane copy, and on a
   conflict with later work (the revert is undone and the files named; resolving it is the owner's call). It never
   deletes a branch. Who may run it is the same as `--merge`. Take the update again with `--merge` (or revert the
   rollback commit).

### A release's predictions (2.73.0)

Whoever ships a release can say what it should move: `npm run release -- predict --metric <name> --expect "-30%"
[--release <version>] [--why "…"] [--by <you>]` writes `docs/releases/<version>.json` (the version defaults to
package.json's; a second predict of the same metric replaces it; `--list` shows them). Metrics: the impact report's
(`landedPerHour`, `redVerifyPct`, `tokensPerKept`, `verifyP50Min`, …) and the snapshot's (`falseRedsPerTrain`,
`tokensPerLanded`, `workaroundsPerDay`), or short names (`landed/h`, `false-reds`, `workarounds/day`). `"-30%"` is a hit
when the measured change is -30% or lower, `"+10%"` when +10% or higher, `"~0%"` within 10 points; `<=`, `<`, `>=`, `>`
work as written. The file ships with the harness; a studio's `npm run autonomy -- impact` scores each prediction of the
release it reports on (hit / miss with the measured change, or not scored while a side has too little data).

### The upgrade watch (2.69.0)

`npm run upgrade -- watch` checks for a newer harness now; the supervisor does the same every
`STUDIO_UPGRADE_WATCH_MIN` (60; `off`: never). It watches the `ref` in `studio/upgrade.json`, else `main` on the remote
of `STUDIO_HARNESS_REF`, else `upstream/main`; fetches it (`STUDIO_UPGRADE_FETCH_MS`, 60000) and compares its
`package.json` version with the studio's. A newer one has its CI read from the public GitHub API (no token); a remote
that isn't on GitHub, an API it can't reach or CI that isn't finished green means it is only reported. It takes the
update on its own (steps 4-5 above, as `upgrade --merge` for the person who switched it on) only when:

- auto-upgrade is on: `npm run upgrade -- watch auto on --by <person>` commits `studio/upgrade.json` with who set it.
  A person in their own terminal, an agent outside the harness or a Producer/Director session with `--permission
  "<the person's words>"`, or the agent the owner's delegation covers for `upgrade-auto` (`npm run delegate`); never
  a worker. `watch auto off` (anyone) turns it off. It counts as committed in the main checkout;
- CI on that commit is green;
- now is inside `STUDIO_UPGRADE_WINDOW` (local time, for example `03:00-05:00`; unset: report only);
- no merge train, no heavy work (a verify) and no agent session is running; otherwise it waits for the next check.

After the merge and the lanes refresh it files one builder task per conflicted lane. Every changed answer is an
`upgrade.watch` event (the 2.68.0 impact report reads `upgrade.merged`). `npm run upgrade -- watch status` shows the
switch and the last check. The running supervisor keeps the old harness in memory: restart it after an upgrade.

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
non-Godot games). 2.65.0: a render task's "before" is captured twice per camera (`before-noise/`) and its change must
reach max(1%, `STUDIO_VISUAL_NOISE_K` (2) x that camera's noise), capped at `STUDIO_VISUAL_NOISE_CAP` (0.05): a noisier
scene is "too noisy to judge", never a pass (`STUDIO_VISUAL_NOISE=off` skips the second capture); on Windows a full
verify records each gate's shell in its machine:heavy tree, so `heavy stop` and the next take find what a gate left
running. A task's type is the owner's decision: `npm run task -- type <ID> <type> --by <name> --why "..."`.
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
7. **New protected file:** studio/triggers.json (which sources may route work; `"mode": "shadow"` by default). The
   autonomy level (studio/autonomy.json) is set by a person, the Producer or an outside agent, not workers. `npm run autonomy` shows the scorecard; `npm run thread -- shadow-report`
   what threads would have routed.

## What 2.30c changed for agents

- **Short output.** `task start` prints the brief's path and a 10-line summary; its JSON carries `carryForward` (the newest hand-off notes, at most 3k characters) instead of the whole history (`studio/handoffs/<ID>.md` keeps it). `npm run handoff` prints at most 3k characters; `npm run handoff -- --full` prints all of it (always saved to `.studio/briefs/producer.md`).
- **Circuit breakers.** A second hand-back for the same reason parks the task with that reason (a task.breaker event). Refreshes and stops never count. Other tasks keep starting. `npm run task -- unblock <ID> --by <name>` (or Unblock on the card) clears it. `STUDIO_BREAKER=off` turns it off.
- **The Producer on events.** The supervisor and the watcher start a Producer session only after a task is done, forced or tripped, or a card or ask appears; at most once per 15 min (`STUDIO_PRODUCER_MIN_MIN`) unless urgent; the wait doubles while nothing changes (up to 4 h). A person starting it from the War Room is never held back. `STUDIO_PRODUCER_WAKE=always` turns this off.
- **Dependency-aware handout.** The supervisor skips a task whose `--after` prerequisite is done but still on an unmerged lane branch, or whose folder another agent holds, tries the next one, and marks it "waiting on X" in the queue.
- **DONE.md.** Finished tasks move to `studio/DONE.md`; `studio/NEXT.md` keeps only open work. An older NEXT.md's DONE section still counts and moves on the next write.
- **The allowlist in the kickoff.** Every kickoff lists exactly what the agent may run without asking (the same list the launcher passes to Claude Code).
- **Gates in plain words.** `npm run verify`, the run report and the release report list failing gates first with one plain sentence each; "not run" is listed apart and never counted as a pass.
- **A Fix: line on every failure (2.66.0).** Each failing gate's FAIL (or WARN) line in `npm run verify` is followed by one `[gates] Fix: …` line: the next step for that gate (harness/gate-fix.mjs; a studio's own gate can carry a `"fix"` in studio/gates.json), ending with `npm run verify -- --only <gate>`. Safety gates never say "approve": they say to put it back or hand the task back. `node harness/gate-fix.mjs --check` fails when a gate or game check kind has no entry of its own; the selftest runs it.
- **Settings map (2.66.0).** `node scripts/settings-map.mjs` writes `docs/SETTINGS.md`: every `STUDIO_*` name the code reads, with its default, its files and the docs page that explains it. The docs gate runs `--check`: a name used in the code must be mentioned on a docs/ page or listed in `docs/settings-baseline.json` (the undocumented ones of 2.66.0, frozen; it only shrinks, `--prune-baseline`). So a new setting is documented in the change that adds it. The baseline only shrinks: names added to it since the main branch's copy (`STUDIO_SETTINGS_BASE_REF` names another revision) fail the same check, so nobody has to guard it.
- **Cleanup tools (2.79).** Two read-only reports for the 2.79 cleanup release; neither gates anything. `node scripts/settings-census.mjs [--json] [--env <a studio's .env>] [--events <its events.jsonl>]` lists every `STUDIO_*` setting with its default, the modules that read it, whether `docs/settings-baseline.json` freezes it, the release that first mentions it (CHANGELOG.md, `docs/RELEASE-*.md`) and, given `--env`/`--events`, whether that studio sets it; then candidates: off switches for a fix added two or more releases ago, families by suffix (`_WAIT_MIN`, `_HOLD_MIN`, `_TIMEOUT_MS`, …) with their docs lines side by side, and settings no module reads (dead). `node scripts/size-report.mjs [--json] [--against <git ref>]` prints modules and lines for harness/, scripts/ and hub/, the 15 largest harness modules, selftest files and units, docs pages and the settings count, and with `--against` the delta per number (it reads the ref with `git archive`; no tests run). The audit that uses them (decision owners, dead code, the split plan, the order of work): `docs/CLEANUP-2.79-AUDIT.md`.
- **Overnight summary.** At `--until`, the supervisor writes `studio/daily/overnight-<date>.md`: tasks done, tokens per finished task (model named), sessions that finished nothing, forced closes, reviews, the top 5 sessions by tokens, open cards. `npm run overnight -- --since 8h` writes one by hand.
