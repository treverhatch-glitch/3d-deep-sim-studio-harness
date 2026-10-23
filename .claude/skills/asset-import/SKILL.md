---
name: asset-import
description: Use to find, import, and credit 3D models or other art assets for the game.
---
### When
- A task requires a new visual asset (model, texture).
- You need to find open-source assets with a compatible license (CC0, CC-BY).
- You need to add a downloaded asset to the project and update credits.

### Steps
1.  Find candidate assets with permissive licenses: `npm run scout -- find "crate"`.
2.  Download the asset file.
3.  Import the asset and record its license information: `npm run scout -- pull <file> --licence CC0 --author "<who>" --source <page> --title "<name>"`.
4.  For assets with restrictive licenses (SA, NC, ND), add them for reference only: `npm run asset -- add <file> --use reference`.
5.  After pulling assets, update the main credits file: `npm run scout -- credits`.
6.  Place the final game-ready asset (e.g., `.glb`) in the game repository's asset folder.

### Done means
- The asset is recorded via `npm run scout -- pull`.
- `CREDITS.md` is up-to-date (the `assets` gate passes).
- The final asset is in the game's asset directory, not the harness repo.

### Never
- Pull unapproved or incorrectly licensed assets into the game.
- Forget to run `npm run scout -- credits` after pulling a new asset.
- Commit large asset files into the harness repository.
