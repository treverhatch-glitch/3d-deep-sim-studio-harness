# Closed Loop

`node harness/closed-loop.mjs` does **not** auto-fix code.

It:
1. Runs the playtest
2. On failure, writes the real seed/tick/actions to `.studio/last-seed-failure.json`
3. Opens a bug report
4. After `MAX_FIX_ATTEMPTS` (default 3), escalates to a stronger model or a human

Auto-fix is intentionally out of scope. A wrong automatic edit is worse than a recorded failure.

## The learning edge (2.61.0)

The loop above fixes this run. The learning edge checks whether what the studio changed afterwards helped. All of it
is plain code in `harness/changes.mjs` and `harness/learn.mjs`: no model grades anything, and nothing is reverted or
promoted to a gate by itself.

**Change records.** Every change to the harness, a skill (`studio/skills/`), a pitfall (`studio/PITFALLS.md`) or a
rule gets a record in `studio/changes/C-<n>.json` (commit it with the change):

```bash
npm run learn -- change add --kind skill --target studio/skills/builder.md --signature sig-3fa9c2d1 \
  --expect "fewer verify-after-change refusals on change tasks" --risk "a longer skill" --revert "git revert --no-edit <sha>"
npm run learn -- change list
npm run learn -- change eval
```

`--signature` is a failure signature: the `sig-…` id `npm run learn` prints under "Keeps happening", or
`"<event type>: <message>"` (grouped the same way), or a bare message. After `STUDIO_CHANGE_EVAL_TASKS` finished tasks
(default 20) or `STUDIO_CHANGE_EVAL_DAYS` days (default 7), `npm run learn` (and the HUB's daily pass) compares how often
tasks of each type hit those signatures before and after the change. A type counts only with `STUDIO_CHANGE_MIN_SAMPLE`
finished tasks on each side (default 5); otherwise the record says "not enough data" and keeps watching. A rise of
`STUDIO_CHANGE_MARGIN` (default 0.1) in any counted type is **regressed**, an equal drop in one is **kept**, anything else
**no effect**. A regressed change files one question for the owner (`npm run ask -- list`): revert or keep, with the
record's revert command. It has no deadline and runs nothing; a person decides and reverts. The verdicts show in
`studio/memory/LEARNED.md` and in `npm run notes -- export`, the notes that go back to the harness maintainer.

**Lesson → check ladder.** When a failure signature keeps happening after a lesson for it exists in
`studio/memory/failures.md` (a dated lesson: on a later day), `npm run learn` queues one builder task, once per
signature (`studio/changes/ladder.json`): "Make the lesson a check: <signature>". Its hand-off note asks for a test, lint
rule, done-check item or gate that fails on the old failure and passes on today's main (the fails-before proof). A new
gate, done-check rule or protected file still goes to the owner: the task asks, it never edits a gate itself.
