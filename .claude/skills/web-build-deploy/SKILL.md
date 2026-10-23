---
name: web-build-deploy
description: Use to run the browser check, play the game, or manage saved builds for the Arcade.
---
### When
- After making a change to the web front-end (`--part renderer` or `both`).
- To verify the game plays correctly in a real browser environment.
- To create a shareable build for playtesting.

### Steps
1.  Run the full browser play check. It builds (if needed), serves, and plays through the main scenario: `npm run play:browser`.
2.  If it fails, check the report in `qa/reports/` for screenshots and error details. Fix and repeat.
3.  Once `npm run play:browser` passes, the build is automatically saved for the Arcade.
4.  To play the latest saved build yourself: `npm run play`.
5.  To list all saved builds: `npm run play -- list`.
6.  To play a specific older build for comparison: `npm run play -- --build <id>`.

### Done means
- `npm run play:browser` passes.
- A new build has been saved to `.studio/builds/` if your changes affected the web build.

### Never
- Consider a renderer task done without a passing `npm run play:browser` run.
- Manually copy files to create a build; let the harness save the build that passed the check.
