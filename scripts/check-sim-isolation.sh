#!/usr/bin/env bash
# Kept for old docs and habits; the check is scripts/check-sim-isolation.mjs (runs on any OS).
exec node "$(dirname "$0")/check-sim-isolation.mjs" "$@"
