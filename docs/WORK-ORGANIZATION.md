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
