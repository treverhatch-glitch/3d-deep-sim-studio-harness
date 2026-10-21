# Mission Control War Room & Embedded Terminal (`docs/WAR-ROOM.md`)

> **Retired in 2.4.0.** The HUB's home page is now War Room v3 (`hub/v3/index.html`): an Ops view and a
> Studio view, built from files only, with buttons behind the HUB token. This React War Room still
> answers at `/legacy` for one release and will then be removed. What follows describes the old page.

The **Mission Control War Room** (`hub/`) is a zero-LLM-token tactical command center designed in a **Palantir / SpaceX Dragon / Cyberpunk Mission Control** aesthetic (`#06080E` obsidian matte, `backdrop-filter: blur(12px)`, `1px solid #00F0FF` tactical borders, CRT scanline toggle, and `JetBrains Mono` telemetry).

It passively watches local studio files (`.studio/events.jsonl`, `.studio/usage.json`, `.studio/war-room.config.json`, `studio/NEXT.md`, `studio/CURRENT_TASK.md`) via native RFC 6455 WebSockets (`/ws`) and Server-Sent Events (`/api/stream`), eliminating the 30k–80k token "Full-Context Re-Read Tax" caused by asking an agent *"What are you doing?"*.

---

## 1. Architecture & 7 Core Modules

| Module | File | Purpose |
| :--- | :--- | :--- |
| **1. Ultrawide 4-Quadrant Layout & Mobile Feed** | `hub/WarRoom.tsx` | Draggable 4-quadrant splitters for 16:9, 21:9, and 32:9 monitors; auto-collapses into a touch-friendly **Mobile Command Feed** on screens `< 768px` (or `?view=mobile`). |
| **2. Dynamic, Uncapped Agent & Failover Node Graph** | `hub/AgentGraph.tsx` | Powered by `@xyflow/react`. Dynamically loads all roles from `studio/roles/*.md` and provider chains from `harness/models.config.mjs`. Includes a live Head Producer preset switcher, 30s amber HTTP `429` cooldown countdowns, and a slide-out **Agent Inspector Drawer** with `git diff` preview (`/api/diff`). |
| **3. "Agent Eyes" Real-Time Viewport Multiplexer** | `hub/AgentEyesViewport.tsx` | 4-source live monitor with FPS/latency HUD, fullscreen toggle, and persistent **Source Gear Menu** (`localStorage` + `.studio/war-room.config.json`). |
| **4. Cyberpunk Terminal Dock & Command Deck** | `hub/TerminalDock.tsx` | Multi-tabbed `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`) terminal over WebSocket (`/ws`). Tab 1 streams color-coded `.studio/events.jsonl` with regex/role filtering; Tab 2 provides a live Studio Shell (with a safe Read-Only lock for public tunnels) + 5 tactical macro buttons. |
| **5. Subscription Quota & Efficiency Telemetry Bar** | `hub/UsageTelemetry.tsx` | Reads/writes `.studio/usage.json` via `/api/usage`. Tracks **Grok/xAI**, **Cursor Ultra**, **Claude**, **Google Vertex ($300 credit)**, **NVIDIA NIM**, and **Groq**, plus the **RTK + QMD + Serena Efficiency Meter** and a `<dialog closedby="any">` quota editor modal. |
| **6. "What's Next" Pipeline & Context Health** | `hub/NextQueue.tsx` | 3-column Kanban (`IN_PROGRESS`, `BACKLOG`, `DONE`) wired to `studio/NEXT.md` + `studio/done/` and a **Context Health Indicator** tracking `studio/CURRENT_TASK.md`, `studio/VISION_LOCK.md`, and `studio/llms.txt`. |
| **7. Zero-Token WebSocket & REST Server** | `hub/server.mjs` | Native Node.js HTTP + RFC 6455 WebSocket server watching studio files on disk. |

---

## 2. Running the War Room Locally

```bash
# Option A: no build (War Room v3 is the home page)
npm run hub
# -> Open http://127.0.0.1:3847/?token=<HUB_TOKEN from .env>

# Option B: Vite HMR / Production bundle build for modular TypeScript components
cd hub
npm install
npm run build
cd ..
npm run hub
```

---

## 3. Streaming Live Agent Screens ("Agent Eyes" 4 Sources)

Click the **Source Gear Menu (`⚙ Gear`)** in the top-right of the **Agent Eyes Multiplexer** to switch between or configure the 4 live video/frame pipelines (persisted automatically to `.studio/war-room.config.json`):

### Source 1: `noVNC` / `Xvfb` Live Desktop Stream (`:6080`)
Watch the actual headless Linux/WSL2/Docker browser or Blender 4.x viewport the agent is controlling in real time:
```bash
node scripts/start-agent-display.mjs
export DISPLAY=:99
# Any Playwright or Blender process launched on DISPLAY=:99 now streams live to :6080
```

### Source 2: WebRTC Low-Latency Video Stream
Connects the `<video>` receiver to a local WHEP/WebRTC endpoint (default `http://localhost:8889/agent-stream` via MediaMTX or OBS WebRTC) for sub-100ms 60 FPS desktop/game streaming.

### Source 3: Playwright CDP / High-Frequency Screencast (`POST /api/frame`)
Streams base64 JPEG/PNG frames pushed by `qa/playtest.mjs` with an interactive HUD overlay showing:
- **UISentinel** DOM bounding-box checks (`#sim-telemetry-bar`, `canvas#three-sim-canvas`)
- **`?playtest=1` (`window.__sim`)** deterministic tick, seed, state hash, and entity count.

Push a custom frame from any script or test runner:
```bash
curl -X POST http://localhost:3847/api/frame \
  -H "Content-Type: application/json" \
  -d '{"fps":60,"latencyMs":11,"simTelemetry":{"tick":240,"seed":42069,"hash":"9f8a12c4","entities":64,"credits":18400,"paused":false,"api":"window.__sim (?playtest=1)"}}'
```

### Source 4: Live Game HMR Iframe (`http://localhost:5173/?playtest=1`)
Embeds the live Three.js / Vite game server directly inside the War Room with a **🎮 Take Manual Control** toggle so you can inspect or playtest the running simulation without leaving Mission Control.

---

## 4. Connecting a Phone via Tailscale or Cloudflare Tunnel

On screens `< 768px` (or `http://<host>:3847/?view=mobile`), the War Room automatically switches into the **Mobile Command Feed** while keeping the interactive Studio Shell locked in **🔒 Tunnel Read-Only: ON** mode by default:

```bash
# Via Tailscale (Private Mesh VPN)
tailscale serve --bg 3847

# Via Cloudflare Quick Tunnel
cloudflared tunnel --url http://localhost:3847
```
