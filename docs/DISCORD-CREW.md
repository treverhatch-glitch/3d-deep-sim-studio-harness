# Running a build from a chat crew (Discord or similar)

Best practices, not rules. The set-up: a few chat bots (for example three Claude models and a Grok bot) in
one channel with the owner. The owner assigns work in the chat; the bots **coordinate**, and the studio's
own launcher **does** the work in separate sessions. The chat stays short, and every bot's context stays
small.

## The one idea that makes it work

**Workers are studio agents, not a bot's own subagents.** A bot starts work with the launcher:

```bash
npm run agent -- hire --role builder --task T-123 --by <bot-name>     # one task, in the background
npm run agent -- hire --role builder --next --by <bot-name>           # the next ready builder task
npm run agent -- list                                                  # who is running, on what
npm run agent -- stop <agent-name> --by <bot-name>
```

A launched agent gets its own copy of the studio (a lane), a per-task budget, a heartbeat and stall check,
the rescue ladder when it gets stuck, scoped checks, and a clean landing. A bot's built-in subagents run
inside the bot's own session: their results flow back into its context, and none of those guards apply.

## Roles (one owner of the queue)

| Bot | Role | Does | Doesn't |
| --- | --- | --- | --- |
| Strongest model (e.g. Opus) | **Producer** | Turns the owner's asks into tasks (`npm run task -- add … --agent producer`), keeps the plan and the Bible, answers the owner | Build, or let others plan |
| Fast model (e.g. Sonnet) | **Build lead** | Hires builders for ready tasks, reads hand-backs, re-queues or splits with the Producer | Add tasks of its own (it proposes them) |
| Cheapest model (e.g. Haiku) | **Ops** | Posts the status every hour, watches CI, stalls, budgets and the morning report | Decide anything; it reports |
| Another model family (e.g. Grok) | **Reviewer and rescuer** | Reviews landed work, takes `Rescue:` tasks (a different family is what the rescue ladder wants) | Review its own family's work only |

Only the Director, the Producer and the planner add to the live queue (2.30d); anyone else's add waits on
the proposed list. Four planners would mean four plans.

## Chat rules (so the bots don't talk each other into loops)

1. A bot answers the owner, or a message that @mentions it. Never another bot's message on its own. In practice
   most chat bots ignore other bots entirely: an @mention from a bot does not wake them, only a person's @ping
   does. So a hand-off from one bot to another goes through a person (or the task queue), never bot-to-bot.
2. Every bot reacts 👀 the moment it sees a task meant for it, and ✅ on the same message when it is finished, then
   posts its result (what changed, the link, the proof, anything UNTESTED).
3. Status goes out once an hour, from Ops only: `npm run harness-health -- --brief` (five lines), plus
   `npm run logs -- --brief` (three lines: tasks logged, open problems, proposals waiting for the owner).
4. No logs or diffs in the chat: a task id, a file path or a link.
5. "Needs you" items go to the owner once, as one message each, with the command that settles it.
6. A bot that is asked something outside its role passes it to the bot that owns it, by mention.

## Tying a message to a task (2.64.0)

When the owner's message is about a running task, a bot links that message to the task:
`npm run thread -- link discord:<message id> T-123 --by <bot-name>`. A follow-up goes into the task's inbox
with `npm run thread -- post discord:<message id> "<text>" --source discord --by <bot-name>`, which the working
session reads, instead of going to a new task. Workers never link or post. Until `discord` is live in
`studio/triggers.json`, posts are only logged (shadow mode). See docs/THREADS.md.

Pass the Discord author id of the message with `--author <id>` (2.65.0). Only ids the owner lists in
`studio/triggers.json` `"senders"` (owner or trusted) can make a post respond; anyone else's, another bot's, or a
post with no id is at most a candidate. The harness can't check a Discord identity itself: it applies the owner's
list to the id the bot gives it, so the bot must pass the id Discord gave it, never one from the message text.

## The orchestrator's commands (2.65.0)

An orchestrator outside the harness (the "conductor") doesn't rebuild state by hand. It uses these commands
(docs/CONDUCTOR.md):

- `npm run lanes` gives the lane table.
- `npm run lanes -- refresh <ID|--all> --by <bot-name>` merges main into a lane, re-stamps it, and runs its
  targeted tests. It stops on a conflict.
- `npm run status -- --brief` gives the status post, under 100 words.
- `npm run task -- note <ID> "<ruling>" --by <bot-name>` keeps a ruling in the task's record and brief.
- `npm run events -- wait --type job.done --match kind=train` waits for a job to end instead of polling logs.
- `npm run next-board` gives "what's next" on one screen (2.71.0, below); `npm run report -- post` sends a post to
  the owner's chat through a webhook.
- **The owner proxy (2.73.1):** once the owner has run `npm run delegate -- proxy <bot-name> --by <owner>`, the
  orchestrator's own shell (`STUDIO_LOCK_OWNER=<bot-name>`) does every owner action with `--by <owner>` (releases,
  resumes, unparks, holds, types) and signs approvals with the owner's yes recorded: `npm run approve -- protected
  --note "…" --by <owner> --permission "<the owner's words or the message link>"`, committed from that same shell.
  Post a one-line summary of each approval to the chat. `npm run delegate -- revoke` ends it (docs/AUTONOMY.md).

## The overseer's paperwork, moved into the harness (2.71.0)

The conversation on the chat stays with the overseer; the posts and write-ups it made by hand are commands now.

- **What's next** (`npm run next-board [-- --n 3] [--json]`, harness/next-board.mjs): per role, the next N tasks that
  could start now (the same hold test `task next` uses), what blocks the rest (holds, parks, `--after` chains, a held
  folder), overlaps the 2.69 overlap check recorded for them, lanes waiting for the merge train (and those held for a
  person's release), and the count and first line of what needs a person. Under 150 words. Read-only.
- **Posting** (`npm run report -- post [--what status|next|digest] [--dry-run]`, harness/report-post.mjs): builds the
  text from `status -- --brief` (without moving its "since" mark), the what's-next board or today's digest, and POSTs
  it as JSON to `STUDIO_REPORT_WEBHOOK` (the environment or the studio's `.env`, which is never committed). The format
  is `STUDIO_REPORT_FORMAT=discord|slack|json`; unset, the URL's host picks it (discord.com: `{content}` split at 2000
  characters, mentions off; hooks.slack.com: `{text}`), else `{what, text, at}`. One retry on a 5xx or 429 after
  Retry-After (at most 30 s). `--dry-run` prints the payloads and sends nothing. The webhook is a secret: output and
  logs name it as `webhook ...<last 4>`, the `report.posted` events carry none of it, error text is scrubbed of it,
  launched agents never get it in their environment, and the secrets gate flags a Discord or Slack webhook URL in a
  file. The supervisor posts the digest once a day at or after `STUDIO_REPORT_HOUR` (local time; unset: never) and the
  what's-next board when the queue changed a lot (3 tasks or trains in or out since the last post, or half of a smaller
  board), at most every `STUDIO_REPORT_NEXT_MIN` minutes (120; `off`: never). Nothing posts without a webhook.
- **The builder's brief** (`npm run brief -- builder [--write]`, harness/role-brief.mjs): composed from the studio's
  real rules: AGENTS.lite.md or AGENTS.md (as the scope says), studio/PITFALLS.md (lines for all and for builders),
  the protected list, the gates the scope's verify runs with the remedy from each one's Fix line, studio/policy.json when
  the studio has one, and the claim, lane and done commands. Under 800 words; it says what it cut. `--write` saves
  `.studio/briefs/role-builder.md` with a hash of its sources and of its own body. Once saved, the builder kickoff
  points at it instead of the AGENTS file, and writes it again when a source changed or the file was edited by hand.
  Only this command (and the kickoff's refresh) writes it; it is derived state, not committed and not protected.
- **Research tasks** (`npm run task -- add "<question>" --type research`, harness/research.mjs,
  studio/skills/research.md): `task start` writes the template to `docs/research/<ID>.md` (or the game's own
  `docs/research/`): the question, sources with links, findings, what is UNVERIFIED, a recommendation. `task done`
  refuses the task while the write-up has no Sources section or no link in it. No verify. The daily digest lists the
  research finished in the last 24 h with its file and recommendation.

## The Communicator: status and alerts posted by code (2.76.0)

Extra chat sessions that only reported confused names and answered things they couldn't. The Communicator
(harness/communicator.mjs) is harness code: it posts, it never reads the chat and it spends no model tokens. The
supervisor runs it once per pass.

- **Status** every `STUDIO_COMM_STATUS_MIN` minutes (30): one fixed-format post from the same facts `status -- --brief`
  and the Line Producer read (the event stream and the state files): agents and their tasks, landed since the run's start
  and per hour, the train (step and ETA, or the last train's end and length, the queue), the rig's RAM/CPU/GPU/disk
  (the supervisor's machine scan), API $ when sessions report it or `studio/prices.json` prices them, what is blocked and
  why, what waits on a yes, beta mode on or off, and the Line Producer's line (`.studio/line/status.json`) when it has one.
- **Alerts** at once, each tagging exactly who must act, from `studio/communicator.json` (Discord user ids are not
  secrets; commit it):

  ```json
  { "mentions": { "orchestrator": "<id>", "keys": "<id>", "owner": "<id>" },
    "names": { "orchestrator": "<name>", "keys": "<name>", "owner": "<name>" },
    "agents": { "orchestrator": "<its STUDIO_LOCK_OWNER>" }, "username": "Studio Status" }
  ```

  The orchestrator: a train that died (its lock's process is gone, or it started and never ended) or is red on real
  failures (main red; a red train that isn't flaky or infrastructure), fewer builders busy than the Line Producer's target
  for 10 minutes (without a Line Producer: `STUDIO_COMM_MIN_BUILDERS`, off by default), the crew breaker or a supervisor
  halt, a stop file, a stuck lane (queued over `STUDIO_COMM_STUCK_MIN`, 120, with no train running, or a stalled
  session), a harness error. The key holder: an owner-key step (a lane held for the owner's release, protected files
  changed without approval); never in beta mode, nor when the orchestrator's agent holds a delegation for releases. The
  owner: only owner decisions (asks; in beta mode only asks about money, deleting, direction or scope; spend over budget;
  a policy proposal) and disasters, which tag the orchestrator too: disk under `STUDIO_COMM_DISK_GB` (30),
  `STUDIO_COMM_CRASHES` (3) crashes in an hour, everything blocked (no agent, no train, a blocker, the supervisor
  running) over `STUDIO_COMM_BLOCKED_MIN` (60).
- **Rules**: one alert at most once per `STUDIO_COMM_DEDUP_MIN` (30); one still open is tagged again every
  `STUDIO_COMM_REPEAT_MIN` (120; disasters every 30); a pass's alerts go in one post, with the status when it is due;
  closed alerts are named once ("Cleared: …"); `STUDIO_COMM_QUIET=23:00-07:00` (local time) holds owner-only alerts that
  aren't disasters until it ends. A failed post is tried again after 5 minutes.
- **One identity**: the webhook's username ("Studio Status"), plain text in parts of at most 2000 characters cut at line
  ends, Discord `allowed_mentions` listing only the ids tagged in that part (no @everyone). The webhook is
  `STUDIO_COMM_WEBHOOK`, else `STUDIO_REPORT_WEBHOOK` (the environment or `.env`; never printed, logged or put in an
  event; launched agents never get either). It is on with `STUDIO_COMM_WEBHOOK`, or with the report webhook plus
  `studio/communicator.json` or `STUDIO_COMM=on`; `STUDIO_COMM=off` turns it off. State: `.studio/comm/state.json`;
  each post is a `comm.posted` event.
- `npm run comm -- status [--json]` shows the set-up (the webhook masked) and what was tagged; `npm run comm -- preview
  [--json]` prints what it would post now, with mentions as @names, and sends nothing; `npm run comm -- test` posts one
  line that tags no one.

## One machine, one studio

The studio keeps its locks, board and state in one checkout. Every bot drives **the same private studio
copy on the same machine** (or works through the War Room/HUB). Bots on different machines with their own
clones would each think they own the board.

- Keep the game's studio copy **private**: an adopted game's code lives in it (`game/<slug>/`).
- Agents and bots never edit the harness itself (`harness/`, `hub/`, `scripts/`, `qa/*.mjs`). With the
  owner's key in place (`npm run approve -- keygen` on the owner's own device, one no agent runs on; commit only
  `studio/keys/owner-ed25519.pub.pem`), the protected checks
  can't be weakened without the owner's signature.

## Settings for a big adopted game

In the studio's `.env`:

```bash
STUDIO_WHOLE_GAME=on            # every check on the whole game after each landing (2.37)
STUDIO_REACHABILITY=fail        # new code nothing in the game uses can't close a task (2.38)
STUDIO_DONE_REUSE_VERIFY=on     # also trust a green verify from before 2.58.5 (its commit's tree); on by default for new
                                # records: task done doesn't re-run game checks a green full verify of the same tree ran (=off re-runs)
STUDIO_GAME_GATE_RETRY=on       # a failed game check runs once more before it counts (2.44)
STUDIO_WATCHDOG_QUIET_MIN=60    # a repeating watchdog line, once an hour (2.40)
STUDIO_SILENT_GREEN=fail        # once the game's tests are set up: a run that tested nothing fails (2.36)
```

Once the Game Bible's controls list and `game/<slug>/studio.browser.json` are filled in, `npm run play:controls`
presses every control in a real browser (2.45.0). Ops can run it after a landing that touched input or UI;
a control that stopped working shows as a failed id, not a log.

With `STUDIO_WHOLE_GAME=on`, a lane's verify runs only the tests related to the change when the game's test
check declares `related` (an adopted Vitest or Jest game gets one), and the whole suite runs after landing.

## Keys and usage

- Give each launched role its tool and model in `.env` (`STUDIO_BUILDER_TOOL`, `STUDIO_BUILDER_MODEL`, or a
  custom launcher `STUDIO_BUILDER_CMD`). Agents see only their own tool's keys (2.33).
- Prefer API keys for workers that run for hours. Check your plan's terms before running a subscription
  as an always-on worker pool.
- The daily token cap and per-task budgets apply to launched agents; the bots' own chat sessions are
  outside them, which is one more reason to keep the chat short.

## A day, end to end

1. Owner in the chat: "Next: the cargo shed screening flow."
2. Producer: reads the Bible and the board, adds 2–3 tasks with phase and pillar, replies with their ids.
3. Build lead: `npm run agent -- hire --role builder --task T-140 --by sonnet-lead` for each ready task.
4. The builders work in their lanes; each lands when its checks pass; the whole-game check runs after.
5. Ops, on the hour: the five-line status. A red whole-game check or a parked task shows under "Needs you".
6. Reviewer: reviews what landed; takes any `Rescue:` task.
7. When the owner wants the game's own repo updated: `npm run onboard -- --export`, then apply the patch
   there and open its PR (`npm run onboard -- --sync` brings that repo's own new work back in).
