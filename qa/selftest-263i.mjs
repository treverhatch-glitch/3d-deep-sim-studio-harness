/**
 * qa/selftest-263i.mjs — 2.63.0 (helper i): blast-radius landing tiers and the merge train's batching rules.
 *   The train landed every green lane alike: a lane that changed the harness, a protected file or a save format landed
 *   as easily as a doc fix. Now each lane gets a tier from its own diff (harness/tiers.mjs, code only): C (harness,
 *   protected files, deleted tests, irreversible files, upgrade merges) is held in the queue until a person releases
 *   it; B (sim, goldens, pins, shared code) verifies with --all and needs its Golden-Reason / Pin-Moves; A lands as
 *   before. Batching: STUDIO_TRAIN_MIN / _MAX / _WAIT_MIN, run-alone lanes (manifest "runAlone"), and a lone task done
 *   rides along with lanes already queued.
 * A tiny studio: a made-up game whose check fails on a note that says BROKEN; lane copies with the commit hooks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest263I({ dir, run, report, tmpRoot, root }) {
  // The size rule reads JavaScript with the typescript package: a copy made without node_modules (the full selftest's
  // copyRepo) gets the harness's own, linked, as selftest-260b does.
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const events = path.join(dir, '.studio', 'events-263i.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_MIN: '', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_WAIT_MIN: '', STUDIO_TRAIN_POLL_S: '', STUDIO_TRAIN_LOCK_WAIT_MIN: '', STUDIO_TRAIN_RIDE_ALONG: '', STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_ROLE: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-263i-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  // A person's own terminal: no coding agent's markers, no agent name.
  const person = { ...env, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_LOCK_OWNER: '' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mainHas = (rel) => g(dir, 'cat-file', '-e', `main:${rel}`).status === 0;
  const board = () => `${fs.existsSync(path.join(dir, 'studio/NEXT.md')) ? fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8') : ''}`;
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard()) && !new RegExp(`\\b${id}\\b`).test(board().split(/^## Done/m)[0]);
  const queueRaw = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')); } catch { return []; } };
  const queue = () => queueRaw().map((e) => e.task);
  const handBack = (id) => { const f = path.join(dir, 'studio', 'handoffs', `${id}.md`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  const dropped = (id) => evs().some((e) => e.type === 'task.train.dropped' && e.task === id);
  const starts = (since) => evs().slice(since).filter((e) => e.type === 'task.train.start');
  const json = (r) => { const t = String(r.stdout || ''); const i = t.indexOf('{\n'); try { return JSON.parse(t.slice(i)); } catch { return {}; } };

  // ---- the studio and its made-up game ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({
    gates: [{ id: 'check', command: 'node game/demo/check.mjs' }],
    runAlone: { paths: ['game/demo/sim/core/**'] },
  }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "let bad = 0;",
    "for (const d of ['game/demo/notes', 'docs/demo']) for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) if (fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) { console.log(`FAIL notes: ${f} says BROKEN`); bad += 1; }",
    "if (bad) process.exit(1);",
    "console.log('demo ok');", ''].join('\n'));
  write(dir, 'game/demo/sim/rules.mjs', 'export const speed = 1;\n');
  write(dir, 'game/demo/sim/core/engine.mjs', 'export const tick = 1;\n');
  write(dir, 'game/demo/sim/goldens/run.json', '{ "ticks": 10 }\n');
  write(dir, 'game/demo/sim/goldens/run2.json', '{ "ticks": 20 }\n');
  write(dir, 'game/demo/notes/shared.md', '# Shared\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-263i-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  /** A task, its lane copy, the task started there, files written and committed with the hooks. */
  const lane = (agent, title, files, { trailers = [] } = {}) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) write(ld, rel, text);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`, ...trailers.flatMap((t) => ['-m', t])], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const queueIt = (l, extra = {}) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, { ...l.as, ...extra });
  const train = (extra = '', e = {}) => run(dir, `node harness/task.mjs train --by tester ${extra}`, { ...env, ...e });
  const trainAsync = (e = {}) => new Promise((resolve) => {
    const p = spawn('node harness/task.mjs train --by tester', { cwd: dir, shell: true, env: { ...process.env, ...env, ...e } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const waitFor = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return fn(); };

  // ---- 1. a lane touching harness/ is tier C: held for the owner; a worker's release refused, a person's lands it ----
  const hc = lane('tier-c', 'Tools: harness note', { 'harness/demo-extra.mjs': 'export const extra = 1;\n' });
  const q1 = queueIt(hc);
  const t1 = train();
  const heldAfter = queueRaw().find((e) => e.task === hc.id);
  const workerRel = run(dir, `node harness/task.mjs train release ${hc.id} --by Dana --permission "Dana said in chat: land the harness note"`, { ...person, STUDIO_LOCK_OWNER: 'builder-s9' });
  const agentRel = run(dir, `node harness/task.mjs train release ${hc.id} --by Dana`, { ...person, CLAUDECODE: '1' });
  const t1b = train();
  const stillHeld = !isDone(hc.id) && !mainHas('harness/demo-extra.mjs') && queue().includes(hc.id);
  const personRel = run(dir, `node harness/task.mjs train release ${hc.id} --by Dana`, person);
  const t1c = train();
  report('2.63.0 (i #1): a lane that changes harness/ is tier C: task done --train says "tier C" and "needs the owner", the train lands nothing and keeps it queued as held (task.train.held); a worker\'s release (builder-s9, even with --permission) and a coding agent\'s release without permission are refused and the next train still holds it; a person\'s release (task.train.released) lets the next train land it (fails on 2.60.0: the train landed the harness change at once and there is no release)',
    hc.ok && q1.status === 0 && /tier C/.test(out(q1)) && /needs the owner/.test(out(q1)) && t1.status === 0 && heldAfter?.held?.tier === 'C' && /harness/.test(heldAfter?.held?.why || '') && /tier C/.test(out(t1))
      && evs().some((e) => e.type === 'task.train.held' && e.task === hc.id)
      && workerRel.status !== 0 && /worker/.test(out(workerRel)) && agentRel.status !== 0 && /coding agent/.test(out(agentRel)) && stillHeld && /needs the owner/.test(out(t1b))
      && personRel.status === 0 && evs().some((e) => e.type === 'task.train.released' && e.task === hc.id && e.meta?.by === 'Dana')
      && t1c.status === 0 && isDone(hc.id) && mainHas('harness/demo-extra.mjs') && !queue().includes(hc.id),
    `${hc.log.slice(-300)}\nq1: ${out(q1).slice(-600)}\nt1: ${out(t1).slice(-1200)}\nheld=${JSON.stringify(heldAfter)}\nworker: ${out(workerRel).slice(-300)}\nagent: ${out(agentRel).slice(-300)}\nt1b: ${out(t1b).slice(-500)}\nperson: ${out(personRel).slice(-300)}\nt1c: ${out(t1c).slice(-1500)}`);

  // ---- 1b. the old path can't carry a tier C lane past its hold: STUDIO_TRAIN=off, --force ----
  const hc2 = lane('tier-c2', 'Tools: another harness note', { 'harness/demo-extra2.mjs': 'export const extra2 = 1;\n' });
  const off = run(hc2.dir, `node harness/task.mjs done ${hc2.id} --agent ${hc2.agent}`, { ...hc2.as, STUDIO_TRAIN: 'off' });
  const forced = run(hc2.dir, `node harness/task.mjs done ${hc2.id} --agent ${hc2.agent} --force --reason "skip the checks for a harness note"`, hc2.as);
  report('2.63.0 (i #1): a tier C lane is refused on the old landing path too: task done with STUDIO_TRAIN=off, or --force, says it lands only through the merge train after a person releases it, and main doesn\'t get it (fails on 2.60.0: STUDIO_TRAIN=off delivered it)',
    hc2.ok && off.status !== 0 && /tier C/.test(out(off)) && /train release/.test(out(off)) && forced.status !== 0 && /tier C/.test(out(forced)) && !mainHas('harness/demo-extra2.mjs') && !isDone(hc2.id),
    `${hc2.log.slice(-300)}\n--- STUDIO_TRAIN=off (${off.status}):\n${out(off).slice(-600)}\n--- --force (${forced.status}):\n${out(forced).slice(-600)}`);

  // ---- 2. a tier A docs lane and a tier B sim lane train together; each logs its tier; the verify is --all ----
  let since = evs().length;
  const da = lane('tier-a', 'Docs: demo notes', { 'docs/demo/notes-a.md': '# Notes A\n' });
  const sb = lane('tier-b', 'Sim: faster speed', { 'game/demo/sim/rules.mjs': 'export const speed = 2;\n' });
  const qa = queueIt(da); const qb = queueIt(sb);
  const t2 = train();
  const j2 = json(t2);
  const tierEv = (id) => evs().slice(since).filter((e) => e.type === 'task.train.tier' && e.task === id).pop();
  report('2.63.0 (i #1): a tier A docs lane and a tier B sim lane land in ONE train with one verify run; the train log names each lane\'s tier and why ("tier A (docs" / "tier B (the game\'s sim"), task done --train printed it, task.train.tier events record it, and the verify runs the whole game (--all) because of the B lane (fails on 2.60.0: no tier anywhere, a scoped verify)',
    da.ok && sb.ok && qa.status === 0 && qb.status === 0 && /tier A/.test(out(qa)) && /tier B/.test(out(qb)) && t2.status === 0 && isDone(da.id) && isDone(sb.id) && starts(since).length === 1 && j2.verifies === 1
      && new RegExp(`${da.id} tier A \\(docs`).test(out(t2)) && new RegExp(`${sb.id} tier B \\(the game's sim`).test(out(t2)) && tierEv(da.id)?.meta?.tier === 'A' && tierEv(sb.id)?.meta?.tier === 'B' && j2.tiers?.[da.id] === 'A' && j2.tiers?.[sb.id] === 'B'
      && /changed file\(s\), --all\)/.test(out(t2)),
    `${out(qa).slice(-300)}\n${out(qb).slice(-300)}\n${out(t2).slice(-2500)}`);

  // ---- 3. a tier B lane that moved a golden without Golden-Reason is handed back; one with the trailer lands ----
  since = evs().length;
  const gr = lane('gold-a', 'Sim: retune run golden', { 'game/demo/sim/goldens/run.json': '{ "ticks": 11 }\n' });
  const gk = lane('gold-b', 'Sim: retune run2 golden', { 'game/demo/sim/goldens/run2.json': '{ "ticks": 21 }\n' }, { trailers: ['Golden-Reason: the faster speed moves the end tick'] });
  const qg = queueIt(gr); queueIt(gk);
  const t3 = train();
  const noteG = handBack(gr.id);
  report('2.63.0 (i #1): a tier B lane whose commits change a golden with no Golden-Reason trailer is handed back with a note naming the golden and the trailer (task done --train warned); a lane that changes a golden with the trailer lands in the same train (fails on 2.60.0: the golden without a reason landed; the weakened-tests gate only warns without an owner key)',
    gr.ok && gk.ok && /Golden-Reason/.test(out(qg)) && dropped(gr.id) && !isDone(gr.id) && /Golden-Reason/.test(noteG) && /goldens\/run\.json/.test(noteG) && /"ticks": 10/.test(g(dir, 'show', 'main:game/demo/sim/goldens/run.json').stdout) && isDone(gk.id) && /"ticks": 21/.test(g(dir, 'show', 'main:game/demo/sim/goldens/run2.json').stdout),
    `${out(qg).slice(-400)}\n${out(t3).slice(-2000)}\nnote: ${noteG.slice(-500)}`);

  // ---- 4. STUDIO_TRAIN_MIN / STUDIO_TRAIN_WAIT_MIN: a train waits for more lanes, then runs (or runs with what it has) ----
  since = evs().length;
  const p1 = lane('batch-1', 'Docs: batch one', { 'docs/demo/batch-1.md': '# One\n' });
  const p2 = lane('batch-2', 'Docs: batch two', { 'docs/demo/batch-2.md': '# Two\n' });
  queueIt(p1);
  const t4p = trainAsync({ STUDIO_TRAIN_MIN: '2', STUDIO_TRAIN_WAIT_MIN: '2', STUDIO_TRAIN_POLL_S: '0.3' });
  const waited = await waitFor(() => evs().slice(since).some((e) => e.type === 'task.train.waiting'), 20000);
  const nothingYet = !isDone(p1.id) && starts(since).length === 0;
  queueIt(p2);
  const t4 = await t4p;
  const j4 = json(t4);
  const s4 = starts(since);
  const since4b = evs().length;
  const p3 = lane('batch-3', 'Docs: batch three', { 'docs/demo/batch-3.md': '# Three\n' });
  queueIt(p3);
  const queuedAt = Date.parse(queueRaw().find((e) => e.task === p3.id)?.at || '') || 0;
  const t4b = train('', { STUDIO_TRAIN_MIN: '3', STUDIO_TRAIN_WAIT_MIN: '0.05', STUDIO_TRAIN_POLL_S: '0.3' });
  const startB = starts(since4b)[0];
  const took = startB ? Date.parse(startB.ts) - queuedAt : -1;
  report('2.63.0 (i #2): with STUDIO_TRAIN_MIN=2 a train with one lane queued waits (task.train.waiting, nothing lands) until a second lane is queued, then lands both in ONE train with one verify; with STUDIO_TRAIN_MIN=3 and STUDIO_TRAIN_WAIT_MIN=0.05 (3 s) a lone lane waits about 3 s from its queueing, then lands by itself (fails on 2.60.0: the train ran at once with the first lane only)',
    p1.ok && p2.ok && p3.ok && waited && nothingYet && t4.status === 0 && isDone(p1.id) && isDone(p2.id) && s4.length === 1 && s4[0].meta?.lanes?.length === 2 && j4.verifies === 1
      && t4b.status === 0 && isDone(p3.id) && took >= 2500 && starts(since4b).length === 1 && evs().slice(since4b).some((e) => e.type === 'task.train.waiting'),
    `waited=${waited} nothingYet=${nothingYet}\n${out(t4).slice(-1500)}\nstarts=${JSON.stringify(s4.map((e) => e.meta?.lanes))}\nt4b (started ${took} ms after queueing): ${out(t4b).slice(-800)}`);

  // ---- 5. a run-alone lane (manifest runAlone.paths) trains by itself; the other lane gets the next train ----
  since = evs().length;
  const ra = lane('alone-a', 'Sim: engine tick', { 'game/demo/sim/core/engine.mjs': 'export const tick = 2;\n' });
  const rb = lane('alone-b', 'Docs: alone b', { 'docs/demo/alone-b.md': '# B\n' });
  queueIt(ra); queueIt(rb);
  const t5 = train();
  const s5 = starts(since);
  const l5 = evs().slice(since).filter((e) => e.type === 'task.train.landed');
  const j5 = json(t5);
  report('2.63.0 (i #2): a lane that touches the manifest\'s runAlone.paths trains by itself: two trains run (the first with only that lane, the second with the docs lane), both land, the log says it runs alone (fails on 2.60.0: one train with both lanes)',
    ra.ok && rb.ok && t5.status === 0 && isDone(ra.id) && isDone(rb.id) && s5.length === 2 && l5.length === 2 && l5[0].meta?.lanes?.join(',') === ra.id && l5[1].meta?.lanes?.join(',') === rb.id && /runs alone/.test(out(t5)) && j5.trains?.length === 2 && queue().length === 0,
    `${out(t5).slice(-2500)}\nlanded=${JSON.stringify(l5.map((e) => e.meta?.lanes))}`);

  // ---- 6. a lone task done rides along with a lane already queued: one train, one verify, its own result as today ----
  since = evs().length;
  const u = lane('ride-u', 'Docs: ride u', { 'docs/demo/ride-u.md': '# U\n' });
  const v = lane('ride-v', 'Docs: ride v', { 'docs/demo/ride-v.md': '# V\n' });
  queueIt(u);
  const dv = run(v.dir, `node harness/task.mjs done ${v.id} --agent ${v.agent}`, v.as);
  const s6 = starts(since);
  const dj = json(dv);
  const verifies6 = evs().slice(since).filter((e) => e.type === 'task.train.verify').length;
  report('2.63.0 (i #2): a lone task done in a lane copy takes the lane already queued for the next train along: ONE train (both lanes, the queued one as a rider), one verify run, both land and the queue empties; task done prints its own task as before (fails on 2.60.0: it ran a one-lane train and the queued lane stayed queued)',
    u.ok && v.ok && dv.status === 0 && dj.id === v.id && isDone(u.id) && isDone(v.id) && s6.length === 1 && s6[0].meta?.lanes?.join(',') === `${v.id},${u.id}` && s6[0].meta?.riders?.join(',') === u.id && verifies6 === 1 && queue().length === 0,
    `${out(dv).slice(-2000)}\nstarts=${JSON.stringify(s6.map((e) => e.meta))} verifies=${verifies6}`);

  // ---- 7. the pure pieces: the tier rules (data), a manifest can't lower a locked rule, the release rule ----
  const probe = path.join(tmpRoot, `tiers-263i-${process.pid}.mjs`);
  fs.writeFileSync(probe, `import { classifyLane, tierRules } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'tiers.mjs')).href)};
import { readTrainSettings, releaseRefusal, batchRules } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)};
const t = (files, o = {}) => classifyLane({ files: files.map(([status, p]) => ({ status, path: p })), ...o }).tier;
const set = readTrainSettings({ irreversible: ['src/save/**'], runAlone: { maxFiles: 2, paths: ['src/core/**'] }, tiers: { rules: [{ tier: 'A', paths: ['src/render/**'] }], set: { harness: 'A', shared: 'A' } } });
const ra = classifyLane({ files: [['M', 'a.ts'], ['M', 'b.ts'], ['M', 'c.ts']].map(([status, p]) => ({ status, path: p })), settings: set });
const person = { CLAUDECODE: '', AI_AGENT: '' };
console.log(JSON.stringify({
  deletedTest: t([['D', 'src/a.test.ts']]), addedTest: t([['A', 'src/a.test.ts']]), changedTest: t([['M', 'src/a.test.ts']]),
  qaScript: t([['A', 'qa/new-check.mjs']]), manifest: t([['M', 'game/demo/studio.gates.json']]), studioProtected: t([['M', 'src/x.ts']], { protectedGlobs: ['src/x.ts'] }),
  newRegression: t([['A', 'qa/regressions/r9.json']]), editedRegression: t([['M', 'qa/regressions/r9.json']]), deletedRegression: t([['D', 'qa/regressions/r9.json']]),
  irreversible: t([['M', 'src/save/format.ts']], { settings: set }), upgrade: t([['M', 'src/x.ts']], { trailers: { 'Upgrade-Ref': ['origin/main'] } }),
  harnessLowered: t([['M', 'harness/x.mjs']], { settings: set }), sharedLowered: t([['M', 'src/lib/x.ts']], { settings: set }), render: t([['M', 'src/render/x.ts']], { settings: set }),
  unknown: t([['M', 'src/x.ts']]), uiInSim: t([['M', 'game/demo/sim/ui/x.mjs']]), tools: t([['A', 'game/demo/tools/x.mjs']]), docs: t([['M', 'docs/x.md']]),
  lockedNote: tierRules(set.tiers).notes.some((n) => /locked/.test(n)), runAlone: ra.runAlone.yes, notes: set.notes.length,
  worker: Boolean(releaseRefusal({ by: 'Dana', permission: 'Dana said yes in chat', env: { ...person, STUDIO_LOCK_OWNER: 'builder-s3' } })),
  agentNoPerm: Boolean(releaseRefusal({ by: 'Dana', env: { CLAUDECODE: '1' } })), agentPerm: releaseRefusal({ by: 'Dana', permission: 'Dana said yes in chat', env: { CLAUDECODE: '1' } }),
  agentBy: Boolean(releaseRefusal({ by: 'builder-s3', env: person })), personOk: releaseRefusal({ by: 'Dana', env: person }),
  keyed: Boolean(releaseRefusal({ by: 'Dana', permission: 'Dana said yes in chat', env: { CLAUDECODE: '1' }, ownerKey: true })),
  batch: batchRules({ STUDIO_TRAIN_MIN: '3', STUDIO_TRAIN_MAX: '5', STUDIO_TRAIN_WAIT_MIN: '7' }), batchDefault: batchRules({}),
}));`);
  const pr = run(dir, `node "${probe}"`, env);
  let pj = {};
  try { pj = JSON.parse(String(pr.stdout).trim().split('\n').pop()); } catch {}
  report('2.63.0 (i #1, #2): the tier rules are data decided by code: deleted test, qa/*.mjs, the game manifest, a studio-protected file, an edited or deleted regression, a manifest "irreversible" file and an Upgrade-Ref merge are C; an added test or regression, tools, docs are A; a changed test, unknown code and UI inside the sim are B; the manifest can add an A rule and lower a B rule but not lower a locked C rule (noted); runAlone.maxFiles; a release is refused for a worker, a coding agent without permission, an agent\'s name in --by, and an agent on permission once an owner key exists; batching settings parse (fails on 2.60.0: harness/tiers.mjs and these exports don\'t exist)',
    pj.deletedTest === 'C' && pj.addedTest === 'A' && pj.changedTest === 'B' && pj.qaScript === 'C' && pj.manifest === 'C' && pj.studioProtected === 'C' && pj.newRegression === 'A' && pj.editedRegression === 'C' && pj.deletedRegression === 'C'
      && pj.irreversible === 'C' && pj.upgrade === 'C' && pj.harnessLowered === 'C' && pj.sharedLowered === 'A' && pj.render === 'A' && pj.unknown === 'B' && pj.uiInSim === 'B' && pj.tools === 'A' && pj.docs === 'A'
      && pj.lockedNote === true && pj.runAlone === true && pj.notes === 0 && pj.worker === true && pj.agentNoPerm === true && pj.agentPerm === '' && pj.agentBy === true && pj.personOk === '' && pj.keyed === true
      && pj.batch?.min === 3 && pj.batch?.max === 5 && pj.batch?.waitMin === 7 && pj.batchDefault?.min === 1 && pj.batchDefault?.max === 0,
    out(pr).slice(-1500));
  for (const p of [laneProbe, probe]) fs.rmSync(p, { force: true });
}
