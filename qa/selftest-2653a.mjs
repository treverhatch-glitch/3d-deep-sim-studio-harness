/**
 * qa/selftest-2653a.mjs — 2.65.3 (a), B-43: a red merge train takes too long to find the lane that broke it.
 *   The crew's 9-lane train ran one verify, then 6+ re-checks of about 10 min each, every one the whole game gate, in
 *   an order that looked random (prefixes of a reduced set, never said), with no word on what each decided or how long
 *   was left. Now: (a) re-checks run only the failing test files (STUDIO_GATE_FOCUS, honoured only by an --only run);
 *   (b) the red event and the log name the failing tests, each re-check says its question, a new round says what it is,
 *   and the current step is in .studio/train/<id>/status.json for npm run lanes and status --brief; (c) once a culprit
 *   is named, the green prefix before it is verified in full and landed (STUDIO_TRAIN_LAND_PREFIX, default on) and the
 *   lanes after it go in the next train, which runs right away; (d) each re-check line, the status file and the event
 *   meta carry an ETA from this train's own timings ("ETA unknown (no timing yet)" before any).
 * A tiny studio: a made-up game whose test check is a node script that runs game/demo/tests/*.test.mjs (or the files
 * it is given), fails a file whose name a note in game/demo/notes "BREAKS", prints vitest-style lines and logs every
 * file it runs (RAN_LOG), so which files each run touched can be seen; lane copies with the commit hooks installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest2653A({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const events = path.join(dir, '.studio', 'events-2653a.jsonl');
  const ranLog = path.join(tmpRoot, `ran-2653a-${process.pid}.log`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: '', STUDIO_TRAIN_MAX: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2653a-${process.pid}.pem`), AGENT_EVENTS_FILE: events, RAN_LOG: ranLog, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const board = () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
  const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };
  const handBack = (id) => { const f = path.join(dir, 'studio', 'handoffs', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  const dropped = (id) => evs().some((e) => e.type === 'task.train.dropped' && e.task === id);
  const ran = () => { try { return fs.readFileSync(ranLog, 'utf8').split('\n').filter(Boolean).map((l) => { const [owner, as, file] = l.split('\t'); return { owner, as, file }; }); } catch { return []; } };
  const resetRan = () => { try { fs.rmSync(ranLog, { force: true }); } catch {} };

  // ---- the studio and its made-up game ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  const manifest = (gates) => `${JSON.stringify({ gates }, null, 2)}\n`;
  write(dir, 'game/demo/studio.gates.json', manifest([{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }]));
  write(dir, 'game/demo/run-tests.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const args = process.argv.slice(2); let as = 'unit'; const files = [];",
    "for (let i = 0; i < args.length; i += 1) { if (args[i] === '--as') { as = args[i + 1]; i += 1; } else files.push(args[i]); }",
    "const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "const nd = 'game/demo/notes';",
    "const notes = fs.existsSync(nd) ? fs.readdirSync(nd).map((f) => fs.readFileSync(path.join(nd, f), 'utf8')).join('\\n') : '';",
    "let bad = 0;",
    "for (const f of list) {",
    "  if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\t${as}\\t${f}\\n`);",
    "  const together = notes.includes(`BREAKS-WITH-OTHERS ${path.basename(f)}`) && list.length > 1;",
    "  if (notes.includes(`BREAKS ${path.basename(f)}`) || together) { console.log(` FAIL  ${f} > adds up`); bad += 1; } else console.log(` \\u2713 ${f} (1 test)`);",
    "}",
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    "process.exit(bad ? 1 : 0);", ''].join('\n'));
  for (const n of ['a', 'b', 'c', 'd']) write(dir, `game/demo/tests/${n}.test.mjs`, `// ${n}\n`);
  write(dir, 'game/demo/notes/readme.md', '# Notes\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-2653a-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  const lane = (agent, title, files) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = (extra = {}) => run(dir, 'node harness/task.mjs train --by tester --now', { ...env, ...extra });
  const trainJson = (r) => { const m = String(r.stdout || '').match(/\{\s*"train"[\s\S]*\}\s*$/); try { return JSON.parse(m[0]); } catch { return {}; } };

  // ---- 1-4. five lanes, the third breaks tests/b.test.mjs: focused re-checks, words, early prefix landing, ETA ----
  const P = [1, 2, 3, 4, 5].map((k) => lane(`fx-p${k}`, `Docs: note p${k}`, { [`game/demo/notes/p${k}.md`]: k === 3 ? 'BREAKS b.test.mjs\n' : `# p${k}\n` }));
  for (const l of P) queueIt(l);
  resetRan();
  const t1 = train();
  const j1 = trainJson(t1);
  const log1 = out(t1);
  const runs = ran();
  const verifyRuns = runs.filter((r) => /^train-[^\s]*$/.test(r.owner) && !/-re$/.test(r.owner));
  const recheckRuns = runs.filter((r) => /-re$/.test(r.owner));
  const ev1 = evs();
  const recheckEvs = ev1.filter((e) => e.type === 'task.train.recheck');
  const red1 = ev1.filter((e) => e.type === 'task.train.red').pop();
  report('2.65.3 (B-43, a): a red train\'s re-checks run only the failing test files: the verify ran all four test files, every re-check ran only game/demo/tests/b.test.mjs (the manifest\'s "focus" command), and the log says so (fails on 2.65.2: each re-check ran the whole game check, all four files)',
    P.every((l) => l.ok) && verifyRuns.length >= 4 && ['a', 'b', 'c', 'd'].every((n) => verifyRuns.some((r) => r.file === `game/demo/tests/${n}.test.mjs`)) && recheckRuns.length >= 2 && recheckRuns.every((r) => r.file === 'game/demo/tests/b.test.mjs')
      && /re-checks run only the failing test files \(game:unit: game\/demo\/tests\/b\.test\.mjs\)/.test(log1),
    `ok=${P.map((l) => l.ok)} v=${verifyRuns.length} r=${recheckRuns.length} runs=${JSON.stringify(runs.slice(0, 30))}\n${log1.slice(-1500)}`);
  report('2.65.3 (B-43, b): the red event and the log name the failing test (game:unit: game/demo/tests/b.test.mjs > adds up); each re-check line says its question ("re-check 1 of about 4: lanes 1-5 red in the verify; is main itself red?", "... is the break in lanes 1-2?") and is a task.train.recheck event (fails on 2.65.2: "re-check 1: game on main" only)',
    /failing tests: game:unit: game\/demo\/tests\/b\.test\.mjs > adds up/.test(log1) && (red1?.meta?.failingTests || []).some((t) => /b\.test\.mjs/.test(t))
      && /re-check 1 of about 4: lanes 1-5 red in the verify; is main itself red\?/.test(log1) && /re-check 2 of about 4: lanes 1-5; main green, red at 5 \(the verify\); is the break in lanes 1-2\?/.test(log1)
      && /re-check 3 of about 4: lanes 1-5; green through lane 2 \(T-\d+\), red at 5 \(the verify\); is the break in lane 3 \(T-\d+\)\?/.test(log1) && recheckEvs.length >= 3,
    `${log1.slice(-3000)}\nred=${JSON.stringify(red1?.meta)}`);
  const pl = ev1.find((e) => e.type === 'task.train.prefix_landed');
  const landedEvs = ev1.filter((e) => e.type === 'task.train.landed');
  const deferred45 = ev1.filter((e) => e.type === 'task.train.deferred' && [P[3].id, P[4].id].includes(e.task));
  report('2.65.3 (B-43, c): once the culprit (lane 3) is named, main + lanes 1-2 are verified in full and land first; lane 3 is handed back; lanes 4-5 are deferred "on top of" the green prefix and land in the next train, run right away by the same command (two trains, queue empty, no person) (fails on 2.65.2: no early landing; lanes 1, 2, 4, 5 landed together after a round-2 verify)',
    t1.status === 0 && pl?.meta?.lanes?.join(',') === `${P[0].id},${P[1].id}` && pl?.meta?.culprit === P[2].id && dropped(P[2].id) && !isDone(P[2].id) && /pass on main \+/.test(handBack(P[2].id))
      && [P[0], P[1], P[3], P[4]].every((l) => isDone(l.id)) && deferred45.length === 2 && deferred45.every((e) => /on top of them/.test(e.msg)) && landedEvs.length >= 2
      && landedEvs[landedEvs.length - 2].meta?.lanes?.join(',') === `${P[0].id},${P[1].id}` && landedEvs[landedEvs.length - 1].meta?.lanes?.join(',') === `${P[3].id},${P[4].id}` && (j1.trains || []).length === 2 && queue().length === 0,
    `${log1.slice(-3500)}\njson=${JSON.stringify(j1).slice(0, 800)}\nqueue=${queue()}\nnote=${handBack(P[2].id).slice(-400)}`);
  const tid = j1.train || (j1.trains || [])[0];
  let st1 = null;
  try { st1 = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', String(tid), 'status.json'), 'utf8')); } catch {}
  const etaOk = recheckEvs.length >= 3 && recheckEvs.every((e) => /^ETA ~\d+ (s|min)/.test(e.meta?.eta?.text || '') && Number(e.meta?.eta?.ms) > 0) && /ETA ~\d+ (s|min)/.test(red1?.meta?.eta?.text || '');
  report('2.65.3 (B-43, d): every re-check line and task.train.recheck event, and the red event\'s meta, carry an ETA from this train\'s own timings ("ETA ~N s (k re-check(s) x ... + 1 verify x ...)"); the train\'s status file .studio/train/<id>/status.json is written (fails on 2.65.2: no ETA, no status file)',
    etaOk && /re-check \d+ of about \d+: .*; ETA ~\d+ (s|min) \(/.test(log1) && st1?.train === tid && st1?.step === 'done',
    `${recheckEvs.map((e) => JSON.stringify(e.meta?.eta)).join('\n')}\nred=${JSON.stringify(red1?.meta?.eta)}\nstatus=${JSON.stringify(st1)}`);

  // ---- 5. STUDIO_TRAIN_LAND_PREFIX=off: as 2.65.2 (one train, lanes 1 and 3 land together); the new round says so ----
  const R = [1, 2, 3].map((k) => lane(`fx-r${k}`, `Docs: note r${k}`, { [`game/demo/notes/r${k}.md`]: k === 2 ? 'BREAKS c.test.mjs\n' : `# r${k}\n` }));
  for (const l of R) queueIt(l);
  const before5 = evs().length;
  const t5 = train({ STUDIO_TRAIN_LAND_PREFIX: 'off' });
  const ev5 = evs().slice(before5);
  report('2.65.3 (B-43, b, c): with STUDIO_TRAIN_LAND_PREFIX=off the train behaves as 2.65.2 (the culprit, lane 2, handed back; lanes 1 and 3 land together after one more verify, nobody deferred, one train) and the new round says what it is: "round 2: 2 lane(s) left without <lane 2>; verify, then bisect again if red" (fails on 2.65.2: no round line)',
    R.every((l) => l.ok) && t5.status === 0 && dropped(R[1].id) && isDone(R[0].id) && isDone(R[2].id) && !ev5.some((e) => e.type === 'task.train.prefix_landed' || e.type === 'task.train.deferred')
      && ev5.filter((e) => e.type === 'task.train.landed').length === 1 && new RegExp(`round 2: 2 lane\\(s\\) left without ${R[1].id} \\(${R[0].id}, ${R[2].id}\\); verify, then bisect again if red`).test(out(t5)) && queue().length === 0,
    out(t5).slice(-2500));

  // ---- 5b. a test file that fails only together with others: the focused search can't see it, so it searches again whole ----
  const Q = [1, 2, 3].map((k) => lane(`fx-q${k}`, `Docs: note q${k}`, { [`game/demo/notes/q${k}.md`]: k === 2 ? 'BREAKS-WITH-OTHERS d.test.mjs\n' : `# q${k}\n` }));
  for (const l of Q) queueIt(l);
  const before5b = evs().length;
  const t5b = train();
  const ev5b = evs().slice(before5b);
  report('2.65.3 (B-43, a): a test file that fails only when run together with the others (d.test.mjs here) passes in a focused re-check on the train\'s own tree; instead of calling the train flaky, the train says so and searches again with the whole failing gate: lane 2 is handed back, lanes 1 and 3 land (fails on 2.65.2: no such search; without it the focused search called the red train flaky and handed nobody back)',
    Q.every((l) => l.ok) && t5b.status === 0 && /the failing test files pass when run on their own on the train's tree \(they fail only together with other tests\): searching again with the whole failing gate/.test(out(t5b))
      && dropped(Q[1].id) && !isDone(Q[1].id) && isDone(Q[0].id) && isDone(Q[2].id) && !ev5b.some((e) => e.type === 'task.train.flaky') && queue().length === 0,
    out(t5b).slice(-3000));

  // ---- 6-7. game-gates with STUDIO_GATE_FOCUS: template, node --test appended, fallbacks; never in a verify ----
  write(dir, 'game/demo/nt/a.test.mjs', "import test from 'node:test'; import fs from 'node:fs';\ntest('a', () => { if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\tnt\\ta.test.mjs\\n`); });\n");
  write(dir, 'game/demo/nt/b.test.mjs', "import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs';\ntest('b adds', () => { if (process.env.RAN_LOG) fs.appendFileSync(process.env.RAN_LOG, `${process.env.STUDIO_LOCK_OWNER || '-'}\\tnt\\tb.test.mjs\\n`); assert.equal(process.env.NT_FAIL ? 1 : 2, 2); });\n");
  write(dir, 'game/demo/studio.gates.json', manifest([
    { id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' },
    { id: 'nt', command: 'cd game/demo/nt && node --test --test-reporter=tap' },
    { id: 'plain', command: 'node game/demo/run-tests.mjs --as plain' },
    { id: 'broken', command: 'node game/demo/run-tests.mjs --as broken', focus: 'node game/demo/no-such-runner.mjs {files}' },
  ]));
  g(dir, 'add', '-A'); spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'fixture: more game checks', '--no-verify'], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, STUDIO_MAIN_COMMIT: 'allow' } });
  const ntB = path.join(dir, 'game', 'demo', 'nt', 'b.test.mjs').split(path.sep).join('/');
  const focus = JSON.stringify({ 'game:nt': [ntB], 'game:plain': ['game/demo/tests/a.test.mjs'], 'game:broken': ['game/demo/tests/a.test.mjs'] });
  resetRan();
  const o6 = run(dir, 'node scripts/run-gates.mjs --no-detach --only game', { ...env, STUDIO_LOCK_OWNER: 'probe-only', STUDIO_GATE_FOCUS: focus });
  const r6 = ran();
  let rec6 = null;
  try { rec6 = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'gates', 'probe-only.json'), 'utf8')); } catch {}
  resetRan();
  const o6b = run(dir, 'node scripts/run-gates.mjs --no-detach', { ...env, STUDIO_LOCK_OWNER: 'probe-full', STUDIO_GATE_FOCUS: focus });
  const r6b = ran();
  const t6 = out(o6);
  report('2.65.3 (B-43, a): run-gates --only game with STUDIO_GATE_FOCUS: a check not in the map is skipped (it passed in the verify); a `node --test` check gets the failing file appended (only b ran); a check whose command isn\'t a clear runner and has no "focus" runs whole, saying why; a "focus" command that fails without naming a test falls back to the whole check, saying so; the record is partial with focus: true. A run without --only ignores STUDIO_GATE_FOCUS: every check ran every file (fails on 2.65.2: the focus was ignored, every file ran)',
    o6.status === 0 && /SKIP game:unit: it passed in the train's verify/.test(t6) && r6.filter((r) => r.as === 'nt').map((r) => r.file).join(',') === 'b.test.mjs'
      && /game:plain: the whole check runs, not a focused re-check: its command .* doesn't clearly run vitest, jest or node --test/.test(t6) && r6.filter((r) => r.as === 'plain').length === 4
      && /game:broken: the focused run exited 1 without naming a failing test; running the whole check instead/.test(t6) && r6.filter((r) => r.as === 'broken').length === 4
      && rec6?.partial === true && rec6?.focus === true
      && r6b.filter((r) => r.as === 'unit').length === 4 && r6b.filter((r) => r.as === 'nt').length === 2 && r6b.filter((r) => r.as === 'plain').length === 4 && !/focused re-check|SKIP game:unit/.test(out(o6b)),
    `${t6.slice(-2500)}\nran=${JSON.stringify(r6)}\nrec=${JSON.stringify(rec6 && { partial: rec6.partial, focus: rec6.focus })}\nfull ran=${JSON.stringify(r6b)}`);
  const o7 = run(dir, 'node harness/game-gates.mjs', { ...env, NT_FAIL: '1', STUDIO_LOCK_OWNER: 'probe-nt' });
  const m7 = out(o7).match(/^\[game-gates\] failing test files in game:nt: (\[.*\])$/m);
  let f7 = [];
  try { f7 = JSON.parse(m7[1]); } catch {}
  report('2.65.3 (B-43, a): a failing `node --test` check (TAP) names its failing test file, absolute and with forward slashes, in "[game-gates] failing test files in game:nt: [...]" (fails on 2.65.2: no such line)',
    o7.status === 1 && f7.length === 1 && f7[0] === ntB,
    out(o7).slice(-1500));

  // ---- 8. the pure pieces: parsing (Windows paths too), the focus command, the ETA ----
  const probe = path.join(tmpRoot, `pure-2653a-${process.pid}.mjs`);
  fs.writeFileSync(probe, `import { failingTestFiles, focusCommand, clearRunner, readFocus, trainFocus } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train-focus.mjs')).href)};
import { trainEta, capNote, stepsLeft } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train-status.mjs')).href)};
const vitestWin = [' FAIL  src\\\\sim\\\\b.test.ts > suite > adds', ' \\u276F src\\\\sim\\\\c.test.ts (3 tests | 1 failed) 12ms', ' \\u276F src\\\\sim\\\\engine.ts:40:3', ' FAIL  |unit| src/ui/d.test.tsx > renders', 'FAIL pin:throughput: expected 10, got 11', 'Test Files  2 failed | 5 passed (7)'].join('\\r\\n');
const jestWin = ['FAIL src\\\\a.test.js (5.2 s)', 'PASS src\\\\ok.test.js', 'FAIL  src/e.test.js'].join('\\n');
const nodeSpecWin = ['\\u2716 failing tests:', '', 'test at C:\\\\game\\\\nt\\\\b.test.mjs:2:1', '\\u2716 b adds (1.2ms)'].join('\\n');
const tapWin = ['ok 1 - a', '  ---', "  location: 'C:\\\\game\\\\nt\\\\a.test.mjs:2:1'", 'not ok 2 - c', '  ---', "  location: 'C:\\\\game\\\\nt\\\\c.test.mjs:3:1'", 'not ok 3 - d', "  location: 'file:///C:/game/nt/d.test.mjs:1:1'"].join('\\n');
const log = ['[game-gates] FAIL game:unit: exit 1', '[game-gates] failing tests in game:unit: ["src/b.test.ts > adds"]', '[game-gates] failing test files in game:unit: ["src\\\\\\\\b.test.ts"]', '[game-gates] FAIL game:lint: exit 1'].join('\\n');
console.log(JSON.stringify({
  vitest: failingTestFiles(vitestWin), jest: failingTestFiles(jestWin), spec: failingTestFiles(nodeSpecWin), tap: failingTestFiles(tapWin),
  tmpl: focusCommand({ command: 'x', focus: 'npx vitest run {files}' }, ['src/b.test.ts']),
  vit: focusCommand({ command: 'cd game/x && npx vitest run' }, ['src/b.test.ts', 'src/c.test.ts']),
  jestC: clearRunner('npx jest --ci'), nodeC: clearRunner('node --test'), npmC: clearRunner('npm test'), pipeC: clearRunner('npx vitest run | tee out.txt'), afterC: clearRunner('npx vitest run && node report.mjs'),
  plain: focusCommand({ command: 'npm test' }, ['a.test.js']).why || '', unsafe: focusCommand({ command: 'npx vitest run' }, ['a"; rm -rf x']).why || '', none: focusCommand({ command: 'npx vitest run' }, []).why || '',
  env: readFocus({ STUDIO_GATE_FOCUS: '{"game:unit":["src\\\\\\\\b.test.ts"]}' }), badEnv: readFocus({ STUDIO_GATE_FOCUS: 'game:unit:b' }),
  tf: trainFocus(log).focus, tfNone: trainFocus('[game-gates] FAIL game:unit: exit 1').why,
  eta0: trainEta({ rechecks: 3 }).text, etaV: trainEta({ rechecks: 3, verifyMs: 600000 }), etaR: trainEta({ rechecks: 2, recheckMs: [60000, 120000], verifyMs: 600000 }),
  cap6: capNote(6), cap9: capNote(9, {}), steps: [stepsLeft(0, 9), stepsLeft(2, 5), stepsLeft(0, 5, false)],
}));`);
  const pr = run(dir, `node "${probe}"`, env);
  let pj = {};
  try { pj = JSON.parse(String(pr.stdout).trim().split('\n').pop()); } catch {}
  report('2.65.3 (B-43, a, d): failing test files are read from vitest, jest and node --test output with Windows backslashes (as forward slashes; a stack frame and a pin name are not files); "focus" templates and clear runners (vitest, jest, node --test as the last step, no pipe) get the files quoted; npm test, an unsafe path or no file fall back with a reason; STUDIO_GATE_FOCUS must be JSON; the ETA says "ETA unknown (no timing yet)" with nothing measured, uses the verify for an untimed re-check and the mean of timed ones (fails on 2.65.2: none of this exists)',
    JSON.stringify(pj.vitest) === JSON.stringify(['src/sim/b.test.ts', 'src/sim/c.test.ts', 'src/ui/d.test.tsx']) && JSON.stringify(pj.jest) === JSON.stringify(['src/a.test.js', 'src/e.test.js'])
      && JSON.stringify(pj.spec) === JSON.stringify(['C:/game/nt/b.test.mjs']) && JSON.stringify(pj.tap) === JSON.stringify(['C:/game/nt/c.test.mjs', 'C:/game/nt/d.test.mjs'])
      && pj.tmpl?.cmd === 'npx vitest run "src/b.test.ts"' && pj.vit?.cmd === 'cd game/x && npx vitest run "src/b.test.ts" "src/c.test.ts"' && pj.jestC === 'jest' && pj.nodeC === 'node --test' && pj.npmC === null && pj.pipeC === null && pj.afterC === null
      && /doesn't clearly run/.test(pj.plain) && /isn't safe/.test(pj.unsafe) && /named no failing test file/.test(pj.none)
      && JSON.stringify(pj.env) === JSON.stringify({ 'game:unit': ['src/b.test.ts'] }) && pj.badEnv === null
      && JSON.stringify(pj.tf) === JSON.stringify({ 'game:unit': ['src/b.test.ts'], 'game:lint': [] }) && /names no failing test file/.test(pj.tfNone)
      && pj.eta0 === 'ETA unknown (no timing yet)' && pj.etaV?.ms === 2400000 && /no re-check timed yet: the verify stands in/.test(pj.etaV?.text) && pj.etaR?.ms === 780000 && /^ETA ~13 min/.test(pj.etaR?.text)
      && pj.cap6 === '' && /9 lanes.*STUDIO_TRAIN_MAX.*now 0: no cap/.test(pj.cap9) && JSON.stringify(pj.steps) === '[4,2,4]',
    out(pr).slice(-2500));

  // ---- 9. npm run lanes and status --brief show the running train's step, ETA and the cap note ----
  const lockF = path.join(dir, '.studio', 'locks', 'train.lock');
  fs.mkdirSync(path.dirname(lockF), { recursive: true });
  fs.writeFileSync(lockF, JSON.stringify({ pid: process.pid, at: Date.now(), id: 'fake-2653a', by: 'tester' }));
  write(dir, '.studio/train/fake-2653a/status.json', JSON.stringify({ train: 'fake-2653a', at: new Date().toISOString(), step: 'recheck', text: 're-check 3 of about 5: lanes 1-9; green through lane 2 (T-1), red at 9; is the break in lanes 3-5?', lanes: 9, round: 1, eta: { ms: 1500000, text: 'ETA ~25 min (3 re-check(s) x 5 min + 1 verify x 10 min)' } }));
  const o9 = run(dir, 'node harness/lanes.mjs --no-stamps', env);
  const o9b = run(dir, 'node harness/status.mjs --brief --peek', env);
  try { fs.rmSync(lockF, { force: true }); } catch {}
  report('2.65.3 (B-43, b, c, d): while a train runs, npm run lanes shows "Train <id> (9 lanes): re-check 3 of about 5 ... is the break in lanes 3-5?; ETA ~25 min" and a note that STUDIO_TRAIN_MAX caps a train of more than 6 lanes; status --brief has a short "Train" line with the ETA (fails on 2.65.2: neither shows the train)',
    /Train fake-2653a \(9 lanes\): re-check 3 of about 5: lanes 1-9; .*is the break in lanes 3-5\?; ETA ~25 min/.test(out(o9)) && /note: this train has 9 lanes.*STUDIO_TRAIN_MAX/.test(out(o9))
      && /Train \(9 lanes\): re-check 3 of about 5: lanes 1-9; ETA ~25 min \(STUDIO_TRAIN_MAX caps lanes\)\./.test(out(o9b)),
    `${out(o9).slice(-1500)}\n---\n${out(o9b).slice(-800)}`);
  for (const p of [laneProbe, probe, ranLog]) { try { fs.rmSync(p, { force: true }); } catch {} }
}
