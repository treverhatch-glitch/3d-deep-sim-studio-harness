# 2.79 cleanup audit (`docs/CLEANUP-2.79-AUDIT.md`)

The read-only step (b) of the 2.79 cleanup (`studio/logs/PROPOSALS.md`, "Planned: 2.79", PU-64 to PU-68). Nothing in
this step changes behaviour: it says which questions the harness answers in more than one place, what is dead, how the
six largest modules split, and in what order to do the work.

**Base.** Branch `claude/279-audit` at `c624c79` (2.79 (a), the census tools) on `ff4d318`. That base has 2.78.1
parts (a), (b), (c), (e), (f) and (g) but **not part (d)** (`f1031e9`) or the 2.78.1 release commits (`10fdb1f`,
`904ce7f`): no `harness/landed-content.mjs`, no `handout.mjs depLanded`, no `docs/RELEASE-2.78.1.md`. Line numbers
are this base's. Those marked **[2781]** are read from `claude/2781`. Step 0 below rebases first.

**How it was measured.** Greps and line ranges, plus two scratch scripts (not committed): an import/mention graph over
`harness/`, `scripts/`, `hub/`, `qa/`, `tools/`, `cartridges/` (an export counts as used by a file that names its
module and the export as a word, so namespace imports such as `h.heavyHolders` count), and a declaration splitter that
assigns each top-level function to a proposed part and reports the imports between parts and any cycles. Inputs: the
census and size reports of 2.79 (a) (`scripts/settings-census.mjs`, `scripts/size-report.mjs`) and the release notes
of 2.77.3, 2.78.0 and 2.78.1.

---

## 1. Decision owners (PU-65)

### Ranking

Risk = how often the crew hit the class (bugs named in 2.77.3 to 2.78.1) × how many readers there are today. The
"single reader" gate in section 4 names the raw files each owner should be the only one to read.

| # | Question | Crew bugs in the class | Readers today | Can disagree now? | Owner |
|---|---|---|---|---|---|
| 1 | Is this approval valid (owner key, beta, proxy)? | B-97, B-104, C3/B-111, B-120, grandfather merges | 9 key readers, 5 validity predicates | **Yes**, incl. an uncommitted beta record (below) | new `harness/owner-key.mjs` + `beta-mode.betaRecordCommitted` |
| 2 | Is this task free to start / in progress / in a train? | B-39, P9.2, B-113/H3, B-115, B-121, H5 | 6 predicates, 14 raw queue readers, 7 inline `heldNow` copies | **Yes** | `task-hold.mjs` (new `startBlock`) + a train-queue part |
| 3 | Has this task's work landed? | H4/B-114 twice, B-106 twice, partial landing, empty diff | 7 answers | **Yes** | `handout.depLanded` [2781] |
| 4 | Which lane does this task / session have? | B-84, B-113, B-123 | 4 answers + a name clash | **Yes** (stall watch) | `task-hold.laneOf` + `sessionLane` (today `supervisor.currentLane`) |
| 5 | How many heavy / engine slots, who holds them? | M6, H2/B-112, C2c, B-117 | 2 count rules, 4 holder views | **Yes** (train planner) | `heavy.mjs heavySlotsAt` / `engineSlotsAt` / `heavyHolders` |
| 6 | Is this process / session / train alive? | B-106 ×2, B-107, the 13 h orphan gate | 17 local `alive` copies + 3 shared | **Yes** (PID reuse, EPERM) | `proc-identity.pidAlive` |
| 7 | Which harness is running / did it change? | B-105, B-116, B-122 | 4 definitions of "harness files" | **Yes** | `harness-version.mjs` |
| 8 | Is this caller a person, a worker, a decider? | H5, M1, M4, B-111, B-123 (lane refusal) | 5 name lists, 7 `AGENT_SHELL` copies | **Yes** | `permission.mjs` |
| 9 | Which checkout is main / am I in a lane copy? | G12 (2.71.1), B-30 | 6 resolvers | Trust differs | `owner-proxy.mainCheckout` (git only) |
| 10 | What did the board record about task X (event window)? | B-114 (its root cause) | 94 calls at 20000 events, others from 600 to 1,000,000 | **Yes** | one `taskHistory(id)` reader in `event.mjs` |
| 11 | What is setting X's value now (`.env` live vs this process)? | B-117 | 21 modules parse `.env` | **Yes** | `dotenv.mjs` + `heavy.liveCount` pattern |
| 12 | Is this beta mode on? | B-111 | 1 reader (`beta-mode.readBeta`); the HUD caches 30 s | Barely | already owned |

The top eight by risk are 1 to 8. Each is detailed below: the question, every answer with its location, how they
disagree today, the raw files, the owner, and the callers to move.

### D1. Is this approval valid? (owner key, beta record, proxy)

**Raw files.** `studio/keys/owner-ed25519.pub.pem` at some revision, `studio/approvals/*.json`, `studio/beta.json`,
`studio/type-record.json`, git (base, local main, tips, Studio-Agent trailers).

**Which key.** Nine readers, five revision rules:

| Reader | Revision it reads | Used for |
|---|---|---|
| `reclassify.mjs:117 ownerKey` | the base, else the main checkout's committed key (B-111); memo 30 s | task type, visual, config decisions |
| `approve.mjs:197 keyFor` | the base, else local main **only if** the studio doesn't push and base ⊂ main (B-120; `STUDIO_KEY_BASE=off`) | the hooks gate (`hook-stamp.mjs:602`) only |
| `approve.mjs:109 ownerPublicKey(base)` | the base only | protected files (`approve.mjs:311`), `forceApproved` (`:332-334`), `:199`, `:208`, weakened tests (`test-weakening.mjs:294`) |
| `approve.mjs:109 ownerPublicKey(null)` | **the working-tree file** | `hook-stamp.mjs:381` (hooks approvals while stamping) |
| `owner-proxy.mjs:74 ownerPubAt` | HEAD of the main checkout | `beta-mode.mjs:65`, `:157`, `owner-proxy.mjs:92`, the `ownerKey` fallback |
| `config-proposal.mjs:196 ownerKeyAt(root, tip)` | the train's tip | `config-proposal.mjs:296` |
| `delegation.mjs:102`, `policy-rules.mjs:73` | HEAD of root, else **the working-tree file** | delegation and policy signing |
| `train.mjs:1410` (tip), `:1484` (`refs/heads/main`) | exists or not | tier and beta-held decisions |
| `upgrade-preflight.mjs:154` | its own path constant | the preflight's owner-key line |

**Which records count.** Five predicates: `approve.verifyApproval` (`approve.mjs:276`), `beta-mode.betaApprovalOk`
(`:105`), `beta-mode.betaRecordCommitted` (`:120`), `owner-proxy.proxyApprovalOk` (`:126`),
`reclassify.signedApproval` (private, about `reclassify.mjs:135`), `config-proposal.signedProposal` (`:199`).

**They disagree today:**

1. **A beta record nobody committed.** `approve.verifyApproval`'s beta branch (`approve.mjs:281-284`) asks
   `committedByAgent(doc.file)`, which returns `null` for an uncommitted file (its own comment at `:269`), and treats
   `null` as fine. `betaRecordCommitted`, the predicate 2.77.3 made "one predicate for every beta record", requires the
   record to be committed with exactly this content by a non-worker commit. So while beta mode is on, a beta-format
   file dropped (not committed) into `studio/approvals/` is refused for a task type or visual decision but accepted by
   `verifyApproval`, which judges protected files, weakened tests, hooks and `task done --force`. `readApprovals`
   (`approve.mjs:266`) also lets the JSON's own `"file"` key override the real file name. **Found by reading. A
   selftest should reproduce it before any fix. Treat it as security-relevant and give it to the owner first.**
2. **A studio that doesn't push** (the crew's case in B-120). origin/main has no key, local main has it. The hooks gate
   (`keyFor`) and type decisions (`ownerKey`) enforce with main's key. On the main checkout, where `resolveBase` can
   pick origin/main (`approve.mjs:155-170`; in a lane copy it picks the studio's branch), the protected-files check
   (`:311`) and `forceApproved` (`:334`) find no key and report "not enforced". `test-weakening.mjs:294` makes it a
   warning only. Suspected, not run: confirm with a selftest.
3. `ownerKey`'s fallback roots at `recordRoot()` → `worktree.mainRoot()` (`worktree.mjs:47`), which takes
   `STUDIO_MAIN_ROOT` as given. `gate-trust.mainRootTrust` (G12) is applied by `approve.mjs:122` and the gate runner's
   `trustedEnv`, not here. Another root-trust rule (see D9).

**Owner.** A new `harness/owner-key.mjs` with no import of `approve.mjs` (whose `:116` comment documents the
`hook-stamp` ↔ `approve` import cycle that produced the copies). It holds `ownerKeyAt({ purpose, root, base })` (one
fallback rule, chosen by the owner: B-111's or B-120's) and `approvalValid(doc, { kind, task })`, built on
`betaRecordCommitted` for beta and `proxyApprovalOk` for proxy. **Callers to move:** `approve.mjs` (199, 208, 311,
334, `verifyApproval`), `hook-stamp.mjs:381`, `:602`, `test-weakening.mjs:294`, `reclassify.mjs:117`,
`config-proposal.mjs:196`, `:296`, `delegation.mjs:102`, `policy-rules.mjs:73`, `train.mjs:1410`, `:1484`,
`upgrade-preflight.mjs:154`, `beta-mode.mjs:65`, `:157`. **The fallback rule and the beta-record rule are the
owner's call** (they decide what counts as the owner's yes). Build the single reader with the stricter rule only after
a signed decision.

### D2. Is this task free to start / in progress / in a train?

**Raw files.** `studio/task-holds.json`, `.studio/train/queue.json`, `.studio/train/<engine>-queue.json`,
`.studio/locks/train.lock` and `<engine>-train.lock`, `.studio/locks/task:*`, events (claims), `studio/NEXT.md`.

**Answers:**

- `task-hold.mjs:213 holdReason`: trunk red, rescue of a held lane, in any train (`:231-235`, only when the task is
  **not** in progress), holds, `--after` (`:244`, board "done"), cooldown.
- `task-hold.mjs:113 heldForLanding`: a hold, the web queue, then every train via `inAnyTrain` (`:132`), **but not
  when the caller passes its own `queue`** (`:124`).
- `busy.mjs:124 claimActive` (supervisor only, `supervisor.mjs:487`), and `busy.mjs:266 taskBusy` (`watchdog.mjs:177`,
  `director-flow.mjs:101`).
- `handout.mjs handoutBlock` (supervisor `:544`, `line-producer.mjs:462`, `next-board.mjs:60`, `queue-depth.mjs:46`).
- `task.mjs:453-465`, `task start`: `holdReason`, then **its own raw read** of `queue.json` (`:459`) for a task in
  progress.
- Raw train-queue readers, each with its own filter: `boot.mjs:228`, `brief-status.mjs:86`, `communicator.mjs:181`,
  `digest.mjs:54`, `heavy-budget.mjs:356`, `hotspots.mjs:104`, `line-producer.mjs:400`, `:721`, `:899`,
  `next-board.mjs:82`, `stall.mjs:475`, `task-hold.mjs:117`, `task.mjs:459`, `train-pipeline.mjs:255`,
  `war-room.mjs:102`. Owner today: `train.mjs:126 readQueue`.
- "Is this queue entry runnable": `train.mjs:1439 heldNow`, plus inline copies in `brief-status.mjs:87`,
  `communicator.mjs:183`, `digest.mjs:56`, `heavy-budget.mjs:357`, `line-producer.mjs:722`, `:899`,
  `next-board.mjs:84`. The train also leaves out task-held lanes (`train.mjs:160 taskHoldOf`, used at `:2139`).
  `heavy-budget.trainComing` (`:343-357`) doesn't, so it reserves room for lanes the train won't run.

**They disagree today:**

1. **A task in progress whose lane is in an engine queue.** `holdReason` checks the trains only for tasks not in
   progress, and `task start`'s own check (`task.mjs:459`) reads only the web queue. So another agent's
   `task start T-n` on an in-progress task in `unity-queue.json` or a live `unity-train.lock` goes ahead. That is B-121
   reached through the CLI instead of the supervisor.
2. **A dependency that is "done" but not landed.** The supervisor refuses through `handoutBlock` ("waiting on T-1:
   done, but N commits … not merged yet"). `task start`, `task next` (`task.mjs:401`), `watch.mjs:289` and
   `upgrade-preflight.mjs:299` use only `holdReason`, whose `--after` check counts any board "done", forced ones
   included. A hand-started builder takes a task the launcher holds back.
3. **The claim check.** The supervisor adds `claimActive` (an outside agent still working on an expired claim). `task
   start`, the Line Producer's plan (`line-producer.mjs:444`) and the War Room's next-board don't, so the plan shows
   "ready" for a task the supervisor won't launch.
4. **A caller with a queue in hand.** `heldForLanding(id, { queue })` skips engine trains (`:124`, on purpose), and
   nothing marks which callers rely on that.

**Owner.** `task-hold.mjs startBlock(taskId, { q, holds, role, agent, now, events })`: one answer composed of
`holdReason`, trains for in-progress tasks as `task start` needs, `handoutBlock`, and `claimActive`, each a named
reason. Plus a train-queue module (the `train-queue` part of section 3) owning `readQueue`, `readEngineQueue`,
`runnable(e)` (today's `heldNow`) and `trainOf(task)` (today's `inAnyTrain`). **Callers to move:** `task.mjs:401`,
`:453-465`, `supervisor.mjs:484-491`, `:544`, `line-producer.mjs:444`, `:462`, `next-board.mjs:56-60`,
`queue-depth.mjs:45-46`, `watch.mjs:289`, `upgrade-preflight.mjs:299`, `director-flow.mjs:92`, `:101`,
`watchdog.mjs:177`; the 14 raw queue readers and 7 inline `heldNow` copies listed above.

### D3. Has this task's work landed?

**Raw files.** Events (`task.done`, `task.train.landed`, `lane.merged`, `task.forced`, `task.reopened`), rolled event
files, `studio/DONE.md` and `NEXT.md`, `.studio/lane-branches.json`, git (branch vs main, patch ids).

**Answers:**

- `handout.mjs:31 landedOnBoard` (the last 20000 events); **[2781]** `handout.mjs:116 depLanded` (window, a rescue's
  landing, the branch bringing nothing to main via `landed-content.mjs bringsNothing`, then the whole history up to
  `STUDIO_DEP_HISTORY_MB`).
- `task-hold.mjs:84 doneIds` → `holdReason`'s `--after` (`:244`): board "done", forced included. The same raw "done"
  set in `rescue.mjs:156`, `watch.mjs:253`, `remote-workers.mjs:286`.
- `train-deps.mjs:21 boardStates` → `judgeDeps` (`:62`) and `orderByDeps` (`:82`): NEXT/DONE checkbox markers.
- `janitor.mjs:218 landedLanes`: `DONE.md` plus `lane.merged` in **the last 4 MB of the current event file only**.
  It ignores `task.train.landed`, which is how most lanes land since 2.59.
- `worktree.mjs:360 unmerged` (a commit count, the B-114 cause), used to keep or delete branches (`worktree.mjs:429`,
  `:554`, `agent.mjs:460`, `:1142`, `:1270`, `:1459`, `:1749`, `:1882`) and in `lanes.mjs:132`.
- **[2781]** the train's own "landed" closes: `task.train.main_merges_only` and `task.train.empty_diff` (via
  `landed-content.mjs`), and `lanes orphans`.

**They disagree today:**

1. A lane landed by the train and later rescued: `depLanded` says landed, `janitor.landedLanes` doesn't (no
   `lane.merged` event), and `unmerged` counts its old commits. The janitor keeps the folder; `removeLaneCopy` keeps
   the branch.
2. A forced done: `depLanded` says not landed (the dependant waits); `doneIds` says done (`task start` and `task next`
   go ahead, as in D2.2).
3. A landing older than the 4 MB tail: the janitor misses it; `depLanded` finds it in the history.

**Owner.** `handout.mjs depLanded` (once rebased onto (d)), moved with `landedOnBoard`/`closingOnBoard` into a small
`harness/landed.mjs` so `task-hold`, `train-deps` and `janitor` can import it without `handout`'s imports. **Callers to
move:** `task-hold.mjs:244`, `train-deps.mjs:62`, `:82`, `janitor.mjs:218`, `rescue.mjs:156`, `watch.mjs:253`,
`remote-workers.mjs:286`. `worktree.unmerged` stays the "may I delete this branch" check, but stops being read as
"landed".

### D4. Which lane does this task or session have?

**Raw files.** `studio/task-holds.json` (`lane`), the `task.added` event's meta (`paths`, `lane`, `part`,
`wholeGame`), `.studio/agents/<name>.json` (`lane` at launch).

**Answers:**

- `task-hold.mjs:350 laneOf`: holds → `task.added` meta → named studio paths → inferred paths → `--part`. Reads
  `readRecentEvents(20000)` by default.
- `supervisor.mjs:347 currentLane`: holds, else **the launch lane** (B-123).
- `stall.mjs:373-379 sessionScope`: **the launch lane first**, then `laneOf`.
- `lane-at-claim.mjs:39`, `lane-create.mjs:124`, `handback-facts.mjs:211`, `remote-workers.mjs:158`, `:481`,
  `lane-plan.mjs:266`, `task-overlap.mjs:69`, `:109`, `next-board.mjs:59`, `queue-depth.mjs:44`,
  `upgrade-preflight.mjs:301`: `laneOf`, each with its own events window.
- Name clash: `hook-stamp.mjs:630 laneOf(root)` answers a different question (is this checkout a lane copy).

**They disagree today:**

1. **The B-123 class, still in the stall watch.** A builder launched with lane `cartridges/x/ui`, then re-scoped with
   `task lane T-5 cartridges/x/ui,cartridges/x/hud`: the supervisor uses the new lane (`currentLane`), but
   `sessionScope` keeps the launch lane, so the drift watch (`stall.mjs DRIFT_SIGNALS`) counts its `hud` edits as
   leaving its scope.
2. **A lane that ages out.** A task added with `--paths` whose `task.added` event falls out of the newest 20000 events
   loses its lane in `laneOf` (null, the whole game) unless `task lane` wrote it to holds. A session launched earlier
   keeps it through its launch lane. The same task is "whole game" to the planner and "scoped" to the running session.

**Owner.** `task-hold.mjs laneOf` plus `sessionLane(s, holds)` (today's `currentLane`, moved next to it). `laneOf`
should read the task's `task.added` event through D10's reader, not a window. **Callers to move:**
`stall.mjs:376` (a fix, with a regression), `supervisor.mjs:495`, `:520`, and every `laneOf` caller above passing
its own events. Rename `hook-stamp.laneOf` to `laneCopyOf` (a pure rename).

### D5. How many heavy / engine slots, and who holds them?

**Raw files.** `.studio/heavy/` markers (`machine-heavy-hold-*`, train-wait and quiet-hold files), `.env` and
`process.env` (`STUDIO_HEAVY_SLOTS`, `STUDIO_ENGINE_SLOTS`), `.studio/machine.json`, train locks.

**Answers:**

- Counts: `heavy.mjs:232 heavySlotsAt` and `:242 engineSlotsAt` (live `.env`, the lower wins, B-117).
  `heavy-budget.mjs:209 slotsFor(profile, env)` (this process's env) is still called directly by
  `train-parallel.mjs:47` and `train-pipeline.mjs:94`. `heavy.mjs:210 heavySlots` is the pre-B-117 reader, dead (no
  caller) but exported.
- Holders: `heavy.mjs:263 heavyHolders`, `:813 laneCheckSlots`, `:843 implicitHolders`, `flake-quiet.mjs:11-19` (its
  own merge of the three), `heavy-budget.mjs:343 trainComing` (reads `train.lock` and `queue.json` itself),
  `self-triage.mjs:201` (removes a marker file by path).

**They disagree today.** `.env` lowered from 3 to 1 while the train daemon runs: `acquireHeavy` admits one, but the
train's parallel planner (`train-parallel.mjs:47`) and the speculative next train (`train-pipeline.mjs:94`) still size
by 3. They plan three verifies side by side that then queue one at a time, so the time limits and the "stalled"
backstop (`STUDIO_TRAIN_STALL_MIN`) fire on waits. That is B-117 one level up.

**Owner.** `heavy.mjs` (the `heavy-holders` part of section 3): `heavySlotsAt`, `engineSlotsAt`, `heavyHolders`, and
a new `machineLoad(root)` returning holders + implicit + lane checks + the train reserve. **Callers to move:**
`train-parallel.mjs:47`, `train-pipeline.mjs:94` (to `heavySlotsAt`), `flake-quiet.mjs:19`, `heavy-budget.mjs:343`,
`self-triage.mjs:201`. Delete `heavySlots`.

### D6. Is this process / session / train alive?

**Answers.** `proc-identity.mjs:117 pidAlive(pid, recorded)` checks the recorded process identity (PID reuse; used by
`supervisor.mjs:236`). `fsafe.mjs:235 pidAlive`, `train-life.mjs:38 pidAlive`, and 17 local copies of
`process.kill(pid, 0)` in `busy.mjs:35`, `communicator.mjs:67`, `janitor.mjs:84`, `merge-lane.mjs:198`,
`remote-workers.mjs:69`, `rig-budget.mjs:32`, `slow-tier.mjs:39`, `train-daemon.mjs:40`, `train-pipeline.mjs:43`,
`train-status.mjs:24`, `train.mjs:118`, `upgrade-watch.mjs:140`, `whole-game.mjs:47` (treats EPERM as dead, every other
copy as alive), `task-hold.mjs:134`, `heavy-budget.mjs`, `upgrade-preflight.mjs` and others. 20 modules in all. Higher
level: `heavy.mjs:257 holderLive` (adds staleness), `train-life` heartbeats (B-106), session files' `status`.

**They disagree today.** On Windows (the crew's PC) PIDs are reused quickly. A train lock whose holder died, with its
PID now taken by another process, is "alive" to `task-hold.inAnyTrain` (`:134`), so its lanes' tasks count as in a
train and never launch. It is "dead" to the supervisor's identity check. `whole-game.mjs` and the rest also differ on
EPERM.

**Owner.** `proc-identity.mjs pidAlive` for anything with a recorded identity; `fsafe.mjs pidAlive` (same semantics as
the copies) for bare PIDs. **Callers to move:** the 17 copies (first to `fsafe.pidAlive`, a pure move; then, where a
file records an identity, to `proc-identity`, a fix per caller).

### D7. Which harness is running, and did it change?

**Answers:** `harness-version.mjs:38 HARNESS_DIRS = ['harness', 'scripts']` (B-122 chain guard, B-116);
`hook-stamp.mjs:622 LANE_HARNESS_DIRS = ['harness', 'scripts']` (`laneHarnessDrift`, `train-refresh.mjs:23`);
`scripts/preflight.mjs:47 harnessFiles` (`harness`, `hub`, `scripts`, `tools`, `.github`, `qa`, plus `gates.json`,
`AGENTS*.md`, `package.json`: the freeze fingerprints); `agent.mjs:2183` and `task.mjs:2264`
(`harness|hub|qa|scripts`: the frozen-harness lane refusal); `train.mjs:1595 precheckChild` (looks for the text
`flags['train-check']` in a lane's `harness/task.mjs`); `upgrade-preflight.mjs:308 checkHarnessDirty`.

**They disagree today.** A merge that changes only `qa/*.mjs` (the gates run them) or `hub/`: the freeze counts it, but
the chain guard and B-116's "harness changed underneath" don't. A train process can chain on, and a re-check of main on
the new `qa/` code is blamed on main.

**Owner.** `harness-version.mjs`: one exported `HARNESS_PATHS` and `harnessChanged(was, now)`. Which set is right
(probably the freeze's) is a technical choice; `qa/` in the chain guard changes behaviour, so it gets its own selftest.
**Callers to move:** `hook-stamp.mjs:622`, `scripts/preflight.mjs:47`, `agent.mjs:2183`, `task.mjs:2264`. Also
`train.mjs:1595`: its text probe must survive the task.mjs split (section 3).

### D8. Is this caller a person, a worker, a decider?

**Answers:**

- `permission.mjs:20 DECIDER_ROLES` (regex), `:22 WORKER_NAME`, `:24 AGENT_SHELL`.
- `away.mjs:21 DECIDER_ROLES` (an array).
- `reclassify.mjs:78 AGENT_SHELL` (copy), `:86 isAgentName` (`AGENTISH` + a session file), `:95 personRefusal`.
- `agent.mjs:1815 isAgentName` (its own list).
- `verdict.mjs:33 AGENTISH`, `:34 isPerson`.
- `task-hold.mjs:190 parkRank` (`opus-N`/`orchestrator-N` = orchestrator, inline `AGENT_SHELL` at `:198`).
- `AGENT_SHELL` copies in `beta-mode.mjs:43`, `upgrade-guard.mjs:141`, `learning-edge.mjs:122`,
  `decisions-log.mjs:56`; `asset-review.mjs:425 agentShell`.

**They disagree today.** `engine-porter-3`, `scout-2`, `balancer-1` and `fun-tester-1` are workers to `WORKER_NAME`
but not agents to `agent.mjs:1815 isAgentName`. `engine-…` and `sound-…` are agents to `verdict.mjs AGENTISH` but not
to `agent.mjs`. Whether a name may hire, give a fun verdict, park or reclassify depends on which list the command
imports.

**Owner.** `permission.mjs`: `WORKER_NAME`, `DECIDER_ROLES`, `AGENT_SHELL`, plus new `isAgentShell(env)`,
`isAgentName(name)` and `rank(by, env)` (today's `parkRank`). **Callers to move:** all above. The identical
`AGENT_SHELL` copies are a pure move. Merging the name lists changes who is refused, so each list gets a selftest
naming the names that change.

### D9 to D12 (lower risk, same pattern)

- **D9 main checkout / lane copy.** `worktree.mjs:47 mainRoot` (trusts `STUDIO_MAIN_ROOT` as given),
  `owner-proxy.mjs:56 mainCheckout` (git only: "never from STUDIO_MAIN_ROOT, which a lane could point anywhere"),
  `approve.mjs:120 studioBranchOfLane` (env only if `mainRootTrust`), `hook-stamp.mjs:630 laneOf`,
  `lock.mjs:384 laneCopyName`, `handout` `gitMainRoot` [2781]. Owner: `owner-proxy.mainCheckout` for any trust
  decision (D1's key fallback first); `worktree.mainRoot` stays for paths.
- **D10 event window.** `readRecentEvents(n)` is called with 20000 (94 times), 50000 (25), 5000 (23), 200000 (9),
  2000 (9), 100000 (7) and up to 1,000,000. Facts about one task (`task.added` meta, its claim, its closing record) are
  read through whichever window the caller chose. B-114's fix built a history reader for one question
  (`handout.closingInHistory` [2781]). Owner: `event.mjs taskHistory(id)` (an index of a task's events across the
  rolled files), reused by D3 and D4.
- **D11 a setting's value now.** 21 modules parse `.env` themselves (`agent-env`, `agent`, `bench`, `boot`,
  `communicator`, `dotenv`, `env-reload`, `event`, `heavy` (`liveCount`, `:222`), `hook-stamp`, `report-post`,
  `route`, `train-lanes`, `train`, `upgrade-preflight`, `whole-game`, `worktree`, plus four scripts). Only
  `heavy.liveCount` reads it live. Owner: `dotenv.mjs` (one parser, and `liveValue(root, key)` for the few settings
  that must be live).
- **D12 beta mode.** One reader (`beta-mode.readBeta`); the HUD caches it for 30 s (`hud.mjs:54`). Nothing to move.
- **One name, two functions:** `excusedRed` is `done-check.mjs:606 excusedRed(taskId)` (dead, no caller) and
  `train.mjs:559 excusedRed(rec, tasks)` (live). Delete the done-check one.

### The off switches that keep a second answer alive

Several 2.78.1 off switches restore exactly the second reader that the fix retired: `STUDIO_HEAVY_SLOTS_LIVE=off`
(the per-process count), `STUDIO_KEY_BASE=off` (a third key rule), `STUDIO_DEP_LANDED_EVIDENCE=off` (window only),
`STUDIO_UNSCOPED_PARALLEL=off`, `STUDIO_TRAIN_HARNESS_GUARD=off`. They are due for removal once 2.78.1 has held two
releases (2.80.x). Until then each owner must keep them as a parameter, not as a second code path.

---

## 2. Dead code (PU-67)

### Exports nothing imports: 42, about 242 lines

Each name appears nowhere else in the repository, docs and JSON included, except as an unrelated local of the same
name where noted. Lines are the declaration's extent.

| Module:line | Export | Lines |
|---|---|---|
| aider-launch.mjs:22 | `AIDER_IGNORE_BASE` | 1 |
| asset-review.mjs:78 / :341 | `PREVIEW_CHECKS` / `makersOf` | 1 / 8 |
| assets.mjs:33 | `ASSETS_DIR` | 1 |
| beta-mode.mjs:75 | `betaOn` (qa has its own local) | 1 |
| ci-watch.mjs:31 | `readCiWatch` | 7 |
| communicator.mjs:54 | `OWNER_KINDS` (line-producer has an unrelated local) | 1 |
| contracts.mjs:417 | `judgeContract` | 40 |
| digest.mjs:115 | `fuzzSuggestions` | 7 |
| done-check.mjs:606 | `excusedRed(taskId)` (see D9 to D12) | 6 |
| game-id.mjs:81 / :100 | `reidentify` / `currentGameId` | 6 / 6 |
| heavy.mjs:210 | `heavySlots` (pre-B-117 count) | 1 |
| hook-stamp.mjs:84 / :622 | `HARNESS_TRAILER` / `LANE_HARNESS_DIRS` (export only) | 1 / 1 |
| lane-disk.mjs:120 | `lanesTotalGb` | 4 |
| lane-sparse.mjs:41 | `NEVER_EXCLUDED` | 1 |
| lanes.mjs:87 / :95 | `mergeTreeSupported` / `conflictFiles` (unity-train has its own copy) | 3 / 4 |
| learn.mjs:215 | `learningFiles` | 13 |
| learning-edge.mjs:181 / :258 | `constraintSettings` / `constraintsData` | 7 / 1 |
| line-producer.mjs:997 | `laneLinesOf` | 8 |
| metrics.mjs:37 | `FAILURE_LABELS` | 1 |
| overseer.mjs:46 | `DEFAULT_CRITERIA` | 5 |
| pending-review.mjs:28 | `isPending` | 1 |
| pitfalls.mjs:102 | `readPitfalls` | 3 |
| policy-rules.mjs:56 | `DEFAULT_POLICY` | 1 |
| prompt-layout.mjs:29 | `stablize` | 6 |
| reasoning-only.mjs:25 | `otherFamilies` | 4 |
| secrets.mjs:241 | `hasSecret` | 1 |
| stall.mjs:315 / :317 | `DRIFT_SIGNALS` / `DRIFT_SCOPE_ALWAYS` | 1 / 1 |
| state-probe.mjs:135 | `judgeProbe` | 17 |
| test-rng.mjs:47 | `KINDS` (others are unrelated locals) | 1 |
| test-weakening.mjs:236 | `goldenWithoutReason` | 15 |
| tiers.mjs:97 | `DEFAULT_TIER` | 1 |
| train.mjs:1932 / :3039 | `chainTailWaits` / `thisLane` | 13 / 3 |
| unity-train.mjs:415 / :416 | `runEngineTrain` / `queueEngineTask` (2.77.0 aliases) | 1 / 1 |
| visual-check.mjs:274 | `VISUAL_CHECK_COMMANDS` | 1 |
| workaround.mjs:384 / :401 | `checkAllStamps` / `detectFromEvents` | 13 / 33 |

A one-line constant such as `DRIFT_SIGNALS` may still be used inside its own module. Then only the `export` goes.
`lock.mjs:400 commitTasks` looked dead to the `.mjs` scan but is used by `scripts/hooks/commit-msg`: keep it.

**Used only by qa/ selftests (listed apart, keep for now).** 10 exports nothing but a selftest calls:
`agent-env.heldBack`, `control-effects.checkEffects`, `divergence.goldenDivergence`, `game-id.checkRecordingId`,
`gate-subids.subIdsOf`, `hash.isHash64`, `heavy-budget.jobCatalog`, `remote-workers.isRemoteOwner`,
`test-weakening.weakeningsInDiff`, `verdict-split.isRenderTask`. Each is either a check whose caller was removed (then
the test goes with it) or a helper the selftest uses as an oracle. Decide per item. A further 291 exports are test
seams (used in their own module and by a selftest): fine. 1384 exports are used only inside their own module: the
`export` keyword is noise, not dead code; not worth a pass.

### Modules nothing imports: 0 dead

Three modules have no importer and no `package.json` script: `scripts/check-approvals.mjs` (a gate command in
`studio/gates.json`), `scripts/golden-diff.mjs` (`scripts/hooks/commit-msg`), `scripts/snapshot-state.mjs`
(`scripts/snapshot-state.sh`). All are alive. 74 more are run by path (CLIs) rather than imported: also alive. Every
`harness/`, `scripts/` and `hub/` module is reached from outside `qa/`.

### STUDIO_* settings read by nothing: 0 of the census's 32

Each was grepped across the whole repository. None is dead harness code; the census over-counts:

- **Read outside the census's scan** (3): `STUDIO_GUARD_PATHS` (`.claude/hooks/guard-paths.mjs`),
  `STUDIO_STOP_GATE_MS` (`.claude/hooks/stop-gate.mjs`), `STUDIO_SELFTEST_SLOW` (`qa/selftest.mjs`, the runner).
- **Members of runtime-built names** (20): `STUDIO_${role}_CMD|_TOOL|_MODEL|_ENV|_PROFILE`
  (`agent.mjs:1091`, `:2072-2093`, `agent-env.mjs:50`, `profile-guard.mjs:28`, `supervisor.mjs:578-618`),
  `STUDIO_TOOL_${tool}_CMD|_MODEL` (`spend-guard.mjs:25`, `agent.mjs:1502`), `STUDIO_TIER_${tier}_MODEL`
  (`model-tiers.mjs:100`, `routing.mjs:57`, `line-producer.mjs:523`), `STUDIO_KEYMAP_…` (`agent-env.mjs:183`),
  `STUDIO_HEAVY_MAX_${kind}` (`heavy-budget.mjs:123`), `STUDIO_${tool}_PROBE_CMD` (`budget.mjs:300`). The names:
  `BUILDER_ENV`, `BUILDER_PROFILE`, `DIRECTOR_PROFILE`, `DIRECTOR_MODEL`, `CLAUDE_PROBE_CMD`, `HEAVY_MAX_UNITY`,
  `KEYMAP_AGENT_KM_1`, `KEYMAP_AGENT_KM_7`, `KEYMAP_BUILDER`, `RND_CMD`, `RND_TOOL`, `SOUND_DESIGNER_CMD`,
  `TIER_CHEAP_MODEL`, `TIER_MID_MODEL`, `TOOL_AGY_CMD`, `TOOL_AIDER_CMD`, `TOOL_CLAUDE_CMD`, `TOOL_HERMES_CMD`,
  `TOOL_ZZALPHA_CMD`, `TOOL_ZZBETA_CMD`.
- **Selftest fixtures** (9, set by a selftest for its own fake tool or as a marker): `ARGV_OUT`, `FAKE_AIDER_410`,
  `FAKE_AIDER_FAIL`, `FAKE_AIDER_HISTORY`, `FAKE_TOKEN`, `GODOT_REAL`, `MODE`, `X`, `X230I`. They still appear in
  `docs/SETTINGS.md` and the 660 count. The settings map should skip names set only inside `qa/selftest*`.

So the census (PU-64) needs three fixes before it can drive the cut: scan `.claude/hooks/`, expand the runtime-built
families, and leave selftest fixtures out. Its "off switch" list also holds one non-switch: `STUDIO_SKIP_LOG_MIN` is a
log interval.

### Off switches for a fix that has held two or more releases

From the census's 22, each checked at its read sites:

| Setting | Added | Verdict | Removing the off path deletes |
|---|---|---|---|
| `STUDIO_TRAIN` | 2.59.0 | **remove** (needs crew data) | `train.mjs:121 trainOn`, its term at `task.mjs:2008`, `train-daemon.mjs:106`, `:129`, `:273`, `heavy-budget.mjs:348`: ~7 lines. `worktree.deliver` stays (it is also the `--force` / `--accepted-by` / no-commits path). |
| `STUDIO_LANE_LOCKS` | 2.58.5 | remove | `lock.mjs:437` and the `!laneBlocks` term at `:446`: 2 lines |
| `STUDIO_TYPE_EVIDENCE` | 2.65.0 | remove | one term at `done-check.mjs:190` |
| `STUDIO_UNITY_PLAYMODE_RETRY` | 2.67.1 | remove | `unity.mjs:375 retryOn`, a term at `:834`: 2 lines |
| `STUDIO_TRAIN_GREEN_FIRST` | 2.69.0 | remove | one term at `train.mjs:613` |
| `STUDIO_GOLDEN_DIVERGENCE` | 2.72.0 | remove | `divergence.mjs:34 divergenceOn`, a term at `game-gates.mjs:386`: 2 lines |
| `STUDIO_RIG_SHARE` | 2.76.0 | remove | `heavy-budget.mjs:312`, the RAM-only branches at `:418`, `:514`, `rig-budget.mjs:108-109`: ~6 lines |
| `STUDIO_TRAIN_RESERVE` | 2.76.0 | remove | one guard at `heavy-budget.mjs:346` |
| `STUDIO_TRAIN_KNOWN_RED` | 2.77.0 | remove | `train.mjs:2602 knownRedOn`, guards at `:2606`, `:2620`: 3 lines |
| `STUDIO_TIMEOUT_RERUN` | 2.72.0 | keep the knob | the triager sets it off for its own runs (`train.mjs:926`, `game-gates.mjs:358`); only the user-facing docs could go |
| `STUDIO_AGY_PROMPT` | 2.58.5 | keep (crew data) | Windows `-p` compatibility; also turns stream mode off (`agy-stream.mjs:56`) |
| `STUDIO_AGY_MODE` | 2.76.0 | **keep: tool option** | `review.mjs:219` sets it off for reviews |
| `STUDIO_UPGRADE_REFRESH` | 2.67.0 | **keep: three modes** | `upgrade-smoke.mjs:65` sets it off |
| `STUDIO_BREAKER` | 2.30.0-c | **keep: feature / bench ablation** | `bench.mjs:84` |
| `STUDIO_WEAKENED_TESTS` | 2.58.2 | **keep: safety gate** | `bench.mjs:82`, `task.mjs:785` |
| `STUDIO_HOOKS_CHECK` | 2.58.2 | **keep: safety gate (on/off/auto)** | `upgrade-smoke.mjs:65` sets it on |
| `STUDIO_WORKTREES` | 2.29.0 | **keep: architecture toggle** | `bench.mjs:91` ablation |
| `STUDIO_QUOTA_SKIP` | 2.24.0 | **keep: feature** | usage watched outside the harness |
| `STUDIO_LANDING_BUILD` | 2.70.0 | **keep: feature** (costs a build) | |
| `STUDIO_ENGINE_TRAIN_AUTO` | 2.77.0 | **keep: policy** | also `engines.<x>.trainAuto` |
| `STUDIO_VISUAL_NOISE` | 2.65.0 | **keep: cost toggle** | skips a second capture on slow machines |
| `STUDIO_SKIP_LOG_MIN` | 2.30.0-q | not an off switch | a log interval |

**Total:** 9 settings to remove, about 27 lines of code, plus their `docs/SETTINGS.md` rows and the selftest cases that
exercise the off path. The code saving is small. The gain is nine fewer settings and nine fewer paths to test. Each
removed name goes on PU-64's frozen "removed" list, which warns when a studio's `.env` still sets it.

---

## 3. Module split plan (PU-66)

Every split keeps the original file as a **facade** that re-exports every name it exports today (selftests and callers
use `import * as tr from './train.mjs'` and generated probes such as `import { runTrain } from '…/train.mjs'`), plus its
CLI. The parts are new files beside it. Sizes are the declarations' lines (imports and the module comment come on top).
"Uses" is the one-way import order. Each proposal below was checked with the scratch splitter and has **no cycles**.

### train.mjs (3047) → 10 parts, largest 625

| Part | Lines | Functions | Uses |
|---|---|---|---|
| `train-common.mjs` | 63 | `git`, `out`, `alive`, `sleep`, `TRAIN_DIR`, `esc`, `pinNameMatches`, `gameGateIds`, `bisectMode`, `stable`, `short`, `mergeEnv`, `stamp`, `ev`, `changedVs`, `thisLane`, `trainRound` | none |
| `train-queue.mjs` | 268 | `trainOn`, `queueFile`, `readQueue`, `writeQueue`, `withQueue`, `enqueue`, `dequeue`, `requeue`, `readLeft`, `leaveTrain`, `readCancel`, `activeLanes`, `TrainCancelled`, `checkCancel`, `taskHoldOf`, `heldOutWhy`, `applyLandedConfig`, `applyHeldConfig`, `heldNow`, `releasedFor`, `handBackCount`, `maxHandBacks`, `holdLane`, `releaseRefusal`, `releaseLane`, `unreleaseLane`, `batchRules` | common |
| `train-scratch.mjs` | 275 | `withTrainLock`, `makeScratch`, `removeScratch`, `goldenReasons`, `readTrainSettings`, `trainManifest`, `pinMoves`, `pinsOnlyRed`, `unionAttributes`, `buildIntegration`, `ignoredOnlyDirty`, `recordGreen`, `sweepScratch` | common |
| `train-verify.mjs` | 432 | `recordCovers`, `wholeEquiv`, `excusedRed`, `recordedVerifies`, `greenFirst`, `failLines`, `verifyTree`, `verifyRemoteFirst`, `localSafetyGates`, `recheckStart`, `recheckEnd`, `recheck`, `recheckAsync`, `trainVerifyParts`, `flakeSeen`, `flakeTriage` | common, queue, scratch |
| `train-triage.mjs` | 283 | `pinReport`, `redPlan`, `deferNoCheck`, `harnessUnderneath`, `focusPlan`, `recheckWords`, `pinPlan` | common, scratch, verify |
| `train-tier.mjs` | 116 | `laneTrailers`, `laneFiles`, `laneToolchain`, `laneTier`, `contractTier`, `clearContractHolds` | common, queue, scratch |
| `train-waits.mjs` | 435 | `waitForBatch`, `laneNow`, `precheckChild`, `livedTrain`, `reapTrains`, `landingBuildAfterTrain`, `trainJobDone`, `depContext`, `laneWaits`, `waitActions`, `buildInOrder`, `relatedRun`, `relatedFirst`, `tailRun`, `chainTailCheck`, `chainTailDefer`, `fixFirst` (`chainTailWaits` deleted) | common, queue, scratch, tier, triage |
| `train-land.mjs` | 249 | `knownRedOn`, `listRedMain`, `knownRedTry`, `boardPaths`, `boardOnlyMove`, `recordEntriesChanged`, `rebuildOverBoardMove`, `recheckBoardMove`, `landTrain`, `summary` | common, queue, scratch, verify, waits |
| `train-body.mjs` | 625 | `runTrain`, `landPrefixOn`, `landPrefixEarly`, `trainBody` (495 lines on its own) | all of the above |
| `train-next.mjs` | 188 | `nextBaseVerdict`, `nextPollMs`, `runNextTrain`, `nextBody` | common, queue, scratch, verify, tier, waits, land |

`flakeTriage` goes with verify (`verifyTree` and `recheckEnd` call it); `runTrain` goes with `trainBody`. Those two
moves are what remove the cycles.

### task.mjs (2480) → 5 parts + a CLI in 2, largest 587

| Part | Lines | Functions | Uses |
|---|---|---|---|
| `task-board.mjs` | 366 | `NEXT_FILE`, `DONE_FILE`, `CURRENT_TASK_FILE`, `parseNextQueue`, `readBoardFiles`, `readMoves`, `parseQueueText`, `formatTaskLine`, `withBoard`, `writeNextQueue`, `writeNextQueueRaw`, `renderNext`, `renderDone`, `currentTaskWrites`, `syncCurrentTaskCheckpoint`, `handoffFile`, `readTaskHandoff`, `readStop`, `setStop`, `clearStop`, `PRI`, `nextFor`, `liveOwner` | none |
| `task-start.mjs` | 159 | `showTask`, `startTask`, `researchAtStart`, `whoAmI`, `CODE_TYPES` | board |
| `task-claim.mjs` | 228 | `holderRunning`, `sameClaim`, `pauseTask`, `PRODUCER_NAME`, `claimLeakGraceMs`, `releaseLeakedClaim`, `boardChangedAt`, `reopenTask`, `scopePaths`, `gateTask` | board |
| `task-add.mjs` | 262 | `allocateTaskId`, `addTask`, `addTaskInner`, `fromRescueMeta`, `engineTargetsQuiet`, `recordEngineTaskAtAdd`, `dropTask`, `reorderTask`, `parseUsage`, `reportUsage`, `parseFlags`, `logTaskDecision` | board, start, claim |
| `task-done.mjs` | 587 | `completeTask` (437 on its own), `assetGateAtDone`, `assetReviewAtDone`, `assetHandoffAfterLanding`, `closeTrainTask`, `predictAtQueue`, `trainDeps`, `reuseTrusted` (now after the CLI, `:2477`) | board, start, claim, add |
| CLI, `task-cli-work.mjs` | ~424 | `next`, `show`, `drain`, `list`, `stop`, `resume`, `trunk`, `type`, `visual`, `start`, `impossible`, `pause`, `reopen`, `done` | all |
| CLI, `task-cli-board.mjs` | ~404 | `train`, `unblock`, `game`, `note`, `hold`, `unhold`, `holds`, `park`, `unpark`, `block`, `yes`, `reorder`, `contract`, `pending`, `promote`, `proposed`, `add` | all |

The CLI is one 828-line top-level `if` chain (`task.mjs:1649`), not functions. It first becomes a handler table
(`{ next: cmdNext, … }`) inside task.mjs, as its own step, before it moves.

### agent.mjs (2389) → 8 parts + facade/CLI, largest 601

| Part | Lines | Functions | Uses |
|---|---|---|---|
| `agent-tools.mjs` | 246 | `AGENTS_DIR`, `WIP_DIR`, `HEARTBEAT_MS`, `providerTrouble`, `nimModelTrouble`, `onPath`, `toolPreflight`, `aiderTail`, `agySettingsArg`, `AGY_DEFAULT_MODEL`, `isGeminiModel`, `modelFamilyTool`, `agyAnyModel`, `agyOptions`, `toolCommand`, `roleKey`, `sessionFile`, `readJson` | none |
| `agent-sessions.mjs` | 193 | `STALL_BEAT_MIN`, `sessions`, `wrappingUp`, `markAgentExited`, `claimSessionEnd`, `releaseDeadLocks`, `sessionTask`, `claimedSince`, `markGone`, `nextAgentName`, `laneNameClash`, `freshAgentName`, `saveWorkOf`, `tasksOf` | tools |
| `agent-usage.mjs` | 217 | `caps`, `spentToday`, `tokensFrom`, `writeSplit`, `cacheTtlAsked`, `workCommitted`, `crashFinishable`, `exitCause`, `streamUsage`, `estimateCost`, `agyStopLine`, `agyUsage`, `agyCutShort` | sessions |
| `agent-prompt.mjs` | 109 | `refreshRule`, `launchStop`, `broadLaneRefusal`, `refreshKickoff`, `sessionPromptParts` | tools, sessions |
| `agent-stop.mjs` | 196 | `killTree`, `stopChild`, `LAUNCHER_ID` (a `let`: it stays here with its setter), `launcherIdentity`, `holdStarting`, `dropStarting`, `killVerdict`, `stopFile`, `recordStop`, `stopMark`, `endAsDead`, `stopAgent`, `wipSummary`, `sayNow` | tools, sessions |
| `agent-end.mjs` | 236 | `cleanUp` (164), `autoFinish`, `parkIfLooping`, `tailOf` | tools, sessions, usage, stop |
| `agent-run.mjs` | 601 | `runAgent` (485), `reusableCopy`, `agyIdent`, `agyVersion`, `agyStreamRecordCheck`, `recordStreamFailure`, `failedSessionEvidence`, `launchEngineLane` | tools, sessions, usage, prompt, stop, end |
| `agent-start.mjs` | 388 | `isAgentName` (→ D8), `readBudgetLimits`, `pauseAgent`, `stopAgentNamed`, `stopAllAgents`, `otherAgents`, `agentLog`, `startAgent`, `fillAgents`, `wake`, `launchableRoles` | tools, sessions, usage, prompt, stop, run |
| `agent.mjs` | ~112 + re-exports | the CLI | sessions, stop, start |

### heavy.mjs (1210) → 3

`heavy-holders.mjs` (485: train-wait and quiet-hold markers, `liveCount`, `heavySlotsAt`, `engineSlotsAt`,
`heavyHolders`, `holderGone`, `holderTree`, `killHolderTree`, `reapOrphans`, `heavyRecords`, `stopRefusal`,
`stopHeavy`, `otherGateSlots`, `laneCheckSlots`, `heavyPrograms`, `implicitHolders`; D5's owner);
`heavy-acquire.mjs` (442: `heavyOwnGroup`, `heldByParent`, `heldClaim`, `acquireHeavy` (161), `floorFree`,
`collectHolders`, `queueAhead`, `withHeavy`, `cpuBusy`, `cpuOrLoad`, `loadFactor`, `lastQuietTime`, `writeTimes`,
`recordGatePass`, `scaledTimeout`; uses holders); `heavy.mjs` (177: `heavyWaitCli` and the CLI; uses both).

### line-producer.mjs (1043) → 3

`line-facts.mjs` (553: `expansionShare`, `isExpansion`, `chainBreakers`, `sizeTier`, `routeTask`, `pickPoolFn`,
`linePlan`, `rigNow`, `logAction`, `restoreLaneCopy`, `ownerHelpers`, `gatherFacts` (172), `protectedApprover`,
`protectedRoutes`, `writeNote`); `line-engine.mjs` (191: `twinConfigs`, `landedFiles`, `twinPass`, `engineWindow`,
`enginePass`, `startEngineTrain`; uses facts); `line-producer.mjs` (242 + CLI: `lineProducerPass`, `summaryLine`,
`CHAIN_HOLD_TAG`, `chainBreakerPush`, `lineStatus`, `supervisorPlan`, `orderGroups`, `statusText`, `whyText`; uses
facts and engine). `pickPoolImpl` (a `let`) stays in facts.

### supervisor.mjs (1017) → 3

`supervisor-policy.mjs` (~250: `boundedStep`, the start backoff (`taskStateSig`, `noteStartRefusal`,
`startBackedOff`, `ingestRefusals`), `jitteredDelay`, `readStatus`, `readResume`, `applyExtend`, `EXTEND_FILE`,
`clearStaleHalt`, `parseUntil`, `inWindow`, `checkBadEnds`, `groupSameDeaths`, `laneClashWith`; `currentLane` moves
to `task-hold` per D4); `supervisor-pass.mjs` (402: `supervise` (331), `trainDaemonTick`, `linePlanNow`,
`sessionCapNow`, `ramNote`, `keepHubUp`; uses policy); `supervisor.mjs` (~324: `main`, `install`, `resumeCli`,
`extendCli`, the CLI; uses both). The splitter's one cycle here was a word inside a string (`install` in
`checkBadEnds`'s hint), not a call.

### What the splits must watch

- **14 selftests read a giant module's source text** and assert on it (`qa/selftest-230h`, `-230i`, `-230k`,
  `-230l`, `-264l`, `-267g`, `-270t`, `-272b`, `-273e`, `-276l`, `-277u`, `-278a`, `-278g`, `qa/selftest.mjs`). A
  moved function breaks them. In the same step, they read the part (or the facade plus its parts). The bar
  "every selftest unchanged" becomes "every selftest passes; the only edits are the source paths those 14 read".
- **`train.mjs:1595 precheckChild`** decides "old harness" by finding `flags['train-check']` in a lane's
  `harness/task.mjs`. Keep that flag parse in `task.mjs` (the facade) or the train refuses every lane as old.
- **A part never runs as a command.** Only the facade keeps the `process.argv[1]` check. `supervisor.mjs:363`
  notes that the watcher passes the launcher's functions in because `agent.mjs` run as a command can't import itself;
  parts are importable, so that workaround can go later, not in the split.
- **Module-level state:** only `agent.mjs:1645 LAUNCHER_ID` and `line-producer.mjs:164 pickPoolImpl`. Each stays in the
  part that assigns it.

---

## 4. Order of work

Each step is one commit, separately testable. "Pure" means no behaviour change: goldens and every selftest unchanged.
A "fix" changes behaviour where two readers disagreed today. It gets a selftest that fails on the commit before it and
a line in the release notes.

| Step | What | Kind | Test | Needs |
|---|---|---|---|---|
| 0 | Rebase `claude/279-census` and this branch onto `claude/2781` (part (d), release notes) and re-run the census | pure | `node scripts/check-docs.mjs`; the census's numbers again | now |
| 1 | **Single-reader gate, report mode.** A data file of owners (`decision`, `owner` module, the raw patterns it alone reads: `'train', 'queue.json'`, `-queue.json`, `train.lock`, `task-holds.json`, `owner-ed25519.pub.pem`, `studio/approvals`, `machine-heavy`, `process.kill(…, 0)`, `CLAUDECODE`, `['harness', 'scripts']`) with a frozen baseline of today's readers that only shrinks (as `docs/settings-baseline.json` does). It fails on a **new** reader only. | pure (new check) | a selftest: a temp module with a raw `queue.json` read fails the check, the baselined files pass. It fails on the old code because the check doesn't exist. | now |
| 2 | **D1 approvals: reproduce first.** Selftests for an uncommitted beta record accepted by `verifyApproval` and for the no-push key gap (`forceApproved`, protected files). Report to the owner. | test only | the selftests show today's behaviour | now; the **fix needs the owner's signed decision** (which key fallback, beta rule) |
| 3 | D1 fix: `owner-key.mjs`, every caller through it; baseline entries removed | fix | the step 2 selftests flip; 2773a/2781c (B-111, B-120) still pass | the owner's call |
| 4 | Pure moves: identical `AGENT_SHELL` copies → `permission.mjs`; inline `heldNow` copies → `train.heldNow`; raw `queue.json` reads → `readQueue`; local `alive` copies → `fsafe.pidAlive`; `hook-stamp.laneOf` → `laneCopyOf` | pure | goldens, selftests, gate baseline shrinks | now |
| 5 | Dead code: the 42 exports (~242 lines); decide on the 10 qa-only ones | pure | a dead-export report before/after; selftests | now |
| 6 | D5: `train-parallel.mjs:47`, `train-pipeline.mjs:94` → `heavySlotsAt`; `trainComing` leaves task-held lanes out; delete `heavySlots` | fix | a selftest: `.env` lowered below the process's value, the planner admits by `.env` | now |
| 7 | D4: `sessionLane` in task-hold; `stall.sessionScope` uses it | fix | a selftest: re-lane a running session, no drift flagged for the new folder | now |
| 8 | D2: `task-hold.startBlock`; `task start`/`next`, the plan, watch and the preflight through it | fix | selftests: (a) `task start` on an in-progress task in `unity-queue.json` is refused; (b) a forced-done dependency holds `task start` as it holds the launcher | now |
| 9 | D3: `landed.mjs` (from `handout` [2781]); `task-hold` `--after`, `train-deps`, `janitor` through it | fix | selftests: a train-landed lane is "landed" to the janitor; a forced done is not | after step 0 |
| 10 | D7 (one `HARNESS_PATHS`), D8 (one name list: each changed name listed), D10 (`taskHistory`), D11 (one `.env` parser) | fix each | one selftest each | now; D8's list change is worth a person's look |
| 11 | **Off switches**: remove the 9; their names go on PU-64's "removed" list (one WARN when set) | fix | the WARN selftest; settings count down by 9 | **crew data**: the `STUDIO_*` names their `.env` sets (`STUDIO_TRAIN` especially) |
| 12 | PU-64 rest: census fixes (`.claude/hooks`, runtime families, fixtures), fold the `*_WAIT_MIN` / `*_HOLD_MIN` families | fix | census and docs check | **crew data**: `.env` names and event-type counts from the 48 h run |
| 13 | Splits, one module per step, smallest first: heavy, supervisor, line-producer, agent, task (handler table first, then parts), train | pure | goldens; every selftest passes, with only the 14 source-text reads repointed; the splitter shows no cycles | now (after steps 4 to 9, so moved callers aren't moved twice) |
| 14 | PU-68: a size budget in the release check; the module-size limit for `harness/` lowered to ~800 | pure (new check) | the release check prints the numbers and the delta | now |

**What the crew's data decides.** The list of `STUDIO_*` names their `.env` sets decides steps 11 and 12 (a removed
name they still set gets the WARN and the replacement's name; `STUDIO_TRAIN=off` in their `.env` would mean the
deliver path is still in use). Event-type counts from the 48 h run (`task.train.landed` vs `lane.merged`,
`task.train.empty_diff`, `task.train.main_merges_only`, `launch.skipped`, `gate.orphan_ended`,
`task.train.chain_stopped`) say which paths ran. Everything else can be done now.

---

## 5. Added after 2.78.2 (merged 2026-11-06, `6c878fb`)

What the 2.78.1 and 2.78.2 work showed, for the order above. Step 0 now rebases onto `main` at `6c878fb`, not
`claude/2781`.

| Finding | Evidence | Goes to |
|---|---|---|
| Settings grew 660 → 697 in two releases | the census on 2.78.2 | step 11/12: the cut needs the crew's `.env` names |
| Every fix adds an off switch (2.78.2 alone: `STUDIO_DONE_QUEUE`, `STUDIO_TRAIN_DETACH`, `STUDIO_FLAKE_TOGETHER`, `STUDIO_REVIEW_VERDICT_LINE`, `STUDIO_OWNER_ONLY_PARK`, `STUDIO_DONE_SKIP_GAME_NONCODE`, `STUDIO_FOCUS_INFER`, `STUDIO_TEST_TIMING`, `STUDIO_TRAIN_LAND_OVER_NONCODE`, …) | `docs/RELEASE-2.78.2.md` | step 11: a switch that stayed on through one crew run is removed in the next cleanup; a new rule for PU-64 |
| Changing a default pins old tests to the old rule (2.78.2: 259a, 263i, 269r, 2773b, 243, 276g, 2585s, the L2222 block) | the 2.78.2 CI reds, 3 rounds | step 11: when a switch goes, its pins go with it; tests that only pin the old rule are retired |
| `train.mjs`, `task.mjs`, `agent.mjs` are where parallel work collides | merge conflicts on every 2.78.x part | step 13: split `task.mjs` (handler table) before `train.mjs` |
| The board list and the check readers disagree (`studio/producer/`, `studio/reviews/` were board paths but the docs check read them) | 2.78.2 item 3 | step 1: the board list is a decision owner; one list, the checks read it |
| Duplicate owners: 17 process-alive copies, 5 agent-name lists, 21 `.env` parsers | section 1 | steps 4 and 10 (unchanged) |
| **PID reuse on Windows**: `busy.mjs` `alive()` is a bare `process.kill(pid, 0)`, so a `done-running` marker whose writer exited reads as live when Windows hands its PID to another process (selftest 230q `drain wait` hung 60 min on CI, run on `3d3ddc2`; passed on re-run) | the CI log; `harness/busy.mjs:35` | step 4: `busy.mjs` through `proc-identity.pidAlive` with the recorded start time; the marker records it. Also a `--max` on the test's second `drain wait` |
| Owner-proxy approvals (orchestrator, grokbot) count when uncommitted; beta approvals must be committed since 2.78.2 | 2.78.2 part (h) | step 3, the next release; **the owner may say leave it out** (he said proxies approve as him) |
