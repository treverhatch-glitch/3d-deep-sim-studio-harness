#!/usr/bin/env bash
# ============================================================================
# scripts/session-start.sh — Thin-Context Session Restoration Hook
#
# Runs automatically at session startup (or manually via `npm run session:start`)
# so the agent resumes from `studio/CURRENT_TASK.md` and `studio/NEXT.md`
# instead of re-reading 80,000 tokens of chat history.
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_TASK="${REPO_ROOT}/studio/CURRENT_TASK.md"

echo "===================================================================="
echo " 3D DEEP-SIM STUDIO — SESSION START RESTORE (THIN CONTEXT)"
echo "===================================================================="

if [[ -f "${CURRENT_TASK}" ]]; then
  cat "${CURRENT_TASK}"
else
  echo "No studio/CURRENT_TASK.md found yet."
fi

echo ""
echo "--- Next Queued Task (studio/NEXT.md) ---"
if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node harness/task.mjs next) || true
  (cd "${REPO_ROOT}" && node harness/event.mjs \
    --type "session.start" \
    --agent "producer" \
    --tokens-saved 8000 \
    --msg "Restored thin-context session state from studio/CURRENT_TASK.md" \
    --quiet) || true
fi
