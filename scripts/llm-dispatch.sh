#!/usr/bin/env bash
# ============================================================================
# scripts/llm-dispatch.sh — Multi-Model Failover Shell Dispatcher
#
# Thin bash wrapper around `node harness/route.mjs` (`freecc:auto` failover):
#   1. Routes prompts to the primary provider for the specified studio role
#      (e.g. Vertex Gemini 2.5 Pro / Flash).
#   2. Instantly fails over to free NVIDIA NIM (GLM 5.3 Flash / Nemotron Ultra),
#      Groq, OpenRouter, or local Ollama on HTTP 429 / 5xx with a 30s+ cooldown.
#   3. Appends passive telemetry to `.studio/events.jsonl` & `/tmp/agent-events.jsonl`.
#
# Usage:
#   bash scripts/llm-dispatch.sh --role builder --prompt "Write fixed-step tick"
#   bash scripts/llm-dispatch.sh --role qa-playtester --dry-run
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
exec node harness/route.mjs "$@"
