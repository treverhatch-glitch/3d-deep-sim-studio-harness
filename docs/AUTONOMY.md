# Autonomy: the scorecard, the drift checks and hands-off by default (2.64.0, 2.65.0)

Two scripts that measure how much the studio needs a person, and notice a session going round in circles. Both
read files and the event log only: no model, no tokens. Neither changes how the studio runs.

## The scorecard (`npm run autonomy`)

```bash
npm run autonomy                                   # the last 7 days: one line, details, daily buckets, the L3 bar
npm run autonomy -- --days 14 --json               # another window, as JSON
npm run autonomy -- --now 2026-11-08T00:00:00Z     # the window ending then (score an older week)
```

The same line is at the top of the overnight page (`npm run overnight`), and the War Room's Ops view has an
Autonomy card (read from `GET /api/autonomy`, cached 5 minutes on the hub).

| Measure | How it is counted |
| --- | --- |
| Hours between interventions | supervisor running time (`supervisor.start` to `supervisor.stop`, halted time taken out) divided by the unplanned person interventions; the longest stretch between two is shown too. An unclosed run ends at the log's last event |
| Unplanned interventions | a person: resuming a halted supervisor, forcing a task done (or accepting a forced one), stopping an agent, reopening, dropping, reordering, unblocking or unparking a task, stopping the studio, retyping a task, an away card sent back with "redo" |
| Planned reviews | counted apart: away "great"/"comment", fun verdicts, intent confirmations, the dev's yes, Bible signing, approvals |
| Hands-free land rate | landed tasks (task done, a train landing, a lane merge) not forced, with no person event on the task between the claim that led to the landing and the landing. A person running the train counts on every lane it landed |
| Forced-done rate | landed tasks forced past a check |
| Reopen/escape rate | landed tasks reopened, or named by a bug added `--caused-by`, within 7 days of landing |
| Hand-backs by label | attempts that didn't end done, by the failure labels in `docs/METRICS.md` |
| Halt wait | minutes from `supervisor.halted` to `supervisor.resumed` (an open halt counts up to now) |
| Gate catches | merge-train reds and done-check refusals, per landed task: the gates catching it, not the agents improving |
| Your verdicts | away cards marked great / redo / comment; Redo rate = redo over all three |
| Tokens per landed task | session tokens in the window (counted as the overnight page counts them) over landed tasks |
| Cost per landed task (2.65) | the tokens per landed task, and the same for the window before (the trend). Dollars only with a price table, `studio/prices.json` (`{ "models": { "<model or tool>": { "in": 3, "out": 15, "cacheRead": 0.3 } } }`, USD per million tokens); none ships, so the card says "tokens only" |
| Person round-trips per landed task (2.65) | a person's planned and unplanned interventions over landed tasks |
| Orchestrator interventions (2.65) | `conductor.note` events (an outside orchestrator's rulings in a task's record), by who wrote them |

**Who is a person.** The harness's own rules: `harness/verdict.mjs` `isPerson`, `harness/reclassify.mjs`
`isAgentName` (agent name shapes, a `-bot` suffix, launched session names), and the harness's own scripts
(watchdog, train, supervisor). A decision an agent recorded on a person's direct permission (2.59.1:
`--by <person> --permission "…"`, logged with `meta.permission` and `meta.recordedBy`) is the **person's**
intervention: the person decided; the agent only typed it. The card lists how many came that way.

## Levels and the L3 bar (`studio/autonomy.json`)

The file holds the level the owner set (`"level": "L2"`) and the bar for L3. Defaults:

| Bar | Default |
| --- | --- |
| days | 7 (the window; the log must reach back that far) |
| `hoursBetweenInterventions` | more than 8 |
| `minLanded` | at least 10 landed tasks (so a quiet week can't qualify) |
| `handsFreeLandRate` | at least 0.8 |
| `reopenRate` | at most 0.05 |
| `redoRate` | at most 0.1 (n/a with no away verdicts) |
| `tierCUnsigned` | 0 tier-C landings without a signature (n/a until landings carry a risk tier) |

- **Promotion is only a suggestion.** When every bar holds and the studio is below L3, the card and the CLI say
  "suggest L3 (your call)". Nothing moves until the owner sets `"level": "L3"` in the file.
- **Demotion is suggested on its own.** When the level is L3 and any bar fails, the card names the failing bars
  and suggests going back to L2. The owner changes the file.
- **Who sets the level.** The owner's rule (2026-11-01): a person, a Producer or Director session, or an agent
  outside the harness (on the owner's word) may change `"level"` and the bar; workers never (in a lane copy studio/ is
  main's and a hook refuses edits to studio config). The file is deliberately not in the protected list; a studio
  that wants owner-signed changes only adds `studio/autonomy.json` to `studio/protected.json`.

**Setting the level (2.65.0).** `npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "…"]`
writes `"level"` (and `"levelSet"`: who, when, why, from) and one `autonomy.level` event. A person in their own
terminal and a launched Producer or Director session may run it; an agent outside the harness needs the person's
words or a link (`--permission`, as in harness/permission.mjs); a worker never. The level is set once; agents then make
every decision it allows, and the scorecard only suggests a change.

## Hands-off by default (2.65.0)

Fewer human steps, not easier ones: the harness decides routine questions from evidence and logs why, fixes routine
stops from a fixed list, and sends one daily digest instead of approval pings.

- **The type from the diff.** A task whose title (or role) makes it a "bug" but whose commits change only tests, docs
  or config is judged a "change" by done-check: no regression replay is asked, the output says
  `type: change (evidence: only tests/config changed: …)` and one `task.type.evidence` event records it
  (harness/type-evidence.mjs). Any file in the game's sim paths (`game|web/<g>/sim`, `cartridges/`, the manifest's
  `simPaths`, `pins.files`, `irreversible`, `shared`, `registry`), a golden, a deleted test, the studio's own code or
  other code keeps the bug and its replay. An owner's `npm run task -- type <ID> bug` outranks the evidence.
  `STUDIO_TYPE_EVIDENCE=off` lets the title decide.
- **Self-triage** (harness/self-triage.mjs, the list in harness/self-triage.json; `node harness/self-triage.mjs status`).
  The watchdog runs it on every pass; the supervisor and the game checks ask it when they stop. Each fix is one
  `selftriage.<fix>` event and runs at most once per cause per `onceHours` (6); a cause that comes back, and any cause
  not on the list, still stops for a person (`selftriage.declined` says why). `STUDIO_SELF_TRIAGE=off` turns it off.
  - `reap-orphans`: a machine:heavy holder whose root died with its tree still running: the leftovers are killed and
    the slot freed.
  - `rerun-timeout`: a game check that timed out under load (load factor above 1) runs once more at the cap
    (`STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR` x the base), never longer.
  - `switch-tool`: two sessions ended with exit 127/9009 (the tool isn't on PATH) and another tool of the budget order is
    on PATH: the missing one is marked out for the window, the halt is cleared as `studio:resume` does, by "self-triage".
    A custom command has no other tool and stays halted.
  - `restart-hub`: the hub stopped answering while no supervisor runs: started again.
  - `close-rescues`: rescue tasks of a task that has landed are closed (the sweep behind task done's own close).
  A halt cleared by self-triage is not a person's intervention on the scorecard.
- **The daily digest** (`npm run digest`, harness/digest.mjs): `studio/digest/<date>.md` and one `digest.written`
  event, written by the watchdog once a day at or after `STUDIO_DIGEST_HOUR` (9, local time; `STUDIO_DIGEST=off`
  stops the daily run). Under 200 words, only what needs a person: lanes held for a person's release (tier C) and
  protected files changed without approval, an unsigned Bible and open questions, spend over the weekly target, a halt
  self-triage can't fix; then the scorecard line and what self-triage fixed. Nothing waiting: one line says so.

## Drift checks (Check cards to the Producer)

Each observation of a running session (the launcher's heartbeat, and the watch pass for a session whose
heartbeat stopped) runs these deterministic checks in `harness/stall.mjs` (`driftCheck`):

| Signal | When |
| --- | --- |
| `gate-loop` | the same gate failed with the same signature (its id plus its output, numbers and ids taken out) `STUDIO_DRIFT_SAME_FAIL` (3) times in the session's own verify runs |
| `verify-no-diff` | `STUDIO_DRIFT_SAME_DIFF` (2) verify runs in a row with no change to its working copy since the one before. A file dated after a verify, or rewritten by one, counts as unknown, never as unchanged |
| `out-of-scope` | a file it changed (uncommitted, or committed under its own `Studio-Agent` trailer) outside its task's lane and its path claims. Harness-written files (the board, hand-offs, notes, regressions) and `STUDIO_DRIFT_SCOPE_ALLOW` paths are fine. A session with no lane and no claim (the whole game) isn't judged |
| `no-heartbeat` (2.65.0) | a session the launcher lists running has never sent a heartbeat `STUDIO_DRIFT_NOHEARTBEAT_MIN` (5) minutes after it started: its tool may never have started (not on PATH, a crash at launch) |
| `borrowed-commits` (2.65.0) | its lane holds commits of another **open** task's unlanded lane: shared with that task's lane branch (`.studio/lane-branches.json`) or queued head and not on its own first-parent line (it merged that lane wholesale), or tagged `Studio-Task: <that task>` (a cherry-pick). Its own work now depends on unlanded work: land that task first (`--after`) or take the commits out |

Each signal is raised **once per session** as a `drift.check` event to the Producer, with the task and the
details. A Check never stops, kills, hands back, parks or edits anything: the Producer (or a person) looks, then
nudges, re-scopes or hands the task back. `npm run watchdog -- drift` lists the Checks of running sessions;
`node harness/stall.mjs check` shows them with the stall state. `STUDIO_DRIFT=off` turns the checks off.

There is no model judge: research on long-running agents found a model-based progress monitor hurt structured
tasks. `setDriftAdvisor(fn)` is a hook for an optional advisory note, used only with `STUDIO_DRIFT_ADVISOR=on`;
it can add a note to a Check already raised, never raise, stop or clear one. It is off and unset by default.
