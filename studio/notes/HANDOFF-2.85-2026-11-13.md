# Handoff: round 2.85, hands off (`studio/notes/HANDOFF-2.85-2026-11-13.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-13. Release notes: docs/RELEASE-2.85.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.85 is on `claude/285`. It is not merged: the owner says when.
- 2.84 is merged (pull request #85). A crew's first 16.3 hours on it are scored in docs/RELEASE-2.85.0.md: land runs
  better and faster, nothing landed without an overseer step.
- The online Unity editor jobs still fail at Unity's sign-in: the repository's `UNITY_EMAIL` and `UNITY_PASSWORD`
  secrets are the owner's to correct.
- The plan this round started on is a document the owner holds ("Harness deep dive and plan"): 2.85 the vision in
  every brief, 2.86 a judge before landing, 2.87 daily pictures, then consolidation. Its stop rule: no new layer while
  the last release's numbers are worse. Seven decisions in it wait for the owner.

## How the round was built

Ten parts, each in its own branch and worktree with its own test unit (285a to 285h; two comment trims), merged one
at a time: after each merge the new unit and its neighbours were run, then the settings map, `check-docs`,
`check:tla` and `gate-fix --check`. `qa/selftest.mjs` and `docs/SETTINGS.md` always conflict: take ours, register the
unit again, regenerate.

## Decisions made on judgment

1. **The real-money rule is gone, by the owner's decision** (13 Nov, in his words: "take all references and everything
   out, leave it to Patch to get permission from me directly"). It was first widened, then reviewed by a second
   session, which showed word lists miss real purchases however long they get. Do not bring a word list back; if the
   owner wants a guard again, build it on who holds a payment method, not on the wording of a question.
2. **No example purchase questions in the repository.** The owner objected to them; tests of asks use neutral wording.
3. **"A rules change needs a test" is a note, not a refusal.** As a refusal it broke two existing tests and added a
   new way for `task done` to say no in a release whose point is fewer of those. The score counts it;
   `STUDIO_RULES_TEST=require` is there when the count says so.
4. **An agent's `train auto off` lapses after four hours.** A person's does not. Who may decide is unchanged.
5. **A full run's target failures do not hand a branch back.** A test a branch breaks that no rule ties to it lands on
   the ordinary run's word: the baseline file is where that shows up.
6. **Two existing tests were given new inputs** (evidence for a met criterion, a task id in a Golden-Reason): the
   assertions are unchanged.
7. **Cuts need proof per item** (P-331). Three of the plan's "safe cuts" were wrong.

## The overseer's notes

The owner asked that the overseer be told to update his own notes: mark what 2.85 closed, take out everything that
treats real money as a harness rule, and consider archiving his old harness write-ups and starting a fresh, short bug
list and devlog. That is section 7 of the upgrade note written for him. Expect the next request as one short file (a
day's score and the open bugs), not as additions to the old lists.

## Open, most valuable first

1. Score a day on 2.85 (`npm run score -- --days 1`): hand-backs with a harness cause, tasks landed with no overseer
   step, briefs with a vision card. Nothing in 2.85 is measured yet.
2. Tasks stacked on a parent that waits in an engine queue: 45 `line.plan_blocked` in the crew's log; not built.
3. The lift check of a same-refusal hold runs in the main checkout, so a lane's refusal lifts once wrongly before the
   second hold sticks. Running it in the lane copy needs the lane recorded on the hold.
4. The Unity sign-in secrets, then the `engine-unity-real` job.
5. 2.86 (a judge before landing) only if item 1 says 2.85 held. It blocks only after catching 70% of at least 20 real
   rejections with under 10% false fails.
6. The weakened-tests check flags `qa/selftest-285c.mjs:256` as a seed special case; it is a comparison of a turn
   count, a false positive of the rule.
