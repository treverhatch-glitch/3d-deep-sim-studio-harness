# Shared Improving Memory Architecture (`docs/MEMORY.md`)

To prevent context bloat across hundreds of sessions, this harness separates **raw append-only telemetry** from **distilled actionable memory**, following the **Hermes Agent (Nous Research)** skill & memory pattern.

---

## 1. Two-Tier Storage Rule

| Tier | Location | Who Reads It | Policy |
| :--- | :--- | :--- | :--- |
| **Tier 1: Raw Telemetry (Append-Only)** | `.studio/events.jsonl`, `qa/reports/*.json` | War Room HUB (`hub/server.js`), `jq` / `duckdb` CLI filters | **Never** paste raw logs into an LLM chat window. |
| **Tier 2: Distilled Memory** | `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, `studio/llms.txt` | Cheap context-preparer (`harness/prepare-brief.mjs`) & active coding agents | Read on task start; updated with 4-line distilled notes after every bug fix. |

---

## 2. Mandatory Post-Fix Distillation Rule

Whenever an agent fixes a bug or resolves a failing `qa/playtest.mjs` run, it **MUST** append a 4-bullet entry to [`studio/memory/failures.md`](../studio/memory/failures.md):

1. **What broke** — The exact invariant, tick/seed failure, or visual layout bug.
2. **Root cause** — Why it happened (e.g., unseeded RNG, missing `export_apply=True`, mutable reference).
3. **The fix that worked** — The exact file/symbol change that resolved it.
4. **How to avoid it next time** — The guardrail rule for future tasks.

---

## 3. Seeing & Acting in 3D (`blender-orchestrator`)

Just as `qa/playtest.mjs` gives coding agents eyes on the running web game (`window.__sim` + Playwright `ariaSnapshot`), 3D asset agents (`studio/roles/asset-3d.md`) use **[`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator)** (`docs/BLENDER-ORCHESTRATOR.md`) alongside headless `bpy` (`tools/blender/generate_glb.py`) so they can inspect the live Blender scene graph, render quick viewport previews, and record 3D asset lessons in `studio/memory/failures.md`.
