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

**A review the harness asks for (2.84 w).** A tool whose sessions cannot run commands (vertex, aider, nim: aider only suggests
them; `TOOL_CAPABILITIES` in `harness/model-tool.mjs`) cannot be a reviewer session. The harness asks the model itself, with no session:

    npm run review -- ask <ID> --model <id> [--tool <tool>] [--for <review task>] [--no-commit]

It sends ONE request with what a reviewer session reads: the task's title, spec and contract, the done-check's summary
(`node harness/done-check.mjs <ID>`), and the diff of the task's lane against its base (an engine task: its engine branch against
the engine target; else its tagged commits), cut at `STUDIO_REVIEW_DIFF_KB` (200) with a note saying so. Vertex goes straight to
its endpoint with the key from the main checkout's `.env` as `x-goog-api-key` (never printed, logged or put in an event); claude,
codex and agy run their CLI read-only with the prompt on stdin. The tool is the model's (`toolForModel`) unless `--tool` names it;
a mismatch is refused. The answer must start with `VERDICT: APPROVE` or `VERDICT: CHANGES`. 2.85: the prompt asks for
the verdict line first (`VERDICT: approve|changes|unsure`), the call asks for up to `STUDIO_REVIEW_MAX_TOKENS` (4000) output
tokens, an answer with findings but no verdict line gets one verdict-only follow-up request before it becomes a draft, and an
`unsure` verdict is kept as a draft (nothing recorded). It is recorded as `review record`
does: `studio/reviews/<date>-<ID>-asked-<model>.md` with the `model-family:` and `implementer-family:` lines, a `via:
harness-asked` line, one `Verdict:` line, a `review.recorded` event (meta `via`, `model`, `tool`), the same family rules, and a
commit. An answer with no verdict is saved as `<date>-<ID>-asked-<model>.rejected.txt` and nothing is recorded. A network,
quota or tool failure exits 1 with one line and a `review.ask_failed` event, and records nothing. The launcher runs it,
detached, for a reviewer task whose planned model runs on such a tool (`review.ask_started`); it is not asked again while one is
in flight or once one is recorded for that review task. With `--for`, the same process then closes that review task (2.84 r: it starts it as "review-ask" before recording and runs `task done` after, the path a reviewer session uses, which runs no game checks for a reviewer's task); a refused close never fails the review, it emits one `review.ask_close_failed` event naming the task and `npm run task -- done <review task> --agent <you>`, and the launcher then keeps saying that task only needs closing. Who may run it: as for `review record`
(never a worker session). Who must review, and what the done check needs, are unchanged.

**A studio with only one model family (2.83, 2.84).** A review from the implementer's own family is taken only when its
header says `same-family: no other family available` AND no other family is configured. Which families are configured is
decided from the studio's own files in the MAIN checkout (found by git, never from `STUDIO_MAIN_ROOT`): the model and tool
settings in its `.env` (`STUDIO_*_MODEL`, `STUDIO_*_MODELS`, `STUDIO_REVIEW_TOOLS`, `STUDIO_REVIEWER_TOOL`; nothing else
in that file is read) and the model names in its `studio/models.json`, together with the session's environment. The
result is the union: the environment can add a family, never remove one, so a session that unsets or overrides those
variables changes nothing. The launch of a review and both checks (`review record` and the done check) use the same
union. A refused header says which family is configured and where it was found (`.env`, `studio/models.json` or
`environment`). The function is `configuredFamilies` in `harness/review-family.mjs`.

**The same-family switch (2.84 g).** Whether a same-family review counts is a studio switch in `studio/review.json` in the
main checkout: `{ "sameFamily": "auto" | "on" | "off", "by", "at", "why" }`. No file, an unreadable one, or any other value
is `auto`. `auto` is the rule above. `on`: a same-family review counts whether or not another family is configured; the
reviewer still writes a header (`same-family: allowed by the studio`, or the old `same-family: no other family
available`), so every such review is visible, and `review record` says it counted because the studio allows it and who set
that. At launch another family still comes first; `on` only lets a review run on a model of the implementer's family when
no other-family model is live (not out of quota). `off`: a same-family review never counts, header or not, even with one
family configured. Change it with `npm run review -- same-family on|off|auto --by <who> [--why "..."]` (with no value it
prints the setting, who set it and when, and the families configured). The owner, the overseer (the owner's proxy, a
beta-mode agent the owner named, or an outside signer) or an outside agent may run it. It loosens a check, so it is
judged as a protected decision: a Producer or Director session may only where the owner set
`STUDIO_PRODUCER_APPROVES=protected`, and a worker session never may, under any `--by`. Each change is one decisions-log line and
one `review.same_family` event. The file is not a protected file (the overseer flips it without a signature); no
environment variable turns it on, and the checks read the main checkout's copy. What `on` gives up: a model reviewing its
own family's work shares its blind spots, so a second family is the stronger check.

**DeepSeek or another OpenAI-compatible reviewer.** The harness has no DeepSeek provider of its own (the router's providers
are in harness/models.config.mjs: Gemini, NVIDIA NIM, xAI, Anthropic, Groq, OpenRouter, local Ollama), so there is no pool to
turn on. To add one: add an entry to `PROVIDERS` in harness/models.config.mjs (protocol openai-compatible: `baseUrl`,
`model`, `envKeys: ['<YOUR_KEY_NAME>']`) and put its id in the `reviewer` chain, or run the review on the provider's own
site and record it with the command above. Both leave the family check in place.


**The verdict line (2.78.2).** End the note with its own line `Verdict: approve` or `Verdict: changes requested`. The
done check reads the LAST `Verdict:` line in the file, so a re-review appended later decides and a "non-blocking note"
doesn't count against an approval. A note with no `Verdict:` line is read the old way (any "changes requested",
"reject" or "blocking" in it means no approval).
