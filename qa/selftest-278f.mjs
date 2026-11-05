/**
 * qa/selftest-278f.mjs — 2.78.0 (helper f): two measures, neither changes how the crew is scheduled.
 *   PU-59  a held-out split for the replay bench (studio/bench/split.json, `bench split`, `bench run --split`) and the
 *          acceptance rule `bench compare` applies to a harness change (accept / compute-bought / reject), attachable to
 *          a change record (--change C-n).
 *   PU-60  plan-time scope and waves in shadow mode (harness/plan-waves.mjs): an overlap graph of the ready tasks,
 *          coloured into waves, the serialized share, a waves.shadow event at most every STUDIO_WAVES_MIN minutes, and a
 *          replay over past events. (Not harness/waves.mjs: that is the fun-check waves module.)
 * No real agents: bench run results are fake results.json files.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278F({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
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
    STUDIO_BENCH_DIR: '', STUDIO_BENCH_NOISE: '', STUDIO_BENCH_COST_MAX: '', STUDIO_WAVES: '', STUDIO_WAVES_MIN: '', STUDIO_WAVES_MAX_SHARE: '',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-278f-${process.pid}.pem`), ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  let n = 0;
  const studio = (name, setup = () => {}) => {
    const S = path.join(tmpRoot, `278f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-278f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    setup(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'studio', '--no-verify');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2000) }; } };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-278f-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const want = (k) => !process.env.ONLY_278F || process.env.ONLY_278F.split(',').includes(k);
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

  // ---- PU-59 fixtures: ten cases (ids c01..c10), fake bench run results ----
  const ids = Array.from({ length: 10 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const caseJson = (id, commit) => `${JSON.stringify({ id, from: { task: 'T-001', title: id }, commit, brief: `brief ${id}`, grader: { pass: ['node -e 0'] }, tokenCap: 100000, timeoutMin: 5 }, null, 2)}\n`;
  const benchStudio = (name, caseIds = ids) => studio(name, (S) => { for (const id of caseIds) writeIn(S, `studio/bench/cases/${id}.json`, caseJson(id, 'a'.repeat(40))); });
  const bench = (st, args, env = {}) => run(st.S, `node harness/bench.mjs ${args}`, { ...st.env, ...env });
  const readSplitFile = (S) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'bench', 'split.json'), 'utf8')); } catch { return null; } };
  /** A fake run result: pass[id] = how many of the 3 tries pass; tokens per try. Written to .studio/bench/<id>/results.json. */
  const fakeRun = (S, id, pass, tokens = 1000) => {
    const tries = [];
    for (const cid of ids) for (let t = 1; t <= 3; t += 1) tries.push({ case: cid, try: t, pass: t <= (pass[cid] ?? 0), tokens: typeof tokens === 'function' ? tokens(cid) : tokens, turns: 5, minutes: 1 });
    const sc = (() => {
      const perCase = {};
      for (const cid of ids) { const ts = tries.filter((x) => x.case === cid); const p = ts.filter((x) => x.pass).length; perCase[cid] = { tries: 3, passes: p, rate: p / 3, allPass: p === 3, tokens: ts[0].tokens, turns: 5, minutes: 1 }; }
      const cs = Object.values(perCase);
      return { perCase, pass1: cs.reduce((a, c) => a + c.rate, 0) / cs.length, passK: cs.filter((c) => c.allPass).length / cs.length, cases: cs.length };
    })();
    const res = { id, by: 'tester', at: '2026-11-01T00:00:00.000Z', harness: { ref: 'HEAD', sha: sha(id) }, k: 3, without: null, offInEnv: [], cases: ids, caseHashes: Object.fromEntries(ids.map((c) => [c, 'h'])), tries, score: sc, done: true };
    writeIn(S, `.studio/bench/${id}/results.json`, `${JSON.stringify(res, null, 2)}\n`);
  };
  const all = (v) => Object.fromEntries(ids.map((c) => [c, v]));
  const BASELINE = { ...all(3), c01: 1, c02: 1, c03: 1, c04: 2, c05: 2, c06: 2, c07: 3, c08: 3, c09: 3, c10: 3 };

  // ---- PU-59 ----
  if (want('split')) await guard('2.78.0 (PU-59): `bench split` writes studio/bench/split.json ({heldIn, heldOut, seed}), about 30% held out; run twice it is identical; new cases get a side by the seed while existing ids keep theirs; it says the folder is protected and needs the owner\'s approval (fails on 2.77.1: no split command)', async () => {
    const st = benchStudio('split', ids.slice(0, 6));
    const r1 = bench(st, 'split --by hatch');
    const s1 = readSplitFile(st.S);
    const r1b = bench(st, 'split --by hatch');
    const s1b = readSplitFile(st.S);
    for (const id of ids.slice(6)) writeIn(st.S, `studio/bench/cases/${id}.json`, caseJson(id, 'a'.repeat(40)));
    const r2 = bench(st, 'split --by hatch --held-out-share 0.3');
    const s2 = readSplitFile(st.S);
    const noBy = bench(st, 'split');
    const keeps = s1 && s2 && s1.heldIn.every((c) => s2.heldIn.includes(c)) && s1.heldOut.every((c) => s2.heldOut.includes(c));
    const ok = r1.status === 0 && s1 && s1.heldIn.length + s1.heldOut.length === 6 && s1.heldOut.length === 2 && typeof s1.seed === 'number'
      && JSON.stringify(s1) === JSON.stringify(s1b) && r1b.status === 0
      && s2 && s2.heldIn.length + s2.heldOut.length === 10 && s2.heldOut.length === 3 && keeps && new Set([...s2.heldIn, ...s2.heldOut]).size === 10
      && /protected/i.test(out(r1)) && /owner's signed approval/.test(out(r1)) && noBy.status !== 0 && /--by/.test(out(noBy));
    return [ok, JSON.stringify({ s1, s2, keeps, r1: out(r1), noBy: out(noBy) })];
  });

  if (want('run')) await guard('2.78.0 (PU-59): `bench run --split heldIn|heldOut` takes only that split\'s cases (the dry run lists the count), and is refused without a split file, with an unknown split name, or with a case the split does not know (fails on 2.77.1: --split is ignored, all cases run)', async () => {
    const st = benchStudio('run');
    const commit = gitIn(st.S, 'rev-parse', 'HEAD').stdout.trim();
    for (const id of ids) writeIn(st.S, `studio/bench/cases/${id}.json`, caseJson(id, commit));
    const noFile = bench(st, 'run --by hatch --split heldOut --k 1');
    bench(st, 'split --by hatch');
    const sp = readSplitFile(st.S);
    const dryOut = bench(st, 'run --by hatch --split heldOut --k 1');
    const dryIn = bench(st, 'run --by hatch --split heldIn --k 1');
    const bad = bench(st, 'run --by hatch --split nope --k 1');
    writeIn(st.S, 'studio/bench/cases/c11.json', caseJson('c11', commit));
    const stray = bench(st, 'run --by hatch --split heldIn --k 1');
    const ok = /no studio\/bench\/split\.json/.test(out(noFile)) && noFile.status === 1 && sp
      && new RegExp(`${sp.heldOut.length} case\\(s\\) x 1 tries = ${sp.heldOut.length} agent sessions`).test(out(dryOut))
      && new RegExp(`${sp.heldIn.length} case\\(s\\) x 1 tries = ${sp.heldIn.length} agent sessions`).test(out(dryIn))
      && bad.status === 1 && /--split is heldIn or heldOut/.test(out(bad)) && stray.status === 1 && /not in the split yet: c11/.test(out(stray));
    return [ok, JSON.stringify({ sp, noFile: out(noFile), dryOut: out(dryOut), dryIn: out(dryIn), bad: out(bad), stray: out(stray) })];
  });

  const compareCase = async (name, aPass, bPass, { aTok = 1000, bTok = 1000, extra = '', env = {} } = {}) => {
    const st = benchStudio(name);
    bench(st, 'split --by hatch');
    fakeRun(st.S, 'run-a', aPass, aTok);
    fakeRun(st.S, 'run-b', bPass, bTok);
    const sp = readSplitFile(st.S);
    const r = bench(st, `compare run-a run-b --json ${extra}`, env);
    const rt = bench(st, `compare run-a run-b ${extra}`, env);
    let j = null;
    try { j = JSON.parse(out(r).slice(out(r).indexOf('{'))).split; } catch {}
    return { st, sp, j, text: out(rt), code: rt.status };
  };
  const firstOf = (sp, side, k) => sp[side].slice(0, k);

  if (want('plant')) await guard('2.78.0 (PU-59): a planted "harness change" that hard-codes a hint for held-in cases improves held-in, does not help held-out (and its extra hint text costs it there), and `compare` rejects it; the per-split pass@1 / pass^k / tokens-per-pass deltas are printed (fails on 2.77.1: compare has no splits and no verdict rule)', async () => {
    // Needs the split to know which cases are held-in: build it first, then plan the fake runs from it.
    const st = benchStudio('plant');
    bench(st, 'split --by hatch');
    const sp = readSplitFile(st.S);
    const aPass = { ...all(3) };
    for (const c of sp.heldIn) aPass[c] = 1;
    for (const c of sp.heldOut) aPass[c] = 3;
    const bPass = { ...aPass };
    for (const c of sp.heldIn) bPass[c] = 3; // the hint makes every held-in case pass
    bPass[sp.heldOut[0]] = 2; // and a distracting hint costs one held-out try
    fakeRun(st.S, 'run-a', aPass, 1000);
    fakeRun(st.S, 'run-b', bPass, 1050);
    const j = JSON.parse(out(bench(st, 'compare run-a run-b --json')).replace(/^[^{]*/, '')).split;
    const text = out(bench(st, 'compare run-a run-b'));
    const ok = j && j.verdict === 'reject' && j.splits.heldIn.improved && !j.splits.heldIn.dropped && j.splits.heldIn.dPass1 > 0.3
      && j.splits.heldOut.dropped && j.splits.heldOut.dPass1 < -0.05 && /heldIn \(7 case\(s\)\)/.test(text) && /heldOut \(3 case\(s\)\)/.test(text)
      && /pass@1 .*pass\^k .*tokens per pass/.test(text) && /DROPPED/.test(text) && /verdict: reject/.test(text);
    return [ok, JSON.stringify({ verdict: j && j.verdict, why: j && j.why, text })];
  });

  if (want('noop')) await guard('2.78.0 (PU-59): a no-op change (same results, token counts moving a few percent) compares as within noise on both splits and is not accepted (fails on 2.77.1: no split verdict)', async () => {
    const c = await compareCase('noop', BASELINE, BASELINE, { aTok: 1000, bTok: 1030 });
    const ok = c.j && c.j.verdict === 'reject' && c.j.within.length === 2 && /within noise/.test(c.text) && !/DROPPED/.test(c.text) && !/\)  improved/.test(c.text) && /verdict: reject .*within noise/.test(c.text);
    return [ok, JSON.stringify({ j: c.j && { v: c.j.verdict, within: c.j.within, why: c.j.why }, text: c.text })];
  });

  if (want('accept')) await guard('2.78.0 (PU-59): a change that improves one split, drops neither and costs 5% more tokens per pass is accepted; the same gain at +40% tokens is "compute-bought"; STUDIO_BENCH_COST_MAX and STUDIO_BENCH_NOISE move the lines (fails on 2.77.1: no verdict)', async () => {
    const st = benchStudio('accept');
    bench(st, 'split --by hatch');
    const sp = readSplitFile(st.S);
    const aPass = { ...all(3) };
    for (const c of [...sp.heldIn.slice(0, 3), ...sp.heldOut.slice(0, 2)]) aPass[c] = 1;
    const bPass = { ...aPass };
    for (const c of [...sp.heldIn.slice(0, 3), ...sp.heldOut.slice(0, 2)]) bPass[c] = 3; // both splits improve
    // 2.78.0: held-in alone improving (held-out flat) is "unproven", not accepted.
    const inOnly = { ...aPass };
    for (const c of sp.heldIn.slice(0, 3)) inOnly[c] = 3;
    const cmp = (aTok, bTok, env = {}, bp = bPass) => { fakeRun(st.S, 'run-a', aPass, aTok); fakeRun(st.S, 'run-b', bp, bTok); const r = bench(st, 'compare run-a run-b --json', env); try { return JSON.parse(out(r).replace(/^[^{]*/, '')).split; } catch { return null; } };
    // tokens per pass: A passes less often, so the same per-try tokens already mean more tokens per pass for A. Use the ratio of the result.
    const acc = cmp(1000, 1000);
    const buy = cmp(1000, 1800);
    const accMax = cmp(1000, 1800, { STUDIO_BENCH_COST_MAX: '5' });
    const noiseHigh = cmp(1000, 1000, { STUDIO_BENCH_NOISE: '0.9' });
    const unproven = cmp(1000, 1000, {}, inOnly);
    const ok = acc && acc.verdict === 'accept' && acc.cost <= 0.15 && buy && buy.verdict === 'compute-bought' && buy.cost > 0.15
      && accMax && accMax.verdict === 'accept' && noiseHigh && noiseHigh.verdict === 'reject' && unproven && unproven.verdict === 'unproven';
    return [ok, JSON.stringify({ acc: acc && [acc.verdict, acc.cost, acc.why], buy: buy && [buy.verdict, buy.cost], accMax: accMax && accMax.verdict, noiseHigh: noiseHigh && noiseHigh.verdict, unproven: unproven && [unproven.verdict, unproven.why] })];
  });

  if (want('missing')) await guard('2.78.0 (PU-59): a split that was not measured (a run with no held-out cases) is rejected, and without a split file `compare` prints only the old comparison (fails on 2.77.1: no split output rule)', async () => {
    const st = benchStudio('missing');
    bench(st, 'split --by hatch');
    const sp = readSplitFile(st.S);
    fakeRun(st.S, 'run-a', BASELINE, 1000);
    fakeRun(st.S, 'run-b', { ...BASELINE, c01: 3 }, 1000);
    // Drop the held-out cases from run B's per-case scores.
    const f = path.join(st.S, '.studio', 'bench', 'run-b', 'results.json');
    const rb = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of sp.heldOut) delete rb.score.perCase[c];
    rb.tries = rb.tries.filter((t) => !sp.heldOut.includes(t.case));
    fs.writeFileSync(f, JSON.stringify(rb));
    const j = JSON.parse(out(bench(st, 'compare run-a run-b --json')).replace(/^[^{]*/, '')).split;
    fs.rmSync(path.join(st.S, 'studio', 'bench', 'split.json'));
    const old = out(bench(st, 'compare run-a run-b'));
    const ok = j.verdict === 'reject' && /heldOut/.test(j.why) && /Compare run-a \(A\) with run-b \(B\)/.test(old) && !/Split compare/.test(old);
    return [ok, JSON.stringify({ j: { v: j.verdict, why: j.why }, old })];
  });

  if (want('change')) await guard('2.78.0 (PU-59): `compare --change C-1` attaches the verdict to that change record as `bench` and leaves its status and verdict alone; `learn -- change list` shows it; a missing record is refused (fails on 2.77.1: no --change)', async () => {
    const st = benchStudio('change');
    const added = probe(st.S, st.env, 'chg', `import { addChange, readChanges, changeLine } from ${u(st.S, 'harness/changes.mjs')};
const r = addChange({ kind: 'harness', target: 'harness/x.mjs', signatures: ['task.not_done: x'], expect: 'fewer', risk: 'none', revert: 'git revert x', by: 'tester' });
console.log(JSON.stringify({ ok: r.ok, id: r.change?.id || r.id || null, msg: r.message || null }));
`);
    bench(st, 'split --by hatch');
    const sp = readSplitFile(st.S);
    const aPass = { ...all(3) };
    for (const c of [...sp.heldIn.slice(0, 3), ...sp.heldOut.slice(0, 2)]) aPass[c] = 1;
    const bPass = { ...aPass };
    for (const c of [...sp.heldIn.slice(0, 3), ...sp.heldOut.slice(0, 2)]) bPass[c] = 3; // both splits improve: accept
    fakeRun(st.S, 'run-a', aPass, 1000);
    fakeRun(st.S, 'run-b', bPass, 1000);
    const files = fs.existsSync(path.join(st.S, 'studio', 'changes')) ? fs.readdirSync(path.join(st.S, 'studio', 'changes')).filter((x) => /^C-\d+\.json$/.test(x)) : [];
    const id = files[0] ? files[0].replace(/\.json$/, '') : 'C-1';
    const before = JSON.parse(fs.readFileSync(path.join(st.S, 'studio', 'changes', `${id}.json`), 'utf8'));
    const r = bench(st, `compare run-a run-b --change ${id}`);
    const after = JSON.parse(fs.readFileSync(path.join(st.S, 'studio', 'changes', `${id}.json`), 'utf8'));
    const line = probe(st.S, st.env, 'chgline', `import { readChanges, changeLine } from ${u(st.S, 'harness/changes.mjs')};
console.log(JSON.stringify({ line: readChanges().map(changeLine)[0] }));
`);
    const bad = bench(st, 'compare run-a run-b --change C-99');
    const ok = files.length === 1 && r.status === 0 && after.bench && after.bench.verdict === 'accept' && after.bench.runs.join() === 'run-a,run-b' && after.status === before.status && after.status === 'watching'
      && !('verdict' in after) && /bench: accept/.test(line.line || '') && bad.status === 1 && /No change record C-99/.test(out(bad));
    return [ok, JSON.stringify({ added, after, line, out: out(r), bad: out(bad) })];
  });

  if (want('proposers')) await guard('2.78.0 (PU-59): retro, learn and experiment read no bench results today (no bench run/results/case reference), so there is nothing to filter to held-in; the split file is the one place heldIn is defined (fails on 2.77.1: n/a, a documentation check of the same fact)', async () => {
    const hits = ['retro.mjs', 'learn.mjs', 'experiment.mjs'].filter((f) => /bench\.mjs|\.studio[\\/]+bench|studio[\\/]+bench|loadRun|bench\.run|results\.json/.test(fs.readFileSync(path.join(dir, 'harness', f), 'utf8')));
    return [hits.length === 0, `proposers that read bench results: ${hits.join(', ') || 'none'}`];
  });

  // ---- PU-60 ----
  if (want('scope')) await guard('2.78.0 (PU-60): parseScope reads "--scope a,b" as globs (braces keep their commas, prose with spaces is dropped, duplicates collapse); globsOverlap tells src/sim/** from src/ui/**, a file from its folder glob, and a file from a different folder (fails on 2.77.1: no harness/plan-waves.mjs)', async () => {
    const st = studio('scope');
    const r = probe(st.S, st.env, 'scope', `import { parseScope, globsOverlap } from ${u(st.S, 'harness/plan-waves.mjs')};
console.log(JSON.stringify({
  p: parseScope('src/sim/**, {a,b}/x.ts ,free text here,src/sim/**,./docs/A.md'),
  none: parseScope(''), arr: parseScope(['x/*.js', 'y']),
  o: [globsOverlap('src/sim/**', 'src/sim/a.ts'), globsOverlap('src/sim/**', 'src/ui/**'), globsOverlap('src/sim', 'src/sim/a.ts'), globsOverlap('src/sim/a.ts', 'src/sim/b.ts'), globsOverlap('src/**', 'src/ui/hud.ts'), globsOverlap('docs/A.md', 'src/**'), globsOverlap('src/*.ts', 'src/ui/**'), globsOverlap('**', 'x/y.ts')],
}));`);
    const ok = JSON.stringify(r.p) === JSON.stringify(['src/sim/**', '{a,b}/x.ts', 'docs/A.md']) && r.none.length === 0 && JSON.stringify(r.arr) === JSON.stringify(['x/*.js', 'y'])
      && JSON.stringify(r.o) === JSON.stringify([true, false, true, false, true, false, true, true]);
    return [ok, JSON.stringify(r)];
  });

  if (want('plan')) await guard('2.78.0 (PU-60): a fixture queue with overlapping scopes (and one task with only overlap history) is coloured into waves where no two tasks overlap; the serialized share is computed; running lanes that overlap ready tasks are listed; over 60% is flagged "over-serialize" (fails on 2.77.1: no waves planner)', async () => {
    const st = studio('plan');
    const r = probe(st.S, st.env, 'plan', `import { planWaves, gather, firstOverlap } from ${u(st.S, 'harness/plan-waves.mjs')};
const tasks = [
  { id: 'T-1', scope: ['src/sim/**'] }, { id: 'T-2', scope: ['src/sim/a.ts'] }, { id: 'T-3', scope: ['src/ui/**'] },
  { id: 'T-4', scope: ['src/ui/hud.ts', 'src/sim/b.ts'] }, { id: 'T-5', scope: ['docs/**'] }, { id: 'T-6', scope: [] },
];
const running = [{ id: 'T-9', agent: 'builder-9', scope: ['src/ui/**'] }, { id: 'T-8', agent: 'builder-8', scope: [], files: ['docs/x.md'] }];
const p = planWaves({ ready: tasks, running });
const overlap = (a, b) => firstOverlap(tasks.find((t) => t.id === a).scope, tasks.find((t) => t.id === b).scope);
const clean = p.waves.every((w) => w.every((a, i) => w.slice(i + 1).every((b) => !overlap(a, b))));
const chain = planWaves({ ready: ['T-11', 'T-12', 'T-13', 'T-14', 'T-15'].map((id) => ({ id, scope: ['src/**'] })) });
// history: T-21 has no scope, but a hotspot.overlap event named it with T-22 on src/x.ts
const events = [
  { ts: '2026-11-01T00:00:00.000Z', type: 'task.added', task: 'T-22', meta: { scope: 'src/**' } },
  { ts: '2026-11-01T00:00:01.000Z', type: 'task.added', task: 'T-21', meta: {} },
  { ts: '2026-11-01T00:10:00.000Z', type: 'hotspot.overlap', meta: { file: 'src/x.ts', line: 3, lanes: ['T-21 (builder-1)', 'T-22 (builder-2)'] } },
];
const g = gather({ q: { backlog: [{ id: 'T-21', title: 'a' }, { id: 'T-22', title: 'b' }], inProgress: [] }, readyIds: ['T-21', 'T-22'], events });
const h = planWaves(g);
console.log(JSON.stringify({ p, clean, chain: { waves: chain.waves.length, share: chain.serializedShare, over: chain.overSerialize }, hist: { waves: h.waves, edges: h.edges.length } }));`);
    const p = r.p || {};
    const ok = JSON.stringify(p.waves) === JSON.stringify([['T-1', 'T-3', 'T-5', 'T-6'], ['T-2', 'T-4']]) && r.clean === true
      && p.serialized === 2 && Math.abs(p.serializedShare - 0.333) < 0.001 && p.overSerialize === false && JSON.stringify(p.unscoped) === JSON.stringify(['T-6'])
      && JSON.stringify((p.runningOverlaps || []).map((o) => `${o.running}>${o.ready}`)) === JSON.stringify(['T-9>T-3', 'T-9>T-4', 'T-8>T-5'])
      && r.chain.waves === 5 && r.chain.share === 0.8 && r.chain.over === true
      && r.hist.edges === 1 && r.hist.waves.length === 2;
    return [ok, JSON.stringify(r)];
  });

  if (want('shadow')) await guard('2.78.0 (PU-59/60): shadow mode logs one waves.shadow event at most every STUDIO_WAVES_MIN minutes (30), none with STUDIO_WAVES=off or an empty queue, carries the over-serialize flag, and never touches the board or which task starts (fails on 2.77.1: no waves.shadow)', async () => {
    const st = studio('shadow');
    const nextBefore = fs.readFileSync(path.join(st.S, 'studio', 'NEXT.md'), 'utf8');
    const r = probe(st.S, st.env, 'shadow', `import { shadowPass } from ${u(st.S, 'harness/plan-waves.mjs')};
const mk = (id) => ({ id, title: id, role: 'builder' });
const q = { backlog: ['T-1', 'T-2', 'T-3'].map(mk), inProgress: [], done: [] };
const events = ['T-1', 'T-2', 'T-3'].map((id, i) => ({ ts: '2026-11-01T00:00:0' + i + '.000Z', type: 'task.added', task: id, meta: { scope: 'src/**' } }));
const t0 = Date.parse('2026-11-01T12:00:00.000Z');
const deps = { q, readyIds: ['T-1', 'T-2', 'T-3'], events };
const a = await shadowPass({ now: t0, deps });
const b = await shadowPass({ now: t0 + 10 * 60000, deps });
const c = await shadowPass({ now: t0 + 31 * 60000, deps });
const off = await shadowPass({ now: t0 + 120 * 60000, deps, env: { ...process.env, STUDIO_WAVES: 'off' } });
const empty = await shadowPass({ now: t0 + 200 * 60000, deps: { q: { backlog: [], inProgress: [] }, readyIds: [], events } });
console.log(JSON.stringify({ a: [a.ran, a.plan && a.plan.serializedShare], b: [b.ran, b.why], c: c.ran, off: [off.ran, off.why], empty: [empty.ran, empty.why] }));`);
    const ev = events(st.ev).filter((e) => e.type === 'waves.shadow');
    const nextAfter = fs.readFileSync(path.join(st.S, 'studio', 'NEXT.md'), 'utf8');
    const ok = r.a && r.a[0] === true && r.b[0] === false && r.c === true && r.off[0] === false && /off/.test(r.off[1]) && r.empty[0] === false
      && ev.length === 2 && ev[0].meta.overSerialize === true && ev[0].meta.serialized === 2 && /over-serialize/.test(ev[0].msg) && nextAfter === nextBefore;
    return [ok, JSON.stringify({ r, ev: ev.map((e) => e.msg) })];
  });

  if (want('replay')) await guard('2.78.0 (PU-60): `plan-waves.mjs replay --events <file> --days 14` counts the recorded hotspot.overlap events waves would have avoided (scopes known before them overlap), the distinct pairs, those it could not avoid, and roughly the extra wall time (the later task waits out the overlap) (fails on 2.77.1: no replay)', async () => {
    const st = studio('replay');
    const T = (min) => new Date(Date.parse('2026-11-01T00:00:00.000Z') + min * 60000).toISOString();
    const evs = [
      { ts: '2026-09-01T00:00:00.000Z', type: 'hotspot.overlap', meta: { file: 'old.ts', lanes: ['T-90 (a)', 'T-91 (b)'] } }, // outside the 14 days
      { ts: T(0), type: 'task.added', task: 'T-1', meta: { scope: 'src/sim/**' } },
      { ts: T(0), type: 'task.added', task: 'T-2', meta: { scope: 'src/sim/a.ts,docs/**' } },
      { ts: T(0), type: 'task.added', task: 'T-3', meta: {} },
      { ts: T(0), type: 'task.added', task: 'T-4', meta: { scope: 'src/ui/**' } },
      { ts: T(1), type: 'task.start', task: 'T-1', agent: 'a' },
      { ts: T(10), type: 'task.start', task: 'T-2', agent: 'b' },
      { ts: T(11), type: 'task.start', task: 'T-3', agent: 'c' },
      { ts: T(12), type: 'task.start', task: 'T-4', agent: 'd' },
      { ts: T(20), type: 'hotspot.overlap', meta: { file: 'src/sim/a.ts', line: 4, lanes: ['T-1 (a)', 'T-2 (b)'] } },
      { ts: T(21), type: 'hotspot.overlap', meta: { file: 'src/sim/a.ts', line: 9, lanes: ['T-1 (a)', 'T-2 (b)'] } },
      { ts: T(22), type: 'hotspot.overlap', meta: { file: 'src/other.ts', line: 1, lanes: ['T-3 (c)', 'T-4 (d)'] } },
      { ts: T(60), type: 'task.done', task: 'T-1' },
      { ts: T(90), type: 'task.done', task: 'T-2' },
    ];
    const f = path.join(st.S, 'events-replay.jsonl');
    fs.writeFileSync(f, `${evs.map((e) => JSON.stringify(e)).join('\r\n')}\r\n`); // CRLF on purpose
    const r = run(st.S, `node harness/plan-waves.mjs replay --events "${f}" --days 14 --json`, st.env);
    let j = null; try { j = JSON.parse(out(r)); } catch {}
    const txt = out(run(st.S, `node harness/plan-waves.mjs replay --events "${f}" --days 14`, st.env));
    const ok = j && j.overlapEvents === 3 && j.avoidedEvents === 2 && j.avoidedPairs === 1 && j.notAvoided === 1 && j.taskStarts === 4 && j.extraWallMs === 50 * 60000
      && /avoided 2 of them \(1 distinct task pair/.test(txt) && /50 min/.test(txt);
    return [ok, JSON.stringify({ j, txt })];
  });

  if (want('cli')) await guard('2.78.0 (PU-60): `node harness/plan-waves.mjs` and `--json` run on the studio\'s own board and print the waves and the serialized share; the fun-check module harness/waves.mjs is untouched (fails on 2.77.1: no planner)', async () => {
    const st = studio('cli');
    const a = run(st.S, 'node harness/plan-waves.mjs', st.env);
    const b = run(st.S, 'node harness/plan-waves.mjs --json', st.env);
    let j = null; try { j = JSON.parse(out(b)); } catch {}
    const fun = fs.readFileSync(path.join(st.S, 'harness', 'waves.mjs'), 'utf8');
    const ok = a.status === 0 && /^Waves for \d+ ready task/.test(out(a)) && /serialized: \d+ of \d+ ready/.test(out(a)) && j && Array.isArray(j.waves) && typeof j.serializedShare === 'number'
      && /Fun check in waves/.test(fun) && /export function joinWave/.test(fun);
    return [ok, JSON.stringify({ a: out(a), b: out(b).slice(0, 600) })];
  });
}
