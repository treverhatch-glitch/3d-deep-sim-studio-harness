# Agent tools: how to plug each one in

How the harness starts each agent tool, and how an owner adds a tool, a key, a budget or a provider. Checked October 2026
against each tool's own docs; CLIs change fast, run `<tool> --help` before a big run. `npm run kickoff -- --role <role> --agent
<name> --model <model> --tool <tool>` prints the prompt and the launch line for that tool. Older wording is in git history
(`git log -p -- docs/AGENT-TOOLS.md`); a tag such as (2.78.1) says which release added a feature.

## Launch lines

Every line is run from the repo root and sets `STUDIO_LOCK_OWNER` and `STUDIO_AGENT_MODEL`, so the agent's task, lock and event
commands, and its commits, carry its name and model.

| Tool | Headless run | Writes files when | Key | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p "<prompt>"` | `--permission-mode acceptEdits` plus `--allowedTools "Bash(npm run *),…"` | Claude login or `ANTHROPIC_API_KEY` | `--output-format json` returns `total_cost_usd`; `--max-budget-usd` caps one run. Don't use `--bare`: it skips CLAUDE.md, so the agent never sees AGENTS.md. Since v2.1.302 `-p` starts in Manual mode, so set a mode |
| Codex CLI | `codex exec - < prompt.md` | `--sandbox workspace-write` (read-only by default) | `CODEX_API_KEY`, for that one command | `--json` gives JSON Lines. Must run inside a git repo. `--full-auto` is gone |
| Cursor CLI | `agent -p "<prompt>"` | `--force` (or `--yolo`) | `CURSOR_API_KEY` | `--output-format text\|json\|stream-json` |
| Grok Build CLI | `grok -p "<prompt>"` | `--always-approve` | `XAI_API_KEY` or `grok login` | Early beta. `-m` picks the model; `--output-format plain\|json\|streaming-json` |
| Antigravity CLI | `agy --print-timeout 5400s --mode accept-edits --model <model> < prompt.md` (the launcher's form since 2.76.0) | workspace files: always; shell commands: only those its `settings.json` allows (see [agy's allow-rules](#agys-allow-rules-the-owner-enrols-them-once)) | Antigravity key (`AV_API_KEY`) | Replaced Gemini CLI for personal Google accounts on June 18, 2026; paid Gemini API keys and Code Assist can still use `gemini`. agy exits early without `--print-timeout`, so the launcher adds it |
| Aider + Ollama | `aider --model ollama_chat/<model> --message-file prompt.md` | `--yes` | none (local) | One instruction, then exits: give it one small task. Ollama's default 2k context silently drops text: start it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` |
| Aider + NVIDIA NIM (`--tool nim`) | `aider --model openai/<model> --openai-api-base https://integrate.api.nvidia.com/v1 --message-file prompt.md` | `--yes-always` (and `--no-auto-commits`) | `NVIDIA_API_KEY` (the agent gets it as `OPENAI_API_KEY` and `AIDER_OPENAI_API_KEY`) | See [NIM as a worker](#nim-as-a-worker-tool-nim) |
| Aider + Vertex AI (`--tool vertex`, 2.79.1) | `aider --model openai/google/<model> --openai-api-base http://127.0.0.1:8787/v1 --openai-api-key session-<agent> --message-file prompt.md` | `--yes-always` (and `--no-auto-commits`) | `VERTEX_API_KEY` and `VERTEX_PROJECT_ID` in `.env`: only the studio's proxy reads them, never the session | See [Vertex AI as a builder](#vertex-ai-as-a-builder-tool-vertex-2791) |

Free tiers change often and sources disagree: check your own account's quota page rather than trusting a number in a doc.

## How agents are launched on Windows

The launcher (`npm run agent -- start`, hires, the supervisor, the reviewer and quota checks; `harness/launch.mjs`) starts every tool
without a shell, on every OS, so each argument reaches the tool as built. The agent's log (`npm run agent -- logs <agent>`) starts
with a `[launcher]` line when a Windows tool was started as an npm shim or through cmd.exe, or wasn't found on PATH.

- **Finding the tool (Windows)**: the agent's PATH, each PATHEXT extension in turn, never the current folder. An `.exe` starts
  directly; an npm shim (`claude.cmd`, `agy.cmd`) is read for its `.js` file and node starts that: no cmd.exe; any other `.cmd` or
  `.bat` runs through `cmd.exe /d /s /c` with every argument quoted by one function.
- **The prompt**: Claude Code gets it on stdin and each `--allowedTools` pattern as its own argument; Codex and agy read stdin; Cursor
  and Grok take one argument. When it can't travel (over Windows' 32,767-character command line, a line break through cmd.exe, or over
  120 KB on macOS and Linux) the tool gets one line telling it to read `.studio/kickoff/<agent>.md`.
- **Names**: `agent stop` then `agent start` with the same name can collide with the stopped session's lane copy (2.78.1): the start is
  refused with a fresh name (`builder-agyf9` -> `builder-agyf10`); `--auto-name` (or `STUDIO_AUTO_NAME=on`) starts under it.
- **Lane copies**: in `.lanes/<agent>`, `studio/` and `.studio/` are links to the main checkout, so only the board commands write in
  `studio/` and the `lane-studio-guard` hook refuses Edit/Write of studio config there (`docs/WORK-ORGANIZATION.md`). Claude Code
  refuses a link's target as "outside the allowed working directories", so the launcher adds `--add-dir <main>/studio --add-dir
  <main>/.studio` for Claude and Codex (an older Codex refuses the flag: update it); agy, Cursor and Grok get nothing extra. A code lane
  gets a copy, and so does a code-writing role (anyone but the Producer, Director and planner) on a task with no lane or no task; a
  session that still claims from the main checkout gets its copy at `task start` (`harness/lane-at-claim.mjs`). If no copy can be made
  the claim is handed back: a builder never works in the main checkout. Don't use a tool's own worktree mode (`claude -w`).
  `STUDIO_LANELESS=shared` keeps such sessions in the main checkout; `STUDIO_WORKTREES=off` turns copies off.
- **Custom command** (`STUDIO_<ROLE>_CMD`, `STUDIO_AGENT_CMD`, `STUDIO_TOOL_<TOOL>_CMD`): your own command line, run in the shell
  (cmd.exe on Windows) in the lane copy, with `STUDIO_MAIN_ROOT` set to the main checkout. Placeholders `{kickoff}`, `{agent}`,
  `{model}`, `{role}`, `{task}` are quoted for that shell (write them bare or inside your own quotes; on Windows a value with a double
  quote or line break is refused), plus `{mainRoot}` and `{addDirs}` (`--add-dir <main>/studio --add-dir <main>/.studio`, empty outside
  a copy, write it outside quotes), e.g. `node /tools/my-wrapper.mjs {kickoff} {model} {addDirs}`. A bare relative path to a file that is
  in the main checkout but not in the copy runs from the main checkout; otherwise use `{mainRoot}/tools/x.mjs`.

### agy's options (2.76.0 and later)

- **Prompt on stdin** (2.58.5): the launcher starts `agy --print-timeout 5400s --mode accept-edits --model <model> [--settings
  <file>]` and writes the kickoff to stdin, then closes it. Untested on real agy: if yours ignores stdin, `STUDIO_AGY_PROMPT=arg`
  brings back `agy -p "<prompt>" …`.
- `STUDIO_AGY_PRINT_TIMEOUT` (default `5400s`; a bare number means seconds) sets `--print-timeout`. `STUDIO_AGY_MODE` sets `--mode`
  (default `accept-edits`; `off` drops it); shell commands stay on the `--settings` allow-list.
- **Model**: with no `--model` the launcher picks `STUDIO_TOOL_AGY_MODEL`, else `gemini-4-argon-high` (`agy models` lists names; a
  budget-order `agy:<model>` entry wins). Untested: the flag's name; `STUDIO_AGY_MODEL_FLAG` names another flag, `=off` passes none.
  **Gemini only** (2.77.0): a start whose model isn't `gemini-…` is refused (it would spend Claude's pool under agy's name);
  `--force-model`, `STUDIO_AGY_ANY_MODEL=on`, or an `agy:<model>` budget-order entry runs it anyway. A non-Gemini model picked by
  rescue, routing, tier-up or reroute gives way to the Gemini default (`model.kept_gemini`).
- **Usage** (2.77.0): the session end reads Gemini usage objects from agy's output and the model it names (`meta.modelReported`);
  with none it records `meta.usage: "not reported"` and tokens estimated from text length (`meta.tokensEstimated`), never a silent 0.
- In a lane copy the launcher writes `GEMINI.md` with the shell rules (one plain command per call; no pipes, chains, redirects or
  `cd`: a refused command ends the session); the kickoff carries the same rules. agy's stop line (refused tool, print timeout) is in
  the hand-back note and `meta.agyStop`.
- **A builder's session stays open across turns** (2.77.3; default since 2.78.1): a builder-like session starts as `agy --input-format
  stream-json --output-format stream-json --print-timeout <STUDIO_AGY_PRINT_TIMEOUT> --mode accept-edits --model <model> [--settings
  <file>]` and gets the kickoff as the first NDJSON message on stdin (`{"event":"user","message":{"role":"user","content":[{"type":"text",
  "text":"…"}]}}`), stdin staying open. When a turn ends while the session holds its task's claim, the launcher waits
  `STUDIO_AGY_CONTINUE_WAIT_SEC` (15) and sends a follow-up (check the background command in the foreground, then `task done` or
  `task pause`). A session with no tool call or write for `STUDIO_AGY_NUDGE_MIN` (10; `0` off) minutes gets the same follow-up (kept
  under two thirds of `STUDIO_STALL_MIN`, 15). At most `STUDIO_AGY_CONTINUE_MAX` (8) follow-ups; then, or when the task is done,
  paused or handed back, stdin closes. Silent output for `STUDIO_AGY_STREAM_IDLE_SEC` (1800; `0` never) or no stream event in the
  first `STUDIO_AGY_STREAM_FIRST_SEC` (180) closes it too. `STUDIO_AGY_STREAM=0` (or `STUDIO_AGY_PROMPT=arg`) keeps the one-turn
  launch. **Safety net**: a stream session that exits before its first turn ends with an input-format error is recorded in
  `.studio/agy-stream.json` and relaunched at once in the one-turn mode in its own copy; later launches skip stream mode while the
  record matches the agy on PATH (delete the file to retry; a new agy clears it). Untested on real agy: which event ends a turn.
- **Failover** (2.78.1): `--fallback` (and the one-turn relaunch) starts the next session under the same name in the copy the ended
  one used, with its branch, commits and uncommitted changes (`lane.reused`).
- **Gemini first, and Gemini as cross-family reviewer** (2.78.1): the routing defaults (`DEFAULT_MODELS` in `harness/model-pools.mjs`,
  written by `npm run models -- init`) put Gemini first (`routes.small` = gemini-flash, gemini-argon, claude-sonnet, claude-opus;
  `routes.normal` = gemini-argon, claude-sonnet, claude-opus); a studio's `studio/models.json` overrides them per list; `npm run models
  -- status` shows what routing picks. The cross-family reviewer (`npm run review -- <ID>`; `reviewerTools` in `harness/review.mjs`)
  tries `STUDIO_REVIEWER_TOOL` (+ `STUDIO_REVIEWER_MODEL`), then `STUDIO_REVIEW_TOOLS` in order, then codex, agy, claude, skipping the
  implementer's family (`STUDIO_REVIEW_TOOLS=agy,claude` puts Gemini first for Claude's work). The agy reviewer runs `agy --print-timeout
  900s --model <Gemini model>` with the review on stdin and no `--mode`; the model is the asked-for one when Gemini, else
  `STUDIO_TOOL_AGY_MODEL`, else the default, skipping one marked out (`agy:<model>` in `.studio/tool-quota.json`) and then trying
  `STUDIO_REVIEW_AGY_FALLBACK` (comma list, default gemini-3.8-flash-high). A reviewer session (`STUDIO_REVIEWER_TOOL=agy`) is
  cross-family only for work by another family, which the done check (`Approved by a reviewer from another model family`) enforces.

## Adding to the command list (2.83)

The built-in list is `ALLOWED` in `harness/allowlist.mjs`. A studio adds its own in `studio/allowlist.json`, an array of `[label,
pattern]` string pairs, e.g. `[["tool", "C:/Tools/bin/tool.exe *"]]`: at most 50 entries, each pattern at most 300 characters on one
line, and it must name its command (fewer than 3 characters before the first `*` is skipped). Entries are appended to the list for
Claude agents' `--allowedTools`, the kickoff's list and the denial report (`allowed(root)`). Invalid JSON, a non-array or a bad pair
is ignored. agy's enrolment (below) stays on the owner's approved set. The file is protected (`studio/protected.json`): it changes
only with the owner's signed approval.

## agy's allow-rules: the owner enrols them once

Claude agents get the command list (node, npm, npx, ffmpeg, blender, read-only git plus add and commit, ls, mkdir, cp, mv) on their
command line. agy has none: in headless mode a shell command is "Ask", is auto-denied, and the run still exits 0. agy reads what it may
run from a settings file: its user file `~/.gemini/antigravity-cli/settings.json` or `agy --settings <file>`. The harness keeps
`.studio/agy-settings.json` (never committed) and passes it to every agy agent once it exists. The owner writes the rules, not an agent:

```bash
npm run agent -- allow agy --dry-run                        # the file and the rules; writes nothing
npm run agent -- allow agy --by <your name>                 # merge them into .studio/agy-settings.json
npm run agent -- allow agy --by <your name> --scope user    # or into agy's own user-level settings.json
npm run agent -- allow agy --by <your name> --prune         # also take out harness rules beyond the approved set
```

- **The approved set only** (`AGY_APPROVED` in `harness/agy-allow.mjs`): `node`, `npm`, `npx`, `git status`, `git diff`, `git add`,
  `git commit`, `git log`, plus a bare `"write_file"` rule (agy gates file writes apart). More needs `--all` (the whole harness list) and
  the owner's OK. `--prune` takes harness rules beyond the set out (backed up first; your own rules are never touched). In beta mode
  (`npm run beta`) the orchestrator or a Producer/Director session may run `allow agy` too (a beta use); a worker never. `--by` refuses
  an agent's name or a launched session.
- Rules go under `permissions.allow`, two per entry: `command(npm)` and `command(regex:^npm(?: …)?$)` (needed on Windows; refuses `;`,
  `&&`, `|`, `$(…)`). A pipe, chain or `cd` is refused by design, hence "one plain command per call".
- It only adds: other settings and your own rules stay (deny beats allow); the file is backed up to `<file>.bak-<time>`, written
  atomically, and left alone with the rules printed if it isn't plain JSON. `--scope project` writes nothing; `--scope user` applies to
  every agy run on the machine. agy reviews are read-only and get no `--settings`. If agy's format changes, `agyRulesFor()` in
  `harness/agy-allow.mjs` is the one place to change. Not confirmed: whether agy merges `--settings` with the user file.
- It never turns on a skip-all mode (`always-proceed`, `--dangerously-skip-permissions`); that stays for a frozen test clone
  (`STUDIO_AGY_BYPASS=1`).
- Until enrolled, `npm run agent -- start … --tool agy` prints `agy has no allow-rules: run npm run agent -- allow agy --by <owner>
  (dry-run first)` and starts anyway (at most hourly). node and npm can run any code: these rules spare prompts, they are not a sandbox.

## NIM as a worker (`--tool nim`)

`harness/route.mjs` uses NVIDIA NIM for chat only. `--tool nim` starts aider on NIM's OpenAI-compatible endpoint so a NIM model
works a task like any agent: `npm run agent -- start --role builder --agent nim-1 --tool nim --model <nim model id> --task T-012`.

- argv: `aider --model openai/<model> --openai-api-base https://integrate.api.nvidia.com/v1 --message-file <kickoff> --yes-always
  --no-auto-commits`, then the aider flags below. aider's own commits are off: the agent commits through the studio's flow.
- **Model**: `--model` (a `<org>/<model>` id), else `STUDIO_NIM_MODEL`, else `moonshotai/kimi-k2.6` (not run from here: check `npm run
  models:check`). A model that isn't `<org>/<model>` gives way to those. A 410 or 404 from NIM ends the log with a `[launcher]` line
  saying what to set. Before a session starts the launcher asks NIM for one token; not found (404, 410) tries the next model in
  `STUDIO_NIM_MODELS` (comma-separated; else `NIM_SESSION.fallbackModels` in `harness/models.config.mjs`), none works: not started. A 429
  never changes the model; a network error launches as set. Cached in `.studio/nim-models.json` for 24 h (`STUDIO_NIM_CHECK_HOURS`;
  delete the file to check now); `STUDIO_NIM_CHECK=off` turns it off.
- **Key**: the process gets `OPENAI_API_KEY` and `AIDER_OPENAI_API_KEY` from `NVIDIA_API_KEY` (first of a comma-separated list, else
  `NVIDIA_API_KEY_2`) and none of your own `OPENAI_` names; it is never in the argv, log or printed line. aider loads `.env` files over
  the environment, so never put an empty `OPENAI_API_KEY=` or `AIDER_OPENAI_API_KEY=` in a `.env`. NIM's free tier runs one session
  at a time (`STUDIO_NIM_MAX_SESSIONS`). A custom command for `--tool nim` (`STUDIO_TOOL_NIM_CMD`) gets nim's environment and is refused
  without a key.
- **Which aider** (`--tool aider` too): `STUDIO_AIDER_CMD` (a path, no arguments), else the studio's venv
  (`.studio/aider-venv/Scripts/aider.exe` on Windows, `.studio/aider-venv/bin/aider` elsewhere, in the main checkout), else PATH. Nothing
  found: "install aider (pip install aider-chat) — needs the owner's OK".
- **What aider sees** (`--tool aider` too): `--aiderignore .studio/aider/<agent>.aiderignore` (harness/, scripts/, tools/, studio/,
  qa/*.mjs and every path in `studio/protected.json`, anchored at the repo root); the brief with `--read`; `--no-pretty
  --no-fancy-input`; `--no-gitignore`; a bounded repo map (`--map-tokens 1024 --map-refresh files`; `STUDIO_AIDER_MAP_TOKENS=0` turns
  it off). A failed session: its last 200 lines (`STUDIO_FAILED_TAIL_LINES`) go to `.studio/agents/<agent>.failed-<time>.log` and its
  lane copy is kept (`STUDIO_KEEP_FAILED_LANE=off` removes it).
- **The launcher runs the builder protocol around aider** (2.79.2, `harness/aider-protocol.mjs`): a builder on aider (`--tool nim`,
  `aider`, `vertex`, or an owner tool in `studio/tools.json` whose command starts `aider`) on a task, in its own lane copy, does not run
  `task start` / `task done` itself. The launcher claims the task first (`node harness/task.mjs start <ID> --agent <agent>`; refused:
  not started; waits `STUDIO_AIDER_CLAIM_TIMEOUT_MS`, 480000, then hands the claim back). aider's `--message-file` is a short edit brief
  (`.studio/kickoff/<agent>.aider.md`), the lane's files go in with `--file`, and the `.aiderignore` whitelists the lane and lists every
  tracked file over `STUDIO_AIDER_MAX_FILE_KB` (200) the lane doesn't name. After aider exits the launcher commits its changes on the lane
  branch (`Studio-Task` / `Studio-Agent` trailers, hooks on), runs `task done --check`, then `task done` (queued for the train). No
  change, a refused commit, a failed check or a refused done hands the task back (`handBackCause` `no-change` or `red`) with aider's last
  lines. An owner tool that runs aider gets the brief as `{kickoff}` and the launcher's aider options as `{aiderArgs}`. Other roles,
  task-less sessions and the shared checkout start aider as before. `STUDIO_AIDER_PROTOCOL=off` brings back the 2.79.1 launch.

## One key per agent or role (`STUDIO_KEYMAP_…`, 2.59.0)

The owner can give one launched agent (or every agent of a role) a key under another name, in `.env` or the supervisor's shell:

```bash
STUDIO_KEYMAP_BUILDER=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE          # every builder: ANTHROPIC_API_KEY := $ANTHROPIC_API_KEY_LANE
STUDIO_KEYMAP_AGENT_BUILDER_S3=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_S3   # builder-s3 only (beats the role's for that name)
```

- Format `TARGET:SOURCE[,TARGET:SOURCE]`; the agent's name in capitals with `-` as `_`. Only that child's environment changes.
- Both names must be key names: capitals ending in `_API_KEY` or `_TOKEN` with an optional suffix (`_LANE`, `_2`); never `STUDIO_…`,
  `HUB_…` or the owner key. Anything else is refused and the launch goes on without that entry.
- A SOURCE that isn't set leaves TARGET unset for that session (no quiet fallback to the shared key). With `--tool nim`, a mapping
  for `OPENAI_API_KEY` also sets `AIDER_OPENAI_API_KEY`. Values are never printed or recorded (`[launcher] key map …`, `agent.keymap`).
  In a launched session a mapping counts only as written in the studio's `.env`.

### An API-key builder pool (`STUDIO_API_POOL`, 2.79)

`STUDIO_API_POOL=builder-api2,builder-api3` names builders that bill an API key, each mapped with
`STUDIO_KEYMAP_AGENT_BUILDER_API2=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE`, `STUDIO_KEYMAP_AGENT_BUILDER_API3=…` and so on (a name with no mapping would bill the plan, so
it is ignored). When the plan's budget is high (every tool with a known weekly budget over its target, `npm run budget`, or the usage
wind-down is on, `STUDIO_USAGE_WINDDOWN_PCT`, which also counts a tool out of quota) the supervisor starts builders under these names,
up to the pool's size and the pace, RAM and Line Producer caps; with headroom the pool stays idle. During a wind-down only the pool
starts builders. The spend guard and the daily token cap apply. `npm run agent -- start --pool api [--task T-12]` starts one by hand. A
tool out of quota through a provider limit (a 429 mark) still holds every session on that tool.

`STUDIO_BUILDER_ORDER` (2.80; unset: the choice above) is the owner's order for filling a builder slot, e.g. `api,vertex,plan`: `api` (a
free pool name), `vertex` (its budget cut, prompt and failure rules and `STUDIO_VERTEX_SHARE=0` still apply; its share cap only when it
comes after `plan`) and `plan` (the plan's tool, not while the plan's budget is high). The first kind that can start now is taken; a kind
left out is never used.

## Vertex AI as a builder (`--tool vertex`, 2.79.1)

Vertex carries builder work on the owner's Google Cloud credit. In `.env`: `VERTEX_API_KEY=<the key>` (works on
aiplatform.googleapis.com, location global, only) and `VERTEX_PROJECT_ID=<the project id>`. Then: `npm run agent -- start --role builder
--tool vertex --task T-12 [--model google/gemini-3.1-pro-preview]`.

- **What runs**: the studio's aider (found as for `--tool nim`) on the studio's Vertex proxy (`harness/vertex-proxy.mjs`,
  `127.0.0.1:STUDIO_VERTEX_PROXY_PORT`, default 8787), same lane copy, checks and train path. argv: `aider --model openai/google/<model>
  --openai-api-base http://127.0.0.1:8787/v1 --openai-api-key session-<agent> --message-file <kickoff> --yes-always --no-auto-commits
  --no-stream --no-show-model-warnings`. The proxy starts on demand (`.studio/vertex-proxy.json`, log `.studio/vertex-proxy.log`);
  `npm run studio:stop` stops it; a port held by another program is named (stop it, or set `STUDIO_VERTEX_PROXY_PORT`).
- **The key never reaches the session.** The proxy reads `VERTEX_API_KEY` and `VERTEX_PROJECT_ID` from the main checkout's `.env` on
  every request and sends the key to Vertex's OpenAI-compatible endpoint as `x-goog-api-key`. The session's environment has no
  `VERTEX_API_KEY` (not even through `STUDIO_AGENT_ENV_PASS` or `STUDIO_AGENT_ENV=full`), its lane copy's `.env` has no such line, and
  aider's key is the session tag `session-<agent>` (the proxy serves only a running session, 401/403 otherwise). Renaming the key in
  `.env` pauses Vertex at once (503).
- **Models**: `--model` (a bare name gets `google/`), else `STUDIO_VERTEX_MODEL` (default `google/gemini-3-flash-preview`); a vertex
  session never runs the role's Claude model. Hard tasks (size 4-5, a chain-breaker, the Line Producer's hard tier) run
  `STUDIO_VERTEX_HARD_MODEL` (default `google/gemini-3.1-pro-preview`) when the supervisor picks Vertex.
- **Share**: the supervisor and Line Producer start a builder that would run on Claude on Vertex instead, up to `STUDIO_VERTEX_SHARE` of
  the builder slots (default 0.5; 1 sends every Claude builder, 0 keeps Vertex for high-budget times and `agent start --tool vertex`)
  while the plan has headroom; when the plan's budget is high Vertex goes first, before the API pool, and takes any free slot. Agy
  routes are left alone. A task handed back on Vertex since it last landed goes to the plan's route. An engine-track task never goes to
  Vertex (2.83); `STUDIO_VERTEX_ENGINE=on` allows it.
- **Prompt cap**: a request over `STUDIO_VERTEX_MAX_PROMPT_TOKENS` (default 150000; `0` = no cap) prompt tokens makes the proxy answer
  that session's next request 403; the launcher stops it and hands its task back (`handBackCause` `prompt-cap`, edits not committed). A
  launch whose prompt files are already over the cap (bytes / 4) is refused before the proxy starts (`agent.start_refused`).
- **Spend**: each answer's usage goes to `.studio/vertex-usage.jsonl`; a session's tokens and dollars land on `agent.session.end`
  (`npm run tokens -- --by task`) and `npm run budget` shows Vertex spend. Prices are in `studio/prices.json` (unverified: check
  Google's page). The router's own Vertex calls are logged there as session `router`.
- **Router** (`harness/route.mjs`): providers `vertex-ai-pro` and `vertex-ai-flash` (`GEMINI_PRO_MODEL`, `GEMINI_FLASH_MODEL`) come first
  in every chain; `npm run models:check` shows them as "listed: n/a". `STUDIO_VERTEX_BASE_URL` replaces the endpoint (https, or http on
  127.0.0.1 only; read from `.env`).

## Spend budgets per tool or key (2.79.1)

Spend is always measured and reported; a budget is a setting on an API key or a tool, monitored and cut before it over-charges, set on
the owner's orders. There is none by default.

```bash
npm run budget                                                        # spend per tool and key, every budget
npm run budget -- set vertex 200 --by opus-1 --why "Hatch: cap our Vertex spend at $200"   [--since all|now|<ISO>]
npm run budget -- set ANTHROPIC_API_KEY_LANE 50 --by opus-1 --why "Hatch: $50 a week on the lane key"
npm run budget -- resume vertex --by opus-1 --why "Hatch: carry on today"
npm run budget -- clear vertex --by opus-1 --why "Hatch: measure only"
```

- A name is a tool (`vertex`, `claude`, a tool in `studio/tools.json`) or a key name. A tool's spend is its sessions' dollars; a key's
  is the dollars of every session that billed it (names recorded after `STUDIO_KEYMAP_…`); Vertex's comes live from the proxy's log. A
  new budget counts from when it is set (`--since all` counts everything).
- At 75%: one page to the orchestrator (`budget.warn`) and one Studio Status line. At 100%: new sessions on that tool or key are refused
  with one line naming how to raise or resume it (`budget.cut`); the supervisor passes over a cut tool to the next. Running sessions
  finish. A cut holds until someone allowed raises (`set`) or resumes it.
- Kept in `.studio/spend-budgets.json` with its history (who, when, old -> new, why).
- Who: the owner, and the orchestrator, the owner's proxy or an outside signer acting on the owner's order (`--why` records it); a
  Producer or Director session only with `STUDIO_PRODUCER_APPROVES=protected`; never a worker or a lane copy. Setting a budget is not
  an owner-only act.

## How an owner adds a provider: Vertex, DeepSeek, NIM, OpenRouter… (`studio/tools.json`, 2.79.1)

Any provider with a coding agent the owner trusts becomes a harness tool by an entry in `studio/tools.json`. A registered tool is
launched like the built-in ones (`npm run agent -- start --tool <name>`; the supervisor and Line Producer through `STUDIO_<ROLE>_TOOL`,
the budget order in `studio/budget.json`, quota marks and takeovers), with the same lane copy, checks and train, an environment with
only its own key names, and spend through the budget code (`npm run budget -- set <name> <usd> …`).

```json
{ "tools": [ {
  "name": "deepseek",
  "command": "\"{mainRoot}/.studio/aider-venv/Scripts/aider.exe\" --model deepseek/{model} --message-file {kickoff} --yes-always --no-auto-commits --no-pretty --no-fancy-input --no-gitignore",
  "provider": "DeepSeek", "keyEnv": ["DEEPSEEK_API_KEY"], "models": ["deepseek-chat"],
  "prices": { "deepseek-chat": { "in": 0.27, "out": 1.1 } }, "roles": ["builder"]
} ] }
```

- Fields: `name` (lower case, not a built-in's), `command` (placeholders of `STUDIO_TOOL_<NAME>_CMD`: `{kickoff}`, `{agent}`, `{model}`,
  `{role}`, `{task}`, `{mainRoot}`, `{addDirs}`; with `"proxy": "vertex"` also `{proxyBase}` and `{sessionKey}`), `provider` (a label),
  `keyEnv` (the only key names its sessions see; put the provider's key in `.env` under that name: aider reads `DEEPSEEK_API_KEY` for
  `deepseek/` models, `OPENROUTER_API_KEY` for `openrouter/`, `OPENAI_API_KEY` for an `openai/` model on any OpenAI-compatible
  `--openai-api-base`; if `OPENAI_API_KEY` holds another provider's key, map it for these agents only:
  `STUDIO_KEYMAP_AGENT_<NAME>=OPENAI_API_KEY:MYPROVIDER_API_KEY`), `models` (the first is the default), `prices` (USD per 1M tokens, or
  `"studio/prices.json"`), `roles` (default `builder`), `proxy` (optional `"vertex"`: traffic goes through the studio's Vertex proxy,
  which holds the key; `keyEnv` is then `[]`).
- Defining or changing a tool is the owner's own act, like keys and money (`harness/owner-acts.mjs`): the file is protected
  (`studio/protected.json`) and an approval of it made in beta mode, by the owner proxy or by an outside signer is refused. What counts
  is the file as committed on the main checkout: with an owner key, only an approval signed with that key (`npm run approve --
  protected`, on the owner's own device) that records exactly its contents; with no owner key yet, only a commit that is a person's (no
  `Studio-Agent` trailer). The orchestrator may launch registered tools and set budgets, not define tools; a worker does neither. `npm
  run tools` lists what counts and why not.
- `STUDIO_TOOL_<NAME>_CMD` in `.env` wins over an entry of the same name (its session is a `custom` one, with `STUDIO_<ROLE>_ENV` for its
  keys). The built-in `vertex` takes no `STUDIO_TOOL_VERTEX_CMD` (ignored, the log says so).

## Scoped agents (`.claude/agents/`)

Claude Code reads three agent definitions from `.claude/agents/`, so a session can hand work to the cheapest model that fits:
**scout** (Haiku, read-only: Read, Grep, Glob, Bash; finds code and answers with `path:line` references, never edits), **fixer**
(Sonnet: a change someone already designed, with its tests and their PASS/FAIL lines) and **architect** (Opus: new subsystems,
cross-cutting changes, permission rules and other work that needs judgement; hands mechanical follow-ups to the fixer).

## Best practices for a run

- **Let the launcher make the copies** (see "Lane copies" above).
- **Name every agent.** One `--agent` per running agent, never shared: the scorecard, locks and HUD go by that name.
- **Cap spend in two places.** The tool's own cap (`--max-budget-usd` for Claude Code) and `STUDIO_DAILY_TOKEN_CAP` for anything that
  goes through the studio router.
- **Check models before you start.** `npm run models:check` asks each provider you have a key for which models it serves (free) and
  names any configured model that is gone. Set the matching `*_MODEL` in `.env`.
- **Dry run for free.** Run one builder on Aider + Ollama through a few small tasks before turning on paid keys; it proves the loop
  (start, brief, claim, done-check, hand back) without spending anything.
- **Let the harness see the tool's limits.** When a tool runs out of usage or is stopped, the agent should hand back (`task.mjs pause …
  --note`). If it can't, the watcher requeues the task once its claim expires and tells the Producer about agents silent for 30 minutes.

## Sources

Each tool's headless docs: code.claude.com/docs/en/headless, learn.chatgpt.com/docs/non-interactive-mode, cursor.com/docs/cli/headless,
docs.x.ai/build/cli/headless-scripting. Antigravity: antigravity.google/docs/permissions?tab=cli (`regex:` on Windows),
antigravity.google/docs/cli/headless, antigravity.google/docs/settings?app=cli. Aider: aider.chat/docs/llms/ollama.html,
aider.chat/docs/scripting.html, aider.chat/docs/config/options.html. `--add-dir`: `claude --help`, developers.openai.com/codex/cli/reference.
