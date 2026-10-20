# Hashing

Two tiers, both over the same bytes: the state as canonical JSON, encoded as UTF-8.
`harness/hash.mjs` and `tools/golden.py` implement both, and `qa/test-golden.py` proves Node and Python
agree on every golden, every regression and the shared edge cases in `qa/hash-vectors.json`.

## The canonical form

Both languages build the text themselves rather than trusting their JSON library, because the
libraries disagree:

- **Keys** are sorted by Unicode code point. `JSON.stringify` puts integer-like keys (`"0"`, `"2"`,
  `"10"`) first in numeric order whatever order they were added in, and JavaScript's default sort
  compares UTF-16 units, so an emoji key sorts differently from Python. Both are avoided.
- **Numbers** are written the way JavaScript writes them (`0.00001`, `1e-7`, `1e+21`, `3`), and
  `tools/golden.py` rebuilds that layout from Python's shortest digits. Python's own `json` writes
  `1e-05` and `1e-07`. `-0` is written `0`; `NaN` and `Infinity` are `null` (and break an invariant).
- **No spaces**; strings escaped as `JSON.stringify` escapes them.

Before 2.13.0 a state with integer-like keys (an entity map, a tile grid) or a float below 0.0001
hashed differently in Node and Python. The example game had neither, so no golden changed.

| Tier | Function | Size | Use it for | Don't use it for |
| --- | --- | --- | --- | --- |
| Display | `hash64()` (FNV-1a 64) | 16 hex | The HUD, playtest reports, a quick "did the state change?" inside a cartridge or a browser | Anything another party has to trust |
| Verification | `sha256()` (SHA-256) | 64 hex | Golden files, regressions, the slice, soak, balance sweeps, playtest determinism, exported trajectories, anything shared, sold or rewarded | Code inside a cartridge (it needs `node:crypto`) |

Every check that asserts determinism compares SHA-256. Scenario goldens also pin `actionsSha256`, the
SHA-256 of every action the scenario's policy took, so a run that reaches the same end state a
different way is caught. A cartridge may export its own `hashState()` for display; `--update` then
marks the golden `"hashKind": "custom"` and Python checks only the SHA-256.

## Why two

- **Display** has to be cheap and run anywhere, including inside a cartridge with no imports, so it
  is pure JS (BigInt). It is one true 64-bit FNV-1a lane, checked against the standard test vectors
  in the self-test. (Before 2.10.0 it was two correlated 32-bit lanes, weaker than its width.)
- **Verification** has to hold at scale and against someone trying: a 64-bit hash reaches even odds
  of an accidental collision after about 4 billion distinct states, and FNV can be forged on purpose.
  SHA-256 has no practical collisions, is built into Node and Python, and is the hash other tools
  already trust.

## What a hash proves, and what it doesn't

A matching SHA-256 proves two states are byte-for-byte the same. It doesn't prove who produced a
state, or that the code which produced it is honest: anyone can hash a state they made up. Trust
comes from **replaying**: the verifier re-runs the seed and actions with the same cartridge and checks
the SHA-256 itself, which is what `qa/check-golden.mjs` and `qa/test-golden.py` do. Proving *who*
made a result needs a signature: `npm run sign` (see `docs/SIGNED-RESULTS-AND-DATA.md`).

## Changing a hash

Changing either function, the canonical form, or a cartridge's state changes every golden. Regenerate
in the same commit:

```bash
npm run golden -- --update
node qa/check-regressions.mjs --update
```

- JS checks: `node qa/check-golden.mjs`, `node qa/check-regressions.mjs`
- Python: `node qa/run-python.mjs qa/test-golden.py`, `node qa/run-python.mjs tools/golden.py --check qa/golden`
- Hash a state file in Python: `python tools/golden.py --hash state.json`
