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
