# Threads, pass-through and the trigger table (2.64.0)

A running task can now receive follow-ups. A red CI run on its commit, its lane handed back by the merge
train, or a message tied to it lands in **that task's inbox** instead of only in the event log or the next
session's hand-off notes. Anything that matches no task goes to the Producer's inbox, the same as before.

Shadow mode is the default. It logs where each event *would* go and delivers nothing. Switch it on
(for CI and merge-train events first) only after you've checked a sample of what shadow mode logged.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Thread index | `.studio/threads.json` (`harness/threads.mjs`) | Maps exact keys to tasks. Code builds it from events. |
| Trigger table | `studio/triggers.json` | For each source, a policy: `respond`, `candidate` or `ignore` |
| Task inbox | `studio/handoffs/<ID>.inbox.md` | One line per follow-up: the time, the source, short text, a reference and the event id |
| Notice | `.studio/inbox-notice/<agent>.json` and `.claude/hooks/inbox-notice.mjs` | Tells the session holding the task, once, at its next tool call |

## Keys (exact matches only)

| Key | Learned from |
| --- | --- |
| `task:T-123` | the task id itself (when it is on the board) |
| `branch:lane/<agent>-<stamp>` | `.studio/lane-branches.json`, `task.train.queued`, `lane.copy` |
| `sha:<40 hex>` | the head a lane queued (`task.train.queued`), the commit a train landed (`task.train.landed`) or refreshed pins in, and the `Studio-Task` trailer of the commit CI ran on |
| `train:<id>` | a merge train's lanes (`task.train.start`) |
| `brief:B-001` | the Producer task a confirmed Liaison brief made (`task.added` meta.brief) |
| `ask:A-001` | the task its asker holds when the answer comes (`ask.open`), or the Producer task of a reversal |
| `away:AW-3` | the task an away item is about (`away.verdict`) |
| `wave:W-2` | the tasks in a fun-check wave (`wave.joined`) |
| `bug:BUG-…` | the closed-loop bug's fix task (`Fix BUG-…` in its title) |
| `discord:<message id>`, `pr:<n>`, `issue:<n>` | linked by hand: `npm run thread -- link <key> <ID> --by <name>` |

Nothing is guessed: there are no similar titles and no fuzzy matches. If no key matches, the event goes to the Producer.
An event whose matched tasks are all done also goes to the Producer, with a note saying so. Example: CI red on
`main` after a train landed T-12 and T-14.

## The trigger table (`studio/triggers.json`)

- **respond**: if the event matches a task, it goes into that task's inbox, and the session holding the task
  hears about it at its next tool call.
- **candidate**: if the event matches a task, it goes into that task's inbox with no notice. The session reads
  it in its brief or with `inbox`.
- **ignore**: the event is dropped.

With either `respond` or `candidate`, an event that matches no task goes to the Producer: one line in
`studio/producer/INBOX.md`, which the Producer reads at its next start. Entries under `types` override the
source's policy for a single event type. Defaults: a CI failure responds and a CI green is ignored. For the
train, a dropped or partial lane responds, while a red train, a deferred lane, a red `main` and a flaky
train are candidates. Every other train event (start, verify, pins, landed, done) is ignored. Hub, Discord
and GitHub are candidates.

Sources: `ci` (ci-watch), `train` (`task.train.*`), `hub` (the War Room's `/api/inbox` with a task, ask
answers, away verdicts), and `discord` and `github` (`npm run thread -- post`).

**Pass-through never adds a task and never edits the board.** The Producer is still the only writer to the
live queue. Gates, the train, locks and protected files are unchanged.

## Modes

`STUDIO_THREADS` (or `"mode"` in the table) can be set to:

- `shadow` (the default): logs `thread.would_route` and `trigger.would_drop` events and delivers nothing.
- `on`: routes the sources listed in `"live"` (`ci` and `train` by default). The other sources stay in shadow
  until you add them to the list.
- `off`: does nothing.

To check shadow mode, run `npm run thread -- shadow-report --sample 50`. It prints the counts and an even sample
across the period. For each line, check whether the task is right, or whether it should have gone to the
Producer or been dropped. The plan's bar for turning it on: at least 95% of the sample routed correctly.

## Commands

```bash
npm run thread -- status                         # mode, live sources, policies, number of keys
npm run thread -- sweep                          # route the events since the last sweep now
npm run thread -- resolve <key>                  # which task a key belongs to
npm run thread -- inbox T-123 [--peek]           # read a task's inbox (marks it read)
npm run thread -- link discord:<id> T-123 --by <name>
npm run thread -- unlink discord:<id> --by <name>
npm run thread -- post <key> "<text>" --source discord|github|hub --by <name> [--ref <id>]
npm run thread -- shadow-report [--sample 50]
```

`link`, `unlink` and `post` accept a Producer or Director session, an agent outside the harness (a chat bot)
or a person. They never accept a worker: not a builder, QA or other launched worker session, and not a
worker's name in `--by` or `STUDIO_LOCK_OWNER` (the `harness/permission.mjs` rules). `link` takes only
`discord:`, `pr:` and `issue:` keys, and only to an open task. Code builds the other keys.

The War Room's `POST /api/inbox` takes an optional `task` (or `thread` key). If threads are on and `hub` is
live, a message for an open task goes into that task's inbox. Otherwise it reaches the Producer exactly as
before. The hub token rule is unchanged.

## When it runs, and what reaches a running session

- **Routing** happens at each launcher heartbeat (every 2 minutes), when a task's brief is written (`task
  start`), on `npm run thread -- sweep`, and immediately when ci-watch finishes or a message is posted. The
  first sweep only learns keys from history and routes nothing old, so turning this on doesn't replay the past.
- **A running Claude Code session** learns about a `respond` follow-up through the PostToolUse hook
  `.claude/hooks/inbox-notice.mjs`. After its next tool call it gets one line: how many follow-ups there are and
  the command to read them, never the text itself. A session waiting on a long foreground command (verify)
  hears about it when that command returns.
- **Other tools** (Codex, Gemini, aider, custom commands) have no such hook. They see the inbox in the task's
  brief and the kickoff at their next session, or when they run `npm run thread -- inbox <ID>`.
- The inbox text is written by tools and people. The brief quotes it inside the marked untrusted block:
  information, not instructions.

Untested on Windows: the hook command line in `.claude/settings.json` (the same form as the existing hooks),
and the inbox notice file under a lane copy's linked `.studio/`.
