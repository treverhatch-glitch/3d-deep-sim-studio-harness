# The art department and the Asset studio

The Art division is on from day one. Pre-production queues **"Art: style sheet and five placeholder
assets"** for the `art` role (`studio/roles/art.md`, `studio/skills/art.md`); art work may start before
the Bible is signed.

## How assets move

```
art agent makes a file ──propose──▶ assets/staging/<pack>/   #4 "Yellow gun", round 1
        ▲                                   │
        │ more rounds, any time             ├─ 👍 the dev (or the Producer after the wait) ──▶ assets/approved/<pack>/
        │ (--round-of 4)                    │      recorded in the asset ledger, import task for a builder
        └──── "Change this" / "#4 is still clunky" ◀─┘
```

- Every asset keeps its **number** (#4) through all its rounds. Rounds don't wait for anyone.
- **Thumbs up** moves the file to `assets/approved/`, records it in `studio/assets/manifest.json` (who
  made it, who approved it, licence, author, source, and for AI art the tool, model, prompt and terms),
  and queues "Import: wire asset #4 … into the game" for a builder (`--part renderer`).
- Game code loads `assets/approved/` only. The assets gate fails on a `assets/staging/` path in code.
- **Feedback** in the dev's words: per card ("Change this"), or typed in "Tell the art department",
  naming assets by number: "yellow gun #4 is still clunky, #7 is perfect". Each named asset gets the
  words for its next round; without a number it's a note to the art department.
- **When the dev is away**: a design waiting longer than the pace allows (precise 24 h, fast 8 h,
  extreme 4 h, half with MAX SPEED) is approved provisionally by the Producer, logged under "Decided
  without you", and marked on its card. The dev can still send it back. The style sheet always waits
  for the dev: it becomes the art reference in the Game Bible.
- **References** from the dev, labelled: "Look like this" (photos, screenshots, clips: kept in the
  reference library, never shipped) or "Use this in the game" (the dev's own model or art: recorded as
  theirs in `assets/own/`). Both are listed in `studio/art/references.json` for the art department.

## The Asset studio (War Room view 4)

Waiting for you · In the works · Approved · References, each card with its picture (3D files spin in
a viewer), number, round, maker, licence, the dev's last words and earlier rounds. Or from a terminal:

```bash
npm run art                                   # every asset, its round and status
npm run art -- approve 4 --by <name>          # (no # on the command line: it starts a comment)
npm run art -- changes 4 "slimmer barrel" --by <name>
npm run art -- say "yellow gun #4 is still clunky" --by <name>
npm run art -- ref photo.jpg --label "hotel lobby mood" --kind look --by <name>
```

## The asset ledger

`npm run asset -- add` records files where they are when they're already in `assets/`, `public/` or
`web/`, and copies anything else into `assets/<pack>/` (namespaced). Fields are kept apart: `author`,
`source`, `licence`, `creditRequired`/`credit`, `rightsHolder`, `declaredBy`, `madeBy`, `generated`.
`npm run asset -- import-manifest <pack>/MANIFEST.json --by <name>` records a whole pack;
`npm run asset -- update <file> --by <name>` re-records a re-export.

Asset tools stay outside the repo (`docs/EXTERNAL-TOOLS.md`, `docs/BLENDER-ORCHESTRATOR.md`).
