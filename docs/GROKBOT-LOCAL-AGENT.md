# Integrating `grokbot-local-agent` (Optional Grok Bot Route)

**This is one supported route, not a requirement.**  
The harness is 100% agent-agnostic. Any agent (Cursor, Claude Code, Gemini CLI, Codex, Pi, local Ollama models, etc.) can fill any role. This document covers the optional path where Grok Bot acts as a thin Executive Producer and offloads heavy coding work to a local worker.

Upstream: **https://github.com/robbin/grokbot-local-agent**

---

## Why It Fits This Template

- **Thin Executive Producer**: Grok Bot only schedules, triages `studio/NEXT.md`, and reviews → matches our `producer` role (`studio/presets/grok-producer.md`).
- **Quota Sovereignty**: Heavy coding, bulk refactors, and Stage-1/Stage-2 QA runs execute on another model's API keys (`harness/route.mjs`: Vertex Gemini credits, free NVIDIA NIM GLM 5.3 Flash / Nemotron, Groq, or local Ollama).
- **Disk-Backed State + Webhook Wakeup**: Solves the *"bot went to sleep and never heard the result"* problem without polling chat and burning the 30k–80k+ token check-in tax.
- **Zero-Token HUB Compatibility**: Their `~/.pi/tasks/<id>/events.jsonl` stream mirrors directly into `.studio/events.jsonl` so `hub/WarRoom.tsx` lights up automatically.

---

## Recommended Mapping

| `grokbot-local-agent` | This Studio Template |
|---------------------|--------------|
| `pi-task` state in `~/.pi/tasks/<id>/` | Source of truth for delegated background work |
| `events.jsonl` inside the task folder | Mirror or append lines via `node scripts/append-event.mjs` into `.studio/events.jsonl` so the HUB displays live nodes |
| On-completion webhook (`PI_NOTIFY_URL`) | Grok Bot routine reads result, updates `studio/CURRENT_TASK.md`, writes `studio/done/` summary |
| `--owner <agent-id>` | Use `--owner grok-producer` so tasks stay tied to the Executive Producer |

---

## Thin Integration Steps

1. Follow the upstream setup guide (`https://github.com/robbin/grokbot-local-agent`) to install Pi and the `pi-task` scripts on the worker machine.
2. Set `PI_NOTIFY_URL` and `PI_NOTIFY_SECRET` in `.env` for the completion webhook.
3. Create a Grok Bot routine using upstream `routines/pi-task-notify.md`.
4. In that completion routine, run:
   - Read the finished task’s `result.md` (or `rtk git diff`).
   - Update `studio/CURRENT_TASK.md` with the outcome and next step (`node harness/task.mjs done <ID>`).
   - Write a short summary entry in `studio/done/YYYY-MM-DD-short-title.md`.
   - Append a completion line to `.studio/events.jsonl` via `node scripts/append-event.mjs DONE src/sim/ P0-XX`.
5. When delegating from Grok Bot, prefer:
   ```bash
   pi-task run --owner grok-producer "Implement fixed-timestep turnaround system per studio/CURRENT_TASK.md"
   ```

## What We Do Not Vendor

This template does not vendor upstream `pi-task` binaries so you always get upstream updates cleanly. Other coding agents (Claude Code, Cursor, Gemini CLI, Codex) do not need this bridge and can read/write `studio/CURRENT_TASK.md` and `studio/NEXT.md` directly.
