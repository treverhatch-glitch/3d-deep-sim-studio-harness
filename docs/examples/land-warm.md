# Example: a land script step that uses the warm editor (2.84, untested on a real editor)

This is an EXAMPLE of the shape, not a script the harness ships. A studio's land script is its own; the harness only
offers a warm editor (docs/NATIVE-ENGINE.md "The editor service"). When `STUDIO_EDITOR_SERVICE` is not set, or the
request answers with exit 3, the step starts Unity cold exactly as before.

```js
// land.mjs (excerpt): the Edit Mode stage
import { spawnSync } from 'node:child_process';

function editMode(results) {
  if (process.env.STUDIO_EDITOR_SERVICE && process.env.STUDIO_EDITOR_SERVICE_CLI) {
    // The warm editor already has the land tree open: refresh + run, no cold start, no re-import.
    const cmd = `${process.env.STUDIO_EDITOR_SERVICE_CLI} test --mode EditMode --results "${results}"`;
    const r = spawnSync(cmd, { shell: true, encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return 'pass';
    if (r.status === 1) return 'fail';   // the tests ran and failed: the results file names them
    // 3: no healthy editor or it timed out (the harness recycles it): fall through to the cold path.
  }
  const unity = process.env.STUDIO_UNITY;
  const r = spawnSync(unity, ['-batchmode', '-projectPath', '.', '-runTests', '-testPlatform', 'EditMode',
    '-testResults', results, '-logFile', '-'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? 'pass' : 'fail';
}
```

Before a test request the script checks out the batch in the land tree as usual; the editor sees the new files on
its own `refresh` (a `test` request should follow a `request refresh` or `request compile` so the new code is loaded).
