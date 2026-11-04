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

## Planned updates from the harness-ideas research (2026-11-04) · PLANNED, nothing built
From Hatch's PDF (the Harmony Harness paper, arXiv 2610.15150, and two X articles on failure ledgers and ratchets),
an independent read of 20 sources (below), and lab tests on a local scratch branch against the crew's own logs
(read-only copies, Oct 31 to Nov 4: 17,379 events, crew on 2.56 to 2.75). The lab's scripts and data stay local: the
data is the crew's. Numbers below are from those tests unless a source is named. Each item needs Hatch's OK before it
is built. Same size scale as above.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-44 | **Denials recorded once:** at a session's end the launcher harvests permission denials from the whole agent log, which is appended to across sessions under one name, so every end records all earlier sessions' denials again. Read only this session's part, as B-83 does for tokens | ADOPT | P1 | S | Lab replay on 2.77: 11, then 22, then 33 records from one log; 182 of the crew's 248 denial records are copies. Selftest: two sessions in one log, the second end records only its own; the crew's log replayed records 11 once |
| PU-45 | **One command per suggested command, and a Next step on every refusal:** messages that suggest a chained command (`git add <files> && git commit` in task done, `cd … && npx` in game-gates, and in train-tail and adopt) say it as single commands; refusals with no fix (a claimed task, some locks) end with one `Next:` command | ADOPT | P1 | S | Lab: 5 real refusals × 3 wordings, Haiku ×2 and Sonnet ×1. The fix text took the right next step from 56% to 92% (3 tuned cases) and 67% to 100% (2 held out). Terse text made every run invent a test script that doesn't exist. The chained suggestion tripled chained commands, which the permission rules refuse (15 real chained denials). A check that no harness message suggests `&&`, `;` or `cd … &&`; re-run the lab cases: chained 0, right step not lower |
| PU-46 | **"Is it learning" line in the daily digest:** failure signatures per day and the share already seen before; refusal families that kept happening after the last update reached the crew; time from first seen to the fix running on the crew. Coordination refusals (locks, holds) kept apart from mistakes | ADOPT | P2 | S | The lab script reads 17k events in 0.3 s. Its first number was wrong until the PU-44 copies were dropped (denial repeats 75% → 6%), so the selftest feeds duplicates on purpose. Today: 6 of 17 frequent families stopped after an update, 11 continued (most are locks and holds) |
| PU-47 | **Guard census in the digest:** gates that never run in the current scope; guard events silent for 7 days; warnings repeated with nobody acting; sim gates that only check the example cartridge. A list for a person to review; nothing is removed automatically (removal goes through `npm run bench -- --without`) | ADOPT | P2 | S | Lab: in Lite 24 of 35 gates never ran; purity, isolation and golden ran on all 301 verifies, never failed, and checked example-sim rather than the game; 13 of 25 guard event types never fired; `prompt.prefix.volatile` fired 205 times after 2.75 with no action |
| PU-48 | **Fix the prompt-prefix leak** the stable-prefix check keeps flagging (a timestamp and the task ID in builder prefixes), so sessions share the prompt cache | ADOPT | P2 | S–M | Prefix hash identical for two builder sessions on different tasks; no volatile event in a crew hour; cache hit rate before and after (median today 0.91 for builders, 0.83 for the Director) |
| PU-49 | **Repeat detector inside a session:** the same refusal family 3 times in one session gives a one-line nudge naming the Next step; 5 times hands the task back with the facts. `task next` doesn't offer a task that refused this agent in the last hour | ADAPT | P2 | M | Sources: LangChain's loop detection (Terminal Bench 2.0 52.8 → 66.5 with the model fixed, their benchmark), MAST (step repetition is the top failure mode, 15.7% of 1,642 traces). Lab: 18 of 40 "held" refusals came back to the same agent within an hour. Selftest with a synthetic session |
| PU-50 | **Hotfix lane to the crew:** a fix for a failure the crew is hitting now ships as x.y.z on its own, without waiting for a feature release; time-to-guard counts until the crew runs it | ADOPT | P1 | S (release doc and process) | Lab: B-83 (false stall on an appended log) was fixed in 2.76.0, but the crew on 2.75 hit it 24 times; the replay reproduces the crew's exact "read 3,023,656 tokens" on 2.75 and reads 0 on 2.77. Measure: days from a PROBLEMS entry to the crew's upgrade |
| PU-51 | **Situation eval before each release:** ~10 frozen refusal and gate situations from the crew's logs, answered by a cheap model, scored on three axes (right next step, one-command rule, command exists); a third held out and never tuned on | ADAPT | P2 | S–M | The PU-45 lab is the first version. Keep it cheap: one Haiku call per wording (about 93k tokens of context each, mostly cached). A release that drops any axis says so. Complements PU-01 and the bench, which still has no cases |
| PU-52 | **Seed the replay bench:** `npm run bench` exists (pass@1, pass^k, `--without` to test removing a guard) but `studio/bench/cases/` is empty; add the first 10 cases from crew tasks with hidden tests (= PU-01) | ADOPT | P2 | M | Needs the owner (graders live in a protected folder). First run on 2.77 as the baseline |
| PU-53 | **Rule-following per model:** the follow telemetry (`skill.follow`) shown per model in the models report; rules-heavy tasks routed away from a model that follows rules poorly | ADAPT | P3 | S | Source: "Harness Updating Is Not Harness Benefit" (weaker models load and follow harness rules far less: 0.14 vs 0.76 adherence). Matters for the Flash lanes. Follow rate per model on one crew day |

**Also strengthens PU-05** (review before landing, still planned): Cognition's clean-context, diff-only reviewer, and
"Are Solved Issues in SWE-bench Really Solved Correctly?" (7.8% of plausible patches pass only on weak tests). Keep it
to risky lanes; it costs tokens.

**Suggested order:** PU-44, PU-45 and PU-50 first (small, and they fix the crew's data and time now), then PU-46 to
PU-48, then PU-49 and PU-51, then PU-52 and PU-53.

**Not adopting:** a harness that rewrites itself (Harmony Harness, Darwin Gödel Machine, ADAS): DGM's run took about
two weeks and "significant API costs", and upgrades already cost more than runs; harness updates gave strong models
little (+2.6 points for Opus 4.6 on SWE-bench Verified in "Harness Updating Is Not Harness Benefit"). Also not: pools
of candidate harnesses, a composition agent per task, an LLM judge as a gate. The Harmony paper's results tables
weren't in the HTML version that could be opened, so its headline numbers are unchecked here.

**Already in the harness, don't rebuild:** the failure ledger (PROBLEMS, workarounds with signatures, error memory,
flakes); MAST failure labels (PU-03); a fails-before test per fix (177 of 246 PROBLEMS entries name one; most of the
rest are setup issues no test can check); refusals that name the fix (`Fix:` lines, gate-fix); done granted by
scripts, not the model; only the owner loosens a rule (protected files, weakened-tests); the bench's `--without` for
removing a guard on evidence; the stable-prefix check; stall and burn checks; progress and hand-back notes.

Sources (opened and read):
[Harmony Harness](https://arxiv.org/html/2610.15150) ·
[Harness Updating Is Not Harness Benefit](https://huggingface.co/papers/2605.30621.md) ·
[LangChain, deep agents](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering) ·
[METR, reward hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking) ·
[MAST](https://arxiv.org/html/2503.13657v3) ·
[SWE-bench patches](https://arxiv.org/html/2503.15223v2) ·
[Darwin Gödel Machine](https://arxiv.org/pdf/2505.22954) ·
[Live-SWE-agent](https://arxiv.org/html/2511.13646v3) ·
[Cognition, multi-agents](https://cognition.com/blog/multi-agents-working) ·
[Cognition, don't build multi-agents](https://cognition.com/blog/dont-build-multi-agents) ·
[Anthropic, C compiler](https://anthropic.com/engineering/building-c-compiler) ·
[Anthropic, multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system) ·
[Anthropic, context engineering](https://anthropic.com/engineering/effective-context-engineering-for-ai-agents) ·
[Cursor, scaling agents](https://cursor.com/blog/scaling-agents) ·
[OpenAI, harness engineering](https://www.openai.com/index/harness-engineering) ·
[OpenHands SDK](https://arxiv.org/pdf/2511.03690) ·
[mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent)

## Planned updates from research round 2 (Grok, 2026-11-05) · PLANNED, nothing built
Source: Grok's "Agent Harnesses, Round 2" report v2 (29 pages, Nov 5). It read the harness at 2.77.0 (34f841f) and ranked
what is still missing; its sources and evidence flags ([full] / [extract] / [abstract] / [snippet]) are in the report.
Claude read its summary, ranking, specs and repo comparison and spot-checked its repo claims (graders readable by
builders; routing holdout built but 0; futility cap in shadow mode). They hold. Its paper numbers are the authors' own,
many read only as abstracts, and are not re-checked here. The owner's frame for this round: **stay in beta mode** (no new
human approval steps); hiding the grading logic from the agents being graded is welcome. Same size scale as above.

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-54 | **Hide the graders from builders:** held-out journey seeds and their expected digests live outside the lane's files (`studio/holdout/`, read by the train, not in lane copies); builder roles can't read grader internals; a new `holdout` check runs at the train, never in the lane. Visible goldens stay readable for debugging | ADOPT | P1 | S–M | Grok's spec 3. Evidence: ImpossibleBench [snippet]: read-only tests cut cheating for one model from 50% to 1% but for another only from 54% to 39%; hidden tests brought both to 0%. METR (read earlier): reward hacking far more common where the scorer is visible. Test: a builder's `cat studio/holdout/x.json` is refused; a planted "special-case the visible golden seed" fix passes visible goldens and fails `holdout`; the train and reviewer still read it. Adds no human step |
| PU-55 | **Player-journey gate:** scripted runs through public input actions only (new game, first goal, save, reopen in a fresh process, finish), each with a success check on the final state, a **no-input control** (the same seed with no input must not pass) and a **fresh-process reopen** (save, kill, start, load: the state digest matches) | ADOPT | P1 | M | Grok's spec 5. Evidence: agent-built games reached their ending in 16% of runs while earning most build points (CEGame [full]); SWE-Game gives no credit for goals reached without input. The harness has playtest, controls and browser-play, but no no-input control and no fresh-process reopen. Test: the mutants "goal completes by itself", "save drops a field", "input ignored" and "a global survives reload" each fail the right sub-check |
| PU-56 | **Load-sensitive tests and the verify cap (crew M7):** cap concurrent verifies with the existing per-kind cap (`STUDIO_HEAVY_MAX_VERIFY`; the train's verify is first in the queue), and make the flake triage judge a test "alone" only on a quiet machine (wait for, or claim, the slots); a test that passes alone at low load and fails under load is recorded as load-sensitive and runs in a quiet slot at the train | ADOPT | P1 | S (cap: a setting, today) + S–M (triage) | The crew's evidence: with 4–6 verifies plus a Unity gate, a 2 ms timing test ran 2.2–2.5 ms (0.7–1.1 ms alone) and builders handed finished work back (T-133 four times, T-199). The flake log judged that test "real: fails when run alone" from a run whose `lowLoad` was false: the alone run wasn't alone. Test: the same test red under a fake load and green alone is labelled load-sensitive, not real; a run with `lowLoad: false` never decides "real" |
| PU-57 | **Mutation score per required gate:** nightly, sim-aware mutants (flip a comparison, off-by-one in a loop, drop a system from the tick, reorder two systems, freeze an RNG step, skip a save field, ignore one input) in a scratch copy; for each gate the share it kills; report-only for two weeks, then a ratchet (a gate's kill rate may not drop) | ADAPT | P2 | M | Grok's spec 4. Evidence: a mutant-designed suite rejected 59.9% of behaviour-changing rewrites vs 25.3% for the repo's own tests [full]; 28.5% of a SWE-bench Verified sample had tests weak enough to pass a wrong patch [abstract]. Pairs with PU-47's guard census (which guards fire; this says which would). Test: the canaries are re-found as killed mutants; a deliberately weakened gate shows a lower kill rate; under 20 min nightly |
| PU-58 | **Honest exit and impossible canaries:** `task blocked <ID> --impossible --why "…"` is a valid outcome (no hand-back penalty, no loop park); now and then a canary task with a contradictory spec (e.g. "goldens pass while the RNG order changes"); per model chain, the share that cheat (caught by weakened-tests, protected or holdout) vs exit honestly | ADOPT | P2 | S | Grok's spec 8. Evidence: ImpossibleBench [snippet] (an abort option cut cheating from 54% to 9%). Fits PU-53 (rule-following per model) and the Flash lanes. Test: a canary a lane "solves" raises a check; an honest exit is credited. No human step |
| PU-59 | **Seed the bench with a held-out split, and the acceptance rule for harness changes:** extends PU-52. `studio/bench/split.json` { heldIn, heldOut }; a harness change is accepted only if, on pass^3, neither split drops, one improves, and tokens per pass rise by no more than 15% (otherwise labelled "compute-bought"); proposers read failures from held-in cases only | ADAPT | P2 | M | Grok's spec 2. Evidence: Harness-Delta Attribution [abstract]: about 54% of evolved-harness gains were overfitting and 14% more compute; Self-Harness [full]: the held-in/held-out rule gained in all 9 settings. Test: a planted change that hard-codes a hint for one held-in case improves held-in, not held-out, and is rejected; a no-op stays within noise over 3 runs |
| PU-60 | **Plan-time scope and waves:** a scope (globs) on each task; tasks whose scopes overlap go in different waves; a task that must reach outside its scope logs a scope amend; stop rule: if the serialized share passes 60%, widen the waves | ADAPT | P2 | M | Grok's spec 7. Evidence: our own logs: 5,397 `hotspot.overlap` events in 4 days (the lab of Nov 4), and the mixed-lane hand-backs before 2.76/2.77; papers: cross-agent pairs conflicted 41.7% vs 19.8% same-agent [extract]. Test: replay two weeks of tasks; waves avoid at least half the recorded overlaps with at most 40% more wall time |
| PU-61 | **A `play` criterion in contracts, judged by a write-less evaluator:** `check.kind: "play"` with a journey and thresholds; a fresh-context evaluator (read, run, browser; no Write/Edit) plays it and records the verdict; extends PU-05 | ADAPT | P3 | M | Grok's spec 6 (Anthropic's planner/generator/evaluator post, Mar 2026 [full]: the evaluator needed tuning; separate evaluators beat self-evaluation). Test: on 10 seeded broken builds it fails at least 8; on 10 good ones it passes at least 9; it cannot edit files |
| PU-62 | **Switch on what is built and measured in shadow:** the routing holdout (10%) and the futility cap's enforce mode per task kind once its shadow log has N ≥ 20 | ADOPT | P3 | S | Grok's spec 9. Both are built (routing.mjs holdout 0; futility.mjs shadow). Test: a weekly cost per landed change by tier with an interval; under 10% of cap-stopped sessions later succeed on retry |
| PU-63 | **Herd controls and an ablation per model release:** jitter and backoff on every polling loop, a per-loop request budget, unique generated lane names; when a new model joins a chain, `npm run bench -- --without <component>` for the planner, contracts, reviewer, handoff and whole-game, and drop what has no measurable effect | ADAPT | P3 | S | Grok's spec 10. Our own evidence: the launcher retried one refused profile 61 times in 85 minutes (lab, Nov 4); H5 (a reused agent name). Test: a 1 h supervisor soak with no loop over budget; lane names unique over 100 launches |

**Not adopting from this round:** Grok's #1, "turn on enforcement with the owner key on the base branch". The crew's studio
already has an owner key (B-103's refusal said so), and beta mode is how the owner chose to keep agents moving; the
template keeps working without a key. A smaller piece fits the beta frame and is folded into PU-47's census: say it loudly
at session start when a studio's protection isn't enforced.

**Suggested order:** PU-56 now (its cap is a setting today; the triage fix is small), then PU-54 and PU-55 (the two
strongest-evidence gaps, and they work together: held-out journeys are the hidden graders), then PU-58 and PU-59, then
PU-57, PU-60 and the rest. All of them add checks or measurements, none adds an approval step.
