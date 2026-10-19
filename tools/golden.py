#!/usr/bin/env python3
"""Standalone 64-bit golden helper.

Does not run the JS sim. It checks golden file shape and can hash a JSON state
with the same 64-bit FNV-style function used by the example cartridge.

Usage:
  python tools/golden.py --check qa/golden
  python tools/golden.py --hash state.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def imul(a: int, b: int) -> int:
    a &= 0xFFFFFFFF
    b &= 0xFFFFFFFF
    if a >= 0x80000000:
        a -= 0x100000000
    if b >= 0x80000000:
        b -= 0x100000000
    return (a * b) & 0xFFFFFFFF


def canonical(value):
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, dict):
        return {k: canonical(value[k]) for k in sorted(value)}
    return value


def hash64(state) -> str:
    raw = json.dumps(canonical(state), separators=(",", ":"), ensure_ascii=False)
    h1 = 0x811C9DC5
    h2 = 0x811C9DC5 ^ 0x01000193
    for i, ch in enumerate(raw):
        c = ord(ch)
        h1 ^= c
        h1 = imul(h1, 0x01000193)
        h2 ^= c
        h2 = imul(h2, 0x01000193)
        h2 = (h2 + i) & 0xFFFFFFFF
    return f"{h1:08x}{h2:08x}"


def check_dir(path: Path) -> int:
    files = sorted(path.glob("*.json"))
    if not files:
        print(f"[golden.py] no json in {path}")
        return 1
    failed = 0
    for file in files:
        spec = json.loads(file.read_text())
        digest = str(spec.get("hash", ""))
        if len(digest) != 16 or digest.startswith("REPLACE"):
            print(f"[golden.py] FAIL {file.name}: expected 64-bit hash, got {digest!r}")
            failed += 1
        else:
            print(f"[golden.py] PASS {file.name} ({digest})")
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", type=Path, help="directory of golden json files")
    parser.add_argument("--hash", type=Path, help="json state file to hash")
    args = parser.parse_args()
    if args.hash:
        state = json.loads(args.hash.read_text())
        print(hash64(state))
        return 0
    if args.check:
        return check_dir(args.check)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
