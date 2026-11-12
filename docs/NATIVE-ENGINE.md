# Native-engine mode (2.82)

A studio whose game is presented and shipped in one engine builds each feature once: its rules in plain code that is
tested without the editor, its scenes, input and visuals in the engine. This page says how a studio becomes native,
what switches off, and the three things 2.82 adds for engine work: the rules check before a land run, the land's
stage report, and the engine block on the scorecard. [ENGINE-TRACKS.md](ENGINE-TRACKS.md) has the engine train and
[UNITY-TRACK.md](UNITY-TRACK.md) the Unity specifics.

## Why

The crew's first 64 Unity land runs (eight days, one PC) are the evidence:

| What the records show | Number |
| --- | --- |
| Land runs that passed | 18 of 64 |
| A passing land run, median | 92 min: .NET rule tests 19, Edit Mode 53, Play Mode 20, build 1 |
| Failed runs by the first stage that failed | .NET rule tests 24, Play Mode 14, Edit Mode 7, merge 1 |
| Machine minutes of land runs per landed lane | 320 |

Two things follow. More than half of the failures were in tests that need no editor, and each was found by a land run
that held the engine's slot. And the editor's Edit Mode spent most of its time re-running the rule tests .NET had
just run. Neither needs a new engine feature to fix: run the cheap tests first, on the batch, and don't run them twice.

## Is this studio native?

```bash
npm run engine -- native            # the verdict, why, and what is off
```

A studio is native `<engine>` when one of these holds:

- `studio/game.json` says so: `"native": "unity"` (an engine named under `"engines"`). The file is the owner's.
- `studio/game.json` names a game and exactly one engine, and the studio has no web game: no `"cartridge"`, no
  `game/<name>`, `web/<name>` or `cartridges/<name>` folder, and no engine twins of web paths.

A studio with no game of its own yet (the template) is never native by inference. `"native": false` turns it off, and
so does `STUDIO_NATIVE=off`. `STUDIO_NATIVE=<engine>` (a configured engine) turns it on for one run.

A studio that is moving a web game's rules into the engine sets `"native"` itself: the web folder is still there, so
nothing is inferred.

## What native mode changes

| Where | In a native studio |
| --- | --- |
| `task add` (web code, 2.83) | A builder task with no `--track` whose title, `--scope`, `--paths` or `--lane` names a path under the web game folder (`game/<game>/`, `web/<game>/`, `cartridges/<game>/`) or a `.ts`, `.tsx`, `.js` or `.mjs` file goes on the web track, and says so (`webCodeNamed` in `harness/native.mjs`); `--track engine:<x>` overrides. |
| `task add` | A builder task with no `--track` goes on `engine:<engine>`, and says so. `--track web` keeps a web task (the web rules a studio is still moving out of). A task with a lane, paths, or a type that is studio work (docs, chore, study, research, review, idea, playtest) gets no track. |
| The Line Producer | No scheduled game-tester run on the web build (`npm run tester -- now` still runs one on demand), and no engine twins of web tasks. |
| The game's train | No playable web build and clip after a landing: the playable build is the engine's (`npm run engine:build`). |
| `npm run engine -- drift --queue` | Refused with the reason: there are no port tasks, because a feature is built once. |
| Kickoffs | The Producer, the Director, the Line Producer, builders and engine porters are told: one build per feature, rules in plain code, no web presentation work, no port tasks. |

It adds no gate and removes none. A studio's own web checks still run for the web files a task changes, so web rules
that are still being moved stay tested until they are gone.

**Moving rules out of a web game.** The web rules keep running until a system is moved, so nothing breaks mid-switch.
One system at a time: port it to plain code in the engine's rules assembly, prove it against the web original (the
web system's own tests are the checklist; recorded inputs and outputs of the original are the oracle), switch the
engine build to it, and only then stop changing the web copy. A fix to a system that isn't moved yet is a
`--track web` task. The order is the studio's: highest-traffic systems first pays back soonest.

## The rules check before the land run

`harness/engine-rules.mjs`. A land run takes the engine's slot for an hour or more; the rules tests take minutes, or
seconds once the rules are compiled code. So the engine train runs them first, on the batch exactly as it would land.

```json
{ "engines": { "unity": { "rules": { "test": "dotnet test tools/SimTests", "inputs": ["Rules~", "Saves~"], "timeoutMin": 30 } } } }
```

- `"rules"` is one command, or `{ test, inputs, timeoutMin }`. Unset, a Unity engine whose target branch has
  `tools/SimTests` gets `dotnet test tools/SimTests` (`STUDIO_DOTNET` names the program when it isn't on the PATH).
  `"rules": false` or `STUDIO_ENGINE_RULES=off`: no rules check. The setting is in the owner's file.
- It runs in a throwaway checkout of the engine repo (never a lane, never the land script's own worktree), with
  `STUDIO_RULES_COMMIT`, `STUDIO_RULES_DIR`, `STUDIO_ENGINE` and `STUDIO_ENGINE_REPO` set. `inputs` are git-ignored
  files or folders the tests read: they are copied in from the engine's folder or the land script's worktree.
- **It judges a batch only after it passed on the target itself** in the same kind of checkout. A check that is red
  on the landed target (a missing input, no SDK) judges no lane: the train says why and the land run decides, as before.
- A green batch goes to the land run with `STUDIO_RULES_GREEN=1`, as long as the land run lands exactly the checked
  lanes on the checked target. A land script may use that to skip its own copy of the same tests.
- A red batch is narrowed with the same cheap check: the first prefix that is red names its last lane. That lane is
  handed back with cause `rules`, the failing test names and the command's last lines, and the rest is checked again.
  `STUDIO_ENGINE_RULES_MAX_RUNS` (12) bounds the runs for one batch; past it the lanes left go to the land run unjudged.
- Results are kept per tree, command and inputs in `.studio/engine/<engine>-rules.json`: a tree is run once. The
  `inputs` are not in the tree, so their content is part of what a kept result is valid for; the train also looks at
  them again right before the land run and leaves `STUDIO_RULES_GREEN` out when they changed since the check.
  `STUDIO_ENGINE_RULES_TIMEOUT_MIN` overrides the time limit.
- Each batch writes one `engine.rules` event (runs, minutes, lanes kept and refused).
- **A lane's own check.** `task done` runs an engine check only when `"quickCheck"` is set: set it to a compile (for
  Unity `dotnet build tools/SimTests`), which takes seconds and stops a lane that does not compile outside the editor;
  the tests then run once, on the batch. With `"rules"` set and no `"quickCheck"`, a porter's `npm run engine -- check`
  by hand is this same rules check on the lane's committed work as it would land (throwaway checkout, inputs copied
  in, the target first), never the bare command in the lane's own folder, where the inputs are not.
  2.83: when the task's lane folder (`.lanes/engine/<task>`) is gone, the check runs on the task's recorded engine
  branch in a throwaway checkout, removed after; with no recorded branch it is skipped and names the missing lane. It
  never runs in the studio repo's own folder.

**Making it cheaper (2.83).** A crew's rules runs grew from 12 to 60+ minutes as the game added test data, and took
half as much machine time as the land runs. Five settings, all optional, in the same `"rules"` object:

```json
{ "rules": { "test": "dotnet test tools/SimTests", "inputs": ["Rules~"],
  "env": { "SIM_DATA": "Rules~/data" }, "paths": ["Assets/Sim", "Assets/Tests/EditMode", "tools/SimTests"],
  "lfs": false, "share": ["Rules~/blobs"],
  "focus": { "test": "dotnet test tools/SimTests --filter \"{filter}\"",
             "map": [ { "match": "^Assets/Sim/([A-Za-z]+)/", "filter": "Category=$1" } ],
             "smoke": "Category=Smoke", "join": "|", "fullEveryHours": 24 } } }
```

- `env`: variables (strings) for the command, over the process's own and under the harness's `STUDIO_RULES_*`.
  `rules show` prints their names only. A changed value is a new kept-result key.
- Large files: the throwaway checkout skips Git LFS smudging (`GIT_LFS_SKIP_SMUDGE=1`) unless `"lfs": true`.
- `paths`: the repo folders or files the rule tests compile or read. Only those are checked out (a sparse checkout; a
  full one, said in the log, if that fails), and a kept result's key is those paths' git ids instead of the whole
  tree: a batch that changes nothing under them gets the target's kept result without a run.
- `inputs` are merged over every folder they are copied from: each file comes from the first folder that has it and
  never overwrites one already there, and the inputs' fingerprint is of that merged view. The train may add the
  lanes' own folders after the regular ones (`extraFrom`); `share` lists folders of content-addressed input files a
  lane adds, which `shareInputs` copies (missing files only, nothing overwritten or deleted) where the next check finds them.
- `focus`: when every path a batch changes (under `paths`, when set) matches a `map` entry, the batch runs
  `focus.test` with `{filter}` replaced by the matching entries' filters (`$1`..`$9` are the regex groups; a group
  with anything but letters, digits, `.`, `_` or `-` counts as unmatched) plus `smoke`, joined by `join`. Otherwise,
  and whenever the last full pass on the target is older than `fullEveryHours`, it runs the full `test`. The target's
  calibration and the narrowing of a red batch use the batch's same command. The command gets
  `STUDIO_RULES_MODE=focus` or `full`; the `engine.rules` event and the train's result say the mode and the filter.
  `STUDIO_ENGINE_RULES_FULL=1` forces a full run. **A focus-mode green is weaker than a full one**: a change in one
  system can break another system's test, which a focused run does not run; the full run every `fullEveryHours` is
  the backstop, and a land script that reads `STUDIO_RULES_MODE` can run the full tests itself after a focused green.
- `focus.ignore` (2.84): a list of regexes; a changed path matching any of them is left out before the "does every
  path map?" test (Play Mode tests, UI files: what the rules tests cannot read), so it no longer forces the full
  command on the whole batch. When only ignored paths changed, the batch runs `smoke` alone (focus), or with no `smoke`
  the target's kept result answers (as when nothing under `paths` changed). A pattern that is not a valid regex is
  skipped with a log line; `rules show` lists the patterns. `play.focus.ignore` does the same for the Play Mode focus
  (only ignored paths: `smoke` alone, or a full play stage). **An ignore pattern that is too wide hides a real change
  from the rules check**: a rules file it matches lands without its tests being run, so match folders, not suffixes.
- `focus.split` (2.84, B-134): `true` runs one command per filter group (each mapped filter, then `smoke`) in
  sequence instead of one joined command, so one test process holds one system's data at a time. Green when all are,
  red on the first red (its output kept); the result and the `engine.rules` event carry each group's seconds.
- `maxLanes` (2.84, B-134; default 0, off): a batch with more lanes is checked in consecutive slices of that many,
  each merged on the same target. A red slice is narrowed within itself, so only its lanes can be refused; one
  `engine.rules` event per slice. The whole batch was never one tree in the check, so a sliced check never sends
  `STUDIO_RULES_GREEN`: it only refuses lanes before they cost a land run.

**Play Mode focus (2.84).** The Play Mode stage became the longest stage of a land (20 to 40 minutes). The same idea,
as a hint the land script may use: `engines.<x>.play.focus`.

```json
{ "play": { "focus": { "map": [ { "match": "^Assets/Scripts/([A-Za-z]+)/", "filter": "Game.PlayTests.$1" } ],
                       "smoke": "Game.PlayTests.Smoke", "join": ";" } } }
```

When every path the batch changes (the same list the rules focus reads: the batch as it would land, against the target)
matches a `map` entry, the land command gets `STUDIO_PLAY_MODE=focus` and `STUDIO_PLAY_FILTER` with the matching
entries' filters plus `smoke`, de-duplicated, joined by `join` (default `;`; `$1`..`$9` as in the rules focus). For
Unity it also gets `STUDIO_UNITY_PLAYMODE_ARGS`, set to `-testFilter "<filter>"` (the Unity Test Framework's command-line filter;
UNVERIFIED on a real editor from the harness's side, as the Edit Mode plan is). Otherwise (a path no entry maps, no
`play.focus`, or a full land run with `STUDIO_LAND_FULL=1`) the engine train sets `STUDIO_PLAY_MODE=full` and neither
of the other two. A filter with a character outside letters, digits, space and `_ . ; | ~ = ! ( ) * -` is refused (a
full play stage, said in the train's log), so nothing odd reaches a command line. The retry of a red play stage runs with
the same filter. The `engine.land` event and the train's result carry `playMode` and `playFilter`. **A focused Play
Mode run is a weaker check than a full one**: a change in one system can break another system's scene test, which a
focused run does not run; the daily full land run is the backstop.

**Play Mode skip (2.84).** `play.focus.skip`: a list of regexes. When every path the batch changes (after `ignore`)
matches one, the land command gets `STUDIO_PLAY_MODE=skip` and no filter: a pure port of rules code, judged by its
.NET and Edit Mode tests. **What it gives up**: a skipped batch runs no Play Mode test at all, so a rules change that
breaks a scene, a prefab or a runtime script that reads those rules lands unseen until the next full land run. Never on
a full land run (`STUDIO_LAND_FULL=1`), which is the backstop: keep it daily. `engine.land` says `playMode: 'skip'`; the
scorecard's Play stage line counts skipped runs.

**What a land script should honour.** Every variable the harness sets for the land command (all optional to use):

| Variable | What to do with it |
| --- | --- |
| `STUDIO_RULES_GREEN` | `1`: the rules check passed on exactly this batch and target; the script may skip its own copy of those tests. |
| `STUDIO_RULES_MODE` | `focus` or `full`: how that green was reached; after a `focus` green the script may still run the full rules tests. |
| `STUDIO_LAND_FULL` | `1`: the daily full run; skip nothing, ignore every shortcut. |
| `STUDIO_UNITY_EDITMODE_ARGS` | Edit Mode arguments to add after the .NET tests passed (`SKIP`: no Edit Mode run needed). Unset on a full run. |
| `STUDIO_PLAY_MODE` | `full`, `focus` or `skip`: run every Play Mode test, only the filter, or none. |
| `STUDIO_PLAY_FILTER` | With `focus`: the Play Mode test filter (`;`-joined). |
| `STUDIO_UNITY_PLAYMODE_ARGS` | For Unity: `-testFilter "<filter>"` to add to the Play Mode start, as is (focus, or a retry's failed tests). |
| `STUDIO_LAND_ONLY` | `compile`: merge the sources into the gate worktree, compile, exit 0 (compiles) or non-zero with the compiler's error lines; land nothing, and put the worktree back. |
| `STUDIO_LAND_RETRY` | `1`: this run repeats a red one; the branches are the same. |
| `STUDIO_LAND_RETRY_STAGE` | The stage that was red (`play`, `edit`, ...). |
| `STUDIO_LAND_RETRY_TESTS` | The failed tests' full names joined by `;`: re-run just those on the merged tree; land if they pass. |
| `STUDIO_LAND_RESULT` | A file to write the stage report to (`stages`/`gates`, and a `failures` list of test full names). |

```bash
npm run engine -- rules show                         # the command, where it comes from, env names, paths, focus
npm run engine -- rules --ref unity/my-branch        # run it on one branch or commit (a porter's own check)
npm run engine -- rules --ref unity/my-branch --full # the full command even when focus would apply
npm run engine -- rules --ref unity/my-branch --fresh # ignore kept results
```

## The engine train from 2.83: who lands with whom, and who is blamed

Eight changes, each from a crew's 26 hours on the train (`harness/unity-train.mjs`, `qa/selftest-283b.mjs`).

- **A branch that lands alone.** `npm run task -- done <ID> --train --alone`, or `npm run task -- alone <ID> on|off`
  at any time before it lands. The train takes the lanes queued before it as one batch, then gives the marked branch a
  land run of its own. Use it for a switch-over (the step that makes the engine's own code the live one): a red run then
  names one change.
- **One more run before blame.** When the first red stage of a land run is one that fails under load, the same batch
  is run once more before anyone is searched for. Which stages: `engines.<x>.retryStages` (a list) or
  `STUDIO_ENGINE_RETRY_STAGES=play,build`; Unity's default is `play`; `off` turns it off. A batch that passes the
  second time lands, and the run is recorded as flaky (`task.train.unity.flaky`, with the stage and the failing test).
- **Blame by evidence.** After a red run the failing test's name is read from the land's output and its class is
  looked up in what each lane changes. When exactly one lane touches it, the batch is run without that lane: green, and
  the rest lands on that one run while the lane is handed back with the evidence (cause `evidence`); red, and the
  search by land runs goes on as before. A compile error names no test: then the file the compiler names
  (`Assets/Tests/Foo.cs(12,5): error CS0117`) is the evidence, and the one lane that changes it is run without.
  `STUDIO_ENGINE_BLAME_EVIDENCE=off` turns it off.
  2.84: when the class names no single lane, the failing test's namespace (its full name less class and method) is
  the evidence: the one lane that changes a test file (`*Tests.cs`, or a path with `/Tests/`) declaring that
  namespace, or a file named after the test's class. Still exactly one lane, or the search by land runs. The
  `evidence` event and the hand-back name the tests (up to five), the suspect, the files and the red stage; a `bisect`
  event says which tests were red.
- **Test names from the results files (2.84).** A land script that writes NUnit XML and prints only a summary names no
  test in its output. `engines.<x>.results` lists the result files it leaves (relative to the gate worktree, or
  absolute; `*` within one path segment); for Unity the default is `TestResults*.xml`, `Logs/*results*.xml` and
  `artifacts/*.xml` in the gate worktree. After a red run the newest of them (20 files, 20 MB at most) that were
  written after the run started are read: every `<test-case>` with `result="Failed"` or `result="Error"`. A
  `"failures"` list in the stage report (`STUDIO_LAND_RESULT`) counts too.
- **Retry only what failed (2.84).** When the red stage is a retry stage and the failing tests are known, the retry is
  told to re-run only those: `STUDIO_LAND_RETRY=1`, `STUDIO_LAND_RETRY_STAGE`, `STUDIO_LAND_RETRY_TESTS` (names joined
  by `;`) and, for a Unity play stage, `STUDIO_UNITY_PLAYMODE_ARGS=-testFilter "<names>"` in place of any focus filter.
  A script that ignores them runs everything again, as before. A name with a character outside the Play Mode filter's
  safe set (a parameterized case's comma or quote), or more than 50 names: the whole land runs again.
  `engines.<x>.flakyTests` (full names, or prefixes ending in `*`): a red run whose ONLY failures are on that list is
  retried the same way whatever its stage. The `flaky` event carries the tests; the scorecard counts them.
- **Compile first (2.84).** `engines.<x>.compileFirst: true`: before a group's land run the train runs the same land
  command once more with `STUDIO_LAND_ONLY=compile` (and every other variable it would get), up to
  `engines.<x>.compileTimeoutMin` (10) minutes. A red compile is handled as a red land run (the compiler's file names
  the lane) and costs minutes, not a land run; a green one goes on to the land run, whose stage report then begins with
  `compile`. Events `task.train.<x>.compile` (pass/red, seconds). A script that answers with an error or a not-run code,
  or lands the branches anyway, is noted once (`compile` event, status `ignored`) and not asked again by that train.
  Not run again for a group, or a lone lane, that already compiled in this train, nor before a retry.
- **A land killed from outside (2.84, B-130).** An exit code in `engines.<x>.killedExits` (default `[1073807364,
  3221225786]`: 0x40010004, a Windows reboot, and 0xC000013A) or a SIGKILL/SIGTERM the harness did not send by a time-out
  is status `killed`. The train tries it once more after `STUDIO_ENGINE_KILLED_RETRY_SEC` (60) seconds
  (`task.train.<x>.killed_retry`); a second kill ends the train with the lanes still queued and nobody handed back. When
  `.studio/train/<x>-cancel.json` names the train (a person's cancel), nothing is retried: the lanes stay queued and a
  `task.train.<x>.cancelled` event is written. The train only reads that file.
- **No blame by elimination.** A lane that the search by land runs leaves over ("everything before it was green") is
  run by itself before it is handed back. If it passes, it lands and nobody is handed back.
- **Handed back means out.** A lane the train hands back leaves the train's record at once, so `task start` on its
  fix works while the train is still landing the rest.
- **A full land run once a day.** Every `engines.<x>.fullLandHours` hours (default 24, `STUDIO_ENGINE_FULL_LAND_HOURS`,
  `off` for never) one land run gets `STUDIO_LAND_FULL=1` and none of the shortcuts: no `STUDIO_RULES_GREEN`, no
  `STUDIO_UNITY_EDITMODE_ARGS`. A land script that skips work on those variables should run everything when it sees
  `STUDIO_LAND_FULL=1`. The time of the last full run that passed is kept in `.studio/engine/<engine>-full-land.json`;
  with no record the clock starts at the first train, so the first full run comes that many hours later.
- **The owner's own Edit Mode arguments.** `engines.unity.editModeArgs` (a string, for example
  `-testCategory "!Slow"`) is passed as `STUDIO_UNITY_EDITMODE_ARGS` in place of the harness's plan. Not on a full run.
- **The land script that runs.** When the land command names a script inside another worktree of the engine repo and
  that copy differs from the target branch's, the train says so (`task.train.unity.land_script`): a landed change to
  the script changes nothing until that copy is updated.

Around the train:

- **Two repositories, one task.** When the merge train lands a task's studio half while its engine branch still has
  commits the engine's target lacks, the task stays open (`task.half_landed`) and the branch is queued for the engine
  train. It closes when that lands.
- **Shared input files.** `engines.<x>.rules.share` (a list of folders, for example `["Rules~/packs"]`): files a lane
  adds there, named by their content, are copied into the engine folder when the lane is queued, so the rules check
  and the land run find them. Existing files are never overwritten.
- **Cleanup.** A landed lane's engine worktree (`.lanes/engine/<task>`) is removed (`STUDIO_ENGINE_LANE_CLEAN=off`
  keeps it; a worktree with uncommitted files is always kept). `engines.<x>.builds` = `{ "dir": "<absolute folder>",
  "keep": 3, "pattern": "gate-*" }` keeps the newest build folders and writes `LATEST.txt` with the newest one's
  path (`STUDIO_ENGINE_KEEP_BUILDS`; docs/ENGINE-TRACKS.md has the rules it refuses by). `npm run lanes -- prune` covers engine lanes; `node harness/engine-clean.mjs lanes|builds`
  runs either by hand.
- `node harness/unity-train.mjs queue --task <ID> [--engine x] [--branch b] [--alone]` queues a branch without closing
  a task; `npm run task -- train dequeue <ID>` takes one out.

## The land's stage report

A land command knows where its time went; the harness didn't. Now it names a file in `STUDIO_LAND_RESULT` and reads
what the command writes there:

```json
{ "gates": { "merge": { "status": "pass" }, "rules": { "status": "pass", "seconds": 510 }, "edit": { "status": "fail", "seconds": 1358 } } }
```

`"stages"` works as well as `"gates"`, and so does a list of `{ name, status, seconds }`. A script that can't write
JSON prints one line per stage instead: `[land-stage] <name> <status> <seconds>`. The stages go on the `engine.land`
event in the order given. A command that reports nothing changes nothing.

**Edit Mode after a green .NET run.** For a Unity land the harness also sets `STUDIO_UNITY_EDITMODE_ARGS`: the
arguments that make the editor run only the Edit Mode test assemblies the .NET project doesn't compile (for example
`-assemblyNames Game.Art.Tests`), or `SKIP` when .NET compiles them all. A land script adds them to its Edit Mode
start after its own .NET tests passed. `node harness/unity.mjs editmode-plan <project> [--args|--json]` prints the
same. `STUDIO_UNITY_EDITMODE_PLAN=off` leaves the variable unset. This rests on the Unity Test Framework's
`-assemblyNames` argument and is UNVERIFIED on a real editor from the harness's side: a script that uses it should
fall back to a full Edit Mode run when the filtered run finds no test, and keep one full run a day.

## The engine block on the scorecard

`npm run score` prints it under the fifteen measures, and `--record` keeps it (`engine` in the record):

| Line | What it counts |
| --- | --- |
| Land-run minutes per landed lane | every land-run minute (pass, red, refused waits) divided by the lanes that landed |
| Land runs that passed; refused or not run | shares of all land runs; the minutes spent waiting, and how many waits were for free memory |
| Minutes spent in red runs | the share of land-run minutes that ended red or in a conflict; the median length of a passing and of a red run |
| Stages | median minutes per stage, and how many red runs failed there first (from the stage report) |
| Rules check before the land run | batches checked, runs, minutes, and lanes refused before they cost a land run |
| Branches per land run (2.84) | the median number of tasks in a land run that ran (pass, red or conflict), and how many runs |
| Play stage (2.84) | land runs whose play stage was focused or full (from `playMode` on `engine.land`; older runs count as full), and the median minutes of each; skipped runs (`play.focus.skip`) when there are any |
| Flaky retries (2.84) | retries that passed (`task.train.<x>.flaky`), and the test seen most in them (`top: <test> ×k`) |

The baseline from the crew's log (2026-10-31 to 2026-11-08): 67 land runs, 11 lanes landed, 3,524 machine minutes;
320 minutes per landed lane; 16.4% passed; 25.4% refused or not run (495 minutes waiting, 16 of 17 for free memory);
53% of the minutes in red runs; a passing run 101 minutes. No stage report and no rules check yet.

Below it, the **design link**: the share of done tasks that trace to a Bible pillar, a kept layer, an approved idea
or the owner's own ask (directly, or through the task they fix), the owner-asked and agent-proposed shares, and the
done work by what it serves. It measures the link, not the quality: a pillar with no landed work, or a rising
untraced share, is the Director's and the owner's signal. The same log: 57.3% of 358 done tasks traced, 7.8% asked
for by the owner, 92.2% proposed by agents.

## The editor service (2.84, untested on a real editor)

One harness-owned engine editor that stays open, used two ways. **Untested on a real editor**: the harness side is
checked against a stand-in editor (`qa/fixtures/fake-editor.mjs`); the Unity side
(`engine/_unity/Assets/Editor/StudioService/StudioEditorService.cs`, its own Editor-only assembly) has never been
compiled. Everything is off by default, and any failure falls back to today's cold path.

- **Warm land runs** (`engines.<x>.warm: "land"`, or `true`): the engine train opens the `land` instance on the land
  tree (`gateWorktree`, else `cwd`) before its first land run and keeps it between runs. When it is healthy the land
  command gets `STUDIO_EDITOR_SERVICE` (the service folder) and `STUDIO_EDITOR_SERVICE_CLI` (a command line); the land
  script may then run `node harness/editor-service.mjs request test --engine <x> --instance land --mode EditMode --results <file>`
  instead of starting Unity (exit 3: no healthy editor, start Unity as before). Not healthy after one restart: the
  variables are not set and `engine.warm.fallback` says why. The land script still owns the land; see
  `docs/examples/land-warm.md`. An editor of the service counts as a heavy program outside the lock
  (`STUDIO_HEAVY_PROGRAMS`): add `|-studioService` to `STUDIO_HEAVY_IGNORE_ARGS` so the land run is not refused for it.
- **The agents' queue** (`engines.<x>.service.check: true`): `npm run editor -- check [--lane <agent>] [--branch b]
  [--capture <scene>[:<camera>]] [--wait]` from any session queues a compile (and a capture) of that lane's branch,
  one waiting request per lane. The supervisor's pass runs the oldest in the `check` instance's own checkout
  (`engines.<x>.service.dir`, else a git worktree `.studio/editor-service/<x>-tree`), writes
  `.studio/editor-service/out/<lane>/<head8>/result.json` and the PNGs, and emits `editor.check`. Never while that
  engine's train runs. `npm run editor -- result` prints `file(line): code message` and the image paths.

`npm run editor -- start|status|stop|request <kind>|check|result|pass`. The protocol is files in
`<project>/Temp/StudioService/` (requests, responses, a heartbeat); the editor is started with `-studioService
<folder>` and does nothing without it. Settings in `studio/game.json` `engines.<x>.service`: `check` (false), `dir`,
`heartbeatSec` (5), `requestTimeoutMin` (30), `recycleAfter` (20 requests), `recycleMin` (240), `startTimeoutMin` (15),
`graceSec` (30). A timed-out request always recycles the editor. `STUDIO_EDITOR_SERVICE=off` turns every use off.
A project another editor has open (Unity's `Temp/UnityLockfile`) is refused; `stop` kills only the pid it started.

**The first run on a PC**: `npm run editor -- start --project <a copy of the project>` and watch for the heartbeat
(`status`); `request ping`; `request compile` with a planted compile error (errors listed, paths project-relative);
`request test --mode EditMode --results <file>` (an NUnit file appears); `request capture --scene <scene> --out <png>`;
a domain reload during a compile (the answer still comes); `stop` (the editor quits, the lock file goes). Then
turn on `service.check` and run one `check` end to end, and only then `warm`.

## Untested

- Everything here on a real Unity editor and on Windows beyond the pull request's checks: the self-test uses a
  made-up engine repo and stand-in commands.
- `STUDIO_UNITY_EDITMODE_ARGS` with a real land script.
- A live studio in native mode.
- The editor service (above) on any real editor.
