/**
 * qa/selftest-267f.mjs — 2.67.0 (f): the proactive chain-tail fixer in the merge train (the owner's idea).
 *   The crew's train 13 bisected a stacked chain that only passes as a whole plus one fix: it handed back the chain's
 *   first lane and landed one lane; an outside agent wrote the missing fix (T-141) by hand. Now, before the verify, the
 *   train builds main + the chain in a second scratch copy, runs the chain's touched tests and the pins' report there;
 *   red: ONE "chain tail" builder task stacked on the chain's last lane (hand-off note: failing tests, pin diff); the
 *   verify red on exactly those tests defers the whole chain "waiting for its tail" (no bisection, nobody handed back),
 *   later trains leave it out until the tail is queued, then chain + tail land together.
 * A tiny studio: a made-up game whose test check runs game/demo/tests/*.test.mjs (or the files it is given). A note
 * "NEEDS-TAIL <file>" fails that file (a pin test, "pins > total") unless a note "TAIL-FIX <file>" is there too;
 * "BREAKS <file>" fails it ("adds up", not a pin). The pins' report counts the notes; lane copies with the hooks on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest267F({ dir, run, report, tmpRoot, root }) {
  // The size rule reads JavaScript with the typescript package: a copy made without node_modules (the full selftest's
  // copyRepo) gets the harness's own, linked, as selftest-263i does. Without it the tail lane's `task done` was refused
  // ("the size check can't read JavaScript"), so the tail never queued (CI release-gate, 2.67.0).
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const events = path.join(dir, '.studio', 'events-267f.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_GATE_FOCUS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_LAND_PREFIX: '', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_CHAIN_TAIL: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-267f-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const isDone = (id) => Boolean(id) && new RegExp(`\\*\\*${id}\\*\\*`).test(read('studio/DONE.md') + (read('studio/NEXT.md').split(/^## DONE/im)[1] || ''));
  const handBack = (id) => read(`studio/handoffs/${id}.md`);
  const holds = () => { try { return JSON.parse(read('studio/task-holds.json')).tasks || {}; } catch { return {}; } };
  const tailTasks = () => (read('studio/NEXT.md').match(/\*\*T-\d+\*\*[^\n]*chain tail for[^\n]*/g) || []);

  // ---- the studio and its made-up game ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({
    gates: [{ id: 'unit', command: 'node game/demo/run-tests.mjs', focus: 'node game/demo/run-tests.mjs {files}' }],
    pins: { tests: ['total'], report: 'node game/demo/pins.mjs report --out {out}', refresh: 'node game/demo/pins.mjs refresh --in {in}' },
  }, null, 2)}\n`);
  write(dir, 'game/demo/run-tests.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "const files = process.argv.slice(2);",
    "const d = 'game/demo/tests';",
    "const list = files.length ? files : fs.readdirSync(d).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${d}/${f}`);",
    "const nd = 'game/demo/notes';",
    "const notes = fs.existsSync(nd) ? fs.readdirSync(nd).map((f) => fs.readFileSync(path.join(nd, f), 'utf8')).join('\\n') : '';",
    "let bad = 0;",
    "for (const f of list) {",
    "  const b = path.basename(f);",
    "  if (notes.includes(`NEEDS-TAIL ${b}`) && !notes.includes(`TAIL-FIX ${b}`)) { console.log(` FAIL  ${f} > pins > total`); bad += 1; }",
    "  else if (notes.includes(`BREAKS ${b}`)) { console.log(` FAIL  ${f} > adds up`); bad += 1; }",
    "  else console.log(` \\u2713 ${f} (1 test)`);",
    "}",
    "console.log(`Test Files  ${bad ? `${bad} failed | ` : ''}${list.length - bad} passed (${list.length})`);",
    "process.exit(bad ? 1 : 0);", ''].join('\n'));
  write(dir, 'game/demo/pins.mjs', [
    "import fs from 'node:fs';",
    "const [cmd, , file] = process.argv.slice(2);",
    "if (cmd === 'report') fs.writeFileSync(file, JSON.stringify({ total: fs.readdirSync('game/demo/notes').length }));",
    "else fs.writeFileSync('game/demo/pins.expected.json', `${fs.readFileSync(file, 'utf8')}\\n`);", ''].join('\n'));
  write(dir, 'game/demo/pins.expected.json', '{"total":1}\n');
  for (const n of ['a', 'b']) write(dir, `game/demo/tests/${n}.test.mjs`, `// ${n}\n`);
  write(dir, 'game/demo/notes/readme.md', '# Notes\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-267f-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  const lane = (agent, title, files, { pins = false, id: given = null } = {}) => {
    const id = given || addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`, ...(pins ? ['-m', 'Pin-Moves: total'] : [])], { windowsHide: true, cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: Boolean(id) && fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const chainOf = (tag, k, needs) => {
    const L = [];
    for (let i = 1; i <= k; i += 1) L.push(lane(`fx-${tag}${i}`, `Docs: ${tag} step ${i}`, { [`game/demo/notes/${tag}${i}.md`]: i === 1 && needs ? `NEEDS-TAIL ${tag}1.test.mjs\n` : `# ${tag}${i}\n`, [`game/demo/tests/${tag}${i}.test.mjs`]: `// ${tag}${i}\n` }, { pins: true }));
    for (let i = 1; i < k; i += 1) run(dir, `node harness/task.mjs block ${L[i].id} --until ${L[i - 1].id} --by tester`, env);
    return L;
  };
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = (extra = {}) => run(dir, 'node harness/task.mjs train --by tester --now', { ...env, ...extra });
  const of = (list, type, pred = () => true) => list.filter((e) => e.type === type && pred(e));

  // ---- 1. a chain of 3 whose pins pass only with a tail fix, plus an unrelated green lane ----
  const C = chainOf('c', 3, true);
  const O = lane('fx-o', 'Docs: other note', { 'game/demo/notes/o.md': '# o\n' });
  for (const l of [...C, O]) queueIt(l);
  const b1 = evs().length;
  const t1 = train();
  const ev1 = evs().slice(b1);
  const log1 = out(t1);
  const opened = of(ev1, 'task.train.chain_tail', (e) => e.meta?.action === 'opened').pop();
  const T = opened?.meta?.tail || null;
  const iOpen = ev1.indexOf(opened);
  const iVerify = ev1.findIndex((e) => e.type === 'task.train.verify');
  const note = T ? handBack(T) : '';
  report('2.67.0 (f, 1-2): a train starting with a stacked chain of 3 (--until links, Pin-Moves: total) runs the chain\'s touched tests and the pins\' report in a second copy BEFORE its verify, finds c1.test.mjs red, and opens ONE chain-tail task: a builder "Bug: chain tail for <c1>, <c2>, <c3>" task (P0) stacked on the last lane (--after <c3>), its note naming the failing test, the pin diff (total: 1 -> 4, declared by the lanes) and the git merge lines; a task.train.chain_tail event (action opened) comes before the first verify (fails on 2.66.0: no chain-tail check, no task)',
    C.every((l) => l.ok) && O.ok && Boolean(T) && iOpen >= 0 && iVerify > iOpen && tailTasks().length === 1 && new RegExp(`\\*\\*${T}\\*\\* \\[P0\\] \\(\x60builder\x60\\) — Bug: chain tail for ${C[0].id}, ${C[1].id}, ${C[2].id}`).test(read('studio/NEXT.md'))
      && (holds()[T]?.after || []).join(',') === C[2].id && (holds()[T]?.chainTail?.chain || []).join(',') === C.map((l) => l.id).join(',')
      && /c1\.test\.mjs > pins > total/.test(note) && /total: 1 -> 4 \(declared by /.test(note) && new RegExp(`git merge --no-edit [0-9a-f]{40}   # ${C[0].id}`).test(note)
      && /chain-tail check 1: main \+ /.test(log1),
    `ok=${C.map((l) => l.ok)},${O.ok} ${C[0].log.slice(-300)}\nT=${T} iOpen=${iOpen} iVerify=${iVerify}\nnext=${read('studio/NEXT.md').slice(-800)}\nholds=${JSON.stringify(holds()[T])}\nnote=${note.slice(0, 900)}\n${log1.slice(-3000)}`);
  const def1 = of(ev1, 'task.train.deferred', (e) => C.some((l) => l.id === e.task));
  report('2.67.0 (f, 3): the verify is red on exactly the chain\'s test, so the whole chain is deferred "waiting for its tail <T>": no bisection, nobody handed back (no hand-back note for lane 1), the chain stays queued; the unrelated lane lands on the next round; a chain_tail event (action deferred) and the log say so (fails on 2.66.0: the train bisected and handed back lane 1)',
    Boolean(T) && def1.length === 3 && def1.every((e) => new RegExp(`waiting for its tail ${T}`).test(e.msg)) && !of(ev1, 'task.train.dropped').length && !of(ev1, 'task.train.bisect').length
      && !/Not landed by merge train/.test(handBack(C[0].id)) && C.every((l) => !isDone(l.id)) && isDone(O.id)
      && of(ev1, 'task.train.chain_tail', (e) => e.meta?.action === 'deferred').length === 1 && new RegExp(`wait for ${T} \\(not bisected, nobody handed back\\)`).test(log1),
    `${log1.slice(-3500)}\ndeferred=${def1.map((e) => e.msg).join('\n')}`);
  const lanes1 = run(dir, 'node harness/lanes.mjs --full --no-stamps', env);
  report('2.67.0 (f, 4): npm run lanes says the chain waits for its tail ("chain <c1>, <c2>, <c3> waits for its tail <T> ... it lands with <T> once <T> is queued") (fails on 2.66.0: no such note)',
    Boolean(T) && new RegExp(`note: chain ${C[0].id}, ${C[1].id}, ${C[2].id} waits for its tail ${T} \\(chain tail, train `).test(out(lanes1)),
    out(lanes1).slice(-1500));

  // ---- 2. dedupe: the next train leaves the chain out (its tail isn't queued) and files no second tail ----
  const b2 = evs().length;
  const t2 = train();
  const ev2 = evs().slice(b2);
  report('2.67.0 (f, dedupe): a second train with the tail not queued leaves the chain out before any verify (deferred, wait "tail") and never files a second tail for the same chain and failure (one tail task, one record) (fails on 2.66.0: no tail at all)',
    Boolean(T) && !of(ev2, 'task.train.verify').length && !of(ev2, 'task.train.chain_tail', (e) => e.meta?.action === 'opened').length && tailTasks().length === 1
      && (JSON.parse(read('.studio/train/chain-tails.json') || '[]')).length === 1 && C.every((l) => of(ev2, 'task.train.deferred', (e) => e.task === l.id && e.meta?.wait === 'tail').length === 1),
    `${out(t2).slice(-2000)}\nrecs=${read('.studio/train/chain-tails.json').slice(0, 600)}`);

  // ---- 3. the tail: its start isn't held by its --after; once queued, the next train lands the chain and the tail ----
  const TL = T ? lane('fx-tail', 'tail', { 'game/demo/notes/tail.md': 'TAIL-FIX c1.test.mjs\n', 'game/demo/tests/tail.test.mjs': '// tail\n' }, { id: T }) : { ok: false, log: 'no tail' };
  const q3 = TL.ok ? queueIt(TL) : { stdout: '', stderr: '' };
  const b3 = evs().length;
  const t3 = TL.ok ? train() : { stdout: '', stderr: 'no tail' };
  const ev3 = evs().slice(b3);
  const landed3 = of(ev3, 'task.train.landed').pop();
  report('2.67.0 (f, 3): the tail starts although its --after lane hasn\'t landed (a chain tail\'s start isn\'t held by the chain it fixes); once it is queued the next train takes the chain and the tail together and lands all four on one verify, nobody handed back (fails on 2.66.0: no tail; lane 1 was handed back)',
    TL.ok && [...C.map((l) => l.id), T].every((id) => isDone(id)) && Boolean(landed3) && [...C.map((l) => l.id), T].every((id) => (landed3.meta?.lanes || []).includes(id)) && !of(ev3, 'task.train.dropped').length
      && !of(ev3, 'task.train.chain_tail', (e) => e.meta?.action === 'opened').length,
    `--- train:\n${out(t3).slice(-700)}\n--- tail lane:\n${TL.log.slice(-500)}\n--- queue it:\n${out(q3).slice(-600)}`);

  // ---- 4. STUDIO_TRAIN_CHAIN_TAIL=off: 2.66.0 behaviour (no check, no tail, the chain bisected, lane 1 handed back) ----
  const D = chainOf('d', 2, true);
  for (const l of D) queueIt(l);
  const b4 = evs().length;
  const t4 = train({ STUDIO_TRAIN_CHAIN_TAIL: 'off' });
  const ev4 = evs().slice(b4);
  report('2.67.0 (f, off): with STUDIO_TRAIN_CHAIN_TAIL=off the train behaves as 2.66.0: no chain-tail check or task, the red chain is bisected and its first lane handed back (passes on 2.66.0 too: the setting keeps the old behaviour)',
    D.every((l) => l.ok) && !of(ev4, 'task.train.chain_tail').length && !/chain-tail check/.test(out(t4)) && of(ev4, 'task.train.bisect').length >= 1
      && of(ev4, 'task.train.dropped', (e) => e.task === D[0].id).length === 1,
    out(t4).slice(-2500));

  // ---- 5. a red on other tests too: handled as before (bisected), even with a tail filed for the chain ----
  const E = chainOf('e', 2, true);
  const X = lane('fx-x', 'Docs: x note', { 'game/demo/notes/x.md': 'BREAKS a.test.mjs\n' });
  for (const l of [...E, X]) queueIt(l);
  const b5 = evs().length;
  const t5 = train();
  const ev5 = evs().slice(b5);
  report('2.67.0 (f, unrelated red): a chain with its tail opened before the verify, plus a lane that breaks a.test.mjs: the verify fails on the chain\'s test AND a.test.mjs, which is not exactly the chain\'s tests, so the train bisects as before (bisect event, a lane handed back, no chain deferral) (fails on 2.66.0: no tail is opened)',
    E.every((l) => l.ok) && X.ok && of(ev5, 'task.train.chain_tail', (e) => e.meta?.action === 'opened').length === 1 && of(ev5, 'task.train.bisect').length >= 1
      && of(ev5, 'task.train.dropped').length >= 1 && !of(ev5, 'task.train.chain_tail', (e) => e.meta?.action === 'deferred').length,
    out(t5).slice(-3000));
}
