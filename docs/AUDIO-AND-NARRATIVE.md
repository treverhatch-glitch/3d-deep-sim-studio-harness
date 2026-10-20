# Audio and Narrative

Keep these out of the pure simulation.

## Recommended places
- Audio cues, music, and SFX → game repo presentation / audio layer
- Story beats, dialogue, and narrative triggers → game repo narrative or content files
- The pure sim (`src/sim/**` or equivalent) should only expose state and events. It should not play sounds or contain story text.

## Simple pattern
- Sim emits events or state changes (e.g. “fuel low”, “quest complete”).
- Presentation layer listens and plays audio or shows narrative.
- This keeps replays deterministic and ports easier.

Agents should not add audio libraries or dialogue strings inside simulation code.

## Voice lines and dubbing (optional)

[VoiceStudio](https://github.com/debpalash/VoiceStudio) is a local, open-source alternative to paid
voice services: voice lines, voice cloning from reference audio, dubbing into many languages,
text-to-speech with several engines, and transcription, all on your own machine with no
per-character fees. It is listed as an optional plugin (`node harness/plugins.mjs enable voicestudio`).

Best practices:

- Use it only when the Game Bible keeps a layer that needs voice (narrative beats, quests, a
  tutorial). Crossed out, skip it. It is never a required gate, like the Blender tools.
- It runs as its own app; the harness never vendors or links its code. It is AGPL-3.0, and its model
  weights and voices have their own terms: check those before shipping audio made with them.
- Clone only voices you have the rights to (your own, or a voice actor's with written consent).
- Keep the script as data (dialogue files in the game's content folder), generate audio from it, and
  save the generated files with the line ID they belong to, so a changed line can be regenerated.
- Generated audio goes through the same approval gate as other external assets.
- Install it from its README. Review any `curl … | sh` installer before running it.
