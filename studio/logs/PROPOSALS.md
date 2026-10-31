# Harness upgrade proposals (Hatch approves each one; nothing changes before that)

Each proposal points at the problems it comes from. Status: **waiting**, **approved**, **declined**, **done**.

### U-001 — A second game repo for the engine port · approved 2026-10-31, done in 2.47 (PR #15)
- **From:** P-002.
- **Change:** an engine track can point at a port in its own repo (adopt it like the web game: record where it
  came from; export and sync both), so parity, drift and the Unity gate work without a hand-written track file.
- **Size:** about half a day, with tests. **Risk:** low; the current one-repo setup keeps working.

### U-002 — Keep the private harness's checks free · approved 2026-10-31, done in 2.47 (PR #15)
- **From:** P-001.
- **Change:** run the harness CI on a self-hosted runner on Hatch's PC (free, safe for a private repo), or trim
  it to the essentials per push with the full set nightly.
- **Size:** an hour once Hatch has added the runner. **Risk:** the checks run only while the PC is on.

### U-003 — Make the 2.41 "two greens" selftest independent of timing · approved 2026-10-31, done in 2.52
- **From:** P-004. **Change:** the test stops depending on file and report times landing in a set order.
- **Risk:** low (a test only). **Advice:** yes; it costs a re-run now and then.

### U-004 — `npm run logs`: the 2-minute read from the command line · approved 2026-10-31, done in 2.49
- **From:** the logs set-up. **Change:** prints the latest summary, open problems and waiting proposals from studio/logs/.
- **Risk:** none. **Advice:** yes, small; useful for the Ops bot's hourly post.

### U-005 — The public-repo guard as a harness feature · approved 2026-10-31, done in 2.51
- **From:** the hand-off (the guard lives only in hatchfield-unity-harness today). **Change:** `npm run public-guard -- install <repo>` copies the guard, hook and CI check into any public game repo, and keeps them up to date.
- **Risk:** low. **Advice:** yes, before a second public game repo exists.

### U-006 — Parity for a Vite game through Vitest · approved 2026-10-31, done in 2.50
- **From:** P-006. **Change:** docs plus a ready-made `--web` command shape for Vite/Vitest games (`REPLAY_PARITY={seeds} npx vitest run …`).
- **Risk:** none. **Advice:** yes, with the Hatchfield link.

### U-007 — Look into the one-time Windows land-lock stress flake (2.30p test) · waiting
- **From:** seen once on main. **Change:** investigation; a fix only if it reproduces.
- **Risk:** none. **Advice:** low priority; only if it shows again.

## Later (ideas to keep, not tasks; nothing starts until Hatch says so)

### L-001 — How fast the Jint rules run in the Unity game, and a native C# port only if needed · LATER
Logged 2026-10-31 on Hatch's request. The Unity game runs the web game's packed rules (hatchfield-sim.mjs)
through Jint on a background thread, so slow rules make the game unable to keep up at high speed rather than
lowering the frame rate. Order:
1. **The rules running in the Windows .exe.** Not started. The CI .exe has no rules file in it yet.
2. **Task A: measure.** On a busy airport in the Windows .exe: the fastest game speed it holds, frame time and
   memory stutters. Plus: profile the same JavaScript rules in Node to find the slowest functions. UNTESTED.
   Known so far: in plain .NET (not Unity), one 3-second step of a starter airport takes ~0.4 s (about 7x game
   speed at most). Unity's runtime may be slower; nothing measured inside Unity at speed.
3. **Task B: a native C# port, only if Task A shows a real limit.** Stable parts only (those that haven't
   changed for a while; `npm run engine -- drift` shows which), slowest first, Jint kept as the reference. A
   ported part replaces the Jint version only when all 3 recorded replays give identical numbers. UNTESTED.
   Risk: the rules are one 28,000-line class, so swapping single parts means C# called from inside Jint.
Already exists: the replay check against any rules engine (`IReplayPlayer`, `ReplayCheck.Compare` in the
Unity repo); no port-task template, no speed measurement inside Unity, no native port.

## Planned updates from the research (2026-10-31) · PLANNED, nothing built
Full report with sources and licences: `studio/logs/research/HARNESS-RESEARCH-2026-10-31.md` (29 sources; ideas
and mechanics only, no code taken). Spot-checked by hand: GameDevBench (arXiv 2602.11103: 333 tasks, best 53.8%,
visual feedback 41.1% → 52.0%), the harness design study (arXiv 2609.20804: context management +35.7 points at a
32k window, +2.7 at 128k), LongHorizon-Harness (arXiv 2608.01964, manage–execute–audit). Licences are as listed by
each project and were not all re-checked; since nothing is copied, they don't change what we ship. Each item
needs Hatch's OK before it is built. Size: S under half a day, M 1–2 days, L more.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-01 | **Studio bench:** ~20 frozen real tasks from Hatchfield's history, each run 3 times with real models, as the baseline every harness change is measured against | ADOPT | P1 | M | Run on 2.53: pass@1, pass^3, median minutes, tokens, hand-backs; later agent-loop PRs must not regress it |
| PU-02 | **One metrics row per task attempt** (a planned `metrics` command): minutes queued / agent working / waiting on checks / waiting on a person / stalled, tokens, sessions, hand-backs, rescues, reopens, review verdict | ADAPT | P1 | S–M | Selftest on a synthetic event log; token totals equal `npm run tokens` |
| PU-03 | **A failure-type label on every bad outcome** (from the MAST paper's failure list): spec-ignored, repetition, no-stop, verify-missing, verify-wrong, env/harness, quota, lane-conflict, unknown | ADAPT | P1 | S | Label today's crew run; ≥85% not "unknown", a person spot-checks 20 |
| PU-04 | **Reviewer canaries:** ~15 diffs (10 with planted sim bugs, 5 clean) to measure each reviewer family's catch rate | ADOPT | P1 | S–M | Catch rate and false alarms per family; re-run after any model change |
| PU-05 | **Review before landing for sim/core/protected tasks**, by a reviewer with no shared context, max 2 fix rounds | ADAPT | P1 | M | Bench A/B: caused-by bugs per 10 points, tokens per landed task |
| PU-06 | **Record which checks were already red when a task is claimed**, judge only checks that were green; when the game's own trunk is red, start only fix tasks (P-021) | ADOPT | P1 | S | Selftest: a pre-existing red gate doesn't fail the builder; "was already red" hand-backs fall to 0 |
| PU-07 | **Screenshots inside the builder's loop** for renderer/UI tasks (look, compare with the art reference, then claim done) | ADOPT | P2 | M | 6 renderer bench tasks with and without: proof-wrong rate, reopens, tokens |
| PU-08 | **Two model families in parallel on escalated tasks only**; the checks pick the winner | ADAPT | P2 | M | 5 hard bench tasks vs the sequential rescue ladder; keep only if success rises more than tokens |
| PU-09 | **State hashes every N ticks** in parity and replays, so a port names the first tick and part that differ (helps L-001) | ADAPT | P2 | M | Plant a one-tick drift in the Unity template's sim; parity names the tick and field |
| PU-10 | **Playtest bots file replays:** invariants during persona play write a seed+tick regression and a bug task with fails-before filled in | ADAPT | P2 | M | Plant 3 bugs; count how many get filed with a replay that fails before the fix |
| PU-11 | **Count the Discord bots' own tokens** (hourly `session-report`); show coordination vs build tokens | ADOPT | P2 | S | One crew day; coordination share reported (first target under 15%) |
| PU-12 | **Efficiency by pace:** landed points per hour and per token, rework and conflicts for each pace | ADAPT | P2 | S | The same bench batch at two paces; default to the better points per token |
| PU-13 | **Phase exit list in JSON** whose pass flags only checks can set | ADAPT | P3 | S | Selftest: an agent flipping a flag without evidence is refused |
| PU-14 | **Per-model context profiles:** trimmed tool output and narrow commands for small local models; large models unchanged | ADAPT | P3 | S | Rejection rate of local-model drafts before and after |

**Suggested order:** PU-06 and the watchdog fixes (P-022 to P-027) first, because the crew is running into them
today; then PU-02 and PU-03, so the crew's data is collected in a usable form from the start; then PU-01 and PU-04;
the rest after there is data.

**Not adopting** (reasons in the report): bot debate or group chat for decisions; parallel writers on shared
files; more role-play departments; moving to LangGraph, CrewAI or AutoGen; a full observability stack on one PC;
an LLM summariser for large-window models; retries with no failing check behind them; choosing models by public
SWE-bench scores; paid cloud sandboxes (breaks the no-money rule); auto-merge of sim or protected files without
a person.

**Already in the harness, don't rebuild:** fails-before regressions, cross-family review, refresh by hand-back,
stall and burn checks, lessons with a "didn't stick" check, one task per session.
