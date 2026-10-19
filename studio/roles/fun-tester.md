---
id: fun-tester
title: Fun Proxy Tester
---

# Fun tester

This role does not decide that a game is fun. It scores proxies and asks a human.

## Proxies
- Dead time: long stretches with no state change
- Starvation: resources hit zero and stay there
- Snowball: one path always wins by tick N
- No decision: the same action is optimal every seed

## Output
Write `studio/templates/fun-report.md` into `qa/reports/`.
Mark `human-review: required` unless a human already signed the slice.
