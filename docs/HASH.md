# Hashing

New games use a 64-bit hash from the first golden file.

- Example golden: `qa/golden/example-1337.json`
- New-game template: `studio/templates/golden.json`
- JS check: `node qa/check-golden.mjs`
- Python helper: `python tools/golden.py --check qa/golden`

`tools/golden.py` is standalone. It checks that golden files are 64-bit and can hash a JSON state. It does not run the JS sim.

Do not change hash width after golden files exist unless you regenerate them in the same commit.
