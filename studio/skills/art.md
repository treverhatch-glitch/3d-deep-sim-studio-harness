# Skill: art

**When.** Pre-production queues "Art: style sheet and five placeholder assets"; later, art tasks
from the Producer, and "Art: change D-…" tasks when the game dev asks for changes.

**Steps.**
1. Read `studio/bible/BIBLE.md` (pitch, art, pillars, voice, never) and any study in
   `studio/research/`.
2. Write the style sheet, `studio/art/STYLE.md`: palette (hex), shapes and silhouettes, lighting,
   camera, UI and text tone, what it takes from the references and what it avoids. One page.
   A concept image next to it (`studio/art/*.png`) helps the dev see it.
3. Propose it: `npm run art -- propose studio/art/STYLE.md --kind style --title "…" --task <ID> --by <you>`.
4. Make placeholders that follow it, from tools you can rerun: `blender --background --python
   tools/blender/generate_glb.py -- --preset crate --out assets/placeholder/crate.glb`, or a free
   CC0 source (say which, with `--licence CC0 --source <url>`). Propose each with `--kind asset`.
5. Tell the game dev they are waiting (the War Room shows them under "Needs you").

**Done means.** Designs proposed since the task started: a style sheet if the task asks for one,
and as many placeholder assets as it names. Approval is the game dev's call and comes after.

**Never.** Ship anything from `references/`. Approve your own designs. Vendor an asset tool into the
repo (`docs/EXTERNAL-TOOLS.md`).
