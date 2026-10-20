---
scope: ["src/render/**", "cartridges/**/render/**"]
---

# Path-Scoped Rule: 3D Renderer & GPU Budget (`studio/rules/renderer-budget.md`)

The 3D renderer is a **stateless visual projection** of `SimState`. It reads `SimState` (plus interpolation `alpha`) and emits user `Action` payloads, but never mutates `SimState` directly.

## 1. InstancedMesh & Draw-Call Discipline
- Any repeated simulation entity class with $>16$ active instances (vehicles, agents, trees, crates, runway lights, conveyor items) **MUST** render via `THREE.InstancedMesh` with a pre-allocated capacity buffer.
- Target draw-call budget: **$\le 150$ draw calls** per frame at 60 FPS on mid-range integrated/mobile GPUs.

## 1b. The budget, measured

`node scripts/check-renderer-budget.mjs` with `RENDER_URL` set opens the running build in Chromium,
samples the game's own counters for three seconds, and fails when the worst frame is over these:

```json budget
{ "drawCalls": 150, "triangles": 500000, "lights": 8, "frameMs": 16.7 }
```

The game publishes its counters next to `window.__sim` (Three.js shown; any renderer works):

```js
renderer.info.autoReset = true;
function frame(t) {
  const start = performance.now();
  renderer.render(scene, camera);
  let lights = 0;
  scene.traverse((o) => { if (o.isLight) lights += 1; });
  window.__render = { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, lights, frameMs: performance.now() - start };
  requestAnimationFrame(frame);
}
```

## 2. Procedural & `.glb` PBR Asset Discipline
- Prefer headless Blender (`tools/blender/generate_glb.py`) low-poly `.glb` meshes with shared PBR material palettes (`MeshStandardMaterial` roughness/metalness) over high-poly unoptimized textures.
- Dispose geometries, materials, and render targets explicitly on scene teardown to prevent WebGL memory leaks.

## 3. Debug & Playtest Bridge (`?playtest=1`)
- When `new URLSearchParams(window.location.search).get('playtest') === '1'`, mount the simulation adapter at `window.__sim` so `qa/playtest.mjs` can drive and inspect the live game.
