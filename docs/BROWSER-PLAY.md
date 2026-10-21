# Playing the game in the browser

Every sim gate can be green while the game in the browser is blank, frozen, or shows the wrong
numbers. `npm run play:browser` (the required `browser-play` gate) catches that.

## What it does

1. Opens the game's browser build in Chromium (`--use-angle=metal` on macOS; pointer lock is stood in
   for, so games that capture the mouse still get input headless).
2. Fails on script errors or a missing file, a blank canvas, or a clock that doesn't move.
3. Plays the cartridge's scenario (start-to-win) with **real key presses and clicks**: the scenario's
   policy picks the action from the live state, and the cartridge says which input performs it.
4. Reads `window.__sim` (the sim) and `window.__view()` (what the page shows) in the same instant,
   every step, and fails on any mismatch, or when the camera is inside geometry.
5. Requires the expected outcome in time, then runs the browser regressions in
   `qa/regressions/browser/` on the live page.
6. Saves start, middle and end screenshots and a report in `qa/reports/`.

## What a cartridge declares (qa.mjs)

```js
export const browser = {
  page: 'web/my-game/index.html',     // served from this repo; or url: 'http://127.0.0.1:5173/'
  query: 'playtest=1&speed=2',
  scenario: 'start-to-win',
  maxMs: 40000,
  input: (action) => (action.type === 'build' ? { key: 'b' } : action.type === 'select' ? { click: '#slot-1' } : null),
  wiring: (state, view) => (view.hud.gold !== state.gold ? [`HUD gold ${view.hud.gold}, sim ${state.gold}`] : []),
  // Every button, key and clickable spot, and what it must do. Each is tried before the play; one that
  // does nothing fails (CONTROL-DEAD). `when` waits until it's fair to try (enough gold to build).
  controls: [
    { name: 'pad 10 builds there', mouse: [612, 344], when: (s) => s.gold >= 50, expect: (a, b) => b.pads[10] && !a.pads[10] },
    { name: 'empty space buys nothing', mouse: [20, 20], expect: (a, b) => b.buildings.length === a.buildings.length },
  ],
};
```

List every control. Solar Outpost's pads overlapped, and a click on empty space bought a building. Every
gate was green, and a person found both in a minute; a `controls` list finds them on every run. The gate
also notes the pace: when a perfect player wins in under 5% of the Bible's play length, the report says
the game may be too fast to read (a note, not a failure).

The page, with `?playtest=1`, sets `window.__sim = { getState }` and `window.__view = () => ({ hud: {…},
drawn, camera: { inside } })`, read from the page itself (the DOM, the scene graph), never copied from
the sim, or a wiring bug can't show. `web/example-sim/` is a small working example.

A bundled game (Vite, Webpack…) declares where its build goes instead of `page`:

```js
export const browser = { dist: 'game/my-game/dist', build: 'npm --prefix game/my-game run build', query: 'playtest=1', /* input, wiring, … */ };
```

The gate runs the build, serves `dist/` and plays that, so it never sees agents' half-saved files the
way a dev server would; the same build is saved for `npm run play` and the Arcade.

`PLAYTEST_URL` or `--url` points the gate at your own dev server instead. A cartridge with no
`browser` passes with a note. Without Chromium the template game is skipped; a real game fails,
because skipping is how "green but broken" ships.

## When it fails before playing

- **A renderer with no contract fails.** A game with a `game/<name>/` or `web/<name>/` folder whose qa.mjs
  declares no `browser` fails with BROWSER-CONTRACT-MISSING. A sim-only game, or the template, skips.
- **A dead `PLAYTEST_URL` is skipped.** When `PLAYTEST_URL` in `.env` doesn't answer, the check plays the
  cartridge's own page or build and prints a note. Clear it unless you mean to play a dev server.
- **Finding a browser.** Order: `PLAYWRIGHT_CHROMIUM`, Playwright's own browser (`npx playwright install
  chromium`), then the installed Chrome or Edge (Windows and macOS included).

## Renderer work and bugs

Tasks carry the part of the game they touch: `npm run task -- add "…" --part sim|renderer|both`.

- Renderer or both: done needs screenshots with a line each (`npm run proof -- add`) and a check by
  someone other than the builder (`npm run proof -- check … --verdict matches|wrong`), against the
  images and the approved art reference. The screenshots are copied to `studio/proof/<task>/`.
- A renderer bug closes with a browser regression, `qa/regressions/browser/<task>.mjs`, that a
  passing `npm run play:browser` ran after the fix (`studio/skills/bug.md`).
