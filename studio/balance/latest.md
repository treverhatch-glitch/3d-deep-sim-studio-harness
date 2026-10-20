# Balance sweep: example-sim · spawnCost

Scenario `start-to-win`, 6 seeds. Target: win rate 0.8–1, median win tick 250–450.

| spawnCost | win rate | median win tick | fastest–slowest | lost | broken | in band |
|---:|---:|---:|---:|---:|---:|:---:|
| 200 | 100% | 265 | 263–267 | 0 | 0 | yes |
| 400 (current) | 100% | 298 | 295–300 | 0 | 0 | yes |
| 800 | 100% | 361.5 | 357–366 | 0 | 0 | yes |
| 1200 | 100% | 435.5 | 428–439 | 0 | 0 | yes |
| 1600 | 100% | 525 | 517–533 | 0 | 0 | no |
| 2400 | 0% | – | – | 6 | 0 | no |

Closest to the middle of the band: **spawnCost = 800** (median 361.5).
Current value 400 is inside the band.

Proxy only. A person picks the final number in studio/balance/decision-YYYY-MM-DD.md.
