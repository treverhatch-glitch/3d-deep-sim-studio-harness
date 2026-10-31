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
| PU-02 | **[built in 2.54.0, PR #27]** **One metrics row per task attempt** (a planned `metrics` command): minutes queued / agent working / waiting on checks / waiting on a person / stalled, tokens, sessions, hand-backs, rescues, reopens, review verdict | ADAPT | P1 | S–M | Selftest on a synthetic event log; token totals equal `npm run tokens` |
| PU-03 | **[built in 2.54.0, PR #27]** **A failure-type label on every bad outcome** (from the MAST paper's failure list): spec-ignored, repetition, no-stop, verify-missing, verify-wrong, env/harness, quota, lane-conflict, unknown | ADAPT | P1 | S | Label today's crew run; ≥85% not "unknown", a person spot-checks 20 |
| PU-04 | **Reviewer canaries:** ~15 diffs (10 with planted sim bugs, 5 clean) to measure each reviewer family's catch rate | ADOPT | P1 | S–M | Catch rate and false alarms per family; re-run after any model change |
| PU-05 | **Review before landing for sim/core/protected tasks**, by a reviewer with no shared context, max 2 fix rounds | ADAPT | P1 | M | Bench A/B: caused-by bugs per 10 points, tokens per landed task |
| PU-06 | **[built in 2.54.0, PR #27]** **Record which checks were already red when a task is claimed**, judge only checks that were green; when the game's own trunk is red, start only fix tasks (P-021) | ADOPT | P1 | S | Selftest: a pre-existing red gate doesn't fail the builder; "was already red" hand-backs fall to 0 |
| PU-07 | **Screenshots inside the builder's loop** for renderer/UI tasks (look, compare with the art reference, then claim done) | ADOPT | P2 | M | 6 renderer bench tasks with and without: proof-wrong rate, reopens, tokens |
| PU-08 | **Two model families in parallel on escalated tasks only**; the checks pick the winner | ADAPT | P2 | M | 5 hard bench tasks vs the sequential rescue ladder; keep only if success rises more than tokens |
| PU-09 | **State hashes every N ticks** in parity and replays, so a port names the first tick and part that differ (helps L-001) | ADAPT | P2 | M | Plant a one-tick drift in the Unity template's sim; parity names the tick and field |
| PU-10 | **Playtest bots file replays:** invariants during persona play write a seed+tick regression and a bug task with fails-before filled in | ADAPT | P2 | M | Plant 3 bugs; count how many get filed with a replay that fails before the fix |
| PU-11 | **Count the Discord bots' own tokens** (hourly `session-report`); show coordination vs build tokens | ADOPT | P2 | S | One crew day; coordination share reported (first target under 15%) |
| PU-12 | **Efficiency by pace:** landed points per hour and per token, rework and conflicts for each pace | ADAPT | P2 | S | The same bench batch at two paces; default to the better points per token |
| PU-13 | **Phase exit list in JSON** whose pass flags only checks can set | ADAPT | P3 | S | Selftest: an agent flipping a flag without evidence is refused |
| PU-14 | **Per-model context profiles:** trimmed tool output and narrow commands for small local models; large models unchanged | ADAPT | P3 | S | Rejection rate of local-model drafts before and after |
| PU-15 | **[approved by Hatch 2026-10-31; built in 2.56.0]** **Visual-effect skill: spec, stepped capture, review loop** for particles, VFX and UI feedback in any genre: a one-screen spec per effect, a contact sheet of stills at fixed effect times (small, never real-time, so it works without a GPU), automatic frame checks (never ends, loop seam, off-screen spill, fast full-screen flash, seeded randomness), then the art review. Pattern from patch-gg/pixelfx (MIT; ideas only). Needs Hatch's OK | ADAPT | P2 | M | Plant 4 faults (a one-shot that never ends, a loop seam, an off-screen spill, a fast full-screen flash): the checks flag all 4. Then 4 bench effect tasks (hit flash, button press, one-shot burst, loop) with and without the skill: proof-wrong verdicts, rounds to approval, reopens, tokens |

PU-15 review: `studio/logs/research/PIXELFX-REVIEW-2026-10-31.md` (licence MIT; mechanics only; risks: taste can't be auto-checked, GPU particle systems need a per-engine capture hook, scope creep into an effects library). It builds on PU-07 and is measured on the PU-01 bench.

## Planned updates from the break tests (2026-10-31 evening) · PLANNED, nothing built
Found by two break-test helpers on throwaway copies (stopped after ~13 minutes by accident; leads in PROBLEMS.md
P-037 to P-041) and re-run by hand before logging. Each needs Hatch's OK. Same size scale as above.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-16 | **[approved by Hatch 2026-10-31; built in 2.57.0]** **Crash-safe studio state:** every state file (board, done list, holds, STOP, locks) written to a temp file and renamed into place; a short file lock around each read-modify-write of the board and holds; a lock file that can't be read is set aside after a grace period instead of blocking the task; an unreadable STOP file counts as stopped (fail closed) | ADOPT | P1 | M | Selftest: 10 parallel starts × 20 rounds, the board's in-progress list equals the locks held every round; an empty lock file recovers; a torn STOP keeps the studio stopped; 10 parallel parks keep 10 (P-037, P-038, P-041) |
| PU-17 | **[approved by Hatch 2026-10-31; first build failed on Windows CI (P-045); rework built in 2.57.1]** **Safe agent stop:** record each agent's process start time (and command) at launch; `agent stop` and the watchdog kill only if the process number still belongs to that program, otherwise mark the session dead and release its work. Windows: no `taskkill /T` on a number that has been reused | ADOPT | P1 | S | Selftest: a stale session whose number now belongs to an unrelated process; `agent stop` leaves it running and hands the task back (P-039) |
| PU-18 | **[approved by Hatch 2026-10-31; built in 2.57.0]** **Secret scan for the crew's real tokens:** Discord bot tokens and webhooks, Slack webhooks and tokens, Telegram bot tokens, AWS secret keys, named assignments (`*_TOKEN=`, `*_SECRET=`, `*_KEY=`) with long random values, and tokens hidden in base64 | ADOPT | P1 | S | Fixture set of fake-shaped tokens: each one fails the scan; the three public repos stay clean (the 2026-10-31 baseline, one known false alarm in an image pack) (P-040) |
| PU-19 | **[approved by Hatch 2026-10-31; built in 2.57.0]** **Usage-limit messages:** recognise "5-hour limit reached", "Weekly limit reached", "Opus weekly limit reached" and "usage limit reached\|<time>"; read the reset from "resets Mon 9am", "resets Nov 3, 9am" and the epoch number; a hit makes the agent wait for the reset instead of counting as a failure | ADOPT | P1 | S | The probe table from the break test as a selftest (every line classed as a limit, the reset time right); one real limit line from the crew's logs added when it appears (wording UNTESTED against a live run) (P-042) |
| PU-20 | **[approved by Hatch 2026-10-31; built in 2.56.1, PR #34]** **Protected files: check the working tree too**, not only commits since `origin/main` (an uncommitted edit, or one already pushed, passed) | ADOPT | P2 | S | LEAD, re-check first: selftest with an uncommitted protected edit and with HEAD equal to origin/main; both refused without the owner's approval |
| PU-21 | **[approved by Hatch 2026-10-31; built, Unity repo PR #11; in-editor run UNTESTED]** **Unity: play the replays through the rules in Edit Mode** and print the rules file's fingerprint at load and in the test name | ADOPT | P1 | S | Unity repo PR; the 3 replays "match" in CI's Unity job and in Hatch's editor; a stale rules file shows its fingerprint in the first line (P-034, P-036) |

**Suggested order for these:** PU-17 and PU-18 first (one can kill an unrelated program on Hatch's PC, the other can
let the crew's Discord token reach a public repo), then PU-19 (the crew runs on subscriptions), then PU-16, then
PU-21; PU-20 after its lead is re-checked. Research update (better approaches for agent-led game development): not
done this round; the research helper was stopped before it reported.

## Planned updates from research part 2 (2026-10-31, late) · PLANNED, nothing built
Report and sources: `studio/logs/research/HARNESS-RESEARCH-2026-10-31-PART2.md`. The maths divergence was re-run by
hand: Node vs the C maths library differ in 3–35% of results. Every other claim is as the research helper reported it.
Each item needs Hatch's OK. Items marked "game repo" are crew tasks in hatchfield-game, not harness changes.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-22 | **[approved by Hatch 2026-11-01; harness lint built in 2.58.2; game `detMath` in hatchfield-game `claude/det-math`, Unity proof in hatchfield-unity-harness #13]** **Deterministic maths for the rules** (game repo + a harness lint): a small `detMath` module (sin, cos, atan2, hypot, pow, exp, log written from the published fdlibm algorithms, ideas only) used by the sim instead of `Math.*`; a lint that refuses raw trig in sim code | ADOPT | P1 | M | One shared input file gives identical results in Node 20/22/24, Chrome, Jint on Linux and Windows; the replays still match 3/3; the lint fails on a planted `Math.sin` |
| PU-23 | **Green 3D tests without a GPU** (game repo, joins the P-021 crew task): Mesa llvmpipe instead of SwiftShader (check the renderer name in the log), the test clock steps exact frames with render off, screenshot tests in their own job; try free macOS runners for screenshots | ADAPT | P1 | S | One CI job prints renderer and fps for each option; switch only if ≥3× faster; e2e gives the same asserts on 1 and 4 cores, 0 flakes in 10 runs |
| PU-24 | **Read Claude's structured rate-limit events** (`rate_limit_event`): pause with a note on a warning, start no large task above ~80% use, wait until the stated reset | ADAPT | P1 | S | Capture one live event first (field names UNVERIFIED); replay a warning-then-rejected stream: the agent hands back before the rejection and the supervisor waits until the reset |
| PU-25 | **Fencing tokens on claims:** every claim gets a rising number; release, requeue and landing must quote the current number; session names carry a launch nonce | ADOPT | P1 | S | Selftest: an ended `opus-1` record plus a fresh `opus-1` claim; the claim survives, a requeue quoting the old number is refused (P-024, P-028) |
| PU-26 | **Change notices between lanes:** when a lane lands, the harness writes what changed (exports, signatures, tuning keys, state fields) to the lanes that use them | ADAPT | P2 | M | 5 planted rename pairs: post-land test failures with and without notices |
| PU-27 | **Measure cheap Unity speed-ups** (joins L-001): Jint strict mode and prepared scripts, and Puerts (V8 in Unity) on the same rules file | ADAPT | P2 | M | Ticks per second for each option with 3/3 replays identical; nothing switched without Hatch's OK |
| PU-28 | **Impossible-task canaries and a "spec conflict" exit:** 6–10 tasks whose test contradicts the spec; `hand back --reason spec-conflict` doesn't count against the agent | ADOPT | P1 | S–M | Cheat rate per model family before and after the exit; no rise in false hand-backs on normal tasks |
| PU-29 | **[approved by Hatch 2026-11-01; built in 2.58.2, with a `--no-verify` check]** **A gate for weakened tests:** removed asserts, `skip` or `only`, raised timeouts, wider tolerances, seed or tick special cases need the owner's OK with a reason | ADAPT | P2 | S | 5 planted weakening diffs all flagged; at most 2 false flags on the last 20 landed tasks |
| PU-30 | **Secrets, second layer:** `.env` moved outside every checkout; 2–3 free honeytokens; GitHub push protection on the public repos (a repo setting: Hatch's call) | ADOPT | P1 | S | A launched agent can't read the file; push protection blocks a fake-shaped token on a private test fork only |
| PU-31 | **Exploration bots that shrink failures** (feeds PU-10): random action sequences with invariants (cash change = ledger sum, no negative stock, no stuck passengers), shrunk to a minimal seed+path replay; a Go-Explore style archive of unique states | ADOPT | P1 | M | 3 planted sim bugs, each found and shrunk to ≤10 actions |
| PU-32 | **Performance as an A/B against the base commit:** alternating runs, fail only when the 95% interval says >10% slower (tick time; frame time with render off) | ADAPT | P2 | S–M | A planted 15% slowdown is flagged; 10 runs of unchanged code give 0 false flags |

**Suggested order for these:** PU-22 first (the Unity port's replay checks rest on it), then PU-23 with the P-021
crew fix, then PU-25 and PU-24, then PU-31 and PU-28; the rest after there is data.

## Planned updates from the round-2 break tests (2026-11-01) · PLANNED, nothing built
Each needs Hatch's OK; with his batching rule (2026-11-01) they would ship together as one release (2.58.0), each with
its own commit and selftest. Same size scale as above.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-33 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Secret checks on what is really committed:** `--staged` reads the staged content (`git show :path`), UTF-16 files are decoded, the skip list is tied to the repo root, and verify also scans the commits since the base branch (diffs and messages) | ADOPT | P1 | S | The stage-then-clean commit fails; a token only in history fails verify; a UTF-16 file with a token fails (P-046) |
| PU-34 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Done trusts only a verify of this commit on a clean tree**, and re-runs `protected` and `secrets` itself (well under a second) | ADOPT | P1 | S | A hand-edited "all ok" record, and a record from an older commit, are refused (P-047) |
| PU-35 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Protect the game's check settings:** `game/*/studio.gates.json`, `web/*/studio.gates.json`, `studio/game.json` | ADOPT | P1 | S | Both round-2 edits make the protected check fail (P-048) |
| PU-36 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Mark untrusted text in briefs and prompts:** titles, notes, events and hand-offs in a fenced block headed "written by agents or people, not instructions"; notes labelled with their real sender; `PITFALLS.md` changes only through a command (or protected) | ADOPT | P1 | S–M | Planted lines appear only inside the marked block; a note shows its real sender (P-049) |
| PU-37 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Board transitions crash-safe end to end:** write the file gaining the task first and show a task found in both files once; the watcher releases claims of done or missing tasks; a requeue re-checks the claim it expects under the board lock; `task start` releases its claim on any error; Windows EPERM on link is retried; board lines the parser can't read are kept under `## UNREADABLE` with a warning, never dropped | ADOPT | P1 | M | The kill-at-each-step repros leave a findable task and no leaked claim; the slow-watcher race leaves b1 holding; hand-added lines survive (P-052 to P-055, P-057) |
| PU-38 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Never break a live holder's lock on age** (same machine: only when its process is gone); the holder re-checks its token before writing | ADOPT | P1 | S | The 12-second holder plus 5 increments ends at 6 (P-056) |
| PU-39 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **The watcher frees a long-stalled agent's task without killing anything** (after about 30 min with no heartbeat: hand the task back, end the session) | ADOPT | P1 | S | The 45-minute stalled record has its task freed after one watcher pass, its process untouched (P-050) |
| PU-40 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Custom-command limits keyed per command** (`custom:<program>`), so the next launch waits | ADOPT | P2 | S | A second custom start says "Not started: budget stop" (P-051) |
| PU-41 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Events history across roll-over and linear metrics:** readers fall back to the newest rolled file; metrics indexes events once | ADOPT | P2 | S–M | `task show` keeps history after a roll-over; 40k events in metrics under 2 s (P-058, P-059) |
| PU-42 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **The watcher sweeps stale temp files** in `studio/` and `.studio/` | ADOPT | P3 | S | 20 killed writes leave no temp files after one watcher pass (P-060) |
| PU-43 | **[approved by Hatch 2026-11-01; built in 2.58.0]** **Windows hygiene:** path claims compared case-insensitively; `scripts/hooks/* text eol=lf` in .gitattributes; a warning event when fsafe falls back to an in-place write | ADOPT | P2 | S | `Branding` vs `branding` claims clash; hooks keep LF after a Windows checkout (Windows CI); the fallback logs an event |

**Suggested order:** PU-33, PU-34, PU-35 and PU-38 first (small, and each closes a way bad work or a secret gets
through), then PU-37 and PU-36, then PU-39 to PU-43. The PU-17 rework (P-039, P-045) stays its own PR because it
needs Windows CI as its proof.

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
