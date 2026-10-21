# Daily Summary (`docs/DAILY-SUMMARY.md`)

End-of-day (or end-of-session) record of what happened, with optional before/after gameplay videos and a task checklist.

## Where It Lives

`studio/daily/YYYY-MM-DD.md` (copy `studio/daily/TEMPLATE.md` and fill it in).

## What to Include

- Short bullets of what was completed
- Checklist of tasks (checked or still open)
- Before/after gameplay videos or GIFs when 3D visuals or choreography changed
- Key file or simulation system changes
- Blockers and the single next focus
- Links to commits, playtest reports (`qa/reports/`), or `studio/done/` summaries

## Videos (`studio/daily/videos/`)

- Prefer short clips or GIFs showing the same scenario before and after a change.
- Store them in `studio/daily/videos/` or link to an external host.
- Name them clearly: `YYYY-MM-DD-before-feature.mp4`, `YYYY-MM-DD-after-feature.mp4`.

## Relation to Other Files

- `studio/CURRENT_TASK.md` = live handoff (updated constantly & snapshotted by `node scripts/pre-compact.mjs`)
- `studio/done/` = per-task completion summaries
- `studio/daily/` = daily rollup with visual before/after evidence for YouTube devlogs
