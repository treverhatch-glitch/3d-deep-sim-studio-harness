/**
 * qa/selftest-278a.mjs — 2.78.0 (PU-56): load-sensitive tests (the crew's M7).
 *   On a PC running 4-6 builder verifies and a Unity gate, a 2 ms timing test took 2.2-2.5 ms and failed "alone" (alone
 *   was not quiet); the flake triager called it `real` at once and builders handed finished work back. Now a red alone is
 *   confirmed at quiet low load first: passes there -> `load-sensitive` (listed in .studio/load-sensitive.json; a train red
 *   only in such tests doesn't hand its lanes back); fails there -> `real`; no quiet machine in time -> `real`, unconfirmed.
 * Pure-function and file-level checks (no git, no spawns): labelTest with a fake runAlone, waitQuiet with a fake clock,
 * triageRed's list, and the train's "hand back or not" function (loadSensitiveExcuse).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278A({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const fx = fs.mkdtempSync(path.join(tmpRoot, '278a-'));
  void run; void harnessRoot;
  const F = 'game/demo/tests/hostProbe.test.mjs';
  // A fake runAlone: answers[i] is the i-th call's reply; calls are recorded.
  const fake = (...answers) => { const calls = []; const f = (a) => { calls.push(a); const r = answers[Math.min(calls.length - 1, answers.length - 1)]; return typeof r === 'function' ? r(a) : r; }; f.calls = calls; return f; };

  await guard('2.78.0 (PU-56): a test that fails alone under load but passes alone at low load on a quiet machine is labelled load-sensitive (the quiet re-run is asked for with quiet:true, lowLoad:true, the wait bound passed on), not real (fails on 2.77.1: the first red alone decided "real" at once)', async () => {
    const { labelTest } = await imp('harness/flakes.mjs');
    const ra = fake({ ok: false }, { ok: true });
    const l = labelTest({ check: 'game:unit', file: F, runAlone: ra, env: { STUDIO_FLAKE_QUIET_WAIT_MIN: '7' } });
    return [l.label === 'load-sensitive' && /load-sensitive/.test(l.why) && /quiet/.test(l.why) && ra.calls.length === 2 && ra.calls[0].lowLoad === false && ra.calls[1].lowLoad === true && ra.calls[1].quiet === true && ra.calls[1].quietWaitMin === 7 && l.runs.length === 2 && l.runs[1].ok === true && l.runs[1].quiet === true, JSON.stringify({ l, calls: ra.calls })];
  });
  await guard('2.78.0 (PU-56): fails alone and fails again at quiet low load is real, with a why that says both runs failed (fails on 2.77.1: one run, no quiet re-run)', async () => {
    const { labelTest } = await imp('harness/flakes.mjs');
    const ra = fake({ ok: false }, { ok: false });
    const l = labelTest({ check: 'game:unit', file: F, runAlone: ra });
    return [l.label === 'real' && /again at quiet low load/.test(l.why) && ra.calls.length === 2 && l.runs.length === 2 && l.runs[1].quiet === true, JSON.stringify(l)];
  });
  await guard('2.78.0 (PU-56): a quiet machine not reached in time (runAlone answers quietUnreached) is real with a why saying "unconfirmed under load" and naming STUDIO_FLAKE_QUIET_WAIT_MIN; the default wait is 10 minutes (fails on 2.77.1: real, no mention)', async () => {
    const { labelTest, quietWaitMin } = await imp('harness/flakes.mjs');
    const ra = fake({ ok: false }, { ok: false, quietUnreached: true });
    const l = labelTest({ check: 'game:unit', file: F, runAlone: ra });
    return [l.label === 'real' && /unconfirmed under load/.test(l.why) && /STUDIO_FLAKE_QUIET_WAIT_MIN/.test(l.why) && /within 10 min/.test(l.why) && ra.calls[1].quietWaitMin === 10 && quietWaitMin({}) === 10 && quietWaitMin({ STUDIO_FLAKE_QUIET_WAIT_MIN: '3' }) === 3, JSON.stringify(l)];
  });
  await guard('2.78.0 (PU-56): the old labels are unchanged: passes alone + low load = load-flake (2 runs, the second not quiet), passes then fails = intermittent, passes alone with a randomness finding = seed-flake (1 run) (fails on 2.77.1: unchanged there, so this passes on both; it guards the change)', async () => {
    const { labelTest } = await imp('harness/flakes.mjs');
    const a = fake({ ok: true }, { ok: true });
    const la = labelTest({ check: 'game:unit', file: F, runAlone: a });
    const b = fake({ ok: true }, { ok: false });
    const lb = labelTest({ check: 'game:unit', file: F, runAlone: b });
    const c = fake({ ok: true });
    const lc = labelTest({ check: 'game:unit', file: F, runAlone: c, rng: { items: [`${F}:3 Math.random`] } });
    return [la.label === 'load-flake' && a.calls.length === 2 && !a.calls[1].quiet && lb.label === 'intermittent' && !b.calls[1].quiet && lc.label === 'seed-flake' && c.calls.length === 1, JSON.stringify({ la: la.label, lb: lb.label, lc: lc.label })];
  });

  await guard('2.78.0 (PU-56): waitQuiet waits (polling, logging once per change) until nothing else is busy, returns quiet:true; when busy to the end of the bound it returns quiet:false naming who (fails on 2.77.1: no harness/flake-quiet.mjs)', async () => {
    const { waitQuiet } = await imp('harness/flake-quiet.mjs');
    let t = 0; const sleeps = []; const logs = [];
    const q = waitQuiet(fx, { waitMin: 1, busy: () => (t < 5000 ? ['verify by builder-1 (pid 7)'] : []), sleep: (ms) => { sleeps.push(ms); t += ms; }, now: () => t, log: (m) => logs.push(m), pollMs: 2000 });
    let t2 = 0;
    const b = waitQuiet(fx, { waitMin: 0.05, busy: () => ['Unity (pid 9)'], sleep: (ms) => { t2 += ms; }, now: () => t2, log: () => {}, pollMs: 2000 });
    let t3 = 0;
    const z = waitQuiet(fx, { waitMin: 0, busy: () => [], sleep: () => { t3 += 1; }, now: () => t3 });
    return [q.quiet === true && sleeps.length === 3 && logs.length === 1 && /builder-1/.test(logs[0]) && b.quiet === false && b.busy[0] === 'Unity (pid 9)' && b.waitedMs >= 3000 && z.quiet === true && t3 === 0, JSON.stringify({ q, sleeps, logs, b, z })];
  });
  await guard('2.78.0 (PU-56): on an idle fixture studio otherWork() is empty, so the real quiet wait returns at once (fails on 2.77.1: no module)', async () => {
    const { otherWork, waitQuiet } = await imp('harness/flake-quiet.mjs');
    const env = { ...process.env, STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_HEAVY_HELD: '' };
    const w = waitQuiet(fx, { waitMin: 0.05, env });
    return [otherWork(fx, { env }).length === 0 && w.quiet === true, JSON.stringify(w)];
  });

  await guard('2.78.0 (PU-56): triageRed records a load-sensitive test in .studio/load-sensitive.json ({ test, check, first, last, count }; count 2 on the second sighting), logs the label in .studio/flakes.jsonl, and never proposes it for quarantine (fails on 2.77.1: labelled real, no list)', async () => {
    const { triageRed, readLoadSensitive, readQuarantine } = await imp('harness/flakes.mjs');
    const text = `[game-gates] FAIL game:unit: x\n[game-gates] failing test files in game:unit: ["${F}"]\n`;
    const ra = (a) => ({ ok: Boolean(a.quiet) });
    const env = { ...process.env, STUDIO_FLAKE_QUARANTINE_AFTER: '1' };
    const r1 = triageRed({ root: fx, dir: fx, text, train: 't1', tree: 'aaaa', runAlone: ra, env, rng: null, emit: () => {}, now: Date.parse('2026-11-05T00:00:00Z') });
    triageRed({ root: fx, dir: fx, text, train: 't2', tree: 'bbbb', runAlone: ra, env, rng: null, emit: () => {}, now: Date.parse('2026-11-05T01:00:00Z') });
    const list = readLoadSensitive(fx);
    const rows = fs.readFileSync(path.join(fx, '.studio', 'flakes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return [r1.labels[0]?.label === 'load-sensitive' && list.length === 1 && list[0].test === F && list[0].check === 'game:unit' && list[0].count === 2 && list[0].first === '2026-11-05T00:00:00.000Z' && list[0].last === '2026-11-05T01:00:00.000Z' && rows.length === 2 && rows.every((x) => x.label === 'load-sensitive') && readQuarantine(fx).length === 0 && r1.quarantined.length === 0, JSON.stringify({ r1, list, rows })];
  });

  await guard('2.78.0 (PU-56): the train\'s hand-back decision: a red whose only failing files are all load-sensitive (each gate has a file part) is excused; one real file, an unlabelled file, a gate with no file part, or a mixed gate (golden) is not (fails on 2.77.1: no such decision, every red handed back)', async () => {
    const { loadSensitiveExcuse } = await imp('harness/flakes.mjs');
    const ls = (t) => ({ test: t, check: 'game:unit', label: 'load-sensitive' });
    const real = (t) => ({ test: t, check: 'game:unit', label: 'real' });
    const A = 'game/demo/tests/a.test.mjs'; const B = 'game/demo/tests/b.test.mjs';
    const ok = loadSensitiveExcuse({ subs: [`game:game:unit:${A}`.replace('game:game:', 'game:'), `game:unit:${B}`], gates: ['game'], labels: [ls(A), ls(B)] });
    const oneReal = loadSensitiveExcuse({ subs: [`game:unit:${A}`, `game:unit:${B}`], gates: ['game'], labels: [ls(A), real(B)] });
    const unlabelled = loadSensitiveExcuse({ subs: [`game:unit:${A}`, `game:unit:${B}`], gates: ['game'], labels: [ls(A)] });
    const bare = loadSensitiveExcuse({ subs: [`game:unit:${A}`], gates: ['game', 'lint'], labels: [ls(A)] });
    const golden = loadSensitiveExcuse({ subs: [`game:unit:${A}`, 'golden:x.json'], gates: ['game', 'golden'], labels: [ls(A)] });
    const none = loadSensitiveExcuse({ subs: [], gates: ['game'], labels: [ls(A)] });
    return [ok.ok && ok.tests.length === 2 && !oneReal.ok && !unlabelled.ok && !bare.ok && /lint/.test(bare.why) && !golden.ok && !none.ok, JSON.stringify({ ok, oneReal, unlabelled, bare, golden, none })];
  });

  await guard('2.78.0 (PU-56): the train wires it: flakeTriage hands the quiet request to a runAlone that waits (waitQuiet) and answers quietUnreached, and the red loop excuses a load-sensitive-only red with a log line naming the timeout-flake path (fails on 2.77.1: no such code)', async () => {
    const t = fs.readFileSync(path.join(dir, 'harness', 'train.mjs'), 'utf8');
    return [/waitQuiet\(root/.test(t) && /quietUnreached: true/.test(t) && /loadSensitiveExcuse\(\{ subs: redSub/.test(t) && /treated like a timeout-flake that passed alone at low load/.test(t) && /v\.triage\?\.labels/.test(t) && /res\.triage = flakeTriage/.test(t), 'train.mjs lacks the wiring'];
  });

  try { fs.rmSync(fx, { recursive: true, force: true }); } catch {}
}
