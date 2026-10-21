# The dev hacker (Dev Hacker Lab)

The dev hacker knows how game developers get around hard problems, and fits those tricks to this game.
Some examples:
- an elevator, helicopter or corridor ride that hides the next level loading;
- object pools instead of allocating every frame;
- a fixed-timestep accumulator;
- instanced props and baked lighting;
- LOD and impostors;
- streaming triggered by volumes in the level.

It works beside the studio, never in its way:

- **It's optional.** The lab is off by default. Open it with `npm run division -- open hacks --reason "…" --by <name>`,
  or with a click on the locked room in the Studio view.
- **It never blocks.** Its hunts are P3, nothing depends on them, and it holds no game-file locks outside
  its own experiment. If it does nothing, nothing changes.
- **It doesn't take orders.** The Director and the Producer keep their flow. The dev hacker sends cards to the
  Producer in batches, and the Producer adopts or parks each one.
- **Every card says when not to use the trick.** Not every game should have an elevator between levels.
  `avoid-if` is required, along with the problem here, the trick, why it fits this game, and how to prove it helped.

## What it works from

These are the same files the rest of the studio uses:
- the Bible and storyboard;
- browser-play and playtest reports;
- the tick and renderer budgets, and module sizes;
- recent bugs;
- the Arcade notes.

A hunt starts in one of two ways:
- the watcher queues one a day while the lab is open;
- the watcher queues one at once when `tick-budget`, `renderer-budget`, `module-size`, `browser-play` or
  `soak` turns red. The hunt names the red check.

## Commands

```bash
npm run trick -- propose "Elevator ride hides the next floor loading" \
  --problem "F3 hitches 400 ms when its models load" \
  --trick "Start loading floor N+1 when the doors close; open them when it is ready" \
  --fits "Every level is a floor of one building; the ride is already in the fiction" \
  --avoid-if "levels aren't separated by a ride, or loads are already under a frame" \
  --proof "longest frame on a floor change, browser check, before vs after" \
  [--source <url>] [--experiment X-003] [--cost 1-5]
npm run trick -- none "frame times are flat; nothing measured to fix"   # a hunt that found nothing is done too
npm run trick -- adopt K-001 --by producer-1 [--phase 1 --serves pillar:<p>] [--lane <folder>]
npm run trick -- park K-001 --why "not this phase" --by producer-1
npm run trick -- list
```

- Cards are kept in `studio/tricks/K-###.md` (with a .json beside each). Hunts that found nothing go in `studio/tricks/HUNTS.md`.
- To try a trick before proposing it, the dev hacker builds a throwaway prototype in an experiment
  (`npm run experiment`) and names it with `--experiment`. The Producer keeps it or drops it.
- An adopted card queues "Build trick K-001: … (prove it: …)" for a builder, with `part: renderer`.
  It is infra work unless the Producer gives it a phase.
- The War Room's Game plan shows the cards in "The dev hacker's tricks".

## Is it worth having?

Yes, as long as it stays tied to measured problems.

The guardrails above exist because a trick researcher that isn't tied to evidence will pitch features:
"add a loading elevator" in a game that has no levels. Each card has to name the problem in this
game, and has to say how the improvement will be measured. The Producer can then judge it the same
way it judges any other task.
