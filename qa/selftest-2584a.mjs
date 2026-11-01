/**
 * qa/selftest-2584a.mjs — 2.58.4: "fails before the fix" counts only a run that played the old code.
 *
 * Found while building a game's first real cartridge: its bundle couldn't build in the fails-before worktree (no
 * node_modules there), so the probe threw, and the check said "the old code throws": a pass, on the fixed commit
 * too. A cartridge missing at the old commit, a build failure, a missing dependency or a timeout now give an error
 * (known: false) that isn't cached; a real difference still passes and the HEAD control still fails.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest2584A({ dir, run, report }) {
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`);
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const fb = (file, rev, env = {}) => {
    const r = run(dir, `node --input-type=module -e "const { failsBefore } = await import('./qa/fails-before.mjs'); console.log(JSON.stringify(failsBefore('${file}', '${rev}')))"`, env);
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: `${r.stdout}${r.stderr}`.slice(-1200) }; }
  };
  const cacheHas = (commit) => {
    try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, '.studio/cache/fails-before.json'), 'utf8'))).includes(commit); } catch { return false; }
  };
  const sha = (n = 1) => git(`rev-parse --short=7 HEAD~${n - 1}`).stdout.trim();
  const counter = (step) => `export const TUNING = Object.freeze({ add: 1 });
export function createInitialState(seed, tuning) { return { tick: 0, n: 0, add: (tuning || TUNING).add }; }
export function step(state) { ${step} return { ...state, tick: state.tick + 1, n: state.n + state.add }; }
`;
  const reg = (name, cart, extra = {}) => w(`qa/regressions/${name}.json`, JSON.stringify({ id: name, cartridge: cart, seed: 1, tick: 5, actions: [], ...extra }));

  git('init -q');
  git('add -A');
  git('commit -q -m base --no-verify');

  // 1. The cartridge isn't there yet at the old commit: loadCartridge says "not found".
  w('cartridges/fbnew/index.mjs', counter(''));
  reg('BUG-fbnew', 'fbnew', { sha256: '0'.repeat(64) });
  git('add -A');
  git('commit -q -m "add fbnew and its regression" --no-verify');
  const missing = fb('qa/regressions/BUG-fbnew.json', 'HEAD~1');
  report('2.58.4: a cartridge that isn\'t there at the old commit is an error (known: false), not "fails before"',
    missing.ok === false && missing.known === false && /couldn't be loaded/.test(missing.why || '') && /proves nothing/.test(missing.why || ''), JSON.stringify(missing));

  // 2. Its build (here: its import) fails at the old commit, as when the worktree has no node_modules.
  w('cartridges/fbbuild/index.mjs', `throw new Error('FBBUILD_BUILD_FAILED: no node_modules here');\nexport function createInitialState() { return {}; }\nexport function step(s) { return s; }\n`);
  reg('BUG-fbbuild', 'fbbuild', { sha256: '0'.repeat(64) });
  git('add -A');
  git('commit -q -m "fbbuild that can\'t build" --no-verify');
  const built = fb('qa/regressions/BUG-fbbuild.json', 'HEAD');
  report('2.58.4: a cartridge whose build or import fails at that commit (a missing dependency, a failed build) is an error, and the reason is shown',
    built.ok === false && built.known === false && /FBBUILD_BUILD_FAILED/.test(built.why || ''), JSON.stringify(built));

  // 3. The old code never finishes: a timeout is an error, not "throws".
  w('cartridges/fbslow/index.mjs', counter('for (;;) {}'));
  reg('BUG-fbslow', 'fbslow', { sha256: '0'.repeat(64) });
  git('add -A');
  git('commit -q -m "fbslow" --no-verify');
  const slow = fb('qa/regressions/BUG-fbslow.json', 'HEAD', { STUDIO_FAILS_BEFORE_TIMEOUT_MS: '3000' });
  report('2.58.4: a run that times out is an error (STUDIO_FAILS_BEFORE_TIMEOUT_MS), not a pass',
    slow.ok === false && slow.known === false && /timed out/.test(slow.why || ''), JSON.stringify(slow));
  report('2.58.4: those errors aren\'t cached, so a fixed setup is checked again', !cacheHas(sha(1)) && !cacheHas(sha(3)) && !cacheHas(sha(2)), fs.existsSync(path.join(dir, '.studio/cache/fails-before.json')) ? fs.readFileSync(path.join(dir, '.studio/cache/fails-before.json'), 'utf8').slice(0, 600) : 'no cache');

  // 4. A real fix still passes on its parent for the right reason, and the HEAD control still fails.
  for (const rel of ['qa/regressions/BUG-fbnew.json', 'qa/regressions/BUG-fbbuild.json', 'qa/regressions/BUG-fbslow.json', 'cartridges/fbbuild', 'cartridges/fbslow']) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
  w('cartridges/fbreal/index.mjs', counter(''));
  git('add -A');
  git('commit -q -m "fbreal with the bug (adds 1)" --no-verify');
  w('cartridges/fbreal/index.mjs', counter('').replace('add: 1', 'add: 2'));
  reg('BUG-fbreal', 'fbreal');
  const pin = run(dir, 'node qa/check-regressions.mjs --update');
  git('add -A');
  git('commit -q -m "fix fbreal (adds 2)" --no-verify');
  const parent = fb('qa/regressions/BUG-fbreal.json', 'HEAD~1');
  const head = fb('qa/regressions/BUG-fbreal.json', 'HEAD');
  report('2.58.4: a real fix still "fails before" on its parent (a different state), and the HEAD control fails ("passes on … too")',
    parent.ok === true && parent.known === true && /different state/.test(parent.why || '') && head.ok === false && head.known === true && /passes on/.test(head.why || ''), `${pin.stdout}${pin.stderr}\n${JSON.stringify({ parent, head })}`);
  report('2.58.4: the check leaves no worktree behind', !/fails-before-/.test(run(dir, 'git worktree list').stdout));
}
