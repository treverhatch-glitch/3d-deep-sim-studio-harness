# Asset brief (`studio/templates/asset-brief.md`)

The brief every asset ("make") task starts from: the asset track (`--track asset`, role `asset-3d`) and any tool that
queues a make task copy this block into the task's brief and fill in every line. Blender runs headless only:
`blender -b --factory-startup -P <script> -- <args>`, never the GUI.

```
Asset brief
- What: <the object, in one line>
- Used in: <scene / feature / layer, and how often it repeats on screen>
- Real-world size: <width x depth x height in metres>   (recorded as "size": { "w": , "d": , "h": } in the file's
  manifest row or in <name>.asset.json next to it; the asset gate checks the model's bounding box against it)
- Triangle budget per LOD: LOD0 <n>, LOD1 <n>, LOD2 <n>   (the game's limits: studio/game.json "assets".triangleBudget)
- Texture budget: <max px on the longest side, count of maps>   (limit: "assets".textureMaxPx)
- Style refs: <files in the reference library or the style sheet>
- Licence: own work | <licence of the source, with its credit line> | generated (<tool>, <plan/terms>)
- Files: <assets/... paths it will add, plus <name>.preview.png next to each model>
```

Done means the asset gate passes (`node harness/asset-gate.mjs --task <ID>`; docs/BLENDER.md "Asset track"): a licence
row for every file, triangles per LOD, texture sizes, scale within the stated size, a preview render, the round trip,
no brand names. The engine task that wires the asset in is queued by the harness when it lands.
