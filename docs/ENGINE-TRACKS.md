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

## Quiet windows and the rig budget (P5.3)

The owner's order is train > builder verifies > Unity/art > soaks. An engine train starts only when all of these hold:

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

## Not done yet (follow-ups)

- A custom launch command (`STUDIO_<ROLE>_CMD`) doesn't get the engine worktree in `{addDirs}` yet; the built-in
  tools do.
- `npm run comm -- preview` doesn't list queued notices yet (the pass posts them).
- Plain `task done` (no `--train`) still runs the land gate in the foreground, outside the quiet-window schedule.
- Nothing has been run against a real Unity or Godot editor: the selftest uses a made-up engine repo and a stand-in
  editor command.
