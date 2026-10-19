# Doc vs Current Repo

Comparison of the Google Doc blueprint against what is actually in this repository.

## 1. Visual HUB: React Flow War Room vs HTML/JS feed

| | Doc | Current repo |
|---|-----|--------------|
| Implementation | `hub/WarRoom.tsx` (React Flow node graph) | `hub/index.html` + `hub/server.js` (live event feed) |
| Look | Sci-fi node graph, good for YouTube B-roll | Clean game-HUD style feed + sidebar stats |
| Complexity | Higher (React + React Flow build) | Zero build step, runs with `node hub/server.js` |

**Which is better?**  
The current HTML HUB is better for daily use (instant, no build, zero tokens).  
A React Flow War Room is better only if you want cinematic YouTube visuals. It is not more functional for development. We can add it later as an optional upgrade without replacing the simple HUB.

## 2. Event log location

| | Doc | Current repo |
|---|-----|--------------|
| Path | `.studio/events.jsonl` | `/tmp/agent-events.jsonl` |

**Which is better?**  
`/tmp` is simpler and disappears on reboot (fine for live monitoring).  
`.studio/events.jsonl` survives reboots and can be committed or archived.  
For a long-running game project, moving to `.studio/events.jsonl` (or supporting both) is slightly better. Easy change.

## 3. Blender `bpy` headless asset automation

The doc describes agents writing Python scripts that use Blender’s `bpy` to generate `.glb` assets headlessly.

**Current repo:** Not included.

**Is it better to add?**  
Yes, as optional guidance, once you are generating 3D assets. It fits the “presentation layer” side of the graphics/sim boundary. It is not required for the core harness. A short `docs/BLENDER.md` with the pattern would be enough.

## 4. Full 15-point Claude audit table

The doc summarizes Claude’s Borrow/Adapt/Skip list in one place.

**Current repo:** The recommendations are implemented across files (roles, rules, route.mjs, PORTING.md, etc.) but not collected as a single table.

**Is a single table better?**  
Only for onboarding. The working files are more useful day-to-day. A short summary table in this doc or in `docs/UPGRADES.md` would be nice-to-have, not essential.

## Summary

| Item | Better than what we have? | Action |
|------|---------------------------|--------|
| React Flow War Room | Only for video | Optional later |
| `.studio/events.jsonl` | Slightly, for persistence | Easy win |
| Blender bpy notes | Yes, when doing assets | Add short doc |
| Single audit table | Marginally, for readers | Optional |

The current repo is already ahead of the doc in executable pieces (real failover client, isolation checker, work organization, daily summaries, agent-agnostic design). The doc is the cleaner narrative.
