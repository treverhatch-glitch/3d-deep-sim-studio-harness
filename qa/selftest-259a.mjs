/**
 * qa/selftest-259a.mjs — 2.59.0 (helper a): the merge train as the standard landing path (brief item 1).
 *   Landing was strictly serial: every lane ran its own full verify, landed, moved main, and every other lane rebased
 *   and verified again. `npm run task -- train` lands the queued lanes (task done <ID> --train) on ONE full verify of
 *   main + the lanes; a red train finds the lane that fails alone and hands it back; lanes that conflict aren't trained
 *   together; every lane's own commits still face the hooks gate; task done in a lane copy is a one-lane train.
 * A tiny studio: a game whose one check is a node script that counts its runs in a marker file and fails on a note
 * that says BROKEN; three-plus lane copies (git worktrees) with the commit hooks installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest259A({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const mark = path.join(tmpRoot, `train-runs-259a-${process.pid}.txt`);
  const events = path.join(dir, '.studio', 'events-259a.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-259a-${process.pid}.pem`), AGENT_EVENTS_FILE: events, TRAIN_MARK: mark, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const runs = () => { try { return fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mainHas = (rel) => g(dir, 'cat-file', '-e', `main:${rel}`).status === 0;
  const board = () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
  const queue = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')).map((e) => e.task); } catch { return []; } };

  // ---- the studio ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.cwd()}\\n`);",
    "const d = 'game/demo/notes';",
    "const bad = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) : [];",
    "if (bad.length) { console.error(`FAIL notes: ${bad.join(', ')} says BROKEN`); process.exit(1); }",
    "console.log('notes ok');", ''].join('\n'));
  write(dir, 'game/demo/notes/shared.md', '# Shared\n\nline one\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-259a-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  /** A task, its lane copy (.lanes/<agent>), the task started there, one note committed with the hooks. */
  const lane = (agent, title, rel, text, { noVerify = false } = {}) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    write(ld, rel, text);
    g(ld, 'add', rel);
    const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`, ...(noVerify ? ['--no-verify'] : [])], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const queueIt = (l) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, l.as);
  const train = (extra = '') => run(dir, `node harness/task.mjs train --by tester ${extra}`, env);

  // ---- 1. two lanes that don't overlap land in one train on ONE verify ----
  const a = lane('bld-a', 'Docs: note a', 'game/demo/notes/a.md', '# A\n');
  const b = lane('bld-b', 'Docs: note b', 'game/demo/notes/b.md', '# B\n');
  const qa = queueIt(a);
  const qb = queueIt(b);
  const queuedBoth = qa.status === 0 && qb.status === 0 && /queued for the next merge train/.test(out(qa)) && queue().join(',') === `${a.id},${b.id}` && !mainHas('game/demo/notes/a.md');
  const r0 = runs();
  const t1 = train();
  const oneVerify = runs() - r0;
  report('2.59.0 (#1): task done <ID> --train checks a lane and queues it (nothing lands yet); npm run task -- train lands two lanes that don\'t overlap with ONE verify run, main ends at a tree with both, both tasks close and the queue empties (fails on 2.58.5: --train was ignored and the lane landed at once; there is no train command)',
    a.ok && b.ok && queuedBoth && t1.status === 0 && oneVerify === 1 && mainHas('game/demo/notes/a.md') && mainHas('game/demo/notes/b.md') && isDone(a.id) && isDone(b.id) && queue().length === 0
      && evs().some((e) => e.type === 'task.train.landed' && (e.meta?.lanes || []).join(',') === `${a.id},${b.id}`),
    `lanes ${a.ok} ${b.ok}\n${a.log.slice(-600)}\nqueued=${queuedBoth} ${out(qa).slice(-500)}\n${out(qb).slice(-300)}\nruns=${oneVerify}\n${out(t1).slice(-1800)}`);

  // ---- 2. a red train: the lane that fails alone is dropped and handed back, the other lands ----
  const c = lane('bld-c', 'Docs: note c', 'game/demo/notes/c.md', '# C\n');
  const d = lane('bld-d', 'Docs: note d', 'game/demo/notes/d.md', '# D\n\nBROKEN on purpose\n');
  queueIt(c); queueIt(d);
  const r1 = runs();
  const t2 = train();
  const handoff = path.join(dir, 'studio', 'handoffs', `${d.id}.md`);
  const note = fs.existsSync(handoff) ? fs.readFileSync(handoff, 'utf8') : '';
  report('2.59.0 (#1): a red train is bisected: the lane whose change breaks the check fails alone, is dropped and handed back (back in the queue, its claim freed, a note naming the failing gate); the other lane lands; main never holds the broken note (fails on 2.58.5: no train command)',
    c.ok && d.ok && mainHas('game/demo/notes/c.md') && !mainHas('game/demo/notes/d.md') && isDone(c.id) && !isDone(d.id) && /game/.test(note) && /merge train/.test(note)
      && evs().some((e) => e.type === 'task.train.dropped' && e.task === d.id) && evs().some((e) => e.type === 'task.train.bisect') && queue().length === 0 && runs() - r1 === 3
      && !out(run(dir, 'node harness/lock.mjs list', env)).includes(`task:${d.id}`),
    `runs=${runs() - r1}\n${out(t2).slice(-2000)}\nnote: ${note.slice(-600)}`);

  // ---- 3. lanes that change the same lines aren't trained together ----
  const e = lane('bld-e', 'Docs: shared line from e', 'game/demo/notes/shared.md', '# Shared\n\nline one, as e says\n');
  const f = lane('bld-f', 'Docs: shared line from f', 'game/demo/notes/shared.md', '# Shared\n\nline one, as f says\n');
  queueIt(e); queueIt(f);
  const r2 = runs();
  const t3 = train();
  const shared = g(dir, 'show', 'main:game/demo/notes/shared.md').stdout;
  const firstTrain = e.ok && f.ok && /as e says/.test(shared) && !/as f says/.test(shared) && isDone(e.id) && !isDone(f.id) && queue().join(',') === f.id && runs() - r2 === 1
    && evs().some((x) => x.type === 'task.train.deferred' && x.task === f.id);
  const t3b = train();
  const fNote = fs.existsSync(path.join(dir, 'studio', 'handoffs', `${f.id}.md`)) ? fs.readFileSync(path.join(dir, 'studio', 'handoffs', `${f.id}.md`), 'utf8') : '';
  report('2.59.0 (#1): two lanes that conflict aren\'t trained together: the first lands, the second waits in the queue for the next train (one verify); there it conflicts with main and is handed back with "merge it into your copy" (fails on 2.58.5: no train command)',
    firstTrain && queue().length === 0 && /git merge main/.test(fNote) && !isDone(f.id),
    `${out(t3).slice(-1200)}\n---\n${out(t3b).slice(-800)}\nshared=${shared}\nqueue=${queue()}`);

  // ---- 4. a lane with a commit that skipped the hooks is refused in a train ----
  const h = lane('bld-h', 'Docs: note h', 'game/demo/notes/h.md', '# H\n');
  const qh = queueIt(h);
  write(h.dir, 'game/demo/notes/h.md', '# H\n\nand more, committed without the hooks\n');
  g(h.dir, 'add', 'game/demo/notes/h.md');
  spawnSync('git', ['commit', '-qm', `${h.id}: more`, '--no-verify'], { cwd: h.dir, encoding: 'utf8', env: { ...process.env, ...h.as } });
  const tipBefore = g(dir, 'rev-parse', 'main').stdout.trim();
  const r3 = runs();
  const t4 = train();
  report('2.59.0 (#1): a queued lane that then gets a commit made with --no-verify is refused by the hooks check in the train (handed back, nothing verified, main unmoved) (fails on 2.58.5: no train command)',
    h.ok && qh.status === 0 && g(dir, 'rev-parse', 'main').stdout.trim() === tipBefore && !isDone(h.id) && runs() === r3 && /hooks/.test(out(t4)) && evs().some((x) => x.type === 'task.train.dropped' && x.task === h.id),
    `${out(qh).slice(-400)}\n${out(t4).slice(-1500)}`);

  // ---- 5. task done in a lane copy is a one-lane train, with the same result as today's landing ----
  const lands = (l, extra = {}) => {
    const v = run(l.dir, 'node scripts/run-gates.mjs', l.as);
    const r = runs();
    const dn = run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent}`, { ...l.as, ...extra });
    const head = g(l.dir, 'rev-parse', 'HEAD').stdout.trim();
    return { v, dn, extraRuns: runs() - r, ff: g(dir, 'rev-parse', 'main').stdout.trim() === head, done: isDone(l.id) };
  };
  const i = lane('bld-i', 'Docs: note i', 'game/demo/notes/i.md', '# I\n');
  const oneLane = lands(i);
  const j = lane('bld-j', 'Docs: note j', 'game/demo/notes/j.md', '# J\n');
  const oldPath = lands(j, { STUDIO_TRAIN: 'off' });
  const viaTrain = evs().some((x) => x.type === 'task.train.landed' && (x.meta?.lanes || []).join(',') === i.id && x.meta?.reused === true);
  const oldNoTrain = !evs().some((x) => x.type === 'task.train.landed' && (x.meta?.lanes || []).includes(j.id));
  report('2.59.0 (#1): task done in a lane copy goes through a one-lane train with the same result as today\'s landing (main fast-forwards to the lane, the task closes, the lane\'s green verify of that tree stands, no second run); STUDIO_TRAIN=off keeps the old path (fails on 2.58.5: no train event)',
    i.ok && j.ok && oneLane.v.status === 0 && oneLane.dn.status === 0 && /"status": "done"/.test(out(oneLane.dn)) && oneLane.ff && oneLane.done && oneLane.extraRuns === 0 && viaTrain
      && oldPath.dn.status === 0 && oldPath.ff && oldPath.done && oldPath.extraRuns === 0 && oldNoTrain,
    `one-lane: ${JSON.stringify({ ff: oneLane.ff, done: oneLane.done, extra: oneLane.extraRuns, viaTrain })}\n${out(oneLane.v).slice(-400)}\n${out(oneLane.dn).slice(-1500)}\nold: ${JSON.stringify({ ff: oldPath.ff, done: oldPath.done, extra: oldPath.extraRuns })}\n${out(oldPath.dn).slice(-600)}`);

  // ---- 7. a lane behind main: main + lane is verified once before main moves, and the lane's commits aren't rewritten ----
  const k = lane('bld-k', 'Docs: note k', 'game/demo/notes/k.md', '# K\n');
  const m = lane('bld-m', 'Docs: note m', 'game/demo/notes/m.md', '# M\n');
  const mDone = run(m.dir, `node harness/task.mjs done ${m.id} --agent ${m.agent}`, m.as);
  const kHead = g(k.dir, 'rev-parse', 'HEAD').stdout.trim();
  const r5 = runs();
  const kDone = run(k.dir, `node harness/task.mjs done ${k.id} --agent ${k.agent}`, k.as);
  const kept = g(dir, 'merge-base', '--is-ancestor', kHead, 'main').status === 0;
  const mainTree = g(dir, 'rev-parse', 'main^{tree}').stdout.trim();
  const verified = (() => { try { return fs.readdirSync(path.join(dir, '.studio', 'train', 'records')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'records', n), 'utf8'))).some((x) => x.tree === mainTree && x.dirty === false); } catch { return false; } })();
  report('2.59.0 (#1): task done on a lane that main has moved past: main + the lane is verified once (the tree main then ends at), and the lane\'s own commit lands as it is (not rebased, so its hook stamp stands) (fails on 2.58.5: deliver rebased the lane and re-checked only what main brought in)',
    k.ok && m.ok && mDone.status === 0 && kDone.status === 0 && kept && verified && runs() - r5 === 1 && mainHas('game/demo/notes/k.md') && mainHas('game/demo/notes/m.md') && isDone(k.id),
    `${out(mDone).slice(-300)}\n${out(kDone).slice(-1500)}\nkept=${kept} verified=${verified} runs=${runs() - r5}`);

  // ---- 8. a red check already red when the task was claimed doesn't block the train (as at task done); stop does ----
  const exProbe = path.join(tmpRoot, `excused-259a-${process.pid}.mjs`);
  fs.mkdirSync(path.join(dir, '.studio', 'baseline'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio', 'baseline', 'T-901.json'), JSON.stringify({ task: 'T-901', red: [{ id: 'docs' }] }));
  fs.writeFileSync(exProbe, `import { excusedRed } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};
const rec = (rows, x = {}) => ({ dirty: false, partial: false, rows, ...x });
const docsRed = [{ id: 'docs', ok: false, required: true }, { id: 'game', ok: true, required: true }];
console.log(JSON.stringify({ excused: excusedRed(rec(docsRed), ['T-901']).ok, noBaseline: excusedRed(rec(docsRed), ['T-901', 'T-902']).ok, fresh: excusedRed(rec([{ id: 'game', ok: false, required: true }]), ['T-901']).ok, dirty: excusedRed(rec(docsRed, { dirty: true }), ['T-901']).ok, green: excusedRed(rec([{ id: 'game', ok: true, required: true }]), []).ok }));`);
  const ex = run(dir, `node "${exProbe}"`, env);
  let exj = {};
  try { exj = JSON.parse(String(ex.stdout).trim().split('\n').pop()); } catch {}
  fs.writeFileSync(path.join(dir, '.studio', 'STOP.json'), JSON.stringify({ by: 'owner', reason: 'lunch', at: new Date().toISOString() }));
  const stoppedTrain = train();
  fs.rmSync(path.join(dir, '.studio', 'STOP.json'), { force: true });
  report('2.59.0 (#1): a train counts a check that was already red when each of its tasks was claimed as task done does (excused), never a new failure, a task with no baseline, or a dirty record; a stopped studio runs no train (fails on 2.58.5: no harness/train.mjs)',
    exj.excused === true && exj.noBaseline === false && exj.fresh === false && exj.dirty === false && exj.green === true && stoppedTrain.status !== 0 && /stopped/.test(out(stoppedTrain)),
    `${out(ex).slice(-600)}\n${out(stoppedTrain).slice(-400)}`);
  fs.rmSync(exProbe, { force: true });

  // ---- 6. one train at a time; the scratch copies are gone ----
  const lockProbe = path.join(tmpRoot, `trainlock-259a-${process.pid}.mjs`);
  fs.writeFileSync(lockProbe, `import { withTrainLock } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};
const root = ${JSON.stringify(dir)};
const inner = await withTrainLock(root, { id: 'outer', by: 'x' }, () => withTrainLock(root, { id: 'inner', by: 'y' }, () => 'ran', { waitMs: 0 }));
console.log(JSON.stringify({ inner }));`);
  const lk = run(dir, `node "${lockProbe}"`, env);
  let lkj = {};
  try { lkj = JSON.parse(String(lk.stdout).trim().split('\n').pop()); } catch {}
  const leftovers = fs.existsSync(path.join(dir, '.lanes')) ? fs.readdirSync(path.join(dir, '.lanes')).filter((n) => n.startsWith('_train-')) : [];
  const branches = g(dir, 'branch', '--list', 'train/*').stdout.trim();
  report('2.59.0 (#1): one train at a time (a second one while a train holds the lock is refused, not run), and every train removes its scratch copy and its train/<id> branch (fails on 2.58.5: no harness/train.mjs)',
    lkj.inner?.busy?.id === 'outer' && !leftovers.length && !branches, `${out(lk).slice(-600)} leftovers=${leftovers} branches=${branches}`);
  for (const p of [laneProbe, lockProbe]) fs.rmSync(p, { force: true });
}
