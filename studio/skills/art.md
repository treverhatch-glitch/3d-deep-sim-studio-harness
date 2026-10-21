# Skill: art

**When.** Pre-production queues "Art: style sheet and five placeholder assets"; later, art tasks from
the Producer, and "Art: round N of #4 …" tasks when the game dev asks for changes.

**Before you start.** Read `studio/bible/BIBLE.md` (pitch, art, pillars, voice, never), any study in
`studio/research/`, and the dev's references in `studio/art/references.json` (each has a label:
"look" = look like this, never shipped; "use" = the dev's own asset, already in the game folder).
Check `npm run art` for feedback on assets you made: the last words on each round are there.

**Steps.**
1. Style sheet first: `studio/art/STYLE.md` (palette with hex, shapes, lighting, camera, UI tone, what
   it takes from the references and what it avoids). Propose it:
   `npm run art -- propose studio/art/STYLE.md --kind style --title "…" --task <ID> --by <you>`.
2. Make assets that follow it, with tools you can rerun (`tools/blender/generate_glb.py`, a clean-up
   script) or free CC0 sources (Poly Haven needs a User-Agent header). Save them anywhere, then
   propose each one; it is copied into `assets/staging/<pack>/` and gets a number (#4):
   `npm run art -- propose <file> --title "Yellow gun" --pack weapons [--thumb <png>] --by <you>`.
   - From a library: `--licence CC0 --author "…" --source <url>`.
   - AI-generated: `--generated "<tool>:<model>" --prompt <prompt file> --terms "<plan or terms>"`.
   - A 3D file gets a picture with `--thumb` (a render or contact sheet), or the Asset studio spins it.
3. Iterate freely: a better version is `npm run art -- propose <file> --round-of 4 --by <you>`.
   Rounds never wait for the dev. The Asset studio always shows the latest.
4. The dev gives a thumbs up (the file moves to `assets/approved/` and a builder gets the import task)
   or words for the next round. Past the pace's limit the Producer approves provisionally.

**Done means.** Designs proposed since the task started: a style sheet if the task asks for one, and
as many assets as it names. Approval is the dev's (or the Producer's) and comes after.

**Never.** Load `assets/staging/` from game code (the assets gate fails). Ship anything from
`references/`. Approve your own work. Vendor an asset tool into the repo (`docs/EXTERNAL-TOOLS.md`).
