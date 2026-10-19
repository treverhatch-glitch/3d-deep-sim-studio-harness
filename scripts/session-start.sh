#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_TASK="${REPO_ROOT}/studio/CURRENT_TASK.md"

echo "===================================================================="
echo " 3D DEEP-SIM STUDIO — SESSION START"
echo "===================================================================="

if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node scripts/verify-session.mjs)
fi

if [[ -f "${CURRENT_TASK}" ]]; then
  cat "${CURRENT_TASK}"
else
  echo "No studio/CURRENT_TASK.md found yet."
fi

echo ""
echo "--- Next Queued Task ---"
if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node harness/task.mjs next) || true
fi
