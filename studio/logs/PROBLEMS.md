# Problems and workarounds

One block per problem. **Harness fix?** says whether the harness itself should change (then it goes into
PROPOSALS.md for Hatch). Mark **open** or **fixed**, with the date.

### P-005 — Couldn't read the GPU model through Task Manager · open
- **What happened:** computer use opened Task Manager, but clicks on the GPU page didn't register. The visible label reads "NVIDIA GeForce R…" (cut off).
- **Why:** Task Manager is a protected Windows app, granted at "click" level; it likely ignored clicks from a non-elevated process.
- **Workaround:** ask Hatch for the model, or read it in the NVIDIA app or Settings → System → Display → Advanced display.
- **Harness fix?** No.

### P-009 — HDRP and its setup can't be run or tested from Claude's side · open
- **What happened:** the HDRP switch and every Unity editor step need Unity with a licence; Claude's machine has neither.
- **Workaround:** a one-click set-up script that logs DONE/SKIPPED per setting; Hatch (or a bot on his PC) runs it and
  sends the Console text; CI runs the Windows build once the licence secrets exist.
- **Harness fix?** Later: a bot on Hatch's PC runs `npm run engine:gate` and posts the result.

### P-346 — timing checks fail under load in the online runs · open
- **Evidence:** 16 November, four runs queued at once: "task lane gives each builder its own folder", "the supervisor starts a fresh agent per task", "2.77.0 (p, P9.6)" and "2.69.0 (q, 1)" each failed once and passed on the re-run of the failed job. Each re-run costs about 40 minutes.
- **Workaround:** re-run the failed job and note it on the pull request. Do not queue four runs at once.
- **2.98:** `290b` "two runs admitted ... their times overlap" failed on Windows in three online runs in a row: the stand-in land run lasted 0.4 s and each step's start-up had grown past it, so two runs started together no longer overlapped. The stand-in now lasts 2.5 s. `277p` "someone moves main" failed once on Linux and passed on a re-run. `284u` "train cancel" got two `cancelled` events once on Windows (the train announced its own cancel before it was ended): a race in the product, open.
- **2.97:** `290b` "the second gate's script moves the target" failed once among 11 units run together on a 2-core machine with other tests running, and passed three times out of three alone.
- **2.96:** the two supervisor-window checks ("two builders without lanes never run at once", "agent names never repeat across supervisor restarts") failed on Windows in the first online run of 2.95 and passed on the re-run; they now wait until one agent is live and then watch a window.
- **2.95:** "with --lanes auto, each lane gets its own agent holding that folder" failed in two of the three online runs of 2.94 (Windows) and passed on the re-run each time.
- **2.94:** seen once more, on main's run after the 2.93 merge, on Windows: "a ping starts STUDIO_DIRECTOR_CMD once, then waits out the cooldown" (starts=0). It passed on the same tree in the pull request's run an hour earlier.
- **2.92:** "task lane gives each builder its own folder" now waits for the thing itself. The same change to "the supervisor starts a fresh agent per task" was withdrawn (the next check, "--lanes auto", then failed 2 runs in 8: only one lane got its agent, even with a 90 s wait; cause not found). Left: that check, `2771a`, the tester drive, `290b` second gate, `277p` "someone moves main", "two builders without lanes", "--lanes auto".
- **2.91:** three were given a hand-shake in place of a clock (`269q`, `2601m`, `277p` B-before-A). Left: the two supervisor-window checks, `2771a`, the tester drive, and two seen under load on 17 November (`290b` second gate, `277p` "someone moves main").

### P-367 — the next batch waited unchecked through the whole train before it · fixed 2.94 (`rules.ahead`, off by default, untested on a real engine)
- **Evidence:** a studio's trains: one rules check (about an hour), then one land run (one to two hours); the lanes queued for the next train were checked only after both.
- **Fix:** with `rules.ahead` the next batch's rules check runs beside the land run when free memory allows; kept only when the land run lands the batch unchanged. `qa/selftest-294a.mjs`.

### P-368 — the scorecards called a closed task "landed" · fixed 2.94
- **Evidence:** `npm run score` and the brief counted every `task.done` under "landed", so planning and watch tasks, duplicates and forced closes read as landed work.
- **Fix:** "landed" is work that went through a train; "closed without a landing" is its own number. `qa/selftest-294c.mjs`. The autonomy badge still counts closes (its bars were set on that number).

### P-369 — on Windows the check ahead ended with the train that started it · fixed 2.94 (before the merge)
- **Evidence:** pull request 96, first online run, Windows only: `294a` (e) red. The check ahead was started and then dropped, the next train ran the same tests again, and the unit crashed removing a folder a leftover process held. On Windows a child that is not started detached ends when its parent's process ends; the check ahead was detached everywhere else.
- **Fix:** it is started detached on every system. The unit's clean-up retries a held folder, as `292a` does.

### P-370 — on Windows a train cancel started from a cut-down environment could not read the process list · open (the unit fixed 2.94, before the merge)
- **Evidence:** pull request 96, second online run and its re-run, Windows only: `294a` (g) red twice the same way. `train cancel` said "the process list could not be read: ETIMEDOUT" (the one PowerShell call took over 16 s), so the train was not ended and neither was the check ahead. `284u` runs the same cancel on the same runner and passes: it passes Windows' own system variables through to its helpers (2.84), and `294a` did not.
- **Fix:** `294a` passes them through, as the fifteen engine units since 2.84 do. Nothing in `harness/` changed. The third online run passed with them, every check of `294a` green on Windows.
- **2.96, measured on an online Windows machine:** from a unit started under a bash shell, a PowerShell that calls no cmdlet answers in 0.3 s and a `[wmisearcher]` query in 0.1 s, while `Get-CimInstance Win32_Process` printed nothing in 19 s. `PSModulePath` there begins with a large module folder; a cmdlet from a module makes PowerShell search those folders first, which is the likely cause. No variable was missing.
- **Open:** `harness/proc-identity.mjs` still reads the process list and start times with `Get-CimInstance`. It works from a studio's normal shell. Moving it to `[wmisearcher]` needs a check that both give the same start time to the millisecond, because locks compare it.

### P-371 — one full rules run was one process that outgrew the machine · fixed 2.95 (as settings)
- **Evidence:** a live studio, 18 November: 6.7, 14 and 18.9 GB for one full run of its rules tests, on 31.8 GB where a land run needs about 21 GB free. Land runs waited, the owed full run stood in the trains' way, the check ahead could not start. The cause on the game side (every test fixture kept its data for the whole run) was found the same day.
- **Fix:** `rules.shards` runs a full check one shard at a time with a green kept per shard; `rules.peak` reads the test run's own peak. `qa/selftest-295a.mjs`. Full only with `rest`; the harness cannot check that filter.

### P-372 — a held, queued branch kept getting new porter sessions · fixed 2.95
- **Evidence:** a live studio: a task whose branch was queued for the engine train and waited for another task (`task after`) was started again and again; each session queued the same branch and the train left it out. A task stays in progress after `task done --train`, and a start on a task in progress skipped the hold.
- **Fix:** no session is started on it, `task start` refuses it in plain words, and queueing the same branch at the same head changes nothing. `qa/selftest-295d.mjs`.

### P-373 — git allow-rules for a studio path with a space are not quoted · open (untested)
- **Evidence:** found while writing `295c`: the `git -C <dir> ...` rules a start builds for agy and for Claude hold the lane's path unquoted. Whether the real tools match them against a quoted path is not known. A studio path without spaces is not affected.
- **Workaround:** keep the studio in a path without spaces.

### P-374 — nobody had measured what a land run or a shard takes · fixed 2.96 (sampling); a studio's first samples were read on 20 November (2.97)
- **Evidence:** a live studio, 19 and 20 November: heavy work admitted by slots and fixed claims; a sampler made by hand summed every test process on the machine and blamed the wrong test (11.5 GB); the test run's own per-fixture table showed one fixture at 14.2 GB. The land run waited for 18.8 GB, the size of a test stage it skips when the rules are green.
- **Fix:** every run's own process tree is sampled; a cost per job kind; `machine.admit: "measured"`. `qa/selftest-296a.mjs`. The first Windows helper (four `Get-CimInstance` queries a sample) wrote no sample at all in the online run: see P-370. It now uses two `[wmisearcher]` queries and no cmdlet; on an online Windows machine it found a 300 MB grandchild, and a sample costs about 0.1 s.

### P-375 — a red rules check re-ran the whole suite at every narrowing step · fixed 2.96
- **Evidence:** a live studio: 169, 316 and 413 minutes of rules for red batches, 87 to 90 for green ones; a count ratchet cost about 6 hours over two trains; naming two lanes from a failure that names its system took 8 runs.
- **Fix:** narrowing runs the failing tests only, one whole check decides; `blame` reads the failure's words; ratchets have their own hand-back kind. `qa/selftest-296b.mjs`.

### P-376 — a held lane at the head of the queue set the batch class and took a seat, train after train · fixed 2.96
- **Evidence:** a live studio: one lane that waited for another task headed four trains in a row; thirteen lanes of the other class waited, one over 30 hours.
- **Fix:** a held lane is left out before the pick; a lane that cannot go does not decide the batch. `qa/selftest-296c.mjs`.

### P-377 — a batch above `rules.maxLanes` left the land run without a green, silently · fixed 2.96
- **Evidence:** a live studio: a 7-lane batch with `maxLanes` 6 was checked in two slices, the land run was not told, and the land script ran the whole suite again.
- **Fix:** the lanes the slices leave are checked once as one tree; `rules show` warns. `qa/selftest-296b.mjs`, `284t`.

### P-378 — upgrades were merged while a train was running, twice from a branch · fixed 2.96
- **Evidence:** a live studio, 18 November: three upgrades during trains; two took a release branch before its online checks had finished, one 26 minutes after a real fault was fixed on it.
- **Fix:** `npm run upgrade` refuses while a train runs and says when the ref is not main. `qa/selftest-296e.mjs`.

### P-379 — a rules green was judged by a lane copy's working files and lost without a word · fixed 2.97
- **Evidence:** a live studio, 20 November: a train's sharded check was green for four lanes; a porter session then edited the lane copy of one of them; the land run was not told, ran the whole rules stage again (about 50 minutes), and `rules.ahead` started nothing. No line said why. A lane copy is a checkout of the lane's branch, and the land run never sees its uncommitted files.
- **Fix:** inputs from a lane copy are read at the lane's commit. A green that is not used and a check ahead that does not start each say why; `rules show` prints the check ahead's last outcome. A branch landed by name that moved after the check loses the green, on purpose. `qa/selftest-297a.mjs`.

### P-380 — the union merge refused without saying why · fixed 2.97
- **Evidence:** the same day: two lanes were deferred "conflicts ... in" two files both listed in `merge.union`. The rule had run and refused: in one file both lanes lengthen the same single line (a quoted list), and the rule took added lines only. The overseer read the silence as "the rule does not reach the batch's conflict check".
- **Fix:** a line both sides only lengthen (one insertion each) is merged, ours' text then theirs'; a refusal names the file and line in the lane's `why`. `qa/selftest-297b.mjs`.

### P-381 — a land run waited for the memory of a stage it skips · fixed 2.97
- **Evidence:** the learned floor was 18.8 GB, from land runs that ran the rules stage and from the whole machine's used memory. A land run told the rules are green peaks near 10 GB in its own tree. With 14 GB always in use, 18.8 GB free never came: refused after 35 minutes. The overseer tuned the floor by hand.
- **Fix:** the floor is the need of the kind about to run, from that kind's passed sampled runs; the owner's setting and the tuned floor still win. `qa/selftest-297c.mjs`. The old whole-machine learning stays as the fallback for a kind with no sampled run and for a studio with sampling off.

### P-382 — a run too short to sample was stored as a peak of 0 GB · fixed 2.97
- **Evidence:** 16 of 41 shards finish inside one 10 s sample interval; each was stored as `gb: 0`. With measured admission on, a 0 would admit anything.
- **Fix:** stored as unknown (`gb: null`, `short: true`); old entries read the same way; admission falls back to the plan's number and says "too short to sample". `qa/selftest-297c.mjs`.

### P-383 — a train that waited on a drain ran the old release over the new files; the upgrade merged a stale ref · fixed 2.97
- **Evidence:** 20 November: the overseer drained to upgrade; a train process had started 30 seconds earlier and waited in memory; after `drain off` it took its lock and ran with 2.95 modules over 2.96 files (its 41 shard runs wrote no samples). The 2.96 guard reads train locks, and a waiting train holds none. The upgrade merged `origin/<branch>` as last fetched hours before: a commit already replaced, whose Windows checks then failed.
- **Fix:** no train starts during a drain and `drain off` starts the waiting one; a train compares the harness it loaded with the one on disk as it takes its lock and starts again once; `--merge <remote>/<branch>` fetches first and a branch other than main needs `--not-main`. `qa/selftest-297d.mjs`. Untested on Windows: the detached restart.

### P-384 — a lane-live window of 0 still called a lane "in use" for a few milliseconds · fixed 2.97 (cause not proven)
- **Evidence:** pull request 99: on Windows `293b` "record" failed in both full online runs and passed in eight runs alone or after `290b`. The start after a session's end did not get the free pool name. `laneLive` read the clock, asked git, then compared the folder's time: with `STUDIO_LANE_LIVE_MIN=0` a write in between gave a time later than the clock, and "live". No run caught the state itself.
- **Fix:** a window of 0 means none (`harness/worktree.mjs`); the check prints the lane folder's age when it fails, so a repeat shows the evidence.

### P-385 — the daily full land run could not finish, and ran again at once · fixed 2.98 (the parts are the studio's to define)
- **Evidence:** a live studio, 23 and 24 November: the full run on the target alone hit its 240-minute limit five times in a row. One editor process grew to 14 GB, free memory fell to 2.5 GB, the machine paged. A timeout was not counted as a run, so past `fullLandMaxHours` it ran at the end of every train and, with an empty queue, again at once. The overseer set both hours to 240 to stop it.
- **Fix:** `engines.<x>.fullLand` (`parts`, `partTimeoutMin`, `backoffHours`): one land run per part (`STUDIO_LAND_PART`), a result per part kept by the target's tree, a try with no result backs off, and with lanes waiting an overdue run takes one part at the end of a train. `qa/selftest-298a.mjs`. What a part runs is the land script's.

### P-386 — rules parts started together built the same output and went red on a locked file · fixed 2.98
- **Evidence:** with `rules.focus.splitMax: 3`, two `dotnet test` parts built one project in one checkout at the same moment: `error CS2012 ... locked by 'VBCSCompiler'`. Two trains went red; the narrowing handed a task back for nothing.
- **Fix:** one build per checkout, then every part with `--no-build` (`rules.build`, `rules.testAfterBuild`); a build fault is run again alone, and twice is "not judged": nothing is narrowed or handed back (`rules.infra`). `qa/selftest-298c.mjs`. Not run with a real `dotnet`.

### P-387 — a train went on with the config it read at its start · fixed 2.98
- **Evidence:** `splitMax` and `fullLandMaxHours` were changed while a train ran; it started a 4-hour full run and a split known to fail. Two trains were cancelled.
- **Fix:** `engines.<x>` is read again before each step and a change is logged in one line. `qa/selftest-298b.mjs`.

### P-388 — lanes that change nothing landed, and the first landing closed tasks with work left · fixed 2.98
- **Evidence:** two lanes holding only a merge commit "landed" (the target gained only the land record). Unit tasks queued without `--slice` were closed by their first landing more than ten times; the overseer reopened each after an audit.
- **Fix:** an empty lane is refused at the door and in the chain, and its task stays open. A task can carry a checklist: every landing is a slice until no item is open (`task checklist`, `--final`). `qa/selftest-298b.mjs`, `qa/selftest-298e.mjs`.

### P-389 — one task, one lane: porters sat idle while a slice waited · fixed 2.98 (as `task split`, not a second lane)
- **Evidence:** a unit's task counted as in progress for the hour or two its slice waited for a train. The overseer filed a second task per unit by hand and the landed work per train doubled.
- **Fix:** `task split <ID> --every <n>` makes child tasks from the open checklist items; the parent closes when they do. A second lane under one task id was not built: about 150 places key engine work by the task. `qa/selftest-298e.mjs`.

### P-390 — one slow lane at the head held fourteen quick ones; tagged lanes waited three days · fixed 2.98
- **Evidence:** "class full, cap 8; 19 wait (14 skip, 5 full)": the quick lanes waited about two hours behind one. Two tag groups waited since 21 November while the queue sat empty overnight.
- **Fix:** `batchSkipFirst` (4): the skip batch goes first, a full head is passed over twice at most. `tagsWhenIdle` (on): with no untagged lane waiting, the oldest tag group gets its own train, before any full run. `qa/selftest-298b.mjs`.

### P-391 — the main tool was marked out for four days from a session that never reached the model · fixed 2.98
- **Evidence:** one output line with all-zero usage marked the tool out until 28 November while other sessions on it ran fine.
- **Fix:** a mark needs a session that reached the model, or a second stop within 15 minutes; the window is the text's own, else 5 hours, a week only when the text says so; the status says what is marked and what is only suspected. `qa/selftest-298f.mjs`. A real limit now costs one extra failed start.

### P-392 — agy could not write in its own engine worktree; the pool started engine tasks as builders · fixed 2.98 (untested on the real tools)
- **Evidence:** an engine porter on agy ended "denied the command, write_file"; `--pool api --task <engine task>` took role `builder` and ended in 30 seconds.
- **Fix:** write rules for a session's lane copy and engine worktree only; five read-only git verbs on the worktree with plain-word arguments; the pool takes the task's role. `qa/selftest-298f.mjs`. The older `log`/`diff` rules still let `--output` through: open.

### P-393 — disk filled with landed lane copies; the size shown was hours old · fixed 2.98 (pruning off until set)
- **Evidence:** free disk fell to 48 GB twice; "lane copies 41.9 GB" stood for ten hours while the folder held 133 GB (a capped walk, cached). A cancelled train left its rules checkouts, 1.3 GB each.
- **Fix:** `disk.pruneUnderGb`: landed, clean, idle copies go, oldest first, each with its reason; the size is measured when shown and carries its age; `train cancel` removes its checkouts. `qa/selftest-298g.mjs`. A train that is killed still leaves them to the 24-hour pass.

### P-394 — a session's record could be read half-written, and its name looked free · fixed 2.98
- **Evidence:** the online run of 2.97 on main, Windows: `293b` "pool" handed a third start the name of a running session. Nine writers rewrote the record in place.
- **Fix:** one atomic writer and one patch helper; a record that exists but cannot be read counts as busy. `qa/selftest-298h.mjs`. Six other modules still read a record with a plain read.

## Older problems (one line each; the full entries are in git history: git log -p -- studio/logs/PROBLEMS.md)

- **P-001** (reopened on purpose 2026-10-31: the owner made the harness and the game's repository public so the online checks run free; they go private again once their checks pass (Hatch decides)): The harness repo is public, and two old public copies exist
- **P-002** (fixed 2026-10-31 (2.47, U-001)): The harness works with one adopted game repo; a studio can have two (web + Unity)
- **P-003** (fixed 2026-10-31): Engine template copy skipped every file on Windows
- **P-004** (fixed 2026-10-31 (2.52, U-003; root cause unproven)): The 2.41 "two greens" selftest failed once on CI timing
- **P-006** (fixed with a workaround): The game's code can't run outside Vite (import.meta.glob)
- **P-007** (fixed): Tests that force random rolls by replacing Math.random stopped working
- **P-008** (fixed 2026-10-31): The public guard's hooks folder switched off Git LFS's hooks
- **P-010** (worked around 2026-10-31 (repo public again, online checks green on #22 to #31); comes back if it goes private without the self-hosted runner): The private harness's online checks won't start (billing)
- **P-011** (fixed with a workaround): The web rules use structuredClone, which an embedded JS engine (Jint) lacks
- **P-012** (fixed 2026-10-31): Unity Hub showed an active Personal licence but no Unity_lic.ulf existed
- **P-013** (fixed in the Unity repo (PR #4, merged 2026-10-31)): GameCI refused to build: "Branch is dirty"
- **P-014** (fixed (in 2.53, PR #22)): Selftest 249 failed once the real logs were merged
- **P-015** (workaround): A URP sample icon shows as changed in every clone
- **P-016** (kept out of the public repo): Unity wrote Hatch's account IDs into ProjectSettings.asset
- **P-017** (fixed (Unity repo PR #8, merged)): Unity CI build killed at start-up (exit 137) after restoring a cached Library
- **P-018** (rebuilt on main): The Unity-port branch was 657 commits behind the game's main
- **P-019** (fixed): main's tests steer Math.random (withSeed, spies), which the rules no longer read
- **P-020** (fixed): Creating a game took one extra Math.random roll, shifting 7 seeded tests
- **P-021** (investigated, fix is a crew task): the game's main has been red on GitHub since at least Oct 17
- **P-022** (fixed in 2.54.0 (PR #27, merged)): The watchdog stopped a 44-minute-old studio for "no task finished in 2 h"
- **P-023** (fixed in 2.54.0 (PR #27, merged)): Planning sessions count as "sessions that ran" for the idle stop
- **P-024** (fixed in 2.54.0 (PR #27, merged)): Two "director-1" sessions started at the same moment
- **P-025** (fixed in 2.54.0 (PR #27, merged)): A docs task was started with a file scope in a folder the game forbids
- **P-026** (fixed in 2.54.0 (PR #27, merged)): The Producer pre-approved Godot tools for a web/Unity game
- **P-027** (fixed in 2.54.0 (PR #27, merged)): The launcher started one more agent in the same pass that stopped the studio
- **P-028** (fixed in 2.55.0 (PR #29, merged)): A stale session record under the same name took a fresh claim away
- **P-029** (caught before it ran): I wrote a force-push into a background merge command
- **P-030** (fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)): `npm run onboard -- --sync --dry-run` applies and commits anyway
- **P-031** (fixed in 2.55.0 (PR #29, merged); tested on Windows 2026-10-31 by grokbot in a fresh clone: Node v24.14.0, commit 3eb0cf2, `EXIT 0`, no "*.tsx" or "No inputs were found" error (2026-10-31, opus-1)): `npm run hub:build` type check fails on Windows (`*.tsx` not expanded)
- **P-032** (fixed in 2.55.0 (PR #29, merged) (2026-10-31, opus-1)): An unchosen pace lets the Director auto-start agents
- **P-033** (fix in T-026 (2026-10-31, opus-1)): Game: `src/branding/Finance.tsx` and `finance.ts` clash on Windows
- **P-034** (fixed 2026-10-31): The Unity folder on Hatch's PC had a pre-merge rules file
- **P-035** (workaround): Screen control can't see the Unity Hub window
- **P-036** (fixed (Unity repo PR #11, PU-21); in-editor run UNTESTED): Unity's replay tests don't play the rules
- **P-037** (fixed in 2.57.0 (PU-16)): An empty lock file makes a task unclaimable
- **P-038** (fixed in 2.57.0 (PU-16; re-run by hand: 10 started, 10 locks, 10 on the board, 5 rounds)): Ten starts at once leave the board wrong
- **P-039** (fixed in 2.57.1 (PU-17 rework; real-Windows PowerShell path proven only by Windows CI)): `agent stop` can kill an unrelated program
- **P-040** (fixed in 2.57.0 (PU-18; re-run by hand with random values)): The secret scan misses the crew's own kind of token
- **P-041** (fixed in 2.57.0 (PU-16)): Lost writes and a stop that fails open (leads, partly re-checked)
- **P-042** (fixed in 2.57.0 (PU-19; wording UNTESTED against a live limit)): Some usage-limit messages aren't recognised
- **P-043** (fixed in 2.58.0 (part B: the land lock retries EPERM/EACCES/EBUSY)): A Windows land-lock selftest flakes with EPERM
- **P-044** (fixed in 2.58.2 (the check waits for the page state; `--only stop-pause --repeat 30` passed 30/30 under load and with refreshes 4.5 s late, where the old logic got 0/10)): The HUD "Stop ends it and hands its task back" check flakes on main
- **P-045** (fixed in 2.57.1 (rework: no process call at launch or in listings; a stop during start-up stops the launcher)): The first PU-17 fix regressed agent sessions on Windows
- **P-046** (fixed in 2.58.0 (PU-33)): A token can still be committed: the commit hook scans the file on disk, not what is staged
- **P-047** (fixed in 2.58.0 (PU-34)): A stale or hand-edited verify record can close a task
- **P-048** (fixed in 2.58.0 (PU-35)): A game's own check settings aren't protected
- **P-049** (fixed in 2.58.0 (PU-36)): Text planted in tasks, notes and pitfalls reaches agents' prompts unmarked
- **P-050** (fixed in 2.58.0 (PU-39)): A silent agent whose process is alive holds its slot and task forever
- **P-051** (fixed in 2.58.0 (PU-40)): A usage limit on a custom-command agent doesn't stop the next launch
- **P-052** (fixed in 2.58.0 (PU-37)): `task done` killed between its two board writes makes the task vanish
- **P-053** (fixed in 2.58.0 (PU-37)): `task done` killed after the board write leaks the claim; nothing recovers it
- **P-054** (fixed in 2.58.0 (PU-37)): A watcher requeue can release a claim made a moment earlier: two agents on one task
- **P-055** (fixed in 2.58.0 (PU-37)): An error in `task start`'s board step leaks the claim (EPERM on Windows)
- **P-056** (fixed in 2.58.0 (PU-38)): A slow but live lock holder loses the lock after 10 s, and an update is lost
- **P-057** (fixed in 2.58.0 (PU-37)): Hand-added board lines in a slightly different format are deleted without a word
- **P-058** (fixed in 2.58.0 (PU-41)): When the events log rolls over (25 MB), readers lose the task history
- **P-059** (fixed in 2.58.0 (PU-41)): `metrics` slows down with the square of the event count
- **P-060** (fixed in 2.58.0 (PU-42)): Temp files left by a killed write pile up outside `.studio/locks`
- **P-061** (fixed in 2.58.0 (part A)): The size-growth done-check measures from the task's start, so merges from main count as the task's growth
- **P-062** (fixed in 2.58.0 (part F; games add *.snap text eol=lf)): On Windows, `verify` rewrote the line endings of a game test snapshot (`*.snap`), dirtying main
- **P-063** (fixed in 2.58.0 (part A: chore type)): Build, toolchain and chore tasks are asked for a regression that fails on the old code
- **P-064** (fixed in 2.58.0 (part F: detached verify; UNTESTED on real Windows)): Claude Code's low-memory guard killed background verify runs four times
- **P-065** (fixed in 2.58.0 (part D: auto-start opt-in)): The hub's watcher started an unwanted Producer session
- **P-066** (fixed in 2.58.1): On Windows the launcher split agent arguments that contain spaces (crew P-036)
- **P-067** (fixed in 2.58.1 (owner runs it once)): agy in headless mode denies its own shell commands (crew P-037)
- **P-068** (fixed in 2.58.2 before release): PU-29's hooks gate would have failed every in-flight lane task after the upgrade
- **P-069** (fixed in 2.58.3): The Producer and Director were refused 62 times: claude's `-p` read as a profile
- **P-070** (fixed in 2.58.3): A person's stop was recorded as a crash and halted the supervisor for 5 hours
- **P-071** (fixed in 2.58.3): Lane agents couldn't read their own role and brief
- **P-072** (fixed in 2.58.3): Claims held by an agent working outside the launcher were handed to new agents
- **P-073** (fixed in 2.58.3): The watchdog ignored an unpark and parked three times at once
- **P-074** (fixed in 2.58.3): Code agents on a task with no lane worked in the main checkout (crew P-039)
- **P-075** (fixed in 2.58.3): Files left on the main checkout blocked unrelated tasks for 3 hours
- **P-076** (fixed in 2.58.3): Done-check fixes from the crew's P-041, P-034 and P-035
- **P-077** (changed in 2.58.3): agy permissions: exact commands only, and a session settings file exists (crew P-037 addendum)
- **P-078** (added in 2.58.3): No coding agent could use the NVIDIA NIM key (crew P-040)
- **P-079** (kickoff note in 2.58.3): Agents lost turns to chained shell commands
- **P-080** (fixed in 2.58.3): Rescues escalated while nothing could pick them up
- **P-081** (fixed in 2.58.4): "Fails before the fix" passed when the old code never ran
- **P-082** (fixed in 2.58.4): A studio game with its own checks left a real cartridge with no gates
- **P-083** (added in 2.58.4): One global tick budget for every cartridge
- **P-084** (fixed in 2.58.5): The hooks gate crashed with ERR_STRING_TOO_LONG (crew report H-7)
- **P-085** (fixed in 2.58.5): `task done` re-ran the game's checks and timed out under load (crew report H-3)
- **P-086** (fixed in 2.58.5): The 2.58.2 upgrade's stash dropped board entries (crew report H-4)
- **P-087** (fixed in 2.58.5 (the key itself is Hatch's to make)): "No owner key" notes didn't say how to make one (crew report H-11)
- **P-088** (fixed in 2.58.5): The weakened-tests seed rule flagged loops over seeds
- **P-089** (fixed in 2.58.5): Crew builders took built-but-unlanded tasks when a claim lapsed (crew report H-5)
- **P-090** (fixed in 2.58.5 (launcher part planned)): A crew builder locked a whole source folder for an hour (crew report H-10)
- **P-091** (fixed in 2.58.5): The lock gate blocked `git merge main` in a lane (crew report H-6)
- **P-092** (fixed in 2.58.5 (per-agent key planned)): A custom tool command got no lane copy and edited the main checkout (crew report H-9)
- **P-093** (fixed in 2.58.5 (untested on real agy)): agy launches failed on Windows: "unexpected argument" (crew report H-2)
- **P-094** (fixed in 2.58.5): `allow agy` wrote 30 rules where 16 were approved (crew report H-2b)
- **P-095** (fixed in 2.58.5): `--tool nim` ran the role's model, and its default was end-of-life (crew report H-1)
- **P-096** (fixed in 2.58.5 (untested against real aider)): `--tool nim` child got no Authorization header (crew report H-8)
- **P-097** (fixed in 2.58.5): A session making its lane copy didn't count against the role's cap
- **P-098** (added in 2.59.0): Serial landing forced rebases and repeated verifies (brief #1)
- **P-099** (fixed in 2.59.0): A fixed 600 s game-check timeout failed under load (brief #2)
- **P-100** (fixed in 2.59.0): A clean rebase invalidated hook stamps (H-13)
- **P-101** (fixed in 2.59.0): Studio-Task listed every task the agent held (H-12)
- **P-102** (fixed in 2.59.0): Bug tasks with no cartridge coverage couldn't close; retitling was the only way out (brief #5)
- **P-103** (fixed in 2.59.0): Lanes ran their own stale copy of the harness (brief #6)
- **P-104** (fixed in 2.59.0): The launcher held too-broad lane locks (brief #8)
- **P-105** (fixed in 2.59.0): Heavy jobs overlapped on one machine (brief #11)
- **P-106** (fixed in 2.59.0): A second full verify ran beside the first (brief #11)
- **P-107** (fixed in 2.59.0): Agents started with almost no free memory (brief #11)
- **P-108** (added in 2.59.0): No supported way to give one agent its own API key (brief #14)
- **P-109** (added in 2.59.0): Clearing a halted supervisor needed the hub token (brief #15)
- **P-110** (added in 2.59.0): No gate for the Unity engine track (brief #16)
- **P-111** (fixed in 2.59.0): Render tasks on a non-Godot game couldn't produce their visual proof
- **P-112** (changed in 2.59.1): Owner-only commands refused agents even with the owner's direct permission
- **P-113** (fixed in 2.60.0): Stale pins blocked parallel lanes (crew 2.60 #1)
- **P-114** (fixed in 2.60.0): A red train guessed its culprit ("the last one waits")
- **P-115** (fixed in 2.60.0): The train handled deferred lanes twice
- **P-116** (fixed in 2.60.0): Barrel import lines conflicted on every landing (crew #2c)
- **P-117** (fixed in 2.60.0): The size rule forced every lane onto one line (crew #2a)
- **P-118** (fixed in 2.60.0): Nobody saw shared-line conflicts coming (crew #2b)
- **P-119** (fixed in 2.60.0): Upgrade commands arrived with the upgrade, and the documented merge was refused (crew #3)
- **P-120** (fixed in 2.60.0): The hooks gate failed on the harness's own unmerged commit (crew #4)
- **P-121** (fixed in 2.60.0): Killing a landing loop left verify and vitest running on Windows (crew #5)
- **P-122** (fixed in 2.60.0): A guessed task id got a lane copy and a stale key (crew #6)
- **P-123** (fixed in 2.60.0): Per-test timeouts tripped under load (crew #6)
- **P-124** (fixed in 2.64.0): A game check's timeout didn't scale on Windows (B-17)
- **P-125** (fixed in 2.64.0): `--tool nim` couldn't find aider in the studio's venv (B-18)
- **P-126** (fixed in 2.64.0): The default NIM model returned 404 for the crew's key (B-19)
- **P-127** (fixed in 2.64.0): aider pulled harness files into its chat and printed terminal warnings (B-20, B-21)
- **P-128** (fixed in 2.64.0): A failed NIM session left no evidence (B-37)
- **P-129** (fixed in 2.64.0): A board-only commit restarted the train's verify (B-29)
- **P-130** (fixed in 2.64.0): The hook-stamp check and restamp judged against different bases (B-30, B-32)
- **P-131** (fixed in 2.64.0): Merging main into a lane asked for a Golden-Reason (B-31)
- **P-132** (fixed in 2.64.0): task done --train named a check the train covers as its reason (B-33)
- **P-133** (fixed in 2.64.0): Unity builds ran outside machine:heavy (B-35)
- **P-134** (fixed in 2.64.0): Owner-reclassified render tasks still needed a visual result (B-38)
- **P-135** (fixed in 2.64.0): Rescue tasks piled up for lanes parked on purpose (B-39)
- **P-136** (fixed in 2.64.0): A lane's edit to studio config landed in main (B-40)
- **P-137** (fixed in 2.64.0): The Unity land gate could land main into itself, guessed its folder, and called exit 3 busy (B-41)
- **P-138** (fixed in 2.64.0): Agent-written lessons reached planning prompts unreviewed
- **P-139** (fixed in 2.64.0): A tier C lane could skip its hold through the old landing path
- **P-140** (fixed in 2.65.0): The crew orchestrator rebuilt lane state, refreshed lanes, wrote status posts and polled logs by hand
- **P-141** (fixed in 2.65.0): A train conflict was found only after its verify started (B-34)
- **P-142** (fixed in 2.65.0): Task order lived in prompts, not in the train
- **P-143** (fixed in 2.65.0): A lane couldn't carry studio config (B-40)
- **P-144** (fixed in 2.65.0): Routine questions waited for the owner
- **P-145** (fixed in 2.65.0): A session that never started, or a lane holding another lane's work, went unnoticed
- **P-146** (fixed in 2.65.0): Any chat author could make a trigger respond
- **P-147** (fixed in 2.65.0): Visual proofs sat at the edge of their noise; a full verify's gates could leave Windows orphans
- **P-148** (fixed in 2.65.1): A game check near its base timeout never printed why, and never got a floor (B-17, 2.65.1 hitlist #1)
- **P-149** (fixed in 2.65.1): `npm run lanes` and the queue disagreed on conflicts
- **P-150** (fixed in 2.65.2): cache writes priced as plain input
- **P-151** (fixed in 2.65.2): scorecard counted cache reads at full weight by default
- **P-152** (fixed in 2.65.2): OpenAI-format cached tokens counted as fresh input or twice
- **P-153** (fixed in 2.65.2): example-sim allowed two entities with one id
- **P-154** (fixed in 2.65.3): a red merge train took over an hour to find the lane that broke it (B-43)
- **P-155** (fixed in 2.65.3): Unity Hub's background `Unity.exe ... serve` counted as an editor outside the lock (B-44)
- **P-156** (fixed in 2.66.0): the scorecard counted landings, not tokens that did work
- **P-157** (fixed in 2.66.0): no generated-input testing
- **P-158** (fixed in 2.66.0): hand-backs lost which files changed; permission denials were never read
- **P-159** (fixed in 2.66.0): gate failures had no next step; about 400 settings, 226 undocumented
- **P-160** (fixed in 2.66.0): a list that silences a check had no guard
- **P-161** (fixed in 2.67.0): a stacked chain that passes only with one more fix was bisected apart
- **P-162** (fixed in 2.67.0): every owner action by an outside agent cost an owner round-trip
- **P-163** (fixed in 2.67.0): `--help` ran the command (B-47)
- **P-164** (fixed in 2.67.0): seeded tests silently on shared Math.random (B-48/B-45)
- **P-165** (fixed in 2.67.0): every lane went stale after an upgrade (B-49); a hold commit restarted a train's verify (B-29)
- **P-166** (fixed in 2.67.0): the scorecard couldn't see the orchestrator; no prices; tiers n/a; a stale halt; UTC days
- **P-167** (fixed in 2.67.1): no checks on asset work at landing, and nothing queued the engine wiring
- **P-168** (fixed in 2.67.1): no single asset flow; the studio's own library was never searched first
- **P-169** (fixed in 2.67.1): fresh Unity copies re-imported Library (~10 min); one flaky Play Mode test turned the gate red; code checks waited behind another lane's editor
- **P-170** (fixed in 2.67.2): a refused verify read as red main (B-50)
- **P-171** (fixed in 2.67.2): `task hold` didn't keep a lane out of a train
- **P-172** (fixed in 2.67.2): sessions ended with no work and were relaunched blindly
- **P-173** (fixed in 2.67.2): the "Regression saved" refusal was vague
- **P-174** (fixed in 2.68.0): the harness didn't know the machine it ran on
- **P-175** (fixed in 2.68.0): the RAM floor never tripped on Windows
- **P-176** (fixed in 2.68.0): heavy work ignored the machine's size
- **P-177** (fixed in 2.68.0): sessions burned with nothing landed; hopeless runs weren't flagged
- **P-178** (fixed in 2.68.0): usage ran out at the wall
- **P-179** (fixed in 2.68.0): temporary files piled up
- **P-180** (fixed in 2.68.0 (and 2.67.1/2.67.2)): a halt was lost when --until came first
- **P-181** (fixed in 2.69.0): a train re-ran a full verify a lane had just passed
- **P-182** (fixed in 2.69.0): slow tests sat on every landing
- **P-183** (fixed in 2.69.0): a red train searched one prefix at a time on an idle machine
- **P-184** (fixed in 2.69.0): trains waited for someone to start them
- **P-185** (fixed in 2.69.0): a flaky test looked like a broken lane
- **P-186** (fixed in 2.69.0): overlapping tasks were found only at merge; the queue ran dry; upgrades waited
- **P-187** (fixed in 2.69.0): overlap advice hid a failed start and kept an expired claim alive
- **P-188** (fixed in 2.70.0): the GPU sat idle while GPU-type jobs queued behind CPU verifies
- **P-189** (fixed in 2.70.0): no playable build after a landing
- **P-190** (fixed in 2.70.0): Unity runs repeated work
- **P-191** (fixed in 2.70.0): asset previews landed with no one looking
- **P-192** (fixed in 2.70.0): lane copies filled the disk unseen
- **P-193** (fixed in 2.71.0): owner decisions had no single record and no autonomous path
- **P-194** (fixed in 2.71.0): status and what's-next were posted by hand
- **P-195** (fixed in 2.71.0): builder briefs drifted from the rules; research had no shape
- **P-196** (fixed in 2.71.0): workarounds of the harness were recorded only in the overseer's notes
- **P-197** (fixed in 2.71.1): a lane could edit the gate runners that judge it
- **P-198** (fixed in 2.71.1): test configs, setup files and .npmrc were open
- **P-199** (fixed in 2.71.1): skipIf(CI), early returns on CI and a proxied expect weren't weakened tests
- **P-200** (fixed in 2.71.1): gate-weakening env overrides worked inside a lane
- **P-201** (fixed in 2.71.1 (partly)): hand-written or dirty-tree verify records were reused
- **P-202** (fixed in 2.71.1): NODE_OPTIONS, git replace and quoted paths fooled the gates
- **P-203** (fixed in 2.71.1): locks, output floods, untracked session costs, no rollback
- **P-204** (fixed in 2.72.0): a red golden said only "hash differs"
- **P-205** (fixed in 2.72.0): every game red was "game"
- **P-206** (fixed in 2.72.0): timeouts under load blamed the lane
- **P-207** (fixed in 2.72.0): standing purity hits drowned new ones; nothing stopped new hits
- **P-208** (fixed in 2.72.0): a game check couldn't prove it can fail
- **P-209** (fixed in 2.72.0): patch loops on the same red
- **P-210** (fixed in 2.72.0): engine gates could pass without proof
- **P-211** (fixed in 2.72.0): contract items went unseen; the same red was re-diagnosed from scratch
- **P-212** (fixed in 2.72.0): game logic was written again per game; CI was one long serial run
- **P-213** (fixed in 2.73.0): no check before or after a big harness update
- **P-214** (fixed in 2.73.0): upgrades made no measurable claims and had no clean "before"
- **P-215** (fixed in 2.73.0): the overseer's stages existed only on paper
- **P-216** (fixed in 2.73.0): a lucky week could suggest L3; autonomous work was reviewed only by choice
- **P-217** (fixed in 2.73.0): every task used the same model tier
- **P-218** (fixed in 2.73.0): a forged record + run log was reused; an author could release its own golden re-record
- **P-219** (fixed in 2.73.1): the crew stopped three times in an hour waiting for owner-only actions
- **P-220** (fixed in 2.73.1): builders were ended mid-verify by the stall watchdog
- **P-221** (fixed in 2.73.1): two same-second deaths halted the studio and its train
- **P-222** (fixed in 2.73.1): an agent name in the studio's .env made the owner's terminal an agent
- **P-223** (fixed in 2.73.1): empty folders in .lanes counted as lanes
- **P-224** (fixed in 2.73.1): restarting the studio took the owner 2.5 h
- **P-225** (fixed in 2.73.1): console windows flashed for every process on Windows
- **P-226** (fixed in 2.73.2): tests failed on time alone when the harness ran many test workers
- **P-227** (fixed in 2.73.2): main red on a check deadlocked every train, the fix included
- **P-228** (fixed in 2.73.2): Unity started short of memory; its abort was recorded as FAIL
- **P-229** (fixed in 2.73.2): a stalled session was "ended" again and again and still listed STALLED
- **P-230** (fixed in 2.73.2): .env changes reached only new processes
- **P-231** (fixed in 2.74.0): the War Room's buttons failed on a refused hub token
- **P-232** (fixed in 2.74.0): the hub kept dropping
- **P-233** (fixed in 2.75.0): the Studio floor was cluttered with cut-off names and agents long gone
- **P-234** (fixed in 2.76.0): every permission step waited on the owner during the beta
- **P-235** (fixed in 2.76.0): nobody kept the line moving or reported it
- **P-236** (fixed in 2.76.0): green lanes dropped, dead trains unrecorded, mixed lanes trained
- **P-237** (fixed in 2.76.0): Gemini builders, stalls, usage and lane copies went wrong for the crew
- **P-238** (fixed in 2.76.0): every check took every core; yes-waits unnamed; divergence missed shared loaders
- **P-239** (fixed in 2.76.1): a trust-note landing left its task open
- **P-240** (fixed in 2.77.0): agy ran Claude, logged 0 tokens, and builders drifted off their task
- **P-241** (fixed in 2.77.0): trains threw away verifies and lanes missed their approvals
- **P-242** (fixed in 2.77.0): no way to use cloud workers or make a lane by hand
- **P-243** (fixed in 2.77.0): engine passes were refused at done and never trained
- **P-244** (fixed in 2.77.0): the War Room was light, long and covered its own content; the Train Room ETA was a guess
- **P-245** (fixed in 2.77.0): lanes waited in line behind one 25-minute verify
- **P-246** (fixed in 2.77.1): the supervisor exited after its first pass (exit 13, "unsettled top-level await")
- **P-247** (fixed in 2.77.1 (partly)): agy builders ended mid-task with exit 0 and the fallback never fired
- **P-248** (fixed in 2.77.1): a beta-mode approval of a config proposal was not applied
- **P-249** (fixed in 2.77.1): an update's own commits failed the hooks gate on main
- **P-250** (fixed in 2.77.1): `train leave` didn't stop the running train's checks
- **P-251** (fixed in 2.77.1): a reused agent name with a leftover lane copy idled for an hour
- **P-252** (fixed in 2.77.1): permission denials were recorded again at every session end
- **P-253** (fixed in 2.77.2): an agent that ended with no commits stalled every launch for 20 minutes
- **P-254** (fixed in 2.77.2): a speculative train still verifying was reported "died silently"
- **P-255** (fixed in 2.77.2): 2.77.1's own commits failed the hooks gate after its merge
- **P-256** (fixed in 2.77.3): beta-mode owner records were "recorded", then ignored
- **P-257** (fixed in 2.77.3): a train sat 35 minutes holding its lock after a "real" verdict
- **P-258** (fixed in 2.77.3): fixed e2e ports collided between verifies and were called flakes
- **P-259** (fixed in 2.77.3): the stall killer stopped a P0 session twice in its first minutes
- **P-260** (fixed in 2.77.3): board state that blocked launches or undid parks
- **P-261** (fixed in 2.78.0): lanes could not be refreshed after a harness upgrade
- **P-262** (fixed in 2.78.0): a timing test failed "alone" under load and finished work was handed back
- **P-263** (fixed in 2.78.1): ready tasks without a lane ran one at a time
- **P-264** (fixed in 2.78.1): agy refused the stream input, and the failover was refused
- **P-265** (fixed in 2.78.1): the owner's hooks approvals never verified on the main checkout
- **P-266** (fixed in 2.78.1): an old train chain-started on the new harness
- **P-267** (fixed in 2.78.1): Unity and game trains starved each other
- **P-268** (fixed in 2.78.1): work that had landed kept tasks open or waiting
- **P-269** (fixed in 2.78.2): trains died with the builder that started them
- **P-270** (fixed in 2.78.2): one red result cost 1–2 hours
- **P-271** (fixed in 2.78.2): green trains were re-verified after unrelated commits to main
- **P-272** (fixed in 2.78.2): quarantined tests ran anyway, and re-checks ran the whole suite
- **P-273** (fixed in 2.78.2): an uncommitted beta approval passed the protected check
- **P-274** (fixed in 2.79.0): every task landed green while the game's first minutes were broken
- **P-275** (fixed in 2.79.0): queued lanes lost their copy at session end (2.78.2 regression)
- **P-276** (fixed in 2.79.0): `train auto off` didn't stop a train
- **P-277** (fixed in 2.79.0): a passing note with the word "protected" re-held a task
- **P-278** (fixed in 2.79.0): a reused PID read as a live record
- **P-279** (fixed in 2.79.0): the owner had to sign by hand in beta mode
- **P-280** (fixed in 2.79.0): asks reposted after they were acted on
- **P-281** (fixed in 2.79.1): Vertex credit couldn't carry builder work
- **P-282** (fixed in 2.79.1): one blocked task froze the whole builder line
- **P-283** (fixed in 2.79.1): an engine land waited 60 min for RAM and was refused
- **P-284** (fixed in 2.79.1): a Golden-Reason line under the subject wasn't a trailer
- **P-285** (fixed in 2.79.2): Vertex builders spent money and did no work
- **P-286** (fixed in 2.80.0): a stale machine scan made a good train red
- **P-287** (fixed in 2.80.0): a lock outlived its owner's session
- **P-288** (fixed in 2.80.0): "everything off" still started paid builders
- **P-289** (fixed in 2.80.0): the train daemon re-ran the same lanes on a red main
- **P-290** (cut in 2.80.0): the War Room was the largest part nobody used
- **P-291** (measured from 2.81.0): nobody could say how well the studio runs, round over round
- **P-292** (fixed in 2.81.0 (record mode)): tasks were relaunched against a blocker that had not changed
- **P-293** (fixed in 2.81.0): the overseer's role was spread over five files, and 2.80 refused its lock release
- **P-294** (fixed in 2.81.0): 71 private copies of "read a JSON file", and almost none skipped a byte-order mark
- **P-295** (fixed in 2.82.0): engine failures that need no editor were found by hour-long land runs
- **P-296** (fixed in 2.82.0): the harness could not see where a land run's time went
- **P-297** (fixed in 2.82.0): a studio whose game is the engine build still paid for the web path
- **P-298** (fixed in 2.82.0 (found by 2.81.0's checks)): the attempt ledger recorded no main tip on Windows
- **P-299** (fixed in 2.82.0 (before release)): the rules check's kept result did not know its git-ignored inputs
- **P-300** (fixed in 2.82.0 (before release)): the porter's own check ran the rules command where its inputs were not
- **P-301** (fixed in 2.83.0): an engine task's session was scored in the wrong repository
- **P-302** (fixed in 2.83.0 (the overseer's B-124)): `npm run engine -- rules` exited 13 without running
- **P-303** (fixed in 2.83.0): the plan reported itself blocked 166 times for two causes
- **P-304** (fixed in 2.83.0): the rules check ran every test for every batch
- **P-305** (fixed in 2.83.0): the engine train blamed by elimination
- **P-306** (fixed in 2.83.0): a task was closed on its studio half
- **P-307** (fixed in 2.83.0 (the overseer's B-127)): the land run's shortcuts could hide a difference between two runtimes for good
- **P-308** (fixed in 2.83.0 (the overseer's B-128)): a landed change to the land script changed nothing
- **P-309** (fixed in 2.83.0 (the overseer's B-126)): a model-pool route overrode every role's own model
- **P-310** (fixed in 2.83.0): the owner was asked in person about removing code
- **P-311** (fixed in 2.83.0): board commands that did something else than asked
- **P-312** (fixed in 2.83.0): landed engine worktrees and old builds filled the disk
- **P-313** (fixed in 2.83.0): watchers that cried wolf
- **P-314** (fixed in 2.84.0): planning sessions were started on a timer, whatever the last one did
- **P-315** (fixed in 2.84.0): a session could make the same-family review fallback apply to itself
- **P-316** (fixed in 2.84.0): the documents cost more to read than the code they describe
- **P-317** (worked around in 2.84.0): the Unity test runner's floating tag cannot activate a Personal licence
- **P-318** (fixed in 2.84.0): the engine train's evidence never saw a crew's results
- **P-319** (mitigated in 2.84.0): The rules check took 12.7 GB on a 17-branch batch
- **P-320** (fixed in 2.84.0): A reviewer planned on another family's model was started with the wrong tool, and two crashes halted the supervisor
- **P-321** (fixed in 2.84.0): The overseer was refused decisions beta mode had given it
- **P-322** (fixed in 2.84.0): A start refused for a full crew put the task to sleep for up to 30 minutes
- **P-323** (fixed in 2.84.0): Every verify ran every gate
- **P-324** (measured again in P-325): 2.83 was projected to raise the engine pass rate and did not
- **P-325** (fixes in 2.85.0, not measured): 2.84 landed nothing without an overseer step
- **P-326** (fixed in 2.85.0): A task waiting in a train queue was handed back for "no running session"
- **P-327** (fixed in 2.85.0): `task done` from the main checkout judged other roles' commits
- **P-328** (fixed in 2.85.0): A game-rules question was refused as the owner's only
- **P-329** (fixed in 2.85.0): The daily full land run was invisible and blamed its branches
- **P-330** (fixed in 2.85.0): The web train's automatic mode stayed off for a week
- **P-331** (lesson): The maintainer's inventory overstated what could be cut
- **P-332** (fixed in 2.86.0, not measured): A running supervisor kept the old code after an upgrade
- **P-333** (fixed in 2.86.0): Hand-written rules map entries never matched
- **P-334** (fixed in 2.86.0, not measured): One listed flaky test cost an engine train 6.5 hours
- **P-335** (fixed in 2.86.0): The 2.85 refresh rule handed off sessions that had done nothing
- **P-336** (caught before release): The dead-code tool's first file list missed a hook
- **P-337** (caught by the online checks): A name defined nowhere, in a branch no new check took
- **P-338** (caught before release): The disk stop used the warning's level and stopped a small test machine
- **P-339** (fixed in 2.86.1): 2.86.0 threw away a daily full run whose land script records every run on the target
- **P-340** (lesson): The maintainer told the owner the harness kept no record of the commands a studio runs
- **P-341** (lesson): Line estimates for shared helpers were 4 to 10 times too high
- **P-342** (fixed 2026-11-16 (2.88)): Reports disagreed on which tasks landed
- **P-343** (fixed 2026-11-16 (2.88)): A file that must load alone was given a shared import
- **P-344** (lesson): A check's failure was hidden by a pipe
- **P-345** (fixed 2026-11-16 (2.90)): The rules check judged nobody for two days and nobody saw it
- **P-347** (fixed 2.90): A rule added after the last local run broke a 2.85 check, and a Windows path
- **P-348** (fixed 2.91): Periodic full runs went ahead of a waiting batch
- **P-349** (fixed 2.91 (needs one setting)): A record commit cost the batch its "rules are green"
- **P-350** (fixed 2.91): The idle stop halted a studio whose work waited on a train
- **P-351** (fixed 2.91): Two stops, and neither resume command named the other
- **P-352** (fixed 2.91 (bounded)): A session reading its task's files was ended as stalled
- **P-353** (process): The maintainer removed test scratch folders while other builds were running
- **P-354** (fixed 2.92): compile clashes were found only when the train started
- **P-355** (fixed 2.92): the check before queueing judged the branch alone
- **P-356** (fixed 2.92): a red compile in the engine's own log sent the search to the wrong branch
- **P-357** (fixed 2.92): a target red by itself was nobody's task
- **P-358** (process): the maintainer planned a tool the harness already had, and gave a wrong setting in a note
- **P-359** (fixed 2.92): a path taken from a URL broke the red-target task on Windows
- **P-360** (fixed 2.93): a compile command that outlived its time limit kept running on Windows
- **P-361** (fixed 2.93): every engine train ran its rules check twice
- **P-362** (fixed 2.93): a rules run started outside the train took the memory a land run needed
- **P-363** (fixed 2.93, 2.98): the API pool and agy could not do engine work (see P-392)
- **P-364** (fixed 2.93): a queued branch could not be held, marked a slice or closed as a duplicate
- **P-365** (process): a cleanup removed a folder that other checkouts linked to
- **P-366** (fixed 2.93): the time-limit wrapper started two processes without the hidden-window option
