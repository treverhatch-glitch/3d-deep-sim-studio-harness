/**
 * qa/selftest-298d.mjs — 2.98 (d): each rules part's memory is its own recent sampled peak (not one old peak for every part),
 * runs older than machine.peakDays do not count, an unmeasured part takes its siblings' largest; a part that slowed down
 * is named, and a part with no test in the times file says so; rules.pins leaves inputs no tree pins out of the print;
 * a config that still sets rules.peak runs and rules show says it is no longer read.
 * Scaffolding as qa/selftest-297e.mjs (a studio copy, a made-up engine repo).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest298D({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s298d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: PowerShell (the process list a train cancel reads) needs Windows' own system variables, which any real shell
  // has; from this cut-down environment it ran into its time limit (P-370). Passed through as they are, as in 284u.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `298d-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio', 'engine'), { recursive: true });
  const setGame = (engines, machine = {}) => write(S, 'studio/game.json', `${JSON.stringify({ engines, machine }, null, 2)}\n`);
  setGame({});
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-298d.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-298d-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const J = (x) => JSON.stringify(x).slice(0, 2500);
  const DAY = 86400000;
  // Passed sampled runs per kind: { <kind>: [[gb, daysAgo, minutes]] }.
  const seed = (kinds) => fs.writeFileSync(path.join(S, '.studio', 'engine-ram.json'), JSON.stringify({ unity: { kinds: Object.fromEntries(Object.entries(kinds).map(([k, runs]) => [k, runs.map(([gb, ago, minutes = 5], i) => ({ id: `${k}-${i}`, at: Date.now() - ago * DAY, gb, cpu: 5, minutes, when: 'middle', code: 0 }))])) } }));
  const show = () => out(spawnSync(process.execPath, ['harness/engine-rules.mjs', 'show'], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 60000 }));

  try {
    // ================= (d1-d3) a part's own memory =================
    const plan = (filters, machine) => { setGame({}, machine); return probe(`import { partMemory } from ${u('harness/run-cost.mjs')};
import { splitPlan } from ${u('harness/rules-parts.mjs')};
const m = partMemory(process.cwd(), 'unity', ${JSON.stringify(filters)});
console.log(JSON.stringify({ m, why: splitPlan({}, { memory: m }).why }));`); };
    seed({ 'rules Cat=Fees': [[0.9, 1]], 'rules Cat=Move': [[1.3, 0.5]], 'rules Rest': [[0.4, 2]] });
    const d1 = plan(['Cat=Fees', 'Cat=Move', 'Rest']);
    await guard('2.98 (d1) the split plan gives each part its own recent peak: with one recent passed run each, the parts take 0.9, 1.3 and 0.4 GB and the plan line names them (fails before this fix: 13.5 for every part)', () => [
      d1.m?.list?.map((x) => x.gb).join() === '0.9,1.3,0.4' && d1.m.gb === 1.3 && /Cat=Fees 0\.9 GB, Cat=Move 1\.3 GB, Rest 0\.4 GB/.test(d1.why || ''), J(d1)]);

    seed({ 'rules Cat=Fees': [[13.5, 9]], 'rules Cat=Move': [[1.3, 2]] });
    const d2 = plan(['Cat=Fees', 'Cat=Move']);
    const d2b = plan(['Cat=Fees', 'Cat=Move'].slice(), { peakDays: 30 });
    await guard('2.98 (d2) a run older than machine.peakDays (7) does not count: a 13.5 GB run 9 days old is left out, and machine.peakDays 30 counts it again (fails before this fix: the old peak was the one number)', () => [
      d2.m?.list?.[0]?.measured === false && d2.m.list[0].gb === 1.3 && d2b.m?.list?.[0]?.measured === true && d2b.m.list[0].gb === 13.5, J({ d2: d2.m, d2b: d2b.m })]);

    seed({ 'rules Cat=Fees': [[0.9, 1]], 'rules Cat=Move': [[1.3, 1]] });
    const d3 = plan(['Cat=Fees', 'Cat=Move', 'Rest']);
    seed({});
    const d3n = plan(['Cat=Fees', 'Rest']);
    await guard('2.98 (d3) a part with no recent sampled run takes the largest of its siblings (Rest 1.3 GB) and the line says which parts were measured and which were not; with none measured the default 4 GB is said (fails before this fix: one old peak for all)', () => [
      d3.m?.list?.[2]?.gb === 1.3 && d3.m.list[2].measured === false && /not measured, so the largest of those \(1\.3 GB\): Rest/.test(d3.m.line) && d3n.m?.gb === 4 && /no part has a passed sampled run/.test(d3n.m.line || ''), J({ d3: d3.m, d3n: d3n.m })]);

    // ================= (d4, d5, d7) rules show =================
    const E = path.join(T, 'repo');
    fs.mkdirSync(E, { recursive: true });
    g(E, 'init', '-q', '-b', 'port/main');
    write(E, 'Sim/Fees/Fees.cs', 'class Fees { }\n');
    g(E, 'add', '-A'); g(E, 'commit', '-qm', 'start');
    const rules = (extra = {}) => ({ test: 'node -e "0"', focus: { test: 'node -e "0" {filter}', smoke: 'Smoke', auto: { root: 'Sim', paths: ['Sim/{name}/'], filter: 'Cat={name}' }, fullEveryHours: 0 }, ...extra });
    const cfgOf = (r) => ({ unity: { land: 'node -e "0" {branch}', target: 'port/main', cwd: fwd(E), rules: r } });
    const timesFile = path.join(S, '.studio', 'engine', 'unity-times.json');
    seed({ 'rules Cat=Fees': [[0.9, 6, 5], [0.9, 5, 5], [0.9, 4, 5], [0.9, 3, 5], [0.9, 0.1, 30]], 'rules Cat=Move': [[1.3, 1, 4]] });
    fs.writeFileSync(timesFile, JSON.stringify({ runs: [{ at: new Date().toISOString(), train: 't1', command: 'Cat=Fees', count: 2, seconds: 100, tests: [['Fees.Rounding', 90], ['Fees.Other', 10]] }] }));
    setGame(cfgOf(rules({ times: 'out/*.trx' })));
    const s4 = show();
    await guard('2.98 (d4) rules show names a part whose last run took 30 minutes against a median of 5, with both times and its slowest test; a part that did not slow down is not named (fails before this fix: nothing said which part grew)', () => [
      /Cat=Fees slowed down: its last passed run took 30 min, the median of its 4 earlier runs is 5 min\. Slowest tests: Fees\.Rounding 1\.5 min, Fees\.Other 10 s\./.test(s4) && !/Cat=Move slowed down/.test(s4), J({ s4: s4.slice(-1500) })]);
    await guard('2.98 (d5) with rules.times set, a part with no test in the times file gets the plain sentence (not "count 0"), and a part with tests does not; with rules.times unset the sentence is not printed', () => {
      setGame(cfgOf(rules()));
      const off = show();
      return [/Cat=Move: no test times for this part \(the times file names none of its tests\)\./.test(s4) && !/Cat=Fees: no test times/.test(s4) && !/count 0/.test(s4) && !/no test times for this part/.test(off), J({ s4: s4.slice(-900), off: off.slice(-600) })];
    });
    setGame(cfgOf(rules({ peak: 'out/**/peak.txt' })));
    const s7 = show();
    const c7 = probe(`import { rulesConfig } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
console.log(JSON.stringify({ ok: Boolean(cfg?.command), peak: cfg?.peak ?? null, ignored: cfg?.peakIgnored === true, bad: cfg?.focusBad || [] }));`);
    await guard('2.98 (d7) a config that still sets rules.peak is read without an error and rules show says "rules.peak is no longer read: every run is sampled" (fails before this fix: rules.peak was read and its file used)', () => [
      c7.ok && c7.peak === null && c7.ignored && !c7.bad.length && /\[engine-rules\] rules\.peak is no longer read: every run is sampled/.test(s7) && !/no longer read/.test(s4), J({ c7, s7: s7.slice(-600) })]);

    // ================= (d6) rules.pins =================
    const pinCfg = { test: 'node -e "0"', inputs: ['Packs'], pins: { file: 'pin.json', folder: 'Packs/{pin}' } };
    setGame({ unity: { rules: pinCfg } });
    const F = path.join(T, 'tree');
    write(F, 'pin.json', '{ "fingerprint": "aaa" }\n');
    write(F, 'Packs/aaa/a.dat', 'one\n');
    write(F, 'Packs/other/keep.txt', 'x\n');
    const pr = (from, withPins = true) => probe(`import { rulesConfig, inputsPrint } from ${u('harness/engine-rules.mjs')};
const cfg = rulesConfig('unity', { root: process.cwd() });
${withPins ? '' : 'delete cfg.pins;'}
console.log(JSON.stringify({ pins: cfg.pins || null, bad: cfg.focusBad || [], print: inputsPrint(cfg, ${JSON.stringify(from)}) }));`);
    const p0 = pr([F]);
    write(F, 'Packs/bbb/b.dat', 'added by another lane\n');
    const p1 = pr([F]);
    const p1x = pr([F], false);
    write(F, 'Packs/aaa/a.dat', 'two\n');
    const p2 = pr([F]);
    write(F, 'Packs/aaa/a.dat', 'one\n');
    fs.rmSync(path.join(F, 'pin.json'));
    const p3 = pr([F]);
    // the same from a git source ({ dir, sha }): the pin read with git at that commit
    const G = path.join(T, 'gitsrc');
    fs.mkdirSync(G, { recursive: true });
    g(G, 'init', '-q', '-b', 'main');
    write(G, 'pin.json', '{ "fingerprint": "aaa" }\n'); write(G, 'Packs/aaa/a.dat', 'one\n');
    g(G, 'add', '-A'); g(G, 'commit', '-qm', 'one');
    const sha1 = g(G, 'rev-parse', 'HEAD').stdout.trim();
    write(G, 'Packs/bbb/b.dat', 'added\n');
    g(G, 'add', '-A'); g(G, 'commit', '-qm', 'two');
    const sha2 = g(G, 'rev-parse', 'HEAD').stdout.trim();
    const q1 = pr([{ dir: G, sha: sha1 }]);
    const q2 = pr([{ dir: G, sha: sha2 }]);
    await guard('2.98 (d6) with rules.pins, a file added under another pin\'s folder leaves the print unchanged and a file under the pinned folder changes it, from a folder and from a commit; with no pin readable, or with no rules.pins, the added file changes it (fails before this fix: both changed it)', () => [
      p0.pins?.key === 'fingerprint' && p0.print && p1.print === p0.print && p2.print !== p0.print && p1x.print !== p0.print && p3.print !== p0.print && q1.print && q2.print === q1.print, J({ p0, p1, p1x, p2, p3, q1, q2 })]);
  } finally {
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep takes it */ }
  }
}
