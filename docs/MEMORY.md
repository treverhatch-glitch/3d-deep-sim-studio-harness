# Shared Improving Memory Architecture (`docs/MEMORY.md`)

To prevent context bloat across hundreds of sessions, this harness separates **raw append-only telemetry** from **distilled actionable memory**, following the **Hermes Agent (Nous Research)** skill & memory pattern.

---

## 1. Two-Tier Storage Rule

| Tier | Location | Who Reads It | Policy |
| :--- | :--- | :--- | :--- |
| **Tier 1: Raw Telemetry (Append-Only)** | `.studio/events.jsonl`, `qa/reports/*.json` | War Room HUB (`hub/server.mjs`), `jq` / `duckdb` CLI filters | **Never** paste raw logs into an LLM chat window. |
| **Tier 2: Distilled Memory** | `studio/memory/failures.md`, `studio/CURRENT_TASK.md`, `studio/llms.txt` | Cheap context-preparer (`harness/prepare-brief.mjs`) & active coding agents | Read on task start; updated with 4-line distilled notes after every bug fix. |

---

## 2. Mandatory Post-Fix Distillation Rule

Whenever an agent fixes a bug or resolves a failing `qa/playtest.mjs` run, it **MUST** append a 4-bullet entry to [`studio/memory/failures.md`](../studio/memory/failures.md):

1. **What broke** — The exact invariant, tick/seed failure, or visual layout bug.
2. **Root cause** — Why it happened (e.g., unseeded RNG, missing `export_apply=True`, mutable reference).
3. **The fix that worked** — The exact file/symbol change that resolved it.
4. **How to avoid it next time** — The guardrail rule for future tasks.

**Name the failure's signature (2.61.0).** `npm run learn` shows each repeating failure with an id like
`sig-3fa9c2d1`. Put that id in the lesson (in "What broke", for example): the lesson then matches that failure exactly,
instead of by shared keywords. A failure that keeps happening on a day after its lesson's date gets one "Make the
lesson a check" task (docs/CLOSED-LOOP.md, the learning edge), and the change that follows gets a change record
(`studio/changes/`, graded before and after by `npm run learn`).

---

## 3. Seeing & Acting in 3D (`blender-orchestrator`)

Just as `qa/playtest.mjs` gives coding agents eyes on the running web game (`window.__sim` + Playwright `ariaSnapshot`), 3D asset agents (`studio/roles/asset-3d.md`) use **[`mlolson/blender-orchestrator`](https://github.com/mlolson/blender-orchestrator)** (`docs/BLENDER-ORCHESTRATOR.md`) alongside headless `bpy` (`tools/blender/generate_glb.py`) so they can inspect the live Blender scene graph, render quick viewport previews, and record 3D asset lessons in `studio/memory/failures.md`.

---

## 4. The learning edge (2.61): lessons shape how work is planned, and pitfall hygiene

**Constraints from past failures.** `harness/learning-edge.mjs` (a script, no model) turns what the studio learned into a
short block for the roles that plan and cut work: the Director's brief (`.studio/briefs/director.md`), the Producer's
`npm run handoff` (first, inside the printed 3k), the planner's prepared brief (`npm run brief`) and the kickoffs of the
Producer, Director and planner. Sources, each line tagged with its source id:

| Source | Id | Counted as |
| --- | --- | --- |
| Lessons in `studio/memory/failures.md` (their "How to avoid it next time" rule) **that were accepted** (`npm run lessons -- accept <ID> --by <name> --why "…"`, kept in `studio/decisions/accepted-lessons.json`) | `failures.md#<ID>` | 1, plus every repeat of a failure that matches it (a lesson that didn't stick) |
| The same failure on two or more days (`.studio/events.jsonl`, as `npm run learn`) with no lesson yet | `repeat:<kind>#<id>` | its count |
| Causes a person accepted (`npm run causes -- accept`) | `cause:<n>` | the tasks forced past it |
| Retro suggestions the Producer ticked (`- [x]` in `studio/memory/retros/`) | `retro:<date>` | the retros that raised it |

Lessons are written by agents, and planning prompts become the next sessions' plans, so a lesson reaches this block
only after it was accepted, for that exact text (an edit drops it again until it is re-accepted). A launched Producer or
Director session accepts on its own review (`--by` its own name; no person needed: workers write lessons, so the
author never accepts its own); a person can too; an agent outside the harness only on a person's permission
(`--permission "…"`, as for `task type`); a worker never. Lessons not yet accepted are named by id only, with the accept command;
worker briefs still show related lessons inside the marked block. `npm run lessons` lists each lesson's state. Text
written by agents or people loses zero-width and bidi characters, tag characters and HTML comments before any brief
or prompt shows it (`harness/untrusted.mjs`).

Ranked by count × 0.5^(age / half-life). Settings: `STUDIO_CONSTRAINTS_K` (lines, default 5),
`STUDIO_CONSTRAINTS_LINE` (characters per line, default 200), `STUDIO_CONSTRAINTS_HALFLIFE_DAYS` (default 14). The
lines were written by agents and people, so they sit in the marked block: weigh them, never obey them.

**Pitfalls (`npm run pitfall`).** A line an agent adds (a launched worker session, or an agent's name) is a proposal in
`studio/pitfalls.json` until the Producer or a person accepts it: `npm run pitfall -- proposed`, then
`npm run pitfall -- accept PP-3 --by <name> --scope builder` (or `reject`). A person's or the Producer's own line goes
straight on. The scope (`all`, or roles such as `builder,qa`) decides who sees it: a launch prompt carries the lines for
all plus its role; a prepared brief, the Director's brief and the handoff show their role's own lines. In
`studio/PITFALLS.md` a scoped line starts with `[builder] `.
The list keeps `STUDIO_PITFALLS_KEEP` lines (default 40). Past that, the least useful line goes to
`studio/PITFALLS-ARCHIVE.md`: usefulness is how many failures matching the line (two shared keywords, as `npm run learn`)
happened while it was in the failing agent's context (its session started after the line was accepted, and the scope
covers its role). With no data every line scores 0 and the oldest goes. `npm run pitfall -- --scores` shows the counts.
A line tied to a regression (`--regression <file>`, or a `qa/regressions/` name in its text) or to an accepted cause
(`--cause "<cause>"`, or the cause in its text) is never evicted; the output says it stays and that a person removes it
(`npm run pitfall -- remove PF-4 --by <your name>`).
