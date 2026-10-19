#!/usr/bin/env bash
# Lightweight check for sim isolation violations.
# Exits non-zero if forbidden imports appear under sim paths.
# Usage: ./scripts/check-sim-isolation.sh [root]

set -euo pipefail
ROOT="${1:-.}"
SIM_PATHS=("src/game/sim" "src/game/pathfinding" "src/game/economy")

FORBIDDEN=("from ['\"]three['\"]" "from ['\"]react['\"]" "from ['\"]@react-three" "document\." "window\.")

found=0
for path in "${SIM_PATHS[@]}"; do
  dir="$ROOT/$path"
  if [ -d "$dir" ]; then
    for pattern in "${FORBIDDEN[@]}"; do
      if grep -rE --include="*.ts" --include="*.tsx" "$pattern" "$dir" 2>/dev/null | grep -v "__hatch" | grep -v "playtest"; then
        echo "Violation in $dir: pattern $pattern"
        found=1
      fi
    done
  fi
done

if [ "$found" -eq 1 ]; then
  echo "Sim isolation check failed."
  exit 1
else
  echo "Sim isolation check passed (or no sim paths present)."
  exit 0
fi
