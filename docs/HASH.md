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

## Game IDs: which game a hash belongs to

Two different games can't produce the same SHA-256 by accident. What can get mixed up is which game a
result belongs to: two studios that both call their game `next-floor`, a copied folder, or results
uploaded to a marketplace. So every game gets an ID once, at `npm run new-game` (or at the next
preflight or watcher pass for a game made before 2.25), in `cartridges/<game>/cartridge.json`:

```json
{ "id": "gid_7q2kz…", "cartridge": "next-floor", "name": "Next Floor", "created": "…", "harness": "2.25.0", "parent": "gid_…" }
```

The ID is stamped on goldens, regressions, signed results, saved builds and events.
- **A recording from another game fails**, even when its hashes match.
- **A copy gets its own ID.** A game started from another (a setup carrying a game template) gets a new
  ID, with the original's as `parent`, so a game's family tree can be followed.

The ID is public, and it is not mixed into seeds or state hashes. Anyone must be able to replay a game
from its code and a seed and get the same hash, including a port to another engine. Proving who made a
game is the job of signed results (`npm run sign`), not of a secret. `npm run game-id` shows it.

## Changing a hash

Changing either function, the canonical form, or a cartridge's state changes every golden. Regenerate
in the same commit:

```bash
npm run golden -- --update
node qa/check-regressions.mjs --update
```

## Where a red golden first went wrong (2.72.0)

A golden red on its SHA-256 also prints the first divergence: the harness re-runs it in lockstep on this tree and on
the commit that last changed the golden file (it recorded the hash; `STUDIO_DIVERGENCE_REF` names another commit),
with a cheap per-subsystem digest per tick (FNV-1a of each top-level state key), stops at the first tick where one
differs and names the first field there (`harness/divergence.mjs`):

```
[golden] first divergence: tick 23, resources.credits 1936 -> 1937 (subsystem resources; example-1337.json vs 3f2a1b4c, the commit that recorded it)
```

It runs only on a red (per-tick hashing of the whole state roughly doubles a run), locates the change and never
decides red or green. When the reference commit doesn't reproduce the golden either, the line says so. The result is a
`golden.divergence` event, part of the `gates.run` event (`meta.divergence`) and a "First divergence" line in the
hand-back facts. `STUDIO_GOLDEN_DIVERGENCE=off` turns it off. A cartridge that imports files outside its folder
can't be loaded from the reference commit; the line says so.

2.73.0: the result is also the golden's signed first-divergence report, `.studio/gates/divergence/<golden path, / as
__>.json` (`harness/golden-report.mjs`), written on a red and by `npm run golden -- --update` before it overwrites a
changed answer. A lane that re-records the golden carries it: the merge train shows it to whoever releases the lane
(never the lane's own agent), and without it only a person can release. So run the golden check before `--update`.
The signing key is the studio's verify key (`STUDIO_VERIFY_KEY_DIR`, default `~/.studio-verify/`; docs/SECURITY.md).

A studio game (not a cartridge) gets the same with a `"divergence"` entry in its `studio.gates.json`:

```json
"divergence": { "command": "node sim/trace.mjs", "state": "node sim/trace.mjs --state {tick} --run {run}", "gate": "golden", "goldens": ["sim/golden.json"] }
```

`command` prints one JSON line per tick, `{ "run": "<name>", "tick": 1, "digests": { "<subsystem>": "<hash>" } }`
(optionally `"fields": { "<subsystem>": { ... } }`); `state` (optional) prints the whole state at `{tick}` of `{run}` as
one JSON object, so the harness can name the field. When the check `gate` (default: any check whose id has "golden")
fails, the harness runs `command` on this tree and on the reference (the last commit of `goldens`, else the merge base
with main, else HEAD) in a detached git worktree in the temp folder (`node_modules` linked; removed afterwards), and
compares the lines itself. The commands run with `STUDIO_DIVERGENCE=trace` set (a game's script may read it); each is
bounded by `STUDIO_DIVERGENCE_TIMEOUT_MS` (600000).

- JS checks: `node qa/check-golden.mjs`, `node qa/check-regressions.mjs`
- Python: `node qa/run-python.mjs qa/test-golden.py`, `node qa/run-python.mjs tools/golden.py --check qa/golden`
- Hash a state file in Python: `python tools/golden.py --hash state.json`
