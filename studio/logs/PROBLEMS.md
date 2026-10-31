# Problems and workarounds

One block per problem. **Harness fix?** says whether the harness itself should change (then it goes into
PROPOSALS.md for Hatch). Mark **open** or **fixed**, with the date.

### P-001 — The harness repo is public, and two old public copies exist · fixed 2026-10-31 (all three private, confirmed by Hatch)
- **What happened:** Hatch's rule is "the harness stays private". It is public, with 1 star and 0 forks.
  `hatchfield-ai-studio-template` and `ANTI-GRAV` are public copies of harness 2.1.
- **Why:** it was kept public earlier ("public for now"), before this rule.
- **Workaround:** none in code. Hatch flips visibility (OWNER-STEPS.md 1) and decides what happens to the copies.
- **Harness fix?** Yes: U-002 (keep the checks free once private).

### P-002 — The harness works with one adopted game repo; Hatchfield has two (web + Unity) · fixed 2026-10-31 (2.47, U-001)
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

### P-004 — The 2.41 "two greens" selftest failed once on CI timing · fixed 2026-10-31 (2.52, U-003; root cause unproven)
- **What happened:** release-gate (Node 24) failed once. It passed on the re-run and on Node 22 with the same code.
- **Why:** not found yet. It's a timing-sensitive test of report times against file times; it doesn't reproduce locally.
- **Workaround:** re-run the failed job.
- **Harness fix?** Maybe: if it happens again, make the test independent of timing.

### P-005 — Couldn't read the GPU model through Task Manager · open
- **What happened:** computer use opened Task Manager, but clicks on the GPU page didn't register. The visible label reads "NVIDIA GeForce R…" (cut off).
- **Why:** Task Manager is a protected Windows app, granted at "click" level; it likely ignored clicks from a non-elevated process.
- **Workaround:** ask Hatch for the model, or read it in the NVIDIA app or Settings → System → Display → Advanced display.
- **Harness fix?** No.

### P-006 — The game's code can't run outside Vite (import.meta.glob) · fixed with a workaround
- **What happened:** a plain Node/tsx replay tool failed: `import.meta.glob is not a function`.
- **Why:** the game uses Vite-only module features.
- **Workaround:** replays run inside Vitest (`tests/sim/replay.test.ts` with REPLAY_RECORD / REPLAY_PARITY).
- **Harness fix?** Maybe: the harness's parity `--web` command for a Vite game is a Vitest run (note it in docs).

### P-007 — Tests that force random rolls by replacing Math.random stopped working · fixed
- **What happened:** after the rules moved to seeded dice, 4 tests that set `Math.random = () => 0` no longer controlled the rules.
- **Why:** the rules don't read Math.random any more.
- **Workaround / fix:** `forceSimRandom(fn)` in src/game/simRng.ts; the tests use it.
- **Harness fix?** No (game code).

### P-008 — The public guard's hooks folder switched off Git LFS's hooks · fixed 2026-10-31
- **What happened:** the Unity repo uses Git LFS for art; `core.hooksPath .githooks` (for the guard) made Git skip LFS's
  own pre-push hook, so LFS files could be pushed as bare pointers.
- **Why:** Git runs hooks from one folder only.
- **Workaround / fix:** the guard's pre-push runs the guard, then `git lfs pre-push`; the other LFS hooks live in
  `.githooks/` too (Unity repo PR #2, and `npm run public-guard -- install` in 2.51).
- **Harness fix?** Done (2.51).

### P-009 — HDRP and its setup can't be run or tested from Claude's side · open
- **What happened:** the HDRP switch and every Unity editor step need Unity with a licence; Claude's machine has neither.
- **Workaround:** a one-click set-up script that logs DONE/SKIPPED per setting; Hatch (or a bot on his PC) runs it and
  sends the Console text; CI runs the Windows build once the licence secrets exist.
- **Harness fix?** Later: a bot on Hatch's PC runs `npm run engine:gate` and posts the result.

### P-010 — The private harness's online checks won't start (billing) · open
- **What happened:** after the harness went private, every GitHub-hosted job failed in 2 seconds: "recent account payments have failed or your spending limit needs to be increased".
- **Why:** a private repo's free Actions minutes were used up; nothing can be spent (rule: no money).
- **Workaround:** run the full selftest locally before a merge (777 checks); the self-hosted runner on Hatch's PC (2.47, U-002) fixes it for good.
- **Harness fix?** Done in 2.47; waits for Hatch to install the runner.

### P-011 — The web rules use structuredClone, which an embedded JS engine (Jint) lacks · fixed with a workaround
- **What happened:** the packed rules failed in Jint: `structuredClone is not defined`.
- **Workaround:** a small JSON-based structuredClone before loading the rules. All 3 replays still match exactly.
- **Harness fix?** Maybe: if shared rules (option A) is chosen, a ready-made host for the packed rules with these globals.
- **2026-10-31:** PR #21 (these logs, documents only) was merged **without online checks**, on Hatch's OK. GitHub
  wouldn't start them (P-010), and no payment method or spending limit is added (Hatch's rule). Local checks
  instead: the docs check and the secret scan on this branch, and the full selftest on main's code (777 pass).

### P-012 — Unity Hub showed an active Personal licence but no Unity_lic.ulf existed · fixed 2026-10-31
- **What happened:** CI needs the licence file; `C:\ProgramData\Unity` didn't exist on Hatch's PC.
- **Why:** newer Hubs store an entitlement and only write the .ulf when a Personal licence is added (GameCI docs warn of this).
- **Workaround:** Hub → Licenses → **Add** → Get a free personal license, even though one is active. The file appeared.
- **Harness fix?** Yes, small: say this in docs/UNITY-TRACK.md's licence section.

### P-013 — GameCI refused to build: "Branch is dirty" · fixed in the Unity repo (PR #4, merged 2026-10-31)
- **What happened:** the first licensed CI build stopped before Unity started.
- **Why:** the URP starter icon is committed outside Git LFS, so checkout marks it changed, and GameCI's semantic
  versioning refuses a dirty tree.
- **Workaround:** `versioning: None` and `allowDirtyBuild: true` in the build step.
- **Harness fix?** Yes, small: the same two lines in the template's engine-unity-build job.

### P-014 — Selftest 249 failed once the real logs were merged · fixed (in 2.53, PR #22)
- **What happened:** the "no logs folder yet" case found the studio's own studio/logs/.
- **Workaround / fix:** the test removes the copy's studio/logs/ first.
- **Harness fix?** Done in 2.53.

### P-015 — A URP sample icon shows as changed in every clone · workaround
- **What happened:** `Assets/TutorialInfo/Icons/URP.png` is committed as a plain image, but `.gitattributes` sends
  PNGs to Git LFS, so every checkout shows it as modified (the same cause as P-013).
- **Workaround:** `git update-index --assume-unchanged` on that file in the local clone. Committing it would turn
  Unity's sample file into an LFS pointer.
- **Harness fix?** No. Later, delete the URP sample folder from the Unity repo once nothing uses it (asks Hatch).

### P-016 — Unity wrote Hatch's account IDs into ProjectSettings.asset · kept out of the public repo
- **What happened:** after the HDRP switch, `ProjectSettings.asset` changed only in `cloudProjectId`,
  `projectName` and `organizationId` (Hatch's Unity account).
- **Workaround:** the HDRP PR (Unity repo #6) leaves that file out; it stays changed on Hatch's PC only.
- **Harness fix?** Maybe: add `organizationId:` / `cloudProjectId:` with a value to the public guard's private
  markers for Unity repos. Proposal, needs Hatch's OK.

### P-017 — Unity CI build killed at start-up (exit 137) after restoring a cached Library · fix in review
- **What happened:** Unity repo PR #7 (docs only) failed its Windows build twice: Unity was killed right after it
  loaded (exit 137). It had restored the Library cache saved by PR #6's build, made before the Jint plugin was on
  main. PR #6 itself started with no cache and passed.
- **Workaround:** deleting the cache through the API is blocked by the proxy, so Unity repo PR #8 changes the cache
  key (asmdefs, plugins, graphics settings) and drops the fallback to older keys.
- **Proven?** Not yet: PR #8's own clean build is the test.
- **Harness fix?** Yes if PR #8 passes: the same key in the Unity template's CI (engine/_unity), via a proposal.

### P-018 — The Unity-port branch was 657 commits behind hatchfield-game main · rebuilt on main
- **What happened:** claude/seeded-rng split from the old trunk (cursor/audit-playtest-562d, still at 8e2278c) on
  Oct 14; main had moved 657 commits on, with 10 files changed on both sides. A rebase stopped on 18 conflicts in
  sim.ts.
- **Workaround:** rebuilt the seeded-dice change by hand on main (branch claude/unity-port), then carried the
  replay, parity, host and pack commits over.
- **Note:** the game repo's CLAUDE.md still says PRs target cursor/audit-playtest-562d, but that branch is stale;
  Hatch said to rebase onto main. Ask Hatch whether CLAUDE.md should say main.
- **Harness fix?** Maybe: `npm run engine -- drift` could also warn when a port branch falls behind the game's main.

### P-019 — main's tests steer Math.random (withSeed, spies), which the rules no longer read · fixed
- **What happened:** 22 test files on main steer Math.random directly; with the rules on their own dice those
  tests would stop steering the game.
- **Fix:** under Vitest the rules' dice follow Math.random by default (src/test/setup.ts), and withSeed forces
  them too; only the repeatable and replay tests switch to the game's own dice. Every existing test sees the same
  rolls as before.
- **Harness fix?** No.
