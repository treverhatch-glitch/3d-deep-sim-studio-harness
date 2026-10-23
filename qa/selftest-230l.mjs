/**
 * qa/selftest-230l.mjs — the 2.30l checks, run by qa/selftest.mjs on a copy of the repo.
 * One builder per task (a launch lock shared by every pass), and the studio's game set apart
 * from the gates' cartridge so a web game's files are found for lanes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest230l({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230l-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };

  // 1. Two passes at once: only the first gets the task's launch lock.
  const l = probe(`import { claim } from ${u('harness/lock.mjs')};
const a = claim('launch:T-900', 'builder-auto-38', 120); const b = claim('launch:T-900', 'builder-auto-39', 120);
console.log(JSON.stringify([a.ok !== false, b.ok === false]));`);
  report('2.30l: a second launch of the same task is refused (one launch lock per task)', Array.isArray(l) && l.every(Boolean), JSON.stringify(l));
  const sup = fs.readFileSync(path.join(dir, 'harness', 'supervisor.mjs'), 'utf8');
  report('2.30l: the supervisor takes the launch lock and skips a task that already has an agent before it starts one',
    /claimLaunch\(`launch:\$\{taskId\}`/.test(sup) && /s\.task === taskId/.test(sup) && sup.indexOf('claimLaunch(`launch:') < sup.indexOf('const r = startAgent('));

  // 2. The game, apart from the cartridge: a web game with its sim beside it.
  fs.mkdirSync(path.join(dir, 'web', 'harbor-test', 'sim'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'harbor-test', 'boats.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'web', 'harbor-test', 'sim', 'index.mjs'), 'export const y = 1;\n');
  const set = run(dir, 'node harness/task.mjs game harbor-test');
  const g = probe(`import { gameFolders } from ${u('harness/task-hold.mjs')};
import { activeCartridge } from ${u('harness/cartridge.mjs')};
import { inferPaths } from ${u('harness/task-hold.mjs')};
const f = gameFolders();
console.log(JSON.stringify({ f, cart: activeCartridge().name, guess: inferPaths('Make the boats livelier', f.renderer) }));`);
  report('2.30l: task game <name> sets the studio game; its web folder and web/<game>/sim are found, the gates cartridge is unchanged, and files are guessed',
    set.status === 0 && g.f?.renderer === 'web/harbor-test' && g.f?.sim === 'web/harbor-test/sim' && g.cart !== 'harbor-test' && g.guess?.join() === 'web/harbor-test/boats.js', `${set.stdout}${set.stderr}${JSON.stringify(g)}`);
}
