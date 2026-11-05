# Rule: Test Ports (`studio/rules/test-ports.md`)

**Applies to:** browser and e2e tests (`*.e2e.*`, `e2e/`, `browser/`, Playwright/Puppeteer specs) and test-runner
configs (`vite.config.*`, `vitest.config.*`, `playwright.config.*`) of the game.

- Do **not** start a test server on a fixed port with `strictPort` (or Playwright's `reuseExistingServer`). Verifies
  run in parallel (a merge train beside a builder, two trains, lane checks): two runs of the same file on the same
  port collide. The second server fails ("Port N is already in use", `EADDRINUSE`), or the test drives the other
  tree's server and fails in ways that look like timing.
- Do ask the OS for a free port: listen on port `0` and read the port back, or use one shared helper that does, then
  pass that port to the server and to the test (an env variable, or the server's returned address).
- A fixed port is fine only for something no two runs ever start at once (a person's own dev server).

Seen first in a crew's 48-hour run: every e2e file had its own fixed port, and trains failed on a different file each
run. The game gate warns about fixed test ports (`[game-gates] WARN game:test-ports`, `node harness/test-ports.mjs`);
the flake triager labels such a red `port-collision` (docs/ONBOARDING-A-GAME.md, "Test ports").
