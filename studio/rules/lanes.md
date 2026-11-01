# Rule: lanes, so several agents can build at once

Parallel work is capped by file layout. One 900-line renderer file means one renderer agent.

- Split the renderer early, as a structural task in Phase 1: camera and input, HUD, one module per
  floor or world, lighting and post-processing, enemies and guests. Keep each module under ~300 lines
  (`node scripts/check-module-size.mjs` lists the ones over).
- Give each task a lane, the narrowest folder it edits: `npm run task -- add "…" --lane game/<game>/src/floors`.
- The supervisor starts one agent per lane, each holding its folder, so no two agents edit the same
  files. A builder with no lane holds the whole game: nothing else in that role runs beside it. Set a lane
  after the fact with `npm run task -- lane <ID> <folder>`; `--part sim|renderer` implies one.
  Work outside a lane goes back to the Producer as a task.
- Work that must wait for other work says so: `--after T-146`. Parked tasks (`task park`) never start.
- The sim (cartridges/<game>/) is its own lane; renderer lanes never edit it.

## One working copy per lane (2.29)

- An agent the launcher starts with a code lane works in its own copy, `.lanes/<agent>/`, on its own
  branch. Another agent's unfinished work can't reach its tests or its commits, and its work can't reach
  theirs.
- `studio/` and `.studio/` are shared: one board, one set of claims, one event log.
- Commit as you go. `task done` refuses uncommitted work. It rebases your branch on the studio's, runs the
  everyday checks again if that branch moved, then adds your commits to it.
- A session that ends without finishing keeps its commits on its branch. The next agent on that task gets
  them merged into its own copy, and any uncommitted files are saved in `.studio/wip/`.
- Needs git 2.42 or newer. On older git, or with `STUDIO_WORKTREES=off`, everyone shares one checkout, as
  before; preflight says which.
- Board lanes (`studio/...`) and builders without a lane work in the main checkout.
- A copy runs its own committed `harness/` and `scripts/` (2.59.0). When the studio's branch changed them after the
  copy branched, `npm run verify` and `task done` there refuse and name the files: rebase on the studio's branch
  (`git rebase main`), then `npm run hooks -- restamp` if the hooks check lists commits. `STUDIO_LANE_HARNESS=own`
  runs the copy's own harness anyway.
- Hook stamps survive a clean rebase (2.59.0). `task done`'s own rebase re-commits through the hooks any commit whose
  stamp it made stale; by hand, `npm run hooks -- restamp` does the same (it keeps a `backup/<lane>-pre-restamp-<time>`
  branch). A commit in a copy is tagged `Studio-Task` with the copy's own task.

## Size (2.29)

- A game function over 80 lines, or a file over 400 lines or 30 KB, is hard to change cheaply: every
  turn re-reads it. `node scripts/check-function-size.mjs` lists them.
- A task can't finish if it made one of these bigger, or made a new one. Edits inside one that don't grow
  it are fine; the Producer queues a split for the rest.
