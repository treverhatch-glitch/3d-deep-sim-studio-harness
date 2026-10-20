#!/usr/bin/env python3
"""Prove every golden and regression matches a real replay, hashed independently in Python.

First the shared hash vectors (qa/hash-vectors.json). Then for each qa/golden/*.json and qa/regressions/*.json: shape check, then `node harness/replay.mjs --golden <file> --state-out <tmp>`
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
REGRESSIONS = ROOT / "qa" / "regressions"
sys.path.insert(0, str(ROOT / "tools"))
from golden import canonical_json, hash64, sha256  # noqa: E402

VECTORS = ROOT / "qa" / "hash-vectors.json"


def check_vectors() -> int:
    """Edge cases where JSON libraries disagree: integer-like keys, tiny and huge floats, -0, emoji keys."""
    failed = 0
    for v in json.loads(VECTORS.read_text(encoding="utf-8"))["vectors"]:
        value = json.loads(v["input"])
        text = canonical_json(value)
        if text != v["canonical"] or sha256(value) != v["sha256"]:
            print(f"[test-golden] FAIL hash vector {v['input']}: python wrote {text}, node wrote {v['canonical']}")
            failed += 1
    if not failed:
        print(f"[test-golden] PASS {len(json.loads(VECTORS.read_text(encoding='utf-8'))['vectors'])} hash vectors match Node byte for byte")
    return failed


def main() -> int:
    files = sorted(GOLDEN.glob("*.json")) + sorted(REGRESSIONS.glob("*.json"))
    if not list(GOLDEN.glob("*.json")):
        print("[test-golden] FAIL no golden files")
        return 1
    failed = check_vectors()
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
        elif spec.get("hashKind") != "custom" and display and py_hash != display:
            print(f"[test-golden] FAIL {file.name}: python display hash {py_hash} != golden {display}")
            failed += 1
        else:
            what = "sha256 (the cartridge uses its own display hash)" if spec.get("hashKind") == "custom" or not display else "sha256 and display hash"
            print(f"[test-golden] PASS {file.parent.name}/{file.name} (replayed; python {what} match, {digest[:16]}...)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
