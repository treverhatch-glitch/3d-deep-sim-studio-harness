# Skills: one job, one fail condition

A skill is a short checklist for one kind of task. Roles (`studio/roles/`) say who an agent is;
skills say how a kind of work gets finished. Each file has four parts: **When**, **Steps**,
**Done means**, **Never**.

"Done means" is not a promise in prose: `node harness/task.mjs done <ID>` runs
`harness/done-check.mjs` and refuses while something is missing. See what a task still needs with
`node harness/done-check.mjs <ID>`.

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

**Forcing.** `task done <ID> --force` finishes a task whose check failed. It is never silent: it
writes a `task.forced` event, the War Room flags it, and the Producer gets a P1
`Check forced done <ID>` task naming what was skipped. The Producer runs that check (or orders
someone to) and either accepts the work or reopens it.
