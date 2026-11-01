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
| Antigravity CLI | `agy -p "<prompt>"` | workspace files: always; shell commands: only those its `settings.json` allows (see [agy's allow-rules](#agys-allow-rules-the-owner-enrols-them-once)) | Antigravity key (`AV_API_KEY` in the migration guides) | Replaced Gemini CLI for personal Google accounts on June 18, 2026. Paid Gemini API keys and Code Assist Standard/Enterprise can still use `gemini`. agy exits early unless it has `--print-timeout` and a closed stdin, so the kickoff line adds both |
| Aider + Ollama | `aider --model ollama_chat/<model> --message-file prompt.md` | `--yes` | none (local) | One instruction, then exits: give it one small task. Ollama's default 2k context silently drops text: start it with `OLLAMA_CONTEXT_LENGTH=32768 ollama serve` |
| Aider + NVIDIA NIM (`--tool nim`) | `aider --model openai/<model> --openai-api-base https://integrate.api.nvidia.com/v1 --message-file prompt.md` | `--yes-always` | `NVIDIA_API_KEY` (the agent gets it as `OPENAI_API_KEY`) | See [NIM as a worker](#nim-as-a-worker-tool-nim) |

Free tiers change often and sources disagree (for example on Gemini's daily request limits), so check
your own account's quota page rather than trusting a number in a doc, this one included.

## How agents are launched on Windows

The launcher (`npm run agent -- start`, hires, the supervisor, and the reviewer and quota checks) starts every
tool without a shell, on every OS, so each argument reaches the tool exactly as built (`harness/launch.mjs`):

- On Windows the tool is looked up on the agent's PATH, each PATHEXT extension in turn, never in the current folder.
  An `.exe` (Claude Code's own installer) starts directly. An npm shim (`claude.cmd`, `agy.cmd` from
  `npm install -g`) is read for the `.js` file it runs, and node starts that file (the shim's own `node.exe` if it
  has one, else the node running the harness): no cmd.exe in between. Any other `.cmd` or `.bat` runs through
  `cmd.exe /d /s /c` with every argument quoted for cmd.exe by one function (quotes, `& | < > ( ) % ! ^` escaped;
  delayed expansion is assumed off, as it is by default).
- Claude Code gets its prompt on stdin and each `--allowedTools` pattern as its own argument; Codex reads stdin.
  agy, Cursor and Grok take the prompt as one argument. When it can't travel (longer than Windows' 32,767-character
  command line, a line break through cmd.exe, which can't carry one, or over 120 KB on macOS and Linux), the tool
  gets one line telling it to read `.studio/kickoff/<agent>.md` instead, and the agent's log says so.
- In a lane copy (`.lanes/<agent>`), `studio/` and `.studio/` are links (junctions on Windows) to the main checkout.
  Claude Code resolves a link and refused its target as "outside the allowed working directories" (crew logs: 46 of
  ~90 sessions; builders handed back within a minute, unable to read their brief or role file). The launcher now adds
  `--add-dir <main>/studio --add-dir <main>/.studio` (the main checkout's real folders, each flag and path its own
  argument) for Claude, and the same flag for Codex (its extra writable roots; added in Codex PR #5335, so an older
  Codex refuses it: update Codex). agy, Cursor and Grok document no such flag and get nothing extra. A custom command
  gets nothing either: add the folders yourself.
- The agent's log (`npm run agent -- logs <agent>`) starts with a `[launcher]` line when a Windows tool was started
  as an npm shim or through cmd.exe, or wasn't found on PATH.
- A custom command (`STUDIO_<ROLE>_CMD`, `STUDIO_AGENT_CMD`, `STUDIO_TOOL_<TOOL>_CMD`) is your own command line and
  still runs in the shell (cmd.exe on Windows). The values filled into `{kickoff}`, `{agent}`, `{model}`, `{role}`
  and `{task}` are quoted for that shell, so a kickoff path with a space stays one argument. Write placeholders bare
  (`mytool --file {kickoff}`) or inside your own quotes; both work. On Windows a value with a double quote or a line
  break is refused, and the agent isn't started.

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
```

- It adds the harness list under `permissions.allow`, two rules per entry: `command(npm)` (agy matches a command's
  leading words) and `command(regex:^npm(?: …)?$)` (on Windows, PowerShell or cmd lines that can't be split into
  words need `regex:`, per Google's docs; the pattern refuses `;`, `&&`, `|` and `$(…)`, so a chained second command
  still asks).
- **What the crew saw on Windows:** agy matched exact commands only. `command(node --version)` allowed
  `node --version`; `command(node *)`, `command(node*)`, `command(node**)`, `command(node:*)` and `command(node)` were
  all denied. So on Windows the word-prefix rules do nothing, and the `regex:` rules are **untested on real agy**. After
  enrolling, check that one launched agy agent can run `node`; if not, add the exact commands it needs by hand.
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
  <kickoff> --yes-always`. aider commits its own edits, as in the Ollama case.
- The model: `--model`, else `STUDIO_NIM_MODEL`, else `qwen/qwen3-coder-480b-a35b-instruct` (a default not run against
  the endpoint from here: check `npm run models:check` or build.nvidia.com and set `STUDIO_NIM_MODEL`).
- The key: the agent's process gets `OPENAI_API_KEY` set from `NVIDIA_API_KEY` (the first of a comma-separated list,
  else `NVIDIA_API_KEY_2`) and none of your own `OPENAI_` names, which would otherwise go to NVIDIA's endpoint. The key
  is never in the argv, the log or the printed line.
- Without aider on PATH the start is refused: "install aider (pip install aider-chat) — needs the owner's OK".
  Without a NIM key: "NVIDIA_API_KEY is not set". NIM's free tier runs one session at a time
  (`STUDIO_NIM_MAX_SESSIONS`).

## Best practices for a run

- **Let the launcher make the copies.** Don't use a tool's own worktree mode (`claude -w`): the studio's queue,
  locks and events live in this checkout's `studio/` and `.studio/`. The launcher's lane copies (`.lanes/<agent>`)
  link those back. A code lane gets a copy, and since 2.58.3 so does a code-writing role (anyone but the Producer,
  Director, planner and liaison) on a task with no lane: its staged files then can't block other tasks' `task done`
  in the main checkout. `STUDIO_LANELESS=shared` keeps such sessions in the main checkout; `STUDIO_WORKTREES=off`
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
