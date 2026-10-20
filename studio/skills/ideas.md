# Skill: ideas

**When.** An `Idea: shape I-…` task (R&D, role `rnd`) or an `Idea: place I-…` task (role `planner`).

**Steps.**
1. `npm run idea -- show <id>` and read `studio/bible/BIBLE.md` and `NOT-DOING.md`.
2. Shaping (R&D): what the player does with it, which phase and layer it belongs to, what it costs to
   build, and any conflict with a pillar or a crossed-out layer. A tiny prototype is fine; build work
   is not. Then `npm run idea -- shape <id> --notes "…"`.
3. Placing (planner): where it lands in the player's progression (phase, layer, unlock point) and in
   the schedule (which milestone, what it pushes back). Then
   `npm run idea -- place <id> --phase <n> [--layer <id>] --unlock "…" --schedule "…"`. That pings
   the Director to decide.

**Done means.** The idea moved to its next stage since the task started.

**Never.** Turn an idea into build tasks yourself. Only an approved idea becomes work, and the
Producer schedules it.
