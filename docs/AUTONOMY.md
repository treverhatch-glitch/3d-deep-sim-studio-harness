# Autonomy: the scorecard, levels, hands-off defaults, delegation and beta mode, the decision log, self-repair, the overseer and drift checks

How much the studio needs a person, and what the harness may decide without one. The scorecard and the drift checks read files and
the event log only (no model, no tokens) and change nothing about how the studio runs. Older wording is in git history
(`git log -p -- docs/AUTONOMY.md`); a tag such as (2.73.0) says which release added a feature. Who may do what and what stays the owner's:
`docs/SECURITY.md`.

## The scorecard (`npm run autonomy`)

```bash
npm run autonomy                                   # the last 7 days: one line, details, daily buckets, the L3 bar
npm run autonomy -- --days 14 --json               # another window, as JSON
npm run autonomy -- --now 2026-11-08T00:00:00Z     # the window ending then (score an older week)
npm run autonomy -- --since 2026-11-01T00:00:00Z   # the window from then to now
```

The same line is at the top of the overnight page (`npm run overnight`).

| Measure | How it is counted |
| --- | --- |
| Hours between interventions | supervisor running time (halted time taken out) over unplanned person interventions; the longest stretch is shown too |
| Unplanned interventions | a person: resuming a halted supervisor, forcing a task done (or accepting a forced one), stopping an agent, reopening, dropping, reordering, unblocking or unparking a task, stopping the studio, retyping a task, an away card sent back with "redo" |
| Planned reviews | counted apart: away "great"/"comment", fun verdicts, intent confirmations, the dev's yes, Bible signing, approvals |
| Hands-free land rate | landed tasks (task done, train landing, lane merge) not forced, with no person event on the task between the claim and the landing; a person running the train counts on every lane it landed |
| Forced-done rate | landed tasks forced past a check |
| Reopen/escape rate | landed tasks reopened, or named by a bug added `--caused-by`, within 7 days |
| Hand-backs by label | attempts that didn't end done, by the failure labels in `docs/METRICS.md` |
| Halt wait | minutes from `supervisor.halted` to `supervisor.resumed`; a halt also ends at `supervisor.halt_cleared`, `supervisor.stop` or a new `supervisor.start`; the card names an open one (who, when, cause, age) |
| Gate catches | merge-train reds and done-check refusals per landed task |
| Your verdicts | away cards marked great / redo / comment; Redo rate = redo over all three |
| Tokens / cost per landed task | session tokens in the window over landed tasks, and the window before (the trend). Dollars only with `studio/prices.json` (below) |
| Person round-trips per landed task | a person's planned and unplanned interventions over landed tasks |
| Orchestrator interventions | `conductor.note` events by who wrote them, plus the orchestrator's other steps (train releases, `lanes refresh`, holds, stale halt clears, person-only steps it recorded). Planned: notes, releases, refreshes, halt clears; unplanned: holds |
| Outside work | sessions recorded with `npm run usage` (`meta.outside`): counted in tokens, cost and budget like any session, and shown apart with their share |

**Prices** (`studio/prices.json`): `{ "models": { "<model or tool>": { "in": 3, "out": 15, "cacheRead": 0.3 } } }`, USD per million
tokens; it ships family rows (`opus`, `sonnet`, `haiku`; a full model id is priced by its own row, its tool's, then the family it
names) and a `"checked"` stamp, `UNVERIFIED` until the owner compares the placeholders with the provider's page and sets the date. The
card stays in tokens (saying why) while no session in the window has a model it can price. Cache writes are priced by TTL, 1.25x
input for 5-minute and 2x for 1-hour writes; a model with no `cacheRead` price reads at 0.1x input; the top-level `"multipliers": {
"cacheWrite5m": 1.25, "cacheWrite1h": 2, "cacheRead": 0.1 }` changes them. A session whose tool reported its cost (`meta.costUsd`)
counts at that cost.

**Who is a person**: `isPerson` in `harness/verdict.mjs`, `isAgentName` in `harness/reclassify.mjs` (agent name shapes, a `-bot` suffix,
launched session names), and the harness's own scripts (watchdog, train, supervisor) are not. A decision an agent recorded on a
person's direct permission (`--by <person> --permission "…"`, `meta.permission`, `meta.recordedBy`) is the person's intervention.

### Outside work, risk tiers, stale halts, local days

```bash
npm run usage -- add --agent opus-bot --tokens-in 120000 --tokens-out 8000 --cache-read 900000 --cache-write 40000 --why "integrated train 14"
npm run usage -- import <a Claude Code session .jsonl, or the folder of a project's sessions> --agent opus-bot
```

- **Outside work**: an orchestrator outside the harness records its usage. `add` appends one `agent.session.end` marked `meta.outside`
  (`--cost-usd`, `--task`, `--model`, `--tool` optional; cache writes go into `tokensIn`). `import` reads Claude Code transcripts (a
  folder is walked, `subagents/` included) and records each session per model once (an already imported key is skipped; one that grew
  records only the growth). Only usage numbers, ids, model names and times are read. A launched worker session is refused.
- **Risk tiers**: a landed task's tier is its latest `task.train.tier` event since its previous landing (or the landing's `meta.tier`);
  a tier-C landing counts as signed when that event names a release or a `task.train.released` came between. The bar shows A / B / C counts.
- **Stale halts**: `npm run studio:resume -- --by <name>` (a person; or a Producer/Director session or an outside agent with
  `--permission "<the person's words>"`, never a worker) clears a halt older than `STUDIO_HALT_STALE_H` hours (default 24) whose
  supervisor isn't running (`supervisor.halt_cleared`, a planned review); a younger one is left alone.
- **Local days**: with `STUDIO_TZ` (an IANA zone, e.g. `Asia/Bangkok`) the daily rows are that zone's days (with their UTC span;
  `tasks[].landedLocal`, `landedUtcDate` in `--json`). Without it days stay UTC; `TZ` alone doesn't switch them.

### Release impact (2.68.0)

`npm run autonomy -- impact [--release <version>] [--days 3] [--json]` (`harness/impact.mjs`) finds when each harness version reached
the studio (an `upgrade.merged` event, an `Upgrade-Versions` trailer, or a `package.json` version bump) and compares the days before and
after: landed per hour, train verify minutes p50/p90, red verify %, hand-backs per landed, tokens per kept change, owner round-trips per
landed, no-work sessions. Fewer than `STUDIO_IMPACT_MIN_N` (30) items on either side reads "not enough data"; within 10% is "same". The
verdict is better / worse / mixed, and the daily digest names the latest upgrade's. When `npm run upgrade -- --merge` left a before
snapshot (`.studio/upgrades/<from>-to-<to>.json`, `docs/RELEASE.md`) its numbers are the before side (marked `*`). False reds per train,
tokens per landed change and workarounds per day are compared apart from the verdict. A release's predictions (`npm run release --
predict`, `docs/releases/<version>.json`) are scored hit or miss, or not scored with too little data.

### Tokens that do work (2.66.0)

The details end with a **Tokens** block (`--json`: `card.tokenWork`).

- **Kept**: a landed change is kept when, within `keepDays` (`STUDIO_KEEP_DAYS`, else `"keepDays"` in `studio/autonomy.json`, default 7)
  of landing, it was not reopened, reverted (a later `Revert "…<task>…"` commit, or a train hand-back of the task) or redone (a task
  naming it: `--caused-by`, `meta.redoOf` / `meta.fixes`, or "redo of T-…" / "fixes T-…" in its title). Younger than `keepDays` with
  none of these: **pending**, counted neither way.
- **Which session paid for what**: each `agent.session.end` is shared among the task attempts it held (by wall time, as `docs/METRICS.md`).
  An attempt counts for the landing it led to; one with none is **handed back**, or **dropped** when the task was dropped or shelved; a
  session with no attempt is **no task**. A hand-back stays pending while the following landing is pending, or for `keepDays` after it.
- **Effective-token ratio** = weighted tokens of kept attempts / all judged (all minus pending), by dollars too when known. **Cost per
  kept change** = judged tokens and dollars / kept landings, also per task type. **Waste split**: reopened/reverted/redone, handed back,
  dropped, no task.
- **Minimum sample**: a rate on fewer than `"minSample"` items (default 30) prints "not enough data (n=…)" with its Wilson 95% interval.

## Levels and the L3 bar (`studio/autonomy.json`)

The file holds the level the owner set (`"level": "L2"`) and the bar for L3 (`l3`, `days`):

| Bar | Default |
| --- | --- |
| days | 7 (the log must reach back that far) |
| `hoursBetweenInterventions` | more than 8 |
| `minLanded` | at least 10 landed tasks |
| `handsFreeLandRate` | at least 0.8 |
| `reopenRate` | at most 0.05 |
| `redoRate` | at most 0.1 (the owner's Redo verdicts and failed audits over verdicts plus audits) |
| `tierCUnsigned` | 0 tier-C landings without a signature |
| `confidence` | 0.9 (top level of the file, not under `l3`) |

- **Confidence bounds** (2.73.0): promotion reads each rate at its one-sided Wilson bound at `"confidence"` (else `STUDIO_L3_CONFIDENCE`,
  applied only when the file sets none): the hands-free rate's LOWER bound must reach its bar, the reopen and redo rates' UPPER bounds must
  stay at or under theirs. The card shows both and what would clear it. Demotion stays on point estimates. `"confidence": 0` gives the old
  point-estimate verdicts.
- **Promotion is only a suggestion** ("suggest L3 (your call)"); nothing moves until the owner sets `"level": "L3"`. **Demotion** is
  suggested on its own when the level is L3 and any bar fails.
- **Who sets the level**: a person, a Producer or Director session, or an agent outside the harness on the owner's word; never a
  worker. The file is deliberately not protected; a studio wanting owner-signed changes adds `studio/autonomy.json` to
  `studio/protected.json`.
- `npm run autonomy -- level <L1|L2|L3|L4> --by <name> [--why "…"] [--permission "…"]` (2.65.0) writes `"level"` and `"levelSet"` and one
  `autonomy.level` event. A person and a launched Producer or Director session may run it; an agent outside the harness needs
  `--permission` (`harness/permission.mjs`); a worker never.

## Hands-off by default (2.65.0)

The harness decides routine questions from evidence and logs why, fixes routine stops from a fixed list, and sends one daily digest.

- **The type from the diff**: a "bug" whose commits change only tests, docs or config is judged a "change" by done-check (no regression
  replay; `task.type.evidence`, `harness/type-evidence.mjs`). Any file in the game's sim paths (`game|web/<g>/sim`, `cartridges/`, the
  manifest's `simPaths`, `pins.files`, `irreversible`, `shared`, `registry`), a golden, a deleted test, the studio's own code or other
  code keeps the bug and its replay. `npm run task -- type <ID> bug` outranks the evidence.
- **Self-triage** (`harness/self-triage.mjs`, list in `harness/self-triage.json`; `node harness/self-triage.mjs status`): the watchdog runs
  it every pass; the supervisor and game checks ask it when they stop. Each fix is one `selftriage.<fix>` event, at most once per cause
  per `onceHours` (6); a cause that returns, or is not on the list, still stops for a person (`selftriage.declined`).
  `STUDIO_SELF_TRIAGE=off` turns it off. Fixes: `reap-orphans` (a `machine:heavy` holder whose root died: leftovers killed, slot freed);
  `rerun-timeout` (a game check that timed out under load, or has no quiet passing run yet while the floor is on, re-runs once at
  `STUDIO_GAME_GATE_TIMEOUT_MAX_FACTOR` x the base, never longer); `switch-tool` (two sessions ended with exit 127/9009 and another tool of
  the budget order is on PATH: the missing one is marked out for the window and the halt cleared; a custom command stays halted);
  `close-rescues` (rescues of a landed task). A halt cleared by self-triage is not a person's intervention.
- **The daily digest** (`npm run digest`, `harness/digest.mjs`): `studio/digest/<date>.md` and a `digest.written` event, written by the
  watchdog once a day at or after `STUDIO_DIGEST_HOUR` (9, local; `STUDIO_DIGEST=off` stops it). Under 200 words, only what needs a
  person: lanes held for release (tier C), protected files changed without approval, an unsigned Bible and open questions, spend over
  the weekly target, a halt self-triage can't fix, fuzz findings; then the top 5 allowlist candidates, the scorecard line, what
  self-triage fixed, fuzz bug tasks filed, finished research. `npm run report -- post --what digest` sends it to the owner's webhook
  (`docs/DISCORD-CREW.md`). It ends with a `## Beta mode` section (see below).
- **Fuzz bugs** (`npm run fuzz`, `qa/fuzz.mjs`; `cartridges/README.md`, "Fuzz"): suggestions for the first week (`autoFileAfter` in
  `studio/fuzz.json`), then one bug task per new finding id, never twice. Each run plays `STUDIO_FUZZ_SEEDS` seeds (20) of
  `STUDIO_FUZZ_TICKS` ticks (500) per cartridge (or `seeds`/`ticks` in `studio/fuzz.json`). An entry in `studio/fuzz.ignore.json`
  silences a finding, so a lane adding one (directly or by a config proposal) is tier C; the same holds for `studio/quarantine.json` and
  `studio/asset-review.json` (the asset preview thresholds).
- **The blocked-command log** (`npm run denials [-- --days 7] [--json]`, `harness/denials.mjs`): at session end the launcher reads Claude
  Code's `permission_denials` into `.studio/denials.jsonl` (task, agent, role, tool, a redacted command of at most 200 characters, a
  group key, why refused). Only plain commands off the list are candidates. Nothing ever adds them to `.claude/settings*.json`,
  `harness/allowlist.mjs` or `--allowedTools`: a person decides.

## Delegation to an outside agent

An outside agent (the crew's orchestrator) can run a short list of owner actions for a time the owner sets (`harness/delegation.mjs`):

```bash
npm run delegate -- grant opus-bot --actions train-release,type,yes,hold --hours 12 --by <owner> [--why "…"]
npm run delegate -- list | revoke
```

- **Who grants**: the owner, once, in their own terminal; refused in a launched session (`STUDIO_ROLE`), a lane copy, a coding agent's
  shell (`CLAUDECODE`, `AI_AGENT`, `CODEX_SANDBOX`, `GEMINI_CLI`), with `STUDIO_AGENT` or an agent's name in `STUDIO_LOCK_OWNER`, or an
  agent's name in `--by`. It writes and commits `studio/delegation.json` (`{ agent, actions, until, by, at, why }`), on the shipped
  protected list (a lane writing it is tier C). It counts as committed in the main checkout: with an owner key only with a valid signature
  by that key; without one only when the commit isn't an agent's (no `Studio-Agent` trailer).
- **Covers**: `train-release`, `type`, `visual`, `yes`, `hold` (and unhold), `upgrade-auto` (`npm run upgrade -- watch auto on`),
  `asset-review` (`npm run asset -- review`, `docs/BLENDER.md`), at most 72 hours. The agent runs them with `--by <agent>` and no
  `--permission`; each use is recorded for the owner "under delegation <at> by <owner>" plus a `delegation.used` event, and the digest
  counts them. Never covered: `npm run approve`, gates or the protected list; workers, launched builder sessions, lane copies.
- **Claude Code's permission prompt**: `npm run delegate -- claude-settings` prints narrow allow rules for exactly the delegated commands
  (`Bash(npm run task -- train release:*)` and the like); `--write` (the owner's terminal only) merges them into the studio's
  `.claude/settings.json` `permissions.allow`; never a broad rule, never deny rules. The harness still refuses anyone but the delegated
  agent. **Revoke**: `npm run delegate -- revoke` (anyone may), then `npm run delegate -- claude-settings --remove --write`.
- `--help` / `-h` on any `npm run task --` subcommand, and on `delegate`, `lanes`, `fuzz` and `denials`, prints usage and never acts.

### Beta mode (2.76.0): the owner's gates off while the harness is built

One switch (`harness/beta-mode.mjs`), set once:

```bash
npm run beta -- on --by <owner> [--agents opus-1] [--why "…"]   # the owner's terminal (signed where the key is), or the owner proxy's shell with --permission "<the owner's yes>"
npm run beta -- off --by <name>                                  # anyone may: it only takes power away
npm run beta -- status [--json]
```

`studio/beta.json` is protected and read as committed in the main checkout. While it is on, the named outside agents (and the owner
proxy's agent) and launched Producer/Director sessions act as the owner, with `--by <their name>` or `--by <the owner>`, no owner key and
no per-step `--permission`, for:

- every owner action (`delegationFor`: releases including tier C and golden re-records without a report, types, yes, holds, unparks,
  resumes, janitor, upgrade switches, …) and every "a person's direct permission" command;
- approvals (`npm run approve -- protected|tests|hooks|force`): an unsigned approval that carries beta.json; it counts while beta mode is
  on with that file, from a commit that isn't a worker's;
- owner asks (`npm run ask -- answer <A-ID> <answer> --by <agent>`, recorded as the owner's with `recordedBy`);
- task types and visual proofs (`npm run task -- type|visual <ID> … --by <agent>`): kept as a beta-format approval
  (`studio/approvals/type-<ID>.json` / `visual-<ID>.json`) and committed, also with an owner key; counted only as committed (same
  content) under the current beta session, from a commit that isn't a worker's (`betaRecordCommitted`);
- a protected config proposal (`studio-proposals/<ID>.json`): the stand-in's `train release <ID>` of the held lane decides the protected
  part (the release carries `betaAt`; one under an older beta session or by a worker doesn't); `train config <ID> --by <agent>` applies
  one held on main; a beta `approve -- proposal` counts under the same rule.

Outside beta mode, with an owner key, `task type` and `task visual` refuse an unsigned record up front (exit 1, "needs the owner's
signature") and read their record back as the checks do. Test files (`*.test.*`, `*.spec.*`, `*.e2e.*`, `tests/`, `e2e/`;
`isRenderTestFile` in `harness/verdict-split.mjs`) are never render files, even under the game's `visualPaths`.

Every use is logged (`delegation.used`, the decision log, the digest). Never: deletes, worker sessions or workers' names, a lane
copy acting as the owner (except approving that lane's own change). The game's tests, the train's full verify and the weakened-tests and
hooks gates stay on. `npm run beta -- off` brings the owner gates back at once; approvals made in beta that haven't landed stop counting.
The daily digest's `## Beta mode` section (24 hours; whether beta is on and who set it, who turned it on or off, each use as one line, at
most 30 with a count of the rest) is left out when beta is off and nothing was used, and is outside the 200 words.

The orchestrator's Claude Code session may run in another folder: `npm run delegate -- claude-settings --owner --dir <its folder> --write`
writes prefix rules for exactly the owner's commands (npm and npm.cmd forms; they include `agent -- stop`, `agent -- pause`, `task --
park`, `task -- block`, `task -- unblock`, `task -- pause`, `beta -- on`, `beta -- off`). Protected text files are hashed with LF endings, so
an approval signed on a CRLF checkout matches the check anywhere.

### The standing owner proxy (2.73.1)

`npm run delegate -- proxy opus-1 --by <owner> [--days 30] [--why "…"]` (once, by the owner, where the key is; up to a year,
`harness/owner-proxy.mjs`) writes and commits `studio/delegation.json` as `{ agent, actions: ["*"], proxy: true, until, by, at, why }`,
signed with the owner key when there is one (the owner's own terminal only). While it counts, in the proxy's own shell
(`STUDIO_LOCK_OWNER=opus-1`; not a launched session or a worker's name):

- **Every owner action** works with `--by opus-1` or `--by <owner>`, and every "a person's direct permission" command with `--by
  <owner>` and no `--permission` (the grant's words are recorded).
- **Approvals without the private key**: `npm run approve -- protected|tests|hooks|force … --by <owner> --permission "<the owner's yes:
  their words or a link>"` (refused under 10 characters) writes an unsigned approval carrying the signed grant and the yes. It counts
  while that grant is the one on file in the main checkout, inside its window, made by the grant's agent, and, once committed, only in
  a commit that is the proxy's own or a person's. This covers gates and the protected list too. Each use is a `delegation.used` event and
  a decision-log line.
- **Never**: worker sessions, a lane copy (except to approve a lane's own change), granting itself another delegation.
- **Ending it**: `npm run delegate -- revoke --by <name>` (anyone may); approvals it made that haven't landed stop counting; the owner's
  signature is needed again as before.

What this trades away: an approval is the proxy's word that the owner said yes. The harness can't read Discord, and any agent able to set
`STUDIO_LOCK_OWNER=opus-1` in its own shell could act as the proxy. Revoke when that matters (more agents, machines, outside contributors).

## The decision log, the studio policy and autonomous mode (2.71.0)

**One decision log**: every decision left to the owner or a game dev writes one record to `.studio/decisions.jsonl` (the main
checkout's) and one `decision` event: train release, task type and visual proof, the dev's yes, hold and unhold, an asset review, a
quarantine confirm or release, deleting stale lanes, train auto, upgrade auto, crew resume, ending a wind-down, studio resume, a held
config proposal, the autonomy level, a delegation grant or revoke, and autonomous mode itself. A record is `{ id, at, action, subject,
by, as, why, evidence, undo }`; `as` is `person`, `agent`, `delegation <grant time>`, `autonomous` or `permission "<the person's words>"`;
`undo` says how to revert it (or null).

```bash
npm run decisions [-- --since 24h|7d|<ISO>] [--by <name>] [--action <a>] [--json]
```

**The studio policy** (`studio/policy.json`, protected; `npm run policy` prints it): `{ "autonomous": { "allowed", "agent", "actions",
"reviewWithinH" }, "never": [...], "notes": [...] }`, plus `"audit"` and `"routing"` (below). No file means today's behaviour. It counts
like the delegation (committed in the main checkout, signed with an owner key, else a commit that isn't an agent's). `notes` are shown to
every agent; a `never` word (`delete-lanes`, `upgrade-auto`, or an action's name) rules that action out for any agent, a delegated one
included.

**Autonomous mode** (opt-in): while the policy allows it, the named overseer agent takes the listed game-dev decisions (default
`train-release, type, yes, hold, visual, asset-review, quarantine`) with `--by <agent>` and no permission words; each is recorded `as:
"autonomous"` and goes on a **review list** that never blocks work.

```bash
npm run policy -- autonomous on --agent <name> [--actions …] [--review-h 72] --by <owner>   # the owner's terminal
npm run autonomy -- mode autonomous on --agent <name> --by <game dev>   # a proposal; the owner runs: npm run policy -- confirm --by <owner>
npm run autonomy -- mode autonomous off --by <name>                    # pauses it at once (anyone but a worker)
npm run decisions -- review                                            # the pending autonomous decisions, oldest first
npm run decisions -- approve <id> --by <you> | revert <id> --by <you> [--why "…"] | edit <id> --note "…" --by <you>
npm run decisions -- stats [--days 14]
```

- **Never autonomous**: protected files, gates (harness code, check silencers, deleted tests) and the policy file, deletes
  (`janitor-lanes`, any rm), visibility, keys. A train release in autonomous mode is refused for a lane held by any shipped tier-C rule; a
  lane held only after too many hand-backs, or by a game's own rule, may be released. **Never self-granted**: `policy autonomous on` and
  `policy confirm` refuse agents' shells, lanes and launched sessions; a policy.json an agent committed doesn't count; a worker can't propose.
- **Review**: a person (or an agent on a person's permission), never the deciding agent. `revert` runs the record's undo (unhold or hold
  again, the type or visual proof back, the dev's yes taken back, a quarantine released, an asset review reopened, a released lane held
  again); a lane that already landed gets a revert task. Shown in `npm run status -- --json` (`decisions`: count, oldest, overdue) and
  the digest; past `reviewWithinH` (72) they go under "Needs you".
- **Audits** (2.73.0, `harness/audit.mjs`): a fixed share of hands-free landings and autonomous decisions is picked for after-the-fact
  review by someone who didn't do the work: `"audit": { "rate": 0.1 }` (no rate: 0.1 while autonomous mode is on, else 0). The draw is
  seeded (sha256 of `studio-audit|<seed>`, the seed the decision id or the landing's task id; `npm run decisions -- audit-draw <id>`
  shows any draw). Picked items show in `npm run decisions -- review` (`[audit]`) and the digest. `npm run decisions -- audit <AU-id>
  pass|fail --by <name> [--note "…"]` (a fail needs a note): a person or an agent on a person's permission, never one that claimed, ran
  or landed the task or decided it. Approving an audited decision passes it; reverting or editing fails it; a failed audit counts as a
  Redo in the redo rate and the L3 bar (`audit.verdict` event).
- **Cheap-first routing** (2.73.0, `harness/routing.mjs`): `"routing": { "cheapFirst": ["chore", "docs", "test"], "tiers": { "cheap":
  "<model>", "mid": "<model>", "top": "<model>" }, "models": [...], "holdout": 0.1 }`. When the launcher picks a writer's model (no
  `--model`), a task whose type, track or role is listed starts on the cheapest tier the policy names a model for and goes one tier up
  per red round, capped at the top listed. Only models the policy lists are picked (`STUDIO_TIER_<TIER>_MODEL`, e.g.
  `STUDIO_TIER_CHEAP_MODEL`, counts only when the policy lists that model); the model never changes mid-task; a routed task skips the
  2.30d tier-up and the reasoning-only reroute (`model.routed`). `npm run autonomy -- routing [--days 14] [--json]` shows per task type and
  tier the sessions, landings, success rate and tokens per landed change. `"holdout"` (a seeded share sent to the default tier, to
  measure) stays 0 unless set; 0.1 is suggested once API credit allows.
- **Time saved** per action is the median owner wait over the last 14 days less the autonomous decision's own wait; under
  `STUDIO_DECISION_MIN_N` (10) waits: "not enough data".

## The self-repair loop: workarounds and harness tasks (2.71.0)

Every workaround of the harness is recorded, and repeats open one task for the harness maintainer (`harness/workaround.mjs`).

- **Log by hand**: `npm run workaround -- log "<what I had to do>" --why "<what the harness did wrong>" [--cmd "<command>"] [--by <agent>]`
  goes to `.studio/workarounds.jsonl` and a `harness.workaround` event, with a signature (the harness command plus the "what" without ids,
  hashes and numbers). Text is cleaned with the secret scanner's patterns.
- **Detected** (`detected: true`, with evidence; cheap, certain signals only): a hand edit of a harness-owned record (the board and
  `.studio/train/queue.json` are stamped in `.studio/write-stamps/`; a file equal to git's HEAD copy or changed after an upgrade or restart
  doesn't count); `--force` on a `task` or `lock` command; the same `task` or `lock` command failing `STUDIO_WORKAROUND_RETRIES` (3) times
  within `STUDIO_WORKAROUND_RETRY_MIN` (10) minutes by one agent (read-only commands and `task done --check` don't count); the supervisor
  stopped and started again within `STUDIO_WORKAROUND_RESTART_MIN` (5) minutes without an upgrade between; an agent session whose launcher
  vanished with no stop asked. `STUDIO_WORKAROUND_DETECT=off` turns detection off.
- **Harness tasks**: a signature seen twice, or once with `--why`, opens ONE task (deduped) in `studio/HARNESS-TASKS.md`: a separate queue,
  never `studio/NEXT.md`, never for game builders. `npm run workaround -- list | tasks [--all] | close <H-id> --by <name> --note "…"` (a
  builder can't close one; a closed task seen again reopens). The supervisor scans every `STUDIO_WORKAROUND_SCAN_MIN` (10) minutes
  (`npm run workaround -- scan` now). A task whose signature doesn't occur for `STUDIO_WORKAROUND_FIXED_DAYS` (7) days after an upgrade is
  marked "maybe fixed in <version>".
- **Measured**: the digest's "Workarounds:" line and `npm run autonomy -- impact`. **Export**: `npm run workaround -- export [--since 7d]`
  writes `.studio/exports/harness-workarounds-<date>.md` (secret patterns removed).

## The overseer's stages and repro PRs (2.73.0)

`studio/overseer.json` (protected; read as committed) holds the stage the owner set (0-3), the overseer's `agent`, `setBy`, `setAt` and each
stage's entry criteria.

| Stage | The overseer also... |
|---|---|
| 0 reporter | logs workarounds (`npm run workaround -- log`) |
| 1 repro tests | writes failing reproduction tests as harness PRs (`npm run workaround -- repro`) |
| 2 small fixes | makes small non-gate harness fixes, reviewed and merged by someone else |
| 3 own releases | merges its own non-gate harness releases |

Gates and protected files stay the owner's at every stage.

- `npm run overseer [-- --json]` shows the stage, the evidence since it was set and whether the next stage's criteria hold (workarounds
  logged, accepted repro PRs with `Repro-Of: <H-id>` and `Overseer-By: <agent>` trailers, merged PRs, revert rate, protected-file
  attempts). A suggestion only. A person records outcomes the harness can't see: `npm run overseer -- record
  <repro-accepted|repro-rejected|pr-merged|pr-reverted|protected-attempt> <subject> --by <person>` (never the overseer). Default criteria:
  stage 1 after 7 days and 10 workarounds, stage 2 after 7 days and 5 accepted repros, stage 3 after 14 days, 10 merged PRs and a revert
  rate of 0.1 or less; no protected-file attempt for any.
- `npm run workaround -- repro <H-id> --by <agent> --harness-repo <dir> [--base <ref>] [--commit]` (stage 1 and up for an agent; a person at
  any stage; never a builder) scaffolds a failing-test PR branch `repro/<h-id>-<sig>` in a SEPARATE clone of the harness repo (never the
  studio): `qa/selftest-repro-<h-id>.mjs` and the PR body in the clone's `.studio/repro/<H-id>-PR.md` with the `Repro-Of` /
  `Repro-Signature` / `Overseer-By` trailers. `--commit` commits it; nothing is pushed.

## Drift checks (Check cards to the Producer)

Each observation of a running session (the launcher's heartbeat; the watch pass if it stopped) runs these deterministic checks
(`driftCheck` in `harness/stall.mjs`):

| Signal | When |
| --- | --- |
| `gate-loop` | the same gate failed with the same signature `STUDIO_DRIFT_SAME_FAIL` (3) times in the session's own verify runs |
| `verify-no-diff` | `STUDIO_DRIFT_SAME_DIFF` (2) verify runs in a row with no change to its working copy (a file dated after a verify, or rewritten by one, counts as unknown) |
| `out-of-scope` | a file it changed outside its task's lane and path claims (harness-written files and `STUDIO_DRIFT_SCOPE_ALLOW` paths are fine; a session with no lane and no claim isn't judged) |
| `no-heartbeat` (2.65.0) | a running session has never sent a heartbeat `STUDIO_DRIFT_NOHEARTBEAT_MIN` (5) minutes after it started |
| `borrowed-commits` (2.65.0) | its lane holds commits of another **open** task's unlanded lane (shared with its lane branch or queued head, or tagged `Studio-Task: <that task>`): land that task first (`--after`) or take the commits out |

Each signal is raised once per session as a `drift.check` event to the Producer. A Check never stops, kills, hands back, parks or edits
anything: the Producer (or a person) looks, then nudges, re-scopes or hands the task back. `npm run watchdog -- drift` lists the Checks of
running sessions; `node harness/stall.mjs check` shows them with the stall state. `STUDIO_DRIFT=off` turns the checks off. There is no model
judge; `setDriftAdvisor(fn)` is a hook for an optional advisory note, used only with `STUDIO_DRIFT_ADVISOR=on` (off by default): it can add
a note to a Check already raised, never raise, stop or clear one.
