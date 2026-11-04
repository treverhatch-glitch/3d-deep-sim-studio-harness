# The War Room (`hub/v3/index.html`, 2.74.0)

The hub's home page, `http://127.0.0.1:3847`: the Ops view ("Studio floor"), the Studio Tycoon view, the Game plan, the
Asset studio and the Arcade. Everything on it is read from the studio's files; nothing calls a model.

## Pair your browser (the buttons)

```bash
npm run hub -- pair --by <your name>     # prints a one-time code and a link: open the link, or type the code
npm run hub -- pairs                     # the paired browsers (name, when, last used)
npm run hub -- unpair --by <your name>   # or unpair <P-id>, or --all
```

The link (`/pair?code=XXXX-XXXX`) or the code under "Pair this browser" in the Ops view's Act box pairs that browser:
the hub gives it a long-lived token in an HttpOnly, SameSite=Strict cookie and keeps only the token's hash
(`.studio/hub-pairs.json`, never in the repo). No token is printed or copied by hand. Every button then acts as you
(`--by <your name>`), from this machine only. `pair` is refused in a launched session, a coding agent's shell or under
an agent's name. `STUDIO_HUB_PAIR_CODE_MIN` (10) is how long a code works; `STUDIO_HUB_PAIR_DAYS` (30) how long an
unused pairing lasts. `HUB_TOKEN` still works for scripts (the `X-Hub-Token` header) and under "Use a HUB token instead".
Details: docs/SECURITY.md.

## Buttons run the harness's own commands

Each Act button runs the command a terminal would, as the paired person, and shows that command's own answer under the
button and in a toast on every view, success or refusal:

| Button | Runs |
| --- | --- |
| Fixed it: try again | `npm run studio:resume -- --by <you>` (supervisor.mjs resumeCli) |
| Release (a lane held for a person) | `npm run task -- train release <ID> --by <you>` |
| Hold / Unhold | `npm run task -- hold <ID> --by <you> --why "…"` / `unhold` |
| Unpark | `npm run task -- unpark <ID> --by <you>` |
| Revoke (Owner proxy; press twice) | `npm run delegate -- revoke --by <you>` |

They go through `POST /api/act` (`/api/supervisor` for resume). A hub started from an agent's shell still lets a paired
person act: the pairing checked who they are, so the agent markers of the hub's own process (`STUDIO_LOCK_OWNER` and the
like) are left out of the command's environment; every other setting (`STUDIO_RESUME_BY`, …) applies.

## Live on every view

The page reads the hub every 2 s. When the hub doesn't answer, a badge says "Reconnecting…" and it tries again at 1, 2, 4,
8, then every 10 s; when the hub is back it says so and reads everything again (the Game plan, the pairing). `/health`
names the hub's boot and the page's version: when the hub comes back with a new page, the page reloads itself. No manual
reloads after a hub restart. Why the hub dropped, and the supervisor restarting it: docs/RUN-UNATTENDED.md.

## The Ops view's deck

In the owner's order:

1. **Needs a person**: halts, lanes waiting for a person's release, parked tasks, the studio's questions; one button each.
2. **Crew**: sessions running against the cap, by role, and why not more (the supervisor's last pass, the flow pass).
3. **Train Room**: one per train (the merge train; an engine track's Unity train beside it). Each lane is a thread off
   main: amber while it verifies, green when it lands (locked into main), red and flickering when it is handed back. The
   step, its minutes and ETA, the last train's result, and the queued lanes with Release for the held ones.
4. **Run clock**: hours since `STUDIO_RUN_T0` (an ISO time; else the supervisor's start), hours left to its `--until`,
   tasks landed (task.done, lane.merged, the lanes of task.train.landed) and landed per hour.
5. **Machine**: RAM, CPU, GPU and disk now and averaged over the last samples (harness/machine.mjs), RAM per running
   session and room for more above `STUDIO_RAM_FLOOR_GB`; "Limit: RAM" when memory is what holds the crew back.
6. **Owner proxy**: the owner's delegation (harness/delegation.mjs), what was done under it in the last week
   (`delegation.used` events, decision-log records made "as delegation …" or autonomous), and Revoke.

The panels come from harness/war-room.mjs (`warRoom` in `/api/hud`). The page loads nothing from outside (no web fonts);
it follows the system's light or dark setting and reduced motion.

## The Studio floor's rooms

Divisions keep their rooms, and three rooms are for specific assignments (harness/war-room.mjs `roomFor`, by role, name
or track, never a fixed agent name):

- **Rail Yard**: the merge train (agents named or with the role train, train-daemon, merge-captain). Its lanes ride as
  cars through QUEUE, VERIFY and LANDED.
- **Engine Bay** (the engine division, formerly Engine Transfer): engine workers (`engine-porter`, `engine-worker`, a
  name with unity/godot/unreal/engine, any task on an `engine:<name>` track) and their own train.
- **Watchtower**: the outside overseer and the owner's delegated agent; its beacon is lit while it acted in the last
  hour, with its latest action and Revoke.

A room with work pulses. Each room shows what its staff are doing now (task, step: editing, verifying, on the train,
needs release, held, handed back, parked) with the action for it right there (Release, Unpark, Unhold, Hold).

## The look (2.75.0)

One design system for every view, a production stripboard: a status is a colored strip on a card's left edge and keeps
its meaning everywhere: green working or landed, amber waiting on you or idle, red stopped or stalled, violet held or
waiting for a release (and the owner's proxy), blue verifying or on the train, grey off or ending. Tokens (`--ds-*` in
`hub/v3/index.html`) set color, type, spacing and radius, with a light set the person can pick (2.77.0: never from the system); motion stops under
reduced motion. Headings use Bahnschrift (it ships with Windows; DIN and condensed fallbacks elsewhere), the text the
system's UI font. Nothing is loaded from outside the hub. Every view has the same tab bar: Control room, Studio floor,
Game plan, Assets, Arcade (the current one marked).

On the Studio floor each desk's plate is a short name over the role ("s12" over "builder"; the full name, task and model
on hover and focus), each person wears one badge for what they are doing (the key is in the dock), dark rooms are
departments that are off (click to open), and the Rail Yard's locomotive runs its track while a train is on it. An agent
leaves the floor, walking out of its room's door, when its session ends, when its last step was `task.done` (or a hand-back,
a stop) with nothing claimed, or after `STUDIO_FLOOR_IDLE_MIN` (30) minutes idle with nothing claimed; with reduced motion
it is simply removed. The Producer's seat and people stay. The Control room's agent list still shows everyone from the
last 24 hours.

`node qa/hud-check.mjs --only gallery --shots <folder>` shoots every view, desktop and phone, light and dark, into
`<folder>/275/`.

## 2.77.0: the field terminal

- **Dark, always.** The War Room no longer follows a light system setting. "Light screen" in every view's header
  switches to a light set; the choice is kept in this browser, and the same button brings the dark screen back. The
  look is a retro-futurist field terminal (an original take): two phosphors on near-black (green to read, amber for what
  wants you), scanlines and a soft glow (off in the light set; the flicker stops under reduced motion), framed panels,
  a tab bar like a wrist terminal, the system's monospace font (Cascadia Mono or Consolas on Windows).
- **The Studio floor is bigger**: drawn larger on wide screens (rooms, people, plates and text), with a badge that bobs
  over each person, a burst over the room when a task lands (and in the Rail Yard when a train lands), and the
  verify's progress under the Rail Yard's track. Finished agents still walk out (2.75.0).
- **The Train Room is a loom**: main is the glowing central timeline; each lane a filament that branches off it and is
  woven back in when it lands, pulses while verifying, peels away red when handed back, waits violet for a release.
- **A real loading bar** for the running train's verify: `scripts/run-gates.mjs` writes its live progress to
  `.studio/gates/progress/<owner>.json` (the train runs as `train-<id>`) and each passing gate's time to
  `.studio/gates/gate-times.json` (the last 10 runs per gate; harness/gate-progress.mjs). The bar is the checks finished
  out of the run's checks; the ETA is the median recorded time of each check still to run plus what is left of the
  running one, and says "estimate" when any of them has fewer than 3 recorded runs (no ETA at all before a first run).

### Pages

| Page | 2.77.0 |
| --- | --- |
| Control room, Studio floor, Game plan, Assets, Arcade, While you were away (`/`) | kept, redone in the terminal look |
| Arcade play (`/play/<build>/…`, `/engine-play/…`) | kept: the saved build plays in the page (checked end to end in qa/hud-check.mjs) |
| Pairing (`/pair`), phone login (`/phone`) | kept |
| `/legacy` (the React War Room retired in 2.4.0) and its source files (`/WarRoom.tsx` …) | cut: the War Room v3 does all of it |
| `/human` (balance and fun sign-off) | cut: "Sign off balance" / "Sign off fun" in the Control room's Act box do the same (`/api/human/*` stays) |

`node qa/hud-check.mjs --only gallery --shots <folder>` shoots every view, desktop and phone, in `<folder>/277/`.
