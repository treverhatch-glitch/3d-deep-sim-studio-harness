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
  - **A builder's agy session can stay open across turns (2.77.3, C1 / B-99): OFF by default, `STUDIO_AGY_STREAM=1`
    turns it on.** `agy -p` runs one turn: a Gemini builder that started a command in the background ("… and am waiting
    for the process to complete") ended its turn and agy exited minutes later with the task unfinished (the GEMINI.md
    foreground rule was ignored). It stays off until one hand-run session on the crew's PC confirms the input shape:
    in a studio shell, run `agy --input-format stream-json --output-format stream-json --print-timeout 0 --mode accept-edits --model gemini-4-argon-high`
    and paste `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Say hello, then run node --version in the foreground."}]}}`
    as one line. It works when agy answers, prints a `{"type":"result",…}` line (or another turn-end line) at the end of
    the turn and waits; a second such line starts a second turn; closing its input (Ctrl+Z then Enter on Windows,
    Ctrl+D elsewhere) ends it. If agy refuses the flags without `-p`, or ends turns with another line, say so before
    turning it on. With it on, a builder-like session (not reviewer, Producer, Director or liaison) starts as
    `agy --input-format stream-json --output-format stream-json --print-timeout <STUDIO_AGY_PRINT_TIMEOUT> --mode accept-edits --model <model> [--settings <file>]`,
    gets the kickoff as the first NDJSON user message on stdin
    (`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`), and its stdin stays open.
    When a turn ends (a `result` event in agy's stream-json output, or another turn-end shape) while the session still
    holds its task's claim (or its pinned task isn't claimed yet), with no stop asked, the launcher waits
    `STUDIO_AGY_CONTINUE_WAIT_SEC` (15) so a background command can finish, asks again, and sends a follow-up: check the
    background command's result in the foreground, then continue to `task done` or `task pause`. At most
    `STUDIO_AGY_CONTINUE_MAX` (8) follow-ups a session (event `agent.agy_continue`); then, or once the task is done,
    paused or handed back, it closes stdin and agy exits. Output silent for `STUDIO_AGY_STREAM_IDLE_SEC` (1800; 0 never)
    with no tool call pending also closes it, and so does no stream-json event at all in the first
    `STUDIO_AGY_STREAM_FIRST_SEC` (180; an agy that doesn't take the stream flags then runs as one turn). Each step is a `[launcher] agy stream: …` line in the log; an event type
    the launcher doesn't know is noted once and ignored. `STUDIO_AGY_STREAM` unset or `0` (or `STUDIO_AGY_PROMPT=arg`)
    keeps the one-turn launch. **Untested on real agy:** the input message shape and which output event ends a turn (the
    selftest drives a stand-in agy that speaks this shape; harness/agy-stream.mjs).
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
  Never `STUDIO_…`, `HUB_…` (`HUB_TOKEN` writes to the War Room) or the owner key. Anything else is refused, and the
  launch goes on without that entry.
- A SOURCE that isn't set leaves TARGET unset for that session (the agent doesn't quietly fall back to the shared key).
  With `--tool nim`, a mapping for `OPENAI_API_KEY` also sets `AIDER_OPENAI_API_KEY`.
- The agent's log gets one `[launcher] key map …` line per entry and an `agent.keymap` event names them (a person sees
  it when something was refused or unset). Values are never printed or written to the log, events or session record,
  and a refused entry is echoed only when it is plainly a variable's name.
- Inside a launched session (an agent hiring an agent) a mapping counts only as written in the studio's `.env`; one set
  in the session's own shell is refused.

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
  Director, planner and liaison) on a task with no lane: its staged files then can't block other tasks' `task done`
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
