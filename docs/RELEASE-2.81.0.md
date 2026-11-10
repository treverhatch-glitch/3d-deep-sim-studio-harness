# 2.81.0: grade, measure, cut again (`docs/RELEASE-2.81.0.md`)

The owner's order of 2026-11-10 ("Round 2.81"): an honest verdict against the goal, a scorecard to keep using, the
upgrades that serve autonomy, the approved cuts, the gaps of 2.80, and old caution pruned from the prompts; with the
add-on: port Fable 5.1's round-2 fixes, base the overseer's role on its report, and weigh its verdict. Built on 2.80.0.
Untested on the crew's Windows PC unless it says otherwise.

## 1. The verdict

5 out of 10 overall: a working production line, not yet an autonomous one. By area, with the evidence for each grade:
`studio/notes/VERDICT-2.81-2026-11-10.md`. The baseline it rests on: section 2.

## 2. The scorecard (`npm run score`, docs/SCORECARD.md)

Fifteen fixed measures from a studio's logs, re-run every round: who is driving (hands-free landings, hours per
intervention, overseer steps per landed task), what it costs (dollars per landed task, the Producer and Director share),
how often work is redone (first-claim rate, harness-caused hand-backs, lanes dropped by trains), how fast it moves (full
verify, task added to done, tasks per day), the machine (idle share), engine work (land pass rate, queue wait), breakage
(stalls and losses per day) and escapes. `--record <label>` keeps a round in `studio/scores/` and the next run shows the
change. It reuses `npm run autonomy` and `npm run metrics` for what they already count.

Baseline, the crew's 8.2 days (2026-10-31 to 2026-11-08): 1 of 15 targets met. Hands-free 29.6%; 2.38 h per unplanned
intervention; 1.58 overseer steps per landed task; $2.44 per landed task; 53.6% of spend on Producer and Director
sessions; 55.2% done on the first claim; 15.1% of attempts handed back for a harness cause; 29.3% of lanes dropped by
trains; full verify 10.3 min; 3 h from added to done; 49.6 tasks per supervisor day; machine under 25% CPU in 58.4% of
samples; 16.4% of engine land runs passed; 31.1 stalls or losses per day; 1.1% escapes (the one target met).

## 3. Upgrades: the view on each, and what was built

| Upgrade | View | Built in 2.81 | Left as a plan |
|---|---|---|---|
| Faster tests | The self-test is about 280 units and an hour in one process; the wait an agent feels is the whole run for a one-module change. | `--only`, `--changed [ref]` (the tests that name a changed file; `--deep` adds one hop through importers), `--jobs n`, `--timing`, `--balance` (shards by recorded time); `npm run selftest:changed`, `selftest:fast` (ported from the Fable trial, then narrowed: a change to one module selects 7 to 42 units, not 150). | Commit a timing file from a CI `--timing` run and switch CI to `--balance`; reuse one verified tree in the four slowest units; lower configured waits in the five timeout units (Fable R1 6.1 #1, #2). |
| The overseer's official role | The rules existed in five files and nobody could ask "may I?" beforehand. A model proposes, a script decides. | `npm run overseer -- role | can <action> | pass`; docs/OVERSEER.md (does / signs / human-only, the loop, model and effort plan); `lock release --owner` for the owner's stand-ins. | The loop runner that wakes on events and writes proposals (Fable R1 section 9, item 1): after a week of the pass facts being used by hand. |
| The Line Producer and the rig | The rig idles because work is serialised (lane overlaps, a builder cap of 2), not because resources are guarded too tightly; and heavy jobs still collide. CPU share is the wrong lever: the measure is heavy work waiting while resources were free. | Measure 12 (idle share) and 14 (stalls) in the scorecard; engine first (below). | Port the trial's `rig.decision` event and turn-taking between an engine land and a game verify (RIDS a and c), add a Windows process-memory sampler, then let the Line raise the builder count when the rig is idle and non-overlapping work is ready. One more week of data first. |
| Unity first | Engine work is the longest and worst queue (16.4% of land runs passed, p90 wait 9.4 h). Priority is cheap; speed needs fewer red lands. | Engine first by default: a studio's only engine gets the push (porters head the plan, the land hold has no time limit, two engine slots when the RAM allows) unless someone turned it off. | A porter's quick check before it queues (the config exists: `engines.<x>.quickCheck`), a warm editor kept between lands, test scenes sized to the change: game-side work for the engine track, measured by measure 13. |
| Reference games | Cross-checking a feature against a known game needs a record of what that game does and a check that the task addressed it. | Anchors (ported, section 4): `studio/references/anchors.json`, `task add --anchors`, acceptance lines in the brief, met / unmet / unknown at done. They record behaviour, numbers and pacing as a yardstick, never material. | Filling the anchors for the game's first slice is the Director's and the reference scout's work. |
| Toward full autonomy | Fewer roles and less text to obey. | Liaison and Dev Hacker retired (section 5); prompts pruned (section 7). | The remaining never-launched creative roles stay: a game at the goal's level needs art, sound and narrative. |

## 4. Ported from the Fable 5.1 round-2 trial

@@PORT@@

## 5. Cut

| What | Lines | Why |
|---|---|---|
| The liaison role (`harness/liaison.mjs`, role, skill, its kickoff and every role list) | about 200 | approved; its job was the War Room's chat |
| `harness/experiment.mjs`, the commit-msg hook's experiment lines, and the Dev Hacker flow around it (`tricks.mjs`, role, skill, `docs/DEV-HACKER.md`, the watcher's trick pass, the `hacks` division) | about 460 | approved; never launched, 0 events. No hook re-stamp is needed: stamps don't record the hook files' contents |
| `.studio/war-room.config.json` and its reader, `harness/gate-progress.mjs` (nothing read what it wrote), `hub/**` patterns in eleven modules, the `hub` thread source, the `away.summary_ready` alert kind, stale hub and War Room wording in fifteen docs | about 650 | approved; leftovers of 2.80 |
| Readers of events nothing emits: hub restarts and `harness.crash` in the communicator, the `task.parked` alert kind | 3 | Fable R1 6.2 #2 |

Not cut, with the reason: the asset and art pipeline (2,931 lines, 0 events in the audit week) is not clearly unused
against the goal: the crew ran art sessions and Unity art passes, and content is what a game at this level is mostly
made of. Candidates for the next pass, in order of safety: `token-norms.mjs` (126) folded with `ledger.mjs` (256) into
`tokens`; the router's unused provider chains (`route.mjs` 578, `models.config.mjs` 299; 3 route attempts in 8 days);
the rehearsal pair (138) moved to `qa/fixtures`; idea and floor side-flows with no events (`floors`, `whole-game`,
`ideas`, `waves`, `closed-loop`: 880); release-tag comments older than 2.70 (about 2,700 lines).

## 6. Gaps of 2.80

| Gap | What was done |
|---|---|
| `STUDIO_BUILDER_ORDER` untested live | Tested in real supervisor passes with stand-in starts: `api,plan` with plan headroom starts the pool builder, `plan,api` and no order start a plan builder, a busy pool falls to the plan, `plan` alone starts nothing while the plan is over its target, a pool name with no key mapping never starts (`qa/selftest-279f.mjs`). |
| `STUDIO_WATCH_INTERVAL=0` | Decided: it turns off the watch pass only. In the hub (and 2.80.0) it also stopped the watchdog, retro, learn pass and run report. |
| Tests for N4, N6, N12 | They exist since 2.80 (`qa/selftest-280f.mjs`: the quarantined file a lane changes, `--no-op` on a chore, `test-golden.py` and `kind: test`); nothing to add. |
| Duplicate helpers | One fold this round: the push record is read by one function for the engine line and the Line Producer. The larger folds (one process-alive helper, one `.env` parser, one `studio/game.json` reader) stay first on the next list. |
| The art pipeline | Kept (section 5). |
| Port 3847 on the owner's PC | Nothing in the studio or the crew's harness copy names `127.0.0.1:3847` or `localhost:3847`; `HUB_PORT=3847` is still in the studio's `.env` and is no longer read. |
| `lock release --owner` and the proxy | 2.80 accepted only `STUDIO_OUTSIDE_SIGNERS`; the crew's orchestrator is the owner's proxy. Now also the proxy and beta mode's agents. |

## 7. Old caution pruned from the prompts

Originals: the git tag `prompts-before-2.81` (`git show prompts-before-2.81:AGENTS.md`).

- "Do not scan the repository", "read only", "never read `CHANGELOG.md`", "instead of loading entire files", "don't
  cat": removed, or replaced by where to start and why (the changelog describes behaviour that later changed).
- Token budgets the agent was told to manage: the session prompt no longer carries "refresh at 40 turns or 120k
  tokens" or "every turn re-reads your whole conversation". The launcher's own limit stays (a session ends at 80 turns
  and a fresh one continues); 4% of the crew's sessions passed the old point. Untested as a cost change: measure 4.
- Absolute rules now say their scope and reason: the rules files, the builder, tester, Director and Producer
  kickoffs, ten skills' "Never" lists, eight role files.
- Cautions whose reason is gone: the War Room, the hub, the model-cost order agents never chose, version tags on
  headings.
- Not touched: a studio's own `studio/PITFALLS.md` (its crew wrote it; the same pass is worth doing there).

## 8. Fable R1 section 6, idea by idea

Adopted: `--changed` in the working loop with the full corpus on CI (6.1 #5); shards balanced by time (6.1 #4, built,
not yet switched on in CI); dead consumer branches (6.2 #2); said-vs-did (6.2 #14); retiring unused features where the
crew's data agrees (6.2 #3: the liaison, Dev Hacker, War Room).

Not adopted, each with its reason:
- 6.1 #1, #2, #3 (one verified tree per unit, lower waits, one long-lived process): real time savings, but each changes
  test structure unit by unit; next round, with the timing file to pick from.
- 6.1 #6 (reorganise the corpus by subsystem): `--changed` now finds a unit by the files it names, which was the point.
- 6.2 #1 (event-type catalogue, hard-fail in CI): 660 lines of names to guard names; the dead-reader check gives most
  of the value.
- 6.2 #4, #5 (the remaining off switches; one unit per time setting): they change the crew's `.env`; do them with Patch.
- 6.2 #6 (drop file-local exports), #9 (trim old release-tag comments): cosmetic or text that tests read; a mechanical
  pass of their own.
- 6.2 #7 (a size budget for `train.mjs`, `task.mjs`, `agent.mjs`): adopted as a rule, not as code: a release says by
  how much each grew (section 9).
- 6.2 #8 (one PNG codec): inside the art pipeline, untouched this round.
- 6.2 #10 (fail when `docs/SETTINGS.md` drifts): it would fail a studio's docs gate whenever a doc line moves.
- 6.2 #11 (`studio/settings.json` with a schema): a migration of every setting; not while the crew runs on `.env`.
- 6.2 #12 (flake tracking for self-test units), #13 (`map find` for settings and events): useful, small, not this round.

On its verdict ("freeze harness features except what a vertical slice needs"): agreed, from here on. This round's
additions are measurement, a written role, test speed and ported fixes aimed at measured failures. After 2.81 a
harness change names the scorecard measure it moves.

## 9. Size

@@SIZE@@

## Untested

- Everything on the crew's Windows PC, and every ported feature in a live studio.
- The session prompt without its token numbers, as a cost change.
- Engine first by default with a real Unity editor.
- `--jobs` over the whole corpus (the build machine has 2 cores); `--balance` in CI (no timing file is committed yet).

## Upgrade note

1. Take 2.80.0's note first (docs/RELEASE-2.80.0.md): no hub, the two local patches go.
2. A person runs `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.81.0"`, then
   `node harness/hook-stamp.mjs check` (it should be green: no re-stamp is needed), `npm ci`,
   `npm run upgrade -- --smoke`, and restarts the supervisor once. The merge changes protected files (the commit-msg
   hook, `harness/hook-stamp.mjs`, `scripts/run-gates.mjs`, `qa/selftest*.mjs`, CI): sign them as for every upgrade.
3. A studio that still has a `liaison` or `dev-hacker` task on its board: retire or re-role it. `STUDIO_LIAISON_*`
   settings are flagged by `npm run studio:reload-env`.
4. Engine first is now the default for a studio with one engine. To keep the old split:
   `npm run mode -- engine-push off --by <who>`.
5. Record a score at the end of the first week: `npm run score -- --record 2.81-week1`.
6. The overseer: `npm run overseer -- role --by <its name>` shows what the studio's grants let it sign today.
