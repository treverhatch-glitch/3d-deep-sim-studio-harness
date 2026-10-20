#!/usr/bin/env bash
# scripts/check-sim-isolation.sh [root] — presentation code must not leak into the sim layer.
# Fails on: rendering/UI imports, DOM access, Math.random, and on zero sim files found.
# No line-based exemptions: a comment or the word "playtest" on a line does not excuse it.
set -euo pipefail

ROOT="${1:-.}"
SIM_PATHS=(src/sim src/game/sim src/game/pathfinding src/game/economy cartridges)
FORBIDDEN=(
  "(from|import\\(|require\\()[[:space:]]*['\"](three|react|react-dom|@react-three/[^'\"]*|pixi\\.js|phaser)(/[^'\"]*)?['\"]"
  "\\bdocument\\."
  "\\bwindow\\."
  "Math\\.random"
)

found=0
checked_dirs=0
checked_files=0
for rel in "${SIM_PATHS[@]}"; do
  dir="$ROOT/$rel"
  [ -d "$dir" ] || continue
  checked_dirs=$((checked_dirs + 1))
  n=$(find "$dir" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.jsx' \) -not -path '*/node_modules/*' | wc -l | tr -d ' ')
  checked_files=$((checked_files + n))
  for pattern in "${FORBIDDEN[@]}"; do
    # Skip pure comment lines only (// or * at the start of the line).
    if hits=$(grep -rnE --include='*.ts' --include='*.tsx' --include='*.mts' --include='*.js' --include='*.mjs' --include='*.cjs' --include='*.jsx' \
        "$pattern" "$dir" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'); then
      echo "[isolation] FAIL forbidden pattern in $rel:"
      echo "$hits"
      found=1
    fi
  done
done

if [ "$checked_files" -eq 0 ]; then
  echo "[isolation] FAIL 0 simulation files found under ${SIM_PATHS[*]}"
  found=1
fi

if [ "$found" -eq 1 ]; then
  echo "[isolation] FAILED"
  exit 1
fi
echo "[isolation] PASS — ${checked_files} file(s) in ${checked_dirs} folder(s)"
