#!/usr/bin/env bash
# Multi-model router for Hatchfield AI Studio.
# Primary: Vertex Gemini. Failover: free NVIDIA GLM / Groq.
# Logs every dispatch to the event log (zero token cost for monitoring).
#
# Usage: ./scripts/llm-dispatch.sh "task description" [preferred-model]
# Environment variables (set these):
#   VERTEX_API_KEY, NVIDIA_API_KEY, GROQ_API_KEY

set -euo pipefail

TASK="${1:-}"
PREFERRED="${2:-auto}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$TASK" ]; then
  echo "Usage: $0 \"task description\" [preferred-model]"
  exit 1
fi

# Helper to log
log_event() {
  local status="$1"
  local worker="$2"
  AGENT=grok-producer WORKER="$worker" "$SCRIPT_DIR/append-event.sh" "$status" "" "" "$worker"
}

echo "Dispatching task: $TASK"
log_event "DISPATCH_START" "router"

# Simple routing decision (extend with real API calls)
if [ "$PREFERRED" = "auto" ] || [ "$PREFERRED" = "vertex" ]; then
  if [ -n "${VERTEX_API_KEY:-}" ]; then
    echo "→ Routing to Vertex Gemini (primary)"
    log_event "ROUTED" "vertex-gemini"
    # TODO: actual Vertex call here
    # curl ... 
    exit 0
  else
    echo "Vertex key missing, falling back..."
  fi
fi

if [ -n "${NVIDIA_API_KEY:-}" ]; then
  echo "→ Routing to NVIDIA GLM 5.3 Flash (failover)"
  log_event "ROUTED" "nvidia-glm-5.3-flash"
  # TODO: actual NVIDIA call
  exit 0
fi

if [ -n "${GROQ_API_KEY:-}" ]; then
  echo "→ Routing to Groq (failover)"
  log_event "ROUTED" "groq"
  # TODO: actual Groq call
  exit 0
fi

echo "ERROR: No API keys available for routing."
log_event "FAILED" "none"
exit 1
