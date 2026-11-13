# 2.85.0: hands off (`docs/RELEASE-2.85.0.md`)

The owner's order of 2026-11-13: fix what the overseer listed, make the harness better, clean up its code, and start on
the plan (the designer's vision in front of every agent). Built on 2.84.0. Only this page and the one for 2.84.0 are
kept; older release notes are in git history.

## What the records said

A crew's first 16.3 hours on 2.84, from its event log (`npm run score`):

| Measure | 2.82 (26.5 h) | 2.83 (21.5 h) | 2.84 (16.3 h) |
| --- | --- | --- | --- |
| Scorecard targets met | 8 of 14 | 4 of 15 | 3 of 15 |
| Engine land runs that passed | 64.5% | 34.8% | 46.2% (13 runs) |
| Median passing land run | | 51.1 min | 32.9 min |
| Tasks landed with no overseer step | 51% | 22% | 0% of 26 |
| Cost per landed task | $7.21 | $8.21 | $7.57 |
| Hand-backs with a harness or machine cause | | | 59.5% (68 of 79 attempts) |

2.84 made the land runs pass more often and finish faster. It did not make the studio run by itself: every one of
26 landed tasks needed an overseer step. The log says why:

- **30 of 73 hand-backs were false.** A task whose branch waited in the engine train's queue had its claim expire; the
  harness recorded "the claim ran out with no running session" and handed it back. Three of those in two hours parked
  the task (9 parks), and the overseer unparked by hand (12 times).
- **One refusal looped.** `task done` from the main checkout read every commit landed since the task started, found a
  `Golden-Reason:` line another role had written above a blank line, and refused. Three sessions hit it in four minutes.
- **45 asks went to the Producer** to decide "continue or hand off" for a session at its turn limit.
- **85 warnings said the board was edited by hand.** It was not: a lane copy stamped the board under its own path.
- **The web train never started by itself.** An agent had turned the automatic train off on 2026-11-06 "until the
  engine land holds the lock" and nothing turned it back on; while off, the daemon said nothing.
- **A game-rules question was refused as real money** (it said "dollars" and "fee" in a question about a price rule), and stayed refused with
  the owner's permission quoted.
- **The daily full land run was invisible.** It fell on an ordinary one-branch train, ran every test (about 28 minutes
  more), was read as the compile check running everything, and its failures were blamed on that branch.

So 2.85 is mostly a release of fixes. By the plan's own stop rule (no new layer while the last release's numbers are
worse), only the smallest part of the plan went in: the vision card.

## What was built

| | What | Where | Checks |
| --- | --- | --- | --- |
| Claims of queued work | A task whose branch waits in a train queue is never handed back: its claim is released quietly (`task.claim.released`). The launcher's own bookkeeping after a session ends no longer counts as "still working". | `harness/director-flow.mjs`, `busy.mjs` | `qa/selftest-285d.mjs` |
| One reading of hand-backs | `harness/handback-kind.mjs`: real, a train release, or a repeated refusal. The watchdog, the crew breaker and the score all read it; a train release never counts toward a park. | `handback-kind.mjs`, `crew-watch.mjs`, `session-outcome.mjs`, `score.mjs` | 285d |
| The same refusal twice | Two identical `task done` refusals with no commit between them hold the task; the hold lifts by itself when `task done --check` stops giving that reason (the harness's own look writes no event). Lifted once and refused again for the same reason: held until a planner or the overseer unparks. | `director-flow.mjs`, `agent.mjs` | 285d |
| Ready engine hand-backs | An engine task handed back with its checks green and a note that says it is ready is queued for the train once (`meta.auto`). `STUDIO_ENGINE_AUTO_QUEUE=off` stops it. | `line-producer.mjs` | 285d |
| Trailer check | `task done` reads the task's own commits, in a lane or in the main checkout. The commit-msg hook moves a `Golden-Reason:` line into the trailer block. | `task.mjs`, `trailers.mjs`, `scripts/hooks/commit-msg` | 285d |
| A land with no branch | `node harness/unity-gate.mjs` with no `--task` or `--branch` prints how to call it and runs nothing. | `unity-gate.mjs`; docs/ENGINE-TRACKS.md | 285d |
| Real money | Taken out of the harness (the owner's decision, 13 Nov). The owner-only list no longer has a real-money entry, and no word list reads an ask for spending: the list read game questions as purchases, and a review showed no list catches the real ones. No agent holds a payment method; if spending is ever needed the overseer asks the owner directly. Deleting data, keys, publishing, tool definitions and turning beta off stay the owner's. The word also leaves the autonomy policy's built-in "never" list, the delegation refusals and the filter that tags the owner on asks (deleting, direction and scope still tag him). Spend budgets for model usage are unchanged. | `harness/owner-acts.mjs`, `ask.mjs`, `policy-rules.mjs`, `communicator.mjs`, `delegation.mjs`; docs/SECURITY.md, docs/AUTONOMY.md | `qa/selftest-285c.mjs` |
| Every ask resolves | An ask with a default is decided by it after `STUDIO_ASK_TIMEOUT_H` (4); one with none, or with a protected subject, is escalated once as stale after `STUDIO_ASK_STALE_H` (8) to the Producer and the overseer. An owner-only ask is never timed. `ask -- list --open` shows each ask's age. | `ask.mjs`; docs/OVERSEER.md | 285c |
| Continue or hand off | `STUDIO_REFRESH_DECIDE=rule` (the default; `ask` is 2.84's behaviour): under `STUDIO_REFRESH_HANDOFF_PCT` (60) of the context the session continues; over it, or after `STUDIO_REFRESH_IDLE_TURNS` (40) turns with no commit, it hands off as a refresh. | `session-cap.mjs`, `agent.mjs`; docs/SESSIONS.md | 285c |
| The daily full land run | Announced before it starts (`task.train.<x>.full_land`, the train's status line, the hand-back text) with the minutes the last one took. The compile check's environment carries nothing of the full run. A stage's status is never shown while the next one runs. | `harness/unity-train.mjs`, `unity-gate.mjs` | `qa/selftest-285a.mjs` |
| Target failures | A full run red only on tests no branch in it is tied to: the branches land on the ordinary run's word, the failures go to `.studio/train/<x>-full-baseline.json` and one `engine.full_red_on_target` event; a baseline name clears when the test passes. | `unity-train.mjs`, `engine-rules.mjs` | 285a |
| Suspect first | A failing test is tied to a branch by its assembly folder, its class file less `Tests`, or a folder named in the test's namespace. One tied branch: the train runs again without it. Two or more: each is tried alone. `task.train.<x>.blame` records the reasoning. | `engine-rules.mjs`, `unity-train.mjs` | 285a |
| An unchanged red | A branch handed back by a train is not queued again at the same commit (`.studio/train/<x>-handbacks.json`); `--again` says a person wants it. | `unity-train.mjs`, `task.mjs` | 285a |
| Play Mode by panel | `engines.<x>.play.focus.map` may name a filter per path; a batch that touches two panels runs both filters. `npm run engine -- play-plan` prints what a batch would run. | `engine-rules.mjs`, `engine.mjs`; docs/NATIVE-ENGINE.md | 285a |
| Rules check memory | The split parts run one at a time by default (`rules.focus.splitMax` 1); more only while free memory stays above `rules.focus.splitGb` per part. | `harness/rules-parts.mjs`, `engine-rules.mjs` | `qa/selftest-285b.mjs` |
| The web train's switch | An agent's `train auto off` lapses after `STUDIO_TRAIN_AUTO_OFF_HOURS` (4) or `--hours N`; a person's lasts until turned on. The daemon says why it waits, once per reason (`train.daemon.waiting`), and `train status` shows the switch. | `harness/train-daemon.mjs`, `task.mjs`; docs/WORK-ORGANIZATION.md | `qa/selftest-285e.mjs` |
| "Everything is blocked" | A running engine train counts as work. | `communicator.mjs` | 285e |
| Review answers | The verdict is asked for first; an answer with none gets one short follow-up; `STUDIO_REVIEW_MAX_TOKENS` (4000). | `review-ask.mjs`; docs/REVIEWER.md | 285e |
| Hand-edit warnings | A board write from a lane copy is not a hand edit; a real one is reported once. | `workaround.mjs` | 285e |
| Upgrades by plain merge | The hooks gate and the upgrade report name the one command that accepts a release's commits. `studio:reload-env` lists unknown names on one line. | `hooks-upgrade-hint.mjs`, `upgrade-guard.mjs`, `env-reload.mjs` | 285e |
| The vision card | Every player-facing brief carries, after "What this task is", the signed Bible's lines for it: the pillar it serves, up to six "never" lines chosen by shared words, what has to feel great, the phase goal, and how to stop when the work would break one. No card for docs, infra or an unsigned Bible. `STUDIO_VISION_CARD=off`, `STUDIO_VISION_CARD_WORDS`. `task.start` records `meta.visionCard`; the score counts briefs with one. | `harness/vision-card.mjs`, `focus.mjs`, `score.mjs`; docs/GAME-BIBLE.md | `qa/selftest-285f.mjs` |
| Vision fixes first | `task add --vision-fix` (the Director, the Producer, a playtester through the Producer's proposals, the overseer): offered to a free builder first, first in the next web and engine batch, behind only a fix for a red trunk. A fix of a vision fix is one too. | `harness/vision-fix.mjs`, `task.mjs`, `train.mjs`, `engine-train-control.mjs`, `supervisor.mjs` | 285f |
| Milestones | An exit criterion is met with evidence that exists (a file, a commit, an event id). An agent cannot record one with none. | `harness/producer-refill.mjs` | `qa/selftest-285g.mjs` |
| Golden-Reason | 20 or more characters and a task on the board; "x" no longer waives the golden check. `STUDIO_GOLDEN_REASON=loose` is 2.84's rule. | `harness/test-weakening.mjs` | 285g |
| Rules with no test | A change task that changes sim code and no test gets a WARN line unless a commit carries `No-Test-Reason:`; the `task.done` event and the score count both. A note, not a refusal: `STUDIO_RULES_TEST=require` refuses. | `done-check.mjs`, `score.mjs` | 285g |
| The browser check's game | It plays the studio's active game. An adopted game with no cartridge is "not applicable", never the sample. | `qa/browser-play.mjs`, `agent.mjs` | 285g |
| Hand-back notes | A file the note says it made that exists nowhere: a WARN line and `task.note_unverified`. | `said-vs-did.mjs`, `handback-facts.mjs` | 285g |
| Settings with no reader | `check-docs` fails when a documented or tested `STUDIO_*` name has no production reader. Two removed (the planning-room switch and the VFX capture command). | `scripts/settings-map.mjs`, `docs/settings-runtime.json` | `qa/selftest-285h.mjs` |
| Repeated watch reports | `watch.report` is written once per distinct text in `STUDIO_EVENT_REPEAT_MIN` (60). | `watch.mjs`, `telemetry.mjs` | 285h |
| Comments | 30 files shortened; `npm run check:same-code` proved each file's code tokens unchanged. | | |

## The overseer's list, item by item

1. **compileFirst ran a full land.** It did not: the log shows `compile ... pass (37 s)` and `pass (322 s)`. The run
   after it was the daily full run, which nothing announced. Fixed as "The daily full land run" above; the compile
   check's environment is also cleaned. `compileFirst` can be turned on again.
2. **In-game money read as real money.** The rule that misread it is removed ("Real money").
3. **Asks with no timeout.** Fixed ("Every ask resolves").
4. **The daily full run blames branches for target failures.** Fixed ("Target failures").
5. **Bisect and re-queue of an unchanged red.** Fixed ("Suspect first", "An unchanged red").
6. **Rules split memory.** The split already ran one part at a time; "three test hosts at once" did not come from it.
   The scheduler is now memory-aware in case a studio raises `splitMax`. The likely source is build servers that stay
   alive between runs; `rules.env` can carry `MSBUILDDISABLENODEREUSE=1` and `DOTNET_CLI_USE_MSBUILD_SERVER=0`.
7. **Queue rules written into tasks.** The Director's and the Producer's pages now say never to write queue, batch or
   landing rules into a task: `batchMax` and `batchGroup` decide. A rule on a page, not a check.
8. **The trailer check from the main checkout.** Fixed properly ("Trailer check"); the local patch can go.
9. **Play Mode cost for UI trains.** Per-panel filters and `play-plan`.

Also from the list: the truncated review answer, the web train's auto mode, the "all blocked" alert, `reload-env`.

## The real-money rule, removed

2.83 and 2.84 kept "real money" on the list of things only the owner answers and told it from the game's own money by
word lists. A crew's game-rules question was refused by it for hours. A first fix in this round widened the lists; a
second session then probed them and found that real purchases worded in new ways still passed. A rule that blocks the
game's questions and misses real ones is not worth its code. The owner decided: the harness does not judge real money.
No agent holds a payment method, and the overseer asks the owner directly when spending is needed.

## What was cut, and what was not

The plan's first inventory said 56 settings had no reader, three event kinds were noise and one module was a
duplicate. Checked properly: 2 settings had no reader (the session hooks read most of the rest); the three event
kinds have readers and were already written once per fact (one had a repeat bug, fixed); `harness/decider.mjs` is not
a duplicate of `mayDecide` (16 cases now pinned). An inventory overstates what can be cut; a cut needs proof per item.

## Not tested, and not built

- Nothing here has run on a real engine editor or on a live studio. Every number in "What the records said" is
  measured; every effect of 2.85 is expected, not measured.
- Not tested end to end: the hooks gate's failure path with the new hint (a source check only); the done-time call of
  the hand-back note check (the pause path is tested); a real web train with the vision order (the order is tested on
  the batch function).
- The same-refusal hold's lift check runs in the main checkout. A refusal that only shows in a lane copy lifts once
  wrongly; when the same refusal comes back the task is held again and stays held for a planner or the overseer.
- Not built: tasks stacked on a parent that waits in an engine queue (45 `line.plan_blocked` in the log); the judge
  before landing, the daily pictures and the consolidation releases of the plan, which wait for 2.85's numbers.

## Upgrading

`npm run upgrade -- --merge <ref> --by <who>`, not a plain `git merge` (a plain merge leaves the release's commits unstamped and
the hooks gate red; 2.85's gate now prints the one command that fixes it). Beta mode survives the upgrade
(`studio/beta.json` is kept since 2.84). A lane in flight whose golden commit carries a short `Golden-Reason` is
refused under the new rule: `STUDIO_GOLDEN_REASON=loose` for that day lets it land.
