# 2.83.0: flow (`docs/RELEASE-2.83.0.md`)

The owner's order of 2026-11-11: the next harness upgrade, from the maintainer's plan, the overseer's notes
(26 hours on 2.82 in a native Unity studio) and the crew's own numbers. Built on 2.82.0. What was not run on a real
editor, on Windows beyond the pull request's checks, or in a live studio is UNTESTED and listed in section 6.

## 1. What the records said first

The crew's event log, scored with `npm run score` for the 26.5 hours on 2.82 and for the 4 days before it:

| | 4 days before | 26.5 h on 2.82 |
| --- | --- | --- |
| Scorecard targets met | 2 of 14 | 8 of 14 |
| Engine land runs that passed | 17.6% | 64.5% |
| Land-run minutes per landed lane | 289.5 | 30.4 |
| A passing land run, median | 99 min | 31.4 min |
| Land runs refused or not run | 33.3% | 0% |
| Landed with no overseer step | 30.7% | 51% |
| Tasks landed per day | 37.9 | 46.2 |
| Cost per landed task | $2.53 | $7.21 |
| Producer and Director share of spend | 56.2% | 22.3% |

So 2.82 did what it was for, and the cost moved elsewhere:

- **Sessions scored in the wrong repository.** 89 session ends said "no work" ($268 of $368 session spend) on 50
  tasks; 32 of those tasks later landed. The work was in the engine worktree and the session end looked at the studio
  lane copy. 25 tasks were parked for "2 sessions with no work". This is 2.82's own fault (native mode) and the main
  reason the cost per landed task rose.
- **A plan blocked for two causes.** `plan_blocked` 166 times: 41 for an `--after` naming a task that did not exist,
  26 for one chain-breaker that sat in the train. Each woke the Producer; 79 of its 89 sessions ended in under 3 minutes.
- **A rules check that ran everything.** 24 batches, 50 runs, 514 machine minutes, growing with every ported system.
- **A train that blamed by elimination.** 10 of 30 land runs failed; Play Mode was the first red stage in 5, and it
  grew to 37 to 41 minutes late in the run.
- **`npm run engine -- rules` did not run at all** (exit 13), another fault of 2.82.

## 2. What was built

| Area | What | Where | Checks |
| --- | --- | --- | --- |
| Accounting | An engine task's session is counted where its work is: commits and unsaved files in `.lanes/engine/<task>`; a task in the engine train is "queued", not "no work"; the hand-back note says what is in the engine worktree; the crew breaker counts queued work. | `harness/engine-tracks.mjs` `engineWork`, `harness/agent.mjs`, `harness/crew-watch.mjs` | `qa/selftest-283a.mjs` (6) |
| Engine train | Land alone; one more run before blame on a load-sensitive stage; blame by evidence; a culprit by elimination is run by itself; a handed-back lane leaves the train at once; a full land run once a day; the owner's Edit Mode arguments; the land-script warning; a task stays open until its engine half lands; shared inputs copied at queue time; cleanup on landing. | `harness/unity-train.mjs`, `harness/unity-gate.mjs`, `harness/task.mjs` | `qa/selftest-283b.mjs` (10) |
| Rules check | `rules.env`; `rules.paths` (sparse checkout, LFS not downloaded); `rules.focus` (the touched systems' tests plus a smoke set, the full command every `fullEveryHours`); inputs merged from every lane of the batch; `rules.share`; the command line no longer exits 13; the porter's check runs in a throwaway worktree of the branch or is skipped, never in the studio repo. | `harness/engine-rules.mjs`, `harness/engine-check.mjs` | `qa/selftest-283c.mjs` |
| Planner | A dangling `--after` asks once; `line.chain_gate`; the builders-low alert leads with the reason; Producer wake back-off; `plan_blocked` at most every 30 minutes per cause. | `harness/line-producer.mjs`, `harness/watch.mjs` | `qa/selftest-283f.mjs` |
| Models and slots | `routeRoles`; a refresh, stop or usage limit is not a route failure; planning sessions don't take builder slots; no engine tasks on Vertex (`STUDIO_VERTEX_ENGINE=on` to allow); `mode -- boost on --builders-only`. | `harness/supervisor.mjs`, `harness/busy.mjs`, `harness/mode.mjs` | `qa/selftest-283e.mjs` |
| Board | `task after --remove/--set/--clear`; unknown `--after` ids refused; `task train dequeue`; an unknown train word starts nothing; train status with two lists; `task track <ID> web`; in a native studio a task naming web code goes to the web track. | `harness/task.mjs`, `harness/native.mjs` | `qa/selftest-283d.mjs` |
| Watching | No "stalled" for a lane in a train; one try a day for the same unchanged-shots review; same-family review fallback, marked on the review; the idle stop and claim minutes skip downtime; a dead session's claim handed back after `STUDIO_DEAD_CLAIM_MIN` (30). | `harness/watch.mjs`, `harness/gamedev-loop.mjs`, `harness/review-family.mjs`, `harness/watchdog.mjs`, `harness/task-budget.mjs` | `qa/selftest-283g.mjs` |
| Cleanup | Landed engine worktrees removed; `engines.<x>.builds` keeps the newest builds and a `latest` pointer; `lanes prune` covers engine lanes. | `harness/engine-clean.mjs`, `harness/lanes.mjs` | `qa/selftest-283h.mjs` |
| Owner-only list | The game's own money is not "real money"; code removed in a lane is not "deleting data"; a stand-in's answer records the reading. | `harness/owner-acts.mjs`, `harness/ask.mjs` | `qa/selftest-283j.mjs` (7) |
| Scorecard | CPU measure from the hourly summaries; `engines.<x>.progress` (a command whose two lines are printed under the engine block); `studio/allowlist.json`. | `harness/score.mjs`, `harness/telemetry.mjs`, `harness/allowlist.mjs` | `qa/selftest-283i.mjs` (6) |

The overseer's local patches on 2.82 are all in this release (the rules command line, `routeRoles` for the pool-route
patch, the studio's own command list for the Blender path, the research-media lines in `.gitignore`), so a studio
that carried them drops them at upgrade. The landing-score script named in those patches is the crew's own file and
is not part of the harness.

## 3. What was cut

`harness/token-norms.mjs` and `harness/ledger.mjs` (382 lines), their two npm scripts and their checks. Nothing
imported them and the crew's log holds no run of either. The measurements themselves (events, usage, the scorecard)
are untouched. A search of every other module in `harness/` found none that nothing uses.

## 4. What a studio sets (the owner's files)

In `studio/game.json`, under `engines.<engine>`:

```json
{
  "rules": {
    "test": "dotnet test tools/SimTests",
    "env": { "GAME_WEB_DIR": "{studio}/game/<name>" },
    "paths": ["Assets/Scripts/Sim", "tools/SimTests"],
    "focus": { "test": "dotnet test tools/SimTests --filter \"{filter}\"",
               "map": [{ "match": "Assets/Scripts/Sim/Economy/", "filter": "FullyQualifiedName~Economy" }],
               "smoke": "Category=Smoke", "join": "|", "fullEveryHours": 24 },
    "share": ["Rules~/packs"]
  },
  "retryStages": ["play"],
  "fullLandHours": 24,
  "editModeArgs": "-testCategory \"!Slow\"",
  "builds": { "dir": "D:/builds/gate", "keep": 5, "pattern": "gate-*" },
  "progress": "node tools/progress.mjs"
}
```

Every key is optional and each is described in docs/NATIVE-ENGINE.md. `studio/models.json` takes `"routeRoles"`;
`studio/allowlist.json` takes a studio's own commands. New settings are in docs/SETTINGS.md.

A land script should read one new variable: with `STUDIO_LAND_FULL=1` it runs everything it has, whatever its own
shortcuts are set to.

## 5. Not built, and why

- **A window that collects branches before a land run, and a quiet Play Mode window.** The retry and the blame by
  evidence remove most of what a quiet window would buy; measure a week first.
- **A warm editor between runs.** The measured start-up overhead was about 0.2 minutes of a 31-minute run.
- **A check before a session starts that its task can be done at all** (the cause of most short sessions that are
  left after P-301). Next round, with the decision sheet from the maintainer's plan.
- **Running the rule tests under the editor's own runtime in the cheap check** (the overseer's B-127). The daily full
  land run is the backstop instead.
- **A drift warning that tells uncommitted local patches from real drift.** Not looked at this round.

## 6. Untested

- Everything on a real Unity editor, and on Windows beyond the pull request's checks. The train's checks use a
  stand-in land script and a stand-in rules command in real git repositories.
- `rules.paths` with LFS on Windows; `rules.focus` against a real `dotnet test --filter`.
- The planner's new steps are checked as functions and through `lineProducerPass` not breaking; a week of a live
  plan is the real test of the back-off.
- The owner-only readings are word lists. They were checked on 30 questions; a live studio will find wordings they
  miss. A miss on the safe side asks the owner as before.
- The same-family review fallback on a studio that has only one model family.

## 7. Numbers

72 files, +4,078 / −823 lines (net +3,255) against 2.82.0. The self-test has ten new units (`selftest-283a` to `283j`).
