/**
 * qa/selftest-283c.mjs — 2.83 (c): a cheaper rules check (harness/engine-rules.mjs) and two bugs around it.
 *
 *   env       rules.env reaches the command and is part of the kept result's key
 *   checkout  large files are not smudged; rules.paths checks out only those paths, and is the kept result's key
 *   focus     a batch runs only the tests of the systems it changes, with a full run every fullEveryHours / --full
 *   inputs    inputs merged over several folders (first folder wins per file), fingerprinted as merged; shareInputs
 *   cli       `node harness/engine-rules.mjs show` exits instead of hanging on an unsettled top-level await (B-124)
 *   check     the porter's quick check never runs in the studio repo's folder when the lane folder is gone (B-125)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283C({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const fwd = (p) => p.split(path.sep).join('/');
  const J = (x) => JSON.stringify(x);
  const T = path.join(tmpRoot, `s283c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-283c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `283c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-283c.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => J(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-283c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  const tmpLeft = () => { try { return fs.readdirSync(path.join(S, '.studio', 'tmp')).filter((n) => /^(rules|check)-/.test(n)); } catch { return []; } };

  // ---- a made-up engine repo: the target port/main lives in the land script's gate worktree ----
  let rn = 0;
  const engineRepo = (lanes, { shared = {} } = {}) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    write(R, 'base.txt', 'base\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    const tip = g(R, 'rev-parse', 'port/main').stdout.trim();
    return { R, GW, heads, tip };
  };
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, 'console.log("landed");\n');
  const cfgFor = (E, extra = {}) => ({ land: `node "${fwd(landStub)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, ...extra });
  // One stub for the rules command: logs what it saw (argument, env, files), then fails when its argument names a system
  // whose bad marker is in the checkout, or always with ALL when any marker is there.
  const stub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs';
const [log, arg = ''] = process.argv.slice(2);
const has = (p) => fs.existsSync(p);
const read = (p) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
fs.appendFileSync(log, JSON.stringify({ arg, flavor: process.env.RULES_FLAVOR ?? null, mode: process.env.STUDIO_RULES_MODE ?? null, lfs: process.env.GIT_LFS_SKIP_SMUDGE ?? null,
  rules: has('Rules/Fees/f.cs'), top: has('base.txt'), a: read('Private~/a.txt'), b: read('Private~/b.txt'), clash: read('Private~/clash.txt') }) + '\\n');
const bad = fs.existsSync('Rules') ? fs.readdirSync('Rules').filter((s) => has('Rules/' + s + '/bad.txt')) : [];
const hit = bad.find((s) => arg === 'ALL' || arg.includes(s));
if (hit) { console.log('  Failed Rules.' + hit + '.Breaks [2 ms]'); process.exit(1); }
console.log('Passed!');
`);
  const logOf = (name) => path.join(T, `${name}.jsonl`);
  const seen = (name) => { try { return fs.readFileSync(logOf(name), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const cmdOf = (name, arg) => `node "${fwd(stub)}" "${fwd(logOf(name))}" ${arg}`;

  // ================= env =================
  {
    resetState();
    const E = engineRepo({});
    const r = probe(`import { runRulesAt } from ${u('harness/engine-rules.mjs')};
const cfg = (flavor) => ({ command: ${J(cmdOf('env', 'ALL'))}, inputs: [], timeoutMin: 2, env: { RULES_FLAVOR: flavor }, paths: [], lfs: false, focus: null, share: [] });
const go = (f) => { const x = runRulesAt({ engine: 'unity', repo: ${J(fwd(E.R))}, sha: ${J(E.tip)}, cfg: cfg(f), root: process.cwd(), id: 'env' }); return { status: x.status, cached: x.cached === true }; };
console.log(JSON.stringify({ a: go('a'), again: go('a'), b: go('b') }));`);
    const s = seen('env');
    await guard('2.83 rules.env: the owner\'s variables reach the rules command (RULES_FLAVOR=a, under the harness\'s STUDIO_RULES_MODE=full), the same env again is a kept result, and a changed value is a new key that runs again (fails before this fix: rules.env was not passed to the command nor part of the key)', () => [
      r.a?.status === 'pass' && !r.a.cached && r.again?.cached === true && r.b?.status === 'pass' && !r.b.cached && s.map((x) => `${x.flavor}|${x.mode}`).join() === 'a|full,b|full',
      J({ r, s })]);
  }

  // ================= checkout: LFS and sparse paths =================
  {
    resetState();
    const E = engineRepo({ 'feat/art': { 'Art/big.txt': 'art\n' } }, { shared: { 'Rules/Fees/f.cs': 'class F {}\n' } });
    const r = probe(`import { checkoutPlan, runRulesAt } from ${u('harness/engine-rules.mjs')};
const plain = checkoutPlan({ dir: 'd', sha: 'abc', cfg: { paths: [] }, env: {} });
const sparse = checkoutPlan({ dir: 'd', sha: 'abc', cfg: { paths: ['Rules'] }, env: {} });
const lfs = checkoutPlan({ dir: 'd', sha: 'abc', cfg: { lfs: true }, env: {} });
const cfg = { command: ${J(cmdOf('sparse', 'none'))}, inputs: [], timeoutMin: 2, env: {}, paths: ['Rules'], lfs: false, focus: null, share: [] };
const x = runRulesAt({ engine: 'unity', repo: ${J(fwd(E.R))}, sha: ${J(E.tip)}, cfg, root: process.cwd(), id: 'sparse' });
console.log(JSON.stringify({ plainLfs: plain.env.GIT_LFS_SKIP_SMUDGE ?? null, plainAdd: plain.add, sparseAdd: sparse.add, patterns: sparse.patterns, lfsOn: lfs.env.GIT_LFS_SKIP_SMUDGE ?? null, status: x.status }));`);
    const s = seen('sparse');
    const conf = fs.readFileSync(path.join(E.R, '.git', 'config'), 'utf8');
    await guard('2.83 rules checkout: git checks the throwaway copy out with GIT_LFS_SKIP_SMUDGE=1 unless rules.lfs is true, and with rules.paths ["Rules"] only that folder is there (Rules/Fees/f.cs present, the top-level base.txt absent), without changing the engine repo\'s shared config (fails before this fix: no checkoutPlan, every checkout was full with large files smudged)', () => [
      r.plainLfs === '1' && r.lfsOn === null && !r.plainAdd?.includes('--no-checkout') && r.sparseAdd?.includes('--no-checkout') && r.patterns?.join() === '/Rules'
        && r.status === 'pass' && s.length === 1 && s[0].rules === true && s[0].top === false && !/worktreeConfig/.test(conf) && !tmpLeft().length,
      J({ r, s, tmp: tmpLeft() })]);
    // A batch that changes nothing under rules.paths: its key is the target's, so the target's kept result answers.
    const gate = probe(`import { rulesGate } from ${u('harness/engine-rules.mjs')};
const cfg = { command: ${J(cmdOf('unchanged', 'none'))}, inputs: [], timeoutMin: 2, env: {}, paths: ['Rules'], lfs: false, focus: null, share: [] };
const lanes = [{ task: 'T-961', branch: 'feat/art', head: ${J(E.heads['feat/art'])} }];
const chain = (tip, ls) => ({ head: ls.length ? ${J(E.heads['feat/art'])} : tip });
const r = rulesGate({ engine: 'unity', repo: ${J(fwd(E.R))}, tip: ${J(E.tip)}, lanes, chain, cfg, root: process.cwd(), id: 'unch', env: {} });
console.log(JSON.stringify({ runs: r.runs, green: r.green || null, kept: r.kept.map((l) => l.task), mode: r.mode }));`);
    await guard('2.83 rules key by paths: a batch that changes only files outside rules.paths (art) gets the target\'s kept result: one run for the target\'s calibration and none for the batch, which is green (fails before this fix: the key was the whole tree, so the batch ran again)', () => [
      gate.runs === 1 && gate.green === E.heads['feat/art'] && gate.kept?.join() === 'T-961' && seen('unchanged').length === 1,
      J({ gate, s: seen('unchanged') })]);
  }

  // ================= focus: the selection as a pure function =================
  {
    const r = probe(`import { rulesSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { command: 'full-cmd', paths: ['Rules'], focus: { test: 't --filter "{filter}"', map: [{ match: '^Rules/([^/]+)/', filter: 'Cat=$1' }], smoke: 'Cat=Smoke', join: '|', fullEveryHours: 24 } };
const sel = (changed, full = false) => { const s = rulesSelection({ changed, cfg, full }); return { mode: s.mode, filter: s.filter, command: s.command, unchanged: s.unchanged === true }; };
console.log(JSON.stringify({
  mapped: sel(['Rules/Fees/a.cs', 'Rules/Fuel/b.cs', 'Rules/Fees/c.cs', 'Art/x.png']),
  unmapped: sel(['Rules/Fees/a.cs', 'Rules/top.cs']),
  none: sel(['Art/x.png']),
  odd: sel(['Rules/a$(x)/c.cs']),
  forced: sel(['Rules/Fees/a.cs'], true),
  nofocus: rulesSelection({ changed: ['Rules/Fees/a.cs'], cfg: { command: 'full-cmd', paths: [] } }).mode,
}));`);
    await guard('2.83 focus selection (pure): every changed path under rules.paths mapped -> focus with the unique filters in order plus smoke, joined, put into focus.test; one unmapped path -> the full command; nothing under paths changed -> the full command marked unchanged (the target\'s kept result answers, no run of its own); a regex group with shell characters -> full; a forced full run or no focus -> full (fails before this fix: no rulesSelection)', () => [
      r.mapped?.mode === 'focus' && r.mapped.filter === 'Cat=Fees|Cat=Fuel|Cat=Smoke' && r.mapped.command === 't --filter "Cat=Fees|Cat=Fuel|Cat=Smoke"'
        && r.unmapped?.mode === 'full' && r.unmapped.command === 'full-cmd' && r.none?.mode === 'full' && r.none.unchanged === true
        && r.odd?.mode === 'full' && r.forced?.mode === 'full' && r.nofocus === 'full',
      J(r)]);
  }

  // ================= focus end to end, and the forced full run =================
  {
    const shared = { 'Rules/Fees/f.cs': 'class F {}\n', 'Rules/Fuel/g.cs': 'class G {}\n' };
    const E = engineRepo({ 'feat/fees': { 'Rules/Fees/f.cs': 'class F { int x; }\n' }, 'feat/fuel': { 'Rules/Fuel/g.cs': 'class G { int y; }\n', 'Rules/Fuel/bad.txt': 'x\n' } }, { shared });
    const rules = (name) => ({ test: cmdOf(name, 'ALL'), paths: ['Rules'], focus: { test: cmdOf(name, '"{filter}"'), map: [{ match: '^Rules/([A-Za-z]+)/', filter: '$1' }], smoke: 'Smoke', join: '+', fullEveryHours: 24 } });
    const stateFile = path.join(S, '.studio', 'engine', 'unity-rules.json');
    const setLastFull = (hoursAgo) => { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, J({ trees: {}, runs: [], lastFullAt: new Date(Date.now() - hoursAgo * 3600000).toISOString() })); };
    const GATE = (opts = '{}') => `import fs from 'node:fs';
import { rulesGate, rulesConfig } from ${u('harness/engine-rules.mjs')};
import { chainOnTarget } from ${u('harness/unity-train.mjs')};
const repo = ${J(fwd(E.R))};
const cfg = rulesConfig('unity', { root: process.cwd(), repo, ref: 'port/main' });
const lanes = [{ task: 'T-971', branch: 'feat/fees', head: ${J(E.heads['feat/fees'])} }, { task: 'T-972', branch: 'feat/fuel', head: ${J(E.heads['feat/fuel'])} }];
const o = ${opts};
const r = rulesGate({ engine: 'unity', repo, tip: ${J(E.tip)}, lanes, cfg, root: process.cwd(), id: 'focus', env: o.env || {}, full: o.full === true, chain: (t, ls) => chainOnTarget(repo, t, ls, 'focus', 'unity') });
const st = (() => { try { return JSON.parse(fs.readFileSync('.studio/engine/unity-rules.json', 'utf8')); } catch { return {}; } })();
console.log(JSON.stringify({ mode: r.mode, filter: r.filter, kept: r.kept.map((l) => l.task), dropped: r.dropped.map((d) => ({ task: d.lane.task, why: d.why })), runs: r.runs, lastFullAt: st.lastFullAt || null }));`;

    resetState(); setLastFull(1);
    setEngines({ unity: cfgFor(E, { rules: rules('focus') }) });
    const f = probe(GATE());
    const s = seen('focus');
    const ev = events().filter((e) => e.type === 'engine.rules').pop();
    await guard('2.83 focus end to end: a batch whose changes are all mapped runs only those systems\' tests (filter Fees+Fuel+Smoke) for the target\'s calibration and every narrowing prefix alike, the lane that breaks its system\'s test is handed back and the other kept, and the result and the engine.rules event carry mode "focus" and the filter; the command sees STUDIO_RULES_MODE=focus (fails before this fix: every run was the full command)', () => [
      f.mode === 'focus' && f.filter === 'Fees+Fuel+Smoke' && f.kept?.join() === 'T-971' && f.dropped?.[0]?.task === 'T-972' && /Rules\.Fuel\.Breaks/.test(f.dropped[0].why)
        && s.length >= 3 && s.every((x) => x.arg === 'Fees+Fuel+Smoke' && x.mode === 'focus') && ev?.meta?.mode === 'focus' && ev.meta.filter === 'Fees+Fuel+Smoke',
      J({ f, s, ev: ev?.meta })]);

    resetState(); setLastFull(30);
    setEngines({ unity: cfgFor(E, { rules: rules('due') }) });
    const due = probe(GATE());
    resetState(); setLastFull(1);
    setEngines({ unity: cfgFor(E, { rules: rules('flag') }) });
    const flag = probe(GATE('{ full: true }'));
    resetState(); setLastFull(1);
    setEngines({ unity: cfgFor(E, { rules: rules('envfull') }) });
    const envFull = probe(GATE("{ env: { STUDIO_ENGINE_RULES_FULL: '1' } }"));
    resetState(); setLastFull(1);
    setEngines({ unity: cfgFor(E, { rules: rules('cli') }) });
    const cli = spawnSync(process.execPath, ['harness/engine-rules.mjs', '--ref', 'feat/fees', '--full', '--json'], { cwd: S, env: envOf(), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    const cliRes = (() => { try { return JSON.parse(String(cli.stdout).trim().split('\n').pop()); } catch { return null; } })();
    const allFull = (name) => seen(name).length > 0 && seen(name).every((x) => x.arg === 'ALL' && x.mode === 'full');
    await guard('2.83 forced full run: with the last full pass 30 h ago (fullEveryHours 24) the batch runs the full command and the pass is recorded as the new lastFullAt; with full: true (the --full flag), STUDIO_ENGINE_RULES_FULL=1, or `engine-rules --ref <branch> --full` it is full too, and the full run still hands back the bad lane (fails before this fix: no focus, no lastFullAt, no --full)', () => [
      due.mode === 'full' && due.dropped?.[0]?.task === 'T-972' && Date.now() - Date.parse(due.lastFullAt || 0) < 3600000 && allFull('due')
        && flag.mode === 'full' && allFull('flag') && envFull.mode === 'full' && allFull('envfull') && cli.status === 0 && cliRes?.mode === 'full' && allFull('cli'),
      J({ due, flag, envFull, cli: out(cli).slice(-600), seen: { due: seen('due'), cli: seen('cli') } })]);
  }

  // ================= inputs merged over several folders; shareInputs =================
  {
    resetState();
    const E = engineRepo({});
    const F1 = path.join(T, 'from-1'); const F2 = path.join(T, 'from-2');
    write(F1, 'Private~/a.txt', 'A1\n'); write(F1, 'Private~/clash.txt', 'one\n');
    write(F2, 'Private~/b.txt', 'B2\n'); write(F2, 'Private~/clash.txt', 'two\n');
    const r = probe(`import { runRulesAt, inputsPrint } from ${u('harness/engine-rules.mjs')};
import fs from 'node:fs';
const cfg = { command: ${J(cmdOf('merge', 'none'))}, inputs: ['Private~'], timeoutMin: 2, env: {}, paths: [], lfs: false, focus: null, share: [] };
const from = [${J(fwd(F1))}]; const extraFrom = [${J(fwd(F2))}];
const x = runRulesAt({ engine: 'unity', repo: ${J(fwd(E.R))}, sha: ${J(E.tip)}, cfg, from, extraFrom, root: process.cwd(), id: 'merge' });
const p0 = inputsPrint(cfg, [...from, ...extraFrom]);
fs.writeFileSync(${J(fwd(path.join(F2, 'Private~', 'clash.txt')))}, 'two changed\\n');
const pShadow = inputsPrint(cfg, [...from, ...extraFrom]);
fs.writeFileSync(${J(fwd(path.join(F2, 'Private~', 'b.txt')))}, 'B2 changed\\n');
const pB = inputsPrint(cfg, [...from, ...extraFrom]);
console.log(JSON.stringify({ status: x.status, p0, pShadow, pB }));`);
    const s = seen('merge');
    await guard('2.83 merged inputs: an input folder is merged over every folder it is copied from (a.txt only in folder 1 and b.txt only in folder 2 both arrive; clash.txt keeps folder 1\'s), extraFrom folders come after the regular ones, and the fingerprint is of that merged view (it changes when folder 2\'s own b.txt changes, not when its shadowed clash.txt does) (fails before this fix: the whole folder came from the first folder that had it, and b.txt was missing)', () => [
      r.status === 'pass' && s.length === 1 && s[0].a === 'A1' && s[0].b === 'B2' && s[0].clash === 'one' && r.p0 && r.pShadow === r.p0 && r.pB !== r.p0,
      J({ r, s })]);
    const L = path.join(T, 'share-lane'); const TO = path.join(T, 'share-to');
    write(L, 'Blobs/ab/1.bin', 'lane\n'); write(L, 'Blobs/cd/2.bin', 'new\n'); write(T, 'evil/x.bin', 'x\n');
    write(TO, 'Blobs/ab/1.bin', 'keep\n');
    const sh = probe(`import { shareInputs } from ${u('harness/engine-rules.mjs')};
const r = shareInputs({ cfg: { share: ['Blobs', '../evil', '/abs', 'Blobs/../../evil'] }, laneDir: ${J(fwd(L))}, to: ${J(fwd(TO))} });
console.log(JSON.stringify(r));`);
    await guard('2.83 shareInputs: copies only the files missing in the target folder (Blobs/cd/2.bin), never overwrites one that is there (Blobs/ab/1.bin stays "keep"), and refuses entries with .. or an absolute path (fails before this fix: no shareInputs)', () => [
      sh.copied?.join() === 'Blobs/cd/2.bin' && sh.skipped === 1 && sh.refused?.length === 3 && fs.readFileSync(path.join(TO, 'Blobs', 'ab', '1.bin'), 'utf8') === 'keep\n'
        && fs.readFileSync(path.join(TO, 'Blobs', 'cd', '2.bin'), 'utf8') === 'new\n' && !fs.existsSync(path.join(TO, 'evil')) && !fs.existsSync(path.join(path.dirname(TO), 'evil', 'Blobs')),
      J(sh)]);
  }

  // ================= the CLI exits (B-124) =================
  {
    resetState();
    const E = engineRepo({});
    setEngines({ unity: cfgFor(E, { rules: { test: cmdOf('show', 'ALL'), env: { RULES_TOKEN_NAME: 'value-not-printed' } } }) });
    const a = spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show'], { cwd: S, env: envOf(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const b = spawnSync(process.execPath, ['harness/engine.mjs', 'rules', 'show'], { cwd: S, env: envOf(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const first = (r) => String(r.stdout || '').split('\n')[0];
    await guard('2.83 rules CLI: `node harness/engine-rules.mjs show` and `npm run engine -- rules show` exit 0 within 30 s with the usual first line, and print the env\'s names but not its values (fails before this fix: exit 13, an unsettled top-level await on the import cycle with unity-train.mjs, B-124)', () => [
      a.status === 0 && b.status === 0 && /^\[engine-rules\] unity: node /.test(first(a)) && /^\[engine-rules\] unity: node /.test(first(b)) && /RULES_TOKEN_NAME/.test(out(a)) && !/value-not-printed/.test(out(a) + out(b)),
      J({ a: { status: a.status, signal: a.signal, out: out(a).slice(-600) }, b: { status: b.status, out: out(b).slice(-300) } })]);
  }

  // ================= the porter's check with no lane folder (B-125) =================
  {
    resetState();
    const E = engineRepo({ 'feat/good': { 'good.txt': 'g\n' }, 'feat/bad': { 'rules-bad.txt': 'x\n' } });
    const qc = path.join(T, 'qc-stub.mjs');
    fs.writeFileSync(qc, `import fs from 'node:fs';
if (!fs.existsSync('base.txt')) { console.log('Project file does not exist'); process.exit(1); }
process.exit(fs.existsSync('rules-bad.txt') ? 1 : 0);
`);
    setEngines({ unity: cfgFor(E, { quickCheck: `node "${fwd(qc)}"` }) });
    const r = probe(`import { runEngineQuickCheck } from ${u('harness/engine-check.mjs')};
import { setTaskBranch } from ${u('harness/unity-gate.mjs')};
setTaskBranch('T-981', 'feat/good'); setTaskBranch('T-982', 'feat/bad');
const one = (task) => { const x = runEngineQuickCheck({ engine: 'unity', root: process.cwd(), task }); return { status: x.status, why: x.why }; };
console.log(JSON.stringify({ good: one('T-981'), bad: one('T-982'), none: one('T-983') }));`);
    await guard('2.83 porter\'s check with no lane folder: a task whose .lanes/engine/<task> is gone is checked on its recorded branch in a throwaway checkout (green for a good branch, red for a bad one, nothing left behind), and a task with no recorded branch is skipped with the missing lane named; never the studio repo\'s folder (fails before this fix: it ran in the studio repo and came out falsely red, "Project file does not exist", B-125)', () => [
      r.good?.status === 'pass' && r.bad?.status === 'red' && r.none?.status === 'skipped' && /\.lanes\/engine\/T-983/.test(r.none.why) && !tmpLeft().length,
      J({ r, tmp: tmpLeft() })]);
  }

  for (const d of [S, T]) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* best effort */ } }
}
