#!/usr/bin/env bash
# Kept for old docs and habits; the script is scripts/snapshot-state.mjs (runs on any OS).
exec node "$(dirname "$0")/snapshot-state.mjs" "$@"
