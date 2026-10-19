#!/usr/bin/env bash
# ============================================================================
# scripts/pre-compact.sh — Durable Pre-Compaction & Pre-Stop Checkpoint Hook
#
# Borrowed from Claude-Code-Game-Studios & adapted for the 3D Deep-Sim Studio:
#   1. Reads `## CHECKPOINT` and `## STATUS` from `studio/CURRENT_TASK.md`.
#   2. Lists modified/untracked git files.
#   3. Appends a timestamped entry to `.studio/session-logs/compaction-log.txt`.
#   4. Emits a passive `session.precompact` event to `.studio/events.jsonl`.
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_TASK="${REPO_ROOT}/studio/CURRENT_TASK.md"
LOG_DIR="${REPO_ROOT}/.studio/session-logs"
LOG_FILE="${LOG_DIR}/compaction-log.txt"
TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mkdir -p "${LOG_DIR}"

{
  echo "===================================================================="
  echo "COMPACTION SNAPSHOT @ ${TS}"
  echo "===================================================================="
  if [[ -f "${CURRENT_TASK}" ]]; then
    cat "${CURRENT_TASK}"
  else
    echo "WARN: studio/CURRENT_TASK.md not found."
  fi
  echo ""
  echo "--- Changed Files (git status --short) ---"
  git -C "${REPO_ROOT}" status --short 2>/dev/null || echo "(not a git worktree)"
  echo ""
} >> "${LOG_FILE}"

if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node harness/event.mjs \
    --type "session.precompact" \
    --agent "producer" \
    --tokens-saved 12000 \
    --msg "Saved pre-compaction checkpoint to .studio/session-logs/compaction-log.txt" \
    --quiet) || true
fi

echo "[pre-compact] Checkpoint archived to .studio/session-logs/compaction-log.txt at ${TS}"
