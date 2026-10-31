# Forcing a task closed (the owner types it)

Sometimes a task's done-check refuses for a reason that doesn't apply to it: a check that can't run on this
machine, or a rule written for another kind of task. The right fixes, in order:

1. **Use the right task type.** From 2.58.0, build, toolchain, CI and dependency work is a `chore` task: title it
   `Chore: …`, `Build: …`, `Toolchain: …`, `CI: …` or `Deps: …`. It needs changes and a green `npm run verify`, but
   no regression test. Don't retitle a task to slip past a check.
2. **Fix or run the check** the done-check names (`node harness/done-check.mjs <ID>` says what is missing).
3. **Hand it back** with a note if it can't be finished now:
   `npm run task -- pause <ID> --agent <you> --note "what is missing and why"`.

When none of those fit, **the owner closes it by hand**. Agents don't: Claude Code's own safety rules stop an
agent from forcing a check, and that's intended. An agent asks the owner and gives the exact line to type. It
never edits settings or writes a script to get around the block.

## The command (typed by the owner, in a terminal, in the studio folder)

```bash
npm run task -- done <ID> --agent <the task's owner> --force --reason "<why, at least 10 characters>" --accepted-by <your name>
```

- `--agent` is the name that holds the task (only the owner of a claim can finish it).
- `--reason` is required. Say what was skipped and why it's acceptable.
- `--accepted-by` is a person's name. With both, the close is logged as accepted by that person (a `task.forced`
  event naming the missing check, the reason and who accepted it), it shows in the run report, and **no** follow-up
  task is opened.
- Without `--accepted-by`, the task is "done (pending)". The lane moves on, an approval card waits, and the Producer
  gets a P1 `Check forced done` task to run the skipped check.
- Uncommitted work at the moment of the force is saved as a patch, and the event names the file.

## What not to do

- Don't force a task an agent is still working on. Stop or pause it first.
- Don't use a forced close to get past a red security check (`secrets`, `protected`). Fix those.
- Don't paste keys or tokens into `--reason`.
