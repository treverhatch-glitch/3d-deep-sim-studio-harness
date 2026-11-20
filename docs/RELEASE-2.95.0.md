# 2.95.0: the full rules check in shards, a playtest build in one command (`docs/RELEASE-2.95.0.md`)

The overseer's list of 2026-11-18, passed on by the owner the same evening as the last upgrade before his playtest.
Built on 2.94.0. Only this page and the one for 2.96.0 are kept; older release notes are in git history.

## What the records said

- One full run of a live studio's rules tests was one test process. It took 6.7, then 14, then 18.9 GB in one day as
  the suite grew, on a machine with 31.8 GB where a land run needs about 21 GB free. Land runs waited for memory, the
  owed full run stood in the trains' way, and 2.94's check ahead could never start. The studio had every batch check
  run in full, so each train began with 60 to 70 minutes of that one process.
- The focused check has run in parts with kept results since 2.86. The full run never did.
- A task whose queued branch waited for another task (`task after`) kept getting new porter sessions: each found
  nothing to do and queued the same branch again.
- The land script already builds a player at the end of every green land run. Nothing kept the newest one in a place
  the owner could find, with a note saying what it is.

## What changed

| | What | Proof |
| --- | --- | --- |
| A full run in shards | `rules.shards`: a full rules check is one test command per shard (the smoke filter, one per system the focus settings find, the filters listed, and `rest`), one at a time, so the peak is one shard's. Every full run is sharded: the batch's, the target's, the owed one. | `295a` |
| A green per shard | A shard with a kept green is not run again: after a red in another shard, on a retry, after a cancel, while a red batch is narrowed. Kept for the exact tree by default (`keep: "tree"`, always sound). `keep: "reads"` keeps it under what the shard reads, so a batch that touches only other shards' files keeps it; at least every `freshEveryHours` (24) a run reuses nothing from another tree. | `295a` |
| Full only with `rest` | Without `shards.rest` a test no filter matches never ran: the run is not full, the land run is told `STUDIO_RULES_MODE=focus`, and the owed full run stays owed and says why. | `295a` |
| Measured memory | `rules.peak`: the file the test command writes its own peak memory to. It is removed before each command and read after it; the number is kept per shard and replaces the 4 GB guess in the split, the check ahead, `rules-plan` and `rules show`. | `295a` |
| Systems named by files | `focus.auto` takes names from a file template (`from`) as well as from child folders, and may be a list, so system folders and per-unit files work together. | `295a` |
| The check ahead by shard | With shards, `rules.ahead` starts each shard when that shard fits beside the land run and waits when it does not. Stopped part-way and the batch landed unchanged, the finished shards are kept and the next train runs only the rest. A check ahead that does not start now says so in an event (`not-started`, with why). | `295a`, `294a` d |
| A playtest build | `npm run engine -- playtest` (`npm run playtest:build`) with `engines.<x>.playtest`: the newest green land run's build is copied into a new dated folder under one fixed folder, with `PLAYTEST.md` and a double-click shortcut there and on the Desktop. With `build` set and no train running it builds the target's tip under the train lock and the machine:heavy slot. `--if-moved` and `nightly` keep it fresh. | `295b` |
| Systems ON | `engines.<x>.switches` reads each system's switch from the engine target with git. `Systems ON: n of m` on `npm run score`, `npm run status` and `npm run studio:status`; `npm run engine -- switches` lists what is still off with the open task that switches it. | `295b` |
| No session on a held, queued branch | A task whose branch is queued for an engine train and waits for another task gets no new session, `task start` refuses it in plain words (a person can still force it), and queueing the same branch again at the same head changes nothing. | `295d` |
| Pool and agy porters, end to end | A check starts an engine porter from the API pool and one on agy against an engine lane, in a studio path with spaces, with stand-in programs that make a first write in the lane. | `295c` |
| Why a start died | `agent list` shows an ended session's refusal (else its reason), cut to 160 characters, running sessions first, then the latest ended. `agent list --json` is new. | `295c` |

## The contract for a land script (new)

After a green land run that built a player, write the executable's path as `gates.build.output` in the land result
(`STUDIO_LAND_RESULT`), with `gates.build.status` and the `commit` the run made. The harness keeps the path from then
on (`.studio/engine/<x>-land-builds.json`); builds made before the upgrade are not known to it.

## Size, said plainly

`node scripts/size-report.mjs --against <2.94>`: harness code is 866 lines larger (84,977 to 85,843), two modules more
(`playtest.mjs`, `switches.mjs`). Tests 982 lines larger (four new units). One setting name more
(`STUDIO_PLAYTEST_COMMIT`, given to the build command). This round adds; nothing was removed.

## Existing checks changed on purpose

- `294a` (d): a check ahead that memory stops from starting now emits one `not-started` event with the reason, where
  it emitted none. Everything else the check proves is unchanged.

## Limits, said plainly

- **Nothing here ran on a real engine, a real test suite, a real peak file, real agy or a real API key.** The four new
  units use stub commands and stand-in programs. On Windows they run in the online checks only.
- **The harness cannot check that `rest` is the rest.** It trusts the filter the studio writes. A sharded run with a
  wrong `rest` reports full for tests that did not run.
- **`keep: "reads"` trusts the studio's paths.** A test that reads another system's code that is not listed in
  `focus.shared` keeps a green it should not. The backstops are `freshEveryHours` and the daily full land run.
- **Parts that run at the same time share the peak file,** so none of them is read. One at a time (the default) is measured.
- **The agy allow-rule match in `295c` is the check's own small model** of how the tool reads its rules, not the tool.
- **A studio path with a space:** the git allow-rules a start builds are not quoted. Whether the real tools match them
  against a quoted path is not known. A path without spaces is not affected.
- **Playtest:** the watchdog's nightly hook, a promoted folder left because it is in use, the real Desktop folder and
  the build command's time limit are not covered by a check. A promote copies the whole build folder; `keep` (3)
  bounds the disk it takes. While `playtest.build` runs it holds the train lock, so `train status` shows `playtest-build`.
- **P-370 stays open:** a train cancel run from a cut-down environment on Windows could not read the process list.

## For a studio taking it

`npm run upgrade -- --merge origin/main`. Nothing changes until a setting is added. In this order:
1. `rules.peak`, once the test run writes its peak. No risk: it only replaces a guess with a number.
2. `rules.shards` with `rest`, `keep: "tree"`. Watch `rules show` and the first trains' `engine.rules` events
   (`meta.shards`), and the memory during a full run.
3. `rules.ahead` (2.94) once a shard fits beside a land run; count `task.train.<x>.rules_ahead` outcomes.
4. `engines.<x>.switches` and `engines.<x>.playtest`; run `npm run engine -- playtest --dry-run` first.
