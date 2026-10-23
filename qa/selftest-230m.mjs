/**
 * qa/selftest-230m.mjs — the 2.30m checks, run by qa/selftest.mjs on a copy of the repo.
 * A build task with no code change since it started is refused unless closed as no-op with a reason.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest230m({ dir, run, report }) {
  const env = { STUDIO_LOCK_OWNER: 'builder-m1', STUDIO_DONE_UNCOMMITTED: 'allow' };
  const g = (args) => run(dir, `git ${args}`);
  g('init -q'); g('-c user.name=t -c user.email=t@t add -A'); g('-c user.name=t -c user.email=t@t commit -qm base --no-verify');
  const add = run(dir, 'node harness/task.mjs add "System: harbour lights blink at night" --role builder --type system --size 2 --origin dev --asked "test"', env);
  const id = (add.stdout.match(/T-\d+/) || [])[0];
  const st = run(dir, `node harness/task.mjs start ${id} --agent builder-m1`, env);
  const none = run(dir, `node harness/task.mjs done ${id} --agent builder-m1`, env);
  report('2.30m: task done refuses a build task with no code change since it started',
    Boolean(id) && st.status === 0 && none.status !== 0 && /no code changed since it started/.test(`${none.stdout}${none.stderr}`), `${add.stdout}${st.stdout}${st.stderr}${none.stdout}${none.stderr}`);
  const short = run(dir, `node harness/task.mjs done ${id} --agent builder-m1 --no-op "ok"`, env);
  report('2.30m: a no-op reason shorter than 10 characters is not enough', short.status !== 0 && /no code changed/.test(`${short.stdout}${short.stderr}`), `${short.stdout}${short.stderr}`);
  fs.writeFileSync(path.join(dir, 'harness', 'zz-change-230m.mjs'), 'export const x = 1;\n');
  g('-c user.name=t -c user.email=t@t add -A'); g('-c user.name=t -c user.email=t@t commit -qm change --no-verify');
  const changed = run(dir, `node harness/task.mjs done ${id} --agent builder-m1`, env);
  report('2.30m: after a committed code change the no-change check passes', !/no code changed/.test(`${changed.stdout}${changed.stderr}`), `${changed.stdout}${changed.stderr}`);
}
