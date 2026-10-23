/**
 * qa/selftest-230n.mjs — the 2.30n check: a lane copy finds its main checkout from its own path
 * (<main>/.lanes/<agent>) when STUDIO_MAIN_ROOT is missing, so task done never skips the merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230nLane({ dir, run, report, tmpRoot }) {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const lane = path.join(dir, '.lanes', 'builder-n1');
  fs.mkdirSync(lane, { recursive: true });
  fs.cpSync(path.join(dir, 'harness'), path.join(lane, 'harness'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'package.json'), path.join(lane, 'package.json'));
  const f = path.join(tmpRoot, `p230n-${process.pid}.mjs`);
  fs.writeFileSync(f, `import { mainRoot, inLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(lane, 'harness', 'worktree.mjs')).href)};
console.log(JSON.stringify({ main: mainRoot(), lane: inLaneCopy() }));`);
  const r = run(dir, `env -u STUDIO_MAIN_ROOT node "${f}"`);
  let o = {};
  try { o = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  report('2.30n: without STUDIO_MAIN_ROOT a lane copy still knows its main checkout and that it is a lane copy',
    o.lane === true && path.resolve(o.main || '') === path.resolve(dir), `${r.stdout}${r.stderr}`);
  const m = run(dir, `env -u STUDIO_MAIN_ROOT node -e "import('./harness/worktree.mjs').then(w=>console.log(w.inLaneCopy()))"`);
  report('2.30n: the main checkout is not a lane copy', /false/.test(m.stdout), `${m.stdout}${m.stderr}`);
}
