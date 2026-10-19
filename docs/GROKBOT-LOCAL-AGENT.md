# Integrating grokbot-local-agent

Optional layer that lets Grok Bot stay a thin Producer while handing heavy work to a local agent (Pi, or similar) running on the same machine.

Upstream: https://github.com/robbin/grokbot-local-agent

## Why it fits this template

- Grok Bot only schedules and reviews → matches our thin Producer role.
- Heavy coding, bulk edits, and research run on another model’s API keys.
- Disk-backed task state + webhook wakeup solves the “bot went to sleep and never heard the result” problem.
- Their `events.jsonl` can feed our event log / HUB.

## Recommended mapping

| grokbot-local-agent | Our template |
|---------------------|--------------|
| `pi-task` state in `~/.pi/tasks/<id>/` | Source of truth for delegated work |
| `events.jsonl` inside the task folder | Append important lines to `/tmp/agent-events.jsonl` (or mirror) so the HUB shows them |
| On completion webhook | Grok Bot routine reads result, updates `CURRENT_TASK.md`, writes `studio/done/` summary |
| `--owner <agent-id>` | Use a stable owner string so tasks stay tied to this Producer |

## Thin integration steps

1. Follow their setup guide to install Pi and the `pi-task` scripts on the Grok Bot machine.
2. Set `PI_NOTIFY_URL` and `PI_NOTIFY_SECRET` for the webhook.
3. Create a Grok Bot routine that uses their `routines/pi-task-notify.md` content.
4. In that routine (or a follow-up step), add:
   - Read the finished task’s `result.md` (or git diff).
   - Update `CURRENT_TASK.md` with the outcome and next step.
   - Write a short entry in `studio/done/`.
   - Optionally append a line to the event log via `scripts/append-event.sh`.
5. When delegating from Grok Bot, prefer:
   ```bash
   pi-task run --owner grok-producer "your task description"
   ```

## What we do not vendor

This template does not copy their scripts. Install them from the upstream repo so you get updates. We only document the handoff points so the two systems stay in sync.

## Limitations (from upstream)

Best for moderate-length tasks. For long-running project maintenance they suggest a heavier tool (e.g. Cursor Cloud Agent). Our file-based handoff (`CURRENT_TASK.md`, `NEXT.md`) still works either way.
