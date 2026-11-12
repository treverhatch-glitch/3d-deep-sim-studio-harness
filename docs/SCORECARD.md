# The round scorecard (`npm run score`)

Fifteen fixed measures of one studio's run, counted from its own logs by a script (no model, no tokens). Run it at the
end of every round of harness work and after every week of studio work; a change to the harness is better only if these
move the right way. It measures and never changes how the studio runs.

```
npm run score                                        the last 7 days of this studio
npm run score -- --days 14 --json
npm run score -- --record 2.82-week1 --note "…"      also writes studio/scores/2.82-week1.json and shows the change
npm run score -- --events a.jsonl,b.jsonl --machine machine-history.jsonl   an exported log (the window ends at its last event)
```

The goal the measures serve: a studio that builds a real, deep game with as little human driving as possible. So the
first three measure who is driving, the next two what it costs, then how often work is redone, how fast it moves, how
well the machine is used, how engine work fares, and how often things break and whether bad work gets out.

| # | Measure | How it is counted | Target | Why this target |
|---|---|---|---|---|
| 1 | Landed with no person or overseer step (%) | landed tasks with no event by a person or an outside agent between claim and landing (`npm run autonomy`'s rule for who is a person) | ≥ 80 | the L3 bar in `studio/autonomy.json` |
| 2 | Supervisor hours per unplanned intervention | supervisor running hours over unplanned person interventions (resume a halt, force, stop, reopen, drop, reorder, unblock, retype) | ≥ 8 h | the L3 bar: a working day without being needed |
| 3 | Outside-overseer steps per landed task | board steps by an agent outside the harness and conductor notes, over landed tasks | ≤ 0.2 | the overseer should handle exceptions, not every task |
| 4 | Cost per landed task ($) | dollars the sessions' tools reported (else `studio/prices.json`) over landed tasks | ≤ 1.50 | the crew's best days were near $1.80 |
| 5 | Spend on Producer and Director sessions (%) | their share of all reported session dollars | ≤ 25 | planning should cost less than building |
| 6 | Done on the first claim (%) | done tasks that were claimed once | ≥ 75 | every extra claim is a session paid twice |
| 7 | Handed back for a harness or machine cause (%) | attempts labelled `env-harness` (`npm run metrics`) over all attempts | ≤ 5 | the harness must not be the reason work stops |
| 8 | Lanes a merge train dropped (%) | dropped over landed plus dropped, from `task.train.done` | ≤ 10 | a lane that passed its own verify should land |
| 9 | Full verify, median (min) | `gates.run` runs that were neither scoped nor partial | ≤ 8 | the wait every builder pays before queueing |
| 10 | Task added to done, median (h) | `task.added` to `task.done` | ≤ 2 | small tasks should be same-session work |
| 11 | Tasks done per supervisor day | `task.done` over supervisor running days | ≥ 60 | above the crew's best week (50) |
| 12 | Machine under 25% CPU (%) | machine samples (`.studio/machine-history.jsonl`) while the supervisor ran | ≤ 30 | an idle rig is unspent capacity; watch it with #14 so it isn't bought with chokes |
| 13 | Engine land runs that passed (%) | `engine.land` with status `pass` over all land runs; the note has the queue wait | ≥ 60 | engine work is the longest and costliest queue |
| 14 | Stalls, dead trains, halts, lost sessions per day | `session.stall`, `task.train.died`, `supervisor.halted`, sessions whose process was gone, over supervisor days | ≤ 5 | each one is a recovery the studio had to make |
| 15 | Landed, then reopened or the cause of a bug (%) | within 7 days of landing | ≤ 5 | the L3 bar: speed must not be bought with escapes |

A measure with nothing to count in the window prints `n/a` and is not judged. The targets live in `harness/score.mjs`
(`MEASURES`); change one only with a note here saying why.

## Baseline

`studio/scores/2026-11-08-baseline.json`: the crew's studio, 2026-10-31 to 2026-11-08 (8.2 days, 55,044 events), on
harness 2.56 to 2.79.2 with an outside overseer.

| # | Measure | Baseline | Target |
|---|---|---|---|
| 1 | Hands-free landings | 29.6% (106 of 358) | ≥ 80% |
| 2 | Hours per unplanned intervention | 2.38 h | ≥ 8 h |
| 3 | Overseer steps per landed task | 1.58 (567 steps) | ≤ 0.2 |
| 4 | Cost per landed task | $2.44 (629k tokens) | ≤ $1.50 |
| 5 | Producer and Director share of spend | 53.6% of $874.50 | ≤ 25% |
| 6 | Done on the first claim | 55.2% (2.3 claims per done task) | ≥ 75% |
| 7 | Handed back for a harness cause | 15.1% of attempts (75% of attempts were handed back in all) | ≤ 5% |
| 8 | Lanes dropped by trains | 29.3% (80 of 273) | ≤ 10% |
| 9 | Full verify, median | 10.3 min (p90 22.6) | ≤ 8 min |
| 10 | Task added to done, median | 3 h (p90 21.7) | ≤ 2 h |
| 11 | Tasks done per supervisor day | 49.6 | ≥ 60 |
| 12 | Machine under 25% CPU | 58.4% of samples (mean CPU 27.5%) | ≤ 30% |
| 13 | Engine land runs that passed | 16.4% (11 of 67); queue wait p90 9.4 h | ≥ 60% |
| 14 | Stalls and losses per day | 31.1 | ≤ 5 |
| 15 | Escapes | 1.1% (4 of 358) | ≤ 5% |

One target of fifteen met. The round's work is judged by the next record against this one.

## The engine flow and the design link (2.82)

Two blocks print under the fifteen measures and are kept in a record (`engine`, `vision`). They are not counted in
the fifteen: one is a single engine's queue, the other a link, and neither has a target yet. What each line counts is
in [NATIVE-ENGINE.md](NATIVE-ENGINE.md).

Baseline from the same log: 67 land runs, 11 lanes landed, 320.3 land-run minutes per landed lane, 16.4% of land runs
passed, 25.4% refused or not run (495.4 minutes waiting), 53% of the minutes in red runs, a passing run 101 minutes
(median). Design link: 57.3% of 358 done tasks trace to a pillar, a kept layer, an approved idea or the owner's ask;
7.8% were asked for by the owner and 92.2% proposed by agents.

## A studio's own progress number (2.83)

`studio/game.json` `engines.<x>.progress` is a command (a string). `npm run score` runs it in the engine's folder
(`engines.<x>.cwd`, else the studio root), for 30 seconds at most, and prints the first non-empty line of its output
(clipped to 200 characters) under the engine block as `Progress (<x>): <line>`. `--record` keeps it in the record as
`progress`. A command that fails, prints nothing or is too slow prints `Progress (<x>): not available (<why>)`; it never
fails the score.

Measure 12 (machine samples under 25% CPU) reads the single samples when the log has them and otherwise the hourly
`machine.sample.summary` events, weighted by each summary's sample count (`meta.cpu`: n, mean, under25, over90). A
summary written before 2.83 has no `meta.cpu`: it is skipped and the note says how many were.

## Which commands a studio runs (2.84)

`npm run commands-run` lists the harness commands this studio has run, by month, and every command file it has never run
(with its npm script names and size). The evidence is an empty marker file per command and month under
`.studio/usage/<YYYY-MM>/`, made when a `harness/` or `scripts/` file run as a command writes its first event (a command that only reads leaves
none, and still writes nothing): the script's name and its
first argument when that is a plain subcommand word, nothing else. It judges commands, not modules: a file never run as
a command may still be used by import. `STUDIO_USAGE_MARKS=off` (default on) makes no markers. It exists so that a
feature nobody uses is cut on a month of evidence from a live studio, not on a guess.
