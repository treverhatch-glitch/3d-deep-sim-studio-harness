#!/usr/bin/env python3
"""Prove every golden matches a real replay, hashed independently in Python.

For each qa/golden/*.json: shape check, then `node harness/replay.mjs --golden <file> --state-out <tmp>`
replays the cartridge, and tools/golden.py hashes the final state with SHA-256 (the verification
hash) and FNV-1a 64 (the display hash). Both must equal the stored values. This catches a stale
golden, a JS/Python hash drift, and a missing or malformed hash.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = ROOT / "qa" / "golden"
sys.path.insert(0, str(ROOT / "tools"))
from golden import hash64, sha256  # noqa: E402


def main() -> int:
    files = sorted(GOLDEN.glob("*.json"))
    if not files:
        print("[test-golden] FAIL no golden files")
        return 1
    failed = 0
    for file in files:
        spec = json.loads(file.read_text(encoding="utf-8"))
        digest = str(spec.get("sha256", ""))
        display = str(spec.get("hash", ""))
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            print(f"[test-golden] FAIL {file.name}: sha256 {digest!r} is not 256-bit hex")
            failed += 1
            continue
        if "scenario" not in spec and ("seed" not in spec or "tick" not in spec):
            print(f"[test-golden] FAIL {file.name}: needs seed + tick, or a scenario")
            failed += 1
            continue
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "state.json"
            run = subprocess.run(
                ["node", str(ROOT / "harness" / "replay.mjs"), "--golden", str(file), "--state-out", str(out), "--quiet"],
                cwd=ROOT,
                capture_output=True,
                text=True,
                env={**os.environ, "AGENT_EVENTS_FILE": str(Path(tmp) / "events.jsonl")},
            )
            if run.returncode != 0 or not out.exists():
                print(f"[test-golden] FAIL {file.name}: replay failed\n{run.stdout}{run.stderr}")
                failed += 1
                continue
            state = json.loads(out.read_text(encoding="utf-8"))
            py_sha, py_hash = sha256(state), hash64(state)
        if py_sha != digest:
            print(f"[test-golden] FAIL {file.name}: python sha256 {py_sha} != golden {digest}")
            failed += 1
        elif py_hash != display:
            print(f"[test-golden] FAIL {file.name}: python display hash {py_hash} != golden {display}")
            failed += 1
        else:
            print(f"[test-golden] PASS {file.name} (replayed; python sha256 and display hash match, {digest[:16]}…)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
