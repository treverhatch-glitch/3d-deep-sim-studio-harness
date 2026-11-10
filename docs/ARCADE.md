# The Arcade: play the last good build

"Can I play it?" is the question the owner asks most. A dev server shows agents' half-finished edits,
so the harness keeps **the last build that passed the browser check** instead.

## Saved builds

Every time `npm run play:browser` passes (it is a required gate, so every `npm run verify` that passes
does this), the build it just played is copied to `.studio/builds/<id>/` with its outcome, tick and
commit. An unchanged build isn't saved twice; the last 6 are kept.

```bash
npm run play                 # serve the newest saved build: http://127.0.0.1:4610/
npm run play -- --lan        # also on phones on the same Wi-Fi (prints the address)
npm run play -- list         # saved builds; play an older one with --build <id>
# The root redirects to the page in its own folder, so its ./main.mjs loads.
```

2.70.0: a build is also saved, with a short clip, after every merge-train landing (`harness/landing-build.mjs`,
docs/WORK-ORGANIZATION.md); `npm run status -- --brief` and the digest name the latest. `STUDIO_LANDING_BUILD=off`
turns that off.

A bundled game (Vite and the like) declares `browser.dist` and `browser.build` in its qa.mjs; the
harness runs the build and saves `dist/`. A plain page declares `browser.page` (`web/<game>/`), and the
saved build holds that folder, the cartridge and `assets/approved/`.

## Is it fun?

2.80: the War Room's Arcade view is gone; `npm run play` serves the build. `npm run verdict -- yes|not-yet --by <name>`
records a person's verdict on the build (`studio/playtest/verdicts.json`). A yes is what lets the current phase close (docs/GAME-BIBLE.md, Phases); a "not yet" goes
to the Producer with its note (`--note "…"`).

- **Play the last good build** with `npm run play` while the agents keep working; `--build <id>` for an older one.
- **Clips**: `npm run clip [-- --seconds 20] [--task T-012] [--name floor-3]` plays the real build with
  real input and saves an mp4 (ffmpeg) to `qa/reports/clips/`; with `--task` it is kept in
  `studio/proof/<task>/`. `npm run shot [-- --query "floor=3"]` saves one screenshot of the real build.
