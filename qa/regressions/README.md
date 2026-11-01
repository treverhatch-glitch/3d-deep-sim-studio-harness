# Regressions

Each real bug should become a permanent file here:

`qa/regressions/<bug-id>.json`

```json
{
  "id": "BUG-0001",
  "seed": 1337,
  "tick": 50,
  "actions": [],
  "description": "what broke",
  "fixed": true
}
```

CI can replay these with `node qa/check-regressions.mjs`.

## A seeded game unit test (`"kind": "test"`, 2.59.0)

When no cartridge replays the part of the game the bug is in, the regression can be one of the game's own unit
tests, run with a seed:

```json
{
  "id": "BUG-0002",
  "kind": "test",
  "test": { "file": "game/<game>/src/fees.test.ts", "name": "landing fee rounds per seat" },
  "seed": 1337,
  "description": "what broke",
  "fixed": true
}
```

- The command is the studio's, never the regression file's: `"regressionTest"` in `studio/game.json`, else in the
  game's `studio.gates.json` (both protected, so only the owner changes it):
  `"regressionTest": { "command": "node node_modules/vitest/vitest.mjs run {file} -t {name} --reporter=junit --outputFile={junit}", "cwd": "game/<game>" }`.
  `{file}` (relative to `cwd`), `{name}`, `{seed}` and `{junit}` are filled in; the seed is also in `STUDIO_TEST_SEED`,
  which the test reads. Each word is passed as is, with no shell (on Windows a non-`node` command goes through one);
  start the command with `node` where you can.
- `{junit}` is required: the runner writes a JUnit XML result there (vitest `--reporter=junit --outputFile={junit}`,
  `node --test --test-reporter=junit --test-reporter-destination={junit}`, pytest `--junitxml={junit}`). That is how
  the harness tells "the test ran and failed" from "it never ran".
- `node qa/fails-before.mjs <file> <fix>^` proves it: the test must pass on the current checkout, and fail on the
  commit before the fix (today's test file, run against the old code, with this checkout's `node_modules`). No JUnit
  result, the named test missing from it (the file didn't load there: it imports something only the fix adds, a
  dependency is missing), a skipped test or a timeout is an error, never a pass.
- `node qa/check-regressions.mjs` runs it with the same command; it must pass.

A new file here needs no approval; editing or deleting one does (`studio/protected.json` `addOnly`).
