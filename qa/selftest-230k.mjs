/**
 * qa/selftest-230k.mjs — the 2.30k checks, run by qa/selftest.mjs on a copy of the repo.
 * File-level lanes (several files per task, guessed from the title or given with --paths) and
 * task done refusing uncommitted changes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230k({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230k-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };

  const F = ['w/boats.js', 'w/main.js', 'w/water.js', 'w/world.js', 'w/hud.css', 'w/index.html', 'w/copy.js', 'w/sim/index.mjs', 'w/jsm/Addons.js', 'w/three.module.js'];
  const g = probe(`import { inferPaths as f } from ${u('harness/task-hold.mjs')};
const F = ${JSON.stringify(F)};
console.log(JSON.stringify([f('Make ships livelier and wider', 'w', F), f('Fix the HUD toolbar button', 'w', F), f('Tidy up', 'w', F), f('Rework three.js addons', 'w', F)]));`);
  report('2.30k: files are guessed from the title (ships -> boats.js, HUD -> hud.css + index.html), nothing matched means the whole folder, vendored files never',
    Array.isArray(g) && g[0].join() === 'w/boats.js' && g[1].join() === 'w/hud.css,w/index.html' && g[2].length === 0 && !g[3].some((x) => /jsm|three/.test(x)), JSON.stringify(g));

  const c = probe(`import { lanesClash as c, laneList as l } from ${u('harness/task-hold.mjs')};
console.log(JSON.stringify([c('w/boats.js,w/world.js', 'w/hud.css'), c('w/boats.js,w/world.js', 'w/world.js'), c('w', 'w/boats.js'), c(null, 'w/boats.js'), l(' w/a.js, ./w/b.js/ ')]));`);
  report('2.30k: lanes of several files clash only when a file overlaps; no lane still means the whole game',
    Array.isArray(c) && c[0] === false && c[1] === true && c[2] === true && c[3] === true && c[4].join() === 'w/a.js,w/b.js', JSON.stringify(c));

  const k = probe(`import { claim } from ${u('harness/lock.mjs')};
const a = claim('path:web/x/boats.js', 'builder-a', 60); const b = claim('path:web/x/hud.css', 'builder-b', 60); const d = claim('path:web/x/boats.js', 'builder-b', 60);
console.log(JSON.stringify([a.ok !== false, b.ok !== false, d.ok === false]));`);
  report('2.30k: two builders hold different files at once; the same file is refused', Array.isArray(k) && k.every(Boolean), JSON.stringify(k));

  const src = fs.readFileSync(path.join(dir, 'harness', 'task.mjs'), 'utf8');
  report('2.30k: task add takes --paths, and task done refuses uncommitted changes in the claimed files',
    /flags\.paths/.test(src) && /error: 'uncommitted'/.test(src));
  const ag = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
  // 2.59.0 (#8): the loop skips a too-broad path left unheld in a lane copy and lets go of the ones it held so far.
  report('2.30k: the launcher claims each file of the lane and lets go of all of them',
    /for \(const p of lanePaths\) \{[\s\S]{0,120}const c = claim\(`path:\$\{p\}`, agent/.test(ag) && /for \(const q of held\) release\(`path:\$\{q\}`, agent\)/.test(ag) && /for \(const p of lanePaths\) release/.test(ag));
}
