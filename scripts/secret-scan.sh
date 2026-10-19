#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

# Length-anchored patterns. Avoid matching provider ids like xai-grok.
PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'
  'sk_live_[A-Za-z0-9]{16,}'
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]{20,}'
  'github_pat_[A-Za-z0-9_]{20,}'
  'xoxb-[A-Za-z0-9-]{20,}'
  'glpat-[A-Za-z0-9_-]{16,}'
  'AIza[0-9A-Za-z_-]{30,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'
  'hf_[A-Za-z0-9]{20,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)

found=0
for p in "${PATTERNS[@]}"; do
  if grep -RInE "$p" "$ROOT" \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=.studio \
    --exclude='secret-scan.sh' \
    --exclude='*.lock' >"$OUT" 2>/dev/null; then
    echo "[secrets] match for pattern"
    cat "$OUT"
    found=1
  fi
done

if [ "$found" -eq 1 ]; then
  echo "[secrets] FAIL"
  exit 1
fi
echo "[secrets] PASS"
