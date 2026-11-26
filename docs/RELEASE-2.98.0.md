# 2.98.0: keep the line full and stop losing hours (`docs/RELEASE-2.98.0.md`)

The overseer's brief of 2026-11-24 (17 items), written after the studio on record had run 2.97.0 for three days, with
the owner's order for this code base: keep it organised and take out what is no longer needed, is a duplicate, or is
replaced by what goes in. Built on 2.97.0. Only this page and the one for 2.99.0 are kept; older release notes are in
git history.

## What the records said

- 2.97 worked: with the check ahead and kept shards a train often started with 37 to 41 of 41 shards green; 8-lane
  batches landed green many times; narrowing by name found a real red in a few steps.
- The daily full land run hit its 4-hour limit five times in a row and ran again at once each time.
- Three rules parts built one project in one checkout at the same moment; a locked file made two trains red and a task
  was handed back for nothing.
- A running train ignored changed settings. Lanes that changed nothing landed. Unit tasks were closed by their first
  landing. One slow lane at the head held fourteen quick ones for two hours. Tagged lanes waited three days.
- The main tool was marked out for four days from a session that never reached the model.
- Free disk fell to 48 GB twice; the size shown was ten hours old.

## What changed

| | What | Proof |
| --- | --- | --- |
| The full land run in parts | `engines.<x>.fullLand`: `{ "parts": [...], "partTimeoutMin": 60, "backoffHours": 12 }`. One land run per part with `STUDIO_LAND_FULL=1` and `STUDIO_LAND_PART=<name>`; the land script decides what a name runs. Each part has its own limit and its own measured memory (kind `... part-<name>`). Without `parts`: one whole run, with the same back-off. | `298a` |
| A result per part | A part that passed on the target's tree is not run again; a full pass is every part green on one tree. A red part ends the run as a red full run does. | `298a` |
| Back off, never loop | A part that hits its limit or ends with no test result is a try: the next is not before `backoffHours`. With lanes waiting, an overdue run takes one part at the end of a train. `train status` and `rules show` say when the next try is due. | `298a` |
| Build once | `rules.build` (default for `dotnet test`: the same command as `dotnet build`): one build per checkout, then every part, shard, by-name run and the first tests with `--no-build`. `rules.testAfterBuild` (`"{command} ..."`) for another tool; `rules.build: false` keeps the old way. A failing build goes to the compile search, not the test narrowing. | `298c` |
| A build fault is not a red | Output matching `rules.infra` (defaults for dotnet: `error CS2012`, `MSB3021`, `MSB3026`, `MSB3027`, "being used by another process", "locked by") is run again once, alone. Twice: "not judged": no lane is narrowed, blamed or handed back; the batch stays queued. | `298c` |
| Config at each step | The engine train reads `engines.<x>` again before the batch, the compile search, the rules check, each round, each land run and the full run, and logs a change in one line. | `298b` |
| An empty lane is refused | A lane whose merge adds nothing over the target is refused at the door and in the chain ("empty lane: nothing to land"); its task stays open. | `298b` |
| Quick lanes first | `engines.<x>.batchSkipFirst` (4; 0 off): a full-class head with that many skip-class lanes behind it is passed over, twice at most. | `298b` |
| Tag groups when idle | `engines.<x>.tagsWhenIdle` (true): with no untagged lane waiting, the Line Producer starts a train for the tag whose oldest lane waited longest, before any full run. | `298b` |
| A checklist | `task checklist <ID> add|done|skip|list`, `task add ... --checklist-file`. With open items every landing is a slice; the task closes when none is open, or with `--final`. `task show`, `task list` and the brief show "7 of 12 done". | `298e` |
| Child tasks | `task split <ID> --every <n> --by <name>`: the open items become child tasks, each with its own lane; the parent starts no session meanwhile and closes when its last child does. | `298e` |
| Quota marks on evidence | A limit line marks a tool out when its session reached the model, or on a second stop within 15 minutes; else "suspected". The window is the text's own, else 5 hours, a week only when the text says weekly or names a date. `npm run budget` and the brief status say what is marked, until when, and what is suspected. | `298f` |
| agy on an engine worktree | Default rules add `write_file` for the session's lane copy and engine worktree (`{own}`), and `show`, `rev-parse`, `merge-base`, `ls-files`, `grep` on the worktree with plain-word arguments (no `-O`, `--output`, `--no-index`, quotes, globs, redirects). A template that writes anywhere else is dropped. | `298f` |
| The pool takes the task's role | `agent start --pool api --task <ID>` with no `--role` starts an engine porter with its worktree when the task is an engine task. | `298f` |
| Each part's own peak | The split plan, the shard plan and admission take a part's memory from its own kind's passed runs of the last `machine.peakDays` (7); an unmeasured part takes its siblings' largest and the plan says so. | `298d` |
| A part that slowed down | `rules show` and `test-cost` name a part whose last run took more than twice its median and 5 minutes more, with its slowest tests when `rules.times` has them. | `298d` |
| Inputs no pin uses | `rules.pins`: `{ "file", "key", "folder": ".../{pin}/" }`: files under another pin's folder are left out of the inputs' print. | `298d` |
| Disk | `disk`: `{ "pruneUnderGb": <n>, "idleHours": 1 }`, off until set: landed, clean, idle copies with no live session, claim, hold or queue entry are removed oldest first until free disk is over the line; each removal and each refusal names its reason. The lane-copies size is measured when shown and carries its age. `train cancel` removes its rules checkouts. | `298g` |
| A session's record | One atomic writer (`writeSession`, `patchSession`) in place of nine in-place writes; a record that exists but cannot be read is a busy name, never a free one. | `298h` |

## What was removed

- **The whole-machine memory learning**: `recordLandPeak`, `readUsedHistory`, `peakFromHistory`, `learnedNeed`, the
  `<engine>.peaks` store, `measuredPeakGb` and the overlap tracking around it. Every run is sampled by kind since 2.96.
- **`rules.peak`** is no longer read (`rules show` says so; a config that still sets it runs). The land floor of a kind
  with no sampled run is the table's, no longer a learned number.
- The path that ran a whole full land run again after a timeout; the copies of the config a train took at its start;
  the second "this landing is a slice" branch and a duplicated board move in `task.mjs`; the cached lane-copy size and
  its capped walk; two places that wrote a quota mark by hand.
- The clean-up pass after the merge: see the handoff for its counts.

## Existing checks changed on purpose

`284u` (its tag block sets `tagsWhenIdle: false`), `2791b` 3.2 and `297c` c1, c3 (the land floor from sampled runs, the
table as fallback), `295a` b2, g1, g2, h, i, j and `296d` d8, d8b (no peak file), `296a` a12 (wording), `270w` (the size
line carries a unit and its age), `293b` b (a write rule names the lane copy), `296e` e4 (the smoke's start line).

## Limits, said plainly

- **Nothing here ran on Windows, a real engine, a real `dotnet` or a real agy before the online checks.**
- **What a full-run part runs is the studio's land script's.** Until it honours `STUDIO_LAND_PART`, set no `parts`: the
  whole run then has the back-off, but still one process.
- **A second lane under one task id was not built** (about 150 places key engine work by the task): `task split` is
  the road. Two children that edit one file meet at the queue door's compile check, not earlier.
- **A check ahead still does not start beside a running rules check.**
- **A real limit on a tool now costs one extra failed start** before the mark, when the tool reports zero usage.
- **agy's older `log` and `diff` rules still let `--output` and a redirect through** (2.93). The new read verbs do not.
- **Disk pruning is off until `disk.pruneUnderGb` is set.** A killed train's checkouts wait for the 24-hour pass.
- **`tagsWhenIdle` is on by default**: a tag that means "not yet" needs a hold (`task hold`) or `tagsWhenIdle: false`.
- Six modules still read a session's record with a plain read; the atomic writer is what protects them.
- **Caught in the online runs:** `task done` printed the task as in progress after closing it (the shared closing
  helper marked a fresh copy); the machine scan wrote the lane-size cache, which the upgrade preflight must not;
  a new check expected `dotnet build` where Windows runs `dotnet.cmd`. All three fixed before the merge.
- **A cancelled train can be announced twice** (the cancel command's event and the train's own), seen once on
  Windows. Open (P-346).

## For a studio taking it

`npm run upgrade -- --merge origin/main`, between trains (it fetches by itself since 2.97). An uncommitted change in
`harness/` blocks the merge: put it away first. New settings are listed above; none is needed to keep running as
before, except that tagged lanes now start by themselves when the queue is empty.
