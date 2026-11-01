# Problems and workarounds

One block per problem. **Harness fix?** says whether the harness itself should change (then it goes into
PROPOSALS.md for Hatch). Mark **open** or **fixed**, with the date.

### P-001 — The harness repo is public, and two old public copies exist · reopened on purpose 2026-10-31: Hatch made the harness and hatchfield-game public so the online checks run free; they go private again once their checks pass (Hatch decides)
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

### P-010 — The private harness's online checks won't start (billing) · worked around 2026-10-31 (repo public again, online checks green on #22 to #31); comes back if it goes private without the self-hosted runner
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

### P-017 — Unity CI build killed at start-up (exit 137) after restoring a cached Library · fixed (Unity repo PR #8, merged)
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

### P-020 — Creating a game took one extra Math.random roll, shifting 7 seeded tests · fixed
- **What happened:** after the seeded-dice rebuild on main, 7 sim tests that pass on main failed (occupancy,
  runway capacity x2, save round-trip, show-up, starter bottleneck, curb window). Each new Game drew its seed
  from Math.random, one roll that main never took, so every later roll in tests that seed Math.random shifted.
- **Fix:** the new-game seed comes from crypto (Math.random only where there is no crypto, such as Jint). The
  9 affected test files pass (29 tests); the replays didn't change.
- **Harness fix?** Worth a line in docs/UNITY-TRACK.md step 1: seeding must not take rolls the old code didn't.

### P-021 — hatchfield-game main has been red on GitHub since at least Oct 17 · investigated, fix is a crew task
- **What happened:** every push to main fails CI (9 tests: 8 browser screen tests time out, 1 sim test hits its
  20 s limit). PR #42 (docs and workflow only) failed the same way, so no PR can get a green check.
- **Status:** an investigation agent is looking for the cause and the fix; report to Hatch first.
- **Harness fix?** Maybe: the studio should warn when the game's own trunk is red before agents build on it.

## First crew run on Hatch's PC (studio-hatchfield, harness 2.53.0, 2026-10-31 10:20–11:24 UTC)
Read from `.studio/events.jsonl` and `.studio/STOP.json` on Hatch's PC (read-only). 110 events, 21 tasks added,
6 agent sessions, 0 tasks done, reported session cost $3.74 (costUsd from the CLI; check whether that's
subscription or API billing).

### P-022 — The watchdog stopped a 44-minute-old studio for "no task finished in 2 h" · fixed in 2.54.0 (PR #27, merged)
- **What happened:** STOP.json at 11:04:45Z: "no task finished in 2 h while 5 sessions ran". The studio started at
  10:20Z (setup.init), 44 minutes earlier.
- **Why:** harness/watchdog.mjs step 3 sets `turnedOnAt = 0` when the watchdog runs in auto mode, so the check
  "sessions ran for the whole window" passes even when the studio is younger than the window.
- **Workaround:** `npm run task -- resume --by hatch`. It can stop again until 2 h after the studio began
  (~12:20Z), or raise STUDIO_WATCHDOG_IDLE_HOURS for now.
- **Harness fix (proposal, needs Hatch's OK):** in auto mode, count the window from the studio's first event or the
  watchdog's first run. Test: a selftest with a studio 30 minutes old and 5 ended sessions must not stop. Size S.

### P-023 — Planning sessions count as "sessions that ran" for the idle stop · fixed in 2.54.0 (PR #27, merged)
- **What happened:** of the 5 sessions counted, 4 were Producer/Director planning sessions (producer-1,
  producer-2, director-1 twice) that never finish tasks by design. Only opus-1 held a task (T-006).
- **Harness fix (proposal):** count only sessions that held a task (builder-type, or any session with a task id).
  Test: selftest with 4 planning sessions + 0 task sessions must not stop. Size S.

### P-024 — Two "director-1" sessions started at the same moment · fixed in 2.54.0 (PR #27, merged)
- **What happened:** at 11:02:44Z two sessions named director-1 started (pids 38060 and 35500), both from one
  low-queue wake-up (the war-room started director-1 and a dev-cycle Director in the same pass).
- **Harness fix (proposal):** one Director per pass; names unique per running session. Test: a selftest that wakes
  for "queue low" and "dev cycle" together must start one Director. Size S–M.

### P-025 — A docs task was started with a file scope in a folder the game forbids · fixed in 2.54.0 (PR #27, merged)
- **What happened:** T-023 ("Write the core loop doc in studio/bible…") was auto-started "in
  game/hatchfield/src/diplomacy/core.ts". The game's AGENTS.md says "Do not touch src/diplomacy". The scope was
  matched from the word "core".
- **Harness fix (proposal):** a docs task's scope comes from the paths it names (studio/bible); a game's "do not
  touch" folders (from its AGENTS.md or studio.json) are never picked. Test: selftest with T-023's text. Size M.

### P-026 — The Producer pre-approved Godot tools for a web/Unity game · fixed in 2.54.0 (PR #27, merged)
- **What happened:** cheat-sheet pre-approvals C-24 ("Run the Godot project…") and C-27 ("Godot 4.x APIs") were
  attached to Hatchfield tasks T-006/T-007/T-008. Hatchfield is a web game with a Unity port.
- **Harness fix (proposal):** filter cheat-sheet items by the game's engine tracks (engine.json / adopt
  settings). Test: an adopted Vite game with a Unity track gets no Godot items. Size S.

### P-027 — The launcher started one more agent in the same pass that stopped the studio · fixed in 2.54.0 (PR #27, merged)
- **What happened:** director-auto-7 started at 11:04:45.261Z; the stop was written at 11:04:45.267Z. The watchdog
  launches before it runs the idle check.
- **Also:** "Queue low … added 0" was logged every 1–3 minutes while stopped (19 refill events): noise in the HUD.
- **Harness fix (proposal):** run the idle check before launching; log a refill that adds nothing once per hour.
  Size S.

### Found by the crew (game bug, not harness): Windows case clash in src/branding
- T-026 (queued by opus-1): `Finance.tsx` and `finance.ts` in game/hatchfield/src/branding clash on Windows, which
  breaks the type check and build there. A real hatchfield-game bug; the crew has it queued.

### P-028 — A stale session record under the same name took a fresh claim away · fixed in 2.55.0 (PR #29, merged)
- **What happened:** at 11:30:42Z the Opus bot claimed T-026 as `opus-1`; 6 seconds later the watcher handed it back:
  "opus-1's session ended (finished without task done) while it held T-026". That session (a launcher session also
  named opus-1) had ended at 11:03, before the claim.
- **Why:** the watcher matches a claim's owner to a session record by name only. A chat bot claiming tasks itself
  and a launcher session can share a name.
- **Workaround:** chat bots claim with names the launcher never uses (`opus-bot`, `sonnet-bot`), not `opus-1`.
- **Harness fix (proposal, needs Hatch's OK):** a session that ended before a claim began never releases that claim;
  launcher names and claim names are checked for clashes at claim time. Test: a selftest with an ended `opus-1`
  record and a fresh claim by `opus-1` keeps the claim. Size S.
- **Found by:** the 2.54.0 metrics command on the crew's real log; the attempt is labelled env-harness.

### P-029 — I wrote a force-push into a background merge command · caught before it ran
- **What happened:** the watcher I started to merge 2.54.0 on green checks included `git push -f` to refresh the
  backup branch `backup/pre-2.54.0`. Hatch's rules forbid force-pushes.
- **Caught:** I stopped it while it was still waiting for the checks; nothing was pushed (the backup branch is still
  at 60e59bf). The restarted watcher pushes a new branch, `backup/pre-2.54.0-merge`, with no force.
- **Lesson:** background commands get the same rule check as foreground ones; a backup is always a new branch name.

## From the crew (logged in studio-hatchfield by opus-1, copied here so the harness keeps one list)

### P-030 — `npm run onboard -- --sync --dry-run` applies and commits anyway · fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)
- **What happened:** in `studio-hatchfield`, `npm run onboard -- --sync --ref main --dry-run` synced the game
  (5ffd051a..ff88183b, 31 files) and committed it straight away, before Hatch could review it.
- **Why:** `scripts/onboard-game.mjs` reads `--dry-run` only on the scan and adopt paths, not on `--sync`.
- **Workaround:** none. Review what `--sync` would bring in with `git log <adopted>..<ref>` in the game repo first.
  This time Hatch kept the commit.
- **Harness fix?** Yes: `--sync --dry-run` should print the commits and files and write nothing.

### P-031 — `npm run hub:build` type check fails on Windows (`*.tsx` not expanded) · fixed in 2.55.0 (PR #29, merged); tested on Windows 2026-10-31 by grokbot in a fresh clone: Node v24.14.0, commit 3eb0cf2, `EXIT 0`, no "*.tsx" or "No inputs were found" error (2026-10-31, opus-1)
- **What happened:** `tsc ... *.tsx` → `error TS6053: File '*.tsx' not found` on Windows. The Vite build itself
  succeeds.
- **Why:** cmd and PowerShell don't expand globs; npm runs the script through cmd on Windows.
- **Workaround:** run tsc with the file names listed out. It passes (exit 0, 6 files).
- **Harness fix?** Yes: list the files in a small node script, or use a tsconfig in `hub/`.

### P-032 — An unchosen pace lets the Director auto-start agents · fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)
- **What happened:** after `task resume`, the watcher auto-started `producer-auto-6` (claude, Opus) on T-006.
  The watchdog then stopped the studio again ("6 sessions, no task finished in 2 h").
- **Why:** `harness/agent.mjs` `fillAgents` lets the Director start agents while the pace is unchosen, even in the
  default "Precise and slow" mode.
- **Workaround:** set the pace explicitly (`npm run mode -- set precise --by hatch`). Done.
- **Harness fix?** Yes: an unchosen pace should never start agents, or `setup` should ask for one.

### P-033 — Game: `src/branding/Finance.tsx` and `finance.ts` clash on Windows · fix in T-026 (2026-10-31, opus-1)
- **What happened:** the game's typecheck and build fail on Windows with TS2305 and TS1149, because `./Finance`
  resolves to `finance.ts`. They pass on Linux.
- **Fix:** rename it to `FinanceCards.tsx` (T-026, lane `opus-1`).
- **Harness fix?** Maybe: the adopt scan could flag paths that differ only in case.

### P-021 findings (2026-10-31, investigated by hand; the investigation agent was stopped)
- **No green CI run on any branch since 2026-10-16 22:26 UTC.** All 9 failures are timeouts; none is a wrong value.
- **The 8 browser tests: the game draws one frame every ~5 s in a headless browser** (software 3D, no GPU).
  Measured on a 2-core box with Playwright's Chromium (SwiftShader): title screen 0.2 fps, in game 0.2 fps; the
  game clock moved 0.1 game-seconds in 10 real seconds (game time advances per frame). A blank page runs at 52 fps
  and a plain WebGL page at 43 fps, so the browser is fine. A CPU profile shows the page's main thread 93% idle:
  it waits on the software renderer. The game's own "low" graphics setting and a small window barely help (0.2 to
  0.6 fps). **Skipping only the 3D draw call** (a scratch edit, never committed) gave 48 fps on the title screen,
  15 fps in game, and 9.4 game-seconds per 10 s: about 90 times faster. Run one at a time with nothing else
  running, 6 of the 7 that could start still timed out, so this is not mainly CPU contention.
- **The sim tests (security.serve in CI; occupancy, contractPacing and the hub-meltdown tests on Hatch's PC): a
  different cause, sharing the CPU.** They pass alone, but use much of their time limit: security.serve 10.7 s
  (limit 20 s), occupancy ~16 s, contractPacing at 3x 16.8 s (limit 60 s). In a full parallel run, alongside
  browser tests rendering in software for minutes, they cross the limits. Fixing the browser tests frees CPU.
- **One more:** infoViews.e2e finds Chrome only at /usr/bin/google-chrome; elsewhere it can't start.
- **Effect while red:** no PR in the game repo can show a green check, and a real regression would hide behind the
  red. With 2.54.0 the studio's done-check excuses exactly these failing test names (PU-06), so crew work isn't
  blocked. Players aren't affected: the tests are slow, not wrong (UNPROVEN on a machine with a real GPU).
- **The fix is one crew task (hatchfield-game, not the harness):**

  > Fix: main's red CI. (1) Add a test-only page switch (`?noRender=1`) that skips `renderer.render` in
  > src/render/world.ts and src/render/interior/InteriorView.ts (2 lines; never on in a normal page). (2) The 8
  > *.e2e.test.ts files open the page with it through one shared helper; the tests that save screenshots keep
  > drawing and move to a separate visual-test script in the game that CI doesn't run by default. (3) infoViews.e2e uses
  > PLAYWRIGHT_CHROME and Playwright's own Chromium like the others. (4) Heavy sim tests (security.serve,
  > atc/occupancy, contractPacing, hub live.edge) get time limits of at least 3x their measured time alone, and CI
  > runs `vitest run --maxWorkers=2`. Proof: `npm test` green 3 runs in a row locally and on GitHub, with a
  > before/after table of the browser tests' times. Size: half a day to a day. Files: 2 render lines, 8 e2e tests
  > (+1 helper), 4 sim tests, the CI workflow.

## Tests on 2026-10-31 evening (break tests, cloud checks, Unity)

### P-034 — The Unity folder on Hatch's PC had a pre-merge rules file · fixed 2026-10-31
- **What happened:** `Rules~/hatchfield-sim.mjs` on Hatch's PC had fingerprint `ea3619eb8311`, not main's `55906ed2b3f5`. A diff shows it was packed from the work branch before the P-020 fix: `freshSeed` without the crypto source (plus a build path in a comment).
- **Why:** I copied the rules file from the branch build, not from a pack of the merged main. `Rules~/` is gitignored, so `git status` never shows the difference.
- **Effect:** replays still match (they pass a seed); only a brand-new game's seed choice differed.
- **Workaround:** the old file is kept beside it as `hatchfield-sim.mjs.old-ea3619eb8311` (Unity ignores `~` folders); main's file copied in; fingerprint checked after the copy.
- **Harness fix?** Yes, small: the Unity repo should print the rules file's fingerprint at load and the replay test should name it, so a stale file shows up in the first line of a run. Logged as PU-21.

### P-035 — Screen control can't see the Unity Hub window · workaround
- **What happened:** with Unity and Unity Hub approved, the Hub window still showed as a blacked-out box, so the project couldn't be opened by screen control.
- **Why (guess, not proven):** the Hub's window belongs to a program name other than the approved Store entry.
- **Workaround:** Hatch opens the project in the Hub; screen control takes over in the editor.
- **Harness fix?** No (desktop tool limit).


### P-036 — Unity's replay tests don't play the rules · fixed (Unity repo PR #11, PU-21); in-editor run UNTESTED
- **What happened:** the 4 Edit Mode tests passed in Hatch's editor (2026-10-31, screenshot of the green Test Runner), but they only read the replay files, check the dice bit for bit and check how a mismatch is reported. No Unity test plays the packed rules through Jint (`RulesHost`) and compares with the replays; that is proven only in .NET (`tools/SimCli`, 3/3).
- **Why:** the replay test was written before the rules ran in Unity (it still has a "not ported yet" case); the Jint run was added to the .NET tools, not to the Edit Mode tests.
- **Effect:** "the replays match inside the editor" was untested even though the Unity tests were green. I had described this check as "the replay tests: 3/3 must match at day 3" before reading the test file.
- **Fix (proposed):** one Edit Mode test per seed: `ReplayCheck.Compare(Load(seed), new RulesHost(<Rules~ file>))` must be "match"; it names the rules file's fingerprint (P-034). About 3–5 minutes a run. Unity repo PR, merged on green checks, then re-run in the editor.

## Break tests, 2026-10-31 evening (harness 2.56.0, throwaway copies, nothing real touched)
Two helpers ran about 13 minutes each before they were stopped by accident (a stop meant for one command
reached them too). Each finding below was re-run by hand before logging; the command is in the entry.
Fixes are planned as PU-16 to PU-21 in PROPOSALS.md and need Hatch's OK.

### P-037 — An empty lock file makes a task unclaimable · fixed in 2.57.0 (PU-16)
- **What happened:** with a task's lock file present but empty (an agent killed between creating and writing it), `npm run task -- start T-102` and `node harness/lock.mjs claim task:T-102` both crash with `RangeError: Maximum call stack size exceeded`, every time, until a person deletes the file.
- **Why:** `claimUnlocked` (harness/lock.mjs ~line 132) creates the file with `wx`; on `EEXIST` it reads it, and when the read fails it calls itself again, which hits `EEXIST` again, forever.
- **Repro:** `node harness/lock.mjs claim task:T-102 --owner a1`, empty the file under `.studio/locks/`, then `npm run task -- start T-102 --agent a2`.
- **Severity:** high (one badly timed crash blocks a task for good).

### P-038 — Ten starts at once leave the board wrong · fixed in 2.57.0 (PU-16; re-run by hand: 10 started, 10 locks, 10 on the board, 5 rounds)
- **What happened:** 10 agents starting 10 different tasks at the same moment, 3 rounds: 6–7 starts succeed and hold their locks, but the board (studio/NEXT.md) shows only 4–5 in progress; the others still read as waiting. The remaining starts fail outright.
- **Why:** each start reads, changes and rewrites NEXT.md with no lock around it, so concurrent rewrites overwrite each other; a reader can also see a half-written file.
- **Effect:** the Producer and the HUB see the wrong state; the launcher starting several agents in one pass (P-024) can hit it. Lower risk at the slow pace (2 agents).
- **Severity:** medium-high.

### P-039 — `agent stop` can kill an unrelated program · fixed in 2.57.1 (PU-17 rework; real-Windows PowerShell path proven only by Windows CI)
- **What happened:** a stale session record whose process number had been reused by another program: `npm run agent -- stop builder-7` killed that other program (a test `sleep`; exit 143).
- **Why:** `stopAgent(pid)` (harness/agent.mjs ~line 688) kills by number only. On Windows it runs `taskkill /pid N /T /F`, which force-kills that program and everything under it.
- **When it can happen:** after a crash or reboot, when the old record is still "running" and Windows has handed the number to something else (Discord, Unity, a terminal).
- **Severity:** high on Windows.

### P-040 — The secret scan misses the crew's own kind of token · fixed in 2.57.0 (PU-18; re-run by hand with random values)
- **What happened:** fake-shaped tokens in single files, `node scripts/secret-scan.mjs <dir>`: PASS (not caught) for a Discord bot token (plain and in JSON), a Discord webhook URL, a Slack webhook, a Telegram bot token and an AWS secret key. Caught: GitHub, Anthropic and xAI keys.
- **Why:** the scanner's pattern list doesn't cover these shapes or named `*_TOKEN=` assignments.
- **Severity:** high for a crew driven by Discord bots on public repos.
- **Baseline (same evening):** all three public repos scan clean (harness 524 files, game 3,843, Unity 126); one false alarm in an embedded airline-logo image (a base64 run that happens to look like an AWS key ID).

### P-041 — Lost writes and a stop that fails open (leads, partly re-checked) · fixed in 2.57.0 (PU-16)
- 10 parks at the same moment kept 1 in `studio/task-holds.json` (lost updates); not re-run by hand.
- A half-written STOP file reads as "not stopped": a start went through. Not re-run by hand.
- A half-written last line in `.studio/events.jsonl` hid the next event (a `task.start`), so `metrics` saw 0 attempts. Not re-run by hand.

### P-042 — Some usage-limit messages aren't recognised · fixed in 2.57.0 (PU-19; wording UNTESTED against a live limit)
- **What happened:** the harness's own check (`providerTrouble` in harness/agent.mjs, `QUOTA_ERROR` in harness/budget.mjs) classes these as ordinary failures: "5-hour limit reached ∙ resets 3pm", "Weekly limit reached ∙ resets Mon 9am", "Opus weekly limit reached ∙ resets Nov 3, 9am". "Claude AI usage limit reached|<epoch>" is recognised but its reset time is ignored (1 h assumed); "resets Mon 9am" and "Nov 3, 9am" aren't parsed.
- **Effect (likely, not run end to end):** a crew agent that hits its 5-hour or weekly window is handed back or failed over as if it broke, instead of waiting for the reset.
- **Caveat:** the wording is how Claude Code shows its limits as far as I know; UNTESTED against a live limit hit. The first real limit line in the crew's logs should be added to the test.

### Leads not re-checked yet
- The protected-files gate passed an uncommitted protected edit, and one already pushed: re-checked, real (with no remote even a committed edit passed); fixed in 2.56.1 (PU-20, PR #34).
- A stalled agent (no heartbeat for 40 min) keeps its slot: the launcher says "1 builder agent(s) already running" and another agent can't hand the task back.

### Held up fine
- Two agents racing for the same task: only one ever wins (5 rounds).
- 200,000 events (119 MB): `task next` 0.23 s, `task list` 0.12 s, `status` 0.46 s, watcher 0.49 s.
- Fresh clone, as a newcomer: `npm run setup` without prompts, `npm run help`, `npm run verify` 10/10 (about 3 s) and `--full` 30/30, `new-game`, its playtest and the hub all worked. (The walkthrough stopped before the crew docs.)

### P-043 — A Windows land-lock selftest flakes with EPERM · fixed in 2.58.0 (part B: the land lock retries EPERM/EACCES/EBUSY)
- **What happened:** PR #34's Windows job failed once on `2.30p: 4 processes x 5 read-modify-writes under the land lock lose no update` with `EPERM` on `open` (harness/merge-lane.mjs); a re-run of the same commit passed.
- **Why (likely):** Windows refuses to open a file another process is replacing at that instant.
- **Workaround:** re-run the failed job once (the release flow already does this for known timing checks).
- **Fix?** 2.57.0 moves board writes off the land lock and adds a Windows rename retry (PU-16); `merge-lane.mjs`'s own land lock is unchanged. Watch whether it recurs.

### P-044 — The HUD "Stop ends it and hands its task back" check flakes on main · fixed in 2.58.2 (the check waits for the page state; `--only stop-pause --repeat 30` passed 30/30 under load and with refreshes 4.5 s late, where the old logic got 0/10)
- **What happened:** main's `war-room-browser` job failed on 2 of 4 pushes (7f4a736, 3eb0cf2) on `[hud] FAIL Stop ends it and hands its task back` (and once on Pause), while the same code passed on its PR.
- **Why (from the log):** the agent did stop (its record says ended) but the page still listed it when the check looked: the check reads the page before the HUD's next refresh.
- **Fix (proposed):** the check waits for the row to go (poll up to a few seconds) instead of reading once. Small; needs Hatch's OK. PU-17 changes the stop path, so re-check after 2.57.0 first.

### P-045 — The first PU-17 fix regressed agent sessions on Windows · fixed in 2.57.1 (rework: no process call at launch or in listings; a stop during start-up stops the launcher)
- **What happened:** 2.57.0's Windows CI job (PR #35, attempt 1) failed 5 selftests, all about agent sessions: PU-17's own launch check (`identity.pid` recorded as null, `alive=false`), "after agent stop, its task can't restart straight away" (`stop-1: it is still starting (no agent process yet)`: nothing was stopped, the task stayed claimed), "task lane gives each builder its own folder", "--lanes auto", "agent names never repeat". Linux passed all of them (865/0).
- **Why (from the log):** (1) a stop while the agent is still starting no longer stops its launcher (the old code did); on the slower Windows runner the stop lands in that window. (2) Each launch and each session listing adds a PowerShell call (about 1 s or more), which pushes the supervisor tests past their time windows. (3) The agent's own identity could not be read right after start (null).
- **Done:** PU-17 reverted from 2.57.0 before merge (auto-merge stopped first); the other three fixes ship.
- **Rework plan:** read identities only when about to kill (not on every listing); a stop during start-up kills the launcher after checking the launcher's identity; compare Windows start times with a tolerance; prove it on Windows CI before merging.


## Break tests round 2, 2026-11-01 (harness 2.57.0 as merged, throwaway copies, nothing real touched)
Two helpers, about 8 and 40 minutes. The round-1 fixes hold: an empty lock file recovers; 10 parallel starts and
parks are kept (10 rounds); a torn STOP counts as stopped; a torn events line loses nothing; the fsafe lock had no
lost update with 40 processes and with holders killed; all 8 token kinds are caught; the limit messages and resets
are right; protected-file edits (uncommitted, staged, committed, deleted) fail. "Re-run by hand" below means I
reproduced it myself; the rest is the helper's repro, with the command in its report.

### P-046 — A token can still be committed: the commit hook scans the file on disk, not what is staged · fixed in 2.58.0 (PU-33)
- **Re-run by hand:** a Discord-shaped token in `game/x/cfg.json`, `git add`, then the file cleaned without re-staging: `git commit` → `[secrets] PASS`, `[pre-commit] PASS`, and `git show HEAD:game/x/cfg.json` has the token; `scripts/secret-scan.mjs .` afterwards → `PASS — 531 file(s)` (it reads the working tree, never history).
- Same family (helper): a UTF-16 file (what Windows PowerShell 5's `>` writes) is skipped as binary; the skip list isn't tied to the repo root, so any `secrets.mjs` or `*.lock` anywhere is never scanned; tokens split across lines, concatenated, hex or URL-encoded, in commit messages, `.png`/`.zip` or file names get through.
- **Severity:** high.

### P-047 — A stale or hand-edited verify record can close a task · fixed in 2.58.0 (PU-34)
- **Read by hand:** `gatesAfter` (harness/done-check.mjs ~298–320) checks only the record's time and rows; the `head` and `dirty` fields run-gates has written since 2.43.0 are never compared. Helper: a record edited to "all ok" closed a task whose `secrets` and `protected` checks had failed.
- **Severity:** high (an agent gaming the checks), medium by accident.

### P-048 — A game's own check settings aren't protected · fixed in 2.58.0 (PU-35)
- **Read by hand:** `studio/protected.json` protects `studio/gates.json` but not `game/*/studio.gates.json`, `web/*/studio.gates.json` or `studio/game.json`. Helper: `"required": false` on a failing game check → `[gates] PASS game`; `{}` in `studio/game.json` → verify tests the example game, `10/10 passed`; both with `[protected] PASS`.
- **Severity:** high.

### P-049 — Text planted in tasks, notes and pitfalls reaches agents' prompts unmarked · fixed in 2.58.0 (PU-36)
- Helper: planted lines appear word for word in `npm run brief` (task title, events, hand-off notes) and in the launch prompt (a line in `studio/PITFALLS.md`, inside the fixed rules part; a `--note`, labelled "Note from the Producer" whoever sent it, harness/agent.mjs ~537). Not re-run by hand.
- **Severity:** high for public repos and a Discord-driven crew.

### P-050 — A silent agent whose process is alive holds its slot and task forever · fixed in 2.58.0 (PU-39)
- Helper: a session with a live process and a 45-minute-old heartbeat: the launcher starts no builder, another agent can't hand the task back, the watcher only reports "stalled"; only `agent stop` frees it (the P-039 kill path). Not re-run by hand. **Severity:** medium.

### P-051 — A usage limit on a custom-command agent doesn't stop the next launch · fixed in 2.58.0 (PU-40)
- Helper: the limit is saved as `custom`, which the budget check skips (harness/budget.mjs ~337); a second `--tool custom` start launched at once and hit the limit again. **Severity:** medium-high (a launch loop).

### P-052 — `task done` killed between its two board writes makes the task vanish · fixed in 2.58.0 (PU-37)
- **Re-run by hand:** SIGKILL at the rename of the new DONE.md → `T-102 in NEXT: 0, in DONE: 0`, `No task T-102.`; the watcher says all quiet. **Cause:** two separate atomic writes (NEXT.md first, then DONE.md). **Severity:** high.

### P-053 — `task done` killed after the board write leaks the claim; nothing recovers it · fixed in 2.58.0 (PU-37)
- Helper: the board says done, the lock stays held (and heartbeat renewals keep it alive), no `task.done` event; after a reopen, another agent can't start it. The watcher skips `task:` locks of tasks not in progress. **Severity:** high.

### P-054 — A watcher requeue can release a claim made a moment earlier: two agents on one task · fixed in 2.58.0 (PU-37)
- Helper: with a slow `git status` in the watcher's pass, b1 re-claims, the watcher then requeues and releases b1's fresh claim, b3 starts the same task. **Cause:** the decision is made from the pass's first read; `pauseTask(force)` releases whatever claim exists then. **Severity:** high.

### P-055 — An error in `task start`'s board step leaks the claim (EPERM on Windows) · fixed in 2.58.0 (PU-37)
- Helper: an injected EPERM on the board mutex → the claim stays held, the task stays in the backlog, `next` skips it for an hour. On Windows one EPERM/EACCES (antivirus, a delete-pending file) is enough. **Severity:** medium-high.

### P-056 — A slow but live lock holder loses the lock after 10 s, and an update is lost · fixed in 2.58.0 (PU-38)
- **Re-run by hand:** a holder that works 12 s inside the lock, 5 quick increments meanwhile → `final counter=1 expected=6`. **Real triggers:** on Windows, clicking into a console window pauses the process writing to it (QuickEdit); a sleeping laptop; a clock jump. **Cause:** harness/fsafe.mjs breaks a lock on age even when its holder is alive on the same machine. **Severity:** high.

### P-057 — Hand-added board lines in a slightly different format are deleted without a word · fixed in 2.58.0 (PU-37)
- **Re-run by hand:** two lines added to NEXT.md, one with an ASCII `-` instead of `—`, one without backticks around the role; after one `task start`: `0 hand-added lines`. No backup, no warning. **Severity:** high (a person or the Producer editing the board loses tasks).

### P-058 — When the events log rolls over (25 MB), readers lose the task history · fixed in 2.58.0 (PU-41)
- Helper: after roll-over `task show` gives `"history": []`; `taskBase`, `laneOf`, the watcher's "last heard" times read only the new file. **Severity:** medium.

### P-059 — `metrics` slows down with the square of the event count · fixed in 2.58.0 (PU-41)
- Helper: 20k events 14 s, 40k 53 s, 80k over 100 s. **Severity:** medium (the crew's log grows daily).

### P-060 — Temp files left by a killed write pile up outside `.studio/locks` · fixed in 2.58.0 (PU-42)
- Helper: 17 of 20 kills left a full-size `.NEXT.md.<pid>….tmp` (gitignored). **Severity:** low.

### Suspected, round 2 (read in code or simulated, not seen live)
- Case-only folder claims: `path:game/Branding` and `path:game/branding` are both granted (seen on Linux); on Windows that is one folder held by two agents (PU-43).
- Hook scripts have no line-ending rule; with Windows line endings `bash\r` isn't found and every commit fails, pushing agents toward `--no-verify` (simulated on Linux) (PU-43).
- `git commit --no-verify` skips everything the hooks enforce; weakened tests (`.skip`, removed asserts, wider tolerances) are forbidden only by the rules text (PU-29).
- fsafe's in-place fallback after about 1 s of EPERM writes the board exactly when another program has it open; it should at least leave a warning event.

### Held up fine (round 2)
- 2,000 tasks, 100 sessions, 300k events (roll-over off): `task next` 0.28 s, `task start` 3.1 s, `done --check` 2.6 s, watcher 1.4 s.
- CRLF in NEXT.md parses; IDs with `../` or case-only differences can't reach the board (the ID format is `[A-Z]+-\d+`).
- `npm run verify` 2.0 s and `task done --check` 0.31 s on a fresh copy.

## From the crew, 2026-11-01 (studio-hatchfield, harness 2.53 to 2.55; Hatch relayed grokbot's notes)
The crew's log numbers these P-034 and P-035; here they get new numbers, since P-034 and P-035 are already used above.

### P-061 — The size-growth done-check measures from the task's start, so merges from main count as the task's growth · fixed in 2.58.0 (part A)
- Forced a `--force` close on T-026 and would hit T-028. Fix: measure from the merge-base with the studio's main.

### P-062 — On Windows, `verify` rewrote the line endings of a game test snapshot (`*.snap`), dirtying main · fixed in 2.58.0 (part F; games add *.snap text eol=lf)
- Fix: game checks run with `CI=true` (snapshots never written in verify); verify names any tracked file it changed;
  games add `*.snap text eol=lf` to their `.gitattributes` (a crew task in the game repo).

### P-063 — Build, toolchain and chore tasks are asked for a regression that fails on the old code · fixed in 2.58.0 (part A: chore type)
- Titles starting "fix" are typed `bug`; the crew retitled tasks "Toolchain" to get past it. Fix: a `chore` type.

### P-064 — Claude Code's low-memory guard killed background verify runs four times · fixed in 2.58.0 (part F: detached verify; UNTESTED on real Windows)
- Fix: `npm run verify` runs the gates in a detached process; a reaped session doesn't lose the run; `--wait` re-attaches.

### P-065 — The hub's watcher started an unwanted Producer session · fixed in 2.58.0 (part D: auto-start opt-in)
- 2.55.0 stopped an unchosen pace from starting agents, but the watcher's Producer check-in still starts one when a
  Producer tool is set or the pace auto-launches. Fix: starting agents from the watcher becomes opt-in.

### Answered without code (crew report)
- Watchdog "6 sessions, no task finished in 2 h": fixed in 2.54.0 (P-022, P-023); studio-hatchfield runs 2.56.0+.
  `STUDIO_WATCHDOG_IDLE_HOURS=4` can go back to the default; keeping 4 while tasks take half a day is reasonable.
- `task done --force`: `--reason` and `--accepted-by` already existed; the owner-typed path is now written down
  (`docs/FORCED-CLOSE.md`, 2.57.1).
- Bots wake only on a person's @ping: written into `docs/DISCORD-CREW.md` (2.57.1) and the Unity repo's
  `docs/crew/BOT-RULES.md` rule 17 (Unity PR #12); the 👀/✅ rule was already rule 13 there.

## From the crew, 2026-11-01 night (studio-hatchfield on 2.56.0; their log numbers P-034 to P-037)
- Their **P-034** (size rule blames merged-in code) = P-061 here: fixed in 2.58.0 (part A).
- Their **P-035** (`buildingMass.test.ts.snap` line endings) = P-062 here: fixed in 2.58.0 (part F: game checks run with
  `CI=true`, verify names files it changed); the game repo should still add `*.snap text eol=lf` (crew task).

### P-066 — On Windows the launcher split agent arguments that contain spaces (crew P-036) · fixed in 2.58.1
- **What happened (crew):** every auto-started Claude agent quit after about 5 turns with its node/npm/git commands
  waiting for approval; agy failed with `unexpected argument "are"`. The same flag typed by hand worked.
- **Why (read in code, reproduced on Linux with the same `shell: true` branch):** harness/agent.mjs launched with
  `spawn(argv[0], argv.slice(1), { shell: IS.win })`; with `shell: true` Node joins the arguments unquoted and cmd.exe
  splits them again (and reads `( ) & % ^`). Claude's `--allowedTools` arrived as 32 pieces; agy's prompt as words.
- **Fix:** `harness/launch.mjs`: shell:false; npm shims resolved to node + their `.js`; `.exe` direct; other `.cmd`
  through cmd.exe with one quoting function; prompts by stdin or one argument (kickoff file when too long).
- **Proof:** `qa/selftest-259h.mjs` 9/9 (3 runs, Linux); Windows CI runs it with real `.cmd` shims. Real installed
  `claude.cmd`/`agy.cmd` on Hatch's PC: UNTESTED until one auto-started agent runs `node`.
- **Supervisor:** stays stopped until 2.58.1 is pulled and one auto-started agent has run `node` successfully.

### P-067 — agy in headless mode denies its own shell commands (crew P-037) · fixed in 2.58.1 (owner runs it once)
- **Why:** agy reads allowed commands only from `~/.gemini/antigravity-cli/settings.json` (`permissions.allow`); in
  headless mode an unlisted command is auto-denied. The harness never wrote it.
- **Fix:** `npm run agent -- allow agy --dry-run`, then `--by <owner> --scope user` (merge only, backup first, atomic,
  logged, never skip-all). Research links in docs/AGENT-TOOLS.md.
- **UNTESTED:** real agy accepting the rules (on Windows, the `regex:` form) until the owner's first run.

### P-068 — PU-29's hooks gate would have failed every in-flight lane task after the upgrade · fixed in 2.58.2 before release
- **What happened (found while assembling 2.58.2):** a checkout on 2.58.1 with lane work takes 2.58.2; the lane's commits were never stamped, and once the lane rebases onto the upgrade their parent's commit-msg hook stamps, so `task done` refused each of them as "skipped the hooks". Reproduced in a throwaway clone (2.58.1 + a lane commit, merge, rebase, `hook-stamp.mjs check` FAIL).
- **Fix:** the first stamping hook run in a checkout (normally the upgrade's own merge commit) lists the unstamped commits on local branches that no remote has, by sha and patch-id, in `<git common dir>/studio-hooks-grandfather.json` (shared by every lane worktree, never committed). Those stay exempt after a clean rebase; a commit made after the list was written is still caught. `node harness/hook-stamp.mjs grandfather` adds to the list by hand. Two checks in `qa/selftest-2582k.mjs`, both failing on the old code.


## Log deep dive, 2026-11-01 (studio-hatchfield on 2.56.0, Oct 31 14:00Z to Nov 1 02:13Z; read-only)
Sources on the crew's PC, read only: `.studio/events.jsonl` (1,434 events in the window; "ev N" = line N),
`.studio/agents/*.json|log` (180 files), `.studio/supervisor.json`, `.studio/hub.log`, `studio/logs/PROBLEMS.md` (crew numbers
P-034 to P-041 below). Times are UTC (Bangkok = +7 h). Nothing on that PC was changed.

### P-069 — The Producer and Director were refused 62 times: claude's `-p` read as a profile · fixed in 2.58.3
- **Evidence:** ev 260–830, 62× profile.refused: "Not started (producer on --permission-mode): profile \"--permission-mode\" is in use by builder-s16"; also "profile \"default\" is in use by builder-s1".
- **Why:** `profileOf` took `-p <next word>` as a profile; for claude `-p` is --print. And with no profiles set up, any builder on the one account blocked planning.
- **Fix:** -p is never a profile for claude, agy, cursor's agent, grok, gemini, codex; a flag is never a profile; the builder-sharing rule applies only once profiles are set up. qa/selftest-2583p.mjs.

### P-070 — A person's stop was recorded as a crash and halted the supervisor for 5 hours · fixed in 2.58.3
- **Evidence:** ev 841–842 21:08:40 "human stopped builder-s16 / qa-playtester-s3"; ev 843 "stopped: exit code 1"; ev 847 21:09:24 supervisor.halted "two sessions in a row ended with exit 1"; `.studio/supervisor.json` still halted at 02:10.
- **Fix:** a stop is recorded before the kill (`.studio/agents/<agent>.stop`); the session ends "stopped by <name>", doesn't halt the supervisor and its hand-back never counts toward parking, the breaker or a model tier-up. qa/selftest-2583n.mjs (N1).

### P-071 — Lane agents couldn't read their own role and brief · fixed in 2.58.3
- **Evidence:** 46 session logs: "…to C:\…\studio-hatchfield\studio\roles\builder.md, which is outside the allowed working directories"; ev 569/659/680 "Blocked: my sandbox can't read .studio/briefs/T-012.md or studio/roles/builder.md (symlinks outside allowed dir)"; ask A-001 "Lane agents can't read/write studio/ and .studio/". With P-066 (still on 2.56.0) this made 59 sessions under 90 s (15.5M tokens incl. cache reads) that did nothing.
- **Fix:** Claude in a lane copy gets `--add-dir` for the main checkout's real studio/ and .studio/ (Codex only with STUDIO_CODEX_ADD_DIR=on). qa/selftest-2583m.mjs (M1).

### P-072 — Claims held by an agent working outside the launcher were handed to new agents · fixed in 2.58.3
- **Evidence:** T-038: opus-bot start 19:48:39 (ev 403); ev 597 20:49:03 "The claim ran out with no running session on it"; supervisor started builder-s16 on it 20:52 while opus-bot ran gates at 20:49:20. Same for T-014 (ev 662, qa-playtester-s2/s3), T-057 (ev 1322, builder-s29; ev 1529/1532/1552 "already claimed by builder-s29"), T-031 (four builders handed back within 15–60 s, "nothing edited").
- **Fix:** an expired claim whose owner had any event in STUDIO_CLAIM_ACTIVE_MIN (30) minutes, or whose lane copy changed, is busy: not handed back, requeued or given out. qa/selftest-2583n.mjs (N2).

### P-073 — The watchdog ignored an unpark and parked three times at once · fixed in 2.58.3
- **Evidence:** ev 868 21:21:33 "hatch unparked T-031" → ev 869 21:21:43 "watchdog parked T-031: handed back 3 times in 2 h" (also ev 848→850); ev 698–709 each park three times within 6 s.
- **Fix:** one hand-back count for the launcher and the watchdog, reset by done, unblock or unpark; parks are written once under the holds lock. qa/selftest-2583n.mjs (N3).

### P-074 — Code agents on a task with no lane worked in the main checkout (crew P-039) · fixed in 2.58.3
- **Evidence:** builder-s3..s7 (T-037), qa-playtester-s2/s3 (T-014), builder-s21/s22 (T-051) started with lane None; builder-s21 left 3 test files staged on main; T-051 was force-closed with its fix only staged (ev 1129; ask A-005).
- **Fix:** any role but producer/director/planner/liaison gets its own copy when its task has no lane (STUDIO_LANELESS=shared opts out). qa/selftest-2583m.mjs (M2).

### P-075 — Files left on the main checkout blocked unrelated tasks for 3 hours · fixed in 2.58.3
- **Evidence:** ev 1092, 1107, 1155, 1219, 1233, 1438, 1455, 1457, 1563: T-025, T-001, T-022, T-009, T-008, T-054 "3/4 uncommitted changes (…starterInterior.test.ts, …vehicles.test.ts, …hallRestock.e2e.test.ts)"; those tasks changed only studio/ docs.
- **Fix:** with no claimed paths, a task that isn't code work and committed no game code isn't refused for someone else's files; the Producer gets a `checkout.strays` event. qa/selftest-2583o.mjs (O4).

### P-076 — Done-check fixes from the crew's P-041, P-034 and P-035 · fixed in 2.58.3
- **P-041 (bug fixes typed as docs):** ev 718, 1235 "no changed .md file since this task started" for "Fix: bug batch N … see qa/reports/….md". Now only a .md in the title's subject makes a fix a docs task. A "batch" done rule needs Hatch's decision (bug fixes still need a seed/tick replay).
- **P-034 rest (size check):** ev 200/205 "(anonymous, line 141)() is 135 lines (was 134)"; anonymous functions are matched by their test titles and calls, and every item is listed (10 + the rest in `.studio/size-growth/<ID>.txt`).
- **P-035 (line endings):** ev 196/198, 208/210, 1401, 1421 "uncommitted change (…buildingMass.test.ts.snap)"; a line-ending-only file no longer blocks task done, a lane landing, the verify record or onboard --sync.
- **Stale-verify wording (T-019):** ev 188/193/215 said "after your last change" when main had moved (T-006 landed, ev 191) or another owner name ran the verify (ev 189, opus-1); the message now says which. qa/selftest-2583o.mjs.

### P-077 — agy permissions: exact commands only, and a session settings file exists (crew P-037 addendum) · changed in 2.58.3
- **Evidence:** crew: `agy --settings <file>` works; `command(node --version)` allowed, `command(node *)`, `command(node)` and the like denied on Windows.
- **Change:** `npm run agent -- allow agy` writes `.studio/agy-settings.json`, passed as `agy --settings`; `--scope user` still exists. The regex form stays UNTESTED on real agy. qa/selftest-2583m.mjs (M3).

### P-078 — No coding agent could use the NVIDIA NIM key (crew P-040) · added in 2.58.3
- **Change:** `--tool nim` runs aider on NIM (`--openai-api-base https://integrate.api.nvidia.com/v1`), the key mapped to OPENAI_API_KEY in the child only, never in argv, logs or events. Installing aider needs Hatch's OK; the default model is UNVERIFIED. qa/selftest-2583m.mjs (M4).

### P-079 — Agents lost turns to chained shell commands · kickoff note in 2.58.3
- **Evidence:** "This Bash command contains multiple operations. The following part requires approval: cat AGENTS.lite.md ; cat studio/roles/art.md"; 51× "head -5; …". After the P-066 quoting is fixed these still stop.
- **Change:** the kickoff says one command per Bash call and read files with the file tools. Widening the allow-list (pwd, wc, git rev-parse, git ls-files) needs Hatch's OK.

### P-080 — Rescues escalated while nothing could pick them up · fixed in 2.58.3
- **Evidence:** ev 920/934 "nobody picked the rescue up in 60 min"; ev 1055 T-016 shelved, all while the supervisor was halted (P-070).
- **Fix:** the pick-up clock stops while no launcher runs or the supervisor is halted; the Producer is told once. qa/selftest-2583n.mjs (N4).

### Seen, not changed in code (proposals)
- **Verify load:** 84 verify runs (median 265 s), up to 4 at once, 43 overlapping; 39 not all green. e2e timeouts seen for alertStack (120 s) and negotiation/panel. Proposal: `STUDIO_GATE_SLOTS=1` on a single-PC studio (one heavy game check at a time), and in the game repo run e2e files serially with a free port (crew P-038). Needs Hatch's OK.
- **Planning cost:** the 45-minute development cycle woke an Opus Director and Producer 7 times while the supervisor was halted (9 producer and 12 director sessions, 16.6M tokens incl. cache reads; director-1 read 1.8M tokens with no progress, ev 1013). Proposal: skip the regular cycle while nothing can start.
- **Opus gaps over 15 min:** 9, mostly waits on a 4–7 minute verify (e.g. 23:06→23:25, 00:11→00:29); 2.58's detached verify (`verify -- --wait`) covers a killed shell.
- **No low-memory guard events** in the studio logs; the harness has no memory guard of its own. Launcher sessions peaked at 3 at once; extra Claude processes come from verify's test workers and the crew's own bots.
- **P-036 (crew) / P-066:** still present in the logs (node/npm commands blocked 205 times) because the studio runs 2.56.0; 2.58.1 fixes the quoting (Windows CI proof). Real installed claude.cmd/agy.cmd stay UNTESTED until the studio updates.

## Building the Hatchfield replay cartridge, 2026-11-01 (a side job for Hatch, in a copy of the studio)

### P-081 — "Fails before the fix" passed when the old code never ran · fixed in 2.58.4
- **Evidence:** the HEAD control for the cartridge's first regression: `node qa/fails-before.mjs <reg> HEAD` said "PASS … the old code throws (HATCHFIELD_BUILD_FAILED: …)" on the fixed commit itself; the bundle couldn't build in the worktree, which has no node_modules.
- **Why:** qa/fails-before.mjs counted any throw, a missing cartridge, a failed import and a timeout (empty output) as "fails before".
- **Fix:** those are `known: false` with the reason, not cached. qa/selftest-2584a.mjs. (The cartridge's own build was fixed to work in a worktree too.)

### P-082 — A studio game with its own checks left a real cartridge with no gates · fixed in 2.58.4
- **Evidence:** in studio-hatchfield (game "hatchfield" owns its checks), `npm run verify` and `-- --all` printed "the cartridge gates are skipped": purity, golden, golden-py, regressions, vertical-slice, soak and tick-budget never ran for cartridges/hatchfield-replay.
- **Fix:** non-template cartridges keep the every-cartridge gates; playtest and browser-play stay skipped. qa/selftest-2584b.mjs.

### P-083 — One global tick budget for every cartridge · added in 2.58.4
- **Evidence:** the Hatchfield sim takes about 3–5 ms a tick (9.4 ms on a 2-core cloud box) against the 1 ms default, and `TICK_BUDGET_MS_PER_TICK` applies to every cartridge.
- **Change:** `cartridge.json` `"tickBudgetMs"`. Note: cartridge.json isn't a protected file, so an agent could loosen it; protecting it needs the owner key and would get in the way of new-game ID minting.


### P-084 — The hooks gate crashed with ERR_STRING_TOO_LONG (crew report H-7) · fixed in 2.58.5
- **Evidence:** opus-bot's report 2026-11-01, H-7 ("blocker"): every landing and main failed the hooks gate once a rebased commit needed the patch-id fallback; the crew carried a local patch (T-084).
- **Why:** harness/hook-stamp.mjs read `git log -p --binary` for the whole base..HEAD range into one Node string; with a far-behind base that range held the game's art import.
- **Fix:** patch-ids only for the commits that need one, streamed `git log --no-walk --stdin -p | git patch-id` with no diff in Node; an output too big to read fails the gate instead of passing it; test-weakening diffs only test code. qa/selftest-2585p.mjs. The crew's T-084 patch can be dropped after updating.

### P-085 — `task done` re-ran the game's checks and timed out under load (crew report H-3) · fixed in 2.58.5
- **Evidence:** H-3 ("high"): the crew raised `STUDIO_GAME_GATE_TIMEOUT_MS` to 1,500,000 and paused builders.
- **Why:** `task done` ran the game's gate again right after a green full `npm run verify` of the same tree; after a rebase every game check ran again; landings queued behind verifies for gate slots.
- **Fix:** a green full verify of the same clean tree stands in (`STUDIO_DONE_REUSE_VERIFY=off` re-runs); after a rebase only checks whose declared paths main touched run; a landing takes the next free slot. qa/selftest-2585s.mjs. **Planned, not done:** scaling the gate timeout with machine load.

### P-086 — The 2.58.2 upgrade's stash dropped board entries (crew report H-4) · fixed in 2.58.5
- **Evidence:** H-4 ("high", hand repair done): done tasks reopened after the stash used for the upgrade was popped.
- **Fix:** `npm run upgrade -- --check` (harness/upgrade-guard.mjs) refuses while board files are uncommitted, names stashes holding board rows and how to restore them by merge; `--snapshot` copies the board aside. docs/RELEASE.md says commit the board first, never stash it. qa/selftest-2585s.mjs.

### P-087 — "No owner key" notes didn't say how to make one (crew report H-11) · fixed in 2.58.5 (the key itself is Hatch's to make)
- **Evidence:** H-11 ("info"): opus-bot correctly refused to run keygen on the agents' PC; approvals for protected files, weakened tests and hooks can't happen until the key exists.
- **Fix:** every such note says exactly how: keygen on a device no agent runs on, commit only `studio/keys/owner-ed25519.pub.pem`, the private key never on the agents' PC. Key handling unchanged. qa/selftest-2585s.mjs.

### P-088 — The weakened-tests seed rule flagged loops over seeds · fixed in 2.58.5
- **Evidence:** found while checking H-7's test-weakening changes: `for seed in [1, 2, 3]:` and `assert seed != 0` were reported as seed special cases.
- **Fix:** only branches on the seed (if, ternary, return/continue/skip, switch, match) count. qa/selftest-2585s.mjs.

### P-089 — Crew builders took built-but-unlanded tasks when a claim lapsed (crew report H-5) · fixed in 2.58.5
- **Evidence:** H-5 ("high"), T-067 taken by a crew builder; T-060, T-061 and T-064 parked by the breaker after "claim ran out" hand-backs.
- **Why:** 2.58.3's claimActive kept the task but not the claim, didn't count a lane named `opus-N` that was built and waiting to land, the breaker counted harness hand-backs, and `task add` then `task start` left a window.
- **Fix:** kept tasks get their claim back; a lane copy with the task's unlanded commits keeps it (up to `STUDIO_CLAIM_LANE_MAX_H`, 24 h); `task start` refuses a live owner's lapsed claim (`--force` reassigns); harness hand-backs never trip the breaker; `task add --start --agent X`. qa/selftest-2585q.mjs.

### P-090 — A crew builder locked a whole source folder for an hour (crew report H-10) · fixed in 2.58.5 (launcher part planned)
- **Fix:** in a lane copy another agent's path lock is a note at commit time (checked when the lane lands; `STUDIO_LANE_LOCKS=block` restores the refusal); by-hand claims on a game's folder, source root or a folder over `STUDIO_LOCK_MAX_FILES` (50) files need `--wide`. qa/selftest-2585q.mjs. **Planned:** the launcher's own broad lane claims aren't checked yet (Hatch to decide: refuse or narrow).

### P-091 — The lock gate blocked `git merge main` in a lane (crew report H-6) · fixed in 2.58.5
- **Why:** the merge commit's staged list included files that came unchanged from main, locked by other lanes.
- **Fix:** during a merge only files the result doesn't take unchanged from the merged branch are judged. qa/selftest-2585q.mjs.

### P-092 — A custom tool command got no lane copy and edited the main checkout (crew report H-9) · fixed in 2.58.5 (per-agent key planned)
- **Evidence:** evidence api-1.json: `"lane": null`, no copy; 2.58.3 refused a lane copy to any custom command.
- **Fix:** a custom command on a laneless code task gets its own lane copy like the built-in tools, with `{mainRoot}` and `{addDirs}` placeholders; an uncommitted wrapper script named by a relative path runs from the main checkout. qa/selftest-2585r.mjs. **Planned:** a per-agent API key mapping (`STUDIO_<ROLE>_KEYMAP`), waiting on Hatch (by role or by agent; the key hold).

### P-093 — agy launches failed on Windows: "unexpected argument" (crew report H-2) · fixed in 2.58.5 (untested on real agy)
- **Evidence:** agy-1.json `cmd: "agy.exe"`, started directly and quoted right; agy.exe itself split `-p`'s text at spaces.
- **Fix:** agy gets its kickoff on stdin (`agy --print-timeout 900s [--settings f]`), and the quota probe does the same; `STUDIO_AGY_PROMPT=arg` brings back `-p`. qa/selftest-2585r.mjs.

### P-094 — `allow agy` wrote 30 rules where 16 were approved (crew report H-2b) · fixed in 2.58.5
- **Fix:** `npm run agent -- allow agy` writes only the owner-approved set (node, npm, npx, git status/diff/add/commit/log); `--all` writes the whole list; `--prune` takes extra harness-written rules out after a backup; a plain run names extras. Docs say only exact commands matched on Windows. qa/selftest-2585r.mjs.

### P-095 — `--tool nim` ran the role's model, and its default was end-of-life (crew report H-1) · fixed in 2.58.5
- **Evidence:** aider showed `openai/claude-sonnet-5-5`; `qwen/qwen3-coder-480b-a35b-instruct` answered 410.
- **Fix:** a model that isn't an `<org>/<model>` id is ignored; the default is `moonshotai/kimi-k2.6` (listed on build.nvidia.com; untested with a real key); a 410/404 ends the log with one clear line and an `agent.model_gone` event. qa/selftest-2585r.mjs.

### P-096 — `--tool nim` child got no Authorization header (crew report H-8) · fixed in 2.58.5 (untested against real aider)
- **Why:** not the env filter (that passed `OPENAI_API_KEY`): aider loads `.env` files over the environment, and the lane copy's `.env` has the template's empty `OPENAI_API_KEY=`.
- **Fix:** the child also gets `AIDER_OPENAI_API_KEY`, applied after `.env`; other-cased `OPENAI_` names are dropped; aider runs with `--no-auto-commits`. qa/selftest-2585r.mjs.

### P-097 — A session making its lane copy didn't count against the role's cap · fixed in 2.58.5
- **Evidence:** PR #43's Windows CI: both PU-19 usage-limit end-to-end checks saw a second session start before the first hit its limit; reproduced on Linux by slowing the lane copy 4 s (both fail, as on Windows).
- **Why:** the detached launcher clears the placeholder its parent wrote (so its own checks don't count it) and wrote its real record only after the lane copy; on Windows or in a big repo `git worktree add` takes seconds, and a supervisor pass in that gap saw the role under its cap. H-9 (custom commands get copies) made it show in this test; built-in tools had the same gap.
- **Fix:** harness/agent.mjs holds a "starting" record from the launcher's checks until the real record, and takes it back if the session never starts. qa/selftest-2585r.mjs (a post-checkout hook that sleeps makes the copy slow).

### P-098 — Serial landing forced rebases and repeated verifies (brief #1) · added in 2.59.0
- **Evidence:** lanes opus-12 to opus-37; backup branches *-pre-rebase*, *-preland-*, *-merged; about 10 rebases, 3 integrator runs and 1-2 h of serial verifies in one day.
- **Why:** each task done moved main, so every other lane rebased and verified again.
- **Fix:** the merge train: queued lanes merged onto main in a scratch copy, one full verify of that tree, main moves only to it; a red train is bisected; `task done` is a one-lane train (`STUDIO_TRAIN=off` keeps the old path). qa/selftest-259a.mjs.

### P-099 — A fixed 600 s game-check timeout failed under load (brief #2) · fixed in 2.59.0
- **Evidence:** T-060 "FAIL game:test: exit null: Error: timed out after 600 s"; v60d e2e "Test timed out in 120000ms".
- **Why:** the timeout ignored other heavy work on the machine.
- **Fix:** the timeout scales with live heavy holders, other running game checks and load average, up to x3, printed and recorded, never shorter. qa/selftest-259d.mjs.

### P-100 — A clean rebase invalidated hook stamps (H-13) · fixed in 2.59.0
- **Evidence:** T-093 on opus-29: "its stamp doesn't match its content" after a conflict-free `git rebase main`; reproduced in qa/selftest-259b.mjs.
- **Why:** the stamp's patch-id hashes 3 lines of context, which change when main edits nearby lines.
- **Fix:** commit-msg also records `Studio-Patch-U0` (patch-id without context); the gate accepts a match on it (old stamps keep the old rule; any changed line still fails); task done re-commits stale-stamped commits through the real hooks after its rebase; `npm run hooks -- restamp`.

### P-101 — Studio-Task listed every task the agent held (H-12) · fixed in 2.59.0
- **Evidence:** commit trailers such as "Studio-Task: T-077, T-085, T-086, T-087" (13 commits) in the crew's history.
- **Why:** the commit-msg hook read all of the agent's task locks.
- **Fix:** the lane's own task, else the subject's leading id it holds, else its only lock, else none with a note. qa/selftest-259b.mjs.

### P-102 — Bug tasks with no cartridge coverage couldn't close; retitling was the only way out (brief #5) · fixed in 2.59.0
- **Evidence:** T-057, T-058, T-059, T-067 parked or forced; T-068 (a toolchain fix titled "Bug:") forced without a regression.
- **Why:** the type came only from the title, and only a cartridge replay satisfied the bug check.
- **Fix:** `npm run task -- type` (people only; recorded, or signed with an owner key) and `"kind": "test"` regressions proven by fails-before. qa/selftest-259c.mjs.

### P-103 — Lanes ran their own stale copy of the harness (brief #6) · fixed in 2.59.0
- **Evidence:** T-061 failed hooks again after the hooks fix landed on main.
- **Why:** a lane runs the harness/ committed on its branch.
- **Fix:** verify and the hooks check refuse in a lane whose branch point is behind a harness change on main and say `git rebase main` (`STUDIO_LANE_HARNESS=own` overrides); commits only get a note. qa/selftest-259b.mjs.

### P-104 — The launcher held too-broad lane locks (brief #8) · fixed in 2.59.0
- **Evidence:** 2.58.5 (P-090) covered by-hand claims; the launcher claimed a task's lane with no breadth check. (The report's builder-s45/s51 claims were by hand, already fixed.)
- **Why:** runAgent claimed `path:<lane>` for 6 h whatever its breadth.
- **Fix:** in a lane copy a too-broad lane isn't held as a lock (`lane.unlocked`); in the main checkout the launch is refused unless a person kept the lane `--wide`. qa/selftest-259e.mjs.

### P-105 — Heavy jobs overlapped on one machine (brief #11) · fixed in 2.59.0
- **Evidence:** full verifies, a Unity editor (6-7 GB) and browser playtesters (~5 GB each) together: e2e timeouts and 2.6 GB free.
- **Why:** gate slots only spread single game checks.
- **Fix:** a box-wide `machine:heavy` lock (`STUDIO_HEAVY_SLOTS`, 1) for full verifies, the Unity gate and wrapped playtests; waiters name the holder. qa/selftest-259d.mjs.

### P-106 — A second full verify ran beside the first (brief #11) · fixed in 2.59.0
- **Evidence:** a stopped background verify loop's child ran a second full verify concurrently.
- **Why:** the running-verify record was per owner and only for detached runs.
- **Fix:** `.studio/verify-running/full.json`; a second full run is refused naming the holder; a dead holder is ignored. qa/selftest-259d.mjs.

### P-107 — Agents started with almost no free memory (brief #11) · fixed in 2.59.0
- **Evidence:** RAM down to 2.6 GB free while new sessions started.
- **Why:** the supervisor's caps ignored memory.
- **Fix:** no new agent under `STUDIO_RAM_FLOOR_GB` (3); one line per pass and a throttled event. qa/selftest-259d.mjs.

### P-108 — No supported way to give one agent its own API key (brief #14) · added in 2.59.0
- **Evidence:** planned in 2.58.5 (P-092).
- **Why:** the env filter only worked by tool prefix.
- **Fix:** `STUDIO_KEYMAP_<ROLE>` / `STUDIO_KEYMAP_AGENT_<NAME>` (`TARGET:SOURCE`, key-like names only); names logged, values never. qa/selftest-259e.mjs.

### P-109 — Clearing a halted supervisor needed the hub token (brief #15) · added in 2.59.0
- **Evidence:** the War Room's Try again needs the token from .env, which agents can't read.
- **Why:** the halt could only be cleared through the hub.
- **Fix:** `npm run studio:resume -- --by <name> [--why]`, refused for agents and launched sessions; `STUDIO_RESUME_BY` narrows who. qa/selftest-259e.mjs.

### P-110 — No gate for the Unity engine track (brief #16) · added in 2.59.0
- **Evidence:** the Unity lane's proposal: work branches merged by hand, tests run when a bot remembered.
- **Why:** the harness had no Unity landing step.
- **Fix:** `harness/unity-gate.mjs` runs `studio/game.json` `engines.unity.land` under the heavy lock (exit 0 pass, 1 red, 2 conflict, 3 refused, other error); `task done` runs it for Unity-track tasks. qa/selftest-259d.mjs.

### P-111 — Render tasks on a non-Godot game couldn't produce their visual proof · fixed in 2.59.0
- **Evidence:** found in the crew's events while checking this release: "a render task needs a visual result: capture ... --godot <project>" 7 times on a web game (T-028 parked; others forced).
- **Why:** the visual proof could only capture a Godot project.
- **Fix:** a game's manifest names its own capture command (`"visual": { "capture": ... }`, protected); `npm run visual -- capture` runs it; the same checks apply; task done's hint names the route. qa/selftest-259f.mjs.
