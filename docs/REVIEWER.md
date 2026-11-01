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
