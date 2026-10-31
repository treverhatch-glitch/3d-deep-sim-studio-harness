# Harness research: what others do, and what to adopt

Compared against harness release 2.53.0 (`main`). Ideas only: no code is taken from any source.
**Evidence tags:** **[Pub]** a paper's measured result; **[Vendor]** a company's claim about its own product;
**[Judge]** my judgement. Licences come from each project's repo or page as last known. Re-check one before
relying on it. Since we copy nothing, a licence changes nothing we ship.

## 1. Sources

| Source | Type | Licence | Why it matters here |
| --- | --- | --- | --- |
| [Anthropic: long-running harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | product writeup | proprietary (blog) | Initializer session, progress file, JSON feature list with `passes` flags, a smoke test at session start, one feature per session |
| [Anthropic: multi-agent research](https://www.anthropic.com/engineering/multi-agent-research-system) | product writeup | proprietary (blog) | Multi-agent uses about 15x chat tokens; token use explained 80% of variance; start with about 20 eval tasks; resume from checkpoints |
| [Cognition: multi-agents, what works](https://cognition.com/blog/multi-agents-working) (Apr 2026) | product writeup | proprietary | One writer, others add judgement; a clean-context reviewer; the coder filters findings; Claude+GPT "smart friend" |
| [MAST: why multi-agent systems fail](https://arxiv.org/abs/2503.13657) | paper (NeurIPS 25) | paper CC BY-NC-ND | 14 failure modes; verifiers are mostly superficial |
| [Harness design study](https://arxiv.org/abs/2609.20804) (2026) | paper | paper only | Context management, planning and tools ablated: the right choice depends on the model and the window |
| [LongHorizon-Harness](https://arxiv.org/abs/2608.01964) (Aug 2026) | paper | paper only | Manage–execute–audit; an executor's claims never change state; a read-only auditor does |
| [METR time horizons](https://arxiv.org/abs/2503.14499) | paper | paper only | Measure success against human task length; the horizon doubled about every 7 months |
| [METR developer RCT](https://simonwillison.net/2025/Jul/12/ai-open-source-productivity/) | study | paper only | Developers were 19% slower with AI while feeling faster: measure, don't trust the feeling |
| [SWE-bench](https://arxiv.org/abs/2310.06770) / [SWE-bench Pro](https://labs.scale.com/papers/swe-bench-pro) | benchmark | MIT / public set + private sets | Fail-to-pass and pass-to-pass tests; private tasks resist contamination; top models score under 25% on Pro |
| [τ-bench](https://arxiv.org/abs/2406.12045) | benchmark | MIT | pass^k: reliability over repeated runs, not one lucky pass |
| [SWE-agent](https://arxiv.org/abs/2405.15793) | paper + framework | MIT | Agent–computer interface: narrow commands, a linter guard on edits |
| [OpenHands](https://arxiv.org/abs/2407.16741), [condenser](https://openhands.dev/blog/openhands-context-condensensation-for-more-efficient-ai-agents) | framework | MIT (core) | Event stream, sandboxes; condenser claims up to 2x cheaper turns at 54% vs 53% solved |
| [Agentless](https://arxiv.org/abs/2407.01489) | paper + tool | MIT | Localize, repair, then choose among several patches with reproduction and regression tests |
| [CodeAct](https://arxiv.org/abs/2402.01030) | paper | paper (ideas in OpenHands) | Actions as code; mostly covered by CLI agents already |
| [Reflexion](https://arxiv.org/abs/2303.11366) | paper | MIT | Verbal lessons from failures, kept in memory |
| [Large LLMs cannot self-correct yet](https://arxiv.org/abs/2310.01798) | paper | CC BY 4.0 | Self-correction without an outside signal doesn't help |
| [Multi-agent debate](https://arxiv.org/abs/2305.14325) | paper | paper only | Several models arguing can improve answers, at a high token cost |
| [LLM judges favour their own output](https://arxiv.org/abs/2404.13076) | paper | paper only | Supports a reviewer from another model family |
| [MetaGPT](https://arxiv.org/abs/2308.00352) / [ChatDev](https://arxiv.org/abs/2307.07924) | paper + framework | MIT / Apache-2.0 | Role SOPs, structured hand-offs; chat chains between role agents |
| [AutoGen](https://arxiv.org/abs/2308.08155) / AG2 | framework | MIT / Apache-2.0 | Group chat with a speaker selector |
| [Voyager](https://arxiv.org/abs/2305.16291) | paper (game agent) | MIT | Automatic curriculum, a skill library of code, feedback from the game environment |
| [GameDevBench](https://arxiv.org/abs/2602.11103) (ICML 26) | benchmark | not stated | 333 game-dev tasks; best agent 53.8%; image or video feedback raises GPT-5.4 from 41.1% to 52.0% |
| [TITAN game testing](https://arxiv.org/abs/2509.22170) | paper (industry) | paper only | LLM playtesters with action memory and bug oracles, deployed in 8 QA pipelines |
| [Copilot coding agent](https://docs.github.com/copilot/concepts/coding-agent/coding-agent) | product | proprietary | One branch and one PR per task, a hard 59-minute session cap, hooks, session logs |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage) | product | proprietary | Hooks, headless JSON usage, subagents, OpenTelemetry usage metrics |
| [Codex CLI](https://github.com/openai/codex), [Aider](https://aider.chat), [Cline](https://github.com/cline/cline)/[Roo](https://github.com/RooCodeInc/Roo-Code) | tools | Apache-2.0 | Approval modes and sandboxes; Aider's repo map, architect/editor split and auto lint/test; plan/act modes and shadow-git checkpoints |
| [CrewAI](https://github.com/crewAIInc/crewAI), [LangGraph](https://docs.langchain.com/oss/python/langgraph/interrupts) | frameworks | MIT | Output guardrails on tasks; checkpointer plus `interrupt()` for human approval and resume |
| Sweep | product | Elastic License 2.0 (2023) | Pivoted; nothing to take |

**What we already match.** The literature backs several things the harness already does: fails-before
regressions (SWE-bench fail-to-pass); cross-family review, enforced for system tasks (self-preference
research); refresh by hand-back rather than summarising (Anthropic's progress file); stall and burn checks
(MAST's top failure mode is step repetition, 15.7%); lessons in `failures.md` with a "didn't stick" check
(Reflexion); one task per session (Anthropic). Don't rebuild any of these.

## 2. Ideas, strongest first

**1. A frozen "studio bench" of about 20 real tasks, run k=3 times each** — **ADOPT · P1 · M**
- *From:* Anthropic's small eval sets; SWE-bench's private task sets (SWE-bench Pro); τ-bench pass^k. The harness design study lists a single run per task as its own weakness.
- *Today:* `rehearse` tests orchestration with a fake model; the selftests (777) test harness code. Nothing measures real agents on fixed tasks, so no harness change can be shown to help.
- *Why:* every other metric below needs a fixed baseline. Use our own game history (frozen commits with known fixes), not public benchmarks. **[Pub]** for method, **[Judge]** for fit.
- *Test:* run the bench on 2.53, then record pass@1, pass^3, median minutes, tokens and hand-backs per task. Every later harness PR that touches the agent loop re-runs it and must not regress.

**2. One metrics row per attempt, with wall time split into segments** — **ADAPT · P1 · S–M**
- *From:* METR (success against task length); SWE-bench leaderboards (cost per instance); Claude Code's OpenTelemetry metrics; Copilot's session logs.
- *Today:* the numbers exist but are spread over `tokens`, `scorecard`, `token-norms`, `trajectories`, `run-report` and `retro`.
- *Change:* `npm run metrics` writes one JSONL/CSV row per task attempt. Fields: task type, size, model and family; minutes queued, agent-active, waiting on a gate or CI, waiting on a person, stalled; tokens in, out and cache; sessions (refreshes); refusals, hand-backs, rescues, forced, reopened, caused-by bugs; review verdict. Report medians and p90 by type and model. Separating human wait from agent time keeps "time per task" honest. **[Judge]**
- *Test:* a selftest that feeds a synthetic event log and checks the expected rows. Token totals must equal `npm run tokens` exactly.

**3. A failure-mode label on every bad outcome (MAST)** — **ADAPT · P1 · S**
- *From:* MAST's 14 modes ([Pub]: step repetition 15.7%, reasoning–action mismatch 13.2%, unaware of when to stop 12.4%, verification missing or wrong 17.3% combined).
- *Today:* `causes` groups forced dones; `stall` knows burn and idle; some events carry a harness-caused flag.
- *Change:* every hand-back, refusal, stall, forced done and reopen gets one code from a fixed list. The list: spec-ignored, repetition (burn), no-stop, verify-missing, verify-wrong (reopened after done), env/harness, quota, lane-conflict. Scripts assign them; `unknown` is allowed.
- *Test:* label the last real run. Target: at least 85% are not `unknown`, and a person spot-checks 20.

**4. Reviewer canaries: plant known bugs to measure each reviewer** — **ADOPT · P1 · S–M**
- *From:* MAST ([Pub]: verifiers check that code compiles, not that it's right); Cognition ([Vendor]: Devin Review finds about 2 bugs per PR).
- *Today:* cross-family review exists, but nobody knows whether Grok or a local model catches real sim bugs. `docs/REVIEWER.md` itself says it's "not fully machine-enforced".
- *Change:* a set of about 15 diffs: 10 with planted bugs (unseeded RNG, off-by-one tick, a free purchase, a golden updated without a reason) and 5 clean.
- *Test:* `npm run review` on each, per reviewer family. Record catch rate and false alarms; route reviews to the best family. Re-run after every model change.

**5. Clean-context review before landing, with at most two fix rounds** — **ADAPT · P1 · M**
- *From:* Cognition ([Vendor]: a reviewer that shares no context works best; the coder decides which findings to act on); LongHorizon-Harness ([Pub]: a read-only auditor sets the state, the executor's claims don't); Huang et al. ([Pub]: a fix loop needs an outside signal).
- *Today:* `review.mjs` sends task, spec and diff to another family. The crew doc has Grok review what has *already landed*, except for system tasks.
- *Change:* for sim, core and protected-area tasks, review in the lane before landing. The builder answers each finding "fixed" or "declined: why". After at most 2 rounds it lands or hands back.
- *Test:* bench A/B. Compare caused-by bugs per 10 points (`scorecard`) and tokens per landed task.

**6. Record which checks were already red at claim, and guard against a red upstream trunk** — **ADOPT · P1 · S**
- *From:* SWE-bench's pass-to-pass rule (only tests that passed before must still pass); Anthropic's smoke test at session start; our own P-021 (Hatchfield `main` red since Oct 17).
- *Today:* the whole-game check turns red into a P0 after landing. A lane doesn't record what was already failing on its base commit, and nothing reads the adopted game's own CI.
- *Change:* at `task start`, record the base commit's gate results. Done-checks then judge only checks that were green before. With an upstream trunk red, the supervisor starts only fix tasks.
- *Test:* a selftest with one gate already failing: the builder isn't refused for it. In a timed crew run, hand-backs saying "was already red" go to zero.

**7. Screenshots inside the builder's loop for renderer and UI work** — **ADOPT · P2 · M**
- *From:* GameDevBench ([Pub]: visual feedback +10.9 points); Anthropic (browser testing as a user would); Voyager (game feedback on every try).
- *Today:* `shot`, `clip` and `proof` exist, but proof is checked by the reviewer at the end.
- *Change:* the kickoff for `--part renderer` tasks has the builder take a shot after each change, look at it and compare it with the art reference before claiming done.
- *Test:* 6 renderer tasks from the bench, with and without. Measure the proof "wrong" rate, reopens and tokens.

**8. For escalated tasks, two families try in parallel and the checks pick** — **ADAPT · P2 · M**
- *From:* Agentless ([Pub]: several candidate patches, chosen by reproduction and regression tests); Cognition's cross-model "smart friend" ([Vendor]).
- *Today:* the rescue ladder is sequential, with a different family after a budget stop.
- *Change:* at rescue rung 2 only, two lanes from two families. The winner passes fails-before and goldens with the smallest diff; the other lane is dropped.
- *Test:* 5 hard bench tasks. Compare success and tokens against the sequential ladder; keep it only if success rises more than tokens.

**9. State hashes every N ticks in parity and replays** — **ADAPT · P2 · M**
- *From:* standard lockstep and desync practice in games **[Judge]**; it supports L-001, the Jint versus native C# port.
- *Today:* parity compares end-of-run fields per seed, and `replay --trace` stops at a failing tick.
- *Change:* the sim emits a hash of each part of its state every N ticks. Parity then reports the first tick where they diverge and which part differs, so a port task says where it broke, not just "cash differs at the end".
- *Test:* plant a one-tick drift in a copy of the Unity template's sim. Parity must name the tick and the field.

**10. Playtest bots that file replays, not reports** — **ADAPT · P2 · M**
- *From:* TITAN ([Pub], industry self-report: action-trace memory, bug oracles, 4 new bugs); Voyager's curriculum.
- *Today:* `playtest`, `closed-loop` (records the failing tick), Hatchfield's persona bots, `play:controls`.
- *Change:* scripted invariants run during persona play, for example cash negative with no loan, or a passenger stuck for more than N ticks. A violation writes a seed+tick regression and a bug task with fails-before already filled in. An optional nightly LLM pass flags anything that looks odd. Scripts come first.
- *Test:* plant 3 known bugs. Count how many are found and filed with a replay that fails before the fix.

**11. Count the Discord bots' own tokens** — **ADOPT · P2 · S**
- *From:* Anthropic ([Vendor]: multi-agent setups use about 15x the tokens). `DISCORD-CREW.md` says bot sessions are outside budgets.
- *Change:* each bot reports with `session-report` (it already exists) hourly. The run report shows coordination tokens against build tokens.
- *Test:* one crew day. Coordination share is reported, with a starting target under 15% **[Judge]**.

**12. Does a faster pace land more? Efficiency by pace** — **ADAPT · P2 · S**
- *From:* Cognition (parallel writers rarely pay off); the METR RCT (feeling fast isn't being fast).
- *Change:* per pace, record landed points per hour, tokens per point, rework (reopened plus caused-by bugs) and land conflicts.
- *Test:* the same bench batch at Precise and at Fast. Default to the pace with the better points per token.

**13. A phase exit list in JSON whose `passes` flags only checks can set** — **ADAPT · P3 · S**
- *From:* Anthropic's feature list (models edit JSON less destructively than Markdown; agents had declared victory early).
- *Today:* `PHASE-<n>-EXIT.md`, the fidelity checklist and `verdict`.
- *Test:* a selftest showing that an agent flipping a flag without evidence is refused (a protected file).

**14. Per-model tool and context profiles** — **ADAPT · P3 · S**
- *From:* the harness design study ([Pub]: context management is worth +35.7 points at a 32k window but only +2.7 at 128k; ready-made tools help weak models, bash alone helps strong ones); the OpenHands condenser ([Vendor]).
- *Change:* local 14B/32B models get trimmed old tool output and the narrow command set. Large-window models keep the refresh rule unchanged.
- *Test:* the rejection rate of `prepare-brief` drafts by local models, before and after.

## 3. Do not adopt

- **Free-form bot debate or group chat for decisions** (AutoGen GroupChat, ChatDev chat chains, debate). It costs many tokens and invites loops; MAST's top failure is repetition. The crew's chat rules are the right call.
- **Parallel writers on shared files, or agent swarms.** Cognition calls unstructured swarms "mostly a distraction". Keep lanes as the only way to run in parallel.
- **More role-play departments** (MetaGPT/ChatDev style CEO/CTO). We already have about 15 roles; each adds a hand-off that can fail. Measure first (ideas 2 and 12).
- **Moving the runtime to LangGraph, CrewAI or AutoGen.** It means a rewrite in another language for features we already have: checkpoints are hand-backs, interrupts are `ask`.
- **A full observability stack** (OTel collector, Langfuse, LangSmith) on one PC. `events.jsonl` plus idea 2 is enough. Use Claude Code's OTel only to cross-check our token counts if they disagree.
- **An LLM summariser for large-window models.** The study shows about 3 points at 128k; refresh by hand-back is simpler and auditable.
- **"Reflect and retry" without a test or replay signal.** Huang et al. found no gain; every retry must be tied to a failing check.
- **Choosing models by public SWE-bench scores.** Contamination, and the tasks don't match ours; use the studio bench.
- **Paid cloud sandboxes** (Devin, Copilot cloud, OpenHands Cloud). They break the no-money rule, and the Unity licence is local.
- **Auto-merge to `main` without a person** (Copilot's opt-in Agent Merge) for sim or protected files. Signed approval stays.
