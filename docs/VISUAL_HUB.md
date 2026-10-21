# Passive Visual HUB — Mission Control (`docs/VISUAL_HUB.md`)

Zero-token local dashboard (`hub/WarRoom.tsx` + `hub/server.mjs`) that watches `.studio/events.jsonl` and `.studio/usage.json`.

## Run It

```bash
node hub/server.mjs
# Open http://localhost:3847
```

The HUB can be closed at any time while agents continue working. Open it on a second monitor for YouTube devlogs or on your phone via Tailscale / Cloudflare Tunnel (`http://localhost:3847/?view=mobile`).

## How Agents Log Events

```bash
node scripts/append-event.mjs RUNNING_VITEST src/sim/clock.ts P0-12 nvidia-glm-flash
# or
node harness/event.mjs --type task.start --agent builder --task T-003 --msg "Implementing InstancedMesh"
```

See [`docs/WAR-ROOM.md`](./WAR-ROOM.md) for the React Flow War Room build, Subscription Usage Panel (`.studio/usage.json`), and Live Agent View (`noVNC` / screenshot / playtest preview).
