# pixelfx review: a skill pattern for making and reviewing visual effects

**Sources:** [patch-gg/pixelfx](https://github.com/patch-gg/pixelfx) ([skills/pixelfx/SKILL.md](https://github.com/patch-gg/pixelfx/blob/main/skills/pixelfx/SKILL.md), [docs/AUTHORING.md](https://github.com/patch-gg/pixelfx/blob/main/docs/AUTHORING.md), [tools/check.mjs](https://github.com/patch-gg/pixelfx/blob/main/tools/check.mjs), [LICENSE](https://github.com/patch-gg/pixelfx/blob/main/LICENSE), [NOTICE.md](https://github.com/patch-gg/pixelfx/blob/main/NOTICE.md)); [live gallery](https://patch-gg.github.io/pixelfx/). The [X post](https://x.com/Tao_Builds/status/2116414245097423359) couldn't be read. The README now says 244 effects, not ~232.

## 1. How the skill works

- **What it asks.** In order: reuse an existing effect with new options (palette, seed, flip); put it in the game as live JS or a sprite sheet; only then make a new one. Its premise: one-shot prompts give mediocre effects; drafts you render, look at and refine give good ones.
- **Input.** A light spec: a one-line art direction (what, motion, palette, timing) plus a `meta` contract (size, origin, duration, loop, fps, options). Characters get an `act`: wind-up, hit-stop, shake, recovery as timed data. A 10-rule quality bar backs it.
- **Output.** One code file per effect (CPU colour and light buffers), rendered to a PNG contact sheet, GIF/MP4, or a sprite sheet with Aseprite-style JSON for any engine.
- **How it checks.** (a) The agent renders a contact sheet in plain Node (no browser or GPU) and **looks at it**, fixing the worst thing each round, "three rounds minimum"; open briefs get 3 to 5 drafts. (b) It compares against a reference library: "if his has more detail, light or life… yours isn't done". (c) A symptom-to-fix table. (d) `tools/check.mjs` catches spill outside the canvas, one-shots that don't end empty, loop seams, `Math.random`, non-determinism, slow frames and act-timing errors. (e) A person sees the best 2 or 3 drafts if present.

The pattern is cheap and not specific to pixel art: a deterministic stepped clock, a contact sheet, eyes, frame checks, repeat.

## 2. Licence

**MIT**: code and effects, © 2026 Patch and Hugo Duprez. NOTICE.md says some parts are adapted from Hugo Duprez's MIT effects and from Hollow Crown (MIT). The Patch Pixel font is **not** covered. We take ideas only, so no obligation follows. If code is ever copied, the MIT notice must be kept.

## 3. Would a general "generate and review visual effects" skill help?

Yes, for any genre: hit, pickup, button and state-change feedback exist in every game, and the harness today has only a three-line "Juice & feedback" item in `studio/templates/polish-checklist.md`. It needs:

- **Spec** (`fx/<id>.md`, one screen): trigger; what it communicates; one-shot or loop; phases with times (anticipation, release, decay); anchor and on-screen size; palette from the style sheet; host hit-stop/shake; budget; smallest readable size; flash safety (max 3 full-screen flashes a second).
- **Cheap capture.** Borrow the **stepped clock**: never record in real time. A playtest hook (`?fx=<id>&seed=1`, `window.__fx.seek(t)`) renders one frame per call; 12 to 16 stills at 256 px make a contact sheet in about a minute even at a fraction of a frame per second. Engine-side, a fixed-timestep recorder (e.g. Godot's Movie Maker mode) or a sprite-sheet bake does the same; GPU-only particles are captured on the owner's PC or via a CPU fallback.
- **Quality check.** Automated: not empty, one-shots end empty, loop seam, bounds, peak inside the release window, flash rate, budget, same seed same frames (tolerance on GPU). Then a non-builder reviewer model or person judges the sheet against the spec and art reference.
- **Log.** Sheets via `npm run proof -- add` (`studio/proof/<task>/`); check JSON in `qa/reports/fx/`; rounds and approval in the Asset studio (`npm run art -- propose … --thumb`).
- **Plugs into.** A `.claude/skills/vfx/SKILL.md` (When/Steps/Done/Never); a contact-sheet mode on `npm run shot`; `npm run clip` for one final real-speed look; the art director and visual reviewer for taste; it extends PU-07.

## 4. Verdict

**Worth doing, adapted; size M.** Risks:
- Taste can't be auto-checked: checks catch broken effects, not dull ones.
- Engine VFX systems differ (Unity VFX Graph, Godot GPUParticles need a GPU): the seek hook is per engine; GPU frames need tolerances.
- Art licensing: referenced effects need credits via the existing scout/credits flow.
- Scope creep: build the loop and checks, not an effects library.

## 5. Proposal (needs the owner's OK)

| # | Update | Verdict | Priority | Size | How we test it |
| --- | --- | --- | --- | --- | --- |
| PU-15 | **Effect spec, stepped capture and review loop** for VFX and UI feedback: a one-screen spec per effect, a contact sheet of stills at fixed effect times (small size, never real-time), automatic frame checks, then the art review | ADAPT | P2 | M | Plant 4 faults (a one-shot that never ends, a loop seam, an off-screen spill, a 5 Hz full-screen flash): the checks flag all 4. Then 4 bench effect tasks (hit flash, button press, one-shot burst, loop) with and without the skill: proof-wrong verdicts, rounds to approval, reopens, tokens |

A `vfx` skill teaches draft, capture, look, fix: three rounds minimum, 3 drafts when the brief is open. Each effect starts from a short spec (what it communicates, phases and timing, host hit-stop, budget, flash safety). Capture never runs in real time: the game exposes a seek-to-time playtest hook (or an engine fixed-step recorder) and `npm run shot` gains a contact-sheet mode, so slow headless rendering costs a minute. Mechanical checks run on the frames; taste goes to the art director or a cross-family reviewer via `npm run proof`; approval via the Asset studio. Builds on PU-07, measured on the same bench.
