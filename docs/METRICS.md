# Measuring the crew (`npm run metrics`)

2.54.0. One row per task attempt, so time per task, tokens, retries and failures can be compared run to run
(planned update PU-02, with PU-03's failure labels). A script reading `.studio/events.jsonl`: no tokens, no model.

```bash
npm run metrics                                   # writes .studio/metrics/attempts.jsonl and attempts.csv
npm run metrics -- --since 2026-10-31T10:00:00Z   # only attempts started after this
npm run metrics -- --json                         # rows and summary as JSON
```

## A row

| Field | Meaning |
| --- | --- |
| `task`, `attempt`, `retries` | the task, which claim of it this is, and how many claims came before |
| `agent`, `model`, `family` | who held it (the model from its session record) |
| `outcome` | done, handed-back, forced, dropped, shelved, session-ended, reclaimed, or open |
| `minutes` | wall time from the claim to the end |
| `agentMin` | working: the rest after the three below |
| `checksMin` | its own `npm run verify` runs |
| `personMin` | its questions to the game dev until answered, plus time the studio was stopped |
| `stalledMin` | heartbeat gaps over 5 min (launched agents only) and stalls the watchdog ended |
| `tokensIn`, `tokensOut`, `cacheRead`, `costUsdReported` | from the session that held it, shared by time between that session's attempts. The cost is the CLI's own estimate, not a bill: a subscription login isn't charged per session |
| `sessions`, `heartbeats` | sessions counted; whether the agent sent heartbeats (a chat bot claiming tasks itself doesn't) |
| `handBacks`, `notDone`, `rescues`, `reopened` | hand-backs, done-check refusals, rescues, and reopened after done |
| `failure` | a label for every attempt that didn't end done (below) |

## Failure labels (PU-03)

Assigned by fixed rules, in this order. The first six come from the MAST taxonomy of multi-agent failures
([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)); the last four are ours.

| Label | When |
| --- | --- |
| `quota` | a usage or rate limit, or a budget stop on the tool |
| `repetition` | a burn/loop stall, or parked after repeated hand-backs |
| `lane-conflict` | lost the task lock or its lane to another agent |
| `verify-missing` | forced done, or "not done" for a missing verify |
| `no-stop` | over its task budget, or a refresh check left unanswered |
| `spec-ignored` | refused for scope, or a review said it missed the task |
| `env-harness` | the harness or the machine: a stopped studio, a flaky check, a merge refused, a stale session record |
| `premature-stop` | its session ended without a done or a hand-back |
| `verify-wrong` | done, then reopened |
| `unknown` | none matched. Aim to keep this under 15% |

## What was red at claim (PU-06)

`task start` writes `.studio/baseline/<task>.json`: the required checks that were red in the last full run, with
their failing test names. The done-check then fails a task only on checks that were green at claim or on new failing
tests. A check that was red with no test names to compare is excused with a note, so prefer checks that print them.

`npm run task -- trunk red --by <name> --why "<why>"` marks the game's trunk red (for example its GitHub CI);
the whole-game check finishing red does the same. While it's red only fix tasks start: a title starting
Fix/Bug/Hotfix/Repair/Revert, a `[fix]` or `[bug]` tag, or a whole-game red task. `npm run task -- trunk green
--by <name>` ends it; `npm run task -- trunk` shows the state.
