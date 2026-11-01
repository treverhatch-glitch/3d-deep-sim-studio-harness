# The replay bench (`npm run bench`)

For people (the owner, or an outside agent on their permission). Crew sessions don't run it.

Selftests prove the harness's plumbing works. They don't show whether agents do better with a harness change, or
whether a guardrail still earns its cost with today's models. The bench measures that. It takes 20-30 past tasks,
each pinned to the commit it started from, and runs each one k times with real agents in clean copies. Code grades
every try. Each run gets two scores:

- **pass@1**: the mean success rate over the cases.
- **pass^k**: the share of cases where all k tries succeeded. This is the score for "does it work every time".

Compare a run before a harness change with a run after it, case by case. Or switch one guardrail off (`--without`)
and compare that run with a baseline. The agent being measured never grades itself. The graders are code the owner
wrote, kept in a protected folder that the bench copies never contain.

## Cases

A case is `studio/bench/cases/<id>.json`:

```json
{
  "id": "t-067",
  "from": { "task": "T-067", "title": "…", "solution": "<the task's last commit>" },
  "commit": "<the commit the task started from>",
  "brief": "the task's brief, as the agent gets it",
  "grader": {
    "pass": ["npm test -- spawn-rate"],
    "fail": [],
    "mustChange": ["cartridges/my-sim/**"],
    "mustNotChange": ["qa/golden/**"],
    "model": { "command": "…", "note": "optional extra, advisory only" }
  },
  "tokenCap": 2000000,
  "timeoutMin": 60
}
```

- `pass`: commands that must exit 0. `fail`: commands that must not exit 0.
- `mustChange`: for each glob, at least one changed file must match it.
- `mustNotChange`: no changed file may match these globs. The studio's protected files are always added to this
  list, unless the grader sets `allowProtected: true`.
- `studio/bench/cases/<id>/files/` holds **hidden files**, normally the task's own tests taken from its solution.
  They are copied into the copy only after the agent has finished, and then the commands run.
- `model` is an optional model grader. It is advisory only: it runs only with `--model-grader`, its output is
  recorded next to the result, and it never decides pass or fail.

Add a case from a past task (a person runs this):

```
npm run bench -- add --from T-067 --by hatch --hidden <the task's test file> --pass "<the command that runs it>"
```

The command finds the task's commits (by the `Studio-Task:` trailer or the id in the subject) and starts the case
from the parent of the first one. If no commit is found, give the start with `--commit <sha>`. The brief comes from
`--brief-file`, else `.studio/briefs/<ID>.md`, else the task's title. `--hidden` copies those files from the task's
last commit. If the case has no code grader, `add` refuses it and lists the tests the task changed, as a hint.
`npm run bench -- list` shows every case and whether it can be used.

`studio/bench/bench.json` holds optional settings: `{ "parallel": 1, "k": 3 }`.

## Protected, and how sealed it is

`studio/bench/**` is in the protected list the harness ships, in two places: `studio/protected.json` and the
defaults in `harness/approve.mjs`. A new or changed case lands only with the owner's signed approval
(`npm run approve -- protected --note "bench case …"`). A studio that has its own `studio/protected.json` gets this
line when it merges the harness upgrade. That merge changes a protected file, so the owner signs it, as with any
protected change.

What keeps the cases from the agents being measured:

- A bench copy never contains `studio/bench/`, and its git history doesn't either. Each copy is a new repo with a
  single parentless start commit, so no later commit that solved the task can be found in it.
- The hidden grader files only arrive after the agent has finished.
- The task's brief, its board line and its hand-off note never mention the bench. The kickoff, the brief writer and
  the repo map never read `studio/bench/`.
- The bench command refuses to run inside a bench copy, and the measured agent's environment doesn't carry the
  bench's own settings.

The limits, honestly: every session in the studio itself can read `studio/bench/` with a shell, because lane copies
link the studio's `studio/` folder. The results in `.studio/bench/` are readable too. For a fully sealed bench, keep
the cases outside the studio with `STUDIO_BENCH_DIR=<folder on the owner's side>`, and run the bench from the owner's
shell. An agent in a bench copy could still read files elsewhere on the machine if it knows their path.

## Running it

```
npm run bench -- run --by hatch [--cases a,b] [--k 3] [--harness <ref>] [--label x] [--without <component>] [--parallel N] [--keep] [--yes]
```

- **Who may run it.** A run costs tokens, so it refuses without `--by <person>`. It follows the rules in
  `harness/permission.mjs`: a person can run it with `--by`. A Producer or Director session, or an agent outside
  the harness, can run it with `--by <the person> --permission "<their words or a link>"`. A worker session never
  can.
- **The ceiling first.** A run first prints the token ceiling (cases × k × tokenCap) and starts nothing until you
  add `--yes`.
- **Each try gets a clean copy.** The copy is a fresh git repo at the case's commit. The harness files of
  `--harness <ref>` (default: this checkout's `HEAD`) are laid over it: `harness/`, `scripts/`, `hub/`, `tools/`,
  `skills/`, `qa/*.mjs`, `AGENTS*.md`, `studio/roles|rules|skills/`. That way a before/after compares harnesses on
  the same game code. The task goes on the copy's board with the brief as its hand-off note. `node_modules` is
  linked, and `.env` is copied for the studio's tool and model settings.
- **The agent starts the normal way.** The bench runs
  `node harness/agent.mjs start --role builder --task <ID> --one-task` in the copy, so it uses the studio's
  configured tool and model. Tests set `STUDIO_BENCH_AGENT_CMD` instead (a custom command with `{case} {try} {task}
  {copy}` filled in).
- **Caps.** The case's `tokenCap` becomes the copy's task budget (`STUDIO_TASK_MAX_TOKENS`) and its daily cap. Its
  `timeoutMin` becomes `STUDIO_TASK_MAX_MIN` and a hard stop for the whole session, which kills the process tree. A
  try that goes over its cap or its time fails. Tokens are counted when a session reports them, at its end, so one
  session can go past its cap before it is stopped. A session killed at its timeout may report nothing; its try
  then shows `tokensUnknown`.
- **Grading.** The bench lists the files changed since the start (committed, uncommitted and new), checks
  `mustNotChange` and `mustChange`, copies in the hidden files, then runs `pass` and `fail`.
- **Results** go to `.studio/bench/<run-id>/results.json`, with each try's log in `logs/`. Each try records
  pass/fail and why, tokens, turns and minutes. The copies are removed afterwards unless you pass `--keep`.
- **Load.** A run holds machine:heavy (`harness/heavy.mjs`) for its whole length, like a full verify, so other heavy
  work waits. Run it when the crew is idle. At most `bench.json`'s `parallel` tries run at once (default 1).
  `--parallel` can lower that number but never raise it.

`npm run bench -- show <run>` prints a run's scores again.

## Comparing two runs

```
npm run bench -- compare <runA> <runB>
```

The comparison pairs the cases the two runs share. A case whose content changed between the runs is left out, and
the output says so. For each pair it compares the success rates. Then it prints:

- pass@1 and pass^k for both runs, and the change in tokens, turns and minutes per try;
- a two-sided exact sign test, with its p-value;
- a verdict: **better**, **no difference** or **worse**.

The sign test needs at least 6 paired cases to show anything at p < 0.05. With fewer, the compare says "not enough
cases". Everything here is plain arithmetic, with no model call.

## The component-removal review (`--without`)

`npm run bench -- components` lists the guardrails that `--without` can switch off. The list only includes switches
the harness already has, each named with the file that reads it, and the bench checks that the switch is still
there before it uses it:

weakened-tests, hooks-check, breaker, stall, session-refresh, auto-finish, loop-handbacks, visual-gate,
silent-green, lane-copies, merge-train.

The task budget is not on the list, because the bench uses it to enforce its own caps.

`--without <component>` sets that one off-switch in the measured agent's environment. It never changes the studio's
config, and the run records which switch it set. Compare that run against a baseline run with the same harness, and
the compare adds a component line:

- **still pays for itself**: the bench did worse without it.
- **no measurable difference**: it may no longer pay for itself. The line also says if the run used fewer tokens.
- **the bench did better without it**.

In every case the owner decides whether to retire the guardrail; the bench changes nothing.

## Not yet

- The runs haven't been tried on Windows. Killing the process tree there uses `taskkill /T /F`.
- A real-agent run was only rehearsed with a custom tool command, not with a paid model.
- The bench doesn't pick the cases. The owner and the crew choose the 20-30 tasks, and the owner sets a token budget
  for bench runs.
