# Autonomy: the scorecard and the drift checks (2.64.0)

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
