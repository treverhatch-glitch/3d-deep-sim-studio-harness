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
