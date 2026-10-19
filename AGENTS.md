# 3D Deep Simulation & AI Game Studio — Agent Operating Rules (`AGENTS.md`)

This repository is a generalized, external-context & multi-agent studio harness designed to scale a 3D simulation game beyond 100,000+ lines of TypeScript without losing architectural direction or exhausting LLM token quotas.

Every coding agent (Claude Code, Cursor, Gemini CLI, Codex, GitHub Copilot, Aider, Grok Bot, or local Ollama workers) **MUST** follow these operating rules.

---

## 1. Thin-Context First: Read Order on Session Start

Do **NOT** scan the entire repository or dump raw files into context. Load state in this exact priority order:

1. **`studio/CURRENT_TASK.md`** — Read the `## CHECKPOINT` and `## STATUS` blocks first to resume from the exact file/line where the last session stopped.
2. **`studio/NEXT.md`** (or run `node harness/task.mjs next`) — Inspect the active task in `IN_PROGRESS` or pull the top item from `BACKLOG`.
3. **`studio/memory/failures.md`** — Read the distilled 4-bullet failure notes (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`). Never read raw `.studio/events.jsonl` or `qa/reports/` dumps into context.
4. **`studio/llms.txt`** — Load the compact engine & simulation API sheet instead of reading full engine source files.
5. **`studio/VISION_LOCK.md` & `studio/decisions/`** — Consult before changing core simulation loops, state schemas, or rendering pipelines.

---

## 2. Preferred Model Cost Order & "Prepare Then Escalate" (`docs/ROUTING.md`)

1. **Preferred Routing Order (`Local → Free Tiers → Paid`)**:
   - **Tier 0 — Local Model (`ollama-local` / `qwen2.5-coder:14b` or `32b`)**: `$0` offline. Use first for context preparation, routine edits, and headless `bpy` scripts.
   - **Tier 1 — Free Cloud Tiers & Trial Credits**: NVIDIA NIM (`GLM 5.3 Flash`), Groq (`Llama 3.3 70B`), OpenRouter `:free`, and Google Vertex (`$300` credit).
   - **Tier 2 — Paid / High-Reasoning Escalation**: Claude Opus/Sonnet, xAI Grok, Gemini 2.5 Pro, OpenAI, Cursor Ultra.
2. **Cheap Model Prepares, Strong Model Executes (`node harness/prepare-brief.mjs`)**:
   - For tasks with long history or escalated bugs, a cheap/local model reads `.studio/events.jsonl`, `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, and recent QA reports and writes a constrained **`<= 300`-word brief** (`.studio/briefs/latest.md`).
   - The strong model (and Producer) receives **only** that `<= 300`-word brief. Skip for already-short tasks.

---

## 3. Mandatory Early Deterministic Seed System & Closed-Loop QA (`qa/README.md`)

1. **Seed System First**:
   - Every new game built in this harness **MUST** implement a deterministic **Seed + Fixed-Tick** system (`{ seed, tick, rngState }`) as **one of the very first systems coded**.
   - Failures are recorded as `{ seed, tick, description }` so agents can scroll back and replay the exact failing tick via `node harness/replay.mjs --seed <seed> --tick <tick>`.
2. **Direct State Access Over Pure GUI Clicking (`?playtest=1`)**:
   - Following the **Recursive Game Creator** pattern and **OhMyGame** open-loop critique, games expose `window.__hatch` and `window.__sim` when launched with `?playtest=1` (`qa/hatchfield.adapter.mjs`).
   - Always check **accessibility trees first (`ariaSnapshot()`)** and take screenshots **only when needed** (`qa/visual-check.mjs`).
3. **Tight Closed Loop & Shared Improving Memory (`Hermes Agent` Pattern)**:
   - Run `node harness/closed-loop.mjs`: fail test → auto-open bug (`studio/templates/bug.md`) → attempt fix → re-test → mark done only on pass. Escalate to a strong model or human after `3` failed attempts.
   - After fixing any bug, append a distilled 4-bullet entry (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`) to [`studio/memory/failures.md`](studio/memory/failures.md).

---

## 4. Mandatory Token-Saver Discipline & 3D Asset Orchestration

- **Shell Commands via `rtk`**: Prefix noisy shell/test/git commands with `rtk` (e.g., `rtk git status`, `rtk npm test`).
- **Markdown Docs via `qmd`** & **Code Lookup via `serena` (LSP)**: Fetch top sections or symbol bodies instead of reading full 2,000-line files.
- **3D Assets (`tools/blender/generate_glb.py` + `mlolson/blender-orchestrator`)**: Use headless `bpy` for procedural `.glb` primitives (`crate`, `cone`, `vehicle`, `beacon`, `hangar`) and connect [`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator) (`docs/BLENDER-ORCHESTRATOR.md`) when agents need to both **see** and **act** inside Blender.
- **Passive Telemetry (`harness/event.mjs`)**: Emit 1-line JSONL events to `.studio/events.jsonl` so the Mission Control War Room (`node hub/server.js`) streams live status at **0% LLM token cost**.

---

## 5. Non-Negotiable 3D Deep-Sim Purity Rules (`studio/rules/sim-purity.md`)

1. **Pure TypeScript Simulation (`src/sim/**` & `cartridges/**`)**:
   - **ZERO** DOM, `window`, `document`, WebGL, or `three` imports inside simulation logic (`bash scripts/check-sim-isolation.sh`).
   - **Fixed-Timestep Tick Only**: Simulation state advances strictly by integer ticks (`step(state, action)`), never by variable `requestAnimationFrame` delta time.
   - **Seeded Deterministic RNG**: `Math.random()` and `Date.now()` / `performance.now()` are forbidden in simulation paths.
   - **100% JSON-Serializable State**: Plain objects, arrays, numbers, strings, and booleans only so saves, replays, and cross-engine ports (Tauri v2, Godot `ts2gd`, Unity `SharpTS`) work losslessly.
2. **Pre-Stop Checkpoint**:
   - Before ending a session or compacting context, update `studio/CURRENT_TASK.md` (`## CHECKPOINT` and `## STATUS`) and run `bash scripts/pre-compact.sh`.
