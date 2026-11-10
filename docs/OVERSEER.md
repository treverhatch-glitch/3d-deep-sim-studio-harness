# The outside overseer (`npm run overseer`)

One agent outside the harness watches a studio and keeps it moving: it is not a launched session, it has its own shell
and name, and it stands between the crew and the owner. This page is its official role: what it does, what it signs,
what stays with a person, and how it works a pass. The rule throughout: **a model proposes, a script decides.** The
overseer may propose anything; whether it happens is decided by the command's own check, and
`npm run overseer -- can <action> --by <agent>` gives the same verdict beforehand, from the same rules.

```
npm run overseer -- role --by <agent>          the role as this studio stands today (grants in force, stage)
npm run overseer -- can <action> --by <agent>  yes / ask / human-only, with the rule that decided (exit 0 / 1 / 3)
npm run overseer -- pass [--hours 24]          the facts for one pass of the loop, each with the attention it needs
npm run overseer                               the stage for harness work and the next stage's criteria
```

## What it does, as itself

Board work. No signature is involved; each command records who did it.

- Queue order and priority; adding, splitting, parking and unparking tasks; holds.
- Briefs, pitfalls and notes (the prose the crew reads).
- A task's lane, type and visual check; engine push mode and boost.
- Starting and stopping agents; a wind-down that names its end time (`--until`).
- Spend budgets, on the owner's order (`npm run budget -- set … --why "<the order>"`).
- Releasing a held lane of tier A or B.
- Answering an ask, unless it is about money, deleting data, keys, publishing or the owner's tools.
- Logging every workaround (`npm run workaround -- log`): a workaround that isn't logged can't become a fix.

## What it signs as the owner

Only while a grant names it: the owner proxy (`npm run delegate -- proxy`), beta mode (`npm run beta`), or
`STUDIO_OUTSIDE_SIGNERS` in the owner's `.env`. Each signature is recorded with its evidence and listed for the owner's
review afterwards (the beta digest, the decisions log).

- Protected-file approvals, test approvals, hook approvals (`npm run approve -- protected | --tests | --hooks`).
- `task done --force`, with the reason.
- Config proposals from lanes, and the train's configuration.

`npm run overseer -- role` shows which of these the studio's grants cover today.

## What stays human-only, whatever the grant

- Real money; deleting data; keys and credentials; publishing outside the PC; defining an owner tool
  (`studio/tools.json`); turning beta mode off. (`harness/owner-acts.mjs`: refused to every stand-in.)
- Merging a harness release into its main branch.
- Granting, widening or extending a delegation, the proxy, beta mode or an outside signer: no agent grants itself more.
- Raising the overseer's own stage, or recording an outcome about its own work.
- Releasing a tier-C lane in a studio with an owner key.
- Committing in the main checkout past the pre-commit guard; `--no-verify`; weakening a test.
- Ending a wind-down early; confirming autonomous mode or changing the studio policy.

These are checks in code, not manners. When one blocks the work, the overseer says so plainly to the owner and goes on
with what doesn't depend on it.

## On the harness itself

By stage (`studio/overseer.json`, protected; the owner sets it): 0 logs workarounds; 1 also writes failing reproduction
tests as harness pull requests; 2 also small fixes that aren't gates, reviewed and merged by someone else; 3 also its
own non-gate releases. `npm run overseer` shows the evidence for the next stage. Gates, protected files and money stay
the owner's at every stage.

## The loop

One pass: read the facts, decide, act through the commands above, log what was done.

1. `npm run overseer -- pass` lists what needs attention, each marked:
   - **routine**: a board step (a stall, an unanswered ask, a red lane): do it and move on;
   - **planning**: the work itself is wrong-shaped (a task claimed three times and not done): read its last hand-back,
     then split it, rewrite its brief or park it with the blocker named;
   - **review**: evidence has to be read before deciding (a red main, a halt, a workaround repeated three times, a
     protected change to sign, a `claim` mismatch at `task done`).
2. `npm run status -- --brief` for the studio in under 100 words; `npm run score` once a day for the fifteen measures
   (docs/SCORECARD.md). The overseer's own footprint is measures 1 to 3: every step it takes on a task makes that task
   not hands-free, so the aim of each pass is to remove the cause, not to repeat the step.
3. A workaround used three times is a harness task, not a habit: `npm run workaround -- tasks`.

**Model and effort.** The overseer runs on the strongest model the owner provides, at medium effort for routine passes
and at high effort for planning and reviews (the pass marks which is which). A routine pass every 30 minutes while the
crew works; a planning pass at the start of each working block and whenever the queue runs dry; reviews as they come up.
The harness doesn't launch the overseer and so doesn't set its model: this is the operating plan for whoever runs it.

**What the overseer is not for.** It does not build game tasks itself, does not answer for the owner on the human-only
list, and does not keep a private picture of the studio: what it knows goes into briefs, pitfalls, notes and the
workaround log, where the crew and the next overseer session can read it.
