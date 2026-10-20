# Skills: one job, one fail condition

A skill is a short checklist for one kind of task. Roles (`studio/roles/`) say who an agent is;
skills say how a kind of work gets finished. Each file has four parts: **When**, **Steps**,
**Done means**, **Never**.

"Done means" is not a promise in prose: `node harness/task.mjs done <ID>` runs
`harness/done-check.mjs` and refuses while something is missing. See what a task still needs with
`node harness/done-check.mjs <ID>`. The checks read content, not just file times: a review must name
what it reviews and give a verdict, a bug needs a pinned regression and a lesson, a build needs real
changes and a verify after the last one. The War Room shows the same checklist when you click an agent.

| Type | Picked by | Skill |
| --- | --- | --- |
| change | role `builder`, `asset-3d`, or anything unmatched | [builder.md](builder.md) |
| bug | title starts with `Bug` or `Fix` (the closed loop queues `Fix BUG-…`) | [bug.md](bug.md) |
| balance | role `designer-calibrator`, `balancer`, or title `Balance:` | [balance.md](balance.md) |
| playtest / fun | role `qa-playtester`, `playtester`, `fun-tester`, or title `Playtest:` / `Fun:` | [playtest.md](playtest.md) |
| study | role `reference-scout`, or title `Study:` | [study.md](study.md) |
| review | role `reviewer`, or title `Review:` | [review.md](review.md) |
| docs | title `Docs:` | [docs.md](docs.md) |
| none | role `producer` or `human` | coordination work, no check |

Queue a typed task with `node harness/task.mjs add "<title>" --type bug` (the prefix is added for you).

**Stopping early.** Any skill: if you run out of usage or are swapped, `task pause <ID> --note "…"`
hands the task back with a note the next agent sees. The watcher (run by the HUB every 5 minutes and
at session start) catches agents that stop without a word.

**Forcing.** `task done <ID> --force` finishes a task whose check failed. It is never silent: it
writes a `task.forced` event, the War Room flags it, and the Producer gets a P1
`Check forced done <ID>` task naming what was skipped. The Producer runs that check (or orders
someone to) and either accepts the work or reopens it.
