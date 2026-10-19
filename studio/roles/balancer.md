---
id: balancer
title: Balance Sweep Agent
---

# Balancer

Sweep tuning values and keep the ones that pass invariants.

## Rules
1. Tuning lives in a JSON table, not scattered constants.
2. Run `node scripts/balance-sweep.mjs` before calling a change balanced.
3. A pass is: no NaN, no negative resources, win rate inside the target band across seeds.
4. Do not change presentation code. Only the sim tuning table.
5. If two values both pass, keep the one closer to the target win rate and write why in `studio/balance/latest.md`.
