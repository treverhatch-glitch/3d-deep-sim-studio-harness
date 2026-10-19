# Doc vs Current Repo

Updated after making the three previously optional items the new defaults.

## Current defaults

| Item | Status |
|------|--------|
| Visual HUB | React Flow War Room (`hub/WarRoom.tsx`) is now the default. Simple HTML feed remains as fallback. |
| Event log | `.studio/events.jsonl` is now the default (written by `scripts/append-event.sh`, read by the HUB). |
| Blender assets | Headless `bpy` guidance is now included (`docs/BLENDER.md`). |

The simple HTML HUB and `/tmp` path are no longer the primary path.
