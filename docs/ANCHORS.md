# Anchors and said-vs-did (`docs/ANCHORS.md`)

Two checks that keep a task's "done" tied to evidence the harness can read, not to what a builder wrote (2.81).

Anchors record what an outside game DOES (its behaviour, numbers and pacing) as a yardstick for our own design. They
never hold its code, art, text or names for use in the game.

## The anchor spec (`studio/references/anchors.json`, `harness/anchors.mjs`)

An anchor is one concrete feature of a reference game that the studio cross-checks its own feature against, for
direction: the behaviours seen, the numbers seen in the reference, the screens, where that evidence comes from, and the
acceptance lines our deliverable must show in its own terms. The harness never names a game (its examples use an
invented one); the owner or the Director fills the file for their game.

```
node harness/anchors.mjs add --game "<reference game>" --feature "<what to match>" \
  [--behaviour "…"]… [--number name=value]… [--screen "…"]… --acceptance "…"… \
  [--evidence <file or url> --kind video|screenshot|manual|wiki|owner --provenance "<who saw it, when>" --status verified|unknown|needs-reference]
node harness/anchors.mjs list | show A1 | validate | check <T-ID>
npm run task -- add "<title>" --anchors A1,A2        # cite anchors (an unknown id is refused)
```

- The brief (`npm run focus`) prints each cited anchor under "Anchors this task must match": behaviours, numbers,
  acceptance lines, evidence status, and how to prove it (name the anchor id in a test, a regression record, a proof
  record or a committed file for the task).
- `task done` and `node harness/done-check.mjs <ID>` record one verdict per anchor from the deliverable only:
  `met` (verified evidence and something the task committed, a regression or a proof record names the id), `unmet`
  (verified evidence, nothing names it), `unknown` (evidence `unknown` or `needs-reference`: the proof may exist, but
  nobody checked the reference). `unknown` is a warning and never green; `unmet` is a warning unless
  `STUDIO_ANCHORS=fail`. The verdicts land in the `task.done` event's `meta.anchors`.
- A builder task added without `--anchors` in a studio that has anchors gets a note, never a refusal.

Limits: the match is "the deliverable names the anchor id in a readable record", not a judgment of design quality;
it catches a task that never addressed the anchor and an anchor nobody verified, not a wrong implementation.

## Said-vs-did at task done (`harness/said-vs-did.mjs`)

```
npm run task -- done <ID> --agent <you> --claim "npm run verify => 14/14 passed" --claim "node qa/selftest.mjs --only anchors => PASS" --note "changed cartridges/x/sim.mjs"
node harness/said-vs-did.mjs <ID> --claim "…" --note "…"      # the same judgment, nothing closed
```

- `--claim` is optional: a done with no claim is judged exactly as before (this section adds nothing to it).
- Each `--claim "<command> => <last line>"` is re-run from an allowlist of read-only checks (`npm run verify`, `npm run
  golden`, `npm run check:purity`, `npm run playtest`, `node qa/selftest*.mjs`, `node qa/check-golden.mjs`,
  `node qa/check-regressions.mjs`, `node qa/vertical-slice.mjs`, `node harness/done-check.mjs`,
  `node harness/anchors.mjs list|show|validate|check`, `node scripts/check-docs.mjs`, `check-sim-purity`,
  `check-function-size`) and the claimed line must appear in the last lines it prints. A command outside the allowlist,
  or one that would write (`--update`, `--write`, `--fix`, `--prune…`, `--init…`), is reported as unverifiable, never
  as green. `STUDIO_CLAIM_TIMEOUT_S` (900) bounds a re-run; `STUDIO_CLAIMS=off` skips the re-run (claims then count
  for nothing).
- With a claim, the file paths the `--note` names must be in the task's diff (commits tagged `Studio-Task: <ID>`, the
  lane's commits, uncommitted edits).
- A mismatch emits `review.verdict` `{verdict: 'claim-mismatch', mismatches, results}` and `task done` refuses with the
  label `claim`. `task done --check` and the merge train's lane check diff the file claims but do not re-run commands
  (the train's own verify follows).

Limits: it checks commands and files, not design; a builder that makes no claim is not caught by this check (the
done-check's own evidence rows still apply).
