#!/usr/bin/env bash
# Append one status event for the passive visual HUB.
# Zero LLM tokens. Writes one JSON line to .studio/events.jsonl
#
# Usage:
#   ./scripts/append-event.sh STATUS [file] [bugId] [worker]
#   AGENT=grok-producer WORKER=nvidia-glm ./scripts/append-event.sh RUNNING_VITEST src/game/sim.ts P0-12

set -euo pipefail

STATUS="${1:-RUNNING}"
FILE="${2:-}"
BUGID="${3:-}"
WORKER="${4:-${WORKER:-unknown}}"
AGENT="${AGENT:-grok-producer}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Escape for JSON
escape() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().strip()))'; }

JSON=$(printf '{"ts":%s,"agent":%s,"worker":%s,"status":%s,"file":%s,"bugId":%s}' \
  "$(escape "$TS")" \
  "$(escape "$AGENT")" \
  "$(escape "$WORKER")" \
  "$(escape "$STATUS")" \
  "$(escape "$FILE")" \
  "$(escape "$BUGID")")

mkdir -p .studio
echo "$JSON" >> .studio/events.jsonl
echo "Event logged: $STATUS (worker=$WORKER)"
