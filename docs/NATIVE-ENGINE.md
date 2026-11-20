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
- **The batch runs first (2.93).** Green: the check is over and nothing runs on the target. Red: the target's answer
  tells a red the batch brings from one the target already has: a kept result for the target's tree answers, else the
  target runs now in the same kind of checkout. A check that is red on the target itself (a missing input, no SDK)
  judges no lane: the train says why and the land run decides, as before. With no `rules.focus` a green train costs one
  full run, not two.
- **The next batch is checked beside the land run (2.94, `rules.ahead`, off by default).** With `"rules": { ...,
  "ahead": true }`, while a green batch's land run runs, the lanes the next train would take (the train's own batch
  selection) are merged on this batch's checked head and run as the next train's batch run would (same mode, filters,
  `first`, time limit; never the target). It starts once the land run holds its machine:heavy slot and only while free
  RAM minus the floor holds what one rules run takes (`focus.splitGb`, else the largest measured peak, else 4 GB);
  never with a second gate in use. Unless the land run lands the batch unchanged, it is ended with its process tree and
  nothing of it is kept (also on `train cancel`, or a land run that dies out of memory, which is then retried without
  it). Landed, the next train takes that same set when its lanes are unchanged, finds the kept result (its rules log
  line says so) or waits for the run still going. A red ahead is only a red for that tree: it hands nobody back.
  Event `task.train.<x>.rules_ahead` (`started`, `kept-green`, `kept-red`, `dropped`); `train status` shows it running.
  2.95: when it does not start (memory, the land run ended first, no rules check) the event says `not-started` and why.
  With `rules.shards` it goes command by command instead of deciding once: each shard starts when its measured peak
  (`rules.peak`, else the plan's number) fits beside the land run, waits when it does not (within its time limit), and
  none starts once the land run answered. Stopped between shards it is `kept-partial`: under the same rule (kept only
  when the land run landed the batch unchanged) its finished shards are kept and the next train runs only the rest.
- A green batch goes to the land run with `STUDIO_RULES_GREEN=1`, as long as the land run lands exactly the checked
  lanes on the checked target. A land script may use that to skip its own copy of the same tests. 2.91: with
  `rules.paths` or `rules.ignore` set, a target that moved only where the rules tests do not read (a land script's own
  record commit) still counts as the checked target; one log line names the two tips. Without them any move loses it.
- A red batch is narrowed with the same cheap check: the first prefix that is red names its last lane. That lane is
  handed back with cause `rules`, the failing test names and the command's last lines, and the rest is checked again.
  `STUDIO_ENGINE_RULES_MAX_RUNS` (12) bounds the runs for one batch; past it the lanes left go to the land run unjudged.
- Results are kept per tree, command and inputs in `.studio/engine/<engine>-rules.json`: a tree is run once. A kept
  full pass also answers a focus or `first` question on the same tree (2.93). A batch head that lands with the same
  rules key is the next target, so its kept result is the next train's answer for the target. The
  `inputs` are not in the tree, so their content is part of what a kept result is valid for; the train also looks at
  them again right before the land run and leaves `STUDIO_RULES_GREEN` out when they changed since the check.
  `STUDIO_ENGINE_RULES_TIMEOUT_MIN` overrides the time limit.
- **The time limit follows the suite (2.90).** A limit the studio set (`rules.timeoutMin`, or
  `STUDIO_ENGINE_RULES_TIMEOUT_MIN`; fractions of a minute are taken as they are) is used as it is. Unset, a run's
  limit is the largest of the default (`STUDIO_ENGINE_RULES_DEFAULT_MIN`, 30), 1.5 times the longest passing run of the
  same mode on record (`full`, `focus`, `first`), and, after a run timed out (the batch or the target), twice the limit it timed
  out with; never over 120 min. The raise stays until a run of that mode passes. Every run's log line says which limit
  applied and why (`up to 37.5 min (1.5 x the longest passing full run on record (25 min))`). A tree that timed out is
  recorded with its limit, and is not run again while the limit is no larger: the log says "not run again" and the
  land run decides. Example: a suite that passed in 22 min gets 33 min; one that timed out at 30 gets 60 next time.
- **A command past its time limit is ended with everything it started (2.93).** The engine commands (compile, rules,
  pre-queue and pre-land checks, the quick check, the land command) run through `harness/run-limited.mjs`. At the limit it
  ends the whole process tree (Windows `taskkill /T /F`, elsewhere the process group), not only the shell, so a compiler or
  editor no longer keeps its folder open. The caller sees a time-out as before. The web game's own timed commands
  (`harness/train.mjs`, `game-gates.mjs` and others) are unchanged.
- **A check that judges no lane is seen (2.90).** When the check is red, not runnable or timed out on the target
  itself, the train writes `task.train.<x>.rules_no_judge` (warn, to the producer) with the one change: for a timeout,
  raise `engines.<x>.rules.timeoutMin` or make the run smaller with `rules.focus` (`map`, `auto`, `paths`); otherwise
  fix the target or name the inputs. After two trains in a row, `train status --engine <x>` and the Line Producer's
  status say how many trains and how many minutes it has cost; the count clears when the check judges again.
- **A red target gets a fix task (2.92).** When the target is red by itself (the rules check, the daily full land run or
  the owed full rules run), no branch is blamed, and the harness files one task: `Fix: <target> is red by itself on <n>
  rule test(s): <first test>`, role `engine-porter`, P1, on the engine track, with the failing names in its handoff note,
  and writes `task.train.<x>.target_red_task` (warn). It is filed once per distinct red: a list that shares half or more
  of its names with an open red is the same red. The record is `.studio/engine/<x>-target-red.json`; a green result from
  the same source clears it, a done or dropped task lets the next red file a new one. `train status` shows
  `Target red: T-xxx`. `STUDIO_ENGINE_TARGET_RED_TASK=off` files nothing.
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

- `landGate` (2.93): the name of the gate in the land run's result file (`STUDIO_LAND_RESULT`) that runs the same tests
  as `test`. When a land run lands and that gate passed (not skipped), the landed tree gets a kept full pass and the
  last full pass is written. A gate skipped because the land run was told green needs nothing: the check's own kept
  result answers.
- `env`: variables (strings) for the command, over the process's own and under the harness's `STUDIO_RULES_*`.
  `rules show` prints their names only. A changed value is a new kept-result key.
- Large files: the throwaway checkout skips Git LFS smudging (`GIT_LFS_SKIP_SMUDGE=1`) unless `"lfs": true`.
- `paths`: the repo folders or files the rule tests compile or read. Only those are checked out (a sparse checkout; a
  full one, said in the log, if that fails), and a kept result's key is those paths' git ids instead of the whole
  tree: a batch that changes nothing under them gets the target's kept result without a run.
- `ignore` (2.91): the opposite list, folders or files the rule tests never read (the folder a land script commits its
  run records to, docs). Plain repo paths only (no glob, no `..`). A change only under them is no change for the check:
  the kept result's key is the tree without them (inside `paths` too, when both are set). The checkout stays full.
- `inputs` are merged over every folder they are copied from: each file comes from the first folder that has it and
  never overwrites one already there, and the inputs' fingerprint is of that merged view. The train may add the
  lanes' own folders after the regular ones (`extraFrom`); `share` lists folders of content-addressed input files a
  lane adds, which `shareInputs` copies (missing files only, nothing overwritten or deleted) where the next check finds them.
- `focus`: when every path a batch changes (under `paths`, when set) matches a `map` entry, the batch runs
  `focus.test` with `{filter}` replaced by the matching entries' filters (`$1`..`$9` are the regex groups; a group
  with anything but letters, digits, `.`, `_` or `-` counts as unmatched) plus `smoke`, joined by `join`. Otherwise,
  and when a person asks for it (`STUDIO_ENGINE_RULES_FULL=1`, `--full`, or `fullEveryHours` 0), it runs the full `test`. The target's
  calibration and the narrowing of a red batch use the batch's same command. The command gets
  `STUDIO_RULES_MODE=focus` or `full`; the `engine.rules` event and the train's result say the mode and the filter.
  `STUDIO_ENGINE_RULES_FULL=1` forces a full run. **A focus-mode green is weaker than a full one**: a change in one
  system can break another system's test, which a focused run does not run; the full run every `fullEveryHours` is
  the backstop, and a land script that reads `STUDIO_RULES_MODE` can run the full tests itself after a focused green.
- **2.91: the full run every `fullEveryHours` is owed, never the batch's check.** With lanes waiting, the train's check
  runs as if it were not due. The owed full run is the full `test` on the target alone: when the queue is empty (the
  Line Producer starts a train with no lane for it), or, once it is older than `focus.fullEveryMaxHours` (default twice
  `fullEveryHours`), at the end of a train after the batch's rounds. The last full pass is also written by a full
  green of the target, by a full green of the batch head that lands unchanged, and by a `landGate` pass (2.93). A rules
  run started outside the train (`npm run engine -- rules`, the done-time check) never turns full because the hours are
  due (`--full` or `STUDIO_ENGINE_RULES_FULL=1` still do), and takes a machine:heavy slot as a verify does: while an
  engine land is queued the Line Producer's hold (`line.engine_hold`) keeps it waiting, and one log line says for what.
  A pass writes the last full pass. A red or a
  timeout blames no lane: `task.train.<x>.rules_full` (warn) and `train status` say it, and it is not run again until
  the target changes under what the tests read (or `fullEveryHours` pass, or a doubled timeout applies).
- `focus.ignore` (2.84): a list of regexes; a changed path matching any of them is left out before the "does every
  path map?" test (Play Mode tests, UI files: what the rules tests cannot read), so it no longer forces the full
  command on the whole batch. When only ignored paths changed, the batch runs `smoke` alone (focus), or with no `smoke`
  the target's kept result answers (as when nothing under `paths` changed). A pattern that is not a valid regex is
  skipped with a log line; `rules show` lists the patterns. `play.focus.ignore` does the same for the Play Mode focus
  (only ignored paths: `smoke` alone, or a full play stage). **An ignore pattern that is too wide hides a real change
  from the rules check**: a rules file it matches lands without its tests being run, so match folders, not suffixes.
- `first` (2.90): one test filter run before everything else, with `focus.test` (it needs `focus.test` with
  `{filter}`; without it the setting is left out and `rules show` says so). The rules check runs that filter on the
  batch first; red there and green on the target, the branch that turns it red is found with that filter alone (the
  short runs) and refused at once with the failing names, before the target's calibration or any full run. Green, or
  red on the target itself: the check goes on as before. For a test that pins generated data to a commit, which fails
  for every branch that moves the pin without regenerating:
  `"rules": { "test": "dotnet test tools/SimTests", "first": "FullyQualifiedName~PinTests", "focus": { "test":
  "dotnet test tools/SimTests --filter \"{filter}\"" } }`.
- `focus.split` (2.84, B-134): `true` runs one command per filter group (each mapped filter, then `smoke`) in
  sequence instead of one joined command, so one test process holds one system's data at a time. Green when all are,
  red on the first red (its output kept); the result and the `engine.rules` event carry each group's seconds.
- `focus.splitMax` and `focus.splitGb` (2.85): how many split parts run at once is a decision about free RAM
  (`harness/rules-parts.mjs`). A part starts only while free RAM minus the floor (`STUDIO_RAM_FLOOR_GB`, 3) holds
  `splitGb` (the GB one test process is expected to take; default 4, or the largest peak `.studio/engine-ram.json`
  has measured); at least one part always runs, the check is made again before every start, and `splitMax` is the
  most at once. `splitMax` unset means 1: in sequence, as 2.84 ran. Each decision is one log line, and the
  `engine.rules` event carries `splitAtOnce`. The result is the same either way; only the time and the memory differ.
- What the rules check cost and why (2.85): the `engine.rules` event's `meta` has `mode` (`focus` or `full`), `why`
  (a full run because of unmapped paths names up to 5 of them, so you can extend `focus.map`), `parts`, `ms` and
  `splitAtOnce`; `train status` prints the last check's mode, why, runs, seconds and parts. A green full check on
  exactly the tree the land run will land makes the land run get `STUDIO_RULES_GREEN=1` and `STUDIO_RULES_MODE=full`;
  the kept result (`.studio/engine/<x>-rules.json`) survives a cancel and restart, so the same batch on the same
  target tip is not checked again ("rules pass cached" in the log). A red part is handed back by name: the part's
  filter and command and the failing test names.
- `focus.map` groups (2.86): only the regex groups a filter uses (`$1`..`$9`) must be letters, digits, `.`, `_` and
  `-`. Before 2.86 any group counted, so an entry like `"^(Sim/Fees/|tools/fees/)"` (a group used only to list
  prefixes) matched nothing and every batch ran in full.
- `focus.auto` (2.86): the map by convention. Describe the layout once and the harness derives one entry per rule
  system from the tree being checked (the target and the batch), so a system a batch adds is covered with no map edit:

```json
"focus": { "test": "dotnet test tools/SimTests --filter \"{filter}\"", "smoke": "Category=Smoke", "split": true,
  "auto": { "root": "Game/Sim", "paths": ["Game/Sim/{name}/", "Game/Sim/{name}.meta", "Game/Tests/Sim/{name}", "tools/port/{name}/"],
            "filter": "FullyQualifiedName~{name}", "filters": { "Path": "FullyQualifiedName~GridPath" }, "inputs": ["Rules~/{name}/"] },
  "shared": ["Game/Sim/Core", "tools/SimTests"] }
```

  `root`: a folder whose child folders are the systems (a name may hold letters, digits, `.`, `_`, `-`). `paths`:
  templates with `{name}`; a changed path belongs to a system when it starts with one, letter case aside (so
  `tools/port/fees/` is `Fees`'s), and the longest match wins (`MapNavTests.cs` is `MapNav`'s, not `Map`'s). `filter`:
  the test filter with `{name}`; `filters` names the systems whose tests are called otherwise. `inputs` (optional):
  templates under `rules.inputs`, so a part's kept result holds only its own input files and the ones no system owns.
  A path a hand-written `map` entry takes stays the entry's (the map wins). A path neither takes still means a full run,
  and the why names it. A bad `auto` is named in plain words (in the log, `rules show`, `rules-plan` and the why) and
  left out.
- `focus.shared` (2.86): paths every part reads. A batch that changes one runs in full; a folder under `auto.root`
  listed here is not a system.
- Results kept per part (2.86, with `auto` or `shared` set): a focused check is a list of parts (one per filter, and
  the smoke filter). A part's green is kept under what it reads: the blob ids of its own files, the tree ids of
  `shared`, the command, and its own inputs (all inputs when they cannot be attributed). The smoke part reads
  everything and is keyed by the whole tree (or `rules.paths`). A part with a kept green is not run again: not on the
  target, not on the batch, not while a red batch is narrowed ("rules part ... pass kept" in the log; the
  `engine.rules` event's `reused`). A part whose files the target does not have (a system the batch adds) is not run on
  the target. A red batch is narrowed with the red part's filter only. Only greens are kept; the full run every
  `fullEveryHours` stays the backstop. Without `auto` and `shared` the keys and runs are 2.85's.
- When `rules.paths` is not set and a batch changes only paths under no map entry and no auto root (art, UI), the run
  is still full (the safe answer), and its why says that `rules.paths` is the setting that would have skipped it.
- `npm run engine -- rules-plan --branch <b> [--branch <c>] [--json]` (2.86) prints, without running a test: full or
  focus and why, the parts, which have a kept green on the target and the batch, which are new in the batch, a part's
  last recorded peak when it is over `splitGb`, and the minutes the recorded runs suggest.
- `focus.auto` from files and as a list (2.95): besides `root` (child folders are the systems), `from` is a path
  template whose last part holds `{name}`; the files (or folders) that fit it name the systems. `{name}` from a file
  holds no dot, so with `"from": "Game/Core/Unit.{name}.cs"` the file `Unit.Fees.Extra.cs` names nothing of its own and
  belongs to `Fees` through `paths` (`Game/Core/Unit.{name}.`). `auto` may also be a list of such descriptions, so
  system folders and system files work at once; a bad entry is named and left out, the others stay. The object form
  is read as before.
- `shards` (2.95): a full rules check run as parts, one test command per shard (`focus.test` with `{filter}`), instead
  of one `test` command that holds every system at once. The shards are the smoke filter, one per filter that
  `focus.map` and `focus.auto` give the tree's files (one per system), the filters listed in `shards.filters`, and
  `shards.rest`, the filter for the tests no other shard runs. `"shards": true` takes only the derived ones; a plain
  list (`"shards": ["<f1>", "<f2>"]`) is `{ "filters": [...] }`. They run one at a time (the peak is one shard's);
  `focus.splitMax` allows more, each start decided on free RAM as for split parts. Every full run is sharded: the
  batch's, the target's when a red batch asks it, the owed full run, `npm run engine -- rules --full`.
  - A shard's green is kept, so it is not run again: after a red in another shard, on a retry, after a cancel, in a
    narrowing step (a red batch is narrowed with its red shard alone) and for the check ahead. A red shard hands back
    by name, with its filter, command and failing tests. `keep` says for what a green is kept. `"tree"` (the default)
    is the exact tree, command and inputs: always sound. `"reads"` keeps it under what the shard reads (2.86's part
    key: its own files, `shared`, the command, its inputs) plus the files no shard owns, so a batch that touches only
    other shards' files keeps it. That trusts the studio's `paths`, `shared` and filters; the backstop is
    `freshEveryHours` (default 24): once that long has passed since a sharded run that reused nothing from another
    tree, the next one reuses nothing from another tree. The log, the result and the `engine.rules` event's
    `meta.shards` (`n`, `kept`, `keptOther`, `ran`, `complete`) say how many were kept and how many came from another tree.
  - **A sharded run is a full run only with `rest`.** Without it a test that no filter matches never ran: the run's mode
    is `shards`, the land run is told `STUDIO_RULES_MODE=focus` (never `full`), no last full pass is written, and the
    owed full run passes as shards but stays owed (`rules_full` says so, `meta.notFull`). `rules show` says it in plain
    words. With `rest` the run is `full`: green, it is kept as the tree's full pass, as one `test` run would be. The
    harness cannot check that `rest` really is the rest: write it as the negation of the other filters.
  - Each shard command gets `STUDIO_RULES_MODE=shard`. `rules show` and `rules-plan` list the shards, which have a kept
    green (on this tree or from another tree) and each one's measured peak.
- `peak` (2.95): the file the test command writes its own peak memory to, a path or glob relative to the test checkout
  (`"peak": "tools/SimTests/bin/**/peak.txt"`), or `{ "file": "...", "match": "<regex>" }` whose first group is the GB
  (default: the first number followed by `GB`, as in `working set 6.71 GB`). The file is removed before every test
  command (so a stale one is never read) and read after it; the number is kept per shard, part or filter (`(full run)`
  for the whole command) beside each part's seconds in `.studio/engine/<x>-rules.json` (`partStats`). With `splitGb`
  unset, a measured number replaces the guess: a part or shard starts when its own peak fits in free RAM, `splitPlan`
  and the check ahead use the full run's peak, and `rules-plan` and `rules show` print it. With no file configured or
  none readable, memory is guessed as before. Parts that ran at the same time share the file, so none of them is read.

```json
"rules": { "test": "dotnet test tools/SimTests", "peak": "tools/SimTests/bin/**/peak.txt", "ahead": true,
  "shards": { "filters": ["FullyQualifiedName~Tests.Pins"], "rest": "FullyQualifiedName!~Tests.Sim&FullyQualifiedName!~Tests.Core&FullyQualifiedName!~Tests.Pins", "keep": "tree" },
  "focus": { "test": "dotnet test tools/SimTests --filter \"{filter}\"", "smoke": "Category=Smoke",
    "auto": [ { "root": "Game/Sim", "paths": ["Game/Sim/{name}/"], "filter": "FullyQualifiedName~Tests.Sim.{name}" },
              { "from": "Game/Core/Unit.{name}.cs", "paths": ["Game/Core/Unit.{name}.", "tools/port/core-{name}/"], "filter": "FullyQualifiedName~Tests.Core.{name}" } ] } }
```
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

**A Play Mode map per panel (2.85).** A UI batch runs the whole Play Mode stage unless every path it changes is
mapped (or ignored). Map each panel's folder and its own shot test to that panel's tests, and keep a short smoke
filter that every focused run adds (made-up names):

```json
{ "play": { "focus": {
  "map": [
    { "match": "^Assets/UI/Panels/([A-Za-z]+)/",                 "filter": "Game.PlayTests.Panels.$1" },
    { "match": "^Assets/Tests/PlayMode/Panels/([A-Za-z]+)Shot",  "filter": "Game.PlayTests.Panels.$1" },
    { "match": "^Assets/UI/Theme/",                              "filter": "Game.PlayTests.Panels" }
  ],
  "smoke": "Game.PlayTests.Smoke",
  "ignore": [ "\\.md$", "^docs/" ],
  "skip": [ "^Assets/Sim/" ] } } }
```

A branch that changes `Assets/UI/Panels/Shop/ShopPanel.cs` and its `ShopShotTests.cs` runs
`Game.PlayTests.Panels.Shop;Game.PlayTests.Smoke`; two panels run both filters plus the smoke. A path no entry takes
(`Assets/UI/Hud.cs`) makes the stage full, which is safe, and the train's log line (`play stage in full: ...`) and its
`done` event (`playUnmatched`) name up to five such paths, so the map can be extended. A path that matches `skip` in a
batch with other paths still makes it full (2.84's rule); a path in `ignore` joins a focused batch. To check a map
without a train (read-only; nothing is queued or run):

```bash
npm run engine -- play-plan --branch feat/shop-panel        # the branch's changes since it left the target
npm run engine -- play-plan --paths Assets/UI/Hud.cs,README.md [--json]
```

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
| `STUDIO_RULES_MODE` | `focus` or `full`: how that green was reached; after a `focus` green the script may still run the full rules tests. 2.95: shards without `rules.shards.rest` are `focus`. |
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
| `STUDIO_LAND_PROBE` | `1` (2.86): land nothing. Merge the branch(es) given (for the target alone: a ref at the target's own tip), run the tests (with `STUDIO_LAND_RETRY_TESTS`: only those; with `STUDIO_LAND_FULL=1`: all), put the worktree back; exit 0 green, 1 red. Print `[land-probe] honoured` so the train may run its by-name steps on lanes. |
| `STUDIO_LAND_KNOWN_RED` | (2.86, only with `engines.<x>.knownRedHours`) listed flaky tests a probe found red on the target alone, joined by `;`: a script may leave them out of its verdict and land when nothing else is red. |

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
- **The engine's own logs (2.92).** `engines.<x>.logs` lists the engine's log files the land run leaves (the editor's
  log, say), found the same way as `results` (no default). After a red run, those written after the run started are
  read (their last 4 MB in all) with the run's own output, for compiler error lines (`Path/File.cs(12,5): error
  CS0234: ...`, either slash). When each file they name is added or changed by exactly one branch of the batch, and
  not every branch is named, those branches are handed back at once (cause `compile`, with the compiler's lines) and the
  rest run again as the next round, with no halving search. A file no branch changed (a branch deleted what another
  file uses), a file two branches change (they may only clash together), or every branch named: the search as before.
  Example: `"logs": ["Logs/Editor.log"]`.
- **Retry only what failed (2.84).** When the red stage is a retry stage and the failing tests are known, the retry is
  told to re-run only those: `STUDIO_LAND_RETRY=1`, `STUDIO_LAND_RETRY_STAGE`, `STUDIO_LAND_RETRY_TESTS` (names joined
  by `;`) and, for a Unity play stage, `STUDIO_UNITY_PLAYMODE_ARGS=-testFilter "<names>"` in place of any focus filter.
  A script that ignores them runs everything again, as before. A name with a character outside the Play Mode filter's
  safe set (a parameterized case's comma or quote), or more than 50 names: the whole land runs again.
  `engines.<x>.flakyTests` (full names, or prefixes ending in `*`): a red run whose ONLY failures are on that list is
  retried the same way whatever its stage. The `flaky` event carries the tests; the scorecard counts them.
- **Compile first (2.84).** `engines.<x>.compileFirst: true`: before a group's land run the train runs the same land
  command once more with `STUDIO_LAND_ONLY=compile` (2.85: and only what a compile needs: never `STUDIO_LAND_FULL`,
  `STUDIO_RULES_GREEN`/`STUDIO_RULES_MODE`, the retry variables, a Play Mode filter or an Edit Mode plan;
  `STUDIO_PLAY_MODE` is still passed), up to
  `engines.<x>.compileTimeoutMin` (10) minutes. A red compile is handled as a red land run (the compiler's file names
  the lane) and costs minutes, not a land run; a green one goes on to the land run, whose stage report then begins with
  `compile`. Events `task.train.<x>.compile` (pass/red, seconds; a pass says "compile check passed in N s; the land run
  starts now", and so does the train's `now` line). A script that answers with an error or a not-run code,
  or lands the branches anyway, is noted once (`compile` event, status `ignored`) and not asked again by that train.
  Not run again for a group, or a lone lane, that already compiled in this train, nor before a retry.
- **A land killed from outside (2.84, B-130).** An exit code in `engines.<x>.killedExits` (default `[1073807364,
  3221225786]`: 0x40010004, a Windows reboot, and 0xC000013A) or a SIGKILL/SIGTERM the harness did not send by a time-out
  is status `killed`. The train tries it once more after `STUDIO_ENGINE_KILLED_RETRY_SEC` (60) seconds
  (`task.train.<x>.killed_retry`); a second kill ends the train with the lanes still queued and nobody handed back. When
  `.studio/train/<x>-cancel.json` names the train (a person's cancel), nothing is retried: the lanes stay queued and a
  `task.train.<x>.cancelled` event is written. The train only reads that file.
- **The suspect first (2.85).** Before 2.85 a lane was run without only when one rule alone (the class, then the
  namespace) tied exactly one lane to EVERY failing test. Now every rule counts at once (`tiesOf`): the class, the
  namespace, the class file less `Tests` (`ShopTests`: `Shop.cs`), and the test's assembly folder (the folder of the
  `.asmdef` above the test's file, at the target or at the lane's head; without one, the file's own folder); a lane tied
  to only some of the tests counts. One lane tied: the next land run is the batch without it (the innocent land at once;
  the lane is handed back with the failing names). Two or more: the untied lanes land first, apart from them, and only
  the tied ones are searched. Neither: the search by land runs. The plan is in the log (`blame plan: ...`) and in
  `task.train.<x>.blame` (meta `plan`: `without`, `apart` or `bisect`, the suspect or the tied lanes, the next lanes).
- **No repeat of an unchanged red (2.85).** Each hand-back is recorded in `.studio/train/<x>-handbacks.json` (the
  branch's head, the reason, the failing tests and their files, the conflict or compile files, the target's tip). The
  engine queue path (`task done --train`) refuses a branch whose every commit since that red is a merge of the target
  and whose target changed none of those files (with no file named: has not moved): "nothing changed since train
  <id> handed <branch> back for <reason>: the same red would repeat". `--again` queues it anyway
  (`task.train.<x>.requeued_unchanged`). A landing clears the record.
- **No blame by elimination.** A lane that the search by land runs leaves over ("everything before it was green") is
  run by itself before it is handed back. If it passes, it lands and nobody is handed back. 2.86: when the red names its
  tests, that run is by name (minutes, see below).
- **Handed back means out.** A lane the train hands back leaves the train's record at once, so `task start` on its
  fix works while the train is still landing the rest.
- **A full land run once a day.** Every `engines.<x>.fullLandHours` hours (default 24, `STUDIO_ENGINE_FULL_LAND_HOURS`,
  `off` for never) one land run gets `STUDIO_LAND_FULL=1` and none of the shortcuts: no `STUDIO_RULES_GREEN`, no
  `STUDIO_UNITY_EDITMODE_ARGS`. A land script that skips work on those variables should run everything when it sees
  `STUDIO_LAND_FULL=1`. The time of the last full run that passed is kept in `.studio/engine/<engine>-full-land.json`;
  with no record the clock starts at the first train, so the first full run comes that many hours later.
  2.85 (B-137): the full run is said wherever one looks. The train's `now` line and `train status --engine <x>` read
  "land run, the daily full run: every test runs, expect about N min" (N: the last full run's minutes, kept in that
  file); one `task.train.<x>.full_land` event (meta `why`, `tasks`) at its start; `engine.land` has `meta.full: true`.
- **2.86: the full run is its own run, on the target alone.** It never carries a branch and is never a retry, bisect or
  confirm step. It runs when it is due and the train has no lane (the Line Producer starts a train for it when the
  queue is empty), or, when it is overdue by `engines.<x>.fullLandMaxHours` (default twice `fullLandHours`; counted from
  the last full run that passed), 2.91: at the end of the next train, after the batch's rounds, on the target as it is
  then. It never goes ahead of a waiting batch; `full_land` says when it runs or what it waits for. When the full rules
  run is owed too, it goes first (it is shorter). The land command gets a
  ref at the target's tip as its branch and `STUDIO_LAND_FULL=1` with `STUDIO_LAND_PROBE=1`. A script that cannot run
  that (an error or conflict) is told in `task.train.<x>.full_land` (warn) and the full run is tried again at the next
  train. Every failing test of a full run is the target's own (below); 2.85's search for a branch tied to it, and the
  batch's second, ordinary run, are gone with the batch.
- **The target's own red in the full run (2.85).** A full run is the one run that sees every test, so it also sees
  what the target already fails. From 2.86 it runs on the target alone, so every failing test it names is the
  target's own: the names go to `.studio/train/<x>-full-baseline.json` (`{ at, target, failing, source }`) and the
  full-run clock counts as served. `engine.full_red_on_target` (warn, to the director) names the tests and asks for a
  fix task, once per set of names. A baseline name is never counted against a branch in an ordinary land run. A green
  full run, or a red one that went on past its first red stage without a baseline name, clears it
  (`engine.full_baseline_cleared`). `train status` shows "Known red on the target in the full run: N test(s)".
- **A red on listed flaky tests is not a branch's fault (2.86).** When every failing test of a red run is on
  `flakyTests`, the failing tests are run again by name up to `engines.<x>.flakyRetries` times (default 2, 0 to 5;
  `task.train.<x>.retry`, meta `n`); a pass on any retry lands the batch (`task.train.<x>.flaky`). Still red: the same
  tests run on the target alone, with no branch (a probe: the retry's variables plus `STUDIO_LAND_PROBE=1`, the branch
  a ref at the target's tip; `task.train.<x>.probe`). Red there too: the target is red. Nobody is handed back, nothing
  counts against a task; the round's lanes stay queued (marked `waitTarget` in place, not re-queued) and wait until the
  target moves (`task.train.<x>.waiting_target`; `train status` lists them); one `engine.red_on_target` (to the
  planner, once per tests and target tip) asks for a fix task. A later train red on tests a probe already found red on
  the same tip goes there at once, without retries. Green on the target: blame goes on as below. A probe that cannot
  tell (an error, a refusal, names not safe on a command line) is not a verdict: blame goes on. A land script that
  does not know `STUDIO_LAND_PROBE` gets a branch that is the target itself, so landing it merges nothing; if that
  script commits its own record of the run, the result still counts (2.86.1, below).
- **Tests known red on the target (2.86, off by default).** With `engines.<x>.knownRedHours` above 0 (the studio's
  choice, in its protected game file), the names of listed flaky tests that a probe found red on the target alone in
  that many hours go to the land script in `STUDIO_LAND_KNOWN_RED`; a script that honours it lands the batch when
  nothing else is red. Each use is a `task.train.<x>.known_red` event naming the tests and the probe that proved them.
  After a probe found the target red, the train tries one more run by name with them named before it waits for the
  target. Never a test that is not on `flakyTests`; nothing is ever left out by the harness itself.
- **The flake record (2.86).** `.studio/train/<x>-flakes.json` keeps, per listed flaky test, the land runs whose
  result for it is known (it failed, or the run passed with it in: a full Play Mode stage, a full run, a retry or probe
  that named it) and its reds, and the last probe on the target. `train status` says "<test> red in R of N land runs:
  fix it or it will keep costing runs" once it has been red twice.
- **The green record (2.86).** `.studio/train/<x>-green.json` (200 at most) keeps the trees of runs of the target alone
  that passed (tree, target tip, kind: a probe of which tests, or the full run). The same run on the same target is not
  run again (`task.train.<x>.green_reused`, and the log says so). A landing run is not looked up: once it passes, the
  target moves, so the same tree on the same target cannot come back.
- **One plan for the order of steps (2.86).** `nextStep` in `harness/unity-train.mjs` is pure: from a round's lanes,
  its results so far and the evidence ties it returns the next step (retry, probe, known-red run, wait for the target,
  without, apart, bisect, confirm, hand back, next round), each with its kind of run (`complete` or `name`) and whether
  a pass lands. `npm run engine -- bisect-plan --lanes A,B,C,D --red B [--flaky] [--target-red] [--pass-on-retry N]
  [--tied A] [--complete] [--no-names] [--land-min 60] [--name-min 5]` prints the steps for made-up outcomes, each with
  its kind of run and minutes, and the total.
- **The search by name (2.86).** When a red land run names its failing tests (safe on a command line, 50 at most) and
  the land script honours `STUDIO_LAND_PROBE`, every narrowing step (the suspect's `without` and `apart`, the prefix
  search) and the confirm run run only those tests on that step's merged tree, with `STUDIO_LAND_PROBE=1` and the retry
  variables: minutes, not an hour, and they land nothing. The log line of each says "by name: N test(s), does not land".
  A lane is handed back on the same proof as before (red with it, green without it, on the same target; red by itself).
  Then ONE complete land run of the survivors lands them; if it is red on other tests, the search starts again from that
  red. When the red names no test (a compile error, a time-out, a crash, no results), or the script has not shown that
  it honours `STUDIO_LAND_PROBE`, every step is a complete land run and a green one lands, as before. The script shows
  it by printing a line `[land-probe] honoured` (or `"probe": true` in its stage report) in a run told
  `STUDIO_LAND_PROBE=1` (a probe or the full run; kept in `.studio/train/<x>-probe.json`), or the owner sets
  `engines.<x>.landProbe: true`. A by-name step on lanes gives the script the lanes' branches (or an integration
  branch): a script that ignored the variable could land them, which is why it must have said so first.
- **When a run that must land nothing moves the target (2.86, 2.86.1).** After every run told `STUDIO_LAND_PROBE=1`
  the train compares the target's tip with the one before.
  - *A run of the target alone* (the daily full run, the probe of a flaky test) carries no branch, so a moved tip
    cannot be a landing: a land script that commits its own record of every run moves it. The run's result stands for
    the tip that was run, and one warning says so (`task.train.<x>.target_moved_alone`). 2.86.0 threw such a run away.
  - *A by-name step that carries a branch* and moves the target has landed something it should not have: the run
    counts as an error, the train stops at once, nobody is blamed, the round's lanes stay queued,
    `task.train.<x>.probe_moved_target` (blocked, to the producer) says what moved, and `.studio/train/<x>-probe.json`
    is marked revoked, so by-name steps are off for that engine until a person removes the file. A lane that the run
    did land is closed by the next train (it is already in the target).
  A land script that honours `STUDIO_LAND_PROBE=1` writes nothing to the target on such a run, its own records
  included: lanes that wait for the target to move are otherwise run again after every record commit.
- **Branches that land alone by path (2.86).** `engines.<x>.batchAlone`: a list of regexes over changed paths (for
  example long Play Mode scenario tests). A queued branch that changes a matching path lands alone, as `--alone` does,
  and the batch line says which path.
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

### The playtest build and "Systems ON" (2.95)

**The contract for a land script:** after a green land run that built a player, write the built executable's path as
`gates.build.output` in the land result (the file named in `STUDIO_LAND_RESULT`), with `gates.build.status` and the
`commit` the land run made. The harness keeps that path in `.studio/engine/<x>-land-builds.json`. It only reads the
build folders; `engines.<x>.builds` still prunes them.

`engines.<x>.playtest` keeps the newest playable build in one fixed folder, with a note beside it:

```json
"playtest": { "dir": "D:/Playtest", "exe": "Game.exe", "build": "powershell -File BuildPlayer.ps1 -Out {out}",
  "shortcut": true, "feedback": "Say what you found in the studio chat.", "keep": 3, "nightly": true }
```

- `npm run engine -- playtest [--engine <x>] [--if-moved] [--dry-run] [--json]` (also `npm run playtest:build`)
  takes the newest green land build still on disk. If it is of the target's tip (or the tip moved only in
  `engines.<x>.rules.ignore` paths), it is promoted. If the target moved past it: with `build` set and no engine train
  running, the tip is built (in the engine's `cwd`, holding the train lock and the machine:heavy slot as a land run
  does, `{out}` a new folder in `dir`, `STUDIO_PLAYTEST_COMMIT` the tip). Without `build`, or while a train runs, the
  newest build is promoted and the output says how many landings it is behind, and which.
- Promote copies the build into `<dir>/<date>-<short commit>/` (never over a folder: the owner may be playing it),
  writes `PLAYTEST.md` there and in `dir`, writes the shortcut (`Playtest <Label>.cmd` on Windows, `playtest-<x>.sh`
  elsewhere; the same name every time) in `dir` and on the Desktop (`shortcut: true`), or in the folder given, and
  records `.studio/engine/<x>-playtest.json` and one `engine.playtest` event. The newest `keep` promoted folders stay;
  one in use is left and named.
- `PLAYTEST.md` says what the build is (commit, when built, when the target last moved, how far behind), Systems ON
  with the names on and off, what landed since the previous playtest build, what is known red or open (the target-red
  and full-run lines, flaky tests, tasks the engine train handed back), and the `feedback` line.
- `--if-moved` does nothing when the promoted build is already the newest there is. `nightly: true`: the watchdog's
  once-a-day tick (the digest's) starts `playtest --if-moved` for that engine on its own (log in
  `.studio/engine/<x>-playtest.log`).

`engines.<x>.switches` counts the rule systems switched ON in the engine. It is read from the engine target with git
(nothing is checked out): one file per system matching `files`, its name from `name` (group 1; else the file's name),
on when `on` matches.

```json
"switches": { "files": "Game/Sim/Systems/**/*.switch.cs", "name": "Name\\s*=>\\s*\"(\\w+)\"", "on": "On\\s*=>\\s*true",
  "total": 64, "task": "switch .*\\b{name}\\b" }
```

`npm run score`, `npm run status` and `npm run studio:status` show `Systems ON: 16 of 64` (`total` is the larger of
the planned number and the systems found; the rest are not in the engine yet). `npm run engine -- switches [--engine
<x>] [--json]` lists the systems still off, each with the open task that switches it: by default one whose title has
the word "switch" and the name as a whole word; `task` (a regex with `{name}`) replaces that. Unset: no line, nothing
read. A bad setting shows as one line naming it.


## The engine train from 2.90: compile search, blame by file, checks before queueing

From a studio's day: a batch of three took four land runs (two hours) to find a branch that compiled alone but not with
another, and a test that fails whenever a branch moves a pinned commit was found by a search of land runs twice.

- **The compile search.** When `engines.<x>.quickCheck` is set (the compile a porter's `task done` already runs), a batch of
  two or more branches is compiled as it would land, before the rules check and the land run, in a throwaway checkout of
  the engine repo (the `rules.paths` sparse checkout and `rules.lfs` when set). Red there and green on the target: merged
  prefixes find each branch that does not compile with the ones before it (a few one-minute runs, never a land run). Each
  is handed back at once (cause `compile`) with the compiler's own lines (checkout folder taken out), the branch(es)
  before it that change a file the compiler names, and the fix: once those have landed, bring the target in and fix the
  lines. The rest go on to ONE land run. Red on the target itself: nobody is judged by it. Event
  `task.train.<x>.compile_search`; the train's result has `compile: { runs, left }`. `engines.<x>.compileSearch`: `false`
  turns it off; a command string uses that command instead of `quickCheck`. The time limit is `quickCheckTimeoutMin` (30).
  Example: `"quickCheck": "dotnet build tools/SimTests --nologo"` alone is enough. Unlike `compileFirst` (the land
  command with `STUDIO_LAND_ONLY=compile`, once per group), it needs nothing from the land script.
- **The compile search at the queue door (2.92).** With the compile search on, `task done --train` compiles the branch
  merged with the target before it is queued. Red there: not queued, with the compiler's lines (a merge that
  conflicts: not queued, with the files). Then the target, the untagged branches queued ahead of it (not those that land
  alone or wait for the target) and the branch: red although the branch alone compiled, the same search names the
  queued branch(es) it does not compile with. The branch is still queued (a refusal would send the porter away from
  work that only needs the other branch to land first, and a hand-back counts toward the watchdog's park); the porter
  reads which branch, the compiler's lines and what to do, and the queue entry keeps the clash. A train leaves it out of
  a batch with that branch (event `task.train.<x>.deferred`) and checks it again once that branch has landed or left the
  queue (the compile search then runs even on a batch of one). At most `STUDIO_QUEUE_COMPILE_RUNS` (6) compile runs for
  this second step and `STUDIO_QUEUE_COMPILE_MIN` (10) minutes in all; a bound reached, a command that cannot run or a
  time-out queues the branch as before, with one line saying so. One `task.train.<x>.queue_compile` event per verdict
  (`meta.verdict`: pass, red, conflict, clash, unfinished, not-run). It takes no machine slot, as the train's search.
- **A failing test tied to the files that explain it.** `engines.<x>.blame`: a list of `{ "test": "<regex on the
  failing test's full name>", "touches": "<path or glob, or a list>", "say": "<what to do>" }`. After a red land run
  (and in the rules check, with `rules.first` too) a failing test an entry matches ties the branches that change a file
  it names: exactly one, and the next run is the batch without it (the 2.83 suspect step, rule `blame`), no halving
  search; it is handed back with the evidence and the `say` line. Several: they go apart from the rest (2.85). An entry
  with a bad regex or a path outside the repo is left out. Example: `"blame": [ { "test": "PinTests\\.", "touches":
  "Rules~/pin.json", "say": "Regenerate the vectors at the new pin in the same branch" } ]`.
- **Checks before queueing.** `engines.<x>.preQueue`: a list of `{ "touches": "<path or glob, or a list>", "run":
  "<command>", "say": "<what to do>", "timeoutMin": 10, "env": { "<NAME>": "<value>" } }`. 2.93: an entry may also
  have `"titles": ["<regex>", ...]` (case-insensitive, tested against the task's title) for a check on one KIND of
  task. An entry applies when every condition it gives is met; it needs `touches` or `titles`. A bad regex leaves the
  entry out and the command's output says so. The command also gets `STUDIO_TASK_ID` and `STUDIO_TASK_TITLE`. When `task done --train` (or the harness's own queueing)
  queues a branch that changes a matching file (against its merge base with the target), the command runs in a
  throwaway checkout of the branch's head merged with the target's tip (2.92: the branch as it would land; a merge that
  conflicts refuses the queue and names the files, and nothing runs). `STUDIO_LANE_COMMIT` is the branch's head and
  `STUDIO_TARGET_COMMIT` the tip it was merged with (`STUDIO_LANE_DIR` the checkout, `STUDIO_ENGINE_REPO`,
  and `STUDIO_ENGINE_LANE_DIR` the porter's lane folder when it exists; before those, the entry's own `env`, for a
  command that needs what `rules.env` gives the rules check). It exits non-zero: the branch is not queued,
  and the porter reads the command's last 8 lines, the `say` line and the one command to run again. Not run again for a
  head already queued. A command that cannot start (or a checkout that fails) queues the branch with a warning event
  (`task.train.<x>.pre_queue`). The queue keeps the tip it passed on; a train that starts on another tip runs the
  check again on the branch merged with its tip, before the compile search and the rules check, and a failure there
  hands that branch back (cause `pre-queue`) while the rest go on. Example: `"preQueue": [ { "touches": "Rules~/pin.json", "run": "dotnet run --project tools/VectorCheck",
  "say": "Re-record the vectors at the new pin and commit them in this branch." } ]`.


## Two land runs at once (2.90, off by default)

One red branch should not hold the whole queue for a halving search of 45-minute runs. With a second gate copy the
train can run two steps of that search at once. Whether to use it is the Line Producer's (or a person's) call; the
harness never switches it by itself.

- **The second gate.** `engines.<x>.gates`: a list; its first entry is the second gate, with its own `land` (and
  `landMany` when used), `cwd` and `gateWorktree` (or `folder`); the engine's own keys stay the first gate. The copy
  needs its own checkout of the engine repo (a detached worktree is enough) and its own editor cache (its own
  `Library` folder for Unity: two editors never share one), and enough disk and RAM for a second editor. A second gate
  with the same worktree and folder as the first is not used. No second gate configured: nothing changes. Example:
  `"gates": [ { "land": "pwsh tools/land.ps1 -Branch {branch} -Gate two", "cwd": "../game-gate-two", "gateWorktree": "../game-gate-two" } ]`.
- **The switch.** `npm run task -- train parallel on|off --engine <x> --by <name> [--why "…"]`, beside `train auto`
  and by the same ranks (the owner, outside agents, Producer and Director sessions; never a worker's name), and the
  Line Producer by its role. `.studio/train/<x>-parallel.json` keeps who set it and when (`task.train.<x>.parallel_on`
  / `parallel_off`). `train status --engine <x>` (and `train parallel` with no word) says whether it is on, who set it,
  and whether the next search would use the second gate or why not. Each Line Producer pass, when a second gate is
  configured or the switch is on, its engine row carries one line: the switch, the second gate, the branches waiting,
  whether the last train was red, free RAM against what two runs need, the engine slots, and the command.
- **What it does.** When it is on, a second gate is usable, the land script has shown it honours `STUDIO_LAND_PROBE=1`
  (the 2.86 probe record, or `"landProbe": true`) and the machine admits two engine land runs, a search by name after a
  red runs two prefixes at once (at a third and two thirds of what is left), one on each gate, each as its own
  `node harness/unity-gate.mjs --gate k` process with its own machine:heavy admission. Both are probes: neither lands.
  A red search over four branches takes one round fewer (the batch, one pair, the confirm, the survivors' landing).
  What lands is what one gate would land: the survivors still land on one complete run on the first gate. Event
  `task.train.<x>.parallel`; the train's result has `parallel` (pairs) and `rounds`.
- **The machine budget.** Two runs need two admissions. The pre-check takes the smallest of `STUDIO_ENGINE_SLOTS`, the
  heavy slots (`STUDIO_HEAVY_SLOTS`) and the job kind's cap (Unity: `STUDIO_HEAVY_MAX_UNITY`, default 1, or the
  budget's `maxConcurrent.unity`), and free RAM against twice the engine's floor. Each run is still admitted by the
  machine:heavy lock on its own; a second run that is not admitted within 2 minutes gives no answer and its step runs
  again on one gate. A train that runs inside another heavy hold never uses the second gate.
- **When something goes wrong.** A gate that gives no answer (not admitted, crashed, refused, no result): that step
  runs again on one gate, as before. The target moves during the pair: a land script ignored the probe; as in 2.86,
  the train stops with every lane still queued, nobody handed back, and the probe record revoked (by-name steps and the
  second gate are off until a person clears `.studio/train/<x>-probe.json`). A gate copy that is behind the target:
  each run gets a ref of the tree it must test (the target's tip with the group merged), so the land script must
  check that ref out or merge it, as the first gate does. The train process dying: the integration refs
  (`<x>-train/...`) are removed at the next train's start, and no probe landed anything.
- **What it does not do.** It never lands two groups at once, and it does not try the next batch on the second gate
  while the first lands: only the land script moves the target, so a group found green on the old target would still
  need a complete land run on the new one, a tree no run has seen as a whole. It is not used for complete runs (a
  land script that does not honour the probe), for the compile search or for the rules check.

## Measured runs and admission by measured RAM and CPU (2.96)

Every land run, rules command (whole, part or shard), compile check and quick test the harness starts is sampled while
it runs: free RAM, commit charge (Windows), total CPU, and the working set and CPU of the run's whole process tree. The
samples are in `.studio/engine/<x>-samples/<run>.csv` (newest 60 per engine, none older than 14 days). Linux reads
`/proc`; elsewhere nothing is sampled. On Windows sampling starts one PowerShell helper for each run that lasts longer
than one sample interval; it prints one line per sample and ends with the run (or by itself when the run's wrapper is
gone); `"machine": { "sample": false }` in `studio/game.json` turns sampling off. A sampler that fails never changes the run.

Each ended run is folded into `.studio/engine-ram.json` (`<x>.kinds`, beside the land peaks): its peak GB, mean CPU %,
minutes, when the peak came (start, middle, end, throughout) and which kinds ran beside it. Kinds: `land with-rules` or
`land no-rules` (`STUDIO_RULES_GREEN`), plus ` play-<mode>` with `STUDIO_PLAY_MODE`; `rules` (the whole command) and
`rules <filter>` (a part or shard); `compile`; `quick`. A kind's need is the peak of its last 5 runs plus
max(0.5 GB, 10%), once at least one of them passed.

`studio/game.json` (the owner's file):

```json
"machine": { "admit": "measured", "cpuCapPct": 85, "slowerPct": 10, "sampleSec": 10, "sample": true }
```

- `admit` (default unset: off). Off, every decision is 2.95's. `"measured"`: a land run (the machine:heavy wait), a
  part of a split rules check, the check ahead and a quick test start when free RAM minus the floor
  (`STUDIO_RAM_FLOOR_GB`) minus what the running jobs still have to grow (their need minus what they use now; a heavy
  job with no samples counts its whole claim) holds the job's own need, and CPU now plus the job's measured share stays
  under `cpuCapPct`. The measured need replaces the claim's RAM and CPU, the land floor and `rules.peak`;
  `rules.focus.splitGb` set by hand still wins. Slots, per-kind caps, the queue and holds stay. A job that waits says it
  in numbers: `waits for memory: needs 12.7 GB, 17 GB free above the floor; land no-rules still has 5.1 GB to grow`.
- When a number is missing (a kind never measured or never passed), stale (a running job's last sample is old) or looks
  wrong (a running job uses more than its own need), today's rule decides, and the log says why. The first run of a
  kind measures it.
- Overlap that does not pay: after 3 passing runs of a kind alone and 3 beside another kind, if it took more than
  `slowerPct` longer beside it, that pair is not run together for 24 hours (`machine.overlap_stopped`, with the numbers),
  then tried again on fresh runs.
- `npm run engine -- rules show` lists each kind's measured peak, need, CPU and minutes, including the land kinds: the
  number a land script's own wait for free RAM can use. `train status` shows each running job's RAM and CPU now, its
  peak so far and its reservation. The land result line and the `engine.land` and `engine.rules` events carry
  `peakGb`, `cpuPct` and `minutes`.
- Untested on Windows: the PowerShell helper (its process tree, CPU per process and commit charge) has only been run
  through a stand-in that speaks its one-line protocol.

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
  `docs/examples/land-warm.md`. An editor of the service is not counted as a heavy program outside the lock:
  the default of `STUDIO_HEAVY_IGNORE_ARGS` matches `-studioService` (a studio that set its own value adds `|-studioService`).
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

## Held and slice lanes (2.93)

- **`task after` holds a queued branch.** A queued lane whose task waits (`task after <ID> --set T-x`) for a task that is
  not done is left out of a train, like a lane that clashes (event `task.train.<x>.deferred`: "it waits for T-x (task
  after)"). It rides the next train once T-x is done or the hold is removed. `task done --train` still queues it and says so.
- **`npm run task -- train slice <ID> --engine <x> --by <name> [--off]`** marks a queued branch as a slice (what
  `task done --train --slice` does): its task stays open when it lands. `--off` removes the mark. Nothing else about the
  entry changes. It refuses when the task is not in that queue or its train is running with it. Same actors as `train auto`.
  Event `task.train.<x>.slice_marked`.


## 2.96 (d): landings posted, what the tests cost, Play Mode gaps, a busy line

- **A landing is posted by itself.** When an engine train lands a batch (`task.train.<x>.landed`) the Communicator posts
  one message to the same webhook as the status: the tasks with their titles (8 at most, then "and n more"), how many
  landed in the last 24 hours, the first line `engines.<x>.progress` prints (a command that fails is left out), and
  `Systems ON: n of m` when `engines.<x>.switches` is set. It is on wherever a webhook is set;
  `engines.<x>.announce: false` turns it off. A landing is posted once; only the Communicator posts it.
- **`rules.times`** is the result file the test command writes with a time per test (a glob inside the test checkout;
  `.trx`, NUnit or JUnit XML): `"times": "tools/SimTests/**/*.trx"`. Only files written since the command started are
  read. The slowest 200 tests of each command are kept for 48 hours in `.studio/engine/<x>-times.json`. The daily digest
  gets up to two short lines. `npm run engine -- test-cost [--engine <x>]` prints the long form: the 10 slowest tests
  with their share of the test time, tests that ran in two commands of one train, the shards with the most measured
  memory (`partStats[...].peakGb`) and the hand-backs of kind `ratchet` in the last 24 hours.
- **Play Mode map gaps.** A land run whose Play Mode stage ran in full because paths match no `play.focus.map` entry
  keeps all of those paths (`.studio/engine/<x>-play-gaps.jsonl`). The digest says how often that happened in 24 hours
  and for which folders. `npm run engine -- play-plan --propose [--engine <x>] [--branch <b> | --paths a,b] [--json]`
  groups the paths by folder (without `--branch` or `--paths`, the paths of the last 7 days) and proposes an entry for
  each: `skip` when the rules tests already judge the folder (a `rules.focus` map entry or auto folder) or
  `play.focus.skip` takes every path, else a `map` entry whose filter you fill in. Nothing is written to `studio/game.json`.
- **A busy line.** The refill counts the open builder tasks that can start now (not held, parked, over budget, waiting
  for another task or queued for a train). When fewer than `STUDIO_REFILL_MIN` can start, it wakes the Producer with
  the cause ("nothing can start: n open tasks wait for the engine train or for another task. Propose the next ready work
  from the plan.") at most once an hour, even while many tasks are open. The `builders-low` alert gives the same cause
  and says it is not a fault.
