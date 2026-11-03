/**
 * qa/selftest-272b.mjs — 2.72.0 (helper b): the purity ratchet, must-fail canaries for game checks, the two-round cap.
 *   ratchet   `npm run purity -- baseline --write --by <person>` records a made-up cartridge's standing purity hits
 *             (keys: file + rule + source line, not line numbers); the purity check then passes on them, still passes
 *             after the code moves, fails on ONE new hit and prints only it (Fix line: the ratchet's); a fixed hit
 *             shrinks the baseline (committed), and coming back it fails; a worker, a coding agent without a person's
 *             words, and a lane copy can't grow it; in a lane a hit the lane added to its own baseline still fails;
 *             the train's tier for a lane that grows it is C ("ratchet-grow"), for one that shrinks it not.
 *   ratchet check  a game check with "ratchet": true and a baseline section fails only on new hits; a crash with no
 *             hit line still fails.
 *   canaries  `npm run gates -- --canaries`: a check whose canary makes it fail is proven (command and fixture), one
 *             that stays green is silently green (event, digest line, one task in studio/HARNESS-TASKS.md), one with
 *             no canary unproven; exit 1. The slow tier runs them too.
 *   round cap two full verifies red on the same sub-id + first FAIL line hand the task back with the summary and the
 *             restart note; a third attempt in the session (task start, verify) is refused; another signature, a green
 *             between, STUDIO_ROUND_CAP=0 or a new session don't cap; a train hand-back counts as a round.
 * Made-up games in temp folders; no network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest272B({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, args) => { const e = { ...process.env, ...ident }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return spawnSync('git', args, { cwd, encoding: 'utf8', env: e }); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const nm = path.join(dir, 'node_modules');
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_GAME: '', STUDIO_REACHABILITY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_OVERLAP: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_ROUND_CAP: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_WORKAROUND_DETECT: 'off', STUDIO_SLOW_TIER: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', AGENT_EVENTS_MIRROR: '', ...ident,
  };
  let n = 0;
  const studio = (name) => {
    const S = path.join(tmpRoot, `272b-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/train', '.studio/locks', '.studio/ratchet', '.studio/gates']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    for (const x of ['.studio/workarounds.jsonl', '.studio/harness-tasks.json', '.studio/decisions.jsonl', 'studio/HARNESS-TASKS.md', 'studio/delegation.json']) fs.rmSync(path.join(S, x), { force: true });
    const ev = path.join(S, '.studio', 'events-272b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']); g(S, ['config', 'core.hooksPath', '/dev/null']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const probe = (S, code, env) => {
    const f = path.join(S, `.probe-272b-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(S, `node ${path.basename(f)}`, env);
    fs.rmSync(f, { force: true });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch {}
    return { ...(j || {}), _out: out(r).slice(-2500) };
  };
  const u = (S, p) => JSON.stringify(pathToFileURL(path.join(S, p)).href);
  const have = (S, p) => fs.existsSync(path.join(S, p));
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const entries = (S, rel, sec = 'purity') => readJson(path.join(S, rel))?.hits?.[sec] || [];

  // ---- A: the purity ratchet on a made-up cartridge ------------------------------------------------------------------
  const A = studio('a');
  const KILN = 'cartridges/kiln/logic.mjs';
  const BL = 'cartridges/kiln/purity-baseline.json';
  const kiln = (pre = '', extra = '') => `${pre}export function heat(s) {\n  s.t = Date.now();\n  s.roll = Math.random();\n  s.spark = Math.random();\n  return s;\n}\n${extra}`;
  fs.mkdirSync(path.join(A.S, 'cartridges', 'kiln'), { recursive: true });
  fs.writeFileSync(path.join(A.S, KILN), kiln());
  g(A.S, ['add', '-A']); g(A.S, ['commit', '-qm', 'kiln with standing hits', '--no-verify']);
  const purity = (S, env) => run(S, 'node scripts/check-sim-purity.mjs', env);

  const before = purity(A.S, A.env);
  const w = run(A.S, 'node harness/purity.mjs baseline --write --by dana', A.env);
  const bl = entries(A.S, BL);
  const committed = g(A.S, ['log', '-1', '--format=%s', '--', BL]).stdout.trim();
  await guard('272b ratchet: `npm run purity -- baseline --write --by <person>` records the cartridge\'s 3 standing hits in cartridges/<name>/purity-baseline.json, keyed by file + rule + source line (no line number), and commits it (fails on 2.71.1: no purity command, no baseline)', () => [
    before.status !== 0 && w.status === 0 && bl.length === 3 && bl.every((e) => e.file === KILN && !('line' in e) && /Math\.random|Date\.now/.test(e.snippet)) && /purity baseline/.test(committed),
    `${out(before).slice(-400)}\n---\n${out(w).slice(-600)}\n${JSON.stringify(bl)}\ncommit: ${committed}`]);
  const pass1 = purity(A.S, A.env);
  await guard('272b ratchet: with the baseline the purity check passes on the standing hits and says how many stand (fails on 2.71.1: every hit fails)', () => [
    pass1.status === 0 && /no new hit; 3 standing hit/.test(out(pass1)), out(pass1).slice(-800)]);
  fs.writeFileSync(path.join(A.S, KILN), kiln('// moved down\n\n\n'));
  const moved = purity(A.S, A.env);
  await guard('272b ratchet: a hit that only moved (3 lines down) keeps its key: still green (fails on 2.71.1)', () => [moved.status === 0, out(moved).slice(-600)]);
  fs.writeFileSync(path.join(A.S, KILN), kiln('// moved down\n\n\n', 'export const late = () => setTimeout(() => 1, 5);\n'));
  const fresh = purity(A.S, A.env);
  const fix = probe(A.S, `import { gateFix } from ${u(A.S, 'harness/gate-fix.mjs')}; console.log(JSON.stringify(gateFix({ id: 'purity' }, { output: ${JSON.stringify(out(fresh))} })));`, A.env);
  const xLines = [...new Set(out(fresh).split('\n').filter((l) => /^\s+x /.test(l)))];
  await guard('272b ratchet: ONE new hit fails the check and only that hit is printed (the 3 standing ones are counted, not shown); the gate\'s Fix line is the ratchet\'s (fix it, never grow the baseline) (fails on 2.71.1: all 4 printed, generic Fix)', () => [
    fresh.status !== 0 && xLines.length === 1 && /NO_TIMERS/.test(xLines[0]) && /3 standing hit/.test(out(fresh)) && fix.source === 'ratchet' && /never grows from a lane/.test(fix.text || ''),
    `${out(fresh).slice(-900)}\n${JSON.stringify(fix).slice(0, 500)}`]);
  // Fix one standing hit (the second Math.random line) and drop the new one: the baseline shrinks.
  fs.writeFileSync(path.join(A.S, KILN), kiln('// moved down\n\n\n').replace('  s.spark = Math.random();\n', ''));
  g(A.S, ['commit', '-qam', 'fix one hit', '--no-verify']);
  const sh = probe(A.S, `import { shrinkAtDone } from ${u(A.S, 'harness/ratchet.mjs')}; const r = shrinkAtDone({ task: 'T-777', agent: 'claude-k' }); console.log(JSON.stringify(r));`, A.env);
  const after = entries(A.S, BL);
  const shrinkMsg = g(A.S, ['log', '-1', '--format=%s', '--', BL]).stdout.trim();
  const taskSrc = fs.readFileSync(path.join(A.S, 'harness', 'task.mjs'), 'utf8');
  fs.writeFileSync(path.join(A.S, KILN), kiln('// moved down\n\n\n'));
  const back = purity(A.S, A.env);
  await guard('272b ratchet: a fixed hit shrinks the baseline at task done (committed: "<task>: purity baseline smaller"), and when it comes back it fails (fails on 2.71.1)', () => [
    sh.removed === 1 && after.reduce((k, e) => k + e.count, 0) === 2 && /^T-777: purity baseline smaller/.test(shrinkMsg) && /shrinkAtDone\(\{ root: REPO_ROOT, task: target\.id, agent \}\)/.test(taskSrc) && back.status !== 0 && /NO_MATH_RANDOM/.test(out(back)),
    `${JSON.stringify(sh)}\n${JSON.stringify(after)}\n${shrinkMsg}\n${out(back).slice(-500)}`]);
  g(A.S, ['checkout', '--', KILN]);
  // Who may grow it: add a hit, then try as a worker, as a coding agent without words, with words.
  fs.writeFileSync(path.join(A.S, KILN), kiln('// moved down\n\n\n', 'export const w = () => performance.now();\n').replace('  s.spark = Math.random();\n', ''));
  g(A.S, ['commit', '-qam', 'a new hit', '--no-verify']);
  const asWorker = run(A.S, 'node harness/purity.mjs baseline --write --by builder-3', { ...A.env, STUDIO_LOCK_OWNER: 'builder-3' });
  const asAgent = run(A.S, 'node harness/purity.mjs baseline --write --by opus-o', { ...A.env, CLAUDECODE: '1' });
  const unchanged = entries(A.S, BL).length;
  const withWords = run(A.S, 'node harness/purity.mjs baseline --write --by opus-o --permission "dana in chat: record the timer hit, the port needs it"', { ...A.env, CLAUDECODE: '1' });
  const grown = entries(A.S, BL).reduce((k, e) => k + e.count, 0);
  const dec = String(fs.existsSync(path.join(A.S, '.studio', 'decisions.jsonl')) ? fs.readFileSync(path.join(A.S, '.studio', 'decisions.jsonl'), 'utf8') : '');
  await guard('272b ratchet: growing the baseline is a person\'s call: a worker is refused, a coding agent without a person\'s words is refused (nothing written), with --permission it is written and logged as a decision (fails on 2.71.1)', () => [
    asWorker.status !== 0 && /worker/.test(out(asWorker)) && asAgent.status !== 0 && /--permission/.test(out(asAgent)) && unchanged === 2 && withWords.status === 0 && grown === 3 && /purity-baseline/.test(dec),
    `${out(asWorker).slice(-300)}\n${out(asAgent).slice(-400)}\n${out(withWords).slice(-300)}\n${grown}`]);
  // A lane copy: it can't write, and a hit it lists in its own baseline still fails there; the train holds it as tier C.
  const L = path.join(tmpRoot, `272b-lane-${process.pid}`);
  g(A.S, ['worktree', 'add', '-q', '-b', 'lane-k', L]);
  const laneEnv = { ...A.env, STUDIO_MAIN_ROOT: A.S };
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(L, 'node_modules'), 'junction'); } catch {} }
  const laneWrite = run(L, 'node harness/purity.mjs baseline --write --by dana', laneEnv);
  fs.writeFileSync(path.join(L, KILN), `${fs.readFileSync(path.join(L, KILN), 'utf8')}export const v = () => crypto.randomUUID();\n`);
  const lb = readJson(path.join(L, BL)) || {};
  lb.hits = lb.hits || {}; lb.hits.purity = lb.hits.purity || [];
  lb.hits.purity.push({ file: KILN, rule: 'NO_CRYPTO_RANDOM', snippet: 'export const v = () => crypto.randomUUID();', count: 1 });
  fs.writeFileSync(path.join(L, BL), `${JSON.stringify(lb, null, 2)}\n`);
  g(L, ['commit', '-qam', 'lane: a new hit and its own baseline line', '--no-verify']);
  const lanePur = purity(L, laneEnv);
  const growHead = g(L, ['rev-parse', 'HEAD']).stdout.trim();
  await guard('272b ratchet: in a lane copy `baseline --write` is refused, and a new hit the lane added to its own baseline still fails (only the studio\'s branch\'s baseline counts there), with a note saying why (fails on 2.71.1)', () => [
    laneWrite.status !== 0 && /lane/.test(out(laneWrite)) && lanePur.status !== 0 && /NO_CRYPTO_RANDOM/.test(out(lanePur)) && /doesn't count here|don't count here/.test(out(lanePur)) && !/x .*NO_WALL_CLOCK/.test(out(lanePur)),
    `${out(laneWrite).slice(-300)}\n---\n${out(lanePur).slice(-900)}`]);
  // A second lane that only shrinks (fixes the performance hit and records that).
  g(L, ['checkout', '-q', '-b', 'lane-s', 'main']);
  fs.writeFileSync(path.join(L, KILN), fs.readFileSync(path.join(L, KILN), 'utf8').replace('export const w = () => performance.now();\n', ''));
  g(L, ['commit', '-qam', 'lane: fix the timer hit', '--no-verify']);
  run(L, 'node harness/purity.mjs baseline --shrink', laneEnv);
  const shrinkHead = g(L, ['rev-parse', 'HEAD']).stdout.trim();
  const tiers = probe(A.S, `import { laneTier } from ${u(A.S, 'harness/train.mjs')}; const tip = ${JSON.stringify(g(A.S, ['rev-parse', 'main']).stdout.trim())}; const a = await laneTier(process.cwd(), { head: ${JSON.stringify(growHead)} }, { tip }); const b = await laneTier(process.cwd(), { head: ${JSON.stringify(shrinkHead)} }, { tip }); console.log(JSON.stringify({ a: { tier: a.tier, rules: a.rules }, b: { tier: b.tier, rules: b.rules } }));`, A.env);
  await guard('272b ratchet: the merge train puts a lane that grows a purity baseline in tier C ("ratchet-grow"); a lane that only shrinks it is not held for that (fails on 2.71.1: tier B either way)', () => [
    tiers.a?.tier === 'C' && tiers.a.rules.includes('ratchet-grow') && tiers.b && !tiers.b.rules.includes('ratchet-grow') && tiers.b.tier !== 'C', JSON.stringify(tiers).slice(0, 1500)]);
  g(A.S, ['worktree', 'remove', '--force', L]);

  // ---- B: a studio game with a ratchet check and canaries -----------------------------------------------------------
  const B = studio('b');
  const genv = { ...B.env, STUDIO_GAME: 'pond' };
  const P = (p) => path.join(B.S, 'game', 'pond', p);
  fs.mkdirSync(P('src'), { recursive: true }); fs.mkdirSync(P('tools/canary'), { recursive: true }); fs.mkdirSync(P('test'), { recursive: true }); fs.mkdirSync(P('canary'), { recursive: true });
  // A made-up lint: every `var ` is a hit; --dir <d> lints another folder; --crash exits 2 with no hit line.
  fs.writeFileSync(P('tools/lint.mjs'), `import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2); if (a.includes('--crash') || process.env.POND_CRASH) { console.error('lint: config not found'); process.exit(2); }
const d = a.includes('--dir') ? a[a.indexOf('--dir') + 1] : 'game/pond/src'; let n = 0;
for (const f of fs.readdirSync(d)) fs.readFileSync(path.join(d, f), 'utf8').split('\\n').forEach((l, i) => { if (/\\bvar /.test(l)) { console.log(path.join(d, f).split(path.sep).join('/') + ':' + (i + 1) + ':1: no var allowed [no-var]'); n++; } });
process.exit(n ? 1 : 0);\n`);
  fs.writeFileSync(P('tools/smoke.mjs'), "console.log('smoke: ok');\n");
  fs.writeFileSync(P('tools/canary/bad.mjs'), 'var broken = 1;\n');
  fs.writeFileSync(P('src/fish.mjs'), 'var a = 1;\nvar b = 2;\nexport const c = a + b;\n');
  fs.writeFileSync(P('test/fish.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; test('fish', () => assert.equal(1, 1));\n");
  fs.writeFileSync(P('canary/bad.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; test('must fail', () => assert.equal(1, 2));\n");
  fs.writeFileSync(P('studio.gates.json'), JSON.stringify({ gates: [
    { id: 'lint', command: 'node game/pond/tools/lint.mjs', ratchet: true, canary: 'node game/pond/tools/lint.mjs --dir game/pond/tools/canary' },
    { id: 'unit', command: 'node --test game/pond/test/fish.test.mjs', canary: 'game/pond/canary/bad.test.mjs' },
    { id: 'smoke', command: 'node game/pond/tools/smoke.mjs', canary: 'node game/pond/tools/smoke.mjs --broken' },
    { id: 'docs', command: 'node game/pond/tools/smoke.mjs' },
  ] }, null, 2));
  g(B.S, ['add', '-A']); g(B.S, ['commit', '-qm', 'pond', '--no-verify']);
  const gg = (env = genv) => run(B.S, 'node harness/game-gates.mjs --paths game/pond/src/fish.mjs', env);
  const noBase = gg();
  const wb = run(B.S, 'node harness/purity.mjs baseline --write --by dana --check game:lint', genv);
  const withBase = gg();
  fs.writeFileSync(P('src/fish.mjs'), 'var a = 1;\nvar b = 2;\nvar d = 3;\nexport const c = a + b + d;\n');
  const newHit = gg();
  fs.writeFileSync(P('src/fish.mjs'), 'var a = 1;\nvar b = 2;\nexport const c = a + b;\n');
  const crash = gg({ ...genv, POND_CRASH: '1' });
  await guard('272b ratchet check: a game check with "ratchet": true fails on its 2 standing hits with no baseline, passes once they are recorded (game/<g>/purity-baseline.json section "game:lint"), fails on ONE new hit naming only it, and a crash with no hit line still fails (fails on 2.71.1: red with the baseline)', () => [
    noBase.status !== 0 && wb.status === 0 && entries(B.S, 'game/pond/purity-baseline.json', 'game:lint').length === 2 && withBase.status === 0 && /PASS game:lint/.test(out(withBase))
      && newHit.status !== 0 && /1 new hit/.test(out(newHit)) && /fish\.mjs:3:1/.test(out(newHit)) && !/fish\.mjs:1:1/.test(out(newHit).split('NEW')[1] || '') && crash.status !== 0 && /no hit line/.test(out(crash)),
    [noBase, wb, withBase, newHit, crash].map((r) => `exit ${r.status}: ${out(r).split('\n').filter((l) => /\[(game-gates\] (PASS|FAIL|WARN)|ratchet|purity)/.test(l)).join('\n')}`).join('\n---\n')]);
  const canMod = have(B.S, 'harness/canaries.mjs');
  const can = canMod ? run(B.S, 'node scripts/run-gates.mjs --canaries', genv) : { status: null, stdout: 'harness/canaries.mjs is missing', stderr: '' };
  const ev = events(B.ev);
  const md = have(B.S, 'studio/HARNESS-TASKS.md') ? fs.readFileSync(path.join(B.S, 'studio', 'HARNESS-TASKS.md'), 'utf8') : '';
  const dg = canMod ? probe(B.S, `import { buildDigest } from ${u(B.S, 'harness/digest.mjs')}; const d = await buildDigest({}); console.log(JSON.stringify({ text: d.text }));`, genv) : {};
  await guard('272b canaries: `npm run gates -- --canaries` proves a check whose command canary makes it fail and one whose fixture canary does (node --test with the fixture appended), reports a check that stays green on its canary as SILENTLY GREEN (gate.silently_green event, one task in studio/HARNESS-TASKS.md, a digest line) and one with no canary as UNPROVEN; exit 1 (fails on 2.71.1: no --canaries)', () => [
    can.status === 1 && /PROVEN game:lint/.test(out(can)) && /PROVEN game:unit/.test(out(can)) && /SILENTLY GREEN game:smoke/.test(out(can)) && /UNPROVEN game:docs/.test(out(can))
      && ev.some((e) => e.type === 'gate.silently_green' && e.meta?.gate === 'game:smoke') && /game:smoke/.test(md) && /Canaries \(pond\): 2 proven, 1 silently green \(game:smoke/.test(dg.text || ''),
    `${out(can).slice(-1200)}\n${md.slice(0, 400)}\n${String(dg.text || dg._out || '').slice(-600)}`]);
  const slow = canMod ? probe(B.S, `import { runSlowTier } from ${u(B.S, 'harness/slow-tier.mjs')}; const r = await runSlowTier({ root: process.cwd(), log: () => {} }); console.log(JSON.stringify({ canaries: r.canaries }));`, genv) : {};
  await guard('272b canaries: the slow tier runs the canaries too (a game with canaries and no slow tier still gets them) and its result counts them (fails on 2.71.1)', () => [
    slow.canaries?.silent === 1 && slow.canaries?.proven === 2 && slow.canaries?.unproven === 1, JSON.stringify(slow).slice(0, 800)]);

  // ---- C: the two-round cap -----------------------------------------------------------------------------------------
  const C = studio('c');
  const cenv = { ...C.env, STUDIO_LOCK_OWNER: 'claude-r' };
  const start = (env = cenv, extra = '') => run(C.S, `node harness/task.mjs start T-003 --agent claude-r${extra}`, env);
  const red = (fail, env = cenv) => probe(C.S, `import { verifyRound } from ${u(C.S, 'harness/round-cap.mjs')}; const r = await verifyRound({ ok: false, failGate: 'game', failText: ${JSON.stringify(fail)}, log: (m) => console.error(m) }); console.log(JSON.stringify(r || {}));`, env);
  const green = (env = cenv) => probe(C.S, `import { verifyRound } from ${u(C.S, 'harness/round-cap.mjs')}; const r = await verifyRound({ ok: true }); console.log(JSON.stringify(r || {}));`, env);
  const F1 = '[game-gates] FAIL game:unit: exit 1: FAIL src/pay.test.ts > pays 3 coins (12 ms)\n FAIL src/pay.test.ts > pays 3 coins\n AssertionError: expected 3 to be 4';
  const F1b = '[game-gates] FAIL game:unit: exit 1: FAIL src/pay.test.ts > pays 3 coins (40 ms)\n FAIL src/pay.test.ts > pays 3 coins\n AssertionError: expected 3 to be 4';
  const F2 = '[game-gates] FAIL game:lint: exit 1: src/a.ts:3:1: no var [no-var]';
  const st = start();
  const r1 = red(F1);
  const r2 = red(F2);
  const r3 = red(F1);
  const g4 = green();
  const r5 = red(F1);
  const diffNoCap = !r1.capped && !r2.capped && !r3.capped && !r5.capped;
  const r6 = red(F1b);
  const board = fs.readFileSync(path.join(C.S, 'studio', 'NEXT.md'), 'utf8');
  const hand = (() => { try { return fs.readFileSync(path.join(C.S, 'studio', 'handoffs', 'T-003.md'), 'utf8'); } catch { return ''; } })();
  const capEv = events(C.ev).filter((e) => e.type === 'task.round_cap');
  await guard('272b round cap: red, other red, red, green, red don\'t cap; two full verifies red in a row on the same sub-id and first FAIL line (times differ) hand the task back with the harness\'s facts, the sub-id, both red signatures, the decisions and "restart from the spec" (one task.round_cap event) (fails on 2.71.1)', () => [
    st.status === 0 && diffNoCap && r6.capped === true && r6.handedBack === true && !/T-003/.test(board.split('## BACKLOG')[0]) && /T-003/.test((board.split('## BACKLOG')[1] || '').split('## DONE')[0])
      && /Round cap \(STUDIO_ROUND_CAP=2\)/.test(hand) && /Sub-id: game:unit/.test(hand) && /Red 2 \(verify/.test(hand) && /restart from the spec/.test(hand) && /Hand-back facts/.test(hand) && /Decisions on T-003/.test(hand) && capEv.length === 1,
    `${out(st).slice(-300)}\n${JSON.stringify({ r1, r2, r3, g4, r5, r6 }).slice(0, 900)}\n${hand.slice(-1200)}`]);
  const again = start();
  const forced = start(cenv, ' --force');
  const vr = run(C.S, 'node scripts/run-gates.mjs --only docs --no-detach', cenv);
  await guard('272b round cap: a third attempt in the same session is refused: task start of the task (round-cap) and, while the agent still holds it (a person\'s --force reassignment), npm run verify, before any gate runs (fails on 2.71.1)', () => [
    again.status !== 0 && /round cap/.test(out(again)) && forced.status === 0 && vr.status !== 0 && /refused \(STUDIO_ROUND_CAP\)/.test(out(vr)) && !/PASS docs/.test(out(vr)),
    `${out(again).slice(-500)}\n---\n${out(vr).slice(-500)}`]);
  fs.appendFileSync(C.ev, `${JSON.stringify({ id: `evt_272b_${Date.now()}`, ts: new Date(Date.now() + 1000).toISOString(), type: 'agent.session.start', agent: 'claude-r', status: 'running', msg: 'new session', meta: {} })}\n`);
  const vr2 = run(C.S, 'node scripts/run-gates.mjs --only docs --no-detach', cenv);
  const off1 = red(F1, { ...cenv, STUDIO_ROUND_CAP: '0' });
  const off2 = red(F1, { ...cenv, STUDIO_ROUND_CAP: '0' });
  await guard('272b round cap: a new session may verify the task again, and STUDIO_ROUND_CAP=0 never caps (fails on 2.71.1)', () => [
    vr2.status === 0 && /PASS docs/.test(out(vr2)) && off1.capped === false && off2.capped === false && !events(C.ev).filter((e) => e.type === 'task.round_cap').slice(1).length,
    `${out(vr2).slice(-400)}\n${JSON.stringify({ off1, off2 })}`]);
  const tr = probe(C.S, `import { trainRound } from ${u(C.S, 'harness/train.mjs')}; const lane = { task: 'T-004', agent: 'claude-s' }; const a = trainRound(lane, 'red in a full verify (game): FAIL src/x.test.ts > y (3 s)'); const b = trainRound(lane, 'red in a full verify (game): FAIL src/x.test.ts > y (9 s)'); console.log(JSON.stringify({ a: a?.capped, b: b?.capped, note: b?.note || '' }));`, C.env);
  await guard('272b round cap: a merge-train hand-back is a round too: the second train red on the same failure caps it and the hand-back gets the summary (fails on 2.71.1: no trainRound)', () => [
    tr.a === false && tr.b === true && /restart from the spec/.test(tr.note || ''), JSON.stringify(tr).slice(0, 1200)]);
}
