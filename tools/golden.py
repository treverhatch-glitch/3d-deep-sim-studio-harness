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
from decimal import Decimal
from pathlib import Path

FNV64_OFFSET = 0xCBF29CE484222325
FNV64_PRIME = 0x100000001B3
MASK64 = 0xFFFFFFFFFFFFFFFF


def js_number(x) -> str:
    """A number written exactly as JavaScript's JSON.stringify writes it (ECMAScript Number::toString).

    Python and JavaScript both find the shortest digits that round-trip; they differ in layout
    (0.00001 vs 1e-05, 1e-7 vs 1e-07, 1e16 vs 1e+16, 3.0 vs 3), so the layout is rebuilt here.
    """
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, int):
        x = float(x) if abs(x) > 2**53 else x
        if isinstance(x, int):
            return str(x)
    if x != x or x in (float("inf"), float("-inf")):
        return "null"
    if x == 0:
        return "0"
    sign = "-" if x < 0 else ""
    _, digits, exp = Decimal(repr(abs(x))).as_tuple()
    s = "".join(map(str, digits)).rstrip("0") or "0"
    exp += len(digits) - len(s)
    k = len(s)
    n = k + exp
    if k <= n <= 21:
        out = s + "0" * (n - k)
    elif 0 < n <= 21:
        out = s[:n] + "." + s[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * (-n) + s
    else:
        e = n - 1
        out = (s if k == 1 else s[0] + "." + s[1:]) + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def canonical_json(value) -> str:
    """Canonical JSON text, identical to harness/hash.mjs canonicalJson(): keys sorted by code point."""
    if value is None:
        return "null"
    if isinstance(value, (bool, int, float)):
        return js_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(value[k]) for k in sorted(value)) + "}"
    raise TypeError(f"not JSON: {type(value).__name__}")


def canonical(value):
    return json.loads(canonical_json(value))


def canonical_bytes(state) -> bytes:
    return canonical_json(state).encode("utf-8")


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
