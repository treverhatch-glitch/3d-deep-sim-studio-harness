# 2.94.0: the next batch is checked while the current one lands (`docs/RELEASE-2.94.0.md`)

The owner's three answers of 2026-11-18, to the questions 2.93 left open: yes to a rules check beside a land run, yes
to removing the old status snapshot, and "up to you" on what the scorecard calls landed. Built on 2.93.0. Only this
page and the one for 2.93.0 are kept; older release notes are in git history.

## What the records said

An engine train in a live studio is one rules check (about an hour of tests) and then one land run (one to two hours
in the engine's editor). Through both, the lanes queued for the next train wait and nothing about them is checked.
With trains back to back, each one starts with an hour that could have run during the land run before it.

## What changed

| | What | Proof |
| --- | --- | --- |
| The check ahead | `engines.<x>.rules.ahead: true` (off by default). While a green batch's land run runs, the lanes the next train would take (the train's own selection, now one function used by both) are merged on this batch's checked head, and the rules check runs there as the next train's would: same mode, filters, `first` and time limit, the batch only. | `294a` b |
| The land run always wins | The check ahead starts only after the land run holds its machine:heavy slot, and only while free RAM minus the floor holds what one rules run takes (`focus.splitGb`, else the largest measured peak, else 4 GB). Never with a second gate in use, once per train at most. A land run that dies out of memory ends it first, then gets its one retry without it. | `294a` d |
| Kept only when it is true | When the land run lands the batch unchanged, the result is kept under the key the next train asks for. Anything else (red, a lane handed back, a search step, a moved target, `train cancel`) ends it with its whole process tree and forgets what it kept. | `294a` c, g |
| The next train | It takes the set that was checked ahead when every lane in it is unchanged (lanes queued since ride the train after), finds the kept result and goes to its land run; its rules log line says where the answer came from. A check ahead still running for exactly that tree is waited for, so the tests run once. | `294a` b, e |
| A red ahead judges nobody | It is a red for that tree and nothing more. The next train's own check asks the target, as 2.93 does, and only then hands a lane back. | `294a` f |
| Seen by people | Event `task.train.<x>.rules_ahead` (`started`, `kept-green`, `kept-red`, `dropped`, with why); `train status` shows "Checking the next batch ahead: ..., since N min". | `294a` e |
| Off is 2.93 | With `rules.ahead` unset: no file, no event, no log line, one rules run per train. | `294a` a |
| "Landed" on the scorecards | `npm run score`, the health report, the morning line and the brief count as landed only work that went through a train (web or engine). Tasks closed with no landing in the window are a second number: `landed: 3; closed without a landing: 2`. A studio with no train at all reads `closed: N`, not "landed". `--json` gains fields; none is renamed. | `294c` |

## What was removed

- **The old status snapshot** (`harness/status.mjs`, 280 lines) and **the role loader** behind `npm run agents`
  (`harness/agents.mjs`, 204 lines). No studio on record ran either. The role files in `studio/roles/` stay; the
  modules that use them read them directly.
- `npm run status` now prints the brief that `npm run status -- --brief` printed, with the same flags; `--brief` is
  still accepted.
- With them: the exports `machineCard` and `staleLanesCard` (only the snapshot called them), and the one setting
  that named its usage file. `.studio/usage.json` is read by no command now.

## Size, said plainly

`node scripts/size-report.mjs --against origin/main`: harness code is 229 lines smaller (85,205 to 84,976) with the
check ahead in it (about 245 lines), one module fewer (333 to 332). Scripts unchanged. Tests 325 lines larger (two new
units). One setting fewer.

## Existing checks changed on purpose

- `268m` and `270w`: the parts that read fields of the removed snapshot are gone (its machine and stale-lane cards);
  what they prove about the brief, the digest and proposals is unchanged.
- `2653a`, `276j`, `270v`, `265p`: they start the brief through its own file where they started it through the
  removed one. What they assert is unchanged.
- The rules check ahead and the scorecard change needed no change to an existing check.

## Limits, said plainly

- **Nothing here ran on a real engine.** The check ahead is the largest change to the train's flow since batches,
  and its first real runs are in a studio. That is why it is off by default.
- **Memory is a guess until measured.** With no recorded peak the harness assumes 4 GB for one rules run; a real test
  process can take several times that. A studio should set `focus.splitGb` to what it has seen before turning this on.
- **Not covered by a check:** the out-of-memory path (the land run dies, the check ahead is ended, the retry), and a
  train process that is killed outright while the check ahead runs (the next train ends what it finds). Ending the
  check ahead's process tree on Windows is run by the online Windows checks only.
- **Caught before the merge:** on Windows the check ahead ended with the train that started it (P-369); it is now
  started detached on every system. The cancel check then failed twice on Windows because its helpers lacked Windows'
  own system variables and the process list timed out (P-370, open: why the harness's own fill-in did not suffice).
- **It is pure cost when the landed tree is not the checked tree:** a land script that commits files outside
  `rules.ignore` and `rules.paths`, a lane dropped by the next train's own pre-queue check or compile search, or new
  shared input files (`rules.share`). The result is then not used and the next train checks as before.
- **The autonomy badge still counts closes** in its "landed" (its bars were set on that number). Unchanged on purpose.

## For a studio taking it

`npm run upgrade -- --merge origin/main`. Nothing changes until `rules.ahead` is set. Before setting it: `rules.ignore`
must cover what the land script commits, and `focus.splitGb` should be the real size of one test process. Then watch
the first trains: the "check ahead" log lines, free memory during the land run, and `minutes.rules` on the next train.
