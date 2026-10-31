/**
 * qa/selftest-248.mjs — 2.48.0: a Unity track builds a Windows .exe by default, with no browser export.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest248({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_UNITY: path.join(tmpRoot, 'no-unity-248') };
  run(dir, 'node scripts/new-game.mjs moth-run', env);
  const st = run(dir, 'node harness/engine.mjs start unity --by prod-1', env);
  const t = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'engine/moth-run/engine.json'), 'utf8')); } catch { return {}; } })();
  const b = run(dir, 'node harness/unity.mjs build', env);
  const web = run(dir, 'node harness/unity.mjs build --target web', env);
  const ci = fs.readFileSync(path.join(dir, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n'); // Windows checks out CRLF
  report('2.48.0: a Unity track builds a Windows .exe by default with no browser export (the Arcade lists it as native); --target web still makes a WebGL build; CI\'s Unity build job makes the Windows build', st.status === 0 && t.engine === 'unity' && t.webExport === null && t.buildTarget === 'windows' && /Windows build also needs/.test(out(b)) && /WebGL build also needs/.test(out(web)) && /targetPlatform: StandaloneWindows64\n\s+buildMethod: StudioBuild\.Windows/.test(ci) && !/targetPlatform: WebGL/.test(ci), `${out(st)}\n${JSON.stringify(t)}\n${out(b)}\n${out(web)}`);
}
