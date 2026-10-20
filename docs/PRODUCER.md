# Producer Checklist

- Assign non-overlapping file sets when multiple agents are active.
- Use the cheap-model prepare step for long histories or messy context.
- Go straight to a strong model for short, already-clear tasks.
- After 3 failed fix attempts on the same bug, escalate to a stronger model or a human.
- Enforce the concurrent work rule: only one agent edits a given file at a time.

## Starting a session

`npm run handoff` prints the briefing and saves it to `.studio/briefs/producer.md`: the plan, the
last log entries, decisions, what needs you first (forced checks, escalations, red gates), the
queue with who holds each task, claims, gate and playtest results, the last failing seed, open
bugs, sign-offs waiting on a person, lessons, meetings, and who did what in the last 24 hours.
It reads files only, so it costs no tokens and works the same for any model.

## Switching Producers

The role can move between models and tools (Grok, Claude, Hermes, Cursor, a person). The new
Producer gets no chat history, so everything it needs must already be in files:

| What a new Producer needs | Where it lives |
| --- | --- |
| The goal, current phase and milestones | `studio/PLAN.md` |
| Why things were decided | `studio/producer/LOG.md`, `studio/decisions/`, `studio/meetings/` |
| What to read and in what order | `studio/MASTER.md` |
| The current state | `npm run handoff` |

Outgoing Producer: `node harness/handoff.mjs note "Handing over: …"` with what you were in the
middle of. Incoming Producer: run the handoff, read the plan and the newest log entries, clear
"Needs you first", then write your first note.

## What reaches you, and what doesn't

The Producer is the most expensive seat, so only decisions should reach it:

| Who handles it | What |
| --- | --- |
| The router (automatic) | A provider or key runs out mid-call: fails over to the next one |
| The watcher (`npm run watch`, a script) | Claims that expired: work goes back to the queue with a note. Silent agents, unclaimed handed-back work and provider outages: one `Watch:` task for you |
| The agent itself | Handing a task back with `task pause --note` when it runs out or is swapped |
| You, the Producer | `Watch:` and `Check forced done` tasks, meetings, the plan, who does what next |
| The person | Design, balance, money, releases, anything that can't be undone |

## Meetings

`node harness/meeting.mjs start "<topic>" --with builder,qa-playtester,designer-calibrator`
gathers several agents at once (role names work; they resolve to whoever is doing that role).
`say "<text>" --agent <name>` records remarks, and `end --decision "…" --action "title|role|P2"`
writes the decisions, turns actions into tasks and adds the outcome to the Producer log. Notes go
to `studio/meetings/`. In the War Room's Studio view everyone walks to a table in the meeting room
and goes back to their desks when it ends.

