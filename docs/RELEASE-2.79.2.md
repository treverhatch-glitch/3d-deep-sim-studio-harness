# 2.79.2: Vertex builders that work (`docs/RELEASE-2.79.2.md`)

A fix release for 2.79.1's Vertex tool, from the crew's first hour on it (2026-11-06): the supervisor started 8 Vertex
builder sessions; every one ended "no work: it never claimed its task", after 1–3 requests of 438k–520k prompt tokens
each, $5.84 in all. Setting `STUDIO_VERTEX_SHARE=0` didn't stop them. Untested on the crew's Windows PC and with real
aider unless it says otherwise. Each item has a selftest that fails on 2.79.1 (`qa/selftest-2792a.mjs`, `2792b.mjs`).

| Item | Cause | Fix |
|---|---|---|
| Aider builders did nothing | aider is one-shot: it edits from one message and exits; it can't run the harness's `task start` / `task done`. Same for `nim` and `aider`. | For a builder on aider (nim, aider, vertex, an owner tool whose command is aider) in its lane copy, **the launcher runs the protocol around aider**: it claims the task first; aider gets a short edit brief (task, lane paths, edit rules; no harness commands) and the lane's files with `--file`; after aider exits the launcher commits with the Studio-Task / Studio-Agent trailers, runs `task done --check` and `task done` (queued for the train), or hands the task back as `no-change` / `red` with aider's last lines and the check's reason. The session end says what happened (`meta.aider`). `STUDIO_AIDER_PROTOCOL=off` restores the 2.79.1 launch. |
| 400k+ tokens per request | aider's repo map and the files it pulled in (a ~1 MB game file) | The repo map covers only the lane (`.aiderignore` whitelist), stays capped (`STUDIO_AIDER_MAP_TOKENS`, 1024), and tracked files over `STUDIO_AIDER_MAX_FILE_KB` (200) are ignored unless the lane names them. A session that sends a request over `STUDIO_VERTEX_MAX_PROMPT_TOKENS` (150,000; 0 = off) is refused its next request by the proxy, stopped, and its task handed back as `prompt-cap` (counted as a Vertex failure, so the plan's route takes the task next). |
| `STUDIO_VERTEX_SHARE=0` didn't hold | With the plan's budget high, the supervisor picked Vertex before reading the share; and the pool router kept a task that had started on Vertex there ("it keeps that model until it lands or fails"), launched as is. | `=0` means no supervisor-started Vertex builder in any mode; the router no longer keeps tasks on Vertex; every Vertex start, new or repeat, passes the same check (share, budget cut, earlier Vertex failures) and otherwise starts on the plan's tool. |

## Untested

- Real aider: whether it honours the lane whitelist in `.aiderignore` and how it reacts to the proxy's 403 (the launcher
  stops the session either way).
- A lane that names the ~1 MB game file still sends it: the prompt cap then stops each such session after one request.
  Split those lanes (region lanes, 2.78.2) or keep those tasks on Claude.
- Edits of a session stopped by the prompt cap are not committed.
- Windows paths (`.cmd` aider, CRLF, `git status -z`).

## Upgrade note for Patch

1. A person runs: `npm run upgrade -- --merge origin/main --by hatch --permission "Hatch: take 2.79.2"` (or
   `origin/claude/2792` before it merges), `node harness/hook-stamp.mjs check`, `npm run upgrade -- --smoke`, restart
   the supervisor once.
2. Keep Vertex cut until one test passes: `npm run agent -- start --role builder --tool vertex --task <small task whose
   lane names one file> --attach` (raise the budget a little first, e.g. `npm run budget -- set vertex 10
   --by opus-1 --why "Hatch: test 2.79.2"`).
3. Check: `.studio/vertex-usage.jsonl` shows tens of thousands of prompt tokens per request; the session log shows
   "claimed", `--file`, and an "aider protocol: …" line; the session end says queued or handed back with a reason, never
   "never claimed".
4. If it works: `npm run budget -- set vertex 200 --by opus-1 --why "Hatch: Vertex back to $200"` and set
   `STUDIO_VERTEX_SHARE` back (e.g. 0.25 to start, compare landings against Claude builders, then raise).
