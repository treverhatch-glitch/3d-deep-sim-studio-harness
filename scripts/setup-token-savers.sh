#!/usr/bin/env bash
# One-command setup for the highest-ROI token savers.
# Run from the root of a game repo that uses this template.

set -euo pipefail

echo "=== Setting up token savers ==="

# RTK
if ! command -v rtk &>/dev/null; then
  echo "Installing RTK..."
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh || true
else
  echo "RTK already installed."
fi

# QMD (requires bun)
if command -v bun &>/dev/null; then
  if ! command -v qmd &>/dev/null; then
    echo "Installing QMD..."
    bun install -g https://github.com/tobi/qmd || true
  else
    echo "QMD already installed."
  fi

  if [ -d docs ] || [ -d studio ]; then
    echo "Adding docs to QMD collection..."
    qmd collection add ./docs --name docs 2>/dev/null || true
    qmd collection add ./studio --name studio 2>/dev/null || true
    qmd embed || true
  fi
else
  echo "Bun not found. Install bun to use QMD: https://bun.sh"
fi

echo ""
echo "Done. Verify with:"
echo "  rtk gain"
echo "  qmd query 'current task'"
echo ""
echo "Add this to your agent instructions:"
echo "  - Run shell commands through rtk"
echo "  - Query docs with qmd before loading full files"
