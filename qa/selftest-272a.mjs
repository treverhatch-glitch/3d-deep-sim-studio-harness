/**
 * qa/selftest-272a.mjs — 2.72.0 (a): better reds, less noise.
 *   (1) first divergence: a red golden (qa/check-golden.mjs) re-runs the sim in lockstep with the commit that recorded
 *       it, a cheap per-subsystem digest per tick, and prints "first divergence: tick N, <subsystem>.<field> a -> b"
 *       (only on a red); the line reaches the gates.run event and the hand-back facts; the generic contract for a game
 *       (studio.gates.json "divergence": { command, state }) compares per-tick JSON digest lines from both trees;
 *   (2) sub-ids: the game gate's failures are named as game:<check>:<file> (and golden:<file>) in the row, the
 *       gates.run event (meta.subIds; meta.failed unchanged), the hand-back facts and the train's events;
 *   (3) a red whose ONLY failures are per-test timeouts re-runs just those files alone at low load: green alone ->
 *       "timeout-flake" (flakes.jsonl, the digest), the check green for those files only; red alone -> red; mixed -> red;
 *       STUDIO_TIMEOUT_RERUN=off keeps 2.71.1. Made-up games; real `node --test` timeouts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest272A({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const events = path.join(dir, '.studio', 'events-272a.jsonl');
  const ranLog = path.join(tmpRoot, `ran-272a-${process.pid}.log`);
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const env = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_GAME_GATE_RETRY: '', STUDIO_TEST_WORKERS: '4', AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gameEnv = { ...env, STUDIO_GAME: 'demo' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const clearEvents = () => { try { fs.rmSync(events, { force: true }); } catch {} };
  const ran = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')); } catch { return []; } };
  const clearRan = () => { try { fs.rmSync(ranLog, { force: true }); } catch {} };
  const probe = (name, code, extra = {}) => {
    const f = path.join(dir, `.probe-272a-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...extra });
    try { fs.rmSync(f, { force: true }); } catch {}
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return JSON.parse(line); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const g = (...x) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.hooksPath=/dev/null', ...x], { cwd: dir, encoding: 'utf8' });
  const lastGatesRun = () => evs().filter((e) => e.type === 'gates.run').pop() || null;
  const flakeRows = () => read('.studio/flakes.jsonl').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // ---- the made-up game "demo": a tiny sim with two subsystems, its golden, its digest trace (the contract) ----
  write('studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'golden', cartridge: true, command: 'node qa/check-golden.mjs', required: true, lite: true },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write('game/demo/sim.mjs', [
    'const BUG = false;',
    'export function make() { return { economy: { fees: 3, cash: 100 }, crowd: { n: 10 } }; }',
    'export function step(s, t) {',
    '  const fee = s.economy.fees + (BUG && t === 31 ? 1 : 0);',
    '  return { economy: { fees: fee, cash: s.economy.cash + fee }, crowd: { n: s.crowd.n + (t % 7 === 0 ? 1 : 0) } };',
    '}',
    'export function run(ticks, onTick = () => {}) { let s = make(); for (let t = 1; t <= ticks; t++) { s = step(s, t); onTick(t, s); } return s; }', ''].join('\n'));
  write('game/demo/digest.mjs', [
    "export const dig = (v) => { const s = JSON.stringify(v); let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };", ''].join('\n'));
  write('game/demo/golden.mjs', [
    "import fs from 'node:fs'; import { run } from './sim.mjs'; import { dig } from './digest.mjs';",
    "const want = JSON.parse(fs.readFileSync('game/demo/golden.json', 'utf8')).hash;",
    'const got = dig(run(50));',
    "if (got !== want) { console.log(`FAIL golden: hash expected ${want} got ${got}`); process.exit(1); }",
    "console.log('golden ok');", ''].join('\n'));
  write('game/demo/trace.mjs', [
    "import { run } from './sim.mjs'; import { dig } from './digest.mjs';",
    "const at = process.argv.includes('--state') ? Number(process.argv[process.argv.indexOf('--state') + 1]) : null;",
    "run(50, (t, s) => { if (at === null) console.log(JSON.stringify({ run: 'g50', tick: t, digests: { economy: dig(s.economy), crowd: dig(s.crowd) } })); else if (t === at) console.log(JSON.stringify(s)); });", ''].join('\n'));
  {
    const { run: simRun } = await import(pathToFileURL(path.join(dir, 'game/demo/sim.mjs')).href);
    const { dig } = await import(pathToFileURL(path.join(dir, 'game/demo/digest.mjs')).href);
    write('game/demo/golden.json', `${JSON.stringify({ hash: dig(simRun(50)) })}\n`);
  }
  write('game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'golden', command: 'node game/demo/golden.mjs' }], divergence: { command: 'node game/demo/trace.mjs', state: 'node game/demo/trace.mjs --state {tick}', goldens: ['game/demo/golden.json'] } }, null, 2)}\n`);
  if (!fs.existsSync(path.join(dir, '.git'))) g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  g('add', '-A'); g('commit', '-qm', 'studio', '--no-verify');
  const base = g('rev-parse', 'HEAD').stdout.trim();

  // ---- (1) first divergence, cartridge goldens ----
  const goodGolden = run(dir, 'node qa/check-golden.mjs', env);
  const idx = path.join(dir, 'cartridges/example-sim/index.mjs');
  const orig = fs.readFileSync(idx, 'utf8');
  fs.writeFileSync(idx, orig.replace('state.resources.credits += t.baseIncome + units', 'state.resources.credits += (state.tick === 23 ? 1 : 0) + t.baseIncome + units'));
  clearEvents();
  const red = run(dir, 'node qa/check-golden.mjs', env);
  const redText = out(red);
  const offRed = run(dir, 'node qa/check-golden.mjs', { ...env, STUDIO_GOLDEN_DIVERGENCE: 'off' });
  const div = evs().filter((e) => e.type === 'golden.divergence');
  const line1 = redText.split('\n').find((l) => l.includes('first divergence:') && l.includes('example-1337.json')) || '';
  report('2.72.0 (a, 1): a red golden prints where the run first went wrong, from a lockstep re-run against the commit that recorded it (per-subsystem digest per tick, only on the red): "first divergence: tick 23, resources.credits 1936 -> 1937 (subsystem resources; example-1337.json vs <ref>...)" plus a divergence-json line and a golden.divergence event; the reference reproduces the golden; a green run and STUDIO_GOLDEN_DIVERGENCE=off print no such line (fails on 2.71.1: a red golden said only "sha256 expected ... got ...")',
    goodGolden.status === 0 && !/first divergence/.test(out(goodGolden)) && red.status === 1
      && /^\[golden\] first divergence: tick 23, resources\.credits 1936 -> 1937 \(subsystem resources; example-1337\.json vs [0-9a-f]{8}, the commit that recorded it\)$/.test(line1)
      && line1.includes(base.slice(0, 8)) && /divergence-json \{.*"tick":23.*"reproduces":true/.test(redText)
      && div.length === 2 && div.every((e) => e.meta?.tick === 23 && e.meta?.subsystem === 'resources' && e.meta?.field === 'resources.credits' && e.meta?.ref === base)
      && offRed.status === 1 && !/first divergence/.test(out(offRed)),
    `${redText.slice(-1500)}\n${JSON.stringify(div.map((e) => e.meta))}`);

  // run-gates: the divergence and the golden's sub-id reach the row, the gates.run event and the hand-back facts.
  clearEvents();
  const vg = run(dir, 'node scripts/run-gates.mjs --no-detach --only golden', env);
  const vgText = out(vg);
  const vgEv = lastGatesRun();
  const vgLog = path.join(tmpRoot, `vg-272a-${process.pid}.log`);
  fs.writeFileSync(vgLog, vgText);
  const facts1 = probe('facts1', `import fs from 'node:fs';
import { readGateLog, renderFacts } from ${u('harness/handback-facts.mjs')};
const text = fs.readFileSync(${JSON.stringify(vgLog)}, 'utf8');
const r = readGateLog(text);
console.log(JSON.stringify({ r, block: renderFacts({ files: [], total: 0, base: 'abcdef12', gates: r.gates, where: 'x', at: 0, signature: null, seed: r.seed, log: 'l', subIds: r.subIds, divergence: r.divergence }) }));
`);
  report('2.72.0 (a, 1): through run-gates, the golden row carries the divergence and its sub-ids (golden:example-1337.json, golden:example-sim-start-to-win.json), the gates.run event has meta.divergence (tick 23, resources) and meta.subIds beside meta.failed ["golden"], and the hand-back facts say "- First divergence: tick 23, resources.credits 1936 -> 1937 (subsystem resources; example-1337.json) vs <ref>" and "- Failing sub-ids: golden:..." (fails on 2.71.1: neither existed)',
    vg.status === 1 && JSON.stringify(vgEv?.meta?.failed) === '["golden"]' && vgEv?.meta?.subIds?.includes('golden:example-1337.json') && vgEv.meta.subIds.includes('golden:example-sim-start-to-win.json')
      && vgEv.meta.divergence?.[0]?.tick === 23 && vgEv.meta.divergence[0].subsystem === 'resources'
      && /\n- First divergence: tick 23, resources\.credits 1936 -> 1937 \(subsystem resources; example-1337\.json\) vs [0-9a-f]{8}\n/.test(facts1.block || '')
      && /\n- Failing sub-ids: golden:example-1337\.json, golden:example-sim-start-to-win\.json\n/.test(facts1.block || ''),
    `${vgText.slice(-1200)}\n${JSON.stringify(vgEv?.meta)}\n${JSON.stringify(facts1).slice(0, 1500)}`);
  fs.writeFileSync(idx, orig);

  // ---- (1) the generic contract: a game's per-tick JSON digest lines, compared by the harness ----
  const simFile = path.join(dir, 'game/demo/sim.mjs');
  const simOrig = fs.readFileSync(simFile, 'utf8');
  fs.writeFileSync(simFile, simOrig.replace('const BUG = false;', 'const BUG = true;'));
  clearEvents();
  const gd = run(dir, 'node harness/game-gates.mjs', gameEnv);
  const gdText = out(gd);
  const wts = g('worktree', 'list', '--porcelain').stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
  report('2.72.0 (a, 1): a game\'s red golden check with "divergence": { command, state } in its manifest: the harness runs the command on this tree and on the reference commit (the last commit of "goldens", in a detached worktree it removes afterwards), compares the per-tick digest lines, names the field from the "state" command: "[game-gates] first divergence: tick 31, economy.fees 3 -> 4 (subsystem economy; game:golden, run g50 vs <ref>, ...)" and a golden.divergence event (fails on 2.71.1: no contract)',
    gd.status === 1 && /\[game-gates\] first divergence: tick 31, economy\.fees 3 -> 4 \(subsystem economy; game:golden, run g50 vs [0-9a-f]{8}, the commit that recorded it\)/.test(gdText)
      && evs().some((e) => e.type === 'golden.divergence' && e.meta?.gate === 'game:golden' && e.meta?.tick === 31 && e.meta?.field === 'economy.fees' && e.meta?.ref === base) && wts === 1,
    `${gdText.slice(-1500)}\nworktrees=${wts}`);
  fs.writeFileSync(simFile, simOrig);

  // ---- (2) sub-ids for the game gate ----
  write('game/demo/vt.mjs', [
    "console.log(' \\u276f src/econ/fees.test.ts (3 tests | 1 failed) 12ms');",
    "console.log('\\u23af\\u23af\\u23af Failed Tests 1 \\u23af\\u23af\\u23af');",
    "console.log(' FAIL  src/econ/fees.test.ts > fees > charges the gate fee once');",
    "console.log('AssertionError: expected 7 to be 6');",
    "console.log(' Test Files  1 failed | 4 passed (5)');",
    "console.log('      Tests  1 failed | 20 passed (21)');",
    'process.exit(1);', ''].join('\n'));
  write('game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'test', command: 'node game/demo/vt.mjs' }, { id: 'lint', command: 'node -e "process.exit(0)"' }] }, null, 2)}\n`);
  clearEvents();
  const sv = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', gameEnv);
  const svText = out(sv);
  const svEv = lastGatesRun();
  let rowSub = null;
  try { rowSub = JSON.parse(read('.studio/gates-last.json')).rows.find((r) => r.id === 'game')?.sub; } catch {}
  const svLog = path.join(tmpRoot, `sv-272a-${process.pid}.log`);
  fs.writeFileSync(svLog, svText);
  const sp = probe('subids', `import fs from 'node:fs';
import { readGateLog, renderFacts } from ${u('harness/handback-facts.mjs')};
import { trainVerifyParts } from ${u('harness/train.mjs')};
import { subIdsFor, subIdsOf } from ${u('harness/gate-subids.mjs')};
const text = fs.readFileSync(${JSON.stringify(svLog)}, 'utf8');
const r = readGateLog(text);
const tap = "not ok 1 - crate ids\\n  ---\\n  location: 'C:\\\\\\\\g\\\\\\\\t\\\\\\\\crates.test.mjs:3:1'\\n  failureType: 'testCodeFailure'\\n  ...\\n# fail 1";
console.log(JSON.stringify({ sub: r.subIds, train: trainVerifyParts(text, false).subIds, block: renderFacts({ files: [], total: 0, base: 'abcdef12', gates: r.gates, where: 'x', at: 0, signature: null, seed: null, log: 'l', subIds: r.subIds }),
  plain: subIdsFor('game', '[game-gates] FAIL game:layout: a wall crosses the runway'), other: subIdsFor('selftest', tap), none: subIdsFor('docs', 'broken link'), of: subIdsOf({ meta: { failed: ['game'] } }) }));
`);
  report('2.72.0 (a, 2): the game gate\'s failure is named by its parts: the row\'s sub, the gates.run event\'s meta.subIds (meta.failed stays ["game"]), a "[gates] game failed in:" line, the hand-back facts ("- Failing sub-ids: game:test:src/econ/fees.test.ts") and the train\'s verify parts all say game:test:src/econ/fees.test.ts; a check with no files is its id (game:layout), another gate\'s node --test file reads as <gate>:<file> (Windows path), nothing finer is the gate id (fails on 2.71.1: 83 of 91 reds were just "game")',
    sv.status === 1 && JSON.stringify(svEv?.meta?.failed) === '["game"]' && JSON.stringify(svEv?.meta?.subIds) === '["game:test:src/econ/fees.test.ts"]' && JSON.stringify(rowSub) === '["game:test:src/econ/fees.test.ts"]'
      && /^\[gates\] game failed in: game:test:src\/econ\/fees\.test\.ts$/m.test(svText) && /^\[gates\] FAIL game$/m.test(svText)
      && JSON.stringify(sp.sub) === '["game:test:src/econ/fees.test.ts"]' && JSON.stringify(sp.train) === '["game:test:src/econ/fees.test.ts"]' && /\n- Failing sub-ids: game:test:src\/econ\/fees\.test\.ts\n/.test(sp.block || '')
      && JSON.stringify(sp.plain) === '["game:layout"]' && JSON.stringify(sp.other) === '["selftest:C:/g/t/crates.test.mjs"]' && JSON.stringify(sp.none) === '["docs"]' && JSON.stringify(sp.of) === '["game"]',
    `${svText.slice(-1200)}\n${JSON.stringify(svEv?.meta)}\nrow=${JSON.stringify(rowSub)}\n${JSON.stringify(sp).slice(0, 1500)}`);

  // ---- (3) the timeout parsers: vitest, jest (synthetic), node --test (real) ----
  write('game/demo/nt/slow.test.mjs', "import test from 'node:test';\ntest('slow one', { timeout: 60 }, async () => { await new Promise((r) => setTimeout(r, 400)); });\ntest('fine', () => {});\n");
  write('game/demo/nt/bad.test.mjs', "import test from 'node:test'; import assert from 'node:assert';\ntest('adds', () => { assert.equal(1, 2); });\n");
  const ntOnly = run(dir, 'node --test --test-reporter=tap game/demo/nt/slow.test.mjs', env);
  const ntMixed = run(dir, 'node --test --test-reporter=tap game/demo/nt/slow.test.mjs game/demo/nt/bad.test.mjs', env);
  const ntSpec = run(dir, 'node --test --test-reporter=spec game/demo/nt/slow.test.mjs', env);
  const p1 = path.join(tmpRoot, `nt-272a-${process.pid}.json`);
  fs.writeFileSync(p1, JSON.stringify({ only: out(ntOnly), mixed: out(ntMixed), spec: out(ntSpec) }));
  const tp = probe('parse', `import fs from 'node:fs';
import { timeoutOnly } from ${u('harness/timeout-rerun.mjs')};
const nt = JSON.parse(fs.readFileSync(${JSON.stringify(p1)}, 'utf8'));
const vit = [' FAIL  src/sim/soak.test.ts > soak > 30 days', 'Error: Test timed out in 5000ms.', 'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".', '\\u23af\\u23af\\u23af[1/1]\\u23af', ' Test Files  1 failed | 3 passed (4)', '      Tests  1 failed | 30 passed (31)'].join('\\n');
const vitMixed = vit.replace(' Test Files', ' FAIL  src/econ/fees.test.ts > fees > once\\nAssertionError: expected 7 to be 6\\n Test Files').replace('Tests  1 failed', 'Tests  2 failed');
const vitCount = vit.replace('Tests  1 failed', 'Tests  3 failed');
const jest = [' FAIL  src/sim/soak.test.js (12.1 s)', '  \\u25cf soak \\u203a 30 days', '', '    thrown: "Exceeded timeout of 5000 ms for a test.', '    Add a timeout value to this test to increase the timeout."', '', 'Tests:       1 failed, 9 passed, 10 total'].join('\\n');
const jestSuite = [' FAIL  src/sim/soak.test.js', '  \\u25cf Test suite failed to run', '', '    Cannot find module x', 'Tests:       0 total'].join('\\n');
const r = { vit: timeoutOnly(vit), vitMixed: timeoutOnly(vitMixed), vitCount: timeoutOnly(vitCount), jest: timeoutOnly(jest), jestSuite: timeoutOnly(jestSuite), ntOnly: timeoutOnly(nt.only), ntMixed: timeoutOnly(nt.mixed), ntSpec: timeoutOnly(nt.spec) };
for (const k of Object.keys(r)) delete r[k].blocks;
console.log(JSON.stringify(r));
`);
  report('2.72.0 (a, 3): timeout-only reds are read from vitest ("Test timed out in 5000ms"), jest ("Exceeded timeout of 5000 ms") and real node --test output (TAP failureType testTimeoutFailure, the spec reporter\'s "test timed out after"), naming the files; a mixed red (a timeout and an assertion, synthetic vitest and real node --test), a runner count above what was read, and jest\'s "Test suite failed to run" are not timeout-only (fails on 2.71.1: no such reading)',
    tp.vit?.ok === true && JSON.stringify(tp.vit.files) === '["src/sim/soak.test.ts"]' && tp.jest?.ok === true && JSON.stringify(tp.jest.files) === '["src/sim/soak.test.js"]'
      && tp.ntOnly?.ok === true && tp.ntOnly.files.length === 1 && tp.ntOnly.files[0].endsWith('game/demo/nt/slow.test.mjs') && tp.ntSpec?.ok === true && tp.ntSpec.files[0].endsWith('slow.test.mjs')
      && tp.vitMixed?.ok === false && /mixed red/.test(tp.vitMixed.why) && tp.ntMixed?.ok === false && /mixed red/.test(tp.ntMixed.why) && tp.vitCount?.ok === false && /counts 3/.test(tp.vitCount.why) && tp.jestSuite?.ok === false,
    `${JSON.stringify(tp).slice(0, 2500)}\n${out(ntMixed).slice(0, 1200)}`);

  // ---- (3) the re-run itself, on a made-up game with real node --test timeouts ----
  // A test file sleeps past its 300 ms timeout unless it runs with one test worker (the re-run's low load), per the notes.
  const tfile = (n) => ["import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs';",
    `const notes = fs.existsSync('game/demo/notes.md') ? fs.readFileSync('game/demo/notes.md', 'utf8') : '';`,
    `if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, 'game/demo/tests/${n}.test.mjs\\t' + (process.env.STUDIO_TEST_WORKERS || '-') + '\\n');`,
    `test('${n} runs the long sim', { timeout: 300 }, async () => {`,
    `  if (notes.includes('BREAKS ${n}')) assert.equal(1, 2);`,
    `  const slow = notes.includes('ALWAYS ${n}') || (notes.includes('SLOW ${n}') && process.env.STUDIO_TEST_WORKERS !== '1');`,
    '  if (slow) await new Promise((r) => setTimeout(r, 1500));',
    '});', ''].join('\n');
  for (const n of ['a', 'b', 'c']) write(`game/demo/tests/${n}.test.mjs`, tfile(n));
  const files = ['a', 'b', 'c'].map((n) => `game/demo/tests/${n}.test.mjs`).join(' ');
  write('game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: `node --test --test-reporter=tap ${files}`, focus: 'node --test --test-reporter=tap {files}' }] }, null, 2)}\n`);
  try { fs.rmSync(path.join(dir, '.studio', 'flakes.jsonl'), { force: true }); } catch {}
  write('game/demo/notes.md', 'SLOW b\n');
  clearEvents(); clearRan();
  const t1 = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', gameEnv);
  const t1Text = out(t1);
  const t1Ran = ran();
  const t1Ev = lastGatesRun();
  const t1Flakes = flakeRows();
  const t1Tf = evs().find((e) => e.type === 'test.timeout_flake');
  const dg = probe('digest', `import path from 'node:path';
import { quarantineDigestLine } from ${u('harness/flakes.mjs')};
console.log(JSON.stringify({ line: quarantineDigestLine([], { root: path.resolve('.') }) }));
`);
  clearRan();
  const t1off = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', { ...gameEnv, STUDIO_TIMEOUT_RERUN: 'off' });
  const t1offRan = ran();
  report('2.72.0 (a, 3): a red whose only failure is a node --test timeout (b, beside a and c) re-runs just b, alone, at low load (one test worker): green alone -> the game check counts green ("timeout-flake in game:unit"), b is a "timeout-flake" row in .studio/flakes.jsonl, a test.timeout_flake event, gates.run meta.timeoutFlakes and a digest line; a and c are never re-run; with STUDIO_TIMEOUT_RERUN=off the same red stays red and nothing is re-run (fails on 2.71.1: the timeout was a red that blamed the lane)',
    t1.status === 0 && /\[game-gates\] timeout-flake in game:unit: \["game\/demo\/tests\/b\.test\.mjs"\]/.test(t1Text)
      && t1Ran.length === 4 && t1Ran.filter((x) => x[0].endsWith('b.test.mjs')).map((x) => x[1]).join(',') === '4,1' && t1Ran.filter((x) => x[1] === '1').length === 1
      && t1Flakes.length === 1 && t1Flakes[0].label === 'timeout-flake' && t1Flakes[0].test === 'game/demo/tests/b.test.mjs' && t1Flakes[0].check === 'game:unit'
      && t1Tf?.meta?.files?.[0] === 'game/demo/tests/b.test.mjs' && JSON.stringify(t1Ev?.meta?.timeoutFlakes) === '{"game:unit":["game/demo/tests/b.test.mjs"]}' && t1Ev?.meta?.failed?.length === 0
      && /1 timeout-only red in 24 h passed when re-run alone at low load \(timeout-flake; counted green for that file only, the lane not blamed\): game\/demo\/tests\/b\.test\.mjs/.test(dg.line || '')
      && t1off.status === 1 && t1offRan.length === 3 && !/timeout-flake in/.test(out(t1off)) && /^\[gates\] game failed in: game:unit:game\/demo\/tests\/b\.test\.mjs$/m.test(out(t1off)),
    `${t1Text.slice(-2000)}\nran=${JSON.stringify(t1Ran)}\nflakes=${JSON.stringify(t1Flakes)}\nev=${JSON.stringify(t1Ev?.meta)}\ndigest=${JSON.stringify(dg)}\noff=${out(t1off).slice(-600)} ran=${JSON.stringify(t1offRan)}`);

  // Red alone stays red (only that file named; the other is a timeout-flake for itself only); a mixed red isn't re-run.
  write('game/demo/notes.md', 'SLOW b\nALWAYS c\n');
  clearEvents(); clearRan();
  try { fs.rmSync(path.join(dir, '.studio', 'flakes.jsonl'), { force: true }); } catch {}
  const t2 = run(dir, 'node harness/game-gates.mjs', gameEnv);
  const t2Text = out(t2);
  const t2Ran = ran();
  const t2Flakes = flakeRows();
  write('game/demo/notes.md', 'SLOW b\nBREAKS a\n');
  clearRan();
  const t3 = run(dir, 'node harness/game-gates.mjs', gameEnv);
  const t3Text = out(t3);
  const t3Ran = ran();
  report('2.72.0 (a, 3): two timeouts, b green alone and c red alone: the check stays red naming only c ("failing test files in game:unit: [c]"), b is a timeout-flake for itself only; a mixed red (b\'s timeout plus a\'s assertion) is a real red, re-runs nothing and says so ("a mixed red") (fails on 2.71.1: no re-run, both reds named the same way)',
    t2.status === 1 && /failing test files in game:unit: \["game\/demo\/tests\/c\.test\.mjs"\]/.test(t2Text) && /timeout-flake in game:unit: \["game\/demo\/tests\/b\.test\.mjs"\]/.test(t2Text)
      && t2Ran.filter((x) => x[1] === '1').map((x) => x[0].split('/').pop()).sort().join(',') === 'b.test.mjs,c.test.mjs' && t2Flakes.length === 1 && t2Flakes[0].test.endsWith('b.test.mjs')
      && t3.status === 1 && /not re-run for timeouts: a mixed red/.test(t3Text) && t3Ran.length === 3 && !t3Ran.some((x) => x[1] === '1') && /failing test files in game:unit: \[.*a\.test\.mjs.*b\.test\.mjs.*\]|failing test files in game:unit: \[.*b\.test\.mjs.*a\.test\.mjs.*\]/.test(t3Text),
    `${t2Text.slice(-1500)}\nran2=${JSON.stringify(t2Ran)}\n${t3Text.slice(-1200)}\nran3=${JSON.stringify(t3Ran)}`);

  clearRan();
  try { fs.rmSync(ranLog, { force: true }); } catch {}
}
