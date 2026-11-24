/**
 * qa/selftest-298c.mjs — 2.98 (b1): rules parts cannot collide on one build output, and a build fault is not a test
 * result. On the studio's machine three `dotnet test` parts started at once in one checkout, each built, two builds
 * wrote one dll together ("error CS2012 ... locked by 'VBCSCompiler'") and a lane was handed back for nothing. Now the
 * rules check builds once per checkout and tests with --no-build; a failing build goes to the compile search; a build
 * fault runs once more alone and, twice, ends "not judged". A stand-in for dotnet (STUDIO_DOTNET) records each call.
 * Scaffolding as qa/selftest-296b.mjs (a studio copy, a made-up engine repo, a stand-in land script).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest298C({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';

  // The dotnet stand-in: build fails on NOBUILD in a system's file; test (building first unless --no-build) runs the
  // tests a Category= or FullyQualifiedName~ filter names; "LOCKED <n>" in a file fails its first n test runs with CS2012.
  const stub = path.join(T, 'fake-dotnet.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2);
const verb = a[0];
const noBuild = a.includes('--no-build');
const rest = a.slice(1).filter((x) => x !== '--no-build');
const ctl = rest[0];
const fi = rest.indexOf('--filter');
const filter = fi > 0 ? rest[fi + 1] : 'ALL';
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const sys = ['Fees', 'Move', 'Bank'];
const src = (s) => read(path.join('Sim', s, s + '.cs'));
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ verb, noBuild, filter, commit: process.env.STUDIO_RULES_COMMIT || null }) + '\\n');
const broken = sys.find((s) => src(s).includes('NOBUILD'));
if (verb === 'build' || !noBuild) {
  if (broken) { console.log('Sim/' + broken + '/' + broken + '.cs(3,5): error CS1002: ; expected [' + process.cwd() + '/Game.csproj]'); console.log('Build FAILED.'); process.exit(1); }
  if (verb === 'build') { console.log('Build succeeded.'); process.exit(0); }
}
const tests = sys.map((s) => ({ name: 'Game.Tests.' + s + '.' + s + 'Tests.Works', sys: s }));
const sel = filter === 'ALL' ? tests : tests.filter((t) => filter.split('|').some((x) => { const m = /^\\s*(?:Category=(\\w+)|FullyQualifiedName~(.+?))\\s*$/.exec(x); return m && (m[1] ? t.sys === m[1] : t.name.includes(m[2])); }));
for (const t of sel) {
  const m = /LOCKED (\\d+)/.exec(src(t.sys));
  const cf = ctl + '-locked';
  if (m && Number(read(cf) || 0) < Number(m[1])) { fs.writeFileSync(cf, String(Number(read(cf) || 0) + 1)); console.log("CSC : error CS2012: Cannot open 'C:\\\\s\\\\obj\\\\Debug\\\\net8.0\\\\Game.dll' for writing -- 'The process cannot access the file because it is being used by another process.'"); process.exit(1); }
}
if (!sel.length) { console.log('No test matches the given testcase filter ' + filter); process.exit(0); }
let failed = 0;
for (const t of sel) { if (src(t.sys).includes('BAD')) { failed += 1; console.log('  Failed ' + t.name + ' [3 ms]'); console.log('  Error Message:'); console.log('   the total is wrong'); } else console.log('  Passed ' + t.name + ' [1 ms]'); }
process.exit(failed ? 1 : 0);
`);
  const dotnet = path.join(T, process.platform === 'win32' ? 'dotnet.cmd' : 'dotnet');
  fs.writeFileSync(dotnet, process.platform === 'win32' ? `@"${process.execPath}" "${stub}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  if (process.platform !== 'win32') fs.chmodSync(dotnet, 0o755);

  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_DOTNET: dotnet, STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  const S = path.join(tmpRoot, `298c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (p) => !/[\\/](\.git|\.lanes|node_modules)$/.test(p) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298c.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-298c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  // The engine repo: three systems under Sim; a lane changes the files it is given.
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Fees/Fees.cs': 'class Fees { }\n', 'Sim/Move/Move.cs': 'class Move { }\n', 'Sim/Bank/Bank.cs': 'class Bank { }\n', 'notes.txt': 'n\n' })) write(R, f, t);
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
    return { R, GW, heads, tip: g(R, 'rev-parse', 'port/main').stdout.trim() };
  };
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs }) + '\\n');
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) process.exit(2); }
console.log('landed ' + srcs.join(' '));
`);
  const rulesOf = (ctl, extra = {}) => ({
    test: `dotnet test "${fwd(ctl)}"`,
    focus: { test: `dotnet test "${fwd(ctl)}" --filter "{filter}"`, map: [{ match: '^Sim/(\\w+)/', filter: 'Category=$1' }], split: true, splitMax: 3, fullEveryHours: 24 },
    ...extra,
  });
  const cfgFor = (E, ctl, rules) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 3, rules });
  const calls = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const ctlOf = (n) => path.join(T, `ctl-${n}`);
  const queue = queueUnityOf(S);
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const GATE = `import { rulesConfig, rulesGate } from ${u('harness/engine-rules.mjs')};
import { chainOnTarget } from ${u('harness/unity-train.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const repo = process.env.REPO; const logs = [];
const lanes = JSON.parse(process.env.LANES);
const r = rulesGate({ engine: 'unity', repo, tip: process.env.TIP, lanes, cfg, from: [repo], root: process.cwd(), id: 'g', owe: true, log: (m) => logs.push(String(m)), chain: (t, ls) => chainOnTarget(repo, t, ls, 'g298', 'unity') });
console.log(JSON.stringify({ kept: r.kept.map((l) => l.task), dropped: r.dropped.map((d) => ({ task: d.lane.task, compile: Boolean(d.compile), why: d.why })), green: r.green || null, notJudged: r.notJudged || null, why: r.why, logs: logs.filter((l) => /build|again|alone|not judged/.test(l)) }));`;
  const gate = (E, ls) => probe(GATE, { REPO: E.R, TIP: E.tip, LANES: JSON.stringify(ls.map((b) => ({ task: b.replace(/^feat\//, ''), branch: b, head: E.heads[b] }))) });
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note) => handed.push({ task: lane.task, note: String(note).slice(0, 900) }) } });
console.log(JSON.stringify({ landed: r.landed, dropped: r.dropped, deferred: r.deferred, handed, rules: r.rules || null }));`;
  const THREE = { 'feat/a': { 'Sim/Fees/Fees.cs': 'class Fees { int a; }\n' }, 'feat/b': { 'Sim/Move/Move.cs': 'class Move { int b; }\n' }, 'feat/c': { 'Sim/Bank/Bank.cs': 'class Bank { int c; }\n' } };

  try {
    // ================= (c1) three parts at once: one build, then three tests with --no-build =================
    {
      resetState();
      const E = engineRepo(THREE);
      const ctl = ctlOf('c1');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const c = calls(ctl);
      const builds = c.filter((x) => x.verb === 'build');
      const tests = c.filter((x) => x.verb === 'test');
      await guard('2.98 (c1) a split of three parts with splitMax 3 in one checkout runs `dotnet build` once, then the three parts as `dotnet test --no-build`, all on one commit, and is green (fails before this fix: three `dotnet test` runs, each building into the same output)', () => [
        Boolean(r.green) && builds.length === 1 && tests.length === 3 && tests.every((x) => x.noBuild && x.commit === builds[0].commit)
          && tests.map((x) => x.filter).sort().join() === 'Category=Bank,Category=Fees,Category=Move' && r.logs?.some((l) => /the build, once for this checkout \(rules\.build\)/.test(l)), J({ r, c })]);
    }

    // ================= (c2) a failing build is a compile red, handed back by the compile search =================
    {
      resetState();
      const E = engineRepo({ ...THREE, 'feat/b': { 'Sim/Move/Move.cs': 'class Move { NOBUILD }\n' } });
      const ctl = ctlOf('c2');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      queue(E, [['T-1', 'feat/a'], ['T-2', 'feat/b'], ['T-3', 'feat/c']]);
      const r = probe(TRAIN);
      const c = calls(ctl);
      // The owed full run on the target alone (ALL) runs after the batch's check; the batch's own tests are the parts.
      const tests = c.filter((x) => x.verb === 'test' && x.filter !== 'ALL');
      const d = (r.dropped || []).find((x) => x.task === 'T-2') || {};
      await guard('2.98 (c2) feat/b does not build: the batch build is red, builds alone find feat/b, it is handed back as cause compile with the compiler line, the tests run once on the batch without it (its three parts, no test narrowing), and T-1 and T-3 land (fails before this fix: each test run built, the red was narrowed by tests and handed back as a rules red)', () => [
        r.landed?.join() === 'T-1,T-3' && (r.dropped || []).length === 1 && d.cause === 'compile' && /does not compile/.test(d.why) && /error CS1002/.test(d.why) && /engines\.unity\.rules\.build/.test(d.why)
          && tests.length === 3 && tests.every((x) => x.noBuild) && new Set(tests.map((x) => x.commit)).size === 1 && c.filter((x) => x.verb === 'build').length >= 3, J({ landed: r.landed, dropped: (r.dropped || []).map((x) => ({ ...x, why: String(x.why).slice(-400) })), handed: (r.handed || []).length, c: c.map((x) => `${x.verb}${x.noBuild ? '-nb' : ''} ${x.filter} ${String(x.commit).slice(0, 7)}`), raw: r._raw })]);
    }

    // ================= (c3) a build fault once: run again alone, green =================
    {
      resetState();
      const E = engineRepo({ ...THREE, 'feat/a': { 'Sim/Fees/Fees.cs': 'class Fees { } // LOCKED 1\n' } });
      const ctl = ctlOf('c3');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const fees = calls(ctl).filter((x) => x.verb === 'test' && x.filter === 'Category=Fees');
      await guard('2.98 (c3) the Fees part prints "error CS2012 ... being used by another process" once: it runs once more, alone, and the check is green with no lane dropped (fails before this fix: red, and a lane was handed back for a locked file)', () => [
        Boolean(r.green) && !r.dropped?.length && r.kept?.join() === 'a,b,c' && fees.length === 2 && r.logs?.some((l) => /met a build fault, not a test result \(CSC : error CS2012.*\): it runs once more, alone/.test(l)), J({ r, fees })]);
    }

    // ================= (c4) the same twice: not judged, the batch stays queued =================
    {
      resetState();
      const E = engineRepo({ ...THREE, 'feat/a': { 'Sim/Fees/Fees.cs': 'class Fees { } // LOCKED 2\n' } });
      const ctl = ctlOf('c4');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      queue(E, [['T-1', 'feat/a'], ['T-2', 'feat/b'], ['T-3', 'feat/c']]);
      const r = probe(TRAIN);
      const q = readJson(path.join(S, '.studio', 'train', 'unity-queue.json')) || [];
      let land = []; try { land = fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean); } catch { /* no land run */ }
      const ev = (() => { try { return fs.readFileSync(evFile, 'utf8'); } catch { return ''; } })();
      await guard('2.98 (c4) the Fees part meets the build fault twice: the check ends "not judged: <the line>", nobody is handed back, no land run, every lane is deferred and stays queued, and the train writes rules_not_judged (fails before this fix: a red, narrowed, a lane handed back)', () => [
        !(r.handed || []).length && !(r.dropped || []).length && !(r.landed || []).length && !land.length && /CS2012/.test(r.rules?.notJudged || '')
          && (r.deferred || []).map((x) => x.task).join() === 'T-1,T-2,T-3' && /not judged: CSC : error CS2012/.test(r.deferred[0].why) && q.map((x) => x.task).join() === 'T-1,T-2,T-3'
          && /task\.train\.unity\.rules_not_judged/.test(ev), J({ r, q, land })]);
    }

    // ================= (c5) rules.build false, and a test command that is not dotnet =================
    {
      resetState();
      const E = engineRepo(THREE);
      const ctl = ctlOf('c5');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { build: false })) });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const c = calls(ctl);
      setEngines({ unity: cfgFor(E, ctl, { test: 'node run-tests.mjs', focus: { test: 'node run-tests.mjs "{filter}"', map: [] } }) });
      const other = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const c = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ build: c.build, infra: c.infra }));`);
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { test: 'dotnet test "x" --filter "A" --logger trx -c Release -- NUnit.N=1', infra: ['MSB4018'] })) });
      const dn = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const c = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ build: c.build, infra: c.infra }));`);
      await guard('2.98 (c5) with rules.build false the three parts run `dotnet test` as before (no build, no --no-build); a node test command gets no build and no infra patterns; a dotnet one gets the default build (test-only options dropped) and its infra patterns plus rules.infra (a guard of unchanged behaviour where it is off)', () => [
        Boolean(r.green) && c.length === 3 && c.every((x) => x.verb === 'test' && !x.noBuild) && other.build === null && Array.isArray(other.infra) && other.infra.length === 0
          && /dotnet(?:\.cmd)? build "x" -c Release$/.test(dn.build?.command || '') && dn.infra?.includes('error CS2012') && dn.infra?.includes('MSB4018'), J({ r, c, other, dn })]);
    }

    // ================= (c6) a by-name run after a red uses --no-build in a built checkout =================
    {
      resetState();
      const E = engineRepo({ ...THREE, 'feat/b': { 'Sim/Move/Move.cs': 'class Move { BAD }\n' } });
      const ctl = ctlOf('c6');
      setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const c = calls(ctl);
      const named = c.filter((x) => x.verb === 'test' && /FullyQualifiedName~/.test(x.filter));
      const builtAt = new Set(c.filter((x) => x.verb === 'build').map((x) => x.commit));
      await guard('2.98 (c6) feat/b breaks a Move test: the red is narrowed by the failing test by name, every by-name run is `dotnet test --no-build` in a checkout built for its commit, and feat/b is handed back (fails before this fix: each by-name run built again)', () => [
        r.dropped?.map((x) => x.task).join() === 'b' && !r.dropped[0].compile && named.length >= 1 && named.every((x) => x.noBuild && builtAt.has(x.commit))
          && c.filter((x) => x.verb === 'test').every((x) => x.noBuild), J({ r, c })]);
    }
  } finally {
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
  }
}
