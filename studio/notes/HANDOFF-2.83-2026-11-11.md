# Handoff: round 2.83, flow (`studio/notes/HANDOFF-2.83-2026-11-11.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-11, after `HANDOFF-2.82-2026-11-10.md`. The owner's
order: the next harness upgrade, from the maintainer's plan, the overseer's notes and the crew's own numbers, with
unused code taken out; a grade before and a projected grade after.

## Where it stands

- Release notes: docs/RELEASE-2.83.0.md. The engine train's new rules: docs/NATIVE-ENGINE.md ("The engine train from
  2.83"). Problems P-301 to P-313 in studio/logs/PROBLEMS.md.
- Ten new self-test units (`selftest-283a` to `283j`).
- Nothing on the crew's PC was changed by the harness work. It was read: the event log, the overseer's notes and
  local patches, the land records.

## Decisions made on judgment (change them if the next score says so)

1. **One retry, Play Mode only, by default.** A second run of a 30-minute land costs less than one wrong hand-back;
   a stage that is red twice is treated as really red. A studio names its own stages (`retryStages`).
2. **Blame by evidence needs exactly one lane.** Two lanes touching the failing test's class, or none, falls back to
   the search by land runs. The class name is matched as a whole word in the files a lane changes.
3. **A full land run every 24 hours**, counted from the last full run that passed. It costs about one long run a day
   and is what makes the shortcuts safe.
4. **Planning sessions don't take builder slots.** They still obey their own per-role caps and the memory floor.
5. **The owner-only readings are narrow word lists** (harness/owner-acts.mjs). A miss on the safe side asks the owner
   as before; every reading a stand-in used is on the ask (`readAs`).
6. **`studio/allowlist.json` is protected**, and a pattern must name its command.
7. **`token-norms.mjs` and `ledger.mjs` were cut** under the owner's "take out unused code" of 2026-11-11 (2.82's
   handoff had kept them under the 2.80 rule "keep measurement"). The events and the scorecard are untouched. One
   revert of the (i) commit's two deletions brings them back.

## Open, most valuable first

1. The crew's upgrade and the config that makes the rules check cheap: `rules.env`, `rules.paths`, `rules.focus`,
   `rules.share` (docs/RELEASE-2.83.0.md section 4). Without `rules.focus` the check still runs everything.
2. A week on 2.83, then `npm run score -- --record 2.83-week1`. Watch: "no work" session ends (expected near zero for
   engine tasks), `plan_blocked` per day, Producer sessions under 3 minutes, rules-check minutes per batch, flaky
   retries (`task.train.unity.flaky`), cost per landed task.
3. A check before a session starts that its task can be done at all, and the decision sheet (the maintainer's plan).
4. The rule tests under the editor's own runtime in the cheap check (the overseer's B-127), if the daily full run
   finds a second runtime difference.
5. A window that collects branches before a land run: only if the week shows trains of one.
