# Skill: direction

**When.** A `Director review: …` task (role `director`).

**Steps.**
1. Read `.studio/briefs/director.md`, then the files it lists. It holds why you were pinged, what
   finished since your last review, the drift report and ideas waiting for a decision.
2. `npm run director -- review` starts a dated file in `studio/bible/reviews/`.
3. Fill in `Phase:`, `Verdict:` (on course, drifting, off course, phase-ready), `Checked:`
   (`pillar:<name>`, `layer:<id>`), what you found, what to stop, and `## Next` with suggested tasks.
4. Decide placed ideas: `npm run idea -- decide <id> approve|park|reject --by <you> --note "…"`.
5. Send the Producer your answer: `node harness/event.mjs --type agent.ask --agent <you> --to producer --msg "…"`.

**Done means.** A dated review since the task started that names the phase, what it checked, a
verdict and next tasks.

**Never.** Change a signed pillar or bring back a crossed-out layer. Assign tasks yourself.
