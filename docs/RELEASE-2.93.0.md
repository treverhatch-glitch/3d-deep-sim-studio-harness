# 2.93.0: one rules check per train, and nothing of the harness's own in a land run's way (`docs/RELEASE-2.93.0.md`)

The owner's order of 2026-11-18: do the overseer's list, clean up old code and duplicate lines, add what helps.
Built on 2.92.0. Only this page and the one for 2.92.0 are kept; older release notes are in git history.

## What the records said

A live studio's first day on 2.92. Its trains landed what they carried (1.1 land runs per train, where 2.83 needed
2.2), with no studio stop and no stalled session. The time went somewhere else:

| What happened | Cost |
| --- | --- |
| Every train ran its rules check twice: on the target, then on the batch. The target had just landed through a train. | 90 to 150 minutes of a train of 4 to 6 branches; once two full runs, 62 and 107 minutes |
| A full rules run started outside the train (a done-time check with the hours due) held 6.7 GB, then 14 GB, while a train with green branches reached its land run. | the land run waited 30 to 60 minutes for memory, twice in one day |
| A start from the API pool with an engine role became a plain builder with no lane and was gone in 30 seconds with no output. Two starts took the same name. | no engine work from that pool |
| An engine pass on agy was refused `git -C <its worktree>` by agy's own permission check and handed back with nothing. | no engine work from that tool; two hand-backs counted against the tasks |
| A porter queued a unit that was told to wait for another task. | the overseer took it out of the queue by hand, five times |
| Slices queued before the upgrade closed their units when they landed. | a unit closed with work left |
| A task that repeated a finished one could be closed only as `impossible`, after starting it. | a failure on the scorecard that was none |
| Two "wire" tasks closed with part of their systems still empty. | found later by hand |

Median engine train by harness version, from that studio's event log: 88 minutes (2.83 and before), 78 (2.84 and
2.85), 120 (2.86), 128 (2.90), 209 (2.92). The rules suite grew over the same weeks; running it twice is what 2.93 removes.

## What changed

| | What | Proof |
| --- | --- | --- |
| The rules check | The batch runs first. Green ends the check and nothing runs on the target. Red asks the target: a kept result for its tree answers, else it runs now. With no `rules.focus` a green train costs one full run, not two. | `293a` |
| A landed tree keeps its green | A batch head that lands with the same rules key is the next target, and its kept result answers. `rules.landGate` names the gate in the land run's result file that runs the same tests: when it passed, the landed tree gets a kept full pass and the last full pass is written. A kept full pass also answers a focus or `first` question on the same tree. | `293a` |
| Rules runs outside the train | `npm run engine -- rules` and the done-time check take a machine:heavy slot as a verify does, so the Line Producer's hold for a queued engine land keeps them waiting. They never turn full because hours are due (`--full` and `STUDIO_ENGINE_RULES_FULL=1` still do). | `293a` |
| The API pool takes a role | `npm run agent -- start --pool api [--role R] [--task T]`: recorded as that role, with that role's lanes (an engine pass gets its engine worktree), under the first pool name with no live session. All names busy is refused in one line. | `293b` |
| A start that dies leaves a record | The detached launcher writes an ended session with a `refusal` line when the start is refused or crashes. | `293b` |
| An engine pass on agy | The launcher writes the session its own settings file with `read_file` rules for the folders a Claude session gets with `--add-dir`, and `git -C <worktree> status|diff|log|add|commit`. `STUDIO_AGY_REACH_RULES` sets the rule templates, or `off`. A session agy ended for permissions says so in its record and hand-back. | `293b` |
| A tool's refusal is not the task's fault | New hand-back kind `tool-permission`, a harness cause: it does not count toward parking the task, the circuit breaker or the task's budget. | `293e` |
| `task after` holds a queued branch | A queued lane whose task waits for a task that is not done is left out of a train (event `task.train.<x>.deferred`) and rides the next one after. `task done --train` still queues it and says so. | `293c` |
| A queued branch can be marked a slice | `npm run task -- train slice <ID> --engine <x> --by <name> [--off]`: its task stays open when it lands. | `293c` |
| A duplicate has its own verb | `npm run task -- duplicate <ID> --of <T-x> --by <name> [--why "..."]` closes a waiting task that repeats another. No start, no failure, no landed work. | `293c` |
| A check for one kind of task | A `preQueue` entry may have `"titles": ["<regex>"]`; its command gets `STUDIO_TASK_ID` and `STUDIO_TASK_TITLE`. A studio's own script can then refuse a task of that kind whose work is partial. | `293c` |
| A time limit ends the whole tree | The engine commands (compile, rules, pre-queue and pre-land checks, the quick check, the land command) run through `harness/run-limited.mjs`. At the limit it ends everything the command started (Windows `taskkill /T /F`, elsewhere the process group). P-360. | `293e` |
| Where a train's minutes went | The train's `done` event and `<engine>-last.json` carry `minutes { total, compile, rules, wait, land }` and `landRuns`. `train status` prints "Last train took N min: ..."; `npm run score` prints the median per part. | `293e` |

Running focused groups at once (`rules.focus.splitMax`, `splitGb`) and a filter per unit (`rules.focus.auto`) exist
since 2.85 and 2.86; nothing was added for them.

## What was removed

- **"Floors"**, an older way to split work by building floor (`harness/floors.mjs`, `docs/FLOORS.md`, `npm run
  floors`, its hooks in the supervisor and the task gate), and **the overnight summary** (`harness/overnight.mjs`,
  `npm run overnight`), which the daily digest covers. No studio on record ran either. 287 lines of modules, plus hooks.
- **Twelve copied functions** now have one home: `positionalOf` and `walkCodeFiles` in `harness/helpers.mjs`, and
  one each in route, cartridge, train-busy, futility, check-comments and settings-map.
- **The problems log** keeps open and recent entries in full; 34 closed ones are one line each (the text is in git history).

## Size, said plainly

`node scripts/size-report.mjs --against origin/main`: harness code is 6 lines smaller (85,211 to 85,205) with every
item above in it, and one module fewer (334 to 333). Scripts are 19 lines smaller. Tests are 959 lines larger (four new
units, 11 checks removed with the two features). Three new settings. One page of documentation fewer.

Still unused by the one studio on record and still in: an older status snapshot with its role loader (about 480
lines) and the second scorecard (421 lines; this release added the train times to it). They wait for the owner's word.

## Existing checks changed on purpose

- **The order of the rules check.** `282a`, `284t` (split), `285b`, `286c` (four checks), `290b` (B3, B1+B3 and the
  time-out cases b, c, d) and `291a` (due, idle, overdue, and three kept-result checks) asserted "target first, then
  the batch". They now assert "batch first; the target only after a red". What each proves about blame, time-outs and
  full runs is unchanged.
- **Removed with their features:** 11 checks in `qa/selftest.mjs` that tested only floors or the overnight summary,
  and the overnight line in one check of `264k`.
- **One check reworded:** "task-add: a phase past the open one is refused" now also holds with an old "floors" list
  left in a studio's Bible. The refusal is the same; the exception for an open floor is gone.

## Limits, said plainly

- **Nothing here ran on a real engine, on real agy or with a real API pool** from the harness's side. The studio's
  first trains on it are the test. "A batch of six lands in under 90 minutes" is not shown; it depends on the
  studio's settings and its land script as well.
- **agy's rule format is a best guess** from its documentation. If it differs, `STUDIO_AGY_REACH_RULES` sets it
  without a new release.
- **Why the pool start died in 30 seconds was not found.** It now has the role and the lane it lacked, and a start
  that dies leaves a record that says why.
- **The harness does not judge "a wire task is complete".** What an empty seam is belongs to the game. The harness
  gives the hook (`titles`) and the task's id and title; the studio writes the check.
- **Slices queued before an upgrade are not marked by the upgrade.** The harness cannot tell a queued slice from a
  queued last part. `train slice` is one command per queued branch.
- **Tree kill on Windows** is exercised by the online Windows run of `293e` only, not on a studio's machine.
- **A changed reading:** elsewhere than Windows, a land command killed from outside now arrives as exit 137, which is
  read as out of memory and retried once.
- The web game's own timed commands still end only the shell.

## For a studio taking it

`npm run upgrade -- --merge origin/main`. Nothing to set for the batch-first check, the waiting rules runs, the tree
kill or the train times. Worth setting: `rules.landGate` to the name of the land script's gate that runs the rules
tests. A studio whose land script skips that gate after a full check can weigh one full check on the batch against a
focused check plus that gate. For a tool or pool that is new to engine work, start one session and read its record
before starting more.
