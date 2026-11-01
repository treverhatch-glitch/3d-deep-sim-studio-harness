# Sessions, budget and models (2.29.2)

What 2.29.2 changes for agents the launcher starts (`npm run agent`, `npm run studio:start`, the War
Room's Start agent). Measured on a 10-hour, 104-session overnight test run on one top-tier model
(Claude Opus 5.5 on every role): 261.6M cache reads, 7.9M fresh input, 1.5M output; 16 sessions
finished nothing; sessions grew from about 37k to 100k–315k tokens of context, up to 126 turns. Every
safeguard below is cheap and doesn't slow a build: caps hand off instead of stopping, checks are cards.

## Refresh context by default

The studio's files are the memory, not the chat.

- A launched session does one task, or refreshes at **40 turns or 120k tokens of context**, whichever
  comes first: it commits, hands back with `node harness/task.mjs pause <ID> --note "Done: … | Failed/tried: … | Next step: … | Standing rules: … | Files: …"`
  (under 3k characters), and stops. A fresh session continues the same task from that note.
- Claude Code sessions get `--max-turns 80` (the ceiling). A session that reaches it is a refresh, not
  a failure: the launcher saves the work, hands the task back with a note and starts a fresh session on
  it at once (up to `STUDIO_REFRESH_RELAUNCH`, default 5, in a row). No failover, no cooldown, and it
  doesn't count toward parking a looping task.
- The brief shows the newest 3k characters of a task's notes (`studio/handoffs/<ID>.md` keeps them all).
- **Hand-back facts (2.66.0).** Every hand-back (`task pause`, the merge train's drop, the watcher, a session that
  ended holding its task) starts with a block the harness writes, not the agent (harness/handback-facts.mjs): the
  files changed since the task's start commit (`git diff --name-only`, untracked files too, at most 30 named plus a
  count), the newest gate run since the task started with PASS/FAIL per gate, the failure signature (the first
  failing gate and its first failing test line, normalised, with a short `sig` hash), the failing seed when the log
  names one, and the last verify log's path. The gate evidence is, newest first: the log the note names (the train's
  `Full log:`), a refused `task done` (`.studio/handback-facts/<ID>.json`), the holder's own verify record. The
  note's 20-line cap applies to the prose only; events and the breaker read the prose. The next agent's brief
  (`.studio/briefs/<ID>.md`) shows the newest block first, inside the marked block (file names and log lines come
  from the work), and leaves older blocks out of the notes.
- **Mid-debug exception.** With a live repro, an agent may keep going to the ceiling:
  `npm run session -- exception "<repro: seed, tick, command>"`. That flags it. The Director or Producer
  gets a "Check <agent>" card at every 20 turns / 40k tokens past the refresh point and answers with
  `npm run session -- check <agent> continue|handoff --by <name>` (or Continue / Hand off in the War
  Room). An agent past the point without the exception gets the same check one step later.
- `npm run session` lists every launched session's turns and context, with the model named.
- Limits: `STUDIO_SESSION_TURNS` (40), `STUDIO_SESSION_CONTEXT` (120000), `STUDIO_SESSION_CEILING_TURNS`
  (80), `STUDIO_CHECK_TURNS` (20), `STUDIO_CHECK_TOKENS` (40000); 0 turns one off.

Turns and context come from Claude Code's stream-json log, read at each heartbeat. Other tools don't
report per-turn usage, so for them only the kickoff rule and the task boundary apply.

## The budget meter counts cache reads

Cache reads were 97% of the tokens in that run, and the meter ignored them: it saw 4.66M against
100M+, so `--budget 95%` could never trip. Now `npm run budget`, the supervisor's `--budget`, the
daily cap and the War Room's **Budget meter** count input (with cache writes) + output + cache reads at
a weight: `STUDIO_CACHE_READ_WEIGHT` or `cacheReadWeight` in `studio/budget.json`, default 0.1. Each
tool's line names the models behind its counts: tokenizers differ by model family (roughly 10–30%), so
compare tokens within a model.

2.65.2: a session end also records its cache writes split by TTL (`meta.cacheWrite5m` / `cacheWrite1h`, when
Claude's result usage gives `cache_creation`) and the TTL the launcher asked for (`meta.cacheTtl`: 1h for the
Director and Producer, else 5m). A plain usage report from another tool counts cached tokens once: in the OpenAI
shapes (`prompt_tokens_details.cached_tokens`, `input_tokens_details.cached_tokens`, `cached_input_tokens`) they come
off the input and count as cache reads.

`studio:start --budget 50%` warns at start when no tool has a `--weekly` figure to pace against.

## The daily token cap has a default

`STUDIO_DAILY_TOKEN_CAP` defaulted to 0, no cap. Now empty means 50,000,000 counted tokens a day
(about 1.4x that whole overnight run, counted this way); set a number, or `off`. Past it no new agent
starts and router calls are refused; running sessions finish.

## Per-role models: a strong suggestion

Nothing is enforced. The suggestion (`.env.example`, `npm run models:check`):

| Role | Tier |
|---|---|
| builders, Producer | mid (e.g. claude-sonnet-*) |
| Director, planner, hard engine ports | top (e.g. claude-opus-*) |
| check-ins, summaries, QA play | cheap (e.g. claude-haiku-*, *-flash, glm-*) |
| reviewer | another model family |

When every role is set to the top tier (or, with nothing set, every session in the last day ran on
it), the War Room shows a warning on every view: "Overpowered models on every task may not be efficient
and can weaken cross-family checks." The game dev clicks **I accept** (or runs
`npm run models:check -- --accept-top-tier <name>`); it stays hidden until the models change.

## The cheat sheet check (pre-approved tricks)

`studio/CHEATSHEET.md` lists tricks and tools, one line each: `- C-NN [tags] trick → link (licence)`.
Before a task is handed out, whoever assigns it runs `npm run cheatsheet -- attach <ID> --by <name>`:
up to 3 lines whose tags match the task's title (or `--tags`) are attached to its brief as
**pre-approved**. The agent may use them for that task without asking; the approval is recorded as a
`cheatsheet.preapproved` event (task, trick ids, approved_by). Anything not attached still follows the
normal approval rules (AGENTS.md section 5). `npm run cheatsheet -- match "<title>"` previews.

The sheet has a **director section** for planning, splitting, assigning and check-ins
(dependency-aware handout, size-3 split, one owner per lane, routing by tier). The Director and
Producer consult it when planning or queueing: `npm run cheatsheet -- match "<plan>" --for director`.
Those lines are never attached to a builder's task. The Director refreshes the sheet weekly from the
scout and keeps it under 150 lines.

## In the War Room (Ops view)

- **Budget meter:** today's counted tokens against the daily cap, and per model: sessions, in, out,
  cache reads, counted.
- **Sessions and context:** each launched session's turns and context against the refresh point, with
  the model; ok / refresh due / mid-debug flagged, checks owed and done; Continue and Hand off buttons.
- **Signals (every view):** the top-tier warning with its I accept button, and "Check an agent" when a
  check is owed.
- **Queue:** the cheat sheet tricks attached to each open task, marked pre-approved, with who approved them and the trick ids.

## Since 2.29.2

The opt-in overnight watchdog shipped in 2.30a. 2.30d adds the rest: a failed hand-back starts the next
session one model tier up (`STUDIO_TIER_<TIER>_MODEL`, else suggested), builder tasks are size 3 at most
(`--size 4|5` queues a linked planner split first), and `task add` attaches up to 3 matching tricks as
pre-approved (logged; `STUDIO_AUTO_TRICKS=0` turns it off). See docs/AWAY-AND-ALERTS.md and the CHANGELOG.
