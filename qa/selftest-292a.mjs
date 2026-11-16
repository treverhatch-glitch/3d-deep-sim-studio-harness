/**
 * qa/selftest-292a.mjs — 2.92 (a): the engine train's checks move to the queue door, and a red land run on a compiler
 * error names its branch. engines.<x>.preQueue runs on the branch merged with the target (a conflict refuses, nothing
 * runs) and again at the train when the target moved; the compile search runs at `task done --train` (red alone:
 * refused; red only with a branch queued ahead: queued, marked, and left out of a batch with that branch); a red land run
 * whose compiler lines (its output, or the engine's own log, engines.<x>.logs) name files only some branches change hands
 * those branches back at once. The scaffolding (a studio copy, a made-up engine repo, stand-ins for the land script and
 * the compile command) is qa/selftest-290b.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, queueUnityOf, readRunsJsonl as runsOf, writeIn as write } from './kit.mjs';

export async function selftest292A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = gEnvOf(ident);
  const g = gitUserCrlfOf(gEnv);
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s292a-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_UNITY_TRAIN_RETRIES: '0', STUDIO_UNITY_TRAIN_RETRY_MIN: '0', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_ENGINE_KILLED_RETRY_SEC: '0', STUDIO_UNITY_EDITMODE_PLAN: 'off', STUDIO_ENGINE_FULL_LAND_HOURS: 'off', STUDIO_USAGE_FUNCTIONS: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-292a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git, events file, engine settings) ----
  const S = path.join(tmpRoot, `292a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-292a.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-292a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true }); fs.writeFileSync(evFile, ''); };
  const queueFile = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'unity-queue.json'), 'utf8')); } catch { return []; } };
  const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

  // ---- a made-up engine repo: one shared class, a pin file and the vectors recorded at it ----
  const STATE = (one, two) => `namespace Game.Sim {\nclass State {\n  int a;\n  // one\n${one}  // 1\n  // 2\n  // 3\n  // 4\n  // two\n${two}}\n}\n`;
  const shared = { 'Sim/State.cs': STATE('', ''), 'Sim/Helpers.cs': 'namespace Game.Helpers { class H { } }\n', 'Sim/Uses.cs': 'using Game.Helpers;\nnamespace Game.Sim { class U { } }\n', 'pins/web.json': '{ "commit": "c0ffee1" }\n', 'vectors/pin.txt': 'c0ffee1\n' };
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    const GW = path.join(T, `gate-${rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries(shared)) write(R, f, t);
    write(R, '.gitignore', 'obj/\nbin/\nLogs/\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    g(R, 'worktree', 'add', '-q', GW, 'port/main');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) { if (t === null) g(R, 'rm', '-q', f); else write(R, f, t); }
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    return { R, GW, heads };
  };
  // The target moves (another branch landed): one commit on port/main in the gate worktree.
  const moveTarget = (E, files) => { for (const [f, t] of Object.entries(files)) write(E.GW, f, t); g(E.GW, 'add', '-A'); g(E.GW, 'commit', '-qm', 'another branch landed'); return g(E.GW, 'rev-parse', 'HEAD').stdout.trim(); };

  // The compile command's stand-in (dotnet build): a field declared twice in one class is error CS0102; a `using` of a namespace no
  // file declares is error CS0234; absolute paths, or a Windows compiler's backslash paths with STUB_WIN=1.
  const compileStub = path.join(T, 'compile-stub.mjs');
  fs.writeFileSync(compileStub, `import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd();
if (process.env.STUB_COMPILE_LOG) fs.appendFileSync(process.env.STUB_COMPILE_LOG, JSON.stringify({ cwd }) + '\\n');
if (Number(process.env.COMPILE_STUB_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.COMPILE_STUB_MS));
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['obj', 'bin', '.git', 'Logs'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.cs')) files.push(p); } };
walk(cwd);
const ns = new Set();
for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/namespace\\s+([\\w.]+)/g)) ns.add(m[1]);
const at = (f) => (process.env.STUB_WIN === '1' ? 'C:\\\\ws\\\\gate\\\\' + path.relative(cwd, f).split(path.sep).join('\\\\') : f);
const errs = [];
for (const f of files.sort()) {
  let cls = ''; const seen = new Set();
  fs.readFileSync(f, 'utf8').split('\\n').forEach((l, i) => {
    const c = /class\\s+(\\w+)/.exec(l); if (c) { cls = c[1]; seen.clear(); }
    const m = /^\\s*int\\s+(\\w+);/.exec(l);
    if (m) { if (seen.has(m[1])) errs.push(at(f) + '(' + (i + 1) + ',7): error CS0102: The type \\'' + cls + '\\' already contains a definition for \\'' + m[1] + '\\''); seen.add(m[1]); }
    const us = /^using\\s+([\\w.]+);/.exec(l);
    if (us && !ns.has(us[1])) errs.push(at(f) + '(' + (i + 1) + ',7): error CS0234: The type or namespace name \\'' + us[1].split('.').pop() + '\\' does not exist in the namespace \\'' + us[1].split('.').slice(0, -1).join('.') + '\\'');
  });
}
if (errs.length) { for (const e of errs) console.log(e); console.log('Build FAILED.'); console.log('    ' + errs.length + ' Error(s)'); process.exit(1); }
console.log('Build succeeded.');
`);
  // The land script's stand-in: merges the branches into the gate worktree and compiles. LAND_LOG_ONLY=1: the compiler's lines
  // go only to the editor's own log (Logs/Editor.log), as an editor compile inside the land run does. Each run is recorded.
  const landStub = path.join(T, 'land-stub.mjs');
  fs.writeFileSync(landStub, `import fs from 'node:fs'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [gw, ctl, ...srcs] = process.argv.slice(2);
const E = process.env;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8', windowsHide: true });
const before = git(gw, 'rev-parse', 'HEAD').stdout.trim();
process.on('exit', () => fs.appendFileSync(ctl + '-runs.jsonl', JSON.stringify({ srcs, probe: E.STUDIO_LAND_PROBE ?? null }) + '\\n'));
for (const s of srcs) { const m = git(gw, 'merge', '--no-ff', '-m', 'land ' + s, 'refs/heads/' + s); if (m.status !== 0) { git(gw, 'merge', '--abort'); git(gw, 'reset', '-q', '--hard', before); console.log('conflict ' + s); process.exit(2); } }
const c = spawnSync(process.execPath, [${JSON.stringify(compileStub)}], { cwd: gw, encoding: 'utf8', env: { ...E, STUB_COMPILE_LOG: '' } });
if (c.status !== 0) {
  git(gw, 'reset', '-q', '--hard', before);
  if (E.LAND_LOG_ONLY === '1') { fs.mkdirSync(path.join(gw, 'Logs'), { recursive: true }); fs.writeFileSync(path.join(gw, 'Logs', 'Editor.log'), 'editor start\\n' + c.stdout); console.log('the editor stage failed: its log has the lines'); }
  else console.log(c.stdout);
  process.exit(1);
}
if (E.STUDIO_LAND_PROBE === '1') { git(gw, 'reset', '-q', '--hard', before); process.exit(0); }
console.log('landed ' + srcs.join(' '));
`);
  // The pin check's stand-in (preQueue): every vectors/*.txt must be recorded at the pinned commit.
  const pqLog = path.join(T, 'prequeue-log.jsonl');
  const pinCheck = path.join(T, 'pin-check.mjs');
  fs.writeFileSync(pinCheck, `import fs from 'node:fs'; import path from 'node:path';
const cwd = process.cwd();
fs.appendFileSync(${JSON.stringify(pqLog)}, JSON.stringify({ lane: process.env.STUDIO_LANE_COMMIT || null, target: process.env.STUDIO_TARGET_COMMIT || null, files: fs.readdirSync(path.join(cwd, 'vectors')).sort() }) + '\\n');
const pin = JSON.parse(fs.readFileSync(path.join(cwd, 'pins/web.json'), 'utf8')).commit;
for (const f of fs.readdirSync(path.join(cwd, 'vectors')).sort()) { const rec = fs.readFileSync(path.join(cwd, 'vectors', f), 'utf8').trim(); if (rec !== pin) { console.log('vectors/' + f + ' recorded at ' + rec + ', the pin is ' + pin); process.exit(1); } }
console.log('vectors match the pin');
`);
  const cfgFor = (E, ctl, extra = {}) => ({ land: `node "${fwd(landStub)}" "${fwd(E.GW)}" "${fwd(ctl)}" {branch}`, target: 'port/main', cwd: fwd(E.R), gateWorktree: fwd(E.GW), timeoutMin: 5, rules: false, ...extra });
  const QUICK = `node "${fwd(compileStub)}"`;
  const PQ = [{ touches: 'pins/*.json', run: `node "${fwd(pinCheck)}"`, say: 'Re-record the vectors at the new pin in this branch.' }];
  const queue = queueUnityOf(S);
  const Q = (task, branch) => `import { queueUnityTask } from ${u('harness/unity-train.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: ${JSON.stringify(task)}, branch: ${JSON.stringify(branch)}, agent: 'porter-a' });
console.log(JSON.stringify({ ok: r.ok, error: r.error || null, message: r.message }));`;
  const TRAIN = `import { runUnityTrain } from ${u('harness/unity-train.mjs')};
const handed = []; const logs = [];
const r = await runUnityTrain({ root: process.cwd(), log: (m) => logs.push(String(m)), deps: { handBack: (lane, note, extra) => handed.push({ task: lane.task, note, extra: extra || null }) } });
console.log(JSON.stringify({ ok: r.ok, runs: r.runs, landed: r.landed, dropped: r.dropped, deferred: r.deferred, handed, compile: r.compile || null, logs: logs.filter((l) => /compile search|blame plan|pre-queue/.test(l)) }));`;
  const PIN3 = { 'pins/web.json': '{ "commit": "beef003" }\n', 'vectors/pin.txt': 'beef003\n' };
  const ONE = '  int X;\n';

  // ================= A. preQueue on the branch as it would land =================
  {
    resetState();
    const E = engineRepo({ 'feat/pinok': PIN3, 'feat/pinclash': { 'pins/web.json': '{ "commit": "beef004" }\n', 'vectors/pin.txt': 'beef004\n' } });
    setEngines({ unity: cfgFor(E, path.join(T, 'ctl-a1'), { preQueue: PQ }) });
    fs.rmSync(pqLog, { force: true });
    const tip = moveTarget(E, { 'vectors/extra.txt': 'c0ffee1\n' });
    const r = probe(Q('T-001', 'feat/pinok'));
    const calls = jsonl(pqLog);
    await guard('2.92 (a) A: a branch moves the pin and re-records its vectors (it passes the check by itself), but the target gained another vectors file since: the preQueue check runs on the branch merged with the target, fails, and the branch is not queued, with the check\'s own line and the studio\'s; STUDIO_LANE_COMMIT is the branch head and STUDIO_TARGET_COMMIT the target tip (fails before this fix: the check ran on the branch alone, passed, and the train found it red hours later)', () => [
      r.ok === false && r.error === 'pre-queue' && /vectors\/extra\.txt recorded at c0ffee1/.test(r.message) && /Re-record the vectors at the new pin in this branch, then task done T-001 --train again/.test(r.message)
        && calls.length === 1 && calls[0].lane === E.heads['feat/pinok'] && calls[0].target === tip && calls[0].files.join() === 'extra.txt,pin.txt' && !queueFile().some((e) => e.task === 'T-001'),
      JSON.stringify({ r, calls }).slice(0, 2500)]);
    moveTarget(E, { 'pins/web.json': '{ "commit": "beef005" }\n' });
    const c = probe(Q('T-002', 'feat/pinclash'));
    await guard('2.92 (a) A: a branch whose merge with the target conflicts (both changed pins/web.json) is refused before the check runs, in the train\'s words for a lane that conflicts with the target, naming the file and the merge command (fails before this fix: the check ran on the branch alone and it was queued)', () => [
      c.ok === false && c.error === 'pre-queue' && /it conflicts with the target in pins\/web\.json: bring the target into it with npm run engine -- merge T-002/.test(c.message) && jsonl(pqLog).length === 1,
      JSON.stringify(c).slice(0, 2000)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/pinok': PIN3, 'feat/q': { 'q.txt': 'q\n' } });
    const ctl = path.join(T, 'ctl-a2');
    setEngines({ unity: cfgFor(E, ctl, { preQueue: PQ }) });
    fs.rmSync(pqLog, { force: true });
    const q1 = probe(Q('T-003', 'feat/pinok'));
    const n1 = jsonl(pqLog).length;
    const entry = queueFile().find((e) => e.task === 'T-003');
    const tip0 = g(E.R, 'rev-parse', 'port/main').stdout.trim();
    const r1 = probe(TRAIN);
    await guard('2.92 (a) A: the check passed at queueing on the target tip the train starts on: the queue entry keeps that tip, and the train does not run the check again; the branch lands (fails before this fix: no tip was kept)', () => [
      q1.ok === true && n1 === 1 && entry?.preQueue?.target === tip0 && jsonl(pqLog).length === 1 && r1.landed?.join() === 'T-003',
      JSON.stringify({ q1, entry, r1, n: jsonl(pqLog).length }).slice(0, 2500)]);
    const E2 = engineRepo({ 'feat/pinok': PIN3, 'feat/q': { 'q.txt': 'q\n' } });
    setEngines({ unity: cfgFor(E2, ctl, { preQueue: PQ }) });
    resetState();
    fs.rmSync(pqLog, { force: true });
    const q2 = probe(Q('T-004', 'feat/pinok'));
    const q3 = probe(Q('T-005', 'feat/q'));
    const tip = moveTarget(E2, { 'vectors/extra.txt': 'c0ffee1\n' });
    const r2 = probe(TRAIN);
    const calls = jsonl(pqLog);
    const d = r2.dropped?.find((x) => x.task === 'T-004') || {};
    await guard('2.92 (a) A: three branches landed on the target after the check passed (here: one more vectors file): the train runs the check again on the branch merged with the new tip before the compile search and the rules check; it fails, T-004 is handed back (cause pre-queue) with the check\'s line and the studio\'s, and T-005 goes on and lands (fails before this fix: the queue-time pass stood and the branch went into the train)', () => [
      q2.ok === true && q3.ok === true && calls.length === 2 && calls[1].target === tip && calls[1].lane === E2.heads['feat/pinok'] && d.cause === 'pre-queue' && /refused before the land run/.test(d.why) && /vectors\/extra\.txt recorded at c0ffee1/.test(d.why)
        && /Re-record the vectors/.test(d.why) && r2.landed?.join() === 'T-005' && r2.handed?.some((h) => h.task === 'T-004'),
      JSON.stringify({ r2, calls }).slice(0, 2500)]);
  }

  // ================= B. the compile search at the queue door =================
  const QC = (E, ctl, extra = {}) => cfgFor(E, ctl, { quickCheck: QUICK, ...extra });
  {
    resetState();
    const E = engineRepo({ 'feat/dup': { 'Sim/State.cs': STATE(`${ONE}${ONE}`, '') } });
    setEngines({ unity: QC(E, path.join(T, 'ctl-b1')) });
    const r = probe(Q('T-011', 'feat/dup'));
    const ev = evs(/^task\.train\.unity\.queue_compile$/);
    await guard('2.92 (a) B: a branch that does not compile merged with the target is not queued: the compiler\'s line (error CS0102 at Sim/State.cs, the checkout folder taken out) and the train\'s words for "does not compile by itself"; one queue_compile event, verdict red (fails before this fix: it was queued and handed back by the next train)', () => [
      r.ok === false && r.error === 'compile' && /does not compile on port\/main by itself/.test(r.message) && /^ {2}Sim\/State\.cs\(\d+,7\): error CS0102/m.test(r.message) && /task done T-011 --train again/.test(r.message)
        && !r.message.includes(fwd(S)) && !queueFile().length && ev.length === 1 && ev[0].meta?.verdict === 'red',
      JSON.stringify({ r, ev: ev.map((e) => e.meta) }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/b': { 'Sim/State.cs': STATE(ONE, '') }, 'feat/c': { 'Sim/State.cs': STATE('', ONE) }, 'feat/a': { 'a.txt': 'a\n' } });
    const ctl = path.join(T, 'ctl-b2');
    setEngines({ unity: QC(E, ctl) });
    const clog = path.join(T, 'b2-compile.jsonl');
    const qa = probe(Q('T-021', 'feat/a'), { STUB_COMPILE_LOG: clog });
    const qb = probe(Q('T-022', 'feat/b'), { STUB_COMPILE_LOG: clog });
    const qc = probe(Q('T-023', 'feat/c'), { STUB_COMPILE_LOG: clog });
    const entry = queueFile().find((e) => e.task === 'T-023');
    const ev = evs(/^task\.train\.unity\.queue_compile$/);
    await guard('2.92 (a) B: a branch that compiles with the target but not with a branch queued ahead of it (both add the same field): it is queued, and the porter reads at once which queued task it does not compile with (T-022, not T-021), the compiler\'s line, and what to do; the queue entry records the clash; one queue_compile event per verdict (pass, pass, clash) (fails before this fix: nothing was said until a train handed it back hours later)', () => [
      qa.ok && qb.ok && qc.ok === true && /does not compile together with T-022 \(feat\/b\), queued ahead of it/.test(qc.message) && !/T-021/.test(qc.message) && /error CS0102/.test(qc.message)
        && /Once it has landed, bring port\/main in \(npm run engine -- merge T-023\)/.test(qc.message) && entry?.clash?.with?.join() === 'T-022' && ev.map((e) => e.meta?.verdict).join() === 'pass,pass,clash' && jsonl(clog).every((c) => !c.cwd.startsWith(fwd(E.R))),
      JSON.stringify({ qc, entry, ev: ev.map((e) => e.meta) }).slice(0, 2500)]);
    const r1 = probe(TRAIN);
    const de = evs(/^task\.train\.unity\.deferred$/);
    await guard('2.92 (a) B: the next train leaves T-023 out of the batch with T-022 (a deferred event, as a lane that conflicts with another), is not in the compile search (one compile run, on T-021 + T-022, which compile), and lands T-021 and T-022 on one land run; T-023 stays queued and is not handed back (fails before this fix: the train\'s compile search rediscovered the clash and handed T-023 back)', () => [
      r1.landed?.join() === 'T-021,T-022' && r1.runs === 1 && r1.compile?.runs === 1 && !r1.compile.left.length && r1.deferred?.map((x) => x.task).join() === 'T-023' && !r1.handed?.length && de.some((e) => e.task === 'T-023') && queueFile().map((e) => e.task).join() === 'T-023',
      JSON.stringify(r1).slice(0, 2500)]);
    const r2 = probe(TRAIN);
    const d = r2.dropped?.[0] || {};
    await guard('2.92 (a) B: once T-022 has landed, the next train checks T-023 again: the compile search runs on that batch of one, and it is handed back (cause compile) with the compiler\'s line and the "by itself" words, with no land run (fails before this fix: a batch of one went straight to a land run)', () => [
      r2.runs === 0 && d.task === 'T-023' && d.cause === 'compile' && /does not compile on port\/main by itself/.test(d.why) && /error CS0102/.test(d.why) && r2.compile?.left?.join() === 'T-023',
      JSON.stringify(r2).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Sim/State.cs': STATE(ONE, '') }, 'feat/c': { 'Sim/State.cs': STATE('', ONE) } });
    setEngines({ unity: QC(E, path.join(T, 'ctl-b3')) });
    queue(E, [['T-031', 'feat/a'], ['T-032', 'feat/b']]);
    const qc = probe(Q('T-033', 'feat/c'), { STUDIO_QUEUE_COMPILE_RUNS: '1' });
    const ev = evs(/^task\.train\.unity\.queue_compile$/);
    const entry = queueFile().find((e) => e.task === 'T-033');
    await guard('2.92 (a) B: the bound is hit (STUDIO_QUEUE_COMPILE_RUNS=1: the batch with the two queued ahead is red, and the search may not go on): the branch is queued as before, with one line saying the check did not finish, and no clash recorded; the event says unfinished', () => [
      qc.ok === true && /did not finish \(1 compile runs \(STUDIO_QUEUE_COMPILE_RUNS\)\): queued as before/.test(qc.message) && entry && !entry.clash && ev[0]?.meta?.verdict === 'unfinished',
      JSON.stringify({ qc, entry, ev: ev.map((e) => e.meta) }).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' } });
    setEngines({ unity: QC(E, path.join(T, 'ctl-b4')) });
    const t0 = Date.now();
    const qc = probe(Q('T-041', 'feat/a'), { COMPILE_STUB_MS: '20000', STUDIO_QUEUE_COMPILE_MIN: '0.05' });
    const ev = evs(/^task\.train\.unity\.queue_compile$/);
    await guard('2.92 (a) B: the check itself cannot finish (the compile command runs past the door\'s time limit, STUDIO_QUEUE_COMPILE_MIN): the branch is queued as today, with one line saying the check judged nothing and why; the event says not-run; queueing waited only the time limit, not the command', () => [
      qc.ok === true && /The compile check at the queue door judged nothing \(.*timed out/.test(qc.message) && queueFile().some((e) => e.task === 'T-041') && ev[0]?.meta?.verdict === 'not-run' && Date.now() - t0 < 18000,
      JSON.stringify({ qc, ev: ev.map((e) => e.meta), ms: Date.now() - t0 }).slice(0, 2500)]);
  }

  // ================= C. a red land run on a compiler error names its branch =================
  const NEW = { 'Sim/New.cs': 'using Game.Missing;\nnamespace Game.Sim { class N { } }\n' };
  const C3 = () => engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/n': NEW, 'feat/c': { 'c.txt': 'c\n' } });
  const blamePlan = () => evs(/^task\.train\.unity\.blame$/)[0]?.meta?.plan || null;
  {
    resetState();
    const E = C3();
    const ctl = path.join(T, 'ctl-c0');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-051', 'feat/a'], ['T-052', 'feat/n'], ['T-053', 'feat/c']]);
    const before = probe(TRAIN, { LAND_LOG_ONLY: '1' });
    const plan0 = blamePlan();
    resetState();
    const E2 = C3();
    const ctl2 = path.join(T, 'ctl-c1');
    setEngines({ unity: cfgFor(E2, ctl2, { logs: ['Logs/Editor.log'] }) });
    queue(E2, [['T-051', 'feat/a'], ['T-052', 'feat/n'], ['T-053', 'feat/c']]);
    const r = probe(TRAIN, { LAND_LOG_ONLY: '1' });
    const d = r.dropped?.[0] || {};
    const runs = runsOf(ctl2);
    await guard('2.92 (a) C: three branches, the second adds a file using a namespace nothing declares; the compiler\'s lines are only in the editor\'s own log: with engines.unity.logs naming it, the train hands T-052 back at once (cause compile, the compiler\'s line CS0234 at Sim/New.cs) and lands the other two on the next run: 2 land runs, blame plan "compile" (fails before this fix: without the log the train searched, here ' + before.runs + ' land runs, plan ' + plan0 + ', the first step a different branch)', () => [
      r.runs === 2 && runs.length === 2 && r.landed?.join() === 'T-051,T-053' && r.dropped?.length === 1 && d.task === 'T-052' && d.cause === 'compile' && /Sim\/New\.cs\(1,7\): error CS0234/.test(d.why) && /a compile error in Sim\/New\.cs/.test(d.why)
        && /task done T-052 --train again/.test(d.why) && blamePlan() === 'compile' && before.runs > 2 && plan0 !== 'compile' && before.dropped?.map((x) => x.task).join() === 'T-052',
      JSON.stringify({ r, runs, before: { runs: before.runs, dropped: before.dropped }, plan0 }).slice(0, 3000)]);
  }
  {
    resetState();
    const E = C3();
    const ctl = path.join(T, 'ctl-c2');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-061', 'feat/a'], ['T-062', 'feat/n'], ['T-063', 'feat/c']]);
    const r = probe(TRAIN, { STUB_WIN: '1' });
    const d = r.dropped?.[0] || {};
    await guard('2.92 (a) C: a Windows compiler\'s backslash path in the land run\'s own output (C:\\ws\\gate\\Sim\\New.cs) maps to the branch that adds Sim/New.cs: T-062 handed back at once (cause compile), the others land on the next run, 2 land runs', () => [
      r.runs === 2 && r.landed?.join() === 'T-061,T-063' && d.task === 'T-062' && d.cause === 'compile' && /Sim\/New\.cs\(1,7\): error CS0234/.test(d.why) && blamePlan() === 'compile',
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/n': NEW, 'feat/m': { 'Sim/More.cs': 'using Game.Gone;\nnamespace Game.Sim { class M { } }\n' }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-c3');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-071', 'feat/a'], ['T-072', 'feat/n'], ['T-073', 'feat/m'], ['T-074', 'feat/c']]);
    const r = probe(TRAIN);
    await guard('2.92 (a) C: two of four branches each add a file the compiler names: both are handed back at once (cause compile) and the other two land on the next run, 2 land runs, no halving search', () => [
      r.runs === 2 && r.landed?.join() === 'T-071,T-074' && r.dropped?.map((x) => `${x.task}:${x.cause}`).sort().join() === 'T-072:compile,T-073:compile' && blamePlan() === 'compile',
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/del': { 'Sim/Helpers.cs': null }, 'feat/c': { 'c.txt': 'c\n' } });
    const ctl = path.join(T, 'ctl-c4');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-081', 'feat/a'], ['T-082', 'feat/del'], ['T-083', 'feat/c']]);
    const r = probe(TRAIN);
    await guard('2.92 (a) C: the compiler names a file no branch changed (Sim/Uses.cs; a branch deleted the namespace it uses): no branch is handed back by the files; the search runs as before and finds T-082 (fails if the mapping guessed: a lane would go back on no evidence)', () => [
      blamePlan() !== 'compile' && r.landed?.join() === 'T-081,T-083' && r.dropped?.map((x) => x.task).join() === 'T-082' && r.dropped[0].cause !== 'compile' && r.runs > 2,
      JSON.stringify(r).slice(0, 2500)]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/n': NEW, 'feat/m': { 'Sim/More.cs': 'using Game.Gone;\nnamespace Game.Sim { class M { } }\n' } });
    const ctl = path.join(T, 'ctl-c5');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-091', 'feat/n'], ['T-092', 'feat/m']]);
    const r = probe(TRAIN);
    await guard('2.92 (a) C: every branch of the batch changes a file the compiler names: nobody is handed back by the files alone; the search runs as before and hands each back after it is red by itself', () => [
      blamePlan() !== 'compile' && !r.landed?.length && r.dropped?.map((x) => x.task).sort().join() === 'T-091,T-092' && r.dropped.every((x) => x.cause !== 'compile') && blamePlan() === 'bisect',
      JSON.stringify({ runs: r.runs, landed: r.landed, dropped: r.dropped?.map((x) => [x.task, x.cause, x.why.split('\n')[0].slice(0, 120)]), plan: blamePlan() })]);
  }
  {
    resetState();
    const E = engineRepo({ 'feat/a': { 'a.txt': 'a\n' }, 'feat/b': { 'Sim/State.cs': STATE(ONE, '') }, 'feat/c': { 'Sim/State.cs': STATE('', ONE) } });
    const ctl = path.join(T, 'ctl-c6');
    setEngines({ unity: cfgFor(E, ctl) });
    queue(E, [['T-095', 'feat/a'], ['T-096', 'feat/b'], ['T-097', 'feat/c']]);
    const r = probe(TRAIN);
    await guard('2.92 (a) C: the one file the compiler names is changed by two branches (each adds the same field: they only clash together): neither is handed back by the files; the search runs as before, T-095 and T-096 land and only T-097 goes back (fails with a rule that hands back every lane naming the file: T-096 went back too)', () => [
      blamePlan() !== 'compile' && r.landed?.join() === 'T-095,T-096' && r.dropped?.map((x) => x.task).join() === 'T-097',
      JSON.stringify({ runs: r.runs, landed: r.landed, dropped: r.dropped?.map((x) => [x.task, x.cause]), plan: blamePlan() })]);
  }
  try { fs.rmSync(T, { recursive: true, force: true }); fs.rmSync(S, { recursive: true, force: true }); } catch { /* the runner's sweep */ }
}
