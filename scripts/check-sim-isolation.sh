#!/usr/bin/env bash
# ============================================================================
# scripts/check-sim-isolation.sh — Simulation Isolation & Boundary Checker
#
# Exits non-zero if forbidden rendering/DOM imports (`three`, `react`,
# `@react-three`, `document.`, `window.`) or unseeded randomness appear
# inside pure simulation paths.
#
# Usage:
#   ./scripts/check-sim-isolation.sh [root]
# ============================================================================

set -euo pipefail

ROOT="${1:-.}"
SIM_PATHS=(
  "src/sim"
  "src/game/sim"
  "src/game/pathfinding"
  "src/game/economy"
)

FORBIDDEN=(
  "from ['\"]three['\"]"
  "from ['\"]react['\"]"
  "from ['\"]@react-three"
  "document\."
  "window\."
  "Math\.random\("
)

found=0
for path in "${SIM_PATHS[@]}"; do
  dir="$ROOT/$path"
  if [ -d "$dir" ]; then
    for pattern in "${FORBIDDEN[@]}"; do
      if grep -rE --include="*.ts" --include="*.tsx" "$pattern" "$dir" 2>/dev/null | grep -v "__sim" | grep -v "__hatch" | grep -v "playtest"; then
        echo "Violation in $dir: pattern $pattern"
        found=1
      fi
    done
  fi
done

# Also run the Node AST/regex purity checker if node is installed
if command -v node >/dev/null 2>&1 && [ -f "$ROOT/scripts/check-sim-purity.mjs" ]; then
  node "$ROOT/scripts/check-sim-purity.mjs" || found=1
fi

if [ "$found" -eq 1 ]; then
  echo "Sim isolation check failed."
  exit 1
else
  echo "Sim isolation check passed (or no sim paths present)."
  exit 0
fi
