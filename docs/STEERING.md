# Steering the studio (2.30a)

The dev's words are the spec. These are the controls that keep agents on what was asked, and the ones that
let the dev overrule a gate. Counts are tokens, turns and tasks; no money figures.

## Intent card and task origin (J2)
- Every task is tagged **dev-asked** or **agent-proposed** when it is queued. `npm run task -- add "…" --origin dev --asked "<the dev's words>"` marks a dev request; an agent's add defaults to agent-proposed.
- After turning feedback into tasks, the Producer shows one card: `npm run intent -- echo --asked "add sprint/jump" --wont "stamina, camera" --tasks T-160 --by producer-1`. The War Room shows "You asked for: X. I will NOT change: Y." under **Your call**; one click ("That's right") confirms it. `npm run intent -- list` shows them.
- An **agent-proposed mechanic** (a phrase like "add a grapple", "new stamina system"; never a lone word) waits for the dev's yes: the "Yes, build it" button, or `npm run task -- yes <ID> --by <dev>`. Other agent work starts at once.
- Only a person says yes. From inside an agent it is a relay and needs the dev's own words and where they said them (`--quote "…" --source "…"`).

## "Do it now" (J3)
`npm run bible -- phase open 2 --now "start Phase 2 now" --by <dev>` (or **Open Phase N now** in Your call) opens the
gate at once, even with the exit list unfinished. What it skipped (no Director review, unticked exit items, a
skipped phase) is written to the event log as the risk (`bible.phase_override`). Tasks parked "until phase:2" start by themselves.

## Steering the queue (J11)
- `npm run task -- drop <ID> --why "…" --by <name>` takes a waiting task off the queue; the why goes in the event log and the task's notes. In-progress work is paused first.
- `npm run task -- reorder <ID> --to top|bottom|<n> | --before <ID> --by <name>` moves a waiting task.
- Scope checks against crossed-out layers match phrases, not single words: "fix the licence text" and "warm mood lighting" pass, "add a licence system" and "crew mood meter" are caught.

## Plain status and owned waits (J10)
The Ops view opens with one line: **Building now**, **Waiting on you** (what, not just how many), **Tokens today** with
the models named. Every waiting task says who it waits on and why ("waiting on the dev: …", "waiting on builder-2: waits for T-12").

## Quota stops (J12)
A tool is marked out of quota only on the provider's own limit message: the launcher skips the agent's transcript
(a session killed while reading a test that quoted "usage limit reached" no longer counts), the probe and the
reviewer read the failed command's error output, not the answer text, and the War Room's "out of quota" badge
uses the same test. A stop records the counted tokens of the last 5 h and the model (`npm run budget`).

## The Arcade (J8)
The newest build that passed the browser check plays at once. Below it: what changed (the tasks finished between
builds; on your first visit, this build's, after that everything since the build you last had open). With no saved
web build but an engine web export, the export plays instead of "Nothing to play".

## Watchdog (G1)
Off by default. `npm run watchdog -- on --by <you>` (or the switch in Your call) for runs nobody watches. Each watch
pass then hands off a session whose refresh check went unanswered for 15 min, parks a task handed back 3 times in
2 h, and stops the studio when no task finished in 2 h while sessions ran. `STUDIO_WATCHDOG_CHECK_MIN`,
`STUDIO_WATCHDOG_HANDBACKS`, `STUDIO_WATCHDOG_IDLE_HOURS` change them. Everything it does is an event by "watchdog".

## HUD noise (J13) and optional plugins
- Serena starts with `--open-web-dashboard false`, so its dashboard never opens over the War Room (it still runs on localhost:24282).
- Nobody sits at a desk in a locked room in the Studio view.
- `studio/plugins.json` lists **godot-mcp** (run the Godot project and read its output) and **ccusage** (Claude Code's own usage log), both off. With ccusage on, `npm run budget -- ccusage` copies its daily totals (tokens per model, cache reads apart) into `.studio/ccusage.json`, shown in the Budget meter beside the harness's count.
