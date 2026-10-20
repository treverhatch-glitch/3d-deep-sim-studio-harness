# Changelog (`CHANGELOG.md`)

All notable upgrades to the **3D Deep Simulation & AI Game Studio Harness** are documented in this file.

---

## [2.3.0] — 2026-10-20
### Added
- **Done-checks by task type** (`harness/done-check.mjs`): `task done` refuses until the proof for that kind of work exists, newer than the task's start. Change and docs: a full green verify. Bug: a pinned regression, a lesson in `failures.md` and a green verify. Balance and fun: a fresh report. Playtest: a report in `qa/reports/`. Study: a `study.md`. Review: a note in `studio/reviews/`. `--type` on `task add` sets the type.
- **`--force` pings the Producer**: it still closes the task, writes a `task.forced` event, flags it in the War Room and queues a P1 `Check forced done` task for the Producer.
- **Skills** (`studio/skills/`): one short file per kind of task (When, Steps, Done means, Never). The builder skill is the edit, test, stop loop.
- **War Room v3** (`/v3`): files-only HUD with two skins. Studio view: themed room per division, staff dressed by division, agents walk to the Producer's office to report and the Producer walks over to hand out work, live widgets (queue board, build light, test board, shipped trophies).
- **Plugin registry** (`studio/plugins.json`, `harness/plugins.mjs`) and the game study guide (`docs/GAME-STUDY.md`).
- `docs/BEST-PRACTICES.md`: recommendations, not rules.
- **Producer handoff** (`npm run handoff`): a briefing built from files for whoever holds the Producer role (plan, log, decisions, what needs attention first, queue with owners, claims, gates, playtest, last failing seed, open bugs, sign-offs, lessons, meetings, last 24 hours, key documents). Saved to `.studio/briefs/producer.md`.
- **Master documents**: `studio/MASTER.md` (the map of key documents and how to take over), `studio/PLAN.md` (the master plan), `studio/producer/LOG.md` (the Producer's reasons, newest first; `node harness/handoff.mjs note`).
- **Meetings** (`harness/meeting.mjs`): the Producer meets several agents at once; notes in `studio/meetings/`, actions become tasks, the outcome goes into the Producer log. In the Studio view everyone walks to a meeting table and back.
- **Handing work back**: `task pause <ID> --note` returns a task to the top of the queue with a note in `studio/handoffs/<ID>.md`; the next agent sees it on `task start`.
- **Watcher** (`npm run watch`; runs on its own every 5 minutes while the HUB is up and at `session:start`): a zero-token script that requeues work whose claim expired, flags silent agents, unclaimed handed-back work and provider outages, and gives the Producer one `Watch:` task at a time. Its requeue note carries the agent's last messages and the repo's uncommitted files. The Producer briefing shows a fresh, read-only watcher pass.
- **Onboarding an existing game** (`npm run onboard`, `docs/ONBOARDING-A-GAME.md`): read-only scan of the game's folder, a fact sheet in `studio/game/GAME.md` that the Producer's briefing shows, and the onboarding tasks.
- **Models in the War Room**: `STUDIO_AGENT_MODEL` or `task start --model` tags every event; desks show the model, and silent agents holding work fall asleep ("z") in the Studio view.
- Events can name who they are for (`--to producer`).
### Changed
- The self-test proves every done-check refuses unfinished work, that `--force` reaches the Producer, that the handoff briefing reflects the studio's state, and that meetings write notes and tasks.
- `studio/MASTER.md` and `studio/PLAN.md` are required by the session check.
### Fixed
- `.studio/usage.json` and the status fallback showed invented token savings and quota use. They now show zeros until something is actually measured.

---

## [2.2.1] — 2026-10-20
### Changed (dependency and tooling refresh)
- Node: supported on 22 and 24 (the LTS lines; Node 20 is end-of-life). CI tests both.
- GitHub Actions: checkout v7, setup-node v7, setup-python v7 (no more Node 20 deprecation warning); Python 3.13 in CI.
- CI: new `war-room-build` job builds the War Room and type-checks its React components (`npm run hub:build`).
- Root dev tools: Playwright 1.64.1, Vite 8.3, TypeScript 5.9 (TypeScript 7 not adopted yet: it is the native rewrite and needs its own migration).
- War Room: React 19, @xyflow/react 12.12, xterm 6 (also in the CDN page), Vite 8, @vitejs/plugin-react 6. Lockfiles committed.
- MCP pins: Playwright MCP 0.0.83, Serena v2.1.0 (context `ide`; `ide-assistant` was renamed), blender-orchestrator pinned to a commit SHA.

---

## [2.2.0] — 2026-10-20
### Fixed
- **Purity gate was bypassable**: aliases (`const r = Math.random`), destructuring, `Date()`, `globalThis[...]`, dynamic `import('three')`, `crypto.randomUUID`, timers and `performance['now']` all passed. Now a wider static scan plus a runtime probe that plays every cartridge with those globals trapped.
- **Isolation gate exemptions**: any line containing `playtest`, `__sim` or `__hatch` was skipped. Removed; `.js/.cjs/.jsx` now scanned.
- **Secret scan missed the providers this harness routes to** (OpenAI `sk-proj-`, OpenRouter, NVIDIA, Groq, xAI, Google OAuth) and flagged a developer's own ignored `.env`. It now scans exactly what git would publish.
- **Golden stubs passed**: a missing or `REPLACE…` hash was silently rewritten and the gate passed. Now it fails unless `--update`; a game with no golden fails; Python re-hashes the real replayed state.
- **Regressions without a hash passed.** Now they fail.
- **Optional gates failed `npm run verify`**; optional failures now warn only.
- **Gates dirtied tracked files** (`studio/balance/latest.md`, `studio/fun/latest.md` on every run). They write only with `--write`; `npm run release` fails if a gate changes a tracked file.
- **Locks**: anyone could `task done` a task claimed by another agent, and the lock leaked; `task start` without `--agent` said "locked". `file:` and `path:` keys could collide and nested path locks overlapped. All fixed; shared tool and role names are refused as owners.
- **HUB**: the War Room page never sent the token, so its buttons and socket always got 401; a foreign Host header was served (DNS rebinding); `0.0.0.0` started with no token; the `.env.example` placeholder token unlocked writes if left unchanged; `GET /api/brief` wrote a file; frame telemetry and boot events showed invented numbers. All fixed and covered by `qa/hub-smoke.mjs`.
- **Closed loop recorded "ticks run" as the failing tick** and parsed stdout. It now records the tick the cartridge failed on, from a JSON report, and the trace replays to that tick.
- **Balance sweep was not a sweep**: it subtracted credits outside the sim and the example had no win state (0/4 wins everywhere).

### Added
- `harness/cartridge.mjs`: load any cartridge by name (`--cartridge`, `STUDIO_CARTRIDGE`, or `studio/gates.json`); every tool uses it.
- `npm run new-game <name>`: copies `cartridges/_template`, plays it, writes real golden files.
- `example-sim` gets a `TUNING` table, win/lose outcomes and invariants; `qa.mjs` scenarios with a `start-to-win` policy.
- Vertical slice with a golden hash (`qa/golden/example-sim-start-to-win.json`), checked by `qa/vertical-slice.mjs` for every game.
- `studio/balance/sweep.json` + a real `TUNING` sweep; fun proxies from real runs (idle vs played).
- `qa/selftest.mjs` now proves every required gate fails for its planted reason, after a clean-copy control, plus locks, claims, the pre-commit hook, the closed loop and new-game.
- `npm run hooks:install` (also run by setup): `scripts/hooks/pre-commit` blocks staged secrets and files locked by another owner.
- `npm run release`: syntax, required gates, closed-loop proof, read-only gates, changelog entry.
- Gates: `playtest`, `soak`, `hub-smoke`; `npm run setup` writes a random `HUB_TOKEN`.

---

## [2.1.0] — 2026-10-20
### Added
- **One-Command Setup (`npm run setup` / `scripts/setup.mjs`)**: Creates `.studio/`, `.env`, verifies `.studio/events.jsonl`, and checks readiness in one step.
- **Prepare-Then-Escalate Briefs (`harness/prepare-brief.mjs`)**: Cheap/local model reads `.studio/events.jsonl`, `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, and `studio/NEXT.md` to write a `<= 300`-word execution brief for strong models.
- **Shared Improving Memory (`studio/memory/failures.md` & `docs/MEMORY.md`)**: Implements the Hermes Agent (Nous) 4-bullet post-fix distillation rule (`What broke`, `Root cause`, `The fix that worked`, `How to avoid it next time`).
- **Deterministic Seed Replay & Closed-Loop Gate (`harness/replay.mjs`, `harness/closed-loop.mjs`, `qa/hatchfield.adapter.mjs`, `qa/visual-check.mjs`)**: Enforces mandatory early seed + tick systems (`{ seed, tick, description }`), exposes `window.__hatch` / `window.__sim`, and auto-escalates after `3` failed retries.
- **Expanded Blender Primitives & Orchestrator Docs (`tools/blender/generate_glb.py`, `docs/BLENDER-ORCHESTRATOR.md`)**: Added `crate`, `cone`, `vehicle`, `beacon`, and `hangar` headless `bpy` presets plus `mlolson/blender-orchestrator` guide.
- **New Roles & Cartridge Example**: Added `studio/roles/asset-3d.md`, `studio/roles/playtester.md`, and `cartridges/example-sim/index.mjs`.
- **Daily Rollup & Demo Seeder (`scripts/daily-summary.sh`, `scripts/seed-demo-events.sh`)**: Rolls events + `NEXT.md` into `studio/daily/YYYY-MM-DD.md` with before/after video slots.
- **HUB `/health` Endpoint & Live Runtime Duration (`hub/server.mjs`, `hub/WarRoom.tsx`)**: Added `GET /health` and start-time → duration telemetry on agent nodes.

---

## [2.0.0] — 2026-10-19
### Added
- **7-Module Mission Control War Room (`hub/`)**: `@xyflow/react` uncapped agent graph, 4-source "Agent Eyes" viewport multiplexer (`noVNC`, `WebRTC`, `Playwright CDP`, `HMR`), `xterm.js` WebSocket terminal dock, and `.studio/usage.json` quota bar.

---

## [1.0.0] — 2026-10-19
### Added
- Initial public release of the generalized 3D Deep-Sim & AI Game Studio Harness (`AGENTS.md`, `harness/route.mjs`, `harness/task.mjs`, `qa/playtest.mjs`, `scripts/setup-token-savers.sh`).
