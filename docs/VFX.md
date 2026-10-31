# Visual effects: spec, contact sheet, checks (`npm run vfx`)

2.56.0 (PU-15). For particles, VFX and UI feedback (a hit flash, a button press, a burst, a looping glow) in any
genre, 2D or 3D. An effect is judged from **stills taken at fixed effect times**, never by recording in real time,
so it works on a machine with no GPU, where a headless browser may draw a 3D scene at a fraction of a frame per
second. Agents follow the `vfx` skill (`.claude/skills/vfx/SKILL.md`).

```bash
npm run vfx -- new hit-flash --kind one-shot --ms 300     # studio/vfx/hit-flash.json, a starter spec
npm run vfx -- validate hit-flash                         # the spec itself
npm run vfx -- check hit-flash --url <page> [--task T-12] # stills, contact sheet, checks
npm run vfx -- list                                       # every spec and its last result
```

## The spec (`studio/vfx/<id>.json`)

| Field | Meaning |
| --- | --- |
| `communicates` | one sentence: what the player should understand at a glance |
| `kind`, `durationMs` | `one-shot` (plays once and ends) or `loop` (one cycle), and how long |
| `phases` | `[{ name, ms }]`, adding up to `durationMs` (for example anticipation, impact, dissipate) |
| `stage` | `{ w, h, background }`: the capture size in pixels, 16 to 1024. Small is the point |
| `anchor`, `palette` | where it sits on its owner, and its colours |
| `budget` | how much of a frame it may cost in the game (checked in the game's own perf tests) |
| `flash` | `{ maxPerSecond: 3, fullStageShare: 0.5 }`: at most 3 full-stage flashes a second |
| `seed`, `frames` | the seed every capture uses, and how many stills go on the contact sheet (4 to 32) |
| `url` | the page with the hook (or pass `--url`) |
| `allowEdge` | `true` only for an effect meant to fill or cross its stage (a screen-wide wipe) |

## The game's side: the capture hook

In playtest mode (never in a player build), a page exposes:

```js
window.__studioVfx = {
  render(id, { tMs, seed, w, h }) { /* draw effect `id` as it looks tMs after it starts; tMs < 0 clears it */ },
};
```

It draws into an element with id `studio-vfx-stage`, `w` × `h` pixels, on the spec's background, and may return a
promise. The same `tMs` and `seed` must always draw the same picture.

**Engines (Godot, Unity): not built yet.** The planned contract is a command in `STUDIO_VFX_CAPTURE_CMD` that writes
one PNG per requested time (`{id} {seed} {w} {h} {times} {out}`), for example a fixed-step recorder in the editor.
Untested.

## The checks

| Check | Fails when |
| --- | --- |
| `draws` | nothing is drawn at any captured time |
| `ends-empty` | a one-shot's last frame still shows more than 5% of the effect at its largest |
| `loop-seam` | a loop's end frame differs from its start by more than a quarter of what it draws there |
| `stays-inside` | drawn pixels touch the stage edge (clipped by, or spilling past, its bounds) |
| `flash-rate` | more than `flash.maxPerSecond` full-stage flashes a second (photosensitivity guidance: 3) |
| `same-seed` | two renders of the same time with the same seed differ (unseeded randomness) |

They catch broken effects, not dull ones: taste is the reviewer's job, from the contact sheet.

## Results

`.studio/vfx/<id>/report.json`, `contact.png` and `frames/`, plus an event `vfx.checked` (so `npm run metrics` and
the run report see it). `--task T-12` copies the contact sheet and the report into `studio/proof/T-12/`.

Proof that the checks bite: `node scripts/check-vfx.mjs` (CI's browser job). A demo page with two clean effects
and six planted faults; every fault must be named and the clean ones must pass.
