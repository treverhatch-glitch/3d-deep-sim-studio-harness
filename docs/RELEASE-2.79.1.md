# 2.79.1: Vertex as a builder tool, spend budgets, owner tools, a Line that doesn't freeze (`docs/RELEASE-2.79.1.md`)

The crew's request of 2026-11-06 (Patch, at the owner's request) after a good day on 2.79.0, with the owner's changes:
budgets are set on his orders (no built-in cap), an engine push mode, and fat cut where it was safe. Untested on the
crew's Windows PC unless it says otherwise. Each item has a selftest that fails on 2.79.0 (`qa/selftest-2791*.mjs`).

## 1. Vertex AI as a built-in builder tool

| What | How |
|---|---|
| `--tool vertex` | Runs the studio's aider against a harness-owned proxy on 127.0.0.1 (`harness/vertex-proxy.mjs`, `STUDIO_VERTEX_PROXY_PORT` 8787). The proxy reads `VERTEX_API_KEY` / `VERTEX_PROJECT_ID` from the main checkout's `.env` on every request (renaming the key pauses Vertex: 503), sends the key as `x-goog-api-key`, and serves only registered running sessions. |
| The key stays out of sessions | aider's key is a session tag (`session-<agent>`), never forwarded. The builder's environment and its lane copy's `.env` never hold `VERTEX_API_KEY`, even with `STUDIO_AGENT_ENV_PASS`. |
| Who starts it | `npm run agent -- start --tool vertex` works for the orchestrator. The supervisor and Line Producer start Vertex builders: with plan headroom up to `STUDIO_VERTEX_SHARE` (0.5) of builder slots; when the plan is over target or winding down, Vertex goes before the paid API pool and may take any free slot. Hard tasks (size 4–5 or the top tier) use `STUDIO_VERTEX_HARD_MODEL` (3.1 Pro), others `STUDIO_VERTEX_MODEL` (3 Flash). A task handed back on Vertex goes to the plan's normal route next. |
| Spend, always measured | Every response logs tokens (output = total − prompt: Gemini's thinking is billed) and dollars to `.studio/vertex-usage.jsonl`; each session end records its dollars and key names; `npm run tokens -- --by task` and `npm run budget` show them. Prices: `studio/prices.json` (third-party listings, marked unverified). |
| Router | Patch's `vertex-openai` protocol and the `vertex-ai-pro` / `vertex-ai-flash` providers, first in every chain; `models:check` shows the endpoint's missing model list as "listed: n/a". |

## 2. Spend budgets (the owner's order: no built-in cap)

`npm run budget -- set|clear|resume <tool or key name> [<usd>] --by <who> --why "<the order>"`, stored with a history
(who, when, old → new, why) in `.studio/spend-budgets.json`. At 75% of a budget: one page to the orchestrator and one
Studio Status line. At 100%: new sessions on that tool or key are refused (said once) and the supervisor picks the next
tool, until someone raises the budget or resumes. Who: the owner, the orchestrator and proxies, outside signers, on the
owner's orders; Producers/Directors only with `STUDIO_PRODUCER_APPROVES=protected`; never workers. A resume starts a
fresh count from now.

## 3. Owner-defined tools

`studio/tools.json` (protected) declares a provider as a harness tool: command template, key names its session may see,
models, prices, allowed roles, optionally through the Vertex proxy. It then launches like a built-in tool (lanes, env
filtering, quota and takeover handling, spend, budgets), and the orchestrator can start it. **Defining or changing a tool
is the owner's own act** (`harness/owner-acts.mjs`): a beta, proxy or outside-signer approval of `studio/tools.json` is
refused; budgets for it are not. `STUDIO_TOOL_<NAME>_CMD` keeps working. docs/AGENT-TOOLS.md "How an owner adds a provider".

## 4. The Line Producer plans instead of freezing

| Item | What changed |
|---|---|
| Freeze behind one task (3.1) | Lane-less ready tasks are skipped while other work can run (the Producer is asked once to scope them); a parked chain-breaker pages the orchestrator once (`line.blocker_paged`) and the line keeps filling; a chain-breaker's verify hold ends when its train runs it and lasts at most `STUDIO_LINE_HOLD_MAX_MIN` (20). |
| Engine lands (3.2, the owner's design) | No permanent RAM reservation. When an engine land is queued or near (a porter's `task done --check` passed), the Line holds new heavy starts (builders keep coding), steps the builder cap down one at a time, waits when running verifies are about to finish, starts the land the moment free RAM reaches the floor and releases the hold at once. The floor is learned: the highest of the last 5 green peaks + 1.5 GB after 3 lands (`.studio/engine-ram.json`), never under 4 GB; the owner's floor still wins. The hold lasts at most `STUDIO_ENGINE_HOLD_MAX_MIN` (30), then reports why (`line.engine_hold_expired`) and tries again at the next gap. A land waits 20 min alone, 35 under the Line's hold (was 60). |
| Engine push mode (the owner's ask) | `npm run mode -- engine-push [off] [--engine <name>] [--until <time>|off] --by <who>`: the engine's porters head the plan, its land hold has no time limit, the engine line gets 2 slots with ≥ 24 GB RAM; everything else runs in what's left, nothing is cancelled. Owner, orchestrator, signers, Producer/Director may switch it; a Studio Status line on on/off/expiry. |
| Boost (3.10) | Expiry posts a Studio Status line with the fallback target; `mode boost on --until <time>|off`. |

## 5. Bugs

| # | Fix |
|---|---|
| 3.3 | `sizeRule.exemptMaxKb` in the game's `studio.gates.json` sets an exempt file's KB cap (default 2× the limit). |
| 3.4 | `task done` (and `--check`) reads trailers with `git interpret-trailers` and says exactly where `Golden-Reason:` must go; the train's hand-back says the same. |
| 3.5 | The divergence report's game command runs with TMP/TEMP/TMPDIR under `.studio/tmp`. |
| 3.6 | The supervisor records itself before its first pass; `studio:stop` marks it stopped at once. |
| 3.7 | Before each porter session the engine's target branch is merged into the pass worktree (conflicts named in the brief); porters may `git add` / `git commit` in that worktree (not push, checkout or reset). |
| 3.8 | An engine-porter task with no track takes the only engine's track (or is refused with the list); `task add` infers a lane from paths named in the title. |
| 3.9 | The janitor removes an engine pass worktree after its pass lands, harness temp copies older than 2 h with no live owner (`STUDIO_JANITOR_TEMP_PREFIXES` adds a game's own prefixes), idle lane copies after `STUDIO_LANE_IDLE_HOURS` (now 4). |

## 6. Less fat

| Item | Before → after |
|---|---|
| Event volume (the crew's 7.75 h on 2.79.0, replayed through the new emit paths) | the trimmed types 1,163 → 250 events (−79%), about −27% of all events: `agent.heartbeat` 882 → 194 (one per 10 min per session, `STUDIO_HEARTBEAT_EVENT_MIN`), `task.overlap` 109 → 36 (once per task and set), `skill.follow` 97 → 6 hourly summaries, `director.flow` 30 → 6 and `lock.kept` 18 → 6 (on change), `agent.agy_continue` 19 → 0 (counted on the session end), `futility.shadow` 8 → 2 summaries. The overlap and on-change shapes are estimates. `STUDIO_TELEMETRY=full` restores every event. |
| Playtest freshness | a tester run newer than the task start and the last game change meets a playtest row (T-175's refusal) |
| Visual gate | off by itself when the game has no capture command (`STUDIO_VISUAL_GATE=off` no longer needed) |
| Old switches removed (their default stays) | `STUDIO_LANE_LOCKS`, `STUDIO_TYPE_EVIDENCE`, `STUDIO_UNITY_PLAYMODE_RETRY`, `STUDIO_TRAIN_GREEN_FIRST`, `STUDIO_STAGE1_PLAYTEST`, `STUDIO_REVIEW_VERDICT_LINE`, `STUDIO_DONE_SKIP_GAME_NONCODE`, `STUDIO_TRAIN_LAND_OVER_NONCODE`, `STUDIO_OWNER_ONLY_PARK`; `studio:reload-env` flags them as removed |
| Dead code | 30 of the audit's 42 exports nothing imports (deleted, or just the `export` where used inside the module); the rest live in files other parts changed or in protected files: next release |
| Settings | 715 → 726: 9 removed, about 20 added for the new features (Vertex, budgets, Line hold, engine push, janitor, heartbeat). Gates 37 → 37. |
| Code | harness + scripts +2,001 / −256 lines (Vertex, budgets, the registry and the Line's engine planning are new code). The big trim (splitting train/task/agent, folding duplicate owners) still waits for the usage reset. |

## Untested

- Real Vertex, real aider and the crew's Windows PC (the detached proxy, `.cmd` aider, killing the proxy).
- A real engine land under the new hold, the learned floor from real machine samples, engine push with a Unity editor.
- A real Vite build in the divergence report; the supervisor under Windows' SIGTERM.
- Gemini prices are unverified listings; image output is priced as 2.5 Flash text (undercounts).

## Upgrade note for Patch

1. Remove your local patches first: `git checkout -- harness/route.mjs harness/models.config.mjs`; stop your
   `.studio/vertex-proxy.mjs` and delete it (it holds port 8787; the harness proxy won't take a port another program holds).
2. A person runs: `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.79.1"`, then
   `node harness/hook-stamp.mjs check`, `npm ci`, `npm run upgrade -- --smoke`, restart the supervisor once.
3. `.env`: keep `VERTEX_API_KEY`, `VERTEX_PROJECT_ID`, `GEMINI_PRO_MODEL`, `GEMINI_FLASH_MODEL`; remove
   `STUDIO_TOOL_VERTEX_CMD` (the built-in replaces it) and `STUDIO_VISUAL_GATE=off` (now automatic); add
   `STUDIO_JANITOR_TEMP_PREFIXES=<your game's temp-copy prefix>` so the janitor clears the game's own temp play copies. `npm run studio:reload-env`
   lists anything removed.
4. Budget on the owner's order, e.g. `npm run budget -- set vertex 200 --by opus-1 --why "Hatch: cap Vertex at $200"`.
   Usage logged by your old proxy has no dollars and counts as $0.
5. Try one: `npm run agent -- start --role builder --auto-name --tool vertex --task <small task>`, then `npm run budget`.
