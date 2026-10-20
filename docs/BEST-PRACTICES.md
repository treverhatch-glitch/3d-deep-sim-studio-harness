# Best practices

Recommendations, not rules: the harness does not enforce these. They keep your accounts in good
standing with GitHub and model providers, and they keep a many-agent team fast and cheap.

## Working with GitHub

- **Commit locally, push in batches.** Let agents commit as often as they like on your machine; a
  person, or one agent you choose, pushes after `npm run verify` passes. A push every few minutes
  from many agents looks like automation abuse; a few pushes a day looks like a developer.
- **Stay in your own repos.** Agents should not open pull requests, issues or comments on other
  people's repositories. Contributions to other projects go through a person.
- **Fine-grained tokens.** Give agents a GitHub token limited to the repos they work on, with an
  expiry date. Never a classic all-repo token.
- **No loops against the API.** Agents read state from local files (`studio/NEXT.md`, the event log),
  not by polling GitHub. CI on push plus one nightly run is plenty.
- **CI is for builds and tests.** The included workflows take under a minute. Keep it that way.

## Working with model providers

- **Use keys you are entitled to.** The router fails over across every key you set, including a
  second key per provider (`NVIDIA_API_KEY_2`, or a comma-separated list), so a second paid key or a
  team key just works. Opening extra free accounts to multiply one provider's free tier breaks most
  providers' terms; failover to a different provider is the safe way to keep agents working.
- **Respect rate limits.** On a 429 the router cools that provider down instead of retrying; leave
  that behaviour on.
- **Cheap model prepares, strong model executes.** `node harness/prepare-brief.mjs` writes a short
  brief so the expensive model reads 300 words, not your whole history.
- **Keys live only in `.env`.** It is gitignored; `bash scripts/secret-scan.sh` checks what git would
  publish.

## Running a team of agents

- **Unique names.** Each running agent gets its own owner name (`cursor-win2`, `claude-a`) so locks
  and the event log say who did what.
- **Lanes, not crowds.** Give each agent a folder or a task type. Two or three agents with clear lanes
  usually beat ten agents in the same files. There is no cap; scale up when the gates stay green.
- **Tools before freehand.** If a tool can make it (Blender presets for models, the balance sweep for
  numbers, scripted playtests for bugs, sound presets for effects), the agent drives the tool and the
  output stays repeatable and reviewable.
- **Gates decide "done".** An agent's claim that something works counts once `npm run verify` passes.
- **Write lessons down.** After a fix, add a replay to `qa/regressions/` and four lines to
  `studio/memory/failures.md`, so every model learns it next session.

## Keeping the repo clean for open source

- Your game, your keys and your private notes live in your clone. Keep the public harness generic:
  no game-specific code outside `cartridges/<your-game>/`.
- Run `npm run release` before you push to a shared or public repo.
