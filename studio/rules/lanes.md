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
- 2.60.0: the game's check manifest (`game/<name>/studio.gates.json`, protected: the owner approves it once) may say
  `"sizeRule": { "exempt": ["src/game/modules.ts"], "importLinesFree": true }`. Paths are relative to the manifest's
  folder (or repo-relative). An exempt file may grow, up to a hard cap (`"exemptMaxLines"`, default 800 lines, and
  60 KB); its functions keep their limit. With `importLinesFree`, added lines that are only imports or re-exports
  (`import … from '…'`, `export … from '…'`, `export * from '…'`, a multi-line import block) don't count as growth in
  any file of the game. The rule is read from the manifest as committed on the studio's main branch: a task's own
  edit of it, or a `sizeRule` anywhere else, is ignored (the refusal says so). JS/TS imports only.

## The registry pattern (2.60.0)

A list every feature appends to (module imports, save/load/reset spreads) makes every lane change the same line, so
every landing conflicts. Give each entry its own module in one folder, and keep the list itself one entry per line,
or generated:

```ts
// src/systems/fuel.ts: one file per entry
export const fuel = { id: 'fuel', save: (s) => s.fuel, load: (s, v) => { s.fuel = v; }, reset: (s) => { s.fuel = 0; } };

// src/systems/index.ts: the registry, one line per entry (exempt in the manifest), never a joined line or a spread
export { fuel } from './fuel';
export { cargo } from './cargo';

// the big file imports the registry once and loops over it
import * as systems from './systems/index';
for (const sys of Object.values(systems)) sys.reset(state);
```

Two lanes that both add a line at the end of the registry still conflict (git can't tell which goes first); insert in
name order, or generate the index from the folder (a build-time glob or a small script), so no lane edits it. Where
save order changes a hash, sort the entries by id rather than by file order.

## Hotspots (2.60.0)

`task start`, `task done --train` and the merge train's start log warn when two lanes in flight (queued for a train,
or lane copies with commits main doesn't have) change the same lines of the same file, naming the file, the line and
the lanes; the Producer gets each such overlap once in its inbox (`studio/producer/INBOX.md`) and as a
`hotspot.overlap` event. Each train that meets a conflict counts it by file and line (`.studio/hotspots.json`); at 3
(`STUDIO_HOTSPOT_ASK`) the Producer gets one ask, "hotspot: restructure <file>:<line> (registry/barrel pattern)":
queue a task that moves those lines into a registry. `node harness/hotspots.mjs` lists both.
