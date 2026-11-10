# Forced work, proposals, waves, asks and alerts (2.30d)

2.80: away mode, the War Room's review cards and phone access to the War Room are gone with the War Room.

Everything here is opt-in and costs no tokens: scripts and files, no model.

## Forced work is "done (pending)"

`task done <ID> --force --reason "…"` still closes the task so the lane moves on, and opens a card. The owner types it, never an agent (docs/FORCED-CLOSE.md).
A person, or a reviewer whose model family differs from the model that forced it, closes or reopens it:
`npm run task -- pending` · `npm run task -- review <ID> --close|--reopen --by <name> [--model <reviewer model>]`.

## Who adds to the live queue

The Director, Producer and planner (and people) add to `studio/NEXT.md`. Other roles' adds go to
`studio/proposed.json` with a one-line `--why`; the Producer promotes them in batches
(`npm run task -- promote P-3,P-4 --by producer` or `--all`, `--drop P-5`). The dev's own asks
(`--origin dev --asked "…"`), and the watcher queue directly.

## Fun check in waves

A gameplay task no longer waits for its own browser play: it closes into the open wave (`studio/waves.json`).
When the batch is in a good state, the Producer (or you, "Fun wave … is ready") marks it ready:
`npm run wave -- ready --by <name>`. QA runs `npm run play:browser` once, then `npm run wave -- check --by <name>`:
all probes pass → the wave passes and goes to your review; a probe fails → one linked "Fix wave" task.
Other lanes keep building and new gameplay work joins the next wave. `STUDIO_FUN_WAVES=0` (or `wave -- off`)
restores 2.30b's per-task check. Sim features (J4) are still checked per task.

## Asks are posted once per state change (2.79, c)
The harness's own asks to the Producer and the orchestrator (`agent.ask` events: "T-xxx is parked: …", "Needs you: …")
go through `harness/ask-post.mjs`. An ask is (task, subject) and posts once. Asked again while it is open, or coming back
after it closed within `STUDIO_ASK_DIGEST_HOURS` (default 24) of its last post (the same task parked again for the same
reason after an unpark), it is counted, not posted: the daily digest lists the open ones with how often each came back,
and an ask posts again at most once per `STUDIO_ASK_DIGEST_HOURS`. It closes by itself, with one `ask.closed` event,
when the task is done or no longer in the state it was asked in (the park lifted or replaced); the watchdog's pass
sweeps them. A formal question (`npm run ask -- "…" --task T-x`) closes the same way when that task is done, and an
answered one is never open again. The Communicator tags an open question again at most every `STUDIO_ASK_DIGEST_HOURS`.
Before, every occurrence posted (the crew counted 252 asks against 20 answers in six days).

## Phone alerts (ntfy or Telegram)

- ntfy: `npm run alerts -- on --channel ntfy --topic <long-random-topic> [--server https://ntfy.sh] --by <you>`;
  an access token, if your server needs one, only in `.env` as `STUDIO_NTFY_TOKEN`.
- Telegram: put the bot token in `.env` as `STUDIO_TELEGRAM_BOT_TOKEN`, then
  `npm run alerts -- on --channel telegram --chat <chat id> --by <you>`.
- Sent on: studio stopped, a watchdog action, forced work pending review, a parked task.
  At most 5 per watch pass; turning alerts on never sends the backlog. `npm run alerts -- test [--dry-run]`.
  Keys are never written to a file or the event log.
