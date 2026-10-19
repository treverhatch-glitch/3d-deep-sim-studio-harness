# Contributing & Customizing (`CONTRIBUTING.md`)

Thank you for contributing to the **3D Deep Simulation & AI Game Studio Harness**!

This repository is a **generalized workflow harness**—not a specific finished game. Developers clone this template to build their own 3D simulations while keeping LLM token usage low and simulation logic 100% deterministic.

---

## 1. How to Clone & Customize for Your Own Game

See [`docs/CLONE-AND-CUSTOMIZE.md`](docs/CLONE-AND-CUSTOMIZE.md) for the full walkthrough:
1. Run `npm run setup` to initialize `.studio/`, `.env`, and verify `.studio/events.jsonl`.
2. Add your game simulation under `src/sim/` or `cartridges/<your-game>/` with a **deterministic seed + tick system first**.
3. Add or customize agent roles in `studio/roles/*.md` (no agent caps).

---

## 2. Pull Request Checklist for the Upstream Harness

Before opening a PR to this public template repository:
1. **Zero Secrets**: Verify no real API keys or tokens exist anywhere (`docs/SECRETS.md`).
2. **Game-Agnostic**: Keep game-specific logic inside optional `cartridges/` examples rather than hardcoding a single game into `harness/` or `hub/`.
3. **Simulation Isolation**: Run `bash scripts/check-sim-isolation.sh` and `node qa/playtest.mjs` and confirm both pass.
4. **Distilled Memory**: If fixing a harness or QA bug, record a 4-bullet entry in `studio/memory/failures.md`.
