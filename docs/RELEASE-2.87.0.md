# 2.87.0: shorter, same behaviour (`docs/RELEASE-2.87.0.md`)

The owner's order of 2026-11-16: start the consolidation map's first step. Nothing in this release changes what a
command prints, decides or writes. Built on 2.86.0. Only this page and the one for 2.86.0 are kept; older release notes
are in git history.

## What the records said

A crew upgraded to 2.86.0 two hours after it was merged. Its first 31.4 hours, from its event log (`npm run score`):

| Measure | 2.85 (19.5 h) | 2.86 (31.4 h) |
| --- | --- | --- |
| Scorecard targets met | 4 of 15 | 5 of 15 |
| Tasks landed with no overseer step | 25% of 24 | 31.7% of 60 |
| Hand-backs with a harness or machine cause | 34% | 30.8% |
| Engine land runs that passed | 35% (20 runs) | 83.3% (18 runs) |
| Engine queue wait, p90 | 12.7 h | 3.1 h |
| Land-run minutes per landed lane | | 28.7 |
| Lanes a web train dropped | | 0 of 12 |
| Cost per landed task | $10.20 | $8.62 |

Two parts of 2.86 had not taken effect there, both for the studio to set: the land script does not honour
`STUDIO_LAND_PROBE`, so no step ran by test name, and the game file has no `rules.focus.auto`, so the rules check still
ran twice a batch (467 minutes for 9 batches). One fault of 2.86.0 showed in the same log and is fixed in 2.86.1.

## What changed

| | What | Lines | Proof |
| --- | --- | --- | --- |
| Comments in `harness/` and `scripts/` | A file header is at most 12 lines, any other comment at most 6. 418 comments were over that: 7,727 lines, now 3,963. | −3,764 | `scripts/same-code.mjs`: the same code tokens in all 282 files |
| Comments in `qa/` | The same rule. 107 comments: 1,704 lines, now 1,188. | −516 | the same, 104 files |
| The rule as a check | `npm run check:comments` (`scripts/check-comments.mjs`), a step of the `release-gate` job. | +96 | `qa/selftest-287a.mjs` |
| One test kit | `qa/kit.mjs`: 81 helpers that were defined 1,237 times in 244 test files. A helper was replaced only when its body was identical, or identical but for one captured variable. No check's name or condition changed. | −263 | 27 units before and after with identical PASS lines; the weakened-test check; the online run |
| Notes and logs | The train-split note and three research notes of October are removed; the work log's rows (one day in October) are gone; 39 older problem entries are one line each; the owner's game is no longer named in harness text. | −744 | `scripts/check-docs.mjs` |

Tracked text: 173,676 lines to about 168,500 (3%); 13.2 MB to 12.7 MB (4%). `harness/` and `scripts/` are 4.8% smaller.

## What a comment says now

What the module or the code below does, how to run it, the warnings that stop a mistake, and the names a reader
searches for (paths, settings, events). How a subsystem works is in `docs/`; what changed when is in `CHANGELOG.md`
and git. The long versions as of 2.86 are one command away: `git show 887cfe2:<file>`.

## What the consolidation map got wrong

- **It said the harness does not record which commands a studio runs.** It has since 2.84 (`npm run commands-run`).
  The owner remembered; the maintainer had not searched. No counter was added.
- **Its line estimates for shared helpers were 4 to 10 times too high.** The repeated helpers are one line each: taking
  a copy out and putting an import in nearly cancel. The test kit saves 263 lines, not 2,000; the harness's own
  helpers would save about 100 and move to the next release with the other merges. The gain is one place to fix a
  helper, not size.

## Not tested, and not done

- The shortened comments were condensed from the old ones by helpers under a written rule and machine-checked for
  form (length, no release numbers, JSDoc tags kept, code unchanged). A sample was read against the originals; not
  every one was.
- Four git version requirements that the shortening dropped were put back by hand. Other figures a comment held
  (a default, a size) may have gone the same way: the code and `docs/` remain the reference.
- 33 of the kit's helpers were not exercised by the 27 units run locally; the online run covers every unit.
- Not done: shared helpers in `harness/`; the merges of the map's later steps.

## Upgrading

`npm run upgrade -- --merge <ref> --by <who>`. Nothing to set, nothing to restart beyond what the upgrade names.
