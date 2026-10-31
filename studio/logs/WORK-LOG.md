# Work log

After every task, one row. **Proof** is a screenshot path, a recording, a test result line or a PR link:
never just "done". **Tested?** is yes, partly (say what) or no.

| Date | Who | Task | What was done | Time | Tool / engine step | Proof | Tested? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-31 | claude (harness) | 2.44 | Sync an adopted game, related tests only, retry once, Discord crew guide | ~3 h | harness, Node | PR #12, all CI jobs green | yes |
| 2026-10-31 | claude (harness) | 2.45 | `npm run play:controls`: real key presses on an adopted web game, checked against the Bible | ~1.5 h | harness, Playwright | PR #13 green; Hatchfield Space/2/1/H 4 of 4 passed | yes |
| 2026-10-31 | claude (harness) | 2.46 | Unity track: pure C# sim on .NET, editor tests read, playable builds, web + Unity side by side | ~3 h | harness, .NET 8, GameCI | PR #14 green; template parity on 6 seeds | partly (editor side untested) |
| 2026-10-31 | claude (harness) | hand-off | Crew docs + public-repo guard in hatchfield-unity-harness (branch claude/handoff, not pushed) | ~1 h | git, Node | guard blocked 6 of 6 planted leaks | yes (guard); docs not used yet |
| 2026-10-31 | claude (harness) | hand-off merged | Crew docs + public guard merged in hatchfield-unity-harness PR #1 (generic paths, URP Windows game) | ~0.5 h | git, GitHub | PR #1, guard CI green | yes |
| 2026-10-31 | claude (harness) | public scan | Full-history scan of hatchfield-game (2,199 commits, 489 branches, 10,812 files) | ~0.5 h | git, Python | scan report sent to Hatch | yes |
| 2026-10-31 | claude (harness) | Job 3 step 1 | Measured repeatability: same seed SAME, with drawing noise DIFFERENT (cash +3,049, pax +30 over 2 days) | ~0.5 h | Vitest | probe output in chat | yes |
| 2026-10-31 | claude (harness) | Job 3 step 2 | Seeded dice for the rules: 160 calls moved, seed + position saved; 5 tests shifted (4 forced Math.random, 1 golden 579→534) | ~1 h | TypeScript, Vitest | full run 2,243/2,252 (2 sandbox-only browser fails); tests/sim/repeatable.test.ts 4/4 | yes |
| 2026-10-31 | claude (harness) | Job 3 step 3 | Replay files: city-start seeds 1–3, 3 days, a checkpoint per day; playback test; parity lines | ~1 h | Vitest | replay test 3/3; a tampered number fails naming day and field | yes |
| 2026-10-31 | claude (harness) | 2.47 | U-001 engine port in its own repo, U-002 self-hosted runner switch | ~1.5 h | harness | PR #15; selftest 773 pass | partly (self-hosted job not run yet) |
| 2026-10-31 | claude (harness) | HDRP switch | Unity repo PR #2: HDRP 17.6 package, one-click max-quality set-up script, Windows build CI (30–60 min first HDRP build) | ~1 h | Unity project files, GameCI | PR #2 pushed | no (needs the Unity editor) |
| 2026-10-31 | claude (harness) | Unity replay check | Unity repo PR #2: pure C# dice (bit for bit), replay reader and check, .NET tests 4/4, CLI prints web day-3 numbers vs "not ported yet" | ~1 h | .NET 8 | dotnet test 4/4; replay CLI 0/3 match (nothing ported) | yes (.NET); Unity Edit Mode run untested |
| 2026-10-31 | claude (harness) | 2.48–2.52 | Windows by default (2.48), U-004 logs (2.49), U-006 Vite parity seeds (2.50), U-005 public guard (2.51), U-003 two-greens timing (2.52) | ~2 h | harness | selftests per release pass locally | yes (local); CI pending |
| 2026-10-31 | claude (harness) | port sizing | Coverage of the 3-day city-start replay: ~12,300 executed lines in 256 web files | 0.3 h | Vitest + v8 coverage | coverage summary | yes |
| 2026-10-31 | claude (harness) | shared-rules probe | Web rules packed into one file (Vite lib build, 2 MB) and run in .NET with Jint: all 3 replays match at day 3 (25,730,600 / 399 / 6; 25,964,400 / 365 / 5; 25,988,400 / 367 / 6) | 0.5 h | Vite, .NET 8, Jint 4.17 | probe output | yes (.NET); not yet inside Unity |
