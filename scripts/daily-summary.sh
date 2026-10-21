#!/usr/bin/env bash
# Kept for old docs and habits; the script is scripts/daily-summary.mjs (runs on any OS).
exec node "$(dirname "$0")/daily-summary.mjs" "$@"
