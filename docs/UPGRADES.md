# Recommended Studio Upgrades (`docs/UPGRADES.md`)

Once you clone this template and mount your 3D simulation cartridge:

## High Priority
- **Token Savers (`rtk` + `qmd` + `serena`)** — Run `node scripts/setup-token-savers.mjs --install` so agents strip 60–90% of bash noise, query Markdown via RAG, and inspect TypeScript symbols over LSP.
- **API Keys for `freecc:auto` Failover** — Copy `.env.example` to `.env` and populate `GEMINI_API_KEY`, `NVIDIA_API_KEY`, and `GROQ_API_KEY` so `node harness/route.mjs` can fail over automatically.
- **Optional Local Agent Offload** — Install [`robbin/grokbot-local-agent`](https://github.com/robbin/grokbot-local-agent) if using Grok Bot as a thin Producer (`docs/GROKBOT-LOCAL-AGENT.md`).

## Medium Priority
- Keep `studio/llms.txt` updated as your simulation's `SimState` and `TUNING` table evolve.
- Add domain-specific invariants in `qa/sim.adapter.mjs` so `node qa/playtest.mjs` catches balance and state bugs in milliseconds.
- Use `tools/blender/generate_glb.py` and `mlolson/blender-orchestrator` (`docs/BLENDER.md`) to generate low-poly `.glb` props.
