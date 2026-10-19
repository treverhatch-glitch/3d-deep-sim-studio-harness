#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
SIM_PATHS=(
  "src/sim"
  "src/game/sim"
  "src/game/pathfinding"
  "src/game/economy"
  "cartridges"
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
checked_dirs=0
checked_files=0

for path in "${SIM_PATHS[@]}"; do
  dir="$ROOT/$path"
  if [ -d "$dir" ]; then
    checked_dirs=$((checked_dirs + 1))
    dir_files=$(find "$dir" -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.mjs" \) 2>/dev/null | wc -l | tr -d ' ')
    checked_files=$((checked_files + dir_files))
    for pattern in "${FORBIDDEN[@]}"; do
      if grep -rE --include="*.ts" --include="*.tsx" --include="*.mjs" "$pattern" "$dir" 2>/dev/null | grep -vE ":\s*(//|\*)" | grep -v "__sim" | grep -v "__hatch" | grep -v "playtest"; then
        echo "[FAIL] Violation in $dir: forbidden pattern $pattern"
        found=1
      fi
    done
  fi
done

if [ "$checked_files" -eq 0 ]; then
  echo "[FAIL] Isolation check found 0 simulation files."
  found=1
fi

if command -v node >/dev/null 2>&1 && [ -f "$ROOT/scripts/check-sim-purity.mjs" ]; then
  node "$ROOT/scripts/check-sim-purity.mjs" || found=1
fi

echo "===================================================================="
if [ "$found" -eq 1 ]; then
  echo " SIM ISOLATION CHECK: FAILED"
  echo "===================================================================="
  exit 1
else
  echo " SIM ISOLATION CHECK: PASSED"
  echo "   Directories Scanned : ${checked_dirs}"
  echo "   Files Verified      : ${checked_files}"
  echo "===================================================================="
  exit 0
fi
