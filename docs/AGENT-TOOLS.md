# Agent tools: how to plug each one in

Checked October 2026 against each tool's own docs. CLIs change fast; run `<tool> --help` before a big
run. `npm run kickoff -- --role <role> --agent <name> --model <model> --tool <tool>` prints the
prompt and the launch line for that tool.

## Launch lines

Every line is run from the repo root and sets `STUDIO_LOCK_OWNER` and `STUDIO_AGENT_MODEL`, so the
agent's task, lock and event commands, and its commits, carry its name and model.

| Tool | Headless run | Writes files when | Key | Notes |
| --- | --- | --- | --- | --- |
| Claude Code | `claude -p "<prompt>"` | `--permission-mode acceptEdits` plus `--allowedTools "Bash(npm run *),…"` | Claude login or `ANTHROPIC_API_KEY` | `--output-format json` returns `total_cost_usd`; `--max-budget-usd` caps one run. Don't use `--bare`: it skips CLAUDE.md, so the agent never sees AGENTS.md. Since v2.1.302 `-p` starts in Manual mode, so set a mode |
| Codex CLI | `codex exec - < prompt.md` | `--sandbox workspace-write` (read-only by default) | `CODEX_API_KEY`, for that one command | `--json` gives JSON Lines. Must run inside a git repo. `--full-auto` is gone |
| Cursor CLI | `agent -p "<prompt>"` | `--force` (or `--yolo`) | `CURSOR_API_KEY` | `--output-format text\|json\|stream-json` |
| Grok Build CLI | `grok -p "<prompt>"` | `--always-approve` | `XAI_API_KEY` or `grok login` | Early beta (SuperGrok, X Premium+). `-m` picks the model; `--output-format plain\|json\|streaming-json` |
| Antigravity CLI | `agy --print-timeout 5400s --mode accept-edits --model <model> < prompt.md` (the launcher's form since 2.76.0; `agy -p "<prompt>"` in Google's docs) | workspace files: always; shell commands: only those its `settings.json` allows (see [agy's allow-rules](#agys-allow-rules-the-owner-enrols-them-once)) | Antigravity key (`AV_API_KEY` in the migration guides) | Replaced Gemini CLI for personal Google accounts on June 18, 2026. Paid Gemini API keys and Code Assist Standard/Enterprise can still use `gemini`. agy exits early unless it has `--print-timeout`, so the launcher adds it |
| Aider + Ollama | `aider --model ollama_chat/<model> --message-file prompt.md` | `--yes` | none (local) | One instruction, then exits: give it one small task. Ollama's default 2k context silently drops text: start it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` |
| Aider + NVIDIA NIM (`--tool nim`) | `aider --model openai/<model> --openai-api-base https://integrate.api.nvidia.com/v1 --message-file prompt.md` | `--yes-always` (and `--no-auto-commits`) | `NVIDIA_API_KEY` (the agent gets it as `OPENAI_API_KEY` and `AIDER_OPENAI_API_KEY`) | See [NIM as a worker](#nim-as-a-worker-tool-nim) |
| Aider + Vertex AI (`--tool vertex`, 2.79.1) | `aider --model openai/google/<model> --openai-api-base http://127.0.0.1:8787/v1 --openai-api-key session-<agent> --message-file prompt.md` | `--yes-always` (and `--no-auto-commits`) | `VERTEX_API_KEY` and `VERTEX_PROJECT_ID` in `.env`: only the studio's proxy reads them, never the session | See [Vertex AI as a builder](#vertex-ai-as-a-builder-tool-vertex-2791) |

Free tiers change often and sources disagree (for example on Gemini's daily request limits), so check
your own account's quota page rather than trusting a number in a doc, this one included.

## How agents are launched on Windows

The launcher (`npm run agent -- start`, hires, the supervisor, and the reviewer and quota checks) starts every
tool without a shell, on every OS, so each argument reaches the tool exactly as built (`harness/launch.mjs`):

2.78.1: `agent stop` then `agent start` with the same name collided with the stopped session's lane copy (its
clean-up still running, or changed minutes ago). The start is now refused up front with a fresh name to use
(`builder-agyf9` → `builder-agyf10`, reserved like the supervisor's names); `--auto-name` (or `STUDIO_AUTO_NAME=on`)
starts under it and logs `agent.renamed`.

- On Windows the tool is looked up on the agent's PATH, each PATHEXT extension in turn, never in the current folder.
  An `.exe` (Claude Code's own installer) starts directly. An npm shim (`claude.cmd`, `agy.cmd` from
  `npm install -g`) is read for the `.js` file it runs, and node starts that file (the shim's own `node.exe` if it
  has one, else the node running the harness): no cmd.exe in between. Any other `.cmd` or `.bat` runs through
  `cmd.exe /d /s /c` with every argument quoted for cmd.exe by one function (quotes, `& | < > ( ) % ! ^` escaped;
  delayed expansion is assumed off, as it is by default).
- Claude Code gets its prompt on stdin and each `--allowedTools` pattern as its own argument; Codex reads stdin, and
  so does agy since 2.58.5 (see below). Cursor and Grok take the prompt as one argument. When it can't travel (longer than Windows' 32,767-character
  command line, a line break through cmd.exe, which can't carry one, or over 120 KB on macOS and Linux), the tool
  gets one line telling it to read `.studio/kickoff/<agent>.md` instead, and the agent's log says so.
- In a lane copy (`.lanes/<agent>`), `studio/` and `.studio/` are links (junctions on Windows) to the main checkout.
  (2.60.1) So an edit there is an edit to main: only the board commands write in `studio/`, and the
  `lane-studio-guard` hook refuses Edit/Write/MultiEdit/NotebookEdit of studio config in a lane copy
  (docs/WORK-ORGANIZATION.md, "Landing lanes").
  Claude Code resolves a link and refused its target as "outside the allowed working directories" (crew logs: 46 of
  ~90 sessions; builders handed back within a minute, unable to read their brief or role file). The launcher now adds
  `--add-dir <main>/studio --add-dir <main>/.studio` (the main checkout's real folders, each flag and path its own
  argument) for Claude, and the same flag for Codex (its extra writable roots; added in Codex PR #5335, so an older
  Codex refuses it: update Codex). agy, Cursor and Grok document no such flag and get nothing extra. A custom command
  runs in the copy too (since 2.58.5) and can pass the folders on itself with `{addDirs}` (below).
- **agy's prompt goes in on stdin** (2.58.5, crew H-2). On Windows agy.exe was started directly (no shell, the prompt
  quoted by the rules every Windows program reads) and still answered `Error: unexpected argument "are". Prompts are
  read only from -p/--print, -i/--prompt-interactive, or stdin`: the prompt ("You are …") was split at its spaces after
  it reached agy. The launcher now starts `agy --print-timeout 5400s --mode accept-edits --model <model> [--settings <file>]`
  (2.76.0, below) and writes the kickoff to its
  stdin, then closes it, so no argument has a space to split (a settings path with a space is given relative to the
  agent's folder). **Untested on real agy:** if your agy ignores stdin, `STUDIO_AGY_PROMPT=arg` brings back
  `agy -p "<prompt>" …`.
- **agy's options (2.76.0, the crew's B-80 and local patches W-0072/W-0073).**
  - `--print-timeout` is `STUDIO_AGY_PRINT_TIMEOUT` (default `5400s`; a bare number means seconds). 900 s ended a
    builder in the middle of a test run ("print timeout after 15m0s while the agent was waiting on 1 background task").
  - `--mode accept-edits` (agy's analogue of Claude's `acceptEdits`): a headless agy session ends at its first refused
    tool, and file writes were refused even with a `write_file` allow rule. `STUDIO_AGY_MODE=off` drops it; another
    value is passed as the mode. Shell commands stay on the `--settings` allow-list.
  - `--model <model>`: `--tool agy` with no `--model` ran agy's own default (a Claude model), not Gemini. With no
    `--model` the launcher now picks `STUDIO_TOOL_AGY_MODEL`, else `gemini-4-argon-high` (`agy models` lists the names; a
    model from the budget order's `agy:<model>` entry wins). **Untested on real agy:** the flag's name;
    `STUDIO_AGY_MODEL_FLAG` names another flag, `=off` passes no model.
  - **Gemini only (2.77.0):** an agy start whose model isn't a Gemini model (`gemini-…`) is refused: agy also serves
    Claude models, and a Claude model inside agy spends Claude's pool under agy's name. `--force-model` (or
    `STUDIO_AGY_ANY_MODEL=on`, or an `agy:<model>` entry the owner put in the budget order) runs it anyway. A model the
    rescue, routing, tier-up or reroute picked for an agy session that isn't Gemini gives way to the Gemini default
    (event `model.kept_gemini`), and a failover keeps a model only within its family.
  - **Usage and model (2.77.0):** `agy -p` printed only its final text in the crew's logs, so every agy session
    recorded 0 tokens. The session end now reads Gemini usage objects from agy's output (`usageMetadata` per response,
    or a `stats.models.<model>.tokens` summary) and the model agy names (`modelVersion`/`model`: `meta.modelReported`);
    with none it records `meta.usage: "not reported"` and tokens estimated from text length (the kickoff in, the
    output out, about 4 characters a token; `meta.tokensEstimated`), never a silent 0 (`agyUsage` in harness/agent.mjs).
    **Untested on real agy:** which of these shapes agy prints (none in the crew's logs).
  - In a lane copy the launcher writes `GEMINI.md` (agy reads it from its folder) with the shell rules: one plain
    command per call, no pipes, chains, redirects or `cd` (a refused command ends the session; the crew found Gemini
    pipes and chains by habit). The file is kept out of the copy's change (its exclude file); a repository that has its
    own `GEMINI.md` keeps it. The agy kickoff carries the same rules.
  - When agy stops on a refused tool, its line (`jetski: … permission … auto-denied`, or a print timeout) is put in the
    hand-back note and the session's end event (`meta.agyStop`), so the reason isn't only in `.studio/agents/<name>.log`.
  - **A builder's agy session stays open across turns (2.77.3, C1 / B-99; on by default since 2.78.1, B-118).**
    `agy -p` runs one turn: a Gemini builder that started a command in the background ("… and am waiting for the
    process to complete") ended its turn and agy exited minutes later with the task unfinished (the GEMINI.md
    foreground rule was ignored). A builder-like session (not reviewer, Producer or Director) starts as
    `agy --input-format stream-json --output-format stream-json --print-timeout <STUDIO_AGY_PRINT_TIMEOUT> --mode accept-edits --model <model> [--settings <file>]`,
    gets the kickoff as the first NDJSON message on stdin, and its stdin stays open. The message is the shape the crew
    probed on real agy (2.78.1, B-118; 2.77.3 sent `"type":"user"` and agy refused it: "stream input message is missing
    the "event" field"): `{"event":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
    When a turn ends (a turn-end word such as `result` or `turn_complete` in an output event's `type`, `event` or
    `kind`) while the session still holds its task's claim (or its pinned task isn't claimed yet), with no stop asked,
    the launcher waits `STUDIO_AGY_CONTINUE_WAIT_SEC` (15) so a background command can finish, asks again, and sends a
    follow-up: check the background command's result in the foreground, then continue to `task done` or `task pause`.
    **Progress nudge (2.78.1):** a stream session with no tool-call event and no file write (the stall check's progress:
    a write, a commit, a task change, or its own verify running) for `STUDIO_AGY_NUDGE_MIN` (10; 0 = off) minutes while
    its task is in progress gets the same follow-up without waiting for a turn end (one stream run sat 40 min with no
    writes). It is kept under two thirds of `STUDIO_STALL_MIN` (15 for a builder), so it comes before the stall end;
    the stall end still follows if the nudge brings no progress. At most `STUDIO_AGY_CONTINUE_MAX` (8) follow-ups a
    session, nudges included (event `agent.agy_continue`, `meta.nudge` on a nudge); then, or once the task is done,
    paused or handed back, the launcher closes stdin and agy exits. Output silent for `STUDIO_AGY_STREAM_IDLE_SEC`
    (1800; 0 never) with no tool call pending also closes it, and so does no stream-json event at all in the first
    `STUDIO_AGY_STREAM_FIRST_SEC` (180). Each step is a `[launcher] agy stream: …` line in the log; an event type the
    launcher doesn't know is noted once and ignored. `STUDIO_AGY_STREAM=0` (or `STUDIO_AGY_PROMPT=arg`) keeps the
    one-turn launch.
    **Safety net (2.78.1):** an agy stream session that exits before its first turn ends, with an input-format error in
    its own output ("missing the … field", "stream input", an unknown or unexpected `--input-format` argument) or with
    no stream-json event at all, is recorded once in `.studio/agy-stream.json` (the error line, the stream flags, agy's
    program file, size, time and `--version`; event `agent.agy_stream_off`, to a person) and relaunched at once under
    the same name in the one-turn mode, in its own lane copy (event `agent.agy_one_turn`). Later agy launches skip the
    stream mode while that record matches the agy on PATH (the log says so); delete `.studio/agy-stream.json` to try
    again. A new agy (another program file and another `--version`) clears the record by itself
    (`agent.agy_stream_retry`). **Untested on real agy:** which output event ends a turn (the crew's full cycle shows
    the session lived through two verifies; harness/agy-stream.mjs is tolerant, and the selftest drives a stand-in
    agy that refuses a line without `"event"`).
  - **A failover works on in its own lane copy (2.78.1, B-118).** `--fallback` (and the one-turn relaunch above) starts
    the next session under the same name in the copy the ended session used, with its branch, commits and any
    uncommitted changes (event `lane.reused`; the kickoff says so, and that the hand-back's patch is a copy of those
    changes). 2.78.0 removed the copy and made a new one: on Windows a copy the dead agy's processes still held stayed
    behind, looked fresh, and the failover was refused ("no lane copy could be made for builder-agyf9 (… still in
    use)"). The copy is removed when the last session in the chain ends, as before.
  - **Gemini first, and Gemini as the cross-family reviewer (2.78.1).** The model routing's built-in defaults
    (harness/model-pools.mjs `DEFAULT_MODELS`, what `npm run models -- init` writes) already put Gemini first:
    `routes.small` = gemini-flash, gemini-argon, claude-sonnet, claude-opus; `routes.normal` = gemini-argon,
    claude-sonnet, claude-opus. A studio's own `studio/models.json` overrides them per list: to put Gemini back first,
    set those two lists in it (or remove them so the defaults apply); `npm run models -- status` shows what routing
    picks now and why. The cross-family reviewer (`npm run review -- <ID>` when the router has no keys or fails;
    harness/review.mjs `reviewerTools`) tries `STUDIO_REVIEWER_TOOL` (+ `STUDIO_REVIEWER_MODEL`), then
    `STUDIO_REVIEW_TOOLS` in order, then codex, agy, claude, skipping the implementer's family: for a Claude
    implementer agy is eligible and for a Gemini one claude is. `STUDIO_REVIEW_TOOLS=agy,claude` puts Gemini first
    for Claude's work (and Claude for Gemini's). The agy reviewer runs `agy --print-timeout 900s --model <Gemini model>`
    with the review on stdin and no `--mode` (it can't edit): the model is the one asked for when it is Gemini
    (`agy:<model>` in `STUDIO_REVIEW_TOOLS`), else `STUDIO_TOOL_AGY_MODEL`, else gemini-4-argon-high. Before 2.78.1 it
    ran `agy -p <review>` with no model, so agy ran its own default (a Claude model) and the review was recorded as
    "gemini". Since 2.78.2 the agy reviewer skips a Gemini model that is marked out (`agy:<model>` in
    .studio/tool-quota.json) and tries the next: the asked-for model, `STUDIO_TOOL_AGY_MODEL`, the default, then
    `STUDIO_REVIEW_AGY_FALLBACK` (comma list, default gemini-3.8-flash-high); only a tool-wide `agy` mark skips agy. A reviewer agent session (`STUDIO_REVIEWER_TOOL=agy`) is one session tool for every review: it is cross-
    family only for work by another family, which the done check (`Approved by a reviewer from another model family`)
    enforces.
- The agent's log (`npm run agent -- logs <agent>`) starts with a `[launcher]` line when a Windows tool was started
  as an npm shim or through cmd.exe, or wasn't found on PATH.
- A custom command (`STUDIO_<ROLE>_CMD`, `STUDIO_AGENT_CMD`, `STUDIO_TOOL_<TOOL>_CMD`) is your own command line and
  still runs in the shell (cmd.exe on Windows). The values filled into `{kickoff}`, `{agent}`, `{model}`, `{role}`
  and `{task}` are quoted for that shell, so a kickoff path with a space stays one argument. Write placeholders bare
  (`mytool --file {kickoff}`) or inside your own quotes; both work. On Windows a value with a double quote or a line
  break is refused, and the agent isn't started.
- **A custom command gets the lane copy like a built-in tool** (2.58.5, crew H-9: a wrapper session ran in the main
  checkout and staged game code there, which the pre-commit hook refused). Its working folder is the copy
  (`.lanes/<agent>`), `STUDIO_MAIN_ROOT` is the main checkout, and two more placeholders help a wrapper start Claude
  Code the way the launcher does: `{mainRoot}` (the main checkout's folder) and `{addDirs}` (`--add-dir <main>/studio
  --add-dir <main>/.studio`, each its own argument; empty outside a copy; write it outside quotes). Example:
  `node /tools/my-wrapper.mjs {kickoff} {model} {addDirs}`. A script that isn't committed isn't in the copy: a bare
  relative path in the line to a file that is in the main checkout but not in the copy is run from the main checkout
  (absolute path; the log says so). Anything else the line needs from the main checkout: `{mainRoot}/tools/x.mjs`.
  `STUDIO_LANELESS=shared` keeps laneless sessions in the main checkout.

Before this (P-066, crew report P-036), Windows ran the built-in tools with `shell: true`: cmd.exe split every
argument at its spaces, so Claude Code lost its allowed-tools list (each command waited for a yes and the agent
quit after a few turns) and agy stopped at `unexpected argument`.

## agy's allow-rules: the owner enrols them once

Claude agents get the harness's command list (`harness/allowlist.mjs`: node, npm, npx, ffmpeg, blender, read-only
git plus add and commit, ls, mkdir, cp, mv) on their command line. agy has no such flag: in headless mode a shell
command is "Ask", nobody is there to answer, so it is skipped ("a tool required the `command` permission that
headless mode cannot prompt for, so it was auto-denied") and the run still exits 0. agy reads what it may run from a
settings file: its user file `~/.gemini/antigravity-cli/settings.json` (`%USERPROFILE%\.gemini\antigravity-cli\settings.json`
on Windows), or a session file given with `agy --settings <file>` (the crew found and used this flag on Windows). So
the harness keeps its own file, `.studio/agy-settings.json` (never committed), and the launcher passes
`--settings .studio/agy-settings.json` to every agy agent once the file exists. The owner writes the rules, not an agent:

```bash
npm run agent -- allow agy --dry-run                        # the file and the rules; writes nothing
npm run agent -- allow agy --by <your name>                 # merge them into .studio/agy-settings.json
npm run agent -- allow agy --by <your name> --scope user    # or into agy's own user-level settings.json
npm run agent -- allow agy --by <your name> --prune         # also take out harness rules beyond the approved set
```

- **The approved set only** (2.58.5, crew H-2b): `node`, `npm`, `npx`, `git status`, `git diff`, `git add`,
  `git commit`, `git log` (the owner's approval of 2026-10-31; `AGY_APPROVED` in `harness/agy-allow.mjs`). 2.58.3 wrote
  the whole harness list (also ffmpeg, blender, git show, ls, mkdir, cp, mv: 30 rules) that nobody had approved for
  agy. More needs `--all` (the whole harness list) and the owner's OK. `--prune` takes harness rules beyond the set being
  written back out of the file (backed up first; your own rules are never touched); a run without it says when there
  are any.
- **File writes (2.76.0, B-80):** agy gates file writes apart from commands. With command rules only, a builder read,
  then quit with `a tool required the "write_file" permission that headless mode cannot prompt for`. The set now
  includes a bare `"write_file"` rule (the form the crew tested on Windows: it allows creating and editing files);
  `command(*)` doesn't cover it. In beta mode (`npm run beta`) the orchestrator the owner named, or a Producer/Director
  session, may run `allow agy` too (logged as a beta use); a worker never.
- It adds that set under `permissions.allow`, two rules per entry: `command(npm)` (agy matches a command's
  leading words) and `command(regex:^npm(?: …)?$)` (on Windows, PowerShell or cmd lines that can't be split into
  words need `regex:`, per Google's docs; the pattern refuses `;`, `&&`, `|` and `$(…)`, so a chained second command
  still asks).
- **What the crew saw on Windows:** the word-prefix rules matched exact commands only (`command(node --version)`
  allowed `node --version`; `command(node)` and its wildcard forms were denied), and the `regex:` rules worked
  (2026-11-04: `node --version`, `npm --version` and `npm run -s task -- train status` through `agy --settings`). A pipe,
  a chain or a `cd` is refused by design (`git status 2>&1 | Select-Object -First 3`, `cd .. ; node --version`), which
  is why the launcher's GEMINI.md and kickoff say "one plain command per call".
- It only adds: other settings and your own allow, ask and deny rules stay (deny still beats allow). The file is
  copied to `<file>.bak-<time>` first and written atomically. A second run adds nothing. A file that isn't plain JSON
  is left alone and the rules are printed to paste by hand.
- The default target is the studio's file; `--scope user` writes the user file instead (it applies to every agy run
  on that machine, so it is said out loud). `--scope project` writes nothing: agy documents no project-level file.
  `--by` names who approved it (event `agy.allow_enrolled`); it refuses an agent's name or a launched session.
- Not confirmed: whether agy merges `--settings` with the user file or uses it alone. agy reviews
  (`harness/review.mjs`) are read-only and don't get `--settings`.
- It never turns on a skip-all mode (`always-proceed`, `--dangerously-skip-permissions`); that stays for a frozen
  test clone (`STUDIO_AGY_BYPASS=1`).
- Until it's done, `npm run agent -- start … --tool agy` prints `agy has no allow-rules: run npm run agent -- allow
  agy --by <owner> (dry-run first)` and starts anyway (event `agy.allow_missing`, at most hourly). The check reads the
  file agy will get: the studio's when it exists, else the user's. node and npm can execute any code, for agy as for
  Claude: these rules spare prompts, they are not a sandbox.
- Not confirmed from Google's docs: whether a CLI `regex:` rule is anchored, and against which text exactly (the
  rules carry their own `^…$`). If agy's format changes, `agyRulesFor()` in `harness/agy-allow.mjs` is the one
  place to change.

## NIM as a worker (`--tool nim`)

`harness/route.mjs` uses NVIDIA NIM for chat only (it can't edit files or run commands). `--tool nim` starts aider on
NIM's OpenAI-compatible endpoint instead, so a NIM model works a task like any other agent:

```bash
npm run agent -- start --role builder --agent nim-1 --tool nim --model <nim model id> --task T-012
```

- argv: `aider --model openai/<model> --openai-api-base https://integrate.api.nvidia.com/v1 --message-file
  <kickoff> --yes-always --no-auto-commits`, then the flags below.
- aider's own commits are off (`--no-auto-commits`, the owner's condition): the agent commits through the studio's
  flow like any other.
- The model: a NIM id (`<org>/<model>`) from `--model`, else `STUDIO_NIM_MODEL`, else `moonshotai/kimi-k2.6`. A nim
  session never runs the role's model (2.58.5, crew H-1: without `--model` it ran `openai/claude-sonnet-5-5`): a model
  that isn't `<org>/<model>` gives way to those two. The old default `qwen/qwen3-coder-480b-a35b-instruct` answered
  410 Gone (end of life 2026-06-11); the new one is taken from NIM's public list as the crew read it on 2026-11-01 and
  is **not run from here**: check `npm run models:check` and set `STUDIO_NIM_MODEL`. When NIM answers 410 or 404 for
  the model, the agent's log ends with one `[launcher]` line saying so and what to set (event `agent.model_gone`).
- The key: the agent's process gets `OPENAI_API_KEY` and `AIDER_OPENAI_API_KEY` set from `NVIDIA_API_KEY` (the first of
  a comma-separated list, else `NVIDIA_API_KEY_2`) and none of your own `OPENAI_` names in any letter case, which would
  otherwise go to NVIDIA's endpoint. The key is never in the argv, the log or the printed line. Why two names (2.58.5,
  crew H-8, "Header of type authorization was missing"): aider loads `.env` files over the environment (your home
  folder, the repo, the current folder; a lane copy has a copy of the studio's `.env`), and `.env.example`'s empty
  `OPENAI_API_KEY=` blanked the key. aider applies `AIDER_OPENAI_API_KEY` (its `--openai-api-key`) after those files.
  Don't put an empty `AIDER_OPENAI_API_KEY=` in a `.env`.
- Which aider (2.60.1, B-18; `--tool aider` too): `STUDIO_AIDER_CMD` (a path to the program, no arguments), else the
  studio's own venv (`.studio/aider-venv/Scripts/aider.exe` on Windows, `.studio/aider-venv/bin/aider` elsewhere, in
  the main checkout), else aider on PATH. The preflight and the launched command use the same answer. Nothing found:
  "install aider (pip install aider-chat) — needs the owner's OK"; a `STUDIO_AIDER_CMD` that points nowhere is named.
  Without a NIM key: "NVIDIA_API_KEY is not set". NIM's free tier runs one session at a time
  (`STUDIO_NIM_MAX_SESSIONS`). A custom command for `--tool nim` (`STUDIO_TOOL_NIM_CMD`, a role's command) gets nim's
  environment, the NIM key as `OPENAI_API_KEY` and `AIDER_OPENAI_API_KEY` (before 2.60.1 it got no key at all), and is
  refused without one.
- The model check (2.60.1, B-19): before a nim session starts, the launcher asks NIM for one token from its model
  (NIM's model list shows models a key can't use). NIM says not found or not for this account (404, 410, "Not found
  for account"): the next model in `STUDIO_NIM_MODELS` (comma-separated; else `NIM_SESSION.fallbackModels` in
  `harness/models.config.mjs`) is tried, and the log's `[launcher]` line and an `agent.nim_model` event say which model
  runs and why. None works: not started, with what to set. A 429 never changes the model (the quota fallback's job); a
  network error launches with the model as set and says the check was skipped. Answers are cached per model and key in
  `.studio/nim-models.json` for 24 h (`STUDIO_NIM_CHECK_HOURS`; delete the file to check again now);
  `STUDIO_NIM_CHECK=off` turns the check off. `npm run models:check` checks the same models.
- What aider sees (2.60.1, B-20, B-21, B-37; `--tool aider` too): `--aiderignore .studio/aider/<agent>.aiderignore`
  (harness/, hub/, scripts/, tools/, studio/, qa/*.mjs and every path in `studio/protected.json`, anchored at the repo
  root, so a game's own `tools/` stays editable): aider never adds those to its chat or edits them, even when the
  kickoff names `harness/task.mjs`. The task's brief goes in with `--read` when it exists. `--no-pretty
  --no-fancy-input` (stdout is a log file), `--no-gitignore` (aider would add `.aider*` to the tracked `.gitignore`;
  in a lane copy `.aider*` is excluded instead), and a bounded repo map (`--map-tokens 1024 --map-refresh files`,
  `AIDER_SESSION` in `harness/models.config.mjs`; `STUDIO_AIDER_MAP_TOKENS=0` turns the map off). `--subtree-only`
  isn't used: a session's folder is the repo root.
- A failed session (2.60.1, B-37): when aider exits non-zero, the last 200 lines of its output
  (`STUDIO_FAILED_TAIL_LINES`) go to `.studio/agents/<agent>.failed-<time>.log`, and its lane copy is kept for a look
  (`STUDIO_KEEP_FAILED_LANE=off` removes it as before); the log and an `agent.failed_evidence` event say where. Python
  output is unbuffered (`PYTHONUNBUFFERED=1`, `PYTHONIOENCODING=utf-8`), so a crash still leaves its last lines.
- The launcher runs the builder protocol around aider (2.79.2, `harness/aider-protocol.mjs`). aider is one-shot and
  doesn't reliably run shell commands, so a builder on aider (`--tool nim`, `aider`, `vertex`, or an owner tool in
  `studio/tools.json` whose command starts `aider`) on a task, in its own lane copy, no longer runs `task start` /
  `task done` itself:
  - before aider starts, the launcher claims the task (`node harness/task.mjs start <ID> --agent <agent>` in the copy;
    refused: not started, with the reason);
  - aider's `--message-file` is a short edit brief (`.studio/kickoff/<agent>.aider.md`: the task, the lane's paths, the
    rules for edits, the brief's "what / done means / steps / never" without harness commands), not the kickoff; no
    `--read` brief;
  - the lane's files go in with `--file`; the agent's `.aiderignore` starts with a whitelist of the lane (so the repo
    map covers the lane only) and lists every tracked file over `STUDIO_AIDER_MAX_FILE_KB` (default 200) that the lane
    doesn't name; the map stays capped by `STUDIO_AIDER_MAP_TOKENS`;
  - after aider exits, the launcher commits its changes on the lane branch (`Studio-Task` / `Studio-Agent` trailers,
    hooks on), runs `task done --check`, then `task done` (in a copy: queued for the merge train). No change, a refused
    commit, a failed check or a refused done hands the task back (`task.paused` with `handBackCause` `no-change` or
    `red`) with aider's last lines and the reason, so the plan's route takes it next (`vertexFailures`, model pools);
  - `agent.session.end` says which (`meta.aider`: claimed, files changed, commit, check, queued or handed back).
  An owner tool that runs aider gets the edit brief as `{kickoff}` and the launcher's aider options as `{aiderArgs}`.
  Other roles, a task-less session, and the shared checkout (no lane copy) start aider as before.
  `STUDIO_AIDER_PROTOCOL=off` brings back the 2.79.1 launch.
  The launcher's claim step (`task start` in the copy) waits `STUDIO_AIDER_CLAIM_TIMEOUT_MS` (default 480000, 8 min; was 120000). When it
  times out or fails after the claim was recorded, the launcher hands the claim back (`task.paused`, the note says "claim step timed out after N s"
  or the failure), so no task stays claimed with no agent.

## One key per agent or role (`STUDIO_KEYMAP_…`, 2.59.0)

The owner can give one launched agent (or every agent of a role) a key under another name, for example so one lane
bills to its own Anthropic key. In `.env` (or the shell that starts the supervisor):

```bash
STUDIO_KEYMAP_BUILDER=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE          # every builder: ANTHROPIC_API_KEY := $ANTHROPIC_API_KEY_LANE
STUDIO_KEYMAP_AGENT_BUILDER_S3=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_S3   # builder-s3 only (beats the role's for that name)
```

- Format: `TARGET:SOURCE[,TARGET:SOURCE]`; the agent's name in capitals with `-` as `_`. For the same TARGET the agent's
  mapping wins over the role's. Only that child's environment changes; the `STUDIO_KEYMAP_` settings aren't passed on.
- Both names must be key names: capitals ending in `_API_KEY` or `_TOKEN`, with an optional suffix (`_LANE`, `_2`).
  Never `STUDIO_…`, `HUB_…` (a 2.79 `.env` may still hold `HUB_TOKEN`) or the owner key. Anything else is refused, and the
  launch goes on without that entry.
- A SOURCE that isn't set leaves TARGET unset for that session (the agent doesn't quietly fall back to the shared key).
  With `--tool nim`, a mapping for `OPENAI_API_KEY` also sets `AIDER_OPENAI_API_KEY`.
- The agent's log gets one `[launcher] key map …` line per entry and an `agent.keymap` event names them (a person sees
  it when something was refused or unset). Values are never printed or written to the log, events or session record,
  and a refused entry is echoed only when it is plainly a variable's name.
- Inside a launched session (an agent hiring an agent) a mapping counts only as written in the studio's `.env`; one set
  in the session's own shell is refused.

### An API-key builder pool (`STUDIO_API_POOL`, 2.79)

`STUDIO_API_POOL=builder-api2,builder-api3` names builders that bill an API key, each mapped with
`STUDIO_KEYMAP_AGENT_BUILDER_API2=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE`, `STUDIO_KEYMAP_AGENT_BUILDER_API3=…` and so on. When the plan's budget is high, the
supervisor starts builders under these names instead of waiting for headroom, up to the pool's size and the pace, RAM
and Line Producer caps. "High" is the signal the supervisor already reads: every tool with a known weekly budget is over
its target for this point in the week (`npm run budget`), or the usage wind-down is on (`STUDIO_USAGE_WINDDOWN_PCT`,
which also counts a tool that is out of quota). With headroom, plan builders start as before and the pool stays idle.
A name with no `STUDIO_KEYMAP_AGENT_<NAME>` entry would bill the plan, so it is ignored. During a wind-down only the
pool starts builders; their lanes still go to the train. The spend guard and the daily token cap apply to the pool as to
any session. `npm run agent -- start --pool api [--task T-12]` starts one pool builder by hand, whatever the budget. A
tool that is out of quota through a provider limit (a 429 mark) still holds every session on that tool, pool or not.

`STUDIO_BUILDER_ORDER` (2.80; unset: the choice above, unchanged) is the owner's order for filling a builder slot, e.g.
`STUDIO_BUILDER_ORDER=api,vertex,plan`: `api` (a free `STUDIO_API_POOL` name), `vertex` (Vertex, below: its budget cut,
prompt and failure rules and `STUDIO_VERTEX_SHARE=0` still apply; its share cap applies only when `vertex` comes after
`plan`) and `plan` (the plan's tool, not while the plan's budget is high). The supervisor takes the first kind that can
start now and skips the others (pool names all running, Vertex cut or off, the plan high); a kind left out is never used.

## Vertex AI as a builder (`--tool vertex`, 2.79.1)

Vertex carries builder work on the owner's Google Cloud credit, so Claude usage goes down. In `.env`, nothing else is
needed:

```bash
VERTEX_API_KEY=<the key>          # works on aiplatform.googleapis.com, location global, only
VERTEX_PROJECT_ID=<the project id>
```

```bash
npm run agent -- start --role builder --tool vertex --task T-12 [--model google/gemini-3.1-pro-preview]
```

- What runs: the studio's aider (the same one `--tool nim` finds: `STUDIO_AIDER_CMD`, `.studio/aider-venv`, PATH) on
  the studio's Vertex proxy (`harness/vertex-proxy.mjs`, `127.0.0.1:STUDIO_VERTEX_PROXY_PORT`, default 8787), with the
  same lane copy, checks and train path as any builder. argv: `aider --model openai/google/<model> --openai-api-base
  http://127.0.0.1:8787/v1 --openai-api-key session-<agent> --message-file <kickoff> --yes-always --no-auto-commits
  --no-stream --no-show-model-warnings`, then the aider flags above.
- The key never reaches the session. The proxy reads `VERTEX_API_KEY` and `VERTEX_PROJECT_ID` from the main checkout's
  `.env` on every request and sends the key to Vertex's OpenAI-compatible endpoint
  (`https://aiplatform.googleapis.com/v1/projects/<project>/locations/global/endpoints/openapi`) as `x-goog-api-key`
  (Vertex answers 401 to a Bearer key). The session's environment has no `VERTEX_API_KEY` (not even through
  `STUDIO_AGENT_ENV_PASS` or `STUDIO_AGENT_ENV=full`), its lane copy's `.env` has no `VERTEX_API_KEY` line, and aider's
  own key is the session tag `session-<agent>`: the proxy reads it as the session's name, never forwards it, and
  serves only a running session on the proxy (401/403 otherwise). Renaming the key in `.env` pauses Vertex at once
  (503 "Vertex is paused or not configured"). The key is never logged or printed.
- The proxy starts on demand (detached, no window, `.studio/vertex-proxy.json`, log `.studio/vertex-proxy.log`) when a
  vertex session starts and it isn't listening, and `npm run studio:stop` stops it. A port held by another program
  (an older local proxy) is named: stop it, or set `STUDIO_VERTEX_PROXY_PORT`.
- Models: `--model` (a bare name gets `google/`), else `STUDIO_VERTEX_MODEL` (default `google/gemini-3-flash-preview`);
  a vertex session never runs the role's Claude model. Hard tasks (size 4-5, a chain-breaker, the Line Producer's hard
  tier) run `STUDIO_VERTEX_HARD_MODEL` (default `google/gemini-3.1-pro-preview`) when the supervisor picks Vertex.
  Live on the crew's key (2026-11-06): gemini-3.1-pro-preview, gemini-3-flash-preview, gemini-2.5-pro, gemini-2.5-flash,
  gemini-2.5-flash-image.
- The supervisor and the Line Producer: a builder that would start on Claude starts on Vertex instead, up to
  `STUDIO_VERTEX_SHARE` of the builder slots (default 0.5) while the plan has headroom; when the plan's budget is high
  (every tool over its weekly target, or the wind-down) Vertex goes first, before the paid API pool
  (`STUDIO_API_POOL`), and takes any free slot. Agy (Gemini plan) routes are left as they are. A task handed back on
  Vertex since it last landed goes to the plan's route (Claude). Why 0.5 by default: half the builders move off the
  Claude plan at once, which is the owner's aim, while the other half keeps the plan's proven builders on the board so
  the two can be compared (`npm run models -- status`, landed vs handed back) before the share goes up; 1 sends every
  Claude builder to Vertex, 0 keeps Vertex for high-budget times and `agent start --tool vertex`.
- A request over `STUDIO_VERTEX_MAX_PROMPT_TOKENS` prompt tokens (default 150000; 0 = no cap; 2.79.2) means the
  session's context is out of hand: the proxy answers that session's next request 403 (not forwarded), the launcher
  stops it (at its next heartbeat, or when aider exits) and hands its task back (`handBackCause` `prompt-cap`, its
  edits not committed), and `agent.session.end` says so. One oversized request is the most such a session spends.
- Spend: each answer's usage goes to `.studio/vertex-usage.jsonl` ({ ts, session, task, tool, model, in = prompt_tokens,
  out = total_tokens - prompt_tokens (Gemini's thinking is billed), total, usd }); a session's tokens and estimated
  dollars land on its `agent.session.end` (`npm run tokens -- --by task`, the same place as the Claude API lane's), and
  `npm run budget` shows Vertex spend. Prices are in `studio/prices.json` (3.1 Pro $2 / $12, 3 Flash $0.50 / $3 per 1M,
  third-party listings; 2.5 Pro and Flash from Google's list as the harness knew it: all unverified, check Google's page).
  There is no cap unless someone sets one (next section). The router's own Vertex calls (`vertex-ai-pro`,
  `vertex-ai-flash`) are logged there too, as session `router`.
- The router (`harness/route.mjs`): providers `vertex-ai-pro` and `vertex-ai-flash` (protocol `vertex-openai`, the key as
  `x-goog-api-key`; `GEMINI_PRO_MODEL`, `GEMINI_FLASH_MODEL`) come first in every chain, before `vertex-gemini-*`.
  `npm run models:check` shows them as "listed: n/a": the endpoint serves no model list (GET /models is 404).
- `STUDIO_VERTEX_BASE_URL` replaces the endpoint (https, or http on 127.0.0.1 only; read from `.env`), for a regional
  endpoint if Google opens one to the key, or a local test server.

## Spend budgets per tool or key (2.79.1)

The owner's rule: spend is always measured and reported, and a budget is a setting placed on an API key or a tool so it
is monitored and cut before it over-charges, set and changed on the owner's orders. There is none by default.

```bash
npm run budget                                                        # spend per tool and key, every budget
npm run budget -- set vertex 200 --by opus-1 --why "Hatch: cap our Vertex spend at $200"   [--since all|now|<ISO>]
npm run budget -- set ANTHROPIC_API_KEY_LANE 50 --by opus-1 --why "Hatch: $50 a week on the lane key"
npm run budget -- resume vertex --by opus-1 --why "Hatch: carry on today"
npm run budget -- clear vertex --by opus-1 --why "Hatch: measure only"
```

- A name is a tool (`vertex`, `claude`, a tool in `studio/tools.json`) or a key name (`VERTEX_API_KEY`,
  `ANTHROPIC_API_KEY_LANE`, …). A tool's spend is its sessions' dollars; a key's is the dollars of every session that
  billed it (each session records the key names it got, after `STUDIO_KEYMAP_…`, names only); Vertex's comes live from
  the proxy's usage log. A new budget counts from when it is set (`--since all` counts everything).
- At 75%: one page to the orchestrator (`budget.warn`) and one Studio Status line. At 100%: new sessions on that tool or
  key are refused with one line naming the budget and how to raise or resume it (`budget.cut`, said once); the
  supervisor passes over a cut tool to the next one (Vertex: the plan or the API pool). Running sessions finish. A cut
  holds until someone allowed raises the budget (`set`) or resumes it (counting starts again from then).
- Kept in `.studio/spend-budgets.json`, with its history (who, when, old -> new, why: the order carried out).
- Who: the owner, and the orchestrator, the owner's proxy or an outside signer acting on the owner's (or the harness
  user's) order, which `--why` records. A Producer or Director session only with `STUDIO_PRODUCER_APPROVES=protected`;
  never a worker or a lane copy. Setting a budget is not an owner-only act.

## How an owner adds a provider: Vertex, DeepSeek, NIM, OpenRouter… (`studio/tools.json`, 2.79.1)

Any provider with a coding agent the owner trusts becomes a harness tool by an entry in `studio/tools.json`. A
registered tool is launched like the built-in ones: `npm run agent -- start --tool <name>` (the orchestrator may run it
without the owner typing anything), the supervisor and the Line Producer (through `STUDIO_<ROLE>_TOOL`, the budget order
in `studio/budget.json`, quota marks and takeovers), the same lane copy, checks and train, an environment with only its
own key names, and spend through the same budget code (`npm run budget -- set <name> <usd> …`).

```json
{
  "tools": [
    {
      "name": "deepseek",
      "command": "\"{mainRoot}/.studio/aider-venv/Scripts/aider.exe\" --model deepseek/{model} --message-file {kickoff} --yes-always --no-auto-commits --no-pretty --no-fancy-input --no-gitignore",
      "provider": "DeepSeek",
      "keyEnv": ["DEEPSEEK_API_KEY"],
      "models": ["deepseek-chat"],
      "prices": { "deepseek-chat": { "in": 0.27, "out": 1.1 } },
      "roles": ["builder"]
    },
    {
      "name": "my-openai-compatible",
      "command": "\"{mainRoot}/.studio/aider-venv/Scripts/aider.exe\" --model openai/{model} --openai-api-base https://llm.example.com/v1 --message-file {kickoff} --yes-always --no-auto-commits --no-pretty --no-fancy-input --no-gitignore",
      "provider": "Any OpenAI-compatible endpoint",
      "keyEnv": ["OPENAI_API_KEY"],
      "models": ["the-model-id"],
      "prices": { "the-model-id": { "in": 1, "out": 4 } },
      "roles": ["builder"]
    },
    {
      "name": "vertex-pro",
      "command": "\"{mainRoot}/.studio/aider-venv/Scripts/aider.exe\" --model openai/google/{model} --openai-api-base {proxyBase} --openai-api-key {sessionKey} --message-file {kickoff} --yes-always --no-auto-commits --no-stream",
      "provider": "Vertex AI through the studio's proxy",
      "keyEnv": [],
      "models": ["gemini-3.1-pro-preview"],
      "prices": "studio/prices.json",
      "roles": ["builder", "reviewer"],
      "proxy": "vertex"
    }
  ]
}
```

(The studio's venv aider is `.studio/aider-venv/Scripts/aider.exe` on Windows, `.studio/aider-venv/bin/aider` elsewhere.)

- Fields: `name` (lower case, not a built-in tool's), `command` (the placeholders of `STUDIO_TOOL_<NAME>_CMD`:
  `{kickoff}`, `{agent}`, `{model}`, `{role}`, `{task}`, `{mainRoot}`, `{addDirs}`; with `"proxy": "vertex"` also
  `{proxyBase}` and `{sessionKey}`), `provider` (a label), `keyEnv` (the only key names its sessions see: put the
  provider's key in `.env` under that name; aider reads `DEEPSEEK_API_KEY` for `deepseek/` models, `OPENROUTER_API_KEY`
  for `openrouter/`, and `OPENAI_API_KEY` for an `openai/` model on any OpenAI-compatible base, as in the second example;
  when `OPENAI_API_KEY` already holds another provider's key, give this provider's key that name for these sessions only
  with a key mapping for their agents, `STUDIO_KEYMAP_AGENT_<NAME>=OPENAI_API_KEY:MYPROVIDER_API_KEY`), `models` (the first is its default), `prices` (USD per 1M tokens, or
  `"studio/prices.json"`), `roles` (default `builder`), `proxy` (optional, `"vertex"`: its traffic goes through the
  studio's Vertex proxy, which holds the key; it never sees `VERTEX_API_KEY`).
- Defining or changing a tool (its command, keys, models, prices, roles) is the owner's own act, like keys and money
  (`harness/owner-acts.mjs`): the file is protected (`studio/protected.json`), and an approval of it made in beta mode,
  by the owner proxy or by an outside signer is refused. What counts is the file as committed on the main checkout:
  with an owner key, only when an approval signed with that key (`npm run approve -- protected`, on the owner's own
  device) records exactly its contents; with no owner key yet, only when the commit that set it is a person's (no
  `Studio-Agent` trailer), a speed bump until the key exists. The orchestrator may launch registered tools and set
  budgets; it may not define tools. A worker does neither. `npm run tools` lists what counts and why not.
- `STUDIO_TOOL_<NAME>_CMD` in `.env` works as before and wins over an entry of the same name (its session is a
  `custom` one, with `STUDIO_<ROLE>_ENV` for its keys). The built-in `vertex` takes no `STUDIO_TOOL_VERTEX_CMD`: the
  crew's local stand-in for it is ignored, and the log says so.


## Scoped agents (`.claude/agents/`)

Claude Code reads three agent definitions from `.claude/agents/`, so a session can hand work to the cheapest model that
fits: **scout** (Haiku, read-only: Read, Grep, Glob, Bash; finds code and answers where/what/how with `path:line`
references, never edits), **fixer** (Sonnet: a change someone already designed, with its tests and their PASS/FAIL
lines) and **architect** (Opus: new subsystems, cross-cutting changes, permission rules and other work that needs
judgement; hands mechanical follow-ups to the fixer). Each file's frontmatter names the agent and its model.

## Best practices for a run

- **Let the launcher make the copies.** Don't use a tool's own worktree mode (`claude -w`): the studio's queue,
  locks and events live in this checkout's `studio/` and `.studio/`. The launcher's lane copies (`.lanes/<agent>`)
  link those back. A code lane gets a copy, and since 2.58.3 so does a code-writing role (anyone but the Producer,
  Director and planner) on a task with no lane: its staged files then can't block other tasks' `task done`
  in the main checkout. 2.76.0 (B-84): so does such a session started with no task at all, and a code-writing session
  that still claims a task from the main checkout (one an older launcher started) gets its copy at `task start`
  (`harness/lane-at-claim.mjs`: `.lanes/<agent>`, the task's earlier work merged in, recorded on its session; the output
  says to cd there). If no copy can be made, the claim is handed back: a builder session never works in the main
  checkout. `STUDIO_LANELESS=shared` keeps such sessions in the main checkout; `STUDIO_WORKTREES=off`
  turns copies off.
- **Name every agent.** One `--agent` per running agent, never shared. The scorecard, locks and HUD
  all go by that name.
- **Cap spend in two places.** The tool's own cap (`--max-budget-usd` for Claude Code) and
  `STUDIO_DAILY_TOKEN_CAP` for anything that goes through the studio router.
- **Check models before you start.** `npm run models:check` asks each provider you have a key for
  which models it serves (the model-list endpoints are free) and names any configured model that is
  gone. Set the matching `*_MODEL` in `.env`.
- **Dry run for free.** Run one builder on Aider + Ollama through a few small tasks before turning on
  paid keys. It proves the loop (start, brief, claim, done-check, hand back) without spending anything.
- **Let the harness see the tool's limits.** When a tool runs out of usage or is stopped, the agent
  should hand back (`task.mjs pause … --note`). If it can't, the watcher requeues the task once its
  claim expires and tells the Producer about agents silent for 30 minutes.

## Sources

- Claude Code headless mode: https://code.claude.com/docs/en/headless
- Codex non-interactive mode: https://learn.chatgpt.com/docs/non-interactive-mode
- Cursor CLI headless: https://cursor.com/docs/cli/headless
- Grok Build CLI headless scripting: https://docs.x.ai/build/cli/headless-scripting
- Gemini CLI to Antigravity CLI migration: https://agentpedia.codes/blog/gemini-cli-to-antigravity-cli-migration
- Antigravity CLI permissions (rule syntax, `regex:` on Windows): https://antigravity.google/docs/permissions?tab=cli
- Antigravity CLI headless mode (soft-denied tools, `permissions.allow`): https://antigravity.google/docs/cli/headless
- Antigravity CLI settings (the one settings file): https://antigravity.google/docs/settings?app=cli
- Aider with Ollama: https://aider.chat/docs/llms/ollama.html
- Aider scripting flags: https://aider.chat/docs/scripting.html
- Aider options (`--openai-api-base`, `--yes-always`): https://aider.chat/docs/config/options.html
- Claude Code CLI (`--add-dir`): `claude --help`
- Codex CLI reference (`--add-dir`): https://developers.openai.com/codex/cli/reference
