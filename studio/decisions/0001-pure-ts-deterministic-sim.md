# ADR-0001: Pure-TypeScript Deterministic Simulation ("Build Playable First, Port Later")

- **Status**: Accepted
- **Date**: 2026-10-19
- **Deciders**: Executive Producer (`producer`), Builder (`builder`), Reviewer (`reviewer`)

## 1. Question
How should we structure a 100,000+ line 3D simulation game so AI coding agents can iterate rapidly on the web while preserving a clean path to Steam (Tauri v2), Godot 4 (`ts2gd`), or Unity (`SharpTS`)?

## 2. Options Considered
1. **Engine-coupled logic**: Write gameplay directly inside Three.js `Object3D` subclasses or Godot/Unity scripts from day one.
2. **Pure-TypeScript deterministic simulation core (`sim/`) + thin renderer bridge (`render/`)**: Keep 100% of game state, tick clock, seeded RNG, and rules in pure TypeScript with zero DOM or Three.js imports.

## 3. Decision
Choose **Option 2 (Pure-TypeScript Deterministic Simulation Core)**.

## 4. Consequences
- AI agents get the fastest edit-test feedback loop in TypeScript (`node qa/playtest.mjs` runs 200+ ticks in milliseconds without a browser).
- Frame-rate bugs, NaN drift, and save-file entity loss are caught automatically in Stage 1 QA.
- Packaging via Tauri v2 or transpiling pure `sim/` modules via `johnfn/ts2gd` (Godot 4) or `nickna/SharpTS` (Unity/.NET) happens late-game after all mechanics are feature-complete.
