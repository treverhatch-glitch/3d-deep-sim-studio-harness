# 3D Deep Simulation & AI Game Studio — Agent Operating Rules (`AGENTS.md`)

This repository is a generalized, external-context & multi-agent studio harness designed to scale a 3D simulation game beyond 100,000+ lines of TypeScript without losing architectural direction or exhausting LLM token quotas.

Every coding agent **MUST** follow these operating rules.

---

## 1. Thin-Context First: Read Order on Session Start

Do **NOT** scan the entire repository. Load state in this order:

1. `studio/CURRENT_TASK.md`
2. `studio/NEXT.md` (or `node harness/task.mjs next`)
3. `studio/memory/failures.md` (distilled notes only)
4. `studio/llms.txt`
5. `studio/VISION_LOCK.md` and `studio/decisions/`

See also `docs/READ-FIRST.md`.

---

## 2. Preferred Model Cost Order & Prepare Then Escalate

1. Local model first, then free tiers, then paid.
2. For long history or escalated bugs, run `node harness/prepare-brief.mjs` and give the strong model only `.studio/briefs/latest.md`.
3. Skip prepare for already-short tasks.

See `docs/ROUTING.md`.

---

## 3. Seed System & Closed-Loop QA

1. Every new game **MUST** implement a deterministic seed + fixed-tick system early.
2. Failures are recorded as `{ seed, tick, description, actions }`.
3. Replay with:
   - `node harness/replay.mjs --seed <seed> --tick <tick>`
   - or `node harness/replay.mjs --trace .studio/last-seed-failure.json`
4. Closed loop (`node harness/closed-loop.mjs`) records the real failure and escalates after `MAX_FIX_ATTEMPTS` (default 3). It does **not** auto-fix code.
5. After a human or strong model fixes a bug, distill the lesson into `studio/memory/failures.md`.

---

## 4. Concurrent Work Rule (real locks)

Logging `editing` is not enough. Use the lock helper.

### Before starting work
1. Claim the task or file:
   `node harness/lock.mjs claim task:T-001 --owner your-agent`
   or `node harness/lock.mjs claim path:src/sim/foo.ts --owner your-agent`
2. If claim fails, do not edit. Wait or pick another task.
3. Prefer `node harness/task.mjs start <ID> --agent your-agent` — it refuses locked tasks.

### While working
- Stay inside what you claimed.
- Do not edit files locked by someone else.

### When finished
- `node harness/lock.mjs release <key> --owner your-agent`
- Or `node harness/task.mjs done <ID>`
- Update `CURRENT_TASK.md`

### Producer
- Assign non-overlapping work.
- If two agents want the same area, pick one.

---

## 5. Human Approval Gate

Require explicit human or Producer approval before:
- Pulling external assets
- Large refactors
- Changing core simulation rules

---

## 6. Token-Saver & Assets

- Use compressed lookups instead of full-file dumps when possible.
- Telemetry savings numbers are estimates (`docs/TELEMETRY.md`).
- Use Blender headless generation or blender-orchestrator for assets.

---

## 7. Sim Purity

- No DOM, `window`, WebGL, or `three` inside simulation logic.
- Fixed timestep only.
- Seeded RNG only.
- JSON-serializable state only.
- Run `scripts/check-sim-isolation.sh` before calling work done.
- Snapshot state before risky changes (`scripts/snapshot-state.sh`).
