/**
 * qa/selftest-297e.mjs — 2.97 (e): a red rules.first is narrowed by the words of its failure, with no setting. A lane
 * whose own name (a folder or file base name no other lane of the batch changes) is a whole word of the failure is left
 * out first; with no such lane, or every lane, the prefix search runs as before. An explicit blame entry with "names"
 * still wins, and `rules show` says which of the two applies. The tests' stand-in prints `FAIL <name>: <file> differs`.
 * Scaffolding as qa/selftest-296b.mjs (a studio copy, a made-up engine repo, a stand-in for the tests).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest297E({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s297e-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.5', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_HEAVY_SLOTS: '1', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_TEST_FREEMEM_MB: '64000',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-297e-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `297e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  setEngines({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-297e.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-297e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 300000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const resetState = () => { for (const x of ['train', 'engine', 'comm', 'gates', 'tmp', 'locks', 'line']) fs.rmSync(path.join(S, '.studio', x), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.writeFileSync(evFile, ''); };

  // The engine repo: one data folder per system under tools/port; each lane changes the files it is given.
  let rn = 0;
  const engineRepo = (lanes) => {
    const R = path.join(T, `repo-${++rn}`);
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    for (const [f, t] of Object.entries({ 'tools/port/fees/a.json': '{}\n', 'tools/port/mapnav/x.json': '{}\n', 'notes.txt': 'n\n' })) write(R, f, t);
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'dev');
    const heads = {};
    for (const [br, files] of Object.entries(lanes)) {
      g(R, 'checkout', '-q', '-B', br, 'port/main');
      for (const [f, t] of Object.entries(files)) write(R, f, t);
      g(R, 'add', '-A'); g(R, 'commit', '-qm', `${br} work`);
      heads[br] = g(R, 'rev-parse', br).stdout.trim();
      g(R, 'checkout', '-q', 'dev');
    }
    return { R, heads, tip: g(R, 'rev-parse', 'port/main').stdout.trim() };
  };
  // The tests' stand-in: one data test; a data file with "BAD SAY=<name> FILE=<file>" fails it with "FAIL <name>: <file> differs".
  const rulesStub = path.join(T, 'rules-stub.mjs');
  fs.writeFileSync(rulesStub, `import fs from 'node:fs'; import path from 'node:path';
const [ctl, filter = 'ALL'] = process.argv.slice(2);
fs.appendFileSync(ctl + '-rules.jsonl', JSON.stringify({ filter }) + '\\n');
let said = '';
for (const d of fs.readdirSync(path.join('tools', 'port'))) for (const f of fs.readdirSync(path.join('tools', 'port', d))) { const m = /BAD SAY=(\\w+) FILE=(\\S+)/.exec(fs.readFileSync(path.join('tools', 'port', d, f), 'utf8')); if (m) said = 'FAIL ' + m[1] + ': ' + m[2] + ' differs'; }
if (!said) { console.log('  Passed Game.Tests.Data.DataTests.Check [1 ms]'); process.exit(0); }
console.log('  Failed Game.Tests.Data.DataTests.Check [3 ms]'); console.log('  Error Message:'); console.log('   ' + said);
for (let i = 0; i < 14; i += 1) console.log('  log line ' + i);
process.exit(1);
`);
  const FIRST = 'FullyQualifiedName~Game.Tests.Data.DataTests.Check';
  const cfgFor = (E, ctl, more = {}) => ({ land: 'node -e 0 {branch}', target: 'port/main', cwd: fwd(E.R), timeoutMin: 5, batchMax: 4,
    rules: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" ALL`, first: FIRST, focus: { test: `node "${fwd(rulesStub)}" "${fwd(ctl)}" "{filter}"`, map: [], fullEveryHours: 0 } }, ...more });
  const firstRuns = (ctl) => { try { return fs.readFileSync(`${ctl}-rules.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).filter).filter((f) => f === FIRST).length; } catch { return 0; } };
  const GATE = `import { rulesConfig, rulesGate } from ${u('harness/engine-rules.mjs')};
import { chainOnTarget } from ${u('harness/unity-train.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
const repo = process.env.REPO; const logs = [];
const lanes = JSON.parse(process.env.LANES);
const r = rulesGate({ engine: 'unity', repo, tip: process.env.TIP, lanes, cfg, from: [repo], root: process.cwd(), id: 'g', owe: true, log: (m) => logs.push(String(m)), chain: (t, ls) => chainOnTarget(repo, t, ls, 'g297', 'unity') });
console.log(JSON.stringify({ kept: r.kept.map((l) => l.task), dropped: r.dropped.map((d) => ({ task: d.lane.task, first: Boolean(d.first), why: d.why.split('\\n')[0] })), green: Boolean(r.green), logs: logs.filter((l) => /rules\\.first|named|trying/.test(l)) }));`;
  const gate = (E, ls) => probe(GATE, { REPO: E.R, TIP: E.tip, LANES: JSON.stringify(ls.map((b) => ({ task: b.replace(/^feat\//, ''), branch: b, head: E.heads[b] }))) });
  const J = (x) => JSON.stringify(x).slice(0, 2800);
  const BLAME = [{ test: 'DataTests', names: 'FAIL (\\w+):', touches: ['tools/port/{name}/'], say: 'Each system keeps its data in tools/port/<system>.' }];

  try {
    // ================= (e1) the failure names a folder only one lane changes =================
    const E1 = () => engineRepo({ 'feat/a': { 'tools/port/mapnav/x.json': '{ "ok": 1 }\n' }, 'feat/b': { 'tools/port/fees/a.json': 'BAD SAY=Fees FILE=fees/a.json\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
    {
      resetState();
      const E = E1();
      const ctl = path.join(T, 'ctl-e1');
      setEngines({ unity: cfgFor(E, ctl) });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const n = firstRuns(ctl);
      await guard('2.97 (e1) rules.first is red with "FAIL Fees: fees/a.json differs", fees is a folder only feat/b changes, no blame entry: b is left out at once, one run of the first test without it is green, b is handed back (3 runs of the first test in all: batch, target, without b), and the log says it needed no setting (fails before this fix: a prefix search, 4 runs)', () => [
        r.dropped?.map((d) => d.task).join() === 'b' && r.dropped[0].first && r.kept?.join() === 'a,c' && r.green && n === 3
          && /its failure names fees, which only feat\/b changes/.test(r.dropped[0].why) && /green without it \(a \+ c\) and red with it/.test(r.dropped[0].why)
          && r.logs?.some((l) => /rules\.first is red and its failure names fees, which only feat\/b changes .*: trying without b first \(an engines\.unity\.blame entry with names makes this exact\)/.test(l)), J({ r, n })]);
    }

    // ================= (e2) the name is changed by two lanes: no suspect =================
    {
      resetState();
      const E = engineRepo({ 'feat/a': { 'tools/port/mapnav/a.json': '{}\n' }, 'feat/n': { 'tools/port/mapnav/x.json': 'BAD SAY=mapnav FILE=mapnav/x.json\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = path.join(T, 'ctl-e2');
      setEngines({ unity: cfgFor(E, ctl) });
      const r = gate(E, ['feat/a', 'feat/n', 'feat/c']);
      const n = firstRuns(ctl);
      await guard('2.97 (e2) the failure names mapnav, which feat/a and feat/n both change: no suspect, the prefix search runs as before (batch, target, 2 prefixes, then the lanes left) and hands back n with "on top of a" (a guard of unchanged behaviour: it holds before and after this fix)', () => [
        r.dropped?.map((d) => d.task).join() === 'n' && r.kept?.join() === 'a,c' && r.green && n === 5 && /red with feat\/n on top of a; it is green without it/.test(r.dropped[0].why)
          && !r.logs?.some((l) => /trying without/.test(l)), J({ r, n })]);
    }

    // ================= (e3) a wrong suspect stays in, the search goes on =================
    {
      resetState();
      const E = engineRepo({ 'feat/f': { 'tools/port/fees/a.json': '{ "ok": 1 }\n' }, 'feat/n': { 'tools/port/mapnav/x.json': 'BAD SAY=Fees FILE=x.json\n' }, 'feat/c': { 'notes.txt': 'n2\n' } });
      const ctl = path.join(T, 'ctl-e3');
      setEngines({ unity: cfgFor(E, ctl) });
      const r = gate(E, ['feat/f', 'feat/n', 'feat/c']);
      const n = firstRuns(ctl);
      await guard('2.97 (e3) the failure says Fees but the red comes from feat/n: the run without the suspect feat/f is still red, so f is not handed back, the log says so, the prefix search finds n, and f lands (fails before this fix: nothing was tried from the failure\'s words)', () => [
        r.dropped?.map((d) => d.task).join() === 'n' && r.kept?.join() === 'f,c' && r.green && r.logs?.some((l) => /trying without f first/.test(l))
          && r.logs?.some((l) => /the failure's own words named f, but the batch without it is red: narrowing as before/.test(l)), J({ r, n })]);
    }

    // ================= (e4) an explicit blame entry with names still wins =================
    {
      resetState();
      const E = E1();
      const ctl = path.join(T, 'ctl-e4');
      setEngines({ unity: { ...cfgFor(E, ctl), blame: BLAME } });
      const r = gate(E, ['feat/a', 'feat/b', 'feat/c']);
      const n = firstRuns(ctl);
      await guard('2.97 (e4) with engines.unity.blame { test, names "FAIL (\\w+):", touches tools/port/{name}/ }, a red rules.first is read by that entry: b is handed back with the entry\'s words and its say line, in 3 runs, and the default by own words is not used (fails before this fix: on rules.first the entry\'s names were never read, a prefix search ran)', () => [
        r.dropped?.map((d) => d.task).join() === 'b' && r.green && n === 3 && /engines\.unity\.blame reads Fees in the failure/.test(r.dropped[0].why) && /Each system keeps its data/.test(r.dropped[0].why)
          && !r.logs?.some((l) => /trying without/.test(l)), J({ r, n })]);
    }

    // ================= (e5) rules show =================
    {
      const E = E1();
      const ctl = path.join(T, 'ctl-e5');
      const show = () => out(spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 }));
      setEngines({ unity: cfgFor(E, ctl) });
      const plain = show();
      setEngines({ unity: { ...cfgFor(E, ctl), blame: BLAME } });
      const withEntry = show();
      await guard('2.97 (e5) rules show with rules.first and no blame entry says a red first test is narrowed by the words of its failure, then by search, and names the doc; with an entry with names it prints that entry instead (fails before this fix: rules show said nothing of rules.first)', () => [
        /rules\.first FullyQualifiedName~Game\.Tests\.Data\.DataTests\.Check: a red first test is narrowed by the words of its failure .*then by search; an engines\.unity\.blame entry with test, names and touches makes it exact \(docs\/NATIVE-ENGINE\.md/.test(plain)
          && /rules\.first .*: blame entry test DataTests, names FAIL \(\\w\+\):, touches tools\/port\/\{name\}\//.test(withEntry) && !/narrowed by the words of its failure/.test(withEntry), J({ plain: plain.slice(-1500), withEntry: withEntry.slice(-1500) })]);
    }
  } finally {
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
  }
}
