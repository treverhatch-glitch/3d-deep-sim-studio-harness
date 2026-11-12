# Harness roadmap (`docs/ROADMAP.md`)

What is still open or planned. Finished items (the 2.7 to 2.27 work: Windows-proof gates, the Game Bible, phases, layers, the
Director and Idea Board, the Liaison, hashes and signed results, backups, the supervisor, the Arcade, alerts, and the rest) are
in `CHANGELOG.md`; the Bible, phases, layers, Director and Idea Board are described in `docs/GAME-BIBLE.md`. Phone alerts
(ntfy, Telegram) exist: `docs/AWAY-AND-ALERTS.md`. Origin: outside reviews (Grok, read-only reviews on Windows) and the
Producer's notes on the first real runs.

Status words: **planned**, **later**, **not planned**. "(status not checked)" means the item may have been built since; the
code and `CHANGELOG.md` showed no clear key name either way.

- **Python for the gates:** `qa/run-python.mjs` tries `python3`, `python`, then `py -3` and says how to install Python 3 if none
  works; `STUDIO_PYTHON` (a command, default unset: the three tries) picks one explicitly.

## Content and craft

- **C1 Content pipeline.** Content as data under `cartridges/<game>/content/` (JSON, a schema per kept layer, tagged by phase).
  The schema gate is done (2.30f, `docs/FLOORS.md`); still planned: generators that write the content, and a sweep for the
  economy and unlock curve across the phases (`scripts/balance-sweep.mjs` exists; whether it covers this: status not checked).
- **C2 Art, audio and narrative tools.** One tool each that an agent drives and a gate checks when the layer is kept: art
  through Blender presets plus a budget check, audio through a sound preset generator plus loudness and length checks,
  narrative as structured dialogue files with a lint (missing speakers, dead branches). Planned (status not checked).
- **F17 Room spec export and a dressing gate** (keep-out zones, per-floor budgets) for set dressing. Planned.
- **F14c Staff the studio.** A Producer staffing plan applied by one "Staff the studio" click, with "close?" hints for idle
  departments. Planned.

## Engine track and War Room leftovers

- **F14g (after 2.27.0): a Godot-first game** with no web version. Next (status not checked).
- **F14e: a version filter** in the War Room, with the engine track (status not checked).
- **2.8.0 leftovers:** storyboard pictures (agents write and diagram; pictures from an image model or Blender stills, never the
  source of truth), and an intake form in the War Room (the `POST /api/intake` endpoint was ready for it) (status not checked:
  the hub was trimmed in 2.80.0).

## Access and scale

- **H3 Phone access.** Tailscale in the docs, never port-forwarding. A one-time login sets an `HttpOnly; SameSite=Strict`
  cookie for reads and the WebSocket; writes still need the token header, so the token never sits in an address. Planned.
- **H5 Agents on several machines.** One home for tasks, locks and events (agents call it with their token; locks keep a
  heartbeat so a dead remote worker's claims expire), so separate clones and cloud sandboxes share one studio. Cloud workers
  through Git exist (`docs/REMOTE-WORKERS.md`); a shared task and lock store is planned (status not checked).
- **H8 A friendly front end.** The same flow (intake, follow-ups, references, assets, the Liaison, ideas, experiments) for
  people who don't use GitHub or a terminal. Asks play length first and suggests a demo; says plainly that longer games need
  more of the dev's own time. Later.

## Verifiable results and data (all opt-in)

- **V4 / B1 Stamp.** Write the SHA-256 of a signed release manifest to a public ledger as a receipt that a build existed at a
  time (`docs/SIGNED-RESULTS-AND-DATA.md`). Free route: OpenTimestamps (anchored in Bitcoin, no wallet); paid badge: a low-cost
  chain posted server-side so users never need a wallet. Verification stays off-chain (replays, gates, signatures); a receipt
  proves a hash existed at a time, not ownership or that the code works. No tokens. Later. Effort: easy.
- **B2 Archive.** The web build stored on a permanent network (Arweave-style) with its stamp, so it can be played years later.
  Permanent means no takedowns: only for builds the dev owns outright with every asset cleared. Later. Effort: easy to medium.
- **B3 On-chain game** (ownership of items or logic on a chain: wallets, fees, audits, store bans, financial rules). A separate
  product, not an add-on. Not planned. Effort: hard.
- **V5 Data partnerships.** Talk to AI labs with sample exports of verified-outcome records from our own games. Before any
  deal: written consent from every game dev whose work is in the records, terms per buyer, and a check of each model
  provider's terms (several limit training competing models on their outputs). Trajectory export (V3) was removed in 2.80.0
  (never used; the consent record stays), so this would need it rebuilt. Later.

The game itself never needs a wallet, a token or a chain (so it can ship on Steam and other stores that refuse crypto or NFT
games); a game dev who clicks no on any of these loses nothing.

## Not here

- A game's own loops (for example an airport loop) are built in that game's repo, which uses this harness; this repo stays a
  template with only the example game.
- Agent frameworks (LangGraph, CrewAI, AutoGen): the queue, locks and gates already coordinate.
