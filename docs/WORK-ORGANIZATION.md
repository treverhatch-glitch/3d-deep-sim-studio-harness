# Work Organization (`docs/WORK-ORGANIZATION.md`)

Agents must keep durable work in files, never trapped in chat history.

## Where to Store Work

| What | Where | When |
|------|--------|------|
| Active handoff / current focus | `studio/CURRENT_TASK.md` | Start and end of every session |
| Prioritized backlog | `studio/NEXT.md` | When priorities change or new work appears |
| Completed task summary | `studio/done/YYYY-MM-DD-short-title.md` | When a task is finished |
| Daily rollup + videos | `studio/daily/YYYY-MM-DD.md` | End of day or major session |
| Before/after videos | `studio/daily/videos/` | When gameplay visuals change |
| Bug report | `studio/templates/bug.md` → copy into `qa/reports/` | When a bug is found |
| Playtest report | `studio/templates/playtest.md` → copy into `qa/reports/` | After a playtest |
| Calibration notes | Inside the done summary or `studio/CURRENT_TASK.md` | During Designer-Calibrator work |

## How to Pull the Next Task

1. Read `studio/CURRENT_TASK.md`. If it has a clear next step in `IN_PROGRESS`, do that.
2. If `studio/CURRENT_TASK.md` is idle or marked done, inspect `studio/NEXT.md` (or run `node harness/task.mjs next`).
3. Take the highest-priority unchecked item (`node harness/task.mjs start <ID>`).
4. Do the work, logging passive progress via `node scripts/append-event.mjs` or `node harness/event.mjs`.
5. When finished:
   - Write a short summary in `studio/done/YYYY-MM-DD-short-title.md`.
   - Update `studio/CURRENT_TASK.md` and mark the item done in `studio/NEXT.md` (`node harness/task.mjs done <ID>`).
6. At the end of a day or major session, fill `studio/daily/YYYY-MM-DD.md` (copied from `studio/daily/TEMPLATE.md`), including the task checklist and any before/after gameplay videos.

## Many Agents, One Board (crash-safe state, 2.57.0)

Several agents change the board at once, and any of them can be killed mid-command. So the harness never
writes shared state in place: `studio/NEXT.md`, `studio/DONE.md`, `studio/task-holds.json`, `.studio/STOP.json`,
the trunk state and the claim files in `.studio/locks/` are written to a temp file and renamed over the old one
(`harness/fsafe.mjs`), so a reader sees the old file or the new one, never half of one. Every change to the board
(start, done, pause, add, drop, reorder, reopen, the watcher's requeue) and to the holds (park, block, lane) is
read, made and written under a short lock (`.studio/locks/board.mutex`, `holds.mutex`; a dead agent's lock is
broken at once, a stuck one after 10 s), so ten agents starting ten tasks together all land on the board. A claim
file that can't be read (an agent killed while making it under an older harness) is reported as "claimed (lock
being written)" for its first 10 s (`STUDIO_BROKEN_LOCK_GRACE_SEC`), then moved to `.studio/locks/broken/`
(kept, never deleted) by the next claim or `npm run watch`. A `STOP.json` that exists but can't be read counts as
stopped; `npm run task -- resume --by <name>` clears it. Don't hand-edit these files while agents run; use the
`npm run task` commands.

### When a command is killed halfway (2.58.0)

- **Moving a task between NEXT.md and DONE.md** takes two writes. The file that gains the task is written first
  (DONE.md on `task done`, NEXT.md on `task reopen`), so a kill between them leaves the task in both files, never in
  neither. It still shows once: the move that was cut off counts as made (done stays done; a reopened task waits).
  Which way it was moving is noted in `.studio/board-move.json` during the write. A task in both files with no such
  note (a hand edit, a merge) counts as done; `task reopen` brings it back. `npm run watch` keeps one copy.
- **Claims nobody can be using** are released by `npm run watch`: a `task:` claim on a task that is done, waiting
  or gone from the board (a `task done` killed after its board write kept it, and heartbeats renewed it; a killed
  start or pause). Only once the claim and the board have both been quiet for `STUDIO_CLAIM_LEAK_GRACE_SEC` (60),
  never while a `task done` for it is running; logged as `lock.released`. `task reopen` also frees an old claim left
  on the task it reopens. `task start` releases its claim if anything goes wrong while it updates the board.
- **The watcher's own hand-backs** (a claim ran out, a session ended) go ahead only if the claim is still what the
  pass saw; an agent that re-claimed the task meanwhile keeps it.
- **Board locks** (`board.mutex` and the others) are never broken on age while their holder's process is alive on
  this machine (a console paused by a click, a sleeping laptop): others wait, or give up after 15 s with "run the
  command again". A dead holder's lock is broken at once; one held by another machine after 10 s; a live holder's
  only after 10 min (`STUDIO_STATE_LOCK_LIVE_MAX_MS`: by then the pid most likely belongs to another program). A
  holder whose lock was broken anyway stops before writing (`ELOCKLOST`).
- **Temp files** a killed write left (`.<name>.<pid>-….tmp`) are removed from `studio/` and `.studio/` by
  `npm run watch` once older than `STUDIO_TEMP_SWEEP_MIN` (5).
- **Lines the board can't read** are never dropped. A task line with an ASCII `-` instead of `—`, or a role without
  backticks, is read as a task and rewritten in the board's format. Anything else (another format, a note, the same
  id twice) is moved under `## UNREADABLE (kept by the harness: fix the format)` at the end of the file, with one
  warning and a `board.unreadable` event; fix the line there (it then counts as waiting work) or delete it.
- **Folder claims** are compared without regard to case: `path:game/Branding` and `path:game/branding` are one
  claim (on Windows they are one folder).
- A state file written in place because another program kept it open (Windows) leaves a `fsafe.warning` event.
- The land lock (`.studio/locks/land.lock`, taken for a landing's fast-forward and board write) treats Windows'
  EPERM/EACCES/EBUSY while it is created or removed as busy and retries, instead of crashing the command.

## Summary Format (`studio/done/YYYY-MM-DD-short-title.md`)

```markdown
# YYYY-MM-DD — Short Title

- **Role:** Builder / QA-Playtester / Designer-Calibrator / Reviewer
- **Task ID:** T-XXX
- **What was done:**
- **Files changed:**
- **Result / verification:** (`node scripts/check-sim-isolation.mjs` + `node qa/playtest.mjs`)
- **Follow-ups:** (or "none")
```

## Rules

- Never leave the only record of work in the chat.
- Keep `studio/CURRENT_TASK.md` short and current.
- Prefer appending to `studio/NEXT.md` (`node harness/task.mjs add "..."`) over creating scattered tracking files.
- The Producer role is responsible for keeping `studio/CURRENT_TASK.md` and `studio/NEXT.md` accurate.
