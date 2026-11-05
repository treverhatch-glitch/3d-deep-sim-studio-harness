# Reviewer Rule

Before marking a non-trivial change done:

1. The implementing agent records the model/provider used.
2. A reviewer agent from a **different model family** must review (example: builder on Gemini, reviewer on Claude or Grok).
3. Reviewer writes a short note in the task or `studio/CURRENT_TASK.md`.
4. Do not self-review with the same model family for core sim changes.

This is a process rule. It is not fully machine-enforced yet.

**Acceptance contracts (2.62.0).** When the task has an agreed contract (`studio/contracts/<ID>.json`,
docs/CONTRACTS.md), grade the work against each criterion: `npm run review` sends it in the brief and asks for a
"CONTRACT <id>: met or not met" line per criterion; one not met means request changes. A manual criterion is yours
to sign: `npm run task -- contract <ID> sign <CID> pass|fail --by <your name> --note "…"`. A builder never signs one.

**A review done outside the harness (2.78.2).** When no cross-family reviewer tool is available (every one out of quota or
not installed), a person, the orchestrator or a Producer/Director session can record a review somebody else did (grokbot
through xAI, a DeepSeek chat, a person):

    npm run review -- record <ID> --by <reviewer name> --family <xai|deepseek|openai|google|anthropic|...> --file <review.md> [--model <m>] [--no-commit]

The file must end with a verdict line (`VERDICT: APPROVE` or `VERDICT: CHANGES`). The family has to differ from the
implementer's (it is refused otherwise), and a worker session, or a worker's name in `STUDIO_LOCK_OWNER`, is refused: a
worker can't record its own review. The review is written to `studio/reviews/<date>-<ID>-outside-<name>.md` with the usual
`model-family:` and `implementer-family:` lines, an `Outside reviewer:` line naming who reviewed it and that it was done
outside the harness, and one `Verdict:` line; a `review.recorded` event is logged and the file is committed (`--no-commit`
to leave it for you). It counts for the done check's "Approved by a reviewer from another model family" like any review.

**DeepSeek or another OpenAI-compatible reviewer.** The harness has no DeepSeek provider of its own (the router's providers
are in harness/models.config.mjs: Gemini, NVIDIA NIM, xAI, Anthropic, Groq, OpenRouter, local Ollama), so there is no pool to
turn on. To add one: add an entry to `PROVIDERS` in harness/models.config.mjs (protocol openai-compatible: `baseUrl`,
`model`, `envKeys: ['<YOUR_KEY_NAME>']`) and put its id in the `reviewer` chain, or run the review on the provider's own
site and record it with the command above. Both leave the family check in place.

