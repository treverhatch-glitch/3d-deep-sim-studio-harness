#!/usr/bin/env python3
"""Golden helper in Python: the same two hashes as harness/hash.mjs.

Both read canonical JSON (keys sorted, no spaces) encoded as UTF-8:
  hash64  FNV-1a 64-bit, 16 hex chars: the fast display hash. Not tamper-resistant.
  sha256  SHA-256, 64 hex chars: the verification hash for goldens and regressions.

It does not run the JS sim; qa/test-golden.py replays each golden in Node and hashes the result here.

Usage:
  python tools/golden.py --check qa/golden
  python tools/golden.py --hash state.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = 0xFFFFFFFFFFFFFFFF


def canonical(value):
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    return value


def canonical_bytes(state) -> bytes:
    return json.dumps(canonical(state), separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def hash64(state) -> str:
    h = FNV64_OFFSET
    for byte in canonical_bytes(state):
        h ^= byte
        h = (h * FNV64_PRIME) & MASK64
    return f"{h:016x}"


def sha256(state) -> str:
    return hashlib.sha256(canonical_bytes(state)).hexdigest()


def check_dir(path: Path) -> int:
    files = sorted(path.glob("*.json"))
    if not files:
        print(f"[golden.py] no json in {path}")
        return 1
    failed = 0
    for file in files:
        spec = json.loads(file.read_text(encoding="utf-8"))
        digest = str(spec.get("sha256", ""))
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            print(f"[golden.py] FAIL {file.name}: expected a sha256 (64 hex), got {digest!r}")
            failed += 1
        else:
            print(f"[golden.py] PASS {file.name} (sha256 {digest[:16]}…)")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", type=Path, help="directory of golden json files")
    parser.add_argument("--hash", type=Path, help="json state file to hash")
    args = parser.parse_args()
    if args.hash:
        state = json.loads(args.hash.read_text(encoding="utf-8"))
        print(json.dumps({"sha256": sha256(state), "hash": hash64(state)}))
        return 0
    if args.check:
        return check_dir(args.check)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
