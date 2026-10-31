# Research, part 2: better approaches for agent-led game development (2026-10-31, late)

Read-only research by a helper agent, aimed at the crew's real problems:
- main red in CI because of software WebGL;
- unattended-run stops and usage limits;
- a mixed Claude + Grok crew on one Windows PC;
- the Unity port's speed and determinism;
- agents gaming checks;
- automated QA for a tycoon sim.

It repeats nothing from part 1 (`HARNESS-RESEARCH-2026-10-31.md`) or PU-01 to PU-21. Ideas and mechanics only; no code
or art is taken. Planned updates from it are PU-22 to PU-32 in `../PROPOSALS.md`, and each needs Hatch's OK.

**Checked by hand (2026-10-31):**
- **Math in the packed rules file.** Counted in `hatchfield-sim.mjs` (main's pack, fingerprint 55906ed2b3f5):
  `Math.sin` 82, `cos` 77, `hypot` 75, `atan2` 70, `sqrt` 43, `pow` 16.
- **Node vs the C maths library.** 20,000 seeded inputs, Node 22 against the C maths library (through Python):
  `sin` differs in 3.6% of results, `cos` 3.1%, `atan2` 18.2%, `hypot` 35.1% (last bits).
  How Jint computes these in .NET, and what Windows' runtime gives, was NOT checked. The 3/3 replay matches are
  real today, but nothing guarantees them.

**Not re-checked:** every other claim below is as the helper reported it, with its source. Tags:
- [Pub] a paper;
- [Vendor] a company writing about its own product;
- [Judge] the helper's own judgement;
- UNVERIFIED where the helper could not confirm a claim.

## Findings

| # | Finding | Verdict | Priority | Size | Planned as |
| --- | --- | --- | --- | --- | --- |
| 1 | Swap SwiftShader for Mesa llvmpipe (`--use-angle=gl` + Xvfb); two write-ups saw about 4x faster GPU-less WebGL [1][3]. Free macOS runners may give headless Chromium a GPU (UNVERIFIED, one PR [4]). Check the renderer name in the run, since it can fall back silently [2]. | ADAPT | P1 | S | PU-23 |
| 2 | Let tests drive game time: Playwright's clock fakes rAF, timers and `performance`; `runFor` steps exact frames [6]. three.js's own e2e uses seeded time and randomness, a small viewport, 0.3% pixel tolerance and 4 CI chunks [5]. | ADAPT | P1 | S | PU-23 |
| 3 | Claude Code's structured rate-limit events (`rate_limit_event`: status, utilization, resetsAt, five_hour or seven_day) are skipped by the launcher today. Use them to pause before a hard stop [7][8][9][10]. Field names UNVERIFIED: capture a live event first. | ADAPT | P1 | S | PU-24 |
| 4 | Fencing tokens on claims: each grant gets a higher number, and stale numbers are refused at release, requeue and landing; session names carry a launch nonce [12]. | ADOPT | P1 | S | PU-25 |
| 5 | Change notices between lanes, not chat. Chat coordination lowered success in CooperBench [13]; an exact note of a landed change recovered 82% of post-merge test breaks [14] [Pub]. | ADAPT | P2 | M | PU-26 |
| 6 | Deterministic math for the rules: engines' `Math.sin` and similar differ [15]. A `detMath` module from the published fdlibm algorithms (about 1.1x cost) plus a lint against raw trig in the rules. | ADOPT | P1 | M | PU-22 |
| 7 | Measure cheap Unity speed-ups before porting: Jint strict mode and prepared scripts [16]; Puerts (V8 in Unity, BSD-3) runs the same JS file [17]. | ADAPT | P2 | M | PU-27 (L-001) |
| 8 | Impossible-task canaries: tasks whose test contradicts the spec, plus a "spec conflict" hand-back exit. A flag-for-a-person exit cut cheating sharply for some models; monitors caught 42–65% [18][19] [Pub]. | ADOPT | P1 | S–M | PU-28 |
| 9 | A gate for weakened tests: removed asserts, skip or only, raised timeouts, wider tolerances, seed or tick special cases. Heavier option: incremental mutation testing (Stryker, Apache-2.0; Vitest 5 support UNVERIFIED) [20]. | ADAPT | P2 | S | PU-29 |
| 10 | Secrets: move `.env` outside the checkout (Read-deny rules don't stop Bash [21]); plant free honeytokens [22]; turn on GitHub push protection on the public repos (free for public repos; it covers Discord bot tokens) [23]. | ADOPT | P1 | S | PU-30 |
| 11 | Exploration bots: random action sequences with invariants, shrunk to a minimal replayable failure (fast-check, MIT) [24]; a Go-Explore archive of unique states [25] [Pub]. A ledger invariant: cash change = sum of ledger entries. | ADOPT | P1 | M | PU-31 |
| 12 | Performance as an A/B against the base commit: alternate base and PR runs, fail only when the 95% interval shows more than 10% slower (tachometer's method, BSD-3) [26]. | ADAPT | P2 | S–M | PU-32 |

**Skipped:**
- A SQLite task board (`node:sqlite` is still a release candidate [27]; PU-16 covers the need).
- Paid GPU runners (costs money).
- A self-hosted runner on a public repo: fork PRs could run code on Hatch's PC [Judge]. This matches Hatch's rule.
- MCP Agent Mail (duplicates the queue; licence unconfirmed).
- NVIDIA FLIP: pixelmatch with a tolerance is enough for now.

**The helper's top 3:**
1. #6, deterministic math: every later port step depends on it.
2. #1 with #2: the cheapest way to get the game's main green and keep it green, next to the no-render switch.
3. #3 with #4: the crew stalls on usage limits and on claims lost to name clashes.

## Sources (as reported by the helper; links not all re-opened by hand)

1. [Microlink: GPU-less WebGL 4x faster](https://microlink.io/blog/webgl-without-a-gpu) (2026-06-29)
2. [Sineless #299: Mesa instead of SwiftShader](https://github.com/orizonaudio/Sineless/issues/299) (2026-10-29)
3. [Dave Snider: Playwright on GPU Actions](https://davesnider.com/gputests) (2026-02-23)
4. [neurodesk/webapps PR #150](https://github.com/neurodesk/webapps/pull/150) (2026-10-07)
5. [three.js e2e puppeteer.js](https://github.com/mrdoob/three.js/blob/d33b929e2f7f168fa38214f3fb898eee2ac55156/test/e2e/puppeteer.js)
6. [Playwright Clock](https://playwright.dev/dotnet/docs/clock)
7. [ClaudeCode RateLimitEvent (Elixir SDK docs)](https://claude-code.hexdocs.pm/ClaudeCode.Message.RateLimitEvent.html)
8. [StopFailure hook](https://agentpatterns.ai/tool-engineering/stopfailure-hook/)
9. [5h/7d limits in the status line](https://skoula.cz/blog/2026/6/how-to-display-context-and-5h-7d-limits-in-the-claude-code-status-bar/) (2026-06-29)
10. [Claude Code resumes after a usage limit](https://dev.to/dawonlee/claude-code-now-resumes-after-a-usage-limit-unless-your-mac-fell-asleep-49dj) (2026-10-14)
12. [Locks, leases, fencing tokens](https://surfingcomplexity.blog/2025/03/03/locks-leases-fencing-tokens-fizzbee/) (2025-03-03)
13. [CooperBench](https://www.alphaxiv.org/abs/2601.13295) (2026-01-26)
14. [Passes Alone, Fails Together](https://arxiv.org/html/2609.25396) (2026-09-21)
15. [Bounce #8: Math.sin diverges between engines](https://codeberg.org/perplexdotgg/bounce/issues/8) (2026-08-03)
16. [Jint benchmarks](https://github.com/sebastienros/jint/blob/main/Jint.Benchmark/README.md) (2026-08-13)
17. [Tencent/puerts](https://github.com/Tencent/puerts)
18. [ImpossibleBench](https://arxiv.org/html/2510.20270v1) (2025-10-23)
19. [METR: recent reward hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking) (2025-06-05)
20. [Stryker incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/)
21. [claude-code issue #45200 (Read deny vs Bash)](https://github.com/anthropics/claude-code/issues/45200) (2026-04)
22. [Zeltser: plant honeytokens](https://zeltser.com/plant-honeytokens) (2026-04-30)
23. [GitHub secret scanning patterns](https://docs.github.com/en/enterprise-server@3.14/code-security/secret-scanning/introduction/supported-secret-scanning-patterns)
24. [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/)
25. [Go-Explore for 3D reachability testing (Microsoft Research)](https://microsoft.com/en-us/research/?p=936006)
26. [google/tachometer](https://github.com/google/tachometer) (archived 2026-09-04)
27. [Node sqlite docs](https://r2.nodejs.org/dist/v26.7.0/docs/api/sqlite.json)

Licences per the helper: fast-check MIT, Stryker Apache-2.0, tachometer BSD-3, pixelmatch ISC, Puerts BSD-3; Jint's
licence was not checked. Nothing is copied, so licences only matter if a tool is later added as a dependency.
