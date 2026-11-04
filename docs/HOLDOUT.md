# Held-out checks (`harness/holdout.mjs`, 2.78.0, PU-54)

Builders can read every visible check, so a builder can tune its work to them (print the expected value for the golden
seed and nothing else). Research on coding agents (ImpossibleBench) found that read-only tests cut cheating far less than
tests the agent cannot see at all. A held-out case is a check whose command and expected result no builder has seen.

## Where the cases live

Outside the repo, so no lane copy reaches them. In a lane copy (`.lanes/<agent>`) `studio/` is a link to the main
checkout's `studio/`, so anything under `studio/` is readable from a lane. The folder is `STUDIO_HOLDOUT_DIR`; by default
`<main checkout's parent>/<main checkout's folder name>-holdout`. The main checkout is `STUDIO_MAIN_ROOT`, or the folder above `.lanes/`.

Each case is a JSON file:

```json
{ "id": "seed-7-final-hash", "command": "node qa/check-golden.mjs", "cwd": ".", "expect": { "exit": 0, "stdoutSha256": "…", "contains": ["…"] }, "note": "the economy does not depend on the golden seed" }
```

The command runs in the train's checkout of the merged tree; `cwd` is relative to the studio root. stdout is compared after CRLF to LF.

## Making and listing cases (owner or Producer)

```
node harness/holdout.mjs add <id> --command "…" --expect-exit 0 [--expect-stdout-of-current] [--contains "…"] [--note "…"]
node harness/holdout.mjs list        # ids and notes only
```

`--expect-stdout-of-current` runs the command once on the main checkout now and records the stdout's sha256. A builder or
lane session cannot `add`.

## The `holdout` gate

`holdout` is a required gate in `studio/gates.json` (`"trainOnly": true`), command `node harness/holdout.mjs run`.
It runs its cases only when `STUDIO_GATE_PRIORITY=landing`, which the merge train sets on its verify. In a lane's own verify it prints
"skipped: runs at the train only" and passes. With no folder or no cases it passes ("no held-out cases"). A failure prints
only the case id and its note, never the command or the expected values, because the builder reads the train's output in its hand-back.

## Who can read it

The path guard hook (`.claude/hooks/guard-paths.mjs`) denies Read, Grep, Glob and Bash commands that name the folder (or `$STUDIO_HOLDOUT_DIR`)
for sessions in a lane copy or with `STUDIO_ROLE=builder`. The reviewer, Producer, Director and owner (`STUDIO_ROLE=reviewer|producer|director|owner`) and the train can read it.

**Caveat.** A path deny on Bash is weak: `python -c`, `node -e` or a script can read any file the user can. The real protection is
that the folder lies outside every lane's files and outside the repo. Keep the folder out of anything a lane syncs or mounts, and
do not point `STUDIO_HOLDOUT_DIR` inside the checkout.

## Settings

- `STUDIO_HOLDOUT_DIR`: the folder of cases; default `<main checkout's parent>/<main checkout's folder name>-holdout`.
- `STUDIO_HOLDOUT_TIMEOUT_MS`: how long one case may run; default `300000`.
