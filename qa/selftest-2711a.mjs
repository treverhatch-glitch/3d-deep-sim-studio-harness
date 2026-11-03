/**
 * qa/selftest-2711a.mjs — 2.71.1 (A): the red team's holes in the protection gates, each attack shown caught with a clean
 * change beside it that stays green.
 *   1. Gate runners (A01b/A01d/A03): a lane that neuters qa/check-golden.mjs or the cartridge loader fails the protected gate.
 *   2. Test toolchain (H03/H04/S02): a game's vitest/vite config, the setup file it names, an .npmrc and the test script in
 *      its package.json are protected (the setup file and the script also make a lane tier C in the train); a new
 *      dependency is not.
 *   3. Weakened tests (H10/H13): skipIf on CI, an early return on CI, a shadowed or proxied expect are flagged; a new
 *      test that runs on one OS only (runIf) is not.
 *   4. Env overrides in a lane (A01b, A09, A16, G12): STUDIO_WEAKENED_TESTS=off, STUDIO_PROTECT_BASE, STUDIO_PROTECT_ROOT
 *      and STUDIO_MAIN_ROOT naming the lane itself are ignored there (and said so); the main checkout keeps them.
 *   5. Verify records (D01/T04, G15/T02): a hand-written record, an edited one and one from a verify beside an untracked
 *      config are not reused by the train; an honest one (build output ignored beside it) is.
 *   6. Golden re-record (A13): a lane that re-records a golden on its own Golden-Reason is tier C.
 * The words the weakened-test gate looks for are put together at run time, so this file never trips it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2711A({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { cwd, encoding: 'utf8' });
  const g = (...a) => gitIn(dir, ...a);
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => fs.readFileSync(path.join(cwd, rel), 'utf8').replace(/\r\n/g, '\n');
  const editIn = (cwd, rel, from, to) => { const t = readIn(cwd, rel); if (!t.includes(from)) throw new Error(`${rel}: no "${from}"`); writeIn(cwd, rel, t.replace(from, to)); };
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, 'no-owner-key.pem'), STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', GITHUB_SHA: '',
    STUDIO_HOOKS_CHECK: '', STUDIO_WEAKENED_TESTS: '', STUDIO_LOCK_OWNER: '', STUDIO_VERIFY_RUN: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', CI: '', GITHUB_ACTIONS: '' };
  const json = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return { _raw: out(r).slice(-1500) }; } };
  const gate = (cwd, cmd, extra = {}) => { const r = run(cwd, cmd, { ...env, ...extra }); return { status: r.status, ...json(r), _out: out(r).slice(-1500) }; };
  const prot = (cwd, extra) => gate(cwd, 'node qa/protected-check.mjs --json', extra);
  const weak = (cwd, extra) => gate(cwd, 'node harness/test-weakening.mjs --json', extra);
  const paths = (r) => (r.changes || []).map((c) => c.path);
  const kinds = (r) => (r.findings || []).map((f) => f.kind);
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || e.message); } };
  const probe = (cwd, name, code, extra = {}) => {
    const f = path.join(tmpRoot, `probe-2711a-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    return { ...json(r), _out: out(r).slice(-1500) };
  };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  // Words the weakened-test gate looks for, built here.
  const W = { SKIPIF: ['.skip', 'If'].join(''), RUNIF: ['.run', 'If'].join(''), ENV: ['process', 'env'].join('.'), EXPECT: 'exp' + 'ect' };

  // ---- the studio: this harness, a made-up vitest game, an owner key on main ----
  writeIn(dir, 'web/mini/package.json', `${JSON.stringify({ name: 'mini', private: true, type: 'module', scripts: { test: 'vitest run', dev: 'vite' }, devDependencies: { vitest: '^3.0.0' } }, null, 2)}\n`);
  writeIn(dir, 'web/mini/vite.config.ts', 'import { defineConfig } from "vitest/config"\nexport default defineConfig({ test: { environment: "node", include: ["src/**/*.test.ts"], setupFiles: ["src/test/setup.ts"] } })\n');
  writeIn(dir, 'web/mini/src/test/setup.ts', 'export {}\n');
  writeIn(dir, 'web/mini/src/core/bank.ts', 'export const pay = (n: number) => n * 2\n');
  writeIn(dir, 'web/mini/src/core/bank.test.ts', `import { describe, it, ${W.EXPECT} } from 'vitest'\nimport { pay } from './bank'\n\ndescribe('payroll', () => {\n  it('pays twice the hours', () => {\n    ${W.EXPECT}(pay(2)).toBe(4)\n  })\n})\n`);
  writeIn(dir, 'web/mini/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'tests', command: 'cd web/mini && npm test', required: true }] }, null, 2)}\n`);
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  writeIn(dir, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '--no-verify', '-m', 'studio with an owner key');
  // A lane copy: a git worktree at <main>/.lanes/<agent>, as harness/worktree.mjs makes it.
  const lane = path.join(dir, '.lanes', 'bob-2711a');
  const add = g('worktree', 'add', '-q', '-b', 'lane/bob-2711a', lane, 'main');
  try { fs.symlinkSync(path.join(dir, 'node_modules'), path.join(lane, 'node_modules'), 'junction'); } catch {}
  const L = (...a) => gitIn(lane, ...a);
  const reset = () => { L('reset', '-q', '--hard', 'main'); L('clean', '-qfd', '--', 'web', 'qa', 'harness'); };
  if (add.status !== 0) { report('2.71.1 (A): setup: a lane copy (git worktree add)', false, out(add)); return; }

  // ---- 1. the gate runners are protected ----
  await guard('2.71.1 (A, item 1, A01b/A01d/A03): a lane that neuters a gate runner (qa/check-golden.mjs exits 0) or the cartridge loader fails the protected gate, naming the file; a docs change stays green (fails on 2.71.0: the runners were not on the protected list, the attack passed)', () => {
    reset();
    writeIn(lane, 'docs/notes-2711a.md', '# notes\n');
    L('add', '-A'); L('commit', '-q', '--no-verify', '-m', 'docs');
    const clean = prot(lane);
    writeIn(lane, 'qa/check-golden.mjs', 'console.log("[golden] PASS"); process.exit(0);\n');
    editIn(lane, 'harness/cartridge.mjs', 'export', '// vendored copy first\nexport');
    L('add', '-A'); L('commit', '-q', '--no-verify', '-m', 'refactor loader');
    const bad = prot(lane);
    return [clean.status === 0 && clean.ok && bad.status !== 0 && !bad.ok && paths(bad).includes('qa/check-golden.mjs') && paths(bad).includes('harness/cartridge.mjs'),
      `clean: ${JSON.stringify(clean).slice(0, 500)}\nbad: ${JSON.stringify(bad).slice(0, 800)}`];
  });

  // ---- 2. the game's test toolchain is protected ----
  await guard('2.71.1 (A, item 2, H03/H04/S02): in a game folder a new vitest.config, an edit to the setup file vite.config names, a new .npmrc and a changed test script in package.json each fail the protected gate (the script as "web/mini/package.json#test-scripts"); a new dependency and a source edit pass (fails on 2.71.0: none of them was protected)', () => {
    const seen = {};
    const tryIt = (name, fn) => { reset(); fn(); seen[name] = prot(lane); };
    tryIt('config', () => writeIn(lane, 'web/mini/vitest.config.ts', 'export default { test: { include: ["src/misc/**"] } }\n'));
    tryIt('setup', () => writeIn(lane, 'web/mini/src/test/setup.ts', 'import { vi } from "vitest"\nvi.mock("../core/bank", () => ({ pay: () => 4 }))\n'));
    tryIt('npmrc', () => writeIn(lane, 'web/mini/.npmrc', 'node-options=--import=./tools/q.mjs\n'));
    tryIt('script', () => editIn(lane, 'web/mini/package.json', '"test": "vitest run"', '"test": "vitest run src/misc"'));
    tryIt('control', () => { editIn(lane, 'web/mini/package.json', '"vitest": "^3.0.0"', '"vitest": "^3.0.0",\n    "zod": "^3.0.0"'); editIn(lane, 'web/mini/src/core/bank.ts', 'n * 2', 'n * 2 // per hour'); });
    reset();
    const ok = seen.config.status !== 0 && paths(seen.config).includes('web/mini/vitest.config.ts')
      && seen.setup.status !== 0 && paths(seen.setup).includes('web/mini/src/test/setup.ts')
      && seen.npmrc.status !== 0 && paths(seen.npmrc).includes('web/mini/.npmrc')
      && seen.script.status !== 0 && paths(seen.script).includes('web/mini/package.json#test-scripts')
      && seen.control.status === 0 && seen.control.ok;
    return [ok, JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { status: v.status, changes: paths(v), why: v.why, raw: v._raw }]))).slice(0, 2500)];
  });
  await guard('2.71.1 (A, item 2): the train holds a lane that edits the setup file the game\'s vite.config names, or its test script, at tier C (protected); a lane adding a dependency is not (fails on 2.71.0: tier B)', () => {
    const tierOf = (fn) => {
      reset(); fn(); L('add', '-A'); L('commit', '-q', '--no-verify', '-m', 'lane change');
      const head = L('rev-parse', 'HEAD').stdout.trim();
      return probe(dir, 'tier', `import { laneTier } from ${u('harness/train.mjs')};\nconst c = await laneTier(process.cwd(), { head: ${JSON.stringify(head)} }, { tip: ${JSON.stringify(g('rev-parse', 'main').stdout.trim())} });\nconsole.log(JSON.stringify({ tier: c.tier, rules: c.rules, why: c.why }));\n`);
    };
    const setup = tierOf(() => writeIn(lane, 'web/mini/src/test/setup.ts', 'export const quiet = true\n'));
    const script = tierOf(() => editIn(lane, 'web/mini/package.json', '"test": "vitest run"', '"test": "vitest run --passWithNoTests"'));
    const dep = tierOf(() => editIn(lane, 'web/mini/package.json', '"vitest": "^3.0.0"', '"vitest": "^3.0.0",\n    "zod": "^3.0.0"'));
    reset();
    return [setup.tier === 'C' && setup.rules?.includes('protected') && script.tier === 'C' && script.rules?.includes('protected') && dep.tier !== 'C',
      JSON.stringify({ setup, script, dep }).slice(0, 2000)];
  });

  // ---- 3. weakened tests: skipIf on CI, early return on CI, a stand-in expect ----
  await guard('2.71.1 (A, item 3, H10/H13): the weakened-tests gate flags describe.skipIf(CI) on an existing suite, an early return on an env variable, and expect renamed on import and wrapped in a Proxy; a NEW test that runs on one OS only (it.runIf(platform)) passes (fails on 2.71.0: all three passed)', () => {
    const T = 'web/mini/src/core/bank.test.ts';
    const seen = {};
    const tryIt = (name, fn) => { reset(); fn(); seen[name] = weak(lane); };
    tryIt('skipIf', () => editIn(lane, T, "describe('payroll'", `describe${W.SKIPIF}(!!${W.ENV}.CI)('payroll'`));
    tryIt('envReturn', () => editIn(lane, T, "  it('pays twice the hours', () => {\n", `  it('pays twice the hours', () => {\n    if (${W.ENV}.CI) return\n`));
    tryIt('proxy', () => {
      editIn(lane, T, `import { describe, it, ${W.EXPECT} } from 'vitest'`, `import { describe, it, ${W.EXPECT} as e0 } from 'vitest'`);
      fs.appendFileSync(path.join(lane, T), `function ${W.EXPECT}(v: any): any { return new Proxy(e0(v), { get: (o, k) => (...a: any[]) => { try { return (o as any)[k](...a) } catch { return undefined } } }) }\n`);
    });
    tryIt('control', () => fs.appendFileSync(path.join(lane, T), `\ndescribe('paths', () => {\n  it${W.RUNIF}(process.platform === 'win32')('uses backslashes', () => {\n    ${W.EXPECT}('a\\\\b'.includes('\\\\')).toBe(true)\n  })\n})\n`));
    reset();
    const ok = seen.skipIf.status !== 0 && kinds(seen.skipIf).includes('skip-added')
      && seen.envReturn.status !== 0 && kinds(seen.envReturn).includes('env-skip')
      && seen.proxy.status !== 0 && kinds(seen.proxy).includes('expect-shadowed')
      && seen.control.status === 0 && seen.control.ok && !kinds(seen.control).length;
    return [ok, JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, { status: v.status, kinds: kinds(v), why: v.why, raw: v._raw }]))).slice(0, 2500)];
  });

  // ---- 4. env overrides in a lane ----
  await guard('2.71.1 (A, item 4, A01b/A09/A16/G12): in a lane copy STUDIO_WEAKENED_TESTS=off, STUDIO_PROTECT_BASE=HEAD, STUDIO_PROTECT_ROOT=<a pristine clone> and STUDIO_MAIN_ROOT=<the lane itself> are ignored (the result says "ignored in a lane copy") and the gates fail on what the lane changed (fails on 2.71.0: each attack passed green)', () => {
    reset();
    // A removed assert (caught on 2.71.0 too) and a narrowed manifest (protected on 2.71.0 too): only the env differs.
    editIn(lane, 'web/mini/src/core/bank.test.ts', `    ${W.EXPECT}(pay(2)).toBe(4)\n`, '');
    editIn(lane, 'web/mini/studio.gates.json', 'npm test', 'npm test -- src/misc');
    L('add', '-A'); L('commit', '-q', '--no-verify', '-m', 'gate: narrow');
    const pristine = path.join(tmpRoot, `pristine-2711a-${process.pid}`);
    gitIn(tmpRoot, 'clone', '-q', '--branch', 'main', dir, pristine);
    const off = weak(lane, { STUDIO_WEAKENED_TESTS: 'off' });
    const base = prot(lane, { STUDIO_PROTECT_BASE: 'HEAD' });
    const ghBase = prot(lane, { GITHUB_BASE_REF: 'lane/bob-2711a' });
    const root = prot(lane, { STUDIO_PROTECT_ROOT: pristine });
    const self = prot(lane, { STUDIO_MAIN_ROOT: lane });
    const real = prot(lane, { STUDIO_MAIN_ROOT: dir });
    fs.rmSync(pristine, { recursive: true, force: true });
    const ignored = (r) => /ignored in a lane copy/.test(String(r.note || ''));
    const ok = off.status !== 0 && !off.off && kinds(off).includes('assert-removed') && ignored(off)
      && base.status !== 0 && paths(base).includes('web/mini/studio.gates.json') && ignored(base)
      && ghBase.status !== 0 && ignored(ghBase)
      && root.status !== 0 && paths(root).includes('web/mini/studio.gates.json') && ignored(root)
      && self.status !== 0 && paths(self).includes('web/mini/studio.gates.json') && ignored(self)
      && real.status !== 0 && !ignored(real);
    return [ok, JSON.stringify({ off, base, ghBase, root, self, real }, (k, v) => (k === '_out' ? undefined : v)).slice(0, 3000)];
  });
  await guard('2.71.1 (A, item 4, control): in the main checkout the owner\'s overrides still work: STUDIO_WEAKENED_TESTS=off turns the gate off and STUDIO_PROTECT_BASE names the base (2.58.2 behaviour, selftest-2582k)', () => {
    reset();
    g('checkout', '-q', '-b', 'side-2711a');
    editIn(dir, 'web/mini/src/core/bank.test.ts', `    ${W.EXPECT}(pay(2)).toBe(4)\n`, '');
    const off = weak(dir, { STUDIO_WEAKENED_TESTS: 'off' });
    const on = weak(dir, { STUDIO_PROTECT_BASE: 'main' });
    g('checkout', '-q', '--', '.'); g('checkout', '-q', 'main'); g('branch', '-q', '-D', 'side-2711a');
    return [off.status === 0 && off.off && !off.note && on.status !== 0 && kinds(on).includes('assert-removed') && !on.note, JSON.stringify({ off, on }).slice(0, 2000)];
  });

  // ---- 6. golden re-record on the lane's own Golden-Reason ----
  await guard('2.71.1 (A, item 6, A13): a lane that re-records a golden with its own Golden-Reason is tier C (rule golden-rerecord: a person, a delegation or autonomous review releases it); without the trailer it stays tier B and needs one; a NEW golden with the trailer is not C; the game\'s manifest may set it to B (fails on 2.71.0: tier B, it landed on its own word)', () => {
    const r = probe(dir, 'gold', `import { classifyLane } from ${u('harness/tiers.mjs')};
const f = [{ status: 'M', path: 'qa/golden/example-sim.json' }];
const own = classifyLane({ files: f, trailers: { 'Golden-Reason': ['income curve retune per design'] } });
const none = classifyLane({ files: f, trailers: {} });
const added = classifyLane({ files: [{ status: 'A', path: 'qa/golden/new-scenario.json' }], trailers: { 'Golden-Reason': ['new scenario'] } });
const lowered = classifyLane({ files: f, trailers: { 'Golden-Reason': ['x'] }, settings: { tiers: { set: { 'golden-rerecord': 'B' } } } });
console.log(JSON.stringify({ own: [own.tier, own.rules], none: [none.tier, none.needs.goldenReason], added: added.tier, lowered: lowered.tier }));
`);
    return [r.own?.[0] === 'C' && r.own[1].includes('golden-rerecord') && r.none?.[0] === 'B' && r.none[1].length === 1 && r.added !== 'C' && r.lowered === 'B', JSON.stringify(r).slice(0, 1500)];
  });

  // ---- 5. verify records: only the harness's own, from a clean run, are reused ----
  try { g('worktree', 'remove', '--force', lane); } catch {}
  writeIn(dir, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node -e "process.exit(process.env.FAIL_2711A ? 1 : 0)"', required: true, lite: true }] }, null, 2)}\n`);
  writeIn(dir, 'studio/game.json', `${JSON.stringify({ game: 'mini' })}\n`);
  g('add', '-A'); g('commit', '-q', '--no-verify', '-m', 'a one-check verify');
  const tree = g('rev-parse', 'HEAD^{tree}').stdout.trim();
  const headSha = g('rev-parse', 'HEAD').stdout.trim();
  const gatesDir = path.join(dir, '.studio', 'gates');
  const fresh = () => { for (const d of [gatesDir, path.join(dir, '.studio', 'train'), path.join(dir, '.studio', 'gates-last-full.json'), path.join(dir, '.studio', 'gates-last.json')]) fs.rmSync(d, { recursive: true, force: true }); };
  const verify = (owner, extra = {}) => run(dir, 'node scripts/run-gates.mjs --no-detach', { ...env, STUDIO_LOCK_OWNER: owner, ...extra });
  const recOf = (owner) => { try { return JSON.parse(fs.readFileSync(path.join(gatesDir, `${owner}-full.json`), 'utf8')); } catch { return null; } };
  const train = (name) => probe(dir, `vt-${name}`, `import { verifyTree } from ${u('harness/train.mjs')};
const logs = [];
const r = verifyTree({ root: process.cwd(), dir: process.cwd() }, { id: 'tt-${name}', n: 1, tree: ${JSON.stringify(tree)}, changed: [], all: false, seen: new Map(), log: (m) => logs.push(m) });
console.log(JSON.stringify({ reused: Boolean(r.reused), ok: r.ok, logs }));
`);
  await guard('2.71.1 (A, item 5, D01/T04): a hand-written green record of the tree, and a failing run\'s record edited to green, are not reused by the train (it says why: no run id / doesn\'t match the run log, and verifies itself); an honest verify\'s record is, with build output (dist/) ignored beside it (fails on 2.71.0: both forged records were reused)', () => {
    fresh();
    fs.mkdirSync(gatesDir, { recursive: true });
    fs.writeFileSync(path.join(gatesDir, 'forger-full.json'), JSON.stringify({ at: new Date().toISOString(), head: headSha, tree, dirty: false, partial: false, scope: 'lite', rows: [{ id: 'game', ok: true, required: true }] }));
    const forged = train('forged');
    fresh();
    const red = verify('red-1', { FAIL_2711A: '1' });
    const redRec = recOf('red-1');
    for (const f of [path.join(gatesDir, 'trees'), path.join(dir, '.studio', 'gates-last-full.json')]) fs.rmSync(f, { recursive: true, force: true }); // only the edited record is left
    if (redRec) fs.writeFileSync(path.join(gatesDir, 'red-1-full.json'), JSON.stringify({ ...redRec, rows: redRec.rows.map((r) => ({ ...r, ok: true })) }, null, 2));
    const edited = train('edited');
    fresh();
    writeIn(dir, 'web/mini/dist/bundle.js', 'built\n');
    writeIn(dir, 'scratch-2711a.txt', 'a note at the root, outside what the checks read\n');
    const honestRun = verify('ok-1');
    const honestRec = recOf('ok-1');
    const honest = train('honest');
    fs.rmSync(path.join(dir, 'web/mini/dist'), { recursive: true, force: true });
    fs.rmSync(path.join(dir, 'scratch-2711a.txt'), { force: true });
    const ok = !forged.reused && forged.logs?.some((l) => /no run id/.test(l))
      && red.status !== 0 && redRec && !edited.reused && edited.logs?.some((l) => /doesn't match the run log/.test(l))
      && honestRun.status === 0 && honestRec?.runId && honestRec.dirty === false && !honestRec.hidden && honest.reused;
    return [ok, JSON.stringify({ forged, edited, redRec, honestRec, honest, honestRun: out(honestRun).slice(-600) }).slice(0, 3000)];
  });
  await guard('2.71.1 (A, item 5, G15/T02): a verify run beside an untracked vitest.config in the game folder records dirty (and the file), so after the file is deleted the train still doesn\'t reuse it (fails on 2.71.0: dirty:false, reused)', () => {
    fresh();
    writeIn(dir, 'web/mini/vitest.config.ts', 'export default { test: { include: ["src/misc/**"] } }\n');
    const v = verify('hid-1');
    const rec = recOf('hid-1');
    fs.rmSync(path.join(dir, 'web/mini/vitest.config.ts'), { force: true });
    const t = train('hidden');
    fresh();
    return [v.status === 0 && rec?.dirty === true && (rec.hidden || []).includes('web/mini/vitest.config.ts') && /untracked or ignored file/.test(out(v)) && !t.reused,
      `${out(v).slice(-800)}\n${JSON.stringify(rec).slice(0, 600)}\n${JSON.stringify(t).slice(0, 800)}`];
  });
}
