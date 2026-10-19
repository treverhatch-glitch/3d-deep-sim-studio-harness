#!/usr/bin/env bash
# Appends a distilled bug lesson to studio/memory/failures.md
# Usage: ./scripts/distill-bug.sh "What broke" "Root cause" "The fix" "How to avoid"

set -e
mkdir -p studio/memory
FILE="studio/memory/failures.md"

if [ ! -f "$FILE" ]; then
  echo "# Failure Lessons" > "$FILE"
  echo "" >> "$FILE"
fi

echo "## $(date -u +%Y-%m-%d)" >> "$FILE"
echo "- What broke: $1" >> "$FILE"
echo "- Root cause: $2" >> "$FILE"
echo "- The fix that worked: $3" >> "$FILE"
echo "- How to avoid it next time: $4" >> "$FILE"
echo "" >> "$FILE"

echo "Appended to $FILE"
