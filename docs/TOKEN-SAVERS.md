# Token savers (2.30g)

Six changes that cut what agents re-read, plus a Godot unit gate. None of them caps anyone's use.

## 1. Cache-friendly prompt order
The launcher builds every kickoff in two parts, split by `<!-- stable-prefix-end -->`:
- **Stable** (first): the role kickoff, the rules, the map tip, the skills line and the game's pitfalls. It names the agent and model only as `$STUDIO_LOCK_OWNER` and `$STUDIO_AGENT_MODEL` (the launcher sets both), so every session of a role starts with the same bytes and Claude reads them from the prompt cache.
- **Volatile** (last, under "## This session"): the agent's name and model, the task, the lane, the repo copy, the refresh rule, how long the last verify took, and any note.

The Director and Producer ask Claude Code for the 1-hour cache (`ENABLE_PROMPT_CACHING_1H=1`, `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`; Claude Code 2.1.108 or later, older versions ignore it). `STUDIO_LONG_CACHE=off` turns it off.

A launched session's SessionStart hook now prints one fixed line, because its old output (the current task, the queue) was added to the context before the kickoff and changed on every launch.

**Check it:** each launch writes the prefix hash to `.studio/prefix-ledger.jsonl`; a changed prefix for a role emits `prompt.prefix.changed`. `npm run prefix` prints each role's stability. Each `agent.session.end` now carries `cacheWrite`, `cacheHitRate` and `prefixHash` from Claude's own usage lines, and the War Room's Tokens panel shows the 24 h hit rate.

## 2. Old tool results in long sessions
The harness starts Claude only through the Claude Code CLI (`claude -p --output-format stream-json`); it never calls the Messages API itself. Anthropic's server-side context editing (clearing old tool results) is an API option, so the harness cannot switch it on. What it does instead:
- long command output is trimmed before the agent reads it (hook below), so old results are small to begin with;
- the session cap (2.29.2) still refreshes a session at 40 turns or 120k tokens and carries the work forward in a hand-back note.
Claude Code's own auto-compaction still applies inside a session.

## 3. Skills that load on demand
`.claude/skills/` holds `godot-scene-edit`, `gdunit-run`, `web-build-deploy`, `asset-import` and `producer-playbook`. Claude Code shows only their names and one-line descriptions until a task needs one. The Producer's items 12 to 20 moved from its kickoff into `producer-playbook`, so its kickoff is shorter. Other tools are told to open a skill's SKILL.md when the task matches.

## 4. Claude Code hooks (`.claude/settings.json`)
- `trim-output.mjs` (PostToolUse, Bash): output over 120 lines or 12k characters is cut to the failure lines (with one line of context) plus the last 40 lines. The full text is kept in `.studio/trimmed/`. `STUDIO_TRIM=off` or `STUDIO_TRIM_LINES=<n>`.
- `guard-paths.mjs` (PreToolUse): reads of `node_modules`, `build`, `dist`, `.godot` and `.import` are denied, with `npm run map -- find <name>` as the alternative. Running a build is not blocked. `STUDIO_GUARD_PATHS=off`.
- `stop-gate.mjs` (Stop): a launched agent with changed files outside `studio/` can't end its turn until the fast (lite) gates pass. It never runs in a person's session and never loops. `STUDIO_STOP_GATE=off`. Fast-only: the hook has a hard budget of 6 s (`STUDIO_STOP_GATE_MS`, capped at 8 s; Claude's hook timeout is 10 s). Checks that don't finish in time are skipped, never blocking, so it can't slow an agent down; the full gates still run at hand-off.

## 5. Token norms per task type
`npm run token-norms` learns each task type's normal use (median and spread of in + out + a tenth of cache reads, from 5 sessions up) and lists sessions far above their own type's normal. A 3D task in Godot is compared with other 3D tasks, never with a docs fix. It is a flag on the HUD only: nothing is capped or stopped.

## 6. Verdict notes
A playtest verdict with words (`npm run verdict`) is also saved to `studio/memory/verdict-notes.jsonl`; `npm run verdict-note -- add --verdict ❌ --on T-12 --by <you> --comment "…"` adds one by hand. A task's brief shows up to 3 related notes under "Notes from the dev's verdicts (context, not rules)".

## 7. Godot unit gate (gdUnit4)
Opt-in per game in `studio/godot-unit.json` (pinned: gdUnit4 v6.2.2, Godot 4.7.2; `GODOT_BIN` overrides the binary). The `godot-unit` gate is a fast (lite) gate: it runs `addons/gdUnit4/runtest.sh` headless when a file under the project's `sim`, `scripts` or `test_gdunit` changed. Exit 0 passes; 100 (failures) and 105 (script error) block. The failing tests from the JUnit XML go into the task's brief and the HUD. It skips cleanly when a game hasn't opted in or has no Godot project. Builders who change sim rules add or update a test in the same task (`gdunit-run` skill).
