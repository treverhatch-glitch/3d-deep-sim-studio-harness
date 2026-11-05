# 2.78.1: the crew's first day on 2.78 (`docs/RELEASE-2.78.1.md`)

The crew's patch request of 2026-11-05 ~05:40 UTC (B-106 to B-123, M7, the Line Producer and fresh-session asks), item
by item, plus the War Room's Planning Room (the owner's ask) and a long-run preflight. Untested on the crew's Windows PC
unless it says otherwise. 2.78.1 adds no human approval step.

## Critical

| Item | Status | What changed |
|---|---|---|
| **B-123** unscoped ready tasks run one at a time | FIXED | `task lane` was never the problem: a running session's lane was fixed when it launched, so a builder started without one held the whole game until it ended, whatever the board said. The supervisor now reads a running session's lane from the board, so `npm run task -- lane <ID> <folders> --by <you>` takes effect on the next pass (a person, the orchestrator, a Producer or Director; a worker is refused). The Line Producer's pass sets lanes on unscoped ready builder tasks from their `--scope`, the paths they name, their title and plan-waves' history, logs it as its decision, and reports the rest as `unscoped` (`STUDIO_LINE_LANES`). Two builders with no lane run side by side when plan-waves predicts files for both and they don't overlap (`STUDIO_UNSCOPED_PARALLEL=off`). qa/selftest-2781a.mjs. |
| **B-118** agy stream input; failover refused | FIXED | The stream input is the shape Patch probed, `{"event":"user","message":{…}}`. A `--fallback` (and the one-turn relaunch below) continues in the ended session's own lane copy instead of being refused "still in use". **Stream mode is the default for agy builders** (`STUDIO_AGY_STREAM=0` is the one-turn launch); if agy refuses the stream input before its first turn ends, that is recorded once in `.studio/agy-stream.json`, a person is alerted, the session is relaunched in one-turn mode, and later launches skip stream mode until agy changes or the file is deleted. qa/selftest-2781b.mjs. |
| **B-120** hooks base on a studio that doesn't push | FIXED | When the base (origin/main) has no owner key and the studio doesn't push, `approve -- hooks` approvals are verified with local main's committed key; the commits judged are unchanged. `STUDIO_KEY_BASE=off` reverts. qa/selftest-2781c.mjs. |
| grandfather skips release merges | FIXED | `grandfatherRange` also lists the release's own merge commits (by sha) between the base and the release tip; merges the studio makes later are still judged. `STUDIO_GRANDFATHER_MERGES=off`. qa/selftest-2781c.mjs. |

## High

| Item | Status | What changed |
|---|---|---|
| Prompt cache misses | FIXED, smaller than hoped | No per-session value was in the cached part of any role's prompt; the warning misfired on dates inside pitfall text (the same for every session). The real breaker: every launched `task start`/`done`/`pause` rewrote `studio/CURRENT_TASK.md`, which `CLAUDE.md` imports ahead of the prompt. Launched sessions no longer write it (`STUDIO_CURRENT_TASK_FILE`), the prompt is built in one place, and the warning names the line it flags. The system prompt and tool definitions were cached all along, so the saving is a few thousand tokens a session. `node harness/prompt-layout.mjs stability` checks it. qa/selftest-2781e.mjs. |
| **B-121** a builder launched on a task in a Unity train | FIXED | Every engine queue and every live train's lanes count as in progress. qa/selftest-2781f.mjs. |
| **B-122** an old train chain-started after the upgrade | FIXED | A train process records the harness it started with; if it changed, it starts no further train (the queue waits for the fresh daemon, `task.train.chain_stopped`). `STUDIO_TRAIN_HARNESS_GUARD=off`. qa/selftest-2781c.mjs. |
| **B-117** Unity vs game trains; the host stage vs heavy slots | FIXED | The host stage did take a slot: each waiter counted against its own copy of `STUDIO_HEAVY_SLOTS`, so sessions started before `.env` was lowered admitted by the old number. Now the main checkout's `.env` is read each time and the lower count wins (`STUDIO_HEAVY_SLOTS_LIVE=off`). Unity lands take their own engine slot (`STUDIO_ENGINE_SLOTS`, 1; needs a fresh machine scan), their RAM still counts, and they give way while a game train verifies, a game landing is queued or a quiet hold is up. A running engine train's 8 GB counts in the room for builders (`STUDIO_ENGINE_TRAIN_RESERVE`). qa/selftest-2781f.mjs. |
| Load failures dominate trains | FIXED (no red lands without evidence) | A test file recorded load-sensitive at least `STUDIO_LOAD_SENSITIVE_TRUST` (2) times on a quiet machine within `STUDIO_FLAKE_WINDOW_DAYS`, and never `real` since, is re-run alone at low load straight away (no quiet wait); it must still pass there. A lane whose only reds are such files lands, logged "trusted". A trusted label never earns more trust, and any `real` label ends it. `=0`/`off` turns it off. qa/selftest-2781d.mjs. |
| **B-114** still on 2.78 | FIXED (cause not pinned) | The "done, but N commits on lane/… not merged yet" check read only the last 20000 events and the dependency's own closing record. Now a dependency also counts as landed when a done `Rescue: <ID>` task landed, its lane branch brings nothing to main, or the full event history (up to `STUDIO_DEP_HISTORY_MB`) shows a landing. A forced done still waits. Without the crew's event log the exact trigger wasn't confirmed. `STUDIO_DEP_LANDED_EVIDENCE=off`. qa/selftest-2781d.mjs. |
| **B-119** engine-porter with its branch in another worktree | FIXED | A clean worktree that already has the branch is reused; a dirty one, or the land script's own gate worktree, refuses the launch with what to do (`STUDIO_ENGINE_LANE_REQUIRED=off`). qa/selftest-2781e.mjs. |
| Partial landing leaves the task open | FIXED | When the lane's only commits not on main are merges of main that bring nothing beyond it, the task closes as landed (`task.train.main_merges_only`; `STUDIO_TRAIN_CLOSE_MAIN_MERGES=off`). Needs git 2.38+ for the merge check. qa/selftest-2781d.mjs. |

## Medium / low

| Item | Status | What changed |
|---|---|---|
| **B-106** alerts for discarded speculative trains | FIXED | A train with a `task.train.next_discarded` event or an ended `life.json` is not "died silently". qa/selftest-2781d.mjs. |
| **B-116** "main itself fails its checks" right after an upgrade | FIXED | When the checked copy's harness differs from the running one (or an import error names a harness file), the re-check is "not run (harness changed underneath)": main isn't blamed and nobody is handed back. qa/selftest-2781c.mjs. |
| **M7** playtest:stage1 passes in ~33 ms on a lane | FIXED (warns) | On a lane without `--cartridge`, stage 1 played the template example, not the studio's game. Every run now prints the cartridge, ticks, seed and time; when it wasn't the studio's game it WARNs (`QA-STAGE1-NOT-THE-GAME`) in the playtest output, `task done` and done-check. `STUDIO_PLAYTEST_GAME_CHECK=fail` makes it a failure; a 0-tick stage still fails. Default warn so builders' playtests don't all go red mid-run. qa/selftest-2781f.mjs. |
| Orphaned `run-gates.mjs` ran 13 h | FIXED | Each supervisor pass ends gate runs whose parent is gone and that are older than `STUDIO_ORPHAN_GATE_MIN` (60), with their tree, and logs `gate.orphan_ended`; `npm run verify`'s host counts while its verify record names it. qa/selftest-2781c.mjs. |
| `agent stop` + relaunch under the same name | FIXED | Refused up front with a fresh name (`builder-agyf9` → `builder-agyf10`); `--auto-name` (or `STUDIO_AUTO_NAME=on`) uses it. qa/selftest-2781e.mjs. |

## Line Producer

| Item | Status | What changed |
|---|---|---|
| Lanes on every ready builder task; "unscoped" as a blocker | FIXED | See B-123. |
| Unity twins | FIXED (needs config) | A landed game task whose commits touch a path in `studio/game.json` `engines.<x>.twins` (globs, empty by default) gets one `<Label> twin of T-n` engine-porter task, after it; otherwise "no twin needed". `game.json` is protected: the owner adds the paths. `STUDIO_LINE_TWINS=off`. |
| Rig-aware scheduling | FIXED | See B-117: Unity's RAM counts, engine lands give way to game trains. |
| Phase awareness | FIXED | A ready builder task whose lane or predicted files touch shared sim code waits (`--after`) for the open task on the same files, logged and shown in the plan. Shared files: `STUDIO_SHARED_SIM`, else the manifest's `"sharedSim"`, else a generic default (the cartridge's `index.*`, `sim.*`, `core/`, `systems/`, `shared/`, `types.*`). |
| Chain-breaker push | FIXED | While a chain-breaker is queued, new builder verifies and engine lands wait (2.78's quiet hold), at most `STUDIO_LINE_CHAIN_HOLD_MIN` (60). |
| Gemini routing; Gemini reviewer | FIXED | Gemini-first for small and normal tasks is already the harness default: only `studio/models.json` overrides it. Bug found: the agy reviewer ran with no model, so agy's own default (a Claude model) did "Gemini" reviews. It now names a Gemini model and reads the review from stdin. |
| **Planning Room** in the War Room (owner's ask) | NEW | Full width under Production: now, next up (with lanes, "unscoped" in amber, waves, routes), waiting (stacks with why, blocked with the fix), the last pass and its decisions. Read-only, from the existing poll (`harness/planning-room.mjs`). `STUDIO_PLANNING_ROOM=off`. qa/selftest-2781g.mjs; the War Room browser check passes 130/130. |

## Agents: fresh sessions and smaller context

| Item | Status | What changed |
|---|---|---|
| Per-role refresh points | FIXED | Reviewers and engine-porters refresh at 70k (`STUDIO_SESSION_CONTEXT_EARLY`, `STUDIO_SESSION_EARLY_ROLES`); builders stay at 120k; `STUDIO_SESSION_CONTEXT_<ROLE>` and `STUDIO_SESSION_CONTEXT_FACTOR_<WORD>` (e.g. `SONNET=0.8`) override. |
| Hand-off quality | FIXED | Every hand-back carries the lane and branch, the task's commits, the last verify and the exact next command, from git and the gate records; a refresh relaunch quotes them. |
| A fresh agent on a red with a new cause | FIXED | A builder red on a different gate or first failing line, past half its refresh point, hands off to a fresh session (`STUDIO_REFRESH_ON_NEW_RED=off`); a session marked mid-debug keeps going; reviewers never resume a session. |

## Quick upgrades

| Item | Status | What changed |
|---|---|---|
| Orphaned finished work | FIXED | `npm run lanes -- orphans [ID]` lists task commits on lanes that main lacks; `npm run lanes -- carry <ID> --by <you>` cherry-picks only commits naming the task onto a fresh lane (a builder only into its own copy), stopping on a conflict. |
| Empty-diff lanes close at once | FIXED | A tier-A lane whose tip has no file change against main lands and closes without a train verify (`task.train.empty_diff`); its lane check still runs; in a mixed train it lands first (`STUDIO_TRAIN_EMPTY_DIFF=off`). qa/selftest-2781d.mjs. |
| Gemini stream progress watch | FIXED | No tool call and no file write for `STUDIO_AGY_NUDGE_MIN` (10) while the task is in progress sends the "continue" nudge, before the stall kill. |
| Long-run preflight (added) | NEW | `npm run upgrade -- --preflight` gains a "before a long run" section (WARN only): `.env` workarounds a later release made unnecessary (`harness/upgrade-leftovers.json`), ready builder tasks with no lane, uncommitted changes in `harness/` or `scripts/`, and trains or verifies still running from before the upgrade. |

## Untested

- Everything on Windows (the crew's PC): the live `.env` read, the orphan reaper's process tree, the lane-copy reuse in the exact "still in use" state, the engine worktree checks.
- agy: which event real agy prints at a turn end (parsing is tolerant), and `agy --version`.

## Upgrade note for Patch

The merge needs a person (the classifier blocks `upgrade --merge --by hatch` for Patch): grokbot or Hatch runs step 1.

1. Remove your local edit of `harness/agy-stream.mjs` (the userLine `event` patch) first: 2.78.1 carries it, and the
   upgrade would conflict. `git checkout -- harness/agy-stream.mjs`.
2. `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.78.1"`, then
   `node harness/hook-stamp.mjs check` (2.78's release merges are now grandfathered too).
3. `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once (`npm run studio:stop`, `npm run studio:start`).
4. `npm run upgrade -- --preflight`: the "before a long run" section lists what is left to do below.
5. Scope the builders already running without a lane: `npm run task -- lane <ID> <folders> --by opus-1`.
6. Workarounds:
   - `.env` `STUDIO_HEAVY_SLOTS=3`: remove (the `.env` count is now live for every session, Unity has its own slot, and
     collisions are named). If load still bites, set it again: it now really applies.
   - `studio/models.json` Claude first for small/normal (cad90d9a): revert, so the harness default (Gemini first) applies,
     or set `"routes": { "small": ["gemini-flash", "gemini-argon", "claude-sonnet", "claude-opus"], "normal":
     ["gemini-argon", "claude-sonnet", "claude-opus"] }`; then `npm run models -- status`.
   - Gemini as the cross-family reviewer: `STUDIO_REVIEW_TOOLS=agy,claude` in `.env`.
   - Delete `STUDIO_AGY_STREAM=1` if it's set (stream mode is the default).
   - `studio/game.json` `engines.unity.gateWorktree` (your 5c842dba): keep it if that folder is the Unity track you mean; 2.78.1 now refuses an engine launch whose branch is checked out in another, dirty worktree, so the folder
     and the engine cwd must agree.
7. Optional: add your game's Unity-twin paths to `studio/game.json` `engines.unity.twins` (owner-signed: protected).
