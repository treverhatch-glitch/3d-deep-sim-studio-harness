#!/usr/bin/env bash
# ============================================================================
# scripts/seed-demo-events.sh — Seed Demo Events for the War Room
#
# Populates `.studio/events.jsonl` with realistic multi-agent start/complete
# timestamps, durations, tasks, and RTK token savings so the Mission Control
# War Room displays live agent runtimes immediately after cloning.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${REPO_ROOT}/.studio"

(
  cd "${REPO_ROOT}"
  node harness/event.mjs --type task.start --agent producer --provider xai-grok --model grok-4-latest --task "T-001" --target "studio/NEXT.md" --status CODING --duration 14200 --saved 6400 --msg "Triaged studio/NEXT.md and locked deterministic seed invariant"
  node harness/event.mjs --type brief.prepare --agent designer-calibrator --provider ollama-local --model qwen2.5-coder:14b --task "T-002" --target "studio/llms.txt" --status CODING --duration 3800 --saved 18200 --msg "Prepared <=300w context brief from failures.md + events.jsonl"
  node harness/event.mjs --type sim.step --agent builder --provider nvidia-nim-glm --model z-ai/glm5 --task "T-003" --target "cartridges/example-sim/index.mjs" --status RUNNING_VITEST --duration 22400 --saved 12400 --msg "Implemented deterministic Mulberry32 seed + tick step(state, action)"
  node harness/event.mjs --type asset.glb --agent asset-3d --provider ollama-local --model qwen2.5-coder:14b --task "T-003" --target "tools/blender/generate_glb.py" --status CODING --duration 9100 --saved 4100 --msg "Generated low-poly crate.glb, cone.glb, and vehicle.glb via headless bpy"
  node harness/event.mjs --type qa.pass --agent qa-playtester --provider groq-llama-70b --model llama-3.3-70b-versatile --task "T-004" --target "qa/playtest.mjs" --status PLAYTESTING --duration 16500 --saved 9800 --msg "Verified ?playtest=1 (window.__sim) seed=42069 tick=120"
  node harness/event.mjs --type review.pass --agent reviewer --provider vertex-gemini-pro --model gemini-2.5-pro --task "T-005" --target "scripts/check-sim-isolation.sh" --status IDLE --duration 5400 --saved 7600 --msg "Sim isolation & determinism hash verified (0 DOM/Three leaks)"
)

echo "[seed-demo-events] Seeded 6 demo studio events into .studio/events.jsonl"
