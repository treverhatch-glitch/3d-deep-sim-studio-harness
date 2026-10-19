# Specification vs. Repository Checklist (`docs/COMPARISON.md`)

All components from the 17-Repository Audit, Master Specification, and Workflow UI HUB plan are implemented and enabled by default:

| Component | Status | Implementation |
|------|--------|------|
| **Visual HUB (War Room)** | **Default** | React Flow 4-Quadrant War Room (`hub/WarRoom.tsx` + `docs/WAR-ROOM.md`) with Live Agent View (`noVNC` / screenshot / preview), Subscription Usage Panel (`.studio/usage.json`), and zero-build HTML fallback (`hub/index.html`). |
| **Event Log** | **Default** | `.studio/events.jsonl` (written by `scripts/append-event.sh` and `harness/event.mjs`, mirrored to `/tmp/agent-events.jsonl`, streamed by `hub/server.mjs`). |
| **Subscription Usage Panel** | **Default** | Reads `.studio/usage.json` (`/usage` & `/api/usage`) to display Grok Bot, Vertex AI $300 credit, NVIDIA NIM, Groq, and RTK/QMD savings. |
| **Blender & 3D Asset Bridge** | **Default** | Headless `bpy` generator (`tools/blender/generate_glb.py` + `docs/BLENDER.md`) + `mlolson/blender-orchestrator` wired in `.mcp.json`. |
| **Sim Isolation & Boundary** | **Default** | `scripts/check-sim-isolation.sh` + `scripts/check-sim-purity.mjs` enforcing `studio/rules/graphics-sim-boundary.md` and `studio/rules/sim-isolation.md`. |
| **Work Organization** | **Default** | `docs/WORK-ORGANIZATION.md`, `docs/DAILY-SUMMARY.md`, `studio/done/`, `studio/daily/TEMPLATE.md`, `studio/daily/videos/`. |
| **Grok Bot Local-Agent Route** | **Default** | `docs/GROKBOT-LOCAL-AGENT.md` (`robbin/grokbot-local-agent`) + `studio/presets/grok-producer.md`. |
| **Multi-Model Failover** | **Default** | `harness/route.mjs` + `harness/models.config.mjs` (`freecc:auto` with 30s+ cooldowns). |
