# 3D Deep Simulation & AI Game Studio — Agent Operating Rules (`AGENTS.md`)

This repository uses an external context & multi-agent studio harness designed to scale a 3D simulation game beyond 100,000+ lines of TypeScript without losing architectural direction or exhausting LLM token quotas.

Every coding agent (Claude Code, Cursor, Gemini CLI, Codex, GitHub Copilot, Aider, Grok Bot, or local Ollama workers) **MUST** follow these operating rules.

---

## 1. Thin-Context First: Read Order on Session Start

Do **NOT** scan the entire repository or dump raw files into context. Load state in this exact priority order:

1. **`studio/CURRENT_TASK.md`** — Read the `## CHECKPOINT` and `## STATUS` blocks first to resume from the exact file/line where the last session stopped.
2. **`studio/NEXT.md`** (or run `node harness/task.mjs next`) — Inspect the active task in `IN_PROGRESS` or pull the top item from `BACKLOG`.
3. **`studio/llms.txt`** — Load the compact engine & simulation API sheet instead of reading full engine source files.
4. **`studio/VISION_LOCK.md` & `studio/decisions/`** — Consult before changing core simulation loops, state schemas, or rendering pipelines.

---

## 2. Mandatory Token-Saver Discipline (60–90% Input Reduction)

Never waste context window tokens on noisy shell output or full-file reads when targeted tools exist:

- **Shell Commands via `rtk`**: Prefix noisy shell/test/git commands with `rtk` (e.g., `rtk git status`, `rtk npm test`) so passing test noise and boilerplate logs are stripped before entering context.
- **Markdown Docs via `qmd`**: Query documentation using `qmd query "<question>"` (or the `qmd` MCP server) to fetch the 3 most relevant paragraphs instead of reading multi-page markdown files.
- **Code Lookup via `serena` (LSP)**: On large TypeScript files, use symbol-level lookup/edits (`oraios/serena` MCP or `rg -n`) rather than reading entire 2,000-line files.
- **JSON & Telemetry via `jq` / `duckdb`**: Filter `.studio/events.jsonl` and `qa/reports/*.json` with `jq` or `duckdb` queries instead of dumping raw JSON into chat.

---

## 3. Passive Telemetry & Zero-Token Status (`harness/event.mjs`)

- **Never ask an LLM "What are you doing?"** — Manual status check-ins force a full-context re-read (30k–80k+ tokens).
- **Emit Passive Events**: Whenever you start a task, switch roles, invoke a model route, or finish a QA run, log a passive JSONL event:
  ```bash
  node harness/event.mjs --type task.start --agent builder --task "T-001" --msg "Implementing fixed-step clock"
  ```
- Both `.studio/events.jsonl` and `/tmp/agent-events.jsonl` are updated automatically and streamed live by the Zero-Token Workflow UI HUB (`node hub/server.mjs`).

---

## 4. Studio Roles & Governance (`studio/roles/` & `harness/agents.mjs`)

- **Default 5-Role Starter Pack**:
  1. `producer` — Triages `studio/NEXT.md`, enforces `studio/VISION_LOCK.md`, and gates ADRs (`Question -> Options -> Decision -> Draft -> Approval`).
  2. `designer-calibrator` — Owns tuning tables, deterministic balance curves, and pacing metrics.
  3. `builder` — Implements pure-TypeScript simulation systems and 3D renderer bridges.
  4. `qa-playtester` — Runs Two-Stage QA (`node qa/playtest.mjs`): Stage 1 programmatic trajectories (`?playtest=1` / `window.__sim`) + Stage 2 visual/layout verification.
  5. `reviewer` — Audits sim purity (`node scripts/check-sim-purity.mjs`), determinism hashes, and visual diffs before marking tasks done.
- **No Agent Caps & No Vendor Lock-In**: Add any number of custom agents, departments, or swarms in `studio/roles/<slug>.md` and inspect them via `node harness/agents.mjs list`. Swap the Executive Producer preset (`studio/presets/grok-producer.md` or any model provider) in `harness/models.config.mjs`.

---

## 5. Non-Negotiable 3D Deep-Sim Purity Rules (`studio/rules/sim-purity.md`)

1. **Pure TypeScript Simulation (`src/sim/**`)**:
   - **ZERO** DOM, `window`, `document`, WebGL, or `three` imports inside `src/sim/`.
   - **Fixed-Timestep Tick Only**: Simulation state advances strictly by integer ticks (`step(state, action)`), never by variable `requestAnimationFrame` delta time.
   - **Seeded Deterministic RNG**: `Math.random()` and `Date.now()` / `performance.now()` are forbidden in `src/sim/`. All randomness must flow through the seeded RNG stored inside `SimState`.
   - **100% JSON-Serializable State**: `SimState` must contain only plain objects, arrays, numbers, strings, and booleans (no class instances, `Map`, `Set`, closures, or circular refs) so saves, replays, and cross-engine ports (Tauri v2, Godot `ts2gd`, Unity `SharpTS`) work losslessly.
2. **Pre-Stop Checkpoint**:
   - Before ending a session or compacting context, update `studio/CURRENT_TASK.md` (`## CHECKPOINT` and `## STATUS`) and run `bash scripts/pre-compact.sh`.
