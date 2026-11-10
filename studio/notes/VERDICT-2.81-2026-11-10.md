# Verdict on the harness, round 2.81 (`studio/notes/VERDICT-2.81-2026-11-10.md`)

Written by the harness maintainer session on 2026-11-10. The goal it is judged against: a studio that builds a real,
deep simulation game with as much AI autonomy as possible, toward AAA level. Evidence: the crew's own event log,
2026-10-31 to 2026-11-08 (8.2 days, 55,044 events, harness 2.56 to 2.79.2, one outside overseer), read with
`npm run score`, `npm run autonomy` and `npm run metrics`; Patch's usage audit and field notes; the Fable 5.1 reports.
The numbers are in `studio/scores/2026-11-08-baseline.json`; `docs/SCORECARD.md` says how each is counted.

## Overall: 5 out of 10

The harness works as a production line: in eight days it took 537 tasks, landed 359, and almost nothing bad got out
(4 landings reopened or caused a bug, 1.1%). It does not yet work as an autonomous one: 70% of landings needed a step
from a person or the overseer, the overseer took 567 steps, three quarters of all attempts ended in a hand-back, engine
work mostly failed, and the machine sat idle more than half the time. It is effective at keeping quality, workable with
an overseer, and not yet efficient.

## By area

| Area | Grade | Evidence |
|---|---|---|
| Planning | 5 | 484 of 537 tasks were proposed by agents, so the studio does plan itself. But the Line Producer reported "plan blocked" 224 times against 27 "plan ok", the Director's flow was starved 227 times, 123 tasks were dropped, and the overseer added 168 of the tasks. Planning cost more than building: Producer and Director sessions were 53.6% of the $874.50 spent. |
| Building | 6 | 359 tasks done, 49.6 per supervisor day; median 3 h from added to done. Only 55% were done on their first claim (2.3 claims per done task) and 772 of 1,023 attempts ended in a hand-back. |
| Testing | 6 | The gates catch things: 339 refused "done"s and 44 red trains against 4 escapes. The game tester found 3 real bugs on each of its first runs. But a full verify takes 10.3 min (p90 22.6), trains dropped 29% of the lanes they took (80 of 273), 26 trains died, and main itself was red 11 times. |
| Review | 4 | 13 reviewer sessions in 8 days for 359 landings ($2 of $874). Quality is held by checks, not by review: nothing checked a builder's own "done" note against what it actually ran until this round. The low escape rate says the checks are doing the job so far. |
| Unity work | 3 | 11 of 67 engine land runs passed (16.4%); 39 were red, 15 refused, 2 never ran for lack of RAM. 43 ports queued, 11 landed. A queued port waited a median 0.9 h and up to 9.4 h (p90) for its train; one train ran 13 land runs over 9 hours and landed 2 of 7 lanes. |
| Rig resource use | 3 | CPU under 25% in 58.4% of 1,199 samples (mean 27.5%), GPU about 1.5%, while lands waited for RAM and the supervisor reported low memory 18 times. The rig is neither full nor safe: work is serialised by lane overlaps and a builder cap of 2, and the heavy jobs collide when they do run. |
| Cost and tokens | 4 | $2.44 and 629k tokens per landed task; Opus sessions were 74% of spend. More than half the money went to coordination. Patch's own figures show the trend is right ($18 per landed task early, about $1.80 on the best days). |
| Hands-free rate | 3 | 29.6% of landings (106 of 358) with no person or overseer step; 2.38 supervisor hours per unplanned intervention; 1.58 overseer steps per landed task; 201 logged workarounds, 58 of them the same one (re-running a refused train command). |
| Recovery from failure | 6 | The studio recovers by itself from most small failures: 117 stalled sessions ended, 32 rescues, 18 dead locks released, and the supervisor ran 174 of 197 hours. It does not recover from a halt (3 halts waited 793 minutes for a person) and it lost 79 sessions whose process vanished; the hub was restarted 526 times (it is gone since 2.80). 31 stalls or losses per day is too many to call it steady. |

## What this says to do

1. The failures are in operation, not in missing features. Redo (first-claim rate, hand-backs), engine lands, the
   overseer's footprint and coordination cost are where the points are.
2. Fable 5.1's verdict, "freeze harness features except what a vertical slice needs", is right from here on. 2.80 and
   2.81 cut about 19,000 lines and added measurement (the scorecard), a written overseer role, faster tests and four
   fixes aimed at redo and honesty. After 2.81 the rule for a harness change is: it names the scorecard measure it
   moves, and the next record shows whether it did.
3. The next round is a vertical slice of the game, run by the crew with the overseer in its written role, scored weekly.
