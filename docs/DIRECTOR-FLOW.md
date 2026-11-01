# The Director's flow, design fidelity and the 2.30h safeguards (`docs/DIRECTOR-FLOW.md`)

2.30h gives the Director the flow of work, scores builds against the reference game's mechanics, and
catches three ways a run went wrong before: builders sat idle with work waiting, a model sent back only its
reasoning, and a red CI check went unnoticed. Every piece is a script: no model calls, no tokens, and nothing
waits on it, so agents are never slowed down.

## 1. Design fidelity (`npm run fidelity`): a scored report, not a gate

Tests can pass while the game still plays thin. Each game keeps its own list of the reference game's mechanics in
its Game Bible (`studio/bible/bible.json`, a `fidelity` section of the shape below); `studio/fidelity.json` is
the fallback when the Bible has none:

```json
{ "reference": "Youda Marina",
  "minScore": 0.8,
  "mechanics": [
    { "id": "lose-money", "says": "the player can lose money (upkeep and bad contracts drain it)" },
    { "id": "varied-paths", "says": "ships take varied paths to their docks" },
    { "id": "night-shift", "says": "a quieter night shift", "required": false } ] }
```

Each mechanic has a probe, `qa/fidelity/<id>.mjs` (or `"probe": "<path>"`), that plays the pure sim or reads the
content data:

```js
// Illustrative: read what your own sim records.
export default async ({ cartridge, runScenario }) => {
  const r = runScenario(cartridge, 'start-to-win', { seed: 1 });
  const dropped = (r.state.log || []).some((e) => e.kind === 'credits' && e.delta < 0);
  return { ok: dropped, why: dropped ? '' : `credits never dropped in ${r.ticksRun} ticks` };
};
```

- `npm run fidelity` scores the mechanics one at a time (`2/3 mechanics of Youda Marina present`) and writes a
  report the Director reads. It is not a hard gate: it exits 0 even when a required mechanic is missing (1 only
  for a bad checklist). `--strict` makes it fail on a missing required mechanic or a score under `minScore`.
  A mechanic that has no probe yet shows as "not scored".
- `npm run fidelity -- send-back` adds a builder task for each missing mechanic, tagged `[fidelity:<id>]`
  (P0 if it's required). It also asks for a probe for each mechanic that has none. It never adds a second
  task for the same mechanic. The Director's flow pass does this on its own after a failed score.
- The list is for mechanics only, never code or art. An entry that asks to copy the reference's code, art,
  sprites, models, textures, sounds or text is refused.
- With no checklist, it reports so and exits 0. It writes only
  `.studio/fidelity-last.json`.

## 2. The Director keeps the builders working (`npm run director -- flow`)

The Director owns the flow. A flow pass runs every minute: in the War Room hub's loop (`STUDIO_FLOW_INTERVAL`,
default 60 s, off when `STUDIO_WATCH_INTERVAL=0`) and in the supervisor's loop. Each pass:

0. frees the locks of agents whose process is gone (agents with a launcher session record only; never a person's);
1. hands back a claim that ran out: a task in progress that nobody holds and that has no running session. Not
   while its `task done` runs or its lane waits to land, and (2.58.3) not while the owner of that claim (an agent
   working outside the launcher, claiming with `task start`) was heard from within `STUDIO_CLAIM_ACTIVE_MIN` (30)
   minutes or its lane copy changed in that time: the pass says "kept T-… (busy: …'s owner … is still working on
   it)". The watcher's requeue follows the same rule, and the supervisor won't give such a task to a new agent.
   (2.58.5) A kept task's claim is made again in the owner's name (`lock.kept`), and `task start` by anyone else is
   refused until the owner lets go (`--force` for a person reassigning it). A lane copy with commits that name the
   task (or on its branch, or named for the owner) ahead of the studio's branch keeps it however quiet the owner is
   (built, not landed), for up to `STUDIO_CLAIM_LANE_MAX_H` (24) hours since the lane last changed, unless the
   owner's session ended. These hand-backs, and every other one the harness causes, never count for the circuit
   breaker or as a failure;
2. counts idle builder slots against ready work across the whole board, every role and lane, minus held and
   parked tasks (breaker parks included) and minus failing tasks: a task whose last hand-back was a failure is
   never re-fed by the flow; the circuit breaker or a person decides what happens to it;
3. refills idle slots through the launcher (`fillAgents`), with the same caps, lanes and pace as always. A
   pace that doesn't start agents on its own (Precise, Budget) gets an alert instead, and nothing starts while
   auto-start is off (the default; `npm run mode -- autostart on --by <name>`, docs/PACE-AND-AGENTS.md);
4. sends back missing design-fidelity mechanics;
5. writes `.studio/director-flow.json`, which feeds the War Room's **Director** card (Ops). The card shows the
   state (flowing, refilling, starved, full or empty), builders in use against slots, how many tasks are ready
   and held, what the pass did, and why nothing started.

When builders have been idle with work ready for `STUDIO_FLOW_IDLE_MIN` minutes (default 10), the pass raises
`director.flow.starved`, with the launcher's reasons. It sends a phone alert when alerts are on. It raises it
once, then again every 30 minutes while the studio stays starved. The Director's brief has a "The flow"
section with the same numbers.

## 3. Reasoning-only replies are failed hand-offs

Some replies are all reasoning and no answer: a `reasoning_content` field with empty `content`, or only a
`<think>…</think>` block.

- **The router** treats such a reply as a failure (`route.reasoning_only`). It doesn't put the model on
  cooldown, since the model works. For the rest of that call, every channel of the same model family is
  passed over, so the next family in the chain answers.
- **A launched session** that ends with an empty result after spending output tokens is handed back as
  failed (`agent.reasoning_only`), instead of being finished by the launcher. The next session on that task
  is rerouted to another family. It takes the first model of a different family in `STUDIO_REROUTE_MODELS`
  (`tool:model,tool:model`, e.g. `codex:gpt-5,claude:claude-sonnet-4-5`). With none set, the reroute is
  suggested to the Director and the Producer (`model.reroute_suggested`) and is never forced.

## 4. Model limits: awareness, not locks (`npm run models:limits`)

`harness/model-limits.mjs` keeps each model's context size and rate limits (requests per minute and per
day, tokens per minute). A built-in table holds approximate published figures, and `studio/model-limits.json`
overrides it (`{ "models": { "<name or /regex/>": { "context": 128000, "rpm": 40, "rpd": 1000 } } }`). Check the
figures there, because providers change them.

The Director's brief and the Director card list every model used in the last 24 h with its limits and
flags: a day's requests near the cap, a prompt near the context size, 429s or quota errors, reasoning-only
replies. **Nothing blocks a model.** The router and the launcher never read this table. The Director
decides routing and tells the Producer.

## 5. CI watch (`npm run ci:watch`)

After a push, `npm run ci:watch -- --detach` (or `npm run release -- <version>`, which runs it itself) waits
for the GitHub Actions runs on the commit and re-runs failed jobs once. If a job is still red, it then:

- raises `ci.failed`, which appears on the Director card and as a phone alert when alerts are on;
- runs `STUDIO_CI_NOTIFY_CMD` if it's set (the notification hook), with `CI_SHA`, `CI_STATE` and
  `CI_SUMMARY` in its environment;
- writes `.studio/ci-watch.json`;
- routes the result (2.64.0, docs/THREADS.md). With `STUDIO_THREADS=on`, a red run on a commit that a lane
  queued or a train landed goes to that task's inbox. A commit with no task goes to the Producer's inbox. In
  shadow mode (the default) it is only logged.

Without the gh CLI, it says "CI not checked", never "green".

## 7. GDScript parse check

`harness/gdscript-parse.mjs` asks Godot to parse every `.gd` file on its own
(`--check-only --script res://<file>`), skipping `.godot`, `addons`, `export` and `build`. The engine gate
(`npm run engine:gate`), the Godot template check (CI's engine-godot job) and the godot-unit gate all fail
when a script doesn't parse, and they name the file and Godot's error, even when the engine's own run exited
0. `npm run gdscript:parse -- <project>` runs it by hand.

## Also

`npm run release` sets package-lock.json's version to match package.json (`scripts/lock-version.mjs`)
outside CI, so a bumped package.json can't ship with a lagging lock again. In CI it only checks.
