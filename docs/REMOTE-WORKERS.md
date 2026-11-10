# Remote (cloud) workers (2.77.0)

The owner asked whether work can run on cloud computers to take load off the PC. It can, for the work that doesn't
need the PC: a cloud session (Claude Code on the web, or any session that works through Git) does one self-contained
task and pushes a branch; the studio's PC fetches it, checks it and lands it through the normal merge train. This is
the first step to more than one rig. It is `harness/remote-workers.mjs` (`npm run remote`); the Line Producer offers
the work (`docs/LINE-PRODUCER.md`).

## What fits and what doesn't

| Fits a remote worker | Stays on the studio's PC |
|---|---|
| Research, design and docs tasks | The merge train and its full verify (`npm run task -- train`) |
| Code tasks that run their own tests (`npm run remote -- mark <T-ID> --test "<cmd>"`) | The board (`studio/NEXT.md`), claims and locks (`.studio/locks`), every `.studio/` state file |
| | Unity (Windows, the GPU and the licence) and other engine checks that need this machine |
| | A person's task and the planning roles (Producer, Director, planner) |

A remote branch never lands by itself. Its commits run on the PC only inside the train's verify, as any lane's do, and
a branch that changes the harness's own code (harness/, scripts/, tools/, qa/*.mjs, package.json) is not queued
automatically at all: a person reads it first (below). Protected files make the lane tier C, as for any lane: it waits
in the queue for a release (with beta mode, the orchestrator may release it).

## Setup: a push-enabled remote

The studio's `origin` push is DISABLED on the owner's PC (the PC never pushes). Cloud sessions work through GitHub, so
they need a repository (or a branch namespace in one) they can push `remote/*` branches to, that holds the studio's
current main for them to start from:

1. A private GitHub repository the cloud sessions may push to, added on the PC as its own remote, for example
   `git remote add cloud https://github.com/<owner>/<studio>-cloud.git`, and `STUDIO_REMOTE_NAME=cloud` in `.env`.
   (Pointing `STUDIO_REMOTE_NAME` at `origin` works when origin's GitHub repository accepts the cloud session's
   pushes: only the PC's own push URL is disabled.)
2. The cloud sessions start from that remote's main, so a person pushes the studio's main there when it should catch
   up: `git push cloud main` (the harness never pushes). `npm run remote -- brief` warns when the main it last fetched
   from that remote is older than the studio's; the PC merges the difference when the branch comes back.
3. Connect that repository to Claude Code on the web (claude.ai/code) as usual; each session gets one brief.

## The flow

1. **Mark** a task: `npm run remote -- mark <T-ID> [--test "<cmd>"]... [--allow <path>]... --by <name>` (studio/task-holds.json
   `remote`). A research, design or docs task needs nothing more; a code task needs the commands that run its own tests
   (or the repo's `npm test`). `--allow` limits the files the branch may change (the task's lane counts too). A person's
   task, a planning role's task, a Unity task or a task whose lane is `studio/` or `.studio/` is refused.
2. **Brief** it: `npm run remote -- brief <T-ID> --worker <name> --by <name>` claims the task for `remote-<name>` (no colon: it is a file name on Windows; a lease made as `remote:<name>` before 2.77.0 is still honored) with a
   lease of `STUDIO_REMOTE_LEASE_H` hours (12): the claim lock, the task in progress on the board, the lease in
   studio/task-holds.json and `.studio/remote/leases.json`. It prints the brief (also in `.studio/remote/briefs/<T-ID>.md`):
   the task and what done means, the notes left on it, the commands for its own tests, the branch to push
   (`remote/<T-ID>-<short>`), the `Studio-Task: <T-ID>` trailer for every commit, the `Studio-Remote: done` marker on the
   last commit (or `Studio-Remote: handback <why>`), and what never to touch. Paste it as the cloud session's prompt.
   While the task is out its local claim clock doesn't run (the lease is its limit; harness/task-budget.mjs).
3. The cloud session works, runs the task's tests and pushes the branch.
4. **Fetch**: `npm run remote -- fetch --by <name>` (or the Line Producer's background fetch with `STUDIO_REMOTE=on`, every
   `STUDIO_REMOTE_FETCH_MIN` minutes while a lease is out) fetches `remote/*` from `STUDIO_REMOTE_NAME`. For each branch
   with a live lease:
   - refused (the lease goes on; a new push is checked again): a commit without the task's trailer, or naming another
     task; a change to `studio/`, `.studio/`, `.lanes/`, `.env` or `node_modules`; a file outside its allowed paths;
   - working: no `Studio-Remote: done` on its last commit yet;
   - needs review: it changes the harness's own code. Read it, then queue it by hand:
     `npm run lane -- create <T-ID> --from cloud/remote/<T-ID>-<short> --agent remote-<t-id>` and, in that copy,
     `npm run task -- done <T-ID> --agent remote-<name> --train`;
   - handed back: `Studio-Remote: handback <why>`: the task goes back on the board with that note;
   - queued: a lane copy `.lanes/remote-<t-id>` is made for it (`npm run lane -- create`: studio/ linked to main), its
     commits re-stamped through the local hooks when needed (as `npm run lanes -- refresh` does), and
     `task done <T-ID> --train` queues it in that copy: every task-done check and the tier rules, then the train's one
     full verify. Nothing is landed without the train.
5. The train lands it (or hands it back, as any lane). The lease closes when the task is done.

A lease past its time (not queued) is ended: the claim is released and the task goes back on the board with a note
(`task.remote.ended`). `npm run remote -- release <T-ID> --by <name>` ends one by hand. `npm run remote -- status`
lists the leases and the last fetch.

## The Line Producer and the rig

- When the local builders are at their target, the Line Producer offers remote-eligible ready tasks to remote workers:
  a "remote" line in `npm run line -- status` and `npm run line -- plan` (and `remote` in .studio/line/status.json),
  and one `remote.offer` event when the offer changes, at most `STUDIO_REMOTE_MAX` tasks out at once. It doesn't start
  cloud sessions itself: whoever runs them (the orchestrator, a person) briefs the offered task.
- The rig budget (`node harness/rig-budget.mjs`) lists tasks on remote workers as 0 local CPU until their branch is
  queued; from then on the train's verify counts, as for any lane.

## Settings

| Setting | Default | What |
|---|---|---|
| `STUDIO_REMOTE` | `off` | `on`: the Line Producer's pass ends leases that ran out, fetches `remote/*` in the background when due, and posts the offer. The `npm run remote` commands work either way. |
| `STUDIO_REMOTE_NAME` | `origin` | The git remote the cloud sessions push to (a push-enabled one; see Setup). |
| `STUDIO_REMOTE_LEASE_H` | `12` | Hours a remote worker holds its task. |
| `STUDIO_REMOTE_MAX` | `2` | At most this many tasks out to remote workers at once (the offer). |
| `STUDIO_REMOTE_FETCH_MIN` | `10` | Minutes between the Line Producer's background fetches while a lease is out. |
| `STUDIO_REMOTE_FETCH_TIMEOUT_S` | `120` | The `git fetch` time limit. |
| `STUDIO_REMOTE_QUEUE_TIMEOUT_S` | `900` | The time limit of the queue step (`task done --train` in the lane copy). |

Who: `mark`, `brief`, `fetch` and `release` are for a person, a Producer or Director session, or an agent outside the
harness (the orchestrator), the rule of `npm run lanes -- refresh`; a launched worker session is refused.

## Building a lane by hand: `npm run lane -- create`

`npm run lane -- create <T-ID> [--from <branch>...] [--agent <name>] [--by <name>] [--allow-mixed]` makes a proper lane
copy for a task the way the launcher does (studio/ and .studio/ linked to the main checkout's, node_modules linked,
.env copied, the sparse plan, the lane record `.studio/lanes/<agent>.lane.json`), then merges the branches given, in
order; with none, the task's own unlanded branch is carried in. A branch carrying another open task's commits (a
`Studio-Task` trailer naming it, or recorded as its branch) is refused unless `--allow-mixed`; a merge conflict
removes the copy and names the files. Then work there as that agent: `npm run task -- start <T-ID> --agent <agent>`
and `npm run task -- done <T-ID> --agent <agent> --train` from the copy (a bare `git worktree add` copy has its own
studio/, so `task done` there said "Task not found").
