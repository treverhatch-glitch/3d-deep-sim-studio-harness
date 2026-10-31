# Problems and workarounds

One block per problem. **Harness fix?** says whether the harness itself should change (then it goes into
PROPOSALS.md for Hatch). Mark **open** or **fixed**, with the date.

### P-001 — The harness repo is public, and two old public copies exist · open
- **What happened:** Hatch's rule is "the harness stays private". It is public, with 1 star and 0 forks.
  `hatchfield-ai-studio-template` and `ANTI-GRAV` are public copies of harness 2.1.
- **Why:** it was kept public earlier ("public for now"), before this rule.
- **Workaround:** none in code. Hatch flips visibility (OWNER-STEPS.md 1) and decides what happens to the copies.
- **Harness fix?** Yes: U-002 (keep the checks free once private).

### P-002 — The harness works with one adopted game repo; Hatchfield has two (web + Unity) · open
- **What happened:** adopt, export and sync track one origin (`studio/game/ORIGIN.json`). The Unity port lives in its
  own public repo, outside the studio folder.
- **Why:** the engine track assumed the port lives inside the studio at `engine/<game>/`.
- **Workaround:** point the Unity commands at the repo path (`npm run engine:sim -- ../hatchfield-unity-harness`)
  and write `engine/hatchfield/engine.json` by hand with `"folder": "../hatchfield-unity-harness"`.
- **Harness fix?** Yes: U-001.

### P-003 — Engine template copy skipped every file on Windows · fixed 2026-10-31
- **What happened:** `npm run engine -- start unity` on Windows CI copied nothing.
- **Why:** the copy filter matched "Temp" anywhere in the full path, and Windows temp folders are `...\AppData\Local\Temp\...`.
- **Workaround / fix:** match only the path inside the template (2.46).
- **Harness fix?** Done.

### P-004 — The 2.41 "two greens" selftest failed once on CI timing · open
- **What happened:** release-gate (Node 24) failed once. It passed on the re-run and on Node 22 with the same code.
- **Why:** not found yet. It's a timing-sensitive test of report times against file times; it doesn't reproduce locally.
- **Workaround:** re-run the failed job.
- **Harness fix?** Maybe: if it happens again, make the test independent of timing.
