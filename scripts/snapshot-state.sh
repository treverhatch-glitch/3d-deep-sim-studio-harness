#!/usr/bin/env bash
# Copies key state files into a timestamped folder before risky changes

set -e
STAMP=$(date -u +%Y%m%d-%H%M%S)
DEST=".studio/snapshots/$STAMP"
mkdir -p "$DEST"

cp -f studio/CURRENT_TASK.md "$DEST/" 2>/dev/null || true
cp -f studio/memory/failures.md "$DEST/" 2>/dev/null || true
cp -f studio/templates/seed-failure.json "$DEST/" 2>/dev/null || true

echo "Snapshot saved to $DEST"
