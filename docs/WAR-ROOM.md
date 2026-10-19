# War Room (`hub/WarRoom.tsx` — React Flow Mission Control & Live Agent View)

The zero-token visual Mission Control HUB (`hub/WarRoom.tsx` + `hub/server.mjs`). Passively watches `.studio/events.jsonl`, `.studio/usage.json`, and `studio/NEXT.md` using **0% of your LLM quota**.

---

## 1. Quick Launch (Zero-Build or React Flow Build)

### Option A: Instant Zero-Build Launch (Works Immediately on Clone)
```bash
node hub/server.mjs
# (or: node hub/server.js)
```
Open **http://localhost:3847** (or **http://localhost:3847/?view=mobile** on your phone via Tailscale / Cloudflare Tunnel).

### Option B: Full React Flow (`@xyflow/react` / `reactflow`) Vite Build
```bash
cd hub
npm install
npm run build
cd ..
node hub/server.mjs
```
Or run Vite dev mode with hot reload:
```bash
# Terminal 1
node hub/server.mjs

# Terminal 2
cd hub
npm install
npm run dev
```

---

## 2. What the 4-Quadrant War Room Displays

1. **Quadrant 1 — React Flow Live Agent & Provider Node Graph (`hub/WarRoom.tsx`)**
   - Visualizes the Executive Producer (`grok-producer` / `auto`), the 5 core roles (`designer-calibrator`, `builder`, `qa-playtester`, `reviewer` + any custom roles in `studio/roles/`), and the active `freecc:auto` model channel (`vertex-gemini-pro`, `nvidia-glm-flash`, `groq-llama-70b`, `ollama-local`).
2. **Quadrant 2 — Subscription & Quota Usage Panel (`.studio/usage.json`) + `freecc:auto` Router Matrix**
   - Reads `.studio/usage.json` (`/usage` / `/api/usage`) to render live quota bars for Grok Bot cycles, Vertex AI $300 credit, NVIDIA NIM free tier, Groq free tier, and Cursor/Claude fast requests, alongside RTK/QMD token savings and avoided "Check-In Tax" tokens.
3. **Quadrant 3 — Live Agent Viewport (`noVNC` / Latest QA Screenshot / Playtest Preview) + `studio/NEXT.md` Queue**
   - Switch between three zero-token visual inspection modes right inside the War Room:
     - **Screenshot Mode (`screenshot`)**: Displays the latest Stage-2 Playwright screenshot from `qa/reports/` (`/api/latest-screenshot`) auto-refreshing as QA runs.
     - **Live Desktop / Container Stream (`novnc`)**: Embeds a live `noVNC` canvas (`NOVNC_URL`, default `http://127.0.0.1:6080/vnc.html`) so you can watch headless Playwright or Blender agents work in real time.
     - **Interactive Playtest Preview (`preview`)**: Embeds `PLAYTEST_URL` (`http://127.0.0.1:5173/?playtest=1`) to inspect `window.__sim` live.
4. **Quadrant 4 — Passive `.studio/events.jsonl` Stream & QA Verdict Ledger**
   - Tails events logged by `./scripts/append-event.sh`, `node harness/event.mjs`, `node harness/route.mjs`, and `node qa/playtest.mjs`.
