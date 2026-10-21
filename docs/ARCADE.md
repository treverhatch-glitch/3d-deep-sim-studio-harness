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
# The root (and the War Room's /play/<id>/) redirects to the page in its own folder, so its ./main.mjs loads.
```

A bundled game (Vite and the like) declares `browser.dist` and `browser.build` in its qa.mjs; the
harness runs the build and saves `dist/`. A plain page declares `browser.page` (`web/<game>/`), and the
saved build holds that folder, the cartridge and `assets/approved/`.

## The Arcade (War Room view 5)

- **Play the last good build** in the page, while the agents keep working. Older builds are one click
  away for comparing. The game runs in a sandboxed frame, so game code can't reach the War Room.
- **Notes while playing**, saved with the build you played in `studio/playtest/NOTES.md`: a note for the
  Producer (inbox), a bug (queued for a builder, who starts if a tool is set), or an idea (Idea Board, to R&D).
- **Clips**: `npm run clip [-- --seconds 20] [--task T-012] [--name floor-3]` plays the real build with
  real input and saves an mp4 (ffmpeg) to `qa/reports/clips/`; with `--task` it is kept in
  `studio/proof/<task>/`. `npm run shot [-- --query "floor=3"]` saves one screenshot of the real build.
- **The dungeon**, read-only: each floor is a phase of the game, each room a task. Cleared rooms drop
  loot, lit rooms show the agent working there, slimes are open bugs and a crowned one is a P0 boss.
  Walk it with the arrow keys or a click; your XP is the points of work done. It changes nothing.
