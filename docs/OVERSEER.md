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
npm run overseer -- sheet [--json]             everything waiting on a person or the overseer, each with its command
npm run overseer                               the stage for harness work and the next stage's criteria
```

## The sheet: what waits right now (`npm run overseer -- sheet`)

One page instead of reading six commands. It reads state and changes nothing. A line says how many items wait on a
person and how many on the overseer; then the sections, in this order, each left out when empty: asks waiting (the
owner-only ones first: those need the person), tasks held or parked (grouped by why), train holds, the engine train
(branches handed back with their cause, half-landed tasks, a land-script warning, flaky retries), chains (one task
gating many), dangling waits, dead ends (handed back 3 or more times in 24 h). Each item says what, since when, why, and
the command that resolves it. A studio with nothing waiting prints "Nothing waits". `--json` gives the same as data.

```
2 items wait on a person, 3 on the overseer (2026-11-11 09:30 UTC)

Asks waiting
 Owner only: these need the person:
  - A-004: Buy the paid asset pack?, 2 h 10 min: owner only: spending real money
      → npm run ask -- answer A-004 "<answer>" --by <you>
Tasks held or parked
 Parked by the watchdog:
  - T-210 Door rules, 1 h 5 min: parked by watchdog: handed back 3 times in 2 h
      → npm run task -- unpark T-210 --by <you>
Dangling waits
  - T-300 waits for T-299: T-299 is on neither the open board nor the done list, so T-300 can never start
      → npm run task -- after T-300 --remove T-299
```

## What it does, as itself

Board work. No signature is involved; each command records who did it.

- Queue order and priority; adding, splitting, parking and unparking tasks; holds.
- Briefs, pitfalls and notes (the prose the crew reads).
- A task's lane, type and visual check; engine push mode and boost.
- Starting and stopping agents; a wind-down that names its end time (`--until`).
- Spend budgets, on the owner's order (`npm run budget -- set … --why "<the order>"`).
- Releasing a held lane of tier A or B.
- Cancelling a running engine train cleanly, the queue kept (`npm run task -- train cancel --engine <x> --by <you> --why "…"`; docs/ENGINE-TRACKS.md).
- Turning an engine train's automatic start off for a window, or on (`npm run task -- train auto off|on --engine <x> --by <you> [--hours N]`).
- Answering an ask, unless it is about money, deleting data, keys, publishing or the owner's tools.
- Turning same-family reviews on or off (`npm run review -- same-family on|off|auto --by <you>`, recorded; docs/REVIEWER.md): a beta-time choice, a second model family is the stronger check.
- Logging every workaround (`npm run workaround -- log`): a workaround that isn't logged can't become a fix.

## What it signs as the owner

Only while a grant names it: the owner proxy (`npm run delegate -- proxy`), beta mode (`npm run beta`), or
`STUDIO_OUTSIDE_SIGNERS` in the owner's `.env`. Each signature is recorded with its evidence and listed for the owner's
review afterwards (the beta digest, the decisions log).

- Protected-file approvals, test approvals, hook approvals (`npm run approve -- protected | --tests | --hooks`).
- `task done --force`, with the reason.
- Config proposals from lanes, and the train's configuration.

`npm run overseer -- role` shows which of these the studio's grants cover today.

## What the overseer and an outside signer may decide unattended

As `qa/selftest-284n.mjs` finds it (stdin closed, no TTY, any hour). Proxy: the owner's proxy shell; beta agent: a
beta-mode named agent; signer: `STUDIO_OUTSIDE_SIGNERS`; P/D: a launched Producer or Director session; worker: any
other launched session. "–": not tested.

| Command | Owner in person | Proxy | Beta agent | Signer | P/D | Worker |
|---|---|---|---|---|---|---|
| `task alone <ID> on\|off` (no actor check) | yes | yes | yes | yes | yes | yes |
| `task train dequeue <ID> [--engine x]` (no actor check) | yes | yes | yes | yes | yes | yes |
| `task after <ID> --set\|--remove\|--clear` (no actor check) | yes | yes | yes | yes | yes | yes |
| `task track <ID> web` | yes | yes | yes | yes | yes | no |
| `task unpark <ID>` of the owner's own park | yes | yes | yes | yes | no | no |
| `task unhold <ID>` | yes | yes | yes | yes | yes | no |
| `review -- same-family on\|off\|auto` | yes | yes | yes | yes | no | no |
| `engine -- merge <ID>` (and `--continue`, `--abort`) without the claim | yes | yes | yes | yes | no | no |
| `task train --engine <x>` (never held by the batch window) | – | – | yes | – | – | – |
| `ask -- answer`: a board ask, or one about the game's own money | yes | yes | yes | yes | yes | no |
| `ask -- answer`: real money (owner-only) | yes | no | no | no | no | no |
| `task type <ID> <type>` (with an owner key: the key's signature) | key only | yes | yes | yes | yes | no |
| `mode -- boost on --builders-only` (no actor check) | yes | yes | yes | yes | yes | yes |
| `task unpark` then `agent start --task <ID>` | – | – | yes | – | – | – |
| `approve -- protected` for `studio/game.json`, `studio/allowlist.json` | – | – | – | yes | – | – |
| 2.84 (q), beta mode on (`qa/selftest-284q.mjs`; the signer's shell sets AI_AGENT and names nobody, `--by signer-1`): | | | | | | |
| `task train release <ID>` of a tier-C lane, no `--permission` | – | – | yes | yes | yes (board decision, as before) | no |
| `approve -- force <ID>`, then `task done <ID> --force` | – | – | yes | yes | no | no |
| `task done <ID> --force --train` with a force approval on file (T-662) | – | – | yes | yes | – | – |
| `approve -- protected` of the agent's own change (marked `self: true`) | – | – | yes | yes | no | no |
| `task unpark <ID>` of a park at the orchestrator's rank | – | – | yes | yes | – | no |
| `crew -- resume <role>`, no `--permission` | – | – | yes | yes | yes (as before) | no |
| `review -- same-family on\|off\|auto` | – | – | – | yes | – | no |
| engine train cancel / auto on\|off (part u: same rule, `standInMay('engine-train')`) | – | – | yes | yes | – | – |
| Any of these with beta mode off | – | – | no | no | – | no |
| A session pinned to a task (`STUDIO_TASK_PIN`) saying `--by <the overseer>` | – | – | no | no | – | – |

The owner-only list (`harness/owner-acts.mjs`: money, delete, credentials, publish, tools, beta-off) is the only thing a
stand-in is refused.

2.84 (q), the owner's decision: while beta mode is on, the overseer (a beta-mode named agent) and an outside signer make
these owner decisions themselves, with no owner key and no `--permission`: releasing a tier-C lane, a force approval and a
forced done (also `--force --train` when a force approval is on file), protected-file, test and hook approvals (their
own change included: the approval is marked `self: true`), unparking at any rank, resuming a paused role, and cancelling
an engine train or switching its auto mode. One rule decides all of them, `standInMay(kind, { by, env, root })` in
`harness/beta-mode.mjs` (also exported from `harness/permission.mjs`); each use is one `beta.use` event, listed in the
daily digest's beta section, a self-approval called out as "SELF-APPROVED: … approved its own change to <file>". Never:
a launched session (`STUDIO_ROLE`) or a pinned one (`STUDIO_TASK_PIN`) whatever `--by` says, a worker's name, the
owner-only list, or anyone with beta mode off. The checks themselves (the train's verify, the game's tests, the hooks and
weakened-tests gates, the safety checks of every `task done`) still run: only who approves changed. A harness update
keeps `studio/beta.json` as the studio had it and says whether beta mode is on before and after.

## What stays human-only, whatever the grant

- Real money; deleting data; keys and credentials; publishing outside the PC; defining an owner tool
  (`studio/tools.json`); turning beta mode off. (`harness/owner-acts.mjs`: refused to every stand-in.)
  A question about the game's own money, or about removing code through a lane, is not one of these (2.83,
  docs/SECURITY.md): the overseer may answer it, and the answer records how it was read. (2.85) A refusal names the word
  that made it real money; an ask with no default is escalated to the overseer once (`ask.stale`) after
  `STUDIO_ASK_STALE_H` hours. Hardening: an ask with any money word is never decided by a timer, even when read as the
  game's own money; it reaches the overseer as stale instead. A worker's `--game-rules` tag does not count.
- Merging a harness release into its main branch.
- Granting, widening or extending a delegation, the proxy, beta mode or an outside signer: no agent grants itself more.
- Raising the overseer's own stage, or recording an outcome about its own work.
- Releasing a tier-C lane in a studio with an owner key, unless beta mode is on (then the overseer and an outside
  signer may: 2.84 q, above).
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
