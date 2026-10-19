#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-.}"
PATTERNS=(
  'sk-[A-Za-z0-9]'
  'AKIA[0-9A-Z]{16}'
  'ghp_[A-Za-z0-9]'
  'github_pat_'
  'xai-[A-Za-z0-9]'
  'AIza[0-9A-Za-z_-]{20}'
  'sk-ant-'
  'hf_[A-Za-z0-9]'
  '-----BEGIN .*PRIVATE KEY-----'
)
found=0
for p in "${PATTERNS[@]}"; do
  if grep -RInE "$p" "$ROOT" \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=.studio \
    --exclude='*.lock' >/tmp/secret-scan.out 2>/dev/null; then
    echo "[secrets] match for $p"
    cat /tmp/secret-scan.out
    found=1
  fi
done
if [ "$found" -eq 1 ]; then
  echo "[secrets] FAIL"
  exit 1
fi
echo "[secrets] PASS"
