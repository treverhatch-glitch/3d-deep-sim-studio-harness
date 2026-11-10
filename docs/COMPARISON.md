# Specification vs. Repository Checklist (`docs/COMPARISON.md`)

All components from the 17-Repository Audit and Master Specification are implemented and enabled by default (2.80: the Workflow UI HUB / War Room was cut; the CLI shows the studio):

| Component | Status | Implementation |
|------|--------|------|
| **Event Log** | **Default** | `.studio/events.jsonl` (written by `node scripts/append-event.mjs` and `harness/event.mjs`, mirrored to `/tmp/agent-events.jsonl`, read by `npm run studio:status`, the digest and the run report). |
| **Subscription Usage Panel** | **Default** | `.studio/usage.json`, read by `npm run status`, tracks Grok Bot, Vertex AI $300 credit, NVIDIA NIM, Groq, and RTK/QMD savings. |
| **Blender & 3D Asset Bridge** | **Default** | Headless `bpy` generator (`tools/blender/generate_glb.py` + `docs/BLENDER.md`) + `mlolson/blender-orchestrator` wired in `.mcp.json`. |
| **Sim Isolation & Boundary** | **Default** | `scripts/check-sim-isolation.mjs` + `scripts/check-sim-purity.mjs` enforcing `studio/rules/graphics-sim-boundary.md` and `studio/rules/sim-isolation.md`. |
| **Work Organization** | **Default** | `docs/WORK-ORGANIZATION.md`, `docs/DAILY-SUMMARY.md`, `studio/done/`, `studio/daily/TEMPLATE.md`, `studio/daily/videos/`. |
| **Grok Bot Local-Agent Route** | **Default** | `docs/GROKBOT-LOCAL-AGENT.md` (`robbin/grokbot-local-agent`) + `studio/presets/grok-producer.md`. |
| **Multi-Model Failover** | **Default** | `harness/route.mjs` + `harness/models.config.mjs` (`freecc:auto` with 30s+ cooldowns). |
