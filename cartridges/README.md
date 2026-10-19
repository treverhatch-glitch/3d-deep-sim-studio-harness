# Simulation Cartridges (`cartridges/`)

Drop your 3D simulation game into `cartridges/<your-game-name>/` (or `src/sim/` + `src/render/`) without modifying the studio harness.

## Cartridge Structure
```text
cartridges/<your-game>/
├── sim/                  # Pure TypeScript simulation (checked by scripts/check-sim-purity.mjs)
│   ├── state.ts          # Plain-JSON SimState + TUNING table
│   ├── rng.ts            # Seeded sfc32 PRNG stored in SimState.rng
│   ├── clock.ts          # Fixed-timestep integer tick accumulator
│   └── step.ts           # Deterministic tick systems + action dispatcher
└── render/               # Three.js / WebGL stateless projection + ?playtest=1 bridge
```

## Wiring `?playtest=1` (`window.__sim`) for Stage 1 & Stage 2 QA
In your browser entry point, expose your simulation adapter when `?playtest=1` is present in the URL:

```ts
if (new URLSearchParams(window.location.search).get('playtest') === '1') {
  (window as any).__sim = mySimAdapter;
}
```

Then run:
```bash
node scripts/check-sim-purity.mjs
node qa/playtest.mjs --url http://127.0.0.1:5173/?playtest=1
```
