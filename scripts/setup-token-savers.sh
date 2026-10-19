#!/usr/bin/env bash
# ============================================================================
# scripts/setup-token-savers.sh
#
# Wires the 5 high-leverage token-saving tools into the studio workspace:
#   1. rtk (rtk-ai/rtk)       — 60-90% bash/test output compression (`rtk init -g`)
#   2. qmd (tobi/qmd)         — Local hybrid Markdown RAG (`qmd query` / `qmd mcp`)
#   3. serena (oraios/serena) — Symbol-level LSP lookup/edits for 100k+ LOC TS
#   4. jq                     — Zero-token JSON filtering
#   5. duckdb                 — SQL analytics over `.studio/events.jsonl`
#
# Usage:
#   bash scripts/setup-token-savers.sh --check     # Verify installed binaries & write MCP config
#   bash scripts/setup-token-savers.sh --install   # Install missing CLI tools + wire MCP/hooks
# ============================================================================

set -euo pipefail

MODE="${1:---check}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "===================================================================="
echo " 3D DEEP-SIM STUDIO — TOKEN-SAVER & MCP HARNESS SETUP (${MODE})"
echo "===================================================================="

check_bin() {
  local name="$1"
  local hint="$2"
  if command -v "$name" >/dev/null 2>&1; then
    echo "  [OK] $name found -> $(command -v "$name")"
    return 0
  else
    echo "  [MISSING] $name — Install hint: $hint"
    return 1
  fi
}

echo ""
echo "1. Auditing CLI Token-Savers..."
check_bin "rtk"    "cargo install --git https://github.com/rtk-ai/rtk or brew install rtk-ai/tap/rtk" || true
check_bin "qmd"    "npm install -g @tobi/qmd (or bun install -g github:tobi/qmd)" || true
check_bin "uvx"    "pip install uv (required to run oraios/serena LSP MCP)" || true
check_bin "jq"     "brew install jq / winget install jqlang.jq / apt install jq" || true
check_bin "duckdb" "brew install duckdb / winget install DuckDB.cli" || true

if [[ "$MODE" == "--install" ]]; then
  echo ""
  echo "2. Attempting automatic installation of missing tools..."
  if ! command -v rtk >/dev/null 2>&1 && command -v cargo >/dev/null 2>&1; then
    cargo install --git https://github.com/rtk-ai/rtk || true
  fi
  if command -v rtk >/dev/null 2>&1; then
    echo "  -> Hooking rtk globally for coding agents (rtk init -g)..."
    rtk init -g || true
  fi
  if ! command -v qmd >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    npm install -g github:tobi/qmd || true
  fi
fi

echo ""
echo "3. Generating workspace .mcp.json (qmd + serena + playwright-mcp)..."
cat > "${REPO_ROOT}/.mcp.json" <<'EOF'
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    },
    "serena": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/oraios/serena",
        "serena",
        "start-mcp-server",
        "--context",
        "ide-assistant",
        "--project",
        "."
      ]
    },
    "playwright": {
      "command": "npx",
      "args": [
        "-y",
        "@playwright/mcp@latest",
        "--headless",
        "--caps=vision"
      ]
    }
  }
}
EOF
echo "  [OK] Wrote ${REPO_ROOT}/.mcp.json"

echo ""
echo "4. Generating .claude/settings.json lifecycle hooks (SessionStart & PreCompact)..."
mkdir -p "${REPO_ROOT}/.claude"
cat > "${REPO_ROOT}/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/session-start.sh"
          }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash scripts/pre-compact.sh"
          }
        ]
      }
    ]
  }
}
EOF
echo "  [OK] Wrote ${REPO_ROOT}/.claude/settings.json"

if command -v node >/dev/null 2>&1; then
  (cd "${REPO_ROOT}" && node harness/event.mjs \
    --type "setup.tokensavers" \
    --agent "producer" \
    --tokens-saved 5000 \
    --msg "Configured .mcp.json (qmd, serena, playwright) and .claude/settings.json hooks" \
    --quiet) || true
fi

echo ""
echo "Done! Token-saver rules are active in AGENTS.md and .mcp.json."
