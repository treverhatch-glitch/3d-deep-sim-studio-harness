#!/usr/bin/env bash
# Kept for old docs and habits; the scan is scripts/secret-scan.mjs (runs on any OS).
exec node "$(dirname "$0")/secret-scan.mjs" "$@"
