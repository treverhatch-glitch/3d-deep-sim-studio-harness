# Autonomy: the scorecard, the drift checks, hands-off by default, the self-repair loop and the overseer's stages (2.64.0 to 2.73.0)

Two scripts that measure how much the studio needs a person, and notice a session going round in circles. Both
read files and the event log only: no model, no tokens. Neither changes how the studio runs.

## The scorecard (`npm run autonomy`)

```bash
npm run autonomy                                   # the last 7 days: one line, details, daily buckets, the L3 bar
npm run autonomy -- --days 14 --json               # another window, as JSON
npm run autonomy -- --now 2026-11-08T00:00:00Z     # the window ending then (score an older week)
npm run autonomy -- --since 2026-11-01T00:00:00Z   # 2.66.0: the window from then to now
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
| Halt wait | minutes from `supervisor.halted` to `supervisor.resumed` (an open halt counts up to now). 2.67.0: a halt also ends at `supervisor.halt_cleared`, `supervisor.stop` or a new `supervisor.start` (a halt lives in the supervisor's own state); the card names an open one (who, when, cause, its age) and how to clear it (see below) |
| Gate catches | merge-train reds and done-check refusals, per landed task: the gates catching it, not the agents improving |
| Your verdicts | away cards marked great / redo / comment; Redo rate = redo over all three |
| Tokens per landed task | session tokens in the window (counted as the overnight page counts them) over landed tasks |
| Cost per landed task (2.65) | the tokens per landed task, and the same for the window before (the trend). Dollars only with a price table, `studio/prices.json` (`{ "models": { "<model or tool>": { "in": 3, "out": 15, "cacheRead": 0.3 } } }`, USD per million tokens). 2.67.0: the file ships with family rows (`opus`, `sonnet`, `haiku`: a full model id such as `claude-opus-4-5` is priced by the family it names, after its own row and its tool's) and a `"checked"` stamp; the card says "prices from studio/prices.json, checked <date>", and stays in tokens (saying why) while no session in the window has a model it can price. The shipped prices are placeholders (`"checked": "UNVERIFIED"`): compare them with the provider's price page, fix any that differ (add a row under a full model id for a model that costs more than its family) and set `"checked"` to that date. 2.65.2: cache writes (inside `tokensIn`) are priced by TTL, 1.25x input for 5-minute writes and 2x for 1-hour ones (the split from Claude's usage, else the TTL the launcher asked for); a model with no `cacheRead` price reads at 0.1x input; the file's top-level `"multipliers": { "cacheWrite5m": 1.25, "cacheWrite1h": 2, "cacheRead": 0.1 }` changes them. A session whose tool reported its cost (`meta.costUsd`) counts at that cost. Tokens are counted as the budget meter counts them, whoever calls the scorecard |
| Person round-trips per landed task (2.65) | a person's planned and unplanned interventions over landed tasks |
| Orchestrator interventions (2.65) | `conductor.note` events (an outside orchestrator's rulings in a task's record), by who wrote them. 2.67.0: also the orchestrator's other steps: train releases it recorded, `lanes refresh`, holds, a stale halt cleared and any person-only step it recorded (who: `meta.recordedBy`, else the event's agent, when that is an agent outside the harness: not the harness's own scripts, a worker, a launched Producer/Director session or a person acting alone). Planned: notes, releases, refreshes, halt clears and the card's planned types; unplanned: holds and the card's unplanned types |
| Outside work (2.67) | sessions recorded with `npm run usage` (`meta.outside`): counted in the tokens, the cost and the budget like any session, and shown apart with their share |

### Outside work, risk tiers, stale halts and local days (2.67.0)

```bash
npm run usage -- add --agent opus-bot --tokens-in 120000 --tokens-out 8000 --cache-read 900000 --cache-write 40000 --why "integrated train 14"
npm run usage -- import <a Claude Code session .jsonl, or the folder of a project's sessions> --agent opus-bot
```

- **Outside work.** An orchestrator outside the harness (a Claude Code session and its subagents) records its usage:
  `add` appends one `agent.session.end` marked `meta.outside` (`--cost-usd`, `--task`, `--model`, `--tool` optional;
  cache writes go into `tokensIn` as the launcher records them). `import` reads Claude Code transcripts (a folder is
  walked, `subagents/` files included) and records each session per model once: a key (session id, plus the agent id
  for a subagent file, and the model) already imported with the same last message id is skipped, one that grew since
  is recorded for the growth only. Only usage numbers, ids, model names and times are read; no message text is kept or
  printed. A launched worker session is refused (its launcher already counts it). The crew's first card (2026-11-02)
  showed 13M tokens over 7 days while about 50 orchestrator subagents went uncounted: this is what closes that gap.
- **Risk tiers.** The train records a lane's tier on its own `task.train.tier` event (2.63), not on the landing, so
  `tierCUnsigned` read n/a. A landed task's tier is now its latest tier event since its previous landing (or the
  landing's own `meta.tier`); a tier-C landing counts as signed when the tier event names a release or a
  `task.train.released` came between. The bar shows the A / B / C counts.
- **Stale halts.** A halt left open by a supervisor that is gone (it crashed, the PC restarted) kept "still waiting"
  counting. The card names it and says how to clear it. `npm run studio:resume -- --by <name>` (a person; or a
  Producer/Director session or an outside agent with `--permission "<the person's words>"`, never a worker) clears a
  halt older than `STUDIO_HALT_STALE_H` hours (default 24) whose supervisor isn't running: one
  `supervisor.halt_cleared` event (a planned review on the card), and the card stops counting it. A younger one is
  left alone (nothing waits on it; a new supervisor starts unhalted).
- **Local days.** With `STUDIO_TZ` (an IANA zone, e.g. `Asia/Bangkok`) the daily rows are that zone's calendar days,
  each with its UTC span, and the landing times in `--json` (`tasks[].landedLocal`) are local, with `landedUtcDate`
  when the UTC date differs. Without it the days stay UTC (as before) and the card names this computer's zone as a
  hint; `TZ` alone doesn't switch them, so a replay scores the same days on every computer.

### Release impact (2.68.0)

`npm run autonomy -- impact [--release <version>] [--days 3] [--json]` (`harness/impact.mjs`) finds when each harness
version reached the studio (an `upgrade.merged` event, an `Upgrade-Versions` trailer on the upgrade merge, or a
`package.json` version bump on the first-parent line) and compares the same measures over the days before and after
it: landed per hour, train verify minutes p50/p90, red verify %, hand-backs per landed, tokens per kept change, owner
round-trips per landed and no-work sessions. A measure with fewer than `STUDIO_IMPACT_MIN_N` (30) items on either side
reads "not enough data"; within 10% is "same". The verdict is better / worse / mixed by the measures judged, and the
daily digest names the latest upgrade's verdict once one measure has enough data.

2.73.0: when `npm run upgrade -- --merge` left a before snapshot for that release (`.studio/upgrades/<from>-to-<to>.json`,
docs/RELEASE.md), its numbers are the before side (marked `*`): the studio as it was at the moment of the update, not
recomputed later from a log that has rolled over. False reds per train (red train verifies whose tree verified green
later, or whose flake triage labelled every failing test other than "real"), tokens per landed change (also by task, from
sessions that name their task) and workarounds per day are compared too, apart from the verdict. A release's
predictions (`npm run release -- predict`, `docs/releases/<version>.json`) are scored: hit or miss with the measured
change, or not scored while a side has too little data.

### Tokens that do work (2.66.0)

`npm run autonomy` ends its details with a short **Tokens** block (`--json`: `card.tokenWork`; the War Room card shows
the effective-token line). `--since <ISO time>` scores the window from then to now (or to `--now`).

- **Kept.** A landed change is kept when, within `keepDays` (`STUDIO_KEEP_DAYS`, else `"keepDays"` in
  `studio/autonomy.json`, default 7) of its landing, it was not reopened, not reverted (a later commit
  `Revert "…<task>…"` on the checked-out branch, or a merge-train hand-back of the same task after it landed) and not
  redone (a task added naming it: `--caused-by`, `meta.redoOf` / `meta.fixes`, or "redo of T-…" / "fixes T-…" in its
  title). A landing younger than `keepDays` with none of these yet is **pending**: reported apart, counted neither way.
- **Which session paid for what.** Each `agent.session.end` in the window is shared among the task attempts it held
  (an attempt belongs to its agent's first session end at or after its claim, shared by wall time, as
  `docs/METRICS.md` shares tokens). An attempt counts for the landing it led to (a landing after its claim and before
  the task's next claim); one with no landing is **handed back**, or **dropped** when the task was dropped or shelved
  after it; a session that held no attempt (Producer, Director, reviews) is **no task**. A hand-back is judged with its
  task: it stays pending while the landing that followed it is pending, or, with no landing yet, for `keepDays` after
  it (otherwise a young window would count failures at once and successes `keepDays` later).
- **Effective-token ratio** = weighted tokens of kept attempts / all judged weighted tokens (all minus pending). By
  dollars too when they are known (a price table, or every session reporting its cost).
- **Cost per kept change** = judged weighted tokens and dollars / kept landings in the window; also per task type (the
  type done-check gives), without the no-task sessions.
- **Waste split**: reopened, reverted or redone, handed back, dropped, no task: tokens and dollars each.
- **Minimum sample.** A rate on fewer than `"minSample"` items (default 30: sessions for the token ratio and the
  waste shares, judged landings for the keep rate) prints "not enough data (n=…)" with its Wilson 95% interval, never a
  bare percentage. The token ratio's interval counts each session as one item (an approximation: sessions differ in
  size).

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
| `redoRate` | at most 0.1 (the owner's Redo verdicts and failed audits over verdicts plus audits; n/a with none) |
| `tierCUnsigned` | 0 tier-C landings without a signature (n/a until landings carry a risk tier) |
| `confidence` | 0.9 (2.73.0; top level of the file, not under `l3`) |

**Confidence bounds (2.73.0).** Point estimates let a handful of lucky landings suggest L3, so a promotion reads each
rate at its one-sided Wilson bound at `"confidence"` (default 0.9; else `STUDIO_L3_CONFIDENCE`, which applies only
when the file sets none): the hands-free rate's LOWER bound must reach its bar, the reopen and redo rates' UPPER
bounds must stay at or under theirs. The CLI and the card show both and what would clear it, e.g.
`hands-free 0.86 (lower bound 0.70 at 90%, n=14): not yet; about 67 more landings at this rate would clear it`, or
"at this rate it never clears" when the rate itself is on the wrong side. With no reopen the reopen bound needs about
32 landings to fall under 5%. Demotion stays on point estimates (fast to step down, slow to step up). The owner sets
`"confidence": 0` in studio/autonomy.json for the old point-estimate verdicts.

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
  - `rerun-timeout`: a game check that timed out under load (load factor above 1), or (2.65.1) with no quiet passing run
    recorded for it yet while the floor is on ("no quiet run recorded yet"), runs once more at the cap
    (`STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR` x the base), never longer. A pass of that re-run at load factor 1 is the
    check's quiet run (its floor); under load it is only its last passing run, which stands in for the floor until a
    quiet run is recorded.
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
  self-triage can't fix, fuzz findings suggested in the last 24 h (2.66.0, `npm run fuzz`'s shadow week); then (2.66.0)
  the top 5 allowlist candidates from the blocked-command log, the scorecard line, what self-triage fixed and how many
  fuzz bug tasks were filed; (2.71.0) research finished in the last 24 h, with its write-up. Nothing waiting: one line
  says so. `npm run report -- post --what digest` sends it to the owner's webhook (docs/DISCORD-CREW.md).
- **Fuzz bugs** (`npm run fuzz`, qa/fuzz.mjs, 2.66.0; cartridges/README.md, "Fuzz"): suggestions for the first week
  (`autoFileAfter` in `studio/fuzz.json`), then one bug task per new finding id, filed by the script, never twice.
  Each run plays `STUDIO_FUZZ_SEEDS` seeds (20) of `STUDIO_FUZZ_TICKS` ticks (500) per cartridge (or `seeds`/`ticks` in
  `studio/fuzz.json`). An entry in `studio/fuzz.ignore.json` silences a finding, so a lane that adds one (directly or
  by a config proposal) is tier C: a game dev releases it, or an outside agent records their permission. The same holds
  for `studio/quarantine.json` (2.69.0) and `studio/asset-review.json` (2.70.0: the asset preview checks' thresholds).
- **The blocked-command log (2.66.0)** (`npm run denials [-- --days 7] [--json]`, harness/denials.mjs). At session
  end the launcher reads Claude Code's `permission_denials` from every `{"type":"result"}` line of the session's log
  (the crew's logs carry the field on every result line) into `.studio/denials.jsonl`: task, agent, role, tool, a
  redacted command summary (keys, tokens, passwords, `Authorization` headers, `NAME_TOKEN=…`, `--password …`,
  `user:pass@` removed; at most 200 characters), a group key (`Bash(git push *)`, `Read(dir/**)`) and why it was
  refused (not on the list; chained, prefixed or using a variable; on the list but refused by a hook or a rule). A
  result line without the field records nothing. `npm run denials` shows the top commands and the count per task.
  Only plain commands off the list are **candidates**. Nothing ever adds them to `.claude/settings*.json`,
  `harness/allowlist.mjs` or `--allowedTools`: a person reads them and decides.

## The owner's standing delegation to an outside agent (2.67.0)

An outside agent (the crew's orchestrator, a Claude Code session on the owner's PC) can run a short list of owner
actions without the owner's words for each one, for a time the owner sets (harness/delegation.mjs):

    npm run delegate -- grant opus-bot --actions train-release,type,yes,hold --hours 12 --by <owner> [--why "…"]
    npm run delegate -- list | revoke

- **Who grants:** the owner, once, in their own terminal. Refused in a launched session (`STUDIO_ROLE`), a lane copy,
  a coding agent's shell (`CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`), with `STUDIO_AGENT` or an agent's
  name in `STUDIO_LOCK_OWNER`, or an agent's name in `--by`. The grant writes and commits `studio/delegation.json`
  (`{ agent, actions, until, by, at, why }`), which is on the shipped protected list: a lane that writes it is tier C,
  so an agent can't grant itself one. It counts as committed in the main checkout: with an owner key only with a valid
  signature by that key (the grant signs it where the private key is; a changed file is ignored); without one only when
  the commit that set it isn't an agent's (no `Studio-Agent` trailer).
- **What it covers:** `train-release`, `type`, `visual`, `yes`, `hold` (hold and unhold), `upgrade-auto` (2.69.0: the
  auto-upgrade switch, `npm run upgrade -- watch auto on`, recorded for the owner), `asset-review` (2.70.0: answering
  an asset's preview review, `npm run asset -- review`, docs/BLENDER.md), at most 72 hours. The named
  agent runs them with `--by <agent>` and no `--permission`; each use is recorded for the owner by the agent "under
  delegation <at> by <owner>" (the release, the task-types entry, the yes relay, the hold) plus one `delegation.used`
  event, and the daily digest counts them. Never covered: `npm run approve` (signing protected files, tests, hooks,
  force), gates or the protected list, money; workers, launched builder sessions and lane copies.
- **Claude Code's permission prompt, set up once by the owner:** `npm run delegate -- claude-settings` prints narrow
  allow rules for exactly the delegated commands (`Bash(npm run task -- train release:*)`,
  `Bash(node harness/task.mjs train release:*)` and the same for type, yes, hold and unhold); `--write` (the owner's
  terminal only) merges them into the studio's `.claude/settings.json` `permissions.allow`. It never writes a broad
  rule (no `Bash(*)`, no `npm run *`) and never touches deny rules. The rules only skip the prompt; the harness still
  refuses anyone but the delegated agent, and everything once the delegation ends. **Revoke:** `npm run delegate --
  revoke` (anyone may: it only takes power away), then `npm run delegate -- claude-settings --remove --write`.
- `--help` / `-h` on any `npm run task --` subcommand, and on `delegate`, `lanes`, `fuzz` and `denials`, prints usage
  and never acts (B-47: `task train --help` used to run a train).

## The decision log, the studio policy and autonomous mode (2.71.0)

**One decision log.** Every decision the harness leaves to the owner or a game dev writes one record to
`.studio/decisions.jsonl` (the main checkout's) and one `decision` event, where it is decided: train release, task
type and visual proof, the dev's yes, hold and unhold, an asset review, a quarantine confirm or release, deleting stale
lanes, train auto, upgrade auto, crew resume, ending a wind-down, studio resume, a held config proposal, the autonomy
level, a delegation grant or revoke, and autonomous mode itself. A record is `{ id, at, action, subject, by, as, why,
evidence, undo }`; `as` is `person`, `agent` (a decision an agent may take under its own name, such as a hold),
`delegation <grant time>`, `autonomous` or `permission "<the person's words>"`; `undo` says how to revert it (or null).
The older records (task-types.json, the train queue's release, the hold file) stay as they were: the log points at
them, and a revert run from it never logs a second decision.

    npm run decisions [-- --since 24h|7d|<ISO>] [--by <name>] [--action <a>] [--json]

**The studio policy** (`studio/policy.json`, protected; `npm run policy` prints it): the owner's plain rules,
`{ "autonomous": { "allowed", "agent", "actions", "reviewWithinH" }, "never": [...], "notes": [...] }`, and (2.73.0)
`"audit"` (below). No file means
today's behaviour. It counts like the delegation: committed in the main checkout, signed when the studio has an owner
key, otherwise only when the commit that set it isn't an agent's. `notes` are shown to every agent; a `never` word
(`delete-lanes`, `upgrade-auto`, or an action's name) rules that action out for any agent, a delegated one included.

**Autonomous mode** (opt-in per studio): while the policy allows it, the named overseer agent takes the listed
game-dev decisions (default `train-release, type, yes, hold, visual, asset-review, quarantine`) with `--by <agent>`
and no permission words. Each is recorded `as: "autonomous"` and goes on a **review list** that never blocks work.

    npm run policy -- autonomous on --agent <name> [--actions …] [--review-h 72] --by <owner>   the owner's terminal
    npm run autonomy -- mode autonomous on --agent <name> --by <game dev>   a proposal; the owner runs: npm run policy -- confirm --by <owner>
    npm run autonomy -- mode autonomous off --by <name>                    pauses it at once (anyone but a worker)
    npm run decisions -- review                                            the pending autonomous decisions, oldest first
    npm run decisions -- approve <id> --by <you> | revert <id> --by <you> [--why "…"] | edit <id> --note "…" --by <you>
    npm run decisions -- stats [--days 14]

- **Never autonomous, whatever the file says:** protected files, gates (harness code, check silencers, deleted tests)
  and the policy file, money, deletes (`janitor-lanes`, any rm), visibility, keys. A train release in autonomous mode is
  refused for a lane held by any shipped tier-C rule; a lane held only after too many hand-backs, or by a game's own
  rule, may be released.
- **Never self-granted:** `policy autonomous on` and `policy confirm` refuse agents' shells, lanes and launched
  sessions; a policy.json an agent committed doesn't count; a worker can't propose.
- **Review:** a person (or an agent on a person's direct permission), never the agent that decided. `revert` runs the
  record's undo: unhold or hold again, the type or visual proof back, the dev's yes taken back, a quarantine released, an
  asset review reopened, a released lane held again; a lane that already landed gets a revert task instead.
- **Shown:** the War Room snapshot (`decisions`: count, oldest, overdue) and the digest line (decisions per day,
  approved vs reverted and the revert rate, time saved). Past `reviewWithinH` (72) they go under "Needs you".
- **Audits (2.73.0, harness/audit.mjs).** A fixed share of hands-free landings and autonomous decisions is picked
  for an after-the-fact review by someone who didn't do the work: `"audit": { "rate": 0.1 }` in the policy; with no
  rate, 0.1 while autonomous mode is on, else 0. The draw is seeded, never random: sha256 of `studio-audit|<seed>` read
  as a fraction under the rate, the seed being the decision id or, for a landing, the task id (landing events carry no
  commit, and a retry keeps the task id, so retrying can't draw again; `npm run decisions -- audit-draw <id>` shows
  any draw). Picked items are listed by `npm run decisions -- review` (marked `[audit]`) and in the digest, and never
  block work. `npm run decisions -- audit <AU-id> pass|fail --by <name> [--note "…"]` records one (a fail needs a note):
  a person or an agent on a person's permission, never an agent that claimed, ran or landed the task, nor the deciding
  agent. Approving an audited decision passes its audit; reverting or editing it fails it. Each verdict is an `audit`
  record in the log and an `audit.verdict` event; a failed audit counts as a Redo in the redo rate and the L3 bar.
- **Time saved** per action is the median owner wait for that action over the last 14 days from events (held to
  released, an agent's proposal to the dev's yes, a review request to its answer, a proposed quarantine to its
  confirm) less the autonomous decision's own wait; under `STUDIO_DECISION_MIN_N` (10) waits it says "not enough data".

## The self-repair loop: workarounds and harness tasks (2.71.0)

Every time an agent or a person has to work around the harness, it is recorded, and repeats open one task for whoever
maintains the harness (`harness/workaround.mjs`). The loop the overseer used to run in a notes file, kept by the harness.

- **Log one by hand:** `npm run workaround -- log "<what I had to do>" --why "<what the harness did wrong>" [--cmd
  "<command>"] [--by <agent>]`. It goes to `.studio/workarounds.jsonl` and a `harness.workaround` event, with a
  signature: the harness command involved (`npm run studio:stop` reads as `supervisor stop`) plus the "what" without
  ids, hashes and numbers, so the same trouble on another task groups with it. Text is cleaned with the secret
  scanner's patterns first.
- **Detected ones** (`detected: true`, with their evidence; only cheap, certain signals):
  - a hand edit of a harness-owned record: the harness stamps what it writes to the board (`studio/NEXT.md`,
    `studio/DONE.md`) and the train queue (`.studio/train/queue.json`) in `.studio/write-stamps/`; a later file with
    other content and a later time was changed outside the harness (found at the next harness write or scan). A file
    equal to git's HEAD copy (a pull, a merge) or changed after an upgrade or restart was logged is not counted;
  - `--force` on a `task` or `lock` command (a rehearsal's scripted one is not);
  - the same `task` or `lock` command (same subcommand and ids) run `STUDIO_WORKAROUND_RETRIES` (3) times within
    `STUDIO_WORKAROUND_RETRY_MIN` (10) minutes by the same agent, every earlier run having failed (read-only commands
    and `task done --check` don't count);
  - the supervisor stopped by hand and started again within `STUDIO_WORKAROUND_RESTART_MIN` (5) minutes, unless an
    upgrade landed in between;
  - an agent session whose launcher vanished with no stop asked through the harness while the machine stayed up.
  Left out as noisy: a tool process ending by a signal (an out-of-memory kill looks the same) and records the harness
  writes from many places without stamps. `STUDIO_WORKAROUND_DETECT=off` turns detection off.
- **Harness tasks:** a signature seen twice, or once with `--why`, opens ONE task (deduped by signature) in
  `studio/HARNESS-TASKS.md`, with the occurrences, evidence and commands. A separate queue for the harness maintainer:
  never on `studio/NEXT.md`, never for game builders. `npm run workaround -- list | tasks [--all] | close <H-id> --by
  <name> --note "…"` (a builder session can't close one; a closed task seen again reopens). The supervisor runs the
  detection pass every `STUDIO_WORKAROUND_SCAN_MIN` (10) minutes (`npm run workaround -- scan` runs it now). When a
  harness upgrade lands (as the impact report finds it, or the version changing) and a task's signature doesn't occur
  for `STUDIO_WORKAROUND_FIXED_DAYS` (7) days after it, the task is marked "maybe fixed in <version>".
- **Measured:** the daily digest's "Workarounds:" line (in 24 h, per day over 7 days, the top 5 signatures, the trend
  after the latest upgrade, open harness tasks) and `npm run autonomy -- impact` (per day before and after the upgrade,
  the top signatures after it and the trend after each recent upgrade: fewer workarounds means the upgrade worked).
- **Export:** `npm run workaround -- export [--since 7d]` writes `.studio/exports/harness-workarounds-<date>.md`, one file
  the owner can read and send to the harness maintainer (anything matching the secret scanner's patterns removed).

## The overseer's stages, repro PRs and the weekly harness scout (2.73.0)

The owner's plan for an outside overseer agent (the crew's orchestrator), in stages it earns. `studio/overseer.json`
holds the stage the owner set (0-3), the overseer's name (`agent`), who set it and when (`setBy`, `setAt`) and each
stage's entry criteria. It is protected (`studio/protected.json`): it changes only with the owner's signed approval, and
the harness reads it as committed (an uncommitted edit is shown and ignored).

| Stage | The overseer also... |
|---|---|
| 0 reporter | logs workarounds (`npm run workaround -- log`) |
| 1 repro tests | writes failing reproduction tests as harness PRs (`npm run workaround -- repro`) |
| 2 small fixes | makes small non-gate harness fixes, reviewed and merged by someone else |
| 3 own releases | merges its own non-gate harness releases |

Gates, protected files and money stay the owner's at every stage.

- `npm run overseer [-- --json]` shows the stage, what it allows, the evidence since the stage was set and whether the
  next stage's criteria hold: workarounds it logged, accepted repro PRs (distinct `Repro-Of: <H-id>` trailers on commits
  with `Overseer-By: <agent>` that reached the studio through an update), merged PRs (commits with `Overseer-By`), the
  revert rate (those commits reverted) and protected-file attempts (its events and workaround records about protected
  files). A suggestion only: the owner changes the stage. Outcomes the harness can't see (a repro accepted or rejected
  on the harness repo, a PR merged or reverted there, a protected-file attempt) a person records with `npm run overseer
  -- record <repro-accepted|repro-rejected|pr-merged|pr-reverted|protected-attempt> <subject> --by <person>` (the
  decision log; never the overseer itself). Default criteria: stage 1 after 7 days and 10 workarounds logged, stage 2
  after 7 days and 5 accepted repros, stage 3 after 14 days, 10 merged PRs and a revert rate of 0.1 or less; no
  protected-file attempt for any.
- `npm run workaround -- repro <H-id> --by <agent> --harness-repo <dir> [--base <ref>] [--commit]` (stage 1 and up for an
  agent; a person at any stage; never a builder session) scaffolds a failing-test PR branch for the harness from a
  harness task, in a SEPARATE clone of the harness repo (never the studio, its lane copies or its installed harness):
  branch `repro/<h-id>-<sig>`, `qa/selftest-repro-<h-id>.mjs` in the selftest style (the evidence in its header, a
  made-up studio, one check per recorded command of a safe shape, or a TODO check that fails) staged, and the PR body
  with the evidence, a checklist and the `Repro-Of` / `Repro-Signature` / `Overseer-By` trailers in the clone's
  `.studio/repro/<H-id>-PR.md`. `--commit` commits it with those trailers. Nothing is pushed.
- **The weekly harness scout:** with `STUDIO_HARNESS_SCOUT=on` (off by default: the owner turns it on), the supervisor
  files one research task (`--type research`, role rnd) on `STUDIO_SCOUT_DAY` (monday by default; a day name or 0-6, in
  `STUDIO_TZ`, else UTC), once a week and never while the last one is open: "Research: weekly harness scout (week of
  <date>)". Its write-up template asks for new harness and agent-tooling ideas from the past week, each with its sources,
  the claim, whether it is measured or a vendor claim, and which scorecard number it could move (the studio's numbers
  at filing time are in it). Paperwork only: the harness makes no network call.

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
