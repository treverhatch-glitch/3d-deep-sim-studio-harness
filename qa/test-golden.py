#!/usr/bin/env python3
"""Validate golden files are present and 64-bit."""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "qa" / "golden"
TOOL = ROOT / "tools" / "golden.py"


def main() -> int:
    files = sorted(GOLDEN.glob("*.json"))
    if not files:
        print("[test-golden] FAIL no golden files")
        return 1
    for file in files:
        spec = json.loads(file.read_text())
        digest = str(spec.get("hash", ""))
        if len(digest) != 16:
            print(f"[test-golden] FAIL {file.name} hash is not 64-bit")
            return 1
        if "seed" not in spec or "tick" not in spec:
            print(f"[test-golden] FAIL {file.name} missing seed/tick")
            return 1
    result = subprocess.run([sys.executable, str(TOOL), "--check", str(GOLDEN)])
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
