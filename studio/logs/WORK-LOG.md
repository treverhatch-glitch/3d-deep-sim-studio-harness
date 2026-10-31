# Work log

After every task, one row. **Proof** is a screenshot path, a recording, a test result line or a PR link:
never just "done". **Tested?** is yes, partly (say what) or no.

| Date | Who | Task | What was done | Time | Tool / engine step | Proof | Tested? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-31 | claude (harness) | 2.44 | Sync an adopted game, related tests only, retry once, Discord crew guide | ~3 h | harness, Node | PR #12, all CI jobs green | yes |
| 2026-10-31 | claude (harness) | 2.45 | `npm run play:controls`: real key presses on an adopted web game, checked against the Bible | ~1.5 h | harness, Playwright | PR #13 green; Hatchfield Space/2/1/H 4 of 4 passed | yes |
| 2026-10-31 | claude (harness) | 2.46 | Unity track: pure C# sim on .NET, editor tests read, playable builds, web + Unity side by side | ~3 h | harness, .NET 8, GameCI | PR #14 green; template parity on 6 seeds | partly (editor side untested) |
| 2026-10-31 | claude (harness) | hand-off | Crew docs + public-repo guard in hatchfield-unity-harness (branch claude/handoff, not pushed) | ~1 h | git, Node | guard blocked 6 of 6 planted leaks | yes (guard); docs not used yet |
