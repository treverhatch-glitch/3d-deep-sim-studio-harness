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
