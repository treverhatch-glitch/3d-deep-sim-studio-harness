/**
 * qa/selftest-278c.mjs — 2.78.0 (PU-54): held-out checks that builders cannot read, run at the merge train only.
 *   (a) the path guard hook denies a builder's (or lane session's) Read and `cat` of a holdout case, allows a reviewer;
 *   (b) a planted "special-case the visible check" change passes the visible check and fails the holdout case, and the
 *       failure output names the case id and note, never the expected value or the command;
 *   (c) a lane's verify skips the gate ("runs at the train only"); a train-mode run (STUDIO_GATE_PRIORITY=landing) runs it;
 *   (d) no cases: it passes ("no held-out cases").
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest278C({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GITHUB_BASE_REF: '',
    STUDIO_GATE_PRIORITY: '', STUDIO_HOLDOUT_DIR: '', STUDIO_GUARD_PATHS: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-278c-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `278c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, env: { ...base } };
  };
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const holdDir = (name) => { const d = path.join(tmpRoot, `278c-hold-${name}-${process.pid}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };
  const hook = (S, input, env) => spawnSync(process.execPath, [path.join(S, '.claude', 'hooks', 'guard-paths.mjs')], { windowsHide: true, cwd: S, input: JSON.stringify(input), encoding: 'utf8', env: { ...base, CLAUDE_PROJECT_DIR: S, ...env } });
  // The planted cartridge: prints the right value only for the visible seed (1); the honest one computes it.
  const CHEAT = 'const seed = Number(process.argv[2]); console.log(seed === 1 ? 42 : 0);\n';
  const HONEST = 'const seed = Number(process.argv[2]); console.log(seed * 42);\n';

  await guard('2.78.0 (PU-54): the path guard denies a builder\'s (and a lane session\'s) Read and cat of a holdout case, and allows a reviewer (fails on 2.77.1: the hook has no holdout rule)', async () => {
    const { S } = studio('a');
    const H = holdDir('a');
    fs.writeFileSync(path.join(H, 'case-1.json'), JSON.stringify({ id: 'case-1', command: 'node x.mjs', expect: { exit: 0 }, note: 'n' }));
    const f = path.join(H, 'case-1.json');
    const denied = (r) => /"deny"/.test(r.stdout);
    const b = { STUDIO_ROLE: 'builder', STUDIO_HOLDOUT_DIR: H };
    const rd = hook(S, { tool_name: 'Read', tool_input: { file_path: f } }, b);
    const cat = hook(S, { tool_name: 'Bash', tool_input: { command: `cat ${f}` } }, b);
    const grep = hook(S, { tool_name: 'Grep', tool_input: { pattern: 'command', path: H } }, b);
    const glob = hook(S, { tool_name: 'Glob', tool_input: { pattern: `${H}/*.json` } }, b);
    const lane = hook(S, { tool_name: 'Read', tool_input: { file_path: f } }, { STUDIO_HOLDOUT_DIR: H, CLAUDE_PROJECT_DIR: path.join(S, '.lanes', 'claude-a') });
    const rev = hook(S, { tool_name: 'Read', tool_input: { file_path: f } }, { STUDIO_ROLE: 'reviewer', STUDIO_HOLDOUT_DIR: H });
    const revCat = hook(S, { tool_name: 'Bash', tool_input: { command: `cat ${f}` } }, { STUDIO_ROLE: 'reviewer', STUDIO_HOLDOUT_DIR: H });
    const prod = hook(S, { tool_name: 'Read', tool_input: { file_path: f } }, { STUDIO_ROLE: 'producer', STUDIO_HOLDOUT_DIR: H });
    const other = hook(S, { tool_name: 'Read', tool_input: { file_path: path.join(S, 'package.json') } }, b);
    const nodeMod = hook(S, { tool_name: 'Read', tool_input: { file_path: `${S}/node_modules/x/index.js` } }, b);
    const ok = denied(rd) && denied(cat) && denied(grep) && denied(glob) && denied(lane) && !denied(rev) && !denied(revCat) && !denied(prod) && !denied(other) && denied(nodeMod);
    return [ok, JSON.stringify({ rd: rd.stdout, cat: cat.stdout, grep: grep.stdout, glob: glob.stdout, lane: lane.stdout, rev: rev.stdout, revCat: revCat.stdout, prod: prod.stdout, other: other.stdout, nodeMod: nodeMod.stdout, err: rd.stderr })];
  });

  await guard('2.78.0 (PU-54): a planted change that prints the expected value only for the visible seed passes the visible check and fails the holdout case, and the failure names the case id and note, not the command or the expected value (fails on 2.77.1: no harness/holdout.mjs)', async () => {
    const H = holdDir('b');
    const { S, env } = studio('b', (S0) => {
      writeIn(S0, 'tools278/cheat.mjs', CHEAT);
      writeIn(S0, 'tools278/visible.mjs', `import { execFileSync } from 'node:child_process';
const v = execFileSync(process.execPath, [new URL('./cheat.mjs', import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'), '1'], { encoding: 'utf8' }).trim();
if (v !== '42') { console.log('visible FAIL'); process.exit(1); }
console.log('visible PASS');
`);
    });
    const addR = run(S, `node harness/holdout.mjs add seed-7-total --command "node tools278/cheat.mjs 7" --expect-exit 0 --expect-stdout-of-current --note "totals must not depend on the golden seed"`, { ...env, STUDIO_HOLDOUT_DIR: H });
    // The case must expect the honest value (294), not what the cheat prints now: write it as the owner would from the honest build.
    const file = path.join(H, 'seed-7-total.json');
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.expect = { exit: 0, stdoutSha256: sha('294\n') };
    fs.writeFileSync(file, JSON.stringify(c));
    const vis = run(S, 'node tools278/visible.mjs', env);
    const bad = run(S, 'node harness/holdout.mjs run', { ...env, STUDIO_HOLDOUT_DIR: H, STUDIO_GATE_PRIORITY: 'landing' });
    writeIn(S, 'tools278/cheat.mjs', HONEST);
    const good = run(S, 'node harness/holdout.mjs run', { ...env, STUDIO_HOLDOUT_DIR: H, STUDIO_GATE_PRIORITY: 'landing' });
    const ls = run(S, 'node harness/holdout.mjs list', { ...env, STUDIO_HOLDOUT_DIR: H });
    const o = out(bad);
    const ok = addR.status === 0 && vis.status === 0 && /visible PASS/.test(out(vis))
      && bad.status !== 0 && /seed-7-total/.test(o) && /totals must not depend on the golden seed/.test(o)
      && !o.includes('294') && !o.includes(sha('294\n')) && !/cheat\.mjs|tools278/.test(o)
      && good.status === 0 && /PASS/.test(out(good))
      && /seed-7-total\ttotals must not depend/.test(out(ls)) && !/cheat\.mjs|sha256/i.test(out(ls));
    return [ok, JSON.stringify({ add: out(addR), vis: out(vis), bad: o, badStatus: bad.status, good: out(good), ls: out(ls) })];
  });

  await guard('2.78.0 (PU-54): in a lane\'s verify the holdout gate is skipped ("runs at the train only") and never fails; in a train-mode run (STUDIO_GATE_PRIORITY=landing) it runs and a failing case fails the gate naming only id and note; gates.json lists it as required (fails on 2.77.1: no holdout gate)', async () => {
    const H = holdDir('c');
    const { S, env } = studio('c');
    fs.writeFileSync(path.join(H, 'always-red.json'), JSON.stringify({ id: 'always-red', command: 'node -e "process.exit(3)"', expect: { exit: 0 }, note: 'hidden behaviour X' }));
    const gj = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'gates.json'), 'utf8'));
    const row = (gj.gates || []).find((g) => g.id === 'holdout');
    const laneEnv = { ...env, STUDIO_HOLDOUT_DIR: H, STUDIO_MAIN_ROOT: path.join(tmpRoot, 'not-this-checkout') };
    const lane = run(S, 'node scripts/run-gates.mjs --no-detach --only holdout', laneEnv);
    const train = run(S, 'node scripts/run-gates.mjs --no-detach --only holdout', { ...env, STUDIO_HOLDOUT_DIR: H, STUDIO_GATE_PRIORITY: 'landing' });
    const lo = out(lane);
    const to = out(train);
    const ok = Boolean(row) && row.required === true && lane.status === 0 && /train only/.test(lo) && /PASS holdout/.test(lo) && !/always-red/.test(lo)
      && train.status !== 0 && /FAIL holdout/.test(to) && /always-red: hidden behaviour X/.test(to) && !/process\.exit\(3\)/.test(to);
    return [ok, JSON.stringify({ row, laneStatus: lane.status, lane: lo.slice(-1200), trainStatus: train.status, train: to.slice(-1500) })];
  });

  await guard('2.78.0 (PU-54): with no holdout folder, or a folder with no cases, the gate passes ("no held-out cases") at the train (fails on 2.77.1: no harness/holdout.mjs)', async () => {
    const { S, env } = studio('d');
    const empty = holdDir('d');
    const missing = path.join(tmpRoot, `278c-nonexistent-${process.pid}`);
    const e1 = run(S, 'node harness/holdout.mjs run', { ...env, STUDIO_HOLDOUT_DIR: empty, STUDIO_GATE_PRIORITY: 'landing' });
    const e2 = run(S, 'node harness/holdout.mjs run', { ...env, STUDIO_HOLDOUT_DIR: missing, STUDIO_GATE_PRIORITY: 'landing' });
    const e3 = run(S, 'node scripts/run-gates.mjs --no-detach --only holdout', { ...env, STUDIO_HOLDOUT_DIR: missing, STUDIO_GATE_PRIORITY: 'landing' });
    const ok = [e1, e2, e3].every((r) => r.status === 0 && /no held-out cases/.test(out(r)));
    return [ok, JSON.stringify({ e1: out(e1), e2: out(e2), e3: out(e3).slice(-800) })];
  });
}
