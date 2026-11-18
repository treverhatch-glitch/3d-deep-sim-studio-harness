/**
 * qa/selftest-295a.mjs — 2.95 (a): the full rules check as shards, measured memory, systems named by files, the check
 * ahead by shard. One full run of the rules tests was one test process that grew to 18.9 GB; a studio's land run needs
 * about 21 GB free, so land runs waited for memory and the check ahead never started. Here: rules.shards runs one command
 * per shard and keeps a green per shard (exact tree, or by what it reads); without rules.shards.rest it is not a full run;
 * rules.peak reads the peak a test command writes and uses it where 4 GB was guessed; focus.auto takes names from a file
 * template and as a list; the check ahead goes shard by shard and says when it does not start.
 * Scaffolding as qa/selftest-294a.mjs (a studio copy, a made-up engine repo, stand-ins for the land script and the tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest295A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s295a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI|PEAK_|AHEAD_)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-295a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `295a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-295a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-295a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };
  const cache = () => readJson(path.join(S, '.studio', 'engine', 'unity-rules.json')) || {};

  // The engine repo: two system folders (Sim/Fees, Sim/Move), one system named by files (Game/Core/Unit.Bank.cs, its
  // .Extra file and its tool folder), a file no system owns, and a stale peak file committed where the tests write theirs.
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'Sim/Move/Move.cs': 'class Move { }\n', 'Sim/Fees/Fees.cs': 'class Fees { }\n', 'Game/Core/Unit.Bank.cs': 'class Bank { }\n', 'Game/Core/Unit.Bank.Extra.cs': 'class BankExtra { }\n', 'tools/port/core-bank/map.json': '{}\n', 'notes.txt': 'n\n', 'out/peak.txt': 'max working set 99 GB\n' })) write(R, f, t);
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
    return { R, GW, heads };
  };
  const commitOn = (E, files, msg) => { g(E.R, 'checkout', '-q', 'port/main'); for (const [f, t] of Object.entries(files)) write(E.R, f, t); g(E.R, 'add', '-A'); g(E.R, 'commit', '-qm', msg); const h = g(E.R, 'rev-parse', 'HEAD').stdout.trim(); g(E.R, 'checkout', '-q', 'dev'); return h; };

  // The land script's stand-in: records what it was told; <ctl>-wait holds a number N: it waits until the check ahead
  // has finished N rules commands; <ctl>-waitline holds text it waits for in the check ahead's lines (conditions, never a
  // fixed sleep). Then it merges the branches.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, green: process.env.STUDIO_RULES_GREEN ?? null, mode: process.env.STUDIO_RULES_MODE ?? null }) + '\\n');
if (fs.existsSync(ctl + '-wait')) {
  const want = Number(fs.readFileSync(ctl + '-wait', 'utf8'));
  const n = () => { try { return fs.readFileSync(ctl + '-rules.jsonl', 'utf8').split('\\n').filter((l) => l.includes('"ahead":true')).length; } catch { return 0; } };
  for (const until = Date.now() + 90000; Date.now() < until && n() < want; nap(100));
  fs.rmSync(ctl + '-wait', { force: true });
}
if (fs.existsSync(ctl + '-waitline')) {
  const want = fs.readFileSync(ctl + '-waitline', 'utf8');
  const seen = () => { try { return JSON.parse(fs.readFileSync(${JSON.stringify(path.join(S, '.studio', 'engine', 'unity-rules-ahead-out.json'))}, 'utf8')).lines.join('\\n').includes(want); } catch { return false; } };
  for (const until = Date.now() + 90000; Date.now() < until && !seen(); nap(100));
  fs.rmSync(ctl + '-waitline', { force: true });
}
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); process.exit(2); } }
console.log('landed ' + srcs.join(' '));
`);
  // The tests' stand-in: one filter per run (ALL for the whole command). Cat=Fees (and ALL) fail when Sim/Fees holds BAD.
  // It writes its peak to out/run/peak.txt (PEAK_<filter> or PEAK_DEFAULT GB) and records whether a peak file was there
  // before it ran. A run of the check ahead takes AHEAD_STUB_MS.
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, filter = 'ALL'] = process.argv.slice(2);
const t0 = Date.now();
const ahead = /-ahead-/.test(process.env.STUDIO_RULES_DIR || '');
const stale = fs.existsSync(path.join('out', 'peak.txt')) || fs.existsSync(path.join('out', 'run', 'peak.txt'));
if (ahead && Number(process.env.AHEAD_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.AHEAD_STUB_MS));
const bad = (filter === 'ALL' || filter === 'Cat=Fees') && fs.readFileSync(path.join('Sim', 'Fees', 'Fees.cs'), 'utf8').includes('BAD');
const peak = process.env['PEAK_' + filter.replace(/[^A-Za-z0-9]/g, '_')] || process.env.PEAK_DEFAULT;
if (peak) { fs.mkdirSync(path.join('out', 'run'), { recursive: true }); fs.writeFileSync(path.join('out', 'run', 'peak.txt'), 'max working set ' + peak + ' GB\\n'); }
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter, ahead, mode: process.env.STUDIO_RULES_MODE || null, commit: process.env.STUDIO_RULES_COMMIT || null, stale, t0, t1: Date.now() }) + '\\n');
console.log('  ' + (bad ? 'Failed' : 'Passed') + ' Game.Rules.Tests.FeesTests.Charges [3 ms]');
process.exit(bad ? 1 : 0);
`);
  const AUTOS = [{ root: 'Sim', paths: ['Sim/{name}/'], filter: 'Cat={name}' }, { from: 'Game/Core/Unit.{name}.cs', paths: ['Game/Core/Unit.{name}.', 'tools/port/core-{name}/'], filter: 'Core.{name}' }];
  const rulesOf = (ctl, { shards = { filters: ['Listed'], rest: 'Rest' }, focus = {}, ...extra } = {}) => ({
    test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`,
    focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, smoke: 'Smoke', auto: AUTOS, fullEveryHours: 0, ...focus },
    ...(shards ? { shards } : {}), peak: 'out/**/peak.txt', ...extra,
  });
  const cfgFor = (E, ctl, rules) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, batchMax: 1, rules });
  const rulesRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const landRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-runs.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const queue = queueUnityOf(S);
  const outcomes = () => evs(/^task\.train\.unity\.rules_ahead$/).map((e) => e.meta?.outcome);
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note: String(note).slice(0, 900), extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, landed: r.landed, dropped: r.dropped, handed, rules: r.rules || null, fullRules: r.fullRules || null, logs: logs.filter((l) => /rules|ahead|shard/.test(l)) }));`;
  const SHARDS = `import { rulesConfig, shardsRun } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const logs = []; let n = 0; const stopAt = Number(process.env.STOP_AT || 0);
const r = shardsRun({ engine: 'unity', repo: process.env.REPO, sha: process.env.SHA, cfg, root: process.cwd(), id: 'p295', log: (m) => logs.push(String(m)), admit: stopAt ? () => (n++ < stopAt ? true : 'a test stop') : null });
console.log(JSON.stringify({ status: r.status, mode: r.mode, stopped: Boolean(r.stopped), shards: r.shards, part: r.part || null, why: r.why, logs: logs.filter((l) => /shard|kept|reuses/.test(l)) }));`;
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const ctlOf = (n) => path.join(T, `ctl-${n}`);
  const ALL6 = ['Smoke', 'Cat=Fees', 'Cat=Move', 'Core.Bank', 'Listed', 'Rest'];
  const evRules = () => evs(/^engine\.rules$/);
  const owedProbe = `import { rulesConfig, fullRulesOwed } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ owed: fullRulesOwed(process.cwd(), 'unity', cfg).why }));`;

  // ================= (a) systems named by files, and a list of autos =================
  {
    resetState();
    const E = engineRepo({});
    setEngines({ unity: cfgFor(E, ctlOf('cfg'), rulesOf(ctlOf('cfg'))) });
    const r = probe(`import { rulesConfig, autoSystems, rulesSelection, shardList, partContext } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const repo = ${JSON.stringify(fwd(E.R))};
const sys = autoSystems({ repo, shas: ['port/main'], auto: cfg.focus.auto });
const sel = rulesSelection({ changed: ['Game/Core/Unit.Bank.Extra.cs', 'tools/port/core-bank/map.json', 'Sim/Fees/Fees.cs'], cfg: { ...cfg, focus: { ...cfg.focus, fullEveryHours: 24 } }, autoNames: sys.names });
const one = rulesConfig('unity', { root: process.cwd() });
const list = shardList(partContext({ repo, cfg, names: sys.names }), 'port/main').map((p) => p.filter);
console.log(JSON.stringify({ bad: cfg.focusBad || [], names: sys.names, mode: sel.mode, filters: sel.filters, list }));`);
    const r0 = probe(`import { autoSystems, autoConfig } from ${u('harness/engine-rules.mjs')};
const a = autoConfig({ root: 'Sim', paths: ['Sim/{name}/'], filter: 'Cat={name}' });
console.log(JSON.stringify({ isObj: !Array.isArray(a.auto), names: autoSystems({ repo: ${JSON.stringify(fwd(E.R))}, shas: ['port/main'], auto: a.auto }).names }));`);
    await guard('2.95 (a1) rules.focus.auto as a list, one taking its names from files (Game/Core/Unit.{name}.cs): the systems are Fees and Move (folders) and Bank (Unit.Bank.Extra.cs names nothing of its own); a batch changing Unit.Bank.Extra.cs, tools/port/core-bank and Sim/Fees runs in focus with Cat=Fees, Core.Bank and the smoke filter; the shards are the smoke filter, each system, the listed filter and rest (fails before this fix: auto had to be one object with a root of system folders)', () => [
      !r.bad?.length && r.names?.join() === 'Bank@1,Fees,Move' && r.mode === 'focus' && JSON.stringify(r.filters) === JSON.stringify(['Core.Bank', 'Cat=Fees', 'Smoke'])
        && r.list?.join() === ALL6.join(), J(r)]);
    await guard('2.95 (a2) the object form of rules.focus.auto is read as before: one description, plain system names (a guard of unchanged behaviour: it holds before and after this change)', () => [
      r0.isObj === true && r0.names?.join() === 'Fees,Move', J(r0)]);
  }

  // ================= (b) a full check as shards, one at a time, with rest: a full run =================
  let measured = null;
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' } });
    const ctl = ctlOf('full');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
    queue(E, [['T-201', 'feat/a']]);
    const r1 = probe(TRAIN, { PEAK_DEFAULT: '1.5', PEAK_Cat_Fees: '2.25' });
    const rr = rulesRuns(ctl);
    const land = landRuns(ctl).pop() || {};
    const ev = evRules().pop() || {};
    measured = cache().partStats || {};
    const seq = rr.every((x, i) => i === 0 || x.t0 >= rr[i - 1].t1);
    await guard('2.95 (b1) with rules.shards and rest, the full batch check runs one command per shard, one at a time (smoke, Cat=Fees, Cat=Move, Core.Bank, Listed, Rest; never the whole command), each told STUDIO_RULES_MODE=shard; all green, the land run is told STUDIO_RULES_GREEN=1 and STUDIO_RULES_MODE=full, and the engine.rules event carries the shards (fails before this fix: a full check was one test process holding every system at once)', () => [
      r1.landed?.join() === 'T-201' && rr.map((x) => x.filter).join() === ALL6.join() && seq && rr.every((x) => x.mode === 'shard') && land.green === '1' && land.mode === 'full'
        && ev.meta?.mode === 'full' && ev.meta?.shards?.n === 6 && ev.meta?.shards?.complete === true && ev.meta?.shards?.ran === 6, J({ r1, rr, land, ev: ev.meta })]);
    await guard('2.95 (b2) rules.peak: each shard\'s peak is read from the file its command wrote (out/**/peak.txt) and kept per shard (2.25 GB for Cat=Fees, 1.5 for the others); the committed stale peak file (99 GB) was removed before every command and never read (fails before this fix: memory was only guessed, 4 GB per run)', () => [
      measured['Cat=Fees']?.peakGb === 2.25 && measured['Cat=Move']?.peakGb === 1.5 && measured.Rest?.peakGb === 1.5 && rr.every((x) => !x.stale) && !Object.values(measured).some((x) => x.peakGb === 99), J({ measured, stale: rr.map((x) => x.stale) })]);
  }

  // ================= (c) kept shards: the exact tree (default), after a stop =================
  {
    resetState();
    const E = engineRepo({});
    const ctl = ctlOf('keep');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl)) });
    const sha = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    const p1 = probe(SHARDS, { REPO: E.R, SHA: sha, STOP_AT: '2' });
    const n1 = rulesRuns(ctl).length;
    const p2 = probe(SHARDS, { REPO: E.R, SHA: sha });
    const ran2 = rulesRuns(ctl).slice(n1).map((x) => x.filter);
    const p3 = probe(SHARDS, { REPO: E.R, SHA: sha });
    const sha2 = commitOn(E, { 'Sim/Fees/Fees.cs': 'class Fees { int f; }\n' }, 'fees');
    const n3 = rulesRuns(ctl).length;
    const p4 = probe(SHARDS, { REPO: E.R, SHA: sha2 });
    const ran4 = rulesRuns(ctl).slice(n3).map((x) => x.filter);
    await guard('2.95 (c1) a shard\'s green is kept for the exact tree: a run stopped after two shards (as a cancel or the check ahead stops) keeps those two; the next run on the same tree runs only the four missing; a third runs nothing; a new tree (one system changed) runs all six again by default (fails before this fix: a full run was one command and nothing of a stopped run was kept)', () => [
      p1.stopped && p1.shards?.ran === 2 && n1 === 2 && p2.status === 'pass' && p2.shards?.kept === 2 && ran2.join() === ALL6.slice(2).join() && p3.status === 'pass' && p3.shards?.kept === 6 && n3 === 6
        && p4.status === 'pass' && ran4.join() === ALL6.join() && p4.shards?.keptOther === 0, J({ p1, p2, ran2, p3, p4, ran4 })]);
  }

  // ================= (d) keep "reads" and its backstop =================
  {
    resetState();
    const E = engineRepo({});
    const ctl = ctlOf('reads');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { shards: { filters: ['Listed'], rest: 'Rest', keep: 'reads', freshEveryHours: 1 } })) });
    const s1 = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    probe(SHARDS, { REPO: E.R, SHA: s1 });
    const fresh1 = cache().shardsFreshAt;
    const s2 = commitOn(E, { 'Sim/Fees/Fees.cs': 'class Fees { int f; }\n' }, 'fees');
    const n2 = rulesRuns(ctl).length;
    const p2 = probe(SHARDS, { REPO: E.R, SHA: s2 });
    const ran2 = rulesRuns(ctl).slice(n2).map((x) => x.filter);
    const s3 = commitOn(E, { 'notes.txt': 'n2\n' }, 'notes');
    const n3 = rulesRuns(ctl).length;
    const p3 = probe(SHARDS, { REPO: E.R, SHA: s3 });
    const ran3 = rulesRuns(ctl).slice(n3).map((x) => x.filter);
    const j = cache(); j.shardsFreshAt = new Date(Date.now() - 2 * 3600000).toISOString(); write(S, '.studio/engine/unity-rules.json', JSON.stringify(j));
    const s4 = commitOn(E, { 'Sim/Move/Move.cs': 'class Move { int m; }\n' }, 'move');
    const n4 = rulesRuns(ctl).length;
    const p4 = probe(SHARDS, { REPO: E.R, SHA: s4 });
    const ran4 = rulesRuns(ctl).slice(n4).map((x) => x.filter);
    await guard('2.95 (d1) keep "reads": a tree that changes only Sim/Fees runs Cat=Fees and the shards without files of their own (smoke, Listed, Rest); Cat=Move and Core.Bank keep their greens from the other tree, and the result and the log say 2 were reused from another tree (fails before this fix: a full run was one command, nothing was kept per system)', () => [
      Boolean(fresh1) && p2.status === 'pass' && ran2.join() === 'Smoke,Cat=Fees,Listed,Rest' && p2.shards?.keptOther === 2 && p2.logs?.some((l) => /6 shard\(s\) on .*: 2 kept \(2 from another tree\), 4 to run/.test(l)), J({ p2, ran2 })]);
    await guard('2.95 (d2) keep "reads" stays sound: a change to a file no shard owns (notes.txt) runs every shard again; and once rules.shards.freshEveryHours passed, the next run reuses nothing from another tree (all six run although only Sim/Move changed) and says why (fails before this fix: there was no per-shard keep to bound)', () => [
      ran3.join() === ALL6.join() && p3.shards?.keptOther === 0 && ran4.join() === ALL6.join() && p4.shards?.fresh && p4.logs?.some((l) => /reuses no green from another tree/.test(l)) && cache().shardsFreshAt !== j.shardsFreshAt, J({ ran3, p3: p3.shards, ran4, p4 })]);
  }

  // ================= (e) no rest: not a full run =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' } });
    const ctl = ctlOf('norest');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { shards: ['Listed'], focus: { fullEveryHours: 24 } })) });
    queue(E, [['T-211', 'feat/a']]);
    const r1 = probe(TRAIN, { STUDIO_ENGINE_RULES_FULL: '1' });
    const land = landRuns(ctl).pop() || {};
    const owed1 = probe(owedProbe);
    const r2 = probe(TRAIN);
    const owed2 = probe(owedProbe);
    const show = spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 });
    const fe = evs(/^task\.train\.unity\.rules_full$/).pop() || {};
    await guard('2.95 (e) without rules.shards.rest a sharded run is not a full run: the batch (a full run asked for) runs its shards green, the land run is told STUDIO_RULES_MODE=focus (never full), the owed full run on the target alone also runs as shards, passes and stays owed (no last full pass written), and rules show says so in plain words (fails before this fix: there were no shards to count wrongly)', () => [
      r1.landed?.join() === 'T-211' && land.green === '1' && land.mode === 'focus' && r1.rules?.mode === 'shards' && /not a full run/.test(r1.rules?.why || '')
        && Boolean(owed1.owed) && r2.fullRules?.status === 'pass' && r2.fullRules?.notFull === true && fe.meta?.notFull === true && Boolean(owed2.owed) && !cache().lastFullAt
        && /no rest: a sharded run is NOT a full run/.test(out(show)), J({ r1: { l: r1.landed, rules: r1.rules }, land, owed1, owed2, fr: r2.fullRules, show: out(show).slice(-900) })]);
  }

  // ================= (f) a red shard hands back by name =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/bad': { 'Sim/Fees/Fees.cs': 'class Fees { BAD }\n' } });
    const ctl = ctlOf('red');
    const s0 = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    setEngines({ unity: { ...cfgFor(E, ctl, rulesOf(ctl)), batchMax: 2 } });
    queue(E, [['T-221', 'feat/a'], ['T-222', 'feat/bad']]);
    const r1 = probe(TRAIN);
    const rr = rulesRuns(ctl);
    // The batch's own runs (smoke, then red Cat=Fees), the target's six, then the prefix T-221: Cat=Fees alone while narrowing,
    // and after the drop the same tree's other five (its Cat=Fees green is kept).
    const later = rr.filter((x) => x.commit !== s0 && x.commit !== rr[0]?.commit);
    const d = (r1.dropped || []).find((x) => x.task === 'T-222') || {};
    const note = (r1.handed || []).find((h) => h.task === 'T-222')?.note || '';
    await guard('2.95 (f) a red shard hands back by name: the batch is red in shard Cat=Fees; the prefix is checked with that shard alone; T-222 is handed back with cause rules, the shard\'s filter and command and the failing test name; T-221 lands (fails before this fix: a full check was one command, so the red named no shard)', () => [
      r1.landed?.join() === 'T-221' && d.cause === 'rules' && /part Cat=Fees/.test(note) && /"Cat=Fees"/.test(note) && /FeesTests\.Charges/.test(note) && rr.slice(0, 2).map((x) => x.filter).join() === 'Smoke,Cat=Fees' && later[0]?.filter === 'Cat=Fees' && later.filter((x) => x.filter === 'Cat=Fees').length === 1 && later.length === 6, J({ r1: { landed: r1.landed, dropped: r1.dropped }, note, rr: rr.map((x) => x.filter) })]);
  }

  // ================= (g) the peak changes the split and the check-ahead decision =================
  {
    const r = probe(`import { splitPlan, runParts } from ${u('harness/rules-parts.mjs')};
const plan = splitPlan({}, { root: process.cwd(), engine: 'unity', peakGb: 1.5 });
const set = splitPlan({ splitGb: 6 }, { root: process.cwd(), engine: 'unity', peakGb: 1.5 });
const start = () => new Promise((res) => { setTimeout(() => res({ status: 'pass' }), 60); });
const guess = await runParts({ parts: [{ filter: 'a' }, { filter: 'b' }], start, max: 2, gb: 4, floorGb: 0, freeGb: () => 3, pollMs: 10 });
const known = await runParts({ parts: [{ filter: 'a', gb: 1.4 }, { filter: 'b', gb: 1.4 }], start, max: 2, gb: 4, floorGb: 0, freeGb: () => 3, pollMs: 10 });
console.log(JSON.stringify({ gb: plan.gb, why: plan.why, setGb: set.gb, guess: guess.atOnce, known: known.atOnce }));`);
    await guard('2.95 (g1) a measured peak replaces the guess: splitPlan takes 1.5 GB from rules.peak when rules.focus.splitGb is unset (6 GB when set), and two parts measured at 1.4 GB run together in 3 GB free where the 4 GB guess ran one at a time (fails before this fix: every part was planned at 4 GB or the land run\'s peak)', () => [
      r.gb === 1.5 && /rules\.peak/.test(r.why || '') && r.setGb === 6 && r.guess === 1 && r.known === 2, J(r)]);
    const aheadCase = async (peak) => {
      resetState();
      const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'notes.txt': 'n2\n' } });
      const ctl = ctlOf(`ahead-fit-${peak ? 'peak' : 'guess'}`);
      const rules = { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`, ahead: true, ...(peak ? { peak: 'out/**/peak.txt' } : {}) };
      setEngines({ unity: cfgFor(E, ctl, rules) });
      queue(E, [['T-231', 'feat/a'], ['T-232', 'feat/b']]);
      if (peak) fs.writeFileSync(`${ctl}-wait`, '1');
      const r1 = probe(TRAIN, { STUDIO_TEST_FREEMEM_MB: '3000', PEAK_DEFAULT: '2.5' });
      for (let i = 0; i < 150 && !outcomes().length; i++) await new Promise((res) => { setTimeout(res, 200); });
      return { r1, ev: outcomes(), full: cache().partStats?.['(full run)']?.peakGb || null };
    };
    const withPeak = await aheadCase(true);
    const guess = await aheadCase(false);
    await guard('2.95 (g2) the check ahead\'s "does one run fit" uses the measured peak: with rules.peak the full run measured 2.5 GB, so with 2.9 GB free beside the land run the check ahead starts; without rules.peak the same machine guesses 4 GB and it does not start, said by a not-started event with the reason (fails before this fix: always the 4 GB guess, and no event)', () => [
      withPeak.full === 2.5 && withPeak.ev[0] === 'started' && guess.ev.join() === 'not-started' && guess.full === null
        && evs(/^task\.train\.unity\.rules_ahead$/).some((e) => e.meta?.outcome === 'not-started' && /under the 4 GB one rules run takes/.test(e.meta?.why || '')), J({ withPeak: { ev: withPeak.ev, full: withPeak.full }, guess: { ev: guess.ev, logs: guess.r1.logs } })]);
  }

  // ================= (h) the check ahead by shard =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'Sim/Fees/Fees.cs': 'class Fees { int b; }\n' } });
    const ctl = ctlOf('ahead-shards');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-241', 'feat/a'], ['T-242', 'feat/b']]);
    fs.writeFileSync(`${ctl}-wait`, '2');
    const env = { STUDIO_TEST_FREEMEM_MB: '3000', PEAK_DEFAULT: '1', AHEAD_STUB_MS: '1500' };
    const r1 = probe(TRAIN, env);
    const n1 = rulesRuns(ctl).length;
    const r2 = probe(TRAIN, env);
    const rr = rulesRuns(ctl);
    const ahead = rr.filter((x) => x.ahead).map((x) => x.filter);
    const next = rr.slice(n1).filter((x) => !x.ahead).map((x) => x.filter);
    await guard('2.95 (h) the check ahead goes shard by shard: each shard measured at 1 GB starts in 2.9 GB free beside the land run (the 4 GB guess would not start one); it stops once the land run answered, its finished shards are kept (kept-partial), and the next train runs only the shards still missing: together they ran each of the six shards exactly once and T-242 lands told full (fails before this fix: the check ahead was one whole run that did not fit, so it never started)', () => [
      r1.landed?.join() === 'T-241' && r2.landed?.join() === 'T-242' && ahead.length >= 2 && ahead.length < 6 && next.length === 6 - ahead.length
        && [...ahead, ...next].sort().join() === [...ALL6].sort().join() && outcomes().join() === 'started,kept-partial' && landRuns(ctl).pop()?.mode === 'full'
        && r2.logs?.some((l) => /finished some shards, this train ran the rest/.test(l)), J({ ahead, next, ev: outcomes(), r2l: r2.landed, logs: r2.logs })]);
  }

  // ================= (i) not started: no shard fits =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' }, 'feat/b': { 'notes.txt': 'n2\n' } });
    const ctl = ctlOf('ahead-none');
    setEngines({ unity: cfgFor(E, ctl, rulesOf(ctl, { ahead: true })) });
    queue(E, [['T-251', 'feat/a'], ['T-252', 'feat/b']]);
    fs.writeFileSync(`${ctl}-waitline`, 'Smoke waits for memory');
    const r1 = probe(TRAIN, { STUDIO_TEST_FREEMEM_MB: '3000', PEAK_DEFAULT: '5' });
    for (let i = 0; i < 150 && !outcomes().length; i++) await new Promise((res) => { setTimeout(res, 200); });
    const e = evs(/^task\.train\.unity\.rules_ahead$/).pop() || {};
    await guard('2.95 (i) shards measured at 5 GB do not fit in 2.9 GB beside the land run: the check ahead waits, starts nothing, and once the land run answered it emits rules_ahead with outcome not-started and the memory it waited for (fails before this fix: a check ahead that did not start emitted no event)', () => [
      r1.landed?.join() === 'T-251' && outcomes().join() === 'not-started' && /waited for memory \(2\.9 GB free over the floor, 5 GB needed\)/.test(e.meta?.why || '') && !rulesRuns(ctl).some((x) => x.ahead), J({ ev: outcomes(), why: e.meta?.why })]);
  }

  // ================= (j) none of it set: 2.94's runs =================
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'Sim/Move/Move.cs': 'class Move { int a; }\n' } });
    const ctl = ctlOf('plain');
    setEngines({ unity: cfgFor(E, ctl, { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`, focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, smoke: 'Smoke', auto: AUTOS[0], fullEveryHours: 0 } }) });
    queue(E, [['T-261', 'feat/a']]);
    const r1 = probe(TRAIN, { PEAK_DEFAULT: '1' });
    const rr = rulesRuns(ctl);
    const land = landRuns(ctl).pop() || {};
    const ev = evRules().pop() || {};
    const c = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ keys: Object.keys(cfg).filter((k) => k === 'shards' || k === 'peak') }));`);
    await guard('2.95 (j) a studio with none of this set (no rules.shards, no rules.peak, focus.auto one object) runs as 2.94: the full check is the one rules.test command, told STUDIO_RULES_MODE=full; the land run is told full; the event has no shards; nothing is measured (a guard of unchanged behaviour: it holds before and after this change)', () => [
      r1.landed?.join() === 'T-261' && rr.length === 1 && rr[0].filter === 'ALL' && rr[0].mode === 'full' && land.mode === 'full' && ev.meta?.mode === 'full' && !ev.meta?.shards
        && !c.keys?.length && !Object.values(cache().partStats || {}).some((x) => x.peakGb), J({ rr, land, ev: ev.meta, c })]);
  }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
}
