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

See also `docs/READ-FIRST.md`.

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
   - Use `studio/templates/seed-failure.json` as the format.
2. **Direct State Access Over Pure GUI Clicking (`?playtest=1`)**:
   - Following the **Recursive Game Creator** pattern and **OhMyGame** open-loop critique, games expose `window.__hatch` and `window.__sim` when launched with `?playtest=1` (`qa/hatchfield.adapter.mjs`).
   - Always check **accessibility trees first (`ariaSnapshot()`)** and take screenshots **only when needed** (`qa/visual-check.mjs`).
3. **Tight Closed Loop & Shared Improving Memory (`Hermes Agent` Pattern)**:
   - Run `node harness/closed-loop.mjs`: fail test → auto-open bug (`studio/templates/bug.md`) → attempt fix → re-test → mark done only on pass. Escalate to a strong model or human after `MAX_FIX_ATTEMPTS=3` failed attempts.
   - After fixing any bug, append a distilled 4-bullet entry to `studio/memory/failures.md` (or run `scripts/distill-bug.sh`).

---

## 4. Concurrent Work Rule

Only one agent may actively edit a given file or tightly coupled set of files at a time.

### Before starting work
1. Check `studio/CURRENT_TASK.md` and `.studio/events.jsonl` for any in-progress work.
2. If another agent is already editing the same file(s) or the same feature area, do not start. Either wait, pick a different task, or ask the Producer.
3. Announce what you are about to touch by appending a short event:
   `{ "agent": "...", "status": "editing", "file": "path/to/file", "task": "short description" }`

### While working
- Stay inside the files you announced.
- Do not edit files another agent has marked as `editing` unless the Producer explicitly reassigns them.
- If you need a file that is locked, stop and report it instead of editing anyway.

### When finished
- Append an event with `"status": "done"` (or `"blocked"`).
- Update `CURRENT_TASK.md` so the next agent can see it is free.

### Producer responsibility
- The Producer assigns non-overlapping file sets when multiple agents are active.
- If two agents request the same area, the Producer picks one and tells the other to wait or switch tasks.

### Simple lock convention
Treat a file as locked if the latest event for that file has `"status": "editing"` and no later `"done"` or `"blocked"` event exists.

---

## 5. Human Approval Gate

The following actions require explicit human or Producer approval before proceeding:
- Pulling or integrating external assets
- Large refactors
- Changing core simulation rules or state schemas

Reference Scout items stay in `studio/references/APPROVALS.md` until marked approved.

---

## 6. Mandatory Token-Saver Discipline & 3D Asset Orchestration

- **Shell Commands via `rtk`**: Prefix noisy shell/test/git commands with `rtk` (e.g., `rtk git status`, `rtk npm test`).
- **Markdown Docs via `qmd`** & **Code Lookup via `serena` (LSP)**: Fetch top sections or symbol bodies instead of reading full 2,000-line files.
- **3D Assets (`tools/blender/generate_glb.py` + `mlolson/blender-orchestrator`)**: Use headless `bpy` for procedural `.glb` primitives and connect blender-orchestrator when agents need to both see and act inside Blender.
- **Passive Telemetry (`harness/event.mjs`)**: Emit 1-line JSONL events to `.studio/events.jsonl` so the War Room streams live status at 0% LLM token cost.

---

## 7. Non-Negotiable 3D Deep-Sim Purity Rules (`studio/rules/sim-purity.md`)

1. **Pure TypeScript Simulation (`src/sim/**` & `cartridges/**`)**:
   - **ZERO** DOM, `window`, `document`, WebGL, or `three` imports inside simulation logic (`bash scripts/check-sim-isolation.sh`).
   - **Fixed-Timestep Tick Only**: Simulation state advances strictly by integer ticks (`step(state, action)`), never by variable `requestAnimationFrame` delta time.
   - **Seeded Deterministic RNG**: `Math.random()` and `Date.now()` / `performance.now()` are forbidden in simulation paths.
   - **100% JSON-Serializable State**: Plain objects, arrays, numbers, strings, and booleans only so saves, replays, and cross-engine ports work losslessly.
2. **Pre-Stop Checkpoint**:
   - Before ending a session or compacting context, update `studio/CURRENT_TASK.md` and run `bash scripts/pre-compact.sh`.
   - For risky changes, run `scripts/snapshot-state.sh` first.
