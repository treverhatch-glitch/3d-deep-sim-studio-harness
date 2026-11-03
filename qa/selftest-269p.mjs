/**
 * qa/selftest-269p.mjs — 2.69.0 (helper p): less repeated work in the merge train.
 *   reuse    a train of ONE lane whose integration tree is the lane's verified tree reuses the lane's green verify, even
 *            after the agent's next verify replaced its own record (verifies kept by tree); "reused <lane>'s green
 *            verify of tree <x>". A multi-lane train orders a lane with a green verify of its own tree on main first.
 *   related  before the full verify of a multi-lane train, each lane's related tests run on the combined tree; a lane
 *            red there is handed back at once (no bisection), with the failing tests and the facts block.
 *   slow     checks and test globs the manifest marks slow are left out of verifies (STUDIO_TEST_EXCLUDE) and run by
 *            `npm run gates -- --tier slow` (STUDIO_TEST_ONLY), one bug task per new failure, deduped; the
 *            supervisor's daily hook starts it once a day from STUDIO_SLOW_HOUR.
 * A made-up studio and game (game/demo: src/<n>.mjs, tests/<n>.test.mjs, a soak test), lane copies from harness/worktree.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest269P({ dir, run, report, tmpRoot, root }) {
  // The size rule reads JavaScript with the typescript package: a copy made without node_modules (the full selftest's
  // copyRepo) gets the harness's own, linked, as selftest-267f does (CI release-gate 22 and windows, 2.69.0: the lanes'
  // `task done` was refused with "the size check can't read JavaScript", so no lane reached the train).
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const events = path.join(dir, '.studio', 'events-269p.jsonl');
  const ranLog = path.join(tmpRoot, `ran-269p-${process.pid}.log`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '', STUDIO_GATE_RELATED: '', STUDIO_GATE_RELATED_ONLY: '', STUDIO_WHOLE_GAME: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: '', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_RELATED_FIRST: '', STUDIO_TRAIN_GREEN_FIRST: '', STUDIO_SLOW_TIER: '', STUDIO_SLOW_HOUR: '', STUDIO_GATE_TIER: '', STUDIO_TEST_EXCLUDE: '', STUDIO_TEST_ONLY: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_LOCK_OWNER: '', npm_lifecycle_event: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-269p-${process.pid}.pem`), AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const board = () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
  const handBack = (id) => { const f = path.join(dir, 'studio', 'handoffs', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  const droppedEv = (id) => evs().find((e) => e.type === 'task.train.dropped' && e.task === id);
  const ran = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => { const [owner, as, file, extra] = l.split('\t'); return { owner, as, file, extra }; }); } catch { return []; } };
  const resetRan = () => { try { fs.rmSync(ranLog, { force: true }); } catch {} };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };

  // ---- the studio and its made-up game ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  const unit = { id: 'unit', command: 'node game/demo/run-tests.mjs', related: 'node game/demo/run-tests.mjs --related {files}' };
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [unit] }, null, 2)}\n`);
  // The runner: tests/<n>.test.mjs fails when src/<n>.mjs says BREAKS; tests/*.soak.test.mjs fails when notes/soak.md says
  // SOAK-RED. --related maps changed src files to their tests. STUDIO_TEST_EXCLUDE / STUDIO_TEST_ONLY are globs.
  write(dir, 'game/demo/run-tests.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const G = 'game/demo';",
    "const args = process.argv.slice(2); const related = args[0] === '--related'; const given = related ? args.slice(1) : args;",
    "const re = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*\\*\\//g, '(?:.*/)?').replace(/\\*/g, '[^/]*')}$`);",
    "const globs = (v) => String(v || '').split(',').filter(Boolean).map(re);",
    "const ex = globs(process.env.STUDIO_TEST_EXCLUDE); const only = globs(process.env.STUDIO_TEST_ONLY);",
    "let list = related ? given.map((f) => `tests/${path.basename(f).split('.')[0]}.test.mjs`).filter((t) => fs.existsSync(`${G}/${t}`)) : given.length ? given : fs.readdirSync(`${G}/tests`).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/${f}`);",
    "if (only.length) list = list.filter((t) => only.some((r) => r.test(t))); else list = list.filter((t) => !ex.some((r) => r.test(t)));",
    "const soakRed = fs.existsSync(`${G}/notes/soak.md`) && fs.readFileSync(`${G}/notes/soak.md`, 'utf8').includes('SOAK-RED');",
    "let bad = 0;",
    "for (const t of list) {",
    "  if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\t${related ? 'related' : 'unit'}\\t${t}\\tEX=${process.env.STUDIO_TEST_EXCLUDE || ''};ONLY=${process.env.STUDIO_TEST_ONLY || ''}\\n`);",
    "  const n = path.basename(t).split('.')[0]; const src = `${G}/src/${n}.mjs`;",
    "  const fail = t.includes('.soak.') ? soakRed : fs.existsSync(src) && fs.readFileSync(src, 'utf8').includes('BREAKS');",
    "  if (fail) { console.log(` FAIL  ${t} > adds up`); bad += 1; } else console.log(` \\u2713 ${t} (1 test)`);",
    "}",
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    "process.exit(bad ? 1 : 0);", ''].join('\n'));
  for (const n of ['base']) { write(dir, `game/demo/src/${n}.mjs`, `export const ${n} = 1;\n`); write(dir, `game/demo/tests/${n}.test.mjs`, `// ${n}\n`); }
  write(dir, 'game/demo/tests/day60.soak.test.mjs', '// a long soak\n');
  write(dir, 'game/demo/notes/soak.md', '# soak\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-269p-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconsole.log(JSON.stringify(createLaneCopy(process.argv[2], { task: process.argv[3] })));\n`);
  /** A started task in its own lane copy with one commit adding src/<n>.mjs and tests/<n>.test.mjs. */
  const lane = (agent, n, { breaks = false } = {}) => {
    const id = addTask(`Code: add ${n}`);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    write(ld, `game/demo/src/${n}.mjs`, `export const ${n} = 1;${breaks ? ' // BREAKS' : ''}\n`);
    write(ld, `game/demo/tests/${n}.test.mjs`, `// ${n}\n`);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: add ${n}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const verifyIn = (l) => run(l.dir, 'node scripts/run-gates.mjs --no-detach', l.as);
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = (extra = {}) => run(dir, 'node harness/task.mjs train --by tester --now', { ...env, ...extra });
  const trainVerifies = (rows) => rows.filter((r) => /^train-[\w-]+$/.test(r.owner) && !/-(re|rel|tail)$/.test(r.owner));

  // ---------- reuse (a): one lane, its green verify replaced by the agent's next (dirty) verify, still reused ----------
  await guard('2.69.0 (p, reuse): a train of ONE lane whose integration tree is the lane\'s verified tree reuses the lane\'s green verify, even after the agent\'s next verify (on an edited tree) replaced its own record: no train verify runs, the log says "reused <lane>\'s green verify of tree <x>", the verify is kept by tree in .studio/gates/trees/ (fails on 2.68.0: the replaced record was gone and the train verified again)', () => {
    const L = lane('fx-one', 'one');
    const v1 = verifyIn(L);
    const tree = (g(L.dir, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
    fs.appendFileSync(path.join(L.dir, 'game/demo/src/one.mjs'), '// wip\n');
    const v2 = verifyIn(L); // a dirty verify: <agent>-full.json now says dirty
    g(L.dir, 'checkout', '--', 'game/demo/src/one.mjs');
    const q = queueIt(L);
    resetRan();
    const t = train();
    const log = out(t);
    const verifies = trainVerifies(ran());
    return [L.ok && v1.status === 0 && q.status === 0 && t.status === 0 && isDone(L.id) && verifies.length === 0 && new RegExp(`reused ${L.id}'s green verify of tree ${tree.slice(0, 8)}`).test(log) && fs.existsSync(path.join(dir, '.studio', 'gates', 'trees', `${tree}.json`)),
      `ok=${L.ok} v1=${v1.status} v2=${v2.status} q=${q.status} t=${t.status} done=${isDone(L.id)} verifies=${verifies.length}\n${out(v1).slice(-600)}\n${out(q).slice(-600)}\n${log.slice(-1500)}`];
  });

  // ---------- reuse (b): a multi-lane train orders the lane with a green verify of its own tree first ----------
  await guard('2.69.0 (p, reuse): in a multi-lane train, a lane whose own tree on main\'s tip has a green recorded verify is "prechecked" and ordered first ("prechecked first: <B> ..."; B lands before A on main though A was queued first) (fails on 2.68.0: queue order, no such line)', () => {
    const A = lane('fx-ga', 'ga');
    const B = lane('fx-gb', 'gb');
    const vb = verifyIn(B);
    const qa = queueIt(A); const qb = queueIt(B);
    const t = train();
    const log = out(t);
    const subjects = (g(dir, 'log', '--format=%s', '-6', 'main').stdout || '').split('\n');
    const ia = subjects.findIndex((s) => s.includes(A.id)); const ib = subjects.findIndex((s) => s.includes(B.id));
    return [A.ok && B.ok && vb.status === 0 && qa.status === 0 && qb.status === 0 && t.status === 0 && isDone(A.id) && isDone(B.id) && new RegExp(`prechecked first: ${B.id} \\(its tree [0-9a-f]{8} on main's tip has a green verify\\); then ${A.id}`).test(log) && ia >= 0 && ib > ia,
      `ok=${A.ok},${B.ok} vb=${vb.status} q=${qa.status},${qb.status} t=${t.status} order=${JSON.stringify(subjects)}\n${log.slice(-1800)}`];
  });

  // ---------- related first: the lane that breaks its related test is handed back before the full verify ----------
  await guard('2.69.0 (p, related): before the full verify of a multi-lane train, each lane\'s related tests run on the combined tree; the lane red there (D) is handed back at once with the failing test, the log and the facts block; C lands after ONE verify, no bisection re-check runs (fails on 2.68.0: a red verify, then bisection re-checks, and a hand-back that names no related tests)', () => {
    const C = lane('fx-rc', 'rc');
    const D = lane('fx-rd', 'rd', { breaks: true });
    const qc = queueIt(C); const qd = queueIt(D);
    resetRan();
    const t = train();
    const log = out(t);
    const rows = ran();
    const verifies = [...new Set(trainVerifies(rows).map((r) => r.owner))];
    const rechecks = rows.filter((r) => /-re$/.test(r.owner));
    const relRuns = rows.filter((r) => /-rel$/.test(r.owner) && r.as === 'related');
    const dr = droppedEv(D.id);
    const note = handBack(D.id);
    return [C.ok && D.ok && qc.status === 0 && qd.status === 0 && isDone(C.id) && !isDone(D.id) && /related tests fail on the combined train tree/.test(dr?.msg || '') && /tests\/rd\.test\.mjs > adds up/.test(dr?.msg || '')
      && /related tests fail on the combined train tree/.test(note) && rechecks.length === 0 && verifies.length === 1 && relRuns.some((r) => r.file === 'tests/rd.test.mjs') && relRuns.some((r) => r.file === 'tests/rc.test.mjs')
      && evs().some((e) => e.type === 'task.train.related_first' && (e.meta?.dropped || []).some((x) => x.task === D.id)),
      `ok=${C.ok},${D.ok} q=${qc.status},${qd.status} t=${t.status} done=${isDone(C.id)},${isDone(D.id)} verifies=${verifies} rechecks=${rechecks.length} rel=${JSON.stringify(relRuns)}\ndrop=${dr?.msg}\n${log.slice(-1800)}\nnote=${note.slice(0, 600)}`];
  });

  // ---------- slow tier ----------
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ slowTests: ['tests/*.soak.test.mjs'], gates: [unit, { id: 'soak', command: 'node game/demo/run-tests.mjs tests/day60.soak.test.mjs', tier: 'slow' }] }, null, 2)}\n`);
  write(dir, 'game/demo/notes/soak.md', '# soak\nSOAK-RED\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'slow tier', '--no-verify');
  await guard('2.69.0 (p, slow): a verify skips the slow check ("tier": "slow": SKIP with "slow tier") and the slow test globs (the unit check runs with STUDIO_TEST_EXCLUDE=tests/*.soak.test.mjs and never runs the soak test), and is green though the soak is red (fails on 2.68.0: the soak check ran and failed the verify)', () => {
    resetRan();
    const r = run(dir, 'node harness/game-gates.mjs', { ...env, STUDIO_LOCK_OWNER: 'fx-verify' });
    const rows = ran();
    return [r.status === 0 && /SKIP game:soak: slow tier/.test(out(r)) && rows.length > 0 && rows.every((x) => !x.file.includes('.soak.')) && rows.every((x) => /EX=tests\/\*\.soak\.test\.mjs;/.test(x.extra)), `exit ${r.status} rows=${JSON.stringify(rows)}\n${out(r).slice(-1500)}`];
  });
  await guard('2.69.0 (p, slow): `npm run gates -- --tier slow` runs only the slow tier on main (the slow check, and the unit check with STUDIO_TEST_ONLY=tests/*.soak.test.mjs), exits red, and files ONE bug task per new failure; a second run files nothing new (deduped while the task is open) (fails on 2.68.0: --tier slow ran an ordinary verify and filed nothing)', () => {
    resetRan();
    const r1 = run(dir, 'node scripts/run-gates.mjs --tier slow', { ...env, STUDIO_LOCK_OWNER: '' });
    const rows = ran();
    const b1 = board();
    const titles = b1.split('\n').filter((l) => /Bug: slow tier:/.test(l));
    const r2 = run(dir, 'node scripts/run-gates.mjs --tier slow', { ...env, STUDIO_LOCK_OWNER: '' });
    const titles2 = board().split('\n').filter((l) => /Bug: slow tier:/.test(l));
    let st = null;
    try { st = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'slow-tier.json'), 'utf8')); } catch {}
    return [r1.status === 1 && rows.length > 0 && rows.every((x) => x.file.includes('.soak.')) && rows.some((x) => /ONLY=tests\/\*\.soak\.test\.mjs$/.test(x.extra)) && titles.length === 2 && titles.some((l) => /tests\/day60\.soak\.test\.mjs > adds up \(game:unit\)/.test(l)) && titles.some((l) => /\(game:soak\)/.test(l))
      && r2.status === 1 && titles2.length === 2 && /already filed as T-\d+/.test(out(r2)) && st?.lastRun?.ok === false && Object.keys(st?.filed || {}).length === 2,
      `r1=${r1.status} r2=${r2.status} rows=${JSON.stringify(rows)}\ntitles=${JSON.stringify(titles)}\n${out(r1).slice(-1200)}\n${out(r2).slice(-600)}\nstate=${JSON.stringify(st)}`];
  });
  await guard('2.69.0 (p, slow): the supervisor\'s daily hook (slow-tier.mjs slowTierPass) starts the slow tier once a local day from STUDIO_SLOW_HOUR: not before the hour, once at it, not twice the same day, never with STUDIO_SLOW_HOUR=off (fails on 2.68.0: no slow tier)', () => {
    const probe = path.join(tmpRoot, `slow-269p-${process.pid}.mjs`);
    fs.writeFileSync(probe, [
      `import { slowTierPass } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'slow-tier.mjs')).href)};`,
      "import fs from 'node:fs'; import path from 'node:path';",
      "fs.rmSync(path.join(process.cwd(), '.studio', 'slow-tier.json'), { force: true });",
      'const at = (h) => { const d = new Date(2026, 10, 2, h, 5, 0); return d.getTime(); };',
      'let starts = 0; const start = () => { starts += 1; return 4242; };',
      'const early = await slowTierPass({ root: process.cwd(), now: at(2), env: { STUDIO_SLOW_HOUR: "3" }, start });',
      'const first = await slowTierPass({ root: process.cwd(), now: at(3), env: { STUDIO_SLOW_HOUR: "3" }, start });',
      'const again = await slowTierPass({ root: process.cwd(), now: at(9), env: { STUDIO_SLOW_HOUR: "3" }, start });',
      'const off = await slowTierPass({ root: process.cwd(), now: at(4) + 86400000, env: { STUDIO_SLOW_HOUR: "off" }, start });',
      'const next = await slowTierPass({ root: process.cwd(), now: at(4) + 86400000, env: {}, start });',
      'console.log(JSON.stringify({ early, first, again, off, next, starts }));', ''].join('\n'));
    const r = run(dir, `node "${probe}"`, env);
    fs.rmSync(probe, { force: true });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
    return [j && !j.early.started && j.first.started && !j.again.started && /already started today/.test(j.again.why) && !j.off.started && /off/.test(j.off.why) && j.next.started && j.starts === 2, out(r).slice(-1500)];
  });
  await guard('2.69.0 (p, reuse): a lane\'s scoped verify stands for a tier-B train\'s --all verify only when every game check ran for its files: a check whose "paths" skipped them keeps the train verifying (wholeEquiv / recordCovers) (fails on 2.68.0: no wholeEquiv; a scoped record never counted)', () => {
    write(dir, 'fx/m-open.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'x' }] })}\n`);
    write(dir, 'fx/m-paths.json', `${JSON.stringify({ gates: [{ id: 'unit', command: 'x' }, { id: 'art', command: 'y', paths: ['game/demo/art/**'] }] })}\n`);
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'fixtures', '--no-verify');
    const probe = path.join(tmpRoot, `whole-269p-${process.pid}.mjs`);
    fs.writeFileSync(probe, [
      `import { wholeEquiv, recordCovers } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};`,
      "import { spawnSync } from 'node:child_process';",
      "const tree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).stdout.trim();",
      "const changed = ['game/demo/src/x.mjs'];",
      "const rec = { at: new Date().toISOString(), tree, dirty: false, partial: false, scoped: true, changed, gatePaths: changed, rows: [{ id: 'game', ok: true, required: true }] };",
      "const open = recordCovers(rec, { root: process.cwd(), tree, changed, all: true, whole: wholeEquiv(process.cwd(), 'HEAD', { manifest: 'fx/m-open.json' }) });",
      "const paths = recordCovers(rec, { root: process.cwd(), tree, changed, all: true, whole: wholeEquiv(process.cwd(), 'HEAD', { manifest: 'fx/m-paths.json' }) });",
      "const wider = recordCovers(rec, { root: process.cwd(), tree, changed: [...changed, 'game/demo/src/y.mjs'], all: true, whole: wholeEquiv(process.cwd(), 'HEAD', { manifest: 'fx/m-open.json' }) });",
      'console.log(JSON.stringify({ open, paths, wider }));', ''].join('\n'));
    const r = run(dir, `node "${probe}"`, env);
    fs.rmSync(probe, { force: true });
    let j = null;
    try { j = JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch {}
    return [j && j.open.ok && !j.paths.ok && /skipped art by paths/.test(j.paths.why) && !j.wider.ok, out(r).slice(-1500)];
  });
  try { fs.rmSync(ranLog, { force: true }); fs.rmSync(laneProbe, { force: true }); } catch {}
}
