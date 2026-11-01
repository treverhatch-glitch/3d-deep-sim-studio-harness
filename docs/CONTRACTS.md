# Acceptance contracts (`docs/CONTRACTS.md`, 2.62.0)

A task's title is one line. A builder can turn every check green and still deliver less than was meant. An
acceptance contract writes down what done means for one task, as checks, before the work starts. After that the
builder can only flip `passes`. This follows Anthropic's long-running-harness pattern: a feature list where agents
only flip `passes`, plus "sprint contracts" agreed before coding. Contracts are optional: a task without one closes
exactly as before.

## The file

`studio/contracts/<ID>.json` is committed with the studio:

```json
{
  "task": "T-012",
  "criteria": [
    { "id": "C1", "text": "The door panel opens and closes", "check": { "kind": "command", "command": "npm test -- door" }, "passes": false },
    { "id": "C2", "text": "The door doc names the hotkey", "check": { "kind": "file", "path": "docs/DOORS.md", "contains": "hotkey" }, "passes": false },
    { "id": "C3", "text": "The panel copy reads well", "check": { "kind": "manual" }, "passes": false }
  ],
  "agreedBy": "hatch",
  "agreedAt": "2026-11-01T12:00:00.000Z"
}
```

## Commands

| Command | Who |
|---|---|
| `npm run task -- contract <ID> [show]` | anyone |
| `npm run task -- contract <ID> add "<text>" [--check "<command>" \| --file <path> [--contains "<text>"] \| --manual]` | anyone; a worker's criterion lands as `proposed` |
| `npm run task -- contract <ID> agree --by <name> [--permission "<the person's words or a link>"] [--why "…"]` | the agreeing roles (below) |
| `npm run task -- contract <ID> check` | anyone: runs every command and file check and sets `passes` |
| `npm run task -- contract <ID> sign <CID> pass\|fail --by <name> [--note "…"]` | a reviewer, a person, or the agreeing roles (manual criteria only) |
| `npm run task -- contract <ID> remove <CID> [--by <name> --why "…"]` | a proposal: anyone; a criterion in force: the agreeing roles, as an amendment |

`agree`, `remove` of a criterion in force, and `add` on an agreed contract commit that one file unless you pass
`--no-commit`. `check` and `sign` leave the file for you to commit with your work.

## Who agrees

- **Agreeing roles**: a Producer or Director session, a person in their own terminal (the owner), or an agent
  outside the harness that names the person and where they said so (`--by <person> --permission "…"`, as in
  2.59.1's `harness/permission.mjs`).
- **Workers** (builders, reviewers, and the rest) never agree a contract, their own task's least of all. A worker
  may propose a criterion. It waits, not in force, until the Producer agrees the contract again
  (`agree --why "accept the builder's criterion"`). Agreeing again, or removing a criterion in force, is an
  **amendment**. It is recorded in `amendments` with who did it and why.

Plan contracts when you plan the task: `task add`, then `contract <ID> add …` and `agree`, committed on the studio's
branch before the lane starts. A builder who finds a gap at task start proposes a criterion and asks.

## What enforces it

- **The weakened-tests gate** (`harness/test-weakening.mjs`, at verify and at every `task done`) judges the diff of
  `studio/contracts/*.json` since the base. On an agreed contract only `passes` may change, plus a manual criterion's
  signature. Any other change is a finding, enforced with or without an owner key:
  - `contract-criterion-changed`: an agreed criterion's text or check was edited.
  - `contract-criterion-removed` or `contract-deleted`: a criterion or the whole contract was taken out.
  - `contract-agreed-by-worker`: an agreement or amendment was set by a worker's commit.
  - `contract-criterion-added-by-worker`: a criterion was put in force by a worker's commit.
  - `contract-manual-unsigned`: a manual criterion was passed without a reviewer's or a person's signature.

  "Who" is read from the commit's `Studio-Agent` trailer, which the commit-msg hook writes for agents. The fix is to
  put the contract back. The owner can approve an intended change by content (`npm run approve -- tests`).
  `STUDIO_WEAKENED_TESTS=off` turns the whole gate off, and `task done` records that it was off.
- **done-check** (`node harness/done-check.mjs <ID>`, `task done`) needs every criterion in force to pass, and lists
  the ones that don't:
  - **Command criteria** count only from a `contract check` run on the work as it is now. The check records evidence
    in `.studio/contracts/<ID>.json`, keyed to the working tree with `studio/contracts/` left out. A `passes: true`
    typed by hand counts for nothing, and a check from before a later change asks for a new one.
  - **File criteria** are read on the spot.
  - **Manual criteria** need a signature from someone who isn't a builder.

  Proposals waiting for agreement are listed as a note.
- **The reviewer** (`npm run review -- <ID>`) gets the contract in its brief and adds one met/not met line per
  criterion. A criterion that isn't met means CHANGES.
- **Required contracts**: `studio/game.json` `"contracts": { "required": ["change", "bug"] }` makes an agreed
  contract mandatory for those task types. `studio/game.json` is protected, so only the owner changes it.

`STUDIO_CONTRACT_TIMEOUT_S` (default 600) caps each command check.

## Limits

- A commit with no `Studio-Agent` trailer counts as a person's. An agent shell without `STUDIO_LOCK_OWNER` writes
  none.
- Until the studio has an owner key, nothing an agent writes is proof. This is a speed bump that makes redefining
  done visible and refusable, not a lock.
- Command checks run through the system shell (cmd.exe on Windows). Keep them free of shell-specific quoting.
