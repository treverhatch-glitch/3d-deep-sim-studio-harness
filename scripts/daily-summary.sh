#!/usr/bin/env bash
# ============================================================================
# scripts/daily-summary.sh — Roll `.studio/events.jsonl` + `studio/NEXT.md`
# into `studio/daily/YYYY-MM-DD.md` with Before/After video placeholder slots.
#
# Usage:
#   bash scripts/daily-summary.sh [YYYY-MM-DD]
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DATE_STR="${1:-$(date -u +"%Y-%m-%d")}"
OUT_FILE="${REPO_ROOT}/studio/daily/${DATE_STR}.md"

mkdir -p "${REPO_ROOT}/studio/daily/videos"

(
  cd "${REPO_ROOT}"
  node -e '
    import fs from "node:fs";
    const dateStr = process.argv[1];
    const outFile = process.argv[2];
    const eventsRaw = fs.existsSync(".studio/events.jsonl")
      ? fs.readFileSync(".studio/events.jsonl", "utf8").split(/\r?\n/).filter(Boolean)
      : [];
    const events = eventsRaw.slice(-30).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const nextMd = fs.existsSync("studio/NEXT.md") ? fs.readFileSync("studio/NEXT.md", "utf8") : "";
    const totalSaved = events.reduce((s, e) => s + Number(e.tokensSaved || 0), 0);

    const eventBullets = events.length
      ? events.slice(-10).map((e) => `- \`[${(e.ts || "").slice(11, 19)}]\` **${e.agent}** (\`${e.type}\`): ${e.msg}`).join("\n")
      : "- No events recorded yet today.";

    const md = `# Daily Studio Summary — ${dateStr}

> Generated automatically by \`scripts/daily-summary.sh\` at 0% LLM token cost.

## 1. What Happened (${events.length} recent events | ~${totalSaved.toLocaleString()} RTK tokens saved)
${eventBullets}

## 2. Task Queue Snapshot (\`studio/NEXT.md\`)
${nextMd.trim()}

## 3. Gameplay & Visual Before / After

### Before
<!-- Drop before video/GIF path from studio/daily/videos/ here -->
- **Video Placeholder**: \`studio/daily/videos/${dateStr}-before.mp4\`
- **Seed & Tick**: \`{ "seed": 42069, "tick": 0, "description": "Baseline state before fix" }\`
- **Notes**: Capture baseline behavior before changes.

### After
<!-- Drop after video/GIF path from studio/daily/videos/ here -->
- **Video Placeholder**: \`studio/daily/videos/${dateStr}-after.mp4\`
- **Seed & Tick**: \`{ "seed": 42069, "tick": 120, "description": "Verified deterministic replay after fix" }\`
- **Notes**: Capture verified behavior after Stage 1 + Stage 2 QA pass.

## 4. Distilled Memory & Links
- **Distilled Failure Notes**: [\`studio/memory/failures.md\`](../memory/failures.md)
- **Playtest Reports**: \`qa/reports/\`
- **Archived Tasks**: \`studio/done/\`
`;
    fs.writeFileSync(outFile, md, "utf8");
    console.log(`[daily-summary] Wrote ${outFile}`);
  ' "${DATE_STR}" "${OUT_FILE}"
)
