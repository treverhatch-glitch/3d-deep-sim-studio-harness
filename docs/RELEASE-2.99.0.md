# 2.99.0: mixed trains that don't stall, checks that run only what changed (`docs/RELEASE-2.99.0.md`)

The overseer's brief of 2026-11-26 (14 items), written after the studio on record had run 2.98.0 for two days, with
the owner's order for this code base: cut what is not used and has not been used, and consolidate. Built on 2.98.0.
Only this page and the one for 2.98.0 are kept; older release notes are in git history.

## What the records said

- 2.98 worked: one train carried art, UI and translation lanes together; eight lanes landed at once; three-lane
  translation trains landed in 33 to 54 minutes; no false red from a shared build output.
- A train with one red lane took 171 to 279 minutes, three times in a day. The log of one: a red land run (52 min), a
  run of the two failing Edit Mode tests by name that then ran all of Play Mode (50 min, landing nothing), then a land
  run that was "not told the rules are green: the batch changed" and ran the whole rules suite itself (105 min).
- In another train the failing tests were new tests of the red lane: the run without that lane could not find them,
  and the studio's land script ran the whole stage instead (110 min, until it was cancelled).
- An agent ran the engine's full land command for its own task, on a lane that held nothing new. It held the one
  editor slot for two hours while a train waited.
- Every mixed batch ran the whole Play Mode stage. A tag group waited five days and three of its four lanes were
  handed back in the first minute of its train. Builder sessions could not run a tool the studio had allowed.
- **Four items had another cause than the brief gave**, found by reading the code and the studio's logs first:
  `play.focus.map` has existed since 2.84 (the gap was the rule for mixed batches); the allow rule for the tool was
  there, but in a spelling no session can type; the agent's own land run was the road the role file told porters to
  take; and three items are files of the studio's own repository.

## What changed

| | What | Proof |
| --- | --- | --- |
| The green after a lane is dropped | A land group that is part of the checked batch and lost the train's green is checked again on its own tree: the train's green, else a kept full pass of that tree, else a rules check of it (kept shards are reused, the others run by shard). Green: the land run is told so (`STUDIO_RULES_GREEN=1`); red: the lane is handed back as a rules red. The log says "N of M shards kept, K re-run (x min)". Only with `rules.shards` or a per-part `rules.focus`; a studio with one whole rules command keeps the old behaviour. | `299a` |
| The by-name run never widens | It runs only the stage its names came from: after a red Edit Mode stage `STUDIO_PLAY_MODE=skip` and no play filter, and no rules stage. The names also go per stage (`STUDIO_LAND_RETRY_TESTS_EDIT`, `STUDIO_LAND_RETRY_TESTS_PLAY`). `engines.<x>.byNameMin` (20): a by-name run past it is ended (`by_name_cut`) and the land run without the suspect follows; never a halving search. | `299a` |
| A lane's own new tests | When every failing test's class is declared only by the suspect lane, there is no by-name run: the land run without the lane goes at once. | `299a` |
| A mixed batch in parts | `engines.<x>.landParts` (off): lanes Play Mode cannot read land first (no play stage), the rest after, each told green from the one rules check. It splits only when the first part keeps its green cheaply (a kept full pass, or a re-check estimated at 3 minutes or less), else it lands whole and says why. | `299a` |
| The train goes first | An agent's own engine run (a worker session; never the train's, a person's, the Producer's or the Director's) does not start while the engine's train runs or lanes wait for it, and is refused on a lane that adds nothing over the target. Where the engine lands through a train it also stops at `engines.<x>.agentLandMin` (45) as "not run", not red. The porter's role file now names `npm run engine -- check` as the check before `task done --train`. | `299b` |
| The check ahead lends, it does not fix | With `rules.shards.keep: "reads"` the next train picks its batch the normal way and reuses the shard greens the check ahead left; only the shards the newly joined lanes touch run. Without reads-keyed shards the checked set is taken only when the normal pick is not larger. `rules show` says what was lent. | `299b` |
| Play Mode for a mixed batch | Paths that match `play.focus.skip` need no Play Mode of their own: when every other path matches a `play.focus.map` entry, the stage runs those fixtures plus `smoke`. Only a path that matches neither sends the stage to full. | `299c` |
| Play Mode time per fixture | `engines.<x>.play.times` (a glob for the engine's test result files): `play-plan` lists the slowest fixtures and what each map entry costs; `--propose` and the land run's log line say the expected minutes. | `299c` |
| A tool the studio allowed | One entry in `studio/allowlist.json` whose program path has a space gives the spellings a session types: quoted for the Bash tool, `& "..."` for the PowerShell tool, with `/` and `\`; the arguments stay as written. An optional third element `{ "roles": [...] }` limits an entry. A denial's key keeps a quoted program whole. The kickoff names the spelling. | `299d` |
| A tag group gets its turn | `engines.<x>.tagMaxWaitHours` (24; 0 off): a group whose oldest lane has been in its tag longer runs next, as its own train, with one untagged train between two overdue groups. | `299e` |
| Waiting lanes are tested | `engines.<x>.queueRetestHours` (6; 0 off): when the target has moved, the Line Producer tests each waiting lane against it (no checkout, no editor) and hands back one that no longer merges, with the train's words, while the work is fresh. | `299e` |
| Newer wins | `engines.<x>.merge.newer`: `[{ "file": "<glob>", "field": "<a top-level JSON field holding a date>" }]`: a conflict only in such files (and union files) takes each whole from the side whose date is later. Anything unclear stays a conflict. | `299e` |
| Long checklists | A brief shows the first 8 open items and tells the session to commit and mark one item at a time. `task.checklistSplitAt` (8; 0 off): the producer is told once to split a longer list. A hand-back with no commit and no item done says so for the next session. | `299f` |
| Asks that clear | `npm run ask -- ... --clear-when "disk>=<GB>"`: the pass that expires asks closes it as `cleared` when the condition holds. | `299f` |

## What was removed

- **Three commands no agent ever ran** in the studio's session logs (3,331 sessions) and that nothing else called:
  `npm run division`, `npm run logs`, `npm run commands-run`, with their modules and units.
- **The usage marks** (`harness/usage-functions.mjs`, `markCommandRun`, `.studio/usage/`, three `STUDIO_USAGE_*`
  settings): written on every command since 2.89 and read only by `commands-run`. The next cut reads the session
  logs, as this one did.
- The `event:sh` alias and its shell wrapper; `idleTag` and `unionGlobs` (replaced by `nextTag` and `mergeRules`);
  2.84's rule that a skip path sends a mixed batch to the full Play Mode stage; the unquoted allow rule for a program
  path with a space (it matched nothing that runs); the "always take the checked set" path of the check ahead.
- Of 165 commands, 44 were never run by an agent in those logs. The other 40 stay: other code, a gate or a workflow
  calls them, or they are the owner's and the maintainer's own tools (setup, the checks, the self-test).

## Existing checks changed on purpose

`284t` (the mixed case now expects focus), `285a` (two unmapped paths, the skip path is not named), `296d` d13 (four
groups), `260d` (the wording of a refused stop). Units `249` and `289a` went with their commands.

## Limits, said plainly

- **Nothing here ran on Windows, a real engine, a real `dotnet` or a real session before the online checks.**
- **The allow rules follow the tool's documentation, not a real session.** The documentation says rules match the
  command text as typed and that PowerShell rules have the same shape; it does not show the call operator. The first
  builder session on Windows is the test.
- **How much a dropped lane re-runs is the studio's setting.** Shards kept by what they read also count the files no
  shard takes. A lane of files outside `rules.paths` and not under `rules.ignore` makes every shard run again. A
  studio whose art and UI live beside its rules code should set `rules.paths` to what the rules tests read.
- **A by-name run is only as narrow as the studio's land script makes it.** The harness says which stage and which
  names, and ends a run that takes too long; it cannot stop a script from treating "no test matched" as "run all".
  The contract is in `docs/NATIVE-ENGINE.md`.
- **`landParts` costs one more Edit Mode stage per train** (and the script's start). It is off until a studio turns
  it on.
- **An agent's land run is not stopped when a train starts to wait**, only refused before it starts and limited in
  time: stopping an editor that may be landing is not safe.
- **The check ahead does not start a second time** for lanes queued after it began.
- **A tag now runs by itself after a day.** A tag that means "not yet" needs a hold or `tagMaxWaitHours: 0`.
- **The two-gate by-name path** (a studio with a second gate) gets neither the per-stage names nor the time limit.
- **A cancelled train can be announced twice** (seen once on Windows). Still open (P-346).

## For a studio taking it

`npm run upgrade -- --merge origin/main`, between trains. New settings are listed above; none is needed to keep
running as before, except: tag groups start after 24 hours, waiting lanes are tested every 6 hours, and an agent's
own engine run gives way to the train.
