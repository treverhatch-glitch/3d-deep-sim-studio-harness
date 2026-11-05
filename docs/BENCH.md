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

If your own shell already switches one of these off (say `STUDIO_HOOKS_CHECK=off` in your environment), the run
says so and records it as `offInEnv`. The compare warns when two runs differ that way, because a "baseline" with a
switch already off is not a baseline.

`--without <component>` sets that one off-switch in the measured agent's environment. It never changes the studio's
config, and the run records which switch it set. Compare that run against a baseline run with the same harness, and
the compare adds a component line:

- **still pays for itself**: the bench did worse without it.
- **no measurable difference**: it may no longer pay for itself. The line also says if the run used fewer tokens.
- **the bench did better without it**.

In every case the owner decides whether to retire the guardrail; the bench changes nothing.

## A held-out split, and the acceptance rule for harness changes (2.78.0, PU-59)

Research on evolved harnesses found that about half of the gains came from overfitting to the cases the harness was
tuned on, and some more from just spending more compute. So a harness change is judged on two groups of cases, and on
its cost.

- `npm run bench -- split --by <person> [--held-out-share 0.3]` writes `studio/bench/split.json`:
  `{ "heldIn": [ids], "heldOut": [ids], "seed": n }`. It is seeded and stable: a case that is already in the file keeps
  its side, and new cases are ranked by the seed (a hash of seed and id) until the held-out share is filled. Cases
  that no longer exist drop out. `studio/bench/` is protected, so the command only writes the file and says it needs the
  owner's signed approval, like any bench case.
- `npm run bench -- run --split heldIn|heldOut` runs one split (a case not yet in the file is refused). The run records
  which split it was.
- Proposers (`retro`, `learn`, `experiment`) read failures from held-in cases only. None of them reads bench results
  today (checked in 2.78.0), so nothing is filtered; if one ever does, it must read `readSplit().heldIn` and say so in a
  comment.
- `npm run bench -- compare <runA> <runB>` prints, when a split file exists, a block per split after the usual
  comparison: the change in pass@1, pass^k and tokens per pass (tokens of all tries over the passing tries), then a
  verdict. A is the harness before the change, B after. Only cases present in both runs (and unchanged) count.
  - **accept**: neither split drops by more than the noise floor, at least one improves by more than it, and tokens per
    pass rise at most the cost limit.
  - **compute-bought**: it improves, no split drops, but tokens per pass rose more than the limit.
  - **reject**: anything else, including a split that was not measured, a drop in either split, or no improvement
    beyond noise (the change is "within noise").
  `--json` adds the same numbers under `split`.
- `--change C-3` attaches the verdict to that change record (`studio/changes/C-3.json`, `bench: { verdict, why, runs,
  splits }`; see `npm run learn -- change list`). It adds that one field: the change record's own status, verdict and
  evaluation from the event log are not touched.

Settings: `STUDIO_BENCH_NOISE` (default 0.05) is the noise floor on pass@1 and pass^k; `STUDIO_BENCH_COST_MAX`
(default 0.15) is the largest rise in tokens per pass that still counts as accept.

## Not yet

- The runs haven't been tried on Windows. Killing the process tree there uses `taskkill /T /F`.
- A real-agent run was only rehearsed with a custom tool command, not with a paid model.
- The bench doesn't pick the cases. The owner and the crew choose the 20-30 tasks, and the owner sets a token budget
  for bench runs.

## Mutation score per gate (`node qa/mutants.mjs`)

A green gate may guard nothing. `qa/mutants.mjs` measures how much each required cartridge gate catches. On a scratch
copy of the repo (never a lane, never main's files) it plants one small bug at a time in the sim cartridge
(`cartridges/<name>/`, the active one, default `example-sim`; `qa.mjs` is left alone), runs the cartridge gates on it
(`run-gates --only`), and records which gates failed. A gate that fails on a bug has *killed* it.

```
node qa/mutants.mjs [--cartridge <name>] [--max N] [--seed N] [--gates a,b] [--out file]
node qa/mutants.mjs --compare <older report> [<newer report>]
```

- **Bugs planted** (plain text edits, seeded, deterministic): flip a comparison (`<` and `>=`), off-by-one in a `for`
  bound, drop one call statement from the tick function, swap two adjacent statements in the tick, freeze an rng
  result to a constant, leave one field out of save/serialise (when the cartridge has one), ignore one action type,
  swap two ids or adjacent constants. The operators are dealt in turn so none crowds out the rest.
- **Discarded, not counted**: a mutant that does not parse (`node --check`), and one that changes nothing (the same
  digest of the scenarios, the goldens and a fixed fuzz replay as the original).
- **Output**: `qa/reports/mutants-<date>.json` and a text summary: each gate's kill rate (killed / mutants it ran on),
  the mutants no gate killed (file:line and operator), and the run time. A gate that is red on the unmutated
  cartridge is left out and named. `browser-play` is not in the default set (it needs a browser); name it with `--gates`.
- **Reading survivors**: a survivor is a spot where the sim can be wrong and every gate stays green, so it is the
  code no check guards. Either a gate is missing a case (add a scenario, a golden or a regression replay) or the
  line is dead. Check by hand that the mutant really changes what a player sees before adding a test for it.
  Surviving `ignore-action` mutants mean no golden or scenario sends that action.
- **Report only, for now**: it never fails a run and is not a required gate (always exit 0). The sample is small and
  seeded, so one run's rates are noisy; the plan is to watch it for two weeks, then let a gate's kill rate not drop
  (like `harness/ratchet.mjs`). `--compare` already prints each gate's rate change, flagging drops; compare runs with
  the same cartridge, seed and `--max`. It is not wired as a gate.

Settings: `STUDIO_MUTANTS_MAX` (mutants to run, default 40), `STUDIO_MUTANTS_SEED` (order, default 278),
`STUDIO_MUTANTS_GATES` (gate ids to run; default the required cartridge gates except `browser-play`),
`STUDIO_MUTANTS_BUDGET_MIN` (stop starting new mutants after this many minutes, default 20).
