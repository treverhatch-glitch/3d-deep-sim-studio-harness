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

**A studio with only one model family (2.83, 2.84).** A review from the implementer's own family is taken only when its
header says `same-family: no other family available` AND no other family is configured. Which families are configured is
decided from the studio's own files in the MAIN checkout (found by git, never from `STUDIO_MAIN_ROOT`): the model and tool
settings in its `.env` (`STUDIO_*_MODEL`, `STUDIO_*_MODELS`, `STUDIO_REVIEW_TOOLS`, `STUDIO_REVIEWER_TOOL`; nothing else
in that file is read) and the model names in its `studio/models.json`, together with the session's environment. The
result is the union: the environment can add a family, never remove one, so a session that unsets or overrides those
variables changes nothing. The launch of a review and both checks (`review record` and the done check) use the same
union. A refused header says which family is configured and where it was found (`.env`, `studio/models.json` or
`environment`). The function is `configuredFamilies` in `harness/review-family.mjs`.

**DeepSeek or another OpenAI-compatible reviewer.** The harness has no DeepSeek provider of its own (the router's providers
are in harness/models.config.mjs: Gemini, NVIDIA NIM, xAI, Anthropic, Groq, OpenRouter, local Ollama), so there is no pool to
turn on. To add one: add an entry to `PROVIDERS` in harness/models.config.mjs (protocol openai-compatible: `baseUrl`,
`model`, `envKeys: ['<YOUR_KEY_NAME>']`) and put its id in the `reviewer` chain, or run the review on the provider's own
site and record it with the command above. Both leave the family check in place.


**The verdict line (2.78.2).** End the note with its own line `Verdict: approve` or `Verdict: changes requested`. The
done check reads the LAST `Verdict:` line in the file, so a re-review appended later decides and a "non-blocking note"
doesn't count against an approval. A note with no `Verdict:` line is read the old way (any "changes requested",
"reject" or "blocking" in it means no approval).
