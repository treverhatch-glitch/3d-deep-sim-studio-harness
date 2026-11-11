# Engine tracks: Unity, Godot or any engine, inside the harness (2.77.0)

An engine pass (a Unity pass, a Godot port step) is a board task like any other. It is planned by the Director and
the Producer, started by the supervisor in the Line Producer's order, landed by its own engine's merge train, and
closed by the harness. This page is the pattern for every engine. [UNITY-TRACK.md](UNITY-TRACK.md) has the Unity
specifics: the editor gate, the warm Library and the RAM floor.

## Why it wasn't fed before 2.77

The crew's Unity work ran outside the harness: an agent run by hand in the Unity repo, with its own land script. The
harness had every part (the land gate, the Unity train, `machine:heavy`, the RAM floor), but four gaps kept engine
passes off the board:

1. **The done check looked in the wrong repo.** A pass titled like real work ("Pass 11: realism …") is a "change"
   task. Its done check looked for commits and a full verify in the studio repo, and an engine pass has neither
   there, so `task done --train` refused it: "no changes found". The 2.63 train test got past this only because its
   tasks were titled "Plan …" (type none).
2. **The track was lost.** A task's track lived only in its `task.added` event, and the harness reads only the last
   20000 events. On a busy board an older engine task lost its track and was closed as a web task.
3. **Nobody started the train.** The web train has a daemon. The Unity queue waited for someone to run
   `task train --unity`.
4. **Wrong checkout.** A launched porter got a lane copy of the studio, not a checkout of the engine repo on its
   branch.

## The engine table

`harness/engine-tracks.mjs` holds one table. The defaults are below; `studio/game.json` `"engines": { "<name>": { … } }`
overrides any of them. That file is protected: only the owner changes it. A studio can name any engine; an unknown
name gets the generic defaults.

| Engine | `machine:heavy` kind | RAM per land run | Threads | Expected minutes (until runs are recorded) | Free-RAM floor |
| --- | --- | --- | --- | --- | --- |
| unity | `unity` (one at a time) | 8 GB | 4 | 30 | `STUDIO_UNITY_MIN_FREE_GB`, 12 |
| godot | `heavy` | 3 GB | 2 | 10 | `STUDIO_GODOT_MIN_FREE_GB`, 0 |
| unreal | `heavy` | 12 GB | 6 | 45 | `STUDIO_UNREAL_MIN_FREE_GB`, 16 |
| any other | `heavy` | 4 GB | 2 | 15 | `STUDIO_<NAME>_MIN_FREE_GB`, 0 |

```json
{ "engines": { "unity": {
  "land": "<your land script> {flags} {branch}", "landMany": "<your land script> {flags} {branches}",
  "target": "unity/main", "gateWorktree": "../my-game-unity-gate", "cwd": "../my-game-unity",
  "rig": { "ramGb": 8, "cpuThreads": 4, "minutes": 26 }, "minFreeGb": 12, "trainAuto": true,
  "tune": { "allow": ["quality-level", "volume", "lod-bias", "batch-flags", "ram-floor"] },
  "visual": { "refs": "assets/reference" }
} } }
```

`npm run engine -- targets [--json]` lists every engine target: its land command, queue, expected minutes, rig cost,
RAM floor, the settings its lane may tune itself, and its repo.

Each engine gets its own copy of every part, and Unity keeps its 2.63 file names:

- **Lane:** the `engine-porter` role and an engine worktree for each launched pass.
- **Gate:** `node harness/unity-gate.mjs --engine <name>`, a land run of `engines.<name>.land`.
- **Train:** `.studio/train/<name>-queue.json`, `.studio/locks/<name>-train.lock`, the integration refs
  `<name>-train/<id>`, and the `task.train.<name>.*` events.
- **Results:** `.studio/gates/<name>-last.json` and `.studio/gates/out/<name>.log`.

## A pass on the board (P5.1)

```bash
npm run task -- add "Pass 11: realism pass on the hangar" --role engine-porter --track engine:unity \
  --branch unity/pass-11 --scope "Assets/Hangar, the apron lights" --size 3 --visual-check --refs hangar-front.jpg,hangar-side.jpg
```

- **Engine record.** `--track engine:<name>` writes the task's record to `.studio/engine/tasks.json`: its engine,
  branch, scope and visual check. The record survives the event log. Tasks added before 2.77 still fall back to
  their event.
- **Launch.** The Line Producer orders engine passes as expansion work, and the supervisor starts them. An engine
  pass's session counts against the rig's session cap together with the builders.
- **Engine worktree.** When the engine's work lives in its own repo, a launched pass gets a worktree of that repo on
  its branch, at `.lanes/engine/<T-ID>`. If the branch doesn't exist yet, it is made from the target. The worktree is
  named in the agent's prompt and passed to the tool as an extra folder. Only `git worktree add` runs in the engine
  repo; its other checkouts and the land script's gate worktree are never touched. `STUDIO_ENGINE_LANES=off` turns
  this off.
  2.78.1 (B-119): a branch can't be checked out twice. When the pass's branch is already checked out in another
  worktree of the engine repo and that worktree is clean, the pass works there (its note says so). With uncommitted
  work there, or when it is the land script's own `gateWorktree`, the launch is refused with what to do (commit or
  stash there, or switch that folder to another branch) instead of starting a session that can't reach the code.
  `STUDIO_ENGINE_LANE_REQUIRED=off` lets such a session start anyway, as before.
  2.78.2 (item 7d): an engine-porter task with no engine record (added before 2.77, or without `--track`) got a plain
  lane copy of the studio. Now, when the studio names exactly one engine in `studio/game.json` `"engines"`, the launch
  records that track for it (`inferred`, an `engine.track_inferred` event) and the pass gets its engine worktree. With
  several engines the launch is refused, naming them and the command that sets the track:
  `npm run task -- track <T-ID> engine:<name> --by <you>` (a person, the orchestrator or a Producer/Director session;
  never a worker). `npm run task -- track <T-ID>` shows the record. With no engine named, nothing changes (the
  engine's work lives in the studio). `STUDIO_ENGINE_TRACK_INFER=off`: no inference (a plain lane, the 2.78.1 way).
  2.78.2 (item 18): a track written without `engine:` (`"unity"`: `task add --track unity`, a record set by hand, an old
  `task.added` event) silently made the task no engine pass, so `task done --train` didn't queue it. Now a bare name
  the studio configures (`studio/game.json` `"engines"`, or an `engine/<game>/engine.json` track) reads as
  `engine:<name>` (`harness/engine-tracks.mjs readTrack`): `task add` and `task track` say so; a record or event is
  fixed once with an `engine.track_normalized` event. `task track` refuses an engine the studio doesn't configure and
  anything that is no track. Other tracks (`asset`, `web`) are untouched. `STUDIO_ENGINE_TRACK_NORMALIZE=off`: a bare
  name is no track (2.78.1).
  Backfill on upgrade: `npm run upgrade -- --merge …` (its post-merge step) gives every open engine-porter task with no
  track the studio's only engine (the record says `inferred: upgrade backfill`, an `engine.track_backfilled` event) and
  prints each one; with several engines configured it lists them for a person with the `task track` command, and an
  engine-porter whose track names no engine is listed too. By hand: `node harness/engine-tracks.mjs backfill
  [--dry-run] --by <you>`.
- **Done check.** A pass in its own repo is judged in that repo:
  - its branch has commits the target lacks, and everything on it is committed;
  - the visual check passes, when the task asks for one;
  - the engine's land run stands for the studio's verify. The studio's game checks don't judge it.
  `task done <ID> --train [--branch <b>]` queues the pass for its engine train. Plain `task done` runs the land gate
  at once.

## The train as the landing path (P5.2, P9.7)

`task done --train` queues the branch. Each Line Producer pass (`enginePass`, inside the supervisor's loop) looks at
every engine queue and starts `task train --engine <name>` detached in a quiet window. Its output goes to
`.studio/line/<name>-train.log`, and the start is logged in `.studio/line/actions.jsonl`. From there the train does
what it did before: a merge-tree check against the target, ONE land run (the studio's land script), bisection when
the run is red, then it closes the tasks.

2.78.2 (item 18): `task done --train` on an engine pass it can't queue says why and exits 1 (a
`task.train.not_queued` event), never going on as a studio lane in silence. The reasons
(`harness/engine-tracks.mjs engineTrainVerdict`) are: an engine-porter task whose track names no engine (or with
several engines and no track), with the `task track` fix; `STUDIO_DONE_UNITY_GATE=skip` (the engine gate and train
off); an engine whose work is in its own repo but has no land command. An engine with no land command whose work is
in the studio, or an engine-porter in a studio with no engine, trains as a studio lane, and done says so.

Engine trains run beside the web train and beside each other. They compete only for `machine:heavy` and RAM.
`npm run task -- train --engine <name>` still starts one by hand, and `npm run line -- status --json` shows the
`engines` rows: queued, running, expected minutes, and why each one waits.

## The engine slot, and the quiet window (P5.3, 2.79)

The owner's order is train > builder verifies > Unity/art > soaks. **2.79:** an engine train starts when the engine's
own slot is free (`STUDIO_ENGINE_SLOTS`, default 1; see "The engine line" below): game trains and verifies never take
that slot and the engine land never takes a game slot, so an engine train neither waits behind a game train nor needs
`train auto off` to get the machine, and game trains don't wait behind it. Free RAM is the land's own heavy wait (it
queues for its RAM and never starves a game job). The Line Producer's `engines` rows say "the <engine> slot is free" or
which engine land holds it.

The older quiet window (2.77.0) is kept for an engine that wants a quiet machine: `"window": "quiet"` in its engine
config, or `STUDIO_ENGINE_WINDOW=quiet`, and whenever the engine line is off (`STUDIO_ENGINE_SLOTS=0` or `off`). Then
the train starts only when all of these hold:

- no web train is running (its lock is held);
- no other job of the same heavy kind is running (for Unity, another Unity job);
- free RAM is at or over the engine's floor;
- CPU is under `STUDIO_ENGINE_QUIET_CPU_PCT` (default 75);
- no web lane is waiting for the train. There is one exception: once the engine queue has waited
  `STUDIO_ENGINE_TRAIN_MAX_WAIT_MIN` (default 120) minutes, it goes anyway, so it is never starved.

The Line Producer doesn't start the same engine's train again within `STUDIO_ENGINE_TRAIN_COOLDOWN_MIN` (3) minutes.
`STUDIO_ENGINE_TRAIN_AUTO=off`, or `"trainAuto": false` for one engine, leaves starting it to a person.

The land run itself still takes `machine:heavy` as that engine's job kind, with its RAM and its free-RAM floor.

**The engine line (2.78.1, B-117).** A Unity land (8 GB, 2 GB VRAM) used to take one of the game's `STUDIO_HEAVY_SLOTS`
and go as a landing: with few slots a game train's flake re-run waited 20+ minutes behind it. Now an engine land
(`harness/unity-gate.mjs`, any engine) takes the engine line instead: at most `STUDIO_ENGINE_SLOTS` (default 1; read
live like the heavy slots) engine lands at once, never a game slot, so builders and the game's train keep every game
slot. Its RAM, VRAM and threads still count in the budget every job is admitted against. It gives way to the game's
train (the owner's order, train > builder verifies > engine): it doesn't start while a game train's verify holds a
slot, while a game landing waits in the queue, while the train-wait marker (M6) is up, or while a quiet hold is (a flake
check's quiet re-run, the chain-breaker push). A land that waits too long is refused (never red) and the engine train
tries again as before. The line needs a fresh machine scan (`npm run machine`; older than `STUDIO_MACHINE_MAX_AGE_MIN`
counts as none): with none, the slot count is the only guard on the machine, so the land keeps sharing the game's slots
(it still gives way to the train). The scan must also show room for both at full size: the engine land's claim plus one
game job (the `heavy` kind's claim, `studio/machine-budget.json` `jobs.heavy`) within the usable RAM (total minus
`STUDIO_RESERVE_RAM_GB`) and the logical cores with no overcommit; a smaller machine (a 4-core runner: 4 + 2 threads on
4 cores) keeps sharing the game's slots, and the land says why. On Windows every heavy wait takes a scan of its own
(for the commit headroom), so a scan alone is not enough. `STUDIO_ENGINE_LINE_ROOM=off` opens the line on any fresh
scan. `STUDIO_ENGINE_SLOTS=0` or `off`: the 2.78.0 behaviour (a game slot, a landing).

**Room for an engine land (2.79.1).** No RAM is reserved for a land that isn't queued. While a land is queued, or near (an
engine-porter task's porter ran `task done --check` in the last `STUDIO_ENGINE_NEAR_MIN` (30) minutes), and doesn't hold its
slot yet, the Line Producer holds new heavy starts back (a quiet hold tagged `engine-land`; builders keep coding, running
verifies finish, the land ignores the hold) until the land holds its slot, then releases it at once. If the running
verifies are expected to finish soon (elapsed against `STUDIO_ENGINE_VERIFY_TYPICAL_MIN`, 10; within `STUDIO_ENGINE_WAIT_SOON_MIN`,
5) it waits for that gap; if not and free RAM is still short, the builder cap steps down one at a time every
`STUDIO_ENGINE_SCALE_STEP_MIN` (3) minutes (none is stopped). Bounded by `STUDIO_ENGINE_HOLD_MAX_MIN` (30): then released,
the land stays queued and `line.engine_hold_expired` says why. The land's own RAM wait is `STUDIO_ENGINE_LAND_WAIT_MIN` (20),
or the hold's time plus 5 min while the Line is making room. The RAM a land needs is the engine table's floor until
`STUDIO_ENGINE_RAM_RUNS` (3) green runs have recorded their peak (`.studio/engine-ram.json`, from the machine monitor's
samples); then the highest of the last 5 green peaks plus `STUDIO_ENGINE_RAM_MARGIN_GB` (1.5), never under
`STUDIO_ENGINE_RAM_MIN_GB` (4). The owner's `STUDIO_UNITY_MIN_FREE_GB` and the lane's tuned `ram-floor` still win.

**Engine first by default (2.81).** A studio with exactly one engine in `studio/game.json` gives that engine the push
below without anyone switching it on: engine work is the longest and costliest queue (in the crew's first week 16% of 67
land runs passed and a queued port waited up to 9.4 h for its train). `npm run mode -- engine-push off --by <who>` turns
it off and it stays off; an explicit push (another engine, or with an end time) wins; a timed push that ended falls back
to this default. A studio with no engine or several has no default.

**Engine push (2.79.1).** `npm run mode -- engine-push [--engine <name>] [--until <HH:MM UTC>|off] --by <who>` (and `engine-push off`)
puts one engine first: its ready porters head the plan and may use every builder slot, the game's tasks get what is left;
the engine hold starts as soon as a land is queued and has no time limit; the engine line gets 2 slots
(`STUDIO_ENGINE_PUSH_MIN_TOTAL_GB`, 24: the RAM both need) instead of `STUDIO_ENGINE_SLOTS`'s 1. Nothing is cancelled. A board
decision: the owner, the orchestrator, a Producer or Director session; never a worker. On, off and expiry post one Studio Status
line and a `mode.engine_push` event; `studio:status` and the Line's status show it. State: `studio/mode.json` `enginePush`.

**Room for builders.** A running engine train (its lock live) keeps its land run's RAM (the engine table's `rig.ramGb`,
written to the lock) off the room for builder sessions between its land runs too (the supervisor's session cap and the
Line Producer's rig; `heavy-budget.mjs` `engineTrainReserve`). While a land holds its slot its claim counts instead,
never both. `STUDIO_ENGINE_TRAIN_RESERVE=off` turns it off.

**Twins (2.78.1).** `"engines": { "unity": { "twins": ["web/my-game/sim/**"] } }` lists the game paths whose change
needs a twin in the engine slice (a fuel ladder's "Unity models" step). When a game task touching one lands, the Line
Producer adds the twin task (docs/LINE-PRODUCER.md). None are listed by default.

- **Recorded durations.** Every land run that runs to the end (pass, red or conflict) records its length in
  `.studio/engine/durations.json`. The median of the last 12 runs becomes the expected minutes; until there are any,
  the table's number is used.
- **Infrastructure aborts.** An abort such as out of memory, a licence failure or the editor being killed is still
  NOT RUN, never FAIL (2.73.2). The train tries again, nobody is handed back, and the branch stays queued.

## Self-tuning (P5.4)

```bash
npm run engine -- tune unity                                   # the values, and what may be tuned
npm run engine -- tune unity lod-bias 1.5 --by porter-a --why "less pop-in on the apron"
npm run engine -- tune unity batch-flags "-nographics -stripEngineCode" --by porter-a --why "faster land runs"
npm run engine -- tune unity ram-floor 10 --by porter-a --why "the slice needs less"
npm run engine -- tune unity volume --unset --by porter-a --why "back to the default"
```

An engine lane changes these settings itself, with no owner gate:

- `quality-level`
- `volume`
- `lod-bias` (0.1 to 8)
- `batch-flags` (up to 12 plain `-flag` or `-flag=value` words)
- `ram-floor` (0 to 64 GB)

The owner can narrow the list with `engines.<x>.tune.allow`. The values live in `studio/engine/<engine>-tune.json`,
which is not a protected file. Each change is logged three ways: the decisions log (`.studio/decisions.jsonl`, action
`engine-tune`, with the command that undoes it; `npm run decisions -- --action engine-tune`), an `engine.tuned`
event, and a line in `studio/engine/LOG.md`.

Any other key is refused. The land command, the target, the exit contract and the rig cost stay in
`studio/game.json`, with the owner.

Where each setting takes effect:

- `ram-floor` is the free RAM the engine's land runs wait for. The owner's environment setting (for example
  `STUDIO_UNITY_MIN_FREE_GB`) wins over it.
- `batch-flags` reach the land command as `{flags}`, and as `STUDIO_ENGINE_FLAGS`.
- Every value reaches the land command as `STUDIO_ENGINE_TUNE` (JSON) and `STUDIO_ENGINE_TUNE_FILE`.
  `STUDIO_ENGINE` names the engine.
- The project's own land or build script applies quality level, volume and LOD bias. The harness never edits a
  project's settings files.

## The visual check (P5.5)

A pass added with `--visual-check` or `--refs` closes only when a person or a reviewing agent has judged it. Nothing in
the harness scores a picture. `task done` and `node harness/done-check.mjs <ID>` list what is missing.

The check needs four things on record:

1. **Fixed-camera before and after shots.** Use the same camera names in both, one PNG per camera, in
   `.studio/proof/<T>/visual/`. The visual proof's pixel check applies: no blank frame, and no near-identical pair.
   ```bash
   npm run visual -- capture <T> before|after                     # the game's own capture command, or --godot
   npm run visual -- shots <T> --before b/apron.png --after a/apron.png --by <you>   # an engine's own screenshots
   ```
2. **Each real-thing asset beside a reference photo the studio provides.** The photo is a local file: the task's
   `--refs`, or the assets reference folder (`engines.<x>.visual.refs`, default `assets/reference/`). A link is
   refused, because the harness never downloads photos. Every `--refs` photo must be used by an asset.
   ```bash
   npm run visual -- asset <T> --name "hangar" --shot shots/hangar.png --ref hangar-front.jpg --by <you>
   ```
3. **The builder looked at its own shots**, after the last shot changed, and said what it saw:
   ```bash
   npm run visual -- looked <T> --by <you> --note "trusses look heavy against the photo; doors fine"
   ```
4. **A review by someone who is not the builder**, on the current shots. "The builder" means any agent that started
   the task, recorded its shots or assets, or said it looked. The reviewer gives "looks real" or "looks toyish",
   with notes, and only "real" passes:
   ```bash
   npm run visual -- review <T> --by <reviewer> --score real|toyish --notes "proportions match the photo"
   ```

`.studio/visual-checks/<T>/side-by-side.html` shows the before and after pairs, and each asset beside its photo.
Every review, and `npm run visual -- send <T>`, queues one path line for the owner through the Communicator: it goes
to `.studio/comm/notices.jsonl`, is posted in the Communicator's next pass, and tags nobody. `npm run visual -- status
<T>` shows where the check stands.

## The rules check, the stage report and native mode (2.82)

Before the long land run the train runs the engine's cheap rules check on the batch as it would land, and hands back
the lane that turns it red (cause `rules`) without a land run. A land command can report what each of its stages took
(`STUDIO_LAND_RESULT`), which the scorecard's engine block shows. A studio whose game is the engine build is native:
builder tasks go on the engine track and the web presentation and porting steps are off. All three are in
[NATIVE-ENGINE.md](NATIVE-ENGINE.md).

## Not done yet (follow-ups)

- A custom launch command (`STUDIO_<ROLE>_CMD`) doesn't get the engine worktree in `{addDirs}` yet; the built-in
  tools do.
- `npm run comm -- preview` doesn't list queued notices yet (the pass posts them).
- Plain `task done` (no `--train`) still runs the land gate in the foreground, outside the quiet-window schedule.
- Nothing has been run against a real Unity or Godot editor: the selftest uses a made-up engine repo and a stand-in
  editor command.

## Engine config keys added in 2.79

All live in `studio/game.json` `engines.<x>`, beside `land`. Each is optional; absent means nothing happens.

| Key | What it does |
| --- | --- |
| `"preLand": "<command>"` | Run once per lane before the long land run, in a throwaway checkout of the engine repo at the lane's commit (never the land script's own worktree), with `STUDIO_LANE_COMMIT`, `STUDIO_LANE_DIR` and `STUDIO_ENGINE_REPO` set (`preLandTimeoutMin`, default 10). A non-zero exit refuses that lane BEFORE the land run: it is handed back with the command's last 8 output lines, with `cause: precheck` on the event and the hand-back (not a red land run). A command that can't run defers the lane (nobody blamed). Example, generic: `"preLand": "<your pin check>"`, a script in the engine repo that compares the lane's pinned bundle id (read from the lane's own pin file in `STUDIO_LANE_DIR`) with the one the land would use, and exits 1 printing both ids when they differ. |
| `"quickCheck": "<command>"` | The porter's own check, e.g. a compile of the sim and test assemblies without the editor. `npm run engine -- check [--engine unity] [--task <ID>]` runs it in the porter's lane copy (`.lanes/engine/<ID>`), one at a time per engine on the machine (the quick check command sees `STUDIO_ENGINE_LANE_DIR` (the lane copy it runs in) and `STUDIO_ENGINE`; lock `engine-check:<engine>`, a holder that is gone or older than `STUDIO_ENGINE_CHECK_STALE_MIN` (120) is taken over; a waiting check prints a status line; `STUDIO_ENGINE_CHECK_WAIT_MIN`, default 20). `task done` of an engine-porter task runs it and refuses on red. `quickCheckTimeoutMin` (30). With no `quickCheck` but the owner's own `"rules"` command (2.82), `task done` runs no check, and `npm run engine -- check` by hand is the rules check itself on the lane's committed work as it would land on the target: in a throwaway checkout with the rules' `inputs` copied in (never in the lane's folder), and only after the same check passed on the target; whenever it can't judge the lane it is skipped and the train's check of the batch decides. For a check at `task done`, set `quickCheck` to a compile. |
| `"shots": "<folder>"` | Folder of PNGs the engine's play-mode tests write (relative to the land command's folder, or absolute). After a green land: the new shots go to `studio/proof/<task>/engine-after/`, the previous green land's (kept in `.studio/engine-shots/<engine>/last/`) to `engine-before/`, a side-by-side page `qa/reports/engine-compare/<task>.html` (before \| after per file name) is written, `last/` is updated, and one Studio Status line with the page path is queued through the Communicator. No shots, nothing happens. |
| `"window": "quiet"` | Keep the quiet-window start (see above) for this engine instead of the engine slot. |

**Bisect on the batch's failure signature (2.79).** When a batch's land run is red, its failing test names are read from
the run's output (NUnit result tags, `Failed : X`, `Failed X [12 ms]`, `[  FAILED  ] X`). The bisect then narrows
through the subsets whose failures are the same names or a subset of them, and stops after `STUDIO_ENGINE_BISECT_MAX`
runs (default 3), handing back the lanes still in the red range instead of re-running every remaining subset. If no
names can be read, the bisect is the full search it was.

**Cleaning up after landings (2.83).** `npm run lanes -- prune` also removes engine lane folders (`.lanes/engine/<task>`) whose commit is already on the engine's target branch and that hold nothing unsaved (no changed tracked files, no untracked files that are not git-ignored), one line per lane, with `--dry-run` respected; it uses plain `git worktree remove` (never forced), so git itself keeps a folder it will not release, and a lane sitting on the target's own tip is kept until the target moves on. `engines.<x>.builds` (owner's file) is `{ "dir": "<absolute folder>", "keep": 3, "pattern": "gate-*" }`: `node harness/engine-clean.mjs builds [--engine x] [--dry-run]` keeps the newest `keep` build folders matching `pattern` (newest by name, direct children only, never links), removes the rest, and writes `LATEST.txt` with the newest one's path; it refuses a relative folder, a filesystem root, the home folder, the studio or its parents, and a pattern with fewer than 3 literal characters before the first `*`. `STUDIO_ENGINE_KEEP_BUILDS` overrides `keep` (`0` or `off`: no pruning). `node harness/engine-clean.mjs lanes` runs the lane part alone.
