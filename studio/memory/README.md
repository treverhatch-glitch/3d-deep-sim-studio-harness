# Shared Improving Studio Memory (`studio/memory/`)

Inspired by the **Hermes Agent (Nous Research)** self-improving skill & memory architecture:
- **Raw append-only logs** stay in `.studio/events.jsonl` and `qa/reports/` (never loaded wholesale into LLM prompts).
- **Distilled lessons** live in [`studio/memory/failures.md`](failures.md).
- Whenever a bug is fixed and verified by `node qa/playtest.mjs`, the agent appends a short 4-bullet entry (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`) to `failures.md`.
- Before starting a new task or running `node harness/prepare-brief.mjs`, agents read **only** `studio/memory/failures.md` (and `studio/CURRENT_TASK.md`), avoiding 50k+ token log dumps.
- For 3D asset tasks where agents need to both **see** and **act** inside Blender, pair `studio/memory/failures.md` with [`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator) (`docs/BLENDER-ORCHESTRATOR.md`).
