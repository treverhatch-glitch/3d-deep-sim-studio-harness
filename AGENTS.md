# 3D Deep Simulation & AI Game Studio — Agent Operating Rules (`AGENTS.md`)

This repository is a generalized, external-context & multi-agent studio harness designed to scale a 3D simulation game beyond 100,000+ lines of TypeScript without losing architectural direction or exhausting LLM token quotas.

Every coding agent **MUST** follow these operating rules.

---

## 1. Thin-Context First: Read Order on Session Start

Do **NOT** scan the entire repository. Load state in this order:

1. `studio/CURRENT_TASK.md` (Producers: run `npm run handoff` instead; it covers this list and more)
2. `studio/NEXT.md` (or `node harness/task.mjs next`)
3. `studio/memory/failures.md` (distilled notes only)
4. `studio/llms.txt`
5. `studio/VISION_LOCK.md`, `studio/PLAN.md` and `studio/decisions/` (`studio/MASTER.md` maps every key document)

See also `docs/READ-FIRST.md`.

---

## 2. Preferred Model Cost Order & Prepare Then Escalate

1. Local model first, then free tiers, then paid.
2. For long history or escalated bugs, run `node harness/prepare-brief.mjs` and give the strong model only `.studio/briefs/latest.md`.
3. Skip prepare for already-short tasks.

See `docs/ROUTING.md`.

---

## 3. Cartridges, Seed System & Closed-Loop QA

1. The game sim lives in `cartridges/<name>/` and follows the contract in `cartridges/README.md`.
   Start one with `npm run new-game <name>`. Pick it with `--cartridge <name>` or `"cartridge"` in `studio/gates.json`.
2. Every cartridge has a deterministic seed + fixed tick, a `TUNING` table, and a `start-to-win` scenario in `qa.mjs`.
3. Failures are recorded as `{ cartridge, seed, tick, description, actions }` where `tick` is the tick the cartridge broke on.
4. Replay with:
   - `node harness/replay.mjs --seed <seed> --tick <tick> [--cartridge <name>]`
   - or `node harness/replay.mjs --trace .studio/last-seed-failure.json` (stops on the failing tick)
5. Closed loop (`node harness/closed-loop.mjs`) records the real failure and escalates after `MAX_FIX_ATTEMPTS` (default 3). It does **not** auto-fix code.
6. A sim change that changes behaviour changes hashes: `npm run golden -- --update` and commit the hashes with the change.
7. After a human or strong model fixes a bug, add a replay to `qa/regressions/` and distill the lesson into `studio/memory/failures.md`.

---

## 4. Concurrent Work Rule (real locks)

Logging `editing` is not enough. Use the lock helper.

### Before starting work
1. Use a unique owner name per running agent (`cursor-win2`, `claude-a`). Shared names such as `cursor`, `claude` or `builder` are refused.
   Export it once: `export STUDIO_LOCK_OWNER=cursor-win2`.
2. Claim the task: `node harness/task.mjs start <ID> --agent cursor-win2` (refuses work another agent claimed).
3. Claim the files or folder: `node harness/lock.mjs claim path:src/sim/ --owner cursor-win2` (a folder lock covers everything under it).
4. If a claim fails, do not edit. Wait or pick another task.
5. `npm run hooks:install` once per clone: the pre-commit hook refuses staged files locked by someone else and staged secrets.

### While working
- Stay inside what you claimed.
- Do not edit files locked by someone else.

### When finished
- `node harness/lock.mjs release <key> --owner cursor-win2`
- `node harness/task.mjs done <ID> --agent cursor-win2` (only the owner can finish a claimed task, and only once its
  done-check passes: `node harness/done-check.mjs <ID>` shows what is missing; how each kind of task finishes is in `studio/skills/`)
- `--force` finishes anyway, but it is logged and the Producer gets a P1 `Check forced done` task
- `npm run verify` before calling it done; `npm run release` before a merge
- Update `CURRENT_TASK.md`

### Producer
- Assign non-overlapping work.
- Work through `Check forced done` tasks: run the skipped check (or order it) and accept or reopen the work.
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
- Run `npm run verify` before calling work done. The purity gate also plays every cartridge with randomness, clock, timers and DOM trapped.
- Snapshot state before risky changes (`scripts/snapshot-state.sh`).

---

## 8. External tools

Optional external tools are listed in `docs/EXTERNAL-TOOLS.md`. Do not vendor them into this repo.


---

## 9. Best practices (recommended)

Not rules, but they keep accounts in good standing and the team fast: commit locally and push in batches,
stay in your own repos, use fine-grained tokens, use only keys you are entitled to (extra free accounts break most providers' terms), tools before freehand.
See `docs/BEST-PRACTICES.md`.
