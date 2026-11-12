# Shipping a release (`npm run release -- <version>`)

One command does what used to be done by hand for every release:

```bash
npm run release -- 2.30.0-c --notes notes.md --title "short output, breakers, the Producer on events"
```

1. Checks you are on `main`, in step with `origin/main` (fetched), and that the version is new.
2. Bumps `package.json` and `package-lock.json`, and writes the CHANGELOG entry from `--notes` (unless one is already there).
3. Makes **one** squashed commit of the working tree on top of `origin/main`. No branches.
4. Clones that commit fresh, installs, and runs `verify --deep` there (every required gate, including the self-test).
5. Bundles `origin/main` as it was (before this release) into the backup folder (`--backup-dir`, `STUDIO_RELEASE_BACKUP_DIR`,
   default `../backups`) and verifies the bundle.
6. Pushes to `main`. Never forced: if main moved, it stops and you rebase.
7. Waits for CI on that commit. A failed job is re-run once (known flaky timing checks); both results are reported.
8. Reports failing steps first, "not run" apart from "pass". Saved to `.studio/release-last.json`; the clone's verify log is
   `.studio/release-verify.log`.

Any red step before the push undoes the commit and leaves the work uncommitted; nothing is pushed. `--dry-run` stops before
the push. Without the `gh` CLI, CI is reported as "not checked", never as green. `npm run release` with no version is the
read-only check CI runs (syntax, required gates, closed loop, changelog).

**Batching (owner's rule, 2026-11-01):** approved upgrades can and should ship together in one release and one PR, each with
its own commit and its own selftest file. Still required: a backup branch of `main` first, the full selftest, and green online
checks before the merge.

**Predictions (2.73.0).** Whoever ships a release can say what it should move: `npm run release -- predict --metric <name>
--expect "-30%" [--release <version>] [--why "…"] [--by <you>]` writes `docs/releases/<version>.json` (version defaults to
package.json's; a second predict of the same metric replaces it; `--list` shows them). Metrics: the impact report's
(`landedPerHour`, `redVerifyPct`, `tokensPerKept`, `verifyP50Min`, …) and the snapshot's (`falseRedsPerTrain`,
`tokensPerLanded`, `workaroundsPerDay`), or short names (`landed/h`, `false-reds`, `workarounds/day`). `"-30%"` hits when the
measured change is -30% or lower, `"+10%"` at +10% or higher, `"~0%"` within 10 points; `<=`, `<`, `>=`, `>` work as written.
The file ships with the harness; a studio's `npm run autonomy -- impact` scores each prediction of the release it reports on
(hit / miss with the measured change, or not scored while a side has too little data).

## CI and the self-test

- **CI shards (2.72.0).** CI runs `node scripts/release.mjs --except selftest` (Linux, Node 22 and 24) and
  `node scripts/run-gates.mjs --required-only --deep --except selftest` (Windows); the self-test runs beside them in 4
  parallel jobs per platform (`release-gate-selftest`, `windows-selftest`: `node qa/selftest.mjs --shard i/4`), and
  `release-gate-summary` is red unless every one passed. `--shard i/N` runs every Nth unit of `qa/selftest.mjs` in file order
  (a unit is a top-level block or one gate's sabotage; units with the same group name, such as 267g and 270v's `owner-key`,
  share a shard), so the shards together are the whole self-test; an empty shard fails.
- `node qa/selftest.mjs --list-shards 4` prints the split as JSON and fails when a check runs outside a unit: a new block
  starts with `if (inShard()) {` (or `if (inShard('<label>', '<group>')) {` for checks that must stay together). A one-unit
  shard (`--list-shards <units>` gives its number) runs one block alone. `--except` runs are partial and never write a verify
  record. Locally, `npm run release` runs the whole self-test in one process.
- **Part of the self-test during work:** `npm run selftest:changed` (minutes): `--changed [ref]` runs the units the files
  changed since `ref` touch (default: merge base with origin/main, else HEAD~1; uncommitted files count): a unit whose test
  file names a changed file (`--deep` also follows one hop through importing modules), and every unit when a shared file
  changed (package.json, studio/gates.json, qa/fixtures/). `--only a,b` runs named units (a label, `L1234`, a group, or a name
  the block mentions); a selection matching nothing fails and says it is not the whole self-test. Before a merge the full
  self-test runs on CI in shards, so a missed selection never lands.
- `npm run selftest:fast` (`--jobs 4`) runs the shards side by side as child processes on a big machine. `--timing [file]`
  prints the 20 slowest units and writes every unit's ms, subprocesses and checks to `.studio/selftest-timing.json` after each
  unit (a killed run keeps it). `--balance [file]` with `--shard` or `--list-shards` splits by those recorded times (greedy,
  longest first; a unit with no time counts as the median; a group stays together) instead of by count; the file is
  `qa/selftest-timing.json` when committed, else `.studio/selftest-timing.json`.
- **Top-level await check (2.84).** `npm run check:tla` (`scripts/check-top-level-await.mjs`, a step after `npm run release` in
  the `release-gate` job of ci.yml) fails when a harness or scripts module, run as a command, awaits at top level a dynamic
  `import('./x.mjs')` (directly, or through a helper it awaits) and x's static imports lead back to that module: the module is
  still evaluating while it waits, so x never finishes and Node ends the process with exit 13 ("unsettled top-level await")
  before the command does anything (shipped twice: `engine-rules.mjs` in 2.82, `budget.mjs` in 2.83). Fix: wrap the
  command-line part in an async function with a `.catch` that exits 1. `--all` also lists, as information only, modules with a
  top-level await that another module imports statically (latent); `--json` prints the offenders with their chain.
- **Settings map (2.66.0).** `node scripts/settings-map.mjs` writes `docs/SETTINGS.md`: every `STUDIO_*` name the code reads,
  with its default, files and the docs page that explains it. The docs gate runs `--check`: a name used in the code must be
  mentioned on a docs/ page or listed in `docs/settings-baseline.json` (the undocumented ones of 2.66.0, frozen; it only
  shrinks, `--prune-baseline`). So a new setting is documented in the change that adds it. Names added to the baseline since
  the main branch's copy (`STUDIO_SETTINGS_BASE_REF` names another revision) fail the same check.
- **Cleanup reports (2.79),** read-only, gating nothing: `node scripts/settings-census.mjs [--json] [--env <a studio's .env>]
  [--events <its events.jsonl>]` lists every `STUDIO_*` setting with its default, reading modules, whether the baseline freezes
  it, the release that first mentions it (CHANGELOG.md, `docs/RELEASE-*.md`) and, given `--env`/`--events`, whether that studio
  sets it; then candidates (off switches for a fix two or more releases old, families by suffix such as `_WAIT_MIN`, `_HOLD_MIN`,
  `_TIMEOUT_MS`, and settings no module reads). `node scripts/size-report.mjs [--json] [--against <git ref>]` prints modules and
  lines for harness/, scripts/ and hub/, the 15 largest harness modules, selftest files and units, docs pages and the settings
  count, and with `--against` the delta per number (reads the ref with `git archive`; no tests run). The audit using them:
  `docs/CLEANUP-2.79-AUDIT.md`.

## Taking a harness update into a studio

A studio (a private copy with a game in it) takes a new harness version by merging it, never by stashing its board (a stash
once took finished tasks' DONE.md rows and the morning's NEXT.md tasks with it, and a finished task reopened).

**Which ref.** Take the harness's merged `main` (`upstream/main`, or `origin/main` when origin is the harness). An unmerged
branch (`upstream/claude/<x>`) only on the owner's say-so; then the owner sets `STUDIO_HARNESS_REF=<remote>/<branch>` in `.env`
so the hooks gate treats that branch's own commits like main's (they carry no stamp until the branch merges; see
docs/SECURITY.md). Remove it once the branch is on main.

**A studio older than the upgrade commands** (no `npm run upgrade -- --merge` yet): run the new guard straight from the ref,
without checking anything out. After `git fetch <remote>`, in the studio's main checkout (cmd, PowerShell or bash):

```bash
node -e "require('fs').mkdirSync('.studio',{recursive:true});require('fs').writeFileSync('.studio/upgrade-guard.mjs',require('child_process').execFileSync('git',['show',process.argv[1]+':harness/upgrade-guard.mjs']))" <ref>
node .studio/upgrade-guard.mjs --check
```

then use `node .studio/upgrade-guard.mjs` wherever the steps below say `npm run upgrade --`. (In bash,
`git show <ref>:harness/upgrade-guard.mjs > .studio/upgrade-guard.mjs` does the same; PowerShell 5's `>` writes UTF-16, which
node can't run, so use the line above there.) The guard finds the studio by git from the folder it runs in.

0. **Preflight (2.73.0):** `npm run upgrade -- --preflight [--ref <ref>] [--json]` (older studio: `node
   .studio/upgrade-guard.mjs --preflight --ref <ref>`; the guard takes its helper from the ref). Read-only. One line per item,
   PASS / WARN / FAIL / INFO, a `Fix:` line under each WARN and FAIL, exit 1 on any FAIL. Items: node against the ref's
   `engines`; git (`STUDIO_PREFLIGHT_MIN_GIT`, default 2.34); the main checkout (on a branch, nothing in progress, the ref
   resolves); the board committed (stash entries with board rows: WARN); the owner key committed
   (`studio/keys/owner-ed25519.pub.pem`; FAIL without it; WARN when the private key is on this machine); the protected check's
   signatures; disk from the machine scan (FAIL under `STUDIO_DISK_MIN_FREE_GB`) and memory headroom (WARN under
   `STUDIO_PREFLIGHT_MIN_RAM_GB`, default 4); `STUDIO_UNITY` / `GODOT_BIN` resolving when set (Unity, Blender and ffmpeg on the
   PATH as INFO); `STUDIO_REPORT_WEBHOOK` set (never printed; FAIL when `.env` is tracked by git); `studio/policy.json`,
   `delegation.json`, `autonomy.json` and `overseer.json` readable; each lane copy with unlanded work (WARN, listed).
   - `dotenv-identity` WARNs when `.env` sets `STUDIO_LOCK_OWNER`, `STUDIO_ROLE`, `STUDIO_AGENT` or `STUDIO_MAIN_ROOT` (2.73.1:
     identity belongs to a session; every loader ignores them there and warns, naming the line).
   - A lane is a registered worktree (`git worktree list`) with its own `.git`; any other folder in `.lanes/` is a
     `lanes-leftover` INFO ("leftover folder (not a lane)"), git is never run in it, and `lanes refresh` refuses it too.
   - "Before a long run" (2.78.1, `long-run/…`, WARN only, so the exit code stays the other items'): `.env` lines a later
     release made unnecessary (`harness/upgrade-leftovers.json`: version, key, value, why; e.g. `STUDIO_STALL_RATIO=0`,
     `STUDIO_HEAVY_SLOTS`; flagged once the studio's harness is at that version; values never printed), ready builder tasks
     with no lane, uncommitted changes in `harness/` or `scripts/` (a local patch), and trains or verifies still running from
     before the harness last changed. Run it again after the update, before a long run.
1. `npm run task -- drain on --by <you>`, then `npm run task -- drain wait` (no landing mid-update).
2. **Commit the board first.** `npm run upgrade -- --check` refuses (exit 1) while `studio/NEXT.md`, `studio/DONE.md`,
   `studio/task-holds.json`, `studio/pending-review.json` or `studio/handoffs/` has uncommitted changes, and prints the
   `git add` / `git commit` to run. `--snapshot` also copies them to `.studio/board-snapshots/<time>/`.
3. Other uncommitted work: commit it on a branch, or set it aside with a named stash
   (`git stash push -u -m "<unique-tag>" -- <paths>`) that leaves `studio/` out. Never `git stash` the whole checkout.
4. **Merge:** `npm run upgrade -- --merge <ref> --by <you>`. It refuses unless step 2's check passes, backs the branch up as
   `backup/pre-<version>`, and merges `<ref>` through the hooks. The main-checkout guard ("only studio notes and the board are
   committed here") opens for exactly that merge commit, so nobody needs `STUDIO_MAIN_COMMIT=allow`. The merge commit records
   `Upgrade-By`, `Upgrade-Recorded-By`, `Upgrade-Ref`, `Upgrade-Versions` and `Upgrade-Backup`, and an `upgrade.merged` event.
   An agent (a Producer or Director session, or an outside agent such as the crew's orchestrator) adds `--permission "<the
   owner's words, or a link to the message>"` (kept as `Upgrade-Permission`); a worker agent can't run it at all. A conflict
   stops with the files listed and nothing resolved; `git merge --abort` undoes it; resolving an update's conflicts is the
   owner's call, and a person who resolves them by hand finishes with `npm run upgrade -- --merge <ref> --by <you> --continue`.
   - **Goldens:** a commit changing `qa/golden/` needs a `Golden-Reason:` trailer (the commit-msg hook). `--merge` adds
     `Golden-Reason: from <ref> (upgrade): <files>` for golden files that arrive exactly as `<ref>` has them. A golden the
     merge combined with the studio's own change isn't upstream's answer: `--merge` stops and asks for `--golden-reason "<why>"`.
     A bundle merged by hand (`git merge` of a bundle's branch) needs the trailer in its merge commit's message the same way.
     The weakened-tests gate judges each of the merged branch's own commits (never the merge): a bundle commit that changes or
     deletes a golden needs its own `Golden-Reason`; one that only adds goldens doesn't. The studio's own golden changes still
     need their own reason.
   - **Lanes (2.67.0):** a merged update ends with `npm run lanes -- refresh --all` (the updated harness's), so the next train
     doesn't hand every lane back as "runs its own harness". It lists each lane as refreshed (main merged in, targeted tests
     green), conflicted (merge aborted, files named: its agent resolves), red (targeted tests fail) or skipped (a running
     session, uncommitted work, a merge in progress: never touched); the upgrade passes either way. `STUDIO_UPGRADE_REFRESH=off`
     skips it (run it yourself later); `STUDIO_UPGRADE_REFRESH=no-tests` merges without the lanes' targeted tests.
     2.76.0: the refresh runs in its own background process (log `.studio/upgrades/lanes-refresh-<time>.log`) and the upgrade
     waits at most `STUDIO_UPGRADE_REFRESH_WAIT_S` (120) seconds, then says so and the refresh goes on by itself (it once ran
     past its caller's limit, exit 143, and the next train bounced every lane). Each lane's targeted tests stop at
     `STUDIO_LANES_REFRESH_TEST_S` (600; 0 = no limit): main stays merged in and the lane is left to the train's full verify.
     The train refreshes a lane whose harness is behind main itself, before its checks (main merged in, commits re-stamped, no
     tests; `harness/train-refresh.mjs`); only a real conflict hands it back. `STUDIO_TRAIN_REFRESH=off` turns that off.
     2.78.0: a lane copy's `studio/` is a link to the main checkout's (a junction on Windows), so every refresh (the train's,
     `npm run lanes -- refresh`, the upgrade's) first marks the lane's `studio/` paths left out of its index and never touches
     main's live board files; a real conflict elsewhere still stops it, files named. A builder's verify in a lane behind main on
     harness files refreshes the lane itself (as `harness`, same merge and re-stamp) and runs again (`STUDIO_LANE_REFRESHED=1`
     marks that second run so it never loops); if the refresh can't run it says to hand the task back (`npm run task -- pause`),
     not to rebase or restamp.
   - **Before snapshot (2.73.0):** just before merging, `--merge` writes `.studio/upgrades/<from>-to-<to>.json`: the studio's
     numbers over the `STUDIO_UPGRADE_SNAPSHOT_DAYS` (3) days before the update (landed per hour, false reds per train, tokens
     per landed change and by task, red verify %, workarounds per day, verify minutes, hand-backs, no-work sessions;
     `harness/upgrade-baseline.mjs`). A merge stopped on a conflict keeps the first one for `--continue`.
     `npm run autonomy -- impact` uses it as the before side (docs/AUTONOMY.md "Release impact").
5. A stash that did take board changes: `npm run upgrade -- --check` names it. Restore by merge:
   `npm run upgrade -- --restore-stash <sha> --by <you>` (board committed first) three-way merges the stash's board files into
   the board, keeping both sides' rows (conflicting task rows of `studio/NEXT.md` and `studio/DONE.md` are all kept), and
   commits. Any other conflict refuses, lists the files and writes nothing. It never drops the stash: it prints the
   `git stash drop stash@{n}` to run once the board has every row.
6. **Smoke (2.73.0):** `npm run upgrade -- --smoke [--keep] [--json]` right after the merge: a tiny verify and a tiny train on
   a throwaway made-up task in a scratch copy of the studio's harness (OS temp folder, a fresh empty board, never the real
   one), the machine scan, and one supervisor pass in dry run (no agent starts). PASS / FAIL per item with `Fix:` lines, exit 1
   on a FAIL, an `upgrade.smoke` event. `--keep` keeps the copy. On a FAIL read its Fix line, or `npm run upgrade -- --rollback
   --by <you>`.
7. `npm run verify`, then `npm run task -- drain off --by <you>`.
8. **Roll back (2.71.1):** `npm run upgrade -- --rollback --by <you> [--permission "…"]` returns the studio to the harness it
   had before the last update (`backup/pre-<version>`) in one step: it reverts that update's merge commit (`git revert -m 1`,
   never a reset), so work landed since stays. It goes through the hooks (the main-checkout guard opens for exactly that
   revert: `STUDIO_UPGRADE_REVERT=<the merge>`, checked against `REVERT_HEAD`), adds `Upgrade-Rollback-Of` and a `Golden-Reason`
   for goldens that come back as they were, refreshes the lanes, and records an `upgrade.rolled_back` event and an
   `upgrade-rollback` decision (`npm run decisions`). It refuses with an uncommitted board change (or any uncommitted tracked
   change), mid-merge or mid-revert, in a lane copy, and on a conflict with later work (the revert is undone, files named;
   resolving is the owner's call). It never deletes a branch. Who may run it is the same as `--merge`. Take the update again
   with `--merge` (or revert the rollback commit).

### The upgrade watch (2.69.0)

`npm run upgrade -- watch` checks for a newer harness now; the supervisor does the same every `STUDIO_UPGRADE_WATCH_MIN` (60;
`off`: never). It watches the `ref` in `studio/upgrade.json`, else `main` on the remote of `STUDIO_HARNESS_REF`, else
`upstream/main`; fetches it (`STUDIO_UPGRADE_FETCH_MS`, 60000) and compares its `package.json` version with the studio's. A
newer one has its CI read from the public GitHub API (no token); a remote not on GitHub, an unreachable API or CI not yet
green means it is only reported. It takes the update itself (steps 4-5, as `upgrade --merge` for the person who switched it
on) only when all hold:

- auto-upgrade is on: `npm run upgrade -- watch auto on --by <person>` commits `studio/upgrade.json` with who set it (a person
  in their own terminal, an agent outside the harness or a Producer/Director session with `--permission "<the person's
  words>"`, or the agent the owner's delegation covers for `upgrade-auto` (`npm run delegate`); never a worker). `watch auto
  off` (anyone) turns it off;
- CI on that commit is green;
- now is inside `STUDIO_UPGRADE_WINDOW` (local time, e.g. `03:00-05:00`; unset: report only);
- no merge train, no heavy work (a verify) and no agent session is running; otherwise it waits for the next check.

After the merge and lanes refresh it files one builder task per conflicted lane. Every changed answer is an `upgrade.watch`
event (the impact report reads `upgrade.merged`). `npm run upgrade -- watch status` shows the switch and the last check. The
running supervisor keeps the old harness in memory: restart it after an upgrade.

## Migrating a studio on an old harness

Take each jump the usual way (drain, snapshot and commit the board, `npm run upgrade -- --merge <ref> --by <you>`, verify),
then do what applies.

**From before 2.59.0 (live lanes).** 2.59.0 changed how lanes land (the merge train), what a hook stamp records
(`Studio-Patch-U0`), and refuses a lane's gates while its harness is behind main.

1. Drain (`npm run task -- drain on --by <you>`, `drain wait`); `npm run upgrade -- --snapshot` and commit what it names;
   `npm run upgrade -- --check` until it passes. Never stash the board.
2. Back up main and merge: `npm run upgrade -- --merge <ref> --by <you>`. A studio that patched a harness file locally (e.g. its
   own hooks-gate fix) takes upstream's version of that file.
3. `npm run verify -- --all` on main must be green before any lane lands.
4. Each live lane copy (`.lanes/<agent>`): bring main in (`git merge main` or `git rebase main`), then `npm run hooks --
   restamp` in the lane (re-commits through the real hooks, keeps `backup/<lane>-pre-restamp-<time>`, refuses with uncommitted
   changes). Until a lane has main's harness, `npm run verify` and the hooks check in it refuse (`STUDIO_LANE_HARNESS=own` runs
   the lane's own copy).
5. `npm run task -- drain off --by <you>`. Lanes land through trains: `task done <ID>` in a lane is a one-lane train; `task done
   <ID> --train` queues it and `npm run task -- train` lands every queued lane on one full verify. `STUDIO_TRAIN=off` keeps the
   old one-at-a-time path.

New settings to know: `STUDIO_HEAVY_SLOTS` (1: full verifies, Unity landings and wrapped playtests run one at a time),
`STUDIO_RAM_FLOOR_GB` (3: no new agent below it), `STUDIO_RESUME_BY` (who may run `npm run studio:resume`),
`STUDIO_KEYMAP_<ROLE>` / `STUDIO_KEYMAP_AGENT_<NAME>` (a key per role or agent), `studio/game.json` `engines.unity.land` (the
Unity landing command), a game manifest's `"visual": { "capture": ... }` (render tasks on non-Godot games). 2.65.0: a render
task's "before" is captured twice per camera (`before-noise/`) and its change must reach max(1%, `STUDIO_VISUAL_NOISE_K` (2) x
that camera's noise), capped at `STUDIO_VISUAL_NOISE_CAP` (0.05): a noisier scene is "too noisy to judge", never a pass
(`STUDIO_VISUAL_NOISE=off` skips the second capture); on Windows a full verify records each gate's shell in its machine:heavy
tree, so `heavy stop` and the next take find what a gate left running. A task's type is the owner's decision: `npm run task --
type <ID> <type> --by <name> --why "..."`. 2.59.1: with the owner's direct permission a Producer or Director session, or an
agent outside the harness, may run it (and `npm run studio:resume`) for them with `--permission "<the owner's words, or a link
to the message>"`; the record keeps the permission and who recorded it. Builders and other workers never can.

**From before 2.64.0 (2.60.1 to 2.64 in one release).**

1. **Live lanes:** `git merge main` in each lane copy and re-stamp (`npm run hooks -- restamp`; check and restamp print the
   same `base <ref> <sha>`). Goldens that arrive unchanged from main need no Golden-Reason in that merge. Lanes parked on
   purpose: `npm run task -- hold <ID> --by <you> --why "…"` (no claim clock, no rescue).
2. **Tiers:** a lane that changes harness/, hub/, scripts/, qa/*.mjs, a protected file, deletes a test/golden/regression or
   carries an upgrade merge is tier C: it waits in the train queue until a person runs `npm run task -- train release <ID> --by
   <person>`. `STUDIO_TRAIN=off` and `--force` no longer skip that.
3. **Render tasks:** set `"visualPaths"` (globs of the game's render/scene code) in studio/game.json so changed files decide
   whether a task needs a visual result (owner's signed change: the file is protected).
4. **Unity:** set `engines.unity.folder` (and optionally `engines.unity.exits`) in studio/game.json; Unity tasks name their
   branch (`task add --branch <b>` or `node harness/unity-gate.mjs branch <ID> <b>`). Unity builds and tests take machine:heavy.
5. **NIM:** put aider in `.studio/aider-venv` or set `STUDIO_AIDER_CMD`; set `STUDIO_NIM_MODELS` (the models the key may use, in
   order).
6. **Lessons:** lessons reach planning prompts only once accepted (`npm run lessons`, then `npm run lessons -- accept <id> --by
   <name> --why "…"`; a Producer session may accept on its own review).
7. **New protected file:** studio/triggers.json (which sources may route work; `"mode": "shadow"` by default). The autonomy
   level (studio/autonomy.json) is set by a person, the Producer or an outside agent, not workers. `npm run autonomy` shows the
   scorecard; `npm run thread -- shadow-report` what threads would have routed.

## What 2.30c changed for agents

- **Short output.** `task start` prints the brief's path and a 10-line summary; its JSON carries `carryForward` (the newest
  hand-off notes, at most 3k characters) instead of the whole history (`studio/handoffs/<ID>.md` keeps it). `npm run handoff`
  prints at most 3k characters; `npm run handoff -- --full` prints all (always saved to `.studio/briefs/producer.md`).
- **Circuit breakers.** A second hand-back for the same reason parks the task with that reason (a task.breaker event).
  Refreshes and stops never count. Other tasks keep starting. `npm run task -- unblock <ID> --by <name>` (or Unblock on the
  card) clears it. `STUDIO_BREAKER=off` turns it off.
- **The Producer on events.** The supervisor and watcher start a Producer session only after a task is done, forced or
  tripped, or a card or ask appears; at most once per 15 min (`STUDIO_PRODUCER_MIN_MIN`) unless urgent, the wait doubling while
  nothing changes (up to 4 h). A person starting it from the War Room is never held back. `STUDIO_PRODUCER_WAKE=always` turns
  this off.
- **Dependency-aware handout.** The supervisor skips a task whose `--after` prerequisite is done but still on an unmerged lane
  branch, or whose folder another agent holds, tries the next, and marks it "waiting on X" in the queue.
- **DONE.md.** Finished tasks move to `studio/DONE.md`; `studio/NEXT.md` keeps only open work (an older NEXT.md's DONE section
  still counts and moves on the next write).
- **The allowlist in the kickoff.** Every kickoff lists exactly what the agent may run without asking (the list the launcher
  passes to Claude Code).
- **Gates in plain words.** `npm run verify`, the run report and the release report list failing gates first with one plain
  sentence each; "not run" is listed apart and never counted as a pass.
- **A Fix: line on every failure (2.66.0).** Each failing gate's FAIL (or WARN) line in `npm run verify` is followed by one
  `[gates] Fix: …` line, the next step for that gate (`harness/gate-fix.mjs`; a studio's own gate can carry a `"fix"` in
  studio/gates.json), ending with `npm run verify -- --only <gate>`. Safety gates never say "approve": they say to put it back
  or hand the task back. `node harness/gate-fix.mjs --check` fails when a gate or game check kind has no entry of its own; the
  selftest runs it.
- **Overnight summary.** At `--until` the supervisor writes `studio/daily/overnight-<date>.md`: tasks done, tokens per finished
  task (model named), sessions that finished nothing, forced closes, reviews, the top 5 sessions by tokens, open cards.
  `npm run overnight -- --since 8h` writes one by hand.
