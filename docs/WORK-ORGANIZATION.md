# Work Organization

Agents must keep durable work in files, not chat.

## Where to Store Work

| What | Where | When |
|------|--------|------|
| Active handoff / current focus | `CURRENT_TASK.md` | Start and end of every session |
| Prioritized backlog | `NEXT.md` | When priorities change or new work appears |
| Completed task summary | `studio/done/YYYY-MM-DD-short-title.md` | When a task is finished |
| Daily rollup + videos | `studio/daily/YYYY-MM-DD.md` | End of day or major session |
| Before/after videos | `studio/daily/videos/` | When gameplay visuals change |
| Bug report | `studio/templates/bug.md` → copy into `qa/reports/` | When a bug is found |
| Playtest report | `studio/templates/playtest.md` → copy into `qa/reports/` | After a playtest |
| Calibration notes | Inside the done summary or `CURRENT_TASK.md` | During Designer-Calibrator work |

## How to Pull the Next Task

1. Read `CURRENT_TASK.md`. If it has a clear next step, do that.
2. If `CURRENT_TASK.md` is empty or marked done, open `NEXT.md`.
3. Take the highest-priority unchecked item.
4. Move it into `CURRENT_TASK.md` (mark it in progress).
5. Do the work.
6. When finished:
   - Write a short summary in `studio/done/`.
   - Update `CURRENT_TASK.md` with what was done and the new next step (or clear it).
   - Check the item off in `NEXT.md` or remove it.
7. At the end of a day or major session, fill `studio/daily/YYYY-MM-DD.md` (copy from `TEMPLATE.md`). Include the task checklist and any before/after gameplay videos.

## Summary Format (studio/done/)

```markdown
# YYYY-MM-DD — Short Title

- **Role:** Builder / QA-Playtester / etc.
- **What was done:**
- **Files changed:**
- **Result / verification:**
- **Follow-ups:** (or "none")
```

## Daily Summary

See `docs/DAILY-SUMMARY.md` and `studio/daily/TEMPLATE.md`.

## Rules

- Never leave the only record of work in the chat.
- Keep `CURRENT_TASK.md` short and current.
- Prefer appending to `NEXT.md` over creating new tracking files.
- The Producer is responsible for keeping `CURRENT_TASK.md` and `NEXT.md` accurate.
- Daily summaries with optional before/after videos give a visual record of progress.
