# 2.96.0: measured memory and CPU, each test once per tree (`docs/RELEASE-2.96.0.md`)

The overseer's brief of 2026-11-20 (16 items) with the owner's direction: make the harness use 32 GB well before the
machine gets 64. Built on 2.95.0. Only this page and the one for 2.95.0 are kept; older release notes are in git history.

## What the records said

- A green rules check took 87 to 90 minutes. Red ones took 169, 316 and 413: every narrowing step re-ran the whole
  80-minute suite though the failing test was known after the first run.
- One lane that waited for another task stood at the head of the queue through four trains. Each time it set the
  batch class, took a seat and was deferred, while thirteen lanes of the other class waited; one for over 30 hours.
- A batch one lane larger than `rules.maxLanes` was checked in slices, and a sliced check never told the land run it
  was green: the land script then ran the whole suite itself.
- Heavy work was admitted by slots and fixed claims. Nobody had measured what a land run or a shard really takes. A
  sampler made by hand first blamed the wrong test: it summed every test process on the machine. The real spike
  (14.2 GB in one fixture) was found from the test run's own per-fixture table.
- Four wiring tasks that each add lines to the same registry list took four trains: every pair conflicts.
- Three upgrades were merged while a train was running, two of them from a branch whose checks had not finished.

## What changed

| | What | Proof |
| --- | --- | --- |
| Every run is sampled | A land run, a rules command (whole, part or shard), a compile check and a quick test are sampled about every 10 s: the machine's free RAM, commit charge and CPU, and the working set and CPU of that run's own process tree. One helper per run on Windows, `/proc` on Linux. Samples per run under `.studio/engine/<x>-samples/`. | `296a` |
| A cost per job kind | Peak, CPU, minutes and when the peak comes, per kind (`land no-rules`, `land with-rules`, `rules <shard>`, `quick`...), in `.studio/engine-ram.json`. A kind's need is its peak over the last 5 runs plus a margin. | `296a` |
| Admission by reservation | `"machine": { "admit": "measured" }` (off by default): a job starts when free RAM minus the floor minus what running jobs still have to grow holds its own need, and CPU stays under `cpuCapPct` (85). A missing, stale or doubtful number falls back to the old rule. Two heavy peaks never overlap on 32 GB and do on 64 GB when they fit. | `296a` |
| Overlap that does not pay | A pair of kinds that is more than `slowerPct` (10) slower together than alone, after three runs each way, is not run together for a day, with one event. | `296a` |
| Narrowing by the failing tests | A red rules check narrows by running only the failing tests (`rules.byName`; on by itself for `dotnet test`), minutes a step. One whole check on the lanes left decides. | `296b` |
| One green per tree | A whole green for a tree is used by the owed full run, the check ahead and the land run (`STUDIO_RULES_GREEN=1`), also after a lane was dropped. | `296b` |
| A sliced check ends whole | After slices by `rules.maxLanes`, the lanes left are checked once as one tree, so the land run is told. `rules show` warns when `batchMax` is above `maxLanes`. | `296b`, `284t` |
| The lane from the failure's words | `blame` entries may read a name out of the failure message (`names`) and use `{name}` in `touches`. Without a rule, a failing test one system's filter takes makes the lanes that change that system the first suspects. | `296b` |
| Count ratchets | `rules.ratchets`: a lane that trips one is handed back with kind `ratchet` and words that say it is not a behaviour regression. It is still handed back. | `296b` |
| Held lanes | A queued lane whose task waits for another is left out before the batch is picked: no class, no seat, listed once in `train status`. A hold set after the train started counts until the land run. A lane that cannot go no longer decides the batch. | `296c` |
| List files merge as a union | `engines.<x>.merge.union`: a conflict only in listed files where both sides only added lines is merged as the union; anything else stays a conflict. | `296c` |
| Landings post themselves | Each engine-train landing is one message on the studio's webhook: tasks and titles, the 24-hour count, the progress line, Systems ON. `engines.<x>.announce: false` turns it off. | `296d` |
| What the tests cost | `rules.times` (a `.trx`, NUnit or JUnit file) and `rules.memory` (a table the test run writes): `npm run engine -- test-cost` lists the slowest tests, tests run twice in one train, the most memory, ratchet trips; the digest gets two lines. | `296d` |
| Play Mode map gaps | `npm run engine -- play-plan --propose` groups unmapped paths and proposes entries; the digest says how often Play Mode ran in full for them. | `296d` |
| A busy line | The refill counts tasks that can start, not tasks that are open, and wakes the Producer with the cause. | `296d` |
| A smoke start for every pool | `npm run agent -- smoke --role <role> [--pool api] [--tool <t>]`: one real start on a throwaway task; it reports lane, first commit and why a start died, then cleans up. It spends real tokens. | `296e` |
| The spending order for porters | `STUDIO_BUILDER_ORDER_ROLES=builder,engine-porter` lets engine porters follow `STUDIO_BUILDER_ORDER`. Unset, as before. | `296e` |
| An upgrade waits for the train | `npm run upgrade` refuses while a train runs (`--during-train` for a person who means it) and says so when the ref is not main. | `296e` |

## What was removed

- `harness/session-report.mjs` (it fed the War Room, gone since 2.80) with its script and check; the exports
  `autonomyCard` and `HARNESS_TRAILER`, used nowhere. `unused-exports` now prints `DEAD 0`. 42 names left the settings baseline.
- Looked for and not found: dead modules. Of 96 files a live studio never loaded in five days, every one is imported
  by something that runs or is a documented command. Exact-copy helpers across files add up to about 46 lines.

## Size, said plainly

`node scripts/size-report.mjs --against <2.95>`: harness code is 1,497 lines larger (85,843 to 87,340), six modules
more. Tests 1,404 lines larger (five new units). One setting name more. This round adds far more than it removes.

## Existing checks changed on purpose

- `284t`: a sliced batch now ends with a whole check and lands green. `294a` (c): a check ahead that is ended keeps its
  exact-tree green. `293c` section 2: a held lane gives a `held` event, not a deferral.
- `230j`: the check of the removed session report is gone. `2652a`, `266a`: one unused setting left their environment.
- `qa/selftest.mjs` near line 1217: "two builders without lanes never run at once" waits until one agent is live and
  then watches a window, where it counted after a fixed 5 seconds (P-346). It asserts the same rule.

## Limits, said plainly

- **Nothing here ran on a real engine, a real test suite, real agy or a real API key.**
- **The Windows sampler** runs for real only in the online Windows check added for it (`296a` a18). On a studio's
  machine it is new: one PowerShell helper per run longer than one interval. `"machine": { "sample": false }` turns it off.
- **Measured admission is off by default** and has never decided anything on a real machine. With it on, each wait
  re-reads the samples files every 2 s.
- **A filtered run never calls a batch green and never hands a lane back alone;** the "no test ran" detection reads
  `dotnet test`'s and NUnit's wording.
- **Narrowing a red LAND run by name** is only what 2.86 already did where the land script honours a probe.
- **The union merge cannot know meaning:** two lanes adding the same key with different values both stay. Not covered
  by a check: the union inside the queue's compile check, the re-pick limit, CRLF files.
- **The smoke start's agy kind and real kickoff text are untested.** P-373 (unquoted git rules for a path with a
  space) and P-370 (train cancel from a cut-down Windows environment) stay open.

## For a studio taking it

`npm run upgrade -- --merge origin/main`, between trains (it now refuses during one). On by itself after the upgrade:
sampling, narrowing by name for `dotnet test`, the whole check after slices, held lanes left out, landing posts where
a webhook is set, the refill's new count. Needs a setting: `machine.admit`, `merge.union`, `rules.ratchets`,
`rules.times`, `rules.memory`, `blame[].names`, `STUDIO_BUILDER_ORDER_ROLES`.
