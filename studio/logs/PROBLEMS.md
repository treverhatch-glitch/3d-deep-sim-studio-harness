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

### P-039 — `agent stop` can kill an unrelated program · fixed in 2.57.0 (PU-17; Windows and macOS identity reads UNTESTED)
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

### P-043 — A Windows land-lock selftest flakes with EPERM · open (watch after 2.57.0)
- **What happened:** PR #34's Windows job failed once on `2.30p: 4 processes x 5 read-modify-writes under the land lock lose no update` with `EPERM` on `open` (harness/merge-lane.mjs); a re-run of the same commit passed.
- **Why (likely):** Windows refuses to open a file another process is replacing at that instant.
- **Workaround:** re-run the failed job once (the release flow already does this for known timing checks).
- **Fix?** 2.57.0 moves board writes off the land lock and adds a Windows rename retry (PU-16); `merge-lane.mjs`'s own land lock is unchanged. Watch whether it recurs.

### P-044 — The HUD "Stop ends it and hands its task back" check flakes on main · open
- **What happened:** main's `war-room-browser` job failed on 2 of 4 pushes (7f4a736, 3eb0cf2) on `[hud] FAIL Stop ends it and hands its task back` (and once on Pause), while the same code passed on its PR.
- **Why (from the log):** the agent did stop (its record says ended) but the page still listed it when the check looked: the check reads the page before the HUD's next refresh.
- **Fix (proposed):** the check waits for the row to go (poll up to a few seconds) instead of reading once. Small; needs Hatch's OK. PU-17 changes the stop path, so re-check after 2.57.0 first.

