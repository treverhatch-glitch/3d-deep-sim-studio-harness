# Skills: one job, one fail condition

A skill is a short checklist for one kind of task. Roles (`studio/roles/`) say who an agent is;
skills say how a kind of work gets finished. Each file has four parts: **When**, **Steps**,
**Done means**, **Never**.

"Done means" is not a promise in prose: `node harness/task.mjs done <ID>` runs
`harness/done-check.mjs` and refuses while something is missing. See what a task still needs with
`node harness/done-check.mjs <ID>`. The checks read content, not just file times: a review must name
what it reviews and give a verdict, a bug needs a pinned regression that fails on the code before the fix and a lesson, a system needs a
spec with a hand-off, a scenario, goldens, a playtest and an approval from another model family, a build needs real
changes and a verify after the last one. The War Room shows the same checklist when you click an agent.

**Which verify counts (2.58.0).** Only a full `npm run verify` of the commit you are on (HEAD), run on a clean
tree: commit first, then verify, then `task done`. A verify of an older commit, one run with uncommitted changes,
or a record with no commit in it (older than 2.43.0, or written by hand) is refused with "run npm run verify
again". `task done` (not `--check`) also runs the `protected` and `secrets` checks again itself, forced or not:
a key or token in the files, or a protected file changed without the owner's signed approval, stops it.

**The size ratchet** counts only this task's own growth. Once your branch has taken in the studio's main branch
(a merge or a rebase; in a lane copy, the main checkout's branch), files are compared with the merge-base of HEAD
and main, not with the commit the task started from, so what came from main isn't yours.
An anonymous function (a long test body, a callback) is matched with its old version by the titles and calls
around it (`describe("fees") > it("charges")`), not by its line, so lines added above it don't make it new
(2.58.3); the refusal lists every grown function (past 10: the first 10, and the full list in
`.studio/size-growth/<ID>.txt`).

**What blocks task done, and what doesn't (2.58.3).** A tracked file whose only difference is line endings (a test
snapshot rewritten on Windows) never counts as uncommitted: task done, a lane copy's landing, the verify record and
`onboard --sync` name it in a note ("line endings only, ignored"); a real change, a new or a deleted file still
block. With no claimed paths, uncommitted files in the game folders block code work (change, chore, bug, system,
balance, fun); a task that isn't code work and committed no game code closes past them, and the Producer gets a
`checkout.strays` event naming them. When the last verify doesn't count, the refusal says why: your files changed
after it, main moved (which task landed when), or it was run under another name than your `STUDIO_LOCK_OWNER`.

| Type | Picked by | Skill |
| --- | --- | --- |
| change | role `builder`, `asset-3d`, or anything unmatched | [builder.md](builder.md) |
| bug | title starts with `Bug` or `Fix` (the closed loop queues `Fix BUG-…`); a `Fix`/`Bug` whose subject names the docs gate, `check-docs` or a `.md` file (`Fix: typo in docs/X.md`) is docs. The subject ends at ` — `, ` - `, `;`, `(`, `[` or a reference word (`see`, `per`, `ref`, `cf`, `via`), so `Fix: bug batch 3 — see qa/…/triage.md` is a bug | [bug.md](bug.md) |
| chore | title starts with `Chore`, `Toolchain`, `Tooling`, `Infra`, `CI`, `Deps` or `Dependencies`; `Build:` / `build(…)` or `Build` with a toolchain word (`Build fails on Windows`; `Build the stairwell` stays a change); `Fix the build`, `Fix build: …`, `Fix CI`, `Fix toolchain`, `Fix deps`; a `[chore]` tag anywhere; or `--type chore`. Done: changes and a full verify after the last one, no regression, gameplay or reach checks | [builder.md](builder.md) |
| system | title `System:`, or `--type system` | [system.md](system.md) |
| balance | role `designer-calibrator`, `balancer`, or title `Balance:` | [balance.md](balance.md) |
| playtest / fun | role `qa-playtester`, `playtester`, `fun-tester`, or title `Playtest:` / `Fun:` | [playtest.md](playtest.md) |
| study | role `reference-scout`, or title `Study:` | [study.md](study.md) |
| review | role `reviewer`, or title `Review:` | [review.md](review.md) |
| docs | title `Docs:` | [docs.md](docs.md) |
| none | role `producer` or `human` | coordination work, no check |

Queue a typed task with `node harness/task.mjs add "<title>" --type bug` (the prefix is added for you;
`--type chore` for build, toolchain, CI or dependency work). Any other `Fix …` is still a bug and needs its regression.

**Stopping early.** Any skill: if you run out of usage or are swapped, `task pause <ID> --note "…"`
hands the task back with a note the next agent sees. The watcher (run by the HUB every 5 minutes and
at session start) catches agents that stop without a word.

**Forcing.** `task done <ID> --force` finishes a task whose check failed. It is never silent: it
writes a `task.forced` event, the War Room flags it, and the Producer gets a P1
`Check forced done <ID>` task naming what was skipped. The Producer runs that check (or orders
someone to) and either accepts the work or reopens it.
