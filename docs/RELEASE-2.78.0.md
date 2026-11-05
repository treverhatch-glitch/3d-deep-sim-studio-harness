# 2.78.0: builders that get more tasks right (`docs/RELEASE-2.78.0.md`)

2.78 takes the dev plan's research items (PU-54 to PU-63 in `studio/logs/PROPOSALS.md`) that make a builder more likely
to finish a task correctly, or that stop the harness from grading a wrong result as right. It also carries the crew's
B-105 from the 2.77.1 run and the crew's C2(c) from the 48-hour run, and it includes 2.77.3 (docs/RELEASE-2.77.3.md):
a test file that fails alone with a port collision in its output is `port-collision` at once (no quiet wait), and a red
whose failures are only port collisions and load-sensitive files hands nobody back (the lanes wait, as in 2.77.3). None
of it adds a human approval step: beta mode stays as it is.

Each item is marked:

- **ON:** on by default, with the test that proves it.
- **SHADOW:** it runs and records what it would do, but changes nothing until its own data, or the owner, says so.
- **READY, OFF:** the code path is in and tested; the default keeps today's behaviour.
- **REPORT:** a command that measures; it gates nothing.

## What makes builders succeed more often

| Item | Status | What it does |
|---|---|---|
| PU-56: load-sensitive tests (the crew's M7) | ON | A test file that fails "alone" while other verifies run no longer counts as `real` at once. It runs again at low load once the machine is quiet (`harness/flake-quiet.mjs`, waiting at most `STUDIO_FLAKE_QUIET_WAIT_MIN`, 10). It fails there too: `real`. It passes: `load-sensitive` (`.studio/load-sensitive.json`, never quarantined), and a train whose only reds are load-sensitive lands and reports them. A machine that never goes quiet leaves it `real`, "unconfirmed under load". The verify cap is the existing `STUDIO_HEAVY_MAX_VERIFY` (3). C2c: while the quiet re-run waits and runs, new builder and lane verifies wait in the heavy queue (never stopped if already running), bounded by `STUDIO_FLAKE_HOLD_MIN` (default the quiet wait + `STUDIO_FLAKE_WAIT_MIN` + the game check's timeout) and released when it ends or its train dies (qa/selftest-278i.mjs). Why: finished work was handed back four times (T-133) over a 2 ms timing test that ran 2.2–2.5 ms under load. qa/selftest-278a.mjs. |
| B-105: lanes refresh after an upgrade | ON | Every lane refresh (the train's, `npm run lanes -- refresh`, the upgrade's) marks the lane's `studio/` paths left out of its index first, so the merge never touches main's live board files through the link; a real conflict elsewhere still stops it, the files named. A builder's verify in a lane behind main on harness files refreshes the lane itself and runs again on the new code; if it can't, it says to hand the task back (`npm run task -- pause`), never to rebase or restamp. A person or a Producer still gets the refusal and how to fix it by hand. qa/selftest-278h.mjs. |
| PU-58: an honest "impossible" exit | ON | `npm run task -- impossible <ID> --why "…" --agent <you>` is a valid outcome for a task that can't be done as written: no hand-back penalty, no loop park. Builders had only "pass" or "hand back", and research found an abort option cut cheating from 54% to 9%. qa/selftest-278b.mjs. |
| PU-58: canary tasks | ON (only when a Producer adds one) | `npm run task -- add "<title>" --canary "<why it is impossible>"` adds a task that is impossible on purpose; builders aren't told. Each canary's ending is counted per model in `.studio/canaries.json` (honest, cheated, handed back), and a canary closed with `task done` is a P1 ask for the Producer (probable check-bending). The scorecard and metrics no longer count an `impossible` exit as a hand-back or a failure. Note: `.studio/` is reachable from a lane, so a builder that went looking could read the canary list; the path guard doesn't cover it yet. |
| PU-63: start backoff, jittered loop, unique names | ON | A start refused for the same reason as last time is skipped for 2, 4, 8 … minutes, at most `STUDIO_START_BACKOFF_MAX_MIN` (30); a changed reason or task state resets it (`.studio/start-backoff.json`). Why: one refused start was retried 61 times in 85 minutes. The supervisor loop waits `STUDIO_SUPERVISOR_SEC` ± `STUDIO_SUPERVISOR_JITTER` (0.1). A new agent name never reuses one with a leftover `.lanes/<name>` folder or one another launch just took. qa/selftest-278g.mjs. |
| PU-62: futility cap `auto` | ON (per task type, by its own data) | `STUDIO_FUTILITY=auto` is the new default. A task type's cap is enforced only once it has 20 good runs (`STUDIO_FUTILITY_MIN_N`) and its shadow record (at least `STUDIO_FUTILITY_AUTO_MIN_SHADOW`, 5, flagged sessions) shows that at most `STUDIO_FUTILITY_AUTO_MAX_LATE` (0.10) of the sessions it would have stopped went on to succeed. A type without that data stays in shadow; each type that switches on emits one `futility.auto_on`. `=shadow` gives 2.77's behaviour. qa/selftest-278g.mjs. |
| PU-62: routing holdout | READY, OFF | The owner deferred it until API credit is available, so `DEFAULT_HOLDOUT` stays 0. docs/AUTONOMY.md says how to turn it on. |

## What stops a wrong result from passing

| Item | Status | What it does |
|---|---|---|
| PU-54: held-out checks | ON (passes until a studio adds cases) | Cases live in `STUDIO_HOLDOUT_DIR`, by default a folder next to the main checkout, outside every checkout, so no lane copy reaches them, and the path guard refuses builder reads of it. The new required `holdout` gate runs them at the merge train only (in a lane's own verify it says "runs at the train only"). A failure names only the case id and its note. A reused lane verify at the train now runs the train-only gates too. No cases: it passes. docs/HOLDOUT.md, qa/selftest-278c.mjs. |
| PU-55: player journeys | ON (passes with a WARN until a studio adds journeys) | The new required `journey` gate (`qa/journey.mjs`) plays each `studio/journeys/<game>/<id>.json` through public inputs: the goal must hold, the same seed with no input must not reach it, and save, new process, load must reach the same state digest. Research found agent-built games reached their ending in 16% of runs while passing most build checks. The example cartridge has one journey (start-to-win) and `saveState`/`loadState`. docs/JOURNEYS.md, qa/selftest-278d.mjs. |
| PU-57: mutation report | REPORT | `npm run mutants` makes small sim-aware changes in a scratch copy (flip a comparison, drop a system from the tick, skip a save field, ignore an input …) and reports, per gate, which ones no check catches. `--compare` shows a gate's rate change between runs. Settings `STUDIO_MUTANTS_MAX` (40), `STUDIO_MUTANTS_BUDGET_MIN` (20). Not wired as a gate. qa/selftest-278e.mjs. |
| PU-59: the bench's held-out split | ON (for `npm run bench` users) | A harness change benched on held-in and held-out cases gets one of: **accept** (neither split drops, held-out improves or both hold, tokens per pass up at most `STUDIO_BENCH_COST_MAX`, 0.15), **unproven** (only held-in improved: the usual sign of overfitting), **compute-bought** (it improved by spending more) or **reject**. docs/BENCH.md, qa/selftest-278f.mjs. |
| PU-60: plan-time waves | SHADOW | `node harness/plan-waves.mjs` groups the ready tasks into waves that don't overlap (by `--scope`, now settable on any task, and overlap history), and `replay --events … --days 14` says how many recorded overlaps waves would have avoided and at what wall-time cost. The watcher logs `waves.shadow` every 30 minutes. It changes no order. If the serialized share passes `STUDIO_WAVES_MAX_SHARE` (0.6), it says scheduling by waves should not be switched on. qa/selftest-278f.mjs. |

## Not in 2.78

- PU-61 (a `play` criterion judged by an evaluator that can't write): P3, and it builds on PU-55's journeys, so it waits
  until the crew has run those.
- B-99 (agy exits while idle): needs the output of `agy --help` and `agy -p --help` from the crew's PC.

## Untested

- B-105 on a real Windows junction. On Linux the same error ("would be overwritten by merge: studio/task-holds.json")
  is reproduced by clearing the lane's skip-worktree bits, and fixed; the crew's run is the first junction test.
- PU-56's quiet wait on the crew's PC (the selftest fakes the load).
- PU-62 `auto` switching a real task type on: the crew's shadow data decides when; until then every type stays in shadow.

## Upgrade note for Patch

Take this only after the 2.77.x run the owner asked for. Everything in 2.77.3's upgrade note (docs/RELEASE-2.77.3.md) applies too if you skip 2.77.3.

1. `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.78.0"`. It adds two required gates
   (`holdout`, `journey`) to `studio/gates.json`; both pass until the studio adds held-out cases or journeys.
2. `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once (`npm run studio:stop`, `npm run studio:start`).
3. Lanes made before the upgrade: nothing to do. The train or the builder's own verify refreshes them.
4. To compare: `.studio/upgrades/<the version you ran>-to-2.78.0.json` is the before snapshot. After a day, look at hand-backs
   for load-sensitive tests (`.studio/load-sensitive.json`), refused starts (`.studio/start-backoff.json`) and any
   `futility.auto_on` events.
