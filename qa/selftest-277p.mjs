/**
 * qa/selftest-277p.mjs — 2.77.0 (helper p, P9.6): pipelined merge trains and the batch cap.
 *   batch     a train takes at most STUDIO_TRAIN_BATCH ready lanes (default 4; with --max and STUDIO_TRAIN_MAX the
 *             smallest cap wins); the lanes past it wait for the next train
 *   pipeline  while train A verifies, ONE speculative train B verifies "A's tree + its lanes" in its own copy and lock
 *             and lands right after A without verifying again; B is discarded (its lanes keep their place, no hand-back)
 *             when A goes red or when main moves any other way, and its lanes then go in a normal train; a train that
 *             would start while B can land waits for it (never two landing at once)
 *   rules     B never holds, hands back or bisects: tier C, held, run-alone-behind-others, waiting and fix-first lanes
 *             are left for the next normal train (pickNextLanes); STUDIO_TRAIN_PIPELINE auto needs room on the machine
 *   status    task train status, .studio/train/status.json (`next`) and studio:status show both trains with their steps
 *   life      B has its own life record; a dead B's lock is freed by the reaper
 * Made-up lanes and a stand-in game check (a few seconds); every check fails on 2.76.1 (no pipeline, no batch cap).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest277P({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules')) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const href = (base, rel) => JSON.stringify(pathToFileURL(path.join(base, rel)).href);
  const lastJson = (r) => { const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; } };
  let n = 0;
  const probe = (cwd, env, name, code) => {
    const f = path.join(tmpRoot, `probe-277p-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, env);
    fs.rmSync(f, { force: true });
    return { ...lastJson(r), _out: out(r).slice(-3000) };
  };
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 300)); } return fn(); };
  const want = (k) => !process.env.ONLY_277P || process.env.ONLY_277P.split(',').includes(k);

  // ---- 1. the pure pieces (harness/train-pipeline.mjs) ----
  if (want('pure')) {
    const repo = path.join(tmpRoot, `277p-git-${process.pid}`);
    fs.mkdirSync(repo, { recursive: true });
    g(repo, 'init', '-q', '-b', 'main');
    write(repo, 'src/a.txt', 'a\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'A');
    const A = g(repo, 'rev-parse', 'HEAD').stdout.trim();
    write(repo, 'studio/NEXT.md', '# board\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'board');
    const board = g(repo, 'rev-parse', 'HEAD').stdout.trim();
    g(repo, 'checkout', '-q', '-b', 'other', A); write(repo, 'src/b.txt', 'b\n'); g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'code');
    const code = g(repo, 'rev-parse', 'HEAD').stdout.trim();
    const p = probe(dir, { ...process.env }, 'pure', `import * as pl from ${href(dir, 'harness/train-pipeline.mjs')};
import { nextBaseVerdict } from ${href(dir, 'harness/train.mjs')};
import { daemonDecision } from ${href(dir, 'harness/train-daemon.mjs')};
const big = { os: { platform: 'linux' }, cores: { logical: 28 }, ram: { totalGb: 32, freeGb: 24 }, gpus: [], at: Date.now() };
const env = { STUDIO_HEAVY_SLOTS: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_TEST_WORKERS: '', STUDIO_MACHINE_SCAN: '', STUDIO_TRAIN_RESERVE: 'off' };
const busy = [1, 2, 3, 4, 5, 6].map((i) => ({ pid: i, at: Date.now(), claim: { kind: 'verify', ramGb: 3, cpuThreads: 4 } }));
const room = { big: await pl.pipelineRoom({ root: process.cwd(), env, machine: big, holders: [] }), none: await pl.pipelineRoom({ root: process.cwd(), env, machine: null, holders: [] }), busy: await pl.pipelineRoom({ root: process.cwd(), env, machine: big, holders: busy }) };
const batch = { def: pl.batchSize({}), two: pl.batchSize({ STUDIO_TRAIN_BATCH: '2' }), off: pl.batchSize({ STUDIO_TRAIN_BATCH: 'off' }), capDef: pl.batchCap({ env: {} }), capMax: pl.batchCap({ max: 6, env: {} }), capRules: pl.batchCap({ rulesMax: 3, env: {} }), capNone: pl.batchCap({ env: { STUDIO_TRAIN_BATCH: '0' } }) };
const modes = [pl.pipelineMode({}), pl.pipelineMode({ STUDIO_TRAIN_PIPELINE: 'on' }), pl.pipelineMode({ STUDIO_TRAIN_PIPELINE: 'off' })];
const a = { id: 'A1', live: true, ended: null, step: 'verify', head: 'h1', tasks: ['T-1'] };
const dec = {
  off: pl.nextDecision({ mode: 'off', a, ready: [{ task: 'T-2' }] }),
  next: pl.nextDecision({ mode: 'on', next: { id: 'B0', after: 'A1' }, a, ready: [{ task: 'T-2' }] }),
  notVerifying: pl.nextDecision({ mode: 'on', a: { ...a, step: 'recheck' }, ready: [{ task: 'T-2' }] }),
  none: pl.nextDecision({ mode: 'on', a, ready: [] }),
  noRoom: pl.nextDecision({ mode: 'auto', a, ready: [{ task: 'T-2' }], room: { ok: false, why: 'no machine scan' } }),
  room: pl.nextDecision({ mode: 'auto', a, ready: [{ task: 'T-2' }], room: { ok: true, why: 'fits' } }),
  on: pl.nextDecision({ mode: 'on', a, ready: [{ task: 'T-2' }], room: { ok: false } }),
};
const c = (task, o = {}) => ({ task, tier: 'A', runAlone: { yes: false }, ...o });
const pick = {
  rules: pl.pickNextLanes([c('T-1', { inA: true }), c('T-2'), c('T-3', { held: { tier: 'C' } }), c('T-4', { out: true }), c('T-5', { tier: 'C' }), c('T-6', { tier: 'C', released: { by: 'p' } }), c('T-7', { needs: 'goldens' }), c('T-8', { capped: true }), c('T-9', { runAlone: { yes: true, why: 'big' } }), c('T-10', { wait: 'after T-1' }), c('T-11'), c('T-12'), c('T-13')], { batch: 3 }),
  alone: pl.pickNextLanes([c('T-20', { runAlone: { yes: true, why: 'sim-wide' } }), c('T-21')], { batch: 4 }),
  fix: pl.pickNextLanes([c('T-30'), c('T-31', { fixFirst: true })], { batch: 4 }),
};
const v = (now) => (now === 'rec' ? { land: true, how: 'record', files: ['studio/NEXT.md'] } : { land: false, why: 'it changes src/x' });
const judge = {
  wait: pl.judgeTrainA({ a, base: 'h1', tip0: 't0', mainNow: 't0', verdict: v }),
  changed: pl.judgeTrainA({ a: { ...a, head: 'h2' }, base: 'h1', tip0: 't0', mainNow: 't0', verdict: v }),
  red: pl.judgeTrainA({ a: { ...a, step: 'recheck', text: 're-check 1 of 2' }, base: 'h1', tip0: 't0', mainNow: 't0', verdict: v }),
  noLand: pl.judgeTrainA({ a: { ...a, live: false, ended: { how: 'done', summary: 'handed back T-1' } }, base: 'h1', tip0: 't0', mainNow: 't0', verdict: v }),
  landed: pl.judgeTrainA({ a: { ...a, live: false, ended: { how: 'done' } }, base: 'h1', tip0: 't0', mainNow: 'h1', verdict: (x) => pl.speculativeBaseVerdict(process.cwd(), { assumed: 'h1', now: x }) }),
  record: pl.judgeTrainA({ a: { ...a, live: false, ended: { how: 'done' } }, base: 'h1', tip0: 't0', mainNow: 'rec', verdict: v }),
  moved: pl.judgeTrainA({ a: { ...a, live: false, ended: { how: 'done' } }, base: 'h1', tip0: 't0', mainNow: 'zz', verdict: v }),
};
const R = ${JSON.stringify(repo)};
const base = { same: nextBaseVerdict(R, { assumed: ${JSON.stringify(A)}, now: ${JSON.stringify(A)} }), board: nextBaseVerdict(R, { assumed: ${JSON.stringify(A)}, now: ${JSON.stringify(board)} }), code: nextBaseVerdict(R, { assumed: ${JSON.stringify(A)}, now: ${JSON.stringify(code)} }) };
const daemon = daemonDecision({ auto: { on: true }, trainOn: true, next: { id: 'B9', after: 'A9' }, queue: [{ task: 'T-1', at: new Date().toISOString() }], rules: { min: 1, waitMin: 0 }, room: { ok: true } });
console.log(JSON.stringify({ room, batch, modes, dec, pick, judge, base, daemon }));
`);
    await guard('2.77.0 (p, P9.6): the batch cap: STUDIO_TRAIN_BATCH default 4, 2 -> 2, off -> no cap; with --max 6 the cap stays 4, with STUDIO_TRAIN_MAX 3 it is 3, STUDIO_TRAIN_BATCH=0 and nothing else: no cap; STUDIO_TRAIN_PIPELINE unset is auto, on, off (fails on 2.76.1: harness/train-pipeline.mjs does not exist)', () => {
      const b = p.batch || {};
      return [b.def === 4 && b.two === 2 && b.off === 0 && b.capDef === 4 && b.capMax === 4 && b.capRules === 3 && b.capNone === 0 && JSON.stringify(p.modes) === '["auto","on","off"]', JSON.stringify(p).slice(0, 2500)];
    });
    await guard('2.77.0 (p, P9.6): auto starts B only with room for a second train verify: a 28-thread/32 GB scan with nothing running has room (beside train A\'s own verify claim); no machine scan has none; a machine whose heavy slots are all taken has none. The decision: off, a B already running, A not verifying (re-checking), no lane queued behind A and auto without room all say no; auto with room and on say start (fails on 2.76.1: no pipeline)', () => {
      const r = p.room || {}; const d = p.dec || {};
      return [r.big?.ok === true && r.none?.ok === false && /no machine scan/.test(r.none?.why || '') && r.busy?.ok === false
        && !d.off?.start && /already running/.test(d.next?.why || '') && /not verifying/.test(d.notVerifying?.why || '') && /no other lane/.test(d.none?.why || '') && !d.noRoom?.start && /no room/.test(d.noRoom?.why || '') && d.room?.start === true && d.on?.start === true,
      JSON.stringify({ room: p.room, dec: p.dec }).slice(0, 2500)];
    });
    await guard('2.77.0 (p, P9.6): B keeps the tier and alone rules by leaving lanes for the next normal train, never holding or handing back: A\'s lanes are not B\'s; a lane held for the owner, held out of trains, tier C not released, missing a Golden-Reason, over the hand-back cap, waiting on a dependency, or run-alone behind others is skipped with its reason; a released tier C goes; the batch (3) is respected; a run-alone lane first goes alone; a fix-first lane anywhere means no B (fails on 2.76.1: no such pick)', () => {
      const q = p.pick || {};
      const got = (q.rules?.lanes || []).map((l) => l.task);
      const sk = Object.fromEntries((q.rules?.skipped || []).map((s) => [s.task, s.why]));
      return [JSON.stringify(got) === '["T-2","T-6","T-11"]' && !('T-1' in sk) && /held for the owner/.test(sk['T-3'] || '') && /out of trains/.test(sk['T-4'] || '') && /tier C/.test(sk['T-5'] || '') && /goldens/.test(sk['T-7'] || '') && /HANDBACKS/.test(sk['T-8'] || '') && /runs alone/.test(sk['T-9'] || '') && /after T-1/.test(sk['T-10'] || '') && /batch of 3/.test(sk['T-12'] || '') && /batch of 3/.test(sk['T-13'] || '')
        && JSON.stringify((q.alone?.lanes || []).map((l) => l.task)) === '["T-20"]' && /runs alone/.test(q.alone?.skipped?.[0]?.why || '') && !q.fix?.lanes?.length && /fix lane/.test(q.fix?.wait || ''),
      JSON.stringify(q).slice(0, 2500)];
    });
    await guard('2.77.0 (p, P9.6): B\'s verdict on train A: A verifying the tree B built on -> wait; A rebuilt (its head changed) or re-checking -> discard; A ended with main where it was -> discard (did not land); main exactly A\'s tree -> land; A\'s tree plus record files -> land; anything else -> discard. With git, nextBaseVerdict (the one "did main move" check): the same commit lands, a commit of studio/NEXT.md on top (a board file) lands as a record move, a code commit does not; the train daemon starts no train while B can land (fails on 2.76.1: no such verdict)', () => {
      const j = p.judge || {}; const b = p.base || {};
      return [j.wait?.wait === true && /changed its tree/.test(j.changed?.discard || '') && /went red/.test(j.red?.discard || '') && /without landing/.test(j.noLand?.discard || '') && j.landed?.land === true && j.landed.how === 'same' && j.record?.land === true && j.record.how === 'record' && /it changes src\/x/.test(j.moved?.discard || '')
        && b.same?.land === true && b.board?.land === true && b.board.how === 'record' && JSON.stringify(b.board.files) === '["studio/NEXT.md"]' && b.code?.land === false && p.daemon?.start === false && /lands first/.test(p.daemon?.why || ''),
      JSON.stringify({ judge: p.judge, base: p.base, daemon: p.daemon }).slice(0, 2500)];
    });
  }

  // ---- the studio and its made-up game (as qa/selftest-269q.mjs) ----
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '',
    STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '',
    STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: 'off', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_CHAIN_TAIL: '', STUDIO_TRAIN_BATCH: '', STUDIO_TRAIN_PIPELINE: 'on', STUDIO_TRAIN_AUTO: '', STUDIO_TRAIN_MAX_HANDBACKS: '',
    STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_HEAVY_SLOTS: '4', STUDIO_TEST_WORKERS: '', STUDIO_RESERVE_RAM_GB: '', STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: 'none',
    STUDIO_TRAIN_BISECT_PARALLEL: '', STUDIO_VERIFY_REMOTE: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '',
    npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '', CI: '', GITHUB_ACTIONS: '', GH_TOKEN: '', GITHUB_TOKEN: '', ...ident,
  };
  const nm = path.join(dir, 'node_modules');
  const RUNNER = [
    "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
    "const files = process.argv.slice(2); const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "const nd = 'game/demo/notes';",
    "const notes = fs.existsSync(nd) ? fs.readdirSync(nd).map((f) => fs.readFileSync(path.join(nd, f), 'utf8')).join('\\n') : '';",
    'const mark = process.env.MARK_277P; const main = process.env.MAIN_277P;',
    'const has = (p) => fs.existsSync(path.join(mark, p));',
    'const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);',
    'const until = (fn, ms) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) pause(200); return fn(); };',
    "const note = (w) => fs.appendFileSync(path.join(mark, 'ran.log'), `${process.env.STUDIO_LOCK_OWNER || '-'}\\t${w}\\t${Date.now()}\\n`);",
    "const onMain = (rel) => spawnSync('git', ['cat-file', '-e', `main:${rel}`], { cwd: main, windowsHide: true }).status === 0;",
    'if (!files.length && mark) {',
    "  if (notes.includes('B-LANE')) {",
    "    fs.writeFileSync(path.join(mark, 'b-verifying'), '1'); note('b-verify');",
    "    if (notes.includes('MOVE-MAIN') && !has('moved')) {",
    "      until(() => onMain('game/demo/notes/a1.md'), 60000);",
    "      fs.writeFileSync(path.join(main, 'game/demo/notes/moved.md'), '# someone else\\n');",
    "      spawnSync('git', ['add', 'game/demo/notes/moved.md'], { cwd: main, windowsHide: true });",
    "      spawnSync('git', ['commit', '-qm', 'someone else moves main', '--no-verify'], { cwd: main, windowsHide: true, env: process.env });",
    "      fs.writeFileSync(path.join(mark, 'moved'), '1'); note('moved');",
    '    }',
    "    if (notes.includes('BREAKS')) until(() => { try { return fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').includes('\"task.train.red\"'); } catch { return false; } }, 60000);",
    "  } else if (notes.includes('A-WAIT')) {",
    "    note('a-wait'); until(() => has('b-verifying'), 60000); note('a-go');",
    "    if (!has('snap')) { fs.writeFileSync(path.join(mark, 'snap'), '1'); until(() => { try { return JSON.parse(fs.readFileSync(path.join(main, '.studio', 'train', 'status.json'), 'utf8')).next?.step === 'verify'; } catch { return false; } }, 20000);",
    "      try { fs.copyFileSync(path.join(main, '.studio', 'train', 'status.json'), path.join(mark, 'status-snap.json')); } catch {}",
    "      const t = spawnSync(process.execPath, [path.join(main, 'harness', 'task.mjs'), 'train', 'status'], { cwd: main, encoding: 'utf8', windowsHide: true, env: { ...process.env, STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '' } });",
    "      fs.writeFileSync(path.join(mark, 'train-status.txt'), `${t.stdout || ''}${t.stderr || ''}`);",
    "      const s = spawnSync(process.execPath, [path.join(main, 'harness', 'supervisor.mjs'), 'status'], { cwd: main, encoding: 'utf8', windowsHide: true, env: { ...process.env, STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '' } });",
    "      fs.writeFileSync(path.join(mark, 'studio-status.txt'), `${s.stdout || ''}${s.stderr || ''}`); }",
    '  }',
    '}',
    'let bad = 0;',
    'for (const f of list) {',
    "  if (notes.includes(`BREAKS ${path.basename(f)}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`);",
    '}',
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    'process.exit(bad ? 1 : 0);', ''].join('\n');
  const studio = (name) => {
    const S = path.join(tmpRoot, `277p-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules|\.studio)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    const mark = path.join(S, '.mark-277p');
    fs.mkdirSync(mark, { recursive: true });
    const events = path.join(S, '.studio', 'events-277p.jsonl');
    fs.mkdirSync(path.dirname(events), { recursive: true }); fs.writeFileSync(events, '');
    write(S, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    write(S, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }] }, null, 2)}\n`);
    write(S, 'game/demo/run-tests.mjs', RUNNER);
    for (const t of ['a', 'b']) write(S, `game/demo/tests/${t}.test.mjs`, `// ${t}\n`);
    write(S, 'game/demo/notes/readme.md', '# Notes\n');
    fs.appendFileSync(path.join(S, '.gitignore'), '\n/.mark-277p/\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    g(S, 'config', 'core.hooksPath', 'scripts/hooks');
    const env = { ...base, AGENT_EVENTS_FILE: events, MARK_277P: mark, MAIN_277P: S, STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-277p-${process.pid}.pem`) };
    const laneProbe = path.join(tmpRoot, `lane-277p-${process.pid}-${n}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${href(S, 'harness/worktree.mjs')};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
    const lane = (agent, title, files) => {
      const id = (out(run(S, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
      run(S, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(S, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: S, STUDIO_LOCK_OWNER: agent };
      const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
      g(ld, 'add', '-A');
      const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...gEnv(), ...as } });
      const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
      return { id, agent, ok: st.status === 0 && c.status === 0 && q.status === 0, log: `${out(st)}\n${out(c)}\n${out(q)}`.slice(-1500) };
    };
    const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
    const onMain = (rel) => g(S, 'cat-file', '-e', `main:${rel}`).status === 0;
    const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
    const ran = () => { try { return fs.readFileSync(path.join(mark, 'ran.log'), 'utf8').split('\n').filter(Boolean).map((l) => { const [owner, what, at] = l.split('\t'); return { owner, what, at: Number(at) }; }); } catch { return []; } };
    const nextLog = () => { try { return fs.readFileSync(path.join(S, '.studio', 'train', 'next.log'), 'utf8'); } catch { return ''; } };
    const lifeOf = (id) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'train', id, 'life.json'), 'utf8')); } catch { return null; } };
    return { S, env, mark, lane, evs, onMain, queue, ran, nextLog, lifeOf };
  };
  const startOf = (E, pred) => E.filter((e) => e.type === 'task.train.start' && pred(e));
  const ts = (e) => (e ? Date.parse(e.ts || e.at || e.time || 0) : NaN);

  // ---- 2. A and B land: A verifies 4 lanes, B verifies 2 more on A's tree at the same time, lands right after A ----
  if (want('land')) {
    const T = studio('land');
    const L = [1, 2, 3, 4].map((k) => T.lane(`pp-a${k}`, `Docs: note a${k}`, { [`game/demo/notes/a${k}.md`]: k === 1 ? '# a1 A-WAIT\n' : `# a${k}\n` }));
    L.push(...[1, 2].map((k) => T.lane(`pp-b${k}`, `Docs: note b${k}`, { [`game/demo/notes/b${k}.md`]: `# b${k} B-LANE\n` })));
    const t0 = Date.now();
    const tr = run(T.S, 'node harness/task.mjs train --by tester --now', T.env);
    const done = await waitFor(() => T.evs().find((e) => (e.type === 'task.train.done' || e.type === 'task.train.next_discarded') && e.meta?.speculative), 150000);
    await waitFor(() => !fs.existsSync(path.join(T.S, '.studio', 'locks', 'train-next.lock')), 20000);
    const E = T.evs();
    const aStart = startOf(E, (e) => !e.meta?.speculative)[0];
    const bStart = startOf(E, (e) => e.meta?.speculative)[0];
    const aId = aStart?.meta?.train; const bId = bStart?.meta?.train;
    const landed = E.filter((e) => e.type === 'task.train.landed');
    const aLanded = landed.find((e) => e.meta?.train === aId); const bLanded = landed.find((e) => e.meta?.train === bId);
    const aDone = E.find((e) => e.type === 'task.train.done' && e.meta?.train === aId);
    const verifies = (id) => E.filter((e) => e.type === 'task.train.verify' && e.meta?.train === id).length;
    const bVerifyStart = T.ran().find((r) => r.what === 'b-verify');
    const all = [1, 2, 3, 4].every((k) => T.onMain(`game/demo/notes/a${k}.md`)) && [1, 2].every((k) => T.onMain(`game/demo/notes/b${k}.md`));
    const life = bId ? T.lifeOf(bId) : null;
    const detail = `lanes ok=${L.map((l) => l.ok)} A=${aId} B=${bId} done=${JSON.stringify(done)?.slice(0, 300)}\nA lanes=${JSON.stringify(aStart?.meta?.lanes)} B lanes=${JSON.stringify(bStart?.meta?.lanes)} verifies A=${aId && verifies(aId)} B=${bId && verifies(bId)}\nran=${JSON.stringify(T.ran())}\n${out(tr).slice(-2000)}\n--- next.log\n${T.nextLog().slice(-2500)}\n${L.find((l) => !l.ok)?.log || ''}`;
    await guard('2.77.0 (p, P9.6): six queued lanes, STUDIO_TRAIN_BATCH default 4: train A takes the 4 oldest, and while A verifies a speculative train B (its own copy, its own lock) takes the other 2 on A\'s tree: B\'s verify started before A landed (A\'s stand-in check waits until B verifies), each train ran exactly ONE full verify, B landed right after A without verifying again, all six notes are on main, the queue is empty (fails on 2.76.1: one train takes all six lanes, no speculative train)', () => [
      L.every((l) => l.ok) && tr.status === 0 && aId && bId && aId !== bId && JSON.stringify(aStart.meta.lanes) === JSON.stringify(L.slice(0, 4).map((l) => l.id)) && JSON.stringify([...bStart.meta.lanes].sort()) === JSON.stringify(L.slice(4).map((l) => l.id).sort())
        && bStart.meta.after === aId && bVerifyStart && aLanded && bVerifyStart.at < ts(aLanded) && verifies(aId) === 1 && verifies(bId) === 1 && bLanded && done?.type === 'task.train.done' && all && !T.queue().length && t0 > 0,
      detail]);
    await guard('2.77.0 (p, P9.6): never two trains landing at once: B moved main only after A had landed and let go of the train lock (A\'s done event before B\'s landed event), from exactly A\'s landed head (main\'s parent chain: B\'s landing commit descends from A\'s); B\'s lock is gone and its own life record (B-88) ended "done" (fails on 2.76.1: no B)', () => {
      const aHead = aLanded?.meta?.head; const bHead = bLanded?.meta?.head;
      const desc = aHead && bHead && g(T.S, 'merge-base', '--is-ancestor', aHead, bHead).status === 0 && g(T.S, 'rev-parse', 'main').stdout.trim() === bHead;
      return [aDone && bLanded && ts(aDone) <= ts(bLanded) && desc && !fs.existsSync(path.join(T.S, '.studio', 'locks', 'train-next.lock')) && life?.ended?.how === 'done' && JSON.stringify((life?.lanes || []).map((l) => l.task).sort()) === JSON.stringify(L.slice(4).map((l) => l.id).sort()), `${detail}\nlife=${JSON.stringify(life)}`];
    });
    await guard('2.77.0 (p, P9.6): while both verify, .studio/train/status.json keeps the running train\'s fields (train A, step verify, its tree) and adds `next` (train B, speculative, after A, step verify); `task train status` shows "Running: train A" and "Next: train B ... speculative on train A\'s tree"; studio:status shows both (fails on 2.76.1: no next, no such lines)', () => {
      let snap = null; try { snap = JSON.parse(fs.readFileSync(path.join(T.mark, 'status-snap.json'), 'utf8')); } catch {}
      let txt = ''; try { txt = fs.readFileSync(path.join(T.mark, 'train-status.txt'), 'utf8'); } catch {}
      let sup = ''; try { sup = fs.readFileSync(path.join(T.mark, 'studio-status.txt'), 'utf8'); } catch {}
      return [snap?.train === aId && snap.step === 'verify' && snap.head && snap.next?.train === bId && snap.next.speculative === true && snap.next.after === aId && snap.next.step === 'verify'
        && new RegExp(`Running: train ${aId}`).test(txt) && new RegExp(`Next: train ${bId}.*speculative on train ${aId}`).test(txt) && new RegExp(`Next: train ${bId}`).test(sup) && new RegExp(`Running: train ${aId}`).test(sup),
      `snap=${JSON.stringify(snap)?.slice(0, 1500)}\n--- train status\n${txt.slice(-1500)}\n--- studio:status\n${sup.slice(-800)}`];
    });
  }

  // ---- 3. A goes red: B is discarded (no hand-back) and its lane lands in a normal train ----
  if (want('red')) {
    const T = studio('red');
    const env = { ...T.env, STUDIO_TRAIN_BATCH: '2' };
    const L = [T.lane('pr-a1', 'Docs: note a1', { 'game/demo/notes/a1.md': '# a1 A-WAIT\n' }), T.lane('pr-a2', 'Docs: note a2', { 'game/demo/notes/a2.md': 'BREAKS b.test.mjs\n' }), T.lane('pr-b1', 'Docs: note b1', { 'game/demo/notes/b1.md': '# b1 B-LANE\n' })];
    const tr = run(T.S, 'node harness/task.mjs train --by tester --now', env);
    const disc = await waitFor(() => T.evs().find((e) => e.type === 'task.train.next_discarded'), 120000);
    const landedB = await waitFor(() => T.evs().find((e) => e.type === 'task.train.landed' && (e.meta?.lanes || []).includes(L[2].id)), 150000);
    const E = T.evs();
    const aId = startOf(E, (e) => !e.meta?.speculative)[0]?.meta?.train;
    const bStart = startOf(E, (e) => e.meta?.speculative)[0];
    const dropped = E.filter((e) => e.type === 'task.train.dropped').map((e) => e.task);
    // Its lane lands in a later train: a normal one, or a new speculative train behind A's next verify.
    const later = landedB ? { meta: { train: landedB.meta.train } } : null;
    const bLife = bStart ? T.lifeOf(bStart.meta.train) : null;
    await guard('2.77.0 (p, P9.6): train A (2 lanes, STUDIO_TRAIN_BATCH=2) goes red while B verifies its third lane on A\'s tree: B is discarded (task.train.next_discarded: A went red or changed its tree), its lane is never handed back (no dropped event, the hand-back cap untouched), B\'s life record ends as a normal end ("discarded"), A hands back its culprit and lands the rest, and B\'s lane lands later in another train (a normal one, or a new speculative train behind A\'s next verify) (fails on 2.76.1: no B; the lanes all go in one train)', () => [
      L.every((l) => l.ok) && aId && bStart && JSON.stringify(bStart.meta.lanes) === JSON.stringify([L[2].id]) && disc && /went red|changed its tree/.test(disc.meta?.why || '') && disc.meta?.after === aId
        && !dropped.includes(L[2].id) && dropped.includes(L[1].id) && T.onMain('game/demo/notes/a1.md') && !T.onMain('game/demo/notes/a2.md') && T.onMain('game/demo/notes/b1.md') && later && later.meta.train !== bStart.meta.train && bLife?.ended?.how === 'done' && /discarded/.test(bLife?.ended?.summary || ''),
      `ok=${L.map((l) => l.ok)} A=${aId} disc=${JSON.stringify(disc)?.slice(0, 500)} dropped=${dropped} later=${later?.meta?.train}\nlife=${JSON.stringify(bLife)}\n${out(tr).slice(-1500)}\n--- next.log\n${T.nextLog().slice(-2500)}\n${L.find((l) => !l.ok)?.log || ''}`]);
  }

  // ---- 4. main moves after A lands, before B: B is discarded; its lane lands in a normal train ----
  if (want('moved')) {
    const T = studio('moved');
    const env = { ...T.env, STUDIO_TRAIN_BATCH: '1' };
    const L = [T.lane('pm-a1', 'Docs: note a1', { 'game/demo/notes/a1.md': '# a1 A-WAIT\n' }), T.lane('pm-b1', 'Docs: note b1', { 'game/demo/notes/b1.md': '# b1 B-LANE MOVE-MAIN\n' })];
    const tr = run(T.S, 'node harness/task.mjs train --by tester --now', env);
    const disc = await waitFor(() => T.evs().find((e) => e.type === 'task.train.next_discarded'), 120000);
    await waitFor(() => T.evs().find((e) => e.type === 'task.train.landed' && (e.meta?.lanes || []).includes(L[1].id)), 150000);
    const E = T.evs();
    const aId = startOf(E, (e) => !e.meta?.speculative)[0]?.meta?.train;
    const dropped = E.filter((e) => e.type === 'task.train.dropped').map((e) => e.task);
    const bLanded = E.filter((e) => e.type === 'task.train.landed' && (e.meta?.lanes || []).includes(L[1].id));
    await guard('2.77.0 (p, P9.6): someone moves main by a code commit after A lands and before B lands: B (STUDIO_TRAIN_BATCH=1: one lane each) is discarded because main is not A\'s verified tree and the move is not record files only ("not a board or record file"), its lane keeps its place (no hand-back) and lands in a normal train on the new main (fails on 2.76.1: no B; one train lands both lanes)', () => [
      L.every((l) => l.ok) && aId && disc && disc.meta?.after === aId && /not train A's verified tree/.test(disc.meta?.why || '') && /not a board or record file/.test(disc.meta?.why || '') && !dropped.length && T.onMain('game/demo/notes/moved.md') && T.onMain('game/demo/notes/b1.md') && bLanded.length === 1 && bLanded[0].meta.train !== disc.meta.train,
      `ok=${L.map((l) => l.ok)} A=${aId} disc=${JSON.stringify(disc)?.slice(0, 600)} dropped=${dropped}\nran=${JSON.stringify(T.ran())}\n${out(tr).slice(-1500)}\n--- next.log\n${T.nextLog().slice(-2500)}\n${L.find((l) => !l.ok)?.log || ''}`]);
  }

  // ---- 5. a train waits for a B that can land; a dead B's lock is freed ----
  if (want('lock')) {
    const T = studio('lock');
    const L = [T.lane('pl-a1', 'Docs: note a1', { 'game/demo/notes/a1.md': '# a1\n' })];
    const tip = g(T.S, 'rev-parse', 'main').stdout.trim();
    const lockF = path.join(T.S, '.studio', 'locks', 'train-next.lock');
    fs.mkdirSync(path.dirname(lockF), { recursive: true });
    fs.writeFileSync(lockF, JSON.stringify({ pid: process.pid, at: Date.now(), id: '20261104-180000-1', after: '20261104-170000-1', base: tip, by: 'train-next', lanes: ['T-999'] }));
    const busy = run(T.S, 'node harness/task.mjs train --by tester --now', T.env);
    const stillQueued = T.queue().includes(L[0].id) && !T.onMain('game/demo/notes/a1.md');
    fs.writeFileSync(lockF, JSON.stringify({ pid: process.pid, at: Date.now(), id: '20261104-180000-1', after: '20261104-170000-1', base: 'f'.repeat(40), by: 'train-next', lanes: ['T-999'] }));
    const goes = run(T.S, 'node harness/task.mjs train --by tester --now', T.env);
    const landedNow = T.onMain('game/demo/notes/a1.md');
    await guard('2.77.0 (p, P9.6): a train that would start while a live speculative train can land on main (its train A ended, main is the tree it built on) gives the train lock back and waits for it: `task train` says the speculative train lands first and lands nothing; when main is not the tree that B built on (B will be discarded) the train runs and lands (fails on 2.76.1: the train runs at once beside the speculative train)', () => [
      L[0].ok && busy.status !== 0 && /speculative train 20261104-180000-1/.test(out(busy)) && stillQueued && goes.status === 0 && landedNow,
      `${out(busy).slice(-1200)}\n---\n${out(goes).slice(-1200)}\n${L[0].log}`]);
    // A dead B: its life record says it runs, its process is gone, its lock names it.
    const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    const bid = `20261104-190000-${dead}`;
    write(T.S, `.studio/train/${bid}/status.json`, `${JSON.stringify({ train: bid, step: 'verify', text: 'verify of train A\'s tree + T-998 (speculative)', speculative: true })}\n`);
    write(T.S, `.studio/train/${bid}/life.json`, `${JSON.stringify({ id: bid, pid: dead, by: 'train-next', at: new Date().toISOString(), lanes: [], ended: null })}\n`);
    fs.writeFileSync(lockF, JSON.stringify({ pid: dead, at: Date.now(), id: bid, after: '20261104-170000-1', base: tip, by: 'train-next', lanes: [] }));
    const r = probe(T.S, T.env, 'reap', `import { reapTrains } from ${href(T.S, 'harness/train.mjs')};\nconsole.log(JSON.stringify(reapTrains(process.cwd(), {})));\n`);
    const died = T.evs().find((e) => e.type === 'task.train.died' && e.meta?.train === bid);
    await guard('2.77.0 (p, P9.6, B-88): a speculative train whose process is gone is found by the reaper like any train: task.train.died "died: verify", and its train-next.lock (which names it) is freed so the next B can start (fails on 2.76.1: the reaper frees only train.lock)', () => [
      died && /died: verify/.test(died.msg) && !fs.existsSync(lockF), `${JSON.stringify(r).slice(0, 800)} died=${JSON.stringify(died)} lock=${fs.existsSync(lockF)}`]);
  }
}
