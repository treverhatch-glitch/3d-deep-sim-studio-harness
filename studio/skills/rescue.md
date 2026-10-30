# Rescue a stuck task (`Rescue: T-…`)

A task used its whole budget (sessions, claimed time or tokens) without finishing. You are a different
model from the ones that got stuck. Your job is to find out **why**, then pick one way forward. You have a
small budget of your own; spend it on understanding, not on repeating the same attempt.

## Read (in this order, briefly)

1. `npm run task -- show <T-ID>` and `node harness/task-budget.mjs <T-ID>`: what it is and what it spent.
2. `studio/handoffs/<T-ID>.md`: every hand-back note, newest first.
3. The refusals: `grep '"task":"<T-ID>"' .studio/events.jsonl | grep not_done | tail -20`.
4. What changed: in its lane, `git log --oneline <main>..` and `git diff --stat <main>...`.

If your title says **"split it into small pieces"** you are step 2: an earlier rescue (on another model)
already tried. Read its report in `studio/rescues/<T-ID>.md` first; your decision must be **split** or
**needs-person**, not retry. If you can't split it either, it is shelved and the studio carries on without it.

## Decide (one)

- **retry**: you found and cleared the blocker. Examples: the brief was ambiguous and you wrote the exact
  steps into `studio/handoffs/<T-ID>.md`; an environment problem (a missing tool, a cache file, a wrong
  path) is fixed; the work is already done and only needs `task done`. The stuck task is unparked when your
  rescue is done and its budget starts again.
- **split**: the task is too big for one builder session. Queue 2–4 smaller tasks, each naming the stuck
  task in its title (`npm run task -- add "T-123 part 1: …" --role builder`), each small enough to finish
  in one session, each with how to check it. The stuck task stays parked until they land.
- **needs-person**: only a person can decide. Examples: a protected file has to change (scenario
  expectations, regressions, the controls list, gates), the task needs a forced done, it's a design call
  the Game Bible doesn't settle, or it needs money, an account or a key. Say exactly what the person must
  decide.

## Write `studio/rescues/<T-ID>.md`

```
# Rescue of T-123

Diagnosis: <40+ words: what kept failing, the evidence (refusal reasons, notes, diff), and the cause>

Decision: retry | split | needs-person

<for retry: what you cleared; for split: the new task ids; for needs-person: the one question to answer>
```

Then `npm run task -- done <your rescue's ID> --agent <you>`.

## Never

- Never edit protected files, sign approvals, force a done, or raise budget limits. Those are the owner's.
- Never just retry the same approach with a different model. If you can't name the cause, the decision is
  needs-person.
