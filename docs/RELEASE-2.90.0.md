# 2.90.0: the overseer's list, and an engine train that finds a red in minutes (`docs/RELEASE-2.90.0.md`)

The owner's order of 2026-11-16: build what the overseer of a live studio asked for after two days on 2.86, two land
runs at once included, with the Line Producer deciding when to use them. Built on 2.89.0. Only this page and the one
for 2.89.0 are kept; older release notes are in git history.

## What the records said

The overseer's brief named the engine train as the studio's speed limit: three branches took 2 h 08 and four land
runs; the next batch went red after 87 minutes. The studio's train logs showed why, and it was not on the list:

- **The rules check judged nobody.** On every train since 15 November it timed out on the target after the default
  30 minutes and "judges no lane". The suite had passed in 22 minutes two days earlier and grew. The line was only in
  the train's log; the path that prints it wrote no event.
- **A compile error was searched with land runs.** Two branches each added the same members to a shared type. Each
  compiled alone. The evidence step found two branches for the named file, so it searched by 45-minute land runs.
- **A red that one changed file explains** (a pin file and the test that reads it) was searched the same way.

## What changed: the engine train

| | What | Proof |
| --- | --- | --- |
| Rules check time limit | With `rules.timeoutMin` unset, the limit is the largest of 30 min, 1.5 times the longest passing run on record, and twice a limit that timed out on the target; never over 120. A set value is used as it is. A tree that timed out is not run again with the same limit. A train whose check judged nobody writes `task.train.<x>.rules_no_judge`; after two in a row `train status` and the Line Producer's page say so, with the minutes spent. | `qa/selftest-290b.mjs`, five checks, fail on 2.89 |
| Compile search | A batch of two or more is compiled as it would land, with `quickCheck`, before the rules check. A branch that does not compile with the ones before it is handed back with the compiler's lines and the branch it collides with; the rest go on. `engines.<x>.compileSearch` (`false`, or a command). | five checks |
| Blame link | `engines.<x>.blame: [{ test, touches, say }]`: when a failing test matches and one branch changes a matching file, the next run is the batch without it. | two checks |
| Check before queueing | `engines.<x>.preQueue: [{ touches, run, say }]`: a branch that changes a matching file runs the command first, in a clean checkout of its head; red refuses `task done --train` with the command's last lines. | two checks |
| A test filter first | `rules.first`: run before anything else in the rules check; red names the tests at once. | three checks |
| Two land runs | `engines.<x>.gates` names a second gate copy; `task train parallel on|off --engine <x> --by <name>` switches it (the Line Producer may; off by default). On, with a second heavy admission and a land script that honours `STUDIO_LAND_PROBE`, two steps of a search run at once. Only one run moves the target; the second gate never lands. | eight checks |

Worked through on the two logged batches: the first takes one land run (four before), the second two (four or five),
or one with the check before queueing.

## What changed: tasks and sessions

| | What |
| --- | --- |
| Slices | `task done <ID> --train --slice` queues a slice; landed, the task is ready again and its budget starts over. A hand-back from a session that committed to its task is progress: not counted by the watchdog park, the circuit breaker, the crew breaker or the scorecard. |
| Proposals | A task that names an open proposal (title or `--after`) waits for it, then for the task it became. `task promote` takes `--phase`, `--serves`, `--type`; an engine porter's "Port ..." is a chore by its title. |
| Holds | `task unblock` ends a time block. |
| Briefs | Line ranges a task names (`path:120-180`) open the brief as "Read only these lines". An answered ask stays a must-do for the asker and the Director until `ask -- followed <id> --task <ID>` or `--none "why"`. |
| Porters | The role says a unit declares no member of a shared type; `studio/templates/port-plan.md` starts with the shared-state chore. |
| Stalls and refresh | A session holding a machine slot or riding a running engine train is not stalled. Idle turns count from a session's first edit or commit. |
| Status | "0 of 5 builders busy: 12 tasks wait on the <engine> train" and no builders-low alert for that reason; the engine train beside the web train; asks past their default time or for a done task not counted as waiting. |
| Guards | The upgrade preflight and `upgrade --merge` warn when a plain `git pull` would merge the harness into the studio (`git branch --unset-upstream`). A refused new file under `scripts/` or `tools/` says a game's own script goes in `game/<name>/tools/`. |

`qa/selftest-290a.mjs` (12 checks) and `qa/selftest-290c.mjs` (14). Against 2.89.0: 44 files, code +873 / −67, tests
+1,040, in two new modules (`harness/engine-compile.mjs`, `harness/engine-gates.mjs`) and changes in place.

## What a studio sets

Nothing for the time limit, the compile search (with `quickCheck` set), slices, briefs or status. For the rest, in
`studio/game.json` under `engines.<x>` (made-up names):

```json
"blame":    [{ "test": "PinTests\\.", "touches": "Rules~/pin.json", "say": "Regenerate the vectors at the new pin in the same branch" }],
"preQueue": [{ "touches": "Rules~/pin.json", "run": "dotnet run --project tools/VectorCheck", "say": "Re-record the vectors at the new pin and commit them." }],
"rules":    { "first": "FullyQualifiedName~PinTests" },
"gates":    [{ "land": "<the land command for copy two>", "cwd": "<copy two>", "gateWorktree": "<copy two>" }]
```

Two land runs also need `STUDIO_ENGINE_SLOTS=2`, `STUDIO_HEAVY_SLOTS=2`, `STUDIO_HEAVY_MAX_UNITY=2`, a second
project copy with its own editor cache, and a land script that writes nothing under `STUDIO_LAND_PROBE=1`.

## Existing checks changed, and why

- `qa/selftest-285c.mjs`: its idle-turn log had no work at all; idle turns now count from the first work, so the log
  has one commit and then 50 idle turns.
- `qa/selftest-283a.mjs`, `284v.mjs`, `285d.mjs`, `286d.mjs`: sessions meant as "did nothing" or "a real hand-back"
  had commits, which is now progress; they commit nothing. 283a uses 10 sessions where it used 8.

## Not tested, and not done

- Everything on the engine train ran against stand-in scripts. No real `dotnet` run, no Unity editor, no two
  editors at once (memory, licence).
- A red slice through a whole train run: the check drives the train's close and hand-back functions directly.
- A session that commits broken work and hands back is no longer parked by the watchdog; the task budget's minutes
  and tokens bound it.
- A test command a session runs outside the harness's own checks is still invisible to the stall check.
- The next batch is not tried on the second gate while the first lands: only the land script moves the target, and
  a group nobody tested on the new target would need a full run anyway.
- Not built: a game's own progress script in the harness (it belongs in `game/<name>/tools/`); the overseer's
  `.env` values as defaults (the rules behind them changed instead).
