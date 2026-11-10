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

```bash
npm run engine -- rules show                  # the command and where it comes from
npm run engine -- rules --ref unity/my-branch # run it on one branch or commit (a porter's own check)
```

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

The baseline from the crew's log (2026-10-31 to 2026-11-08): 67 land runs, 11 lanes landed, 3,524 machine minutes;
320 minutes per landed lane; 16.4% passed; 25.4% refused or not run (495 minutes waiting, 16 of 17 for free memory);
53% of the minutes in red runs; a passing run 101 minutes. No stage report and no rules check yet.

Below it, the **design link**: the share of done tasks that trace to a Bible pillar, a kept layer, an approved idea
or the owner's own ask (directly, or through the task they fix), the owner-asked and agent-proposed shares, and the
done work by what it serves. It measures the link, not the quality: a pillar with no landed work, or a rising
untraced share, is the Director's and the owner's signal. The same log: 57.3% of 358 done tasks traced, 7.8% asked
for by the owner, 92.2% proposed by agents.

## Untested

- Everything here on a real Unity editor and on Windows beyond the pull request's checks: the self-test uses a
  made-up engine repo and stand-in commands.
- `STUDIO_UNITY_EDITMODE_ARGS` with a real land script.
- A live studio in native mode.
