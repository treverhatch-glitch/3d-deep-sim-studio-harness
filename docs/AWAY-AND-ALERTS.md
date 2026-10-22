# Away mode, the review, alerts and phone access (2.30d)

Everything here is opt-in and costs no tokens: scripts and files, no model.

## Away mode and "While you were away"

- **Go away:** War Room, Ops view, "Your call" → **I'm away** (or `npm run away -- on --by <you> [--note "…"]`).
  The Director and Producer keep deciding; nothing waits on you.
- **Come back:** **I'm back** (or `npm run away -- back --by <you>`). Every decision the Director or Producer
  made while you were away (tasks queued, dropped, reordered or promoted, phases opened, reviews, saved builds,
  finished work) becomes a card in the **While you were away** view, with its screenshots, clip or details.
- **Answer each card:** ✅ **Great** (kept as a good call), ❌ **Redo** (finished work is reopened with your
  words), or 💬 **Comment** (your words go into the task's hand-off notes and the workers refine it).
  CLI: `npm run away -- list` · `npm run away -- verdict AW-3 great|redo|comment --by <you> [--comment "…"]`.
- **Learning:** every verdict is in `studio/away/reviews.json` and one line in `studio/memory/decisions-learned.md`.
  The Director and Producer read `npm run away -- learned` (their counts and your recent words) before deciding.

## Forced work is "done (pending)"

`task done <ID> --force --reason "…"` still closes the task so the lane moves on, and opens a card.
A person, or a reviewer whose model family differs from the model that forced it, closes or reopens it:
`npm run task -- pending` · `npm run task -- review <ID> --close|--reopen --by <name> [--model <reviewer model>]`.
The War Room shows the card under "Your call" with Accept and Reopen.

## Who adds to the live queue

The Director, Producer and planner (and people) add to `studio/NEXT.md`. Other roles' adds go to
`studio/proposed.json` with a one-line `--why`; the Producer promotes them in batches
(`npm run task -- promote P-3,P-4 --by producer` or `--all`, `--drop P-5`). The dev's own asks
(`--origin dev --asked "…"`), the watcher and the liaison queue directly.

## Fun check in waves

A gameplay task no longer waits for its own browser play: it closes into the open wave (`studio/waves.json`).
When the batch is in a good state, the Producer (or you, "Fun wave … is ready") marks it ready:
`npm run wave -- ready --by <name>`. QA runs `npm run play:browser` once, then `npm run wave -- check --by <name>`:
all probes pass → the wave passes and goes to your review; a probe fails → one linked "Fix wave" task.
Other lanes keep building and new gameplay work joins the next wave. `STUDIO_FUN_WAVES=0` (or `wave -- off`)
restores 2.30b's per-task check. Sim features (J4) are still checked per task.

## Phone alerts (ntfy or Telegram)

- ntfy: `npm run alerts -- on --channel ntfy --topic <long-random-topic> [--server https://ntfy.sh] --by <you>`;
  an access token, if your server needs one, only in `.env` as `STUDIO_NTFY_TOKEN`.
- Telegram: put the bot token in `.env` as `STUDIO_TELEGRAM_BOT_TOKEN`, then
  `npm run alerts -- on --channel telegram --chat <chat id> --by <you>`.
- Sent on: studio stopped, a watchdog action, forced work pending review, the away summary ready, a parked task.
  At most 5 per watch pass; turning alerts on never sends the backlog. `npm run alerts -- test [--dry-run]`.
  Keys are never written to a file or the event log.

## Phone access with a secure login (H3)

1. Bind the hub where the phone can reach it (Tailscale is best) with a strong `HUB_TOKEN`, as in docs/SECURITY.md.
2. `npm run phone -- on --by <you>` prints a one-time 8-character code (valid 15 minutes; only its scrypt hash is stored).
3. On the phone open `http://<host>:3847/phone`, enter the code. The phone gets a 12-hour HttpOnly session cookie;
   its writes also carry a per-session CSRF value. 5 wrong codes lock that address for 15 minutes.
4. `npm run phone -- new-code` for another device, `revoke` to sign every phone out, `off` to end it.
   Set `STUDIO_PHONE_SECURE_COOKIE=1` behind HTTPS.

## The watchdog in the studio

The watchdog (`npm run watchdog -- on|off`, 2.30a) is a dog in its own kennel room on the Studio Tycoon floor:
curled up asleep on its bed while it is off, awake and patrolling its room while it is on.
