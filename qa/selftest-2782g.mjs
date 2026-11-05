/**
 * qa/selftest-2782g.mjs — 2.78.2 (g): items 16 and 18 of the crew's 2.78.1 run.
 *   - Item 16: a train with a green verify of tree T, when main moved meanwhile by commits that touch only files no
 *     check reads (a deleted note, a new handoff: the board rule refuses a delete), lands T and merges those commits on
 *     top (ONE verify, task.train.landed_over_noncode naming the commits). A move by a file a check reads (a docs-read
 *     board file), or STUDIO_TRAIN_LAND_OVER_NONCODE=off, still verifies again. nonCodeReaders: the rule, file by file.
 *   - Item 18: a track written "unity" (a configured engine without engine:) reads as engine:unity (task add, a record,
 *     task track); task track refuses an engine the studio doesn't configure and a non-track; `task done --train` on an
 *     engine pass it can't queue says why; `upgrade --merge` backfills open engine-porter tasks' tracks (one engine) or
 *     lists them for a person (several).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782G({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args, extra = {}) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(extra) });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_VISUAL_GATE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782g-${process.pid}.pem`), CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 240000 });
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // A studio of its own (the repo as it is), its own git (made before `dir` becomes one).
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782g-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2782g.jsonl');
    writeIn(S, '.studio/events-2782g.jsonl', '');
    made.push(S);
    return { S, ev, env: { ...base, STUDIO_HOOKS_CHECK: 'off', AGENT_EVENTS_FILE: ev } };
  };
  const initRepo = (S) => { g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'user.name', 't']); g(S, ['config', 'user.email', 't@example.invalid']); g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']); };
  const gameJson = (S) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'game.json'), 'utf8')); } catch { return {}; } };
  const idOf = (r) => (out(r).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
  const S18 = studio('track');
  const S18b = studio('backfill');
  const S18c = studio('backfill2');

  // ================= item 16: land the verified tree, then main's non-code commits on top =================
  {
    const mark = path.join(tmpRoot, `train-runs-2782g-${process.pid}.txt`);
    const moveSpec = path.join(tmpRoot, `train-move-2782g-${process.pid}.json`);
    const evFile = path.join(dir, '.studio', 'events-2782g.jsonl');
    const env = { ...base, STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_MAIN_ROOT: '', AGENT_EVENTS_FILE: evFile, TRAIN_MARK: mark, TRAIN_MOVE: moveSpec };
    const runs = () => { try { return fs.readFileSync(mark, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
    const evs = () => events(evFile);
    const mainHas = (rel) => g(dir, ['cat-file', '-e', `main:${rel}`]).status === 0;
    writeIn(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
      { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
      { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
      { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
      { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
    ] }, null, 2)}\n`);
    writeIn(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
    // The game's check counts its runs; once (TRAIN_MOVE names a spec) it commits on the main checkout while the train's
    // verify runs (written and removed files), as the orchestrator's notes commit did.
    writeIn(dir, 'game/demo/check.mjs', [
      "import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';",
      "if (process.env.TRAIN_MARK) fs.appendFileSync(process.env.TRAIN_MARK, `${process.cwd()}\\n`);",
      "const spec = process.env.TRAIN_MOVE;",
      "if (spec && fs.existsSync(spec) && process.env.STUDIO_MAIN_ROOT) {",
      "  const s = JSON.parse(fs.readFileSync(spec, 'utf8')); fs.rmSync(spec);",
      "  const root = process.env.STUDIO_MAIN_ROOT;",
      "  const env = { ...process.env }; for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k];",
      "  for (const [rel, text] of Object.entries(s.files || {})) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); spawnSync('git', ['add', '--', rel], { cwd: root, env }); }",
      "  for (const rel of s.remove || []) spawnSync('git', ['rm', '-q', '--', rel], { cwd: root, env });",
      "  const c = spawnSync('git', ['commit', '-q', '--no-verify', '-m', s.message], { cwd: root, env, encoding: 'utf8' });",
      "  if (c.status !== 0) { console.error(`FAIL could not move main: ${c.stderr}`); process.exit(1); }",
      "}",
      "console.log('notes ok');", ''].join('\n'));
    writeIn(dir, 'studio/notes/old-run-log.md', '# old run log\n');
    writeIn(dir, 'studio/notes/older-run-log.md', '# older run log\n');
    writeIn(dir, 'studio/memory/scratch-2782g.md', '# a memory note the docs check reads\n');
    fs.mkdirSync(path.dirname(evFile), { recursive: true });
    g(dir, ['init', '-q', '-b', 'main']); g(dir, ['config', 'core.autocrlf', 'false']); g(dir, ['config', 'user.name', 't']); g(dir, ['config', 'user.email', 't@example.invalid']);
    g(dir, ['add', '-A']); g(dir, ['commit', '-qm', 'studio', '--no-verify']);
    g(dir, ['config', 'core.hooksPath', 'scripts/hooks']);
    const laneProbe = path.join(tmpRoot, `lane-2782g-${process.pid}.mjs`);
    fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'worktree.mjs')).href)};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
    const lane = (agent, title, rel, text) => {
      const id = idOf(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1 --lane game/demo`, env));
      const made1 = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
      const ld = path.join(dir, '.lanes', agent);
      const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
      const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
      writeIn(ld, rel, text);
      g(ld, ['add', rel]);
      const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { windowsHide: true, cwd: ld, encoding: 'utf8', env: gEnv(as) });
      const q = run(ld, `node harness/task.mjs done ${id} --agent ${agent} --train`, as);
      return { id, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0 && q.status === 0, log: `${out(made1).slice(-300)}\n${out(st).slice(-300)}\n${out(c)}\n${out(q).slice(-600)}` };
    };
    const train = (extra = {}) => run(dir, 'node harness/task.mjs train --by tester', { ...env, ...extra });

    await guard('2.78.2 (g, item 16): main moved during a green verify by a commit that only deletes a run log (studio/notes/) and adds a handoff: the train lands the verified tree and merges that commit on top (ONE verify, main = merge of the train head and that commit, the deleted note gone, task.train.landed_over_noncode naming the commit, no "moved") (fails on 2.78.1: the board rule refuses a delete, so "moved" and a second verify)', () => {
      const a = lane('bld-a', 'Docs: note a', 'game/demo/notes/a.md', '# A\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'orchestrator: rotate the run log', files: { 'studio/handoffs/h-2782g.md': '# handoff\n' }, remove: ['studio/notes/old-run-log.md'] }));
      const r0 = runs();
      const t = train();
      const moveCommit = g(dir, ['log', '-1', '--no-merges', '--format=%H', '--grep', 'rotate the run log', 'main']).stdout.trim();
      const lo = evs().find((e) => e.type === 'task.train.landed_over_noncode');
      const landed = evs().filter((e) => e.type === 'task.train.landed').pop();
      const parents = g(dir, ['rev-list', '--parents', '-n', '1', 'main']).stdout.trim().split(' ').slice(1);
      const ok = a.ok && t.status === 0 && runs() - r0 === 1 && !fs.existsSync(moveSpec) && /^[0-9a-f]{40}$/.test(moveCommit)
        && mainHas('game/demo/notes/a.md') && !mainHas('studio/notes/old-run-log.md') && mainHas('studio/handoffs/h-2782g.md')
        && parents.length === 2 && parents[1] === moveCommit && lo && (lo.meta?.commits || []).map((c) => c.sha).join() === moveCommit
        && (lo.meta?.files || []).join() === 'studio/handoffs/h-2782g.md,studio/notes/old-run-log.md'
        && landed && /non-code commit/.test(landed.msg) && g(dir, ['rev-parse', 'main^{tree}']).stdout.trim() === landed.meta?.tree
        && !evs().some((e) => e.type === 'task.train.moved') && !fs.existsSync(path.join(dir, 'studio/notes/old-run-log.md'));
      return [ok, `lane ${a.ok} ${a.log.slice(-400)}\nruns=${runs() - r0}\n${out(t).slice(-1800)}\nover=${JSON.stringify(lo?.meta)}\nlanded=${landed?.msg}\nparents=${parents.join(',')} move=${moveCommit}`];
    });

    await guard('2.78.2 (g, item 16, guard): main moved during the verify by a commit that deletes a board file the docs check reads (studio/memory/*.md): the train builds and verifies again (2 verify runs, "moved", no landed_over_noncode); and with STUDIO_TRAIN_LAND_OVER_NONCODE=off a deleted run log verifies again too (fails on 2.78.1: it verified again too, but its refusal named neither the check that reads the file ("read by docs") nor the setting; the guard keeps the new rule from widening)', () => {
      const before = evs().filter((e) => e.type === 'task.train.landed_over_noncode').length;
      const movedBefore = evs().filter((e) => e.type === 'task.train.moved').length;
      const b = lane('bld-b', 'Docs: note b', 'game/demo/notes/b.md', '# B\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'orchestrator: drop a memory note', remove: ['studio/memory/scratch-2782g.md'] }));
      const r0 = runs();
      const t = train();
      const runsB = runs() - r0;
      const c = lane('bld-c', 'Docs: note c', 'game/demo/notes/c.md', '# C\n');
      fs.writeFileSync(moveSpec, JSON.stringify({ message: 'orchestrator: rotate the older run log', remove: ['studio/notes/older-run-log.md'] }));
      const r1 = runs();
      const t2 = train({ STUDIO_TRAIN_LAND_OVER_NONCODE: 'off' });
      const runsC = runs() - r1;
      const ok = b.ok && c.ok && t.status === 0 && t2.status === 0 && runsB === 2 && runsC === 2 && mainHas('game/demo/notes/b.md') && mainHas('game/demo/notes/c.md')
        && evs().filter((e) => e.type === 'task.train.landed_over_noncode').length === before && evs().filter((e) => e.type === 'task.train.moved').length === movedBefore + 2
        && /read by docs/.test(out(t)) && /STUDIO_TRAIN_LAND_OVER_NONCODE=off/.test(out(t2));
      return [ok, `b ${b.ok} c ${c.ok} runsB=${runsB} runsC=${runsC}\n${out(t).slice(-1200)}\n---\n${out(t2).slice(-800)}`];
    });

    // The rule, file by file (no train): what a check reads is code.
    const p = node(dir, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href)}).then((m) => {
const ctx = { board: m.boardPaths(), rechecks: m.recheckPaths(), records: m.taskRecordPaths(), addOnly: m.addOnlyPaths(), game: [{ glob: 'studio/notes/game-reads/**', by: 'game:check (its paths)' }] };
const r = (f) => m.nonCodeReaders(f, ctx);
console.log(JSON.stringify({ notes: r('studio/notes/x.md'), handoffs: r('studio/handoffs/y.md'), producer: r('studio/producer/LOG.md'), reviews: r('studio/reviews/r.md'), next: r('studio/NEXT.md'), protectedJson: r('studio/protected.json'), code: r('game/demo/src/a.ts'), approval: r('studio/approvals/a.json'), holds: r('studio/task-holds.json'), gameRead: r('studio/notes/game-reads/z.md'), controls: r('studio/bible/controls.json'), gates: r('studio/gates.json') }));
});`], env);
    let j = null; try { j = JSON.parse(String(p.stdout || '').trim().split('\n').pop()); } catch {}
    await guard('2.78.2 (g, item 16): nonCodeReaders: run logs, handoffs and the Producer log have no reader; a review (reviewer), NEXT.md (docs, session), protected.json (off the board list), a code file, an approval, a task record, a file in a game check\'s paths, the controls list and gates.json each name who reads them (fails on 2.78.1: no such rule, a move of main was judged by the hand list alone)', () => [
      j && !j.notes.length && !j.handoffs.length && !j.producer.length && j.reviews.some((x) => /reviewer/.test(x)) && j.next.some((x) => /docs/.test(x)) && j.next.some((x) => /session/.test(x))
        && j.protectedJson.some((x) => /board list/.test(x)) && j.code.some((x) => /whole tree/.test(x)) && j.approval.some((x) => /approval/.test(x)) && j.holds.some((x) => /task record/.test(x))
        && j.gameRead.some((x) => /game:check/.test(x)) && j.controls.some((x) => /controls/.test(x)) && j.gates.some((x) => /always shared/.test(x)),
      j ? JSON.stringify(j) : out(p).slice(-600)]);
  }

  // ================= item 18: engine tracks for older tasks =================
  {
    const { S, ev, env } = S18;
    writeIn(S, 'studio/game.json', `${JSON.stringify({ ...gameJson(S), engines: { unity: { land: 'node -e "process.exit(0)"', target: 'main' } } }, null, 2)}\n`);
    initRepo(S);
    const task = (args, e = env) => node(S, ['harness/task.mjs', ...args], e);
    const rec = (id) => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'tasks.json'), 'utf8'))[id] || null; } catch { return null; } };
    // (a) task add --track unity
    const a = task(['add', 'Port pass: dock', '--role', 'engine-porter', '--track', 'unity']);
    const idA = idOf(a);
    await guard('2.78.2 (g, item 18a): `task add --track unity` (a configured engine without engine:) is read as engine:unity: it says so and the engine record is written (fails on 2.78.1: "unity" was no track, no record, so the task was no engine pass)', () => [
      idA && /read as engine:unity/.test(out(a)) && rec(idA)?.track === 'engine:unity' && rec(idA)?.engine === 'unity',
      `${out(a).slice(-500)}\nrec=${JSON.stringify(rec(idA))}`]);
    // (a) a record a person wrote by hand: { track: "unity" } (the crew's fix that silently didn't work)
    const b = task(['add', 'Port pass: hangar', '--role', 'engine-porter']);
    const idB = idOf(b);
    const all = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'tasks.json'), 'utf8')); } catch { return {}; } })();
    all[idB] = { track: 'unity' };
    writeIn(S, '.studio/engine/tasks.json', `${JSON.stringify(all, null, 2)}\n`);
    const pr = node(S, ['-e', `import(${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'engine-tracks.mjs')).href)}).then((m) => { const r = m.engineTask(${JSON.stringify(idB)}); console.log(JSON.stringify({ track: r?.track || null, engine: r?.engine || null, again: m.engineTask(${JSON.stringify(idB)})?.track || null })); });`], env);
    let j = null; try { j = JSON.parse(String(pr.stdout || '').trim().split('\n').pop()); } catch {}
    const norm = events(ev).filter((e) => e.type === 'engine.track_normalized' && e.task === idB);
    await guard('2.78.2 (g, item 18a): an engine record whose track says "unity" reads as engine:unity: the record is fixed once and an engine.track_normalized event says so (fails on 2.78.1: engineTask gave track "unity", which no train or gate reads as an engine)', () => [
      j && j.track === 'engine:unity' && j.engine === 'unity' && j.again === 'engine:unity' && rec(idB)?.track === 'engine:unity' && norm.length === 1,
      `${JSON.stringify(j)} ${out(pr).slice(-300)}\nrec=${JSON.stringify(rec(idB))} events=${norm.length}`]);
    // (a) task track: normalize, refuse unknown
    const c = task(['add', 'Port pass: tower', '--role', 'engine-porter']);
    const idC = idOf(c);
    const t1 = task(['track', idC, 'unity', '--by', 'owner']);
    const t2 = task(['track', idC, 'engine:godot', '--by', 'owner']);
    const t3 = task(['track', idC, 'web', '--by', 'owner']);
    await guard('2.78.2 (g, item 18a): `task track <ID> unity` sets engine:unity (and says it read it so); engine:godot (not configured here) and "web" (no engine) are refused and leave the track as it was (fails on 2.78.1: "unity" was refused as no track, engine:godot was accepted)', () => [
      t1.status === 0 && /read as engine:unity/.test(out(t1)) && t2.status !== 0 && /not an engine this studio configures/.test(out(t2)) && t3.status !== 0 && /not a track/.test(out(t3)) && rec(idC)?.track === 'engine:unity',
      `${out(t1).slice(-300)}\n---\n${out(t2).slice(-300)}\n---\n${out(t3).slice(-300)}\nrec=${JSON.stringify(rec(idC))}`]);
    // (c) done --train on an engine pass it can't queue says why
    const d = task(['add', 'Port pass: apron', '--role', 'engine-porter', '--track', 'unit']);
    const idD = idOf(d);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    const q1 = task(['done', idD, '--agent', 'porter-1', '--train']);
    const q2 = task(['done', idA, '--agent', 'porter-1', '--train'], { ...env, STUDIO_DONE_UNITY_GATE: 'skip' });
    const nq = events(ev).filter((e) => e.type === 'task.train.not_queued');
    await guard('2.78.2 (g, item 18c): `task done --train` on an engine pass it can\'t queue says why and exits 1: an engine-porter task whose track "unit" names no engine (with the task track fix), and an engine:unity task with STUDIO_DONE_UNITY_GATE=skip (the engine train off); a task.train.not_queued event each (fails on 2.78.1: neither said it was an engine pass that wasn\'t queued)', () => [
      q1.status === 1 && /was not queued: it is an engine pass/.test(out(q1)) && /"unit" is not a track/.test(out(q1)) && /task -- track/.test(out(q1))
        && q2.status === 1 && /was not queued/.test(out(q2)) && /STUDIO_DONE_UNITY_GATE=skip/.test(out(q2)) && nq.length === 2,
      `${out(q1).slice(-500)}\n---\n${out(q2).slice(-500)}\nnot_queued=${nq.length}`]);
  }
  // (b) upgrade --merge backfills (one engine) or lists (several)
  const upgradeWith = async (St, engines, name) => {
    const { S, env } = St;
    writeIn(S, 'studio/game.json', `${JSON.stringify({ ...gameJson(S), engines }, null, 2)}\n`);
    initRepo(S);
    const id = idOf(node(S, ['harness/task.mjs', 'add', `Port pass: ${name}`, '--role', 'engine-porter'], env));
    const web = idOf(node(S, ['harness/task.mjs', 'add', `Build: ${name} hud`, '--role', 'builder', '--lane', 'harness'], env));
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'board', '--no-verify']);
    g(S, ['checkout', '-qb', 'upstream']);
    const pj = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')); pj.version = '9.9.9';
    writeIn(S, 'package.json', `${JSON.stringify(pj, null, 2)}\n`);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'harness 9.9.9', '--no-verify']);
    g(S, ['checkout', '-q', 'main']);
    const m = node(S, ['harness/upgrade-guard.mjs', '--merge', 'upstream', '--by', 'Pat', '--permission', 'Pat: take the 9.9.9 update (selftest)'], { ...env, STUDIO_UPGRADE_REFRESH: 'off' });
    let recs = {}; try { recs = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'engine', 'tasks.json'), 'utf8')); } catch {}
    return { m, id, web, recs };
  };
  {
    const one = await upgradeWith(S18b, { unity: { land: 'node -e "process.exit(0)"' } }, 'one');
    await guard('2.78.2 (g, item 18b): `upgrade --merge` gives an open engine-porter task with no track the studio\'s only engine (engine:unity, inferred by the upgrade backfill) and lists it; a builder task is left alone (fails on 2.78.1: no backfill, the task stayed off the Unity train)', () => [
      one.m.status === 0 && new RegExp(`engine track set: ${one.id} -> engine:unity`).test(out(one.m)) && one.recs[one.id]?.track === 'engine:unity' && /upgrade backfill/.test(one.recs[one.id]?.inferred?.from || '') && !one.recs[one.web],
      `${out(one.m).slice(-900)}\nrecs=${JSON.stringify(one.recs)}`]);
    const two = await upgradeWith(S18c, { unity: { land: 'node -e "process.exit(0)"' }, godot: { land: 'node -e "process.exit(0)"' } }, 'two');
    await guard('2.78.2 (g, item 18b): with two engines configured, `upgrade --merge` sets no track and lists the open engine-porter task for a person with the task track command (fails on 2.78.1: nothing listed)', () => [
      two.m.status === 0 && new RegExp(`configures 2 engines \\(godot, unity\\).*track ${two.id} engine:<godot\\|unity>`).test(out(two.m)) && !two.recs[two.id],
      `${out(two.m).slice(-900)}\nrecs=${JSON.stringify(two.recs)}`]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a later run cleans it */ } }
}
