/**
 * qa/selftest-297c.mjs — 2.97 (c): a land run waits for the memory of the kind it runs, and a run too short to sample is
 * unknown, not 0 GB. Before, the floor was the peak of every green land run on the machine (18.8 GB, from runs that also
 * ran the rules stage), so a land run told the rules are green waited for memory it never needed; and a run shorter than
 * one sample interval was stored as a measured 0 GB. Scaffolding: a made-up studio root with only .studio files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf, guardCap3000Of, out } from './kit.mjs';

export async function selftest297C({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const R = path.join(tmpRoot, `297c-root-${process.pid}`);
  const u = fileUrlOf(dir);
  const base = { ...clean, STUDIO_MAIN_ROOT: R, STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_CPU_PROBE: 'off', CI: '', NODE_OPTIONS: '' };
  const wr = (rel, text) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const store = (j) => wr('.studio/engine-ram.json', JSON.stringify(j));
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(R, `.probe-297c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: R, env: { ...base, ...env }, encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; }
  };
  const run = (id, code = 0, gb = 10, over = {}) => ({ id, at: 1, gb, cpu: 30, minutes: 20, when: 'middle', code, ...over });
  const rulesGreen = { STUDIO_RULES_GREEN: '1', STUDIO_PLAY_MODE: 'skip' };

  try {
    fs.mkdirSync(R, { recursive: true });
    // Two kinds on one engine: the heavier one (rules stage run) and the lighter one (rules told green).
    store({ unity: {
      kinds: { 'land with-rules play-full': [run('a', 0, 15), run('b', 0, 15)], 'land no-rules play-skip': [run('c', 0, 10.1), run('d', 0, 9.8)] },
    } });
    const F = probe(`import { landHeavyOpts } from ${u('harness/unity-gate.mjs')};
import { engineFloor } from ${u('harness/engine-tracks.mjs')};
import { landKind } from ${u('harness/run-cost.mjs')};
const env = JSON.parse(process.env.E || '{}');
const h = await landHeavyOpts('unity', { env: { ...process.env, ...env } });
const k = (e) => engineFloor('unity', { root: process.cwd(), env: { ...process.env, ...e }, kind: 'land with-rules play-zzz' });
const none = engineFloor('unity', { root: process.cwd(), env: process.env });
console.log(JSON.stringify({ kind: landKind({ ...process.env, ...env }), opts: { gb: h.heavyOpts.minFreeGb, why: h.heavyOpts.floorWhy }, unknown: k({}), none }));`, { E: JSON.stringify(rulesGreen) });
    await guard('2.97 (c1) a land run told the rules are green waits for the need of land no-rules play-skip (10.1 + 1.5 = 11.6 GB), not the heavier kind\'s 16.5 GB, and the line names the kind (fails before this fix: the 18.8 GB of the whole machine)', () => [
      F.kind === 'land no-rules play-skip' && F.opts?.gb === 11.6 && /^need of land no-rules play-skip \(peak of its last 2 passed runs plus 1\.5 GB\)$/.test(F.opts.why || ''), JSON.stringify(F)]);

    // The wait line itself: free RAM 1 GB, under any floor (a small machine caps the floor at 60% of its RAM), the wait ends at once.
    const W = probe(`import { acquireHeavy } from ${u('harness/heavy.mjs')};
import { landHeavyOpts } from ${u('harness/unity-gate.mjs')};
const env = { ...process.env, ...JSON.parse(process.env.E) };
const { hroot, heavyOpts } = await landHeavyOpts('unity', { env });
let msg = '';
try { acquireHeavy(hroot, 'land probe', { ...heavyOpts, env, waitMin: 0.02, log: () => {} }); } catch (e) { msg = String(e.message); }
console.log(JSON.stringify({ msg }));`, { E: JSON.stringify(rulesGreen), STUDIO_TEST_FREEMEM_MB: '1000' });
    await guard('2.97 (c1b) the wait line says "under the 11.6 GB need of land no-rules play-skip (peak of its last 2 passed runs plus 1.5 GB)" (fails before this fix: it named a floor and no kind)', () => [
      /free RAM is 1 GB.*under the [\d.]+ GB need of land no-rules play-skip \(peak of its last 2 passed runs plus 1\.5 GB\)/.test(W.msg || ''), JSON.stringify(W).slice(0, 800)]);

    const O = probe(`import { engineFloor } from ${u('harness/engine-tracks.mjs')};
const e = (extra) => engineFloor('unity', { root: process.cwd(), env: { ...process.env, ...extra }, kind: 'land no-rules play-skip' });
const owner = e({ STUDIO_UNITY_MIN_FREE_GB: '14' });
const fs = await import('node:fs');
fs.mkdirSync('studio/engine', { recursive: true });
fs.writeFileSync('studio/engine/unity-tune.json', JSON.stringify({ values: { 'ram-floor': 12 }, log: [] }));
const tuned = e({});
const both = e({ STUDIO_UNITY_MIN_FREE_GB: '14' });
fs.rmSync('studio/engine', { recursive: true, force: true });
console.log(JSON.stringify({ owner, tuned, both }));`);
    await guard('2.97 (c2) the owner\'s environment setting (14 GB) and the tuned ram-floor (12 GB) still win over the measured need, the environment first', () => [
      O.owner?.gb === 14 && /owner/.test(O.owner.from) && O.tuned?.gb === 12 && /tuned/.test(O.tuned.from) && O.both?.gb === 14, JSON.stringify(O)]);

    await guard('2.97 (c3) a kind with no passed run falls back to the engine table (12 GB) and says no passed sampled run of that kind; a caller with no kind gets the heaviest land kind measured (15 + 1.5 = 16.5 GB) and says so', () => [
      F.unknown?.gb === 12 && /^no passed sampled run of land with-rules play-zzz yet; the engine table/.test(F.unknown.from) && F.none?.gb === 16.5 && /^no kind given, so the heaviest land kind measured: need of land with-rules play-full/.test(F.none.from), JSON.stringify({ unknown: F.unknown, none: F.none })]);

    // ---- unknown runs ----
    const sDir = path.join(R, '.studio', 'engine', 'unity-samples');
    fs.mkdirSync(sDir, { recursive: true });
    const csv = (name, kind, gbs, at) => fs.writeFileSync(path.join(sDir, `${name}.csv`), `# ${JSON.stringify({ v: 1, kind, engine: 'unity', pid: 2000000001, ppid: 1, at, everyMs: 10000 })}\nt,availGb,commitUsedGb,commitLimitGb,cpuPct,treeGb,treeCpuPct,procs\n${gbs.map((gb, i) => `${at + i * 1000},20,,,40,${gb},5,3`).join('\n')}\n# end ${JSON.stringify({ at: at + 6000, code: 0 })}\n`);
    const at = Date.now() - 3600000;
    csv('quick-0', 'rules Fees', [], at);
    csv('real-0', 'rules MapNav', [0.02, 0.03], at);
    store({ unity: { kinds: { 'rules old': [{ id: 'o', at: 1, gb: 0, cpu: null, minutes: 0.1, when: null, code: 0 }] } } });
    const U = probe(`import fs from 'node:fs';
import { foldRuns, kindCost } from ${u('harness/run-cost.mjs')};
const e = foldRuns(process.cwd(), 'unity');
console.log(JSON.stringify({ short: e.kinds['rules Fees'], real: e.kinds['rules MapNav'], oldCost: kindCost(e, 'rules old'), realCost: kindCost(e, 'rules MapNav') }));`);
    await guard('2.97 (c4) a run with no sample row is stored gb null, short true, with its minutes and exit code; a 2.96 entry gb 0 with no CPU and no peak time reads as unknown; a real 0.03 GB with sample rows stays a number (fails before this fix: stored and read as 0 GB)', () => [
      U.short?.[0]?.gb === null && U.short[0].short === true && U.short[0].code === 0 && Number.isFinite(U.short[0].minutes)
        && U.oldCost?.unknown === true && U.oldCost.peakGb === null && U.oldCost.measured === false && U.oldCost.minutes === 0.1
        && U.real?.[0]?.gb === 0.03 && U.realCost?.unknown === undefined && U.realCost.peakGb === 0.03, JSON.stringify(U)]);

    // ---- admission and the printed lines ----
    wr('studio/game.json', JSON.stringify({ machine: { admit: 'measured' } }));
    const A = probe(`import { measuredAdmit, costLines } from ${u('harness/run-cost.mjs')};
import { costText } from ${u('harness/rules-times.mjs')};
const a = (extra) => measuredAdmit({ root: process.cwd(), engine: 'unity', kind: 'rules old', cpuNowPct: 0, ...extra });
console.log(JSON.stringify({ plain: a({}), hand: a({ handGb: 3 }), lines: costLines(process.cwd(), 'unity'), text: costText({ engine: 'unity', runs: 1, total: 5, slowest: [], twice: [], heavy: [], short: [{ filter: 'Fees', minutes: 0.1 }], memory: [], ratchets: 0 }) }));`, { STUDIO_TEST_FREEMEM_MB: '30000' });
    await guard('2.97 (c5) measured admission for a kind with only unknown runs does not take 0 GB: with no number it leaves the decision to today\'s rule and says "too short to sample"; with the plan\'s or hand-set number (3 GB) it uses that (fails before this fix: "no measured peak yet")', () => [
      A.plain?.decided === false && /too short to sample \(0\.1 min\)/.test(A.plain.why || '') && A.hand?.decided === true && A.hand.needGb === 3, JSON.stringify({ plain: A.plain, hand: A.hand })]);
    await guard('2.97 (c6) the cost lines (rules show) and the test cost text print "too short to sample (0.1 min)", never "0 GB" (fails before this fix: peak 0 GB)', () => [
      (A.lines || []).some((l) => /rules old: too short to sample \(0\.1 min\)/.test(l)) && !(A.lines || []).some((l) => /rules old.*peak 0 GB/.test(l)) && /too short to sample \(0\.1 min\): Fees/.test(A.text || ''), JSON.stringify({ lines: A.lines, text: A.text })]);
  } finally {
    try { fs.rmSync(R, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}
