# 2.92.0: bad news at the queue door, not hours later (`docs/RELEASE-2.92.0.md`)

The owner's order of 2026-11-17: upgrade the harness, and take lines away where that is right. Built on 2.91.0. Only
this page and the one for 2.91.0 are kept; older release notes are in git history.

## What the records said

One more night of a live studio's engine trains on 2.90 (2.91 was merged but not yet taken there):

| What happened | Cost |
| --- | --- |
| Two trains in a row handed back 6 of 12 branches because they did not compile together. The compile search found them in two minutes, but only when the train started, hours after each porter had queued and its session had ended. | 6 tasks picked up cold |
| A branch passed its check before queueing, three other branches landed, and the merged tree failed the same test in the train. The check had judged the branch alone. | one train's first step, one hand-back |
| A source file used a namespace its assembly did not reference. The quick compile does not build the editor's assemblies, so a land run went red in the editor's compile. The search then tried a different branch alone first. | two land runs, about two hours each |
| The rules check was red on the target itself. No branch was blamed, rightly, and nobody was asked to fix it, so the next train lost its rules check too. | every train until someone noticed |

## What changed

| | What | Proof |
| --- | --- | --- |
| The check before queueing | `preQueue` commands run on the branch merged with the target's tip (`STUDIO_TARGET_COMMIT`). A merge that conflicts refuses the queue and names the files. The queue keeps the tip the check passed on; a train that starts on another tip runs it again, before the compile search, and hands back only that branch. | `292a` A |
| The compile search at the queue door | With the compile search on, `task done --train` compiles the branch merged with the target (red: not queued, with the compiler's lines), then with the branches queued ahead of it. A clash with a queued branch does not refuse: the branch is queued, the porter is told now which branch and which lines, and trains keep the two apart until the other has landed or left. Bounded (`STUDIO_QUEUE_COMPILE_RUNS` 6, `STUDIO_QUEUE_COMPILE_MIN` 10); any failure of the check itself queues as before. Event `task.train.<x>.queue_compile`. | `292a` B |
| A red compile names its branch | `engines.<x>.logs`: the engine's own log files. After a red land run their compiler error lines are read with the run's output. When each named file is changed by exactly one branch of the batch, those branches go back at once (cause `compile`) and the rest run again, with no halving search. Otherwise the search as before. | `292a` C |
| A red target gets a fix task | When the target is red by itself (the rules check, the daily full land run, the owed full rules run), the harness files one task, `Fix: <target> is red by itself on <n> rule test(s): ...`, once per distinct red, and `train status` shows it. `STUDIO_ENGINE_TARGET_RED_TASK=off`. | `292b` |
TIMINGROW

## Size, said plainly

The owner asked that the harness not grow. `node scripts/size-report.mjs --against origin/main`: harness code
SIZELINE. What was looked for and not found:

- **Dead files: none.** Every module is imported, run by a command, a hook or the online checks.
- **A tool that was planned and not built:** a "which units cover this change" command. The self-test already has
  it (`npm run selftest:changed`, 2.81). About 150 lines not added.
- **Two maintainer scripts considered for removal and kept:** the settings census and the size report. They were
  written for this work and had gone unused by the maintainer; this page uses the second.
- **Unused by the one studio on record, but wired into other code:** an older way to split work ("floors", 190
  lines), an overnight summary that overlaps the daily digest (97), an older status snapshot with its role loader
  (about 480), a second scorecard (421). Removing one is a feature decision for the owner, not housekeeping.

## Existing checks changed on purpose

`283b` (3b) and `284t` (compile first, red): the cause they assert for a branch handed back on a compiler's error
line is now `compile`, not `evidence`. Everything else they assert is unchanged.

## Limits, said plainly

- Nothing here ran on a real engine from the harness's side.
- Not tested: a queue-door clash with more than one partner; `engines.<x>.logs` at its 4 MB cap; a Windows path in
  an engine log file (only in the land run's output).
- `engines.<x>.logs` needs the studio to name its log files; without it only the land command's own output is read.
- The red-target task is added through `task add`; a session that may only propose (a builder's shell) cannot file
  it, and that is one warn event.

## For a studio taking it

`npm run upgrade -- --merge origin/main`. Set `engines.<x>.logs` to the editor's log files of a land run. The
queue-door compile needs `quickCheck`, as the train's compile search does.
