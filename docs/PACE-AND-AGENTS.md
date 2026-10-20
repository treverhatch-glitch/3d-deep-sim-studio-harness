# Pace, MAX SPEED and starting agents

## Pace

The game dev chooses how fast the studio works, at intake, in the War Room's Game plan view, or with
`npm run mode -- set <mode> --by <name>`. Every change is logged in `studio/mode.json`.

| Pace | Agents at once | Reviews from another model family | Starts agents itself | Director / Producer check-ins |
| --- | --- | --- | --- | --- |
| Precise and slow (default) | 2 (1 builder) | every build task | no | 24 h / 8 h |
| Budget: cheaper and slower | 1 | whole systems | no | 24 h / 12 h |
| Fast and furious | 4 (3 builders) | whole systems | yes | 12 h / 4 h |
| Extreme speed | 8 (5 builders) | whole systems | yes | 6 h / 2 h |

## MAX SPEED

A lever in every War Room view (and `npm run mode -- boost on|off --by <name> [--hours 4]`). On top
of any pace: twice the agents (up to 12), agents start automatically, the Director checks in about
four times as often and the Producer every hour. Going faster without the leads looking more often is
how studios drift; the lever does both.

## Starting agents

```bash
npm run agent -- start --role builder --agent builder-1 --tool claude --model claude-sonnet-5-5
npm run agent -- list
npm run agent -- stop builder-1
```

Or the War Room's **Start agent**. Set defaults in `.env`: `STUDIO_AGENT_TOOL` and `STUDIO_AGENT_MODEL`,
or per role (`STUDIO_BUILDER_TOOL`, `STUDIO_DIRECTOR_MODEL`, …). `STUDIO_<ROLE>_CMD` replaces the whole
command for tools the launcher doesn't know (Hermes, a script); `{kickoff}`, `{agent}`, `{model}` and
`{role}` are filled in.

The launcher:
- refuses to start past the pace's caps, while the studio is stopped, or when the daily token cap is spent;
- passes the kickoff on stdin or as one argument, so the same command works on Windows, macOS and Linux
  (macOS uses BSD `script` for agy; Codex can run without its sandbox in a frozen clone with
  `STUDIO_CODEX_BYPASS=1`);
- sends a heartbeat every 2 minutes; the War Room shows "Agent stalled" when it stops;
- when an agent dies (exit code, usage limit, 429, auth), hands its task back with a note, saves its
  uncommitted work under its claims to `.studio/wip/<task>-<agent>.patch`, frees its claims, and with
  `--fallback codex:gpt-6-sol,claude:claude-sonnet-5-5` starts the next tool on the same task.

In fast paces and with MAX SPEED, the watcher (run by the HUB) starts agents for waiting tasks itself.

## Questions with a deadline

```bash
npm run ask -- "Which floor first?" --options "Cubicle,Food court" --default Cubicle --timeout 4h --why "it teaches the controls"
```

The question shows under **Needs you** and in the Game plan, answered with one click. If nobody answers
in time, the default applies, logged in `studio/decisions/decided-without-you.md` and the run report;
the dev can reverse it. Signing, pillars, money and deleting never get a deadline.
