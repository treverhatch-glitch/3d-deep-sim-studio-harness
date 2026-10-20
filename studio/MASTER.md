# Master index (`studio/MASTER.md`)

The map of the studio's key documents. A new Producer (or any agent taking over) reads this, then
runs `npm run handoff` for the current state. Everything that matters lives in a file, never only
in a chat.

## Read in this order

| Document | What it holds | Who updates it |
| --- | --- | --- |
| `studio/VISION_LOCK.md` | The pillars. Changing one needs a decision record. | Producer, with a person's approval |
| `studio/game/GAME.md` | The game's fact sheet: pitch, state, pillars, engine, run commands, what agents must not touch. Written by `npm run onboard`. | A person fills in the top; rescans refresh the rest |
| `studio/PLAN.md` | The master plan: goal, where we are now, milestones, risks. | Producer, when the phase or a milestone changes |
| `studio/producer/LOG.md` | The Producer's notebook: what changed, why, what's next. Newest first. | Producer, every session (`node harness/handoff.mjs note "…"`) |
| `studio/decisions/` | Decision records: the question, the options, what was chosen and why. | Whoever proposes; a person approves |
| `studio/NEXT.md` | The task queue. | `node harness/task.mjs` |
| `studio/CURRENT_TASK.md` | The checkpoint for the task in progress. | `node harness/task.mjs` |
| `studio/memory/failures.md` | Lessons from fixed bugs, four bullets each. | Whoever fixes a bug |
| `studio/meetings/` | Notes from Producer meetings: who came, what was decided, tasks made. | `node harness/meeting.mjs` |
| `studio/handoffs/` | Notes on tasks an agent handed back (out of usage, swapped, stuck). | `node harness/task.mjs pause`, the watcher |
| `studio/memory/retros/` | Daily retrospectives: what went wrong and suggestions for the Producer to accept or reject. | `harness/retro.mjs` (the HUB writes one a day) |

## Look up when needed

| Document | What it holds |
| --- | --- |
| `AGENTS.md` | Operating rules for every agent: locks, gates, sim purity. |
| `docs/BEST-PRACTICES.md` | Recommendations, not rules. |
| `studio/skills/` | How each kind of task gets finished, and what done means. |
| `studio/roles/` | Who each agent is. |
| `studio/balance/latest.md`, `studio/fun/latest.md` | The latest sweep and fun report, waiting on a person's sign-off. |
| `studio/research/` | Studies of other games and of our own build. |
| `studio/divisions.json`, `studio/plugins.json` | Which divisions and outside tools are switched on. |
| `studio/llms.txt` | Every harness command on one page. |
| `qa/reports/`, `qa/regressions/` | Playtest reports, bug reports and the replays that keep bugs fixed. |

## Taking over as Producer

1. `npm run handoff`: the briefing (plan, last log entries, decisions, queue, claims, gates, bugs,
   sign-offs, lessons, meetings, who did what today). Saved to `.studio/briefs/producer.md`.
2. Read `studio/PLAN.md` and the newest entries in `studio/producer/LOG.md`.
3. Clear `Check forced done` tasks first.
4. Write your first log entry: `node harness/handoff.mjs note "Took over from <previous>. Plan: …"`.
5. Before you stop, write another: what you changed, why, and what the next Producer should do.
