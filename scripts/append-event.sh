#!/usr/bin/env bash
# ============================================================================
# scripts/append-event.sh — Zero-Token Passive Event Logger
#
# Appends one JSON line to `.studio/events.jsonl` (and mirrors to
# `/tmp/agent-events.jsonl` when writable) for the visual Workflow UI HUB.
# Uses 0% LLM tokens.
#
# Usage:
#   ./scripts/append-event.sh STATUS [file] [bugId] [worker]
#   AGENT=grok-producer WORKER=nvidia-glm ./scripts/append-event.sh RUNNING_VITEST src/game/sim.ts P0-12
# ============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS="${1:-RUNNING}"
FILE="${2:-}"
BUGID="${3:-}"
WORKER="${4:-${WORKER:-vertex-gemini-pro}}"
AGENT="${AGENT:-grok-producer}"
TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mkdir -p "${REPO_ROOT}/.studio"

if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node -e '
    const fs = require("fs");
    const [ts, agent, worker, status, file, bugId] = process.argv.slice(1);
    const evt = {
      id: "evt_" + Date.now(),
      ts,
      type: status.toLowerCase(),
      agent,
      worker,
      provider: worker,
      status,
      file: file || null,
      bugId: bugId || null,
      task: bugId || null,
      tokensSaved: 4200,
      msg: `${status}${file ? " (" + file + ")" : ""}${bugId ? " [" + bugId + "]" : ""}`
    };
    const line = JSON.stringify(evt) + "\n";
    fs.appendFileSync(".studio/events.jsonl", line, "utf8");
    try { if (fs.existsSync("/tmp")) fs.appendFileSync("/tmp/agent-events.jsonl", line, "utf8"); } catch {}
  ' "$TS" "$AGENT" "$WORKER" "$STATUS" "$FILE" "$BUGID")
else
  printf '{"ts":"%s","type":"%s","agent":"%s","worker":"%s","provider":"%s","status":"%s","file":"%s","bugId":"%s","msg":"%s"}\n' \
    "$TS" "$STATUS" "$AGENT" "$WORKER" "$WORKER" "$STATUS" "$FILE" "$BUGID" "$STATUS $FILE $BUGID" \
    >> "${REPO_ROOT}/.studio/events.jsonl"
fi

echo "Event logged to .studio/events.jsonl: ${STATUS} (agent=${AGENT}, worker=${WORKER})"
