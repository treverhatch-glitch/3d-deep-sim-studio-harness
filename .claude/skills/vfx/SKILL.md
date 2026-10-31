---
name: vfx
description: Use to make or change a visual effect (particles, VFX, UI feedback such as a hit flash or a button press) and prove it with a contact sheet and frame checks.
---
### When
- A task asks for a new effect, or a change to how one looks or times.
- A reviewer said an effect is wrong (doesn't end, jumps when it loops, flashes, gets clipped).

### Steps
1. **Spec first.** `npm run vfx -- new <id> [--kind one-shot|loop] [--ms 400]` writes `studio/vfx/<id>.json`. Fill in
   what it communicates (one sentence a player would agree with), its phases and their times (they must add up to
   `durationMs`), the stage size, the palette, the budget and the seed. `npm run vfx -- validate <id>` must pass.
2. **Reuse before you build.** If the game already has an effect close to this one, change its parameters (colour,
   seed, size, timing) before writing a new one.
3. **Draw it from time and seed only.** The effect at time t with seed s must always look the same: no
   `Math.random`, no wall clock. Expose it through the page hook `window.__studioVfx.render(id, { tMs, seed, w, h })`
   in playtest mode, drawing into `#studio-vfx-stage` (docs/VFX.md). Never in a player build.
4. **Capture and look.** `npm run vfx -- check <id> --url <page>` takes stills at fixed effect times (not real
   time: it works without a GPU), writes a contact sheet and runs the checks. **Open the contact sheet and look at
   it.** Fix the single worst thing you see, then check again. At least three rounds; for an open brief, make 3
   drafts and keep the best one.
5. **Hand it to review.** `npm run vfx -- check <id> --url <page> --task <T-ID>` puts the contact sheet and the
   report in `studio/proof/<T-ID>/`; the reviewer (another model family, or the art director) judges taste.

### Done means
- `npm run vfx -- check <id>` passes every check: draws, ends-empty (one-shot) or loop-seam (loop), stays-inside,
  flash-rate (at most 3 full-stage flashes a second), same-seed.
- The contact sheet is in the task's proof, and the review says it communicates what the spec says.

### Never
- Call an effect done from the code alone, without looking at its contact sheet.
- Record in real time or raise a limit to make a check pass; fix the effect.
- Copy another project's effect code or art. Ideas and timing principles only; art needs its licence recorded
  (docs/ART-PIPELINE.md).
