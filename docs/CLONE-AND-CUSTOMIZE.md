# Clone & Customize Guide (`docs/CLONE-AND-CUSTOMIZE.md`)

How to turn this open-source harness into your own private 3D simulation game studio in under 5 minutes.

---

## Step 1: Create Your Private Repo & Run One-Command Setup

```bash
git clone https://github.com/treverhatch-glitch/3d-deep-sim-studio-harness.git my-3d-sim-game
cd my-3d-sim-game

# Creates .studio/, copies .env.example -> .env, and verifies .studio/events.jsonl
npm run setup

# Optional: seed realistic demo events so the War Room lights up immediately
node scripts/seed-demo-events.mjs
```

---

## Step 2: Configure Your Preferred Models (`.env`)

Edit `.env` (gitignored). The harness follows a strict **cost-saving priority order**:
1. **Local model (`ollama-local` / Qwen2.5-Coder)** — `$0` offline
2. **Free tiers & trial credits** — NVIDIA NIM, Groq, OpenRouter `:free`, Google Vertex `$300` credit
3. **Paid escalation models** — Claude Opus/Sonnet, xAI Grok, OpenAI, Cursor Ultra (used after `npm run brief -- <ID> --model` compresses a task's history to 300 words)

---

## Step 3: Code Your Deterministic Seed System First (`cartridges/` or `src/sim/`)

> **Mandatory Rule**: Implement your deterministic **Seed + Fixed-Tick** system (`{ seed, tick, rngState }`) as **one of the very first systems coded**.

1. Copy [`cartridges/example-sim/index.mjs`](../cartridges/example-sim/index.mjs) or create `src/sim/index.ts`.
2. Expose `window.__sim` when `?playtest=1` is in the URL so `qa/playtest.mjs` and `node harness/replay.mjs --seed 42069 --tick 120` can replay any bug to the exact failing tick.
3. Lock your game's core pillars in [`studio/VISION_LOCK.md`](../studio/VISION_LOCK.md) and compact API surface in [`studio/llms.txt`](../studio/llms.txt).

---

## Step 4: Launch the Mission Control War Room

```bash
npm run hub
# -> Open http://127.0.0.1:3847/?token=<HUB_TOKEN from .env>
```

Use the **⚙ Gear** button in the top-right of the **Agent Eyes** panel to paste your local game URL (`http://localhost:5173/?playtest=1`), `noVNC` stream URL (`http://localhost:6080/vnc.html`), or screenshot stream without touching code.
