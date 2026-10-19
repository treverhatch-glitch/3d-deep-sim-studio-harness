#!/usr/bin/env bash
# Append one status event for the passive visual HUB.
# Usage: ./scripts/append-event.sh "STATUS" "optional-file" "optional-bugId"

STATUS="${1:-RUNNING}"
FILE="${2:-}"
BUGID="${3:-}"
AGENT="${AGENT:-grok-producer}"
WORKER="${WORKER:-unknown}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p /tmp
echo "{\"ts\":\"$TS\",\"agent\":\"$AGENT\",\"worker\":\"$WORKER\",\"status\":\"$STATUS\",\"file\":\"$FILE\",\"bugId\":\"$BUGID\"}" >> /tmp/agent-events.jsonl

echo "Event logged: $STATUS"
